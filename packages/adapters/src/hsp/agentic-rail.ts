import type { Address } from "@settleback/domain";
import type { Clock } from "../clock.ts";
import { caip2, classifyGatewayRecord } from "../gateway.ts";
import { RailRejectedError, RailTimeoutError, RailUnavailableError, type PrepareInput, type RailObservation } from "../rail.ts";
import type { ChainTransfer } from "../settlement.ts";
import { HspToolError, type HspAgenticClient } from "./agentic-client.ts";
import { HspShapeError, paymentStatusFromQuery, type CheckedOffer, type HspPaymentStatus, type HspPaymentToken } from "./agentic-offer.ts";
import { cartHash } from "./cart-mandate.ts";
import { quoteContents } from "./quote.ts";

/** Reads the payment chain; see TokenTransferReader. */
export interface TransferSource {
  transfer(txHash: string, expect: { from: string; to: string }): Promise<ChainTransfer | null>;
}

export interface HspOrderRecord {
  flowId: string;
  paymentRequestId: string;
  /** SHA-256 of the cart contents sent to HSP, recorded with the attempt. */
  cartSha256: string;
  paymentUrl: string | null;
  /** True when the order was found by query after a lost or refused create. */
  recovered: boolean;
}

/** The tools the rail calls; an HspAgenticClient, or a stand-in in tests. */
export type HspAgenticTools = Pick<HspAgenticClient, "createOrder" | "preparePayment" | "finalizePayment" | "submitPayment" | "queryPayment">;

export interface HspAgenticRailOptions {
  client: HspAgenticTools;
  transfers: TransferSource;
  /** The team's reporting name at HSP; the same exact value at order creation and every query. */
  merchantName: string;
  token: HspPaymentToken;
  clock: Clock;
}

/**
 * Payments through HSP Agentic Payment. HSP signs each cart and prepares the EIP-712 authorization;
 * the payer's wallet signs it after the Payment Agent checked it; HSP's gateway broadcasts the
 * transfer. Every observation is checked against the payment chain, not taken from HSP alone.
 */
export class HspAgenticRail {
  readonly provenance = "LIVE" as const;
  readonly kind = "hsp-agentic" as const;
  readonly merchantName: string;
  readonly token: HspPaymentToken;
  private readonly client: HspAgenticTools;
  private readonly transfers: TransferSource;
  private readonly clock: Clock;

  constructor(options: HspAgenticRailOptions) {
    this.client = options.client;
    this.transfers = options.transfers;
    this.merchantName = options.merchantName;
    this.token = options.token;
    this.clock = options.clock;
  }

  /**
   * Creates HSP's order for the cart. After a lost response, or a refusal that may mean the order
   * already exists, the order is looked up by the same payment request ID and accepted only if it
   * pays the same recipient, so retrying never pays into a different order.
   */
  async createOrder(input: PrepareInput): Promise<HspOrderRecord> {
    if (input.chainId !== this.token.chainId || input.token.toLowerCase() !== this.token.address) {
      throw new RailRejectedError("TOKEN_NOT_CONFIGURED", `HSP pays ${this.token.symbol} at ${this.token.address} on chain ${this.token.chainId}, not ${input.token} on chain ${input.chainId}.`);
    }
    // Network, token, and coin come from HSP's chain configuration, as its guide requires.
    const quoted = quoteContents({ ...input, coin: this.token.symbol }, this.merchantName);
    const contents = {
      ...quoted,
      payment_request: {
        ...quoted.payment_request,
        method_data: quoted.payment_request.method_data.map((method) => ({ ...method, data: { ...method.data, network: this.token.network, contract_address: this.token.address } })),
      },
    };
    const cartSha256 = cartHash(contents);
    try {
      const order = await this.client.createOrder({ merchantName: this.merchantName, payTo: input.payee, contents });
      if (order.paymentRequestId !== input.paymentRequestId) throw new RailRejectedError("ORDER_CONFLICT", "HSP returned a different payment request ID for the order");
      return { flowId: order.flowId, paymentRequestId: order.paymentRequestId, cartSha256, paymentUrl: order.paymentUrl, recovered: false };
    } catch (error) {
      if (!(error instanceof RailTimeoutError) && !(error instanceof HspToolError)) throw error;
      let found: HspPaymentStatus;
      try {
        found = await this.status(input.paymentRequestId);
      } catch {
        throw error;
      }
      if (found.record.to_pay_address.toLowerCase() !== input.payee.toLowerCase()) throw new RailRejectedError("ORDER_CONFLICT", "An HSP order with this payment request ID pays a different recipient");
      return { flowId: found.record.flow_id, paymentRequestId: input.paymentRequestId, cartSha256, paymentUrl: null, recovered: true };
    }
  }

  /** HSP's prepared payment for the order, unchecked: the caller checks it with checkPreparedPayment before any wallet sees it. */
  async prepare(flowId: string, payer: Address): Promise<unknown> {
    if (this.token.protocol !== "eip3009") throw new RailRejectedError("PROTOCOL_UNSUPPORTED", `The ${this.token.symbol} token uses ${this.token.protocol}; only eip3009 authorizations are supported.`);
    return this.client.preparePayment({ flowId, payer, protocol: "eip3009" });
  }

  /**
   * Hands the payer's signature of a checked offer to HSP and submits the resulting Payment Mandate
   * once. A lost answer at either step is reported as RailTimeoutError: the signature has left this
   * server, so the payment is observed from then on, never submitted again.
   */
  async submit(offer: CheckedOffer, signature: string): Promise<{ status: string | null }> {
    const { prepared } = offer;
    const mandate = await this.client.finalizePayment({ signature, paymentPayload: prepared.paymentPayload, paymentMandateContents: prepared.paymentMandateContents, cartHash: prepared.cartHash });
    const result = await this.client.submitPayment(mandate);
    const status = typeof result === "object" && result !== null ? (result as { status?: unknown }).status : undefined;
    return { status: typeof status === "string" ? status : null };
  }

  async status(paymentRequestId: string): Promise<HspPaymentStatus> {
    const raw = await this.client.queryPayment({ paymentRequestId, merchantName: this.merchantName });
    try {
      return paymentStatusFromQuery(raw, paymentRequestId);
    } catch (error) {
      if (error instanceof HspShapeError) throw new RailUnavailableError(`HSP query_payment (${error.message})`);
      throw error;
    }
  }

  /** HSP's record of the payment and, once HSP names a transaction, that transaction as the payment chain shows it. */
  async observe(paymentRequestId: string): Promise<RailObservation & { attributionVerified: boolean | null }> {
    const { record, attributionVerified } = await this.status(paymentRequestId);
    if (record.chain !== caip2(this.token.chainId) && record.network !== this.token.network) {
      throw new RailRejectedError("WRONG_NETWORK", `HSP reports the payment on ${record.chain}, not chain ${this.token.chainId}`);
    }
    let transfer: ChainTransfer | null = null;
    if (record.tx_signature !== null && record.payer_address !== null) {
      try {
        transfer = await this.transfers.transfer(record.tx_signature, { from: record.payer_address, to: record.to_pay_address });
      } catch (error) {
        throw new RailUnavailableError(`payment chain (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`);
      }
    }
    return { provenance: "LIVE", record, kind: classifyGatewayRecord(record), transfer, observedAt: this.clock.now().toISOString(), attributionVerified };
  }
}

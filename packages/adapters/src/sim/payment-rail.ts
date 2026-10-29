import { decimalToBaseUnits } from "../amounts.ts";
import type { Clock } from "../clock.ts";
import { GatewayError, classifyGatewayRecord, caip2 } from "../gateway.ts";
import { quoteContents } from "../hsp/quote.ts";
import type { MerchantClient } from "../hsp/merchant-client.ts";
import { cartHash } from "../hsp/cart-mandate.ts";
import {
  RailRejectedError,
  RailTimeoutError,
  type ExecutionPayload,
  type PaymentRail,
  type PrepareInput,
  type PreparedPayment,
  type RailObservation,
  type SignedPayload,
} from "../rail.ts";
import type { SimChain } from "./chain.ts";
import { simulatedSignature, type SimGateway } from "./gateway.ts";

export class SimulatedPaymentRail implements PaymentRail {
  readonly provenance = "SIMULATED" as const;
  private readonly gateway: SimGateway;
  private readonly chain: SimChain;
  private readonly clock: Clock;
  private readonly merchant: MerchantClient;

  constructor(options: { gateway: SimGateway; chain: SimChain; clock: Clock; merchant: MerchantClient }) {
    this.gateway = options.gateway;
    this.chain = options.chain;
    this.clock = options.clock;
    this.merchant = options.merchant;
  }

  /**
   * Signs the Cart Mandate and creates the order. When the response is lost, or the identifiers were
   * already used, it reads the order back by the same payment request ID and accepts it only when
   * the terms match, so a retry never creates a second order.
   */
  async prepare(input: PrepareInput): Promise<PreparedPayment> {
    const cartMandate = this.merchant.signCartMandate(quoteContents(input, this.merchant.merchantName));
    const cartSha256 = cartHash(cartMandate.contents);
    try {
      const created = await this.merchant.createOrder(cartMandate);
      if (created.payment_request_id !== input.paymentRequestId) throw new RailRejectedError("ORDER_CONFLICT", "The gateway returned a different payment request ID");
      return { provenance: "SIMULATED", cartMandate, cartMandateId: input.cartMandateId, paymentRequestId: input.paymentRequestId, cartSha256, paymentUrl: created.payment_url, recovered: false };
    } catch (error) {
      const lost = error instanceof RailTimeoutError;
      const duplicate = error instanceof GatewayError && (error.code === "40001" || error.code === "10004");
      if (!lost && !duplicate) throw error;
      const record = await this.merchant.paymentByRequestId(input.paymentRequestId);
      const matches =
        record.cart_mandate_id === input.cartMandateId &&
        record.to_pay_address.toLowerCase() === input.payee.toLowerCase() &&
        record.token_address.toLowerCase() === input.token.toLowerCase() &&
        record.chain === caip2(input.chainId) &&
        decimalToBaseUnits(record.product_amount, input.tokenDecimals) === decimalToBaseUnits(input.priceUsd, input.tokenDecimals);
      if (!matches) throw new RailRejectedError("ORDER_CONFLICT", "An order with these identifiers exists with different terms");
      return { provenance: "SIMULATED", cartMandate, cartMandateId: input.cartMandateId, paymentRequestId: input.paymentRequestId, cartSha256, paymentUrl: null, recovered: true };
    }
  }

  async submit(signed: SignedPayload): Promise<void> {
    if (signed.payload.provenance !== "SIMULATED") {
      throw new RailRejectedError("PROVENANCE", "The simulated rail accepts only simulated payloads");
    }
    await this.gateway.submitPaymentMandate(signed);
  }

  async observe(paymentRequestId: string): Promise<RailObservation> {
    const record = await this.merchant.paymentByRequestId(paymentRequestId);
    return {
      provenance: "SIMULATED",
      record,
      kind: classifyGatewayRecord(record),
      transfer: record.tx_signature === null ? null : this.chain.getTransfer(record.tx_signature),
      observedAt: this.clock.now().toISOString(),
    };
  }
}

/** Signs a simulated payload. Stands in for a wallet or guarded signer; never valid for a live gateway. */
export function signSimulatedPayload(payload: ExecutionPayload): SignedPayload {
  if (payload.provenance !== "SIMULATED") throw new Error("Only simulated payloads can be signed by the simulator");
  return { payload, signature: simulatedSignature(payload.payer, payload.nonce) };
}

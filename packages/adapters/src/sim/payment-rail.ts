import { createHash } from "node:crypto";
import type { Address } from "@settleback/domain";
import { decimalToBaseUnits } from "../amounts.ts";
import type { Clock } from "../clock.ts";
import { classifyGatewayRecord } from "../gateway.ts";
import {
  RailRejectedError,
  type ExecutionPayload,
  type PaymentRail,
  type PrepareInput,
  type PreparedPayment,
  type RailObservation,
  type SignedPayload,
} from "../rail.ts";
import type { SimChain } from "./chain.ts";
import { GatewayError, simulatedSignature, type SimGateway } from "./gateway.ts";

export class SimulatedPaymentRail implements PaymentRail {
  readonly provenance = "SIMULATED" as const;
  private readonly gateway: SimGateway;
  private readonly chain: SimChain;
  private readonly clock: Clock;
  private readonly decimals = new Map<string, number>();

  constructor(options: { gateway: SimGateway; chain: SimChain; clock: Clock }) {
    this.gateway = options.gateway;
    this.chain = options.chain;
    this.clock = options.clock;
  }

  /**
   * Creates the order. If the same identifiers were already used, the existing order is returned
   * when it matches, which recovers a lost create response without a second order.
   */
  async prepare(input: PrepareInput): Promise<PreparedPayment> {
    this.decimals.set(input.paymentRequestId, input.tokenDecimals);
    try {
      const created = this.gateway.createOrder(input);
      return this.prepared(input, created.flow_id, created.payment_url, created.cart_sha256);
    } catch (error) {
      if (!(error instanceof GatewayError) || (error.code !== "40001" && error.code !== "10004")) throw error;
      const record = this.gateway.query(input.paymentRequestId);
      const matches =
        record.cart_mandate_id === input.cartMandateId &&
        record.to_pay_address.toLowerCase() === input.payee.toLowerCase() &&
        record.token_address.toLowerCase() === input.token.toLowerCase() &&
        record.chain === `eip155:${input.chainId}` &&
        decimalToBaseUnits(record.order_amount, input.tokenDecimals) === decimalToBaseUnits(input.priceUsd, input.tokenDecimals);
      if (!matches) throw new RailRejectedError("ORDER_CONFLICT", "An order with these identifiers exists with different terms");
      return this.prepared(input, record.flow_id, `https://sim.invalid/flow/${record.flow_id}`, null);
    }
  }

  async executionPayload(prepared: PreparedPayment, payer: Address): Promise<ExecutionPayload> {
    const record = this.gateway.query(prepared.paymentRequestId);
    const decimals = this.decimals.get(prepared.paymentRequestId);
    if (decimals === undefined) throw new Error(`Unknown payment request ${prepared.paymentRequestId}`);
    return {
      provenance: "SIMULATED",
      kind: "simulated-payment-mandate",
      paymentRequestId: prepared.paymentRequestId,
      payer: payer.toLowerCase() as Address,
      payee: record.to_pay_address.toLowerCase() as Address,
      chainId: Number(record.chain.replace("eip155:", "")),
      token: record.token_address.toLowerCase() as Address,
      amountBaseUnits: decimalToBaseUnits(record.order_amount, decimals),
      nonce: createHash("sha256").update(`${prepared.paymentRequestId}:${payer.toLowerCase()}`).digest("hex"),
    };
  }

  async submit(signed: SignedPayload): Promise<void> {
    if (signed.payload.provenance !== "SIMULATED") {
      throw new RailRejectedError("PROVENANCE", "The simulated rail accepts only simulated payloads");
    }
    this.gateway.submitPaymentMandate(signed);
  }

  async observe(paymentRequestId: string): Promise<RailObservation> {
    const record = this.gateway.query(paymentRequestId);
    return {
      provenance: "SIMULATED",
      record,
      kind: classifyGatewayRecord(record),
      transfer: record.tx_signature === null ? null : this.chain.getTransfer(record.tx_signature),
      observedAt: this.clock.now().toISOString(),
    };
  }

  private prepared(input: PrepareInput, flowId: string, paymentUrl: string, cartSha256: string | null): PreparedPayment {
    return {
      provenance: "SIMULATED",
      cartMandateId: input.cartMandateId,
      paymentRequestId: input.paymentRequestId,
      flowId,
      paymentUrl,
      cartSha256,
    };
  }
}

/** Signs a simulated payload. Stands in for a wallet or guarded signer; never valid for a live gateway. */
export function signSimulatedPayload(payload: ExecutionPayload): SignedPayload {
  if (payload.provenance !== "SIMULATED") throw new Error("Only simulated payloads can be signed by the simulator");
  return { payload, signature: simulatedSignature(payload.payer, payload.nonce) };
}

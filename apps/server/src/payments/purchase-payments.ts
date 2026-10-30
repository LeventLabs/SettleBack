import type { DatabaseSync } from "node:sqlite";
import { OFFER_CHECKS, walletTypedData, type HspAgenticRail, type OfferExpectations, type PaymentCheck } from "@settleback/adapters";
import type { Address, Environment } from "@settleback/domain";
import type { PaymentAttemptRecord } from "../db/payments.ts";
import { hspCartExpiryOf, hspOrderInput, offerAuthorization, orderAttempt, submitAuthorization } from "./hsp-authorization.ts";
import { liveOriginalAttempt, quoteForBuyer, requestPaymentSignature, requireBuyer, spentToday, submitPaymentSignature, type BuyerPaymentAgent } from "./purchase.ts";
import { stageOriginalAttempt } from "./quote.ts";
import type { PaymentObserver } from "./reconcile.ts";

/** Where a purchase's payment happens; fixed into each operation's intent. */
export interface PurchaseNetwork {
  environment: Environment;
  chainId: number;
  token: Address;
  tokenDecimals: number;
  coin: string;
}

export interface BuyerLimits {
  payeeAllowlist: readonly Address[];
  perPaymentCapBaseUnits: string;
  dailyCapBaseUnits: string;
  maxFeeBaseUnits: string;
}

/** The order behind a quote, as the buyer is shown it. */
export interface QuoteSummary {
  merchantName: string;
  cartMandateId: string;
  paymentRequestId: string;
  cartSha256: string;
  /** HSP's flow for the order; null for the simulated gateway's quotes. */
  flowId: string | null;
  expiresAt: string;
  grossLimitBaseUnits: string | null;
}

/** What the wallet is about to authorize, shown before it signs. */
export interface AuthorizationSummary {
  recipient: string;
  payer: string;
  /** Raw token units, exactly as authorized. */
  amountBaseUnits: string;
  quoteExpiresAt: string | null;
  preparedBy: "payment-agent" | "hsp";
}

export type PurchaseSignatureRequest =
  | { status: "SIGNATURE_REQUIRED"; typedData: unknown; authorization: AuthorizationSummary; checks: PaymentCheck[] | null }
  | { status: "REFUSED"; checks: PaymentCheck[]; reasons: string[] }
  | { status: "ALREADY_REQUESTED" };

export type PurchaseSubmission = { status: "SUBMITTED" | "ALREADY_REQUESTED" } | { status: "OUTCOME_UNKNOWN"; reason: string };

interface BuyerStep {
  operationId: string;
  buyer: string;
  now: () => Date;
}

/**
 * How a purchase is paid, whichever gateway pays it: the quote and the Payment Agent's checks, the
 * typed data the buyer's wallet signs, and the one submission of that signature.
 */
export interface PurchasePayments {
  readonly kind: "simulated" | "hsp-agentic";
  readonly network: PurchaseNetwork;
  readonly observer: PaymentObserver;
  readonly limits: BuyerLimits;
  quote(db: DatabaseSync, input: BuyerStep): Promise<{ summary: QuoteSummary; checks: PaymentCheck[] }>;
  requestSignature(db: DatabaseSync, input: BuyerStep): Promise<PurchaseSignatureRequest>;
  submitSignature(db: DatabaseSync, input: BuyerStep & { signature: string }): Promise<PurchaseSubmission>;
}

/** The local demo's payments: the gateway simulator, and an AP2 mandate the Payment Agent builds from the validated cart. */
export function simulatedPurchasePayments(agent: BuyerPaymentAgent, network: Omit<PurchaseNetwork, "environment" | "coin">): PurchasePayments {
  const limits: BuyerLimits = agent.policy;
  return {
    kind: "simulated",
    network: { ...network, environment: "local", coin: agent.coin },
    observer: agent.rail,
    limits,
    async quote(db, input) {
      const { quote, validation } = await quoteForBuyer(db, { ...input, agent });
      return {
        summary: {
          merchantName: quote.cartMandate.contents.merchant_name,
          cartMandateId: quote.cartMandateId,
          paymentRequestId: quote.paymentRequestId,
          cartSha256: quote.cartSha256,
          flowId: null,
          expiresAt: quote.cartMandate.contents.cart_expiry,
          grossLimitBaseUnits: validation.ok ? validation.cart.grossLimitBaseUnits : null,
        },
        checks: validation.checks,
      };
    },
    async requestSignature(db, input) {
      const outcome = await requestPaymentSignature(db, { ...input, agent });
      if (outcome.status !== "SIGNATURE_REQUIRED") return { status: "ALREADY_REQUESTED" };
      const { payload } = outcome;
      return {
        status: "SIGNATURE_REQUIRED",
        typedData: walletTypedData(payload),
        authorization: { recipient: payload.payee, payer: payload.payer, amountBaseUnits: payload.amountBaseUnits, quoteExpiresAt: null, preparedBy: "payment-agent" },
        checks: null,
      };
    },
    async submitSignature(db, input) {
      const outcome = await submitPaymentSignature(db, { ...input, agent });
      return outcome.status === "OUTCOME_UNKNOWN" ? { status: "OUTCOME_UNKNOWN", reason: outcome.reason } : { status: outcome.status };
    },
  };
}

export interface HspBuyerAgent {
  rail: HspAgenticRail;
  limits: BuyerLimits;
  deploymentId: string;
  /** Line-item label on HSP's cart. */
  label: string;
}

/**
 * Payments through HSP Agentic Payment on HSK Chain testnet. HSP signs the cart and prepares the
 * authorization; the buyer's Payment Agent checks it against the order and the buyer's limits
 * before the wallet sees it; HSP's gateway broadcasts the transfer.
 */
export function hspPurchasePayments(agent: HspBuyerAgent): PurchasePayments {
  const { rail, limits } = agent;
  const network: PurchaseNetwork = { environment: "testnet", chainId: rail.token.chainId, token: rail.token.address, tokenDecimals: rail.token.decimals, coin: rail.token.symbol };

  const expectations =
    (db: DatabaseSync, now: () => Date) =>
    (attempt: PaymentAttemptRecord): OfferExpectations => {
      if (attempt.paymentRequestId === null) throw new Error(`payment attempt ${attempt.id} has no payment request`);
      return {
        paymentRequestId: attempt.paymentRequestId,
        payer: attempt.payer,
        payee: attempt.payee,
        chainId: attempt.chainId,
        token: attempt.token,
        principalBaseUnits: attempt.amountBaseUnits,
        maxFeeBaseUnits: limits.maxFeeBaseUnits,
        notAfter: hspCartExpiryOf(attempt),
        policy: {
          payeeAllowlist: limits.payeeAllowlist,
          perPaymentCapBaseUnits: limits.perPaymentCapBaseUnits,
          dailyCapBaseUnits: limits.dailyCapBaseUnits,
          spentTodayBaseUnits: spentToday(db, attempt.payer, attempt.id, limits.maxFeeBaseUnits, now()),
        },
      };
    };

  /** The operation's attempt with HSP's order created; creating it again after a lost answer finds the same order. */
  const ordered = async (db: DatabaseSync, input: BuyerStep): Promise<PaymentAttemptRecord> => {
    const operation = requireBuyer(db, input.operationId, input.buyer);
    const staged = stageOriginalAttempt(db, { operationId: operation.id, provenance: rail.provenance, deploymentId: agent.deploymentId, now: input.now });
    const attempt = liveOriginalAttempt(db, operation.id);
    if (attempt === undefined || attempt.id !== staged.attempt.id) throw new Error(`purchase ${operation.id} lost its payment attempt`);
    return orderAttempt(db, { attempt, rail, order: hspOrderInput(attempt, { tokenDecimals: operation.tokenDecimals, priceUsd: operation.priceUsd, coin: rail.token.symbol, label: agent.label }), now: input.now });
  };

  return {
    kind: "hsp-agentic",
    network,
    observer: rail,
    limits,
    async quote(db, input) {
      const attempt = await ordered(db, input);
      const gross = BigInt(attempt.amountBaseUnits) + BigInt(limits.maxFeeBaseUnits);
      const spent = BigInt(spentToday(db, attempt.payer, attempt.id, limits.maxFeeBaseUnits, input.now()));
      // Until HSP prepares the authorization only the buyer's limits can be checked, against the most the payment may cost.
      const early: Partial<Record<(typeof OFFER_CHECKS)[number]["id"], string | null>> = {
        "payee-allowlist": limits.payeeAllowlist.some((allowed) => allowed.toLowerCase() === attempt.payee) ? null : "the seller is not on the allowlist",
        "per-payment-cap": gross <= BigInt(limits.perPaymentCapBaseUnits) ? null : "the price plus the maximum fee exceeds the per-payment cap",
        "daily-cap": spent + gross <= BigInt(limits.dailyCapBaseUnits) ? null : "the price plus the maximum fee would exceed today's cap",
      };
      const checks: PaymentCheck[] = OFFER_CHECKS.map(({ id, label }) => {
        if (!(id in early)) return { id, label, status: "not-checked", reason: "Checked when you authorize, once HSP has prepared the authorization." };
        const reason = early[id] ?? null;
        return { id, label, status: reason === null ? "passed" : "blocked", reason };
      });
      if (attempt.cartMandateId === null || attempt.paymentRequestId === null || attempt.cartSha256 === null) throw new Error(`payment attempt ${attempt.id} is not prepared`);
      return {
        summary: {
          merchantName: rail.merchantName,
          cartMandateId: attempt.cartMandateId,
          paymentRequestId: attempt.paymentRequestId,
          cartSha256: attempt.cartSha256,
          flowId: attempt.flowId,
          expiresAt: hspCartExpiryOf(attempt),
          grossLimitBaseUnits: gross.toString(),
        },
        checks,
      };
    },
    async requestSignature(db, input) {
      const operation = requireBuyer(db, input.operationId, input.buyer);
      const live = liveOriginalAttempt(db, operation.id);
      if (live !== undefined && live.state !== "CREATED" && live.state !== "PREPARED") return { status: "ALREADY_REQUESTED" };
      const attempt = await ordered(db, input);
      const outcome = await offerAuthorization(db, { attemptId: attempt.id, rail, expectations: expectations(db, input.now), now: input.now });
      if (outcome.status === "ALREADY_REQUESTED") return { status: "ALREADY_REQUESTED" };
      if (outcome.status === "REFUSED") return { status: "REFUSED", checks: outcome.checks, reasons: outcome.reasons };
      const { offer } = outcome;
      return {
        status: "SIGNATURE_REQUIRED",
        typedData: offer.walletTypedData,
        authorization: { recipient: offer.authorization.to, payer: offer.authorization.from, amountBaseUnits: offer.authorization.value, quoteExpiresAt: offer.quoteExpiresAt, preparedBy: "hsp" },
        checks: outcome.checks,
      };
    },
    async submitSignature(db, input) {
      const operation = requireBuyer(db, input.operationId, input.buyer);
      const attempt = liveOriginalAttempt(db, operation.id);
      if (attempt === undefined) return { status: "ALREADY_REQUESTED" };
      const outcome = await submitAuthorization(db, {
        attemptId: attempt.id,
        rail,
        requestedBy: input.buyer,
        signature: input.signature,
        priceUsd: operation.priceUsd,
        expectations: expectations(db, input.now),
        now: input.now,
      });
      return outcome.status === "OUTCOME_UNKNOWN" ? { status: "OUTCOME_UNKNOWN", reason: outcome.reason } : { status: outcome.status };
    },
  };
}

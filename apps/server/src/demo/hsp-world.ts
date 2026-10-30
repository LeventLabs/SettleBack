import type { DatabaseSync } from "node:sqlite";
import { HspAgenticClient, HspAgenticRail, McpHttpClient, TokenTransferReader, selectPaymentToken, systemClock, tokenDomain } from "@settleback/adapters";
import type { Address } from "@settleback/domain";
import { loadSourceBytes, loadSources } from "@settleback/fixtures";
import type { HspConfig } from "../config.ts";
import { hspPurchasePayments } from "../payments/purchase-payments.ts";
import type { HspRepaymentPayments } from "../recovery/repayment.ts";
import { TERMS, registerFixturePolicies, type FixtureParties } from "./fixture-case.ts";
import { DemoPurchases } from "./purchases.ts";
import { DEMO_BUYER_LIMITS, type DemoWorld } from "./world.ts";

const HSK_TESTNET = 133;
const MCP_TIMEOUT_MS = 30_000;
const RPC_TIMEOUT_MS = 15_000;

export interface HspDemoWorld extends Omit<DemoWorld, "rail" | "payments"> {
  rail: HspAgenticRail;
  payments: HspRepaymentPayments;
}

/**
 * The HSP testnet demo: jobs bought through the workspace and paid through HSP Agentic Payment on
 * HSK Chain testnet, run against the demo service with the chosen faults, and repaid through HSP
 * when a case calls for it. Startup fails unless HSP lists all its tools, its chain configuration
 * names exactly one USDC token on chain 133 with a pinned EIP-712 domain, and that token's own
 * DOMAIN_SEPARATOR matches the pin. There are no seeded cases: every case comes from a purchase.
 */
export async function startHspDemoWorld(db: DatabaseSync, options: { parties: FixtureParties; hsp: HspConfig; tickMs: number; onError?: (error: unknown) => void }): Promise<HspDemoWorld> {
  const { hsp } = options;
  const mcp = new McpHttpClient({
    url: hsp.mcpUrl,
    clientInfo: { name: "settleback", version: "0.1.0" },
    timeoutMs: MCP_TIMEOUT_MS,
    ...(hsp.relayToken === undefined ? {} : { headers: { "x-settleback-relay": hsp.relayToken.reveal() } }),
  });
  const client = new HspAgenticClient(mcp);
  await client.verifyTools();
  const token = selectPaymentToken(await client.chainConfig(), { chainId: HSK_TESTNET, symbol: "USDC" });
  if (token.protocol !== "eip3009") throw new Error(`HSP pays USDC on chain ${HSK_TESTNET} with ${token.protocol}; this build signs eip3009 authorizations only.`);
  if (tokenDomain(token.chainId, token.address) === undefined) throw new Error(`HSP's USDC ${token.address} on chain ${token.chainId} has no pinned EIP-712 domain; pin it before paying with it.`);
  const transfers = await TokenTransferReader.connect({ rpcUrl: hsp.paymentRpcUrl, chainId: token.chainId, token: token.address, timeoutMs: RPC_TIMEOUT_MS });
  const rail = new HspAgenticRail({ client, transfers, merchantName: hsp.merchantName, token, clock: systemClock });

  registerFixturePolicies(db);
  const source = loadSources()[0];
  const policy = TERMS.get("extraction-delivery-v1");
  if (source === undefined || policy === undefined) throw new Error("the demo's source document or delivery terms are missing");
  const seller = options.parties.seller.toLowerCase() as Address;
  const purchases = new DemoPurchases(db, {
    seller,
    payments: hspPurchasePayments({ rail, limits: { ...DEMO_BUYER_LIMITS, payeeAllowlist: [seller] }, deploymentId: "hsp-testnet-demo", label: "Structured extraction job" }),
    source: { id: source.id, text: loadSourceBytes(source).toString("utf8"), sha256: source.sourceSha256 },
    policy: { id: policy.id, sha256: policy.sha256 },
    now: () => new Date(),
  });

  const timer = setInterval(() => {
    void purchases.tick().catch((error: unknown) => options.onError?.(error));
  }, options.tickMs);
  timer.unref();

  return {
    cases: [],
    terms: TERMS,
    lookup: purchases.lookup,
    rail,
    payments: { kind: "hsp-agentic", rail, deploymentId: "hsp-testnet-demo", maxFeeBaseUnits: DEMO_BUYER_LIMITS.maxFeeBaseUnits },
    purchases,
    stop: () => clearInterval(timer),
  };
}

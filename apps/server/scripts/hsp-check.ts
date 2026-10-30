// Checks HSP Agentic Payment before a demo, without creating an order or moving anything: the
// endpoint answers (from this machine, or through the team's relay), all eight tools are listed
// with their live input schemas, get_chain_config names exactly one USDC token on HSK Chain
// testnet with a pinned EIP-712 domain that the token itself confirms, and the demo buyer and
// seller hold that token. It reads only; the guide's advice not to hammer a blocked endpoint holds.
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HspAgenticClient, McpHttpClient, TokenTransferReader, selectPaymentToken } from "@settleback/adapters";
import type { Address } from "@settleback/domain";

const MCP_URL = process.env.SETTLEBACK_HSP_MCP_URL ?? "https://mcp-qa.hashkeymerchant.com/";
const RPC_URL = process.env.SETTLEBACK_DEMO_RPC_URL ?? "https://testnet.hsk.xyz";
const KEYS = (process.env.SETTLEBACK_DEMO_KEYS ?? `${homedir()}/.config/settleback/testnet-demo`).replace(/^~(?=\/)/, homedir());
const RELAY_TOKEN_FILE = (process.env.SETTLEBACK_HSP_RELAY_TOKEN_FILE ?? `${homedir()}/.config/settleback/hsp-relay.token`).replace(/^~(?=\/)/, homedir());

const relayed = process.env.SETTLEBACK_HSP_MCP_URL !== undefined && existsSync(RELAY_TOKEN_FILE);
const headers: Record<string, string> = {};
if (relayed) {
  if ((statSync(RELAY_TOKEN_FILE).mode & 0o077) !== 0) fail(`${RELAY_TOKEN_FILE} is readable by other users; restrict it with chmod 600.`);
  headers["x-settleback-relay"] = readFileSync(RELAY_TOKEN_FILE, "utf8").trim();
}

console.log(`HSP endpoint: ${MCP_URL}${relayed ? " (through the relay)" : ""}`);
const health = await fetch(new URL("health", MCP_URL), { headers, signal: AbortSignal.timeout(15_000) }).catch((error: unknown) => error as Error);
if (health instanceof Error) fail(`  health: unreachable (${health.message})`);
const body = await health.text();
console.log(`  health: HTTP ${health.status} ${body.slice(0, 80)}`);
if (health.status === 403) fail("  HSP refuses this address: it is not on the QA allowlist yet. Wait for HSP's confirmation before retrying.");
if (health.status === 404 && relayed) fail("  The relay refused the request: check the relay token file.");

const client = new HspAgenticClient(new McpHttpClient({ url: MCP_URL, clientInfo: { name: "settleback-check", version: "0.1.0" }, timeoutMs: 30_000, headers }));
let tools: Awaited<ReturnType<HspAgenticClient["verifyTools"]>>;
try {
  tools = await client.verifyTools();
} catch (error) {
  fail(`  tools: ${error instanceof Error ? error.message : String(error)}`);
}
console.log("  tools: all eight listed. Live input schemas:");
for (const tool of tools) {
  const schema = tool.inputSchema as { properties?: Record<string, { type?: unknown }>; required?: string[] };
  const params = Object.entries(schema.properties ?? {}).map(([name, spec]) => `${name}${(schema.required ?? []).includes(name) ? "" : "?"}: ${JSON.stringify(spec.type ?? "any")}`);
  console.log(`    ${tool.name}(${params.join(", ")})`);
}

let config: unknown;
try {
  config = await client.chainConfig();
} catch (error) {
  fail(`  get_chain_config: ${error instanceof Error ? error.message : String(error)}`);
}
console.log("  get_chain_config:");
console.log(
  JSON.stringify(config, null, 2)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n"),
);
const token = selectPaymentToken(config, { chainId: 133, symbol: "USDC" });
console.log(`  payment token: ${token.symbol} ${token.address} on ${token.network} (${token.chainId}), ${token.decimals} decimals, ${token.protocol}`);
if (token.protocol !== "eip3009") fail(`  ${token.protocol} authorizations are not supported by this build.`);

const reader = await TokenTransferReader.connect({ rpcUrl: RPC_URL, chainId: 133, token: token.address, timeoutMs: 15_000 }).catch((error: unknown) => {
  fail(`  token: ${error instanceof Error ? error.message : String(error)}`);
});
console.log("  token: its DOMAIN_SEPARATOR matches the pinned EIP-712 domain");
for (const role of ["buyer", "seller"] as const) {
  const file = `${KEYS}/${role}.key`;
  if (!existsSync(file)) {
    console.log(`  ${role}: no key file at ${file}`);
    continue;
  }
  const holder = privateKeyToAccount(readFileSync(file, "utf8").trim() as Hex).address.toLowerCase() as Address;
  const balance = await reader.balanceOf(holder);
  console.log(`  ${role.padEnd(6)} ${holder}  ${balance.toString()} base units${balance === 0n ? "  <- needs test USDC" : ""}`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

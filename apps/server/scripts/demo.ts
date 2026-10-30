// Starts the demonstration. By default the server is seeded with the fixture cases and the
// RecoveryRegistry is deployed to a disposable anvil chain (npm run demo). With --hsk-testnet the
// server uses the demo registry already deployed on HSK Chain testnet, with keys kept outside the
// repository (npm run demo:testnet); payments stay simulated. With --hsp, jobs bought in the
// workspace and their repayments are paid through HSP Agentic Payment on HSK Chain testnet
// (npm run demo:hsp), with the same registry and keys and no seeded cases.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createPublicClient, formatEther, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deployRegistry } from "@settleback/adapters";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CONTRACTS = `${ROOT}contracts/`;
const ARTIFACT = `${CONTRACTS}out/RecoveryRegistry.sol/RecoveryRegistry.json`;
const SERVER = `${ROOT}apps/server/`;
const CHAIN_ID = 31337;
const RPC_PORT = Number(process.env.SETTLEBACK_DEMO_RPC_PORT ?? "8545");
// The demo registry on HSK Chain testnet: the same contract as the main testnet deployment, with its
// own verifier, so the simulated payments its cases reference never mix with the main registry's records.
const HSK_TESTNET = {
  chainId: 133,
  rpcUrl: process.env.SETTLEBACK_DEMO_RPC_URL ?? "https://testnet.hsk.xyz",
  registry: (process.env.SETTLEBACK_DEMO_REGISTRY_ADDRESS ?? "0xf1F8FD66A678693C1Ff02611c285ba105562de34") as `0x${string}`,
  explorer: "https://testnet-explorer.hskchain.net",
  // .env files do not expand ~, so a leading ~/ is expanded here.
  keys: (process.env.SETTLEBACK_DEMO_KEYS ?? `${homedir()}/.config/settleback/testnet-demo`).replace(/^~(?=\/)/, homedir()),
};
const ROLES = ["verifier", "buyer", "seller", "operator"] as const;
// Only these settings reach the demo server; a live environment's registry, keys, or database in .env never do.
const FORWARDED = [
  "ANTHROPIC_API_KEY",
  "SETTLEBACK_ASSESSMENT_MODEL",
  "SETTLEBACK_ASSESSMENT_EFFORT",
  "SETTLEBACK_ASSESSMENT_MAX_TOKENS",
  "SETTLEBACK_ASSESSMENT_TIMEOUT_MS",
  "SETTLEBACK_LOG_LEVEL",
  "SETTLEBACK_PORT",
];
// HSP Agentic Payment: the endpoint (HSP's, or the team's relay from an allowlisted address) and the team name.
const HSP_FORWARDED = ["SETTLEBACK_HSP_MCP_URL", "SETTLEBACK_HSP_MERCHANT_NAME", "SETTLEBACK_DB_PATH"];
const RELAY_TOKEN_FILE = (process.env.SETTLEBACK_HSP_RELAY_TOKEN_FILE ?? `${homedir()}/.config/settleback/hsp-relay.token`).replace(/^~(?=\/)/, homedir());

const children: ChildProcess[] = [];
const stop = (code: number): never => {
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
};
process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));

const args = process.argv.slice(2);
for (const arg of args) if (arg !== "--hsk-testnet" && arg !== "--hsp") fail(`Unknown option "${arg}". The options are --hsk-testnet and --hsp.`);
const throughHsp = args.includes("--hsp");
const onHskTestnet = throughHsp || args.includes("--hsk-testnet");
const address = (key: Hex) => privateKeyToAccount(key).address;
const network = onHskTestnet ? await hskTestnet() : await localChain();
const { rpcUrl, chainId, registry, verifier, buyer, seller, operator } = network;

const forwarded = Object.fromEntries([...FORWARDED, ...(throughHsp ? HSP_FORWARDED : [])].flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name] as string]])));
const hspSettings = throughHsp ? hspEnvironment() : {};
const server = spawn(process.execPath, ["src/main.ts"], {
  cwd: SERVER,
  stdio: "inherit",
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...forwarded,
    ...hspSettings,
    SETTLEBACK_ENV: throughHsp ? "testnet" : "local",
    SETTLEBACK_DEMO: throughHsp ? "hsp-testnet" : "fixtures",
    SETTLEBACK_DEMO_BUYER: address(buyer),
    SETTLEBACK_DEMO_SELLER: address(seller),
    SETTLEBACK_OPERATORS: address(operator),
    SETTLEBACK_PAYMENT_WRITES: "enabled",
    ...(onHskTestnet && !throughHsp ? { SETTLEBACK_DEMO_REGISTRY: "hsk-testnet" } : {}),
    SETTLEBACK_REGISTRY_RPC_URL: rpcUrl,
    SETTLEBACK_REGISTRY_CHAIN_ID: String(chainId),
    SETTLEBACK_REGISTRY_ADDRESS: registry,
    SETTLEBACK_VERIFIER_PRIVATE_KEY: verifier,
  },
});
children.push(server);
server.once("exit", (code) => stop(code ?? 1));

const assessments = forwarded.ANTHROPIC_API_KEY === undefined ? "off (no ANTHROPIC_API_KEY in .env); requests are recorded as failed" : "Claude, from ANTHROPIC_API_KEY in .env";
console.log(
  (throughHsp
    ? [
        "",
        "SettleBack on HSK Chain testnet with HSP Agentic Payment. Purchases and repayments are real testnet payments through HSP;",
        "  the job service is the demo's, with the faults you choose; the RecoveryRegistry is live. Records are kept in data/.",
        `  HSP endpoint: ${hspSettings.SETTLEBACK_HSP_MCP_URL ?? "HSP QA"}${hspSettings.SETTLEBACK_HSP_RELAY_TOKEN === undefined ? "" : " (relay, token from file)"}; team name: ${hspSettings.SETTLEBACK_HSP_MERCHANT_NAME}`,
        `  Wallet network: HSK Chain testnet, RPC ${rpcUrl}, chain ID ${chainId}`,
        `  RecoveryRegistry: ${registry}  ${HSK_TESTNET.explorer}/address/${registry}`,
        `  Accounts (import the key files into a wallet used only for this demo; keys in ${HSK_TESTNET.keys}):`,
        ...network.balances.map((line) => `    ${line}`),
        "  The buyer and the seller each need HSP's test USDC; npm run hsp:check shows the token and both balances.",
      ]
    : onHskTestnet
    ? [
        "",
        "SettleBack demo on HSK Chain testnet. Payments, the gateway, and the job service are simulated; the RecoveryRegistry is live.",
        "  Every case it registers references a simulated payment, so it uses its own demo registry, never the main one.",
        `  Wallet network: HSK Chain testnet, RPC ${rpcUrl}, chain ID ${chainId}`,
        `  RecoveryRegistry: ${registry}  ${HSK_TESTNET.explorer}/address/${registry}`,
        `  Accounts (import the key files into a wallet used only for this demo; keys in ${HSK_TESTNET.keys}):`,
        ...network.balances.map((line) => `    ${line}`),
      ]
    : [
        "",
        "SettleBack local demo. Everything here is simulated and disposable; nothing touches a real network.",
        `  Wallet network: RPC ${rpcUrl}, chain ID ${chainId}`,
        `  RecoveryRegistry: ${registry}`,
        "  Accounts (anvil's public test keys; never send real funds to them):",
        `    buyer     ${address(buyer)}  ${buyer}`,
        `    seller    ${address(seller)}  ${seller}`,
        `    operator  ${address(operator)}  ${operator}`,
      ]
  )
    .concat([
      `  Assessments: ${assessments}`,
      `  Then run npm run dev:web and open http://localhost:5173. Ctrl+C stops ${onHskTestnet ? "" : "the chain and "}the server.`,
      "",
    ])
    .join("\n"),
);

interface DemoNetwork {
  rpcUrl: string;
  chainId: number;
  registry: `0x${string}`;
  verifier: Hex;
  buyer: Hex;
  seller: Hex;
  operator: Hex;
  balances: string[];
}

/** A disposable anvil chain with a freshly deployed registry and anvil's public test accounts. */
async function localChain(): Promise<DemoNetwork> {
  if (!Number.isInteger(RPC_PORT) || RPC_PORT < 1 || RPC_PORT > 65535) fail(`SETTLEBACK_DEMO_RPC_PORT must be a port number, got "${process.env.SETTLEBACK_DEMO_RPC_PORT}".`);
  if (!(await portFree(RPC_PORT))) fail(`Port ${RPC_PORT} is in use. Stop whatever listens there or set SETTLEBACK_DEMO_RPC_PORT.`);
  if (!existsSync(ARTIFACT)) {
    const build = spawnSync("forge", ["build", "--root", CONTRACTS], { stdio: "inherit" });
    if (build.status !== 0) fail("forge build failed; install Foundry (https://getfoundry.sh/) and retry.");
  }
  const anvil = spawn("anvil", ["--port", String(RPC_PORT), "--chain-id", String(CHAIN_ID)], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(anvil);
  anvil.once("exit", (code) => {
    console.error(`anvil exited (${code ?? "signal"}).`);
    stop(1);
  });
  const keys = await anvilKeys(anvil);
  const rpcUrl = `http://127.0.0.1:${RPC_PORT}`;
  const [deployer, verifier, buyer, seller, operator] = keys;
  if (deployer === undefined || verifier === undefined || buyer === undefined || seller === undefined || operator === undefined) fail("anvil printed fewer than five accounts.");
  const registry = await deployRegistry({ rpcUrl, chainId: CHAIN_ID, deployerPrivateKey: deployer, verifier: address(verifier).toLowerCase() as `0x${string}`, artifactPath: ARTIFACT });
  return { rpcUrl, chainId: CHAIN_ID, registry, verifier, buyer, seller, operator, balances: [] };
}

/**
 * The demo registry on HSK Chain testnet, with keys read from files only the current user can read.
 * The verifier pays for registry writes and the seller for its reservations, so both need testnet HSK.
 */
async function hskTestnet(): Promise<DemoNetwork> {
  const keys = Object.fromEntries(ROLES.map((role) => [role, readKey(`${HSK_TESTNET.keys}/${role}.key`)])) as Record<(typeof ROLES)[number], Hex>;
  const client = createPublicClient({ transport: http(HSK_TESTNET.rpcUrl, { timeout: 15_000 }) });
  const chainId = await client.getChainId();
  if (chainId !== HSK_TESTNET.chainId) fail(`${HSK_TESTNET.rpcUrl} serves chain ${chainId}, not HSK Chain testnet (${HSK_TESTNET.chainId}).`);
  // The server would refuse a key that is not the registry's verifier; say why, and what to do, before it starts.
  const registryVerifier = await client.readContract({ address: HSK_TESTNET.registry, abi: parseAbi(["function verifier() view returns (address)"]), functionName: "verifier" });
  if (registryVerifier.toLowerCase() !== address(keys.verifier).toLowerCase()) {
    fail(
      `The registry ${HSK_TESTNET.registry} has verifier ${registryVerifier}, not your verifier key ${address(keys.verifier)}. ` +
        "Deploy your own demo registry with your verifier (see README) and set SETTLEBACK_DEMO_REGISTRY_ADDRESS.",
    );
  }
  const balances: string[] = [];
  for (const role of ROLES) {
    const holder = address(keys[role]);
    const balance = await client.getBalance({ address: holder });
    const needsGas = role === "verifier" || role === "seller";
    if (needsGas && balance === 0n) fail(`The ${role} ${holder} has no testnet HSK; fund it from the faucet (https://hskchain.net/faucet) first.`);
    balances.push(`${role.padEnd(9)} ${holder}  ${formatEther(balance)} HSK${needsGas ? "" : " (needs none)"}`);
  }
  return { rpcUrl: HSK_TESTNET.rpcUrl, chainId, registry: HSK_TESTNET.registry, ...keys, balances };
}

/** The HSP settings the server needs; the relay token is read from a file only the current user can read, never echoed. */
function hspEnvironment(): Record<string, string> {
  const settings: Record<string, string> = {
    SETTLEBACK_HSP_MERCHANT_NAME: process.env.SETTLEBACK_HSP_MERCHANT_NAME ?? "SettleBack",
    SETTLEBACK_PAYMENT_RPC_URL: HSK_TESTNET.rpcUrl,
  };
  if (process.env.SETTLEBACK_HSP_MCP_URL !== undefined) settings.SETTLEBACK_HSP_MCP_URL = process.env.SETTLEBACK_HSP_MCP_URL;
  if (process.env.SETTLEBACK_HSP_MCP_URL !== undefined && existsSync(RELAY_TOKEN_FILE)) {
    if ((statSync(RELAY_TOKEN_FILE).mode & 0o077) !== 0) fail(`${RELAY_TOKEN_FILE} is readable by other users; restrict it with chmod 600.`);
    settings.SETTLEBACK_HSP_RELAY_TOKEN = readFileSync(RELAY_TOKEN_FILE, "utf8").trim();
  }
  return settings;
}

function readKey(file: string): Hex {
  if (!existsSync(file)) fail(`Missing ${file}. Run npm run demo:keys to create the demo keys, or set SETTLEBACK_DEMO_KEYS.`);
  if ((statSync(file).mode & 0o077) !== 0) fail(`${file} is readable by other users; restrict it with chmod 600.`);
  const key = readFileSync(file, "utf8").trim();
  // Never echo the value.
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) fail(`${file} must hold 0x followed by 64 hex digits.`);
  return key as Hex;
}

function anvilKeys(child: ChildProcess): Promise<Hex[]> {
  return new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error(`anvil did not start: ${text}`)), 15_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes("Listening on")) {
        clearTimeout(timer);
        resolve([...text.slice(text.indexOf("Private Keys")).matchAll(/0x[0-9a-f]{64}/g)].map((match) => match[0] as Hex).slice(0, 10));
      }
    });
    child.once("error", reject);
  });
}

function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

function fail(message: string): never {
  console.error(message);
  return stop(1);
}

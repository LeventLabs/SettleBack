// Starts the local demonstration: a disposable anvil chain with the RecoveryRegistry deployed, and
// the server seeded with the fixture cases. Usage, from the repository root: npm run demo
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deployRegistry } from "@settleback/adapters";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CONTRACTS = `${ROOT}contracts/`;
const ARTIFACT = `${CONTRACTS}out/RecoveryRegistry.sol/RecoveryRegistry.json`;
const SERVER = `${ROOT}apps/server/`;
const CHAIN_ID = 31337;
const RPC_PORT = Number(process.env.SETTLEBACK_DEMO_RPC_PORT ?? "8545");
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

const children: ChildProcess[] = [];
const stop = (code: number): never => {
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
};
process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));

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
const address = (key: Hex) => privateKeyToAccount(key).address;
const registry = await deployRegistry({ rpcUrl, chainId: CHAIN_ID, deployerPrivateKey: deployer, verifier: address(verifier).toLowerCase() as `0x${string}`, artifactPath: ARTIFACT });

const forwarded = Object.fromEntries(FORWARDED.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name] as string]])));
const server = spawn(process.execPath, ["src/main.ts"], {
  cwd: SERVER,
  stdio: "inherit",
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...forwarded,
    SETTLEBACK_ENV: "local",
    SETTLEBACK_DEMO: "fixtures",
    SETTLEBACK_DEMO_BUYER: address(buyer),
    SETTLEBACK_DEMO_SELLER: address(seller),
    SETTLEBACK_OPERATORS: address(operator),
    SETTLEBACK_PAYMENT_WRITES: "enabled",
    SETTLEBACK_REGISTRY_RPC_URL: rpcUrl,
    SETTLEBACK_REGISTRY_CHAIN_ID: String(CHAIN_ID),
    SETTLEBACK_REGISTRY_ADDRESS: registry,
    SETTLEBACK_VERIFIER_PRIVATE_KEY: verifier,
  },
});
children.push(server);
server.once("exit", (code) => stop(code ?? 1));

console.log(
  [
    "",
    "SettleBack local demo. Everything here is simulated and disposable; nothing touches a real network.",
    `  Wallet network: RPC ${rpcUrl}, chain ID ${CHAIN_ID}`,
    `  RecoveryRegistry: ${registry}`,
    "  Accounts (anvil's public test keys; never send real funds to them):",
    `    buyer     ${address(buyer)}  ${buyer}`,
    `    seller    ${address(seller)}  ${seller}`,
    `    operator  ${address(operator)}  ${operator}`,
    `  Assessments: ${forwarded.ANTHROPIC_API_KEY === undefined ? "off (no ANTHROPIC_API_KEY in .env); requests are recorded as failed" : "Claude, from ANTHROPIC_API_KEY in .env"}`,
    "  Then run npm run dev:web and open http://localhost:5173. Ctrl+C stops the chain and the server.",
    "",
  ].join("\n"),
);

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

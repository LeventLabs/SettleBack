import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { EvmRegistryGateway, deployRegistry, type WalletCall } from "@settleback/adapters";
import type { Address } from "@settleback/domain";

const CONTRACTS = fileURLToPath(new URL("../../../../contracts/", import.meta.url));
const ARTIFACT = `${CONTRACTS}out/RecoveryRegistry.sol/RecoveryRegistry.json`;
const CHAIN_ID = 31337;

export interface LocalChain {
  rpcUrl: string;
  keys: Hex[];
  registry: EvmRegistryGateway;
  /** Sends a wallet call from any address, the way that account's own wallet would. */
  sendAs(from: Address, call: WalletCall, gas?: bigint): Promise<Hex>;
  mined(hash: Hex): Promise<void>;
  rpc(method: string, params?: unknown[]): Promise<unknown>;
  addressOf(key: Hex): Address;
  stop(): void;
}

/** A disposable anvil chain with the RecoveryRegistry deployed and a verifier-keyed gateway. */
export async function startLocalChain(port: number, confirmations = 1): Promise<LocalChain> {
  if (!existsSync(ARTIFACT)) {
    const build = spawnSync("forge", ["build", "--root", CONTRACTS], { encoding: "utf8" });
    if (build.status !== 0) throw new Error(`forge build failed: ${build.stderr}`);
  }
  const rpcUrl = `http://127.0.0.1:${port}`;
  const anvil: ChildProcess = spawn("anvil", ["--port", String(port), "--chain-id", String(CHAIN_ID)], { stdio: ["ignore", "pipe", "pipe"] });
  const output = await new Promise<string>((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error(`anvil did not start: ${text}`)), 15_000);
    anvil.stdout?.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes("Listening on")) {
        clearTimeout(timer);
        resolve(text);
      }
    });
    anvil.on("error", reject);
  });
  const keys = [...output.slice(output.indexOf("Private Keys")).matchAll(/0x[0-9a-f]{64}/g)].map((match) => match[0] as Hex).slice(0, 10);
  const addressOf = (key: Hex) => privateKeyToAccount(key).address.toLowerCase() as Address;
  const verifierKey = keys[1] as Hex;
  const address = await deployRegistry({ rpcUrl, chainId: CHAIN_ID, deployerPrivateKey: keys[0] as Hex, verifier: addressOf(verifierKey), artifactPath: ARTIFACT });
  const registry = await EvmRegistryGateway.connect({ rpcUrl, chainId: CHAIN_ID, address, provenance: "SIMULATED", verifierPrivateKey: verifierKey, confirmations, timeoutMs: 10_000 });
  const chain = defineChain({ id: CHAIN_ID, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  const rpc = async (method: string, params: unknown[] = []) => {
    const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return ((await response.json()) as { result: unknown }).result;
  };
  return {
    rpcUrl,
    keys,
    registry,
    addressOf,
    rpc,
    async sendAs(from, call, gas) {
      await rpc("anvil_impersonateAccount", [from]);
      await rpc("anvil_setBalance", [from, "0x56BC75E2D63100000"]);
      const wallet = createWalletClient({ account: from, chain, transport: http(rpcUrl) });
      return wallet.sendTransaction({ to: call.to, data: call.data as Hex, ...(gas === undefined ? {} : { gas }) });
    },
    async mined(hash) {
      await client.waitForTransactionReceipt({ hash });
    },
    stop() {
      anvil.kill();
    },
  };
}

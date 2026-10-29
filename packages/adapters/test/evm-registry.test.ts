import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, custom, defineChain, http, type Hex, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Address } from "@settleback/domain";
import {
  EvmRegistryGateway,
  RECOVERY_REGISTRY_ABI,
  RegistryConfigurationError,
  RegistryRevertError,
  deployRegistry,
  type RegisterCaseInput,
  type RegistryPolicyTerms,
  type WalletCall,
} from "../src/index.ts";

const CONTRACTS = fileURLToPath(new URL("../../../contracts/", import.meta.url));
const ARTIFACT = `${CONTRACTS}out/RecoveryRegistry.sol/RecoveryRegistry.json`;
const CHAIN_ID = 31337;
const PORT = 20_000 + (process.pid % 10_000);
const RPC = `http://127.0.0.1:${PORT}`;
const TOKEN = "0x8fe3cb719ee4410e236cd6b72ab1fcdc06ef53c6" as Address;
const SHA = (seed: string) => seed.repeat(64).slice(0, 64);

let anvil: ChildProcess;
let keys: Hex[];
let registry: Address;
let gateway: EvmRegistryGateway;
const chain = defineChain({ id: CHAIN_ID, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const client = createPublicClient({ chain, transport: http(RPC) });

const addressOf = (key: Hex) => privateKeyToAccount(key).address.toLowerCase() as Address;
const verifierKey = () => keys[1] as Hex;
const sellerKey = () => keys[2] as Hex;
const delegateKey = () => keys[4] as Hex;
const strangerKey = () => keys[5] as Hex;

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return ((await response.json()) as { result: unknown }).result;
}

/** Like `rpc`, but a JSON-RPC error is thrown with its code, as a node would report it. */
async function forward(method: string, params: readonly unknown[] = []): Promise<unknown> {
  const response = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await response.json()) as { result?: unknown; error?: { code: number; message: string } };
  if (body.error !== undefined) throw Object.assign(new Error(body.error.message), { code: body.error.code });
  return body.result;
}

interface LaggingNodes {
  transport: Transport;
  /** The next lookups reach a node that has not received the transaction at all. */
  hideTransactions: (lookups: number) => void;
  /** The next transaction count comes from a node that has not seen the account's latest transaction. */
  staleNonce: () => void;
  /** After `skip` more block-number requests, one is answered with `head` by a node that far behind. */
  staleHead: (skip: number, head: bigint) => void;
}

/**
 * A load-balanced RPC whose replicas lag. State at the "latest" tag comes from a replica `lag`
 * blocks behind the head; a request naming a block is served at that block, or fails if no replica
 * has it yet. With `alternate`, block numbers, transaction counts, receipts, and transactions also
 * alternate between an up-to-date node and the lagging one.
 */
function laggingTransport({ lag = 5n, alternate = true }: { lag?: bigint; alternate?: boolean } = {}): LaggingNodes {
  let turn = 0;
  let hidden = 0;
  let nonceBehind = false;
  let headOverride: { skip: number; head: bigint } | undefined;
  const transport = custom({
    async request({ method, params }: { method: string; params?: readonly unknown[] }) {
      const args = params ?? [];
      const head = BigInt((await forward("eth_blockNumber")) as string);
      const behind = head > lag ? head - lag : 0n;
      turn += 1;
      const stale = alternate && turn % 2 === 0;
      const at = (tag: unknown): string => {
        if (typeof tag === "string" && tag.startsWith("0x")) {
          if (BigInt(tag) > head) throw Object.assign(new Error("header not found"), { code: -32000 });
          return tag;
        }
        return `0x${behind.toString(16)}`;
      };
      switch (method) {
        case "eth_blockNumber":
          if (headOverride !== undefined) {
            if (headOverride.skip > 0) {
              headOverride.skip -= 1;
              return `0x${head.toString(16)}`;
            }
            const answer = headOverride.head;
            headOverride = undefined;
            return `0x${answer.toString(16)}`;
          }
          return `0x${(stale ? behind : head).toString(16)}`;
        case "eth_call":
        case "eth_estimateGas":
          return forward(method, [args[0], at(args[1])]);
        case "eth_getTransactionCount": {
          if (nonceBehind) {
            nonceBehind = false;
            return `0x${(BigInt((await forward(method, args)) as string) - 1n).toString(16)}`;
          }
          return stale ? forward(method, [args[0], at(args[1])]) : forward(method, args);
        }
        case "eth_fillTransaction":
          // Not offered, so a wallet that does not fill in every field estimates gas at the lagging "latest".
          throw Object.assign(new Error("the method eth_fillTransaction does not exist/is not available"), { code: -32601 });
        case "eth_getTransactionReceipt": {
          if (hidden > 0) {
            hidden -= 1;
            return null;
          }
          const receipt = (await forward(method, args)) as { blockNumber: string } | null;
          return receipt !== null && (!stale || BigInt(receipt.blockNumber) <= behind) ? receipt : null;
        }
        case "eth_getTransactionByHash": {
          if (hidden > 0) {
            hidden -= 1;
            return null;
          }
          const transaction = (await forward(method, args)) as { blockNumber: string | null } | null;
          return transaction !== null && (!stale || (transaction.blockNumber !== null && BigInt(transaction.blockNumber) <= behind)) ? transaction : null;
        }
        default:
          return forward(method, args);
      }
    },
  // Like the gateway's own HTTP transport, nothing is retried underneath it.
  }, { retryCount: 0 });
  return {
    transport,
    hideTransactions: (lookups) => (hidden = lookups),
    staleNonce: () => (nonceBehind = true),
    staleHead: (skip, at) => (headOverride = { skip, head: at }),
  };
}

/** Sends a prepared wallet call as `key`, the way the seller's wallet or delegate would. */
async function send(key: Hex, call: WalletCall, gas?: bigint): Promise<Hex> {
  const wallet = createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(RPC) });
  // An explicit gas limit skips estimation, so a call the contract refuses is still mined, as a revert.
  return wallet.sendTransaction({ to: call.to, data: call.data as Hex, ...(gas === undefined ? {} : { gas }) });
}

async function mined(hash: Hex): Promise<void> {
  await client.waitForTransactionReceipt({ hash });
}

let caseCounter = 0;
async function caseInput(overrides: Partial<RegisterCaseInput> = {}): Promise<RegisterCaseInput> {
  caseCounter += 1;
  const block = await client.getBlock();
  const id = caseCounter.toString(16).padStart(64, "0");
  return {
    caseKey: `0x${id}`,
    buyer: addressOf(keys[3] as Hex),
    seller: addressOf(sellerKey()),
    token: TOKEN,
    amountBaseUnits: "1000000",
    originalRef: { chainId: 133, txHash: `0x${"ab".repeat(31)}${caseCounter.toString(16).padStart(2, "0")}` },
    policySha256: SHA("a"),
    eligibilityRulesSha256: SHA("b"),
    autoEligible: true,
    actionDigest: SHA("c"),
    evidenceDigest: SHA("d"),
    actionKind: "REPAY",
    deadline: new Date((Number(block.timestamp) + 86_400) * 1000).toISOString(),
    ...overrides,
  };
}

beforeAll(async () => {
  if (!existsSync(ARTIFACT)) {
    const build = spawnSync("forge", ["build", "--root", CONTRACTS], { encoding: "utf8" });
    if (build.status !== 0) throw new Error(`forge build failed: ${build.stderr}`);
  }
  anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", String(CHAIN_ID)], { stdio: ["ignore", "pipe", "pipe"] });
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
  keys = [...output.slice(output.indexOf("Private Keys")).matchAll(/0x[0-9a-f]{64}/g)].map((match) => match[0] as Hex).slice(0, 10);
  registry = await deployRegistry({ rpcUrl: RPC, chainId: CHAIN_ID, deployerPrivateKey: keys[0] as Hex, verifier: addressOf(verifierKey()), artifactPath: ARTIFACT });
  gateway = await EvmRegistryGateway.connect({ rpcUrl: RPC, chainId: CHAIN_ID, address: registry, provenance: "SIMULATED", verifierPrivateKey: verifierKey(), confirmations: 1, timeoutMs: 10_000 });
}, 120_000);

afterAll(() => {
  anvil?.kill();
});

describe("registry ABI", () => {
  it("matches the Foundry build of the contract", () => {
    const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8")) as { abi: unknown };
    expect(JSON.parse(JSON.stringify(RECOVERY_REGISTRY_ABI))).toEqual(artifact.abi);
  });
});

describe("connecting to the registry", () => {
  it("refuses a wrong chain, an address without code, and a key that is not the verifier", async () => {
    const base = { rpcUrl: RPC, address: registry, provenance: "SIMULATED" as const, confirmations: 1, timeoutMs: 5_000 };
    await expect(EvmRegistryGateway.connect({ ...base, chainId: 133 })).rejects.toThrow(/serves chain 31337/);
    await expect(EvmRegistryGateway.connect({ ...base, chainId: CHAIN_ID, address: addressOf(strangerKey()) })).rejects.toThrow(/no contract/);
    await expect(EvmRegistryGateway.connect({ ...base, chainId: CHAIN_ID, verifierPrivateKey: strangerKey() })).rejects.toThrow(/not the registry's verifier/);
    await expect(EvmRegistryGateway.connect({ ...base, chainId: CHAIN_ID, confirmations: 0 })).rejects.toBeInstanceOf(RegistryConfigurationError);
  });

  it("reads without a verifier key but refuses to write", async () => {
    const reader = await EvmRegistryGateway.connect({ rpcUrl: RPC, chainId: CHAIN_ID, address: registry, provenance: "SIMULATED", confirmations: 1, timeoutMs: 5_000 });
    expect(await reader.activePolicyId(addressOf(sellerKey()), 133, TOKEN)).toBe(0);
    await expect(reader.registerCase(await caseInput())).rejects.toThrow(/no verifier key/);
  });

  it("will not deploy to HSK Chain from this helper", async () => {
    await expect(deployRegistry({ rpcUrl: RPC, chainId: 133, deployerPrivateKey: keys[0] as Hex, verifier: addressOf(verifierKey()), artifactPath: ARTIFACT })).rejects.toThrow(
      /Foundry scripts/,
    );
  });
});

describe("verifier writes", () => {
  it("registers a case and reads every field back", async () => {
    const input = await caseInput();
    const write = await gateway.registerCase(input);
    expect(write.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    const record = await gateway.readCase(input.caseKey);
    expect(record).toEqual({
      ...input,
      deadline: new Date(Math.floor(Date.parse(input.deadline) / 1000) * 1000).toISOString(),
      state: "OPEN",
      mode: "NONE",
      authorizationId: 0,
      outcomeRef: null,
      outcomeCommitment: null,
    });
    expect(await gateway.readCase(`0x${"f".repeat(64)}`)).toBeUndefined();
  });

  it("reports contract refusals by their error names without sending a transaction", async () => {
    const input = await caseInput();
    await gateway.registerCase(input);
    const before = await client.getTransactionCount({ address: addressOf(verifierKey()) });
    await expect(gateway.registerCase(input)).rejects.toMatchObject({ reason: "CaseExists" });
    await expect(gateway.registerCase({ ...(await caseInput()), originalRef: input.originalRef })).rejects.toMatchObject({ reason: "ReferenceAlreadyUsed" });
    await expect(gateway.registerCase(await caseInput({ deadline: "2020-01-01T00:00:00.000Z" }))).rejects.toMatchObject({ reason: "DeadlineNotInFuture" });
    await expect(gateway.completeRepayment(input.caseKey, `0x${"9".repeat(64)}`, SHA("e"))).rejects.toMatchObject({ reason: "WrongState" });
    await expect(gateway.registerCase({ ...(await caseInput()), policySha256: "nothex" })).rejects.toBeInstanceOf(RegistryRevertError);
    expect(await client.getTransactionCount({ address: addressOf(verifierKey()) })).toBe(before);
  });

  it("sends concurrent writes one after another from the one verifier account", async () => {
    const inputs: RegisterCaseInput[] = [];
    for (let i = 0; i < 3; i += 1) inputs.push(await caseInput({ actionKind: "RETRIEVE", autoEligible: false }));
    const writes = await Promise.all(inputs.map((input) => gateway.registerCase(input)));
    expect(new Set(writes.map((write) => write.txHash)).size).toBe(3);
    for (const input of inputs) expect((await gateway.readCase(input.caseKey))?.state).toBe("OPEN");
    // A duplicate sent at the same time simulates after the first landed and is refused without a transaction.
    const [input] = inputs;
    if (input === undefined) throw new Error("expected a case");
    const results = await Promise.allSettled([gateway.reserveRetrieval(input.caseKey), gateway.reserveRetrieval(input.caseKey)]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(results[1]).toMatchObject({ reason: { reason: "WrongState" } });
  });

  it("reserves and completes a retrieval", async () => {
    const input = await caseInput({ actionKind: "RETRIEVE", autoEligible: false });
    await gateway.registerCase(input);
    await gateway.reserveRetrieval(input.caseKey);
    await gateway.completeRetrieval(input.caseKey, SHA("1"), SHA("2"));
    expect(await gateway.readCase(input.caseKey)).toMatchObject({ state: "RECOVERED", outcomeRef: `0x${SHA("1")}`, outcomeCommitment: SHA("2") });
  });
});

describe("confirming a seller's reservation from the chain", () => {
  it("confirms a per-case reservation sent from the seller's wallet, then the verifier records the repayment", async () => {
    const input = await caseInput();
    await gateway.registerCase(input);
    const hash = await send(sellerKey(), gateway.reserveRepaymentCall(input.caseKey));
    await mined(hash);
    const scope = (await gateway.readBudget(input.seller, 133, TOKEN)).scope;
    expect(await gateway.confirmReservation(hash, { caseKey: input.caseKey, mode: "PER_CASE", reservedBy: input.seller })).toEqual({
      status: "CONFIRMED",
      txHash: hash,
      blockNumber: expect.any(Number),
      confirmations: 1,
      amountBaseUnits: "1000000",
      scope,
    });
    expect(Number((await gateway.readBudget(input.seller, 133, TOKEN)).outstandingBaseUnits)).toBeGreaterThanOrEqual(1_000_000);

    await gateway.completeRepayment(input.caseKey, `0x${"7".repeat(63)}1`, SHA("e"));
    expect(await gateway.readCase(input.caseKey)).toMatchObject({ state: "REPAID", outcomeRef: `0x${"7".repeat(63)}1` });
    // The reservation is still confirmed after completion.
    expect((await gateway.confirmReservation(hash, { caseKey: input.caseKey, mode: "PER_CASE", reservedBy: input.seller })).status).toBe("CONFIRMED");
  });

  it("never counts an unrelated or mismatched transaction as the reservation", async () => {
    const input = await caseInput();
    const other = await caseInput();
    await gateway.registerCase(input);
    await gateway.registerCase(other);
    const otherHash = await send(sellerKey(), gateway.reserveRepaymentCall(other.caseKey));
    await mined(otherHash);
    const transfer = await createWalletClient({ account: privateKeyToAccount(sellerKey()), chain, transport: http(RPC) }).sendTransaction({
      to: addressOf(strangerKey()),
      value: 1n,
    });
    await mined(transfer);
    const strangerTry = await send(strangerKey(), gateway.reserveRepaymentCall(input.caseKey), 200_000n);
    await client.waitForTransactionReceipt({ hash: strangerTry });
    const expect_ = { caseKey: input.caseKey, mode: "PER_CASE" as const, reservedBy: input.seller };
    expect(await gateway.confirmReservation(transfer, expect_)).toMatchObject({ status: "REJECTED", reason: expect.stringMatching(/not a call to this registry/) });
    expect(await gateway.confirmReservation(otherHash, expect_)).toMatchObject({ status: "REJECTED", reason: expect.stringMatching(/did not reserve this case/) });
    expect(await gateway.confirmReservation(strangerTry, expect_)).toMatchObject({ status: "REJECTED", reason: expect.stringMatching(/reverted/) });
    expect(await gateway.confirmReservation(otherHash, { ...expect_, caseKey: other.caseKey, reservedBy: addressOf(strangerKey()) })).toMatchObject({
      status: "REJECTED",
      reason: expect.stringMatching(/another account/),
    });
    expect(await gateway.confirmReservation(otherHash, { ...expect_, caseKey: other.caseKey, mode: "STANDING_POLICY", authorizationId: 1 })).toMatchObject({
      status: "REJECTED",
      reason: expect.stringMatching(/PER_CASE mode/),
    });
    expect(await gateway.confirmReservation(`0x${"5".repeat(64)}`, expect_)).toMatchObject({ status: "REJECTED", reason: expect.stringMatching(/does not know/) });
    expect((await gateway.readCase(input.caseKey))?.state).toBe("OPEN");
  });

  it("keeps an unmined or shallow reservation pending", async () => {
    const strict = await EvmRegistryGateway.connect({ rpcUrl: RPC, chainId: CHAIN_ID, address: registry, provenance: "SIMULATED", confirmations: 2, timeoutMs: 5_000 });
    const input = await caseInput();
    await gateway.registerCase(input);
    const expectation = { caseKey: input.caseKey, mode: "PER_CASE" as const, reservedBy: input.seller };
    await rpc("evm_setAutomine", [false]);
    try {
      const hash = await send(sellerKey(), gateway.reserveRepaymentCall(input.caseKey));
      expect(await strict.confirmReservation(hash, expectation)).toEqual({ status: "PENDING", reason: "the transaction is not mined yet" });
      await rpc("evm_mine");
      expect(await strict.confirmReservation(hash, expectation)).toEqual({ status: "PENDING", reason: "1 of 2 confirmations" });
      await rpc("evm_mine");
      expect((await strict.confirmReservation(hash, expectation)).status).toBe("CONFIRMED");
    } finally {
      await rpc("evm_setAutomine", [true]);
    }
  });
});

describe("behind a load-balanced RPC with a node that lags", () => {
  it("reads its own writes, keeps its nonce, and confirms a reservation the lagging node has not seen", async () => {
    // The last test's transaction is in the head block, so the lagging node also reports an old nonce.
    await gateway.registerCase(await caseInput({ actionKind: "RETRIEVE", autoEligible: false }));
    const rpcNodes = laggingTransport();
    // The registry itself must be older than the lag, as a deployed contract is.
    for (let block = 0; block < 6; block += 1) await rpc("evm_mine");
    const lagging = await EvmRegistryGateway.connect({
      rpcUrl: RPC,
      chainId: CHAIN_ID,
      address: registry,
      provenance: "SIMULATED",
      verifierPrivateKey: verifierKey(),
      confirmations: 1,
      timeoutMs: 10_000,
      pollMs: 20,
      transport: rpcNodes.transport,
    });
    // A live chain keeps producing blocks; anvil mines only on demand.
    const miner = setInterval(() => void rpc("evm_mine"), 100);
    try {
      // Each step needs the state the one before it wrote.
      const retrieval = await caseInput({ actionKind: "RETRIEVE", autoEligible: false });
      await lagging.registerCase(retrieval);
      expect((await lagging.readCase(retrieval.caseKey))?.state).toBe("OPEN");
      await lagging.reserveRetrieval(retrieval.caseKey);
      expect((await lagging.readCase(retrieval.caseKey))?.state).toBe("RESERVED_RETRIEVE");
      const outcome = await lagging.completeRetrieval(retrieval.caseKey, SHA("1"), SHA("2"));
      expect(await lagging.readCase(retrieval.caseKey)).toMatchObject({ state: "RECOVERED", outcomeRef: `0x${SHA("1")}` });
      expect(outcome.txHash).toMatch(/^0x[0-9a-f]{64}$/);

      // A seller's reservation, reported the moment it is mined, may be pending on the lagging node,
      // but is never called unknown to the chain; asked again, as the workspace does, it is confirmed.
      const repayment = await caseInput();
      await lagging.registerCase(repayment);
      const hash = await send(sellerKey(), lagging.reserveRepaymentCall(repayment.caseKey));
      await mined(hash);
      rpcNodes.hideTransactions(2);
      const expectation = { caseKey: repayment.caseKey, mode: "PER_CASE" as const, reservedBy: repayment.seller };
      let confirmation = await lagging.confirmReservation(hash, expectation);
      for (let attempt = 0; confirmation.status === "PENDING" && attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        confirmation = await lagging.confirmReservation(hash, expectation);
      }
      expect(confirmation.status).toBe("CONFIRMED");
      await lagging.completeRepayment(repayment.caseKey, `0x${"8".repeat(63)}1`, SHA("e"));
      expect((await lagging.readCase(repayment.caseKey))?.state).toBe("REPAID");
    } finally {
      clearInterval(miner);
    }
  }, 60_000);
});

describe("a node one step behind, deterministically", () => {
  it("sends with the next nonce, and does not read a reservation from a node a block short of it", async () => {
    // The verifier has sent at least one transaction for a node to have missed.
    await gateway.registerCase(await caseInput({ actionKind: "RETRIEVE", autoEligible: false }));
    for (let block = 0; block < 6; block += 1) await rpc("evm_mine");
    const nodes = laggingTransport({ alternate: false });
    const lagging = await EvmRegistryGateway.connect({
      rpcUrl: RPC,
      chainId: CHAIN_ID,
      address: registry,
      provenance: "SIMULATED",
      verifierPrivateKey: verifierKey(),
      confirmations: 1,
      timeoutMs: 10_000,
      pollMs: 20,
      transport: nodes.transport,
    });
    const input = await caseInput();
    // The node asked for the nonce has not seen the verifier's last transaction.
    nodes.staleNonce();
    await lagging.registerCase(input);
    expect((await lagging.readCase(input.caseKey))?.state).toBe("OPEN");

    const hash = await send(sellerKey(), lagging.reserveRepaymentCall(input.caseKey));
    const { blockNumber } = await client.waitForTransactionReceipt({ hash });
    // Confirmations are counted from an up-to-date node; the read that follows reaches one a block short.
    nodes.staleHead(1, blockNumber - 1n);
    expect(await lagging.confirmReservation(hash, { caseKey: input.caseKey, mode: "PER_CASE", reservedBy: input.seller })).toMatchObject({ status: "CONFIRMED" });
  });
});

describe("standing policies through wallet calls", () => {
  it("activates a policy, lets the delegate reserve under it, and reads the budget", async () => {
    const block = await client.getBlock();
    const now = Number(block.timestamp);
    const terms: RegistryPolicyTerms = {
      delegate: addressOf(delegateKey()),
      signer: addressOf(keys[6] as Hex),
      token: TOKEN,
      paymentChainId: 177,
      servicePolicySha256: SHA("a"),
      eligibilityRulesSha256: SHA("b"),
      maxPerCaseBaseUnits: "2000000",
      dailyLimitBaseUnits: "5000000",
      validFrom: new Date(now * 1000).toISOString(),
      validUntil: new Date((now + 7 * 86_400) * 1000).toISOString(),
    };
    await mined(await send(sellerKey(), gateway.activatePolicyCall(terms)));
    const seller = addressOf(sellerKey());
    const id = await gateway.activePolicyId(seller, 177, TOKEN);
    expect(id).toBeGreaterThan(0);
    expect(await gateway.readPolicy(id)).toEqual({ authorizationId: id, seller, status: "ACTIVE", terms });
    expect(await gateway.readPolicy(9_999)).toBeUndefined();

    const input = await caseInput({ originalRef: { chainId: 177, txHash: `0x${"cd".repeat(32)}` } });
    await gateway.registerCase(input);
    const hash = await send(delegateKey(), gateway.reserveUnderPolicyCall(input.caseKey, id));
    await mined(hash);
    expect((await gateway.confirmReservation(hash, { caseKey: input.caseKey, mode: "STANDING_POLICY", reservedBy: terms.delegate, authorizationId: id })).status).toBe(
      "CONFIRMED",
    );
    expect(await gateway.confirmReservation(hash, { caseKey: input.caseKey, mode: "STANDING_POLICY", reservedBy: terms.delegate, authorizationId: id + 1 })).toMatchObject({
      status: "REJECTED",
    });
    expect(await gateway.confirmReservation(hash, { caseKey: input.caseKey, mode: "STANDING_POLICY", reservedBy: terms.delegate })).toMatchObject({ status: "REJECTED" });
    expect(await gateway.readBudget(seller, 177, TOKEN)).toMatchObject({ bookedOnDayBaseUnits: "0", outstandingBaseUnits: "1000000" });

    await mined(await send(sellerKey(), gateway.pausePolicyCall(id)));
    expect((await gateway.readPolicy(id))?.status).toBe("PAUSED");
    await mined(await send(sellerKey(), gateway.resumePolicyCall(id)));
    await mined(await send(sellerKey(), gateway.revokePolicyCall(id)));
    expect((await gateway.readPolicy(id))?.status).toBe("REVOKED");
    expect(await gateway.activePolicyId(seller, 177, TOKEN)).toBe(0);
    // Revocation does not release the outstanding reservation.
    expect((await gateway.readBudget(seller, 177, TOKEN)).outstandingBaseUnits).toBe("1000000");
  });
});

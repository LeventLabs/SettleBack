import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import {
  BaseError,
  ContractFunctionRevertedError,
  NonceTooLowError,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  WaitForTransactionReceiptTimeoutError,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  parseEventLogs,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Address } from "@settleback/domain";
import type { Provenance } from "../provenance.ts";
import {
  RegistryOutcomeUnknownError,
  RegistryRevertError,
  type RegisterCaseInput,
  type RegistryBudget,
  type RegistryCase,
  type RegistryCaseState,
  type RegistryGateway,
  type RegistryPolicy,
  type RegistryPolicyStatus,
  type RegistryPolicyTerms,
  type RegistryReservationMode,
  type RegistryWrite,
  type ReservationConfirmation,
  type ReservationExpectation,
  type WalletCall,
} from "../registry.ts";
import { RECOVERY_REGISTRY_ABI } from "./registry-abi.ts";

const CASE_STATES: readonly (RegistryCaseState | undefined)[] = [undefined, "OPEN", "RESERVED_REPAY", "RESERVED_RETRIEVE", "REPAID", "RECOVERED"];
const MODES: readonly RegistryReservationMode[] = ["NONE", "PER_CASE", "STANDING_POLICY"];
const POLICY_STATUSES: readonly (RegistryPolicyStatus | undefined)[] = [undefined, "ACTIVE", "PAUSED", "REVOKED", "REPLACED"];
const KINDS = { REPAY: 1, RETRIEVE: 2 } as const;
const ZERO32 = `0x${"0".repeat(64)}`;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface EvmRegistryOptions {
  rpcUrl: string;
  chainId: number;
  address: Address;
  /** SIMULATED for a disposable local chain, LIVE for HSK Chain. */
  provenance: Provenance;
  /** The verifier's key, for verifier writes. Without it the gateway can read and confirm but not write. */
  verifierPrivateKey?: Hex;
  /** Blocks a receipt needs before a write or a reservation counts as confirmed. */
  confirmations: number;
  timeoutMs: number;
  /** How often to poll for new blocks and receipts, and to ask a lagging RPC node again; tests shorten it. */
  pollMs?: number;
  /** Test seam; defaults to HTTP. */
  transport?: Transport;
}

/** Times a transaction the RPC does not know is looked up before it is reported as unknown to the chain. */
const UNKNOWN_TRANSACTION_CHECKS = 4;
/** Sends tried with the next nonce when a lagging node reported an old one. */
const NONCE_ATTEMPTS = 3;

export class RegistryConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryConfigurationError";
  }
}

type WriteFunction = "registerCase" | "reserveRetrieval" | "completeRepayment" | "completeRetrieval";

/**
 * The RecoveryRegistry on an EVM chain. The same class serves a disposable local chain and HSK
 * Chain; the provenance label says which. Construction goes through `connect`, which checks the
 * chain ID, that the address holds code, and that the configured verifier key is the contract's
 * verifier, so a misconfigured deployment fails at startup rather than at the first write.
 */
export class EvmRegistryGateway implements RegistryGateway {
  readonly provenance: Provenance;
  readonly chainId: number;
  readonly address: Address;
  private readonly client: PublicClient;
  private readonly wallet: WalletClient | undefined;
  private readonly account: PrivateKeyAccount | undefined;
  private readonly confirmations: number;
  private readonly timeoutMs: number;
  // Writes from the one verifier account go out one at a time, so concurrent calls cannot pick the same nonce.
  private writes: Promise<unknown> = Promise.resolve();
  // The highest block holding a write or a reservation this gateway relied on. Reads and simulations
  // are pinned at or above it, so a node lagging behind a load-balanced RPC cannot answer with older
  // state. A disposable local chain never lags, so there this changes nothing.
  private floor = 0n;
  private readonly pollMs: number;

  private constructor(options: EvmRegistryOptions, chain: Chain) {
    this.provenance = options.provenance;
    this.chainId = options.chainId;
    this.address = getAddress(options.address) as Address;
    this.confirmations = options.confirmations;
    this.timeoutMs = options.timeoutMs;
    this.pollMs = options.pollMs ?? 1_000;
    const transport = options.transport ?? http(options.rpcUrl, { timeout: options.timeoutMs, retryCount: 0 });
    this.client = createPublicClient({ chain, transport, pollingInterval: this.pollMs });
    this.account = options.verifierPrivateKey === undefined ? undefined : privateKeyToAccount(options.verifierPrivateKey);
    this.wallet = this.account === undefined ? undefined : createWalletClient({ account: this.account, chain, transport });
  }

  static async connect(options: EvmRegistryOptions): Promise<EvmRegistryGateway> {
    if (!Number.isInteger(options.confirmations) || options.confirmations < 1) throw new RegistryConfigurationError("confirmations must be at least 1");
    const chain = defineChain({
      id: options.chainId,
      name: `chain-${options.chainId}`,
      nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
      rpcUrls: { default: { http: [options.rpcUrl] } },
    });
    const gateway = new EvmRegistryGateway(options, chain);
    const actualChainId = await gateway.client.getChainId();
    if (actualChainId !== options.chainId) throw new RegistryConfigurationError(`RPC serves chain ${actualChainId}, not ${options.chainId}`);
    const code = await gateway.client.getCode({ address: gateway.address });
    if (code === undefined || code === "0x") throw new RegistryConfigurationError(`no contract at ${gateway.address} on chain ${options.chainId}`);
    if (gateway.account !== undefined) {
      const verifier = await gateway.client.readContract({ address: gateway.address, abi: RECOVERY_REGISTRY_ABI, functionName: "verifier" });
      if (verifier.toLowerCase() !== gateway.account.address.toLowerCase()) {
        throw new RegistryConfigurationError("the configured verifier key is not the registry's verifier");
      }
    }
    return gateway;
  }

  async readCase(caseKey: string): Promise<RegistryCase | undefined> {
    const key = bytes32(caseKey, "case key");
    const record = await this.pinned((at) => this.client.readContract({ ...at, address: this.address, abi: RECOVERY_REGISTRY_ABI, functionName: "getCase", args: [key] }));
    const state = CASE_STATES[record.state];
    if (state === undefined) return undefined;
    const t = record.terms;
    return {
      caseKey: caseKey.toLowerCase(),
      buyer: lower(t.buyer),
      seller: lower(t.seller),
      token: lower(t.token),
      amountBaseUnits: t.amount.toString(),
      originalRef: { chainId: Number(t.paymentChainId), txHash: t.originalTxHash.toLowerCase() },
      policySha256: unprefixed(t.policyHash),
      eligibilityRulesSha256: unprefixed(t.eligibilityRulesHash),
      autoEligible: t.autoEligible,
      actionDigest: unprefixed(t.actionDigest),
      evidenceDigest: unprefixed(t.evidenceDigest),
      actionKind: t.kind === KINDS.REPAY ? "REPAY" : "RETRIEVE",
      deadline: new Date(Number(t.deadline) * 1000).toISOString(),
      state,
      mode: MODES[record.mode] ?? "NONE",
      authorizationId: Number(record.authorizationId),
      outcomeRef: record.outcomeRef === ZERO32 ? null : record.outcomeRef.toLowerCase(),
      outcomeCommitment: record.outcomeCommitment === ZERO32 ? null : unprefixed(record.outcomeCommitment),
    };
  }

  async readPolicy(authorizationId: number): Promise<RegistryPolicy | undefined> {
    const id = uint64(authorizationId);
    const policy = await this.pinned((at) => this.client.readContract({ ...at, address: this.address, abi: RECOVERY_REGISTRY_ABI, functionName: "getPolicy", args: [id] }));
    const status = POLICY_STATUSES[policy.status];
    if (status === undefined) return undefined;
    const t = policy.terms;
    return {
      authorizationId,
      seller: lower(policy.seller),
      status,
      terms: {
        delegate: lower(t.delegate),
        signer: lower(t.signer),
        token: lower(t.token),
        paymentChainId: Number(t.paymentChainId),
        servicePolicySha256: unprefixed(t.servicePolicyHash),
        eligibilityRulesSha256: unprefixed(t.eligibilityRulesHash),
        maxPerCaseBaseUnits: t.maxPerCase.toString(),
        dailyLimitBaseUnits: t.dailyLimit.toString(),
        validFrom: new Date(Number(t.validFrom) * 1000).toISOString(),
        validUntil: new Date(Number(t.validUntil) * 1000).toISOString(),
      },
    };
  }

  async activePolicyId(seller: Address, paymentChainId: number, token: Address): Promise<number> {
    const scope = await this.scope(seller, paymentChainId, token);
    return Number(await this.pinned((at) => this.client.readContract({ ...at, address: this.address, abi: RECOVERY_REGISTRY_ABI, functionName: "activePolicyOf", args: [scope] })));
  }

  async readBudget(seller: Address, paymentChainId: number, token: Address, day?: number): Promise<RegistryBudget> {
    const scope = await this.scope(seller, paymentChainId, token);
    const which = day ?? Number(await this.pinned((at) => this.client.readContract({ ...at, address: this.address, abi: RECOVERY_REGISTRY_ABI, functionName: "currentDay" })));
    const [booked, outstanding] = await this.pinned((at) =>
      this.client.readContract({
        ...at,
        address: this.address,
        abi: RECOVERY_REGISTRY_ABI,
        functionName: "getBudget",
        args: [scope, BigInt(which)],
      }),
    );
    return { scope, day: which, bookedOnDayBaseUnits: booked.toString(), outstandingBaseUnits: outstanding.toString() };
  }

  async registerCase(input: RegisterCaseInput): Promise<RegistryWrite> {
    const deadline = Date.parse(input.deadline);
    if (!Number.isFinite(deadline)) throw new RegistryRevertError("InvalidTerms");
    return this.write("registerCase", [
      bytes32(input.caseKey, "case key"),
      {
        buyer: getAddress(input.buyer),
        seller: getAddress(input.seller),
        token: getAddress(input.token),
        amount: positive(input.amountBaseUnits),
        paymentChainId: uint64(input.originalRef.chainId),
        originalTxHash: bytes32(input.originalRef.txHash, "original transaction"),
        policyHash: digest(input.policySha256),
        eligibilityRulesHash: digest(input.eligibilityRulesSha256),
        autoEligible: input.autoEligible,
        actionDigest: digest(input.actionDigest),
        evidenceDigest: digest(input.evidenceDigest),
        kind: KINDS[input.actionKind],
        deadline: BigInt(Math.floor(deadline / 1000)),
      },
    ]);
  }

  async reserveRetrieval(caseKey: string): Promise<RegistryWrite> {
    return this.write("reserveRetrieval", [bytes32(caseKey, "case key")]);
  }

  async completeRepayment(caseKey: string, repaymentTxHash: string, evidenceBundleSha256: string): Promise<RegistryWrite> {
    return this.write("completeRepayment", [bytes32(caseKey, "case key"), bytes32(repaymentTxHash, "repayment transaction"), digest(evidenceBundleSha256)]);
  }

  async completeRetrieval(caseKey: string, artifactSha256: string, acknowledgementSha256: string): Promise<RegistryWrite> {
    return this.write("completeRetrieval", [bytes32(caseKey, "case key"), digest(artifactSha256), digest(acknowledgementSha256)]);
  }

  reserveRepaymentCall(caseKey: string): WalletCall {
    return this.call(encodeFunctionData({ abi: RECOVERY_REGISTRY_ABI, functionName: "reserveRepayment", args: [bytes32(caseKey, "case key")] }));
  }

  reserveUnderPolicyCall(caseKey: string, authorizationId: number): WalletCall {
    return this.call(
      encodeFunctionData({ abi: RECOVERY_REGISTRY_ABI, functionName: "reserveRepaymentUnderPolicy", args: [bytes32(caseKey, "case key"), uint64(authorizationId)] }),
    );
  }

  activatePolicyCall(terms: RegistryPolicyTerms): WalletCall {
    return this.call(
      encodeFunctionData({
        abi: RECOVERY_REGISTRY_ABI,
        functionName: "activatePolicy",
        args: [
          {
            delegate: getAddress(terms.delegate),
            signer: getAddress(terms.signer),
            token: getAddress(terms.token),
            paymentChainId: uint64(terms.paymentChainId),
            servicePolicyHash: digest(terms.servicePolicySha256),
            eligibilityRulesHash: digest(terms.eligibilityRulesSha256),
            maxPerCase: positive(terms.maxPerCaseBaseUnits),
            dailyLimit: positive(terms.dailyLimitBaseUnits),
            validFrom: seconds(terms.validFrom),
            validUntil: seconds(terms.validUntil),
          },
        ],
      }),
    );
  }

  pausePolicyCall(authorizationId: number): WalletCall {
    return this.call(encodeFunctionData({ abi: RECOVERY_REGISTRY_ABI, functionName: "pausePolicy", args: [uint64(authorizationId)] }));
  }

  resumePolicyCall(authorizationId: number): WalletCall {
    return this.call(encodeFunctionData({ abi: RECOVERY_REGISTRY_ABI, functionName: "resumePolicy", args: [uint64(authorizationId)] }));
  }

  revokePolicyCall(authorizationId: number): WalletCall {
    return this.call(encodeFunctionData({ abi: RECOVERY_REGISTRY_ABI, functionName: "revokePolicy", args: [uint64(authorizationId)] }));
  }

  /**
   * Accepts a reported reservation transaction only when the chain shows all of it: a successful
   * call to this registry from the expected account, exactly one RepaymentReserved event from this
   * registry for the case with the expected mode and authorization, enough confirmations, and the
   * case's current state still recording that reservation. A transaction not yet mined is pending,
   * never rejected and never accepted.
   */
  async confirmReservation(txHash: string, expected: ReservationExpectation): Promise<ReservationConfirmation> {
    const hash = bytes32(txHash, "transaction hash");
    const caseKey = bytes32(expected.caseKey, "case key");
    if (expected.mode === "STANDING_POLICY" && (expected.authorizationId === undefined || expected.authorizationId < 1)) {
      return { status: "REJECTED", reason: "a standing-policy reservation needs its authorization ID" };
    }

    let receipt: Awaited<ReturnType<PublicClient["getTransactionReceipt"]>> | undefined;
    for (let check = 1; receipt === undefined; check += 1) {
      try {
        receipt = await this.client.getTransactionReceipt({ hash });
      } catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
        try {
          await this.client.getTransaction({ hash });
          return { status: "PENDING", reason: "the transaction is not mined yet" };
        } catch (inner) {
          if (!(inner instanceof TransactionNotFoundError)) throw inner;
          // A transaction sent a moment ago may not have reached the node that answered yet.
          if (check >= UNKNOWN_TRANSACTION_CHECKS) return { status: "REJECTED", reason: "the chain does not know this transaction" };
          await sleep(this.pollMs);
        }
      }
    }
    if (receipt.status !== "success") return { status: "REJECTED", reason: "the transaction reverted" };

    // The receipt names the sender and recipient; a second lookup could reach a node that lacks the transaction.
    if (receipt.to === null || receipt.to.toLowerCase() !== this.address.toLowerCase()) return { status: "REJECTED", reason: "the transaction is not a call to this registry" };
    if (receipt.from.toLowerCase() !== expected.reservedBy.toLowerCase()) return { status: "REJECTED", reason: "the transaction was sent by another account" };

    const events = parseEventLogs({ abi: RECOVERY_REGISTRY_ABI, logs: receipt.logs, eventName: "RepaymentReserved" }).filter(
      (log) => log.address.toLowerCase() === this.address.toLowerCase() && log.args.caseKey.toLowerCase() === caseKey,
    );
    const [event] = events;
    if (event === undefined || events.length !== 1) return { status: "REJECTED", reason: "the transaction did not reserve this case" };
    const mode = MODES[event.args.mode];
    if (mode !== expected.mode) return { status: "REJECTED", reason: `the case was reserved in ${mode ?? "an unknown"} mode` };
    if (expected.mode === "STANDING_POLICY" && Number(event.args.authorizationId) !== expected.authorizationId) {
      return { status: "REJECTED", reason: "the reservation used a different authorization" };
    }

    // viem caches the block number for its polling interval; a stale head would undercount confirmations.
    const head = await this.client.getBlockNumber({ cacheTime: 0 });
    const confirmations = Number(head - receipt.blockNumber) + 1;
    if (confirmations < this.confirmations) return { status: "PENDING", reason: `${confirmations} of ${this.confirmations} confirmations` };

    this.raiseFloor(receipt.blockNumber);
    const current = await this.readCase(caseKey);
    if (current === undefined || (current.state !== "RESERVED_REPAY" && current.state !== "REPAID") || current.mode !== expected.mode) {
      return { status: "REJECTED", reason: "the registry no longer records this reservation" };
    }
    if (expected.mode === "STANDING_POLICY" && current.authorizationId !== expected.authorizationId) {
      return { status: "REJECTED", reason: "the registry records a different authorization" };
    }
    return {
      status: "CONFIRMED",
      txHash: hash,
      blockNumber: Number(receipt.blockNumber),
      confirmations,
      amountBaseUnits: event.args.amount.toString(),
      scope: event.args.scope.toLowerCase(),
    };
  }

  private async scope(seller: Address, paymentChainId: number, token: Address): Promise<Hex> {
    const args = [getAddress(seller), uint64(paymentChainId), getAddress(token)] as const;
    return this.pinned((at) => this.client.readContract({ ...at, address: this.address, abi: RECOVERY_REGISTRY_ABI, functionName: "scopeOf", args }));
  }

  private raiseFloor(blockNumber: bigint): void {
    if (blockNumber > this.floor) this.floor = blockNumber;
  }

  /**
   * Runs a read at a block at or above the floor. A node that has not reached the floor, or that
   * does not serve the block another node reported, is asked again until the timeout. A contract
   * revert is an answer, not lag, and is passed on at once.
   */
  private async pinned<T>(read: (at: { blockNumber?: bigint }) => Promise<T>): Promise<T> {
    if (this.floor === 0n) return read({});
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      let failure: unknown = new BaseError(`The registry RPC has not reached block ${this.floor} yet.`);
      try {
        const head = await this.client.getBlockNumber({ cacheTime: 0 });
        if (head >= this.floor) return await read({ blockNumber: head });
      } catch (error) {
        if (revertOf(error) instanceof RegistryRevertError) throw error;
        failure = error;
      }
      if (Date.now() >= deadline) throw failure;
      await sleep(this.pollMs);
    }
  }

  private call(data: Hex): WalletCall {
    return { chainId: this.chainId, to: this.address, data };
  }

  /**
   * Simulates first, so a contract refusal is reported by its custom error name without spending
   * gas, then sends and waits for the configured confirmations. A sent transaction whose receipt
   * does not arrive in time is reported with its hash as an unknown outcome. Each write starts
   * after the previous one has finished, so it also simulates against the state that one left.
   */
  private write<F extends WriteFunction>(functionName: F, args: readonly unknown[]): Promise<RegistryWrite> {
    const next = this.writes.then(() => this.send(functionName, args));
    this.writes = next.catch(() => undefined);
    return next;
  }

  private async send<F extends WriteFunction>(functionName: F, args: readonly unknown[]): Promise<RegistryWrite> {
    if (this.wallet === undefined || this.account === undefined) throw new RegistryConfigurationError("no verifier key is configured for registry writes");
    const account = this.account;
    let request;
    try {
      ({ request } = await this.pinned((at) =>
        this.client.simulateContract({
          ...at,
          account,
          address: this.address,
          abi: RECOVERY_REGISTRY_ABI,
          functionName,
          args: args as never,
        }),
      ));
    } catch (error) {
      throw revertOf(error);
    }
    // The simulation's block pin is not part of the transaction. Gas is estimated at the same pinned
    // block, with headroom, and every field is given explicitly, so viem neither re-estimates nor
    // fills the transaction (eth_fillTransaction) against a node that has not seen that state.
    const { blockNumber: _simulatedAt, ...transaction } = request as typeof request & { blockNumber?: bigint };
    const estimated = await this.pinned((at) =>
      this.client.estimateContractGas({ ...at, account, address: this.address, abi: RECOVERY_REGISTRY_ABI, functionName, args: args as never }),
    );
    const gas = (estimated * 5n) / 4n;
    const { maxFeePerGas, maxPriorityFeePerGas } = await this.client.estimateFeesPerGas();
    let nonce = await this.client.getTransactionCount({ address: account.address, blockTag: "pending" });
    let txHash: Hex | undefined;
    for (let attempt = 1; txHash === undefined; attempt += 1) {
      try {
        txHash = await this.wallet.writeContract({ ...transaction, chainId: this.chainId, gas, nonce, maxFeePerGas, maxPriorityFeePerGas } as never);
      } catch (error) {
        // A lagging node reported fewer transactions than the account has sent. viem files "already
        // known" under the same error; that transaction was received, so it is never sent again.
        const tooLow = error instanceof BaseError && error.walk((cause) => cause instanceof NonceTooLowError) instanceof NonceTooLowError && /nonce too low/i.test(error.message);
        if (attempt >= NONCE_ATTEMPTS || !tooLow) throw error;
        nonce += 1;
      }
    }
    try {
      const receipt = await this.client.waitForTransactionReceipt({ hash: txHash, confirmations: this.confirmations, timeout: this.timeoutMs });
      if (receipt.status !== "success") throw new RegistryRevertError("RevertedOnChain");
      this.raiseFloor(receipt.blockNumber);
      return { txHash, blockNumber: Number(receipt.blockNumber) };
    } catch (error) {
      if (error instanceof WaitForTransactionReceiptTimeoutError) {
        throw new RegistryOutcomeUnknownError(txHash, `${functionName} was sent as ${txHash}, but its receipt did not arrive in time`);
      }
      throw error;
    }
  }
}

/**
 * Deploys the registry from the Foundry artifact. For disposable local chains and tests only:
 * live deployments go through the reviewed Foundry scripts.
 */
export async function deployRegistry(options: { rpcUrl: string; chainId: number; deployerPrivateKey: Hex; verifier: Address; artifactPath: string }): Promise<Address> {
  if (options.chainId === 133 || options.chainId === 177) throw new RegistryConfigurationError("live deployments use the Foundry scripts, not this helper");
  const artifact = JSON.parse(readFileSync(options.artifactPath, "utf8")) as { bytecode: { object: Hex } };
  const chain = defineChain({ id: options.chainId, name: "local", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [options.rpcUrl] } } });
  const account = privateKeyToAccount(options.deployerPrivateKey);
  const wallet = createWalletClient({ account, chain, transport: http(options.rpcUrl) });
  const client = createPublicClient({ chain, transport: http(options.rpcUrl) });
  if ((await client.getChainId()) !== options.chainId) throw new RegistryConfigurationError("RPC chain ID differs from the requested local chain");
  const hash = await wallet.deployContract({ abi: RECOVERY_REGISTRY_ABI, bytecode: artifact.bytecode.object, args: [getAddress(options.verifier)] });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || receipt.contractAddress === null || receipt.contractAddress === undefined) throw new Error("registry deployment failed");
  return lower(receipt.contractAddress);
}

function revertOf(error: unknown): Error {
  if (error instanceof BaseError) {
    const reverted = error.walk((cause) => cause instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) return new RegistryRevertError(reverted.data?.errorName ?? reverted.reason ?? "Reverted");
  }
  return error instanceof Error ? error : new Error(String(error));
}

function bytes32(value: string, label: string): Hex {
  const lowered = value.toLowerCase();
  if (!BYTES32.test(lowered)) throw new RegistryRevertError(`InvalidInput: ${label} must be 0x and 64 hex digits`);
  return lowered as Hex;
}

function digest(value: string): Hex {
  if (!SHA256.test(value)) throw new RegistryRevertError("InvalidInput: digests are 64 lowercase hex digits");
  return `0x${value}`;
}

function unprefixed(value: string): string {
  return value.slice(2).toLowerCase();
}

function positive(value: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) throw new RegistryRevertError("InvalidInput: amounts are positive integers in base units");
  return BigInt(value);
}

function uint64(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new RegistryRevertError("InvalidInput: expected a non-negative integer");
  return BigInt(value);
}

function seconds(iso: string): bigint {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new RegistryRevertError("InvalidInput: invalid time");
  return BigInt(Math.floor(ms / 1000));
}

function lower(address: string): Address {
  return address.toLowerCase() as Address;
}

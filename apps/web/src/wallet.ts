// The browser wallet over EIP-1193. Keys never leave the wallet; this module only asks it to sign
// or send what the server prepared, and the server verifies the result independently.

export interface WalletAccount {
  /** Lowercase address. */
  address: string;
  chainId: number;
}

interface Eip1193Provider {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export function hasWallet(): boolean {
  return window.ethereum !== undefined;
}

function provider(): Eip1193Provider {
  const wallet = window.ethereum;
  if (wallet === undefined) throw new Error("No browser wallet was found. Install one, such as MetaMask, to sign in.");
  return wallet;
}

async function chainIdOf(wallet: Eip1193Provider): Promise<number> {
  return Number.parseInt(String(await wallet.request({ method: "eth_chainId" })), 16);
}

function firstAccount(value: unknown): string | null {
  return Array.isArray(value) && typeof value[0] === "string" ? value[0].toLowerCase() : null;
}

/** The account the wallet already exposes to this site, without prompting. */
export async function currentAccount(): Promise<WalletAccount | null> {
  const wallet = window.ethereum;
  if (wallet === undefined) return null;
  const address = firstAccount(await wallet.request({ method: "eth_accounts" }));
  return address === null ? null : { address, chainId: await chainIdOf(wallet) };
}

export async function connectWallet(): Promise<WalletAccount> {
  const wallet = provider();
  const address = firstAccount(await wallet.request({ method: "eth_requestAccounts" }));
  if (address === null) throw new Error("The wallet did not share an account.");
  return { address, chainId: await chainIdOf(wallet) };
}

/** EIP-191 personal_sign of the exact text the server issued. */
export async function signMessage(account: WalletAccount, message: string): Promise<string> {
  const hex = `0x${Array.from(new TextEncoder().encode(message), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  return String(await provider().request({ method: "personal_sign", params: [hex, account.address] }));
}

/** Sends a call the server prepared; the wallet shows the recipient and data before the user approves. */
export async function sendTransaction(account: WalletAccount, call: { chainId: number; to: string; data: string }): Promise<string> {
  if (account.chainId !== call.chainId) throw new Error(`Switch the wallet to chain ${call.chainId} before approving; it is on chain ${account.chainId}.`);
  return String(await provider().request({ method: "eth_sendTransaction", params: [{ from: account.address, to: call.to, data: call.data }] }));
}

/** Calls back when the wallet's account or network changes; returns the unsubscribe function. */
export function watchWallet(onAccount: (address: string | null) => void, onChain: (chainId: number) => void): () => void {
  const wallet = window.ethereum;
  if (wallet?.on === undefined) return () => undefined;
  const accounts = (value: unknown) => onAccount(firstAccount(value));
  const chain = (value: unknown) => onChain(Number.parseInt(String(value), 16));
  wallet.on("accountsChanged", accounts);
  wallet.on("chainChanged", chain);
  return () => {
    wallet.removeListener?.("accountsChanged", accounts);
    wallet.removeListener?.("chainChanged", chain);
  };
}

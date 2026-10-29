import type { WalletAccount } from "./wallet.ts";

/** A refusal or failure from the server, with its stable code. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  /** Required by the server on every state change; a mismatch with the session ends it. */
  wallet?: WalletAccount | null;
}

function headersFor(options: RequestOptions): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.wallet) headers["x-settleback-wallet"] = `eip155:${options.wallet.chainId}:${options.wallet.address}`;
  return headers;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const init: RequestInit = { method: options.method ?? "GET", headers: headersFor(options), credentials: "same-origin" };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  try {
    return await fetch(path, init);
  } catch {
    throw new ApiError(0, "SERVER_UNREACHABLE", "The SettleBack server could not be reached.");
  }
}

async function failure(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    return new ApiError(response.status, body.error?.code ?? `HTTP_${response.status}`, body.error?.message ?? response.statusText);
  } catch {
    return new ApiError(response.status, `HTTP_${response.status}`, response.statusText);
  }
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(path, options);
  if (!response.ok) throw await failure(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface DeliveredResult {
  bytes: Uint8Array;
  /** What the server says it sent; the buyer acknowledges the digest it computes itself. */
  declaredSha256: string;
  computedSha256: string;
}

/** Downloads the recovered result and hashes the bytes received, never trusting the declared digest alone. */
export async function retrieveResult(operationId: string, wallet: WalletAccount): Promise<DeliveredResult> {
  const response = await send(`/api/operations/${encodeURIComponent(operationId)}/result`, { wallet });
  if (!response.ok) throw await failure(response);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return {
    bytes,
    declaredSha256: response.headers.get("x-settleback-artifact-sha256") ?? "",
    computedSha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) return `${error.message} (${error.code})`;
  if (error instanceof Error) return error.message;
  return String(error);
}

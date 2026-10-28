import type { AssessmentPrompt } from "@settleback/domain";

/**
 * Where an assessment's text came from. "live" is a model call made now; "recorded" replays a
 * response captured from an earlier live call; "scripted" is hand-written test input. Every stored
 * assessment carries its origin so a replayed or scripted output is never shown as a live one.
 */
export type AssessmentOrigin = "live" | "recorded" | "scripted";

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  /** Output tokens spent on internal reasoning, when the provider reports them. */
  thinkingTokens: number | null;
}

export interface ProviderReply {
  /** The model that actually served the request, as the provider reports it. */
  model: string;
  stopReason: string;
  /** The response text, or null when the response carried none. */
  text: string | null;
  refusalCategory: string | null;
  usage: ProviderUsage | null;
}

export type ProviderFailure =
  | "PROVIDER_NOT_CONFIGURED"
  | "TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_AUTH"
  | "PROVIDER_REJECTED";

export class ProviderError extends Error {
  readonly code: ProviderFailure;

  constructor(code: ProviderFailure, message: string) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
  }
}

/** Reads a fixed prompt and returns raw text. It has no tools and no access to keys, signers, or state. */
export interface AssessmentProvider {
  readonly name: string;
  /** The pinned model this provider requests. */
  readonly model: string;
  readonly origin: AssessmentOrigin;
  assess(prompt: AssessmentPrompt, signal: AbortSignal): Promise<ProviderReply>;
}

import Anthropic from "@anthropic-ai/sdk";
import { ASSESSMENT_OUTPUT_SCHEMA, type AssessmentPrompt } from "@settleback/domain";
import type { AssessmentModel, AssessmentEffort } from "../config.ts";
import { ProviderError, type AssessmentProvider, type ProviderReply } from "./provider.ts";

const ANTHROPIC_API_URL = "https://api.anthropic.com";

export interface ClaudeProviderOptions {
  apiKey: string;
  model: AssessmentModel;
  effort: AssessmentEffort;
  maxTokens: number;
  timeoutMs: number;
  /** Test seam; production uses the SDK's default HTTP client. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Calls the Messages API once per assessment with structured output. No tools are offered, the
 * SDK never retries, and a refused request is reported as refused: there is no fallback to another
 * model, so every stored assessment names the model that produced it.
 */
export class ClaudeAssessmentProvider implements AssessmentProvider {
  readonly name = "anthropic";
  readonly origin = "live" as const;
  readonly model: AssessmentModel;
  private readonly client: Anthropic;
  private readonly effort: AssessmentEffort;
  private readonly maxTokens: number;

  constructor(options: ClaudeProviderOptions) {
    this.model = options.model;
    this.effort = options.effort;
    this.maxTokens = options.maxTokens;
    this.client = new Anthropic({
      apiKey: options.apiKey,
      // Explicit, so ANTHROPIC_BASE_URL or ANTHROPIC_AUTH_TOKEN in the environment cannot redirect the key or replace it.
      baseURL: ANTHROPIC_API_URL,
      authToken: null,
      maxRetries: 0,
      timeout: options.timeoutMs,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  async assess(prompt: AssessmentPrompt, signal: AbortSignal): Promise<ProviderReply> {
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: this.maxTokens,
          system: prompt.system,
          messages: [{ role: "user", content: prompt.user }],
          output_config: { effort: this.effort, format: { type: "json_schema", schema: ASSESSMENT_OUTPUT_SCHEMA } },
        },
        { signal },
      );
    } catch (error) {
      throw toProviderError(error, signal);
    }

    const parts = message.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
    return {
      model: message.model,
      stopReason: message.stop_reason ?? "none",
      text: parts.length === 0 ? null : parts.join(""),
      refusalCategory: message.stop_reason === "refusal" ? (message.stop_details?.category ?? null) : null,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        thinkingTokens: message.usage.output_tokens_details?.thinking_tokens ?? null,
      },
    };
  }
}

function toProviderError(error: unknown, signal: AbortSignal): ProviderError {
  // The caller's deadline aborts the request; the SDK reports that as a user abort.
  if (signal.aborted || error instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderError("TIMEOUT", "the assessment request did not complete before its deadline");
  }
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError("PROVIDER_AUTH", "the assessment provider rejected the configured credentials");
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new ProviderError("PROVIDER_RATE_LIMITED", "the assessment provider is rate limiting requests");
  }
  if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.NotFoundError || error instanceof Anthropic.UnprocessableEntityError) {
    return new ProviderError("PROVIDER_REJECTED", `the assessment provider rejected the request (HTTP ${String(error.status)})`);
  }
  if (error instanceof Anthropic.APIError) {
    return new ProviderError("PROVIDER_UNAVAILABLE", `the assessment provider failed (${error.status === undefined ? "connection error" : `HTTP ${String(error.status)}`})`);
  }
  throw error;
}

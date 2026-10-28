import type { AssessmentPrompt } from "@settleback/domain";
import type { AssessmentProvider, ProviderReply } from "../../src/recovery/provider.ts";

export { TERMS, registerFixturePolicies, setupFixtureCase, type FixtureCaseSetup, type FixtureParties } from "../../eval/fixture-case.ts";

export const MODEL = "claude-opus-5-5";

/** Hand-written test input. Its origin is "scripted" so it can never be mistaken for a model's answer. */
export class ScriptedProvider implements AssessmentProvider {
  readonly name = "scripted";
  readonly origin = "scripted" as const;
  readonly model: string;
  readonly prompts: AssessmentPrompt[] = [];
  private readonly respond: (prompt: AssessmentPrompt, signal: AbortSignal) => Promise<ProviderReply> | ProviderReply;

  constructor(respond: (prompt: AssessmentPrompt, signal: AbortSignal) => Promise<ProviderReply> | ProviderReply, model = MODEL) {
    this.respond = respond;
    this.model = model;
  }

  async assess(prompt: AssessmentPrompt, signal: AbortSignal): Promise<ProviderReply> {
    this.prompts.push(prompt);
    return this.respond(prompt, signal);
  }
}

export function reply(body: unknown, overrides: Partial<ProviderReply> = {}): ProviderReply {
  return {
    model: MODEL,
    stopReason: "end_turn",
    text: typeof body === "string" ? body : JSON.stringify(body),
    refusalCategory: null,
    usage: { inputTokens: 3000, outputTokens: 1800, thinkingTokens: 300 },
    ...overrides,
  };
}

/** The line of `content` that contains `needle`, for quoting it verbatim. */
export function lineWith(content: string, needle: string): string {
  const line = content.split("\n").find((entry) => entry.includes(needle));
  if (line === undefined) throw new Error(`no line contains ${needle}`);
  return line;
}

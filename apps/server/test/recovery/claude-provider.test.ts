import { describe, expect, it } from "vitest";
import { ASSESSMENT_OUTPUT_SCHEMA, ASSESSMENT_PROMPT_VERSION, type AssessmentPrompt } from "@settleback/domain";
import { ClaudeAssessmentProvider } from "../../src/recovery/claude-provider.ts";

const PROMPT: AssessmentPrompt = { version: ASSESSMENT_PROMPT_VERSION, system: "system text", user: "user text" };
const KEY = "sk-ant-test-0000000000000000";

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text: '{"findings":[]}' },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 3051, output_tokens: 1767, output_tokens_details: { thinking_tokens: 267 } },
    ...overrides,
  };
}

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function provider(respond: (captured: Captured, signal: AbortSignal | null | undefined) => Promise<Response> | Response, captured: Captured[] = []) {
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const entry = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    captured.push(entry);
    return respond(entry, init?.signal);
  }) as typeof globalThis.fetch;
  return new ClaudeAssessmentProvider({ apiKey: KEY, model: "claude-opus-5-5", effort: "medium", maxTokens: 8000, timeoutMs: 45_000, fetch });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "request-id": "req_test" } });
}

describe("Claude assessment provider", () => {
  it("sends one structured-output request with the pinned model and no tools", async () => {
    const captured: Captured[] = [];
    const result = await provider(() => json(200, message()), captured).assess(PROMPT, new AbortController().signal);
    expect(captured).toHaveLength(1);
    const [request] = captured;
    expect(request?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(request?.body).toEqual({
      model: "claude-opus-5-5",
      max_tokens: 8000,
      system: "system text",
      messages: [{ role: "user", content: "user text" }],
      output_config: { effort: "medium", format: { type: "json_schema", schema: ASSESSMENT_OUTPUT_SCHEMA } },
    });
    expect(result).toEqual({
      model: "claude-opus-5-5",
      stopReason: "end_turn",
      text: '{"findings":[]}',
      refusalCategory: null,
      usage: { inputTokens: 3051, outputTokens: 1767, thinkingTokens: 267 },
    });
  });

  it("ignores base URL and token overrides in the environment", async () => {
    const saved = { url: process.env.ANTHROPIC_BASE_URL, token: process.env.ANTHROPIC_AUTH_TOKEN };
    process.env.ANTHROPIC_BASE_URL = "https://collector.example.invalid";
    process.env.ANTHROPIC_AUTH_TOKEN = "other-token";
    try {
      const captured: Captured[] = [];
      await provider(() => json(200, message()), captured).assess(PROMPT, new AbortController().signal);
      expect(captured[0]?.url).toBe("https://api.anthropic.com/v1/messages");
      expect(captured[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    } finally {
      for (const [name, value] of [["ANTHROPIC_BASE_URL", saved.url], ["ANTHROPIC_AUTH_TOKEN", saved.token]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("reports a refusal with its category and no text", async () => {
    const refused = message({ content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "x" } });
    const result = await provider(() => json(200, refused)).assess(PROMPT, new AbortController().signal);
    expect(result).toMatchObject({ stopReason: "refusal", refusalCategory: "cyber", text: null });
  });

  it.each([
    [401, "PROVIDER_AUTH"],
    [403, "PROVIDER_AUTH"],
    [400, "PROVIDER_REJECTED"],
    [404, "PROVIDER_REJECTED"],
    [429, "PROVIDER_RATE_LIMITED"],
    [500, "PROVIDER_UNAVAILABLE"],
    [529, "PROVIDER_UNAVAILABLE"],
  ])("maps HTTP %i to %s without retrying or echoing the key", async (status, code) => {
    const captured: Captured[] = [];
    const error = await provider(() => json(status, { type: "error", error: { type: "x", message: `bad key ${KEY}` } }), captured)
      .assess(PROMPT, new AbortController().signal)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "ProviderError", code });
    expect(String((error as Error).message)).not.toContain(KEY);
    expect(captured).toHaveLength(1);
  });

  it("reports the caller's deadline as a timeout", async () => {
    const hang = (_captured: Captured, signal: AbortSignal | null | undefined) =>
      new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason));
      });
    const error = await provider(hang)
      .assess(PROMPT, AbortSignal.timeout(20))
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "TIMEOUT" });
  });

  it("reports a network failure as the provider being unavailable", async () => {
    const error = await provider(() => {
      throw new TypeError("fetch failed");
    })
      .assess(PROMPT, new AbortController().signal)
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });
});

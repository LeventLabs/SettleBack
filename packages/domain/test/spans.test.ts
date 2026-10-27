import { describe, expect, it } from "vitest";
import { evidenceSnapshotSha256, type SnapshotItem } from "../src/digest.ts";
import { checkSpan, findLineSpan, findSpan, leadingSpan } from "../src/index.ts";

const LOG = "10:00:30 edge 504 délai\n10:00:33 worker artifact stored sha256=4b26\n";

describe("evidence spans", () => {
  it("uses UTF-8 byte offsets, so multi-byte text before the quote shifts them", () => {
    const span = findSpan("ev-1", LOG, "artifact stored");
    expect(span).toBeDefined();
    if (span === undefined) return;
    const bytes = new TextEncoder().encode(LOG);
    expect(new TextDecoder().decode(bytes.slice(span.start, span.end))).toBe("artifact stored");
    expect(span.start).toBe(LOG.indexOf("artifact stored") + 1);
    expect(checkSpan(LOG, span)).toBe(true);
  });

  it("rejects spans that are out of range, shifted, empty, or quote different text", () => {
    const span = findSpan("ev-1", LOG, "artifact stored");
    if (span === undefined) throw new Error("span not found");
    expect(checkSpan(LOG, { ...span, start: span.start + 1 })).toBe(false);
    expect(checkSpan(LOG, { ...span, start: span.start + 1, end: span.end + 1 })).toBe(false);
    expect(checkSpan(LOG, { ...span, quote: "artifact STORED" })).toBe(false);
    expect(checkSpan(LOG, { ...span, end: span.start })).toBe(false);
    expect(checkSpan(LOG, { ...span, start: -1 })).toBe(false);
    expect(checkSpan(LOG, { ...span, end: 10_000 })).toBe(false);
    expect(checkSpan(LOG, { ...span, start: 1.5 })).toBe(false);
  });

  it("rejects a quote that would only match by splitting a character", () => {
    const start = new TextEncoder().encode("10:00:30 edge 504 d").byteLength;
    // The first byte of "é" decodes to U+FFFD on its own; it must not be accepted as a quote.
    expect(checkSpan(LOG, { evidenceId: "ev-1", start, end: start + 1, quote: "�" })).toBe(false);
  });

  it("rejects a malformed quote even when its encoding happens to match the bytes", () => {
    // TextEncoder turns a lone surrogate into U+FFFD, so "\uD800" encodes to the same bytes as "\uFFFD".
    const content = "x\uFFFDy";
    expect(checkSpan(content, { evidenceId: "ev-1", start: 1, end: 4, quote: "\uFFFD" })).toBe(true);
    expect(checkSpan(content, { evidenceId: "ev-1", start: 1, end: 4, quote: "\uD800" })).toBe(false);
  });

  it("finds whole lines and leading spans", () => {
    const policy = "# Terms\n\n1. Delivery. Met when stored.\n2. Refundable failure. Full repayment.\r\n3. Timeouts.";
    const clause = findLineSpan("pol", policy, /^2\. /);
    expect(clause?.quote).toBe("2. Refundable failure. Full repayment.");
    expect(clause !== undefined && checkSpan(policy, clause)).toBe(true);
    expect(findLineSpan("pol", policy, /^9\. /)).toBeUndefined();
    expect(() => findLineSpan("pol", policy, /^2\. /g)).toThrow();
    expect(leadingSpan("pol", policy).quote).toBe("# Terms");
    expect(leadingSpan("c", "x".repeat(500), 240).quote).toHaveLength(240);
  });
});

describe("evidence snapshot digest", () => {
  const items: SnapshotItem[] = [1, 2, 3].map((sequence) => ({
    id: `ev-${sequence}`,
    sequence,
    source: "worker-log",
    provenance: "AUTHENTICATED_SERVICE",
    submittedBy: "service",
    sourceEventId: `e${sequence}`,
    contentSha256: String(sequence).repeat(64),
    storedSha256: String(sequence).repeat(64),
  }));

  it("depends on sequence, not on the order items are passed in", () => {
    expect(evidenceSnapshotSha256("op-1", [...items].reverse())).toBe(evidenceSnapshotSha256("op-1", items));
  });

  it("changes when any item field, the item set, or the operation changes", () => {
    const base = evidenceSnapshotSha256("op-1", items);
    expect(evidenceSnapshotSha256("op-2", items)).not.toBe(base);
    expect(evidenceSnapshotSha256("op-1", items.slice(0, 2))).not.toBe(base);
    for (const field of ["provenance", "submittedBy", "sourceEventId", "contentSha256", "storedSha256"] as const) {
      const changed = items.map((item, index) => (index === 1 ? { ...item, [field]: `${item[field]}x` } : item));
      expect(evidenceSnapshotSha256("op-1", changed), field).not.toBe(base);
    }
  });

  it("refuses gaps or duplicates in the sequence", () => {
    expect(() => evidenceSnapshotSha256("op-1", [items[0] as SnapshotItem, items[2] as SnapshotItem])).toThrow(/contiguous/);
    expect(() => evidenceSnapshotSha256("op-1", [items[0] as SnapshotItem, items[0] as SnapshotItem])).toThrow(/contiguous/);
  });
});

/**
 * A cited range of one evidence item. Offsets are UTF-8 byte positions in the stored (redacted)
 * text, so a citation can be checked the same way in any language, and `quote` must equal those
 * bytes exactly.
 */
export interface SpanRef {
  evidenceId: string;
  start: number;
  end: number;
  quote: string;
}

const encoder = new TextEncoder();

/** The first exact occurrence of `quote` at or after `fromIndex` (a string index), as a byte span. */
export function findSpan(evidenceId: string, content: string, quote: string, fromIndex = 0): SpanRef | undefined {
  if (quote === "") return undefined;
  const index = content.indexOf(quote, fromIndex);
  if (index === -1) return undefined;
  const start = encoder.encode(content.slice(0, index)).byteLength;
  return { evidenceId, start, end: start + encoder.encode(quote).byteLength, quote };
}

/** The first line matching `pattern`, as a byte span. The pattern must not be global or sticky. */
export function findLineSpan(evidenceId: string, content: string, pattern: RegExp): SpanRef | undefined {
  if (pattern.global || pattern.sticky) throw new Error("findLineSpan needs a non-global, non-sticky pattern");
  let offset = 0;
  for (const line of content.split("\n")) {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (pattern.test(text)) return findSpan(evidenceId, content, text, offset);
    offset += line.length + 1;
  }
  return undefined;
}

/** The whole item, or its first line when the item spans several lines, capped at `maxChars`. */
export function leadingSpan(evidenceId: string, content: string, maxChars = 240): SpanRef {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
  const quote = Array.from(firstLine).slice(0, maxChars).join("");
  const span = findSpan(evidenceId, content, quote === "" ? content : quote);
  if (span === undefined) throw new Error("leading span must exist in its own content");
  return span;
}

/** True when the span lies inside the content, on character boundaries, and its quote matches byte for byte. */
export function checkSpan(content: string, span: SpanRef): boolean {
  const bytes = encoder.encode(content);
  if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || !span.quote.isWellFormed()) return false;
  if (span.start < 0 || span.end <= span.start || span.end > bytes.byteLength) return false;
  const quoted = encoder.encode(span.quote);
  if (quoted.byteLength !== span.end - span.start) return false;
  for (let i = 0; i < quoted.byteLength; i += 1) {
    if (bytes[span.start + i] !== quoted[i]) return false;
  }
  return true;
}

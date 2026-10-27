import type { ExtractedItem, ExtractionArtifact } from "@settleback/fixtures";

export class ExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionError";
  }
}

const ITEM_LINE = /^(?:The\s+)?(.+?)\s*\(SKU ([A-Z]{2}-[0-9]{4})\),?\s+(.+)$/;
const PRICE = /\b([0-9]+\.[0-9]{2}) USD\b/;

/**
 * Deterministic extraction for the synthetic supplier price note format: one item per line,
 * identified by "(SKU XX-0000)", with either a USD price or a discontinuation notice.
 */
export function extractPriceNote(sourceId: string, text: string): ExtractionArtifact {
  const items: ExtractedItem[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = ITEM_LINE.exec(line);
    if (match === null) continue;
    const [, name, sku, rest] = match;
    if (name === undefined || sku === undefined || rest === undefined) continue;
    if (/\bdiscontinued\b/i.test(rest)) {
      items.push({ sku, name: name.trim(), unitPriceUsd: null, status: "discontinued" });
      continue;
    }
    const price = PRICE.exec(rest)?.[1];
    if (price === undefined) throw new ExtractionError(`No price or status for ${sku}`);
    items.push({ sku, name: name.trim(), unitPriceUsd: price, status: "available" });
  }
  if (items.length === 0) throw new ExtractionError("No items found in the source document");
  return { schema: "settleback.extraction.v1", sourceId, items };
}

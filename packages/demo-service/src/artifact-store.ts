import { sha256Hex } from "@settleback/domain/hash";

export interface ArtifactRecord {
  sha256: string;
  writer: string;
  size: number;
  storedAt: string;
  /** SHA-256 of the bytes currently held; differs from `sha256` if the stored bytes were altered. */
  currentSha256: string;
}

/** Content-addressed result storage. Records which worker job wrote each artifact. */
export class MemoryArtifactStore {
  private readonly records = new Map<string, ArtifactRecord>();
  private readonly contents = new Map<string, string>();

  put(content: string, writer: string, storedAt: string): ArtifactRecord {
    const sha256 = sha256Hex(content);
    const record: ArtifactRecord = { sha256, writer, size: Buffer.byteLength(content), storedAt, currentSha256: sha256 };
    this.records.set(sha256, record);
    this.contents.set(sha256, content);
    return { ...record };
  }

  digestOf(content: string): string {
    return sha256Hex(content);
  }

  get(sha256: string): string | undefined {
    return this.contents.get(sha256);
  }

  record(sha256: string): ArtifactRecord | undefined {
    const record = this.records.get(sha256);
    return record === undefined ? undefined : { ...record };
  }

  list(): ArtifactRecord[] {
    return [...this.records.values()].map((record) => ({ ...record }));
  }

  /** Fault injection: alter stored bytes after the writer recorded their digest. */
  corrupt(sha256: string): void {
    const content = this.contents.get(sha256);
    const record = this.records.get(sha256);
    if (content === undefined || record === undefined) throw new Error(`No artifact ${sha256}`);
    const altered = `${content.slice(0, -1)} `;
    this.contents.set(sha256, altered);
    record.currentSha256 = sha256Hex(altered);
  }
}

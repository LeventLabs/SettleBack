import { describe, expect, it } from "vitest";
import type { Address } from "@settleback/domain";
import { loadCases, loadSourceBytes, loadSources } from "@settleback/fixtures";
import { composeCaseEvidence, type OperationTerms } from "../src/index.ts";

const source = loadSources()[0];
if (source === undefined) throw new Error("fixture source missing");
const text = loadSourceBytes(source).toString("utf8");
const terms: OperationTerms = {
  operationId: "op-demo-0001",
  requestId: "req-7f3a",
  buyer: "0x00000000000000000000000000000000000000b1" as Address,
  seller: "0x00000000000000000000000000000000000000a1" as Address,
  chainId: 133,
  token: "0x8fe3cb719ee4410e236cd6b72ab1fcdc06ef53c6" as Address,
  tokenDecimals: 6,
  priceUsd: "1.00",
};

describe("composeCaseEvidence", () => {
  it("produces each fixture's evidence sources from running components, plus only its hand-written claims", async () => {
    for (const fixture of loadCases()) {
      const composed = await composeCaseEvidence(fixture, terms, text);
      const expected = fixture.evidence.map((spec) => spec.source).filter((name) => name !== "policy").sort();
      expect(composed.evidence.map((item) => item.source).sort(), fixture.id).toEqual(expected);
      for (const item of composed.evidence) {
        if (item.submittedBy === "buyer") expect(fixture.evidence.find((spec) => spec.source === item.source)?.text, fixture.id).toBe(item.content);
        else expect(item.submittedBy === "reconciler" ? item.source === "gateway-record" : item.submittedBy === "service", fixture.id).toBe(true);
      }
    }
  });

  it("is deterministic", async () => {
    for (const fixture of loadCases()) {
      const first = await composeCaseEvidence(fixture, terms, text);
      const second = await composeCaseEvidence(fixture, terms, text);
      expect(second.evidence, fixture.id).toEqual(first.evidence);
    }
  });

  it("refuses a fixture whose declared payment contradicts the simulated gateway", async () => {
    const fixture = loadCases().find((entry) => entry.id === "payment-never-broadcast");
    if (fixture === undefined) throw new Error("fixture missing");
    await expect(composeCaseEvidence({ ...fixture, payment: "verified" }, terms, text)).rejects.toThrow(/gateway simulation produced NO_TRANSFER_FOUND/);
  });
});

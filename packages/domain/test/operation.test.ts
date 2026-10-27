import { describe, expect, it } from "vitest";
import { operationIntentSha256 } from "../src/digest.ts";
import { InvalidOperationIntentError, validateOperationIntent, type OperationIntent } from "../src/index.ts";

const SAMPLE_INTENT = {
  buyer: "0x00000000000000000000000000000000000000B1",
  seller: "0x00000000000000000000000000000000000000a1",
  serviceId: "structured-extraction",
  requestSha256: "09fed74ec1dfb2c5d983d4e5bfce9f4fba51cf1df9aea4eb385673338771ee42",
  policyId: "extraction-delivery-v1",
  policySha256: "1111111111111111111111111111111111111111111111111111111111111111",
  chainId: 133,
  token: "0x8FE3cB719Ee4410E236Cd6b72ab1fCDC06eF53c6",
  tokenDecimals: 6,
  priceUsd: "1.00",
  amountBaseUnits: "1000000",
};

function invalidField(input: unknown): string | undefined {
  try {
    validateOperationIntent(input);
    return undefined;
  } catch (error) {
    return error instanceof InvalidOperationIntentError ? error.field : "unexpected error";
  }
}

describe("validateOperationIntent", () => {
  it("normalizes addresses to lowercase and keeps every other field", () => {
    const intent = validateOperationIntent(SAMPLE_INTENT);
    expect(intent.buyer).toBe("0x00000000000000000000000000000000000000b1");
    expect(intent.token).toBe("0x8fe3cb719ee4410e236cd6b72ab1fcdc06ef53c6");
    expect(intent.amountBaseUnits).toBe("1000000");
  });

  it("rejects malformed amounts, prices, addresses, and extra fields", () => {
    expect(invalidField({ ...SAMPLE_INTENT, amountBaseUnits: "01000000" })).toBe("amountBaseUnits");
    expect(invalidField({ ...SAMPLE_INTENT, amountBaseUnits: "0" })).toBe("amountBaseUnits");
    expect(invalidField({ ...SAMPLE_INTENT, amountBaseUnits: 1000000 })).toBe("amountBaseUnits");
    expect(invalidField({ ...SAMPLE_INTENT, priceUsd: "1.5" })).toBe("priceUsd");
    expect(invalidField({ ...SAMPLE_INTENT, priceUsd: "0.00" })).toBe("priceUsd");
    expect(invalidField({ ...SAMPLE_INTENT, buyer: "0x123" })).toBe("buyer");
    expect(invalidField({ ...SAMPLE_INTENT, chainId: 1.5 })).toBe("chainId");
    expect(invalidField({ ...SAMPLE_INTENT, recipient: "0x00000000000000000000000000000000000000c3" })).toBe("recipient");
  });

  it("rejects a buyer paying itself, including when only the letter case differs", () => {
    expect(invalidField({ ...SAMPLE_INTENT, seller: SAMPLE_INTENT.buyer.toLowerCase() })).toBe("seller");
  });
});

describe("operationIntentSha256", () => {
  const intent = validateOperationIntent(SAMPLE_INTENT);

  it("does not depend on property order", () => {
    const reversed = Object.fromEntries(Object.entries(intent).reverse()) as unknown as OperationIntent;
    expect(operationIntentSha256(reversed)).toBe(operationIntentSha256(intent));
  });

  it("changes when any field changes", () => {
    const base = operationIntentSha256(intent);
    expect(operationIntentSha256({ ...intent, amountBaseUnits: "1000001" })).not.toBe(base);
    expect(operationIntentSha256({ ...intent, chainId: 177 })).not.toBe(base);
    expect(operationIntentSha256({ ...intent, policySha256: "2".repeat(64) })).not.toBe(base);
  });
});

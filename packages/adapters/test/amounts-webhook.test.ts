import { describe, expect, it } from "vitest";
import { baseUnitsToDecimal, decimalToBaseUnits, signWebhook, verifyWebhook } from "../src/index.ts";

describe("decimalToBaseUnits", () => {
  it("converts gateway decimal strings exactly", () => {
    expect(decimalToBaseUnits("1.00", 6)).toBe("1000000");
    expect(decimalToBaseUnits("100.30", 6)).toBe("100300000");
    expect(decimalToBaseUnits("0.000045", 6)).toBe("45");
    expect(decimalToBaseUnits("7", 6)).toBe("7000000");
    expect(decimalToBaseUnits("1.5", 18)).toBe("1500000000000000000");
  });

  it("refuses precision the token cannot represent and anything that is not a plain decimal", () => {
    expect(() => decimalToBaseUnits("0.0000001", 6)).toThrow(/fractional digits/);
    for (const bad of ["-1.00", "1e6", "01.00", "1.", ".5", " 1.00", "1,00", ""]) {
      expect(() => decimalToBaseUnits(bad, 6), bad).toThrow();
    }
  });
});

describe("baseUnitsToDecimal", () => {
  it("formats base units with at least two fractional digits", () => {
    expect(baseUnitsToDecimal("1000000", 6)).toBe("1.00");
    expect(baseUnitsToDecimal("1010000", 6)).toBe("1.01");
    expect(baseUnitsToDecimal("45", 6)).toBe("0.000045");
    expect(baseUnitsToDecimal("0", 6)).toBe("0.00");
  });

  it("round-trips with decimalToBaseUnits", () => {
    for (const units of ["1", "999999", "1000000", "123456789"]) {
      expect(decimalToBaseUnits(baseUnitsToDecimal(units, 6), 6)).toBe(units);
    }
  });
});

describe("webhook signatures", () => {
  const secret = "app-secret-for-tests";
  const body = '{"event_type":"payment","status":"payment-finalized"}';
  const now = 1_793_000_000;

  it("verifies a signature made over the exact raw body", () => {
    const header = signWebhook(secret, now, body);
    expect(header).toMatch(/^t=1793000000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhook(header, body, secret, now)).toEqual({ ok: true, timestamp: now });
    expect(verifyWebhook(header, Buffer.from(body), secret, now + 300)).toEqual({ ok: true, timestamp: now });
  });

  it("rejects a changed body, a wrong secret, and re-serialized JSON", () => {
    const header = signWebhook(secret, now, body);
    expect(verifyWebhook(header, body.replace("finalized", "failed"), secret, now)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifyWebhook(header, body, "other-secret", now)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(verifyWebhook(header, JSON.stringify(JSON.parse(body), null, 2), secret, now)).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("rejects timestamps outside the five-minute window", () => {
    const header = signWebhook(secret, now, body);
    expect(verifyWebhook(header, body, secret, now + 301)).toEqual({ ok: false, reason: "STALE_TIMESTAMP" });
    expect(verifyWebhook(header, body, secret, now - 301)).toEqual({ ok: false, reason: "STALE_TIMESTAMP" });
  });

  it("rejects missing and malformed headers", () => {
    expect(verifyWebhook(undefined, body, secret, now)).toEqual({ ok: false, reason: "MISSING_HEADER" });
    for (const header of ["t=1,v1=zz", "v1=" + "a".repeat(64), "t=abc,v1=" + "a".repeat(64), "t=1=2,v1=" + "a".repeat(64)]) {
      expect(verifyWebhook(header, body, secret, now), header).toEqual({ ok: false, reason: "MALFORMED_HEADER" });
    }
  });
});

import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../src/hash.ts";

describe("canonicalJson", () => {
  it("sorts keys recursively, keeps array order, and emits no whitespace", () => {
    expect(canonicalJson({ b: 2, a: 1, nested: { z: "last", m: "middle" }, list: [3, 1, 2] })).toBe(
      '{"a":1,"b":2,"list":[3,1,2],"nested":{"m":"middle","z":"last"}}',
    );
  });

  it("matches the gateway documentation example", () => {
    expect(canonicalJson({ merchant_name: "My Store", id: "cart-123", cart_expiry: "2024-03-01T12:00:00Z" })).toBe(
      '{"cart_expiry":"2024-03-01T12:00:00Z","id":"cart-123","merchant_name":"My Store"}',
    );
  });

  it("rejects numbers whose text form could vary", () => {
    expect(() => canonicalJson({ price: 4.2 })).toThrow(/not a safe integer/);
    expect(() => canonicalJson({ big: 2 ** 60 })).toThrow(/not a safe integer/);
  });
});

describe("sha256Hex", () => {
  it("matches the standard test vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

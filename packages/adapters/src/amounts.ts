const DECIMAL = /^(0|[1-9][0-9]*)(\.([0-9]+))?$/;
const BASE_UNITS = /^(0|[1-9][0-9]*)$/;

/**
 * Converts a token-denominated decimal string (as the gateway reports amounts) to integer base
 * units. More fractional digits than the token supports is an error, never a rounding.
 */
export function decimalToBaseUnits(value: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error(`Invalid token decimals ${decimals}`);
  const match = DECIMAL.exec(value);
  if (match === null) throw new Error(`"${value}" is not a plain non-negative decimal`);
  const whole = match[1] ?? "0";
  const fraction = match[3] ?? "";
  if (fraction.length > decimals) {
    throw new Error(`"${value}" has more than ${decimals} fractional digits`);
  }
  return BigInt(whole + fraction.padEnd(decimals, "0")).toString();
}

/** Formats base units as a decimal string with at least `minFraction` fractional digits. */
export function baseUnitsToDecimal(units: string, decimals: number, minFraction = 2): string {
  if (!BASE_UNITS.test(units)) throw new Error(`"${units}" is not an integer base-unit amount`);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error(`Invalid token decimals ${decimals}`);
  const padded = units.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals);
  let fraction = padded.slice(padded.length - decimals).replace(/0+$/, "");
  if (fraction.length < Math.min(minFraction, decimals)) fraction = fraction.padEnd(Math.min(minFraction, decimals), "0");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

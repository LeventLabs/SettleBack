import type { Environment } from "@settleback/domain";

/** Every artifact an adapter produces says whether it came from a simulator or a live system. */
export type Provenance = "SIMULATED" | "LIVE";

export class ProvenanceViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvenanceViolationError";
  }
}

/**
 * The local environment accepts only simulated artifacts and every live environment only live
 * ones, so a simulated payment can never be recorded as real evidence.
 */
export function assertProvenanceAllowed(environment: Environment, provenance: Provenance): void {
  const required: Provenance = environment === "local" ? "SIMULATED" : "LIVE";
  if (provenance !== required) {
    throw new ProvenanceViolationError(
      `${provenance} artifacts are not accepted in the "${environment}" environment; ${required} required.`,
    );
  }
}

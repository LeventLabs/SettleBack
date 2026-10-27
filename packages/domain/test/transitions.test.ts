import { describe, expect, it } from "vitest";
import {
  ACTORS,
  CASE_MACHINE,
  CASE_STATES,
  IllegalTransitionError,
  PAYMENT_ATTEMPT_MACHINE,
  PAYMENT_ATTEMPT_STATES,
  RECOVERY_ACTION_STATES,
  REPAY_ACTION_MACHINE,
  RETRIEVE_ACTION_MACHINE,
  SERVICE_JOB_MACHINE,
  SERVICE_JOB_STATES,
  assertTransition,
  checkTransition,
  type Actor,
  type Machine,
} from "../src/index.ts";

type AnyMachine = Machine<string>;

const MACHINES: [AnyMachine, readonly string[]][] = [
  [PAYMENT_ATTEMPT_MACHINE, PAYMENT_ATTEMPT_STATES],
  [SERVICE_JOB_MACHINE, SERVICE_JOB_STATES],
  [CASE_MACHINE, CASE_STATES],
  [REPAY_ACTION_MACHINE, RECOVERY_ACTION_STATES],
  [RETRIEVE_ACTION_MACHINE, RECOVERY_ACTION_STATES],
];

/** The complete allowed edge set per machine, written out independently of the tables. */
const EXPECTED_EDGES: Record<string, string[]> = {
  "payment attempt": [
    "CREATED>PREPARED",
    "CREATED>REJECTED_NO_SEND",
    "PREPARED>SIGNING_REQUESTED",
    "PREPARED>REJECTED_NO_SEND",
    "SIGNING_REQUESTED>SUBMITTED",
    "SIGNING_REQUESTED>UNKNOWN",
    "SIGNING_REQUESTED>REJECTED_NO_SEND",
    "SUBMITTED>OBSERVED",
    "SUBMITTED>UNKNOWN",
    "OBSERVED>VERIFIED",
    "OBSERVED>UNKNOWN",
    "OBSERVED>FAILED",
    "UNKNOWN>SUBMITTED",
    "UNKNOWN>OBSERVED",
    "UNKNOWN>VERIFIED",
    "UNKNOWN>FAILED",
  ],
  "service job": [
    "NOT_STARTED>INVOKED",
    "INVOKED>RUNNING",
    "INVOKED>FAILED",
    "INVOKED>UNKNOWN",
    "RUNNING>COMPLETED",
    "RUNNING>FAILED",
    "RUNNING>UNKNOWN",
    "UNKNOWN>RUNNING",
    "UNKNOWN>COMPLETED",
    "UNKNOWN>FAILED",
  ],
  case: [
    "OPEN>ASSESSING",
    "ASSESSING>ACTION_PREPARED",
    "ASSESSING>REVIEW_REQUIRED",
    "ASSESSING>OPEN",
    "REVIEW_REQUIRED>ACTION_PREPARED",
    "REVIEW_REQUIRED>UNRESOLVED",
    "REVIEW_REQUIRED>OPEN",
    "UNRESOLVED>OPEN",
    "ACTION_PREPARED>RESERVED",
    "ACTION_PREPARED>OPEN",
    "RESERVED>EXECUTION_REQUESTED",
    "EXECUTION_REQUESTED>VERIFIED",
    "EXECUTION_REQUESTED>DELIVERY_ACKED",
    "VERIFIED>RECORD_PENDING",
    "DELIVERY_ACKED>RECORD_PENDING",
    "RECORD_PENDING>REPAID",
    "RECORD_PENDING>RECOVERED",
    ...[
      "OPEN",
      "ASSESSING",
      "REVIEW_REQUIRED",
      "UNRESOLVED",
      "ACTION_PREPARED",
      "RESERVED",
      "EXECUTION_REQUESTED",
      "VERIFIED",
      "DELIVERY_ACKED",
      "RECORD_PENDING",
    ].map((state) => `${state}>QUARANTINED`),
  ],
  "repay action": [
    "PREPARED>RESERVED",
    "PREPARED>STRANDED",
    "RESERVED>EXECUTION_REQUESTED",
    "RESERVED>STRANDED",
    "EXECUTION_REQUESTED>VERIFIED",
    "VERIFIED>RECORD_PENDING",
    "RECORD_PENDING>COMPLETED",
  ],
  "retrieve action": [
    "PREPARED>RESERVED",
    "PREPARED>STRANDED",
    "RESERVED>EXECUTION_REQUESTED",
    "RESERVED>STRANDED",
    "EXECUTION_REQUESTED>DELIVERY_ACKED",
    "DELIVERY_ACKED>RECORD_PENDING",
    "RECORD_PENDING>COMPLETED",
  ],
};

function definedEdges(machine: AnyMachine): string[] {
  const edges: string[] = [];
  for (const [from, targets] of Object.entries(machine.edges)) {
    for (const to of Object.keys(targets ?? {})) edges.push(`${from}>${to}`);
  }
  return edges.sort();
}

function edgeOf(machine: AnyMachine, from: string, to: string) {
  return machine.edges[from]?.[to];
}

describe.each(MACHINES.map(([machine, states]) => ({ name: machine.name, machine, states })))("$name machine", ({ machine, states }) => {
  it("declares exactly the shared state list", () => {
    expect([...machine.states]).toEqual([...states]);
  });

  it("allows exactly the expected edges", () => {
    expect(definedEdges(machine)).toEqual([...(EXPECTED_EDGES[machine.name] ?? [])].sort());
  });

  it("refuses every transition out of a terminal state, for every actor", () => {
    for (const from of machine.terminal) {
      for (const to of machine.states) {
        for (const actor of ACTORS) {
          const result = checkTransition(machine, from, to, { actor, evidenceRef: "ev-1" });
          expect(result, `${from}>${to} by ${actor}`).toEqual(expect.objectContaining({ allowed: false, code: "TERMINAL_STATE" }));
        }
      }
    }
  });

  it("allows each defined edge only for its listed actors and refuses every undefined pair", () => {
    for (const from of machine.states) {
      for (const to of machine.states) {
        const edge = edgeOf(machine, from, to);
        for (const actor of ACTORS) {
          const result = checkTransition(machine, from, to, { actor, evidenceRef: "ev-1" });
          const expected = !machine.terminal.includes(from) && edge !== undefined && edge.actors.includes(actor);
          expect(result.allowed, `${from}>${to} by ${actor}`).toBe(expected);
        }
      }
    }
  });

  it("refuses evidence-gated edges without a cited evidence reference", () => {
    for (const from of machine.states) {
      for (const to of machine.states) {
        const edge = edgeOf(machine, from, to);
        if (edge?.requiresEvidence !== true || machine.terminal.includes(from)) continue;
        const actor = edge.actors[0] as Actor;
        expect(checkTransition(machine, from, to, { actor })).toEqual(expect.objectContaining({ code: "EVIDENCE_REQUIRED" }));
        expect(checkTransition(machine, from, to, { actor, evidenceRef: " " })).toEqual(
          expect.objectContaining({ code: "EVIDENCE_REQUIRED" }),
        );
      }
    }
  });

  it("refuses states it does not know", () => {
    expect(checkTransition(machine, "BOGUS", machine.states[0] ?? "", { actor: "server" })).toEqual(
      expect.objectContaining({ code: "UNKNOWN_STATE" }),
    );
  });
});

describe("invariant: no model or client status grants monetary authority", () => {
  it("never lists the model as an actor on any edge of any machine", () => {
    for (const [machine] of MACHINES) {
      for (const targets of Object.values(machine.edges)) {
        for (const edge of Object.values(targets ?? {})) {
          expect(edge?.actors, machine.name).not.toContain("assessor");
        }
      }
    }
  });

  it("lets only the server-side reconciler mark payments or repayments verified", () => {
    for (const [machine, from] of [
      [PAYMENT_ATTEMPT_MACHINE, "OBSERVED"],
      [PAYMENT_ATTEMPT_MACHINE, "UNKNOWN"],
      [CASE_MACHINE, "EXECUTION_REQUESTED"],
      [REPAY_ACTION_MACHINE, "EXECUTION_REQUESTED"],
    ] as const) {
      expect(edgeOf(machine as AnyMachine, from, "VERIFIED")?.actors).toEqual(["reconciler"]);
    }
  });

  it("refuses a buyer, seller, or model claiming a verified payment", () => {
    for (const actor of ["buyer", "seller", "assessor", "server"] as const) {
      expect(() => assertTransition(PAYMENT_ATTEMPT_MACHINE, "OBSERVED", "VERIFIED", { actor, evidenceRef: "ev" })).toThrow(
        IllegalTransitionError,
      );
    }
  });
});

describe("invariant: uncertainty does not authorize new spending", () => {
  it("never moves an unknown payment to a state that would permit a fresh attempt", () => {
    expect(edgeOf(PAYMENT_ATTEMPT_MACHINE, "UNKNOWN", "REJECTED_NO_SEND")).toBeUndefined();
    expect(edgeOf(PAYMENT_ATTEMPT_MACHINE, "UNKNOWN", "CREATED")).toBeUndefined();
    expect(edgeOf(PAYMENT_ATTEMPT_MACHINE, "SUBMITTED", "REJECTED_NO_SEND")).toBeUndefined();
  });

  it("closes an unknown payment as failed only by an operator citing evidence", () => {
    expect(checkTransition(PAYMENT_ATTEMPT_MACHINE, "UNKNOWN", "FAILED", { actor: "reconciler", evidenceRef: "ev" }).allowed).toBe(false);
    expect(checkTransition(PAYMENT_ATTEMPT_MACHINE, "UNKNOWN", "FAILED", { actor: "operator" }).allowed).toBe(false);
    expect(checkTransition(PAYMENT_ATTEMPT_MACHINE, "UNKNOWN", "FAILED", { actor: "operator", evidenceRef: "ev" }).allowed).toBe(true);
  });

  it("never re-invokes a job whose outcome is unknown", () => {
    expect(edgeOf(SERVICE_JOB_MACHINE, "UNKNOWN", "INVOKED")).toBeUndefined();
    expect(edgeOf(SERVICE_JOB_MACHINE, "UNKNOWN", "NOT_STARTED")).toBeUndefined();
  });
});

describe("recovery action kinds", () => {
  it("lets a repayment reach verification but never a delivery acknowledgement, and the reverse for retrieval", () => {
    expect(edgeOf(REPAY_ACTION_MACHINE, "EXECUTION_REQUESTED", "DELIVERY_ACKED")).toBeUndefined();
    expect(edgeOf(RETRIEVE_ACTION_MACHINE, "EXECUTION_REQUESTED", "VERIFIED")).toBeUndefined();
  });

  it("passes every outcome through RECORD_PENDING before completion", () => {
    for (const machine of [REPAY_ACTION_MACHINE, RETRIEVE_ACTION_MACHINE]) {
      const intoCompleted = definedEdges(machine).filter((edge) => edge.endsWith(">COMPLETED"));
      expect(intoCompleted).toEqual(["RECORD_PENDING>COMPLETED"]);
    }
  });
});

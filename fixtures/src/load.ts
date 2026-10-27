import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AUTHORIZATION_MODES,
  CASE_CATEGORIES,
  COMPONENTS,
  EVIDENCE_SOURCES,
  EXISTING_ACTIONS,
  EXISTING_ATTEMPTS,
  GUARD_DECISIONS,
  GUARD_SIGNERS,
  PAYMENT_STATES,
  POLICY_STATUSES,
  RECOVERY_ACTIONS,
  RULES_BASELINE,
  type AuthorizationFixture,
  type Citation,
  type EvidenceSpec,
  type ExtractedItem,
  type Fault,
  type FixtureCase,
  type FixtureSource,
} from "./types.ts";

const FIXTURES_ROOT = fileURLToPath(new URL("../", import.meta.url));
const SHA256_HEX = /^[0-9a-f]{64}$/;
const BASE_UNITS = /^(0|[1-9][0-9]*)$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function fixturePath(relative: string): string {
  return FIXTURES_ROOT + relative;
}

export function loadCases(): FixtureCase[] {
  return readJsonArray("cases.json").map((value, index) => parseCase(value, `cases.json[${index}]`));
}

export function loadSources(): FixtureSource[] {
  return readJsonArray("sources.json").map((value, index) => parseSource(value, `sources.json[${index}]`));
}

export function loadAuthorizationFixtures(): AuthorizationFixture[] {
  return readJsonArray("authorization.json").map((value, index) =>
    parseAuthorization(value, `authorization.json[${index}]`),
  );
}

export function loadPolicyText(policyId: string): string {
  if (!ID.test(policyId)) throw new Error(`Invalid policy id "${policyId}"`);
  return readFileSync(fixturePath(`policies/${policyId}.md`), "utf8");
}

export function loadSourceBytes(source: FixtureSource): Buffer {
  return readFileSync(fixturePath(source.file));
}

function readJsonArray(relative: string): unknown[] {
  const value: unknown = JSON.parse(readFileSync(fixturePath(relative), "utf8"));
  if (!Array.isArray(value)) throw new Error(`${relative}: expected an array`);
  return value;
}

function parseCase(value: unknown, where: string): FixtureCase {
  const o = obj(value, where);
  const expected = obj(o.expected, `${where}.expected`);
  const parsed: FixtureCase = {
    id: id(o, "id", where),
    title: str(o, "title", where),
    category: oneOf(o, "category", CASE_CATEGORIES, where),
    policyId: id(o, "policyId", where),
    sourceId: id(o, "sourceId", where),
    payment: oneOf(o, "payment", PAYMENT_STATES, where),
    faults: arr(o, "faults", where).map((f, i) => parseFault(f, `${where}.faults[${i}]`)),
    evidence: arr(o, "evidence", where).map((e, i) => parseEvidence(e, `${where}.evidence[${i}]`)),
    expected: {
      classification: id(expected, "classification", `${where}.expected`),
      action: oneOf(expected, "action", RECOVERY_ACTIONS, `${where}.expected`),
      rulesBaseline: oneOf(expected, "rulesBaseline", RULES_BASELINE, `${where}.expected`),
      citations: arr(expected, "citations", `${where}.expected`).map((c, i) =>
        parseCitation(c, `${where}.expected.citations[${i}]`),
      ),
      forbidden: arr(expected, "forbidden", `${where}.expected`).map((f, i) =>
        constant(f, `${where}.expected.forbidden[${i}]`),
      ),
      reasons: arr(expected, "reasons", `${where}.expected`).map((r, i) => text(r, `${where}.expected.reasons[${i}]`)),
    },
  };
  if (o.authorizationMode !== undefined) {
    parsed.authorizationMode = oneOf(o, "authorizationMode", AUTHORIZATION_MODES, where);
  }
  return parsed;
}

function parseFault(value: unknown, where: string): Fault {
  const o = obj(value, where);
  return {
    component: oneOf(o, "component", COMPONENTS, where),
    point: id(o, "point", where),
    description: str(o, "description", where),
  };
}

function parseEvidence(value: unknown, where: string): EvidenceSpec {
  const o = obj(value, where);
  const spec: EvidenceSpec = {
    source: oneOf(o, "source", EVIDENCE_SOURCES, where),
    producedBy: oneOf(o, "producedBy", COMPONENTS, where),
    format: str(o, "format", where),
    shows: str(o, "shows", where),
  };
  if (o.jobAlias !== undefined) spec.jobAlias = str(o, "jobAlias", where);
  if (o.clockOffsetMs !== undefined) {
    if (!Number.isSafeInteger(o.clockOffsetMs)) throw new Error(`${where}.clockOffsetMs: expected an integer`);
    spec.clockOffsetMs = o.clockOffsetMs as number;
  }
  if (o.handWritten !== undefined) {
    if (o.handWritten !== true) throw new Error(`${where}.handWritten: only true is meaningful`);
    spec.handWritten = true;
  }
  return spec;
}

function parseCitation(value: unknown, where: string): Citation {
  const o = obj(value, where);
  return { source: oneOf(o, "source", EVIDENCE_SOURCES, where), mustShow: str(o, "mustShow", where) };
}

function parseSource(value: unknown, where: string): FixtureSource {
  const o = obj(value, where);
  const artifact = obj(o.expectedArtifact, `${where}.expectedArtifact`);
  if (artifact.schema !== "settleback.extraction.v1") {
    throw new Error(`${where}.expectedArtifact.schema: expected "settleback.extraction.v1"`);
  }
  return {
    id: id(o, "id", where),
    file: str(o, "file", where),
    sourceSha256: matching(o, "sourceSha256", SHA256_HEX, where),
    expectedArtifact: {
      schema: "settleback.extraction.v1",
      sourceId: id(artifact, "sourceId", `${where}.expectedArtifact`),
      items: arr(artifact, "items", `${where}.expectedArtifact`).map((item, i) =>
        parseItem(item, `${where}.expectedArtifact.items[${i}]`),
      ),
    },
    expectedArtifactSha256: matching(o, "expectedArtifactSha256", SHA256_HEX, where),
  };
}

function parseItem(value: unknown, where: string): ExtractedItem {
  const o = obj(value, where);
  const price = o.unitPriceUsd;
  if (price !== null && (typeof price !== "string" || !/^[0-9]+\.[0-9]{2}$/.test(price))) {
    throw new Error(`${where}.unitPriceUsd: expected null or a two-decimal string`);
  }
  return {
    sku: str(o, "sku", where),
    name: str(o, "name", where),
    unitPriceUsd: price,
    status: oneOf(o, "status", ["available", "discontinued"] as const, where),
  };
}

function parseAuthorization(value: unknown, where: string): AuthorizationFixture {
  const o = obj(value, where);
  const policy = obj(o.policy, `${where}.policy`);
  const state = obj(o.state, `${where}.state`);
  const request = obj(o.request, `${where}.request`);
  const expected = obj(o.expected, `${where}.expected`);
  const signer = oneOf(o, "signer", GUARD_SIGNERS, where);

  const fixture: AuthorizationFixture = {
    id: id(o, "id", where),
    title: str(o, "title", where),
    signer,
    policy: {
      status: oneOf(policy, "status", POLICY_STATUSES, `${where}.policy`),
      validFrom: time(policy, "validFrom", `${where}.policy`),
      validUntil: time(policy, "validUntil", `${where}.policy`),
      dailyCapBaseUnits: matching(policy, "dailyCapBaseUnits", BASE_UNITS, `${where}.policy`),
    },
    state: {
      at: time(state, "at", `${where}.state`),
      bookedTodayBaseUnits: matching(state, "bookedTodayBaseUnits", BASE_UNITS, `${where}.state`),
      outstandingBaseUnits: matching(state, "outstandingBaseUnits", BASE_UNITS, `${where}.state`),
    },
    request: { amountBaseUnits: matching(request, "amountBaseUnits", BASE_UNITS, `${where}.request`) },
    expected: {
      decision: oneOf(expected, "decision", GUARD_DECISIONS, `${where}.expected`),
      reason: str(expected, "reason", `${where}.expected`),
    },
  };

  if (signer === "seller-guard") {
    fixture.policy.perCaseCapBaseUnits = matching(policy, "perCaseCapBaseUnits", BASE_UNITS, `${where}.policy`);
    fixture.state.existingAction = oneOf(state, "existingAction", EXISTING_ACTIONS, `${where}.state`);
  } else {
    fixture.policy.perPaymentCapBaseUnits = matching(policy, "perPaymentCapBaseUnits", BASE_UNITS, `${where}.policy`);
    fixture.policy.maxFeeBaseUnits = matching(policy, "maxFeeBaseUnits", BASE_UNITS, `${where}.policy`);
    fixture.policy.payeeAllowlist = arr(policy, "payeeAllowlist", `${where}.policy`).map((a, i) =>
      address(a, `${where}.policy.payeeAllowlist[${i}]`),
    );
    fixture.state.existingAttempt = oneOf(state, "existingAttempt", EXISTING_ATTEMPTS, `${where}.state`);
    fixture.request.payee = address(request.payee, `${where}.request.payee`);
  }
  return fixture;
}

function obj(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function arr(o: Record<string, unknown>, key: string, where: string): unknown[] {
  const value = o[key];
  if (!Array.isArray(value)) throw new Error(`${where}.${key}: expected an array`);
  return value;
}

function str(o: Record<string, unknown>, key: string, where: string): string {
  return text(o[key], `${where}.${key}`);
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${where}: expected a non-empty string`);
  return value;
}

function id(o: Record<string, unknown>, key: string, where: string): string {
  return matching(o, key, ID, where);
}

function constant(value: unknown, where: string): string {
  if (typeof value !== "string" || !/^[A-Z][A-Z_]*$/.test(value)) throw new Error(`${where}: expected UPPER_SNAKE_CASE`);
  return value;
}

function matching(o: Record<string, unknown>, key: string, pattern: RegExp, where: string): string {
  const value = o[key];
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${where}.${key}: does not match ${pattern}`);
  return value;
}

function time(o: Record<string, unknown>, key: string, where: string): string {
  const value = str(o, key, where);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${where}.${key}: expected an ISO-8601 UTC timestamp`);
  }
  return value;
}

function address(value: unknown, where: string): string {
  if (typeof value !== "string" || !ADDRESS.test(value)) throw new Error(`${where}: expected a 0x address`);
  return value;
}

function oneOf<const T extends readonly string[]>(
  o: Record<string, unknown>,
  key: string,
  allowed: T,
  where: string,
): T[number] {
  const value = o[key];
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${where}.${key}: expected one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}

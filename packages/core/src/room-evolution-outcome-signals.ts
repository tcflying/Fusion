export const ROOM_EVOLUTION_OUTCOME_SIGNAL_CONTRACT_VERSION = 1 as const;

export const ROOM_EVOLUTION_OUTCOME_SIGNAL_KINDS = [
  "failure",
  "correction",
  "confidence",
  "retry",
  "dissent",
  "quality",
  "stability",
  "utilization",
  "latency",
] as const;

export type RoomEvolutionOutcomeSignalKindV1 =
  (typeof ROOM_EVOLUTION_OUTCOME_SIGNAL_KINDS)[number];
export type RoomEvolutionOutcomeSignalSourceV1 =
  | "deterministic_gate"
  | "human_correction"
  | "durable_room_ledger"
  | "independent_review"
  | "authorized_observed_outcome"
  | "room_metric";
export type RoomEvolutionOutcomeSignalUnitV1 = "count" | "ratio" | "milliseconds";

export interface RoomEvolutionOutcomeObservationV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_OUTCOME_SIGNAL_CONTRACT_VERSION;
  readonly id: string;
  readonly projectId: string;
  readonly roomId: string;
  readonly kind: RoomEvolutionOutcomeSignalKindV1;
  readonly source: RoomEvolutionOutcomeSignalSourceV1;
  readonly sourceRef: string;
  readonly evidenceHash: string;
  readonly observedAt: string;
  readonly unit: RoomEvolutionOutcomeSignalUnitV1;
  readonly value: number;
}

export interface CollectAuthorizedRoomEvolutionOutcomeSignalsInputV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_OUTCOME_SIGNAL_CONTRACT_VERSION;
  readonly projectId: string;
  readonly asOf: string;
  readonly maxObservationAgeMs: number;
  readonly observations: readonly RoomEvolutionOutcomeObservationV1[];
}

export type RoomEvolutionOutcomeSignalCoverageStateV1 = "observed" | "unknown";

export interface RoomEvolutionOutcomeSignalCoverageV1 {
  readonly kind: RoomEvolutionOutcomeSignalKindV1;
  readonly state: RoomEvolutionOutcomeSignalCoverageStateV1;
  readonly observationIds: readonly string[];
}

export interface RoomEvolutionOutcomeSignalSetV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_OUTCOME_SIGNAL_CONTRACT_VERSION;
  readonly projectId: string;
  readonly asOf: string;
  readonly observations: readonly RoomEvolutionOutcomeObservationV1[];
  readonly coverage: readonly RoomEvolutionOutcomeSignalCoverageV1[];
  readonly modelSelfReportExcluded: true;
}

export type RoomEvolutionOutcomeSignalIssueCodeV1 =
  | "invalid_input"
  | "invalid_timestamp"
  | "duplicate_observation"
  | "project_scope_mismatch"
  | "stale_observation"
  | "future_observation"
  | "untrusted_source"
  | "invalid_unit"
  | "invalid_value";

export interface RoomEvolutionOutcomeSignalIssueV1 {
  readonly code: RoomEvolutionOutcomeSignalIssueCodeV1;
  readonly path: string;
  readonly message: string;
}

export type CollectAuthorizedRoomEvolutionOutcomeSignalsResultV1 =
  | { readonly ok: true; readonly value: RoomEvolutionOutcomeSignalSetV1 }
  | { readonly ok: false; readonly issues: readonly RoomEvolutionOutcomeSignalIssueV1[] };

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const MAX_OBSERVATION_AGE_MS = 31 * 24 * 60 * 60 * 1000;

const EXPECTED_UNITS: Readonly<Record<RoomEvolutionOutcomeSignalKindV1, RoomEvolutionOutcomeSignalUnitV1>> = {
  failure: "count",
  correction: "count",
  confidence: "ratio",
  retry: "count",
  dissent: "count",
  quality: "ratio",
  stability: "ratio",
  utilization: "ratio",
  latency: "milliseconds",
};

const TRUSTED_SOURCES: Readonly<Record<
  RoomEvolutionOutcomeSignalKindV1,
  readonly RoomEvolutionOutcomeSignalSourceV1[]
>> = {
  failure: ["deterministic_gate", "durable_room_ledger"],
  correction: ["human_correction"],
  confidence: ["durable_room_ledger"],
  retry: ["durable_room_ledger"],
  dissent: ["durable_room_ledger", "independent_review"],
  quality: ["independent_review", "authorized_observed_outcome"],
  stability: ["room_metric"],
  utilization: ["room_metric"],
  latency: ["room_metric"],
};

export function collectAuthorizedRoomEvolutionOutcomeSignals(
  input: CollectAuthorizedRoomEvolutionOutcomeSignalsInputV1,
): CollectAuthorizedRoomEvolutionOutcomeSignalsResultV1 {
  const issues: RoomEvolutionOutcomeSignalIssueV1[] = [];
  if (!isRecord(input) || !hasExactKeys(input, [
    "contractVersion", "projectId", "asOf", "maxObservationAgeMs", "observations",
  ])) {
    return failure([issue("invalid_input", "input", "Outcome signal collection input must have the exact v1 shape")]);
  }
  if (input.contractVersion !== ROOM_EVOLUTION_OUTCOME_SIGNAL_CONTRACT_VERSION) {
    issues.push(issue("invalid_input", "contractVersion", "Outcome signal collection contract version is unsupported"));
  }
  if (!isIdentifier(input.projectId)) {
    issues.push(issue("invalid_input", "projectId", "Project id must be a canonical identifier"));
  }
  const asOfMs = parseCanonicalTimestamp(input.asOf, "asOf", issues);
  if (!isPositiveSafeInteger(input.maxObservationAgeMs) || input.maxObservationAgeMs > MAX_OBSERVATION_AGE_MS) {
    issues.push(issue("invalid_input", "maxObservationAgeMs", "Observation age must be a bounded positive safe integer"));
  }
  if (!Array.isArray(input.observations)) {
    issues.push(issue("invalid_input", "observations", "Observations must be an array"));
  }
  if (issues.length > 0 || asOfMs === null || !Array.isArray(input.observations)) return failure(issues);

  const identifiers = new Set<string>();
  const observations: RoomEvolutionOutcomeObservationV1[] = [];
  for (const [index, value] of input.observations.entries()) {
    const observation = parseObservation(
      value,
      `observations[${index}]`,
      input.projectId,
      asOfMs,
      input.maxObservationAgeMs,
      identifiers,
      issues,
    );
    if (observation) observations.push(observation);
  }
  if (issues.length > 0) return failure(issues);

  const canonicalObservations = observations.sort((left, right) => left.id.localeCompare(right.id));
  const coverage = ROOM_EVOLUTION_OUTCOME_SIGNAL_KINDS.map((kind) => {
    const observationIds = canonicalObservations
      .filter((entry) => entry.kind === kind)
      .map((entry) => entry.id);
    return {
      kind,
      state: observationIds.length > 0 ? "observed" : "unknown",
      observationIds,
    } satisfies RoomEvolutionOutcomeSignalCoverageV1;
  });
  return success({
    contractVersion: ROOM_EVOLUTION_OUTCOME_SIGNAL_CONTRACT_VERSION,
    projectId: input.projectId,
    asOf: input.asOf,
    observations: canonicalObservations,
    coverage,
    modelSelfReportExcluded: true,
  });
}

function parseObservation(
  value: unknown,
  path: string,
  projectId: string,
  asOfMs: number,
  maxObservationAgeMs: number,
  identifiers: Set<string>,
  issues: RoomEvolutionOutcomeSignalIssueV1[],
): RoomEvolutionOutcomeObservationV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "contractVersion", "id", "projectId", "roomId", "kind", "source", "sourceRef", "evidenceHash",
    "observedAt", "unit", "value",
  ])) {
    issues.push(issue("invalid_input", path, "Observation must have the exact v1 shape"));
    return null;
  }
  if (value.contractVersion !== ROOM_EVOLUTION_OUTCOME_SIGNAL_CONTRACT_VERSION) {
    issues.push(issue("invalid_input", `${path}.contractVersion`, "Observation contract version is unsupported"));
  }
  if (!isIdentifier(value.id)) {
    issues.push(issue("invalid_input", `${path}.id`, "Observation id must be canonical"));
  } else if (identifiers.has(value.id)) {
    issues.push(issue("duplicate_observation", `${path}.id`, "Observation id must be unique within a collection"));
  } else {
    identifiers.add(value.id);
  }
  if (value.projectId !== projectId) {
    issues.push(issue("project_scope_mismatch", `${path}.projectId`, "Observation belongs to another project"));
  }
  if (!isIdentifier(value.roomId)) {
    issues.push(issue("invalid_input", `${path}.roomId`, "Room id must be canonical"));
  }
  if (!isOutcomeSignalKind(value.kind)) {
    issues.push(issue("invalid_input", `${path}.kind`, "Observation kind is unsupported"));
    return null;
  }
  if (!isOutcomeSignalSource(value.source) || !TRUSTED_SOURCES[value.kind].includes(value.source)) {
    issues.push(issue("untrusted_source", `${path}.source`, "Model self-report and untrusted observation sources are excluded"));
  }
  if (!isIdentifier(value.sourceRef)) {
    issues.push(issue("invalid_input", `${path}.sourceRef`, "Source reference must be canonical"));
  }
  if (typeof value.evidenceHash !== "string" || !HASH.test(value.evidenceHash)) {
    issues.push(issue("invalid_input", `${path}.evidenceHash`, "Evidence hash must be a lowercase SHA-256 digest"));
  }
  const observedAtMs = parseCanonicalTimestamp(value.observedAt, `${path}.observedAt`, issues);
  if (observedAtMs !== null) {
    if (observedAtMs < asOfMs - maxObservationAgeMs) {
      issues.push(issue("stale_observation", `${path}.observedAt`, "Observation is outside the authorized freshness window"));
    }
    if (observedAtMs > asOfMs) {
      issues.push(issue("future_observation", `${path}.observedAt`, "Observation occurs after collection time"));
    }
  }
  if (value.unit !== EXPECTED_UNITS[value.kind]) {
    issues.push(issue("invalid_unit", `${path}.unit`, `Observation kind ${value.kind} requires ${EXPECTED_UNITS[value.kind]} units`));
  }
  if (!isValidValue(value.unit, value.value)) {
    issues.push(issue("invalid_value", `${path}.value`, "Observation value is outside its trusted unit range"));
  }
  if (!isIdentifier(value.id) || !isIdentifier(value.roomId) || !isIdentifier(value.sourceRef)
    || typeof value.evidenceHash !== "string" || !HASH.test(value.evidenceHash)
    || observedAtMs === null || !isOutcomeSignalSource(value.source)
    || value.unit !== EXPECTED_UNITS[value.kind] || !isValidValue(value.unit, value.value)
    || value.projectId !== projectId || !TRUSTED_SOURCES[value.kind].includes(value.source)) {
    return null;
  }
  return {
    contractVersion: ROOM_EVOLUTION_OUTCOME_SIGNAL_CONTRACT_VERSION,
    id: value.id as string,
    projectId,
    roomId: value.roomId as string,
    kind: value.kind,
    source: value.source as RoomEvolutionOutcomeSignalSourceV1,
    sourceRef: value.sourceRef as string,
    evidenceHash: value.evidenceHash as string,
    observedAt: value.observedAt as string,
    unit: value.unit as RoomEvolutionOutcomeSignalUnitV1,
    value: value.value as number,
  };
}

function parseCanonicalTimestamp(
  value: unknown,
  path: string,
  issues: RoomEvolutionOutcomeSignalIssueV1[],
): number | null {
  if (typeof value !== "string") {
    issues.push(issue("invalid_timestamp", path, "Timestamp must be canonical UTC ISO text"));
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    issues.push(issue("invalid_timestamp", path, "Timestamp must be canonical UTC ISO text"));
    return null;
  }
  return parsed;
}

function isValidValue(unit: unknown, value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return false;
  if (unit === "count") return Number.isSafeInteger(value);
  if (unit === "ratio") return value <= 1;
  return unit === "milliseconds";
}

function isOutcomeSignalKind(value: unknown): value is RoomEvolutionOutcomeSignalKindV1 {
  return typeof value === "string" && ROOM_EVOLUTION_OUTCOME_SIGNAL_KINDS.includes(value as RoomEvolutionOutcomeSignalKindV1);
}

function isOutcomeSignalSource(value: unknown): value is RoomEvolutionOutcomeSignalSourceV1 {
  return value === "deterministic_gate"
    || value === "human_correction"
    || value === "durable_room_ledger"
    || value === "independent_review"
    || value === "authorized_observed_outcome"
    || value === "room_metric";
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function issue(
  code: RoomEvolutionOutcomeSignalIssueCodeV1,
  path: string,
  message: string,
): RoomEvolutionOutcomeSignalIssueV1 {
  return { code, path, message };
}

function failure(
  issues: readonly RoomEvolutionOutcomeSignalIssueV1[],
): CollectAuthorizedRoomEvolutionOutcomeSignalsResultV1 {
  return deepFreeze({
    ok: false,
    issues: [...issues].sort((left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code)),
  });
}

function success(value: RoomEvolutionOutcomeSignalSetV1): CollectAuthorizedRoomEvolutionOutcomeSignalsResultV1 {
  return deepFreeze({ ok: true, value });
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null) return value;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const nestedValue of Object.values(value)) deepFreeze(nestedValue, seen);
  return Object.freeze(value);
}

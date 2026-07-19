import {
  calculateRoomObservabilityMetrics,
  type RoomCapacityTelemetryV1,
  type RoomMetricReasonCountV1,
  type RoomMetricWindowInputV1,
  type RoomObservabilityMetricsInputV1,
  type RoomObservabilityMetricsSnapshotV1,
  type RoomObservabilityScopeV1,
  type RoomQueueTelemetryV1,
  type RoomReasonTelemetryV1,
  type RoomRecoveryTelemetryV1,
  type RoomThroughputTelemetryV1,
} from "@fusion/core";

import {
  ROOM_CONNECTOR_RUNTIME_OBSERVATION_REPORTER_CONTRACT_VERSION,
  type RoomConnectorRuntimeObservationV1,
} from "./room-connector-runtime-observation-reporter.js";

export const ROOM_RUNTIME_OBSERVABILITY_BRIDGE_CONTRACT_VERSION = 1 as const;

const CONTROLLED_RUNTIME_OBSERVATION_SOURCE = "controlled_connector_runtime_observation_port" as const;

type RoomRuntimeCapacityFactsV1 = Omit<RoomCapacityTelemetryV1, "scope" | "observedAt">;
type RoomRuntimeThroughputFactsV1 = Omit<RoomThroughputTelemetryV1, "scope" | "observedAt">;
type RoomRuntimeQueueFactsV1 = Omit<RoomQueueTelemetryV1, "scope" | "observedAt">;
type RoomRuntimeRecoveryFactsV1 = Omit<RoomRecoveryTelemetryV1, "scope" | "observedAt">;

export interface RoomRuntimeObservabilitySchedulingFactsV1 {
  readonly scope: RoomObservabilityScopeV1;
  readonly observedAt: string;
  readonly evidenceRefs: readonly string[];
  readonly capacity: RoomRuntimeCapacityFactsV1 | null;
  readonly throughput: RoomRuntimeThroughputFactsV1 | null;
  readonly queue: RoomRuntimeQueueFactsV1 | null;
  readonly idleReasons: readonly RoomMetricReasonCountV1[] | null;
  readonly waitReasons: readonly RoomMetricReasonCountV1[] | null;
  readonly recovery: RoomRuntimeRecoveryFactsV1 | null;
}

export interface RoomRuntimeObservabilityBridgeInputV1 {
  readonly contractVersion: typeof ROOM_RUNTIME_OBSERVABILITY_BRIDGE_CONTRACT_VERSION;
  readonly scope: RoomObservabilityScopeV1;
  readonly eventId: string;
  readonly cursor: number;
  readonly computedAt: string;
  readonly window: RoomMetricWindowInputV1;
  readonly connectorRuntime: RoomConnectorRuntimeObservationV1 | null;
  readonly scheduling: RoomRuntimeObservabilitySchedulingFactsV1 | null;
}

export type RoomRuntimeObservabilityAlertCodeV1 =
  | "connector_degraded"
  | "connector_health_unknown"
  | "connector_unavailable"
  | "idle_reason_unknown"
  | "metrics_telemetry_missing"
  | "queue_blocked"
  | "queue_retrying"
  | "runtime_telemetry_missing"
  | "saturation_detected"
  | "scheduling_telemetry_missing";

export interface RoomRuntimeObservabilityAlertV1 {
  readonly code: RoomRuntimeObservabilityAlertCodeV1;
  readonly severity: "info" | "warning" | "critical";
  readonly reason: string;
  readonly evidenceRefs: readonly string[];
}

export interface RoomRuntimeObservabilityConnectorStatusV1 {
  readonly state: "healthy" | "degraded" | "unavailable" | "unknown";
  readonly reason: string;
  readonly evidenceRefs: readonly string[];
}

export interface RoomRuntimeObservabilityIdleStatusV1 {
  readonly state: "known" | "not_idle" | "unknown";
  readonly reason: string;
  readonly reasons: readonly RoomMetricReasonCountV1[];
  readonly evidenceRefs: readonly string[];
}

export interface RoomRuntimeObservabilityPublicationV1 {
  readonly contractVersion: typeof ROOM_RUNTIME_OBSERVABILITY_BRIDGE_CONTRACT_VERSION;
  readonly scope: RoomObservabilityScopeV1;
  readonly eventId: string;
  readonly cursor: number;
  readonly computedAt: string;
  readonly snapshot: RoomObservabilityMetricsSnapshotV1;
  readonly connector: RoomRuntimeObservabilityConnectorStatusV1;
  readonly idle: RoomRuntimeObservabilityIdleStatusV1;
  readonly alerts: readonly RoomRuntimeObservabilityAlertV1[];
  readonly evidenceRefs: readonly string[];
}

export type RoomRuntimeObservabilitySinkAckV1 =
  | {
    readonly ok: true;
    readonly acknowledgementRef: string;
    readonly acknowledgedAt: string;
  }
  | {
    readonly ok: false;
    readonly reason: string;
    readonly evidenceRefs: readonly string[];
  };

export interface RoomRuntimeObservabilitySinkV1 {
  publish(publication: RoomRuntimeObservabilityPublicationV1): Promise<RoomRuntimeObservabilitySinkAckV1>;
}

export interface RoomRuntimeObservabilityBridgeOptionsV1 {
  readonly sink?: RoomRuntimeObservabilitySinkV1;
}

export type RoomRuntimeObservabilityBridgeReasonCodeV1 =
  | "duplicate_event"
  | "invalid_input"
  | "scope_mismatch"
  | "sink_ack_failed"
  | "sink_ack_rejected"
  | "stale_cursor";

export interface RoomRuntimeObservabilityBridgeWithheldReasonV1 {
  readonly code: RoomRuntimeObservabilityBridgeReasonCodeV1;
  readonly message: string;
}

export type RoomRuntimeObservabilityBridgeResultV1 =
  | ({
    readonly ok: true;
    readonly outcome: "published";
    readonly delivery: "core_calculated" | "sink_acknowledged";
  } & RoomRuntimeObservabilityPublicationV1)
  | {
    readonly ok: false;
    readonly outcome: "withheld";
    readonly reason: RoomRuntimeObservabilityBridgeWithheldReasonV1;
    readonly evidenceRefs: readonly string[];
  };

interface NormalizedSchedulingFacts {
  readonly scope: RoomObservabilityScopeV1;
  readonly observedAt: string;
  readonly evidenceRefs: readonly string[];
  readonly capacity: RoomRuntimeCapacityFactsV1 | null;
  readonly throughput: RoomRuntimeThroughputFactsV1 | null;
  readonly queue: RoomRuntimeQueueFactsV1 | null;
  readonly idleReasons: readonly RoomMetricReasonCountV1[] | null;
  readonly waitReasons: readonly RoomMetricReasonCountV1[] | null;
  readonly recovery: RoomRuntimeRecoveryFactsV1 | null;
}

interface NormalizedRuntimeFacts {
  readonly present: boolean;
  readonly availability: "available" | "unavailable" | "unknown";
  readonly healthState: string | null;
  readonly evidenceRefs: readonly string[];
}

interface NormalizedInput {
  readonly scope: RoomObservabilityScopeV1;
  readonly eventId: string;
  readonly cursor: number;
  readonly computedAt: string;
  readonly window: RoomMetricWindowInputV1;
  readonly connectorRuntime: NormalizedRuntimeFacts;
  readonly scheduling: NormalizedSchedulingFacts | null;
}

interface ScopeState {
  readonly eventIds: Set<string>;
  cursor: number;
}

interface ControlledRuntimeField {
  readonly state: "known" | "unknown";
  readonly observedAt: string;
  readonly value: unknown | null;
}

class BridgeValidationError extends Error {
  constructor(
    readonly code: "invalid_input" | "scope_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "BridgeValidationError";
  }
}

type UnknownRecord = Record<string, unknown>;

function freeze<T>(value: T): T {
  return Object.freeze(value);
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertExactKeys(value: unknown, expected: readonly string[], label: string): asserts value is UnknownRecord {
  if (!isRecord(value)) {
    throw new BridgeValidationError("invalid_input", `${label} must be an inspectable object`);
  }
  const actual = Object.keys(value).sort(compareText);
  const canonicalExpected = [...expected].sort(compareText);
  if (actual.length !== canonicalExpected.length || actual.some((key, index) => key !== canonicalExpected[index])) {
    throw new BridgeValidationError("invalid_input", `${label} has unexpected or missing fields`);
  }
}

function assertCanonicalIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw new BridgeValidationError("invalid_input", `${label} must be a canonical identifier`);
  }
}

function parseCanonicalTimestamp(value: unknown, label: string): number {
  if (typeof value !== "string") {
    throw new BridgeValidationError("invalid_input", `${label} must be a canonical ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new BridgeValidationError("invalid_input", `${label} must be a canonical ISO timestamp`);
  }
  return parsed;
}

function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new BridgeValidationError("invalid_input", `${label} must be a non-negative safe integer`);
  }
}

function normalizeScope(value: unknown, label: string): RoomObservabilityScopeV1 {
  assertExactKeys(value, ["projectId", "roomId"], label);
  assertCanonicalIdentifier(value.projectId, `${label} project id`);
  assertCanonicalIdentifier(value.roomId, `${label} Room id`);
  return freeze({ projectId: value.projectId, roomId: value.roomId });
}

function assertSameScope(actual: RoomObservabilityScopeV1, expected: RoomObservabilityScopeV1, label: string): void {
  if (actual.projectId !== expected.projectId || actual.roomId !== expected.roomId) {
    throw new BridgeValidationError("scope_mismatch", `${label} is outside the requested project/Room scope`);
  }
}

function normalizeEvidenceRefs(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new BridgeValidationError("invalid_input", `${label} must be an array`);
  }
  const refs = value.map((ref) => {
    if (typeof ref !== "string" || ref.length === 0 || ref.trim() !== ref) {
      throw new BridgeValidationError("invalid_input", `${label} must contain canonical evidence references`);
    }
    return ref;
  });
  return freeze([...new Set(refs)].sort(compareText));
}

function mergeEvidenceRefs(...values: readonly (readonly string[])[]): readonly string[] {
  return freeze([...new Set(values.flat())].sort(compareText));
}

function normalizeWindow(value: unknown, computedAtMs: number): RoomMetricWindowInputV1 {
  assertExactKeys(value, ["startedAt", "endedAt"], "Room observability window");
  const startedAtMs = parseCanonicalTimestamp(value.startedAt, "Room observability window startedAt");
  const endedAtMs = parseCanonicalTimestamp(value.endedAt, "Room observability window endedAt");
  if (endedAtMs <= startedAtMs || endedAtMs > computedAtMs) {
    throw new BridgeValidationError("invalid_input", "Room observability window must finish after start and no later than computation");
  }
  return freeze({ startedAt: value.startedAt as string, endedAt: value.endedAt as string });
}

function normalizeFactRecord<T>(value: unknown, expectedKeys: readonly string[], label: string): T | null {
  if (value === null) return null;
  assertExactKeys(value, expectedKeys, label);
  return value as T;
}

function normalizeReasonFacts(value: unknown, label: string): readonly RoomMetricReasonCountV1[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) {
    throw new BridgeValidationError("invalid_input", `${label} must be an array or null`);
  }
  return value as readonly RoomMetricReasonCountV1[];
}

function normalizeScheduling(
  value: unknown,
  scope: RoomObservabilityScopeV1,
  computedAtMs: number,
): NormalizedSchedulingFacts | null {
  if (value === null) return null;
  assertExactKeys(value, [
    "scope", "observedAt", "evidenceRefs", "capacity", "throughput", "queue", "idleReasons", "waitReasons", "recovery",
  ], "Room scheduling facts");
  const schedulingScope = normalizeScope(value.scope, "Room scheduling facts scope");
  assertSameScope(schedulingScope, scope, "Room scheduling facts");
  const observedAtMs = parseCanonicalTimestamp(value.observedAt, "Room scheduling facts observedAt");
  if (observedAtMs > computedAtMs) {
    throw new BridgeValidationError("invalid_input", "Room scheduling facts cannot be observed after computation");
  }
  return freeze({
    scope: schedulingScope,
    observedAt: value.observedAt as string,
    evidenceRefs: normalizeEvidenceRefs(value.evidenceRefs, "Room scheduling facts evidenceRefs"),
    capacity: normalizeFactRecord<RoomRuntimeCapacityFactsV1>(value.capacity, [
      "configuredSlots", "eligibleSlots", "activeSlots", "reservedVerifierSlots", "reservedRecoverySlots", "degradedSlots", "blockedSlots", "retryingSlots",
    ], "Room capacity facts"),
    throughput: normalizeFactRecord<RoomRuntimeThroughputFactsV1>(value.throughput, ["completedTasks", "committedEvents"], "Room throughput facts"),
    queue: normalizeFactRecord<RoomRuntimeQueueFactsV1>(value.queue, ["readyTasks", "queuedTasks", "blockedTasks", "retryingTasks"], "Room queue facts"),
    idleReasons: normalizeReasonFacts(value.idleReasons, "Room idle reason facts"),
    waitReasons: normalizeReasonFacts(value.waitReasons, "Room wait reason facts"),
    recovery: normalizeFactRecord<RoomRuntimeRecoveryFactsV1>(value.recovery, ["attempted", "succeeded", "failed", "inFlight"], "Room recovery facts"),
  });
}

function normalizeControlledRuntimeField(
  value: unknown,
  label: string,
  computedAtMs: number,
): ControlledRuntimeField {
  if (!isRecord(value)) {
    throw new BridgeValidationError("invalid_input", `${label} must be an inspectable controlled runtime field`);
  }
  if (value.state === "known") {
    assertExactKeys(value, ["state", "source", "observedAt", "value"], label);
  } else if (value.state === "unknown") {
    assertExactKeys(value, ["state", "source", "observedAt", "reason"], label);
  } else {
    throw new BridgeValidationError("invalid_input", `${label} must be known or explicitly unknown`);
  }
  if (value.source !== CONTROLLED_RUNTIME_OBSERVATION_SOURCE) {
    throw new BridgeValidationError("invalid_input", `${label} must originate from the controlled connector runtime port`);
  }
  const observedAtMs = parseCanonicalTimestamp(value.observedAt, `${label} observedAt`);
  if (observedAtMs > computedAtMs) {
    throw new BridgeValidationError("invalid_input", `${label} cannot be observed after computation`);
  }
  return freeze({
    state: value.state,
    observedAt: value.observedAt as string,
    value: value.state === "known" ? value.value : null,
  });
}

function normalizeRuntime(
  value: unknown,
  scope: RoomObservabilityScopeV1,
  computedAtMs: number,
): NormalizedRuntimeFacts {
  if (value === null) {
    return freeze({ present: false, availability: "unknown" as const, healthState: null, evidenceRefs: freeze([]) });
  }
  if (!isRecord(value)) {
    throw new BridgeValidationError("invalid_input", "Connector runtime observation must be an inspectable object or null");
  }
  if (value.contractVersion !== ROOM_CONNECTOR_RUNTIME_OBSERVATION_REPORTER_CONTRACT_VERSION) {
    throw new BridgeValidationError("invalid_input", "Connector runtime observation contract version is unsupported");
  }
  if (value.source !== CONTROLLED_RUNTIME_OBSERVATION_SOURCE) {
    throw new BridgeValidationError("invalid_input", "Connector runtime observation source is not controlled");
  }
  if (value.projectId !== scope.projectId || value.roomId !== scope.roomId) {
    throw new BridgeValidationError("scope_mismatch", "Connector runtime observation is outside the requested project/Room scope");
  }
  assertCanonicalIdentifier(value.bindingId, "Connector runtime observation binding id");
  const snapshot = normalizeControlledRuntimeField(value.snapshot, "Connector runtime snapshot", computedAtMs);
  const connectorEvidence = normalizeControlledRuntimeField(value.connectorEvidence, "Connector runtime connector evidence", computedAtMs);
  const health = normalizeControlledRuntimeField(value.health, "Connector runtime health", computedAtMs);
  let snapshotSuffix = "unversioned";
  if (snapshot.state === "known") {
    assertExactKeys(snapshot.value, ["snapshotId", "revision", "capturedAt", "expiresAt"], "Connector runtime snapshot value");
    assertCanonicalIdentifier(snapshot.value.snapshotId, "Connector runtime snapshot id");
    assertNonNegativeSafeInteger(snapshot.value.revision, "Connector runtime snapshot revision");
    parseCanonicalTimestamp(snapshot.value.capturedAt, "Connector runtime snapshot capturedAt");
    parseCanonicalTimestamp(snapshot.value.expiresAt, "Connector runtime snapshot expiresAt");
    snapshotSuffix = `${snapshot.value.snapshotId as string}@${snapshot.value.revision as number}`;
  }
  let availability: NormalizedRuntimeFacts["availability"] = "unknown";
  if (connectorEvidence.state === "known") {
    assertExactKeys(connectorEvidence.value, ["availability"], "Connector runtime connector evidence value");
    if (connectorEvidence.value.availability !== "available" && connectorEvidence.value.availability !== "unavailable") {
      throw new BridgeValidationError("invalid_input", "Connector runtime availability is unsupported");
    }
    availability = connectorEvidence.value.availability;
  }
  let healthState: string | null = null;
  if (health.state === "known") {
    if (!isRecord(health.value) || typeof health.value.state !== "string" || health.value.state.length === 0) {
      throw new BridgeValidationError("invalid_input", "Connector runtime health must include a reported state");
    }
    healthState = health.value.state;
  }
  const baseRef = `connector-runtime://${value.bindingId}/${snapshotSuffix}`;
  return freeze({
    present: true,
    availability,
    healthState,
    evidenceRefs: mergeEvidenceRefs([
      `${baseRef}/snapshot/${snapshot.observedAt}`,
      `${baseRef}/connector/${connectorEvidence.observedAt}`,
      `${baseRef}/health/${health.observedAt}`,
    ]),
  });
}

function normalizeInput(rawInput: unknown): NormalizedInput {
  assertExactKeys(rawInput, [
    "contractVersion", "scope", "eventId", "cursor", "computedAt", "window", "connectorRuntime", "scheduling",
  ], "Room runtime observability bridge input");
  if (rawInput.contractVersion !== ROOM_RUNTIME_OBSERVABILITY_BRIDGE_CONTRACT_VERSION) {
    throw new BridgeValidationError("invalid_input", "Room runtime observability bridge contract version is unsupported");
  }
  const scope = normalizeScope(rawInput.scope, "Room runtime observability bridge scope");
  assertCanonicalIdentifier(rawInput.eventId, "Room runtime observability event id");
  assertNonNegativeSafeInteger(rawInput.cursor, "Room runtime observability cursor");
  const computedAtMs = parseCanonicalTimestamp(rawInput.computedAt, "Room runtime observability computedAt");
  return freeze({
    scope,
    eventId: rawInput.eventId,
    cursor: rawInput.cursor,
    computedAt: rawInput.computedAt as string,
    window: normalizeWindow(rawInput.window, computedAtMs),
    connectorRuntime: normalizeRuntime(rawInput.connectorRuntime, scope, computedAtMs),
    scheduling: normalizeScheduling(rawInput.scheduling, scope, computedAtMs),
  });
}

function derivedProviderIdleReasons(
  runtime: NormalizedRuntimeFacts,
  scheduling: NormalizedSchedulingFacts | null,
): readonly RoomMetricReasonCountV1[] | null {
  if (scheduling?.idleReasons !== null && scheduling?.idleReasons !== undefined) return scheduling.idleReasons;
  if (runtime.availability !== "unavailable" || scheduling?.capacity === null || scheduling?.capacity === undefined) return null;
  const { eligibleSlots, activeSlots } = scheduling.capacity;
  if (
    typeof eligibleSlots !== "number"
    || typeof activeSlots !== "number"
    || !Number.isSafeInteger(eligibleSlots)
    || !Number.isSafeInteger(activeSlots)
    || eligibleSlots < activeSlots
    || activeSlots < 0
  ) {
    return null;
  }
  const idleSlots = eligibleSlots - activeSlots;
  return idleSlots === 0 ? null : freeze([{ reason: "provider", count: idleSlots }]);
}

function toCoreMetricsInput(input: NormalizedInput): RoomObservabilityMetricsInputV1 {
  const scheduling = input.scheduling;
  const idleReasons = derivedProviderIdleReasons(input.connectorRuntime, scheduling);
  const observedAt = scheduling?.observedAt;
  return {
    contractVersion: 1,
    scope: input.scope,
    computedAt: input.computedAt,
    window: input.window,
    capacity: scheduling?.capacity === null || scheduling?.capacity === undefined || observedAt === undefined
      ? null
      : { scope: input.scope, observedAt, ...scheduling.capacity },
    throughput: scheduling?.throughput === null || scheduling?.throughput === undefined || observedAt === undefined
      ? null
      : { scope: input.scope, observedAt, ...scheduling.throughput },
    queue: scheduling?.queue === null || scheduling?.queue === undefined || observedAt === undefined
      ? null
      : { scope: input.scope, observedAt, ...scheduling.queue },
    idle: idleReasons === null || observedAt === undefined
      ? null
      : { scope: input.scope, observedAt, reasons: idleReasons } satisfies RoomReasonTelemetryV1,
    wait: scheduling?.waitReasons === null || scheduling?.waitReasons === undefined || observedAt === undefined
      ? null
      : { scope: input.scope, observedAt, reasons: scheduling.waitReasons } satisfies RoomReasonTelemetryV1,
    recovery: scheduling?.recovery === null || scheduling?.recovery === undefined || observedAt === undefined
      ? null
      : { scope: input.scope, observedAt, ...scheduling.recovery },
  };
}

function connectorStatus(runtime: NormalizedRuntimeFacts): RoomRuntimeObservabilityConnectorStatusV1 {
  if (!runtime.present) {
    return freeze({
      state: "unknown" as const,
      reason: "Connector runtime telemetry is absent, so connector health cannot be asserted",
      evidenceRefs: runtime.evidenceRefs,
    });
  }
  if (runtime.availability === "unavailable") {
    return freeze({
      state: "unavailable" as const,
      reason: "Controlled connector runtime telemetry reports the binding as unavailable",
      evidenceRefs: runtime.evidenceRefs,
    });
  }
  if (runtime.availability === "unknown" || runtime.healthState === null) {
    return freeze({
      state: "unknown" as const,
      reason: "Controlled connector runtime telemetry does not provide both availability and health",
      evidenceRefs: runtime.evidenceRefs,
    });
  }
  if (runtime.healthState === "healthy") {
    return freeze({
      state: "healthy" as const,
      reason: "Controlled connector runtime telemetry reports an available healthy binding",
      evidenceRefs: runtime.evidenceRefs,
    });
  }
  return freeze({
    state: "degraded" as const,
    reason: `Controlled connector runtime telemetry reports health state ${runtime.healthState}`,
    evidenceRefs: runtime.evidenceRefs,
  });
}

function idleStatus(
  snapshot: RoomObservabilityMetricsSnapshotV1,
  evidenceRefs: readonly string[],
): RoomRuntimeObservabilityIdleStatusV1 {
  if (snapshot.idle.slots.state === "unknown") {
    return freeze({
      state: "unknown" as const,
      reason: "Idle capacity cannot be determined because eligible or active capacity telemetry is missing",
      reasons: freeze([]),
      evidenceRefs,
    });
  }
  if (snapshot.idle.slots.value === 0) {
    return freeze({
      state: "not_idle" as const,
      reason: "No idle capacity is observed",
      reasons: freeze([]),
      evidenceRefs,
    });
  }
  if (snapshot.idle.reasonTelemetryState === "known" && snapshot.idle.reasons.length > 0) {
    return freeze({
      state: "known" as const,
      reason: "Idle capacity is attributed by controlled scheduling or connector runtime telemetry",
      reasons: snapshot.idle.reasons,
      evidenceRefs,
    });
  }
  return freeze({
    state: "unknown" as const,
    reason: "Idle capacity is observed but has no attributable reason telemetry",
    reasons: freeze([]),
    evidenceRefs,
  });
}

function createAlert(
  code: RoomRuntimeObservabilityAlertCodeV1,
  severity: RoomRuntimeObservabilityAlertV1["severity"],
  reason: string,
  evidenceRefs: readonly string[],
): RoomRuntimeObservabilityAlertV1 {
  return freeze({ code, severity, reason, evidenceRefs });
}

function alertsFor(
  input: NormalizedInput,
  snapshot: RoomObservabilityMetricsSnapshotV1,
  connector: RoomRuntimeObservabilityConnectorStatusV1,
  idle: RoomRuntimeObservabilityIdleStatusV1,
  evidenceRefs: readonly string[],
): readonly RoomRuntimeObservabilityAlertV1[] {
  const alerts: RoomRuntimeObservabilityAlertV1[] = [];
  if (!input.connectorRuntime.present) {
    alerts.push(createAlert("runtime_telemetry_missing", "warning", "Connector runtime telemetry is absent", input.connectorRuntime.evidenceRefs));
  }
  if (input.scheduling === null) {
    alerts.push(createAlert("scheduling_telemetry_missing", "warning", "Scheduling and queue telemetry is absent", freeze([])));
  }
  if (connector.state === "unavailable") {
    alerts.push(createAlert("connector_unavailable", "critical", connector.reason, connector.evidenceRefs));
  } else if (connector.state === "degraded") {
    alerts.push(createAlert("connector_degraded", "warning", connector.reason, connector.evidenceRefs));
  } else if (connector.state === "unknown") {
    alerts.push(createAlert("connector_health_unknown", "warning", connector.reason, connector.evidenceRefs));
  }
  if (snapshot.missingTelemetry.length > 0) {
    alerts.push(createAlert(
      "metrics_telemetry_missing",
      "warning",
      `Core metrics snapshot has explicit missing telemetry: ${snapshot.missingTelemetry.join(", ")}`,
      evidenceRefs,
    ));
  }
  if (snapshot.saturation.classification === "saturated") {
    alerts.push(createAlert("saturation_detected", "warning", "Observed active capacity equals eligible capacity", evidenceRefs));
  }
  if (snapshot.queue.blockedTasks.value !== null && snapshot.queue.blockedTasks.value > 0) {
    alerts.push(createAlert("queue_blocked", "warning", "Observed queue contains blocked tasks", evidenceRefs));
  }
  if (snapshot.queue.retryingTasks.value !== null && snapshot.queue.retryingTasks.value > 0) {
    alerts.push(createAlert("queue_retrying", "info", "Observed queue contains retrying tasks", evidenceRefs));
  }
  if (idle.state === "unknown") {
    alerts.push(createAlert("idle_reason_unknown", "warning", idle.reason, idle.evidenceRefs));
  }
  return freeze(alerts.sort((left, right) => compareText(left.code, right.code)));
}

function withhold(
  code: RoomRuntimeObservabilityBridgeReasonCodeV1,
  message: string,
  evidenceRefs: readonly string[] = freeze([]),
): RoomRuntimeObservabilityBridgeResultV1 {
  return freeze({
    ok: false as const,
    outcome: "withheld" as const,
    reason: freeze({ code, message }),
    evidenceRefs,
  });
}

function scopeKey(scope: RoomObservabilityScopeV1): string {
  return `${scope.projectId}\u0000${scope.roomId}`;
}

function normalizeSinkAck(value: unknown, computedAt: string): RoomRuntimeObservabilitySinkAckV1 {
  if (!isRecord(value)) {
    throw new Error("Observability sink acknowledgement must be an inspectable object");
  }
  if (value.ok === true) {
    assertExactKeys(value, ["ok", "acknowledgementRef", "acknowledgedAt"], "Observability sink acknowledgement");
    const refs = normalizeEvidenceRefs([value.acknowledgementRef], "Observability sink acknowledgement reference");
    const acknowledgedAtMs = parseCanonicalTimestamp(value.acknowledgedAt, "Observability sink acknowledgement time");
    const computedAtMs = parseCanonicalTimestamp(computedAt, "Room runtime observability computedAt");
    if (acknowledgedAtMs < computedAtMs) {
      throw new Error("Observability sink acknowledgement cannot predate computation");
    }
    return freeze({
      ok: true as const,
      acknowledgementRef: refs[0]!,
      acknowledgedAt: value.acknowledgedAt as string,
    });
  }
  if (value.ok === false) {
    assertExactKeys(value, ["ok", "reason", "evidenceRefs"], "Observability sink rejection");
    if (typeof value.reason !== "string" || value.reason.length === 0 || value.reason.trim() !== value.reason) {
      throw new Error("Observability sink rejection must include a canonical reason");
    }
    return freeze({
      ok: false as const,
      reason: value.reason,
      evidenceRefs: normalizeEvidenceRefs(value.evidenceRefs, "Observability sink rejection evidenceRefs"),
    });
  }
  throw new Error("Observability sink acknowledgement must be accepted or rejected");
}

export class RoomRuntimeObservabilityBridge {
  private readonly sink: RoomRuntimeObservabilitySinkV1 | null;
  private readonly scopeStates = new Map<string, ScopeState>();
  private readonly latestByScope = new Map<string, RoomRuntimeObservabilityPublicationV1>();
  private readonly scopeTails = new Map<string, Promise<void>>();

  constructor(options: RoomRuntimeObservabilityBridgeOptionsV1 = {}) {
    if (options.sink !== undefined && (options.sink === null || typeof options.sink.publish !== "function")) {
      throw new Error("Room runtime observability sink must implement publish");
    }
    this.sink = options.sink ?? null;
  }

  getLatest(scope: RoomObservabilityScopeV1): RoomRuntimeObservabilityPublicationV1 | null {
    const normalizedScope = normalizeScope(scope, "Room runtime observability latest scope");
    return this.latestByScope.get(scopeKey(normalizedScope)) ?? null;
  }

  async observe(rawInput: RoomRuntimeObservabilityBridgeInputV1): Promise<RoomRuntimeObservabilityBridgeResultV1> {
    let input: NormalizedInput;
    try {
      input = normalizeInput(rawInput);
    } catch (error) {
      if (error instanceof BridgeValidationError) return withhold(error.code, error.message);
      return withhold("invalid_input", "Room runtime observability input could not be validated");
    }
    return this.withScopeLock(scopeKey(input.scope), async () => this.observeNormalized(input));
  }

  private async observeNormalized(input: NormalizedInput): Promise<RoomRuntimeObservabilityBridgeResultV1> {
    const key = scopeKey(input.scope);
    const state = this.scopeStates.get(key) ?? { cursor: -1, eventIds: new Set<string>() };
    if (state.eventIds.has(input.eventId)) {
      return withhold("duplicate_event", "Observability event has already produced an acknowledged snapshot");
    }
    if (input.cursor <= state.cursor) {
      return withhold("stale_cursor", "Observability event cursor cannot replace the current Room snapshot");
    }
    let snapshot: RoomObservabilityMetricsSnapshotV1;
    try {
      snapshot = calculateRoomObservabilityMetrics(toCoreMetricsInput(input));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Core metrics calculation rejected runtime facts";
      return withhold("invalid_input", message);
    }
    const baseEvidenceRefs = mergeEvidenceRefs(
      input.connectorRuntime.evidenceRefs,
      input.scheduling?.evidenceRefs ?? freeze([]),
    );
    const connector = connectorStatus(input.connectorRuntime);
    const idle = idleStatus(snapshot, baseEvidenceRefs);
    const alerts = alertsFor(input, snapshot, connector, idle, baseEvidenceRefs);
    const publication = freeze({
      contractVersion: ROOM_RUNTIME_OBSERVABILITY_BRIDGE_CONTRACT_VERSION,
      scope: input.scope,
      eventId: input.eventId,
      cursor: input.cursor,
      computedAt: input.computedAt,
      snapshot,
      connector,
      idle,
      alerts,
      evidenceRefs: baseEvidenceRefs,
    } satisfies RoomRuntimeObservabilityPublicationV1);
    if (this.sink === null) {
      this.recordPublished(key, publication);
      return freeze({ ok: true as const, outcome: "published" as const, delivery: "core_calculated" as const, ...publication });
    }
    let acknowledgement: RoomRuntimeObservabilitySinkAckV1;
    try {
      acknowledgement = normalizeSinkAck(await this.sink.publish(publication), input.computedAt);
    } catch {
      return withhold("sink_ack_failed", "Observability sink failed before producing a valid acknowledgement", baseEvidenceRefs);
    }
    if (!acknowledgement.ok) {
      return withhold(
        "sink_ack_rejected",
        `Observability sink rejected the snapshot: ${acknowledgement.reason}`,
        mergeEvidenceRefs(baseEvidenceRefs, acknowledgement.evidenceRefs),
      );
    }
    const acknowledgedPublication = freeze({
      ...publication,
      evidenceRefs: mergeEvidenceRefs(baseEvidenceRefs, [acknowledgement.acknowledgementRef]),
    } satisfies RoomRuntimeObservabilityPublicationV1);
    this.recordPublished(key, acknowledgedPublication);
    return freeze({
      ok: true as const,
      outcome: "published" as const,
      delivery: "sink_acknowledged" as const,
      ...acknowledgedPublication,
    });
  }

  private recordPublished(key: string, publication: RoomRuntimeObservabilityPublicationV1): void {
    const state = this.scopeStates.get(key) ?? { cursor: -1, eventIds: new Set<string>() };
    state.cursor = publication.cursor;
    state.eventIds.add(publication.eventId);
    this.scopeStates.set(key, state);
    this.latestByScope.set(key, publication);
  }

  private async withScopeLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const tail = this.scopeTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = tail.then(() => gate);
    this.scopeTails.set(key, queued);
    await tail;
    try {
      return await operation();
    } finally {
      release();
      if (this.scopeTails.get(key) === queued) this.scopeTails.delete(key);
    }
  }
}

export const ROOM_OBSERVABILITY_METRICS_CONTRACT_VERSION = 1 as const;

const ROOM_METRIC_REASONS = [
  "approval",
  "backpressure",
  "dependency",
  "missing_capability",
  "no_eligible_work",
  "policy",
  "provider",
  "scheduler",
  "unknown",
] as const;

export type RoomMetricKnownnessV1 = "known" | "unknown";
export type RoomMetricRatioStateV1 = RoomMetricKnownnessV1 | "not_applicable";
export type RoomMetricReasonV1 = (typeof ROOM_METRIC_REASONS)[number];
export type RoomSaturationClassificationV1 = "saturated" | "available" | "unknown" | "not_applicable";
export type RoomObservabilityMissingTelemetryV1 =
  | "capacity"
  | "capacity.configured_slots"
  | "capacity.eligible_slots"
  | "capacity.active_slots"
  | "capacity.reserved_verifier_slots"
  | "capacity.reserved_recovery_slots"
  | "capacity.degraded_slots"
  | "capacity.blocked_slots"
  | "capacity.retrying_slots"
  | "throughput"
  | "throughput.completed_tasks"
  | "throughput.committed_events"
  | "queue"
  | "queue.ready_tasks"
  | "queue.queued_tasks"
  | "queue.blocked_tasks"
  | "queue.retrying_tasks"
  | "idle_reasons"
  | "wait_reasons"
  | "recovery"
  | "recovery.attempted"
  | "recovery.succeeded"
  | "recovery.failed"
  | "recovery.in_flight";

export interface RoomObservabilityScopeV1 {
  readonly projectId: string;
  readonly roomId: string;
}

export interface RoomMetricWindowInputV1 {
  readonly startedAt: string;
  readonly endedAt: string;
}

export interface RoomMetricReasonCountV1 {
  readonly reason: RoomMetricReasonV1;
  readonly count: number;
}

export interface RoomCapacityTelemetryV1 {
  readonly scope: RoomObservabilityScopeV1;
  readonly observedAt: string;
  readonly configuredSlots: number | null;
  readonly eligibleSlots: number | null;
  readonly activeSlots: number | null;
  readonly reservedVerifierSlots: number | null;
  readonly reservedRecoverySlots: number | null;
  readonly degradedSlots: number | null;
  readonly blockedSlots: number | null;
  readonly retryingSlots: number | null;
}

export interface RoomThroughputTelemetryV1 {
  readonly scope: RoomObservabilityScopeV1;
  readonly observedAt: string;
  readonly completedTasks: number | null;
  readonly committedEvents: number | null;
}

export interface RoomQueueTelemetryV1 {
  readonly scope: RoomObservabilityScopeV1;
  readonly observedAt: string;
  readonly readyTasks: number | null;
  readonly queuedTasks: number | null;
  readonly blockedTasks: number | null;
  readonly retryingTasks: number | null;
}

export interface RoomReasonTelemetryV1 {
  readonly scope: RoomObservabilityScopeV1;
  readonly observedAt: string;
  readonly reasons: readonly RoomMetricReasonCountV1[];
}

export interface RoomRecoveryTelemetryV1 {
  readonly scope: RoomObservabilityScopeV1;
  readonly observedAt: string;
  readonly attempted: number | null;
  readonly succeeded: number | null;
  readonly failed: number | null;
  readonly inFlight: number | null;
}

export interface RoomObservabilityMetricsInputV1 {
  readonly contractVersion: typeof ROOM_OBSERVABILITY_METRICS_CONTRACT_VERSION;
  readonly scope: RoomObservabilityScopeV1;
  readonly computedAt: string;
  readonly window: RoomMetricWindowInputV1;
  readonly capacity: RoomCapacityTelemetryV1 | null;
  readonly throughput: RoomThroughputTelemetryV1 | null;
  readonly queue: RoomQueueTelemetryV1 | null;
  readonly idle: RoomReasonTelemetryV1 | null;
  readonly wait: RoomReasonTelemetryV1 | null;
  readonly recovery: RoomRecoveryTelemetryV1 | null;
}

export interface RoomMetricCountSnapshotV1 {
  readonly state: RoomMetricKnownnessV1;
  readonly value: number | null;
}

export interface RoomMetricRatioSnapshotV1 {
  readonly state: RoomMetricRatioStateV1;
  readonly numerator: number | null;
  readonly denominator: number | null;
  readonly value: number | null;
}

export interface RoomObservabilityMetricsSnapshotV1 {
  readonly contractVersion: typeof ROOM_OBSERVABILITY_METRICS_CONTRACT_VERSION;
  readonly scope: RoomObservabilityScopeV1;
  readonly computedAt: string;
  readonly window: {
    readonly startedAt: string;
    readonly endedAt: string;
    readonly durationMs: number;
  };
  readonly capacity: {
    readonly observedAt: string | null;
    readonly configuredSlots: RoomMetricCountSnapshotV1;
    readonly eligibleSlots: RoomMetricCountSnapshotV1;
    readonly activeSlots: RoomMetricCountSnapshotV1;
    readonly reservedVerifierSlots: RoomMetricCountSnapshotV1;
    readonly reservedRecoverySlots: RoomMetricCountSnapshotV1;
    readonly degradedSlots: RoomMetricCountSnapshotV1;
    readonly blockedSlots: RoomMetricCountSnapshotV1;
    readonly retryingSlots: RoomMetricCountSnapshotV1;
  };
  readonly throughput: {
    readonly observedAt: string | null;
    readonly completedTasks: RoomMetricCountSnapshotV1;
    readonly committedEvents: RoomMetricCountSnapshotV1;
    readonly completedTasksPerSecond: RoomMetricRatioSnapshotV1;
    readonly committedEventsPerSecond: RoomMetricRatioSnapshotV1;
  };
  readonly queue: {
    readonly observedAt: string | null;
    readonly readyTasks: RoomMetricCountSnapshotV1;
    readonly queuedTasks: RoomMetricCountSnapshotV1;
    readonly blockedTasks: RoomMetricCountSnapshotV1;
    readonly retryingTasks: RoomMetricCountSnapshotV1;
  };
  readonly utilization: {
    readonly basis: "instantaneous_active_slots";
    readonly ratio: RoomMetricRatioSnapshotV1;
  };
  readonly idle: {
    readonly observedAt: string | null;
    readonly slots: RoomMetricCountSnapshotV1;
    readonly reasonTelemetryState: RoomMetricKnownnessV1;
    readonly reasons: readonly RoomMetricReasonCountV1[];
    readonly attributedSlots: RoomMetricCountSnapshotV1;
    readonly unattributedSlots: RoomMetricCountSnapshotV1;
  };
  readonly wait: {
    readonly observedAt: string | null;
    readonly reasonTelemetryState: RoomMetricKnownnessV1;
    readonly reasons: readonly RoomMetricReasonCountV1[];
    readonly waitingTasksObserved: RoomMetricCountSnapshotV1;
  };
  readonly saturation: {
    readonly classification: RoomSaturationClassificationV1;
    readonly ratio: RoomMetricRatioSnapshotV1;
  };
  readonly recovery: {
    readonly observedAt: string | null;
    readonly attempted: RoomMetricCountSnapshotV1;
    readonly succeeded: RoomMetricCountSnapshotV1;
    readonly failed: RoomMetricCountSnapshotV1;
    readonly inFlight: RoomMetricCountSnapshotV1;
  };
  readonly missingTelemetry: readonly RoomObservabilityMissingTelemetryV1[];
}

export function calculateRoomObservabilityMetrics(
  input: RoomObservabilityMetricsInputV1,
): RoomObservabilityMetricsSnapshotV1 {
  assertExactKeys(input, [
    "contractVersion", "scope", "computedAt", "window", "capacity", "throughput", "queue", "idle", "wait", "recovery",
  ], "Room observability metrics input");
  if (input.contractVersion !== ROOM_OBSERVABILITY_METRICS_CONTRACT_VERSION) {
    throw new Error("Room observability metrics contract version is unsupported");
  }

  const scope = normalizeScope(input.scope, "Room observability scope");
  const computedAtMs = parseCanonicalTimestamp(input.computedAt, "Room metrics computedAt");
  const window = normalizeWindow(input.window, computedAtMs);
  const missingTelemetry: RoomObservabilityMissingTelemetryV1[] = [];

  const capacity = normalizeCapacity(input.capacity, scope, computedAtMs, missingTelemetry);
  const throughput = normalizeThroughput(input.throughput, scope, computedAtMs, window.durationMs, missingTelemetry);
  const queue = normalizeQueue(input.queue, scope, computedAtMs, missingTelemetry);
  const idleReasons = normalizeReasons(input.idle, "idle_reasons", scope, computedAtMs, missingTelemetry);
  const waitReasons = normalizeReasons(input.wait, "wait_reasons", scope, computedAtMs, missingTelemetry);
  const recovery = normalizeRecovery(input.recovery, scope, computedAtMs, missingTelemetry);

  const utilizationRatio = ratio(capacity.activeSlots.value, capacity.eligibleSlots.value);
  const idleSlots = subtractKnown(capacity.eligibleSlots.value, capacity.activeSlots.value, "idle slots");
  const idle = deriveIdle(idleSlots, idleReasons);
  const saturation = deriveSaturation(utilizationRatio);

  return freeze({
    contractVersion: ROOM_OBSERVABILITY_METRICS_CONTRACT_VERSION,
    scope,
    computedAt: input.computedAt,
    window,
    capacity,
    throughput,
    queue,
    utilization: freeze({ basis: "instantaneous_active_slots" as const, ratio: utilizationRatio }),
    idle,
    wait: freeze({
      observedAt: waitReasons.observedAt,
      reasonTelemetryState: waitReasons.state,
      reasons: waitReasons.reasons,
      waitingTasksObserved: waitReasons.total,
    }),
    saturation,
    recovery,
    missingTelemetry: freeze([...new Set(missingTelemetry)].sort(compareText)),
  });
}

function normalizeCapacity(
  telemetry: RoomCapacityTelemetryV1 | null,
  scope: RoomObservabilityScopeV1,
  computedAtMs: number,
  missing: RoomObservabilityMissingTelemetryV1[],
): RoomObservabilityMetricsSnapshotV1["capacity"] {
  if (telemetry === null) {
    missing.push("capacity");
    return freeze({
      observedAt: null,
      configuredSlots: unknownCount(),
      eligibleSlots: unknownCount(),
      activeSlots: unknownCount(),
      reservedVerifierSlots: unknownCount(),
      reservedRecoverySlots: unknownCount(),
      degradedSlots: unknownCount(),
      blockedSlots: unknownCount(),
      retryingSlots: unknownCount(),
    });
  }
  assertExactKeys(telemetry, [
    "scope", "observedAt", "configuredSlots", "eligibleSlots", "activeSlots", "reservedVerifierSlots",
    "reservedRecoverySlots", "degradedSlots", "blockedSlots", "retryingSlots",
  ], "capacity telemetry");
  assertTelemetryScope(telemetry.scope, scope, "capacity telemetry");
  assertTelemetryTimestamp(telemetry.observedAt, computedAtMs, "capacity telemetry observedAt");
  const configuredSlots = normalizeNullableCount(telemetry.configuredSlots, "capacity.configured_slots", missing);
  const eligibleSlots = normalizeNullableCount(telemetry.eligibleSlots, "capacity.eligible_slots", missing);
  const activeSlots = normalizeNullableCount(telemetry.activeSlots, "capacity.active_slots", missing);
  const reservedVerifierSlots = normalizeNullableCount(telemetry.reservedVerifierSlots, "capacity.reserved_verifier_slots", missing);
  const reservedRecoverySlots = normalizeNullableCount(telemetry.reservedRecoverySlots, "capacity.reserved_recovery_slots", missing);
  const degradedSlots = normalizeNullableCount(telemetry.degradedSlots, "capacity.degraded_slots", missing);
  const blockedSlots = normalizeNullableCount(telemetry.blockedSlots, "capacity.blocked_slots", missing);
  const retryingSlots = normalizeNullableCount(telemetry.retryingSlots, "capacity.retrying_slots", missing);

  assertAtMost(eligibleSlots.value, configuredSlots.value, "eligible capacity");
  assertAtMost(activeSlots.value, eligibleSlots.value, "active capacity");
  if (
    configuredSlots.value !== null
    && reservedVerifierSlots.value !== null
    && reservedRecoverySlots.value !== null
    && reservedVerifierSlots.value + reservedRecoverySlots.value > configuredSlots.value
  ) {
    throw new Error("Reserved verifier and recovery capacity exceeds configured capacity");
  }

  return freeze({
    observedAt: telemetry.observedAt,
    configuredSlots,
    eligibleSlots,
    activeSlots,
    reservedVerifierSlots,
    reservedRecoverySlots,
    degradedSlots,
    blockedSlots,
    retryingSlots,
  });
}

function normalizeThroughput(
  telemetry: RoomThroughputTelemetryV1 | null,
  scope: RoomObservabilityScopeV1,
  computedAtMs: number,
  durationMs: number,
  missing: RoomObservabilityMissingTelemetryV1[],
): RoomObservabilityMetricsSnapshotV1["throughput"] {
  if (telemetry === null) {
    missing.push("throughput");
    return freeze({
      observedAt: null,
      completedTasks: unknownCount(),
      committedEvents: unknownCount(),
      completedTasksPerSecond: ratio(null, durationMs / 1000),
      committedEventsPerSecond: ratio(null, durationMs / 1000),
    });
  }
  assertExactKeys(telemetry, ["scope", "observedAt", "completedTasks", "committedEvents"], "throughput telemetry");
  assertTelemetryScope(telemetry.scope, scope, "throughput telemetry");
  assertTelemetryTimestamp(telemetry.observedAt, computedAtMs, "throughput telemetry observedAt");
  const completedTasks = normalizeNullableCount(telemetry.completedTasks, "throughput.completed_tasks", missing);
  const committedEvents = normalizeNullableCount(telemetry.committedEvents, "throughput.committed_events", missing);
  return freeze({
    observedAt: telemetry.observedAt,
    completedTasks,
    committedEvents,
    completedTasksPerSecond: ratio(completedTasks.value, durationMs / 1000),
    committedEventsPerSecond: ratio(committedEvents.value, durationMs / 1000),
  });
}

function normalizeQueue(
  telemetry: RoomQueueTelemetryV1 | null,
  scope: RoomObservabilityScopeV1,
  computedAtMs: number,
  missing: RoomObservabilityMissingTelemetryV1[],
): RoomObservabilityMetricsSnapshotV1["queue"] {
  if (telemetry === null) {
    missing.push("queue");
    return freeze({
      observedAt: null,
      readyTasks: unknownCount(),
      queuedTasks: unknownCount(),
      blockedTasks: unknownCount(),
      retryingTasks: unknownCount(),
    });
  }
  assertExactKeys(telemetry, ["scope", "observedAt", "readyTasks", "queuedTasks", "blockedTasks", "retryingTasks"], "queue telemetry");
  assertTelemetryScope(telemetry.scope, scope, "queue telemetry");
  assertTelemetryTimestamp(telemetry.observedAt, computedAtMs, "queue telemetry observedAt");
  return freeze({
    observedAt: telemetry.observedAt,
    readyTasks: normalizeNullableCount(telemetry.readyTasks, "queue.ready_tasks", missing),
    queuedTasks: normalizeNullableCount(telemetry.queuedTasks, "queue.queued_tasks", missing),
    blockedTasks: normalizeNullableCount(telemetry.blockedTasks, "queue.blocked_tasks", missing),
    retryingTasks: normalizeNullableCount(telemetry.retryingTasks, "queue.retrying_tasks", missing),
  });
}

function normalizeReasons(
  telemetry: RoomReasonTelemetryV1 | null,
  missingKey: "idle_reasons" | "wait_reasons",
  scope: RoomObservabilityScopeV1,
  computedAtMs: number,
  missing: RoomObservabilityMissingTelemetryV1[],
): {
  readonly observedAt: string | null;
  readonly state: RoomMetricKnownnessV1;
  readonly reasons: readonly RoomMetricReasonCountV1[];
  readonly total: RoomMetricCountSnapshotV1;
} {
  if (telemetry === null) {
    missing.push(missingKey);
    return freeze({ observedAt: null, state: "unknown" as const, reasons: freeze([]), total: unknownCount() });
  }
  assertExactKeys(telemetry, ["scope", "observedAt", "reasons"], `${missingKey} telemetry`);
  assertTelemetryScope(telemetry.scope, scope, `${missingKey} telemetry`);
  assertTelemetryTimestamp(telemetry.observedAt, computedAtMs, `${missingKey} telemetry observedAt`);
  if (!Array.isArray(telemetry.reasons)) throw new Error(`${missingKey} reasons must be an array`);
  const seen = new Set<RoomMetricReasonV1>();
  const reasons = telemetry.reasons.map((reason) => {
    assertExactKeys(reason, ["reason", "count"], `${missingKey} reason`);
    if (!ROOM_METRIC_REASONS.includes(reason.reason)) {
      throw new Error(`${missingKey} reason ${String(reason.reason)} is unsupported`);
    }
    if (seen.has(reason.reason)) throw new Error(`${missingKey} reasons must not contain duplicate ${reason.reason}`);
    seen.add(reason.reason);
    assertNonNegativeSafeInteger(reason.count, `${missingKey} reason count`);
    return freeze({ reason: reason.reason, count: reason.count });
  }).sort((left, right) => compareText(left.reason, right.reason));
  const total = reasons.reduce((current, reason) => current + reason.count, 0);
  return freeze({
    observedAt: telemetry.observedAt,
    state: "known" as const,
    reasons: freeze(reasons),
    total: knownCount(total),
  });
}

function normalizeRecovery(
  telemetry: RoomRecoveryTelemetryV1 | null,
  scope: RoomObservabilityScopeV1,
  computedAtMs: number,
  missing: RoomObservabilityMissingTelemetryV1[],
): RoomObservabilityMetricsSnapshotV1["recovery"] {
  if (telemetry === null) {
    missing.push("recovery");
    return freeze({
      observedAt: null,
      attempted: unknownCount(),
      succeeded: unknownCount(),
      failed: unknownCount(),
      inFlight: unknownCount(),
    });
  }
  assertExactKeys(telemetry, ["scope", "observedAt", "attempted", "succeeded", "failed", "inFlight"], "recovery telemetry");
  assertTelemetryScope(telemetry.scope, scope, "recovery telemetry");
  assertTelemetryTimestamp(telemetry.observedAt, computedAtMs, "recovery telemetry observedAt");
  const attempted = normalizeNullableCount(telemetry.attempted, "recovery.attempted", missing);
  const succeeded = normalizeNullableCount(telemetry.succeeded, "recovery.succeeded", missing);
  const failed = normalizeNullableCount(telemetry.failed, "recovery.failed", missing);
  const inFlight = normalizeNullableCount(telemetry.inFlight, "recovery.in_flight", missing);
  if (
    attempted.value !== null
    && succeeded.value !== null
    && failed.value !== null
    && inFlight.value !== null
    && succeeded.value + failed.value + inFlight.value > attempted.value
  ) {
    throw new Error("Recovery outcome counts exceed observed recovery attempts");
  }
  return freeze({ observedAt: telemetry.observedAt, attempted, succeeded, failed, inFlight });
}

function deriveIdle(
  idleSlots: RoomMetricCountSnapshotV1,
  reasons: {
    readonly observedAt: string | null;
    readonly state: RoomMetricKnownnessV1;
    readonly reasons: readonly RoomMetricReasonCountV1[];
    readonly total: RoomMetricCountSnapshotV1;
  },
): RoomObservabilityMetricsSnapshotV1["idle"] {
  if (idleSlots.value !== null && reasons.total.value !== null && reasons.total.value > idleSlots.value) {
    throw new Error("Idle reason attribution exceeds observed idle capacity");
  }
  const unattributedSlots = idleSlots.value !== null && reasons.total.value !== null
    ? knownCount(idleSlots.value - reasons.total.value)
    : unknownCount();
  return freeze({
    observedAt: reasons.observedAt,
    slots: idleSlots,
    reasonTelemetryState: reasons.state,
    reasons: reasons.reasons,
    attributedSlots: reasons.total,
    unattributedSlots,
  });
}

function deriveSaturation(
  saturationRatio: RoomMetricRatioSnapshotV1,
): RoomObservabilityMetricsSnapshotV1["saturation"] {
  const classification: RoomSaturationClassificationV1 = saturationRatio.state === "known"
    ? saturationRatio.value === 1 ? "saturated" : "available"
    : saturationRatio.state === "not_applicable" ? "not_applicable" : "unknown";
  return freeze({ classification, ratio: saturationRatio });
}

function normalizeNullableCount(
  value: number | null,
  missingKey: RoomObservabilityMissingTelemetryV1,
  missing: RoomObservabilityMissingTelemetryV1[],
): RoomMetricCountSnapshotV1 {
  if (value === null) {
    missing.push(missingKey);
    return unknownCount();
  }
  assertNonNegativeSafeInteger(value, missingKey);
  return knownCount(value);
}

function ratio(numerator: number | null, denominator: number | null): RoomMetricRatioSnapshotV1 {
  if (denominator === 0) {
    return freeze({ state: "not_applicable" as const, numerator, denominator, value: null });
  }
  if (numerator === null || denominator === null) {
    return freeze({ state: "unknown" as const, numerator, denominator, value: null });
  }
  return freeze({ state: "known" as const, numerator, denominator, value: numerator / denominator });
}

function subtractKnown(
  minuend: number | null,
  subtrahend: number | null,
  label: string,
): RoomMetricCountSnapshotV1 {
  if (minuend === null || subtrahend === null) return unknownCount();
  if (subtrahend > minuend) throw new Error(`${label} cannot be negative`);
  return knownCount(minuend - subtrahend);
}

function knownCount(value: number): RoomMetricCountSnapshotV1 {
  return freeze({ state: "known" as const, value });
}

function unknownCount(): RoomMetricCountSnapshotV1 {
  return freeze({ state: "unknown" as const, value: null });
}

function normalizeScope(value: RoomObservabilityScopeV1, label: string): RoomObservabilityScopeV1 {
  assertExactKeys(value, ["projectId", "roomId"], label);
  assertCanonicalIdentifier(value.projectId, `${label} project id`);
  assertCanonicalIdentifier(value.roomId, `${label} Room id`);
  return freeze({ projectId: value.projectId, roomId: value.roomId });
}

function normalizeWindow(value: RoomMetricWindowInputV1, computedAtMs: number): RoomObservabilityMetricsSnapshotV1["window"] {
  assertExactKeys(value, ["startedAt", "endedAt"], "Room metrics window");
  const startedAtMs = parseCanonicalTimestamp(value.startedAt, "Room metrics window startedAt");
  const endedAtMs = parseCanonicalTimestamp(value.endedAt, "Room metrics window endedAt");
  if (endedAtMs <= startedAtMs) throw new Error("Room metrics window must have a positive duration");
  if (endedAtMs > computedAtMs) throw new Error("Room metrics window cannot end after computation");
  return freeze({ startedAt: value.startedAt, endedAt: value.endedAt, durationMs: endedAtMs - startedAtMs });
}

function assertTelemetryScope(
  telemetryScope: RoomObservabilityScopeV1,
  expectedScope: RoomObservabilityScopeV1,
  label: string,
): void {
  const scope = normalizeScope(telemetryScope, `${label} scope`);
  if (scope.projectId !== expectedScope.projectId || scope.roomId !== expectedScope.roomId) {
    throw new Error(`${label} is outside the requested project/Room scope`);
  }
}

function assertTelemetryTimestamp(value: string, computedAtMs: number, label: string): void {
  if (parseCanonicalTimestamp(value, label) > computedAtMs) {
    throw new Error(`${label} cannot be after Room metrics computation`);
  }
}

function assertAtMost(value: number | null, limit: number | null, label: string): void {
  if (value !== null && limit !== null && value > limit) {
    throw new Error(`${label} exceeds its known capacity limit`);
  }
}

function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function assertCanonicalIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    throw new Error(`${label} must be a canonical identifier`);
  }
}

function parseCanonicalTimestamp(value: unknown, label: string): number {
  if (typeof value !== "string") throw new Error(`${label} must be a canonical ISO timestamp`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return parsed;
}

function assertExactKeys(value: unknown, expected: readonly string[], label: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort(compareText);
  const canonicalExpected = [...expected].sort(compareText);
  if (actual.length !== canonicalExpected.length || actual.some((key, index) => key !== canonicalExpected[index])) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}

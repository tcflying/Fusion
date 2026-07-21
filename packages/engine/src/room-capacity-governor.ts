import {
  ROOM_ADAPTIVE_SCHEDULING_POLICY_CONTRACT_VERSION,
  scheduleRoomAdaptiveWork,
  type RoomAdaptiveSchedulingInputV1,
} from "@fusion/core";

export const ROOM_CAPACITY_GOVERNOR_CONTRACT_VERSION = 1 as const;

const MAX_TELEMETRY_TTL_MS = 300_000;

export type RoomCapacityGovernorConnectorStateV1 =
  | "healthy"
  | "degraded"
  | "rate_limited"
  | "authentication_required"
  | "host_unavailable"
  | "unavailable";

export type RoomCapacityGovernorQuotaStateV1 =
  | "clear"
  | "limited"
  | "exhausted"
  | "unknown";

export type RoomCapacityGovernorActionV1 =
  | "start"
  | "hold"
  | "pause"
  | "decrease";

export type RoomCapacityGovernorReasonCode =
  | "capability_registry_stale"
  | "capability_registry_unavailable"
  | "capacity_available"
  | "connector_degraded"
  | "connector_unavailable"
  | "core_policy_rejected"
  | "error_rate_overload"
  | "hard_concurrency_cap_exceeded"
  | "hard_concurrency_cap_reached"
  | "hard_concurrency_cap_reserved_capacity_conflict"
  | "latency_overload"
  | "no_queued_work"
  | "quota_exhausted"
  | "quota_limited"
  | "quota_unknown"
  | "reserved_capacity_held"
  | "stale_telemetry"
  | "telemetry_contradiction"
  | "telemetry_invalid";

export type RoomCapacityGovernorIssueCode =
  | "capability_registry_invalid"
  | "capability_registry_stale"
  | "capability_registry_unavailable"
  | "invalid_input"
  | "invalid_timestamp"
  | "stale_telemetry"
  | "telemetry_contradiction"
  | "core_policy_rejected";

export interface RoomCapacityGovernorIssueV1 {
  readonly code: RoomCapacityGovernorIssueCode;
  readonly path: string;
  readonly message: string;
}

export interface RoomCapacityGovernorQueueSnapshotV1 {
  readonly source: "controller_observation";
  readonly queuedWorkCount: number;
}

export interface RoomCapacityGovernorRunningSnapshotV1 {
  readonly source: "controller_observation";
  readonly activeWorkCount: number;
  readonly activeSlots: number;
}

export interface RoomCapacityGovernorFailureSnapshotV1 {
  readonly source: "controller_observation";
  readonly attemptCount: number;
  readonly failureCount: number;
}

export interface RoomCapacityGovernorLatencySnapshotV1 {
  readonly source: "controller_observation";
  readonly sampleCount: number;
  readonly p95Ms: number;
}

export interface RoomCapacityGovernorQuotaSnapshotV1 {
  readonly source: "session_connector_observation";
  readonly state: RoomCapacityGovernorQuotaStateV1;
  readonly hardConcurrencyLimit: number;
  readonly retryAfterMs: number | null;
}

export interface RoomCapacityGovernorConnectorSnapshotV1 {
  readonly source: "session_connector_observation";
  readonly state: RoomCapacityGovernorConnectorStateV1;
}

export interface RoomCapacityGovernorTelemetryV1 {
  readonly sampledAt: string;
  readonly queue: RoomCapacityGovernorQueueSnapshotV1;
  readonly running: RoomCapacityGovernorRunningSnapshotV1;
  readonly failures: RoomCapacityGovernorFailureSnapshotV1;
  readonly latency: RoomCapacityGovernorLatencySnapshotV1;
  readonly quota: RoomCapacityGovernorQuotaSnapshotV1;
  readonly connector: RoomCapacityGovernorConnectorSnapshotV1;
}

/**
 * Identity-only proof carried alongside an admission snapshot. The dispatcher
 * resolves it against the durable Room ledger before any task claim; the
 * governor additionally rejects missing, future, or expired proof so a caller
 * cannot replace a live capability report with a provider-label default.
 */
export interface RoomCapacityGovernorCapabilityRegistryProofV1 {
  readonly source: "durable_room_ledger";
  readonly registryId: string;
  readonly revision: number;
  readonly integrityHash: string;
  readonly observedAt: string;
  readonly expiresAt: string;
}

export interface RoomCapacityGovernorPolicyV1 {
  readonly telemetryTtlMs: number;
  readonly maximumFailureRate: number;
  readonly maximumP95LatencyMs: number;
  readonly decreaseStepSlots: number;
}

export interface RoomCapacityGovernorInputV1 {
  readonly contractVersion: typeof ROOM_CAPACITY_GOVERNOR_CONTRACT_VERSION;
  readonly asOf: string;
  readonly policy: RoomCapacityGovernorPolicyV1;
  readonly scheduling: RoomAdaptiveSchedulingInputV1;
  readonly telemetry: RoomCapacityGovernorTelemetryV1;
  /*
   * FNXC:SessionRoomCapacityAdmission 2026-07-19-22:05:
   * OpenSpec 6.1-6.6 requires quality and capacity decisions to consume the
   * current durable capability report for concrete bindings. The later
   * dispatcher comparison binds this proof to the immutable Room ledger; this
   * pure governor still fails closed before it can score a reportless input.
   */
  readonly capabilityRegistry: RoomCapacityGovernorCapabilityRegistryProofV1;
}

export interface RoomCapacityGovernorTelemetryWindowV1 {
  readonly sampledAt: string | null;
  readonly ttlMs: number;
  readonly expiresAt: string | null;
  readonly state: "fresh" | "stale" | "invalid";
}

export interface RoomCapacityGovernorAdmissionV1 {
  readonly concurrencyLimit: number;
  readonly currentActiveSlots: number;
  readonly newlyAdmittedSlots: number;
  readonly scheduledWorkIds: readonly string[];
  readonly preemptedWorkIds: readonly string[];
}

export interface RoomCapacityGovernorRecommendationV1 {
  readonly action: RoomCapacityGovernorActionV1;
  readonly targetConcurrentSlots: number;
}

export interface RoomCapacityGovernorSaturationV1 {
  readonly state: "idle" | "available" | "saturated" | "withheld";
  readonly ratio: number | null;
}

/**
 * A decision-local metric surface. It deliberately reports unknown as null
 * instead of converting an unavailable report into a zero-capacity reading.
 */
export interface RoomCapacityGovernorCapacityMetricsV1 {
  readonly configuredSlots: number | null;
  readonly effectiveSlots: number | null;
  readonly activeSlots: number | null;
  readonly queuedWorkCount: number | null;
  readonly reservedVerifierSlots: number | null;
  readonly reservedRecoverySlots: number | null;
  readonly availableSlots: number | null;
  readonly newlyAdmittedSlots: number;
  readonly saturation: RoomCapacityGovernorSaturationV1;
  readonly waitReasonCodes: readonly RoomCapacityGovernorReasonCode[];
  readonly idleReasonCodes: readonly RoomCapacityGovernorReasonCode[];
}

export interface RoomCapacityGovernorDecisionV1 {
  readonly contractVersion: typeof ROOM_CAPACITY_GOVERNOR_CONTRACT_VERSION;
  readonly schedulerContractVersion:
    | typeof ROOM_ADAPTIVE_SCHEDULING_POLICY_CONTRACT_VERSION
    | null;
  readonly asOf: string | null;
  readonly telemetry: RoomCapacityGovernorTelemetryWindowV1;
  readonly admission: RoomCapacityGovernorAdmissionV1;
  readonly recommendation: RoomCapacityGovernorRecommendationV1;
  readonly metrics: RoomCapacityGovernorCapacityMetricsV1;
  readonly reasonCodes: readonly RoomCapacityGovernorReasonCode[];
  readonly issues: readonly RoomCapacityGovernorIssueV1[];
}

interface NormalizedPolicyV1 {
  readonly telemetryTtlMs: number;
  readonly maximumFailureRate: number;
  readonly maximumP95LatencyMs: number;
  readonly decreaseStepSlots: number;
}

interface NormalizedTelemetryV1 {
  readonly sampledAt: string;
  readonly sampledAtMs: number;
  readonly queueCount: number;
  readonly activeWorkCount: number;
  readonly activeSlots: number;
  readonly attemptCount: number;
  readonly failureCount: number;
  readonly p95LatencyMs: number;
  readonly quotaState: RoomCapacityGovernorQuotaStateV1;
  readonly hardConcurrencyLimit: number;
  readonly connectorState: RoomCapacityGovernorConnectorStateV1;
}

interface NormalizedCapabilityRegistryProofV1
  extends RoomCapacityGovernorCapabilityRegistryProofV1 {}

const CONNECTOR_STATES = new Set<RoomCapacityGovernorConnectorStateV1>([
  "healthy",
  "degraded",
  "rate_limited",
  "authentication_required",
  "host_unavailable",
  "unavailable",
]);
const QUOTA_STATES = new Set<RoomCapacityGovernorQuotaStateV1>([
  "clear",
  "limited",
  "exhausted",
  "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isCanonicalString(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.trim() === value
  );
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isUnitInterval(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function normalizeCapabilityRegistryProof(
  value: unknown,
  asOf: string
):
  | { readonly value: NormalizedCapabilityRegistryProofV1 }
  | { readonly issue: RoomCapacityGovernorIssueV1 } {
  if (!isRecord(value)) {
    return {
      issue: issue(
        "capability_registry_unavailable",
        "$.capabilityRegistry",
        "Capacity admission requires a durable Room capability-registry proof"
      ),
    };
  }
  if (
    value.source !== "durable_room_ledger" ||
    !isCanonicalString(value.registryId) ||
    !isNonNegativeSafeInteger(value.revision) ||
    !isCanonicalString(value.integrityHash) ||
    !isCanonicalTimestamp(value.observedAt) ||
    !isCanonicalTimestamp(value.expiresAt)
  ) {
    return {
      issue: issue(
        "capability_registry_invalid",
        "$.capabilityRegistry",
        "Capability-registry proof must identify one durable, integrity-bound registry revision"
      ),
    };
  }
  const observedAtMs = Date.parse(value.observedAt);
  const expiresAtMs = Date.parse(value.expiresAt);
  const asOfMs = Date.parse(asOf);
  if (
    observedAtMs > asOfMs ||
    expiresAtMs < asOfMs ||
    expiresAtMs < observedAtMs
  ) {
    return {
      issue: issue(
        "capability_registry_stale",
        "$.capabilityRegistry",
        "Capability-registry proof must cover the governor decision time"
      ),
    };
  }
  return {
    value: {
      source: "durable_room_ledger",
      registryId: value.registryId,
      revision: value.revision,
      integrityHash: value.integrityHash,
      observedAt: value.observedAt,
      expiresAt: value.expiresAt,
    },
  };
}

function issue(
  code: RoomCapacityGovernorIssueCode,
  path: string,
  message: string
): RoomCapacityGovernorIssueV1 {
  return { code, path, message };
}

function sortIssues(
  issues: readonly RoomCapacityGovernorIssueV1[]
): readonly RoomCapacityGovernorIssueV1[] {
  return [...issues].sort((left, right) => {
    const code = left.code.localeCompare(right.code);
    return code !== 0 ? code : left.path.localeCompare(right.path);
  });
}

function sortReasons(
  reasons: readonly RoomCapacityGovernorReasonCode[]
): readonly RoomCapacityGovernorReasonCode[] {
  return [...new Set(reasons)].sort((left, right) => left.localeCompare(right));
}

function expiresAt(
  sampledAt: string | null,
  telemetryTtlMs: number
): string | null {
  if (
    sampledAt === null ||
    !Number.isSafeInteger(telemetryTtlMs) ||
    telemetryTtlMs <= 0
  )
    return null;
  const sampledAtMs = Date.parse(sampledAt);
  return Number.isFinite(sampledAtMs)
    ? new Date(sampledAtMs + telemetryTtlMs).toISOString()
    : null;
}

function telemetryWindow(
  sampledAt: string | null,
  ttlMs: number,
  state: RoomCapacityGovernorTelemetryWindowV1["state"]
): RoomCapacityGovernorTelemetryWindowV1 {
  return { sampledAt, ttlMs, expiresAt: expiresAt(sampledAt, ttlMs), state };
}

function metricCount(value: unknown): number | null {
  return isNonNegativeSafeInteger(value) ? value : null;
}

function waitReasons(
  queuedWorkCount: number | null,
  newlyAdmittedSlots: number,
  reasons: readonly RoomCapacityGovernorReasonCode[]
): readonly RoomCapacityGovernorReasonCode[] {
  if (
    queuedWorkCount === null ||
    queuedWorkCount === 0 ||
    newlyAdmittedSlots > 0
  )
    return [];
  return sortReasons(
    reasons.filter(
      (reason) => reason !== "capacity_available" && reason !== "no_queued_work"
    )
  );
}

function capacityMetrics(input: {
  readonly configuredSlots: unknown;
  readonly effectiveSlots: unknown;
  readonly activeSlots: unknown;
  readonly queuedWorkCount: unknown;
  readonly reservedVerifierSlots: unknown;
  readonly reservedRecoverySlots: unknown;
  readonly newlyAdmittedSlots: number;
  readonly reasons: readonly RoomCapacityGovernorReasonCode[];
  readonly withheld: boolean;
}): RoomCapacityGovernorCapacityMetricsV1 {
  const configuredSlots = metricCount(input.configuredSlots);
  const effectiveSlots = metricCount(input.effectiveSlots);
  const activeSlots = metricCount(input.activeSlots);
  const queuedWorkCount = metricCount(input.queuedWorkCount);
  const reservedVerifierSlots = metricCount(input.reservedVerifierSlots);
  const reservedRecoverySlots = metricCount(input.reservedRecoverySlots);
  const availableSlots =
    effectiveSlots !== null && activeSlots !== null
      ? Math.max(0, effectiveSlots - activeSlots)
      : null;
  const ratio =
    effectiveSlots !== null && effectiveSlots > 0 && activeSlots !== null
      ? activeSlots / effectiveSlots
      : null;
  const reasons = sortReasons(input.reasons);
  const waits = waitReasons(queuedWorkCount, input.newlyAdmittedSlots, reasons);
  const idleReasons =
    activeSlots === 0
      ? queuedWorkCount === 0
        ? ["no_queued_work" as const]
        : waits
      : [];
  const state: RoomCapacityGovernorSaturationV1["state"] = input.withheld
    ? "withheld"
    : activeSlots === 0 && queuedWorkCount === 0
    ? "idle"
    : effectiveSlots !== null &&
      activeSlots !== null &&
      activeSlots >= effectiveSlots
    ? "saturated"
    : "available";
  return {
    configuredSlots,
    effectiveSlots,
    activeSlots,
    queuedWorkCount,
    reservedVerifierSlots,
    reservedRecoverySlots,
    availableSlots,
    newlyAdmittedSlots: input.newlyAdmittedSlots,
    saturation: { state, ratio },
    waitReasonCodes: waits,
    idleReasonCodes: sortReasons(idleReasons),
  };
}

function conservativeDecision(input: {
  readonly asOf: string | null;
  readonly sampledAt: string | null;
  readonly telemetryTtlMs: number;
  readonly telemetryState: RoomCapacityGovernorTelemetryWindowV1["state"];
  readonly reasons: readonly RoomCapacityGovernorReasonCode[];
  readonly issues: readonly RoomCapacityGovernorIssueV1[];
}): RoomCapacityGovernorDecisionV1 {
  return {
    contractVersion: ROOM_CAPACITY_GOVERNOR_CONTRACT_VERSION,
    schedulerContractVersion: null,
    asOf: input.asOf,
    telemetry: telemetryWindow(
      input.sampledAt,
      input.telemetryTtlMs,
      input.telemetryState
    ),
    admission: {
      concurrencyLimit: 0,
      currentActiveSlots: 0,
      newlyAdmittedSlots: 0,
      scheduledWorkIds: [],
      preemptedWorkIds: [],
    },
    recommendation: { action: "pause", targetConcurrentSlots: 0 },
    metrics: capacityMetrics({
      configuredSlots: null,
      effectiveSlots: null,
      activeSlots: null,
      queuedWorkCount: null,
      reservedVerifierSlots: null,
      reservedRecoverySlots: null,
      newlyAdmittedSlots: 0,
      reasons: input.reasons,
      withheld: true,
    }),
    reasonCodes: sortReasons(input.reasons),
    issues: sortIssues(input.issues),
  };
}

function normalizePolicy(
  value: unknown,
  issues: RoomCapacityGovernorIssueV1[]
): NormalizedPolicyV1 | null {
  if (!isRecord(value)) {
    issues.push(
      issue(
        "invalid_input",
        "$.policy",
        "Governor policy must be an inspectable object"
      )
    );
    return null;
  }
  if (
    !isPositiveSafeInteger(value.telemetryTtlMs) ||
    value.telemetryTtlMs > MAX_TELEMETRY_TTL_MS
  ) {
    issues.push(
      issue(
        "invalid_input",
        "$.policy.telemetryTtlMs",
        "Telemetry TTL must be a positive bounded safe integer"
      )
    );
  }
  if (!isUnitInterval(value.maximumFailureRate)) {
    issues.push(
      issue(
        "invalid_input",
        "$.policy.maximumFailureRate",
        "Maximum failure rate must be finite and in [0, 1]"
      )
    );
  }
  if (!isPositiveSafeInteger(value.maximumP95LatencyMs)) {
    issues.push(
      issue(
        "invalid_input",
        "$.policy.maximumP95LatencyMs",
        "Maximum p95 latency must be a positive safe integer"
      )
    );
  }
  if (!isPositiveSafeInteger(value.decreaseStepSlots)) {
    issues.push(
      issue(
        "invalid_input",
        "$.policy.decreaseStepSlots",
        "Decrease step must be a positive safe integer"
      )
    );
  }
  if (issues.some((entry) => entry.path.startsWith("$.policy"))) return null;
  return {
    telemetryTtlMs: value.telemetryTtlMs as number,
    maximumFailureRate: value.maximumFailureRate as number,
    maximumP95LatencyMs: value.maximumP95LatencyMs as number,
    decreaseStepSlots: value.decreaseStepSlots as number,
  };
}

function requireSource(
  value: Record<string, unknown>,
  expected: string,
  path: string,
  issues: RoomCapacityGovernorIssueV1[]
): void {
  if (value.source !== expected) {
    issues.push(
      issue(
        "invalid_input",
        path + ".source",
        "Snapshot source is not certified for this field"
      )
    );
  }
}

function normalizeTelemetry(
  value: unknown,
  issues: RoomCapacityGovernorIssueV1[]
): NormalizedTelemetryV1 | null {
  if (!isRecord(value)) {
    issues.push(
      issue(
        "invalid_input",
        "$.telemetry",
        "Telemetry must be an inspectable snapshot"
      )
    );
    return null;
  }
  if (!isCanonicalTimestamp(value.sampledAt)) {
    issues.push(
      issue(
        "invalid_timestamp",
        "$.telemetry.sampledAt",
        "Telemetry sample time must be canonical UTC"
      )
    );
  }
  const queue = isRecord(value.queue) ? value.queue : null;
  const running = isRecord(value.running) ? value.running : null;
  const failures = isRecord(value.failures) ? value.failures : null;
  const latency = isRecord(value.latency) ? value.latency : null;
  const quota = isRecord(value.quota) ? value.quota : null;
  const connector = isRecord(value.connector) ? value.connector : null;
  for (const [path, snapshot] of [
    ["$.telemetry.queue", queue],
    ["$.telemetry.running", running],
    ["$.telemetry.failures", failures],
    ["$.telemetry.latency", latency],
    ["$.telemetry.quota", quota],
    ["$.telemetry.connector", connector],
  ] as const) {
    if (snapshot === null)
      issues.push(
        issue(
          "invalid_input",
          path,
          "Telemetry field must be an inspectable object"
        )
      );
  }
  if (
    !queue ||
    !running ||
    !failures ||
    !latency ||
    !quota ||
    !connector ||
    !isCanonicalTimestamp(value.sampledAt)
  ) {
    return null;
  }

  requireSource(queue, "controller_observation", "$.telemetry.queue", issues);
  requireSource(
    running,
    "controller_observation",
    "$.telemetry.running",
    issues
  );
  requireSource(
    failures,
    "controller_observation",
    "$.telemetry.failures",
    issues
  );
  requireSource(
    latency,
    "controller_observation",
    "$.telemetry.latency",
    issues
  );
  requireSource(
    quota,
    "session_connector_observation",
    "$.telemetry.quota",
    issues
  );
  requireSource(
    connector,
    "session_connector_observation",
    "$.telemetry.connector",
    issues
  );

  for (const [path, field] of [
    ["$.telemetry.queue.queuedWorkCount", queue.queuedWorkCount],
    ["$.telemetry.running.activeWorkCount", running.activeWorkCount],
    ["$.telemetry.running.activeSlots", running.activeSlots],
    ["$.telemetry.failures.failureCount", failures.failureCount],
  ] as const) {
    if (!isNonNegativeSafeInteger(field)) {
      issues.push(
        issue(
          "invalid_input",
          path,
          "Counter must be a non-negative safe integer"
        )
      );
    }
  }
  if (!isPositiveSafeInteger(failures.attemptCount)) {
    issues.push(
      issue(
        "invalid_input",
        "$.telemetry.failures.attemptCount",
        "Failure telemetry requires at least one observed attempt"
      )
    );
  }
  if (!isPositiveSafeInteger(latency.sampleCount)) {
    issues.push(
      issue(
        "invalid_input",
        "$.telemetry.latency.sampleCount",
        "Latency telemetry requires at least one observed sample"
      )
    );
  }
  if (
    typeof latency.p95Ms !== "number" ||
    !Number.isFinite(latency.p95Ms) ||
    latency.p95Ms < 0
  ) {
    issues.push(
      issue(
        "invalid_input",
        "$.telemetry.latency.p95Ms",
        "Latency p95 must be a finite non-negative number"
      )
    );
  }
  if (!isPositiveSafeInteger(quota.hardConcurrencyLimit)) {
    issues.push(
      issue(
        "invalid_input",
        "$.telemetry.quota.hardConcurrencyLimit",
        "A known positive hard concurrency limit is required before admission can increase"
      )
    );
  }
  if (!QUOTA_STATES.has(quota.state as RoomCapacityGovernorQuotaStateV1)) {
    issues.push(
      issue(
        "invalid_input",
        "$.telemetry.quota.state",
        "Quota state is unsupported"
      )
    );
  }
  if (
    !CONNECTOR_STATES.has(
      connector.state as RoomCapacityGovernorConnectorStateV1
    )
  ) {
    issues.push(
      issue(
        "invalid_input",
        "$.telemetry.connector.state",
        "Connector state is unsupported"
      )
    );
  }
  if (quota.state === "limited" || quota.state === "exhausted") {
    if (!isPositiveSafeInteger(quota.retryAfterMs)) {
      issues.push(
        issue(
          "invalid_input",
          "$.telemetry.quota.retryAfterMs",
          "Limited or exhausted quota requires a positive retry-after"
        )
      );
    }
  } else if (quota.retryAfterMs !== null) {
    issues.push(
      issue(
        "invalid_input",
        "$.telemetry.quota.retryAfterMs",
        "Only limited or exhausted quota may carry a retry-after"
      )
    );
  }
  if (
    isNonNegativeSafeInteger(failures.failureCount) &&
    isPositiveSafeInteger(failures.attemptCount) &&
    failures.failureCount > failures.attemptCount
  ) {
    issues.push(
      issue(
        "telemetry_contradiction",
        "$.telemetry.failures",
        "Failure count cannot exceed observed attempts"
      )
    );
  }
  if (
    connector.state === "healthy" &&
    (quota.state === "limited" || quota.state === "exhausted")
  ) {
    issues.push(
      issue(
        "telemetry_contradiction",
        "$.telemetry",
        "Healthy connector state cannot conflict with non-clear quota state"
      )
    );
  }
  if (connector.state === "rate_limited" && quota.state === "clear") {
    issues.push(
      issue(
        "telemetry_contradiction",
        "$.telemetry",
        "Rate-limited connector state cannot conflict with clear quota state"
      )
    );
  }
  if (issues.some((entry) => entry.path.startsWith("$.telemetry"))) return null;
  return {
    sampledAt: value.sampledAt,
    sampledAtMs: Date.parse(value.sampledAt),
    queueCount: queue.queuedWorkCount as number,
    activeWorkCount: running.activeWorkCount as number,
    activeSlots: running.activeSlots as number,
    attemptCount: failures.attemptCount as number,
    failureCount: failures.failureCount as number,
    p95LatencyMs: latency.p95Ms as number,
    quotaState: quota.state as RoomCapacityGovernorQuotaStateV1,
    hardConcurrencyLimit: quota.hardConcurrencyLimit as number,
    connectorState: connector.state as RoomCapacityGovernorConnectorStateV1,
  };
}

function hasSchedulingShape(
  value: unknown
): value is RoomAdaptiveSchedulingInputV1 {
  return (
    isRecord(value) &&
    isRecord(value.capacity) &&
    isRecord(value.policy) &&
    Array.isArray(value.queued) &&
    Array.isArray(value.active)
  );
}

function activeSlotsFromScheduling(
  input: RoomAdaptiveSchedulingInputV1
): number | null {
  let total = 0;
  for (const active of input.active) {
    if (!isRecord(active) || !isPositiveSafeInteger(active.requiredSlots))
      return null;
    total += active.requiredSlots;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function slotsForScheduledWork(
  input: RoomAdaptiveSchedulingInputV1,
  scheduledWorkIds: readonly string[]
): number {
  const queued = new Map(
    input.queued.map((work) => [work.workId, work.requiredSlots])
  );
  return scheduledWorkIds.reduce(
    (total, workId) => total + (queued.get(workId) ?? 0),
    0
  );
}

function restrictiveDecision(input: {
  readonly asOf: string;
  readonly policy: NormalizedPolicyV1;
  readonly telemetry: NormalizedTelemetryV1;
  readonly configuredSlots: number;
  readonly effectiveSlots: number;
  readonly reservedVerifierSlots: number;
  readonly reservedRecoverySlots: number;
  readonly concurrencyLimit: number;
  readonly action: RoomCapacityGovernorActionV1;
  readonly targetConcurrentSlots: number;
  readonly reasons: readonly RoomCapacityGovernorReasonCode[];
  readonly issues?: readonly RoomCapacityGovernorIssueV1[];
}): RoomCapacityGovernorDecisionV1 {
  return {
    contractVersion: ROOM_CAPACITY_GOVERNOR_CONTRACT_VERSION,
    schedulerContractVersion: null,
    asOf: input.asOf,
    telemetry: telemetryWindow(
      input.telemetry.sampledAt,
      input.policy.telemetryTtlMs,
      "fresh"
    ),
    admission: {
      concurrencyLimit: input.concurrencyLimit,
      currentActiveSlots: input.telemetry.activeSlots,
      newlyAdmittedSlots: 0,
      scheduledWorkIds: [],
      preemptedWorkIds: [],
    },
    recommendation: {
      action: input.action,
      targetConcurrentSlots: input.targetConcurrentSlots,
    },
    metrics: capacityMetrics({
      configuredSlots: input.configuredSlots,
      effectiveSlots: input.effectiveSlots,
      activeSlots: input.telemetry.activeSlots,
      queuedWorkCount: input.telemetry.queueCount,
      reservedVerifierSlots: input.reservedVerifierSlots,
      reservedRecoverySlots: input.reservedRecoverySlots,
      newlyAdmittedSlots: 0,
      reasons: input.reasons,
      withheld: true,
    }),
    reasonCodes: sortReasons(input.reasons),
    issues: sortIssues(input.issues ?? []),
  };
}

/**
 * FNXC:RoomCapacityGovernor 2026-07-18-12:30:
 * Task 6.3 needs a pure Engine admission boundary that keeps Core's
 * quality-first scheduling authority while refusing to increase dispatch from
 * stale, missing, contradictory, or over-cap telemetry. This module performs
 * no provider I/O and never fabricates provider capacity from failures or latency.
 */
export function governRoomCapacity(
  rawInput: RoomCapacityGovernorInputV1
): RoomCapacityGovernorDecisionV1 {
  const raw = rawInput as unknown;
  if (!isRecord(raw)) {
    return conservativeDecision({
      asOf: null,
      sampledAt: null,
      telemetryTtlMs: 0,
      telemetryState: "invalid",
      reasons: ["telemetry_invalid"],
      issues: [
        issue(
          "invalid_input",
          "$",
          "Governor input must be an inspectable object"
        ),
      ],
    });
  }

  const issues: RoomCapacityGovernorIssueV1[] = [];
  const asOf = isCanonicalTimestamp(raw.asOf) ? raw.asOf : null;
  const sampledAt =
    isRecord(raw.telemetry) && isCanonicalTimestamp(raw.telemetry.sampledAt)
      ? raw.telemetry.sampledAt
      : null;
  const provisionalTtlMs =
    isRecord(raw.policy) && isPositiveSafeInteger(raw.policy.telemetryTtlMs)
      ? raw.policy.telemetryTtlMs
      : 0;
  if (raw.contractVersion !== ROOM_CAPACITY_GOVERNOR_CONTRACT_VERSION) {
    issues.push(
      issue(
        "invalid_input",
        "$.contractVersion",
        "Only governor contract version 1 is supported"
      )
    );
  }
  if (asOf === null) {
    issues.push(
      issue(
        "invalid_timestamp",
        "$.asOf",
        "Decision time must be canonical UTC"
      )
    );
  }
  const policy = normalizePolicy(raw.policy, issues);
  const telemetry = normalizeTelemetry(raw.telemetry, issues);
  if (!hasSchedulingShape(raw.scheduling)) {
    issues.push(
      issue(
        "invalid_input",
        "$.scheduling",
        "Core scheduling input must contain capacity, policy, queue, and active arrays"
      )
    );
  }
  if (
    issues.length > 0 ||
    asOf === null ||
    policy === null ||
    telemetry === null ||
    !hasSchedulingShape(raw.scheduling)
  ) {
    const hasContradiction = issues.some(
      (entry) => entry.code === "telemetry_contradiction"
    );
    return conservativeDecision({
      asOf,
      sampledAt,
      telemetryTtlMs: provisionalTtlMs,
      telemetryState: "invalid",
      reasons: hasContradiction
        ? ["telemetry_contradiction", "telemetry_invalid"]
        : ["telemetry_invalid"],
      issues,
    });
  }

  const capabilityProof = normalizeCapabilityRegistryProof(
    raw.capabilityRegistry,
    asOf
  );
  if ("issue" in capabilityProof) {
    return conservativeDecision({
      asOf,
      sampledAt: telemetry.sampledAt,
      telemetryTtlMs: policy.telemetryTtlMs,
      telemetryState: "invalid",
      reasons: [
        capabilityProof.issue.code === "capability_registry_stale"
          ? "capability_registry_stale"
          : "capability_registry_unavailable",
      ],
      issues: [capabilityProof.issue],
    });
  }

  const scheduling = raw.scheduling;
  if (scheduling.asOf !== asOf) {
    return conservativeDecision({
      asOf,
      sampledAt: telemetry.sampledAt,
      telemetryTtlMs: policy.telemetryTtlMs,
      telemetryState: "invalid",
      reasons: ["telemetry_contradiction"],
      issues: [
        issue(
          "telemetry_contradiction",
          "$.scheduling.asOf",
          "Scheduling and telemetry must use the same decision time"
        ),
      ],
    });
  }

  const asOfMs = Date.parse(asOf);
  if (
    telemetry.sampledAtMs > asOfMs ||
    asOfMs - telemetry.sampledAtMs > policy.telemetryTtlMs
  ) {
    return conservativeDecision({
      asOf,
      sampledAt: telemetry.sampledAt,
      telemetryTtlMs: policy.telemetryTtlMs,
      telemetryState: "stale",
      reasons: ["stale_telemetry"],
      issues: [
        issue(
          "stale_telemetry",
          "$.telemetry.sampledAt",
          "Telemetry must be fresh at the decision time"
        ),
      ],
    });
  }

  const activeSlots = activeSlotsFromScheduling(scheduling);
  if (
    telemetry.queueCount !== scheduling.queued.length ||
    telemetry.activeWorkCount !== scheduling.active.length ||
    activeSlots === null ||
    telemetry.activeSlots !== activeSlots
  ) {
    return conservativeDecision({
      asOf,
      sampledAt: telemetry.sampledAt,
      telemetryTtlMs: policy.telemetryTtlMs,
      telemetryState: "invalid",
      reasons: ["telemetry_contradiction"],
      issues: [
        issue(
          "telemetry_contradiction",
          "$.telemetry",
          "Queue, active-work, and active-slot telemetry must match the scheduling snapshot"
        ),
      ],
    });
  }

  if (!isPositiveSafeInteger(scheduling.capacity.totalSlots)) {
    return conservativeDecision({
      asOf,
      sampledAt: telemetry.sampledAt,
      telemetryTtlMs: policy.telemetryTtlMs,
      telemetryState: "invalid",
      reasons: ["core_policy_rejected"],
      issues: [
        issue(
          "core_policy_rejected",
          "$.scheduling.capacity.totalSlots",
          "Core capacity must be a positive safe integer"
        ),
      ],
    });
  }
  const configuredCapacity = scheduling.capacity.totalSlots;
  const effectiveCapacity = Math.min(
    configuredCapacity,
    telemetry.hardConcurrencyLimit
  );

  if (telemetry.activeSlots > telemetry.hardConcurrencyLimit) {
    return restrictiveDecision({
      asOf,
      policy,
      telemetry,
      configuredSlots: configuredCapacity,
      effectiveSlots: effectiveCapacity,
      reservedVerifierSlots: scheduling.capacity.reservedVerifierSlots,
      reservedRecoverySlots: scheduling.capacity.reservedRecoverySlots,
      concurrencyLimit: telemetry.hardConcurrencyLimit,
      action: "decrease",
      targetConcurrentSlots: telemetry.hardConcurrencyLimit,
      reasons: ["hard_concurrency_cap_exceeded"],
    });
  }

  if (
    telemetry.quotaState === "limited" ||
    telemetry.quotaState === "exhausted" ||
    telemetry.quotaState === "unknown"
  ) {
    const reason: RoomCapacityGovernorReasonCode =
      telemetry.quotaState === "limited"
        ? "quota_limited"
        : telemetry.quotaState === "exhausted"
        ? "quota_exhausted"
        : "quota_unknown";
    return restrictiveDecision({
      asOf,
      policy,
      telemetry,
      configuredSlots: configuredCapacity,
      effectiveSlots: effectiveCapacity,
      reservedVerifierSlots: scheduling.capacity.reservedVerifierSlots,
      reservedRecoverySlots: scheduling.capacity.reservedRecoverySlots,
      concurrencyLimit: 0,
      action: "pause",
      targetConcurrentSlots: 0,
      reasons: [reason],
    });
  }

  if (telemetry.connectorState !== "healthy") {
    if (telemetry.connectorState === "degraded") {
      const target = Math.max(
        0,
        telemetry.activeSlots - policy.decreaseStepSlots
      );
      return restrictiveDecision({
        asOf,
        policy,
        telemetry,
        configuredSlots: configuredCapacity,
        effectiveSlots: effectiveCapacity,
        reservedVerifierSlots: scheduling.capacity.reservedVerifierSlots,
        reservedRecoverySlots: scheduling.capacity.reservedRecoverySlots,
        concurrencyLimit: target,
        action: target < telemetry.activeSlots ? "decrease" : "pause",
        targetConcurrentSlots: target,
        reasons: ["connector_degraded"],
      });
    }
    return restrictiveDecision({
      asOf,
      policy,
      telemetry,
      configuredSlots: configuredCapacity,
      effectiveSlots: effectiveCapacity,
      reservedVerifierSlots: scheduling.capacity.reservedVerifierSlots,
      reservedRecoverySlots: scheduling.capacity.reservedRecoverySlots,
      concurrencyLimit: 0,
      action: "pause",
      targetConcurrentSlots: 0,
      reasons: ["connector_unavailable"],
    });
  }

  const errorRate = telemetry.failureCount / telemetry.attemptCount;
  const overloadReasons: RoomCapacityGovernorReasonCode[] = [];
  if (errorRate > policy.maximumFailureRate)
    overloadReasons.push("error_rate_overload");
  if (telemetry.p95LatencyMs > policy.maximumP95LatencyMs)
    overloadReasons.push("latency_overload");
  if (overloadReasons.length > 0) {
    const target = Math.max(
      0,
      Math.min(
        effectiveCapacity,
        telemetry.activeSlots - policy.decreaseStepSlots
      )
    );
    return restrictiveDecision({
      asOf,
      policy,
      telemetry,
      configuredSlots: configuredCapacity,
      effectiveSlots: effectiveCapacity,
      reservedVerifierSlots: scheduling.capacity.reservedVerifierSlots,
      reservedRecoverySlots: scheduling.capacity.reservedRecoverySlots,
      concurrencyLimit: target,
      action: target < telemetry.activeSlots ? "decrease" : "pause",
      targetConcurrentSlots: target,
      reasons: overloadReasons,
    });
  }

  const reservedVerifierSlots = scheduling.capacity.reservedVerifierSlots;
  const reservedRecoverySlots = scheduling.capacity.reservedRecoverySlots;
  if (
    !isNonNegativeSafeInteger(reservedVerifierSlots) ||
    !isNonNegativeSafeInteger(reservedRecoverySlots) ||
    reservedVerifierSlots + reservedRecoverySlots > effectiveCapacity
  ) {
    return restrictiveDecision({
      asOf,
      policy,
      telemetry,
      configuredSlots: configuredCapacity,
      effectiveSlots: effectiveCapacity,
      reservedVerifierSlots,
      reservedRecoverySlots,
      concurrencyLimit: effectiveCapacity,
      action: "pause",
      targetConcurrentSlots: telemetry.activeSlots,
      reasons: ["hard_concurrency_cap_reserved_capacity_conflict"],
    });
  }

  const scheduled = scheduleRoomAdaptiveWork({
    ...scheduling,
    capacity: { ...scheduling.capacity, totalSlots: effectiveCapacity },
  });
  if (!scheduled.ok) {
    return conservativeDecision({
      asOf,
      sampledAt: telemetry.sampledAt,
      telemetryTtlMs: policy.telemetryTtlMs,
      telemetryState: "invalid",
      reasons: ["core_policy_rejected"],
      issues: scheduled.issues.map((entry) =>
        issue(
          "core_policy_rejected",
          "$.scheduling" + entry.path.slice(1),
          entry.message
        )
      ),
    });
  }

  const scheduledWorkIds = [...scheduled.value.scheduledWorkIds];
  const preemptedWorkIds = [...scheduled.value.preemptedWorkIds];
  const newlyAdmittedSlots = slotsForScheduledWork(
    scheduling,
    scheduledWorkIds
  );
  const reasons: RoomCapacityGovernorReasonCode[] = [];
  if (scheduledWorkIds.length > 0) reasons.push("capacity_available");
  if (scheduledWorkIds.length === 0 && scheduling.queued.length === 0)
    reasons.push("no_queued_work");
  if (
    scheduledWorkIds.length === 0 &&
    telemetry.activeSlots >= effectiveCapacity
  ) {
    reasons.push("hard_concurrency_cap_reached");
  }
  if (
    scheduledWorkIds.length === 0 &&
    scheduling.queued.length > 0 &&
    telemetry.activeSlots < effectiveCapacity
  ) {
    reasons.push("reserved_capacity_held");
  }
  if (reasons.length === 0) reasons.push("capacity_available");

  return {
    contractVersion: ROOM_CAPACITY_GOVERNOR_CONTRACT_VERSION,
    schedulerContractVersion: scheduled.value.contractVersion,
    asOf,
    telemetry: telemetryWindow(
      telemetry.sampledAt,
      policy.telemetryTtlMs,
      "fresh"
    ),
    admission: {
      concurrencyLimit: effectiveCapacity,
      currentActiveSlots: telemetry.activeSlots,
      newlyAdmittedSlots,
      scheduledWorkIds,
      preemptedWorkIds,
    },
    recommendation: {
      action: scheduledWorkIds.length > 0 ? "start" : "hold",
      targetConcurrentSlots: Math.min(
        effectiveCapacity,
        telemetry.activeSlots + newlyAdmittedSlots
      ),
    },
    metrics: capacityMetrics({
      configuredSlots: configuredCapacity,
      effectiveSlots: effectiveCapacity,
      activeSlots: telemetry.activeSlots,
      queuedWorkCount: telemetry.queueCount,
      reservedVerifierSlots,
      reservedRecoverySlots,
      newlyAdmittedSlots,
      reasons,
      withheld: false,
    }),
    reasonCodes: sortReasons(reasons),
    issues: [],
  };
}

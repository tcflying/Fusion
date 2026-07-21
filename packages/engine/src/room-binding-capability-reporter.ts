import {
  RoomCapabilityRegistry,
  SESSION_CONNECTOR_CAPABILITIES,
  type RoomBindingRecordV1,
  type SessionConnectorCapabilitiesV1,
  type SessionConnectorCapabilityName,
  type SessionConnectorCapabilityState,
  type SessionConnectorHealthV1,
  type SessionConnectorIdentityV1,
} from "@fusion/core";

export const ROOM_BINDING_CAPABILITY_REPORTER_CONTRACT_VERSION = 1 as const;

const CAPABILITY_STATES = new Set<SessionConnectorCapabilityState>([
  "verified",
  "degraded",
  "unavailable",
  "unverified",
]);
const CONNECTOR_HEALTH_STATES = new Set<SessionConnectorHealthV1["state"]>([
  "healthy",
  "degraded",
  "authentication_required",
  "rate_limited",
  "host_unavailable",
  "unavailable",
]);
const HOST_STATES = new Set<SessionConnectorHealthV1["host"]>([
  "reachable",
  "unavailable",
  "mismatch",
  "unknown",
]);
const RATE_LIMIT_STATES = new Set<SessionConnectorHealthV1["rateLimit"]>([
  "clear",
  "limited",
  "unknown",
]);
const ACTIVE_CONCRETE_BINDING_STATES = new Set<RoomBindingRecordV1["state"]>([
  "attached",
  "paused",
  "authentication_blocked",
  "host_unavailable",
  "delivery_uncertain",
]);
const QUALITY_EVIDENCE_KINDS = new Set([
  "deterministic_gate",
  "independent_review",
  "observed_outcome",
]);
const MAX_OBSERVATION_AGE_MS = 300_000;
const MAX_FUTURE_SKEW_MS = 60_000;

export type RoomBindingCapabilityReporterIssueCode =
  | "invalid_input"
  | "untrusted_claim"
  | "scope_mismatch"
  | "binding_mismatch"
  | "identity_mismatch"
  | "host_mismatch"
  | "model_claim_mismatch"
  | "connector_evidence_unavailable"
  | "connector_evidence_invalid"
  | "stale_observation"
  | "future_observation"
  | "expired_observation"
  | "core_snapshot_rejected";

export interface RoomBindingCapabilityReporterIssueV1 {
  readonly code: RoomBindingCapabilityReporterIssueCode;
  readonly path: string;
  readonly message: string;
}

export type RoomBindingCapabilityReporterResultV1<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly RoomBindingCapabilityReporterIssueV1[] };

export interface RoomBindingCapabilityReporterFreshnessV1 {
  readonly maxObservationAgeMs: number;
  readonly maxFutureSkewMs: number;
}

/**
 * This target is loaded from the Room binding and the connector-attached runtime
 * boundary. It is intentionally separate from a peer-produced observation.
 */
export interface TrustedRoomBindingCapabilityTargetV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly binding: RoomBindingRecordV1;
  readonly runtime: {
    readonly source: "trusted_session_connector_binding";
    readonly identity: SessionConnectorIdentityV1;
    readonly accountId: string;
    readonly modelId: string;
    readonly observedAt: string;
  };
}

export interface SessionConnectorNamedCapabilityObservationV1 {
  readonly source: "trusted_session_connector";
  readonly name: string;
  readonly state: SessionConnectorCapabilityState;
  readonly evidenceRef: string | null;
  readonly observedAt: string;
}

export interface SessionConnectorContextObservationV1 {
  readonly source: "trusted_session_connector";
  readonly contextVersion: string;
  readonly maximumTokens: number;
  readonly availableTokens: number;
  readonly observedAt: string;
}

export interface SessionConnectorWorkspaceAuthorityObservationV1 {
  readonly source: "trusted_session_connector";
  readonly workspaceId: string;
  readonly scopes: readonly string[];
  readonly state: SessionConnectorCapabilityState;
  readonly observedAt: string;
}

export interface SessionConnectorLatencyObservationV1 {
  readonly source: "trusted_session_connector";
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly sampleCount: number;
  readonly observedAt: string;
}

export interface TrustedRoomBindingDomainQualityObservationV1 {
  readonly source: "trusted_room_evidence";
  readonly domain: string;
  readonly selfReportedScore: null;
  readonly independentEvidence: readonly {
    readonly sourceId: string;
    readonly kind: "deterministic_gate" | "independent_review" | "observed_outcome";
    readonly score: number;
    readonly observedAt: string;
  }[];
}

export interface TrustedRoomBindingCalibrationObservationV1 {
  readonly source: "trusted_room_evidence";
  readonly domain: string;
  readonly outcomeCount: number;
  readonly meanAbsoluteError: number;
  readonly observedAt: string;
}

/**
 * Caller-provided observations are not a live provider integration. The caller
 * must acquire these values through an already trusted concrete connector path.
 */
export interface RoomBindingCapabilityObservationV1 {
  readonly source: "trusted_session_connector";
  readonly connectorEvidence: {
    readonly source: "trusted_session_connector";
    readonly availability: "available" | "unavailable";
    readonly observedAt: string;
  };
  readonly projectId: string;
  readonly roomId: string;
  readonly bindingId: string;
  readonly snapshotId: string;
  readonly revision: number;
  readonly capturedAt: string;
  readonly expiresAt: string;
  readonly identity: SessionConnectorIdentityV1;
  readonly capabilities: SessionConnectorCapabilitiesV1;
  readonly health: SessionConnectorHealthV1;
  readonly model: {
    readonly source: "trusted_session_connector";
    readonly providerId: string;
    readonly accountId: string;
    readonly modelId: string;
    readonly observedAt: string;
  };
  readonly tools: readonly SessionConnectorNamedCapabilityObservationV1[];
  readonly mcps: readonly SessionConnectorNamedCapabilityObservationV1[];
  readonly skills: readonly SessionConnectorNamedCapabilityObservationV1[];
  readonly context: SessionConnectorContextObservationV1;
  readonly workspaceAuthority: SessionConnectorWorkspaceAuthorityObservationV1;
  readonly latency: SessionConnectorLatencyObservationV1;
  readonly domainQuality: readonly TrustedRoomBindingDomainQualityObservationV1[];
  readonly calibration: readonly TrustedRoomBindingCalibrationObservationV1[];
}

export interface CreateRoomBindingCapabilityReportInputV1 {
  readonly contractVersion: typeof ROOM_BINDING_CAPABILITY_REPORTER_CONTRACT_VERSION;
  /** Caller-injected decision time. This adapter never reads a mutable clock. */
  readonly asOf: string;
  readonly freshness: RoomBindingCapabilityReporterFreshnessV1;
  readonly target: TrustedRoomBindingCapabilityTargetV1;
  readonly observation: RoomBindingCapabilityObservationV1;
}

export interface RoomBindingCapabilityReportV1 {
  readonly contractVersion: typeof ROOM_BINDING_CAPABILITY_REPORTER_CONTRACT_VERSION;
  /**
   * This explicitly means that a caller supplied a trusted observation. It does
   * not assert a live provider-report wiring or initiate any connector I/O.
   */
  readonly observationKind: "caller_provided_connector_observation";
  readonly projectId: string;
  readonly roomId: string;
  readonly bindingId: string;
  readonly identity: SessionConnectorIdentityV1;
  readonly accountId: string;
  readonly modelId: string;
  readonly snapshot: RoomCapabilityRegistry.RoomBindingCapabilitySnapshotV1;
  readonly connector: {
    readonly evidenceObservedAt: string;
    readonly capabilities: SessionConnectorCapabilitiesV1;
    readonly health: SessionConnectorHealthV1;
  };
  readonly tools: readonly SessionConnectorNamedCapabilityObservationV1[];
  readonly mcps: readonly SessionConnectorNamedCapabilityObservationV1[];
  readonly skills: readonly SessionConnectorNamedCapabilityObservationV1[];
  readonly workspaceAuthority: SessionConnectorWorkspaceAuthorityObservationV1;
}

interface NormalizedFreshnessV1 {
  readonly maxObservationAgeMs: number;
  readonly maxFutureSkewMs: number;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null) return value;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  Object.freeze(objectValue);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function issue(
  code: RoomBindingCapabilityReporterIssueCode,
  path: string,
  message: string,
): RoomBindingCapabilityReporterIssueV1 {
  return { code, path, message };
}

function fail<T>(
  issues: readonly RoomBindingCapabilityReporterIssueV1[],
): RoomBindingCapabilityReporterResultV1<T> {
  return deepFreeze({
    ok: false,
    issues: [...issues].sort((left, right) => {
      const code = left.code.localeCompare(right.code);
      return code !== 0 ? code : left.path.localeCompare(right.path);
    }),
  });
}

function succeed<T>(value: T): RoomBindingCapabilityReporterResultV1<T> {
  return deepFreeze({ ok: true, value: deepFreeze(value) });
}

function requireText(
  value: unknown,
  path: string,
  issues: RoomBindingCapabilityReporterIssueV1[],
): void {
  if (!isCanonicalText(value)) {
    issues.push(issue("invalid_input", path, "Value must be a canonical non-empty string"));
  }
}

function requireNullableText(
  value: unknown,
  path: string,
  issues: RoomBindingCapabilityReporterIssueV1[],
): void {
  if (value !== null && !isCanonicalText(value)) {
    issues.push(issue("invalid_input", path, "Value must be null or a canonical non-empty string"));
  }
}

function normalizeFreshness(
  value: unknown,
  issues: RoomBindingCapabilityReporterIssueV1[],
): NormalizedFreshnessV1 | null {
  if (!isRecord(value)) {
    issues.push(issue("invalid_input", "$.freshness", "Freshness policy must be an inspectable object"));
    return null;
  }
  if (
    !isPositiveSafeInteger(value.maxObservationAgeMs)
    || value.maxObservationAgeMs > MAX_OBSERVATION_AGE_MS
  ) {
    issues.push(issue(
      "invalid_input",
      "$.freshness.maxObservationAgeMs",
      "Observation freshness must be a positive bounded safe integer",
    ));
  }
  if (
    !isNonNegativeSafeInteger(value.maxFutureSkewMs)
    || value.maxFutureSkewMs > MAX_FUTURE_SKEW_MS
  ) {
    issues.push(issue(
      "invalid_input",
      "$.freshness.maxFutureSkewMs",
      "Future skew must be a bounded non-negative safe integer",
    ));
  }
  if (issues.some((entry) => entry.path.startsWith("$.freshness"))) return null;
  return {
    maxObservationAgeMs: value.maxObservationAgeMs as number,
    maxFutureSkewMs: value.maxFutureSkewMs as number,
  };
}

function validateObservationTime(
  value: unknown,
  path: string,
  asOfMs: number,
  freshness: NormalizedFreshnessV1,
  issues: RoomBindingCapabilityReporterIssueV1[],
  capturedAtMs?: number,
): void {
  if (!isCanonicalTimestamp(value)) {
    issues.push(issue("invalid_input", path, "Observation time must be canonical UTC"));
    return;
  }
  const observedAtMs = Date.parse(value);
  if (observedAtMs < asOfMs - freshness.maxObservationAgeMs) {
    issues.push(issue("stale_observation", path, "Observation is older than the fail-closed freshness window"));
  }
  if (observedAtMs > asOfMs + freshness.maxFutureSkewMs) {
    issues.push(issue("future_observation", path, "Observation is too far in the future"));
  }
  if (capturedAtMs !== undefined && observedAtMs > capturedAtMs) {
    issues.push(issue("future_observation", path, "Observation cannot occur after its capability capture time"));
  }
}

function validateIdentity(
  value: unknown,
  path: string,
  issues: RoomBindingCapabilityReporterIssueV1[],
): value is SessionConnectorIdentityV1 {
  if (!isRecord(value)) {
    issues.push(issue("invalid_input", path, "Session identity must be an inspectable object"));
    return false;
  }
  for (const field of ["connectorId", "providerId", "nativeSessionId", "hostId"] as const) {
    requireText(value[field], path + "." + field, issues);
  }
  for (const field of ["happierSessionId", "serverProfileId", "machineId"] as const) {
    requireNullableText(value[field], path + "." + field, issues);
  }
  return true;
}

function sameIdentity(
  left: SessionConnectorIdentityV1,
  right: SessionConnectorIdentityV1,
): boolean {
  return left.connectorId === right.connectorId
    && left.providerId === right.providerId
    && left.nativeSessionId === right.nativeSessionId
    && left.happierSessionId === right.happierSessionId
    && left.serverProfileId === right.serverProfileId
    && left.machineId === right.machineId
    && left.hostId === right.hostId;
}

function validateBinding(
  binding: RoomBindingRecordV1,
  path: string,
  issues: RoomBindingCapabilityReporterIssueV1[],
): void {
  if (binding.contractVersion !== 1) {
    issues.push(issue("invalid_input", path + ".contractVersion", "Only Room binding contract version 1 is supported"));
  }
  for (const field of [
    "id",
    "roomId",
    "seatId",
    "connectorId",
    "providerId",
    "nativeSessionId",
    "hostId",
  ] as const) {
    requireText(binding[field], path + "." + field, issues);
  }
  for (const field of ["happierSessionId", "serverProfileId", "machineId"] as const) {
    requireNullableText(binding[field], path + "." + field, issues);
  }
  if (!isPositiveSafeInteger(binding.generation)) {
    issues.push(issue("invalid_input", path + ".generation", "Binding generation must be a positive safe integer"));
  }
  if (!ACTIVE_CONCRETE_BINDING_STATES.has(binding.state)) {
    issues.push(issue(
      "binding_mismatch",
      path + ".state",
      "Only a current concrete Room binding may produce a capability report",
    ));
  }
}

function validateConnectorCapabilities(
  capabilities: SessionConnectorCapabilitiesV1,
  expectedConnectorId: string,
  asOfMs: number,
  freshness: NormalizedFreshnessV1,
  capturedAtMs: number,
  issues: RoomBindingCapabilityReporterIssueV1[],
): void {
  if (!isRecord(capabilities)) {
    issues.push(issue("connector_evidence_invalid", "$.observation.capabilities", "Capability evidence must be an object"));
    return;
  }
  if (capabilities.contractVersion !== 1) {
    issues.push(issue(
      "connector_evidence_invalid",
      "$.observation.capabilities.contractVersion",
      "Only Session Connector contract version 1 is supported",
    ));
  }
  if (capabilities.connectorId !== expectedConnectorId) {
    issues.push(issue(
      "connector_evidence_invalid",
      "$.observation.capabilities.connectorId",
      "Capability evidence belongs to a different connector",
    ));
  }
  requireText(capabilities.connectorVersion, "$.observation.capabilities.connectorVersion", issues);
  requireText(capabilities.sourceRevision, "$.observation.capabilities.sourceRevision", issues);
  validateObservationTime(
    capabilities.verifiedAt,
    "$.observation.capabilities.verifiedAt",
    asOfMs,
    freshness,
    issues,
    capturedAtMs,
  );
  const matrix = capabilities.capabilities as unknown;
  if (!isRecord(matrix)) {
    issues.push(issue(
      "connector_evidence_invalid",
      "$.observation.capabilities.capabilities",
      "Capability matrix must be an object",
    ));
    return;
  }
  for (const name of SESSION_CONNECTOR_CAPABILITIES) {
    const entry = matrix[name];
    const path = "$.observation.capabilities.capabilities." + name;
    if (!isRecord(entry) || !CAPABILITY_STATES.has(entry.state as SessionConnectorCapabilityState)) {
      issues.push(issue("connector_evidence_invalid", path, "Capability certification state is invalid"));
      continue;
    }
    if (entry.state === "verified") {
      requireText(entry.evidenceRef, path + ".evidenceRef", issues);
      validateObservationTime(entry.lastVerifiedAt, path + ".lastVerifiedAt", asOfMs, freshness, issues, capturedAtMs);
    } else {
      if (!isCanonicalText(entry.reasonCode)) {
        issues.push(issue(
          "connector_evidence_invalid",
          path + ".reasonCode",
          "A non-verified capability must carry a typed reason",
        ));
      }
      if (entry.lastVerifiedAt !== null && !isCanonicalTimestamp(entry.lastVerifiedAt)) {
        issues.push(issue(
          "connector_evidence_invalid",
          path + ".lastVerifiedAt",
          "A capability verification time must be canonical UTC or null",
        ));
      }
    }
  }
}

function validateHealth(
  health: SessionConnectorHealthV1,
  expectedConnectorId: string,
  expectedHostId: string,
  asOfMs: number,
  freshness: NormalizedFreshnessV1,
  capturedAtMs: number,
  issues: RoomBindingCapabilityReporterIssueV1[],
): void {
  if (!isRecord(health)) {
    issues.push(issue("connector_evidence_invalid", "$.observation.health", "Connector health must be an object"));
    return;
  }
  if (health.connectorId !== expectedConnectorId) {
    issues.push(issue(
      "connector_evidence_invalid",
      "$.observation.health.connectorId",
      "Health evidence belongs to a different connector",
    ));
  }
  if (health.hostId !== expectedHostId) {
    issues.push(issue(
      "host_mismatch",
      "$.observation.health.hostId",
      "Health evidence belongs to a different host",
    ));
  }
  if (!CONNECTOR_HEALTH_STATES.has(health.state)) {
    issues.push(issue("connector_evidence_invalid", "$.observation.health.state", "Health state is invalid"));
  }
  if (!HOST_STATES.has(health.host)) {
    issues.push(issue("connector_evidence_invalid", "$.observation.health.host", "Host health state is invalid"));
  }
  if (!RATE_LIMIT_STATES.has(health.rateLimit)) {
    issues.push(issue("connector_evidence_invalid", "$.observation.health.rateLimit", "Rate-limit state is invalid"));
  }
  validateObservationTime(health.checkedAt, "$.observation.health.checkedAt", asOfMs, freshness, issues, capturedAtMs);
  if (
    health.retryAfterMs !== null
    && (!isPositiveSafeInteger(health.retryAfterMs) || health.retryAfterMs > 604_800_000)
  ) {
    issues.push(issue(
      "connector_evidence_invalid",
      "$.observation.health.retryAfterMs",
      "Retry-after must be null or a bounded positive safe integer",
    ));
  }
  if (health.rateLimit === "limited" && !isPositiveSafeInteger(health.retryAfterMs)) {
    issues.push(issue(
      "connector_evidence_invalid",
      "$.observation.health.retryAfterMs",
      "Limited health requires a positive retry-after",
    ));
  }
  if (health.rateLimit !== "limited" && health.retryAfterMs !== null) {
    issues.push(issue(
      "connector_evidence_invalid",
      "$.observation.health.retryAfterMs",
      "Only limited health may carry a retry-after",
    ));
  }
  if (health.state === "rate_limited" && health.rateLimit !== "limited") {
    issues.push(issue(
      "connector_evidence_invalid",
      "$.observation.health",
      "Rate-limited health requires a limited rate state",
    ));
  }
  if (health.state === "host_unavailable" && health.host !== "unavailable") {
    issues.push(issue(
      "connector_evidence_invalid",
      "$.observation.health",
      "Host-unavailable health requires an unavailable host state",
    ));
  }
  const capabilityStates = health.capabilities as unknown;
  if (!isRecord(capabilityStates)) {
    issues.push(issue(
      "connector_evidence_invalid",
      "$.observation.health.capabilities",
      "Health capability matrix must be an object",
    ));
    return;
  }
  for (const name of SESSION_CONNECTOR_CAPABILITIES) {
    if (!CAPABILITY_STATES.has(capabilityStates[name] as SessionConnectorCapabilityState)) {
      issues.push(issue(
        "connector_evidence_invalid",
        "$.observation.health.capabilities." + name,
        "Health capability state is invalid",
      ));
    }
  }
}

function validateNamedCapabilities(
  value: unknown,
  path: string,
  asOfMs: number,
  freshness: NormalizedFreshnessV1,
  capturedAtMs: number,
  issues: RoomBindingCapabilityReporterIssueV1[],
): readonly SessionConnectorNamedCapabilityObservationV1[] {
  if (!Array.isArray(value)) {
    issues.push(issue("invalid_input", path, "Named capabilities must be an array"));
    return [];
  }
  const names = new Set<string>();
  const entries: SessionConnectorNamedCapabilityObservationV1[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const entryPath = path + "[" + index + "]";
    if (!isRecord(entry)) {
      issues.push(issue("invalid_input", entryPath, "Named capability must be an object"));
      continue;
    }
    if (entry.source !== "trusted_session_connector") {
      issues.push(issue("untrusted_claim", entryPath + ".source", "Peer or model capability claims are not accepted"));
    }
    requireText(entry.name, entryPath + ".name", issues);
    if (!CAPABILITY_STATES.has(entry.state as SessionConnectorCapabilityState)) {
      issues.push(issue("invalid_input", entryPath + ".state", "Capability state is invalid"));
    }
    if (entry.state === "verified") requireText(entry.evidenceRef, entryPath + ".evidenceRef", issues);
    else requireNullableText(entry.evidenceRef, entryPath + ".evidenceRef", issues);
    validateObservationTime(entry.observedAt, entryPath + ".observedAt", asOfMs, freshness, issues, capturedAtMs);
    if (isCanonicalText(entry.name)) {
      if (names.has(entry.name)) {
        issues.push(issue("invalid_input", entryPath + ".name", "Capability names must be unique within their category"));
      }
      names.add(entry.name);
    }
    entries.push(entry as unknown as SessionConnectorNamedCapabilityObservationV1);
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

function validateContext(
  value: unknown,
  asOfMs: number,
  freshness: NormalizedFreshnessV1,
  capturedAtMs: number,
  issues: RoomBindingCapabilityReporterIssueV1[],
): value is SessionConnectorContextObservationV1 {
  const path = "$.observation.context";
  if (!isRecord(value)) {
    issues.push(issue("invalid_input", path, "Context observation must be an object"));
    return false;
  }
  if (value.source !== "trusted_session_connector") {
    issues.push(issue("untrusted_claim", path + ".source", "Peer or model context claims are not accepted"));
  }
  requireText(value.contextVersion, path + ".contextVersion", issues);
  if (!isPositiveSafeInteger(value.maximumTokens)) {
    issues.push(issue("invalid_input", path + ".maximumTokens", "Context maximum must be a positive safe integer"));
  }
  if (!isNonNegativeSafeInteger(value.availableTokens)) {
    issues.push(issue("invalid_input", path + ".availableTokens", "Available context must be a non-negative safe integer"));
  }
  if (
    isPositiveSafeInteger(value.maximumTokens)
    && isNonNegativeSafeInteger(value.availableTokens)
    && value.availableTokens > value.maximumTokens
  ) {
    issues.push(issue("invalid_input", path + ".availableTokens", "Available context cannot exceed its maximum"));
  }
  validateObservationTime(value.observedAt, path + ".observedAt", asOfMs, freshness, issues, capturedAtMs);
  return true;
}

function validateWorkspaceAuthority(
  value: unknown,
  asOfMs: number,
  freshness: NormalizedFreshnessV1,
  capturedAtMs: number,
  issues: RoomBindingCapabilityReporterIssueV1[],
): value is SessionConnectorWorkspaceAuthorityObservationV1 {
  const path = "$.observation.workspaceAuthority";
  if (!isRecord(value)) {
    issues.push(issue("invalid_input", path, "Workspace authority must be an object"));
    return false;
  }
  if (value.source !== "trusted_session_connector") {
    issues.push(issue("untrusted_claim", path + ".source", "Peer or model workspace claims are not accepted"));
  }
  requireText(value.workspaceId, path + ".workspaceId", issues);
  if (!CAPABILITY_STATES.has(value.state as SessionConnectorCapabilityState)) {
    issues.push(issue("invalid_input", path + ".state", "Workspace authority state is invalid"));
  }
  if (!Array.isArray(value.scopes) || !value.scopes.every(isCanonicalText)) {
    issues.push(issue("invalid_input", path + ".scopes", "Workspace scopes must be canonical strings"));
  } else if (new Set(value.scopes).size !== value.scopes.length) {
    issues.push(issue("invalid_input", path + ".scopes", "Workspace scopes must be unique"));
  }
  validateObservationTime(value.observedAt, path + ".observedAt", asOfMs, freshness, issues, capturedAtMs);
  return true;
}

function validateLatency(
  value: unknown,
  asOfMs: number,
  freshness: NormalizedFreshnessV1,
  capturedAtMs: number,
  issues: RoomBindingCapabilityReporterIssueV1[],
): value is SessionConnectorLatencyObservationV1 {
  const path = "$.observation.latency";
  if (!isRecord(value)) {
    issues.push(issue("invalid_input", path, "Latency observation must be an object"));
    return false;
  }
  if (value.source !== "trusted_session_connector") {
    issues.push(issue("untrusted_claim", path + ".source", "Peer or model latency claims are not accepted"));
  }
  if (typeof value.p50Ms !== "number" || !Number.isFinite(value.p50Ms) || value.p50Ms < 0) {
    issues.push(issue("invalid_input", path + ".p50Ms", "Latency p50 must be finite and non-negative"));
  }
  if (typeof value.p95Ms !== "number" || !Number.isFinite(value.p95Ms) || value.p95Ms < 0) {
    issues.push(issue("invalid_input", path + ".p95Ms", "Latency p95 must be finite and non-negative"));
  }
  if (
    typeof value.p50Ms === "number"
    && typeof value.p95Ms === "number"
    && value.p95Ms < value.p50Ms
  ) {
    issues.push(issue("invalid_input", path, "Latency p95 cannot be lower than p50"));
  }
  if (!isPositiveSafeInteger(value.sampleCount)) {
    issues.push(issue("invalid_input", path + ".sampleCount", "Latency sample count must be a positive safe integer"));
  }
  validateObservationTime(value.observedAt, path + ".observedAt", asOfMs, freshness, issues, capturedAtMs);
  return true;
}

function validateQuality(
  value: unknown,
  bindingId: string,
  asOfMs: number,
  freshness: NormalizedFreshnessV1,
  capturedAtMs: number,
  issues: RoomBindingCapabilityReporterIssueV1[],
): value is readonly TrustedRoomBindingDomainQualityObservationV1[] {
  const path = "$.observation.domainQuality";
  if (!Array.isArray(value)) {
    issues.push(issue("invalid_input", path, "Domain quality must be an array"));
    return false;
  }
  const domains = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const entryPath = path + "[" + index + "]";
    if (!isRecord(entry)) {
      issues.push(issue("invalid_input", entryPath, "Domain quality entry must be an object"));
      continue;
    }
    if (entry.source !== "trusted_room_evidence") {
      issues.push(issue("untrusted_claim", entryPath + ".source", "Quality must come from trusted independent evidence"));
    }
    requireText(entry.domain, entryPath + ".domain", issues);
    if (entry.selfReportedScore !== null) {
      issues.push(issue("untrusted_claim", entryPath + ".selfReportedScore", "Self-reported quality cannot enter a capability report"));
    }
    if (isCanonicalText(entry.domain)) {
      if (domains.has(entry.domain)) {
        issues.push(issue("invalid_input", entryPath + ".domain", "Each quality domain may appear once"));
      }
      domains.add(entry.domain);
    }
    if (!Array.isArray(entry.independentEvidence)) {
      issues.push(issue("invalid_input", entryPath + ".independentEvidence", "Independent quality evidence must be an array"));
      continue;
    }
    const sourceIds = new Set<string>();
    for (let evidenceIndex = 0; evidenceIndex < entry.independentEvidence.length; evidenceIndex += 1) {
      const evidence = entry.independentEvidence[evidenceIndex];
      const evidencePath = entryPath + ".independentEvidence[" + evidenceIndex + "]";
      if (!isRecord(evidence)) {
        issues.push(issue("invalid_input", evidencePath, "Independent quality evidence must be an object"));
        continue;
      }
      requireText(evidence.sourceId, evidencePath + ".sourceId", issues);
      if (!QUALITY_EVIDENCE_KINDS.has(evidence.kind as string)) {
        issues.push(issue("invalid_input", evidencePath + ".kind", "Quality evidence kind is invalid"));
      }
      if (!isUnitInterval(evidence.score)) {
        issues.push(issue("invalid_input", evidencePath + ".score", "Quality score must be in [0, 1]"));
      }
      validateObservationTime(evidence.observedAt, evidencePath + ".observedAt", asOfMs, freshness, issues, capturedAtMs);
      if (evidence.sourceId === bindingId) {
        issues.push(issue("untrusted_claim", evidencePath + ".sourceId", "A binding cannot independently score itself"));
      }
      if (isCanonicalText(evidence.sourceId)) {
        if (sourceIds.has(evidence.sourceId)) {
          issues.push(issue("invalid_input", evidencePath + ".sourceId", "Quality evidence source may appear once per domain"));
        }
        sourceIds.add(evidence.sourceId);
      }
    }
  }
  return true;
}

function validateCalibration(
  value: unknown,
  asOfMs: number,
  freshness: NormalizedFreshnessV1,
  capturedAtMs: number,
  issues: RoomBindingCapabilityReporterIssueV1[],
): value is readonly TrustedRoomBindingCalibrationObservationV1[] {
  const path = "$.observation.calibration";
  if (!Array.isArray(value)) {
    issues.push(issue("invalid_input", path, "Calibration must be an array"));
    return false;
  }
  const domains = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const entryPath = path + "[" + index + "]";
    if (!isRecord(entry)) {
      issues.push(issue("invalid_input", entryPath, "Calibration entry must be an object"));
      continue;
    }
    if (entry.source !== "trusted_room_evidence") {
      issues.push(issue("untrusted_claim", entryPath + ".source", "Calibration must come from trusted outcome evidence"));
    }
    requireText(entry.domain, entryPath + ".domain", issues);
    if (isCanonicalText(entry.domain)) {
      if (domains.has(entry.domain)) {
        issues.push(issue("invalid_input", entryPath + ".domain", "Each calibration domain may appear once"));
      }
      domains.add(entry.domain);
    }
    if (!isNonNegativeSafeInteger(entry.outcomeCount)) {
      issues.push(issue("invalid_input", entryPath + ".outcomeCount", "Calibration outcome count must be non-negative"));
    }
    if (
      typeof entry.meanAbsoluteError !== "number"
      || !Number.isFinite(entry.meanAbsoluteError)
      || entry.meanAbsoluteError < 0
      || entry.meanAbsoluteError > 1
    ) {
      issues.push(issue(
        "invalid_input",
        entryPath + ".meanAbsoluteError",
        "Calibration error must be a finite value in [0, 1]",
      ));
    }
    validateObservationTime(entry.observedAt, entryPath + ".observedAt", asOfMs, freshness, issues, capturedAtMs);
  }
  return true;
}

function capabilityStateFor(
  certification: SessionConnectorCapabilityState,
  health: SessionConnectorCapabilityState,
): SessionConnectorCapabilityState {
  const rank: Record<SessionConnectorCapabilityState, number> = {
    unavailable: 0,
    unverified: 1,
    degraded: 2,
    verified: 3,
  };
  return rank[certification] <= rank[health] ? certification : health;
}

function hostStateFor(
  health: SessionConnectorHealthV1,
): RoomCapabilityRegistry.RoomBindingHostHealthState {
  if (health.host === "reachable") return "healthy";
  if (health.host === "unavailable" || health.host === "mismatch") return "unavailable";
  return "degraded";
}

function connectorStateFor(
  health: SessionConnectorHealthV1,
  hostState: RoomCapabilityRegistry.RoomBindingHostHealthState,
): RoomCapabilityRegistry.RoomBindingConnectorHealthState {
  if (health.state !== "healthy") return health.state;
  if (hostState === "unavailable") return "host_unavailable";
  if (hostState === "degraded") return "degraded";
  return "healthy";
}

function snapshotTools(
  capabilities: SessionConnectorCapabilitiesV1,
  health: SessionConnectorHealthV1,
  tools: readonly SessionConnectorNamedCapabilityObservationV1[],
  mcps: readonly SessionConnectorNamedCapabilityObservationV1[],
  skills: readonly SessionConnectorNamedCapabilityObservationV1[],
  workspaceAuthority: SessionConnectorWorkspaceAuthorityObservationV1,
): readonly RoomCapabilityRegistry.RoomBindingToolCapabilityV1[] {
  const values: RoomCapabilityRegistry.RoomBindingToolCapabilityV1[] = [];
  for (const name of SESSION_CONNECTOR_CAPABILITIES) {
    values.push({
      name: "connector:" + name,
      state: capabilityStateFor(capabilities.capabilities[name].state, health.capabilities[name]),
    });
  }
  for (const [kind, entries] of [
    ["tool", tools],
    ["mcp", mcps],
    ["skill", skills],
  ] as const) {
    for (const entry of entries) values.push({ name: kind + ":" + entry.name, state: entry.state });
  }
  values.push({ name: "workspace:authority", state: workspaceAuthority.state });
  for (const scope of workspaceAuthority.scopes) {
    values.push({ name: "workspace-scope:" + scope, state: workspaceAuthority.state });
  }
  return values.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * FNXC:RoomBindingCapabilityReporter 2026-07-18-10:32:
 * Task 6.1 needs a pure Engine boundary that translates only caller-provided,
 * trusted concrete Session-connector observations into Core snapshots. It
 * rejects peer or model claims, stale data, unavailable evidence, and any
 * project, Room, binding, identity, host, provider, or model mismatch. This
 * module performs no provider call and must not be presented as live-report wiring.
 */
export function createRoomBindingCapabilityReport(
  rawInput: CreateRoomBindingCapabilityReportInputV1,
): RoomBindingCapabilityReporterResultV1<RoomBindingCapabilityReportV1> {
  const issues: RoomBindingCapabilityReporterIssueV1[] = [];
  if (!isRecord(rawInput)) {
    return fail([issue("invalid_input", "$", "Capability report input must be an inspectable object")]);
  }
  const input = rawInput as unknown as CreateRoomBindingCapabilityReportInputV1;
  if (input.contractVersion !== ROOM_BINDING_CAPABILITY_REPORTER_CONTRACT_VERSION) {
    issues.push(issue("invalid_input", "$.contractVersion", "Only reporter contract version 1 is supported"));
  }
  if (!isCanonicalTimestamp(input.asOf)) {
    issues.push(issue("invalid_input", "$.asOf", "Decision time must be canonical UTC"));
  }
  const freshness = normalizeFreshness(input.freshness, issues);
  if (!isRecord(input.target) || !isRecord(input.observation)) {
    issues.push(issue("invalid_input", "$.target", "Target and observation must be inspectable objects"));
    return fail(issues);
  }
  const target = input.target as TrustedRoomBindingCapabilityTargetV1;
  const observation = input.observation as RoomBindingCapabilityObservationV1;
  if (
    !isRecord(target.binding)
    || !isRecord(target.runtime)
    || !isRecord(target.runtime.identity)
    || !isRecord(observation.identity)
    || !isRecord(observation.connectorEvidence)
    || !isRecord(observation.model)
  ) {
    issues.push(issue("invalid_input", "$", "Binding, runtime, identity, evidence, and model must be inspectable objects"));
    return fail(issues);
  }
  if (!freshness || !isCanonicalTimestamp(input.asOf)) return fail(issues);

  const asOfMs = Date.parse(input.asOf);
  requireText(target.projectId, "$.target.projectId", issues);
  requireText(target.roomId, "$.target.roomId", issues);
  validateBinding(target.binding, "$.target.binding", issues);
  if (target.runtime.source !== "trusted_session_connector_binding") {
    issues.push(issue("untrusted_claim", "$.target.runtime.source", "Binding runtime must come from the trusted connector boundary"));
  }
  validateIdentity(target.runtime.identity, "$.target.runtime.identity", issues);
  requireText(target.runtime.accountId, "$.target.runtime.accountId", issues);
  requireText(target.runtime.modelId, "$.target.runtime.modelId", issues);
  validateObservationTime(target.runtime.observedAt, "$.target.runtime.observedAt", asOfMs, freshness, issues);

  if (observation.source !== "trusted_session_connector") {
    issues.push(issue("untrusted_claim", "$.observation.source", "Peer or model observations are not accepted"));
  }
  if (observation.connectorEvidence.source !== "trusted_session_connector") {
    issues.push(issue("untrusted_claim", "$.observation.connectorEvidence.source", "Connector evidence must be trusted connector evidence"));
  }
  if (observation.connectorEvidence.availability !== "available") {
    issues.push(issue(
      "connector_evidence_unavailable",
      "$.observation.connectorEvidence.availability",
      "Capability reports require available connector evidence",
    ));
  }
  validateObservationTime(
    observation.connectorEvidence.observedAt,
    "$.observation.connectorEvidence.observedAt",
    asOfMs,
    freshness,
    issues,
  );
  for (const field of ["projectId", "roomId", "bindingId", "snapshotId"] as const) {
    requireText(observation[field], "$.observation." + field, issues);
  }
  if (!isPositiveSafeInteger(observation.revision)) {
    issues.push(issue("invalid_input", "$.observation.revision", "Snapshot revision must be a positive safe integer"));
  }
  validateObservationTime(observation.capturedAt, "$.observation.capturedAt", asOfMs, freshness, issues);
  if (!isCanonicalTimestamp(observation.expiresAt)) {
    issues.push(issue("invalid_input", "$.observation.expiresAt", "Snapshot expiry must be canonical UTC"));
  }
  const capturedAtMs = isCanonicalTimestamp(observation.capturedAt)
    ? Date.parse(observation.capturedAt)
    : Number.NaN;
  const expiresAtMs = isCanonicalTimestamp(observation.expiresAt)
    ? Date.parse(observation.expiresAt)
    : Number.NaN;
  if (Number.isFinite(capturedAtMs) && Number.isFinite(expiresAtMs) && expiresAtMs < capturedAtMs) {
    issues.push(issue("invalid_input", "$.observation.expiresAt", "Snapshot expiry cannot precede capture"));
  }
  if (Number.isFinite(expiresAtMs) && asOfMs > expiresAtMs) {
    issues.push(issue("expired_observation", "$.observation.expiresAt", "Snapshot has expired before reporting"));
  }

  validateIdentity(observation.identity, "$.observation.identity", issues);
  if (target.binding.roomId !== target.roomId || observation.roomId !== target.roomId || observation.projectId !== target.projectId) {
    issues.push(issue("scope_mismatch", "$.observation", "Observation must remain in the target project and Room"));
  }
  if (observation.bindingId !== target.binding.id) {
    issues.push(issue("binding_mismatch", "$.observation.bindingId", "Observation belongs to a different Room binding"));
  }
  if (!sameIdentity(target.runtime.identity, observation.identity)) {
    issues.push(issue("identity_mismatch", "$.observation.identity", "Observation identity differs from the trusted connector binding"));
  }
  const bindingIdentity: SessionConnectorIdentityV1 = {
    connectorId: target.binding.connectorId,
    providerId: target.binding.providerId,
    nativeSessionId: target.binding.nativeSessionId,
    happierSessionId: target.binding.happierSessionId,
    serverProfileId: target.binding.serverProfileId,
    machineId: target.binding.machineId,
    hostId: target.binding.hostId,
  };
  if (!sameIdentity(bindingIdentity, target.runtime.identity)) {
    issues.push(issue("identity_mismatch", "$.target.runtime.identity", "Trusted runtime identity differs from the persisted Room binding"));
  }
  if (observation.identity.hostId !== target.binding.hostId) {
    issues.push(issue("host_mismatch", "$.observation.identity.hostId", "Observation host differs from the bound host"));
  }

  if (observation.model.source !== "trusted_session_connector") {
    issues.push(issue("untrusted_claim", "$.observation.model.source", "Peer or model identity claims are not accepted"));
  }
  for (const field of ["providerId", "accountId", "modelId"] as const) {
    requireText(observation.model[field], "$.observation.model." + field, issues);
  }
  validateObservationTime(observation.model.observedAt, "$.observation.model.observedAt", asOfMs, freshness, issues, capturedAtMs);
  if (
    observation.model.providerId !== target.binding.providerId
    || observation.model.providerId !== target.runtime.identity.providerId
    || observation.model.accountId !== target.runtime.accountId
    || observation.model.modelId !== target.runtime.modelId
  ) {
    issues.push(issue(
      "model_claim_mismatch",
      "$.observation.model",
      "Actual provider, account, and model must match the trusted concrete binding",
    ));
  }

  validateConnectorCapabilities(
    observation.capabilities,
    target.binding.connectorId,
    asOfMs,
    freshness,
    capturedAtMs,
    issues,
  );
  validateHealth(
    observation.health,
    target.binding.connectorId,
    target.binding.hostId,
    asOfMs,
    freshness,
    capturedAtMs,
    issues,
  );
  const tools = validateNamedCapabilities(
    observation.tools,
    "$.observation.tools",
    asOfMs,
    freshness,
    capturedAtMs,
    issues,
  );
  const mcps = validateNamedCapabilities(
    observation.mcps,
    "$.observation.mcps",
    asOfMs,
    freshness,
    capturedAtMs,
    issues,
  );
  const skills = validateNamedCapabilities(
    observation.skills,
    "$.observation.skills",
    asOfMs,
    freshness,
    capturedAtMs,
    issues,
  );
  const contextValid = validateContext(observation.context, asOfMs, freshness, capturedAtMs, issues);
  const workspaceAuthorityValid = validateWorkspaceAuthority(
    observation.workspaceAuthority,
    asOfMs,
    freshness,
    capturedAtMs,
    issues,
  );
  const latencyValid = validateLatency(observation.latency, asOfMs, freshness, capturedAtMs, issues);
  const qualityValid = validateQuality(
    observation.domainQuality,
    target.binding.id,
    asOfMs,
    freshness,
    capturedAtMs,
    issues,
  );
  const calibrationValid = validateCalibration(
    observation.calibration,
    asOfMs,
    freshness,
    capturedAtMs,
    issues,
  );
  if (
    issues.length > 0
    || !contextValid
    || !workspaceAuthorityValid
    || !latencyValid
    || !qualityValid
    || !calibrationValid
  ) {
    return fail(issues);
  }

  const hostState = hostStateFor(observation.health);
  const snapshot = RoomCapabilityRegistry.createRoomBindingCapabilitySnapshot({
    contractVersion: RoomCapabilityRegistry.ROOM_CAPABILITY_REGISTRY_CONTRACT_VERSION,
    snapshotId: observation.snapshotId,
    revision: observation.revision,
    lineage: {
      bindingId: target.binding.id,
      bindingGeneration: target.binding.generation,
      providerId: target.binding.providerId,
      accountId: target.runtime.accountId,
      modelId: target.runtime.modelId,
      connectorId: target.binding.connectorId,
      nativeSessionId: target.binding.nativeSessionId,
      hostId: target.binding.hostId,
    },
    freshness: {
      capturedAt: observation.capturedAt,
      expiresAt: observation.expiresAt,
      sourceRevision: observation.capabilities.sourceRevision,
    },
    tools: snapshotTools(
      observation.capabilities,
      observation.health,
      tools,
      mcps,
      skills,
      observation.workspaceAuthority,
    ),
    context: {
      contextVersion: observation.context.contextVersion,
      maximumTokens: observation.context.maximumTokens,
      availableTokens: observation.context.availableTokens,
      observedAt: observation.context.observedAt,
    },
    health: {
      connectorState: connectorStateFor(observation.health, hostState),
      hostState,
      observedAt: observation.health.checkedAt,
    },
    latency: {
      p50Ms: observation.latency.p50Ms,
      p95Ms: observation.latency.p95Ms,
      sampleCount: observation.latency.sampleCount,
      observedAt: observation.latency.observedAt,
    },
    rateLimit: {
      state: observation.health.rateLimit,
      retryAfterMs: observation.health.retryAfterMs,
      observedAt: observation.health.checkedAt,
    },
    domainQuality: observation.domainQuality.map((entry) => ({
      domain: entry.domain,
      selfReportedScore: null,
      independentEvidence: entry.independentEvidence.map((evidence) => ({
        sourceId: evidence.sourceId,
        kind: evidence.kind,
        score: evidence.score,
        observedAt: evidence.observedAt,
      })),
    })),
    calibration: observation.calibration.map((entry) => ({
      domain: entry.domain,
      outcomeCount: entry.outcomeCount,
      meanAbsoluteError: entry.meanAbsoluteError,
      observedAt: entry.observedAt,
    })),
  });
  if (!snapshot.ok) {
    return fail(snapshot.issues.map((entry) => issue(
      "core_snapshot_rejected",
      "$.snapshot" + entry.path.slice(1),
      entry.message,
    )));
  }

  return succeed({
    contractVersion: ROOM_BINDING_CAPABILITY_REPORTER_CONTRACT_VERSION,
    observationKind: "caller_provided_connector_observation",
    projectId: target.projectId,
    roomId: target.roomId,
    bindingId: target.binding.id,
    identity: structuredClone(observation.identity),
    accountId: target.runtime.accountId,
    modelId: target.runtime.modelId,
    snapshot: snapshot.value,
    connector: {
      evidenceObservedAt: observation.connectorEvidence.observedAt,
      capabilities: structuredClone(observation.capabilities),
      health: structuredClone(observation.health),
    },
    tools: structuredClone(tools),
    mcps: structuredClone(mcps),
    skills: structuredClone(skills),
    workspaceAuthority: structuredClone(observation.workspaceAuthority),
  });
}

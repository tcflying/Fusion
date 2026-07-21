import type { IsoTimestamp, RoomBindingId } from "./room-contracts/ids.js";
import { compareRoomText, hashRoomValue } from "./room-integrity.js";

export const ROOM_CAPABILITY_REGISTRY_CONTRACT_VERSION = 1 as const;

const TOOL_STATES = new Set(["verified", "degraded", "unavailable", "unverified"]);
const CONNECTOR_HEALTH_STATES = new Set([
  "healthy",
  "degraded",
  "authentication_required",
  "rate_limited",
  "host_unavailable",
  "unavailable",
]);
const HOST_HEALTH_STATES = new Set(["healthy", "degraded", "unavailable"]);
const RATE_LIMIT_STATES = new Set(["clear", "limited", "unknown"]);
const QUALITY_EVIDENCE_KINDS = new Set([
  "deterministic_gate",
  "independent_review",
  "observed_outcome",
]);

export type RoomBindingToolState = "verified" | "degraded" | "unavailable" | "unverified";
export type RoomBindingConnectorHealthState =
  | "healthy"
  | "degraded"
  | "authentication_required"
  | "rate_limited"
  | "host_unavailable"
  | "unavailable";
export type RoomBindingHostHealthState = "healthy" | "degraded" | "unavailable";
export type RoomBindingRateLimitState = "clear" | "limited" | "unknown";
export type RoomBindingQualityEvidenceKind =
  | "deterministic_gate"
  | "independent_review"
  | "observed_outcome";

/** Immutable identity of a concrete provider session binding. */
export interface RoomBindingCapabilityLineageV1 {
  readonly bindingId: RoomBindingId;
  readonly bindingGeneration: number;
  readonly providerId: string;
  readonly accountId: string;
  readonly modelId: string;
  readonly connectorId: string;
  readonly nativeSessionId: string;
  readonly hostId: string;
}

export interface RoomBindingToolCapabilityV1 {
  readonly name: string;
  readonly state: RoomBindingToolState;
}

export interface RoomBindingContextCapacityV1 {
  readonly contextVersion: string;
  readonly maximumTokens: number;
  readonly availableTokens: number;
  readonly observedAt: IsoTimestamp;
}

export interface RoomBindingHealthV1 {
  readonly connectorState: RoomBindingConnectorHealthState;
  readonly hostState: RoomBindingHostHealthState;
  readonly observedAt: IsoTimestamp;
}

export interface RoomBindingLatencyV1 {
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly sampleCount: number;
  readonly observedAt: IsoTimestamp;
}

export interface RoomBindingRateLimitV1 {
  readonly state: RoomBindingRateLimitState;
  readonly retryAfterMs: number | null;
  readonly observedAt: IsoTimestamp;
}

/**
 * The source must be independent of the binding being scored. A deterministic
 * gate can use its immutable gate identity as sourceId; a review must use the
 * other evaluator's binding identity.
 */
export interface RoomBindingIndependentQualityEvidenceV1 {
  readonly sourceId: string;
  readonly kind: RoomBindingQualityEvidenceKind;
  readonly score: number;
  readonly observedAt: IsoTimestamp;
}

export interface RoomBindingDomainQualityV1 {
  readonly domain: string;
  /** Retained for observability only; routing never reads this value. */
  readonly selfReportedScore: number | null;
  readonly independentEvidence: readonly RoomBindingIndependentQualityEvidenceV1[];
}

export interface RoomBindingDomainCalibrationV1 {
  readonly domain: string;
  readonly outcomeCount: number;
  readonly meanAbsoluteError: number;
  readonly observedAt: IsoTimestamp;
}

export interface RoomBindingSnapshotFreshnessV1 {
  readonly capturedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly sourceRevision: string;
}

export interface RoomBindingCapabilitySnapshotDraftV1 {
  readonly contractVersion: typeof ROOM_CAPABILITY_REGISTRY_CONTRACT_VERSION;
  readonly snapshotId: string;
  readonly revision: number;
  readonly lineage: RoomBindingCapabilityLineageV1;
  readonly freshness: RoomBindingSnapshotFreshnessV1;
  readonly tools: readonly RoomBindingToolCapabilityV1[];
  readonly context: RoomBindingContextCapacityV1;
  readonly health: RoomBindingHealthV1;
  readonly latency: RoomBindingLatencyV1;
  readonly rateLimit: RoomBindingRateLimitV1;
  readonly domainQuality: readonly RoomBindingDomainQualityV1[];
  readonly calibration: readonly RoomBindingDomainCalibrationV1[];
}

export interface RoomBindingCapabilitySnapshotV1 extends RoomBindingCapabilitySnapshotDraftV1 {
  readonly integrityHash: string;
}

export interface RoomCapabilityRegistryV1 {
  readonly contractVersion: typeof ROOM_CAPABILITY_REGISTRY_CONTRACT_VERSION;
  readonly registryId: string;
  readonly revision: number;
  readonly observedAt: IsoTimestamp;
  readonly bindings: readonly RoomBindingCapabilitySnapshotV1[];
  readonly integrityHash: string;
}

export interface RoomCapabilityFreshnessPolicyV1 {
  readonly maxSnapshotAgeMs: number;
  readonly maxSignalAgeMs: number;
  readonly maxFutureSkewMs: number;
}

export interface RoomCapabilityProviderLimitV1 {
  readonly providerId: string;
  readonly accountId: string;
  readonly maxActiveDispatches: number;
  readonly activeDispatches: number;
  readonly retryAfterMs: number | null;
  readonly checkedAt: IsoTimestamp;
}

export interface RoomCapabilityRoutingRequirementsV1 {
  readonly requiredTools: readonly string[];
  readonly minimumAvailableContextTokens: number;
  readonly domain: string;
  readonly minimumIndependentEvidence: number;
  readonly minimumCalibrationOutcomeCount: number;
  readonly minimumQualityScore: number;
}

export interface RoomCapabilityRoutingPolicyV1 {
  readonly freshness: RoomCapabilityFreshnessPolicyV1;
  readonly requirements: RoomCapabilityRoutingRequirementsV1;
  readonly providerLimits: readonly RoomCapabilityProviderLimitV1[];
}

export type RoomCapabilityRegistryIssueCode =
  | "invalid_snapshot"
  | "invalid_registry"
  | "invalid_policy"
  | "snapshot_integrity_mismatch"
  | "registry_integrity_mismatch"
  | "duplicate_binding_snapshot"
  | "stale_snapshot"
  | "future_snapshot"
  | "snapshot_expired"
  | "stale_signal"
  | "future_signal"
  | "stale_revision"
  | "contradictory_revision"
  | "binding_lineage_mismatch"
  | "health_not_healthy"
  | "host_not_healthy"
  | "rate_limited"
  | "provider_limit_unknown"
  | "stale_provider_limit"
  | "provider_capacity_exhausted"
  | "required_tool_unavailable"
  | "insufficient_context"
  | "independent_quality_missing"
  | "stale_quality_evidence"
  | "calibration_missing"
  | "stale_calibration"
  | "quality_below_threshold";

export interface RoomCapabilityRegistryIssueV1 {
  readonly code: RoomCapabilityRegistryIssueCode;
  readonly path: string;
  readonly message: string;
  readonly bindingId?: RoomBindingId;
  readonly providerId?: string;
}

export type RoomCapabilityRegistryResultV1<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly RoomCapabilityRegistryIssueV1[] };

export interface MergeRoomCapabilityRegistryInputV1 {
  readonly registryId: string;
  readonly current: RoomCapabilityRegistryV1 | null;
  readonly samples: readonly RoomBindingCapabilitySnapshotV1[];
  readonly asOf: IsoTimestamp;
  readonly freshness: RoomCapabilityFreshnessPolicyV1;
}

export interface RoomBindingCapabilityEligibilityV1 {
  readonly bindingId: RoomBindingId;
  readonly eligible: boolean;
  readonly qualityScore: number | null;
  readonly independentEvidenceCount: number;
  readonly calibrationOutcomeCount: number;
  readonly issues: readonly RoomCapabilityRegistryIssueV1[];
}

export interface EvaluateRoomBindingCapabilityInputV1 {
  readonly snapshot: RoomBindingCapabilitySnapshotV1;
  readonly asOf: IsoTimestamp;
  readonly policy: RoomCapabilityRoutingPolicyV1;
}

export interface RecommendRoomCapabilityBindingsInputV1 {
  readonly registry: RoomCapabilityRegistryV1;
  readonly asOf: IsoTimestamp;
  readonly policy: RoomCapabilityRoutingPolicyV1;
}

export interface RoomCapabilityRecommendationV1 {
  readonly bindingId: RoomBindingId;
  readonly providerId: string;
  readonly modelId: string;
  readonly qualityScore: number;
  readonly latencyP95Ms: number;
  readonly availableContextTokens: number;
}

export interface RoomCapabilityRecommendationSetV1 {
  readonly recommendations: readonly RoomCapabilityRecommendationV1[];
  readonly rejected: readonly RoomBindingCapabilityEligibilityV1[];
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

function isCanonicalNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isCanonicalUtcTimestamp(value: unknown): value is IsoTimestamp {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function issue(
  code: RoomCapabilityRegistryIssueCode,
  path: string,
  message: string,
  details: Pick<RoomCapabilityRegistryIssueV1, "bindingId" | "providerId"> = {},
): RoomCapabilityRegistryIssueV1 {
  return { code, path, message, ...details };
}

function sortIssues(issues: readonly RoomCapabilityRegistryIssueV1[]): RoomCapabilityRegistryIssueV1[] {
  return [...issues].sort((left, right) => {
    const code = compareRoomText(left.code, right.code);
    if (code !== 0) return code;
    const path = compareRoomText(left.path, right.path);
    if (path !== 0) return path;
    return compareRoomText(left.message, right.message);
  });
}

function fail<T>(issues: readonly RoomCapabilityRegistryIssueV1[]): RoomCapabilityRegistryResultV1<T> {
  return deepFreeze({ ok: false, issues: sortIssues(issues) });
}

function succeed<T>(value: T): RoomCapabilityRegistryResultV1<T> {
  return deepFreeze({ ok: true, value: deepFreeze(value) });
}

function normalizeLineage(
  value: unknown,
  path: string,
  issues: RoomCapabilityRegistryIssueV1[],
): RoomBindingCapabilityLineageV1 | undefined {
  if (!isRecord(value)) {
    issues.push(issue("invalid_snapshot", path, "Binding lineage must be an inspectable object"));
    return undefined;
  }
  const fields = [
    "bindingId",
    "providerId",
    "accountId",
    "modelId",
    "connectorId",
    "nativeSessionId",
    "hostId",
  ] as const;
  for (const field of fields) {
    if (!isCanonicalNonEmptyString(value[field])) {
      issues.push(issue("invalid_snapshot", `${path}.${field}`, "Binding lineage fields must be canonical non-empty strings"));
    }
  }
  if (!isPositiveSafeInteger(value.bindingGeneration)) {
    issues.push(issue("invalid_snapshot", `${path}.bindingGeneration`, "Binding generation must be a positive safe integer"));
  }
  if (issues.some((entry) => entry.path.startsWith(path))) return undefined;
  return {
    bindingId: value.bindingId as RoomBindingId,
    bindingGeneration: value.bindingGeneration as number,
    providerId: value.providerId as string,
    accountId: value.accountId as string,
    modelId: value.modelId as string,
    connectorId: value.connectorId as string,
    nativeSessionId: value.nativeSessionId as string,
    hostId: value.hostId as string,
  };
}

function normalizeTools(
  value: unknown,
  path: string,
  bindingId: RoomBindingId | undefined,
  issues: RoomCapabilityRegistryIssueV1[],
): RoomBindingToolCapabilityV1[] | undefined {
  if (!Array.isArray(value)) {
    issues.push(issue("invalid_snapshot", path, "Tool capabilities must be an array", { bindingId }));
    return undefined;
  }
  const tools: RoomBindingToolCapabilityV1[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const entryPath = `${path}[${index}]`;
    if (!isRecord(entry) || !isCanonicalNonEmptyString(entry.name) || !TOOL_STATES.has(entry.state as string)) {
      issues.push(issue("invalid_snapshot", entryPath, "Each tool needs a canonical name and supported state", { bindingId }));
      continue;
    }
    if (seen.has(entry.name)) {
      issues.push(issue("invalid_snapshot", `${entryPath}.name`, "A tool may appear only once per binding snapshot", { bindingId }));
      continue;
    }
    seen.add(entry.name);
    tools.push({ name: entry.name, state: entry.state as RoomBindingToolState });
  }
  return tools.sort((left, right) => compareRoomText(left.name, right.name));
}

function normalizeContext(
  value: unknown,
  path: string,
  bindingId: RoomBindingId | undefined,
  issues: RoomCapabilityRegistryIssueV1[],
): RoomBindingContextCapacityV1 | undefined {
  if (!isRecord(value)) {
    issues.push(issue("invalid_snapshot", path, "Context capacity must be an inspectable object", { bindingId }));
    return undefined;
  }
  if (!isCanonicalNonEmptyString(value.contextVersion)) {
    issues.push(issue("invalid_snapshot", `${path}.contextVersion`, "Context version must be a canonical non-empty string", { bindingId }));
  }
  if (!isPositiveSafeInteger(value.maximumTokens)) {
    issues.push(issue("invalid_snapshot", `${path}.maximumTokens`, "Context maximum tokens must be a positive safe integer", { bindingId }));
  }
  if (!isNonNegativeSafeInteger(value.availableTokens)) {
    issues.push(issue("invalid_snapshot", `${path}.availableTokens`, "Context available tokens must be a non-negative safe integer", { bindingId }));
  }
  if (
    isPositiveSafeInteger(value.maximumTokens)
    && isNonNegativeSafeInteger(value.availableTokens)
    && value.availableTokens > value.maximumTokens
  ) {
    issues.push(issue("invalid_snapshot", `${path}.availableTokens`, "Context availability cannot exceed its maximum", { bindingId }));
  }
  if (!isCanonicalUtcTimestamp(value.observedAt)) {
    issues.push(issue("invalid_snapshot", `${path}.observedAt`, "Context observation time must be canonical UTC", { bindingId }));
  }
  if (issues.some((entry) => entry.path.startsWith(path))) return undefined;
  return {
    contextVersion: value.contextVersion as string,
    maximumTokens: value.maximumTokens as number,
    availableTokens: value.availableTokens as number,
    observedAt: value.observedAt as IsoTimestamp,
  };
}

function normalizeHealth(
  value: unknown,
  path: string,
  bindingId: RoomBindingId | undefined,
  issues: RoomCapabilityRegistryIssueV1[],
): RoomBindingHealthV1 | undefined {
  if (!isRecord(value)) {
    issues.push(issue("invalid_snapshot", path, "Health must be an inspectable object", { bindingId }));
    return undefined;
  }
  if (!CONNECTOR_HEALTH_STATES.has(value.connectorState as string)) {
    issues.push(issue("invalid_snapshot", `${path}.connectorState`, "Connector health state is unsupported", { bindingId }));
  }
  if (!HOST_HEALTH_STATES.has(value.hostState as string)) {
    issues.push(issue("invalid_snapshot", `${path}.hostState`, "Host health state is unsupported", { bindingId }));
  }
  if (!isCanonicalUtcTimestamp(value.observedAt)) {
    issues.push(issue("invalid_snapshot", `${path}.observedAt`, "Health observation time must be canonical UTC", { bindingId }));
  }
  if (
    value.connectorState === "healthy"
    && value.hostState === "unavailable"
  ) {
    issues.push(issue("invalid_snapshot", path, "A healthy connector cannot be attached to an unavailable host", { bindingId }));
  }
  if (
    value.connectorState === "host_unavailable"
    && value.hostState !== "unavailable"
  ) {
    issues.push(issue("invalid_snapshot", path, "Host-unavailable connector state requires an unavailable host", { bindingId }));
  }
  if (issues.some((entry) => entry.path.startsWith(path))) return undefined;
  return {
    connectorState: value.connectorState as RoomBindingConnectorHealthState,
    hostState: value.hostState as RoomBindingHostHealthState,
    observedAt: value.observedAt as IsoTimestamp,
  };
}

function normalizeLatency(
  value: unknown,
  path: string,
  bindingId: RoomBindingId | undefined,
  issues: RoomCapabilityRegistryIssueV1[],
): RoomBindingLatencyV1 | undefined {
  if (!isRecord(value)) {
    issues.push(issue("invalid_snapshot", path, "Latency must be an inspectable object", { bindingId }));
    return undefined;
  }
  if (typeof value.p50Ms !== "number" || !Number.isFinite(value.p50Ms) || value.p50Ms < 0) {
    issues.push(issue("invalid_snapshot", `${path}.p50Ms`, "Latency p50 must be finite and non-negative", { bindingId }));
  }
  if (typeof value.p95Ms !== "number" || !Number.isFinite(value.p95Ms) || value.p95Ms < 0) {
    issues.push(issue("invalid_snapshot", `${path}.p95Ms`, "Latency p95 must be finite and non-negative", { bindingId }));
  }
  if (
    typeof value.p50Ms === "number"
    && typeof value.p95Ms === "number"
    && Number.isFinite(value.p50Ms)
    && Number.isFinite(value.p95Ms)
    && value.p95Ms < value.p50Ms
  ) {
    issues.push(issue("invalid_snapshot", path, "Latency p95 cannot be lower than p50", { bindingId }));
  }
  if (!isPositiveSafeInteger(value.sampleCount)) {
    issues.push(issue("invalid_snapshot", `${path}.sampleCount`, "Latency sample count must be a positive safe integer", { bindingId }));
  }
  if (!isCanonicalUtcTimestamp(value.observedAt)) {
    issues.push(issue("invalid_snapshot", `${path}.observedAt`, "Latency observation time must be canonical UTC", { bindingId }));
  }
  if (issues.some((entry) => entry.path.startsWith(path))) return undefined;
  return {
    p50Ms: value.p50Ms as number,
    p95Ms: value.p95Ms as number,
    sampleCount: value.sampleCount as number,
    observedAt: value.observedAt as IsoTimestamp,
  };
}

function normalizeRateLimit(
  value: unknown,
  path: string,
  bindingId: RoomBindingId | undefined,
  health: RoomBindingHealthV1 | undefined,
  issues: RoomCapabilityRegistryIssueV1[],
): RoomBindingRateLimitV1 | undefined {
  if (!isRecord(value)) {
    issues.push(issue("invalid_snapshot", path, "Rate-limit state must be an inspectable object", { bindingId }));
    return undefined;
  }
  if (!RATE_LIMIT_STATES.has(value.state as string)) {
    issues.push(issue("invalid_snapshot", `${path}.state`, "Rate-limit state is unsupported", { bindingId }));
  }
  const retryAfterValid = value.retryAfterMs === null || isPositiveSafeInteger(value.retryAfterMs);
  if (!retryAfterValid) {
    issues.push(issue("invalid_snapshot", `${path}.retryAfterMs`, "Retry-after must be null or a positive safe integer", { bindingId }));
  }
  if (value.state === "limited" && !isPositiveSafeInteger(value.retryAfterMs)) {
    issues.push(issue("invalid_snapshot", `${path}.retryAfterMs`, "Limited bindings require an explicit retry-after", { bindingId }));
  }
  if (value.state !== "limited" && value.retryAfterMs !== null) {
    issues.push(issue("invalid_snapshot", `${path}.retryAfterMs`, "Only limited bindings may carry retry-after", { bindingId }));
  }
  if (health?.connectorState === "rate_limited" && value.state !== "limited") {
    issues.push(issue("invalid_snapshot", path, "Rate-limited connector health requires limited rate state", { bindingId }));
  }
  if (value.state === "limited" && health?.connectorState !== "rate_limited") {
    issues.push(issue("invalid_snapshot", path, "Limited rate state requires rate-limited connector health", { bindingId }));
  }
  if (!isCanonicalUtcTimestamp(value.observedAt)) {
    issues.push(issue("invalid_snapshot", `${path}.observedAt`, "Rate-limit observation time must be canonical UTC", { bindingId }));
  }
  if (issues.some((entry) => entry.path.startsWith(path))) return undefined;
  return {
    state: value.state as RoomBindingRateLimitState,
    retryAfterMs: value.retryAfterMs as number | null,
    observedAt: value.observedAt as IsoTimestamp,
  };
}

function normalizeDomainQuality(
  value: unknown,
  path: string,
  bindingId: RoomBindingId | undefined,
  issues: RoomCapabilityRegistryIssueV1[],
): RoomBindingDomainQualityV1[] | undefined {
  if (!Array.isArray(value)) {
    issues.push(issue("invalid_snapshot", path, "Domain quality must be an array", { bindingId }));
    return undefined;
  }
  const quality: RoomBindingDomainQualityV1[] = [];
  const domains = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const entryPath = `${path}[${index}]`;
    if (!isRecord(entry) || !isCanonicalNonEmptyString(entry.domain)) {
      issues.push(issue("invalid_snapshot", entryPath, "Domain quality requires a canonical domain", { bindingId }));
      continue;
    }
    if (domains.has(entry.domain)) {
      issues.push(issue("invalid_snapshot", `${entryPath}.domain`, "A domain may appear only once per binding snapshot", { bindingId }));
      continue;
    }
    domains.add(entry.domain);
    if (entry.selfReportedScore !== null && !isUnitInterval(entry.selfReportedScore)) {
      issues.push(issue("invalid_snapshot", `${entryPath}.selfReportedScore`, "Self-reported quality must be null or a score in [0, 1]", { bindingId }));
    }
    if (!Array.isArray(entry.independentEvidence)) {
      issues.push(issue("invalid_snapshot", `${entryPath}.independentEvidence`, "Independent quality evidence must be an array", { bindingId }));
      continue;
    }
    const evidence: RoomBindingIndependentQualityEvidenceV1[] = [];
    const sourceIds = new Set<string>();
    for (let evidenceIndex = 0; evidenceIndex < entry.independentEvidence.length; evidenceIndex += 1) {
      const source = entry.independentEvidence[evidenceIndex];
      const sourcePath = `${entryPath}.independentEvidence[${evidenceIndex}]`;
      if (
        !isRecord(source)
        || !isCanonicalNonEmptyString(source.sourceId)
        || !QUALITY_EVIDENCE_KINDS.has(source.kind as string)
        || !isUnitInterval(source.score)
        || !isCanonicalUtcTimestamp(source.observedAt)
      ) {
        issues.push(issue("invalid_snapshot", sourcePath, "Independent quality evidence is malformed", { bindingId }));
        continue;
      }
      if (source.sourceId === bindingId) {
        issues.push(issue("invalid_snapshot", `${sourcePath}.sourceId`, "Independent evidence cannot originate from the scored binding", { bindingId }));
        continue;
      }
      if (sourceIds.has(source.sourceId)) {
        issues.push(issue("invalid_snapshot", `${sourcePath}.sourceId`, "A quality evidence source may appear once per domain", { bindingId }));
        continue;
      }
      sourceIds.add(source.sourceId);
      evidence.push({
        sourceId: source.sourceId,
        kind: source.kind as RoomBindingQualityEvidenceKind,
        score: source.score as number,
        observedAt: source.observedAt as IsoTimestamp,
      });
    }
    quality.push({
      domain: entry.domain,
      selfReportedScore: entry.selfReportedScore as number | null,
      independentEvidence: evidence.sort((left, right) => compareRoomText(left.sourceId, right.sourceId)),
    });
  }
  return quality.sort((left, right) => compareRoomText(left.domain, right.domain));
}

function normalizeCalibration(
  value: unknown,
  path: string,
  bindingId: RoomBindingId | undefined,
  issues: RoomCapabilityRegistryIssueV1[],
): RoomBindingDomainCalibrationV1[] | undefined {
  if (!Array.isArray(value)) {
    issues.push(issue("invalid_snapshot", path, "Domain calibration must be an array", { bindingId }));
    return undefined;
  }
  const calibration: RoomBindingDomainCalibrationV1[] = [];
  const domains = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const entryPath = `${path}[${index}]`;
    if (
      !isRecord(entry)
      || !isCanonicalNonEmptyString(entry.domain)
      || !isNonNegativeSafeInteger(entry.outcomeCount)
      || !isUnitInterval(entry.meanAbsoluteError)
      || !isCanonicalUtcTimestamp(entry.observedAt)
    ) {
      issues.push(issue("invalid_snapshot", entryPath, "Domain calibration is malformed", { bindingId }));
      continue;
    }
    if (domains.has(entry.domain)) {
      issues.push(issue("invalid_snapshot", `${entryPath}.domain`, "A calibration domain may appear only once per binding snapshot", { bindingId }));
      continue;
    }
    domains.add(entry.domain);
    calibration.push({
      domain: entry.domain,
      outcomeCount: entry.outcomeCount,
      meanAbsoluteError: entry.meanAbsoluteError,
      observedAt: entry.observedAt,
    });
  }
  return calibration.sort((left, right) => compareRoomText(left.domain, right.domain));
}

function normalizeFreshness(
  value: unknown,
  path: string,
  bindingId: RoomBindingId | undefined,
  issues: RoomCapabilityRegistryIssueV1[],
): RoomBindingSnapshotFreshnessV1 | undefined {
  if (!isRecord(value)) {
    issues.push(issue("invalid_snapshot", path, "Snapshot freshness must be an inspectable object", { bindingId }));
    return undefined;
  }
  if (!isCanonicalUtcTimestamp(value.capturedAt)) {
    issues.push(issue("invalid_snapshot", `${path}.capturedAt`, "Snapshot capture time must be canonical UTC", { bindingId }));
  }
  if (!isCanonicalUtcTimestamp(value.expiresAt)) {
    issues.push(issue("invalid_snapshot", `${path}.expiresAt`, "Snapshot expiry time must be canonical UTC", { bindingId }));
  }
  if (!isCanonicalNonEmptyString(value.sourceRevision)) {
    issues.push(issue("invalid_snapshot", `${path}.sourceRevision`, "Snapshot source revision must be a canonical non-empty string", { bindingId }));
  }
  if (
    isCanonicalUtcTimestamp(value.capturedAt)
    && isCanonicalUtcTimestamp(value.expiresAt)
    && Date.parse(value.expiresAt) <= Date.parse(value.capturedAt)
  ) {
    issues.push(issue("invalid_snapshot", path, "Snapshot expiry must be after capture", { bindingId }));
  }
  if (issues.some((entry) => entry.path.startsWith(path))) return undefined;
  return {
    capturedAt: value.capturedAt as IsoTimestamp,
    expiresAt: value.expiresAt as IsoTimestamp,
    sourceRevision: value.sourceRevision as string,
  };
}

function ensureObservedBeforeCapture(
  observedAt: IsoTimestamp,
  capturedAt: IsoTimestamp,
  path: string,
  bindingId: RoomBindingId,
  issues: RoomCapabilityRegistryIssueV1[],
): void {
  if (Date.parse(observedAt) > Date.parse(capturedAt)) {
    issues.push(issue("invalid_snapshot", path, "A measurement cannot be observed after its enclosing snapshot was captured", { bindingId }));
  }
}

function snapshotIntegrityPayload(snapshot: RoomBindingCapabilitySnapshotDraftV1): Record<string, unknown> {
  return {
    contractVersion: snapshot.contractVersion,
    snapshotId: snapshot.snapshotId,
    revision: snapshot.revision,
    lineage: snapshot.lineage,
    freshness: snapshot.freshness,
    tools: snapshot.tools,
    context: snapshot.context,
    health: snapshot.health,
    latency: snapshot.latency,
    rateLimit: snapshot.rateLimit,
    domainQuality: snapshot.domainQuality,
    calibration: snapshot.calibration,
  };
}

function normalizeSnapshotDraft(value: unknown): RoomCapabilityRegistryResultV1<RoomBindingCapabilitySnapshotDraftV1> {
  const issues: RoomCapabilityRegistryIssueV1[] = [];
  if (!isRecord(value)) {
    return fail([issue("invalid_snapshot", "$", "Binding capability snapshot must be an inspectable object")]);
  }
  if (value.contractVersion !== ROOM_CAPABILITY_REGISTRY_CONTRACT_VERSION) {
    issues.push(issue("invalid_snapshot", "$.contractVersion", "Only binding capability registry contract version 1 is supported"));
  }
  if (!isCanonicalNonEmptyString(value.snapshotId)) {
    issues.push(issue("invalid_snapshot", "$.snapshotId", "Snapshot identity must be a canonical non-empty string"));
  }
  if (!isPositiveSafeInteger(value.revision)) {
    issues.push(issue("invalid_snapshot", "$.revision", "Snapshot revision must be a positive safe integer"));
  }
  const lineage = normalizeLineage(value.lineage, "$.lineage", issues);
  const bindingId = lineage?.bindingId;
  const freshness = normalizeFreshness(value.freshness, "$.freshness", bindingId, issues);
  const tools = normalizeTools(value.tools, "$.tools", bindingId, issues);
  const context = normalizeContext(value.context, "$.context", bindingId, issues);
  const health = normalizeHealth(value.health, "$.health", bindingId, issues);
  const latency = normalizeLatency(value.latency, "$.latency", bindingId, issues);
  const rateLimit = normalizeRateLimit(value.rateLimit, "$.rateLimit", bindingId, health, issues);
  const domainQuality = normalizeDomainQuality(value.domainQuality, "$.domainQuality", bindingId, issues);
  const calibration = normalizeCalibration(value.calibration, "$.calibration", bindingId, issues);

  if (
    lineage
    && freshness
    && context
    && health
    && latency
    && rateLimit
    && domainQuality
    && calibration
  ) {
    const qualityDomains = new Set(domainQuality.map((entry) => entry.domain));
    const calibrationDomains = new Set(calibration.map((entry) => entry.domain));
    for (const domain of qualityDomains) {
      if (!calibrationDomains.has(domain)) {
        issues.push(issue("invalid_snapshot", "$.calibration", `Domain '${domain}' has quality evidence but no calibration record`, { bindingId: lineage.bindingId }));
      }
    }
    for (const domain of calibrationDomains) {
      if (!qualityDomains.has(domain)) {
        issues.push(issue("invalid_snapshot", "$.calibration", `Calibration domain '${domain}' has no quality record`, { bindingId: lineage.bindingId }));
      }
    }
    ensureObservedBeforeCapture(context.observedAt, freshness.capturedAt, "$.context.observedAt", lineage.bindingId, issues);
    ensureObservedBeforeCapture(health.observedAt, freshness.capturedAt, "$.health.observedAt", lineage.bindingId, issues);
    ensureObservedBeforeCapture(latency.observedAt, freshness.capturedAt, "$.latency.observedAt", lineage.bindingId, issues);
    ensureObservedBeforeCapture(rateLimit.observedAt, freshness.capturedAt, "$.rateLimit.observedAt", lineage.bindingId, issues);
    for (const quality of domainQuality) {
      for (const evidence of quality.independentEvidence) {
        ensureObservedBeforeCapture(evidence.observedAt, freshness.capturedAt, `$.domainQuality.${quality.domain}.independentEvidence.${evidence.sourceId}.observedAt`, lineage.bindingId, issues);
      }
    }
    for (const entry of calibration) {
      ensureObservedBeforeCapture(entry.observedAt, freshness.capturedAt, `$.calibration.${entry.domain}.observedAt`, lineage.bindingId, issues);
    }
  }

  if (
    issues.length > 0
    || !lineage
    || !freshness
    || !tools
    || !context
    || !health
    || !latency
    || !rateLimit
    || !domainQuality
    || !calibration
  ) {
    return fail(issues);
  }
  return succeed({
    contractVersion: ROOM_CAPABILITY_REGISTRY_CONTRACT_VERSION,
    snapshotId: value.snapshotId as string,
    revision: value.revision as number,
    lineage,
    freshness,
    tools,
    context,
    health,
    latency,
    rateLimit,
    domainQuality,
    calibration,
  });
}

/**
 * FNXC:RoomCapabilityRegistry 2026-07-19-08:07:
 * A capability sample is immutable evidence for one concrete binding, not a
 * provider-wide label. Provider/model/native-session/host lineage is carried
 * in every revision so a replacement cannot masquerade as a performance update.
 * The integrity hash detects altered payloads inside this pure foundation; a
 * future persistence/connector layer must still authenticate its producer.
 */
export function createRoomBindingCapabilitySnapshot(
  input: RoomBindingCapabilitySnapshotDraftV1,
): RoomCapabilityRegistryResultV1<RoomBindingCapabilitySnapshotV1> {
  const normalized = normalizeSnapshotDraft(input);
  if (!normalized.ok) return normalized;
  const snapshot: RoomBindingCapabilitySnapshotV1 = {
    ...normalized.value,
    integrityHash: hashRoomValue(snapshotIntegrityPayload(normalized.value)),
  };
  return succeed(snapshot);
}

export function validateRoomBindingCapabilitySnapshot(
  input: unknown,
): RoomCapabilityRegistryResultV1<RoomBindingCapabilitySnapshotV1> {
  const normalized = normalizeSnapshotDraft(input);
  if (!normalized.ok) return normalized;
  if (!isRecord(input) || !isCanonicalNonEmptyString(input.integrityHash)) {
    return fail([issue("snapshot_integrity_mismatch", "$.integrityHash", "A received binding snapshot requires an integrity hash", { bindingId: normalized.value.lineage.bindingId })]);
  }
  const expectedHash = hashRoomValue(snapshotIntegrityPayload(normalized.value));
  if (input.integrityHash !== expectedHash) {
    return fail([issue("snapshot_integrity_mismatch", "$.integrityHash", "Binding snapshot payload does not match its integrity hash", { bindingId: normalized.value.lineage.bindingId })]);
  }
  return succeed({ ...normalized.value, integrityHash: expectedHash });
}

function registryIntegrityPayload(registry: Omit<RoomCapabilityRegistryV1, "integrityHash">): Record<string, unknown> {
  return {
    contractVersion: registry.contractVersion,
    registryId: registry.registryId,
    revision: registry.revision,
    observedAt: registry.observedAt,
    bindingIntegrityHashes: registry.bindings.map((binding) => binding.integrityHash),
  };
}

function validateRoomCapabilityRegistry(
  input: unknown,
): RoomCapabilityRegistryResultV1<RoomCapabilityRegistryV1> {
  if (!isRecord(input)) {
    return fail([issue("invalid_registry", "$", "Capability registry must be an inspectable object")]);
  }
  const issues: RoomCapabilityRegistryIssueV1[] = [];
  if (input.contractVersion !== ROOM_CAPABILITY_REGISTRY_CONTRACT_VERSION) {
    issues.push(issue("invalid_registry", "$.contractVersion", "Only registry contract version 1 is supported"));
  }
  if (!isCanonicalNonEmptyString(input.registryId)) {
    issues.push(issue("invalid_registry", "$.registryId", "Registry identity must be a canonical non-empty string"));
  }
  if (!isPositiveSafeInteger(input.revision)) {
    issues.push(issue("invalid_registry", "$.revision", "Registry revision must be a positive safe integer"));
  }
  if (!isCanonicalUtcTimestamp(input.observedAt)) {
    issues.push(issue("invalid_registry", "$.observedAt", "Registry observation time must be canonical UTC"));
  }
  if (!Array.isArray(input.bindings)) {
    issues.push(issue("invalid_registry", "$.bindings", "Registry bindings must be an array"));
  }
  if (!isCanonicalNonEmptyString(input.integrityHash)) {
    issues.push(issue("registry_integrity_mismatch", "$.integrityHash", "A received registry requires an integrity hash"));
  }
  const bindings: RoomBindingCapabilitySnapshotV1[] = [];
  const seenBindingIds = new Set<string>();
  if (Array.isArray(input.bindings)) {
    for (let index = 0; index < input.bindings.length; index += 1) {
      const validated = validateRoomBindingCapabilitySnapshot(input.bindings[index]);
      if (!validated.ok) {
        issues.push(...validated.issues);
        continue;
      }
      const bindingId = validated.value.lineage.bindingId;
      if (seenBindingIds.has(bindingId)) {
        issues.push(issue("duplicate_binding_snapshot", `$.bindings[${index}]`, "Registry cannot contain the same binding twice", { bindingId }));
        continue;
      }
      seenBindingIds.add(bindingId);
      bindings.push(validated.value);
    }
  }
  bindings.sort((left, right) => compareRoomText(left.lineage.bindingId, right.lineage.bindingId));
  if (issues.length > 0) return fail(issues);
  const registryWithoutHash = {
    contractVersion: ROOM_CAPABILITY_REGISTRY_CONTRACT_VERSION,
    registryId: input.registryId as string,
    revision: input.revision as number,
    observedAt: input.observedAt as IsoTimestamp,
    bindings,
  };
  const expectedHash = hashRoomValue(registryIntegrityPayload(registryWithoutHash));
  if (input.integrityHash !== expectedHash) {
    return fail([issue("registry_integrity_mismatch", "$.integrityHash", "Registry payload does not match its integrity hash")]);
  }
  return succeed({ ...registryWithoutHash, integrityHash: expectedHash });
}

function normalizeFreshnessPolicy(
  value: unknown,
): RoomCapabilityRegistryResultV1<RoomCapabilityFreshnessPolicyV1> {
  if (!isRecord(value)) {
    return fail([issue("invalid_policy", "$.freshness", "Freshness policy must be an inspectable object")]);
  }
  const fields = ["maxSnapshotAgeMs", "maxSignalAgeMs"] as const;
  const issues: RoomCapabilityRegistryIssueV1[] = [];
  for (const field of fields) {
    if (!isPositiveSafeInteger(value[field])) {
      issues.push(issue("invalid_policy", `$.freshness.${field}`, "Freshness ages must be positive safe integers"));
    }
  }
  if (!isNonNegativeSafeInteger(value.maxFutureSkewMs)) {
    issues.push(issue("invalid_policy", "$.freshness.maxFutureSkewMs", "Future skew must be a non-negative safe integer"));
  }
  if (issues.length > 0) return fail(issues);
  return succeed({
    maxSnapshotAgeMs: value.maxSnapshotAgeMs as number,
    maxSignalAgeMs: value.maxSignalAgeMs as number,
    maxFutureSkewMs: value.maxFutureSkewMs as number,
  });
}

function timestampFreshnessIssues(
  timestamp: IsoTimestamp,
  asOf: IsoTimestamp,
  maxAgeMs: number,
  maxFutureSkewMs: number,
  path: string,
  bindingId: RoomBindingId,
  staleCode: RoomCapabilityRegistryIssueCode,
  futureCode: RoomCapabilityRegistryIssueCode,
): RoomCapabilityRegistryIssueV1[] {
  const deltaMs = Date.parse(asOf) - Date.parse(timestamp);
  if (deltaMs < -maxFutureSkewMs) {
    return [issue(futureCode, path, "Measurement is too far in the future for a deterministic routing decision", { bindingId })];
  }
  if (deltaMs > maxAgeMs) {
    return [issue(staleCode, path, "Measurement is older than the configured routing freshness window", { bindingId })];
  }
  return [];
}

function snapshotFreshnessIssues(
  snapshot: RoomBindingCapabilitySnapshotV1,
  asOf: IsoTimestamp,
  policy: RoomCapabilityFreshnessPolicyV1,
): RoomCapabilityRegistryIssueV1[] {
  const bindingId = snapshot.lineage.bindingId;
  const issues = timestampFreshnessIssues(
    snapshot.freshness.capturedAt,
    asOf,
    policy.maxSnapshotAgeMs,
    policy.maxFutureSkewMs,
    "$.freshness.capturedAt",
    bindingId,
    "stale_snapshot",
    "future_snapshot",
  );
  if (Date.parse(asOf) > Date.parse(snapshot.freshness.expiresAt)) {
    issues.push(issue("snapshot_expired", "$.freshness.expiresAt", "Snapshot has reached its declared expiry", { bindingId }));
  }
  for (const [path, observedAt] of [
    ["$.context.observedAt", snapshot.context.observedAt],
    ["$.health.observedAt", snapshot.health.observedAt],
    ["$.latency.observedAt", snapshot.latency.observedAt],
    ["$.rateLimit.observedAt", snapshot.rateLimit.observedAt],
  ] as const) {
    issues.push(...timestampFreshnessIssues(
      observedAt,
      asOf,
      policy.maxSignalAgeMs,
      policy.maxFutureSkewMs,
      path,
      bindingId,
      "stale_signal",
      "future_signal",
    ));
  }
  return issues;
}

function sameLineage(
  left: RoomBindingCapabilityLineageV1,
  right: RoomBindingCapabilityLineageV1,
): boolean {
  return left.bindingId === right.bindingId
    && left.bindingGeneration === right.bindingGeneration
    && left.providerId === right.providerId
    && left.accountId === right.accountId
    && left.modelId === right.modelId
    && left.connectorId === right.connectorId
    && left.nativeSessionId === right.nativeSessionId
    && left.hostId === right.hostId;
}

/**
 * FNXC:RoomCapabilityRegistry 2026-07-19-08:07:
 * Merge is deliberately all-or-nothing and clock-injected. A stale,
 * contradictory, or hash-altered sample cannot partly change the registry, and
 * a same-binding update cannot silently substitute a native Session, host,
 * provider, or model. This module intentionally provides no storage or worker
 * scheduling integration.
 */
export function mergeRoomCapabilityRegistry(
  input: MergeRoomCapabilityRegistryInputV1,
): RoomCapabilityRegistryResultV1<RoomCapabilityRegistryV1> {
  const candidate = input as unknown;
  if (!isRecord(candidate)) {
    return fail([issue("invalid_registry", "$", "Registry merge input must be an inspectable object")]);
  }
  const issues: RoomCapabilityRegistryIssueV1[] = [];
  if (!isCanonicalNonEmptyString(candidate.registryId)) {
    issues.push(issue("invalid_registry", "$.registryId", "Registry identity must be a canonical non-empty string"));
  }
  if (!isCanonicalUtcTimestamp(candidate.asOf)) {
    issues.push(issue("invalid_registry", "$.asOf", "Merge time must be canonical UTC"));
  }
  const freshness = normalizeFreshnessPolicy(candidate.freshness);
  if (!freshness.ok) issues.push(...freshness.issues);
  if (!Array.isArray(candidate.samples)) {
    issues.push(issue("invalid_registry", "$.samples", "Registry merge samples must be an array"));
  }
  let current: RoomCapabilityRegistryV1 | null = null;
  if (candidate.current !== null) {
    const currentResult = validateRoomCapabilityRegistry(candidate.current);
    if (!currentResult.ok) issues.push(...currentResult.issues);
    else current = currentResult.value;
  }
  if (current && current.registryId !== candidate.registryId) {
    issues.push(issue("invalid_registry", "$.registryId", "Registry identity cannot change during a merge"));
  }

  const samples: RoomBindingCapabilitySnapshotV1[] = [];
  const sampleBindingIds = new Set<string>();
  if (Array.isArray(candidate.samples)) {
    for (let index = 0; index < candidate.samples.length; index += 1) {
      const validated = validateRoomBindingCapabilitySnapshot(candidate.samples[index]);
      if (!validated.ok) {
        issues.push(...validated.issues);
        continue;
      }
      const bindingId = validated.value.lineage.bindingId;
      if (sampleBindingIds.has(bindingId)) {
        issues.push(issue("duplicate_binding_snapshot", `$.samples[${index}]`, "A merge accepts at most one sample per concrete binding", { bindingId }));
        continue;
      }
      sampleBindingIds.add(bindingId);
      samples.push(validated.value);
    }
  }
  if (freshness.ok && isCanonicalUtcTimestamp(candidate.asOf)) {
    for (const sample of samples) {
      issues.push(...snapshotFreshnessIssues(sample, candidate.asOf, freshness.value));
    }
  }
  if (issues.length > 0 || !freshness.ok || !isCanonicalUtcTimestamp(candidate.asOf) || !isCanonicalNonEmptyString(candidate.registryId)) {
    return fail(issues);
  }

  const bindingsById = new Map<string, RoomBindingCapabilitySnapshotV1>(
    current?.bindings.map((binding) => [binding.lineage.bindingId, binding]) ?? [],
  );
  let changed = current === null;
  for (const sample of samples.sort((left, right) => compareRoomText(left.lineage.bindingId, right.lineage.bindingId))) {
    const existing = bindingsById.get(sample.lineage.bindingId);
    if (!existing) {
      bindingsById.set(sample.lineage.bindingId, sample);
      changed = true;
      continue;
    }
    if (!sameLineage(existing.lineage, sample.lineage)) {
      issues.push(issue("binding_lineage_mismatch", "$.samples", "A new native-session/provider/model/host lineage requires a new binding generation", { bindingId: sample.lineage.bindingId }));
      continue;
    }
    if (sample.revision < existing.revision) {
      issues.push(issue("stale_revision", "$.samples", "Binding snapshot revision is older than the registry revision", { bindingId: sample.lineage.bindingId }));
      continue;
    }
    if (sample.revision === existing.revision) {
      if (sample.integrityHash !== existing.integrityHash) {
        issues.push(issue("contradictory_revision", "$.samples", "The same binding revision cannot describe two different payloads", { bindingId: sample.lineage.bindingId }));
      }
      continue;
    }
    bindingsById.set(sample.lineage.bindingId, sample);
    changed = true;
  }
  if (issues.length > 0) return fail(issues);
  if (!changed && current) return succeed(current);

  const bindings = [...bindingsById.values()].sort((left, right) => compareRoomText(left.lineage.bindingId, right.lineage.bindingId));
  const registryWithoutHash = {
    contractVersion: ROOM_CAPABILITY_REGISTRY_CONTRACT_VERSION,
    registryId: candidate.registryId,
    revision: current ? current.revision + 1 : 1,
    observedAt: candidate.asOf,
    bindings,
  };
  return succeed({
    ...registryWithoutHash,
    integrityHash: hashRoomValue(registryIntegrityPayload(registryWithoutHash)),
  });
}

interface NormalizedRoutingPolicyV1 {
  readonly freshness: RoomCapabilityFreshnessPolicyV1;
  readonly requirements: RoomCapabilityRoutingRequirementsV1;
  readonly providerLimits: readonly RoomCapabilityProviderLimitV1[];
}

function normalizeRoutingPolicy(value: unknown): RoomCapabilityRegistryResultV1<NormalizedRoutingPolicyV1> {
  if (!isRecord(value)) {
    return fail([issue("invalid_policy", "$", "Routing policy must be an inspectable object")]);
  }
  const issues: RoomCapabilityRegistryIssueV1[] = [];
  const freshness = normalizeFreshnessPolicy(value.freshness);
  if (!freshness.ok) issues.push(...freshness.issues);
  const requirements = value.requirements;
  if (!isRecord(requirements)) {
    issues.push(issue("invalid_policy", "$.requirements", "Routing requirements must be an inspectable object"));
  }
  const normalizedRequirements: RoomCapabilityRoutingRequirementsV1 | undefined = isRecord(requirements)
    ? normalizeRoutingRequirements(requirements, issues)
    : undefined;
  const providerLimits = normalizeProviderLimits(value.providerLimits, issues);
  if (issues.length > 0 || !freshness.ok || !normalizedRequirements || !providerLimits) return fail(issues);
  return succeed({ freshness: freshness.value, requirements: normalizedRequirements, providerLimits });
}

function normalizeRoutingRequirements(
  value: Record<string, unknown>,
  issues: RoomCapabilityRegistryIssueV1[],
): RoomCapabilityRoutingRequirementsV1 | undefined {
  if (!Array.isArray(value.requiredTools) || !value.requiredTools.every(isCanonicalNonEmptyString)) {
    issues.push(issue("invalid_policy", "$.requirements.requiredTools", "Required tools must be canonical strings"));
  }
  const rawTools = Array.isArray(value.requiredTools) && value.requiredTools.every(isCanonicalNonEmptyString)
    ? value.requiredTools
    : undefined;
  const tools = rawTools ? [...new Set(rawTools)].sort(compareRoomText) : undefined;
  if (tools && rawTools && tools.length !== rawTools.length) {
    issues.push(issue("invalid_policy", "$.requirements.requiredTools", "Required tools cannot contain duplicates"));
  }
  if (!isNonNegativeSafeInteger(value.minimumAvailableContextTokens)) {
    issues.push(issue("invalid_policy", "$.requirements.minimumAvailableContextTokens", "Minimum context must be a non-negative safe integer"));
  }
  if (!isCanonicalNonEmptyString(value.domain)) {
    issues.push(issue("invalid_policy", "$.requirements.domain", "Routing domain must be a canonical non-empty string"));
  }
  if (!isPositiveSafeInteger(value.minimumIndependentEvidence)) {
    issues.push(issue("invalid_policy", "$.requirements.minimumIndependentEvidence", "At least one independent quality evidence item is required"));
  }
  if (!isNonNegativeSafeInteger(value.minimumCalibrationOutcomeCount)) {
    issues.push(issue("invalid_policy", "$.requirements.minimumCalibrationOutcomeCount", "Minimum calibration outcomes must be a non-negative safe integer"));
  }
  if (!isUnitInterval(value.minimumQualityScore)) {
    issues.push(issue("invalid_policy", "$.requirements.minimumQualityScore", "Minimum quality must be a score in [0, 1]"));
  }
  if (issues.some((entry) => entry.path.startsWith("$.requirements")) || !tools) return undefined;
  return {
    requiredTools: tools,
    minimumAvailableContextTokens: value.minimumAvailableContextTokens as number,
    domain: value.domain as string,
    minimumIndependentEvidence: value.minimumIndependentEvidence as number,
    minimumCalibrationOutcomeCount: value.minimumCalibrationOutcomeCount as number,
    minimumQualityScore: value.minimumQualityScore as number,
  };
}

function normalizeProviderLimits(
  value: unknown,
  issues: RoomCapabilityRegistryIssueV1[],
): RoomCapabilityProviderLimitV1[] | undefined {
  if (!Array.isArray(value)) {
    issues.push(issue("invalid_policy", "$.providerLimits", "Provider limits must be an array"));
    return undefined;
  }
  const limits: RoomCapabilityProviderLimitV1[] = [];
  const keys = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const path = `$.providerLimits[${index}]`;
    if (
      !isRecord(entry)
      || !isCanonicalNonEmptyString(entry.providerId)
      || !isCanonicalNonEmptyString(entry.accountId)
      || !isPositiveSafeInteger(entry.maxActiveDispatches)
      || !isNonNegativeSafeInteger(entry.activeDispatches)
      || (entry.retryAfterMs !== null && !isPositiveSafeInteger(entry.retryAfterMs))
      || !isCanonicalUtcTimestamp(entry.checkedAt)
    ) {
      issues.push(issue("invalid_policy", path, "Provider limit is malformed"));
      continue;
    }
    const key = `${entry.providerId}\u0000${entry.accountId}`;
    if (keys.has(key)) {
      issues.push(issue("invalid_policy", path, "Provider/account capacity can appear only once"));
      continue;
    }
    keys.add(key);
    limits.push({
      providerId: entry.providerId,
      accountId: entry.accountId,
      maxActiveDispatches: entry.maxActiveDispatches,
      activeDispatches: entry.activeDispatches,
      retryAfterMs: entry.retryAfterMs,
      checkedAt: entry.checkedAt,
    });
  }
  return limits.sort((left, right) => {
    const provider = compareRoomText(left.providerId, right.providerId);
    return provider !== 0 ? provider : compareRoomText(left.accountId, right.accountId);
  });
}

function providerLimitFor(
  snapshot: RoomBindingCapabilitySnapshotV1,
  providerLimits: readonly RoomCapabilityProviderLimitV1[],
): RoomCapabilityProviderLimitV1 | undefined {
  return providerLimits.find((limit) =>
    limit.providerId === snapshot.lineage.providerId
    && limit.accountId === snapshot.lineage.accountId,
  );
}

function qualityFor(
  snapshot: RoomBindingCapabilitySnapshotV1,
  asOf: IsoTimestamp,
  policy: NormalizedRoutingPolicyV1,
  issues: RoomCapabilityRegistryIssueV1[],
): Pick<RoomBindingCapabilityEligibilityV1, "qualityScore" | "independentEvidenceCount" | "calibrationOutcomeCount"> {
  const bindingId = snapshot.lineage.bindingId;
  const quality = snapshot.domainQuality.find((entry) => entry.domain === policy.requirements.domain);
  if (!quality) {
    issues.push(issue("independent_quality_missing", "$.domainQuality", "Binding has no quality evidence for the requested domain", { bindingId }));
    return { qualityScore: null, independentEvidenceCount: 0, calibrationOutcomeCount: 0 };
  }
  const liveEvidence = quality.independentEvidence.filter((evidence) => {
    const stale = timestampFreshnessIssues(
      evidence.observedAt,
      asOf,
      policy.freshness.maxSignalAgeMs,
      policy.freshness.maxFutureSkewMs,
      `$.domainQuality.${quality.domain}.independentEvidence.${evidence.sourceId}.observedAt`,
      bindingId,
      "stale_quality_evidence",
      "stale_quality_evidence",
    );
    issues.push(...stale);
    return stale.length === 0;
  });
  if (liveEvidence.length < policy.requirements.minimumIndependentEvidence) {
    issues.push(issue("independent_quality_missing", "$.domainQuality", "Self-reported quality cannot substitute for the required independent evidence", { bindingId }));
  }
  const calibration = snapshot.calibration.find((entry) => entry.domain === policy.requirements.domain);
  if (!calibration || calibration.outcomeCount < policy.requirements.minimumCalibrationOutcomeCount) {
    issues.push(issue("calibration_missing", "$.calibration", "Binding lacks sufficient calibrated outcomes for the requested domain", { bindingId }));
  }
  if (calibration) {
    issues.push(...timestampFreshnessIssues(
      calibration.observedAt,
      asOf,
      policy.freshness.maxSignalAgeMs,
      policy.freshness.maxFutureSkewMs,
      `$.calibration.${calibration.domain}.observedAt`,
      bindingId,
      "stale_calibration",
      "stale_calibration",
    ));
  }
  if (liveEvidence.length === 0 || !calibration || calibration.outcomeCount < policy.requirements.minimumCalibrationOutcomeCount) {
    return {
      qualityScore: null,
      independentEvidenceCount: liveEvidence.length,
      calibrationOutcomeCount: calibration?.outcomeCount ?? 0,
    };
  }
  const independentMean = liveEvidence.reduce((sum, evidence) => sum + evidence.score, 0) / liveEvidence.length;
  // Stable precision prevents identical replay inputs from ranking differently through IEEE-754 tail noise.
  const qualityScore = Number((independentMean * (1 - calibration.meanAbsoluteError)).toFixed(12));
  if (qualityScore < policy.requirements.minimumQualityScore) {
    issues.push(issue("quality_below_threshold", "$.domainQuality", "Calibrated independent quality is below the routing threshold", { bindingId }));
  }
  return {
    qualityScore,
    independentEvidenceCount: liveEvidence.length,
    calibrationOutcomeCount: calibration.outcomeCount,
  };
}

function evaluateCapabilitySnapshot(
  snapshot: RoomBindingCapabilitySnapshotV1,
  asOf: IsoTimestamp,
  policy: NormalizedRoutingPolicyV1,
): RoomBindingCapabilityEligibilityV1 {
  const bindingId = snapshot.lineage.bindingId;
  const issues = snapshotFreshnessIssues(snapshot, asOf, policy.freshness);
  if (snapshot.health.connectorState !== "healthy") {
    issues.push(issue("health_not_healthy", "$.health.connectorState", "Only healthy connector bindings are eligible for new routing", { bindingId }));
  }
  if (snapshot.health.hostState !== "healthy") {
    issues.push(issue("host_not_healthy", "$.health.hostState", "Only healthy hosts are eligible for new routing", { bindingId }));
  }
  if (snapshot.rateLimit.state !== "clear") {
    issues.push(issue("rate_limited", "$.rateLimit.state", "Bindings with unknown or limited rate state fail closed for new routing", { bindingId }));
  }
  const providerLimit = providerLimitFor(snapshot, policy.providerLimits);
  if (!providerLimit) {
    issues.push(issue("provider_limit_unknown", "$.providerLimits", "Provider/account dispatch capacity must be explicit", { bindingId, providerId: snapshot.lineage.providerId }));
  } else {
    issues.push(...timestampFreshnessIssues(
      providerLimit.checkedAt,
      asOf,
      policy.freshness.maxSignalAgeMs,
      policy.freshness.maxFutureSkewMs,
      "$.providerLimits.checkedAt",
      bindingId,
      "stale_provider_limit",
      "stale_provider_limit",
    ));
    if (providerLimit.retryAfterMs !== null || providerLimit.activeDispatches >= providerLimit.maxActiveDispatches) {
      issues.push(issue("provider_capacity_exhausted", "$.providerLimits", "Provider/account dispatch capacity is exhausted or paused", { bindingId, providerId: snapshot.lineage.providerId }));
    }
  }
  if (snapshot.context.availableTokens < policy.requirements.minimumAvailableContextTokens) {
    issues.push(issue("insufficient_context", "$.context.availableTokens", "Binding does not have the required free context capacity", { bindingId }));
  }
  const tools = new Map(snapshot.tools.map((tool) => [tool.name, tool.state]));
  for (const requiredTool of policy.requirements.requiredTools) {
    if (tools.get(requiredTool) !== "verified") {
      issues.push(issue("required_tool_unavailable", `$.tools.${requiredTool}`, "Required tool is not currently verified", { bindingId }));
    }
  }
  const quality = qualityFor(snapshot, asOf, policy, issues);
  return deepFreeze({
    bindingId,
    eligible: issues.length === 0 && quality.qualityScore !== null,
    ...quality,
    issues: sortIssues(issues),
  });
}

/**
 * FNXC:RoomCapabilityRegistry 2026-07-19-08:07:
 * Recommendation is quality-first but fail-closed. A model's self-reported
 * score is intentionally never read: only fresh independent evidence, its
 * calibration, current certified tools, context, health, and provider capacity
 * may make a concrete binding eligible for a new turn.
 */
export function evaluateRoomBindingCapability(
  input: EvaluateRoomBindingCapabilityInputV1,
): RoomCapabilityRegistryResultV1<RoomBindingCapabilityEligibilityV1> {
  const candidate = input as unknown;
  if (!isRecord(candidate) || !isCanonicalUtcTimestamp(candidate.asOf)) {
    return fail([issue("invalid_policy", "$.asOf", "Eligibility evaluation requires a canonical UTC decision time")]);
  }
  const snapshot = validateRoomBindingCapabilitySnapshot(candidate.snapshot);
  if (!snapshot.ok) return snapshot;
  const policy = normalizeRoutingPolicy(candidate.policy);
  if (!policy.ok) return policy;
  return succeed(evaluateCapabilitySnapshot(snapshot.value, candidate.asOf, policy.value));
}

export function recommendRoomCapabilityBindings(
  input: RecommendRoomCapabilityBindingsInputV1,
): RoomCapabilityRegistryResultV1<RoomCapabilityRecommendationSetV1> {
  const candidate = input as unknown;
  if (!isRecord(candidate) || !isCanonicalUtcTimestamp(candidate.asOf)) {
    return fail([issue("invalid_policy", "$.asOf", "Recommendation requires a canonical UTC decision time")]);
  }
  const registry = validateRoomCapabilityRegistry(candidate.registry);
  if (!registry.ok) return registry;
  const policy = normalizeRoutingPolicy(candidate.policy);
  if (!policy.ok) return policy;
  const asOf = candidate.asOf as IsoTimestamp;
  const evaluated = registry.value.bindings.map((binding) =>
    evaluateCapabilitySnapshot(binding, asOf, policy.value),
  );
  const recommendations = evaluated
    .filter((entry) => entry.eligible && entry.qualityScore !== null)
    .map((entry) => {
      const snapshot = registry.value.bindings.find((binding) => binding.lineage.bindingId === entry.bindingId)!;
      return {
        bindingId: entry.bindingId,
        providerId: snapshot.lineage.providerId,
        modelId: snapshot.lineage.modelId,
        qualityScore: entry.qualityScore!,
        latencyP95Ms: snapshot.latency.p95Ms,
        availableContextTokens: snapshot.context.availableTokens,
      };
    })
    .sort((left, right) => {
      const quality = right.qualityScore - left.qualityScore;
      if (quality !== 0) return quality;
      const latency = left.latencyP95Ms - right.latencyP95Ms;
      if (latency !== 0) return latency;
      const context = right.availableContextTokens - left.availableContextTokens;
      if (context !== 0) return context;
      return compareRoomText(left.bindingId, right.bindingId);
    });
  const rejected = evaluated
    .filter((entry) => !entry.eligible)
    .sort((left, right) => compareRoomText(left.bindingId, right.bindingId));
  return succeed({ recommendations, rejected });
}

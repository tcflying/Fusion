import type { IsoTimestamp, RoomBindingId } from "./room-contracts/ids.js";
import type {
  RoomCapabilitySnapshotInputV1,
  RoomCapabilitySnapshotV1,
} from "./room-contracts/assignment.js";
import type {
  RoomBindingCapabilityLineageV1,
  RoomBindingCapabilitySnapshotV1,
  RoomCapabilityFreshnessPolicyV1,
  RoomCapabilityRegistryIssueV1,
  RoomCapabilityRegistryV1,
} from "./room-capability-registry.js";
import {
  ROOM_CAPABILITY_REGISTRY_CONTRACT_VERSION,
  validateRoomBindingCapabilitySnapshot,
} from "./room-capability-registry.js";
import { compareRoomText, hashRoomValue } from "./room-integrity.js";
import { createRoomCapabilitySnapshot } from "./room-role-assignment.js";

export type RoomCapabilityAssignmentAdapterIssueCode =
  | RoomCapabilityRegistryIssueV1["code"]
  | "invalid_input"
  | "stale_registry"
  | "future_registry"
  | "unsafe_binding_health"
  | "unsafe_rate_limit"
  | "unsafe_context"
  | "assignment_snapshot_rejected";

export interface RoomCapabilityAssignmentAdapterIssueV1 {
  readonly code: RoomCapabilityAssignmentAdapterIssueCode;
  readonly path: string;
  readonly message: string;
  readonly bindingId?: RoomBindingId;
}

export type RoomCapabilityAssignmentAdapterResultV1<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly RoomCapabilityAssignmentAdapterIssueV1[] };

export interface AdaptRoomCapabilityRegistryToAssignmentSnapshotInputV1 {
  readonly registry: RoomCapabilityRegistryV1;
  /** Caller-injected decision time; this adapter never reads a mutable clock. */
  readonly asOf: IsoTimestamp;
  readonly freshness: RoomCapabilityFreshnessPolicyV1;
}

/**
 * The legacy assignment snapshot intentionally carries only binding identity
 * and certified capabilities. Keep the exact source lineage beside it so a
 * later caller never has to infer provider/account/model/session identity.
 */
export interface RoomCapabilityAssignmentAdaptedSnapshotV1 {
  readonly capabilitySnapshot: RoomCapabilitySnapshotV1;
  readonly bindingLineages: readonly RoomBindingCapabilityLineageV1[];
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

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function issue(
  code: RoomCapabilityAssignmentAdapterIssueCode,
  path: string,
  message: string,
  bindingId?: RoomBindingId,
): RoomCapabilityAssignmentAdapterIssueV1 {
  return bindingId === undefined
    ? { code, path, message }
    : { code, path, message, bindingId };
}

function sortIssues(
  issues: readonly RoomCapabilityAssignmentAdapterIssueV1[],
): RoomCapabilityAssignmentAdapterIssueV1[] {
  return [...issues].sort((left, right) => {
    const code = compareRoomText(left.code, right.code);
    if (code !== 0) return code;
    const path = compareRoomText(left.path, right.path);
    if (path !== 0) return path;
    const message = compareRoomText(left.message, right.message);
    if (message !== 0) return message;
    return compareRoomText(left.bindingId ?? "", right.bindingId ?? "");
  });
}

function fail<T>(
  issues: readonly RoomCapabilityAssignmentAdapterIssueV1[],
): RoomCapabilityAssignmentAdapterResultV1<T> {
  return deepFreeze({ ok: false, issues: sortIssues(issues) });
}

function succeed<T>(value: T): RoomCapabilityAssignmentAdapterResultV1<T> {
  return deepFreeze({ ok: true, value: deepFreeze(value) });
}

function rebaseRegistryIssue(
  source: RoomCapabilityRegistryIssueV1,
  basePath: string,
): RoomCapabilityAssignmentAdapterIssueV1 {
  const path = source.path === "$"
    ? basePath
    : source.path.startsWith("$.")
      ? `${basePath}${source.path.slice(1)}`
      : basePath;
  return issue(source.code, path, source.message, source.bindingId);
}

function registryIntegrityPayload(
  registry: Omit<RoomCapabilityRegistryV1, "integrityHash">,
): Record<string, unknown> {
  return {
    contractVersion: registry.contractVersion,
    registryId: registry.registryId,
    revision: registry.revision,
    observedAt: registry.observedAt,
    bindingIntegrityHashes: registry.bindings.map((binding) => binding.integrityHash),
  };
}

function normalizeRegistry(
  value: unknown,
): RoomCapabilityAssignmentAdapterResultV1<RoomCapabilityRegistryV1> {
  if (!isRecord(value)) {
    return fail([issue("invalid_registry", "$.registry", "Capability registry must be an inspectable object")]);
  }

  const issues: RoomCapabilityAssignmentAdapterIssueV1[] = [];
  if (value.contractVersion !== ROOM_CAPABILITY_REGISTRY_CONTRACT_VERSION) {
    issues.push(issue("invalid_registry", "$.registry.contractVersion", "Only registry contract version 1 is supported"));
  }
  if (!isCanonicalNonEmptyString(value.registryId)) {
    issues.push(issue("invalid_registry", "$.registry.registryId", "Registry identity must be a canonical non-empty string"));
  }
  if (!isPositiveSafeInteger(value.revision)) {
    issues.push(issue("invalid_registry", "$.registry.revision", "Registry revision must be a positive safe integer"));
  }
  if (!isCanonicalUtcTimestamp(value.observedAt)) {
    issues.push(issue("invalid_registry", "$.registry.observedAt", "Registry observation time must be canonical UTC"));
  }
  if (!Array.isArray(value.bindings)) {
    issues.push(issue("invalid_registry", "$.registry.bindings", "Registry bindings must be an array"));
  }
  if (!isCanonicalNonEmptyString(value.integrityHash)) {
    issues.push(issue("registry_integrity_mismatch", "$.registry.integrityHash", "A received registry requires an integrity hash"));
  }

  const bindings: RoomBindingCapabilitySnapshotV1[] = [];
  const seenBindingIds = new Set<string>();
  if (Array.isArray(value.bindings)) {
    for (let index = 0; index < value.bindings.length; index += 1) {
      const validated = validateRoomBindingCapabilitySnapshot(value.bindings[index]);
      if (!validated.ok) {
        issues.push(...validated.issues.map((entry) => rebaseRegistryIssue(entry, `$.registry.bindings[${index}]`)));
        continue;
      }
      const bindingId = validated.value.lineage.bindingId;
      if (seenBindingIds.has(bindingId)) {
        issues.push(issue(
          "duplicate_binding_snapshot",
          `$.registry.bindings[${index}]`,
          "Registry cannot contain the same binding twice",
          bindingId,
        ));
        continue;
      }
      seenBindingIds.add(bindingId);
      bindings.push(validated.value);
    }
  }
  bindings.sort((left, right) => compareRoomText(left.lineage.bindingId, right.lineage.bindingId));

  if (issues.length > 0) return fail(issues);
  const registryWithoutHash: Omit<RoomCapabilityRegistryV1, "integrityHash"> = {
    contractVersion: ROOM_CAPABILITY_REGISTRY_CONTRACT_VERSION,
    registryId: value.registryId as string,
    revision: value.revision as number,
    observedAt: value.observedAt as IsoTimestamp,
    bindings,
  };
  const expectedHash = hashRoomValue(registryIntegrityPayload(registryWithoutHash));
  if (value.integrityHash !== expectedHash) {
    return fail([issue(
      "registry_integrity_mismatch",
      "$.registry.integrityHash",
      "Registry payload does not match its integrity hash",
    )]);
  }
  return succeed({ ...registryWithoutHash, integrityHash: expectedHash });
}

function normalizeFreshnessPolicy(
  value: unknown,
): RoomCapabilityAssignmentAdapterResultV1<RoomCapabilityFreshnessPolicyV1> {
  if (!isRecord(value)) {
    return fail([issue("invalid_input", "$.freshness", "Freshness policy must be an inspectable object")]);
  }
  const issues: RoomCapabilityAssignmentAdapterIssueV1[] = [];
  if (!isPositiveSafeInteger(value.maxSnapshotAgeMs)) {
    issues.push(issue("invalid_input", "$.freshness.maxSnapshotAgeMs", "Snapshot age must be a positive safe integer"));
  }
  if (!isPositiveSafeInteger(value.maxSignalAgeMs)) {
    issues.push(issue("invalid_input", "$.freshness.maxSignalAgeMs", "Signal age must be a positive safe integer"));
  }
  if (!isNonNegativeSafeInteger(value.maxFutureSkewMs)) {
    issues.push(issue("invalid_input", "$.freshness.maxFutureSkewMs", "Future skew must be a non-negative safe integer"));
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
  bindingId: RoomBindingId | undefined,
  staleCode: RoomCapabilityAssignmentAdapterIssueCode,
  futureCode: RoomCapabilityAssignmentAdapterIssueCode,
): RoomCapabilityAssignmentAdapterIssueV1[] {
  const deltaMs = Date.parse(asOf) - Date.parse(timestamp);
  if (deltaMs < -maxFutureSkewMs) {
    return [issue(futureCode, path, "Measurement is too far in the future for a deterministic assignment decision", bindingId)];
  }
  if (deltaMs > maxAgeMs) {
    return [issue(staleCode, path, "Measurement is older than the configured assignment freshness window", bindingId)];
  }
  return [];
}

function bindingFreshnessIssues(
  binding: RoomBindingCapabilitySnapshotV1,
  asOf: IsoTimestamp,
  policy: RoomCapabilityFreshnessPolicyV1,
): RoomCapabilityAssignmentAdapterIssueV1[] {
  const bindingId = binding.lineage.bindingId;
  const basePath = `$.registry.bindings[${bindingId}]`;
  const issues = timestampFreshnessIssues(
    binding.freshness.capturedAt,
    asOf,
    policy.maxSnapshotAgeMs,
    policy.maxFutureSkewMs,
    `${basePath}.freshness.capturedAt`,
    bindingId,
    "stale_snapshot",
    "future_snapshot",
  );
  if (Date.parse(asOf) > Date.parse(binding.freshness.expiresAt)) {
    issues.push(issue(
      "snapshot_expired",
      `${basePath}.freshness.expiresAt`,
      "Snapshot has reached its declared expiry",
      bindingId,
    ));
  }
  for (const [path, observedAt] of [
    ["context.observedAt", binding.context.observedAt],
    ["health.observedAt", binding.health.observedAt],
    ["latency.observedAt", binding.latency.observedAt],
    ["rateLimit.observedAt", binding.rateLimit.observedAt],
  ] as const) {
    issues.push(...timestampFreshnessIssues(
      observedAt,
      asOf,
      policy.maxSignalAgeMs,
      policy.maxFutureSkewMs,
      `${basePath}.${path}`,
      bindingId,
      "stale_signal",
      "future_signal",
    ));
  }
  return issues;
}

function bindingSafetyIssues(
  binding: RoomBindingCapabilitySnapshotV1,
): RoomCapabilityAssignmentAdapterIssueV1[] {
  const bindingId = binding.lineage.bindingId;
  const basePath = `$.registry.bindings[${bindingId}]`;
  const issues: RoomCapabilityAssignmentAdapterIssueV1[] = [];
  if (binding.health.connectorState !== "healthy") {
    issues.push(issue(
      "unsafe_binding_health",
      `${basePath}.health.connectorState`,
      "Assignment requires a healthy connector",
      bindingId,
    ));
  }
  if (binding.health.hostState !== "healthy") {
    issues.push(issue(
      "unsafe_binding_health",
      `${basePath}.health.hostState`,
      "Assignment requires a healthy host",
      bindingId,
    ));
  }
  if (binding.rateLimit.state !== "clear") {
    issues.push(issue(
      "unsafe_rate_limit",
      `${basePath}.rateLimit.state`,
      "Assignment requires a known clear rate-limit state",
      bindingId,
    ));
  }
  if (binding.context.availableTokens === 0) {
    issues.push(issue(
      "unsafe_context",
      `${basePath}.context.availableTokens`,
      "Assignment cannot discard a binding with no available context capacity",
      bindingId,
    ));
  }
  return issues;
}

function cloneLineage(lineage: RoomBindingCapabilityLineageV1): RoomBindingCapabilityLineageV1 {
  return {
    bindingId: lineage.bindingId,
    bindingGeneration: lineage.bindingGeneration,
    providerId: lineage.providerId,
    accountId: lineage.accountId,
    modelId: lineage.modelId,
    connectorId: lineage.connectorId,
    nativeSessionId: lineage.nativeSessionId,
    hostId: lineage.hostId,
  };
}

/**
 * Convert one fresh, signed capability registry into the pre-existing role
 * assignment snapshot contract. The conversion is all-or-nothing: it rejects
 * invalid, stale, depleted, or unsafe source evidence rather than fabricating
 * legacy availability. Provider/account/model data remains only in the exact,
 * detached lineage sidecar.
 */
export function adaptRoomCapabilityRegistryToAssignmentSnapshot(
  input: AdaptRoomCapabilityRegistryToAssignmentSnapshotInputV1,
): RoomCapabilityAssignmentAdapterResultV1<RoomCapabilityAssignmentAdaptedSnapshotV1> {
  const candidate = input as unknown;
  if (!isRecord(candidate)) {
    return fail([issue("invalid_input", "$", "Capability-assignment adapter input must be an inspectable object")]);
  }
  if (!isCanonicalUtcTimestamp(candidate.asOf)) {
    return fail([issue("invalid_input", "$.asOf", "Decision time must be canonical UTC")]);
  }

  const freshness = normalizeFreshnessPolicy(candidate.freshness);
  if (!freshness.ok) return freshness;
  const registry = normalizeRegistry(candidate.registry);
  if (!registry.ok) return registry;

  const issues = timestampFreshnessIssues(
    registry.value.observedAt,
    candidate.asOf,
    freshness.value.maxSnapshotAgeMs,
    freshness.value.maxFutureSkewMs,
    "$.registry.observedAt",
    undefined,
    "stale_registry",
    "future_registry",
  );
  for (const binding of registry.value.bindings) {
    issues.push(...bindingFreshnessIssues(binding, candidate.asOf, freshness.value));
    issues.push(...bindingSafetyIssues(binding));
  }
  if (issues.length > 0) return fail(issues);

  const snapshotInput: RoomCapabilitySnapshotInputV1 = {
    contractVersion: 1,
    snapshotId: registry.value.registryId,
    revision: registry.value.revision,
    capturedAt: registry.value.observedAt,
    bindings: registry.value.bindings.map((binding) => ({
      bindingId: binding.lineage.bindingId,
      availability: "eligible",
      capabilityRevision: binding.freshness.sourceRevision,
      capabilities: binding.tools.map((tool) => ({
        name: tool.name,
        state: tool.state,
      })),
    })),
  };
  const capabilitySnapshot = createRoomCapabilitySnapshot(snapshotInput);
  if (!capabilitySnapshot.ok) {
    return fail(capabilitySnapshot.unsatisfied.map((entry) => issue(
      "assignment_snapshot_rejected",
      entry.path === "$" ? "$.capabilitySnapshot" : `$.capabilitySnapshot${entry.path.slice(1)}`,
      entry.message,
      entry.bindingId,
    )));
  }

  return succeed({
    capabilitySnapshot: capabilitySnapshot.value,
    bindingLineages: registry.value.bindings.map((binding) => cloneLineage(binding.lineage)),
  });
}

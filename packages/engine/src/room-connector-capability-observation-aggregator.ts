import {
  RoomCapabilityRegistry,
  type RoomBindingRecordV1,
  type SessionConnectorIdentityV1,
} from "@fusion/core";
import {
  createRoomBindingCapabilityReport,
  type CreateRoomBindingCapabilityReportInputV1,
  type RoomBindingCapabilityReporterFreshnessV1,
  type RoomBindingCapabilityReporterIssueCode,
  type TrustedRoomBindingCapabilityTargetV1,
} from "./room-binding-capability-reporter.js";
import { isRoomConnectorCapabilitySnapshotSchedulable } from "./room-connector-runtime-observation-reporter.js";
import {
  MAX_ROOM_CAPABILITY_REGISTRY_UPDATE_SAMPLES,
  ROOM_CAPABILITY_REGISTRY_UPDATER_CONTRACT_VERSION,
  type RoomCapabilityRegistrySchedulingStateV1,
  type RoomCapabilityRegistryUpdateInputV1,
  type RoomCapabilityRegistryUpdateSampleV1,
} from "./room-capability-registry-updater.js";

export const ROOM_CONNECTOR_CAPABILITY_OBSERVATION_AGGREGATOR_CONTRACT_VERSION = 1 as const;

const ACTIVE_CONCRETE_BINDING_STATES = new Set<RoomBindingRecordV1["state"]>([
  "attached",
  "paused",
  "authentication_blocked",
  "host_unavailable",
  "delivery_uncertain",
]);
const CORE_ACTIVE_BINDING_STATES = new Set<RoomBindingRecordV1["state"]>([
  "pending",
  ...ACTIVE_CONCRETE_BINDING_STATES,
]);

type RuntimeRecord = Record<string, unknown>;
type CapabilityRegistrySnapshotV1 = RoomCapabilityRegistry.RoomBindingCapabilitySnapshotV1;

export type RoomConnectorCapabilityObservationRegistryUpdateV1 = Pick<
  RoomCapabilityRegistryUpdateInputV1,
  | "expectedAggregateVersion"
  | "expectedRegistryRevision"
  | "roomWorkerFence"
  | "idempotencyKey"
  | "freshness"
>;

/**
 * The controller supplies both the authoritative active-binding set and the
 * corresponding already-trusted concrete observations. This module never
 * queries a SessionConnector or fills in unknown capability fields.
 */
export interface RoomConnectorCapabilityObservationAggregationInputV1 {
  readonly contractVersion: typeof ROOM_CONNECTOR_CAPABILITY_OBSERVATION_AGGREGATOR_CONTRACT_VERSION;
  readonly projectId: string;
  readonly roomId: string;
  /** One caller-selected decision time that every report must use exactly. */
  readonly asOf: string;
  readonly reportFreshness: RoomBindingCapabilityReporterFreshnessV1;
  readonly registryUpdate: RoomConnectorCapabilityObservationRegistryUpdateV1;
  /**
   * Controller-owned complete Room binding projection. This is authoritative
   * for the active-set comparison; activeBindings below cannot self-select a
   * convenient subset when a registry revision already exists.
   */
  readonly roomBindings: readonly RoomBindingRecordV1[];
  readonly activeBindings: readonly TrustedRoomBindingCapabilityTargetV1[];
  readonly observations: readonly RoomCapabilityRegistryUpdateSampleV1[];
}

export type RoomConnectorCapabilityObservationAggregatorIssueCodeV1 =
  | "invalid_input"
  | "active_binding_limit_exceeded"
  | "sample_limit_exceeded"
  | "invalid_active_binding"
  | "invalid_room_binding"
  | "duplicate_room_binding"
  | "unknown_active_binding"
  | "missing_active_binding"
  | "unobservable_active_binding"
  | "duplicate_active_binding"
  | "untrusted_sample"
  | "sample_time_mismatch"
  | "sample_freshness_mismatch"
  | "sample_scope_mismatch"
  | "unknown_binding_sample"
  | "duplicate_binding_sample"
  | "binding_identity_mismatch"
  | "missing_binding_sample";

export type RoomConnectorCapabilityObservationAggregatorIssueV1 =
  | {
    readonly source: "aggregator";
    readonly code: RoomConnectorCapabilityObservationAggregatorIssueCodeV1;
    readonly path: string;
    readonly message: string;
  }
  | {
    readonly source: "reporter";
    readonly code: RoomBindingCapabilityReporterIssueCode;
    readonly path: string;
    readonly message: string;
  };

export type RoomConnectorCapabilityObservationAggregationResultV1 =
  | {
    readonly ok: true;
    readonly outcome: "aggregated";
    readonly scheduling: RoomCapabilityRegistrySchedulingStateV1;
    readonly update: RoomCapabilityRegistryUpdateInputV1;
  }
  | {
    readonly ok: false;
    readonly outcome: "withheld";
    readonly scheduling: "not_schedulable";
    readonly projectId: string | null;
    readonly roomId: string | null;
    readonly asOf: string | null;
    readonly update: null;
    readonly reason: {
      readonly code: RoomConnectorCapabilityObservationAggregatorIssueV1["code"];
      readonly message: string;
    };
    readonly issues: readonly RoomConnectorCapabilityObservationAggregatorIssueV1[];
  };

interface ActiveBindingV1 {
  readonly target: TrustedRoomBindingCapabilityTargetV1;
  readonly bindingId: string;
}

interface RoomBindingV1 {
  readonly binding: RoomBindingRecordV1;
  readonly bindingId: string;
}

interface ValidatedObservationV1 {
  readonly bindingId: string;
  readonly binding: RoomBindingRecordV1;
  readonly snapshot: CapabilityRegistrySnapshotV1;
  readonly sample: RoomCapabilityRegistryUpdateSampleV1;
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

function isRecord(value: unknown): value is RuntimeRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isNullableCanonicalText(value: unknown): value is string | null {
  return value === null || isCanonicalText(value);
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

function aggregatorIssue(
  code: RoomConnectorCapabilityObservationAggregatorIssueCodeV1,
  path: string,
  message: string,
): RoomConnectorCapabilityObservationAggregatorIssueV1 {
  return { source: "aggregator", code, path, message };
}

function reporterIssue(
  code: RoomBindingCapabilityReporterIssueCode,
  path: string,
  message: string,
): RoomConnectorCapabilityObservationAggregatorIssueV1 {
  return { source: "reporter", code, path, message };
}

function sortIssues(
  issues: readonly RoomConnectorCapabilityObservationAggregatorIssueV1[],
): readonly RoomConnectorCapabilityObservationAggregatorIssueV1[] {
  return [...issues].sort((left, right) => {
    const source = left.source.localeCompare(right.source);
    if (source !== 0) return source;
    const code = left.code.localeCompare(right.code);
    return code === 0 ? left.path.localeCompare(right.path) : code;
  });
}

function inputReferences(rawInput: unknown): {
  readonly projectId: string | null;
  readonly roomId: string | null;
  readonly asOf: string | null;
} {
  if (!isRecord(rawInput)) return { projectId: null, roomId: null, asOf: null };
  return {
    projectId: isCanonicalText(rawInput.projectId) ? rawInput.projectId : null,
    roomId: isCanonicalText(rawInput.roomId) ? rawInput.roomId : null,
    asOf: isCanonicalTimestamp(rawInput.asOf) ? rawInput.asOf : null,
  };
}

function withheld(
  rawInput: unknown,
  rawIssues: readonly RoomConnectorCapabilityObservationAggregatorIssueV1[],
): Extract<RoomConnectorCapabilityObservationAggregationResultV1, { readonly outcome: "withheld" }> {
  const issues = sortIssues(rawIssues);
  const reason = issues[0] ?? aggregatorIssue(
    "invalid_input",
    "$",
    "Capability observation aggregation could not prove a complete update",
  );
  return deepFreeze({
    ok: false,
    outcome: "withheld",
    scheduling: "not_schedulable",
    ...inputReferences(rawInput),
    update: null,
    reason: { code: reason.code, message: reason.message },
    issues,
  });
}

function bindingIdentity(binding: RoomBindingRecordV1): SessionConnectorIdentityV1 {
  return {
    connectorId: binding.connectorId,
    providerId: binding.providerId,
    nativeSessionId: binding.nativeSessionId,
    happierSessionId: binding.happierSessionId,
    serverProfileId: binding.serverProfileId,
    machineId: binding.machineId,
    hostId: binding.hostId,
  };
}

function sameIdentity(left: SessionConnectorIdentityV1, right: SessionConnectorIdentityV1): boolean {
  return left.connectorId === right.connectorId
    && left.providerId === right.providerId
    && left.nativeSessionId === right.nativeSessionId
    && left.happierSessionId === right.happierSessionId
    && left.serverProfileId === right.serverProfileId
    && left.machineId === right.machineId
    && left.hostId === right.hostId;
}

function sameBinding(left: RoomBindingRecordV1, right: RoomBindingRecordV1): boolean {
  return left.contractVersion === right.contractVersion
    && left.id === right.id
    && left.roomId === right.roomId
    && left.seatId === right.seatId
    && left.generation === right.generation
    && sameIdentity(bindingIdentity(left), bindingIdentity(right))
    && left.state === right.state
    && left.attachedAt === right.attachedAt
    && left.detachedAt === right.detachedAt
    && left.replacedByBindingId === right.replacedByBindingId;
}

function sameTarget(
  left: TrustedRoomBindingCapabilityTargetV1,
  right: TrustedRoomBindingCapabilityTargetV1,
): boolean {
  return left.projectId === right.projectId
    && left.roomId === right.roomId
    && sameBinding(left.binding, right.binding)
    && left.runtime.source === right.runtime.source
    && sameIdentity(left.runtime.identity, right.runtime.identity)
    && left.runtime.accountId === right.runtime.accountId
    && left.runtime.modelId === right.runtime.modelId
    && left.runtime.observedAt === right.runtime.observedAt;
}

function sameFreshness(left: unknown, right: unknown): boolean {
  return isRecord(left)
    && isRecord(right)
    && left.maxObservationAgeMs === right.maxObservationAgeMs
    && left.maxFutureSkewMs === right.maxFutureSkewMs;
}

function validateIdentity(
  value: unknown,
  path: string,
  issues: RoomConnectorCapabilityObservationAggregatorIssueV1[],
): value is SessionConnectorIdentityV1 {
  if (!isRecord(value)) {
    issues.push(aggregatorIssue("invalid_active_binding", path, "Binding identity must be an inspectable object"));
    return false;
  }
  for (const field of ["connectorId", "providerId", "nativeSessionId", "hostId"] as const) {
    if (!isCanonicalText(value[field])) {
      issues.push(aggregatorIssue("invalid_active_binding", `${path}.${field}`, "Binding identity must use canonical text"));
    }
  }
  for (const field of ["happierSessionId", "serverProfileId", "machineId"] as const) {
    if (!isNullableCanonicalText(value[field])) {
      issues.push(aggregatorIssue("invalid_active_binding", `${path}.${field}`, "Binding identity must use canonical text or null"));
    }
  }
  return true;
}

function normalizeActiveBinding(
  value: unknown,
  index: number,
  projectId: string,
  roomId: string,
  issues: RoomConnectorCapabilityObservationAggregatorIssueV1[],
): ActiveBindingV1 | null {
  const path = `$.activeBindings[${index}]`;
  const start = issues.length;
  if (!isRecord(value)) {
    issues.push(aggregatorIssue("invalid_active_binding", path, "Active binding target must be an inspectable object"));
    return null;
  }
  if (value.projectId !== projectId || value.roomId !== roomId) {
    issues.push(aggregatorIssue("invalid_active_binding", path, "Active binding target must match the controller project and Room"));
  }
  if (!isRecord(value.binding)) {
    issues.push(aggregatorIssue("invalid_active_binding", `${path}.binding`, "Active binding must be an inspectable object"));
  }
  if (!isRecord(value.runtime)) {
    issues.push(aggregatorIssue("invalid_active_binding", `${path}.runtime`, "Active runtime identity must be an inspectable object"));
  }
  if (!isRecord(value.binding) || !isRecord(value.runtime)) return null;

  const binding = value.binding;
  const runtime = value.runtime;
  if (binding.contractVersion !== 1) {
    issues.push(aggregatorIssue("invalid_active_binding", `${path}.binding.contractVersion`, "Only binding contract version 1 is supported"));
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
    if (!isCanonicalText(binding[field])) {
      issues.push(aggregatorIssue("invalid_active_binding", `${path}.binding.${field}`, "Active binding must use canonical text"));
    }
  }
  for (const field of ["happierSessionId", "serverProfileId", "machineId"] as const) {
    if (!isNullableCanonicalText(binding[field])) {
      issues.push(aggregatorIssue("invalid_active_binding", `${path}.binding.${field}`, "Active binding identity must use canonical text or null"));
    }
  }
  if (!isPositiveSafeInteger(binding.generation)) {
    issues.push(aggregatorIssue("invalid_active_binding", `${path}.binding.generation`, "Binding generation must be a positive safe integer"));
  }
  if (binding.roomId !== roomId) {
    issues.push(aggregatorIssue("invalid_active_binding", `${path}.binding.roomId`, "Active binding must belong to the requested Room"));
  }
  if (!ACTIVE_CONCRETE_BINDING_STATES.has(binding.state as RoomBindingRecordV1["state"])) {
    issues.push(aggregatorIssue("invalid_active_binding", `${path}.binding.state`, "Only a current concrete binding can be aggregated"));
  }
  if (!isCanonicalTimestamp(binding.attachedAt) || binding.detachedAt !== null) {
    issues.push(aggregatorIssue("invalid_active_binding", `${path}.binding`, "Active binding must have a canonical attachment time and no detachment"));
  }
  if (binding.replacedByBindingId !== null && !isCanonicalText(binding.replacedByBindingId)) {
    issues.push(aggregatorIssue("invalid_active_binding", `${path}.binding.replacedByBindingId`, "Replacement binding identifier must be canonical text or null"));
  }

  if (runtime.source !== "trusted_session_connector_binding") {
    issues.push(aggregatorIssue("invalid_active_binding", `${path}.runtime.source`, "Active runtime must come from the trusted connector-binding boundary"));
  }
  const identityValid = validateIdentity(runtime.identity, `${path}.runtime.identity`, issues);
  for (const field of ["accountId", "modelId"] as const) {
    if (!isCanonicalText(runtime[field])) {
      issues.push(aggregatorIssue("invalid_active_binding", `${path}.runtime.${field}`, "Active runtime must use canonical text"));
    }
  }
  if (!isCanonicalTimestamp(runtime.observedAt)) {
    issues.push(aggregatorIssue("invalid_active_binding", `${path}.runtime.observedAt`, "Active runtime observation time must be canonical UTC"));
  }

  if (issues.length !== start || !identityValid) return null;
  const target = value as unknown as TrustedRoomBindingCapabilityTargetV1;
  if (!sameIdentity(bindingIdentity(target.binding), target.runtime.identity)) {
    issues.push(aggregatorIssue("invalid_active_binding", `${path}.runtime.identity`, "Runtime identity must exactly match the active binding"));
    return null;
  }
  return { target, bindingId: target.binding.id };
}

function normalizeRoomBinding(
  value: unknown,
  index: number,
  roomId: string,
  issues: RoomConnectorCapabilityObservationAggregatorIssueV1[],
): RoomBindingV1 | null {
  const path = `$.roomBindings[${index}]`;
  if (!isRecord(value)) {
    issues.push(aggregatorIssue("invalid_room_binding", path, "Room binding must be an inspectable object"));
    return null;
  }
  if (
    value.contractVersion !== 1
    || !isCanonicalText(value.id)
    || value.roomId !== roomId
  ) {
    issues.push(aggregatorIssue(
      "invalid_room_binding",
      path,
      "Room binding must be a current binding in the requested Room",
    ));
    return null;
  }
  if (!CORE_ACTIVE_BINDING_STATES.has(value.state as RoomBindingRecordV1["state"])) {
    if (["detached", "replaced", "failed"].includes(value.state as string)) return null;
    issues.push(aggregatorIssue("invalid_room_binding", `${path}.state`, "Room binding state is unsupported"));
    return null;
  }
  return { binding: value as unknown as RoomBindingRecordV1, bindingId: value.id as string };
}

function validateRegistryUpdate(
  value: unknown,
  issues: RoomConnectorCapabilityObservationAggregatorIssueV1[],
): value is RoomConnectorCapabilityObservationRegistryUpdateV1 {
  if (!isRecord(value)) {
    issues.push(aggregatorIssue("invalid_input", "$.registryUpdate", "Registry update metadata must be an inspectable object"));
    return false;
  }
  if (!isNonNegativeSafeInteger(value.expectedAggregateVersion)) {
    issues.push(aggregatorIssue("invalid_input", "$.registryUpdate.expectedAggregateVersion", "Aggregate version must be a non-negative safe integer"));
  }
  if (!isNonNegativeSafeInteger(value.expectedRegistryRevision)) {
    issues.push(aggregatorIssue("invalid_input", "$.registryUpdate.expectedRegistryRevision", "Registry revision must be a non-negative safe integer"));
  }
  if (!isCanonicalText(value.idempotencyKey)) {
    issues.push(aggregatorIssue("invalid_input", "$.registryUpdate.idempotencyKey", "Idempotency key must be canonical text"));
  }
  if (!isRecord(value.roomWorkerFence)
    || !isCanonicalText(value.roomWorkerFence.leaseId)
    || !isCanonicalText(value.roomWorkerFence.holderId)
    || !isCanonicalText(value.roomWorkerFence.hostId)
    || !isPositiveSafeInteger(value.roomWorkerFence.expectedEpoch)) {
    issues.push(aggregatorIssue("invalid_input", "$.registryUpdate.roomWorkerFence", "A complete fenced room-worker identity is required"));
  }
  if (!isRecord(value.freshness)
    || !isPositiveSafeInteger(value.freshness.maxSnapshotAgeMs)
    || !isPositiveSafeInteger(value.freshness.maxSignalAgeMs)
    || !isNonNegativeSafeInteger(value.freshness.maxFutureSkewMs)) {
    issues.push(aggregatorIssue("invalid_input", "$.registryUpdate.freshness", "Registry freshness must use positive ages and non-negative future skew"));
  }
  return true;
}

function validateTopLevelInput(
  rawInput: unknown,
): readonly RoomConnectorCapabilityObservationAggregatorIssueV1[] {
  if (!isRecord(rawInput)) {
    return [aggregatorIssue("invalid_input", "$", "Aggregation input must be an inspectable object")];
  }
  const issues: RoomConnectorCapabilityObservationAggregatorIssueV1[] = [];
  if (rawInput.contractVersion !== ROOM_CONNECTOR_CAPABILITY_OBSERVATION_AGGREGATOR_CONTRACT_VERSION) {
    issues.push(aggregatorIssue("invalid_input", "$.contractVersion", "Only aggregation contract version 1 is supported"));
  }
  if (!isCanonicalText(rawInput.projectId)) {
    issues.push(aggregatorIssue("invalid_input", "$.projectId", "Project identifier must be canonical text"));
  }
  if (!isCanonicalText(rawInput.roomId)) {
    issues.push(aggregatorIssue("invalid_input", "$.roomId", "Room identifier must be canonical text"));
  }
  if (!isCanonicalTimestamp(rawInput.asOf)) {
    issues.push(aggregatorIssue("invalid_input", "$.asOf", "Decision time must be canonical UTC"));
  }
  if (!isRecord(rawInput.reportFreshness)
    || !isPositiveSafeInteger(rawInput.reportFreshness.maxObservationAgeMs)
    || !isNonNegativeSafeInteger(rawInput.reportFreshness.maxFutureSkewMs)) {
    issues.push(aggregatorIssue("invalid_input", "$.reportFreshness", "Reporter freshness must use a positive age and non-negative future skew"));
  }
  validateRegistryUpdate(rawInput.registryUpdate, issues);
  if (!Array.isArray(rawInput.roomBindings) || rawInput.roomBindings.length === 0) {
    issues.push(aggregatorIssue("invalid_input", "$.roomBindings", "Complete Room bindings are required"));
  } else if (rawInput.roomBindings.length > MAX_ROOM_CAPABILITY_REGISTRY_UPDATE_SAMPLES) {
    issues.push(aggregatorIssue("active_binding_limit_exceeded", "$.roomBindings", `At most ${MAX_ROOM_CAPABILITY_REGISTRY_UPDATE_SAMPLES} active Room bindings can be aggregated at once`));
  }
  if (!Array.isArray(rawInput.activeBindings) || rawInput.activeBindings.length === 0) {
    issues.push(aggregatorIssue("invalid_input", "$.activeBindings", "At least one active binding is required"));
  } else if (rawInput.activeBindings.length > MAX_ROOM_CAPABILITY_REGISTRY_UPDATE_SAMPLES) {
    issues.push(aggregatorIssue("active_binding_limit_exceeded", "$.activeBindings", `At most ${MAX_ROOM_CAPABILITY_REGISTRY_UPDATE_SAMPLES} active bindings can be aggregated at once`));
  }
  if (!Array.isArray(rawInput.observations) || rawInput.observations.length === 0) {
    issues.push(aggregatorIssue("invalid_input", "$.observations", "At least one trusted observation is required"));
  } else if (rawInput.observations.length > MAX_ROOM_CAPABILITY_REGISTRY_UPDATE_SAMPLES) {
    issues.push(aggregatorIssue("sample_limit_exceeded", "$.observations", `At most ${MAX_ROOM_CAPABILITY_REGISTRY_UPDATE_SAMPLES} observations can be aggregated at once`));
  }
  return issues;
}

/**
 * FNXC:RoomCapabilityObservationAggregation 2026-07-20-00:24:
 * Task 6.1 requires a controller-owned all-or-nothing seam before later
 * ProjectEngine/RoomController storage wiring. Every active concrete binding
 * must contribute exactly one caller-provided trusted runtime observation at
 * the same decision time; missing, duplicate, stale, unknown, or rejected
 * evidence withholds the entire update. This adapter performs no connector I/O
 * and no storage write, so it cannot fabricate capability state from
 * SessionConnectorV1 fields or partially publish an unsafe registry. Complete
 * evidence for a paused/degraded binding is still a durable operator signal,
 * but it is explicitly not schedulable; an empty tool inventory is likewise
 * insufficient evidence to dispatch work.
 */
export function aggregateRoomConnectorCapabilityObservations(
  rawInput: RoomConnectorCapabilityObservationAggregationInputV1,
): RoomConnectorCapabilityObservationAggregationResultV1 {
  const topLevelIssues = validateTopLevelInput(rawInput);
  if (topLevelIssues.length > 0) return withheld(rawInput, topLevelIssues);

  const input = rawInput as RoomConnectorCapabilityObservationAggregationInputV1;
  const issues: RoomConnectorCapabilityObservationAggregatorIssueV1[] = [];
  const roomActiveByBindingId = new Map<string, RoomBindingV1>();
  for (const [index, value] of input.roomBindings.entries()) {
    const roomBinding = normalizeRoomBinding(value, index, input.roomId, issues);
    if (!roomBinding) continue;
    if (roomActiveByBindingId.has(roomBinding.bindingId)) {
      issues.push(aggregatorIssue("duplicate_room_binding", `$.roomBindings[${index}].id`, "Controller Room binding projection must contain each active binding once"));
      continue;
    }
    roomActiveByBindingId.set(roomBinding.bindingId, roomBinding);
  }
  const activeByBindingId = new Map<string, ActiveBindingV1>();
  for (const [index, value] of input.activeBindings.entries()) {
    const active = normalizeActiveBinding(value, index, input.projectId, input.roomId, issues);
    if (!active) continue;
    if (activeByBindingId.has(active.bindingId)) {
      issues.push(aggregatorIssue("duplicate_active_binding", `$.activeBindings[${index}].binding.id`, "Controller active-binding set must contain each binding once"));
      continue;
    }
    activeByBindingId.set(active.bindingId, active);
  }

  for (const [bindingId, active] of activeByBindingId) {
    const persisted = roomActiveByBindingId.get(bindingId);
    if (!persisted) {
      issues.push(aggregatorIssue("unknown_active_binding", "$.activeBindings", `Active capability target ${bindingId} is not present in the controller Room binding projection`));
      continue;
    }
    if (!sameBinding(active.target.binding, persisted.binding)) {
      issues.push(aggregatorIssue("binding_identity_mismatch", "$.activeBindings", `Active capability target ${bindingId} does not exactly match the controller Room binding projection`));
    }
  }
  for (const [bindingId, persisted] of roomActiveByBindingId) {
    if (persisted.binding.state === "pending") {
      issues.push(aggregatorIssue("unobservable_active_binding", "$.roomBindings", `Pending binding ${bindingId} has no concrete Session runtime observation`));
      continue;
    }
    if (!activeByBindingId.has(bindingId)) {
      issues.push(aggregatorIssue("missing_active_binding", "$.activeBindings", `Active Room binding ${bindingId} has no controlled runtime target`));
    }
  }

  const observedBindingIds = new Set<string>();
  const observations: ValidatedObservationV1[] = [];
  for (const [index, value] of input.observations.entries()) {
    const path = `$.observations[${index}]`;
    if (!isRecord(value) || value.source !== "trusted_session_connector") {
      issues.push(aggregatorIssue("untrusted_sample", `${path}.source`, "Only caller-provided trusted connector observations are accepted"));
      continue;
    }
    if (!isRecord(value.report)) {
      issues.push(aggregatorIssue("untrusted_sample", `${path}.report`, "Trusted observation must carry an inspectable reporter input"));
      continue;
    }
    const reportInput = value.report as CreateRoomBindingCapabilityReportInputV1;
    if (reportInput.asOf !== input.asOf) {
      issues.push(aggregatorIssue("sample_time_mismatch", `${path}.report.asOf`, "Every observation must use the single controller decision time"));
      continue;
    }
    if (!sameFreshness(reportInput.freshness, input.reportFreshness)) {
      issues.push(aggregatorIssue("sample_freshness_mismatch", `${path}.report.freshness`, "Every observation must use the controller reporter freshness policy"));
      continue;
    }
    const report = createRoomBindingCapabilityReport(reportInput);
    if (!report.ok) {
      issues.push(...report.issues.map((issue) => reporterIssue(
        issue.code,
        `${path}.report${issue.path.slice(1)}`,
        issue.message,
      )));
      continue;
    }
    if (report.value.projectId !== input.projectId || report.value.roomId !== input.roomId) {
      issues.push(aggregatorIssue("sample_scope_mismatch", `${path}.report.target`, "Observation report must belong to the controller project and Room"));
      continue;
    }
    const active = activeByBindingId.get(report.value.bindingId);
    if (!active) {
      issues.push(aggregatorIssue("unknown_binding_sample", `${path}.report.target.binding.id`, "Observation is not for a caller-supplied active binding"));
      continue;
    }
    if (observedBindingIds.has(report.value.bindingId)) {
      issues.push(aggregatorIssue("duplicate_binding_sample", `${path}.report.target.binding.id`, "Only one observation may represent an active binding"));
      continue;
    }
    if (!sameTarget(active.target, reportInput.target)) {
      issues.push(aggregatorIssue("binding_identity_mismatch", `${path}.report.target`, "Observation target must exactly match the controller active binding and runtime identity"));
      continue;
    }
    observedBindingIds.add(report.value.bindingId);
    observations.push({
      bindingId: report.value.bindingId,
      binding: active.target.binding,
      snapshot: report.value.snapshot,
      sample: value as RoomCapabilityRegistryUpdateSampleV1,
    });
  }

  for (const [bindingId] of activeByBindingId) {
    if (!observedBindingIds.has(bindingId)) {
      issues.push(aggregatorIssue("missing_binding_sample", "$.observations", `Active binding ${bindingId} has no accepted trusted observation`));
    }
  }
  if (issues.length > 0) return withheld(rawInput, issues);

  const ordered = [...observations].sort((left, right) => left.bindingId.localeCompare(right.bindingId));
  const samples = ordered.map((entry) => structuredClone(entry.sample)) as RoomCapabilityRegistryUpdateSampleV1[];
  const scheduling = ordered.every((entry) => isRoomConnectorCapabilitySnapshotSchedulable(
    entry.binding,
    entry.snapshot,
  ))
    ? "schedulable"
    : "not_schedulable";
  const update: RoomCapabilityRegistryUpdateInputV1 = {
    contractVersion: ROOM_CAPABILITY_REGISTRY_UPDATER_CONTRACT_VERSION,
    projectId: input.projectId,
    roomId: input.roomId,
    expectedAggregateVersion: input.registryUpdate.expectedAggregateVersion,
    expectedRegistryRevision: input.registryUpdate.expectedRegistryRevision,
    roomWorkerFence: structuredClone(input.registryUpdate.roomWorkerFence),
    idempotencyKey: input.registryUpdate.idempotencyKey,
    sampledAt: input.asOf,
    freshness: structuredClone(input.registryUpdate.freshness),
    samples,
  };
  return deepFreeze({ ok: true, outcome: "aggregated", scheduling, update });
}

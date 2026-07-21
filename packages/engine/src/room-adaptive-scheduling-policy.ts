export const ROOM_ADAPTIVE_SCHEDULING_POLICY_CONTRACT_VERSION = 1 as const;

export type RoomAdaptiveSchedulingAuthoritySourceV1 = "room_controller" | "event_ledger";
export type RoomAdaptiveSchedulingWorkKindV1 = "producer" | "verifier" | "recovery";

export interface RoomAdaptiveSchedulingWorkItemV1 {
  readonly workId: string;
  readonly projectId: string;
  readonly roomId: string;
  readonly kind: RoomAdaptiveSchedulingWorkKindV1;
  readonly qualityScore: number;
  readonly criticalPathDistance: number;
  readonly projectPriority: number;
  readonly roomPriority: number;
  readonly enqueuedAt: string;
  readonly requiredSlots: number;
}

export interface RoomAdaptiveSchedulingActiveWorkItemV1 extends RoomAdaptiveSchedulingWorkItemV1 {
  readonly startedAt: string;
  readonly turnBoundary: {
    readonly source: RoomAdaptiveSchedulingAuthoritySourceV1;
    readonly state: "safe" | "mid_turn";
    readonly observedAt: string;
  };
}

export interface RoomAdaptiveSchedulingProjectAllocationV1 {
  readonly projectId: string;
  readonly slots: number;
}

export interface RoomAdaptiveSchedulingRoomAllocationV1 {
  readonly roomId: string;
  readonly slots: number;
}

export interface RoomAdaptiveSchedulingCanonicalStateV1 {
  readonly source: RoomAdaptiveSchedulingAuthoritySourceV1;
  readonly snapshotId: string;
  readonly observedAt: string;
  readonly sequence: number;
  readonly fairness: {
    readonly source: RoomAdaptiveSchedulingAuthoritySourceV1;
    readonly windowStartedAt: string;
    readonly projectAllocatedSlots: readonly RoomAdaptiveSchedulingProjectAllocationV1[];
    readonly roomAllocatedSlots: readonly RoomAdaptiveSchedulingRoomAllocationV1[];
  };
  readonly queued: readonly RoomAdaptiveSchedulingWorkItemV1[];
  readonly active: readonly RoomAdaptiveSchedulingActiveWorkItemV1[];
}

export interface RoomAdaptiveSchedulingCapacityV1 {
  readonly totalSlots: number;
  readonly reservedVerifierSlots: number;
  readonly reservedRecoverySlots: number;
}

export interface RoomAdaptiveSchedulingReservationV1 {
  readonly projectId?: string;
  readonly roomId?: string;
  readonly minimumSlots: number;
}

export interface RoomAdaptiveSchedulingPolicyV1 {
  readonly minimumProjectReservations: readonly RoomAdaptiveSchedulingReservationV1[];
  readonly minimumRoomReservations: readonly RoomAdaptiveSchedulingReservationV1[];
  readonly fairnessAgingQuantumMs: number;
  readonly preemptionEnabled: boolean;
}

export interface RoomAdaptiveSchedulingInputV1 {
  readonly contractVersion: typeof ROOM_ADAPTIVE_SCHEDULING_POLICY_CONTRACT_VERSION;
  readonly asOf: string;
  readonly canonicalState: RoomAdaptiveSchedulingCanonicalStateV1;
  readonly capacity: RoomAdaptiveSchedulingCapacityV1;
  readonly policy: RoomAdaptiveSchedulingPolicyV1;
}

export type RoomAdaptiveSchedulingReasonV1 =
  | "quality_first"
  | "critical_path_tiebreak"
  | "project_priority_tiebreak"
  | "room_priority_tiebreak"
  | "fairness_tiebreak"
  | "aging_tiebreak"
  | "deterministic_work_id_tiebreak"
  | "minimum_project_reservation"
  | "minimum_room_reservation"
  | "safe_turn_boundary_preemption"
  | "no_safe_turn_boundary"
  | "preemption_disabled"
  | "reserved_capacity_protected"
  | "capacity_exhausted";

export interface RoomAdaptiveSchedulingWorkDecisionV1 {
  readonly workId: string;
  readonly disposition: "selected" | "preempted" | "refused";
  readonly reasons: readonly RoomAdaptiveSchedulingReasonV1[];
}

export interface RoomAdaptiveSchedulingDecisionV1 {
  readonly contractVersion: typeof ROOM_ADAPTIVE_SCHEDULING_POLICY_CONTRACT_VERSION;
  readonly selectedWorkIds: readonly string[];
  readonly preemptedWorkIds: readonly string[];
  readonly unusedSlots: number;
  readonly workDecisions: readonly RoomAdaptiveSchedulingWorkDecisionV1[];
}

export type RoomAdaptiveSchedulingIssueCodeV1 =
  | "active_capacity_exceeds_total"
  | "capacity_reservation_exceeds_total"
  | "duplicate_reservation"
  | "duplicate_work_id"
  | "invalid_input"
  | "invalid_timestamp"
  | "unauthorized_state_source";

export interface RoomAdaptiveSchedulingIssueV1 {
  readonly code: RoomAdaptiveSchedulingIssueCodeV1;
  readonly path: string;
  readonly message: string;
}

export type RoomAdaptiveSchedulingResultV1 =
  | { readonly ok: true; readonly value: RoomAdaptiveSchedulingDecisionV1 }
  | { readonly ok: false; readonly issues: readonly RoomAdaptiveSchedulingIssueV1[] };

interface MutableAllocationV1 {
  readonly selected: RoomAdaptiveSchedulingWorkItemV1[];
  readonly active: RoomAdaptiveSchedulingActiveWorkItemV1[];
  readonly preempted: RoomAdaptiveSchedulingActiveWorkItemV1[];
}

const WORK_KINDS = new Set<RoomAdaptiveSchedulingWorkKindV1>(["producer", "verifier", "recovery"]);
const AUTHORITY_SOURCES = new Set<RoomAdaptiveSchedulingAuthoritySourceV1>(["room_controller", "event_ledger"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isCanonicalTimestamp(value: unknown): value is string {
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

function issue(
  code: RoomAdaptiveSchedulingIssueCodeV1,
  path: string,
  message: string,
): RoomAdaptiveSchedulingIssueV1 {
  return { code, path, message };
}

function sortIssues(issues: readonly RoomAdaptiveSchedulingIssueV1[]): readonly RoomAdaptiveSchedulingIssueV1[] {
  return [...issues].sort((left, right) => {
    const byCode = left.code.localeCompare(right.code);
    return byCode !== 0 ? byCode : left.path.localeCompare(right.path);
  });
}

function validateAllocationEntries(
  value: unknown,
  field: "projectAllocatedSlots" | "roomAllocatedSlots",
  identity: "projectId" | "roomId",
  issues: RoomAdaptiveSchedulingIssueV1[],
): void {
  if (!Array.isArray(value)) {
    issues.push(issue("invalid_input", `canonicalState.fairness.${field}`, "Canonical fairness allocations must be arrays"));
    return;
  }
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const path = `canonicalState.fairness.${field}[${index}]`;
    if (!isRecord(entry) || !isCanonicalString(entry[identity]) || !isNonNegativeSafeInteger(entry.slots)) {
      issues.push(issue("invalid_input", path, "Allocation entries require a canonical scope ID and non-negative slots"));
      continue;
    }
    const id = entry[identity] as string;
    if (seen.has(id)) issues.push(issue("duplicate_reservation", path, "A fairness scope may occur once per canonical window"));
    seen.add(id);
  }
}

function validateWork(
  value: unknown,
  path: string,
  active: boolean,
  issues: RoomAdaptiveSchedulingIssueV1[],
): void {
  if (!isRecord(value)) {
    issues.push(issue("invalid_input", path, "Work must be an inspectable canonical record"));
    return;
  }
  for (const field of ["workId", "projectId", "roomId"] as const) {
    if (!isCanonicalString(value[field])) {
      issues.push(issue("invalid_input", `${path}.${field}`, "Work identity must be a canonical non-empty string"));
    }
  }
  if (!WORK_KINDS.has(value.kind as RoomAdaptiveSchedulingWorkKindV1)) {
    issues.push(issue("invalid_input", `${path}.kind`, "Work kind is unsupported"));
  }
  if (typeof value.qualityScore !== "number" || !Number.isFinite(value.qualityScore) || value.qualityScore < 0 || value.qualityScore > 1) {
    issues.push(issue("invalid_input", `${path}.qualityScore`, "Quality must be independent finite evidence in [0, 1]"));
  }
  for (const field of ["criticalPathDistance", "projectPriority", "roomPriority"] as const) {
    if (!isNonNegativeSafeInteger(value[field])) {
      issues.push(issue("invalid_input", `${path}.${field}`, "Priority dimensions must be non-negative safe integers"));
    }
  }
  if (!isCanonicalTimestamp(value.enqueuedAt)) {
    issues.push(issue("invalid_timestamp", `${path}.enqueuedAt`, "Enqueue time must be canonical UTC"));
  }
  if (!isPositiveSafeInteger(value.requiredSlots)) {
    issues.push(issue("invalid_input", `${path}.requiredSlots`, "Work must request a positive safe number of slots"));
  }
  if (!active) return;
  if (!isCanonicalTimestamp(value.startedAt)) {
    issues.push(issue("invalid_timestamp", `${path}.startedAt`, "Active work start time must be canonical UTC"));
  }
  if (!isRecord(value.turnBoundary)) {
    issues.push(issue("invalid_input", `${path}.turnBoundary`, "Active work requires a controller-recorded turn boundary"));
    return;
  }
  if (!AUTHORITY_SOURCES.has(value.turnBoundary.source as RoomAdaptiveSchedulingAuthoritySourceV1)) {
    issues.push(issue("unauthorized_state_source", `${path}.turnBoundary.source`, "Worker self-reports cannot authorize preemption"));
  }
  if (value.turnBoundary.state !== "safe" && value.turnBoundary.state !== "mid_turn") {
    issues.push(issue("invalid_input", `${path}.turnBoundary.state`, "Turn-boundary state is unsupported"));
  }
  if (!isCanonicalTimestamp(value.turnBoundary.observedAt)) {
    issues.push(issue("invalid_timestamp", `${path}.turnBoundary.observedAt`, "Turn-boundary observation must be canonical UTC"));
  }
}

function validateReservations(
  value: unknown,
  field: "minimumProjectReservations" | "minimumRoomReservations",
  identity: "projectId" | "roomId",
  issues: RoomAdaptiveSchedulingIssueV1[],
): void {
  if (!Array.isArray(value)) {
    issues.push(issue("invalid_input", `policy.${field}`, "Minimum reservations must be arrays"));
    return;
  }
  const seen = new Set<string>();
  for (const [index, reservation] of value.entries()) {
    const path = `policy.${field}[${index}]`;
    if (!isRecord(reservation) || !isCanonicalString(reservation[identity]) || !isPositiveSafeInteger(reservation.minimumSlots)) {
      issues.push(issue("invalid_input", path, "Minimum reservations require a canonical scope ID and positive slots"));
      continue;
    }
    const id = reservation[identity] as string;
    if (seen.has(id)) issues.push(issue("duplicate_reservation", path, "A scope may have one minimum reservation"));
    seen.add(id);
  }
}

function validateInput(input: unknown): readonly RoomAdaptiveSchedulingIssueV1[] {
  const issues: RoomAdaptiveSchedulingIssueV1[] = [];
  if (!isRecord(input)) {
    return [issue("invalid_input", "$", "Scheduling input must be an inspectable object")];
  }
  if (input.contractVersion !== ROOM_ADAPTIVE_SCHEDULING_POLICY_CONTRACT_VERSION) {
    issues.push(issue("invalid_input", "contractVersion", "Only scheduling contract version 1 is supported"));
  }
  if (!isCanonicalTimestamp(input.asOf)) {
    issues.push(issue("invalid_timestamp", "asOf", "Decision time must be canonical UTC"));
  }
  const state = isRecord(input.canonicalState) ? input.canonicalState : null;
  if (state === null) {
    issues.push(issue("invalid_input", "canonicalState", "A canonical state snapshot is required"));
  } else {
    if (!AUTHORITY_SOURCES.has(state.source as RoomAdaptiveSchedulingAuthoritySourceV1)) {
      issues.push(issue("unauthorized_state_source", "canonicalState.source", "Only controller or event-ledger snapshots are authoritative"));
    }
    if (!isCanonicalString(state.snapshotId)) {
      issues.push(issue("invalid_input", "canonicalState.snapshotId", "Snapshot ID must be canonical"));
    }
    if (!isCanonicalTimestamp(state.observedAt)) {
      issues.push(issue("invalid_timestamp", "canonicalState.observedAt", "Snapshot time must be canonical UTC"));
    }
    if (!isNonNegativeSafeInteger(state.sequence)) {
      issues.push(issue("invalid_input", "canonicalState.sequence", "Snapshot sequence must be a non-negative safe integer"));
    }
    const fairness = isRecord(state.fairness) ? state.fairness : null;
    if (fairness === null) {
      issues.push(issue("invalid_input", "canonicalState.fairness", "Canonical fairness state is required"));
    } else {
      if (!AUTHORITY_SOURCES.has(fairness.source as RoomAdaptiveSchedulingAuthoritySourceV1)) {
        issues.push(issue("unauthorized_state_source", "canonicalState.fairness.source", "Worker self-reports cannot supply fairness history"));
      }
      if (!isCanonicalTimestamp(fairness.windowStartedAt)) {
        issues.push(issue("invalid_timestamp", "canonicalState.fairness.windowStartedAt", "Fairness window start must be canonical UTC"));
      }
      validateAllocationEntries(fairness.projectAllocatedSlots, "projectAllocatedSlots", "projectId", issues);
      validateAllocationEntries(fairness.roomAllocatedSlots, "roomAllocatedSlots", "roomId", issues);
    }
    const queued = Array.isArray(state.queued) ? state.queued : null;
    const active = Array.isArray(state.active) ? state.active : null;
    if (queued === null) issues.push(issue("invalid_input", "canonicalState.queued", "Canonical queued work must be an array"));
    if (active === null) issues.push(issue("invalid_input", "canonicalState.active", "Canonical active work must be an array"));
    const workIds = new Set<string>();
    for (const [index, work] of (queued ?? []).entries()) {
      validateWork(work, `canonicalState.queued[${index}]`, false, issues);
      if (isRecord(work) && isCanonicalString(work.workId)) {
        if (workIds.has(work.workId)) issues.push(issue("duplicate_work_id", `canonicalState.queued[${index}].workId`, "Work IDs must be unique across the snapshot"));
        workIds.add(work.workId);
      }
    }
    for (const [index, work] of (active ?? []).entries()) {
      validateWork(work, `canonicalState.active[${index}]`, true, issues);
      if (isRecord(work) && isCanonicalString(work.workId)) {
        if (workIds.has(work.workId)) issues.push(issue("duplicate_work_id", `canonicalState.active[${index}].workId`, "Work IDs must be unique across the snapshot"));
        workIds.add(work.workId);
      }
    }
  }
  const capacity = isRecord(input.capacity) ? input.capacity : null;
  if (capacity === null) {
    issues.push(issue("invalid_input", "capacity", "Capacity must be an inspectable canonical record"));
  } else {
    if (!isPositiveSafeInteger(capacity.totalSlots)) {
      issues.push(issue("invalid_input", "capacity.totalSlots", "Total slots must be a positive safe integer"));
    }
    for (const field of ["reservedVerifierSlots", "reservedRecoverySlots"] as const) {
      if (!isNonNegativeSafeInteger(capacity[field])) {
        issues.push(issue("invalid_input", `capacity.${field}`, "Reserved slots must be non-negative safe integers"));
      }
    }
    if (
      isPositiveSafeInteger(capacity.totalSlots)
      && isNonNegativeSafeInteger(capacity.reservedVerifierSlots)
      && isNonNegativeSafeInteger(capacity.reservedRecoverySlots)
      && capacity.reservedVerifierSlots + capacity.reservedRecoverySlots > capacity.totalSlots
    ) {
      issues.push(issue("capacity_reservation_exceeds_total", "capacity", "Reserved verifier and recovery slots exceed total capacity"));
    }
    if (state !== null && Array.isArray(state.active) && isPositiveSafeInteger(capacity.totalSlots)) {
      const activeSlots = state.active.reduce((total, item) =>
        total + (isRecord(item) && isPositiveSafeInteger(item.requiredSlots) ? item.requiredSlots : 0), 0);
      if (activeSlots > capacity.totalSlots) {
        issues.push(issue("active_capacity_exceeds_total", "canonicalState.active", "Active work exceeds total capacity"));
      }
    }
  }
  const policy = isRecord(input.policy) ? input.policy : null;
  if (policy === null) {
    issues.push(issue("invalid_input", "policy", "Scheduling policy must be an inspectable canonical record"));
  } else {
    if (!isPositiveSafeInteger(policy.fairnessAgingQuantumMs)) {
      issues.push(issue("invalid_input", "policy.fairnessAgingQuantumMs", "Fairness aging quantum must be a positive safe integer"));
    }
    if (typeof policy.preemptionEnabled !== "boolean") {
      issues.push(issue("invalid_input", "policy.preemptionEnabled", "Preemption setting must be boolean"));
    }
    validateReservations(policy.minimumProjectReservations, "minimumProjectReservations", "projectId", issues);
    validateReservations(policy.minimumRoomReservations, "minimumRoomReservations", "roomId", issues);
  }
  return sortIssues(issues);
}

function allocatedSlotsForScope(
  input: RoomAdaptiveSchedulingInputV1,
  allocation: MutableAllocationV1,
  scope: "projectId" | "roomId",
  id: string,
): number {
  const historical = scope === "projectId"
    ? input.canonicalState.fairness.projectAllocatedSlots.find((entry) => entry.projectId === id)?.slots ?? 0
    : input.canonicalState.fairness.roomAllocatedSlots.find((entry) => entry.roomId === id)?.slots ?? 0;
  const current = [...allocation.active, ...allocation.selected]
    .reduce((total, item) => total + (item[scope] === id ? item.requiredSlots : 0), 0);
  return historical + current;
}

function currentSlotsForScope(
  allocation: MutableAllocationV1,
  scope: "projectId" | "roomId",
  id: string,
): number {
  return [...allocation.active, ...allocation.selected]
    .reduce((total, item) => total + (item[scope] === id ? item.requiredSlots : 0), 0);
}

function ageQuanta(input: RoomAdaptiveSchedulingInputV1, item: RoomAdaptiveSchedulingWorkItemV1): number {
  return Math.floor(
    Math.max(0, Date.parse(input.asOf) - Date.parse(item.enqueuedAt)) / input.policy.fairnessAgingQuantumMs,
  );
}

function slotsForKind(
  items: readonly RoomAdaptiveSchedulingWorkItemV1[],
  kind: RoomAdaptiveSchedulingWorkKindV1,
): number {
  return items.reduce((total, item) => total + (item.kind === kind ? item.requiredSlots : 0), 0);
}

function canAllocate(
  candidate: RoomAdaptiveSchedulingWorkItemV1,
  input: RoomAdaptiveSchedulingInputV1,
  allocation: MutableAllocationV1,
  remainingSlots: number,
): boolean {
  if (candidate.requiredSlots > remainingSlots) return false;
  const allocated = [...allocation.active, ...allocation.selected];
  const totalAfter = allocated.reduce((total, item) => total + item.requiredSlots, 0) + candidate.requiredSlots;
  const verifierAfter = slotsForKind(allocated, "verifier") + (candidate.kind === "verifier" ? candidate.requiredSlots : 0);
  const recoveryAfter = slotsForKind(allocated, "recovery") + (candidate.kind === "recovery" ? candidate.requiredSlots : 0);
  const producerAfter = slotsForKind(allocated, "producer") + (candidate.kind === "producer" ? candidate.requiredSlots : 0);
  const producerLimit = input.capacity.totalSlots - input.capacity.reservedVerifierSlots - input.capacity.reservedRecoverySlots;
  if (producerAfter > producerLimit) return false;
  if (candidate.kind === "verifier") {
    return totalAfter <= input.capacity.totalSlots - Math.max(0, input.capacity.reservedRecoverySlots - recoveryAfter);
  }
  if (candidate.kind === "recovery") {
    return totalAfter <= input.capacity.totalSlots - Math.max(0, input.capacity.reservedVerifierSlots - verifierAfter);
  }
  return true;
}

function compareWork(
  left: RoomAdaptiveSchedulingWorkItemV1,
  right: RoomAdaptiveSchedulingWorkItemV1,
  input: RoomAdaptiveSchedulingInputV1,
  allocation: MutableAllocationV1,
): number {
  if (left.qualityScore !== right.qualityScore) return right.qualityScore - left.qualityScore;
  if (left.criticalPathDistance !== right.criticalPathDistance) {
    return left.criticalPathDistance - right.criticalPathDistance;
  }
  if (left.projectPriority !== right.projectPriority) {
    return right.projectPriority - left.projectPriority;
  }
  if (left.roomPriority !== right.roomPriority) {
    return right.roomPriority - left.roomPriority;
  }
  const leftProjectShare = allocatedSlotsForScope(input, allocation, "projectId", left.projectId);
  const rightProjectShare = allocatedSlotsForScope(input, allocation, "projectId", right.projectId);
  if (leftProjectShare !== rightProjectShare) return leftProjectShare - rightProjectShare;
  const leftRoomShare = allocatedSlotsForScope(input, allocation, "roomId", left.roomId);
  const rightRoomShare = allocatedSlotsForScope(input, allocation, "roomId", right.roomId);
  if (leftRoomShare !== rightRoomShare) return leftRoomShare - rightRoomShare;
  const leftAge = ageQuanta(input, left);
  const rightAge = ageQuanta(input, right);
  if (leftAge !== rightAge) return rightAge - leftAge;
  return left.workId.localeCompare(right.workId);
}

function selectionReasons(
  candidate: RoomAdaptiveSchedulingWorkItemV1,
  queued: readonly RoomAdaptiveSchedulingWorkItemV1[],
  input: RoomAdaptiveSchedulingInputV1,
  allocation: MutableAllocationV1,
): readonly RoomAdaptiveSchedulingReasonV1[] {
  const others = queued.filter((item) => item.workId !== candidate.workId);
  const tiedThroughPriority = others.filter((item) =>
    item.qualityScore === candidate.qualityScore
    && item.criticalPathDistance === candidate.criticalPathDistance
    && item.projectPriority === candidate.projectPriority
    && item.roomPriority === candidate.roomPriority
  );
  if (tiedThroughPriority.some((item) =>
    allocatedSlotsForScope(input, allocation, "projectId", candidate.projectId)
      < allocatedSlotsForScope(input, allocation, "projectId", item.projectId)
    || (
      allocatedSlotsForScope(input, allocation, "projectId", candidate.projectId)
        === allocatedSlotsForScope(input, allocation, "projectId", item.projectId)
      && allocatedSlotsForScope(input, allocation, "roomId", candidate.roomId)
        < allocatedSlotsForScope(input, allocation, "roomId", item.roomId)
    )
  )) {
    return ["fairness_tiebreak"];
  }
  if (tiedThroughPriority.some((item) =>
    allocatedSlotsForScope(input, allocation, "projectId", candidate.projectId)
      === allocatedSlotsForScope(input, allocation, "projectId", item.projectId)
    && allocatedSlotsForScope(input, allocation, "roomId", candidate.roomId)
      === allocatedSlotsForScope(input, allocation, "roomId", item.roomId)
    && ageQuanta(input, candidate) > ageQuanta(input, item)
  )) {
    return ["aging_tiebreak"];
  }
  if (tiedThroughPriority.some((item) =>
    allocatedSlotsForScope(input, allocation, "projectId", candidate.projectId)
      === allocatedSlotsForScope(input, allocation, "projectId", item.projectId)
    && allocatedSlotsForScope(input, allocation, "roomId", candidate.roomId)
      === allocatedSlotsForScope(input, allocation, "roomId", item.roomId)
    && ageQuanta(input, candidate) === ageQuanta(input, item)
    && candidate.workId < item.workId
  )) {
    return ["deterministic_work_id_tiebreak"];
  }
  const reasons: RoomAdaptiveSchedulingReasonV1[] = [];
  if (others.some((item) => item.qualityScore < candidate.qualityScore)) reasons.push("quality_first");
  if (others.some((item) => item.qualityScore === candidate.qualityScore && item.criticalPathDistance > candidate.criticalPathDistance)) {
    reasons.push("critical_path_tiebreak");
  }
  if (others.some((item) =>
    item.qualityScore === candidate.qualityScore
    && item.criticalPathDistance === candidate.criticalPathDistance
    && item.projectPriority < candidate.projectPriority
  )) {
    reasons.push("project_priority_tiebreak");
  }
  if (others.some((item) =>
    item.qualityScore === candidate.qualityScore
    && item.criticalPathDistance === candidate.criticalPathDistance
    && item.projectPriority === candidate.projectPriority
    && item.roomPriority < candidate.roomPriority
  )) {
    reasons.push("room_priority_tiebreak");
  }
  return reasons.length > 0 ? reasons : ["quality_first"];
}

/**
 * FNXC:RoomAdaptiveScheduling 2026-07-19-15:55:
 * The Engine receives only controller or event-ledger canonical snapshots; worker
 * self-reports are intentionally absent from this policy boundary. Selection is
 * pure so the controller can persist and fence the resulting decision separately.
 */
export function scheduleRoomAdaptiveWork(input: RoomAdaptiveSchedulingInputV1): RoomAdaptiveSchedulingResultV1 {
  const issues = validateInput(input);
  if (issues.length > 0) return { ok: false, issues };

  const allocation: MutableAllocationV1 = {
    selected: [],
    active: [...input.canonicalState.active],
    preempted: [],
  };
  const selectionReasonByWorkId = new Map<string, readonly RoomAdaptiveSchedulingReasonV1[]>();
  const refusalReasonByWorkId = new Map<string, readonly RoomAdaptiveSchedulingReasonV1[]>();
  let remainingSlots = input.capacity.totalSlots - allocation.active.reduce((total, item) => total + item.requiredSlots, 0);
  const ordered = (): RoomAdaptiveSchedulingWorkItemV1[] => [...input.canonicalState.queued].sort((left, right) =>
    compareWork(left, right, input, allocation)
  );

  const preemptionRefusal = (candidate: RoomAdaptiveSchedulingWorkItemV1): RoomAdaptiveSchedulingReasonV1 | null => {
    if (canAllocate(candidate, input, allocation, remainingSlots)) return null;
    if (candidate.requiredSlots <= remainingSlots) return "reserved_capacity_protected";
    if (!input.policy.preemptionEnabled) return "preemption_disabled";

    const outrankedActive = allocation.active.filter((active) => compareWork(candidate, active, input, allocation) < 0);
    const safeCandidates = outrankedActive
      .filter((active) =>
        active.kind === "producer"
        && (active.turnBoundary.source === "room_controller" || active.turnBoundary.source === "event_ledger")
        && active.turnBoundary.state === "safe"
      )
      .sort((left, right) => compareWork(right, left, input, allocation));
    if (safeCandidates.length === 0) {
      return outrankedActive.some((active) => active.kind === "producer" && active.turnBoundary.state === "mid_turn")
        ? "no_safe_turn_boundary"
        : "capacity_exhausted";
    }

    const before = [...allocation.active];
    const staged: RoomAdaptiveSchedulingActiveWorkItemV1[] = [];
    let stagedRemainingSlots = remainingSlots;
    for (const active of safeCandidates) {
      const index = allocation.active.findIndex((item) => item.workId === active.workId);
      if (index < 0) continue;
      allocation.active.splice(index, 1);
      staged.push(active);
      stagedRemainingSlots += active.requiredSlots;
      if (canAllocate(candidate, input, allocation, stagedRemainingSlots)) {
        allocation.preempted.push(...staged);
        remainingSlots = stagedRemainingSlots;
        return null;
      }
    }
    allocation.active.splice(0, allocation.active.length, ...before);
    return "capacity_exhausted";
  };

  const reserve = (
    reservations: readonly RoomAdaptiveSchedulingReservationV1[],
    scope: "projectId" | "roomId",
    reason: "minimum_project_reservation" | "minimum_room_reservation",
  ): void => {
    for (const reservation of [...reservations].sort((left, right) => {
      const leftId = left[scope] ?? "";
      const rightId = right[scope] ?? "";
      return leftId.localeCompare(rightId);
    })) {
      const id = reservation[scope];
      if (id === undefined) continue;
      while (currentSlotsForScope(allocation, scope, id) < reservation.minimumSlots) {
        const candidate = ordered().find((item) =>
          item[scope] === id
          && !selectionReasonByWorkId.has(item.workId)
          && !refusalReasonByWorkId.has(item.workId)
        );
        if (candidate === undefined) break;
        const refusal = preemptionRefusal(candidate);
        if (refusal !== null) {
          refusalReasonByWorkId.set(candidate.workId, [refusal]);
          continue;
        }
        allocation.selected.push(candidate);
        selectionReasonByWorkId.set(candidate.workId, [reason]);
        remainingSlots -= candidate.requiredSlots;
      }
    }
  };

  reserve(input.policy.minimumProjectReservations, "projectId", "minimum_project_reservation");
  reserve(input.policy.minimumRoomReservations, "roomId", "minimum_room_reservation");

  while (true) {
    const candidate = ordered().find((item) =>
      !selectionReasonByWorkId.has(item.workId) && !refusalReasonByWorkId.has(item.workId)
    );
    if (candidate === undefined) break;
    const refusal = preemptionRefusal(candidate);
    if (refusal !== null) {
      refusalReasonByWorkId.set(candidate.workId, [refusal]);
      continue;
    }
    const reasons = selectionReasons(candidate, input.canonicalState.queued, input, allocation);
    allocation.selected.push(candidate);
    selectionReasonByWorkId.set(candidate.workId, reasons);
    remainingSlots -= candidate.requiredSlots;
  }

  return {
    ok: true,
    value: {
      contractVersion: ROOM_ADAPTIVE_SCHEDULING_POLICY_CONTRACT_VERSION,
      selectedWorkIds: allocation.selected.map((item) => item.workId),
      preemptedWorkIds: allocation.preempted.map((item) => item.workId).sort((left, right) => left.localeCompare(right)),
      unusedSlots: remainingSlots,
      workDecisions: [
        ...input.canonicalState.queued.map((item) => ({
          workId: item.workId,
          disposition: selectionReasonByWorkId.has(item.workId) ? "selected" as const : "refused" as const,
          reasons: selectionReasonByWorkId.get(item.workId)
            ?? refusalReasonByWorkId.get(item.workId)
            ?? ["capacity_exhausted"] as const,
        })),
        ...allocation.preempted.map((item) => ({
          workId: item.workId,
          disposition: "preempted" as const,
          reasons: ["safe_turn_boundary_preemption"] as const,
        })),
      ].sort((left, right) => left.workId.localeCompare(right.workId)),
    },
  };
}

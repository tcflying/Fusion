export const ROOM_ADAPTIVE_SCHEDULING_POLICY_CONTRACT_VERSION = 1 as const;

const WORK_KINDS = new Set(["producer", "verifier", "recovery"]);

export type RoomAdaptiveSchedulingWorkKind = "producer" | "verifier" | "recovery";

export interface RoomAdaptiveSchedulingWorkItemV1 {
  readonly workId: string;
  readonly projectId: string;
  readonly roomId: string;
  readonly kind: RoomAdaptiveSchedulingWorkKind;
  /** Independent, current quality score; self-reported scores are not admissible here. */
  readonly qualityScore: number;
  /** Lower is closer to the unfrozen critical path. */
  readonly criticalPathDistance: number;
  readonly projectPriority: number;
  readonly roomPriority: number;
  readonly enqueuedAt: string;
  readonly requiredSlots: number;
}

export interface RoomAdaptiveSchedulingActiveWorkItemV1 extends RoomAdaptiveSchedulingWorkItemV1 {
  readonly startedAt: string;
  /** The controller has recorded a safe semantic turn boundary for this work. */
  readonly atTurnBoundary: boolean;
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
  readonly asOf: string;
  readonly capacity: RoomAdaptiveSchedulingCapacityV1;
  readonly policy: RoomAdaptiveSchedulingPolicyV1;
  readonly queued: readonly RoomAdaptiveSchedulingWorkItemV1[];
  readonly active: readonly RoomAdaptiveSchedulingActiveWorkItemV1[];
}

export type RoomAdaptiveSchedulingIssueCode =
  | "invalid_input"
  | "invalid_timestamp"
  | "duplicate_work_id"
  | "duplicate_reservation"
  | "capacity_reservation_exceeds_total"
  | "active_capacity_exceeds_total";

export interface RoomAdaptiveSchedulingIssueV1 {
  readonly code: RoomAdaptiveSchedulingIssueCode;
  readonly path: string;
  readonly message: string;
}

export interface RoomAdaptiveSchedulingDecisionV1 {
  readonly contractVersion: typeof ROOM_ADAPTIVE_SCHEDULING_POLICY_CONTRACT_VERSION;
  readonly scheduledWorkIds: readonly string[];
  readonly preemptedWorkIds: readonly string[];
  readonly reservedCapacity: { readonly verifierSlots: number; readonly recoverySlots: number };
  readonly unusedSlots: number;
}

export type RoomAdaptiveSchedulingResultV1 =
  | { readonly ok: true; readonly value: RoomAdaptiveSchedulingDecisionV1 }
  | { readonly ok: false; readonly issues: readonly RoomAdaptiveSchedulingIssueV1[] };

type MutableAllocation = {
  readonly selected: RoomAdaptiveSchedulingWorkItemV1[];
  readonly preempted: RoomAdaptiveSchedulingActiveWorkItemV1[];
  readonly active: RoomAdaptiveSchedulingActiveWorkItemV1[];
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function canonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function issue(
  code: RoomAdaptiveSchedulingIssueCode,
  path: string,
  message: string,
): RoomAdaptiveSchedulingIssueV1 {
  return { code, path, message };
}

function sortIssues(issues: readonly RoomAdaptiveSchedulingIssueV1[]): RoomAdaptiveSchedulingIssueV1[] {
  return [...issues].sort((left, right) => {
    const code = compareText(left.code, right.code);
    return code !== 0 ? code : compareText(left.path, right.path);
  });
}

function slots(items: readonly RoomAdaptiveSchedulingWorkItemV1[]): number {
  return items.reduce((sum, item) => sum + item.requiredSlots, 0);
}

function slotsForKind(items: readonly RoomAdaptiveSchedulingWorkItemV1[], kind: RoomAdaptiveSchedulingWorkKind): number {
  return items.filter((item) => item.kind === kind).reduce((sum, item) => sum + item.requiredSlots, 0);
}

function slotsForProject(items: readonly RoomAdaptiveSchedulingWorkItemV1[], projectId: string): number {
  return items.filter((item) => item.projectId === projectId).reduce((sum, item) => sum + item.requiredSlots, 0);
}

function slotsForRoom(items: readonly RoomAdaptiveSchedulingWorkItemV1[], roomId: string): number {
  return items.filter((item) => item.roomId === roomId).reduce((sum, item) => sum + item.requiredSlots, 0);
}

function allAllocated(allocation: MutableAllocation): RoomAdaptiveSchedulingWorkItemV1[] {
  return [...allocation.active, ...allocation.selected];
}

function workOrder(
  left: RoomAdaptiveSchedulingWorkItemV1,
  right: RoomAdaptiveSchedulingWorkItemV1,
  allocation: MutableAllocation,
  asOfMs: number,
  agingQuantumMs: number,
): number {
  // FNXC-2026-07-19: quality evidence is the first ordering dimension; path
  // urgency may break a quality tie but may never outrank stronger evidence.
  if (left.qualityScore !== right.qualityScore) return right.qualityScore - left.qualityScore;
  if (left.criticalPathDistance !== right.criticalPathDistance) return left.criticalPathDistance - right.criticalPathDistance;
  if (left.projectPriority !== right.projectPriority) return right.projectPriority - left.projectPriority;
  if (left.roomPriority !== right.roomPriority) return right.roomPriority - left.roomPriority;

  const allocated = allAllocated(allocation);
  const projectShare = slotsForProject(allocated, left.projectId) - slotsForProject(allocated, right.projectId);
  if (projectShare !== 0) return projectShare;
  const roomShare = slotsForRoom(allocated, left.roomId) - slotsForRoom(allocated, right.roomId);
  if (roomShare !== 0) return roomShare;

  const leftAge = Math.floor(Math.max(0, asOfMs - Date.parse(left.enqueuedAt)) / agingQuantumMs);
  const rightAge = Math.floor(Math.max(0, asOfMs - Date.parse(right.enqueuedAt)) / agingQuantumMs);
  if (leftAge !== rightAge) return rightAge - leftAge;
  return compareText(left.workId, right.workId);
}

function canAllocate(
  candidate: RoomAdaptiveSchedulingWorkItemV1,
  allocation: MutableAllocation,
  capacity: RoomAdaptiveSchedulingCapacityV1,
): boolean {
  const allocated = allAllocated(allocation);
  const totalAfter = slots(allocated) + candidate.requiredSlots;
  if (totalAfter > capacity.totalSlots) return false;
  const verifierAfter = slotsForKind(allocated, "verifier") + (candidate.kind === "verifier" ? candidate.requiredSlots : 0);
  const recoveryAfter = slotsForKind(allocated, "recovery") + (candidate.kind === "recovery" ? candidate.requiredSlots : 0);
  const producerAfter = slotsForKind(allocated, "producer") + (candidate.kind === "producer" ? candidate.requiredSlots : 0);
  const producerLimit = capacity.totalSlots - capacity.reservedVerifierSlots - capacity.reservedRecoverySlots;
  if (producerAfter > producerLimit) return false;
  if (candidate.kind === "verifier") {
    return totalAfter <= capacity.totalSlots - Math.max(0, capacity.reservedRecoverySlots - recoveryAfter);
  }
  if (candidate.kind === "recovery") {
    return totalAfter <= capacity.totalSlots - Math.max(0, capacity.reservedVerifierSlots - verifierAfter);
  }
  return true;
}

function allocatedWorkOrder(left: RoomAdaptiveSchedulingActiveWorkItemV1, right: RoomAdaptiveSchedulingActiveWorkItemV1): number {
  if (left.qualityScore !== right.qualityScore) return left.qualityScore - right.qualityScore;
  if (left.criticalPathDistance !== right.criticalPathDistance) return right.criticalPathDistance - left.criticalPathDistance;
  return compareText(left.workId, right.workId);
}

function candidateOutranks(
  candidate: RoomAdaptiveSchedulingWorkItemV1,
  active: RoomAdaptiveSchedulingActiveWorkItemV1,
): boolean {
  if (candidate.qualityScore !== active.qualityScore) return candidate.qualityScore > active.qualityScore;
  if (candidate.criticalPathDistance !== active.criticalPathDistance) return candidate.criticalPathDistance < active.criticalPathDistance;
  if (candidate.projectPriority !== active.projectPriority) return candidate.projectPriority > active.projectPriority;
  return candidate.roomPriority > active.roomPriority;
}

function tryAllocate(
  candidate: RoomAdaptiveSchedulingWorkItemV1,
  allocation: MutableAllocation,
  capacity: RoomAdaptiveSchedulingCapacityV1,
  allowPreemption: boolean,
): boolean {
  if (canAllocate(candidate, allocation, capacity)) {
    allocation.selected.push(candidate);
    return true;
  }
  if (!allowPreemption) return false;

  // FNXC-2026-07-19: only lower-quality producer work with an explicit safe
  // turn boundary is preemptible. Verifier/recovery capacity is never evicted.
  const preemptible = allocation.active
    .filter((item) => item.kind === "producer" && item.atTurnBoundary && candidateOutranks(candidate, item))
    .sort(allocatedWorkOrder);
  for (const active of preemptible) {
    const index = allocation.active.findIndex((item) => item.workId === active.workId);
    if (index < 0) continue;
    allocation.active.splice(index, 1);
    allocation.preempted.push(active);
    if (canAllocate(candidate, allocation, capacity)) {
      allocation.selected.push(candidate);
      return true;
    }
  }
  return false;
}

function validateWork(
  value: RoomAdaptiveSchedulingWorkItemV1 | RoomAdaptiveSchedulingActiveWorkItemV1,
  path: string,
  active: boolean,
  issues: RoomAdaptiveSchedulingIssueV1[],
): void {
  for (const field of ["workId", "projectId", "roomId"] as const) {
    if (!canonicalString(value[field])) issues.push(issue("invalid_input", `${path}.${field}`, "Identity fields must be canonical non-empty strings"));
  }
  if (!WORK_KINDS.has(value.kind)) issues.push(issue("invalid_input", `${path}.kind`, "Work kind is unsupported"));
  if (typeof value.qualityScore !== "number" || !Number.isFinite(value.qualityScore) || value.qualityScore < 0 || value.qualityScore > 1) {
    issues.push(issue("invalid_input", `${path}.qualityScore`, "Quality score must be a finite value in [0, 1]"));
  }
  for (const field of ["criticalPathDistance", "projectPriority", "roomPriority"] as const) {
    if (!nonNegativeSafeInteger(value[field])) issues.push(issue("invalid_input", `${path}.${field}`, "Priority fields must be non-negative safe integers"));
  }
  if (!positiveSafeInteger(value.requiredSlots)) issues.push(issue("invalid_input", `${path}.requiredSlots`, "Required slots must be a positive safe integer"));
  if (!canonicalTimestamp(value.enqueuedAt)) issues.push(issue("invalid_timestamp", `${path}.enqueuedAt`, "Queue time must be canonical UTC"));
  if (active) {
    const activeValue = value as RoomAdaptiveSchedulingActiveWorkItemV1;
    if (!canonicalTimestamp(activeValue.startedAt)) issues.push(issue("invalid_timestamp", `${path}.startedAt`, "Start time must be canonical UTC"));
    if (typeof activeValue.atTurnBoundary !== "boolean") issues.push(issue("invalid_input", `${path}.atTurnBoundary`, "Turn-boundary state must be boolean"));
  }
}

function validate(input: RoomAdaptiveSchedulingInputV1): RoomAdaptiveSchedulingIssueV1[] {
  const issues: RoomAdaptiveSchedulingIssueV1[] = [];
  if (!canonicalTimestamp(input.asOf)) issues.push(issue("invalid_timestamp", "asOf", "Scheduler time must be canonical UTC"));
  const { capacity, policy } = input;
  if (!positiveSafeInteger(capacity.totalSlots)) issues.push(issue("invalid_input", "capacity.totalSlots", "Total slots must be a positive safe integer"));
  for (const field of ["reservedVerifierSlots", "reservedRecoverySlots"] as const) {
    if (!nonNegativeSafeInteger(capacity[field])) issues.push(issue("invalid_input", `capacity.${field}`, "Reserved slots must be non-negative safe integers"));
  }
  if (
    nonNegativeSafeInteger(capacity.reservedVerifierSlots)
    && nonNegativeSafeInteger(capacity.reservedRecoverySlots)
    && positiveSafeInteger(capacity.totalSlots)
    && capacity.reservedVerifierSlots + capacity.reservedRecoverySlots > capacity.totalSlots
  ) {
    issues.push(issue("capacity_reservation_exceeds_total", "capacity", "Verifier and recovery reservations cannot exceed total capacity"));
  }
  if (!positiveSafeInteger(policy.fairnessAgingQuantumMs)) issues.push(issue("invalid_input", "policy.fairnessAgingQuantumMs", "Fairness quantum must be a positive safe integer"));
  if (typeof policy.preemptionEnabled !== "boolean") issues.push(issue("invalid_input", "policy.preemptionEnabled", "Preemption setting must be boolean"));
  const all = [...input.queued, ...input.active];
  const seen = new Set<string>();
  for (const [index, item] of input.queued.entries()) {
    validateWork(item, `queued[${index}]`, false, issues);
    if (seen.has(item.workId)) issues.push(issue("duplicate_work_id", `queued[${index}].workId`, "A work ID may occur only once"));
    seen.add(item.workId);
  }
  for (const [index, item] of input.active.entries()) {
    validateWork(item, `active[${index}]`, true, issues);
    if (seen.has(item.workId)) issues.push(issue("duplicate_work_id", `active[${index}].workId`, "A work ID may occur only once"));
    seen.add(item.workId);
  }
  if (positiveSafeInteger(capacity.totalSlots) && slots(input.active) > capacity.totalSlots) {
    issues.push(issue("active_capacity_exceeds_total", "active", "Active work already exceeds total capacity"));
  }
  for (const [scope, reservations, identity] of [
    ["project", policy.minimumProjectReservations, "projectId"],
    ["room", policy.minimumRoomReservations, "roomId"],
  ] as const) {
    const reservationIds = new Set<string>();
    for (const [index, reservation] of reservations.entries()) {
      const id = reservation[identity];
      if (!canonicalString(id) || !positiveSafeInteger(reservation.minimumSlots)) {
        issues.push(issue("invalid_input", `policy.minimum${scope === "project" ? "Project" : "Room"}Reservations[${index}]`, "Reservations require a canonical scope ID and positive minimum"));
        continue;
      }
      if (reservationIds.has(id)) issues.push(issue("duplicate_reservation", `policy.minimum${scope === "project" ? "Project" : "Room"}Reservations[${index}]`, "A scope may have one minimum reservation"));
      reservationIds.add(id);
    }
  }
  if (all.some((item) => item.requiredSlots > capacity.totalSlots)) {
    issues.push(issue("invalid_input", "work.requiredSlots", "No work item may require more slots than global capacity"));
  }
  return sortIssues(issues);
}

function reserve(
  reservations: readonly RoomAdaptiveSchedulingReservationV1[],
  queued: readonly RoomAdaptiveSchedulingWorkItemV1[],
  allocation: MutableAllocation,
  capacity: RoomAdaptiveSchedulingCapacityV1,
  input: RoomAdaptiveSchedulingInputV1,
  scope: "project" | "room",
): void {
  const identity = scope === "project" ? "projectId" : "roomId";
  for (const reservation of [...reservations].sort((left, right) => compareText(left[identity] as string, right[identity] as string))) {
    const id = reservation[identity] as string;
    while (slotsForScope(allAllocated(allocation), id, scope) < reservation.minimumSlots) {
      const candidate = queued
        .filter((item) => !allocation.selected.some((selected) => selected.workId === item.workId) && item[identity] === id)
        .sort((left, right) => workOrder(left, right, allocation, Date.parse(input.asOf), input.policy.fairnessAgingQuantumMs))
        .find((item) => tryAllocate(item, allocation, capacity, false));
      if (!candidate) break;
    }
  }
}

function slotsForScope(items: readonly RoomAdaptiveSchedulingWorkItemV1[], id: string, scope: "project" | "room"): number {
  return scope === "project" ? slotsForProject(items, id) : slotsForRoom(items, id);
}

/** Pure, deterministic policy only. Durable scheduler/leases own all side effects. */
export function scheduleRoomAdaptiveWork(input: RoomAdaptiveSchedulingInputV1): RoomAdaptiveSchedulingResultV1 {
  const issues = validate(input);
  if (issues.length > 0) return { ok: false, issues };

  const allocation: MutableAllocation = { selected: [], preempted: [], active: [...input.active] };
  reserve(input.policy.minimumProjectReservations, input.queued, allocation, input.capacity, input, "project");
  reserve(input.policy.minimumRoomReservations, input.queued, allocation, input.capacity, input, "room");

  const asOfMs = Date.parse(input.asOf);
  const sorted = [...input.queued].sort((left, right) => workOrder(left, right, allocation, asOfMs, input.policy.fairnessAgingQuantumMs));
  for (const candidate of sorted) {
    if (allocation.selected.some((selected) => selected.workId === candidate.workId)) continue;
    tryAllocate(candidate, allocation, input.capacity, input.policy.preemptionEnabled);
  }

  const selected = [...allocation.selected].sort((left, right) => workOrder(left, right, allocation, asOfMs, input.policy.fairnessAgingQuantumMs));
  return {
    ok: true,
    value: {
      contractVersion: ROOM_ADAPTIVE_SCHEDULING_POLICY_CONTRACT_VERSION,
      scheduledWorkIds: selected.map((item) => item.workId),
      preemptedWorkIds: allocation.preempted.map((item) => item.workId).sort(compareText),
      reservedCapacity: {
        verifierSlots: input.capacity.reservedVerifierSlots,
        recoverySlots: input.capacity.reservedRecoverySlots,
      },
      unusedSlots: input.capacity.totalSlots - slots(allAllocated(allocation)),
    },
  };
}

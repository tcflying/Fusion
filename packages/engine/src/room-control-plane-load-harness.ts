import type {
  RoomAdaptiveSchedulingActiveWorkItemV1,
  RoomAdaptiveSchedulingWorkItemV1,
} from "@fusion/core";

import {
  ROOM_CAPACITY_GOVERNOR_CONTRACT_VERSION,
  governRoomCapacity,
  type RoomCapacityGovernorDecisionV1,
  type RoomCapacityGovernorInputV1,
} from "./room-capacity-governor.js";

export const ROOM_CONTROL_PLANE_LOAD_HARNESS_CONTRACT_VERSION = 1 as const;

const ATTACHED_SEAT_COUNT = 64;
const ACTIVE_CONTROLLER_TASK_COUNT = 32;
const QUEUED_CONTROLLER_TASK_COUNT = 32;

export interface RoomControlPlaneLoadHarnessInputV1 {
  readonly contractVersion: typeof ROOM_CONTROL_PLANE_LOAD_HARNESS_CONTRACT_VERSION;
  readonly asOf: string;
  readonly projectId: string;
  readonly roomId: string;
  readonly seed: string;
}

export interface RoomControlPlaneLoadHarnessSeatV1 {
  readonly seatId: string;
  readonly simulatedProviderId: string;
  readonly simulatedAccountId: string;
  readonly simulatedModelId: string;
  readonly simulatedConnectorId: string;
  readonly simulatedNodeId: string;
  readonly simulatedSessionId: string;
}

export interface RoomControlPlaneLoadHarnessProofBoundaryV1 {
  readonly tier: "simulated_control_plane";
  readonly realProviderE2E: false;
  readonly realSessionE2E: false;
}

export interface RoomControlPlaneLoadHarnessScenarioV1 {
  readonly id: "attached-64-seats" | "active-32-controller-tasks";
  readonly status: "passed" | "failed";
}

export interface RoomControlPlaneLoadHarnessIssueV1 {
  readonly code: "invalid_input" | "harness_invariant_failed";
  readonly message: string;
}

export interface RoomControlPlaneLoadHarnessResultV1 {
  readonly contractVersion: typeof ROOM_CONTROL_PLANE_LOAD_HARNESS_CONTRACT_VERSION;
  readonly status: "passed" | "failed";
  readonly proofBoundary: RoomControlPlaneLoadHarnessProofBoundaryV1;
  readonly asOf: string | null;
  readonly projectId: string | null;
  readonly roomId: string | null;
  readonly seed: string | null;
  readonly counts: {
    readonly attachedSeats: number;
    readonly activeControllerTasks: number;
    readonly queuedControllerTasks: number;
  };
  readonly seats: readonly RoomControlPlaneLoadHarnessSeatV1[];
  readonly activeControllerTasks: readonly RoomAdaptiveSchedulingActiveWorkItemV1[];
  readonly queuedControllerTasks: readonly RoomAdaptiveSchedulingWorkItemV1[];
  readonly capacityDecision: RoomCapacityGovernorDecisionV1;
  readonly scenarios: readonly RoomControlPlaneLoadHarnessScenarioV1[];
  readonly issues: readonly RoomControlPlaneLoadHarnessIssueV1[];
}

interface ValidatedInput {
  readonly asOf: string;
  readonly projectId: string;
  readonly roomId: string;
  readonly seed: string;
}

export function runRoomControlPlaneLoadHarness(
  input: RoomControlPlaneLoadHarnessInputV1,
): RoomControlPlaneLoadHarnessResultV1 {
  const validated = validateInput(input);
  if (validated === null) {
    return freezeResult({
      contractVersion: ROOM_CONTROL_PLANE_LOAD_HARNESS_CONTRACT_VERSION,
      status: "failed",
      proofBoundary: proofBoundary(),
      asOf: null,
      projectId: null,
      roomId: null,
      seed: null,
      counts: { attachedSeats: 0, activeControllerTasks: 0, queuedControllerTasks: 0 },
      seats: [],
      activeControllerTasks: [],
      queuedControllerTasks: [],
      capacityDecision: invalidCapacityDecision(),
      scenarios: [
        { id: "attached-64-seats", status: "failed" },
        { id: "active-32-controller-tasks", status: "failed" },
      ],
      issues: [{ code: "invalid_input", message: "Load-harness input must contain canonical time and nonblank project, Room, and seed identities." }],
    });
  }

  const seats = createSeats(validated);
  const activeControllerTasks = createActiveControllerTasks(validated);
  const queuedControllerTasks = createQueuedControllerTasks(validated);
  const capacityDecision = governRoomCapacity(createGovernorInput(validated, activeControllerTasks, queuedControllerTasks));
  const attachmentPassed = seats.length === ATTACHED_SEAT_COUNT && new Set(seats.map((seat) => seat.seatId)).size === ATTACHED_SEAT_COUNT;
  const controllerTaskPassed =
    activeControllerTasks.length === ACTIVE_CONTROLLER_TASK_COUNT &&
    queuedControllerTasks.length === QUEUED_CONTROLLER_TASK_COUNT &&
    capacityDecision.admission.concurrencyLimit === ACTIVE_CONTROLLER_TASK_COUNT &&
    capacityDecision.admission.currentActiveSlots === ACTIVE_CONTROLLER_TASK_COUNT &&
    capacityDecision.admission.newlyAdmittedSlots === 0;
  const status = attachmentPassed && controllerTaskPassed ? "passed" : "failed";
  const issues: RoomControlPlaneLoadHarnessIssueV1[] = [];
  if (!attachmentPassed) {
    issues.push({ code: "harness_invariant_failed", message: "The deterministic harness did not retain exactly 64 distinct simulated seat identities." });
  }
  if (!controllerTaskPassed) {
    issues.push({ code: "harness_invariant_failed", message: "The deterministic harness did not hold exactly 32 active controller tasks at the certified simulated cap." });
  }
  return freezeResult({
    contractVersion: ROOM_CONTROL_PLANE_LOAD_HARNESS_CONTRACT_VERSION,
    status,
    proofBoundary: proofBoundary(),
    asOf: validated.asOf,
    projectId: validated.projectId,
    roomId: validated.roomId,
    seed: validated.seed,
    counts: {
      attachedSeats: seats.length,
      activeControllerTasks: activeControllerTasks.length,
      queuedControllerTasks: queuedControllerTasks.length,
    },
    seats,
    activeControllerTasks,
    queuedControllerTasks,
    capacityDecision,
    scenarios: [
      { id: "attached-64-seats", status: attachmentPassed ? "passed" : "failed" },
      { id: "active-32-controller-tasks", status: controllerTaskPassed ? "passed" : "failed" },
    ],
    issues,
  });
}

function createSeats(input: ValidatedInput): readonly RoomControlPlaneLoadHarnessSeatV1[] {
  const seats: RoomControlPlaneLoadHarnessSeatV1[] = [];
  for (let index = 0; index < ATTACHED_SEAT_COUNT; index += 1) {
    const ordinal = String(index + 1).padStart(2, "0");
    seats.push({
      seatId: `simulated-seat-${ordinal}`,
      simulatedProviderId: `simulated-provider-${(index % 3) + 1}`,
      simulatedAccountId: `simulated-account-${(index % 4) + 1}`,
      simulatedModelId: `simulated-model-${(index % 5) + 1}`,
      simulatedConnectorId: `simulated-connector-${(index % 8) + 1}`,
      simulatedNodeId: `simulated-node-${(index % 8) + 1}`,
      simulatedSessionId: `simulated-session-${input.seed}-${ordinal}`,
    });
  }
  return seats;
}

function createActiveControllerTasks(input: ValidatedInput): readonly RoomAdaptiveSchedulingActiveWorkItemV1[] {
  const tasks: RoomAdaptiveSchedulingActiveWorkItemV1[] = [];
  for (let index = 0; index < ACTIVE_CONTROLLER_TASK_COUNT; index += 1) {
    tasks.push({
      ...createWorkItem(input, "active", index),
      startedAt: input.asOf,
      atTurnBoundary: true,
    });
  }
  return tasks;
}

function createQueuedControllerTasks(input: ValidatedInput): readonly RoomAdaptiveSchedulingWorkItemV1[] {
  const tasks: RoomAdaptiveSchedulingWorkItemV1[] = [];
  for (let index = 0; index < QUEUED_CONTROLLER_TASK_COUNT; index += 1) {
    tasks.push(createWorkItem(input, "queued", index));
  }
  return tasks;
}

function createWorkItem(
  input: ValidatedInput,
  state: "active" | "queued",
  index: number,
): RoomAdaptiveSchedulingWorkItemV1 {
  return {
    workId: `simulated-${state}-controller-${String(index + 1).padStart(2, "0")}`,
    projectId: input.projectId,
    roomId: input.roomId,
    kind: index % 8 === 0 ? "verifier" : index % 8 === 1 ? "recovery" : "producer",
    qualityScore: 0.5 + (index % 10) / 20,
    criticalPathDistance: index % 5,
    projectPriority: 1,
    roomPriority: 1,
    enqueuedAt: input.asOf,
    requiredSlots: 1,
  };
}

function createGovernorInput(
  input: ValidatedInput,
  active: readonly RoomAdaptiveSchedulingActiveWorkItemV1[],
  queued: readonly RoomAdaptiveSchedulingWorkItemV1[],
): RoomCapacityGovernorInputV1 {
  return {
    contractVersion: ROOM_CAPACITY_GOVERNOR_CONTRACT_VERSION,
    asOf: input.asOf,
    policy: {
      telemetryTtlMs: 60_000,
      maximumFailureRate: 0.2,
      maximumP95LatencyMs: 1_000,
      decreaseStepSlots: 1,
    },
    scheduling: {
      asOf: input.asOf,
      capacity: { totalSlots: ATTACHED_SEAT_COUNT, reservedVerifierSlots: 0, reservedRecoverySlots: 0 },
      policy: {
        minimumProjectReservations: [],
        minimumRoomReservations: [],
        fairnessAgingQuantumMs: 60_000,
        preemptionEnabled: false,
      },
      queued,
      active,
    },
    telemetry: {
      sampledAt: input.asOf,
      queue: { source: "controller_observation", queuedWorkCount: queued.length },
      running: {
        source: "controller_observation",
        activeWorkCount: active.length,
        activeSlots: active.length,
      },
      failures: { source: "controller_observation", attemptCount: active.length, failureCount: 0 },
      latency: { source: "controller_observation", sampleCount: active.length, p95Ms: 100 },
      quota: {
        source: "session_connector_observation",
        state: "clear",
        hardConcurrencyLimit: ACTIVE_CONTROLLER_TASK_COUNT,
        retryAfterMs: null,
      },
      connector: { source: "session_connector_observation", state: "healthy" },
    },
  };
}

function invalidCapacityDecision(): RoomCapacityGovernorDecisionV1 {
  return governRoomCapacity({} as RoomCapacityGovernorInputV1);
}

function proofBoundary(): RoomControlPlaneLoadHarnessProofBoundaryV1 {
  return { tier: "simulated_control_plane", realProviderE2E: false, realSessionE2E: false };
}

function validateInput(input: RoomControlPlaneLoadHarnessInputV1): ValidatedInput | null {
  const raw = input as unknown;
  if (!isRecord(raw) || raw.contractVersion !== ROOM_CONTROL_PLANE_LOAD_HARNESS_CONTRACT_VERSION) return null;
  if (!isCanonicalTimestamp(raw.asOf) || !isNonBlank(raw.projectId) || !isNonBlank(raw.roomId) || !isNonBlank(raw.seed)) return null;
  return { asOf: raw.asOf, projectId: raw.projectId, roomId: raw.roomId, seed: raw.seed };
}

function freezeResult(result: RoomControlPlaneLoadHarnessResultV1): RoomControlPlaneLoadHarnessResultV1 {
  return deepFreeze(result);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

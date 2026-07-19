import {
  createRoomGlobalConcurrencyPostgresPorts,
  type AsyncDataLayer,
  type RoomGlobalConcurrencyPostgresLegacySnapshotReaderV1,
  type RoomGlobalConcurrencyPostgresPolicyV1,
  type RoomGlobalConcurrencyPostgresPortsV1,
} from "@fusion/core";

import {
  RoomGlobalConcurrencyAccounting,
  type RecoverDanglingRoomGlobalConcurrencyClaimsInputV1,
  type RecoverDanglingRoomGlobalConcurrencyClaimsResultV1,
  type RoomGlobalConcurrencyAccountingPortsV1,
  type RoomGlobalConcurrencyWorkClassV1,
} from "./room-global-concurrency-accounting.js";
import type { RoomControllerCapacityAdmissionOptionsV1 } from "./room-controller.js";
import {
  createRoomLegacyTaskTriageSnapshotReader,
  type RoomLegacyTaskTriageSnapshotTaskStoreV1,
} from "./room-legacy-task-triage-snapshot-reader.js";

export type RoomGlobalConcurrencyRuntimePolicyV1 = Omit<RoomGlobalConcurrencyPostgresPolicyV1, "totalSlots"> & {
  readonly totalSlots: number;
};

export interface RoomGlobalConcurrencyControllerAdmissionPolicyV1 {
  readonly workClass: RoomGlobalConcurrencyWorkClassV1;
  readonly slots: number;
  readonly createClaimId?: RoomControllerCapacityAdmissionOptionsV1["createClaimId"];
}

export interface RoomGlobalConcurrencyVerifiedPolicyV1 {
  readonly policy: RoomGlobalConcurrencyRuntimePolicyV1;
  readonly controllerAdmission: RoomGlobalConcurrencyControllerAdmissionPolicyV1;
  readonly verifiedAt: string;
  readonly verificationId: string;
}

export interface CreateRoomGlobalConcurrencyRuntimeInputV1 {
  readonly projectId: string;
  readonly layer: AsyncDataLayer;
  readonly taskStore: RoomLegacyTaskTriageSnapshotTaskStoreV1;
  readonly verifiedPolicy: RoomGlobalConcurrencyVerifiedPolicyV1;
}

export interface RoomGlobalConcurrencyLedgerRecoveryPortV1 {
  recoverDanglingClaims(
    input: RecoverDanglingRoomGlobalConcurrencyClaimsInputV1,
  ): Promise<RecoverDanglingRoomGlobalConcurrencyClaimsResultV1>;
}

export interface RoomGlobalConcurrencyRuntimeV1 {
  readonly projectId: string;
  readonly verifiedPolicy: RoomGlobalConcurrencyVerifiedPolicyV1;
  readonly accounting: RoomGlobalConcurrencyAccounting;
  readonly ports: RoomGlobalConcurrencyAccountingPortsV1;
  readonly postgresPorts: RoomGlobalConcurrencyPostgresPortsV1;
  readonly legacySnapshotReader: RoomGlobalConcurrencyPostgresLegacySnapshotReaderV1;
  readonly capacityAdmission: RoomControllerCapacityAdmissionOptionsV1;
  readonly recovery: RoomGlobalConcurrencyLedgerRecoveryPortV1;
}

export type RoomGlobalConcurrencyRuntimeErrorCodeV1 =
  | "invalid_input"
  | "project_layer_mismatch"
  | "project_store_mismatch"
  | "policy_missing"
  | "policy_invalid";

export class RoomGlobalConcurrencyRuntimeError extends Error {
  public constructor(
    readonly code: RoomGlobalConcurrencyRuntimeErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "RoomGlobalConcurrencyRuntimeError";
  }
}

interface ValidatedRuntimeInputV1 {
  readonly projectId: string;
  readonly layer: AsyncDataLayer;
  readonly taskStore: RoomLegacyTaskTriageSnapshotTaskStoreV1;
  readonly verifiedPolicy: RoomGlobalConcurrencyVerifiedPolicyV1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalString(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function canonicalTimestamp(value: unknown): value is string {
  if (!canonicalString(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isWorkClass(value: unknown): value is RoomGlobalConcurrencyWorkClassV1 {
  return value === "normal" || value === "verifier" || value === "recovery";
}

function normalizeVerifiedPolicy(value: unknown): RoomGlobalConcurrencyVerifiedPolicyV1 {
  if (
    value === undefined
    || value === null
    || (isRecord(value) && (value.policy === undefined || value.policy === null || value.controllerAdmission === undefined || value.controllerAdmission === null))
  ) {
    throw new RoomGlobalConcurrencyRuntimeError(
      "policy_missing",
      "Room global concurrency runtime requires an explicitly verified policy.",
    );
  }
  if (
    !isRecord(value)
    || !isRecord(value.policy)
    || !isRecord(value.policy.reservations)
    || !isRecord(value.controllerAdmission)
  ) {
    throw new RoomGlobalConcurrencyRuntimeError("policy_invalid", "Room global concurrency runtime policy is invalid.");
  }

  const policy = value.policy;
  const reservations = policy.reservations;
  const controllerAdmission = value.controllerAdmission;
  if (!isRecord(reservations) || !isRecord(controllerAdmission)) {
    throw new RoomGlobalConcurrencyRuntimeError("policy_invalid", "Room global concurrency runtime policy is invalid.");
  }
  if (
    !canonicalTimestamp(value.verifiedAt)
    || !canonicalString(value.verificationId)
    || !nonNegativeSafeInteger(policy.totalSlots)
    || !nonNegativeSafeInteger(reservations.verifierSlots)
    || !nonNegativeSafeInteger(reservations.recoverySlots)
    || !nonNegativeSafeInteger(reservations.legacyTaskTriageSlots)
    || !positiveSafeInteger(policy.snapshotTtlMs)
    || reservations.verifierSlots + reservations.recoverySlots + reservations.legacyTaskTriageSlots > policy.totalSlots
    || !isWorkClass(controllerAdmission.workClass)
    || !positiveSafeInteger(controllerAdmission.slots)
    || (controllerAdmission.createClaimId !== undefined && typeof controllerAdmission.createClaimId !== "function")
  ) {
    throw new RoomGlobalConcurrencyRuntimeError("policy_invalid", "Room global concurrency runtime policy is unverified or invalid.");
  }

  return Object.freeze({
    policy: Object.freeze({
      totalSlots: policy.totalSlots,
      reservations: Object.freeze({
        verifierSlots: reservations.verifierSlots,
        recoverySlots: reservations.recoverySlots,
        legacyTaskTriageSlots: reservations.legacyTaskTriageSlots,
      }),
      snapshotTtlMs: policy.snapshotTtlMs,
    }),
    controllerAdmission: Object.freeze({
      workClass: controllerAdmission.workClass,
      slots: controllerAdmission.slots,
      ...(controllerAdmission.createClaimId === undefined
        ? {}
        : { createClaimId: controllerAdmission.createClaimId as RoomControllerCapacityAdmissionOptionsV1["createClaimId"] }),
    }),
    verifiedAt: value.verifiedAt,
    verificationId: value.verificationId,
  });
}

function validateInput(input: unknown): ValidatedRuntimeInputV1 {
  if (!isRecord(input) || !canonicalString(input.projectId)) {
    throw new RoomGlobalConcurrencyRuntimeError("invalid_input", "Room global concurrency runtime requires a canonical project id.");
  }
  if (!isRecord(input.layer) || input.layer.projectId !== input.projectId) {
    throw new RoomGlobalConcurrencyRuntimeError(
      "project_layer_mismatch",
      "Room global concurrency runtime requires an AsyncDataLayer bound to the requested project.",
    );
  }
  if (
    !isRecord(input.taskStore)
    || typeof input.taskStore.getAsyncLayer !== "function"
    || typeof input.taskStore.listTasks !== "function"
  ) {
    throw new RoomGlobalConcurrencyRuntimeError("invalid_input", "Room global concurrency runtime requires a TaskStore reader.");
  }

  const taskStore = input.taskStore as unknown as RoomLegacyTaskTriageSnapshotTaskStoreV1;
  let taskStoreLayer: ReturnType<RoomLegacyTaskTriageSnapshotTaskStoreV1["getAsyncLayer"]>;
  try {
    taskStoreLayer = taskStore.getAsyncLayer();
  } catch {
    throw new RoomGlobalConcurrencyRuntimeError(
      "project_store_mismatch",
      "Room global concurrency runtime could not verify the TaskStore project binding.",
    );
  }
  if (taskStoreLayer?.projectId !== input.projectId) {
    throw new RoomGlobalConcurrencyRuntimeError(
      "project_store_mismatch",
      "Room global concurrency runtime requires a TaskStore bound to the requested project.",
    );
  }

  return Object.freeze({
    projectId: input.projectId,
    layer: input.layer as unknown as AsyncDataLayer,
    taskStore,
    verifiedPolicy: normalizeVerifiedPolicy(input.verifiedPolicy),
  });
}

/**
 * FNXC:RoomGlobalConcurrencyRuntime 2026-07-19-18:07:
 * ProjectEngine may inject this runtime only after it supplies one project-bound
 * AsyncDataLayer, a same-project TaskStore, and explicit verified capacity policy.
 * The factory never invents slots, reservations, occupancy, or telemetry; any
 * scope or policy uncertainty fails before Room admission can begin.
 */
export function createRoomGlobalConcurrencyRuntime(
  input: CreateRoomGlobalConcurrencyRuntimeInputV1,
): RoomGlobalConcurrencyRuntimeV1 {
  const validated = validateInput(input);
  const legacySnapshotReader = createRoomLegacyTaskTriageSnapshotReader({
    projectId: validated.projectId,
    taskStore: validated.taskStore,
  });
  const postgresPorts = createRoomGlobalConcurrencyPostgresPorts({
    layer: validated.layer,
    projectId: validated.projectId,
    policy: validated.verifiedPolicy.policy,
    legacySnapshotReader,
  });
  const ports: RoomGlobalConcurrencyAccountingPortsV1 = Object.freeze({
    snapshotPort: postgresPorts.snapshotPort,
    claimStore: postgresPorts.claimStore,
  });
  const accounting = new RoomGlobalConcurrencyAccounting(ports);
  const capacityAdmission: RoomControllerCapacityAdmissionOptionsV1 = Object.freeze({
    globalAccounting: accounting,
    workClass: validated.verifiedPolicy.controllerAdmission.workClass,
    slots: validated.verifiedPolicy.controllerAdmission.slots,
    ...(validated.verifiedPolicy.controllerAdmission.createClaimId === undefined
      ? {}
      : { createClaimId: validated.verifiedPolicy.controllerAdmission.createClaimId }),
  });
  const recovery: RoomGlobalConcurrencyLedgerRecoveryPortV1 = Object.freeze({
    recoverDanglingClaims: accounting.recoverDanglingClaims.bind(accounting),
  });

  return Object.freeze({
    projectId: validated.projectId,
    verifiedPolicy: validated.verifiedPolicy,
    accounting,
    ports,
    postgresPorts,
    legacySnapshotReader,
    capacityAdmission,
    recovery,
  });
}

import { randomUUID } from "node:crypto";

import type {
  RoomAggregateV1,
  RoomCapabilityRegistryProjectionV1,
  RoomLifecycleState,
  RunAuditEventInput,
  StoredRoomLeaseV1,
} from "@fusion/core";

import { createLogger } from "./logger.js";
import { persistTaskDispatchCapacityAdmissions } from "./room-task-capacity-admission-audit.js";
import {
  ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
  type RoomGlobalConcurrencyAcquireInputV1,
  type RoomGlobalConcurrencyMutationResultV1,
  type RoomGlobalConcurrencyReleaseInputV1,
  type RoomGlobalConcurrencyRenewInputV1,
  type RoomGlobalConcurrencyWorkClassV1,
} from "./room-global-concurrency-accounting.js";
import type { DispatchReadyRoomTasksResult } from "./room-dependency-dispatch-coordinator.js";
import type {
  ProcessRoomSemanticControllerInboxInput,
  RoomSemanticControllerInboxProcessSummary,
} from "./room-semantic-controller-inbox-processor.js";
import type {
  RequestRoomCandidateSynthesisV1,
  RoomCandidateSynthesisResultV1,
} from "./room-candidate-synthesis-coordinator.js";
import type {
  RoomCandidateFanoutBlindReviewInputV1,
  RoomCandidateFanoutBlindReviewResultV1,
} from "./room-candidate-fanout-blind-review-coordinator.js";
import type {
  ExecuteRoomDeterministicEvidenceGatesV1,
  RoomDeterministicEvidenceGateCoordinatorResultV1,
} from "./room-deterministic-evidence-gate-coordinator.js";
import type {
  RequestRoomIndependentArbitrationV1,
  RoomIndependentArbitrationResultV1,
} from "./room-independent-arbitration-coordinator.js";
import {
  RoomTerminalizationCommitCoordinator,
  type CommitRoomTerminalizationInputV1,
  type CommitRoomTerminalizationResultV1,
  type RoomTerminalizationCommitStore,
} from "./room-terminalization-commit-coordinator.js";
import {
  MAX_ROOM_CAPABILITY_REGISTRY_UPDATE_SAMPLES,
  ROOM_CAPABILITY_REGISTRY_UPDATER_CONTRACT_VERSION,
  updateRoomCapabilityRegistry,
  type RoomCapabilityRegistryUpdateInputV1,
  type RoomCapabilityRegistryUpdateResultV1,
  type RoomCapabilityRegistryWriterPortV1,
} from "./room-capability-registry-updater.js";
import {
  aggregateRoomConnectorCapabilityObservations,
  ROOM_CONNECTOR_CAPABILITY_OBSERVATION_AGGREGATOR_CONTRACT_VERSION,
} from "./room-connector-capability-observation-aggregator.js";
import {
  collectRoomConnectorRuntimeObservation,
  ROOM_CONNECTOR_RUNTIME_OBSERVATION_REPORTER_CONTRACT_VERSION,
  type ControlledRoomConnectorRuntimeObservationPortV1,
} from "./room-connector-runtime-observation-reporter.js";
import type { RoomBindingCapabilityReporterFreshnessV1 } from "./room-binding-capability-reporter.js";
import type { RoomHostCompositionAuthorityGuardV1 } from "./room-host-composition.js";

const roomControllerLog = createLogger("room-controller");

export interface RoomControllerRoomStore {
  listRunnableRooms(): Promise<readonly RoomAggregateV1[]>;
  getRoom?(roomId: string): Promise<RoomAggregateV1 | undefined>;
  getRoomCapabilityRegistry?(roomId: string): Promise<RoomCapabilityRegistryProjectionV1 | null>;
  getRecoveryPosture?(roomId: string): Promise<RoomControllerRecoveryPosture>;
  assertWorkerAuthority?(input: {
    readonly roomId: string;
    readonly lease: StoredRoomLeaseV1;
    readonly expectedAggregateVersion: number;
    readonly now: string;
  }): Promise<RoomWorkerAuthorityV1>;
  recordRoomCapabilityRegistry?: RoomCapabilityRegistryWriterPortV1["recordRoomCapabilityRegistry"];
  recordRoomTerminalizationContract?: RoomTerminalizationCommitStore["recordRoomTerminalizationContract"];
  terminalizeRoom?: RoomTerminalizationCommitStore["terminalizeRoom"];
  subscribe?(listener: () => void | Promise<void>): () => void;
}

export interface RoomControllerRecoveryPosture {
  readonly lifecycleState: RoomLifecycleState;
  readonly aggregateVersion: number;
  readonly humanPaused: boolean;
  readonly approvalState: "none" | "waiting" | "blocked";
}

export interface RoomWorkerAuthorityV1 {
  readonly lease: StoredRoomLeaseV1;
  readonly posture: RoomControllerRecoveryPosture;
}

/**
 * A worker can propose terminalization only through its controller-owned
 * callback. The callback supplies the Room id, current fence, and one pinned
 * timestamp; these authority-bearing fields are never worker-provided.
 */
export type RoomWorkerTerminalizationInputV1 = Omit<
  CommitRoomTerminalizationInputV1,
  "roomId" | "roomWorkerFence" | "occurredAt"
>;

/**
 * The controller derives Room identity, fence, contract version, and sampling
 * time. A worker may contribute only a trusted connector observation and CAS
 * expectations, never a self-issued capability authority.
 */
export type RoomWorkerCapabilityRegistryUpdateInputV1 = Omit<
  RoomCapabilityRegistryUpdateInputV1,
  "contractVersion" | "projectId" | "roomId" | "roomWorkerFence" | "sampledAt"
>;

export type RoomWorkerIndependentArbitrationInputV1 = Omit<
  RequestRoomIndependentArbitrationV1,
  "scope"
> & {
  readonly expectedAggregateVersion: number;
};

export type RoomWorkerCandidateSynthesisInputV1 = Omit<
  RequestRoomCandidateSynthesisV1,
  "scope"
> & {
  readonly expectedAggregateVersion: number;
};

export type RoomWorkerBlindReviewFanoutInputV1 = Omit<
  RoomCandidateFanoutBlindReviewInputV1,
  "scope"
> & {
  readonly expectedAggregateVersion: number;
};

export type RoomWorkerDeterministicEvidenceGateInputV1 = Omit<
  ExecuteRoomDeterministicEvidenceGatesV1,
  "scope"
> & {
  readonly expectedAggregateVersion: number;
};

export interface RoomIndependentArbitrationWorkflowV1 {
  arbitrate(input: RequestRoomIndependentArbitrationV1): Promise<RoomIndependentArbitrationResultV1>;
}

export interface RoomCandidateSynthesisWorkflowV1 {
  synthesize(input: RequestRoomCandidateSynthesisV1): Promise<RoomCandidateSynthesisResultV1>;
}

export interface RoomCandidateFanoutBlindReviewWorkflowV1 {
  prepare(input: RoomCandidateFanoutBlindReviewInputV1): Promise<RoomCandidateFanoutBlindReviewResultV1>;
}

export interface RoomDeterministicEvidenceGateWorkflowV1 {
  execute(input: ExecuteRoomDeterministicEvidenceGatesV1): Promise<RoomDeterministicEvidenceGateCoordinatorResultV1>;
}

export interface RoomControllerEvidenceWorkflowsV1 {
  readonly arbitration?: RoomIndependentArbitrationWorkflowV1;
  readonly synthesis?: RoomCandidateSynthesisWorkflowV1;
  readonly blindReviewFanout?: RoomCandidateFanoutBlindReviewWorkflowV1;
  readonly deterministicEvidenceGates?: RoomDeterministicEvidenceGateWorkflowV1;
}

/**
 * FNXC:RoomControllerCentralCapacityPort 2026-07-20-07:17:
 * Controller-facing capability is deliberately narrower than either the old
 * Room ledger or CentralCore. The controller may only mutate its own fenced
 * Room-worker claim; it never receives a policy writer, snapshot, or arbitrary
 * resource-kind port.
 */
export interface RoomControllerGlobalCapacityAccountingPortV1 {
  acquire(input: RoomGlobalConcurrencyAcquireInputV1): Promise<RoomGlobalConcurrencyMutationResultV1>;
  renew(input: RoomGlobalConcurrencyRenewInputV1): Promise<RoomGlobalConcurrencyMutationResultV1>;
  release(input: RoomGlobalConcurrencyReleaseInputV1): Promise<RoomGlobalConcurrencyMutationResultV1>;
}

export interface RoomControllerCapacityClaimIdInputV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly lease: StoredRoomLeaseV1;
  readonly expectedAggregateVersion: number;
  readonly workClass: RoomGlobalConcurrencyWorkClassV1;
  readonly slots: number;
}

export type RoomControllerCapacityReleaseOutcomeV1 =
  | "worker_completed"
  | "worker_failed"
  | "controller_stop"
  | "room_not_runnable"
  | "lease_lost"
  | "recovery_withheld"
  | "semantic_inbox_stopped"
  | "renew_guard_lost"
  | "capacity_renewal_failed"
  | "capacity_admission_failed"
  | "pre_start_authority_lost"
  | "start_audit_failed"
  | "unknown";

/*
FNXC:RoomControllerCapacityAdmission 2026-07-19-17:43:
A Room may contain several provider bindings, so controller admission reserves
only global Room work behind its durable lease and aggregate fence. Provider,
account, model, connector, and node backpressure belongs at the actual connector
delivery boundary, where the exact binding is known; the controller must never
guess a scope or create a Room-wide provider reservation. Global refusal is
persisted and every acquired global claim is compensated exactly once.
*/
export interface RoomControllerCapacityAdmissionOptionsV1 {
  readonly globalAccounting: RoomControllerGlobalCapacityAccountingPortV1;
  readonly workClass: RoomGlobalConcurrencyWorkClassV1;
  readonly slots: number;
  /** Central capacity owns the one TTL shared by the Room worker and its claim. */
  readonly leaseTtlMs: number;
  /** The controller must reconcile at least this often while the central claim is live. */
  readonly renewalIntervalMs: number;
  readonly createClaimId?: (input: RoomControllerCapacityClaimIdInputV1) => string;
}

class RoomWorkerAuthorityError extends Error {
  readonly code = "room_worker_authority_revoked" as const;

  constructor(
    readonly posture: RoomControllerRecoveryPosture,
    readonly reason: string,
  ) {
    super(`Room worker authority revoked: ${reason}`);
    this.name = "RoomWorkerAuthorityError";
  }
}

function isRoomWorkerAuthorityError(error: unknown): error is RoomWorkerAuthorityError {
  if (!error || typeof error !== "object") return false;
  const candidate = error as Partial<RoomWorkerAuthorityError>;
  return candidate.code === "room_worker_authority_revoked"
    && typeof candidate.reason === "string"
    && Boolean(candidate.posture);
}

export type RoomControllerAuditMutationType =
  | "room:worker-lease-acquired" | "room:worker-lease-taken-over"
  | "room:worker-capacity-admitted" | "room:worker-capacity-withheld" | "room:task-capacity-admission"
  | "room:capability-registry-withheld"
  | "room:worker-lease-lost"
  | "room:worker-started"
  | "room:worker-stopped"
  | "room:worker-stop-timeout"
  | "room:worker-recovery-failed"
  | "room:worker-recovery-withheld";

export type RoomControllerAuditEvent = Omit<RunAuditEventInput, "mutationType"> & {
  readonly id: string;
  readonly projectId: string;
  readonly timestamp: string;
  readonly mutationType: RoomControllerAuditMutationType;
};

export interface RoomControllerLeaseStore {
  acquireLease(input: {
    leaseId: string;
    roomId: string;
    kind: "room_worker";
    resourceId: string;
    holderId: string;
    hostId: string;
    expectedEpoch: number | null;
    now: string;
    expiresAt: string;
  }): Promise<
    | { ok: true; action: "acquired" | "taken_over"; lease: StoredRoomLeaseV1 }
    | { ok: false; reason: "active" | "stale_epoch"; current: StoredRoomLeaseV1 | null }
  >;
  renewLease(input: {
    leaseId: string;
    roomId: string;
    kind: "room_worker";
    resourceId: string;
    holderId: string;
    hostId: string;
    expectedEpoch: number;
    now: string;
    expiresAt: string;
  }): Promise<
    | { ok: true; lease: StoredRoomLeaseV1 }
    | { ok: false; reason: "not_found" | "stale_fence" | "expired"; current: StoredRoomLeaseV1 | null }
  >;
  releaseLease(input: {
    leaseId: string;
    roomId: string;
    kind: "room_worker";
    resourceId: string;
    holderId: string;
    hostId: string;
    expectedEpoch: number;
    now: string;
  }): Promise<unknown>;
  assertFence(input: {
    leaseId: string;
    roomId: string;
    kind: "room_worker";
    resourceId: string;
    holderId: string;
    hostId: string;
    expectedEpoch: number;
    now: string;
  }): Promise<StoredRoomLeaseV1>;
}

export interface RoomControllerCheckpointStore {
  replayProjection(roomId: string): Promise<{ readonly aggregate: RoomAggregateV1 }>;
}

export interface RoomWorkerRunInput {
  readonly room: RoomAggregateV1;
  readonly lease: StoredRoomLeaseV1;
  readonly signal: AbortSignal;
  /**
   * Worker-facing authorization seam backed by the durable lease fence. This
   * proves the caller still owns its epoch; Task 4.5/4.6 attach it to each
   * provider/store mutation transaction.
   */
  readonly assertAuthority: () => Promise<RoomWorkerAuthorityV1>;
  /** @deprecated Use assertAuthority; this alias now executes the same combined guard. */
  readonly assertLeaseAuthority: () => Promise<StoredRoomLeaseV1>;
  /** Present only when the controller has both durable terminalization store operations. */
  readonly terminalizeRoom?: (
    input: RoomWorkerTerminalizationInputV1,
  ) => Promise<CommitRoomTerminalizationResultV1>;
  /** Present only when the controller exposes Core's fenced capability-registry writer. */
  readonly recordCapabilityRegistry?: (
    input: RoomWorkerCapabilityRegistryUpdateInputV1,
  ) => Promise<RoomCapabilityRegistryUpdateResultV1>;
  readonly arbitrateCandidates?: (
    input: RoomWorkerIndependentArbitrationInputV1,
  ) => Promise<RoomIndependentArbitrationResultV1>;
  readonly synthesizeCandidates?: (
    input: RoomWorkerCandidateSynthesisInputV1,
  ) => Promise<RoomCandidateSynthesisResultV1>;
  readonly prepareBlindReviewFanout?: (
    input: RoomWorkerBlindReviewFanoutInputV1,
  ) => Promise<RoomCandidateFanoutBlindReviewResultV1>;
  readonly executeDeterministicEvidenceGates?: (
    input: RoomWorkerDeterministicEvidenceGateInputV1,
  ) => Promise<RoomDeterministicEvidenceGateCoordinatorResultV1>;
}

export interface RoomWorker {
  /**
   * Custom workers must opt in before ProjectEngine lets the controller create
   * task-dispatch outbox intent for them to deliver.
   */
  readonly supportsDurableTaskDispatch?: boolean;
  runRoom(input: RoomWorkerRunInput): Promise<void>;
}

export interface RoomTaskDispatcher {
  dispatchReadyTasks(input: {
    readonly room: RoomAggregateV1;
    readonly lease: StoredRoomLeaseV1;
    readonly renewLease: (lease: StoredRoomLeaseV1) => Promise<StoredRoomLeaseV1>;
    readonly canContinue?: () => boolean;
  }): Promise<DispatchReadyRoomTasksResult>;
}

/**
 * Controller-owned, provider-free consumption of semantic routes addressed to
 * the Room itself. Its claim/complete operations share the Room-worker fence
 * with task dispatch, so browser lifetime and a stale controller cannot turn
 * an accepted semantic message into an in-process-only side effect.
 */
export interface RoomSemanticControllerInboxProcessor {
  process(
    input: ProcessRoomSemanticControllerInboxInput,
  ): Promise<RoomSemanticControllerInboxProcessSummary>;
}

export interface RoomControllerOptions {
  readonly projectId: string;
  readonly workerId: string;
  readonly hostId: string;
  readonly roomStore: RoomControllerRoomStore;
  readonly leaseStore: RoomControllerLeaseStore;
  readonly checkpointStore?: RoomControllerCheckpointStore;
  readonly worker: RoomWorker;
  /**
   * Optional durable pre-worker planner. It may create only fenced task
   * dispatch intent; external delivery remains owned by `worker`.
   */
  readonly taskDispatcher?: RoomTaskDispatcher;
  /** Durable controller-directed protocol work; it performs no provider send. */
  readonly semanticControllerInboxProcessor?: RoomSemanticControllerInboxProcessor;
  readonly evidenceWorkflows?: RoomControllerEvidenceWorkflowsV1;
  readonly capacityAdmission?: RoomControllerCapacityAdmissionOptionsV1;
  /**
   * Optional revalidation of the host-issued Room composition bundle. A
   * withheld result fences new worker work and stops an existing controller
   * before it can renew leases, capacity, task dispatch, or provider delivery.
   */
  readonly hostCompositionAuthorityGuard?: RoomHostCompositionAuthorityGuardV1;
  /**
   * Optional controller-owned refresh of the complete durable capability
   * registry before dispatch. Production composition is responsible for
   * supplying a concrete controlled observation port.
   */
  readonly capabilityRegistryRefresh?: RoomControllerCapabilityRegistryRefreshOptionsV1;
  readonly now?: () => string;
  readonly createLeaseId?: (roomId: string, workerId: string) => string;
  readonly leaseDurationMs?: number;
  readonly pollIntervalMs?: number;
  readonly shutdownGraceMs?: number;
  readonly workerRestartBaseDelayMs?: number;
  readonly workerRestartMaxDelayMs?: number;
  readonly workerRestartMaxRestarts?: number;
  readonly auditMaxAttempts?: number;
  /** Durable persistence seam; successful resolution means the event is committed to an outbox. */
  readonly recordRunAuditEvent: (event: RoomControllerAuditEvent) => Promise<void>;
}

export interface RoomControllerCapabilityRegistryRefreshOptionsV1 {
  readonly observationPort: ControlledRoomConnectorRuntimeObservationPortV1;
  readonly reportFreshness: RoomBindingCapabilityReporterFreshnessV1;
  readonly registryFreshness: RoomCapabilityRegistryUpdateInputV1["freshness"];
  readonly createIdempotencyKey?: (input: {
    readonly roomId: string;
    readonly lease: StoredRoomLeaseV1;
    readonly aggregateVersion: number;
    readonly registryRevision: number;
    readonly asOf: string;
  }) => string;
}

interface RoomWorkerHandle {
  readonly roomId: string;
  readonly lifecycleGeneration: number;
  projectionVersion: number;
  readonly source: string;
  readonly abortController: AbortController;
  lease: StoredRoomLeaseV1;
  runPromise: Promise<void>;
  completionPromise: Promise<void>;
  releasePromise: Promise<void> | null;
  stopPromise: Promise<void> | null;
  stopReason: string | null;
  stopSource: string | null;
  startAuditPromise: Promise<void> | null;
  terminationAuditPromise: Promise<void> | null;
  capacityAdmission: RoomWorkerCapacityAdmission | null;
  capacityReleasePromise: Promise<void> | null;
  capacityReleased: boolean;
  workerLaunchCommitted: boolean;
  released: boolean;
}

interface RoomWorkerCapacityAdmission {
  readonly claimId: string;
  readonly acquireOperationId: string;
  readonly releaseOperationId: string;
  readonly workClass: RoomGlobalConcurrencyWorkClassV1;
  readonly slots: number;
  globalReleased: boolean;
  releaseAsOf: string | null;
}

interface RoomCapabilityRegistryRefreshResult {
  readonly room: RoomAggregateV1;
  readonly scheduling: "schedulable" | "not_schedulable";
}

interface RoomRestartState {
  readonly projectionVersion: number;
  readonly failures: number;
  readonly nextAttemptAtMs: number;
}

const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
const DEFAULT_WORKER_RESTART_BASE_DELAY_MS = 1_000;
const DEFAULT_WORKER_RESTART_MAX_DELAY_MS = 60_000;
const DEFAULT_WORKER_RESTART_MAX_RESTARTS = 5;
const DEFAULT_AUDIT_MAX_ATTEMPTS = 3;
const LEASE_RELEASE_MAX_ATTEMPTS = 3;
const CAPACITY_RELEASE_MAX_ATTEMPTS = 3;

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`RoomController ${name} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`RoomController ${name} must be a non-negative safe integer`);
  }
  return value;
}

function isRoomCapacityWorkClass(value: RoomGlobalConcurrencyWorkClassV1): boolean {
  return value === "normal" || value === "verifier" || value === "recovery";
}

function nonBlankString(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`RoomController ${name} must be a non-blank string`);
  }
  return value;
}

function isSafeHostCompositionWithheldReason(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_:-]{0,127}$/.test(value);
}

function leaseMutationInput(lease: StoredRoomLeaseV1, now: string) {
  return {
    leaseId: lease.id,
    roomId: lease.roomId,
    kind: "room_worker" as const,
    resourceId: lease.resourceId,
    holderId: lease.holderId,
    hostId: lease.hostId,
    expectedEpoch: lease.epoch,
    now,
  };
}

function sameRoomWorkerLease(left: StoredRoomLeaseV1, right: StoredRoomLeaseV1): boolean {
  return left.id === right.id
    && left.roomId === right.roomId
    && left.kind === "room_worker"
    && right.kind === "room_worker"
    && left.resourceId === right.resourceId
    && left.holderId === right.holderId
    && left.hostId === right.hostId
    && left.epoch === right.epoch
    && left.releasedAt === null
    && right.releasedAt === null;
}

function isRoomTerminalizationCommitStore(
  store: RoomControllerRoomStore,
): store is RoomControllerRoomStore & RoomTerminalizationCommitStore {
  return typeof store.recordRoomTerminalizationContract === "function"
    && typeof store.terminalizeRoom === "function";
}

function isRoomCapabilityRegistryWriter(
  store: RoomControllerRoomStore,
): store is RoomControllerRoomStore & RoomCapabilityRegistryWriterPortV1 {
  return typeof store.recordRoomCapabilityRegistry === "function";
}

/**
 * Backend-owned supervisor for durable operational Rooms. It owns only worker
 * lifecycle and lease fencing. When configured, it establishes durable task
 * dispatch intent before creating the fixed-version recovery worker; external
 * delivery remains delegated to that worker.
 */
export class RoomController {
  private readonly now: () => string;
  private readonly createLeaseId: (roomId: string, workerId: string) => string;
  private readonly leaseDurationMs: number;
  private readonly pollIntervalMs: number;
  private readonly shutdownGraceMs: number;
  private readonly roomOperationBudgetMs: number;
  private readonly workerRestartBaseDelayMs: number;
  private readonly workerRestartMaxDelayMs: number;
  private readonly workerRestartMaxRestarts: number;
  private readonly auditMaxAttempts: number;
  private readonly terminalizationCoordinator: RoomTerminalizationCommitCoordinator | null;
  private readonly handles = new Map<string, RoomWorkerHandle>();
  private readonly pendingCapacityReleases = new Map<string, RoomWorkerHandle>();
  private readonly roomOperations = new Map<string, Promise<void>>();
  private readonly restartStates = new Map<string, RoomRestartState>();
  private readonly auditDeliveries = new Set<Promise<void>>();
  private readonly auditRunId = `room-controller:${randomUUID()}`;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private reconcileInFlight: Promise<void> | null = null;
  private started = false;
  private stopping = false;
  private lifecycleWritesClosed = true;
  private lifecycleGeneration = 0;
  private stopInFlight: Promise<void> | null = null;

  constructor(private readonly options: RoomControllerOptions) {
    let capacityTiming: {
      readonly leaseTtlMs: number;
      readonly renewalIntervalMs: number;
    } | null = null;
    if (!options.projectId.trim() || !options.workerId.trim() || !options.hostId.trim()) {
      throw new Error("RoomController projectId, workerId, and hostId are required");
    }
    if (options.taskDispatcher && !options.roomStore.assertWorkerAuthority) {
      throw new Error("RoomController taskDispatcher requires roomStore.assertWorkerAuthority");
    }
    if (
      options.hostCompositionAuthorityGuard !== undefined
      && typeof options.hostCompositionAuthorityGuard.assertCurrent !== "function"
    ) {
      throw new Error("RoomController hostCompositionAuthorityGuard requires assertCurrent");
    }
    if (options.capabilityRegistryRefresh) {
      if (typeof options.capabilityRegistryRefresh.observationPort?.observe !== "function") {
        throw new Error("RoomController capabilityRegistryRefresh requires observationPort.observe");
      }
      if (
        !isRoomCapabilityRegistryWriter(options.roomStore)
        || typeof options.roomStore.getRoomCapabilityRegistry !== "function"
        || typeof options.roomStore.getRoom !== "function"
      ) {
        throw new Error(
          "RoomController capabilityRegistryRefresh requires durable registry writer, reader, and room projection reader",
        );
      }
      if (
        options.capabilityRegistryRefresh.createIdempotencyKey
        && typeof options.capabilityRegistryRefresh.createIdempotencyKey !== "function"
      ) {
        throw new Error("RoomController capabilityRegistryRefresh createIdempotencyKey must be a function");
      }
    }
    if (
      options.evidenceWorkflows?.arbitration
      && typeof options.evidenceWorkflows.arbitration.arbitrate !== "function"
    ) {
      throw new Error("RoomController arbitration workflow requires arbitrate");
    }
    if (
      options.evidenceWorkflows?.synthesis
      && typeof options.evidenceWorkflows.synthesis.synthesize !== "function"
    ) {
      throw new Error("RoomController synthesis workflow requires synthesize");
    }
    if (
      options.evidenceWorkflows?.blindReviewFanout
      && typeof options.evidenceWorkflows.blindReviewFanout.prepare !== "function"
    ) {
      throw new Error("RoomController blind-review fan-out workflow requires prepare");
    }
    if (
      options.evidenceWorkflows?.deterministicEvidenceGates
      && typeof options.evidenceWorkflows.deterministicEvidenceGates.execute !== "function"
    ) {
      throw new Error("RoomController deterministic evidence-gate workflow requires execute");
    }
    if (options.capacityAdmission) {
      const capacity = options.capacityAdmission;
      if (
        !capacity.globalAccounting
        || typeof capacity.globalAccounting.acquire !== "function"
        || typeof capacity.globalAccounting.renew !== "function"
        || typeof capacity.globalAccounting.release !== "function"
      ) {
        throw new Error("RoomController capacityAdmission requires globalAccounting acquire, renew, and release");
      }
      if (!isRoomCapacityWorkClass(capacity.workClass)) {
        throw new Error("RoomController capacityAdmission workClass is invalid");
      }
      positiveInteger(capacity.slots, "capacityAdmission.slots");
      /*
      FNXC:RoomControllerCentralCapacityTiming 2026-07-20-07:44:
      A central capacity claim cannot outlive a divergent local Room lease.
      When admission is enabled, use the policy-owned TTL for every Room-worker
      acquire and renewal, and cap controller polling at the policy renewal
      interval. Reject malformed or conflicting timings before any lease, task,
      semantic action, or worker can start.
      */
      const leaseTtlMs = positiveInteger(
        capacity.leaseTtlMs,
        "capacityAdmission.leaseTtlMs",
      );
      const renewalIntervalMs = positiveInteger(
        capacity.renewalIntervalMs,
        "capacityAdmission.renewalIntervalMs",
      );
      if (renewalIntervalMs >= leaseTtlMs) {
        throw new Error(
          "RoomController capacityAdmission.renewalIntervalMs must be strictly less than capacityAdmission.leaseTtlMs",
        );
      }
      capacityTiming = { leaseTtlMs, renewalIntervalMs };
      if (
        options.leaseDurationMs !== undefined
        && positiveInteger(options.leaseDurationMs, "leaseDurationMs") !== leaseTtlMs
      ) {
        throw new Error("RoomController leaseDurationMs must match capacityAdmission.leaseTtlMs");
      }
      if (capacity.createClaimId && typeof capacity.createClaimId !== "function") {
        throw new Error("RoomController capacityAdmission createClaimId must be a function");
      }
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.terminalizationCoordinator = isRoomTerminalizationCommitStore(options.roomStore)
      ? new RoomTerminalizationCommitCoordinator({
          projectId: options.projectId,
          controllerId: options.workerId,
          store: options.roomStore,
        })
      : null;
    this.createLeaseId = options.createLeaseId ?? (() => randomUUID());
    const requestedLeaseDurationMs = options.leaseDurationMs === undefined
      ? null
      : positiveInteger(options.leaseDurationMs, "leaseDurationMs");
    const requestedPollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
    );
    this.leaseDurationMs = capacityTiming?.leaseTtlMs
      ?? requestedLeaseDurationMs
      ?? DEFAULT_LEASE_DURATION_MS;
    this.pollIntervalMs = capacityTiming
      ? Math.min(requestedPollIntervalMs, capacityTiming.renewalIntervalMs)
      : requestedPollIntervalMs;
    this.shutdownGraceMs = positiveInteger(
      options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
      "shutdownGraceMs",
    );
    this.roomOperationBudgetMs = Math.max(
      1,
      Math.min(this.pollIntervalMs, Math.floor(this.leaseDurationMs / 3)),
    );
    this.workerRestartBaseDelayMs = positiveInteger(
      options.workerRestartBaseDelayMs ?? DEFAULT_WORKER_RESTART_BASE_DELAY_MS,
      "workerRestartBaseDelayMs",
    );
    this.workerRestartMaxDelayMs = positiveInteger(
      options.workerRestartMaxDelayMs ?? DEFAULT_WORKER_RESTART_MAX_DELAY_MS,
      "workerRestartMaxDelayMs",
    );
    if (this.workerRestartMaxDelayMs < this.workerRestartBaseDelayMs) {
      throw new Error("RoomController workerRestartMaxDelayMs must be at least workerRestartBaseDelayMs");
    }
    this.workerRestartMaxRestarts = nonNegativeInteger(
      options.workerRestartMaxRestarts ?? DEFAULT_WORKER_RESTART_MAX_RESTARTS,
      "workerRestartMaxRestarts",
    );
    this.auditMaxAttempts = positiveInteger(
      options.auditMaxAttempts ?? DEFAULT_AUDIT_MAX_ATTEMPTS,
      "auditMaxAttempts",
    );
  }

  async start(): Promise<void> {
    if (this.stopInFlight) await this.stopInFlight;
    if (this.started) return;
    this.lifecycleGeneration += 1;
    this.lifecycleWritesClosed = false;
    this.started = true;
    this.stopping = false;
    this.unsubscribe = this.options.roomStore.subscribe?.(() => {
      void this.reconcile("committed-event");
    }) ?? null;
    try {
      await this.reconcile("startup");
      this.scheduleNextReconcile();
    } catch (error) {
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.started = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopInFlight) return this.stopInFlight;
    const operation = this.stopWithinBudget().finally(() => {
      if (this.stopInFlight === operation) this.stopInFlight = null;
    });
    this.stopInFlight = operation;
    return operation;
  }

  private async stopWithinBudget(): Promise<void> {
    if (
      !this.started
      && this.handles.size === 0
      && this.pendingCapacityReleases.size === 0
      && !this.reconcileInFlight
      && this.auditDeliveries.size === 0
    ) {
      this.lifecycleWritesClosed = true;
      return;
    }
    this.stopping = true;
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;

    const activeHandles = new Set(this.handles.values());
    const cleanupHandles = [
      ...new Set([
        ...activeHandles,
        ...this.pendingCapacityReleases.values(),
      ]),
    ];
    const workerBudgetMs = this.shutdownGraceMs;
    const pending = [
      this.reconcileInFlight?.catch(() => undefined),
      ...this.roomOperations.values(),
      ...cleanupHandles.map((handle) => (
        activeHandles.has(handle)
          ? this.stopHandle(handle, true, "controller_stop", "shutdown", workerBudgetMs)
          : this.releaseHandle(handle)
      )),
    ].filter((value): value is Promise<void> => Boolean(value));
    await this.waitWithinBudget(Promise.allSettled(pending), workerBudgetMs);
    await this.drainAuditDeliveries();
    // No callback may create a fresh durable write after ProjectEngine is
    // allowed to stop the dispatcher and close the runtime data layer.
    this.lifecycleWritesClosed = true;

    this.handles.clear();
    this.pendingCapacityReleases.clear();
    this.roomOperations.clear();
    this.restartStates.clear();
    this.reconcileInFlight = null;
    this.stopping = false;
  }

  reconcile(reason = "manual"): Promise<void> {
    if (this.stopping || !this.started) return Promise.resolve();
    if (this.reconcileInFlight) return this.reconcileInFlight;
    const lifecycleGeneration = this.lifecycleGeneration;
    const operation = this.reconcileNow(reason, lifecycleGeneration)
      .catch((error) => {
        roomControllerLog.warn(
          `Room reconcile failed for ${this.options.projectId} (${reason}): ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (this.reconcileInFlight === operation) this.reconcileInFlight = null;
      });
    this.reconcileInFlight = operation;
    return operation;
  }

  private scheduleNextReconcile(): void {
    if (!this.started || this.stopping || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.reconcile("poll").finally(() => this.scheduleNextReconcile());
    }, this.pollIntervalMs);
  }

  private async reconcileNow(reason: string, lifecycleGeneration: number): Promise<void> {
    /*
    FNXC:RoomControllerCentralCapacityReleaseRetry 2026-07-20-08:01:
    A Room whose central release is not yet acknowledged remains fenced by its
    existing Room lease. Retry that exact claim before any renewal or new
    worker claim, and skip its replacement for this pass even if cleanup wins.
    This avoids a transient central outage creating a second worker or freeing
    the local lease while the global ledger may still count the first one.
    */
    const pendingAtStart = new Set(this.pendingCapacityReleases.keys());
    if (pendingAtStart.size > 0) {
      await Promise.all([...pendingAtStart].map((roomId) => (
        this.runRoomOperation(roomId, async () => {
          const handle = this.pendingCapacityReleases.get(roomId);
          if (handle) await this.releaseHandle(handle);
        })
      )));
    }
    if (!this.canStartLeaseMutation(lifecycleGeneration)) return;
    const runnableRooms = await this.options.roomStore.listRunnableRooms();
    if (!this.canStartLeaseMutation(lifecycleGeneration)) return;
    const runnableById = new Map(runnableRooms.map((room) => [room.room.id, room]));
    const runnableIds = new Set(runnableById.keys());
    const operations: Promise<void>[] = [];
    for (const handle of [...this.handles.values()]) {
      if (handle.lifecycleGeneration !== lifecycleGeneration) continue;
      if (!runnableIds.has(handle.roomId)) {
        operations.push(this.runRoomOperation(handle.roomId, () => (
          this.stopHandle(handle, true, "room_not_runnable", reason)
        )));
        continue;
      }
      operations.push(this.runRoomOperation(handle.roomId, () => (
        this.renewHandle(handle, reason, runnableById.get(handle.roomId))
      )));
    }
    for (const room of runnableRooms) {
      if (
        !this.canStartLeaseMutation(lifecycleGeneration)
        || this.handles.has(room.room.id)
        || this.pendingCapacityReleases.has(room.room.id)
        || pendingAtStart.has(room.room.id)
      ) continue;
      if (!this.canClaimRoom(room)) continue;
      operations.push(this.runRoomOperation(
        room.room.id,
        () => this.claimRoom(room, reason, lifecycleGeneration),
      ));
    }
    await Promise.all(operations);
  }

  private async claimRoom(
    room: RoomAggregateV1,
    source: string,
    lifecycleGeneration: number,
  ): Promise<void> {
    if (!this.canStartLeaseMutation(lifecycleGeneration)) return;
    if (this.options.roomStore.getRecoveryPosture) {
      const initialGuard = await this.readRunGuard(room.room.id);
      if (!this.canStartLeaseMutation(lifecycleGeneration)) return;
      const initialReason = initialGuard.reason
        ?? (initialGuard.posture.aggregateVersion === room.room.aggregateVersion
          ? null
          : "posture_version_changed");
      if (initialReason) {
        await this.recordRecoveryWithheld(
          room.room.id,
          initialGuard.posture,
          initialReason,
          source,
          lifecycleGeneration,
        );
        return;
      }
    }
    const now = this.now();
    const leaseId = this.createLeaseId(room.room.id, this.options.workerId);
    const baseInput = {
      leaseId,
      roomId: room.room.id,
      kind: "room_worker" as const,
      resourceId: room.room.id,
      holderId: this.options.workerId,
      hostId: this.options.hostId,
      now,
      expiresAt: this.expiresAt(now),
    };
    let acquired = await this.options.leaseStore.acquireLease({
      ...baseInput,
      expectedEpoch: null,
    });
    if (!this.isLifecycleGenerationOpen(lifecycleGeneration)) return;
    if (!acquired.ok && acquired.reason === "stale_epoch" && acquired.current) {
      if (!this.canStartLeaseMutation(lifecycleGeneration)) return;
      acquired = await this.options.leaseStore.acquireLease({
        ...baseInput,
        expectedEpoch: acquired.current.epoch,
      });
      if (!this.isLifecycleGenerationOpen(lifecycleGeneration)) return;
    }
    if (!acquired.ok) return;

    let activeLease = acquired.lease;
    let authoritativeRoom = room;
    const abortController = new AbortController();
    const handle: RoomWorkerHandle = {
      roomId: room.room.id,
      lifecycleGeneration,
      projectionVersion: room.room.aggregateVersion,
      source,
      abortController,
      lease: activeLease,
      runPromise: Promise.resolve(),
      completionPromise: Promise.resolve(),
      releasePromise: null,
      stopPromise: null,
      stopReason: null,
      stopSource: null,
      startAuditPromise: null,
      terminationAuditPromise: null,
      capacityAdmission: null,
      capacityReleasePromise: null,
      capacityReleased: false,
      workerLaunchCommitted: false,
      released: false,
    };
    try {
      if (this.options.checkpointStore) {
        authoritativeRoom = (await this.options.checkpointStore.replayProjection(room.room.id)).aggregate;
        if (!this.isLifecycleGenerationOpen(lifecycleGeneration)) return;
      }
      if (authoritativeRoom.room.state !== "running" || this.stopping || !this.started) {
        await this.releaseHandle(handle);
        return;
      }
      handle.projectionVersion = authoritativeRoom.room.aggregateVersion;

      if (this.options.roomStore.getRecoveryPosture) {
        const postLeasePosture = await this.options.roomStore.getRecoveryPosture(room.room.id);
        if (!this.isLifecycleGenerationOpen(lifecycleGeneration)) return;
        const withheldReason = this.recoveryWithheldReason(postLeasePosture);
        const postureChanged = postLeasePosture.aggregateVersion
          !== authoritativeRoom.room.aggregateVersion;
        if (withheldReason || postureChanged || this.stopping || !this.started) {
          await this.releaseHandle(handle);
          if (withheldReason || postureChanged) {
            await this.recordRecoveryWithheld(
              room.room.id,
              postLeasePosture,
              withheldReason ?? "posture_version_changed",
              source,
              lifecycleGeneration,
            );
          }
          return;
        }
      }
      await this.recordLifecycleAudit(
        acquired.action === "taken_over"
          ? "room:worker-lease-taken-over"
          : "room:worker-lease-acquired",
        authoritativeRoom.room.id,
        {
          leaseId: activeLease.id,
          leaseEpoch: activeLease.epoch,
          source,
        },
        lifecycleGeneration,
      );
      /*
      FNXC:RoomControllerCapacityBeforeDispatch 2026-07-19-23:32:
      Task dispatch creates durable runnable intent, so global capacity must be
      acquired and fence-checked before any dispatcher can claim a node. This
      makes capacity denial a no-dispatch outcome and binds later dispatch lease
      renewals to the same global reservation.
      */
      if (!this.canStartLeaseMutation(lifecycleGeneration)) {
        abortController.abort();
        await this.releaseHandle(handle).catch(() => undefined);
        return;
      }
      try {
        await this.assertCombinedAuthority(handle);
        const capacityAdmitted = await this.admitWorkerCapacity(handle);
        if (!capacityAdmitted) {
          abortController.abort();
          await this.releaseHandle(handle).catch(() => undefined);
          return;
        }
        await this.assertCombinedAuthority(handle);
      } catch (error) {
        abortController.abort();
        await this.releaseHandle(handle).catch(() => undefined);
        throw error;
      }
      if (!this.canStartLeaseMutation(lifecycleGeneration)) {
        abortController.abort();
        await this.releaseHandle(handle).catch(() => undefined);
        return;
      }
      const capabilityRefresh = await this.refreshCapabilityRegistryBeforeDispatch(
        handle,
        authoritativeRoom,
      );
      if (!capabilityRefresh || capabilityRefresh.scheduling !== "schedulable") {
        abortController.abort();
        await this.releaseHandle(handle).catch(() => undefined);
        return;
      }
      authoritativeRoom = capabilityRefresh.room;
      if (!this.canStartLeaseMutation(lifecycleGeneration)) {
        abortController.abort();
        await this.releaseHandle(handle).catch(() => undefined);
        return;
      }
      if (this.options.taskDispatcher) {
        const dispatched = await this.options.taskDispatcher.dispatchReadyTasks({
          room: authoritativeRoom,
          lease: activeLease,
          renewLease: async (lease) => {
            if (!this.canStartLeaseMutation(lifecycleGeneration)) {
              throw new Error(`Room ${room.room.id} stopped before task-dispatch lease renewal`);
            }
            if (
              lease.id !== activeLease.id
              || lease.epoch !== activeLease.epoch
              || lease.holderId !== activeLease.holderId
              || lease.hostId !== activeLease.hostId
            ) {
              throw new Error(`Room ${room.room.id} task dispatcher attempted to renew a stale worker lease`);
            }
            await this.assertCombinedAuthority(handle);
            const renewalTime = this.now();
            const renewed = await this.options.leaseStore.renewLease({
              ...leaseMutationInput(activeLease, renewalTime),
              expiresAt: this.expiresAt(renewalTime),
            });
            if (!renewed.ok) {
              throw new Error(`Room ${room.room.id} task-dispatch lease renewal failed: ${renewed.reason}`);
            }
            activeLease = renewed.lease;
            handle.lease = activeLease;
            if (!(await this.renewCapacityAdmission(handle, renewalTime))) {
              throw new Error(`Room ${room.room.id} task-dispatch capacity renewal failed`);
            }
            return activeLease;
          },
          canContinue: () => this.canStartLeaseMutation(lifecycleGeneration),
        });
        await persistTaskDispatchCapacityAdmissions(handle, dispatched.capacityAdmissions, this.recordLifecycleAudit.bind(this));
        authoritativeRoom = this.validateDispatchedRoom(
          room.room.id,
          authoritativeRoom,
          dispatched,
        );
        handle.projectionVersion = authoritativeRoom.room.aggregateVersion;
        if (
          !this.canStartLeaseMutation(lifecycleGeneration)
          || authoritativeRoom.room.state !== "running"
        ) {
          abortController.abort();
          await this.releaseHandle(handle).catch(() => undefined);
          return;
        }
        await this.assertCombinedAuthority(handle);
      }
      const semanticInbox = await this.processSemanticControllerInbox(
        room.room.id,
        activeLease,
        authoritativeRoom.room.aggregateVersion,
        lifecycleGeneration,
        handle,
      );
      activeLease = semanticInbox.lease;
      handle.lease = activeLease;
      if (semanticInbox.stopped || !this.canStartLeaseMutation(lifecycleGeneration)) {
        abortController.abort();
        await this.releaseHandle(handle).catch(() => undefined);
        return;
      }
    } catch (error) {
      abortController.abort();
      await this.releaseHandle(handle).catch(() => undefined);
      if (isRoomWorkerAuthorityError(error) && this.isLifecycleGenerationOpen(lifecycleGeneration)) {
        await this.recordRecoveryWithheld(
          handle.roomId,
          error.posture,
          error.reason,
          source,
          lifecycleGeneration,
        );
      }
      throw error;
    }

    if (!this.canStartLeaseMutation(lifecycleGeneration)) {
      abortController.abort();
      await this.releaseHandle(handle).catch(() => undefined);
      return;
    }

    const startAuditPromise = this.recordLifecycleAudit(
      "room:worker-started",
      handle.roomId,
      {
        leaseId: handle.lease.id,
        leaseEpoch: handle.lease.epoch,
        source,
      },
      handle.lifecycleGeneration,
    );
    handle.startAuditPromise = startAuditPromise;
    this.handles.set(handle.roomId, handle);
    try {
      await startAuditPromise;
    } catch (error) {
      if (this.handles.get(handle.roomId) === handle) this.handles.delete(handle.roomId);
      abortController.abort();
      await this.releaseHandle(handle).catch(() => undefined);
      throw error;
    }
    if (
      !this.started
      || this.stopping
      || !this.isLifecycleGenerationOpen(lifecycleGeneration)
      || this.handles.get(handle.roomId) !== handle
      || abortController.signal.aborted
    ) {
      if (this.handles.get(handle.roomId) === handle) this.handles.delete(handle.roomId);
      abortController.abort();
      await this.releaseHandle(handle).catch(() => undefined);
      return;
    }
    handle.workerLaunchCommitted = true;
    handle.runPromise = Promise.resolve().then(() => {
      if (
        !this.started
        || this.stopping
        || !this.isLifecycleGenerationOpen(lifecycleGeneration)
        || this.handles.get(handle.roomId) !== handle
        || abortController.signal.aborted
      ) return;
      return this.assertCombinedAuthority(handle).then((authority) => this.options.worker.runRoom({
        room: authoritativeRoom,
        lease: authority.lease,
        signal: abortController.signal,
        assertAuthority: () => this.assertCombinedAuthority(handle),
        assertLeaseAuthority: async () => (await this.assertCombinedAuthority(handle)).lease,
        terminalizeRoom: this.createTerminalizationCallback(handle),
        recordCapabilityRegistry: this.createCapabilityRegistryCallback(handle),
        arbitrateCandidates: this.createIndependentArbitrationCallback(handle),
        synthesizeCandidates: this.createCandidateSynthesisCallback(handle),
        prepareBlindReviewFanout: this.createBlindReviewFanoutCallback(handle),
        executeDeterministicEvidenceGates: this.createDeterministicEvidenceGateCallback(handle),
      })).catch(async (error) => {
        if (!isRoomWorkerAuthorityError(error)) throw error;
        if (error.reason === "controller_stopped") return;
        if (!this.isLifecycleGenerationOpen(handle.lifecycleGeneration)) return;
        handle.stopReason = "recovery_withheld";
        handle.stopSource = source;
        if (this.handles.get(handle.roomId) === handle) this.handles.delete(handle.roomId);
        abortController.abort();
        try {
          await this.recordRecoveryWithheld(
            handle.roomId,
            error.posture,
            error.reason,
            source,
            handle.lifecycleGeneration,
          );
        } finally {
          await this.releaseHandle(handle);
        }
      });
    });
    handle.completionPromise = handle.runPromise.then(
      () => this.finishHandle(handle, "worker_completed"),
      async (_error) => {
        try {
          if (!abortController.signal.aborted) {
            roomControllerLog.warn(
              `Room worker failed for ${handle.roomId}: code=room_worker_failed`,
            );
            await this.recordLifecycleAudit(
              "room:worker-recovery-failed",
              handle.roomId,
              {
                leaseId: handle.lease.id,
                leaseEpoch: handle.lease.epoch,
                errorCode: "room_worker_failed",
                recoverable: true,
                source: handle.source,
              },
              handle.lifecycleGeneration,
            );
          }
        } finally {
          await this.finishHandle(handle, "worker_failed");
        }
      },
    );
    void handle.completionPromise.catch(() => {
      roomControllerLog.warn(
        `Room worker completion failed for ${handle.roomId}: code=room_worker_completion_failed`,
      );
    });
  }

  /**
   * Runs only controller-addressed semantic work under the same lease epoch as
   * the pre-worker dispatch pass and an already-running worker's renewal pass.
   * The processor renews before each fenced mutation; a lost lease is a normal
   * stop condition, not a reason to keep a stale Room worker alive.
   */
  private async processSemanticControllerInbox(
    roomId: string,
    lease: StoredRoomLeaseV1,
    expectedAggregateVersion: number,
    lifecycleGeneration: number,
    handle?: RoomWorkerHandle,
  ): Promise<{ readonly lease: StoredRoomLeaseV1; readonly stopped: boolean }> {
    const processor = this.options.semanticControllerInboxProcessor;
    if (!processor) return { lease, stopped: false };

    let activeLease = lease;
    const summary = await processor.process({
      roomId,
      lease: activeLease,
      renewLease: async (candidate) => {
        if (!this.canStartLeaseMutation(lifecycleGeneration)) return null;
        if (!sameRoomWorkerLease(candidate, activeLease)) return null;
        if (
          this.options.hostCompositionAuthorityGuard !== undefined
          && await this.hostCompositionAuthorityWithheldReason()
        ) return null;
        const renewalTime = this.now();
        const renewed = await this.options.leaseStore.renewLease({
          ...leaseMutationInput(activeLease, renewalTime),
          expiresAt: this.expiresAt(renewalTime),
        });
        if (!renewed.ok || !this.canStartLeaseMutation(lifecycleGeneration)) return null;
        activeLease = renewed.lease;
        if (handle) {
          handle.lease = activeLease;
          if (!(await this.renewCapacityAdmission(handle, renewalTime))) {
            await this.stopHandle(handle, true, "capacity_renewal_failed", "semantic-inbox");
            return null;
          }
        }
        return activeLease;
      },
      observeLease: async (candidate) => this.observeSemanticControllerLease(
        roomId,
        candidate,
        expectedAggregateVersion,
        lifecycleGeneration,
      ),
      canContinue: () => this.canStartLeaseMutation(lifecycleGeneration),
    });
    if (!sameRoomWorkerLease(summary.lease, activeLease)) {
      throw new Error(`Room ${roomId} semantic inbox returned a lease outside the current worker fence`);
    }
    return { lease: activeLease, stopped: summary.stopped };
  }

  /**
   * The semantic inbox cannot treat a successful lease renewal as sufficient
   * authority. A pause, approval block, or Room aggregate change may commit in
   * the interval between renewal and the inbox's fenced claim/complete write.
   * Reuse the same combined guard as a Room worker so semantic control work
   * stops before it can acknowledge an action under an obsolete projection.
   */
  private async observeSemanticControllerLease(
    roomId: string,
    lease: StoredRoomLeaseV1,
    expectedAggregateVersion: number,
    lifecycleGeneration: number,
  ): Promise<StoredRoomLeaseV1 | null> {
    if (!this.canStartLeaseMutation(lifecycleGeneration)) return null;
    if (
      this.options.hostCompositionAuthorityGuard !== undefined
      && await this.hostCompositionAuthorityWithheldReason()
    ) return null;

    if (this.options.roomStore.assertWorkerAuthority) {
      const authority = await this.options.roomStore.assertWorkerAuthority({
        roomId,
        lease,
        expectedAggregateVersion,
        now: this.now(),
      });
      if (
        !this.canStartLeaseMutation(lifecycleGeneration)
        || !sameRoomWorkerLease(authority.lease, lease)
      ) return null;
      return authority.lease;
    }

    const observedLease = await this.options.leaseStore.assertFence(
      leaseMutationInput(lease, this.now()),
    );
    if (
      !this.canStartLeaseMutation(lifecycleGeneration)
      || !sameRoomWorkerLease(observedLease, lease)
    ) return null;
    if (!this.options.roomStore.getRecoveryPosture) return observedLease;

    const guard = await this.readRunGuard(roomId);
    if (
      !this.canStartLeaseMutation(lifecycleGeneration)
      || guard.reason
      || guard.posture.aggregateVersion !== expectedAggregateVersion
    ) return null;
    return observedLease;
  }

  private async renewHandle(
    handle: RoomWorkerHandle,
    source: string,
    room: RoomAggregateV1 | undefined,
  ): Promise<void> {
    const lifecycleGeneration = handle.lifecycleGeneration;
    if (!this.canStartLeaseMutation(lifecycleGeneration)) return;
    const hostCompositionReason = this.options.hostCompositionAuthorityGuard === undefined
      ? null
      : await this.hostCompositionAuthorityWithheldReason();
    if (!this.canStartLeaseMutation(lifecycleGeneration)) return;
    if (hostCompositionReason !== null) {
      const posture = this.hostCompositionAuthorityBlockedPosture(handle);
      const stopPromise = this.stopHandle(
        handle,
        true,
        "host_composition_authority_withheld",
        source,
      );
      await this.recordRecoveryWithheld(
        handle.roomId,
        posture,
        hostCompositionReason,
        source,
        lifecycleGeneration,
      );
      await stopPromise;
      return;
    }
    let preRenewPosture: RoomControllerRecoveryPosture | null = null;
    if (this.options.roomStore.getRecoveryPosture) {
      const guard = await this.readRunGuard(handle.roomId);
      if (!this.canStartLeaseMutation(lifecycleGeneration)) return;
      preRenewPosture = guard.posture;
      const reason = guard.reason
        ?? (room && guard.posture.aggregateVersion !== room.room.aggregateVersion
          ? "posture_version_changed"
          : null);
      if (reason) {
        const stopPromise = this.stopHandle(handle, true, "recovery_withheld", source);
        await this.recordRecoveryWithheld(
          handle.roomId,
          guard.posture,
          reason,
          source,
          lifecycleGeneration,
        );
        await stopPromise;
        return;
      }
    }
    if (!this.canStartLeaseMutation(lifecycleGeneration)) return;
    const now = this.now();
    const renewed = await this.options.leaseStore.renewLease({
      ...leaseMutationInput(handle.lease, now),
      expiresAt: this.expiresAt(now),
    });
    if (!this.isLifecycleGenerationOpen(lifecycleGeneration)) return;
    if (renewed.ok) {
      handle.lease = renewed.lease;
      if (!(await this.renewCapacityAdmission(handle, now))) {
        await this.stopHandle(handle, true, "capacity_renewal_failed", source);
        return;
      }
      if (this.options.roomStore.getRecoveryPosture && preRenewPosture) {
        const postRenewGuard = await this.readRunGuard(handle.roomId);
        if (!this.isLifecycleGenerationOpen(lifecycleGeneration)) return;
        const reason = postRenewGuard.reason
          ?? (postRenewGuard.posture.aggregateVersion === preRenewPosture.aggregateVersion
            ? null
            : "posture_version_changed");
        if (reason) {
          const stopPromise = this.stopHandle(handle, true, "recovery_withheld", source);
          await this.recordRecoveryWithheld(
            handle.roomId,
            postRenewGuard.posture,
            reason,
            source,
            lifecycleGeneration,
          );
          await stopPromise;
          return;
        }
      }
      const semanticInbox = await this.processSemanticControllerInbox(
        handle.roomId,
        handle.lease,
        handle.projectionVersion,
        lifecycleGeneration,
        handle,
      );
      handle.lease = semanticInbox.lease;
      if (semanticInbox.stopped) {
        await this.stopHandle(handle, true, "semantic_inbox_stopped", source);
        return;
      }
      if (!this.started || this.stopping || this.handles.get(handle.roomId) !== handle) {
        await this.stopHandle(handle, true, "renew_guard_lost", source);
      }
      return;
    }
    if (!this.isLifecycleGenerationOpen(lifecycleGeneration)) return;
    handle.released = true;
    const stopPromise = this.stopHandle(handle, true, "lease_lost", source);
    await this.recordLifecycleAudit(
      "room:worker-lease-lost",
      handle.roomId,
      {
        leaseId: handle.lease.id,
        leaseEpoch: handle.lease.epoch,
        reason: renewed.reason,
        source,
      },
      handle.lifecycleGeneration,
    );
    await stopPromise;
  }

  private async finishHandle(handle: RoomWorkerHandle, outcome: string): Promise<void> {
    const wasCurrent = this.handles.get(handle.roomId) === handle;
    if (wasCurrent) this.handles.delete(handle.roomId);
    if (handle.stopReason === null) handle.stopReason = outcome;
    if (handle.stopSource === null) handle.stopSource = handle.source;
    if (wasCurrent && !handle.abortController.signal.aborted && this.started && !this.stopping) {
      this.recordAbnormalWorkerExit(handle);
    }
    if (!this.isLifecycleGenerationOpen(handle.lifecycleGeneration)) return;
    const releasePromise = this.releaseHandle(handle);
    void releasePromise.catch(() => undefined);
    try {
      await this.recordWorkerStoppedOnce(
        handle,
        handle.stopReason ?? outcome,
        handle.stopSource ?? handle.source,
        "settled",
      );
    } finally {
      await releasePromise;
    }
  }

  private async stopHandle(
    handle: RoomWorkerHandle,
    release: boolean,
    reason = "controller_stop",
    source = "shutdown",
    budgetMs = this.roomOperationBudgetMs,
  ): Promise<void> {
    if (handle.stopPromise) return handle.stopPromise;
    handle.stopReason = reason;
    handle.stopSource = source;
    if (this.handles.get(handle.roomId) === handle) this.handles.delete(handle.roomId);
    handle.abortController.abort();
    const releasePromise = release ? this.releaseHandle(handle) : Promise.resolve();
    void releasePromise.catch(() => undefined);
    const operation = (async () => {
      if (!handle.workerLaunchCommitted) {
        let startWasPersisted = false;
        if (handle.startAuditPromise) {
          try {
            await handle.startAuditPromise;
            startWasPersisted = true;
          } catch {
            // A failed start persistence creates no durable lifecycle fact, so
            // there is no started worker for a terminal event to close.
          }
        }
        if (startWasPersisted) {
          await this.recordWorkerStoppedOnce(handle, reason, source, "settled");
        }
        await this.waitWithinBudget(releasePromise, budgetMs);
        return;
      }
      const settled = await this.settlesWithinBudget(handle.runPromise, budgetMs);
      if (!settled) {
        await this.recordWorkerStopTimeoutOnce(handle, reason, source);
      } else {
        await handle.completionPromise;
      }
      await this.waitWithinBudget(releasePromise, budgetMs);
    })();
    handle.stopPromise = operation;
    return operation;
  }

  private async readRunGuard(roomId: string): Promise<{
    readonly posture: RoomControllerRecoveryPosture;
    readonly reason: string | null;
  }> {
    const posture = await this.options.roomStore.getRecoveryPosture!(roomId);
    return { posture, reason: this.recoveryWithheldReason(posture) };
  }

  private validateDispatchedRoom(
    roomId: string,
    beforeDispatch: RoomAggregateV1,
    result: DispatchReadyRoomTasksResult,
  ): RoomAggregateV1 {
    const room = result.room;
    if (
      room.room.id !== roomId
      || room.room.projectId !== this.options.projectId
      || room.room.aggregateVersion < beforeDispatch.room.aggregateVersion
    ) {
      throw new Error(`Room task dispatcher returned an invalid projection for ${roomId}`);
    }
    return room;
  }

  /**
   * FNXC:RoomControllerCapabilityRefresh 2026-07-20-00:24:
   * A controller-configured runtime refresh must collect only concrete bound
   * Sessions, then give the aggregator the complete authoritative binding
   * projection. Pending or unobservable bindings therefore withhold the whole
   * write and no task dispatcher can claim partial capability evidence.
   *
   * The controller owns one decision time and a live worker fence. It does not
   * synthesize connector, account, model, tool, health, latency, or quality
   * facts; those can enter only through the controlled observation port.
   * Complete trusted evidence that is unhealthy, rate-limited, tool-less, or
   * bound to a paused/degraded Session must still be durably recorded under
   * that fence/CAS so operators can see why dispatch is withheld.
   */
  private async refreshCapabilityRegistryBeforeDispatch(
    handle: RoomWorkerHandle,
    room: RoomAggregateV1,
  ): Promise<RoomCapabilityRegistryRefreshResult | null> {
    const refresh = this.options.capabilityRegistryRefresh;
    if (!refresh) return { room, scheduling: "schedulable" };
    const roomStore = this.options.roomStore;
    if (
      !isRoomCapabilityRegistryWriter(roomStore)
      || typeof roomStore.getRoomCapabilityRegistry !== "function"
      || typeof roomStore.getRoom !== "function"
    ) return null;

    const firstAuthority = await this.assertCombinedAuthority(handle);
    if (firstAuthority.posture.aggregateVersion !== handle.projectionVersion) return null;
    const registry = await roomStore.getRoomCapabilityRegistry(handle.roomId);
    const registryRevision = registry?.registry.revision ?? 0;
    const asOf = this.now();
    /*
     * FNXC:RoomControllerCapabilityRefreshReplay 2026-07-20-00:24:
     * A single refresh operation may see a lost response after Core commits.
     * Keep one operation identity, decision time, and immutable update payload
     * for the bounded retry so Core can replay its existing idempotency record
     * instead of treating the retry as a second registry mutation.
     */
    const operationId = `room-capability-refresh:${randomUUID()}`;
    const idempotencyKey = refresh.createIdempotencyKey?.({
      roomId: handle.roomId,
      lease: firstAuthority.lease,
      aggregateVersion: handle.projectionVersion,
      registryRevision,
      asOf,
    }) ?? operationId;
    const activeBindingCount = room.bindings.filter((binding) => (
      binding.state === "pending"
      || binding.state === "attached"
      || binding.state === "paused"
      || binding.state === "authentication_blocked"
      || binding.state === "host_unavailable"
      || binding.state === "delivery_uncertain"
    )).length;
    if (activeBindingCount > MAX_ROOM_CAPABILITY_REGISTRY_UPDATE_SAMPLES) {
      await this.recordCapabilityRegistryWithheld(handle, "sample_limit_exceeded", {
        activeBindingCount,
        maximumSamples: MAX_ROOM_CAPABILITY_REGISTRY_UPDATE_SAMPLES,
      });
      return null;
    }
    const concreteBindings = room.bindings.filter((binding) => (
      binding.state === "attached"
      || binding.state === "paused"
      || binding.state === "authentication_blocked"
      || binding.state === "host_unavailable"
      || binding.state === "delivery_uncertain"
    ));
    const collection = await Promise.all(concreteBindings.map((binding) => (
      collectRoomConnectorRuntimeObservation({
        contractVersion: ROOM_CONNECTOR_RUNTIME_OBSERVATION_REPORTER_CONTRACT_VERSION,
        asOf,
        reportFreshness: refresh.reportFreshness,
        target: {
          projectId: this.options.projectId,
          roomId: handle.roomId,
          binding,
        },
        registryUpdate: {
          expectedAggregateVersion: handle.projectionVersion,
          expectedRegistryRevision: registryRevision,
          roomWorkerFence: {
            leaseId: firstAuthority.lease.id,
            holderId: firstAuthority.lease.holderId,
            hostId: firstAuthority.lease.hostId,
            expectedEpoch: firstAuthority.lease.epoch,
          },
          idempotencyKey,
          freshness: refresh.registryFreshness,
        },
      }, refresh.observationPort)
    )));
    const authority = await this.assertCombinedAuthority(handle);
    if (authority.posture.aggregateVersion !== handle.projectionVersion) return null;
    const collected = collection.filter((result) => result.ok);
    const aggregated = aggregateRoomConnectorCapabilityObservations({
      contractVersion: ROOM_CONNECTOR_CAPABILITY_OBSERVATION_AGGREGATOR_CONTRACT_VERSION,
      projectId: this.options.projectId,
      roomId: handle.roomId,
      asOf,
      reportFreshness: refresh.reportFreshness,
      registryUpdate: {
        expectedAggregateVersion: handle.projectionVersion,
        expectedRegistryRevision: registryRevision,
        roomWorkerFence: {
          leaseId: authority.lease.id,
          holderId: authority.lease.holderId,
          hostId: authority.lease.hostId,
          expectedEpoch: authority.lease.epoch,
        },
        idempotencyKey,
        freshness: refresh.registryFreshness,
      },
      roomBindings: room.bindings,
      activeBindings: collected.map((result) => result.sample.report.target),
      observations: collected.map((result) => result.sample),
    });
    if (!aggregated.ok) {
      const collectionFailures = collection
        .filter((result) => !result.ok)
        .map((result) => ({
          bindingId: result.bindingId,
          reasonCode: result.reason.code,
          unknownFields: result.unknown.map((entry) => entry.field).sort(),
        }));
      await this.recordCapabilityRegistryWithheld(handle, "aggregation_withheld", {
        aggregateReasonCode: aggregated.reason.code,
        aggregateIssueCodes: [...new Set(aggregated.issues.map((issue) => `${issue.source}:${issue.code}`))].sort(),
        collectionFailures,
      });
      return null;
    }

    let written: RoomCapabilityRegistryUpdateResultV1 | null = null;
    try {
      written = await updateRoomCapabilityRegistry(aggregated.update, roomStore);
    } catch {
      written = null;
    }
    if (!written || (!written.ok && written.outcome === "writer_rejected")) {
      try {
        written = await updateRoomCapabilityRegistry(aggregated.update, roomStore);
      } catch {
        written = null;
      }
    }
    if (!written || !written.ok || written.outcome !== "written") {
      await this.recordCapabilityRegistryWithheld(handle, "registry_write_withheld", {
        writeOutcome: written?.outcome ?? "writer_unavailable",
        writeReasonCode: written && !written.ok ? written.reason.code : null,
      });
      return null;
    }
    handle.projectionVersion = written.write.projection.aggregateVersion;
    const refreshedRoom = await roomStore.getRoom(handle.roomId);
    if (
      !refreshedRoom
      || refreshedRoom.room.aggregateVersion !== handle.projectionVersion
      || refreshedRoom.room.state !== "running"
    ) return null;
    return {
      room: refreshedRoom,
      scheduling: aggregated.scheduling === "schedulable" && written.scheduling === "schedulable"
        ? "schedulable"
        : "not_schedulable",
    };
  }

  /**
   * FNXC:RoomControllerCapabilityRegistry 2026-07-18-12:52:
   * Dynamic Session capability data becomes scheduler input only after a live
   * controller fence writes Core's event-backed registry. The callback hides
   * controller identity and clock fields from workers, preserves their CAS
   * intent, and advances this handle's projection version after a committed
   * registry event so later controller writes cannot use stale authority.
   */
  private createCapabilityRegistryCallback(
    handle: RoomWorkerHandle,
  ): ((
    input: RoomWorkerCapabilityRegistryUpdateInputV1,
  ) => Promise<RoomCapabilityRegistryUpdateResultV1>) | undefined {
    const roomStore = this.options.roomStore;
    if (!isRoomCapabilityRegistryWriter(roomStore)) return undefined;
    return async (input) => {
      if (!this.isLifecycleGenerationOpen(handle.lifecycleGeneration)) {
        throw new RoomWorkerAuthorityError({
          lifecycleState: "blocked",
          aggregateVersion: handle.projectionVersion,
          humanPaused: false,
          approvalState: "blocked",
        }, "controller_stopped");
      }
      const authority = await this.assertCombinedAuthority(handle);
      if (authority.posture.aggregateVersion !== input.expectedAggregateVersion) {
        throw new RoomWorkerAuthorityError(
          authority.posture,
          "capability_registry_aggregate_version_changed",
        );
      }
      const result = await updateRoomCapabilityRegistry({
        ...input,
        contractVersion: ROOM_CAPABILITY_REGISTRY_UPDATER_CONTRACT_VERSION,
        projectId: this.options.projectId,
        roomId: handle.roomId,
        roomWorkerFence: {
          leaseId: authority.lease.id,
          holderId: authority.lease.holderId,
          hostId: authority.lease.hostId,
          expectedEpoch: authority.lease.epoch,
        },
        sampledAt: this.now(),
      }, roomStore);
      if (result.ok && result.outcome === "written") {
        const projection = result.write.projection;
        if (
          projection.projectId !== this.options.projectId
          || projection.roomId !== handle.roomId
          || projection.aggregateVersion <= handle.projectionVersion
        ) {
          throw new Error(`Room ${handle.roomId} capability registry writer returned an invalid projection`);
        }
        handle.lease = authority.lease;
        handle.projectionVersion = projection.aggregateVersion;
      }
      return result;
    };
  }

  private createIndependentArbitrationCallback(
    handle: RoomWorkerHandle,
  ): ((input: RoomWorkerIndependentArbitrationInputV1) => Promise<RoomIndependentArbitrationResultV1>) | undefined {
    const workflow = this.options.evidenceWorkflows?.arbitration;
    if (!workflow) return undefined;
    return async (input) => {
      if (!this.isLifecycleGenerationOpen(handle.lifecycleGeneration)) {
        throw new RoomWorkerAuthorityError({
          lifecycleState: "blocked",
          aggregateVersion: handle.projectionVersion,
          humanPaused: false,
          approvalState: "blocked",
        }, "controller_stopped");
      }
      const authority = await this.assertCombinedAuthority(handle);
      if (authority.posture.aggregateVersion !== input.expectedAggregateVersion) {
        throw new RoomWorkerAuthorityError(
          authority.posture,
          "arbitration_aggregate_version_changed",
        );
      }
      const { expectedAggregateVersion: _expectedAggregateVersion, ...request } = input;
      const result = await workflow.arbitrate({
        ...request,
        scope: {
          projectId: this.options.projectId,
          roomId: handle.roomId,
        },
      });
      handle.lease = authority.lease;
      return result;
    };
  }

  private createCandidateSynthesisCallback(
    handle: RoomWorkerHandle,
  ): ((input: RoomWorkerCandidateSynthesisInputV1) => Promise<RoomCandidateSynthesisResultV1>) | undefined {
    const workflow = this.options.evidenceWorkflows?.synthesis;
    if (!workflow) return undefined;
    return async (input) => {
      if (!this.isLifecycleGenerationOpen(handle.lifecycleGeneration)) {
        throw new RoomWorkerAuthorityError({
          lifecycleState: "blocked",
          aggregateVersion: handle.projectionVersion,
          humanPaused: false,
          approvalState: "blocked",
        }, "controller_stopped");
      }
      const authority = await this.assertCombinedAuthority(handle);
      if (authority.posture.aggregateVersion !== input.expectedAggregateVersion) {
        throw new RoomWorkerAuthorityError(
          authority.posture,
          "candidate_synthesis_aggregate_version_changed",
        );
      }
      const { expectedAggregateVersion: _expectedAggregateVersion, ...request } = input;
      const result = await workflow.synthesize({
        ...request,
        scope: {
          projectId: this.options.projectId,
          roomId: handle.roomId,
        },
      });
      handle.lease = authority.lease;
      return result;
    };
  }

  private createBlindReviewFanoutCallback(
    handle: RoomWorkerHandle,
  ): ((input: RoomWorkerBlindReviewFanoutInputV1) => Promise<RoomCandidateFanoutBlindReviewResultV1>) | undefined {
    const workflow = this.options.evidenceWorkflows?.blindReviewFanout;
    if (!workflow) return undefined;
    return async (input) => {
      if (!this.isLifecycleGenerationOpen(handle.lifecycleGeneration)) {
        throw new RoomWorkerAuthorityError({
          lifecycleState: "blocked",
          aggregateVersion: handle.projectionVersion,
          humanPaused: false,
          approvalState: "blocked",
        }, "controller_stopped");
      }
      const authority = await this.assertCombinedAuthority(handle);
      if (authority.posture.aggregateVersion !== input.expectedAggregateVersion) {
        throw new RoomWorkerAuthorityError(
          authority.posture,
          "blind_review_fanout_aggregate_version_changed",
        );
      }
      const { expectedAggregateVersion: _expectedAggregateVersion, ...request } = input;
      const result = await workflow.prepare({
        ...request,
        scope: {
          projectId: this.options.projectId,
          roomId: handle.roomId,
        },
      });
      handle.lease = authority.lease;
      return result;
    };
  }

  private createDeterministicEvidenceGateCallback(
    handle: RoomWorkerHandle,
  ): ((input: RoomWorkerDeterministicEvidenceGateInputV1) => Promise<RoomDeterministicEvidenceGateCoordinatorResultV1>) | undefined {
    const workflow = this.options.evidenceWorkflows?.deterministicEvidenceGates;
    if (!workflow) return undefined;
    return async (input) => {
      if (!this.isLifecycleGenerationOpen(handle.lifecycleGeneration)) {
        throw new RoomWorkerAuthorityError({
          lifecycleState: "blocked",
          aggregateVersion: handle.projectionVersion,
          humanPaused: false,
          approvalState: "blocked",
        }, "controller_stopped");
      }
      const authority = await this.assertCombinedAuthority(handle);
      if (authority.posture.aggregateVersion !== input.expectedAggregateVersion) {
        throw new RoomWorkerAuthorityError(
          authority.posture,
          "deterministic_evidence_gate_aggregate_version_changed",
        );
      }
      const { expectedAggregateVersion: _expectedAggregateVersion, ...request } = input;
      const result = await workflow.execute({
        ...request,
        scope: {
          projectId: this.options.projectId,
          roomId: handle.roomId,
        },
      });
      handle.lease = authority.lease;
      return result;
    };
  }

  /**
   * FNXC:RoomControllerTerminalization 2026-07-18-12:22:
   * A Room worker may supply evidence, but it never supplies its own authority.
   * This callback captures the live controller lease and aggregate version,
   * records the immutable contract, and only then allows Core to revoke the
   * same worker fence as part of the terminal mutation.
   */
  private createTerminalizationCallback(
    handle: RoomWorkerHandle,
  ): ((input: RoomWorkerTerminalizationInputV1) => Promise<CommitRoomTerminalizationResultV1>) | undefined {
    const coordinator = this.terminalizationCoordinator;
    if (!coordinator) return undefined;
    return async (input) => {
      if (!this.isLifecycleGenerationOpen(handle.lifecycleGeneration)) {
        throw new RoomWorkerAuthorityError({
          lifecycleState: "blocked",
          aggregateVersion: handle.projectionVersion,
          humanPaused: false,
          approvalState: "blocked",
        }, "controller_stopped");
      }
      let workerLease = handle.lease;
      try {
        const authority = await this.assertCombinedAuthority(handle);
        if (authority.posture.aggregateVersion !== input.expectedAggregateVersion) {
          throw new RoomWorkerAuthorityError(
            authority.posture,
            "terminalization_aggregate_version_changed",
          );
        }
        workerLease = authority.lease;
      } catch (error) {
        if (!isRoomWorkerAuthorityError(error)) throw error;
        if (
          handle.stopReason !== "room_terminalized"
          || handle.stopSource !== "terminalization"
          || !handle.released
          || !handle.abortController.signal.aborted
        ) {
          throw error;
        }
        /*
        FNXC:RoomControllerTerminalization 2026-07-18-12:38:
        A terminal write revokes its own worker lease. An acknowledgement-loss
        retry therefore cannot pass a fresh preflight, but Core reserves the
        same derived idempotency keys before it checks that stale fence. Permit
        only this replay-shaped call to reach Core; a new mutation still fails
        its transaction-local fence assertion and never regains authority.
        */
      }
      const result = await coordinator.commit({
        ...input,
        roomId: handle.roomId,
        roomWorkerFence: {
          leaseId: workerLease.id,
          holderId: workerLease.holderId,
          hostId: workerLease.hostId,
          expectedEpoch: workerLease.epoch,
        },
        occurredAt: this.now(),
      });
      if (result.status === "terminalized") {
        // Core revoked the durable lease in the same transaction, so this handle
        // must not emit a duplicate release after its worker returns.
        handle.released = true;
        handle.releasePromise = Promise.resolve();
        handle.stopReason = "room_terminalized";
        handle.stopSource = "terminalization";
        handle.abortController.abort();
      }
      return result;
    };
  }

  private async assertCombinedAuthority(handle: RoomWorkerHandle): Promise<RoomWorkerAuthorityV1> {
    this.assertAuthorityRequestAllowed(handle);
    if (this.options.hostCompositionAuthorityGuard !== undefined) {
      const hostCompositionReason = await this.hostCompositionAuthorityWithheldReason();
      if (hostCompositionReason !== null) {
        throw new RoomWorkerAuthorityError(
          this.hostCompositionAuthorityBlockedPosture(handle),
          hostCompositionReason,
        );
      }
    }
    if (this.options.roomStore.assertWorkerAuthority) {
      const authority = await this.options.roomStore.assertWorkerAuthority({
        roomId: handle.roomId,
        lease: handle.lease,
        expectedAggregateVersion: handle.projectionVersion,
        now: this.now(),
      });
      this.assertAuthorityResultCurrent(handle);
      return authority;
    }
    const lease = await this.options.leaseStore.assertFence(
      leaseMutationInput(handle.lease, this.now()),
    );
    this.assertAuthorityResultCurrent(handle);
    if (!this.options.roomStore.getRecoveryPosture) {
      return {
        lease,
        posture: {
          lifecycleState: "running",
          aggregateVersion: handle.projectionVersion,
          humanPaused: false,
          approvalState: "none",
        },
      };
    }
    const guard = await this.readRunGuard(handle.roomId);
    this.assertAuthorityResultCurrent(handle);
    const reason = guard.reason
      ?? (guard.posture.aggregateVersion === handle.projectionVersion
        ? null
        : "posture_version_changed");
    if (reason) throw new RoomWorkerAuthorityError(guard.posture, reason);
    return { lease, posture: guard.posture };
  }

  /*
  FNXC:RoomHostCompositionRevalidation 2026-07-20-09:42:
  A startup-approved host bundle can expire, be revoked, be replaced, or lose a
  connector after the worker begins. Every guarded controller authority check
  converts that live result into a fenced Room-worker stop; it never treats the
  original startup decision as an indefinite permit to renew or deliver.
  */
  private async hostCompositionAuthorityWithheldReason(): Promise<string | null> {
    const guard = this.options.hostCompositionAuthorityGuard;
    if (!guard) return null;
    try {
      const result = await guard.assertCurrent();
      if (result && result.state === "current") return null;
      if (
        result
        && result.state === "withheld"
        && isSafeHostCompositionWithheldReason(result.reason)
      ) {
        return result.reason;
      }
      return "host_composition_authority_invalid";
    } catch {
      return "host_composition_authority_guard_failed";
    }
  }

  private hostCompositionAuthorityBlockedPosture(
    handle: RoomWorkerHandle,
  ): RoomControllerRecoveryPosture {
    return {
      lifecycleState: "blocked",
      aggregateVersion: handle.projectionVersion,
      humanPaused: false,
      approvalState: "blocked",
    };
  }

  private recordRecoveryWithheld(
    roomId: string,
    posture: RoomControllerRecoveryPosture,
    reason: string,
    source: string,
    lifecycleGeneration: number,
  ): Promise<void> {
    return this.recordLifecycleAudit("room:worker-recovery-withheld", roomId, {
      lifecycleState: posture.lifecycleState,
      aggregateVersion: posture.aggregateVersion,
      reason,
      source,
    }, lifecycleGeneration);
  }

  private recoveryWithheldReason(posture: RoomControllerRecoveryPosture): string | null {
    if (posture.humanPaused) return "human_paused";
    if (posture.approvalState === "waiting") return "approval_waiting";
    if (posture.approvalState === "blocked") return "approval_blocked";
    if ([
      "completed",
      "completed_with_risks",
      "partial",
      "cancelled",
      "failed",
      "archived",
    ].includes(posture.lifecycleState)) {
      return "terminal_state";
    }
    return posture.lifecycleState === "running" ? null : "lifecycle_not_running";
  }

  private recordWorkerStoppedOnce(
    handle: RoomWorkerHandle,
    reason: string,
    source: string,
    terminationOutcome: "settled",
  ): Promise<void> {
    if (handle.terminationAuditPromise) return handle.terminationAuditPromise;
    const persistence = this.recordLifecycleAudit("room:worker-stopped", handle.roomId, {
      leaseId: handle.lease.id,
      leaseEpoch: handle.lease.epoch,
      reason,
      source,
      terminationOutcome,
    }, handle.lifecycleGeneration);
    const tracked = persistence.catch((error) => {
      handle.terminationAuditPromise = null;
      throw error;
    });
    handle.terminationAuditPromise = tracked;
    return tracked;
  }

  private recordWorkerStopTimeoutOnce(
    handle: RoomWorkerHandle,
    reason: string,
    source: string,
  ): Promise<void> {
    if (handle.terminationAuditPromise) return handle.terminationAuditPromise;
    /*
    FNXC:SessionRoomWorkerTermination 2026-07-18-02:09:
    Abort timeout proves only that termination is unknown. Once this audit is
    durably persisted it is the final termination fact for this controller
    lifetime; a later in-memory settlement cannot write through a closed store.
    Outside controller shutdown, a rejected persistence attempt clears the slot
    so a late observed settlement may persist the truthful worker-stopped fact.
    During shutdown the failed slot remains final: stop closes lifecycle writes
    before ProjectEngine tears down the dispatcher and runtime data layer.
    */
    const persistence = this.recordLifecycleAudit("room:worker-stop-timeout", handle.roomId, {
      leaseId: handle.lease.id,
      leaseEpoch: handle.lease.epoch,
      reason,
      source,
      terminationOutcome: "termination_unknown",
    }, handle.lifecycleGeneration);
    const tracked = persistence.catch((error) => {
      if (!this.stopping) handle.terminationAuditPromise = null;
      throw error;
    });
    handle.terminationAuditPromise = tracked;
    return tracked;
  }

  private recordLifecycleAudit(
    mutationType: RoomControllerAuditMutationType,
    roomId: string,
    metadata: Record<string, unknown>,
    lifecycleGeneration: number,
  ): Promise<void> {
    if (!this.isLifecycleGenerationOpen(lifecycleGeneration)) {
      return Promise.reject(new Error("room_controller_lifecycle_writes_closed"));
    }
    const event: RoomControllerAuditEvent = {
      id: randomUUID(),
      projectId: this.options.projectId,
      timestamp: this.now(),
      agentId: this.options.workerId,
      runId: this.auditRunId,
      domain: "database",
      mutationType,
      target: roomId,
      metadata: {
        projectId: this.options.projectId,
        roomId,
        workerId: this.options.workerId,
        hostId: this.options.hostId,
        ...metadata,
      },
    };
    const delivery = this.deliverAudit(event).finally(() => {
      this.auditDeliveries.delete(delivery);
    });
    this.auditDeliveries.add(delivery);
    return delivery;
  }

  /*
  FNXC:RoomCapabilityRegistryWithheldAudit 2026-07-20-08:24:
  An incomplete or rejected capability refresh is an operational decision, not
  a quiet no-op. Persist only controlled reason codes and field names—never a
  connector exception message or session content—before the controller releases
  the worker. This gives the cockpit a durable explanation for an idle Room
  while retaining the fail-closed dispatch boundary.
  */
  private recordCapabilityRegistryWithheld(
    handle: RoomWorkerHandle,
    reason: "sample_limit_exceeded" | "aggregation_withheld" | "registry_write_withheld",
    metadata: Record<string, unknown>,
  ): Promise<void> {
    return this.recordLifecycleAudit("room:capability-registry-withheld", handle.roomId, {
      leaseId: handle.lease.id,
      leaseEpoch: handle.lease.epoch,
      expectedAggregateVersion: handle.projectionVersion,
      source: handle.source,
      reason,
      ...metadata,
    }, handle.lifecycleGeneration);
  }

  private async deliverAudit(event: RoomControllerAuditEvent): Promise<void> {
    for (let attempt = 1; attempt <= this.auditMaxAttempts; attempt += 1) {
      try {
        await this.options.recordRunAuditEvent(event);
        return;
      } catch {
        // Retry the exact same stable event id. The durable outbox makes this
        // idempotent; unlike an outer timeout, rejection proves the attempt has
        // actually settled and cannot commit after controller teardown.
      }
    }
    roomControllerLog.warn(
      `Room lifecycle audit failed for ${event.target} (${event.mutationType}): code=audit_delivery_exhausted`,
    );
    throw new Error("room_lifecycle_audit_persistence_failed");
  }

  private async drainAuditDeliveries(): Promise<void> {
    while (this.auditDeliveries.size > 0) {
      await Promise.allSettled([...this.auditDeliveries]);
    }
  }

  private async admitWorkerCapacity(handle: RoomWorkerHandle): Promise<boolean> {
    const configured = this.options.capacityAdmission;
    if (!configured) return true;

    const claimId = this.createCapacityClaimId(configured, handle);
    const admission: RoomWorkerCapacityAdmission = {
      claimId,
      acquireOperationId: `room-capacity-acquire:${claimId}`,
      releaseOperationId: `room-capacity-release:${claimId}`,
      workClass: configured.workClass,
      slots: configured.slots,
      globalReleased: false,
      releaseAsOf: null,
    };
    const acquiredAt = this.now();
    let global: RoomGlobalConcurrencyMutationResultV1;
    try {
      global = await configured.globalAccounting.acquire({
        contractVersion: ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
        projectId: this.options.projectId,
        roomId: handle.roomId,
        claimId: admission.claimId,
        operationId: admission.acquireOperationId,
        workClass: admission.workClass,
        slots: admission.slots,
        holderId: this.options.workerId,
        leaseId: handle.lease.id,
        fence: handle.lease.epoch,
        asOf: acquiredAt,
        expiresAt: handle.lease.expiresAt,
      });
    } catch (error) {
      await this.recordCapacityWithheld(handle, "global", "admission_error", {
        errorCode: error instanceof Error ? error.name : "unknown_error",
      }).catch(() => undefined);
      throw error;
    }

    if (global.action !== "acquired") {
      await this.recordCapacityWithheld(handle, "global", global.reason, {
        globalAction: global.action,
        globalReason: global.reason,
      });
      return false;
    }
    handle.capacityAdmission = admission;
    if (global.claimId !== admission.claimId || global.fence !== handle.lease.epoch) {
      await this.releaseCapacityAndRecordWithheld(handle, "global", "acquire_identity_mismatch", {
        globalAction: global.action,
        globalClaimId: global.claimId,
        globalFence: global.fence,
      }).catch(() => undefined);
      throw new Error(`Room ${handle.roomId} capacity acquire returned an unexpected claim fence`);
    }
    try {
      await this.recordCapacityAdmitted(handle);
      return true;
    } catch (error) {
      await this.releaseCapacityAndRecordWithheld(handle, "global", "admission_error", {
        errorCode: error instanceof Error ? error.name : "unknown_error",
      }).catch(() => undefined);
      throw error;
    }
  }

  /*
  FNXC:RoomControllerCapacityRenewal 2026-07-19-18:44:
  RoomController owns only the active global-capacity claim. After Core has
  renewed a worker lease, the controller must fence-renew that claim to the
  exact new lease expiry before semantic or worker work continues. A held,
  rejected, malformed, or exceptional renewal aborts the worker and reuses the
  normal capacity-withheld audit plus compensating release path; provider
  backpressure is deliberately outside this controller boundary.
  */
  private async renewCapacityAdmission(handle: RoomWorkerHandle, asOf: string): Promise<boolean> {
    const admission = handle.capacityAdmission;
    const configured = this.options.capacityAdmission;
    if (!admission || !configured || handle.capacityReleased) return true;

    const operationId = `room-capacity-renew:${admission.claimId}:${handle.lease.expiresAt}`;
    let global: RoomGlobalConcurrencyMutationResultV1;
    try {
      global = await configured.globalAccounting.renew({
        contractVersion: ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
        projectId: this.options.projectId,
        roomId: handle.roomId,
        claimId: admission.claimId,
        operationId,
        holderId: this.options.workerId,
        leaseId: handle.lease.id,
        fence: handle.lease.epoch,
        asOf,
        expiresAt: handle.lease.expiresAt,
      });
    } catch (error) {
      await this.recordCapacityWithheld(handle, "global", "renewal_error", {
        errorCode: error instanceof Error ? error.name : "unknown_error",
      }).catch(() => undefined);
      return false;
    }

    if (global.action !== "renewed") {
      await this.recordCapacityWithheld(handle, "global", global.reason, {
        globalAction: global.action,
        globalReason: global.reason,
        operationId,
      }).catch(() => undefined);
      return false;
    }
    if (global.claimId !== admission.claimId || global.fence !== handle.lease.epoch) {
      await this.recordCapacityWithheld(handle, "global", "renew_identity_mismatch", {
        globalAction: global.action,
        globalClaimId: global.claimId,
        globalFence: global.fence,
        operationId,
      }).catch(() => undefined);
      return false;
    }
    return true;
  }

  private createCapacityClaimId(
    configured: RoomControllerCapacityAdmissionOptionsV1,
    handle: RoomWorkerHandle,
  ): string {
    const input: RoomControllerCapacityClaimIdInputV1 = {
      projectId: this.options.projectId,
      roomId: handle.roomId,
      lease: handle.lease,
      expectedAggregateVersion: handle.projectionVersion,
      workClass: configured.workClass,
      slots: configured.slots,
    };
    return nonBlankString(
      configured.createClaimId?.(input)
        ?? `room-capacity:${this.options.projectId}:${handle.roomId}:${handle.lease.id}:${handle.lease.epoch}`,
      "capacityAdmission claimId",
    );
  }

  private async releaseCapacityAndRecordWithheld(
    handle: RoomWorkerHandle,
    admissionScope: "global",
    reason: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    let releaseError: unknown = null;
    try {
      await this.releaseCapacityAdmission(handle, "capacity_admission_failed");
    } catch (error) {
      releaseError = error;
    }
    await this.recordCapacityWithheld(handle, admissionScope, reason, metadata);
    if (releaseError) throw releaseError;
  }

  private recordCapacityAdmitted(handle: RoomWorkerHandle): Promise<void> {
    const admission = handle.capacityAdmission;
    if (!admission) {
      return Promise.reject(new Error(`Room ${handle.roomId} has no global capacity reservation`));
    }
    return this.recordLifecycleAudit("room:worker-capacity-admitted", handle.roomId, {
      leaseId: handle.lease.id,
      leaseEpoch: handle.lease.epoch,
      expectedAggregateVersion: handle.projectionVersion,
      source: handle.source,
      claimId: admission.claimId,
      globalFence: handle.lease.epoch,
      workClass: admission.workClass,
      slots: admission.slots,
    }, handle.lifecycleGeneration);
  }

  private recordCapacityWithheld(
    handle: RoomWorkerHandle,
    admissionScope: "global",
    reason: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    return this.recordLifecycleAudit("room:worker-capacity-withheld", handle.roomId, {
      leaseId: handle.lease.id,
      leaseEpoch: handle.lease.epoch,
      expectedAggregateVersion: handle.projectionVersion,
      source: handle.source,
      admissionScope,
      reason,
      ...metadata,
    }, handle.lifecycleGeneration);
  }

  private async releaseCapacityAdmission(
    handle: RoomWorkerHandle,
    _outcome: RoomControllerCapacityReleaseOutcomeV1,
  ): Promise<void> {
    const admission = handle.capacityAdmission;
    const configured = this.options.capacityAdmission;
    if (!admission || !configured || handle.capacityReleased) return;
    if (handle.capacityReleasePromise) return handle.capacityReleasePromise;
    if (!this.isLifecycleGenerationOpen(handle.lifecycleGeneration)) return;

    const operation = (async () => {
      let failure: unknown = null;
      const asOf = admission.releaseAsOf ?? this.now();
      admission.releaseAsOf ??= asOf;
      for (
        let attempt = 1;
        !admission.globalReleased && attempt <= CAPACITY_RELEASE_MAX_ATTEMPTS;
        attempt += 1
      ) {
        try {
          const released = await configured.globalAccounting.release({
            contractVersion: ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
            projectId: this.options.projectId,
            roomId: handle.roomId,
            claimId: admission.claimId,
            operationId: admission.releaseOperationId,
            holderId: this.options.workerId,
            leaseId: handle.lease.id,
            fence: handle.lease.epoch,
            asOf,
          });
          if (
            released.action !== "released"
            || released.claimId !== admission.claimId
            || released.fence !== handle.lease.epoch
          ) {
            throw new Error(`Room ${handle.roomId} capacity release was not acknowledged`);
          }
          admission.globalReleased = true;
        } catch (error) {
          failure = error;
        }
      }
      handle.capacityReleased = admission.globalReleased;
      if (!admission.globalReleased && failure) throw failure;
    })();
    handle.capacityReleasePromise = operation;
    try {
      await operation;
    } catch (error) {
      roomControllerLog.warn(
        `Room capacity release failed for ${handle.roomId}: code=room_capacity_release_failed`,
      );
      throw error;
    } finally {
      if (!handle.capacityReleased && handle.capacityReleasePromise === operation) {
        handle.capacityReleasePromise = null;
      }
    }
  }

  private async releaseHandle(handle: RoomWorkerHandle): Promise<void> {
    if (handle.releasePromise) return handle.releasePromise;
    if (!this.isLifecycleGenerationOpen(handle.lifecycleGeneration)) return;
    this.retainPendingCapacityRelease(handle);
    if (handle.released && (!handle.capacityAdmission || handle.capacityReleased)) {
      this.clearPendingCapacityRelease(handle);
      return;
    }
    const operation = (async () => {
      let capacityFailure: unknown = null;
      try {
        await this.releaseCapacityAdmission(
          handle,
          this.capacityReleaseOutcome(handle.stopReason),
        );
      } catch (error) {
        capacityFailure = error;
      }
      if (capacityFailure) throw capacityFailure;

      let leaseFailure: unknown = null;
      if (!handle.released) {
        for (let attempt = 1; attempt <= LEASE_RELEASE_MAX_ATTEMPTS; attempt += 1) {
          if (!this.isLifecycleGenerationOpen(handle.lifecycleGeneration)) break;
          try {
            await this.options.leaseStore.releaseLease(
              leaseMutationInput(handle.lease, this.now()),
            );
            if (!this.isLifecycleGenerationOpen(handle.lifecycleGeneration)) break;
            handle.released = true;
            break;
          } catch (error) {
            leaseFailure = error;
            if (attempt === LEASE_RELEASE_MAX_ATTEMPTS) break;
          }
        }
      }
      if (leaseFailure) throw leaseFailure;
      this.clearPendingCapacityRelease(handle);
    })();
    handle.releasePromise = operation;
    try {
      await operation;
    } catch (error) {
      roomControllerLog.warn(
        `Room lease release failed for ${handle.roomId}: code=room_lease_release_failed`,
      );
      throw error;
    } finally {
      if (
        (!handle.released || (handle.capacityAdmission && !handle.capacityReleased))
        && handle.releasePromise === operation
      ) {
        handle.releasePromise = null;
      }
    }
  }

  private retainPendingCapacityRelease(handle: RoomWorkerHandle): void {
    const current = this.pendingCapacityReleases.get(handle.roomId);
    if (!current || current === handle) {
      this.pendingCapacityReleases.set(handle.roomId, handle);
    }
  }

  private clearPendingCapacityRelease(handle: RoomWorkerHandle): void {
    if (this.pendingCapacityReleases.get(handle.roomId) === handle) {
      this.pendingCapacityReleases.delete(handle.roomId);
    }
  }

  private capacityReleaseOutcome(reason: string | null): RoomControllerCapacityReleaseOutcomeV1 {
    switch (reason) {
      case "worker_completed":
      case "worker_failed":
      case "controller_stop":
      case "room_not_runnable":
      case "lease_lost":
      case "recovery_withheld":
      case "semantic_inbox_stopped":
      case "renew_guard_lost":
      case "capacity_renewal_failed":
      case "capacity_admission_failed":
      case "pre_start_authority_lost":
      case "start_audit_failed":
        return reason;
      default:
        return "unknown";
    }
  }

  private async settlesWithinBudget(promise: Promise<unknown>, budgetMs: number): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const outcome = await Promise.race([
      promise.then(() => true, () => false),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), budgetMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    return outcome;
  }

  private async waitWithinBudget(promise: Promise<unknown>, budgetMs: number): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const bounded = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, budgetMs);
    });
    await Promise.race([promise.then(() => undefined, () => undefined), bounded]);
    if (timeout) clearTimeout(timeout);
  }

  private runRoomOperation(roomId: string, operation: () => Promise<void>): Promise<void> {
    if (this.roomOperations.has(roomId)) return Promise.resolve();
    const running = Promise.resolve()
      .then(operation)
      .catch((error) => {
        roomControllerLog.warn(
          `Room operation failed for ${roomId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (this.roomOperations.get(roomId) === running) this.roomOperations.delete(roomId);
      });
    this.roomOperations.set(roomId, running);
    return this.waitWithinBudget(running, this.roomOperationBudgetMs);
  }

  private canClaimRoom(room: RoomAggregateV1): boolean {
    const roomId = room.room.id;
    const restart = this.restartStates.get(roomId);
    if (!restart) return true;
    if (restart.projectionVersion !== room.room.aggregateVersion) {
      this.restartStates.delete(roomId);
      return true;
    }
    if (restart.failures > this.workerRestartMaxRestarts) return false;
    const nowMs = Date.parse(this.now());
    if (!Number.isFinite(nowMs)) throw new Error(`RoomController received invalid time ${this.now()}`);
    return nowMs >= restart.nextAttemptAtMs;
  }

  private recordAbnormalWorkerExit(handle: RoomWorkerHandle): void {
    const previous = this.restartStates.get(handle.roomId);
    const failures = previous?.projectionVersion === handle.projectionVersion
      ? previous.failures + 1
      : 1;
    const delay = Math.min(
      this.workerRestartMaxDelayMs,
      this.workerRestartBaseDelayMs * (2 ** Math.max(0, failures - 1)),
    );
    const nowMs = Date.parse(this.now());
    if (!Number.isFinite(nowMs)) return;
    this.restartStates.set(handle.roomId, {
      projectionVersion: handle.projectionVersion,
      failures,
      nextAttemptAtMs: nowMs + delay,
    });
  }

  private expiresAt(now: string): string {
    const timestamp = Date.parse(now);
    if (!Number.isFinite(timestamp)) throw new Error(`RoomController received invalid time ${now}`);
    return new Date(timestamp + this.leaseDurationMs).toISOString();
  }

  private isLifecycleGenerationOpen(lifecycleGeneration: number): boolean {
    return lifecycleGeneration === this.lifecycleGeneration && !this.lifecycleWritesClosed;
  }

  private assertAuthorityRequestAllowed(handle: RoomWorkerHandle): void {
    if (this.canStartLeaseMutation(handle.lifecycleGeneration)) return;
    this.throwControllerStoppedAuthority(handle);
  }

  private assertAuthorityResultCurrent(handle: RoomWorkerHandle): void {
    const requiresCurrentRegistration = handle.startAuditPromise !== null
      || handle.workerLaunchCommitted;
    if (
      this.canStartLeaseMutation(handle.lifecycleGeneration)
      && !handle.abortController.signal.aborted
      && (!requiresCurrentRegistration || this.handles.get(handle.roomId) === handle)
    ) return;
    this.throwControllerStoppedAuthority(handle);
  }

  private throwControllerStoppedAuthority(handle: RoomWorkerHandle): never {
    throw new RoomWorkerAuthorityError({
      lifecycleState: "blocked",
      aggregateVersion: handle.projectionVersion,
      humanPaused: false,
      approvalState: "blocked",
    }, "controller_stopped");
  }

  private canStartLeaseMutation(lifecycleGeneration: number): boolean {
    return this.isLifecycleGenerationOpen(lifecycleGeneration) && this.started && !this.stopping;
  }

  private async releaseLeaseIfOpen(
    lease: StoredRoomLeaseV1,
    lifecycleGeneration: number,
  ): Promise<void> {
    if (!this.isLifecycleGenerationOpen(lifecycleGeneration)) return;
    await this.options.leaseStore.releaseLease(leaseMutationInput(lease, this.now()));
  }
}

/** A fail-closed worker used until protocol/DAG execution is attached. */
export const PASSIVE_ROOM_WORKER: RoomWorker = Object.freeze({
  runRoom: ({ signal }: RoomWorkerRunInput) => new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  }),
});

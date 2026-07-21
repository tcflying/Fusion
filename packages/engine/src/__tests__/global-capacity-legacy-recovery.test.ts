import { describe, expect, it, vi } from "vitest";

import {
  GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
  GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION,
  type GlobalCapacityLedgerMutationResultV1,
  type GlobalCapacityLegacyAttemptPrepareInputV1,
  type GlobalCapacityLegacyAttemptV1,
} from "@fusion/core";

import {
  createGlobalCapacityLegacyRecoveryCoordinator,
  type GlobalCapacityLegacyRecoveryCoordinatorV1,
} from "../global-capacity-legacy-recovery.js";

const PREPARED: GlobalCapacityLegacyAttemptV1 = {
  contractVersion: GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION,
  id: "attempt-1",
  projectId: "project-a",
  resourceKind: "legacy_task",
  resourceId: "FN-100",
  state: "prepared",
  workClass: "normal",
  slots: 1,
  holderId: "executor-owner-1",
  leaseId: "lease-1",
  capacityFence: 7,
  claimId: "claim-1",
  acquireOperationId: "acquire-1",
  acquireGeneration: 1,
  lastWithheldOperationId: null,
  renewOperationId: "renew-1",
  renewGeneration: 1,
  lastRenewalOperationId: null,
  releaseOperationId: "release-1",
  preparedAt: "2026-07-20T05:20:00.000Z",
  expiresAt: "2026-07-20T05:25:00.000Z",
  admittedAt: null,
  workStartedAt: null,
  workFinishedAt: null,
  releasedAt: null,
  supersededAt: null,
  updatedAt: "2026-07-20T05:20:00.000Z",
};

const ADMITTED: GlobalCapacityLegacyAttemptV1 = {
  ...PREPARED,
  state: "admitted",
  admittedAt: "2026-07-20T05:20:01.000Z",
  updatedAt: "2026-07-20T05:20:01.000Z",
};

const STARTED: GlobalCapacityLegacyAttemptV1 = {
  ...ADMITTED,
  state: "work_started",
  workStartedAt: "2026-07-20T05:20:02.000Z",
  updatedAt: "2026-07-20T05:20:02.000Z",
};

const FINISHED: GlobalCapacityLegacyAttemptV1 = {
  ...STARTED,
  state: "work_finished",
  workFinishedAt: "2026-07-20T05:20:03.000Z",
  updatedAt: "2026-07-20T05:20:03.000Z",
};

const RELEASED: GlobalCapacityLegacyAttemptV1 = {
  ...FINISHED,
  state: "released",
  releasedAt: "2026-07-20T05:20:04.000Z",
  updatedAt: "2026-07-20T05:20:04.000Z",
};

const WITHHELD: GlobalCapacityLegacyAttemptV1 = {
  ...PREPARED,
  state: "withheld",
  acquireOperationId: "acquire-2",
  acquireGeneration: 2,
  lastWithheldOperationId: PREPARED.acquireOperationId,
  updatedAt: "2026-07-20T05:20:01.000Z",
};

const RELEASE_SUCCEEDED: GlobalCapacityLedgerMutationResultV1 = {
  action: "released",
  reason: "capacity_released",
  replayed: false,
  claimId: FINISHED.claimId,
  fence: FINISHED.capacityFence,
};

const PREPARE_INPUT: GlobalCapacityLegacyAttemptPrepareInputV1 = {
  contractVersion: GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION,
  resourceKind: PREPARED.resourceKind,
  resourceId: PREPARED.resourceId,
  workClass: PREPARED.workClass,
  slots: PREPARED.slots,
  holderId: PREPARED.holderId,
};

const RECOVERY_REQUEST = {
  prepareInput: PREPARE_INPUT,
  attempt: {
    contractVersion: GLOBAL_CAPACITY_LEGACY_ATTEMPT_POSTGRES_CONTRACT_VERSION,
    attemptId: PREPARED.id,
    resourceKind: PREPARED.resourceKind,
    resourceId: PREPARED.resourceId,
    capacityFence: PREPARED.capacityFence,
  },
} as const;

function createStore(attempt: GlobalCapacityLegacyAttemptV1 | null) {
  return {
    read: vi.fn(async () => attempt),
    recordRecoveredWorkFinishedRelease: vi.fn(async () => RELEASED),
    recordReleased: vi.fn(),
    prepare: vi.fn(),
    recordWorkStarted: vi.fn(),
    recordWorkFinished: vi.fn(),
  };
}

function createLedger() {
  return {
    release: vi.fn(async () => RELEASE_SUCCEEDED),
    acquire: vi.fn(),
    renew: vi.fn(),
  };
}

function createCoordinator(
  store: ReturnType<typeof createStore>,
  ledger: ReturnType<typeof createLedger>,
): GlobalCapacityLegacyRecoveryCoordinatorV1 {
  return createGlobalCapacityLegacyRecoveryCoordinator({
    projectId: PREPARED.projectId,
    store,
    ledger,
    now: () => "2026-07-20T05:20:04.000Z",
  });
}

/**
 * FNXC:GlobalCapacityLegacyRecovery 2026-07-20-05:48:
 * Durable recovery may replay only a persisted release after work_finished.
 * The fake Core recovery port matches Core's trusted acknowledgement input and
 * keeps private receipt validation out of public requests. Work-start, prepare,
 * acquire, renew, and public recordReleased remain visible so this path cannot
 * silently rerun work or claim crash closure.
 */
describe("global capacity legacy recovery coordinator", () => {
  it("replays the persisted release through the trusted Core recovery port", async () => {
    const store = createStore(FINISHED);
    const ledger = createLedger();
    const events: string[] = [];
    ledger.release.mockImplementation(async () => {
      events.push("release");
      return RELEASE_SUCCEEDED;
    });
    store.recordRecoveredWorkFinishedRelease.mockImplementation(async () => {
      events.push("trusted-record");
      return RELEASED;
    });

    await expect(createCoordinator(store, ledger).recover(RECOVERY_REQUEST)).resolves.toEqual({
      state: "released",
      attempt: RELEASED,
      release: RELEASE_SUCCEEDED,
      replayed: true,
    });

    expect(ledger.release).toHaveBeenCalledWith({
      contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
      projectId: FINISHED.projectId,
      resourceKind: FINISHED.resourceKind,
      resourceId: FINISHED.resourceId,
      claimId: FINISHED.claimId,
      operationId: FINISHED.releaseOperationId,
      holderId: FINISHED.holderId,
      leaseId: FINISHED.leaseId,
      fence: FINISHED.capacityFence,
      asOf: "2026-07-20T05:20:04.000Z",
    });
    expect(store.recordRecoveredWorkFinishedRelease).toHaveBeenCalledWith({
      contractVersion: FINISHED.contractVersion,
      attemptId: FINISHED.id,
      resourceKind: FINISHED.resourceKind,
      resourceId: FINISHED.resourceId,
      capacityFence: FINISHED.capacityFence,
      observedReleaseOperationId: FINISHED.releaseOperationId,
    });
    expect(store.recordReleased).not.toHaveBeenCalled();
    expect(store.prepare).not.toHaveBeenCalled();
    expect(store.recordWorkStarted).not.toHaveBeenCalled();
    expect(store.recordWorkFinished).not.toHaveBeenCalled();
    expect(ledger.acquire).not.toHaveBeenCalled();
    expect(ledger.renew).not.toHaveBeenCalled();
    expect(events).toEqual(["release", "trusted-record"]);
  });

  it("parks a work-started attempt for reconciliation without releasing capacity", async () => {
    const store = createStore(STARTED);
    const ledger = createLedger();

    await expect(createCoordinator(store, ledger).recover(RECOVERY_REQUEST)).resolves.toEqual({
      state: "reconciliation_required",
      action: "park",
      reason: "work_started",
      attempt: STARTED,
    });

    expect(ledger.release).not.toHaveBeenCalled();
    expect(store.recordRecoveredWorkFinishedRelease).not.toHaveBeenCalled();
    expect(store.recordReleased).not.toHaveBeenCalled();
    expect(store.prepare).not.toHaveBeenCalled();
    expect(store.recordWorkStarted).not.toHaveBeenCalled();
  });

  it.each([
    [PREPARED, "pre_start_not_started"],
    [WITHHELD, "ledger_held"],
    [ADMITTED, "admitted_without_work_start"],
  ] as const)("returns %s as retryable without starting or releasing work", async (attempt, reason) => {
    const store = createStore(attempt);
    const ledger = createLedger();

    await expect(createCoordinator(store, ledger).recover(RECOVERY_REQUEST)).resolves.toEqual({
      state: "retryable",
      reason,
      attempt,
    });

    expect(ledger.release).not.toHaveBeenCalled();
    expect(store.recordRecoveredWorkFinishedRelease).not.toHaveBeenCalled();
    expect(store.recordReleased).not.toHaveBeenCalled();
    expect(store.prepare).not.toHaveBeenCalled();
    expect(store.recordWorkStarted).not.toHaveBeenCalled();
    expect(ledger.acquire).not.toHaveBeenCalled();
  });

  it("returns unresolved and preserves the exact release operation after an unknown release outcome", async () => {
    const releaseOperationIds: string[] = [];
    const store = createStore(FINISHED);
    const ledger = createLedger();
    ledger.release.mockImplementation(async (input) => {
      releaseOperationIds.push(input.operationId);
      if (releaseOperationIds.length === 1) throw new Error("release transport unknown");
      return RELEASE_SUCCEEDED;
    });
    const coordinator = createCoordinator(store, ledger);

    await expect(coordinator.recover(RECOVERY_REQUEST)).resolves.toEqual({
      state: "unresolved",
      phase: "release",
      attempt: FINISHED,
    });
    expect(store.recordRecoveredWorkFinishedRelease).not.toHaveBeenCalled();
    expect(store.recordReleased).not.toHaveBeenCalled();

    await expect(coordinator.recover(RECOVERY_REQUEST)).resolves.toEqual({
      state: "released",
      attempt: RELEASED,
      release: RELEASE_SUCCEEDED,
      replayed: true,
    });
    expect(releaseOperationIds).toEqual([FINISHED.releaseOperationId, FINISHED.releaseOperationId]);
  });

  it("parks missing durable state instead of inventing a recovery operation", async () => {
    const store = createStore(null);
    const ledger = createLedger();

    await expect(createCoordinator(store, ledger).recover(RECOVERY_REQUEST)).resolves.toEqual({
      state: "reconciliation_required",
      action: "park",
      reason: "attempt_not_found",
    });

    expect(ledger.release).not.toHaveBeenCalled();
    expect(store.recordRecoveredWorkFinishedRelease).not.toHaveBeenCalled();
    expect(store.recordReleased).not.toHaveBeenCalled();
    expect(store.prepare).not.toHaveBeenCalled();
  });
});

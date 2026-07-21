import { describe, expect, it, vi } from "vitest";

import type { GlobalCapacityLedgerMutationResultV1 } from "@fusion/core";

import {
  GLOBAL_CAPACITY_LEGACY_ADMISSION_CONTRACT_VERSION,
  createGlobalCapacityLegacyAdmission,
  type GlobalCapacityLegacyExecutionLeaseV1,
  type GlobalCapacityLegacyLedgerPortV1,
} from "../global-capacity-legacy-admission.js";

const ACQUIRED: GlobalCapacityLedgerMutationResultV1 = {
  action: "acquired",
  reason: "capacity_admitted",
  replayed: false,
  claimId: "claim-executor-1",
  fence: 7,
};

const REPLAYED_ACQUIRED: GlobalCapacityLedgerMutationResultV1 = {
  ...ACQUIRED,
  replayed: true,
};

const RELEASED: GlobalCapacityLedgerMutationResultV1 = {
  action: "released",
  reason: "capacity_released",
  replayed: false,
  claimId: "claim-executor-1",
  fence: 7,
};

const HELD: GlobalCapacityLedgerMutationResultV1 = {
  action: "held",
  reason: "global_capacity_exhausted",
  replayed: false,
  claimId: null,
  fence: null,
};

const LEASE: GlobalCapacityLegacyExecutionLeaseV1 = {
  projectId: "project-a",
  resourceKind: "legacy_task",
  resourceId: "FN-100",
  claimId: "claim-executor-1",
  acquireOperationId: "acquire-executor-1",
  releaseOperationId: "release-executor-1",
  holderId: "agent-executor-1",
  leaseId: "task-lease-1",
  fence: 7,
  workClass: "normal",
  slots: 1,
  acquiredAt: "2026-07-20T03:15:00.000Z",
  expiresAt: "2026-07-20T03:20:00.000Z",
};

function createPorts(overrides: Partial<GlobalCapacityLegacyLedgerPortV1> = {}): GlobalCapacityLegacyLedgerPortV1 {
  return {
    acquire: vi.fn(async () => ACQUIRED),
    renew: vi.fn(async () => ({
      action: "renewed",
      reason: "capacity_renewed",
      replayed: false,
      claimId: LEASE.claimId,
      fence: LEASE.fence,
    })),
    release: vi.fn(async () => RELEASED),
    ...overrides,
  };
}

describe("global capacity legacy admission", () => {
  it("runs only after the durable ledger admits an exact trusted task lease and releases it afterward", async () => {
    const ports = createPorts();
    const admission = createGlobalCapacityLegacyAdmission({
      projectId: "project-a",
      ports,
      now: () => "2026-07-20T03:16:00.000Z",
    });
    const work = vi.fn(async () => "completed-work");

    const result = await admission.run({
      contractVersion: GLOBAL_CAPACITY_LEGACY_ADMISSION_CONTRACT_VERSION,
      lease: LEASE,
    }, work);

    expect(result).toMatchObject({
      state: "completed",
      value: "completed-work",
      admission: ACQUIRED,
      release: RELEASED,
      cleanupState: "released",
    });
    expect(work).toHaveBeenCalledTimes(1);
    expect(ports.acquire).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-a",
      resourceKind: "legacy_task",
      resourceId: "FN-100",
      claimId: "claim-executor-1",
      operationId: "acquire-executor-1",
      holderId: "agent-executor-1",
      leaseId: "task-lease-1",
      fence: 7,
    }));
    expect(ports.release).toHaveBeenCalledWith(expect.objectContaining({
      claimId: "claim-executor-1",
      operationId: "release-executor-1",
      asOf: "2026-07-20T03:16:00.000Z",
    }));
  });

  it("withholds work before it starts when durable capacity is not admitted", async () => {
    const ports = createPorts({ acquire: vi.fn(async () => HELD) });
    const admission = createGlobalCapacityLegacyAdmission({
      projectId: "project-a",
      ports,
      now: () => "2026-07-20T03:16:00.000Z",
    });
    const work = vi.fn(async () => "must-not-run");

    await expect(admission.run({
      contractVersion: GLOBAL_CAPACITY_LEGACY_ADMISSION_CONTRACT_VERSION,
      lease: LEASE,
    }, work)).resolves.toEqual({ state: "withheld", admission: HELD });
    expect(work).not.toHaveBeenCalled();
    expect(ports.release).not.toHaveBeenCalled();
  });

  it("fails closed rather than rerunning external work when acquire is replayed without a durable work-start receipt", async () => {
    const ports = createPorts({ acquire: vi.fn(async () => REPLAYED_ACQUIRED) });
    const admission = createGlobalCapacityLegacyAdmission({
      projectId: "project-a",
      ports,
      now: () => "2026-07-20T03:16:00.000Z",
    });
    const work = vi.fn(async () => "must-not-run-twice");

    await expect(admission.run({
      contractVersion: GLOBAL_CAPACITY_LEGACY_ADMISSION_CONTRACT_VERSION,
      lease: LEASE,
    }, work)).resolves.toEqual({ state: "recovery_required", admission: REPLAYED_ACQUIRED });
    expect(work).not.toHaveBeenCalled();
    expect(ports.release).not.toHaveBeenCalled();
  });

  it("fails closed for a missing trusted fence and does not touch the ledger", async () => {
    const ports = createPorts();
    const admission = createGlobalCapacityLegacyAdmission({
      projectId: "project-a",
      ports,
      now: () => "2026-07-20T03:16:00.000Z",
    });
    const work = vi.fn(async () => "must-not-run");

    await expect(admission.run({
      contractVersion: GLOBAL_CAPACITY_LEGACY_ADMISSION_CONTRACT_VERSION,
      lease: { ...LEASE, fence: 0 },
    }, work)).resolves.toMatchObject({
      state: "withheld",
      admission: { action: "rejected", reason: "invalid_request" },
    });
    expect(work).not.toHaveBeenCalled();
    expect(ports.acquire).not.toHaveBeenCalled();
  });

  it("releases after a thrown worker and keeps renewal bound to the same lease identity", async () => {
    const ports = createPorts();
    const admission = createGlobalCapacityLegacyAdmission({
      projectId: "project-a",
      ports,
      now: () => "2026-07-20T03:16:00.000Z",
    });
    const failure = new Error("worker failed");

    await expect(admission.run({
      contractVersion: GLOBAL_CAPACITY_LEGACY_ADMISSION_CONTRACT_VERSION,
      lease: LEASE,
    }, async () => {
      throw failure;
    })).rejects.toBe(failure);
    expect(ports.release).toHaveBeenCalledTimes(1);

    await expect(admission.renew({
      contractVersion: GLOBAL_CAPACITY_LEGACY_ADMISSION_CONTRACT_VERSION,
      lease: LEASE,
      operationId: "renew-executor-1",
      asOf: "2026-07-20T03:17:00.000Z",
      expiresAt: "2026-07-20T03:22:00.000Z",
    })).resolves.toMatchObject({ action: "renewed" });
    expect(ports.renew).toHaveBeenCalledWith(expect.objectContaining({
      resourceKind: "legacy_task",
      claimId: "claim-executor-1",
      holderId: "agent-executor-1",
      leaseId: "task-lease-1",
      fence: 7,
      operationId: "renew-executor-1",
    }));
  });

  it("keeps a completed worker distinct from a rejected cleanup release", async () => {
    const ports = createPorts({
      release: vi.fn(async () => ({
        action: "rejected",
        reason: "stale_fence",
        replayed: false,
        claimId: null,
        fence: null,
      })),
    });
    const admission = createGlobalCapacityLegacyAdmission({
      projectId: "project-a",
      ports,
      now: () => "2026-07-20T03:16:00.000Z",
    });

    await expect(admission.run({
      contractVersion: GLOBAL_CAPACITY_LEGACY_ADMISSION_CONTRACT_VERSION,
      lease: LEASE,
    }, async () => "worker-completed")).resolves.toMatchObject({
      state: "completed",
      value: "worker-completed",
      cleanupState: "release_withheld",
      release: { action: "rejected", reason: "stale_fence" },
    });
  });
});

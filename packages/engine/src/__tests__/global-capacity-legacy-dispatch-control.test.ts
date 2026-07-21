import type {
  GlobalCapacityLegacyAttemptV1,
} from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import {
  createGlobalCapacityLegacyDispatchControl,
  globalCapacityLegacyHolderId,
} from "../global-capacity-legacy-dispatch-control.js";
import type {
  GlobalCapacityLegacyAttemptExecutionHandleV1,
  GlobalCapacityLegacyAttemptRunnerV1,
} from "../global-capacity-legacy-attempt-runner.js";

const PROJECT_ID = "project-control";

function attempt(): GlobalCapacityLegacyAttemptV1 {
  return {
    contractVersion: 1,
    id: "attempt-1",
    projectId: PROJECT_ID,
    resourceKind: "legacy_task",
    resourceId: "task-1",
    state: "work_started",
    workClass: "normal",
    slots: 1,
    holderId: globalCapacityLegacyHolderId(PROJECT_ID, "legacy_task", "task-1"),
    leaseId: "lease-1",
    capacityFence: 1,
    claimId: "claim-1",
    acquireOperationId: "acquire-1",
    acquireGeneration: 1,
    lastWithheldOperationId: null,
    renewOperationId: "renew-1",
    renewGeneration: 1,
    lastRenewalOperationId: null,
    releaseOperationId: "release-1",
    preparedAt: "2026-07-20T00:00:00.000Z",
    expiresAt: "2026-07-20T00:05:00.000Z",
    admittedAt: "2026-07-20T00:00:00.000Z",
    workStartedAt: "2026-07-20T00:00:00.000Z",
    workFinishedAt: null,
    releasedAt: null,
    supersededAt: null,
    updatedAt: "2026-07-20T00:00:00.000Z",
  };
}

function handle(): GlobalCapacityLegacyAttemptExecutionHandleV1 {
  const current = attempt();
  return {
    attempt: current,
    executionReceiptId: "receipt-1",
    renew: vi.fn(async () => ({ state: "renewed", attempt: current, renewal: { action: "renewed", reason: "renewed", replayed: false, claimId: current.claimId, fence: current.capacityFence } })),
    finish: vi.fn(async () => ({ state: "released", attempt: { ...current, state: "released" as const }, release: { action: "released", reason: "capacity_released", replayed: false, claimId: current.claimId, fence: current.capacityFence } })),
  };
}

describe("global capacity legacy dispatch control", () => {
  it("builds an explicit durable prepare bundle with a stable holder identity", async () => {
    const run = vi.fn(async () => ({ state: "rejected" as const, reason: "invalid_input" as const }));
    const control = createGlobalCapacityLegacyDispatchControl({
      projectId: PROJECT_ID,
      runner: { run } as GlobalCapacityLegacyAttemptRunnerV1,
      leaseTtlMs: 120_000,
    });

    await expect(control.begin({ resourceKind: "legacy_task", resourceId: "task-1", workClass: "normal", slots: 1 }))
      .resolves.toEqual({ state: "rejected", reason: "invalid_input" });
    expect(run).toHaveBeenCalledWith({
      contractVersion: 1,
      resourceKind: "legacy_task",
      resourceId: "task-1",
      workClass: "normal",
      slots: 1,
      holderId: globalCapacityLegacyHolderId(PROJECT_ID, "legacy_task", "task-1"),
    });
  });

  it("rejects malformed start identity before it reaches the durable runner", async () => {
    const run = vi.fn();
    const control = createGlobalCapacityLegacyDispatchControl({
      projectId: PROJECT_ID,
      runner: { run } as GlobalCapacityLegacyAttemptRunnerV1,
      leaseTtlMs: 120_000,
    });

    await expect(control.begin({ resourceKind: "legacy_task", resourceId: "", workClass: "normal", slots: 1 }))
      .resolves.toEqual({ state: "rejected", reason: "invalid_input" });
    expect(run).not.toHaveBeenCalled();
  });

  it("passes the verified central TTL to the lease maintainer", () => {
    const scheduler = { schedule: vi.fn(() => ({ cancel: vi.fn() })) };
    const control = createGlobalCapacityLegacyDispatchControl({
      projectId: PROJECT_ID,
      runner: { run: vi.fn() } as GlobalCapacityLegacyAttemptRunnerV1,
      leaseTtlMs: 120_000,
      scheduler,
    });

    const maintainer = control.maintain({ handle: handle(), onRenewalFailure: vi.fn() });
    maintainer.start();
    expect(scheduler.schedule).toHaveBeenCalledWith(60_000, expect.any(Function));
  });
});

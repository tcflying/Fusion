import { beforeEach, describe, expect, it, vi } from "vitest";

const recoverySeams = vi.hoisted(() => ({
  acquireSenderLease: vi.fn(),
  recoverRoomAfterCrash: vi.fn(),
}));

vi.mock("@fusion/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@fusion/core")>(),
  acquireRoomRecoverySenderLease: recoverySeams.acquireSenderLease,
  recoverRoomAfterCrash: recoverySeams.recoverRoomAfterCrash,
}));

import { DurableRoomRecoveryWorker } from "../room-durable-recovery-worker.js";
import { SessionConnectorRegistry } from "../session-connector-registry.js";

const NOW = "2026-07-18T00:00:00.000Z";

function lease(kind: "room_worker" | "sender", overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    id: `lease-${kind}`,
    roomId: "room-1",
    kind,
    resourceId: kind === "room_worker" ? "room-1" : "binding-1",
    holderId: "worker-1",
    hostId: "host-1",
    epoch: 3,
    acquiredAt: NOW,
    heartbeatAt: NOW,
    expiresAt: "2026-07-18T00:01:00.000Z",
    releasedAt: null,
    ...overrides,
  } as const;
}

describe("DurableRoomRecoveryWorker", () => {
  beforeEach(() => {
    recoverySeams.acquireSenderLease.mockReset();
    recoverySeams.recoverRoomAfterCrash.mockReset();
  });

  it("proves Room authority, acquires per-binding sender authority, runs durable recovery, and releases the sender lease", async () => {
    const abortController = new AbortController();
    const roomWorkerLease = lease("room_worker");
    const senderLease = lease("sender", { id: "lease-sender-new" });
    const releaseLease = vi.fn(async () => ({ ok: true, lease: senderLease }));
    const assertAuthority = vi.fn(async () => ({
      lease: roomWorkerLease,
      posture: {
        lifecycleState: "running",
        aggregateVersion: 7,
        humanPaused: false,
        approvalState: "none",
      },
    }));
    recoverySeams.acquireSenderLease.mockResolvedValue(senderLease);
    recoverySeams.recoverRoomAfterCrash.mockImplementation(async (input) => {
      expect(await input.resolveSenderLease("binding-1")).toEqual(senderLease);
      abortController.abort();
      return { deliveries: [], checkpointId: null, nativeTakeover: null };
    });

    const worker = new DurableRoomRecoveryWorker({
      projectId: "project-1",
      workerId: "worker-1",
      hostId: "host-1",
      layer: { projectId: "project-1" } as never,
      roomStore: {} as never,
      leaseStore: { releaseLease } as never,
      checkpointStore: {} as never,
      registry: new SessionConnectorRegistry(),
      now: () => NOW,
      createSenderLeaseId: () => "lease-sender-new",
    });

    await worker.runRoom({
      room: {
        room: { id: "room-1", projectId: "project-1", aggregateVersion: 7 },
      } as never,
      lease: roomWorkerLease,
      signal: abortController.signal,
      assertAuthority,
      assertLeaseAuthority: async () => roomWorkerLease,
    });

    expect(assertAuthority).toHaveBeenCalledTimes(2);
    expect(recoverySeams.acquireSenderLease).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      roomId: "room-1",
      bindingId: "binding-1",
      workerId: "worker-1",
      hostId: "host-1",
      leaseId: "lease-sender-new",
    }));
    expect(recoverySeams.recoverRoomAfterCrash).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      roomId: "room-1",
      workerId: "worker-1",
      hostId: "host-1",
      roomWorkerLease,
      senderLease: null,
    }));
    expect(releaseLease).toHaveBeenCalledWith(expect.objectContaining({
      leaseId: "lease-sender-new",
      kind: "sender",
      expectedEpoch: 3,
    }));
  });

  it("does not release a matching sender lease that predated this recovery cycle", async () => {
    const abortController = new AbortController();
    const roomWorkerLease = lease("room_worker");
    const reusedSenderLease = lease("sender", { id: "lease-sender-preexisting" });
    const releaseLease = vi.fn();
    const assertAuthority = vi.fn(async () => ({
      lease: roomWorkerLease,
      posture: {
        lifecycleState: "running",
        aggregateVersion: 7,
        humanPaused: false,
        approvalState: "none",
      },
    }));
    recoverySeams.acquireSenderLease.mockResolvedValue(reusedSenderLease);
    recoverySeams.recoverRoomAfterCrash.mockImplementation(async (input) => {
      await input.resolveSenderLease("binding-1");
      abortController.abort();
      return { deliveries: [], checkpointId: null, nativeTakeover: null };
    });
    const worker = new DurableRoomRecoveryWorker({
      projectId: "project-1",
      workerId: "worker-1",
      hostId: "host-1",
      layer: { projectId: "project-1" } as never,
      roomStore: {} as never,
      leaseStore: { releaseLease } as never,
      checkpointStore: {} as never,
      registry: new SessionConnectorRegistry(),
      now: () => NOW,
      createSenderLeaseId: () => "lease-sender-new-attempt",
    });

    await worker.runRoom({
      room: {
        room: { id: "room-1", projectId: "project-1", aggregateVersion: 7 },
      } as never,
      lease: roomWorkerLease,
      signal: abortController.signal,
      assertAuthority,
      assertLeaseAuthority: async () => roomWorkerLease,
    });

    expect(releaseLease).not.toHaveBeenCalled();
  });

  it("revalidates a cached sender lease against fresh wall-clock time before another delivery", async () => {
    const abortController = new AbortController();
    const roomWorkerLease = lease("room_worker");
    const firstSenderLease = lease("sender", {
      id: "lease-sender-short",
      epoch: 3,
      expiresAt: "2026-07-18T00:00:10.000Z",
    });
    const replacementSenderLease = lease("sender", {
      id: "lease-sender-replacement",
      epoch: 4,
      acquiredAt: "2026-07-18T00:00:11.000Z",
      heartbeatAt: "2026-07-18T00:00:11.000Z",
      expiresAt: "2026-07-18T00:00:41.000Z",
    });
    let currentNow = NOW;
    const releaseLease = vi.fn(async () => ({ ok: true, lease: replacementSenderLease }));
    const assertFence = vi.fn(async (input: { readonly leaseId: string; readonly now: string }) => {
      if (input.leaseId === firstSenderLease.id && input.now >= firstSenderLease.expiresAt) {
        const error = new Error("stale sender fence") as Error & { code: string };
        error.code = "stale_lease_fence";
        throw error;
      }
      return input.leaseId === firstSenderLease.id ? firstSenderLease : replacementSenderLease;
    });
    const assertAuthority = vi.fn(async () => ({
      lease: roomWorkerLease,
      posture: {
        lifecycleState: "running",
        aggregateVersion: 7,
        humanPaused: false,
        approvalState: "none",
      },
    }));
    recoverySeams.acquireSenderLease
      .mockResolvedValueOnce(firstSenderLease)
      .mockResolvedValueOnce(replacementSenderLease);
    recoverySeams.recoverRoomAfterCrash.mockImplementation(async (input) => {
      expect(input.signal).toBe(abortController.signal);
      await input.assertAuthority();
      expect(await input.resolveSenderLease("binding-1")).toEqual(firstSenderLease);
      currentNow = "2026-07-18T00:00:11.000Z";
      expect(input.currentTime()).toBe(currentNow);
      expect(await input.resolveSenderLease("binding-1")).toEqual(replacementSenderLease);
      abortController.abort();
      return { deliveries: [], checkpointId: null, nativeTakeover: null };
    });
    const worker = new DurableRoomRecoveryWorker({
      projectId: "project-1",
      workerId: "worker-1",
      hostId: "host-1",
      layer: { projectId: "project-1" } as never,
      roomStore: {} as never,
      leaseStore: { assertFence, releaseLease } as never,
      checkpointStore: {} as never,
      registry: new SessionConnectorRegistry(),
      now: () => currentNow,
      createSenderLeaseId: (_roomId, _bindingId) => currentNow === NOW
        ? firstSenderLease.id
        : replacementSenderLease.id,
      senderLeaseDurationMs: 30_000,
    });

    await worker.runRoom({
      room: {
        room: { id: "room-1", projectId: "project-1", aggregateVersion: 7 },
      } as never,
      lease: roomWorkerLease,
      signal: abortController.signal,
      assertAuthority,
      assertLeaseAuthority: async () => roomWorkerLease,
    });

    expect(recoverySeams.acquireSenderLease).toHaveBeenCalledTimes(2);
    expect(recoverySeams.acquireSenderLease).toHaveBeenLastCalledWith(expect.objectContaining({
      leaseId: replacementSenderLease.id,
      now: currentNow,
    }));
    expect(assertFence).toHaveBeenCalledWith(expect.objectContaining({
      leaseId: firstSenderLease.id,
      now: currentNow,
    }));
  });
});

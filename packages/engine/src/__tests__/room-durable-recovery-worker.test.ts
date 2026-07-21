import { beforeEach, describe, expect, it, vi } from "vitest";

const recoverySeams = vi.hoisted(() => ({
  acquireSenderLease: vi.fn(),
  recoverRoomAfterCrash: vi.fn(),
}));

const deliveryCoordinatorSeams = vi.hoisted(() => ({
  dispatch: vi.fn(),
}));

vi.mock("@fusion/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@fusion/core")>(),
  acquireRoomRecoverySenderLease: recoverySeams.acquireSenderLease,
  recoverRoomAfterCrash: recoverySeams.recoverRoomAfterCrash,
}));

vi.mock("../room-delivery-coordinator.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../room-delivery-coordinator.js")>(),
  dispatchRoomDelivery: deliveryCoordinatorSeams.dispatch,
}));

import { hashRoomValue, type StoredRoomLeaseV1 } from "@fusion/core";
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
    deliveryCoordinatorSeams.dispatch.mockReset();
  });

  it("refuses provider dispatch composition when the atomic pending-outbox cleanup fence is absent", () => {
    expect(() => new DurableRoomRecoveryWorker({
      projectId: "project-1",
      workerId: "worker-1",
      hostId: "host-1",
      layer: { projectId: "project-1" } as never,
      roomStore: {} as never,
      leaseStore: {} as never,
      checkpointStore: {} as never,
      registry: new SessionConnectorRegistry(),
      now: () => NOW,
      providerBackpressureSendGate: { admit: vi.fn() } as never,
      providerBackpressureCleanupActions: {
        enqueue: vi.fn(),
        claimNext: vi.fn(),
        markExpired: vi.fn(),
        finalizeExactPreSendOutbox: vi.fn(),
      } as never,
    })).toThrow("fencePendingOutbox");
  });

  it("refuses a cleanup adapter that cannot finalize a terminal pre-claim fence", () => {
    expect(() => new DurableRoomRecoveryWorker({
      projectId: "project-1",
      workerId: "worker-1",
      hostId: "host-1",
      layer: { projectId: "project-1" } as never,
      roomStore: {} as never,
      leaseStore: {} as never,
      checkpointStore: {} as never,
      registry: new SessionConnectorRegistry(),
      now: () => NOW,
      providerBackpressureSendGate: { admit: vi.fn() } as never,
      providerBackpressureCleanupActions: {
        enqueue: vi.fn(),
        fencePendingOutbox: vi.fn(),
        claimNext: vi.fn(),
        markExpired: vi.fn(),
        finalizeExactPreSendOutbox: vi.fn(),
      } as never,
    })).toThrow("finalizeTerminalPreClaimOutbox");
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

    expect(assertAuthority).toHaveBeenCalledTimes(3);
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

  it("fails closed when Core recovery is canceled by PostgreSQL SQLSTATE 57014", async () => {
    const abortController = new AbortController();
    const roomWorkerLease = lease("room_worker");
    const timeoutError = Object.assign(
      new Error("canceling statement due to statement timeout"),
      { code: "57014" },
    );
    const recoverNoProgressTaskDispatches = vi.fn();
    const assertAuthority = vi.fn(async () => ({
      lease: roomWorkerLease,
      posture: {
        lifecycleState: "running",
        aggregateVersion: 7,
        humanPaused: false,
        approvalState: "none",
      },
    }));
    recoverySeams.recoverRoomAfterCrash.mockRejectedValue(timeoutError);

    const worker = new DurableRoomRecoveryWorker({
      projectId: "project-1",
      workerId: "worker-1",
      hostId: "host-1",
      layer: { projectId: "project-1" } as never,
      roomStore: { recoverNoProgressTaskDispatches } as never,
      leaseStore: { releaseLease: vi.fn() } as never,
      checkpointStore: {} as never,
      registry: new SessionConnectorRegistry(),
      now: () => NOW,
    });

    await expect(worker.runRoom({
      room: { room: { id: "room-1", projectId: "project-1", aggregateVersion: 7 } } as never,
      lease: roomWorkerLease,
      signal: abortController.signal,
      assertAuthority,
      assertLeaseAuthority: async () => roomWorkerLease,
    })).resolves.toBeUndefined();

    expect(recoverySeams.recoverRoomAfterCrash).toHaveBeenCalledTimes(1);
    expect(recoverySeams.acquireSenderLease).not.toHaveBeenCalled();
    expect(deliveryCoordinatorSeams.dispatch).not.toHaveBeenCalled();
    expect(recoverNoProgressTaskDispatches).not.toHaveBeenCalled();
  });

  it("fails closed before sender acquisition when terminal timeout resolution is canceled by PostgreSQL SQLSTATE 57014", async () => {
    const abortController = new AbortController();
    const roomWorkerLease = lease("room_worker");
    const timeoutError = Object.assign(
      new Error("canceling statement due to lock timeout"),
      { code: "57014" },
    );
    const claimedTerminalProof = {
      contractVersion: 1,
      id: "provider-admission-timeout:terminal-proof-timeout",
      projectId: "project-1",
      roomId: "room-1",
      gateAttemptId: "gate-attempt-timeout",
      requestHash: "c".repeat(64),
      outboxId: "outbox-1",
      outboxBindingId: "binding-1",
      outboxAttemptCount: 0,
      senderFence: {
        leaseId: "lease-sender-old",
        holderId: "worker-old",
        hostId: "host-old",
        epoch: 2,
      },
      timeoutErrorCode: "provider_gate_timeout",
      state: "terminal_outcome_claimed",
      cleanupActionId: null,
      reservationId: null,
      terminalGateOutcomeId: "terminal-outcome-timeout",
      terminalGateOutcome: "deferred_without_permit",
      terminalAt: NOW,
      claimToken: "terminal-claim-timeout",
      claimLeaseId: roomWorkerLease.id,
      claimLeaseEpoch: roomWorkerLease.epoch,
      claimedAt: NOW,
      claimExpiresAt: "2026-07-18T00:01:00.000Z",
      nextAttemptAt: null,
      resolvedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as never;
    const claimNextAdmissionTimeoutTerminalOutcome = vi.fn(async () => claimedTerminalProof);
    const resolveAdmissionTimeoutWithoutPermit = vi.fn(async () => {
      throw timeoutError;
    });
    const recoverNoProgressTaskDispatches = vi.fn();
    const worker = new DurableRoomRecoveryWorker({
      projectId: "project-1",
      workerId: "worker-1",
      hostId: "host-1",
      layer: { projectId: "project-1" } as never,
      roomStore: { recoverNoProgressTaskDispatches } as never,
      leaseStore: { releaseLease: vi.fn() } as never,
      checkpointStore: {} as never,
      registry: new SessionConnectorRegistry(),
      now: () => NOW,
      providerBackpressureCleanupActions: {
        enqueue: vi.fn(),
        fencePendingOutbox: vi.fn(),
        claimNext: vi.fn(async () => null),
        markExpired: vi.fn(),
        finalizeExactPreSendOutbox: vi.fn(),
        finalizeTerminalPreClaimOutbox: vi.fn(),
        reconcilePendingAdmissionTimeout: vi.fn(async () => null),
        claimNextAdmissionTimeoutTerminalOutcome,
        resolveAdmissionTimeoutWithoutPermit,
      },
    });

    await expect(worker.runRoom({
      room: { room: { id: "room-1", projectId: "project-1", aggregateVersion: 7 } } as never,
      lease: roomWorkerLease,
      signal: abortController.signal,
      assertAuthority: async () => ({
        lease: roomWorkerLease,
        posture: {
          lifecycleState: "running",
          aggregateVersion: 7,
          humanPaused: false,
          approvalState: "none",
        },
      }),
      assertLeaseAuthority: async () => roomWorkerLease,
    })).resolves.toBeUndefined();

    expect(claimNextAdmissionTimeoutTerminalOutcome).toHaveBeenCalledTimes(1);
    expect(resolveAdmissionTimeoutWithoutPermit).toHaveBeenCalledTimes(1);
    expect(recoverySeams.acquireSenderLease).not.toHaveBeenCalled();
    expect(recoverySeams.recoverRoomAfterCrash).not.toHaveBeenCalled();
    expect(deliveryCoordinatorSeams.dispatch).not.toHaveBeenCalled();
    expect(recoverNoProgressTaskDispatches).not.toHaveBeenCalled();
  });

  it.each(["reservation_bound", "terminal_outcome_recorded", "retry_later"] as const)(
    "stops before any sender or crash recovery when receipt-backed admission-timeout preflight reports %s",
    async (status) => {
      const abortController = new AbortController();
      const roomWorkerLease = lease("room_worker");
      const reconcilePendingAdmissionTimeout = vi.fn(async () => ({ status } as never));
      const claimNextAdmissionTimeoutTerminalOutcome = vi.fn(async () => null);
      const recoverNoProgressTaskDispatches = vi.fn();
      recoverySeams.recoverRoomAfterCrash.mockImplementation(async () => {
        abortController.abort();
        return { deliveries: [], checkpointId: null, nativeTakeover: null };
      });
      const worker = new DurableRoomRecoveryWorker({
        projectId: "project-1",
        workerId: "worker-1",
        hostId: "host-1",
        layer: { projectId: "project-1" } as never,
        roomStore: { recoverNoProgressTaskDispatches } as never,
        leaseStore: { releaseLease: vi.fn() } as never,
        checkpointStore: {} as never,
        registry: new SessionConnectorRegistry(),
        now: () => NOW,
        providerBackpressureCleanupActions: {
          enqueue: vi.fn(),
          fencePendingOutbox: vi.fn(),
          claimNext: vi.fn(async () => null),
          markExpired: vi.fn(),
          finalizeExactPreSendOutbox: vi.fn(),
          finalizeTerminalPreClaimOutbox: vi.fn(),
          reconcilePendingAdmissionTimeout,
          claimNextAdmissionTimeoutTerminalOutcome,
          resolveAdmissionTimeoutWithoutPermit: vi.fn(),
        },
      });

      await expect(worker.runRoom({
        room: { room: { id: "room-1", projectId: "project-1", aggregateVersion: 7 } } as never,
        lease: roomWorkerLease,
        signal: abortController.signal,
        assertAuthority: async () => ({
          lease: roomWorkerLease,
          posture: {
            lifecycleState: "running",
            aggregateVersion: 7,
            humanPaused: false,
            approvalState: "none",
          },
        }),
        assertLeaseAuthority: async () => roomWorkerLease,
      })).resolves.toBeUndefined();

      expect(reconcilePendingAdmissionTimeout).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "project-1",
        roomId: "room-1",
        cleanupWorkerLease: roomWorkerLease,
        audit: {
          runId: `room-provider-admission-timeout-reconcile:room-1:epoch:${roomWorkerLease.epoch}`,
          agentId: "worker-1",
        },
      }));
      expect(claimNextAdmissionTimeoutTerminalOutcome).not.toHaveBeenCalled();
      expect(recoverySeams.acquireSenderLease).not.toHaveBeenCalled();
      expect(deliveryCoordinatorSeams.dispatch).not.toHaveBeenCalled();
      expect(recoverySeams.recoverRoomAfterCrash).not.toHaveBeenCalled();
      expect(recoverNoProgressTaskDispatches).not.toHaveBeenCalled();
    },
  );

  it("rethrows a stale-fence error from Core recovery", async () => {
    const abortController = new AbortController();
    const roomWorkerLease = lease("room_worker");
    const staleFenceError = Object.assign(new Error("stale Room worker fence"), {
      code: "stale_lease_fence",
    });
    recoverySeams.recoverRoomAfterCrash.mockRejectedValue(staleFenceError);
    const worker = new DurableRoomRecoveryWorker({
      projectId: "project-1",
      workerId: "worker-1",
      hostId: "host-1",
      layer: { projectId: "project-1" } as never,
      roomStore: {} as never,
      leaseStore: { releaseLease: vi.fn() } as never,
      checkpointStore: {} as never,
      registry: new SessionConnectorRegistry(),
      now: () => NOW,
    });

    await expect(worker.runRoom({
      room: { room: { id: "room-1", projectId: "project-1", aggregateVersion: 7 } } as never,
      lease: roomWorkerLease,
      signal: abortController.signal,
      assertAuthority: async () => ({
        lease: roomWorkerLease,
        posture: {
          lifecycleState: "running",
          aggregateVersion: 7,
          humanPaused: false,
          approvalState: "none",
        },
      }),
      assertLeaseAuthority: async () => roomWorkerLease,
    })).rejects.toBe(staleFenceError);

    expect(recoverySeams.acquireSenderLease).not.toHaveBeenCalled();
    expect(deliveryCoordinatorSeams.dispatch).not.toHaveBeenCalled();
  });

  it("uses no sender lease when Core reports active-sender retry_later for a terminal pre-claim fence", async () => {
    const abortController = new AbortController();
    const roomWorkerLease = lease("room_worker");
    const terminalPreClaimAction = {
      id: "cleanup-pre-claim",
      roomId: "room-1",
      state: "released",
      completionKind: "pre_claim_not_started",
      outboxId: "outbox-1",
      outboxBindingId: "binding-1",
      outboxAttemptId: null,
      outboxAttemptCount: 0,
    };
    const pendingActions = [terminalPreClaimAction];
    const finalizeExactPreSendOutbox = vi.fn();
    const finalizeTerminalPreClaimOutbox = vi.fn(async () => ({
      status: "retry_later" as const,
      action: terminalPreClaimAction,
    }));
    const providerBackpressureCleanupActions = {
      enqueue: vi.fn(),
      fencePendingOutbox: vi.fn(),
      claimNext: vi.fn(async () => pendingActions.shift() ?? null),
      markExpired: vi.fn(),
      finalizeExactPreSendOutbox,
      finalizeTerminalPreClaimOutbox,
      reconcilePendingAdmissionTimeout: vi.fn(async () => null),
      claimNextAdmissionTimeoutTerminalOutcome: vi.fn(async () => null),
      resolveAdmissionTimeoutWithoutPermit: vi.fn(),
    };
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
    recoverySeams.recoverRoomAfterCrash.mockImplementation(async () => {
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
      providerBackpressureCleanupActions,
    });

    await worker.runRoom({
      room: { room: { id: "room-1", projectId: "project-1", aggregateVersion: 7 } } as never,
      lease: roomWorkerLease,
      signal: abortController.signal,
      assertAuthority,
      assertLeaseAuthority: async () => roomWorkerLease,
    });

    /*
    FNXC:RoomProviderPreClaimTerminalRecovery 2026-07-20-22:38:
    A Core retry_later means a live sender owns the uncertain generation. The
    recovery worker may only hand off the future normal retry to Core; it cannot
    acquire sender authority, invoke a connector, or start another admission.
    */
    expect(finalizeTerminalPreClaimOutbox).toHaveBeenCalledWith(expect.objectContaining({
      actionId: "cleanup-pre-claim",
      cleanupWorkerLease: roomWorkerLease,
      nextAttemptAt: "2026-07-18T00:00:01.000Z",
    }));
    expect(finalizeExactPreSendOutbox).not.toHaveBeenCalled();
    expect(recoverySeams.acquireSenderLease).not.toHaveBeenCalled();
    expect(releaseLease).not.toHaveBeenCalled();
    expect(deliveryCoordinatorSeams.dispatch).not.toHaveBeenCalled();
  });

  /*
  FNXC:RoomProviderAdmissionTimeoutRestartRecovery 2026-07-20-23:55:
  A late no-permit callback can terminate with the original Room worker. A
  successor may consume only Core's durably recorded terminal proof under its
  own current room-worker lease, schedule a strictly future retry, and never
  acquire sender authority or contact a provider during that recovery handoff.
  */
  it.each(["resolved", "replayed"] as const)(
    "claims one recorded no-permit proof after restart with a fresh room-worker lease when Core %s",
    async (status) => {
    const abortController = new AbortController();
    const oldCallbackLease = lease("room_worker", {
      id: "lease-room-worker-old-callback",
      holderId: "worker-old",
      hostId: "host-old",
      epoch: 2,
    });
    const restartedRoomWorkerLease = lease("room_worker", {
      id: "lease-room-worker-restarted",
      holderId: "worker-restarted",
      hostId: "host-restarted",
      epoch: 4,
    });
    const claimedTerminalProof = {
      contractVersion: 1,
      id: "provider-admission-timeout:terminal-proof-1",
      projectId: "project-1",
      roomId: "room-1",
      gateAttemptId: "gate-attempt-old-1",
      requestHash: "a".repeat(64),
      outboxId: "outbox-1",
      outboxBindingId: "binding-1",
      outboxAttemptCount: 0,
      senderFence: {
        leaseId: "lease-sender-old",
        holderId: "worker-old",
        hostId: "host-old",
        epoch: 2,
      },
      timeoutErrorCode: "provider_gate_timeout",
      state: "terminal_outcome_claimed",
      cleanupActionId: null,
      reservationId: null,
      terminalGateOutcomeId: "terminal-outcome-old-1",
      terminalGateOutcome: "deferred_without_permit",
      terminalAt: NOW,
      claimToken: "terminal-claim-restarted-1",
      claimLeaseId: restartedRoomWorkerLease.id,
      claimLeaseEpoch: restartedRoomWorkerLease.epoch,
      claimedAt: NOW,
      claimExpiresAt: "2026-07-18T00:01:00.000Z",
      nextAttemptAt: null,
      resolvedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    } as never;
    const claimNextAdmissionTimeoutTerminalOutcome = vi.fn(async () => claimedTerminalProof);
    const resolveAdmissionTimeoutWithoutPermit = vi.fn(async (input: {
      readonly nextAttemptAt: string;
    }) => ({
      status,
      tombstone: {
        ...claimedTerminalProof,
        state: "terminal_without_permit",
        nextAttemptAt: input.nextAttemptAt,
        resolvedAt: NOW,
      },
      outbox: {
        id: "outbox-1",
        roomId: "room-1",
        bindingId: "binding-1",
        state: "pending",
        nextAttemptAt: input.nextAttemptAt,
        lastErrorCode: "provider_gate_terminal_without_permit",
      },
    }));
    const providerBackpressureCleanupActions = {
      enqueue: vi.fn(),
      fencePendingOutbox: vi.fn(),
      claimNext: vi.fn(async () => null),
      markExpired: vi.fn(),
      finalizeExactPreSendOutbox: vi.fn(),
        finalizeTerminalPreClaimOutbox: vi.fn(),
        reconcilePendingAdmissionTimeout: vi.fn(async () => null),
        claimNextAdmissionTimeoutTerminalOutcome,
      resolveAdmissionTimeoutWithoutPermit,
    };
    const assertAuthority = vi.fn(async () => ({
      lease: restartedRoomWorkerLease,
      posture: {
        lifecycleState: "running",
        aggregateVersion: 7,
        humanPaused: false,
        approvalState: "none",
      },
    }));
    recoverySeams.recoverRoomAfterCrash.mockImplementation(async () => {
      abortController.abort();
      return { deliveries: [], checkpointId: null, nativeTakeover: null };
    });
    const worker = new DurableRoomRecoveryWorker({
      projectId: "project-1",
      workerId: "worker-restarted",
      hostId: "host-restarted",
      layer: { projectId: "project-1" } as never,
      roomStore: {} as never,
      leaseStore: { releaseLease: vi.fn() } as never,
      checkpointStore: {} as never,
      registry: new SessionConnectorRegistry(),
      now: () => NOW,
      providerBackpressureCleanupActions,
    });

    await worker.runRoom({
      room: { room: { id: "room-1", projectId: "project-1", aggregateVersion: 7 } } as never,
      lease: restartedRoomWorkerLease,
      signal: abortController.signal,
      assertAuthority,
      assertLeaseAuthority: async () => restartedRoomWorkerLease,
    });

    expect(claimNextAdmissionTimeoutTerminalOutcome).toHaveBeenCalledTimes(1);
    expect(claimNextAdmissionTimeoutTerminalOutcome).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      roomId: "room-1",
      cleanupWorkerLease: restartedRoomWorkerLease,
    }));
    expect(claimNextAdmissionTimeoutTerminalOutcome).not.toHaveBeenCalledWith(expect.objectContaining({
      cleanupWorkerLease: oldCallbackLease,
    }));
    expect(resolveAdmissionTimeoutWithoutPermit).toHaveBeenCalledTimes(1);
    expect(resolveAdmissionTimeoutWithoutPermit).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      roomId: "room-1",
      gateAttemptId: "gate-attempt-old-1",
      requestHash: "a".repeat(64),
      cleanupWorkerLease: restartedRoomWorkerLease,
      claimToken: "terminal-claim-restarted-1",
      nextAttemptAt: "2026-07-18T00:00:01.000Z",
    }));
    expect(resolveAdmissionTimeoutWithoutPermit.mock.invocationCallOrder[0]).toBeLessThan(
      recoverySeams.recoverRoomAfterCrash.mock.invocationCallOrder[0]!,
    );
    expect(recoverySeams.acquireSenderLease).not.toHaveBeenCalled();
      expect(deliveryCoordinatorSeams.dispatch).not.toHaveBeenCalled();
    },
  );

  /*
  FNXC:RoomProviderAdmissionTimeoutLiveSenderYield 2026-07-20-23:58:
  A claimed terminal no-permit proof can still encounter a live sender. Core's
  retry_later result retains the durable claim; this worker must stop instead
  of looping back into ordinary crash dispatch, acquiring a sender lease, or
  manufacturing an earlier retry while the claim remains fenced.
  */
  it("stops rather than re-entering recovery when Core retains a claimed no-permit proof for a live sender", async () => {
    const abortController = new AbortController();
    const roomWorkerLease = lease("room_worker", {
      id: "lease-room-worker-retry-later",
      holderId: "worker-retry-later",
      hostId: "host-retry-later",
      epoch: 5,
    });
    const claimedTerminalProof = {
      id: "provider-admission-timeout:terminal-proof-live-sender",
      projectId: "project-1",
      roomId: "room-1",
      gateAttemptId: "gate-attempt-live-sender",
      requestHash: "b".repeat(64),
      state: "terminal_outcome_claimed",
      cleanupActionId: null,
      reservationId: null,
      terminalGateOutcomeId: "terminal-outcome-live-sender",
      terminalGateOutcome: "deferred_without_permit",
      terminalAt: NOW,
      claimToken: "terminal-claim-live-sender",
      claimLeaseId: roomWorkerLease.id,
      claimLeaseEpoch: roomWorkerLease.epoch,
      claimExpiresAt: "2026-07-18T00:01:00.000Z",
      nextAttemptAt: null,
      resolvedAt: null,
    } as never;
    const claimNextAdmissionTimeoutTerminalOutcome = vi.fn()
      .mockResolvedValueOnce(claimedTerminalProof)
      .mockResolvedValue(null);
    const resolveAdmissionTimeoutWithoutPermit = vi.fn(async () => ({
      status: "retry_later" as const,
      tombstone: claimedTerminalProof,
      outbox: { state: "delivery_uncertain", nextAttemptAt: null },
    }));
    const providerBackpressureCleanupActions = {
      enqueue: vi.fn(),
      fencePendingOutbox: vi.fn(),
      claimNext: vi.fn(async () => null),
      markExpired: vi.fn(),
      finalizeExactPreSendOutbox: vi.fn(),
        finalizeTerminalPreClaimOutbox: vi.fn(),
        reconcilePendingAdmissionTimeout: vi.fn(async () => null),
        claimNextAdmissionTimeoutTerminalOutcome,
      resolveAdmissionTimeoutWithoutPermit,
    };
    const assertAuthority = vi.fn(async () => ({
      lease: roomWorkerLease,
      posture: {
        lifecycleState: "running",
        aggregateVersion: 7,
        humanPaused: false,
        approvalState: "none",
      },
    }));
    recoverySeams.recoverRoomAfterCrash.mockImplementation(async () => {
      abortController.abort();
      return { deliveries: [], checkpointId: null, nativeTakeover: null };
    });
    const worker = new DurableRoomRecoveryWorker({
      projectId: "project-1",
      workerId: "worker-retry-later",
      hostId: "host-retry-later",
      layer: { projectId: "project-1" } as never,
      roomStore: {} as never,
      leaseStore: { releaseLease: vi.fn() } as never,
      checkpointStore: {} as never,
      registry: new SessionConnectorRegistry(),
      now: () => NOW,
      recoveryIntervalMs: 1,
      providerBackpressureCleanupActions,
    });

    await worker.runRoom({
      room: { room: { id: "room-1", projectId: "project-1", aggregateVersion: 7 } } as never,
      lease: roomWorkerLease,
      signal: abortController.signal,
      assertAuthority,
      assertLeaseAuthority: async () => roomWorkerLease,
    });

    expect(claimNextAdmissionTimeoutTerminalOutcome).toHaveBeenCalledTimes(1);
    expect(resolveAdmissionTimeoutWithoutPermit).toHaveBeenCalledTimes(1);
    expect(recoverySeams.recoverRoomAfterCrash).not.toHaveBeenCalled();
    expect(recoverySeams.acquireSenderLease).not.toHaveBeenCalled();
    expect(deliveryCoordinatorSeams.dispatch).not.toHaveBeenCalled();
  });

  it.each(["reservation_bound", "pending"] as const)(
    "never resolves a %s admission-timeout tombstone returned by an invalid claim adapter",
    async (state) => {
      const abortController = new AbortController();
      const roomWorkerLease = lease("room_worker");
      const resolveAdmissionTimeoutWithoutPermit = vi.fn();
      const providerBackpressureCleanupActions = {
        enqueue: vi.fn(),
        fencePendingOutbox: vi.fn(),
        claimNext: vi.fn(async () => null),
        markExpired: vi.fn(),
        finalizeExactPreSendOutbox: vi.fn(),
        finalizeTerminalPreClaimOutbox: vi.fn(),
        reconcilePendingAdmissionTimeout: vi.fn(async () => null),
        claimNextAdmissionTimeoutTerminalOutcome: vi.fn(async () => ({
          projectId: "project-1",
          roomId: "room-1",
          state,
          cleanupActionId: state === "reservation_bound" ? "cleanup-late-permit" : null,
          reservationId: state === "reservation_bound" ? "reservation-late-permit" : null,
        } as never)),
        resolveAdmissionTimeoutWithoutPermit,
      };
      const worker = new DurableRoomRecoveryWorker({
        projectId: "project-1",
        workerId: "worker-1",
        hostId: "host-1",
        layer: { projectId: "project-1" } as never,
        roomStore: {} as never,
        leaseStore: { releaseLease: vi.fn() } as never,
        checkpointStore: {} as never,
        registry: new SessionConnectorRegistry(),
        now: () => NOW,
        providerBackpressureCleanupActions,
      });

      await expect(worker.runRoom({
        room: { room: { id: "room-1", projectId: "project-1", aggregateVersion: 7 } } as never,
        lease: roomWorkerLease,
        signal: abortController.signal,
        assertAuthority: async () => ({
          lease: roomWorkerLease,
          posture: {
            lifecycleState: "running",
            aggregateVersion: 7,
            humanPaused: false,
            approvalState: "none",
          },
        }),
        assertLeaseAuthority: async () => roomWorkerLease,
      })).rejects.toThrow("invalid claimed provider admission-timeout terminal proof");

      expect(resolveAdmissionTimeoutWithoutPermit).not.toHaveBeenCalled();
      expect(recoverySeams.recoverRoomAfterCrash).not.toHaveBeenCalled();
      expect(recoverySeams.acquireSenderLease).not.toHaveBeenCalled();
    },
  );

  /*
  FNXC:RoomProviderAdmissionTimeoutClaimConflict 2026-07-21-00:02:
  Restart workers may overlap after the original callback is gone. Core's
  fenced claim is the sole ownership boundary: only its winner may present the
  claim token to resolve, while a successor that finds no claim must never
  infer terminal proof, acquire sender authority, or dispatch the outbox.
  */
  it("allows only the Core claim winner to resolve a shared recorded no-permit proof", async () => {
    const firstAbortController = new AbortController();
    const secondAbortController = new AbortController();
    const firstLease = lease("room_worker", {
      id: "lease-room-worker-claim-winner",
      holderId: "worker-claim-winner",
      hostId: "host-claim-winner",
      epoch: 6,
    });
    const secondLease = lease("room_worker", {
      id: "lease-room-worker-claim-loser",
      holderId: "worker-claim-loser",
      hostId: "host-claim-loser",
      epoch: 7,
    });
    let claimed = false;
    const claimNextAdmissionTimeoutTerminalOutcome = vi.fn(async (input: {
      readonly cleanupWorkerLease: StoredRoomLeaseV1;
    }) => {
      if (claimed) return null;
      claimed = true;
      return {
        id: "provider-admission-timeout:shared-proof",
        projectId: "project-1",
        roomId: "room-1",
        gateAttemptId: "gate-attempt-shared",
        requestHash: "c".repeat(64),
        state: "terminal_outcome_claimed",
        cleanupActionId: null,
        reservationId: null,
        terminalGateOutcomeId: "terminal-outcome-shared",
        terminalGateOutcome: "deferred_without_permit",
        terminalAt: NOW,
        claimToken: `terminal-claim:${input.cleanupWorkerLease.id}`,
        claimLeaseId: input.cleanupWorkerLease.id,
        claimLeaseEpoch: input.cleanupWorkerLease.epoch,
        claimExpiresAt: "2026-07-18T00:01:00.000Z",
        nextAttemptAt: null,
        resolvedAt: null,
      } as never;
    });
    const resolveAdmissionTimeoutWithoutPermit = vi.fn(async (input: {
      readonly cleanupWorkerLease: StoredRoomLeaseV1;
      readonly claimToken: string;
      readonly nextAttemptAt: string;
    }) => ({
      status: "resolved" as const,
      tombstone: {
        id: "provider-admission-timeout:shared-proof",
        projectId: "project-1",
        roomId: "room-1",
        state: "terminal_without_permit",
        cleanupActionId: null,
        reservationId: null,
        terminalGateOutcomeId: "terminal-outcome-shared",
        terminalGateOutcome: "deferred_without_permit",
        terminalAt: NOW,
        nextAttemptAt: input.nextAttemptAt,
        resolvedAt: NOW,
      },
      outbox: { state: "pending", nextAttemptAt: input.nextAttemptAt },
    }));
    const providerBackpressureCleanupActions = {
      enqueue: vi.fn(),
      fencePendingOutbox: vi.fn(),
      claimNext: vi.fn(async () => null),
      markExpired: vi.fn(),
      finalizeExactPreSendOutbox: vi.fn(),
        finalizeTerminalPreClaimOutbox: vi.fn(),
        reconcilePendingAdmissionTimeout: vi.fn(async () => null),
        claimNextAdmissionTimeoutTerminalOutcome,
      resolveAdmissionTimeoutWithoutPermit,
    };
    recoverySeams.recoverRoomAfterCrash.mockImplementation(async (input) => {
      if (input.roomWorkerLease.id === firstLease.id) firstAbortController.abort();
      if (input.roomWorkerLease.id === secondLease.id) secondAbortController.abort();
      return { deliveries: [], checkpointId: null, nativeTakeover: null };
    });
    const runRestartWorker = async (
      roomWorkerLease: StoredRoomLeaseV1,
      abortController: AbortController,
    ): Promise<void> => {
      const worker = new DurableRoomRecoveryWorker({
        projectId: "project-1",
        workerId: roomWorkerLease.holderId,
        hostId: roomWorkerLease.hostId,
        layer: { projectId: "project-1" } as never,
        roomStore: {} as never,
        leaseStore: { releaseLease: vi.fn() } as never,
        checkpointStore: {} as never,
        registry: new SessionConnectorRegistry(),
        now: () => NOW,
        providerBackpressureCleanupActions,
      });
      await worker.runRoom({
        room: { room: { id: "room-1", projectId: "project-1", aggregateVersion: 7 } } as never,
        lease: roomWorkerLease,
        signal: abortController.signal,
        assertAuthority: async () => ({
          lease: roomWorkerLease,
          posture: {
            lifecycleState: "running",
            aggregateVersion: 7,
            humanPaused: false,
            approvalState: "none",
          },
        }),
        assertLeaseAuthority: async () => roomWorkerLease,
      });
    };

    await runRestartWorker(firstLease, firstAbortController);
    await runRestartWorker(secondLease, secondAbortController);

    expect(claimNextAdmissionTimeoutTerminalOutcome).toHaveBeenCalledTimes(2);
    expect(resolveAdmissionTimeoutWithoutPermit).toHaveBeenCalledTimes(1);
    expect(resolveAdmissionTimeoutWithoutPermit).toHaveBeenCalledWith(expect.objectContaining({
      cleanupWorkerLease: firstLease,
      claimToken: `terminal-claim:${firstLease.id}`,
    }));
    expect(recoverySeams.acquireSenderLease).not.toHaveBeenCalled();
    expect(deliveryCoordinatorSeams.dispatch).not.toHaveBeenCalled();
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

  it("forwards the same verified provider gate and atomic pre-claim fence through every durable recovery cycle", async () => {
    const abortController = new AbortController();
    const roomWorkerLease = lease("room_worker");
    const providerBackpressureSendGate = { admit: vi.fn() } as never;
    const providerBackpressureCleanupActions = {
      enqueue: vi.fn(async () => ({ status: "created" as const, action: {} })),
      fencePendingOutbox: vi.fn(async () => ({ status: "created" as const, action: {} })),
      claimNext: vi.fn(async () => null),
      markExpired: vi.fn(),
      finalizeExactPreSendOutbox: vi.fn(),
      finalizeTerminalPreClaimOutbox: vi.fn(),
      reconcilePendingAdmissionTimeout: vi.fn(async () => null),
      claimNextAdmissionTimeoutTerminalOutcome: vi.fn(async () => null),
      resolveAdmissionTimeoutWithoutPermit: vi.fn(),
    };
    const assertAuthority = vi.fn(async () => ({
      lease: roomWorkerLease,
      posture: {
        lifecycleState: "running",
        aggregateVersion: 7,
        humanPaused: false,
        approvalState: "none",
      },
    }));
    let recoveryCycles = 0;
    deliveryCoordinatorSeams.dispatch.mockResolvedValue({} as never);
    recoverySeams.recoverRoomAfterCrash.mockImplementation(async (input) => {
      recoveryCycles += 1;
      await input.deliveryCoordinator.dispatch({} as never);
      if (recoveryCycles === 2) abortController.abort();
      return { deliveries: [], checkpointId: null, nativeTakeover: null };
    });

    const worker = new DurableRoomRecoveryWorker({
      projectId: "project-1",
      workerId: "worker-1",
      hostId: "host-1",
      layer: { projectId: "project-1" } as never,
      roomStore: {
        recoverNoProgressTaskDispatches: vi.fn(async () => ({ blocked: [], skipped: [] })),
      } as never,
      leaseStore: { releaseLease: vi.fn() } as never,
      checkpointStore: {} as never,
      registry: new SessionConnectorRegistry(),
      now: () => NOW,
      providerBackpressureSendGate,
      providerBackpressureCleanupActions,
    });

    await worker.runRoom({
      room: { room: { id: "room-1", projectId: "project-1", aggregateVersion: 7 } } as never,
      lease: roomWorkerLease,
      signal: abortController.signal,
      assertAuthority,
      assertLeaseAuthority: async () => roomWorkerLease,
    });

    expect(recoveryCycles).toBe(2);
    expect(deliveryCoordinatorSeams.dispatch).toHaveBeenCalledTimes(2);
    expect(deliveryCoordinatorSeams.dispatch.mock.calls.map(([input]) => (
      (input as { readonly providerBackpressure?: unknown }).providerBackpressure
    ))).toEqual([providerBackpressureSendGate, providerBackpressureSendGate]);
    expect(deliveryCoordinatorSeams.dispatch.mock.calls.map(([input]) => (
      (input as { readonly providerBackpressureCleanupActions?: unknown }).providerBackpressureCleanupActions
    ))).toEqual([providerBackpressureCleanupActions, providerBackpressureCleanupActions]);
    expect(deliveryCoordinatorSeams.dispatch.mock.calls.map(([input]) => (
      (input as { readonly providerBackpressureCleanupContext?: unknown }).providerBackpressureCleanupContext
    ))).toEqual([{ projectId: "project-1" }, { projectId: "project-1" }]);
    /*
    FNXC:RoomProviderPreClaimRecovery 2026-07-20-22:31:
    Restart recovery must retain the exact Core fencer, not a lookalike cleanup
    adapter, so a post-crash pre-claim timeout cannot bypass the same atomic
    pending-to-uncertain boundary enforced during the original dispatch.
    */
    expect(deliveryCoordinatorSeams.dispatch.mock.calls.map(([input]) => (
      (input as { readonly providerBackpressureCleanupActions?: { readonly fencePendingOutbox?: unknown } })
        .providerBackpressureCleanupActions?.fencePendingOutbox
    ))).toEqual([
      providerBackpressureCleanupActions.fencePendingOutbox,
      providerBackpressureCleanupActions.fencePendingOutbox,
    ]);
    expect(providerBackpressureCleanupActions.claimNext).toHaveBeenCalledTimes(2);
  });

  it("processes durable provider cleanup before a recovery pass can wait on connector history", async () => {
    const abortController = new AbortController();
    const roomWorkerLease = lease("room_worker");
    let resolveRecoveryEntered!: () => void;
    const recoveryEntered = new Promise<void>((resolve) => {
      resolveRecoveryEntered = resolve;
    });
    let releaseRecovery!: () => void;
    const recoveryRelease = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    const providerBackpressureCleanupActions = {
      enqueue: vi.fn(async () => ({ status: "created" as const, action: {} })),
      fencePendingOutbox: vi.fn(async () => ({ status: "created" as const, action: {} })),
      claimNext: vi.fn(async () => null),
      markExpired: vi.fn(),
      finalizeExactPreSendOutbox: vi.fn(),
      finalizeTerminalPreClaimOutbox: vi.fn(),
      reconcilePendingAdmissionTimeout: vi.fn(async () => null),
      claimNextAdmissionTimeoutTerminalOutcome: vi.fn(async () => null),
      resolveAdmissionTimeoutWithoutPermit: vi.fn(),
    };
    recoverySeams.recoverRoomAfterCrash.mockImplementation(async () => {
      resolveRecoveryEntered();
      await recoveryRelease;
      return { deliveries: [], checkpointId: null, nativeTakeover: null };
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
    const worker = new DurableRoomRecoveryWorker({
      projectId: "project-1",
      workerId: "worker-1",
      hostId: "host-1",
      layer: { projectId: "project-1" } as never,
      roomStore: {} as never,
      leaseStore: { releaseLease: vi.fn() } as never,
      checkpointStore: {} as never,
      registry: new SessionConnectorRegistry(),
      now: () => NOW,
      providerBackpressureCleanupActions,
    });

    const running = worker.runRoom({
      room: {
        room: { id: "room-1", projectId: "project-1", aggregateVersion: 7 },
      },
      lease: roomWorkerLease,
      signal: abortController.signal,
      assertAuthority,
    });

    await recoveryEntered;
    expect(providerBackpressureCleanupActions.claimNext).toHaveBeenCalledTimes(1);
    expect(providerBackpressureCleanupActions.claimNext.mock.invocationCallOrder[0]).toBeLessThan(
      recoverySeams.recoverRoomAfterCrash.mock.invocationCallOrder[0]!,
    );

    abortController.abort();
    releaseRecovery();
    await running;
  });

  it("runs bounded task-dispatch recovery behind a freshly asserted Room-worker fence", async () => {
    const abortController = new AbortController();
    const roomWorkerLease = lease("room_worker");
    const assertAuthority = vi.fn(async () => ({
      lease: roomWorkerLease,
      posture: {
        lifecycleState: "running",
        aggregateVersion: 7,
        humanPaused: false,
        approvalState: "none",
      },
    }));
    const recoverNoProgressTaskDispatches = vi.fn(async () => {
      abortController.abort();
      return { blocked: [], skipped: [] };
    });
    recoverySeams.recoverRoomAfterCrash.mockResolvedValue({
      deliveries: [],
      checkpointId: null,
      nativeTakeover: null,
    });

    const worker = new DurableRoomRecoveryWorker({
      projectId: "project-1",
      workerId: "worker-1",
      hostId: "host-1",
      layer: { projectId: "project-1" } as never,
      roomStore: { recoverNoProgressTaskDispatches } as never,
      leaseStore: { releaseLease: vi.fn() } as never,
      checkpointStore: {} as never,
      registry: new SessionConnectorRegistry(),
      now: () => NOW,
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

    expect(assertAuthority).toHaveBeenCalledTimes(3);
    expect(recoverNoProgressTaskDispatches).toHaveBeenCalledWith({
      roomId: "room-1",
      roomWorkerFence: {
        leaseId: roomWorkerLease.id,
        holderId: roomWorkerLease.holderId,
        hostId: roomWorkerLease.hostId,
        expectedEpoch: roomWorkerLease.epoch,
      },
      now: NOW,
    });
  });

  it("drains a due no-progress action through the same Room worker only when a durable handoff consumer is configured", async () => {
    const abortController = new AbortController();
    const roomWorkerLease = lease("room_worker");
    const assertAuthority = vi.fn(async () => ({
      lease: roomWorkerLease,
      posture: {
        lifecycleState: "running",
        aggregateVersion: 7,
        humanPaused: false,
        approvalState: "none",
      },
    }));
    const action = {
      id: "recovery-action-1",
      roomId: "room-1",
      nodeId: "node-1",
      nodeVersion: 2,
      observationId: "observation-1",
      actionId: "replan",
      actionSnapshot: { executionMode: "controller_plan" },
      state: "claimed",
      attemptCount: 1,
      claimToken: "claim-token-1",
      claimExpiresAt: "2026-07-18T00:01:00.000Z",
      claimedByWorkerId: "worker-1",
      claimedAt: NOW,
    } as never;
    const claimNextRoomTaskRecoveryAction = vi.fn(async () => action);
    const completeRoomTaskRecoveryAction = vi.fn(async (input: { readonly actionId: string }) => {
      expect(input.actionId).toBe("recovery-action-1");
      abortController.abort();
      return { ...action, state: "processed" } as never;
    });
    const consumeAction = vi.fn(async () => {
      const receiptRef = "controller-plan:recovery-action-1";
      return {
        contractVersion: "room-task-recovery-action-result/v1" as const,
        kind: "controller_plan_submitted" as const,
        receiptRef,
        resultHash: hashRoomValue({
          contractVersion: "room-task-recovery-action-result/v1",
          kind: "controller_plan_submitted",
          receiptRef,
        }),
      };
    });
    recoverySeams.recoverRoomAfterCrash.mockResolvedValue({
      deliveries: [],
      checkpointId: null,
      nativeTakeover: null,
    });

    const worker = new DurableRoomRecoveryWorker({
      projectId: "project-1",
      workerId: "worker-1",
      hostId: "host-1",
      layer: { projectId: "project-1" } as never,
      roomStore: {
        recoverNoProgressTaskDispatches: vi.fn(async () => ({ blockedNodeIds: [], skippedOutboxIds: [] })),
        claimNextRoomTaskRecoveryAction,
        completeRoomTaskRecoveryAction,
      } as never,
      leaseStore: { releaseLease: vi.fn() } as never,
      checkpointStore: {} as never,
      registry: new SessionConnectorRegistry(),
      now: () => NOW,
      taskRecoveryActionConsumer: consumeAction,
    });

    await worker.runRoom({
      room: { room: { id: "room-1", projectId: "project-1", aggregateVersion: 7 } } as never,
      lease: roomWorkerLease,
      signal: abortController.signal,
      assertAuthority,
      assertLeaseAuthority: async () => roomWorkerLease,
    });

    expect(consumeAction).toHaveBeenCalledWith(action, expect.objectContaining({
      roomId: "room-1",
      workerId: "worker-1",
      hostId: "host-1",
      now: NOW,
      roomWorkerFence: {
        leaseId: roomWorkerLease.id,
        holderId: roomWorkerLease.holderId,
        hostId: roomWorkerLease.hostId,
        expectedEpoch: roomWorkerLease.epoch,
      },
    }));
    expect(claimNextRoomTaskRecoveryAction).toHaveBeenCalledTimes(1);
    expect(completeRoomTaskRecoveryAction).toHaveBeenCalledWith(expect.objectContaining({
      roomId: "room-1",
      actionId: "recovery-action-1",
      outcome: "processed",
      idempotencyKey: "room-task-recovery-complete:room-1:recovery-action-1:claim-token-1",
    }));
  });

  it("uses the built-in fenced recovery-plan consumer when the real Room store exposes it", async () => {
    const abortController = new AbortController();
    const roomWorkerLease = lease("room_worker");
    const assertAuthority = vi.fn(async () => ({
      lease: roomWorkerLease,
      posture: {
        lifecycleState: "running",
        aggregateVersion: 7,
        humanPaused: false,
        approvalState: "none",
      },
    }));
    const recoveryAction = {
      id: "replan-stalled-node",
      trigger: "no_progress",
      action: "replan",
      maxAttempts: 1,
      phaseIds: ["plan"],
      exhaustedGateId: "implementation_blocked",
    } as const;
    const actionSnapshot = {
      contractVersion: "room-task-no-progress-recovery-action/v1" as const,
      protocolId: "implementation",
      protocolVersion: 1,
      turnId: "turn-1",
      phaseId: "plan",
      nodeId: "node-1",
      nodeVersion: 2,
      observationId: "observation-1",
      recoveryAction,
      recoveryActionHash: hashRoomValue(recoveryAction),
      ladderOrder: 1,
      minimumConsecutiveUnchangedRounds: 2,
      executionMode: "controller_plan" as const,
    };
    const action = {
      id: "recovery-action-default-1",
      roomId: "room-1",
      nodeId: "node-1",
      nodeVersion: 2,
      observationId: "observation-1",
      actionId: recoveryAction.id,
      actionSnapshot,
      policySnapshot: {
        protocolId: "implementation",
        protocolVersion: 1,
        actions: [{ recoveryActionId: recoveryAction.id, ladderOrder: 1, minimumConsecutiveUnchangedRounds: 2 }],
      },
      state: "claimed" as const,
      attemptCount: 1,
      claimToken: "claim-token-default-1",
      claimExpiresAt: "2026-07-18T00:01:00.000Z",
      claimedByWorkerId: "worker-1",
      claimedAt: NOW,
      nextEligibleAt: NOW,
      resultPayload: null,
      lastErrorCode: null,
      operatorApprovalId: null,
      createdAt: NOW,
      updatedAt: NOW,
      processedAt: null,
    };
    const planId = `room-task-recovery-plan:${action.id}`;
    const resultReceipt = {
      contractVersion: "room-task-recovery-action-result/v1" as const,
      kind: "controller_plan_submitted" as const,
      receiptRef: planId,
      resultHash: hashRoomValue({
        contractVersion: "room-task-recovery-action-result/v1",
        kind: "controller_plan_submitted",
        receiptRef: planId,
      }),
    };
    const recordRoomTaskRecoveryPlan = vi.fn(async () => ({
      contractVersion: "room-task-recovery-plan/v1" as const,
      id: planId,
      roomId: "room-1",
      recoveryActionId: action.id,
      executionMode: "controller_plan" as const,
      actionSnapshot,
      actionSnapshotHash: hashRoomValue(actionSnapshot),
      resultReceipt,
      createdAt: NOW,
    }));
    const completeRoomTaskRecoveryAction = vi.fn(async () => {
      abortController.abort();
      return { ...action, state: "processed" } as never;
    });
    recoverySeams.recoverRoomAfterCrash.mockResolvedValue({
      deliveries: [],
      checkpointId: null,
      nativeTakeover: null,
    });

    const worker = new DurableRoomRecoveryWorker({
      projectId: "project-1",
      workerId: "worker-1",
      hostId: "host-1",
      layer: { projectId: "project-1" } as never,
      roomStore: {
        recoverNoProgressTaskDispatches: vi.fn(async () => ({ blockedNodeIds: [], skippedOutboxIds: [] })),
        claimNextRoomTaskRecoveryAction: vi.fn(async () => action),
        recordRoomTaskRecoveryPlan,
        completeRoomTaskRecoveryAction,
      } as never,
      leaseStore: { releaseLease: vi.fn() } as never,
      checkpointStore: {} as never,
      registry: new SessionConnectorRegistry(),
      now: () => NOW,
    });

    await worker.runRoom({
      room: { room: { id: "room-1", projectId: "project-1", aggregateVersion: 7 } } as never,
      lease: roomWorkerLease,
      signal: abortController.signal,
      assertAuthority,
      assertLeaseAuthority: async () => roomWorkerLease,
    });

    expect(recordRoomTaskRecoveryPlan).toHaveBeenCalledWith(expect.objectContaining({
      roomId: "room-1",
      recoveryActionId: action.id,
      claimToken: action.claimToken,
      idempotencyKey: `room-task-recovery-plan:room-1:${action.id}`,
    }));
    expect(completeRoomTaskRecoveryAction).toHaveBeenCalledWith(expect.objectContaining({
      actionId: action.id,
      outcome: "processed",
      resultPayload: resultReceipt,
    }));
  });
});

import { describe, expect, it, vi } from "vitest";
import type {
  RoomProviderBackpressureCleanupActionV1,
  RoomProviderBackpressureCleanupActions,
  StoredRoomLeaseV1,
} from "@fusion/core";

import { RoomProviderBackpressureCleanupActionProcessor } from "../room-provider-backpressure-cleanup-action-processor.js";

const PROJECT_ID = "project-provider-cleanup";
const ROOM_ID = "room-provider-cleanup";
const WORKER_ID = "room-worker-1";
const HOST_ID = "host-controller";
const NOW = "2026-07-20T00:00:00.000Z";

type CleanupActions = Pick<
  RoomProviderBackpressureCleanupActions,
  "claimNext" | "markExpired" | "finalizeExactPreSendOutbox" | "finalizeTerminalPreClaimOutbox"
>;
type ClaimInput = Parameters<CleanupActions["claimNext"]>[0];
type MarkInput = Parameters<CleanupActions["markExpired"]>[0];
type MarkResult = Awaited<ReturnType<CleanupActions["markExpired"]>>;

function workerLease(overrides: Partial<StoredRoomLeaseV1> = {}): StoredRoomLeaseV1 {
  return {
    contractVersion: 1,
    id: "room-worker-lease-1",
    roomId: ROOM_ID,
    kind: "room_worker",
    resourceId: ROOM_ID,
    holderId: WORKER_ID,
    hostId: HOST_ID,
    epoch: 7,
    acquiredAt: NOW,
    renewedAt: NOW,
    heartbeatAt: NOW,
    expiresAt: "2026-07-20T00:01:00.000Z",
    releasedAt: null,
    ...overrides,
  };
}

function claimedAction(
  id: string,
  lease: StoredRoomLeaseV1 = workerLease(),
): RoomProviderBackpressureCleanupActionV1 {
  return {
    contractVersion: 1,
    id,
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    idempotencyKey: `cleanup:${id}`,
    outboxId: null,
    outboxBindingId: null,
    outboxAttemptId: null,
    outboxAttemptCount: null,
    reservationId: `reservation:${id}`,
    requestId: `request:${id}`,
    claimId: `claim:${id}`,
    originalWorkerFence: {
      leaseId: "original-room-worker-lease",
      holderId: "original-room-worker",
      hostId: HOST_ID,
      epoch: 3,
    },
    expectedAggregateVersion: 12,
    reservationExpiresAt: "2026-07-20T00:05:00.000Z",
    completionKind: "pre_send_not_started",
    state: "claimed",
    attemptCount: 1,
    claimToken: `cleanup-claim:${id}`,
    claimLeaseId: lease.id,
    claimLeaseEpoch: lease.epoch,
    claimedAt: NOW,
    claimExpiresAt: "2026-07-20T00:02:00.000Z",
    lastErrorCode: null,
    completedAt: null,
    outboxUnblockedAt: null,
    outboxFinalizedAt: null,
    outboxFinalizationOutcome: null,
    outboxFinalizationReason: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function expiredAction(
  action: RoomProviderBackpressureCleanupActionV1,
  now: string,
): RoomProviderBackpressureCleanupActionV1 {
  return {
    ...action,
    state: "expired",
    claimToken: null,
    claimLeaseId: null,
    claimLeaseEpoch: null,
    claimedAt: null,
    claimExpiresAt: null,
    lastErrorCode: "reservation_expired_unreleased",
    completedAt: now,
    updatedAt: now,
  };
}

function releasedAction(
  action: RoomProviderBackpressureCleanupActionV1,
  now: string,
): RoomProviderBackpressureCleanupActionV1 {
  return {
    ...action,
    state: "released",
    claimToken: null,
    claimLeaseId: null,
    claimLeaseEpoch: null,
    claimedAt: null,
    claimExpiresAt: null,
    lastErrorCode: null,
    completedAt: now,
    updatedAt: now,
  };
}

function createCleanupActions(
  claimed: readonly RoomProviderBackpressureCleanupActionV1[],
  mark: (input: MarkInput, action: RoomProviderBackpressureCleanupActionV1) => Promise<MarkResult> | MarkResult = (
    input,
    action,
  ) => ({ status: "expired", action: expiredAction(action, input.now) }),
): {
  readonly cleanupActions: CleanupActions;
  readonly claims: ClaimInput[];
  readonly marks: MarkInput[];
} {
  const pending = [...claimed];
  const claims: ClaimInput[] = [];
  const marks: MarkInput[] = [];
  return {
    cleanupActions: {
      claimNext: async (input) => {
        claims.push(input);
        return pending.shift() ?? null;
      },
      markExpired: async (input) => {
        marks.push(input);
        const action = claimed.find((candidate) => candidate.id === input.actionId);
        if (!action) throw new Error(`Unknown cleanup action ${input.actionId}`);
        return mark(input, action);
      },
      finalizeExactPreSendOutbox: async () => ({ status: "not_applicable", action: claimed[0]! }),
      finalizeTerminalPreClaimOutbox: async () => ({ status: "not_applicable", action: claimed[0]! }),
    },
    claims,
    marks,
  };
}

function processor(cleanupActions: CleanupActions, options: {
  readonly maxActions?: number;
  readonly claimTtlMs?: number;
} = {}): RoomProviderBackpressureCleanupActionProcessor {
  return new RoomProviderBackpressureCleanupActionProcessor({
    projectId: PROJECT_ID,
    workerId: WORKER_ID,
    hostId: HOST_ID,
    cleanupActions,
    now: () => NOW,
    ...options,
  });
}

function codedError(code: string): Error & { readonly code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

function abortError(): Error {
  const error = new Error("controller cancelled");
  error.name = "AbortError";
  return error;
}

describe("RoomProviderBackpressureCleanupActionProcessor", () => {
  it("is bounded and records only Core-confirmed expiries", async () => {
    const lease = workerLease();
    const { cleanupActions, claims, marks } = createCleanupActions([
      claimedAction("cleanup-a", lease),
      claimedAction("cleanup-b", lease),
      claimedAction("cleanup-c", lease),
    ]);

    const summary = await processor(cleanupActions, { maxActions: 2, claimTtlMs: 45_000 }).process({
      roomId: ROOM_ID,
      lease,
      renewLease: async (current) => current,
      observeLease: async (current) => current,
    });

    expect(summary).toMatchObject({
      roomId: ROOM_ID,
      lease,
      claimedActionCount: 2,
      expiredActionCount: 2,
      notDueActionCount: 0,
      reachedMaxActions: true,
      stopped: false,
      stopReason: null,
    });
    expect(claims).toEqual([
      expect.objectContaining({
        projectId: PROJECT_ID,
        roomId: ROOM_ID,
        cleanupWorkerLease: lease,
        now: NOW,
        claimTtlMs: 45_000,
      }),
      expect.objectContaining({
        projectId: PROJECT_ID,
        roomId: ROOM_ID,
        cleanupWorkerLease: lease,
        now: NOW,
        claimTtlMs: 45_000,
      }),
    ]);
    expect(marks).toEqual([
      expect.objectContaining({
        projectId: PROJECT_ID,
        roomId: ROOM_ID,
        cleanupWorkerLease: lease,
        actionId: "cleanup-a",
        claimToken: "cleanup-claim:cleanup-a",
        now: NOW,
      }),
      expect.objectContaining({
        projectId: PROJECT_ID,
        roomId: ROOM_ID,
        cleanupWorkerLease: lease,
        actionId: "cleanup-b",
        claimToken: "cleanup-claim:cleanup-b",
        now: NOW,
      }),
    ]);
  });

  it("leaves a not-due claim untouched and ends the pass", async () => {
    const lease = workerLease();
    const { cleanupActions, claims, marks } = createCleanupActions(
      [claimedAction("cleanup-not-due", lease), claimedAction("cleanup-later", lease)],
      async (_input, action) => ({ status: "not_due", action }),
    );

    const summary = await processor(cleanupActions).process({
      roomId: ROOM_ID,
      lease,
      renewLease: async (current) => current,
    });

    expect(summary).toMatchObject({
      claimedActionCount: 1,
      expiredActionCount: 0,
      notDueActionCount: 1,
      reachedMaxActions: false,
      stopped: false,
      stopReason: null,
    });
    expect(claims).toHaveLength(1);
    expect(marks).toEqual([
      expect.objectContaining({
        actionId: "cleanup-not-due",
        claimToken: "cleanup-claim:cleanup-not-due",
      }),
    ]);
  });

  it("records a Core-confirmed late release without fabricating an expiry", async () => {
    const lease = workerLease();
    const { cleanupActions, marks } = createCleanupActions(
      [claimedAction("cleanup-released", lease)],
      async (input, action) => ({ status: "released", action: releasedAction(action, input.now) }),
    );

    const summary = await processor(cleanupActions).process({
      roomId: ROOM_ID,
      lease,
      renewLease: async (current) => current,
    });

    expect(summary).toMatchObject({
      claimedActionCount: 1,
      expiredActionCount: 0,
      releasedActionCount: 1,
      notDueActionCount: 0,
      stopped: false,
      stopReason: null,
    });
    expect(marks).toHaveLength(1);
  });

  for (const code of ["stale_lease_fence", "room_worker_authority_revoked"] as const) {
    it(`stops without another mutation when Core rejects the current fence (${code})`, async () => {
      const lease = workerLease();
      const { cleanupActions, claims, marks } = createCleanupActions([claimedAction("cleanup-fenced", lease)]);
      cleanupActions.markExpired = async (input) => {
        marks.push(input);
        throw codedError(code);
      };

      const summary = await processor(cleanupActions).process({
        roomId: ROOM_ID,
        lease,
        renewLease: async (current) => current,
      });

      expect(summary).toMatchObject({
        claimedActionCount: 1,
        expiredActionCount: 0,
        notDueActionCount: 0,
        reachedMaxActions: false,
        stopped: true,
        stopReason: "fence_revoked",
      });
      expect(claims).toHaveLength(1);
      expect(marks).toHaveLength(1);
    });
  }

  it("stops cleanly when the controller is cancelled during a claim", async () => {
    const claims: ClaimInput[] = [];
    const cleanupActions: CleanupActions = {
      claimNext: async (input) => {
        claims.push(input);
        throw abortError();
      },
      markExpired: async () => {
        throw new Error("markExpired must not run after cancellation");
      },
      finalizeExactPreSendOutbox: vi.fn(),
      finalizeTerminalPreClaimOutbox: vi.fn(),
    };

    const summary = await processor(cleanupActions).process({
      roomId: ROOM_ID,
      lease: workerLease(),
      renewLease: async (current) => current,
    });

    expect(summary).toMatchObject({
      claimedActionCount: 0,
      expiredActionCount: 0,
      notDueActionCount: 0,
      stopped: true,
      stopReason: "controller_stopped",
    });
    expect(claims).toHaveLength(1);
  });

  it("rejects an invalid current room-worker lease before it can claim", async () => {
    const { cleanupActions, claims } = createCleanupActions([]);

    await expect(processor(cleanupActions).process({
      roomId: ROOM_ID,
      lease: workerLease({ holderId: "another-worker" }),
      renewLease: async (current) => current,
    })).rejects.toMatchObject({
      code: "room_provider_backpressure_cleanup_action_invalid_worker_lease",
    });

    expect(claims).toHaveLength(0);
  });

  it("finalizes only a terminal exact pre-send action with a fresh sender fence", async () => {
    const terminal = {
      ...releasedAction(claimedAction("cleanup-exact"), NOW),
      outboxId: "outbox-exact",
      outboxBindingId: "binding-exact",
      outboxAttemptId: "attempt-exact",
      outboxAttemptCount: 3,
    };
    const finalizeExactPreSendOutbox = vi.fn(async () => ({
      status: "unblocked" as const,
      action: {
        ...terminal,
        outboxUnblockedAt: NOW,
        outboxFinalizedAt: NOW,
        outboxFinalizationOutcome: "unblocked" as const,
        outboxFinalizationReason: null,
      },
    }));
    const cleanupActions: CleanupActions = {
      claimNext: vi.fn(async () => terminal),
      markExpired: vi.fn(),
      finalizeExactPreSendOutbox,
      finalizeTerminalPreClaimOutbox: vi.fn(),
    };
    const senderLease = workerLease({ id: "sender-exact", kind: "sender", resourceId: "binding-exact" });

    const summary = await processor(cleanupActions, { maxActions: 1 }).process({
      roomId: ROOM_ID,
      lease: workerLease(),
      renewLease: async (current) => current,
      resolveSenderLease: async () => senderLease,
    });

    expect(summary).toMatchObject({ unblockedOutboxCount: 1, withheldOutboxFinalizationCount: 0 });
    expect(finalizeExactPreSendOutbox).toHaveBeenCalledWith(expect.objectContaining({
      actionId: "cleanup-exact", senderLease, roomId: ROOM_ID,
    }));
  });

  it("uses Core's direct pre-claim finalizer without acquiring a sender lease", async () => {
    const terminal = {
      ...releasedAction(claimedAction("cleanup-pre-claim"), NOW),
      completionKind: "pre_claim_not_started" as const,
      outboxId: "outbox-pre-claim",
      outboxBindingId: "binding-pre-claim",
      outboxAttemptId: null,
      outboxAttemptCount: 0,
    };
    const finalizeExactPreSendOutbox = vi.fn();
    const finalizeTerminalPreClaimOutbox = vi.fn(async () => ({
      status: "retry_later" as const,
      action: terminal,
    }));
    const cleanupActions: CleanupActions = {
      claimNext: vi.fn(async () => terminal),
      markExpired: vi.fn(),
      finalizeExactPreSendOutbox,
      finalizeTerminalPreClaimOutbox,
    };
    const resolveSenderLease = vi.fn(async () => workerLease({
      id: "sender-pre-claim", kind: "sender", resourceId: "binding-pre-claim",
    }));

    const summary = await processor(cleanupActions, { maxActions: 1 }).process({
      roomId: ROOM_ID,
      lease: workerLease(),
      renewLease: async (current) => current,
      resolveSenderLease,
    });

    expect(summary).toMatchObject({
      unblockedOutboxCount: 0,
      withheldOutboxFinalizationCount: 0,
      deferredOutboxRetryCount: 1,
    });
    /*
    FNXC:RoomProviderPreClaimTerminalRecovery 2026-07-20-22:38:
    Core's retry_later result represents a live sender or equivalent durable
    gate. Engine must leave the gated future retry to Core and cannot obtain a
    sender fence, issue a provider send, or start a second admission here.
    */
    expect(finalizeTerminalPreClaimOutbox).toHaveBeenCalledWith(expect.objectContaining({
      actionId: "cleanup-pre-claim",
      cleanupWorkerLease: workerLease(),
      roomId: ROOM_ID,
      now: NOW,
      nextAttemptAt: "2026-07-20T00:00:01.000Z",
    }));
    expect(resolveSenderLease).not.toHaveBeenCalled();
    expect(finalizeExactPreSendOutbox).not.toHaveBeenCalled();
  });

  it("continues after Core durably withholds an obsolete terminal outbox generation", async () => {
    const first = {
      ...releasedAction(claimedAction("cleanup-stale"), NOW),
      outboxId: "outbox-stale",
      outboxBindingId: "binding-stale",
      outboxAttemptId: "attempt-stale",
      outboxAttemptCount: 3,
    };
    const second = {
      ...releasedAction(claimedAction("cleanup-late-after-stale"), NOW),
      completionKind: "late_admission_not_started" as const,
    };
    const pending = [first, second];
    const finalizeExactPreSendOutbox = vi.fn(async () => ({
      status: "withheld" as const,
      action: {
        ...first,
        outboxFinalizedAt: NOW,
        outboxFinalizationOutcome: "withheld" as const,
        outboxFinalizationReason: "outbox_generation_not_reopenable",
      },
    }));
    const cleanupActions: CleanupActions = {
      claimNext: vi.fn(async () => pending.shift() ?? null),
      markExpired: vi.fn(),
      finalizeExactPreSendOutbox,
      finalizeTerminalPreClaimOutbox: vi.fn(),
    };
    const senderLease = workerLease({ id: "sender-stale", kind: "sender", resourceId: "binding-stale" });

    const summary = await processor(cleanupActions, { maxActions: 3 }).process({
      roomId: ROOM_ID,
      lease: workerLease(),
      renewLease: async (current) => current,
      resolveSenderLease: async (bindingId) => bindingId === "binding-stale" ? senderLease : null,
    });

    expect(summary).toMatchObject({
      claimedActionCount: 2,
      unblockedOutboxCount: 0,
      withheldOutboxFinalizationCount: 1,
      stopped: false,
    });
    expect(finalizeExactPreSendOutbox).toHaveBeenCalledTimes(1);
  });

  it("withholds a terminal pre-send action when no current sender fence exists", async () => {
    const terminal = {
      ...releasedAction(claimedAction("cleanup-no-sender"), NOW),
      outboxId: "outbox-no-sender", outboxBindingId: "binding-no-sender", outboxAttemptId: "attempt-no-sender", outboxAttemptCount: 1,
    };
    const finalizeExactPreSendOutbox = vi.fn();
    const cleanupActions: CleanupActions = {
      claimNext: vi.fn(async () => terminal),
      markExpired: vi.fn(),
      finalizeExactPreSendOutbox,
      finalizeTerminalPreClaimOutbox: vi.fn(),
    };
    const summary = await processor(cleanupActions, { maxActions: 1 }).process({
      roomId: ROOM_ID, lease: workerLease(), renewLease: async (current) => current, resolveSenderLease: async () => null,
    });
    expect(summary).toMatchObject({ unblockedOutboxCount: 0, withheldOutboxFinalizationCount: 1 });
    expect(finalizeExactPreSendOutbox).not.toHaveBeenCalled();
  });

  it("never finalizes a late-admission action into any outbox", async () => {
    const late = { ...releasedAction(claimedAction("cleanup-late"), NOW), completionKind: "late_admission_not_started" as const };
    const finalizeExactPreSendOutbox = vi.fn();
    const cleanupActions: CleanupActions = {
      claimNext: vi.fn(async () => late),
      markExpired: vi.fn(),
      finalizeExactPreSendOutbox,
      finalizeTerminalPreClaimOutbox: vi.fn(),
    };
    const summary = await processor(cleanupActions, { maxActions: 1 }).process({
      roomId: ROOM_ID, lease: workerLease(), renewLease: async (current) => current, resolveSenderLease: async () => null,
    });
    expect(summary).toMatchObject({ unblockedOutboxCount: 0, withheldOutboxFinalizationCount: 0 });
    expect(finalizeExactPreSendOutbox).not.toHaveBeenCalled();
  });
});

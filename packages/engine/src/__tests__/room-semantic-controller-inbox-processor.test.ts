import { describe, expect, it, vi } from "vitest";
import type {
  ClaimRoomSemanticControllerActionInputV1,
  CompleteRoomSemanticControllerActionInputV1,
  RoomSemanticControllerActionV1,
  StoredRoomLeaseV1,
} from "@fusion/core";

import {
  RoomSemanticControllerInboxProcessor,
  type RoomSemanticControllerInboxStore,
} from "../room-semantic-controller-inbox-processor.js";

const ROOM_ID = "room-semantic-inbox";
const WORKER_ID = "room-worker-1";
const HOST_ID = "host-controller";
const NOW = "2026-07-19T01:00:00.000Z";

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
    expiresAt: "2026-07-19T01:01:00.000Z",
    releasedAt: null,
    ...overrides,
  };
}

function claimedAction(
  id: string,
  actionKind: RoomSemanticControllerActionV1["actionKind"],
): RoomSemanticControllerActionV1 {
  return {
    id,
    roomId: ROOM_ID,
    messageId: `message-${id}`,
    protocolMessageId: `protocol-message-${id}`,
    actionKind,
    reasonCode: actionKind === "semantic_loop_break" ? "semantic_loop" : null,
    payload: {
      contractVersion: "room-semantic-controller-action/v1",
      actionId: id,
    },
    state: "claimed",
    attemptCount: 1,
    claimToken: `claim-token-${id}`,
    claimExpiresAt: "2026-07-19T01:05:00.000Z",
    claimedBy: WORKER_ID,
    processedAt: null,
    lastErrorCode: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function createStore(actions: readonly RoomSemanticControllerActionV1[]): {
  readonly store: RoomSemanticControllerInboxStore;
  readonly claims: ClaimRoomSemanticControllerActionInputV1[];
  readonly completions: CompleteRoomSemanticControllerActionInputV1[];
} {
  const pending = [...actions];
  const claims: ClaimRoomSemanticControllerActionInputV1[] = [];
  const completions: CompleteRoomSemanticControllerActionInputV1[] = [];
  return {
    store: {
      claimNextRoomSemanticControllerAction: async (input) => {
        claims.push(input);
        return pending.shift() ?? null;
      },
      completeRoomSemanticControllerAction: async (input) => {
        completions.push(input);
        const action = actions.find((candidate) => candidate.id === input.actionId);
        if (!action) throw new Error(`Unknown action ${input.actionId}`);
        return {
          ...action,
          state: input.outcome === "processed" ? "processed" : "pending",
          claimToken: null,
          claimExpiresAt: null,
          claimedBy: null,
          processedAt: input.outcome === "processed" ? input.now : null,
          lastErrorCode: input.errorCode,
          updatedAt: input.now,
        };
      },
    },
    claims,
    completions,
  };
}

describe("RoomSemanticControllerInboxProcessor", () => {
  it("drains both supported semantic action kinds as durable backend consumption only", async () => {
    const { store, claims, completions } = createStore([
      claimedAction("action-message", "semantic_message"),
      claimedAction("action-loop", "semantic_loop_break"),
    ]);
    const consumedActionIds: string[] = [];
    const renewLease = vi.fn(async (lease: StoredRoomLeaseV1) => lease);
    const observeLease = vi.fn(async (lease: StoredRoomLeaseV1) => lease);
    const processor = new RoomSemanticControllerInboxProcessor({
      workerId: WORKER_ID,
      hostId: HOST_ID,
      store,
      now: () => NOW,
      consumeAction: async (action) => {
        consumedActionIds.push(action.id);
      },
    });

    const summary = await processor.process({
      roomId: ROOM_ID,
      lease: workerLease(),
      renewLease,
      observeLease,
    });

    expect(summary).toMatchObject({
      roomId: ROOM_ID,
      claimedActionCount: 2,
      processedActionCount: 2,
      retriedActionCount: 0,
      reachedMaxActions: false,
      stopped: false,
      stopReason: null,
      processedActionKinds: {
        semantic_message: 1,
        semantic_loop_break: 1,
      },
    });
    expect(consumedActionIds).toEqual(["action-message", "action-loop"]);
    expect(claims).toHaveLength(3);
    expect(completions).toHaveLength(2);
    expect(renewLease).toHaveBeenCalledTimes(5);
    expect(observeLease).toHaveBeenCalledTimes(5);
    for (const input of [...claims, ...completions]) {
      expect(input).toMatchObject({
        roomId: ROOM_ID,
        roomWorkerFence: {
          leaseId: "room-worker-lease-1",
          holderId: WORKER_ID,
          hostId: HOST_ID,
          expectedEpoch: 7,
        },
      });
    }
    expect(completions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actionId: "action-message",
        outcome: "processed",
        errorCode: null,
      }),
      expect.objectContaining({
        actionId: "action-loop",
        outcome: "processed",
        errorCode: null,
      }),
    ]));
  });

  it("fails closed without a consumer, retries the claimed action, and keeps the controller lifecycle healthy", async () => {
    const { store, claims, completions } = createStore([
      claimedAction("action-unconfigured", "semantic_message"),
      claimedAction("action-unrelated", "semantic_loop_break"),
    ]);
    const renewLease = vi.fn(async (lease: StoredRoomLeaseV1) => lease);
    const observeLease = vi.fn(async (lease: StoredRoomLeaseV1) => lease);
    const processor = new RoomSemanticControllerInboxProcessor({
      workerId: WORKER_ID,
      hostId: HOST_ID,
      store,
      now: () => NOW,
    });

    const summary = await processor.process({
      roomId: ROOM_ID,
      lease: workerLease(),
      renewLease,
      observeLease,
    });

    expect(summary).toMatchObject({
      claimedActionCount: 1,
      processedActionCount: 0,
      retriedActionCount: 1,
      reachedMaxActions: false,
      stopped: false,
      stopReason: null,
      retriedActionKinds: {
        semantic_message: 1,
        semantic_loop_break: 0,
      },
    });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ roomId: ROOM_ID });
    expect(completions).toEqual([
      expect.objectContaining({
        actionId: "action-unconfigured",
        outcome: "retry",
        errorCode: "semantic_controller_action_consumer_unconfigured",
      }),
    ]);
    expect(renewLease).toHaveBeenCalledTimes(2);
    expect(observeLease).toHaveBeenCalledTimes(2);
  });

  it("stops at maxActions without claiming a further queued action", async () => {
    const { store, claims, completions } = createStore([
      claimedAction("action-1", "semantic_message"),
      claimedAction("action-2", "semantic_loop_break"),
      claimedAction("action-3", "semantic_message"),
    ]);
    const processor = new RoomSemanticControllerInboxProcessor({
      workerId: WORKER_ID,
      hostId: HOST_ID,
      store,
      now: () => NOW,
      maxActions: 2,
      consumeAction: async () => undefined,
    });

    const summary = await processor.process({
      roomId: ROOM_ID,
      lease: workerLease(),
      renewLease: async (lease) => lease,
    });

    expect(summary).toMatchObject({
      claimedActionCount: 2,
      processedActionCount: 2,
      retriedActionCount: 0,
      reachedMaxActions: true,
      stopped: false,
    });
    expect(claims).toHaveLength(2);
    expect(completions).toHaveLength(2);
  });

  it("stops without completing a claimed action when the current fence is no longer observable", async () => {
    const { store, claims, completions } = createStore([
      claimedAction("action-fenced", "semantic_message"),
    ]);
    let observations = 0;
    const processor = new RoomSemanticControllerInboxProcessor({
      workerId: WORKER_ID,
      hostId: HOST_ID,
      store,
      now: () => NOW,
    });

    const summary = await processor.process({
      roomId: ROOM_ID,
      lease: workerLease(),
      renewLease: async (lease) => lease,
      observeLease: async (lease) => {
        observations += 1;
        return observations === 1 ? lease : null;
      },
    });

    expect(summary).toMatchObject({
      claimedActionCount: 1,
      processedActionCount: 0,
      retriedActionCount: 0,
      reachedMaxActions: false,
      stopped: true,
      stopReason: "fence_revoked",
    });
    expect(claims).toHaveLength(1);
    expect(completions).toHaveLength(0);
  });

  it("releases an action back to pending with a safe retry code after an action-local failure", async () => {
    const { store, completions } = createStore([
      claimedAction("action-retry", "semantic_message"),
    ]);
    const processor = new RoomSemanticControllerInboxProcessor({
      workerId: WORKER_ID,
      hostId: HOST_ID,
      store,
      now: () => NOW,
      consumeAction: async () => {
        throw new Error("connector secret=should-not-reach-the-durable-error-code");
      },
    });

    const summary = await processor.process({
      roomId: ROOM_ID,
      lease: workerLease(),
      renewLease: async (lease) => lease,
    });

    expect(summary).toMatchObject({
      claimedActionCount: 1,
      processedActionCount: 0,
      retriedActionCount: 1,
      reachedMaxActions: false,
      stopped: false,
      retriedActionKinds: {
        semantic_message: 1,
        semantic_loop_break: 0,
      },
    });
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({
      actionId: "action-retry",
      outcome: "retry",
      errorCode: "semantic_controller_action_failed",
    });
    expect(JSON.stringify(completions[0])).not.toContain("should-not-reach-the-durable-error-code");
  });
});

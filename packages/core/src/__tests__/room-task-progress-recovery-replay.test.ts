import { describe, expect, it, vi } from "vitest";

const roomSchemaReplayStub = vi.hoisted(() => new Proxy(
  { ROOM_PROJECT_TABLE_NAMES: [] as const },
  {
    get(target, property) {
      if (property === "ROOM_PROJECT_TABLE_NAMES") return target.ROOM_PROJECT_TABLE_NAMES;
      if (property === "then") return undefined;
      return {};
    },
    has() {
      return true;
    },
  },
));

/*
FNXC:SessionRoomTaskProgressRecovery 2026-07-19-08:46:
The graph replayer is pure, but its historical module host also loads Drizzle
table definitions. Stub only those unrelated table bindings so this unit test
exercises the public replayer without opening a database/schema cycle.
*/
vi.mock("../postgres/schema/room.js", () => roomSchemaReplayStub);

import {
  rebuildRoomTaskGraphProjectionFromEvents,
  type RoomTaskNoProgressRecoveryDecisionV1,
  type RoomTaskProgressObservationV1,
  type RoomTaskRecoveryActionV1,
} from "../async-room-store.js";
import { createRoomAggregate } from "../room-domain.js";
import { hashRoomValue } from "../room-integrity.js";
import {
  extractRoomTaskRecoveryExhaustionTaskGraphProjection,
  rebuildRoomProjectionFromEvents,
  rebuildRoomTaskProgressRecoveryProjectionFromEvents,
} from "../room-projection-replay.js";
import type { RoomEventRecordV1 } from "../room-contracts/storage.js";

const ROOM_ID = "room-task-progress-replay";
const PROJECT_ID = "project-task-progress-replay";
const CREATED_AT = "2026-07-19T08:59:00.000Z";
const OBSERVED_ONE_AT = "2026-07-19T09:00:00.000Z";
const OBSERVED_TWO_AT = "2026-07-19T09:01:00.000Z";
const CLAIMED_ONE_AT = "2026-07-19T09:02:00.000Z";
const RETRIED_AT = "2026-07-19T09:03:00.000Z";
const CLAIMED_TWO_AT = "2026-07-19T09:04:00.000Z";
const PROCESSED_AT = "2026-07-19T09:05:00.000Z";

function observation(
  id: string,
  roundId: string,
  observedAt: string,
): RoomTaskProgressObservationV1 {
  return {
    id,
    roomId: ROOM_ID,
    nodeId: "node-task-progress-1",
    nodeVersion: 3,
    turnId: "turn-task-progress-1",
    phaseId: "verify",
    roundId,
    idempotencyKey: `observe:${roundId}`,
    progressSignature: hashRoomValue("progress-signature-unchanged"),
    semanticHash: hashRoomValue("semantic-unchanged"),
    evidenceHash: hashRoomValue("evidence-unchanged"),
    artifactHash: hashRoomValue("artifact-unchanged"),
    testHash: hashRoomValue("tests-unchanged"),
    resolvedDissentHash: hashRoomValue("dissent-unchanged"),
    origin: {
      contractVersion: "room-task-progress-observation-origin/v1",
      sourceKind: "recovery_worker",
      sourceRef: "room-recovery-worker-1",
    },
    observedAt,
    createdAt: observedAt,
  };
}

function recoveryAction(
  triggeringObservation: RoomTaskProgressObservationV1,
): RoomTaskRecoveryActionV1 {
  const declared = {
    id: "recovery-redecompose-1",
    trigger: "no_progress" as const,
    action: "redecompose" as const,
    maxAttempts: 2,
    phaseIds: ["verify"],
    exhaustedGateId: "recovery-exhausted-1",
  };
  return {
    id: "task-recovery-action-1",
    roomId: ROOM_ID,
    nodeId: triggeringObservation.nodeId,
    nodeVersion: triggeringObservation.nodeVersion,
    observationId: triggeringObservation.id,
    actionId: declared.id,
    actionSnapshot: {
      contractVersion: "room-task-no-progress-recovery-action/v1",
      protocolId: "implementation",
      protocolVersion: 1,
      turnId: triggeringObservation.turnId,
      phaseId: triggeringObservation.phaseId,
      nodeId: triggeringObservation.nodeId,
      nodeVersion: triggeringObservation.nodeVersion,
      observationId: triggeringObservation.id,
      recoveryAction: declared,
      recoveryActionHash: hashRoomValue(declared),
      ladderOrder: 1,
      minimumConsecutiveUnchangedRounds: 2,
      executionMode: "controller_plan",
    },
    policySnapshot: {
      protocolId: "implementation",
      protocolVersion: 1,
      actions: [{
        recoveryActionId: declared.id,
        ladderOrder: 1,
        minimumConsecutiveUnchangedRounds: 2,
      }],
    },
    state: "pending",
    attemptCount: 0,
    claimToken: null,
    claimExpiresAt: null,
    claimedByWorkerId: null,
    claimedAt: null,
    nextEligibleAt: triggeringObservation.observedAt,
    resultPayload: null,
    lastErrorCode: null,
    operatorApprovalId: null,
    createdAt: triggeringObservation.observedAt,
    updatedAt: triggeringObservation.observedAt,
    processedAt: null,
  };
}

function claimedAction(
  previous: RoomTaskRecoveryActionV1,
  claimToken: string,
  updatedAt: string,
): RoomTaskRecoveryActionV1 {
  return {
    ...previous,
    state: "claimed",
    attemptCount: previous.attemptCount + 1,
    claimToken,
    claimExpiresAt: new Date(Date.parse(updatedAt) + 60_000).toISOString(),
    claimedByWorkerId: "room-recovery-worker-1",
    claimedAt: updatedAt,
    resultPayload: null,
    lastErrorCode: null,
    processedAt: null,
    updatedAt,
  };
}

function retriedAction(previous: RoomTaskRecoveryActionV1): RoomTaskRecoveryActionV1 {
  return {
    ...previous,
    state: "pending",
    claimToken: null,
    claimExpiresAt: null,
    claimedByWorkerId: null,
    claimedAt: null,
    nextEligibleAt: "2026-07-19T09:04:00.000Z",
    resultPayload: null,
    lastErrorCode: "controller_timeout",
    processedAt: null,
    updatedAt: RETRIED_AT,
  };
}

function processedAction(previous: RoomTaskRecoveryActionV1): RoomTaskRecoveryActionV1 {
  const resultPayload = {
    contractVersion: "room-task-recovery-action-result/v1" as const,
    kind: "controller_plan_submitted" as const,
    receiptRef: "controller-plan:task-recovery-action-1",
    resultHash: hashRoomValue({
      contractVersion: "room-task-recovery-action-result/v1",
      kind: "controller_plan_submitted",
      receiptRef: "controller-plan:task-recovery-action-1",
    }),
  };
  return {
    ...previous,
    state: "processed",
    claimToken: null,
    claimExpiresAt: null,
    claimedByWorkerId: null,
    claimedAt: null,
    resultPayload,
    lastErrorCode: null,
    processedAt: PROCESSED_AT,
    updatedAt: PROCESSED_AT,
  };
}

function roomCreatedEvent(): RoomEventRecordV1 {
  const initialProjection = createRoomAggregate({
    id: ROOM_ID,
    projectId: PROJECT_ID,
    objective: "Replay no-progress recovery evidence",
    protocolId: "implementation",
    protocolVersion: 1,
    now: CREATED_AT,
  });
  return roomEvent({
    id: "event-room-created-task-progress-1",
    aggregateVersion: 0,
    eventType: "room_created",
    occurredAt: CREATED_AT,
    cursor: "1",
    payload: {
      projectionVersion: 1,
      initialProjection,
      initialProjectionHash: hashRoomValue(initialProjection),
    },
  });
}

function progressEvent(
  id: string,
  aggregateVersion: number,
  cursor: string,
  observed: RoomTaskProgressObservationV1,
  decision: RoomTaskNoProgressRecoveryDecisionV1,
): RoomEventRecordV1 {
  const eventType = decision.kind === "action_enqueued"
    ? "room_task_recovery_action_enqueued"
    : decision.kind === "exhausted"
      ? "room_task_recovery_ladder_exhausted"
      : "room_task_progress_observed";
  const graph = decision.kind === "exhausted"
    ? {
      roomId: ROOM_ID,
      aggregateVersion,
      dagVersion: 4,
      nodes: [],
      edges: [],
      readyNodeIds: [],
      criticalPathNodeIds: [],
    }
    : null;
  return roomEvent({
    id,
    aggregateVersion,
    eventType,
    occurredAt: observed.observedAt,
    cursor,
    payload: {
      projectionVersion: 1,
      snapshot: {
        contractVersion: "room-task-progress-observation-snapshot/v1",
        observation: observed,
        decision,
      },
      ...(graph ? {
        taskGraphProjection: graph,
        taskGraphProjectionHash: hashRoomValue(graph),
      } : {}),
      updatedAt: observed.observedAt,
    },
  });
}

function claimedEvent(
  action: RoomTaskRecoveryActionV1,
  aggregateVersion: number,
  cursor: string,
  previousState: "pending" | "claimed" = "pending",
): RoomEventRecordV1 {
  return roomEvent({
    id: `event-task-recovery-claimed-${aggregateVersion}`,
    aggregateVersion,
    eventType: "room_task_recovery_action_claimed",
    occurredAt: action.updatedAt,
    cursor,
    payload: {
      projectionVersion: 1,
      actionId: action.id,
      snapshot: {
        contractVersion: "room-task-recovery-action-snapshot/v1",
        transition: "claimed",
        previousState,
        action,
      },
      updatedAt: action.updatedAt,
    },
  });
}

function completedEvent(
  action: RoomTaskRecoveryActionV1,
  aggregateVersion: number,
  cursor: string,
  transition: "retry" | "processed",
): RoomEventRecordV1 {
  return roomEvent({
    id: `event-task-recovery-completed-${aggregateVersion}`,
    aggregateVersion,
    eventType: "room_task_recovery_action_completed",
    occurredAt: action.updatedAt,
    cursor,
    payload: {
      projectionVersion: 1,
      actionId: action.id,
      snapshot: {
        contractVersion: "room-task-recovery-action-snapshot/v1",
        transition,
        previousState: "claimed",
        action,
      },
      updatedAt: action.updatedAt,
    },
  });
}

function roomEvent(input: {
  readonly id: string;
  readonly aggregateVersion: number;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly cursor: string;
  readonly payload: Record<string, unknown>;
}): RoomEventRecordV1 {
  return {
    contractVersion: 1,
    id: input.id,
    roomId: ROOM_ID,
    projectId: PROJECT_ID,
    aggregateVersion: input.aggregateVersion,
    eventType: input.eventType,
    actorType: "controller",
    actorId: "room-recovery-worker-1",
    correlationId: "task-progress-recovery-replay",
    causationId: "turn-task-progress-1",
    payload: input.payload,
    occurredAt: input.occurredAt,
    cursor: input.cursor,
  };
}

function fullRecoveryStream(): readonly RoomEventRecordV1[] {
  const first = observation("observation-1", "round-1", OBSERVED_ONE_AT);
  const second = observation("observation-2", "round-2", OBSERVED_TWO_AT);
  const seeded = recoveryAction(second);
  const claimedOnce = claimedAction(seeded, "claim-token-1", CLAIMED_ONE_AT);
  const retried = retriedAction(claimedOnce);
  const claimedTwice = claimedAction(retried, "claim-token-2", CLAIMED_TWO_AT);
  const processed = processedAction(claimedTwice);
  return [
    roomCreatedEvent(),
    progressEvent("event-progress-1", 1, "2", first, {
      kind: "below_threshold",
      consecutiveUnchangedRounds: 1,
    }),
    progressEvent("event-progress-2", 2, "3", second, {
      kind: "action_enqueued",
      consecutiveUnchangedRounds: 2,
      action: seeded,
    }),
    claimedEvent(claimedOnce, 3, "4"),
    completedEvent(retried, 4, "5", "retry"),
    claimedEvent(claimedTwice, 5, "6"),
    completedEvent(processed, 6, "7", "processed"),
  ];
}

/*
FNXC:SessionRoomTaskProgressRecovery 2026-07-19-08:35:
The recovery ledger must survive a crash between observation, claim, retry, and
completion without inventing a second action or accepting an altered graph.
These pure tests exercise the immutable replay boundary without a PostgreSQL
worker or provider-side effect.
*/
describe("Room task-progress recovery projection replay", () => {
  it("replays observation through enqueue, claim, retry, reclaim, and processed receipt", () => {
    const projection = rebuildRoomTaskProgressRecoveryProjectionFromEvents(fullRecoveryStream());

    expect(projection.observations).toHaveLength(2);
    expect(projection.actions).toEqual([
      expect.objectContaining({
        id: "task-recovery-action-1",
        state: "processed",
        attemptCount: 2,
        claimToken: null,
        processedAt: PROCESSED_AT,
        resultPayload: expect.objectContaining({ kind: "controller_plan_submitted" }),
      }),
    ]);
    expect(rebuildRoomProjectionFromEvents(fullRecoveryStream()).room).toMatchObject({
      aggregateVersion: 6,
      updatedAt: PROCESSED_AT,
    });
  });

  it("accepts only the hash-bound exhaustion task-graph snapshot", () => {
    const exhausted = observation("observation-exhausted", "round-exhausted", OBSERVED_ONE_AT);
    const event = progressEvent("event-progress-exhausted", 1, "2", exhausted, {
      kind: "exhausted",
      consecutiveUnchangedRounds: 2,
      exhaustedGateIds: ["recovery-exhausted-1"],
    });
    const stream = [roomCreatedEvent(), event];

    expect(extractRoomTaskRecoveryExhaustionTaskGraphProjection(event)).toMatchObject({
      roomId: ROOM_ID,
      aggregateVersion: 1,
      dagVersion: 4,
    });
    expect(rebuildRoomTaskGraphProjectionFromEvents(stream)).toMatchObject({
      roomId: ROOM_ID,
      aggregateVersion: 1,
      dagVersion: 4,
      nodes: [],
      edges: [],
    });
    expect(rebuildRoomTaskProgressRecoveryProjectionFromEvents(stream).observations).toHaveLength(1);

    const corruptedHash = {
      ...event,
      payload: { ...event.payload, taskGraphProjectionHash: hashRoomValue("tampered") },
    } as RoomEventRecordV1;
    expect(() => rebuildRoomProjectionFromEvents([roomCreatedEvent(), corruptedHash]))
      .toThrow(/task-graph hash/i);
  });

  it("fails closed on payload, hash, version, event-type, aggregate-time, and claim-token tampering", () => {
    const [created, first, enqueued, claimed, retried, reclaimed] = fullRecoveryStream();
    const malformedPayload = {
      ...claimed!,
      payload: { ...claimed!.payload, forged: true },
    } as RoomEventRecordV1;
    expect(() => rebuildRoomProjectionFromEvents([created!, first!, enqueued!, malformedPayload]))
      .toThrow(/must contain exactly/i);

    const badVersion = {
      ...first!,
      payload: { ...first!.payload, projectionVersion: 2 },
    } as RoomEventRecordV1;
    expect(() => rebuildRoomProjectionFromEvents([created!, badVersion]))
      .toThrow(/unsupported projection payload version/i);

    const eventTypeMismatch = {
      ...enqueued!,
      eventType: "room_task_progress_observed",
    } as RoomEventRecordV1;
    expect(() => rebuildRoomProjectionFromEvents([created!, first!, eventTypeMismatch]))
      .toThrow(/does not bind its observation and decision/i);

    const timeBackwards = {
      ...first!,
      occurredAt: "2026-07-19T08:58:00.000Z",
      payload: {
        ...first!.payload,
        snapshot: {
          ...(first!.payload.snapshot as Record<string, unknown>),
          observation: {
            ...((first!.payload.snapshot as Record<string, unknown>).observation as Record<string, unknown>),
            observedAt: "2026-07-19T08:58:00.000Z",
            createdAt: "2026-07-19T08:58:00.000Z",
          },
        },
        updatedAt: "2026-07-19T08:58:00.000Z",
      },
    } as RoomEventRecordV1;
    expect(() => rebuildRoomProjectionFromEvents([created!, timeBackwards]))
      .toThrow(/cannot move Room time backwards/i);

    const reusedToken = {
      ...reclaimed!,
      payload: {
        ...reclaimed!.payload,
        snapshot: {
          ...(reclaimed!.payload.snapshot as Record<string, unknown>),
          action: {
            ...((reclaimed!.payload.snapshot as Record<string, unknown>).action as Record<string, unknown>),
            claimToken: "claim-token-1",
          },
        },
      },
    } as RoomEventRecordV1;
    expect(() => rebuildRoomTaskProgressRecoveryProjectionFromEvents([
      created!, first!, enqueued!, claimed!, retried!, reusedToken,
    ])).toThrow(/reuses a prior immutable claim token/i);
  });
});

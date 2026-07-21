import { describe, expect, it } from "vitest";

import { rebuildRoomSemanticControllerInboxProjectionFromEvents } from "../room-projection-replay.js";
import {
  applyRoomProjectionEvents,
  createRoomAggregate,
} from "../index.js";
import { hashRoomValue } from "../room-integrity.js";
import type { RoomSemanticControllerActionV1 } from "../async-room-store.js";
import type { RoomEventRecordV1 } from "../room-contracts/storage.js";

const CREATED_AT = "2026-07-19T03:55:00.000Z";
const SEMANTIC_STATE_UPDATED_AT = "2026-07-19T03:56:00.000Z";
const SEMANTIC_ROUTE_UPDATED_AT = "2026-07-19T03:57:00.000Z";
const SEMANTIC_ACTION_CLAIMED_AT = "2026-07-19T03:58:00.000Z";
const SEMANTIC_ACTION_PROCESSED_AT = "2026-07-19T03:59:00.000Z";

function semanticStatePayload() {
  return {
    projectionVersion: 1,
    semanticStateId: "semantic-state-routing-1",
    revision: 1,
    turnId: "turn-semantic-routing-1",
    nodeId: "node-semantic-routing-1",
    protocolId: "implementation",
    protocolVersion: 1,
    phaseId: "verify",
    semanticHash: hashRoomValue("semantic-state-routing-1"),
    evidenceStateHash: hashRoomValue("evidence-state-routing-1"),
    decisionStateHash: hashRoomValue("decision-state-routing-1"),
    stateFingerprint: hashRoomValue("semantic-state-fingerprint-routing-1"),
    updatedAt: SEMANTIC_STATE_UPDATED_AT,
  };
}

function semanticControllerAction(
  overrides: Partial<RoomSemanticControllerActionV1> = {},
): RoomSemanticControllerActionV1 {
  return {
    id: "semantic-controller-action-routing-1",
    roomId: "room-semantic-routing-replay",
    messageId: "message-semantic-route-1",
    protocolMessageId: "protocol-message-semantic-route-1",
    actionKind: "semantic_message",
    reasonCode: null,
    payload: {
      contractVersion: "room-semantic-controller-action/v1",
      protocolMessageId: "protocol-message-semantic-route-1",
      protocolEnvelope: {
        contractVersion: "room-protocol-message/v1",
        messageId: "protocol-message-semantic-route-1",
        issuedAt: SEMANTIC_ROUTE_UPDATED_AT,
        protocolId: "implementation",
        protocolVersion: 1,
        phaseId: "verify",
        channelId: "implementation_review",
        projectId: "project-semantic-routing-replay",
        roomId: "room-semantic-routing-replay",
        turnId: "turn-semantic-routing-1",
        nodeId: "node-semantic-routing-1",
        origin: {
          seatId: "seat-reviewer",
          bindingId: "binding-reviewer-1",
          roleId: "implementation_verifier",
        },
        target: { kind: "seats", seatIds: ["seat-implementer"] },
        intent: "challenge",
        content: "Please verify the replayable semantic route.",
        contentHash: hashRoomValue("Please verify the replayable semantic route."),
        semanticHash: hashRoomValue("semantic-state-routing-1"),
        evidenceStateHash: hashRoomValue("evidence-state-routing-1"),
        decisionStateHash: hashRoomValue("decision-state-routing-1"),
        authority: {
          actorType: "seat",
          actorId: "seat-reviewer",
          deviceId: null,
          role: "implementation_verifier",
          allowedActions: ["room:message:route"],
          projectId: "project-semantic-routing-replay",
          roomId: "room-semantic-routing-replay",
          nodeIds: ["node-semantic-routing-1"],
          seatIds: ["seat-reviewer", "seat-implementer"],
          evidenceRefs: ["evidence-routing-1"],
        },
        references: {
          evidenceRefs: ["evidence-routing-1"],
          parentMessageIds: [],
          resolutionRefs: [],
        },
      },
      turnId: "turn-semantic-routing-1",
      nodeId: "node-semantic-routing-1",
      intent: "challenge",
      origin: {
        seatId: "seat-reviewer",
        bindingId: "binding-reviewer-1",
        roleId: "implementation_verifier",
      },
      semanticStateId: "semantic-state-routing-1",
      semanticStateRevision: 1,
      semanticStateFingerprint: hashRoomValue("semantic-state-fingerprint-routing-1"),
      audit: {
        outcome: "route",
        messageFingerprint: hashRoomValue("message-fingerprint-routing-1"),
        semanticLoopFingerprint: hashRoomValue("semantic-loop-fingerprint-routing-1"),
        targetFingerprint: hashRoomValue("target-fingerprint-routing-1"),
        semanticHash: hashRoomValue("semantic-state-routing-1"),
        evidenceStateHash: hashRoomValue("evidence-state-routing-1"),
        decisionStateHash: hashRoomValue("decision-state-routing-1"),
        repeatedSemanticCount: 1,
        recipientCount: 1,
        requiredResponderCount: 1,
      },
    },
    state: "pending",
    attemptCount: 0,
    claimToken: null,
    claimExpiresAt: null,
    claimedBy: null,
    processedAt: null,
    lastErrorCode: null,
    createdAt: SEMANTIC_ROUTE_UPDATED_AT,
    updatedAt: SEMANTIC_ROUTE_UPDATED_AT,
    ...overrides,
  };
}

function semanticRoutePayload(
  controllerAction: RoomSemanticControllerActionV1 | null = null,
) {
  const state = semanticStatePayload();
  const sourceMessage = {
    contractVersion: 1,
    id: "message-semantic-route-1",
    roomId: "room-semantic-routing-replay",
    turnId: "turn-semantic-routing-1",
    nodeId: "node-semantic-routing-1",
    originType: "seat",
    originId: "seat-reviewer",
    targetSeatIds: ["seat-implementer"],
    intent: "challenge",
    content: "Please verify the replayable semantic route.",
    contentHash: hashRoomValue("Please verify the replayable semantic route."),
    authorityEnvelope: {
      actorType: "seat",
      actorId: "seat-reviewer",
      deviceId: null,
      role: "implementation_verifier",
      allowedActions: ["room:message:route"],
      projectId: "project-semantic-routing-replay",
      roomId: "room-semantic-routing-replay",
      nodeIds: ["node-semantic-routing-1"],
      seatIds: ["seat-reviewer", "seat-implementer"],
      evidenceRefs: ["evidence-routing-1"],
    },
    createdAt: SEMANTIC_ROUTE_UPDATED_AT,
  };
  const envelope = {
    contractVersion: "room-protocol-message/v1",
    messageId: "protocol-message-semantic-route-1",
    issuedAt: SEMANTIC_ROUTE_UPDATED_AT,
    protocolId: "implementation",
    protocolVersion: 1,
    phaseId: "verify",
    channelId: "implementation_review",
    projectId: "project-semantic-routing-replay",
    roomId: "room-semantic-routing-replay",
    turnId: "turn-semantic-routing-1",
    nodeId: "node-semantic-routing-1",
    origin: {
      seatId: "seat-reviewer",
      bindingId: "binding-reviewer-1",
      roleId: "implementation_verifier",
    },
    target: { kind: "seats", seatIds: ["seat-implementer"] },
    intent: "challenge",
    content: sourceMessage.content,
    contentHash: sourceMessage.contentHash,
    semanticHash: state.semanticHash,
    evidenceStateHash: state.evidenceStateHash,
    decisionStateHash: state.decisionStateHash,
    authority: sourceMessage.authorityEnvelope,
    references: {
      evidenceRefs: ["evidence-routing-1"],
      parentMessageIds: [],
      resolutionRefs: [],
    },
  };
  const target = {
    contractVersion: 1,
    id: "seat-implementer",
    projectId: "project-semantic-routing-replay",
    roomId: "room-semantic-routing-replay",
    messageId: sourceMessage.id,
    selectorKind: "seats",
    selectorRef: null,
    targetKind: "seat",
    seatId: "seat-implementer",
    bindingId: "binding-implementer-1",
    ordinal: 0,
    createdAt: SEMANTIC_ROUTE_UPDATED_AT,
  };
  const delivery = {
    contractVersion: 1,
    id: "outbox-semantic-route-1",
    roomId: "room-semantic-routing-replay",
    logicalMessageId: sourceMessage.id,
    localMessageId: "local-message-semantic-route-1",
    bindingId: "binding-implementer-1",
    idempotencyKey: "semantic-route-replay:binding-implementer-1",
    payloadHash: sourceMessage.contentHash,
    state: "pending",
    attemptCount: 0,
    connectorAcknowledgementId: null,
    nativeMessageId: null,
    nativeCursor: null,
    reconciliationFromCursor: null,
    reconciliationEvidenceRef: null,
    lastErrorCode: null,
    nextAttemptAt: null,
    updatedAt: SEMANTIC_ROUTE_UPDATED_AT,
  };
  const protocolMessage = {
    id: sourceMessage.id,
    roomId: sourceMessage.roomId,
    protocolMessageId: envelope.messageId,
    turnId: envelope.turnId,
    nodeId: envelope.nodeId,
    protocolId: envelope.protocolId,
    protocolVersion: envelope.protocolVersion,
    phaseId: envelope.phaseId,
    channelId: envelope.channelId,
    issuedAt: envelope.issuedAt,
    envelope,
    origin: envelope.origin,
    target: envelope.target,
    semanticLoopFingerprint: hashRoomValue("semantic-loop-fingerprint-routing-1"),
    semanticStateId: state.semanticStateId,
    semanticStateRevision: state.revision,
    semanticStateFingerprint: state.stateFingerprint,
    routeOutcome: "route",
    recipientController: controllerAction !== null,
    recipientSeatIds: ["seat-implementer"],
    requiredControllerResponse: false,
    requiredResponderSeatIds: ["seat-implementer"],
    createdAt: SEMANTIC_ROUTE_UPDATED_AT,
  };
  return {
    projectionVersion: 2,
    messageId: sourceMessage.id,
    protocolMessageId: envelope.messageId,
    targetIds: ["seat-implementer"],
    outboxIds: ["outbox-semantic-route-1"],
    controllerActionId: controllerAction?.id ?? null,
    escalationMessageId: null,
    escalationTargetId: null,
    semanticStateId: state.semanticStateId,
    semanticStateRevision: state.revision,
    semanticStateFingerprint: state.stateFingerprint,
    outcome: "route",
    audit: {
      outcome: "route",
      messageFingerprint: hashRoomValue("message-fingerprint-routing-1"),
      semanticLoopFingerprint: hashRoomValue("semantic-loop-fingerprint-routing-1"),
      targetFingerprint: hashRoomValue("target-fingerprint-routing-1"),
      semanticHash: state.semanticHash,
      evidenceStateHash: state.evidenceStateHash,
      decisionStateHash: state.decisionStateHash,
      repeatedSemanticCount: 1,
      recipientCount: 1,
      requiredResponderCount: 1,
    },
    snapshot: {
      contractVersion: "room-semantic-route-snapshot/v1",
      sourceMessage,
      protocolMessage,
      targets: [target],
      deliveries: [delivery],
      controllerAction,
      loopBreak: null,
    },
    updatedAt: SEMANTIC_ROUTE_UPDATED_AT,
  };
}

function semanticControllerActionClaimed(): RoomSemanticControllerActionV1 {
  return semanticControllerAction({
    state: "claimed",
    attemptCount: 1,
    claimToken: "semantic-controller-claim-routing-1",
    claimExpiresAt: "2026-07-19T04:03:00.000Z",
    claimedBy: "semantic-controller-worker-1",
    updatedAt: SEMANTIC_ACTION_CLAIMED_AT,
  });
}

function semanticControllerActionProcessed(): RoomSemanticControllerActionV1 {
  return semanticControllerAction({
    state: "processed",
    attemptCount: 1,
    processedAt: SEMANTIC_ACTION_PROCESSED_AT,
    updatedAt: SEMANTIC_ACTION_PROCESSED_AT,
  });
}

function semanticStateEvent(
  payload: Readonly<Record<string, unknown>> = semanticStatePayload(),
): RoomEventRecordV1 {
  return {
    contractVersion: 1,
    id: "event-semantic-state-routing-1",
    roomId: "room-semantic-routing-replay",
    projectId: "project-semantic-routing-replay",
    aggregateVersion: 1,
    eventType: "room_semantic_state_updated",
    actorType: "controller",
    actorId: "room-semantic-controller",
    correlationId: "correlation-semantic-state-routing-1",
    causationId: "command-semantic-state-routing-1",
    payload,
    occurredAt: SEMANTIC_STATE_UPDATED_AT,
    cursor: "2",
  };
}

function semanticRouteEvent(
  payload: Readonly<Record<string, unknown>> = semanticRoutePayload(),
): RoomEventRecordV1 {
  return {
    contractVersion: 1,
    id: "event-semantic-route-routing-1",
    roomId: "room-semantic-routing-replay",
    projectId: "project-semantic-routing-replay",
    aggregateVersion: 2,
    eventType: "room_protocol_message_routed",
    actorType: "controller",
    actorId: "room-semantic-controller",
    correlationId: "correlation-semantic-route-routing-1",
    causationId: "command-semantic-route-routing-1",
    payload,
    occurredAt: SEMANTIC_ROUTE_UPDATED_AT,
    cursor: "3",
  };
}

function semanticControllerActionClaimedEvent(
  action: RoomSemanticControllerActionV1 = semanticControllerActionClaimed(),
): RoomEventRecordV1 {
  return {
    contractVersion: 1,
    id: "event-semantic-controller-action-claimed-routing-1",
    roomId: "room-semantic-routing-replay",
    projectId: "project-semantic-routing-replay",
    aggregateVersion: 3,
    eventType: "room_semantic_controller_action_claimed",
    actorType: "controller",
    actorId: "semantic-controller-worker-1",
    correlationId: "protocol-message-semantic-route-1",
    causationId: "message-semantic-route-1",
    payload: {
      projectionVersion: 1,
      actionId: action.id,
      snapshot: {
        contractVersion: "room-semantic-controller-action-snapshot/v1",
        transition: "claimed",
        previousState: "pending",
        action,
      },
      updatedAt: action.updatedAt,
    },
    occurredAt: SEMANTIC_ACTION_CLAIMED_AT,
    cursor: "4",
  };
}

function semanticControllerActionCompletedEvent(
  action: RoomSemanticControllerActionV1 = semanticControllerActionProcessed(),
): RoomEventRecordV1 {
  return {
    contractVersion: 1,
    id: "event-semantic-controller-action-completed-routing-1",
    roomId: "room-semantic-routing-replay",
    projectId: "project-semantic-routing-replay",
    aggregateVersion: 4,
    eventType: "room_semantic_controller_action_completed",
    actorType: "controller",
    actorId: "semantic-controller-worker-1",
    correlationId: "protocol-message-semantic-route-1",
    causationId: "message-semantic-route-1",
    payload: {
      projectionVersion: 1,
      actionId: action.id,
      snapshot: {
        contractVersion: "room-semantic-controller-action-snapshot/v1",
        transition: "processed",
        previousState: "claimed",
        action,
      },
      updatedAt: action.updatedAt,
    },
    occurredAt: SEMANTIC_ACTION_PROCESSED_AT,
    cursor: "5",
  };
}

function roomCreatedEvent(): RoomEventRecordV1 {
  const initialProjection = semanticReplayBase();
  return {
    contractVersion: 1,
    id: "event-room-created-semantic-routing-1",
    roomId: initialProjection.room.id,
    projectId: initialProjection.room.projectId,
    aggregateVersion: 0,
    eventType: "room_created",
    actorType: "system",
    actorId: "semantic-routing-replay-fixture",
    correlationId: "room-semantic-routing-replay",
    causationId: null,
    payload: {
      projectionVersion: 1,
      initialProjection,
      initialProjectionHash: hashRoomValue(initialProjection),
    },
    occurredAt: CREATED_AT,
    cursor: "1",
  };
}

function semanticInboxReplayFromEvents(
  events: readonly RoomEventRecordV1[],
): readonly RoomSemanticControllerActionV1[] {
  return rebuildRoomSemanticControllerInboxProjectionFromEvents(events);
}

function semanticInboxReplay(): readonly RoomSemanticControllerActionV1[] {
  return semanticInboxReplayFromEvents([
    roomCreatedEvent(),
    semanticStateEvent(),
    semanticRouteEvent(semanticRoutePayload(semanticControllerAction())),
    semanticControllerActionClaimedEvent(),
    semanticControllerActionCompletedEvent(),
  ]) as readonly RoomSemanticControllerActionV1[];
}

function semanticReplayBase() {
  return createRoomAggregate({
    id: "room-semantic-routing-replay",
    projectId: "project-semantic-routing-replay",
    objective: "Replay semantic routing evidence",
    protocolId: "implementation",
    protocolVersion: 1,
    now: CREATED_AT,
  });
}

/*
FNXC:SessionRoomSemanticRouting 2026-07-19-03:57:
Semantic routing persists controller-owned state before the route decision. The
public replay boundary must accept that ordered evidence and reject malformed
route records rather than silently rebuilding a divergent projection.
*/
describe("Room semantic-routing projection replay", () => {
  it("replays a valid semantic-state update followed by a routed protocol message", () => {
    const base = semanticReplayBase();

    expect(applyRoomProjectionEvents(base, [
      semanticStateEvent(),
      semanticRouteEvent(),
    ])).toEqual({
      ...base,
      room: {
        ...base.room,
        aggregateVersion: 2,
        updatedAt: SEMANTIC_ROUTE_UPDATED_AT,
      },
    });
  });

  it("fails closed on malformed semantic route replay payloads", () => {
    const mismatchedAudit = semanticRoutePayload();
    expect(() => applyRoomProjectionEvents(semanticReplayBase(), [
      semanticStateEvent(),
      semanticRouteEvent({
        ...mismatchedAudit,
        audit: { ...mismatchedAudit.audit, outcome: "loop_break" },
      }),
    ])).toThrow(/audit outcome does not match payload/i);

    const routeWithEscalation = semanticRoutePayload();
    expect(() => applyRoomProjectionEvents(semanticReplayBase(), [
      semanticStateEvent(),
      semanticRouteEvent({
        ...routeWithEscalation,
        escalationMessageId: "message-escalation-1",
        escalationTargetId: "controller",
      }),
    ])).toThrow(/cannot contain a loop-break escalation/i);
  });

  it("rebuilds one immutable controller inbox action from route through claim and completion", () => {
    expect(applyRoomProjectionEvents(semanticReplayBase(), [
      semanticStateEvent(),
      semanticRouteEvent(semanticRoutePayload(semanticControllerAction())),
      semanticControllerActionClaimedEvent(),
      semanticControllerActionCompletedEvent(),
    ])).toMatchObject({
      room: {
        aggregateVersion: 4,
        updatedAt: SEMANTIC_ACTION_PROCESSED_AT,
      },
    });

    expect(semanticInboxReplay()).toEqual([semanticControllerActionProcessed()]);
  });

  it("rejects action snapshots that add undeclared payload fields or break the claim transition", () => {
    const malformed = semanticControllerActionCompletedEvent();
    expect(() => applyRoomProjectionEvents(semanticReplayBase(), [
      semanticStateEvent(),
      semanticRouteEvent(semanticRoutePayload(semanticControllerAction())),
      semanticControllerActionClaimedEvent(),
      {
        ...malformed,
        payload: { ...malformed.payload, outcome: "processed" },
      },
    ])).toThrow(/must contain exactly/i);

    const completedBeforeClaim = semanticControllerActionCompletedEvent();
    expect(() => semanticInboxReplayFromEvents([
      roomCreatedEvent(),
      semanticStateEvent(),
      semanticRouteEvent(semanticRoutePayload(semanticControllerAction())),
      {
        ...completedBeforeClaim,
        aggregateVersion: 3,
        cursor: "4",
      },
    ])).toThrow(/claimed/i);
  });

  it("rejects a second route that attempts to seed the same controller action", () => {
    const duplicateRoute = semanticRouteEvent(semanticRoutePayload(semanticControllerAction()));
    expect(() => semanticInboxReplayFromEvents([
      roomCreatedEvent(),
      semanticStateEvent(),
      semanticRouteEvent(semanticRoutePayload(semanticControllerAction())),
      {
        ...duplicateRoute,
        id: "event-semantic-route-routing-duplicate",
        aggregateVersion: 3,
        cursor: "4",
      },
    ])).toThrow(/duplicate.*action/i);
  });
});

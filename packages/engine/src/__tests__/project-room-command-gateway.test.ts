import { describe, expect, it, vi } from "vitest";

import type {
  RoomAggregateV1,
  RoomPhaseGateEvidenceProjectionV1,
  RoomRoleAssignmentProjectionV1,
  RouteOperatorMessageResultV1,
  RouteRoomProtocolMessageResultV1,
} from "@fusion/core";
import {
  ProjectRoomCommandError,
  ProjectRoomCommandGateway,
  type ProjectRoomCommandSpineV1,
  type ProjectRoomCommandV1,
  type ProjectRoomTrustedPrincipalV1,
  type ProjectRoomExistingSessionPreflightV1,
} from "../project-room-command-gateway.js";
import type {
  RoomExistingSessionPreflightRequestV1,
  RoomExistingSessionPreflightResultV1,
} from "../room-existing-session-preflight.js";
import type {
  CreateRoomWithExistingSessionsInput,
  RequestAddExistingSessionAtTurnBoundaryInput,
  RequestRemoveExistingSessionAtTurnBoundaryInput,
  RecordRoomPhaseGateEvidenceAtCompletedTurnBoundaryInput,
  RestoreRoomExistingSessionsInput,
  RouteStructuredRoomProtocolMessageInput,
  SendToRoomSeatInput,
  TransitionRoomRoleAssignmentAtCompletedTurnBoundaryInput,
} from "../room-existing-session-spine.js";
import type {
  RoomEvolutionAuthorizedShadowResultV1,
  RoomEvolutionAuthorizedShadowRunner,
} from "../room-evolution-authorized-shadow.js";

const PROJECT_ID = "project-room-command-gateway";

const DASHBOARD_OPERATOR: ProjectRoomTrustedPrincipalV1 = {
  kind: "dashboard_operator",
  principalId: "operator-1",
  authenticated: true,
};

const CONTROLLER: ProjectRoomTrustedPrincipalV1 = {
  kind: "controller",
  principalId: "controller-1",
  authenticated: true,
};

const CONNECTOR_ADAPTER: ProjectRoomTrustedPrincipalV1 = {
  kind: "connector_adapter",
  principalId: "connector-adapter-1",
  authenticated: true,
};

function createGateway(
  spine: ProjectRoomCommandSpineV1 | null,
  evolutionShadow: RoomEvolutionAuthorizedShadowRunner | null = null,
  preflight: ProjectRoomExistingSessionPreflightV1 | null = null,
): ProjectRoomCommandGateway {
  return new ProjectRoomCommandGateway({
    projectId: PROJECT_ID,
    resolveSpine: () => spine,
    resolvePreflight: () => preflight,
    resolveEvolutionShadow: () => evolutionShadow,
  });
}

function createSpine(): ProjectRoomCommandSpineV1 {
  const room = {
    room: { id: "room-1", projectId: PROJECT_ID, aggregateVersion: 3 },
    membershipVersion: 1,
  } as unknown as RoomAggregateV1;
  const routed = {
    roomId: "room-1",
  } as unknown as RouteRoomProtocolMessageResultV1;
  const assignment = {
    roomId: "room-1",
  } as unknown as RoomRoleAssignmentProjectionV1;
  const phaseGateEvidence = { id: "phase-gate-evidence-1", roomId: "room-1" } as unknown as RoomPhaseGateEvidenceProjectionV1;
  const routedOperatorMessage = {
    deliveries: [{ id: "outbox-1", roomId: "room-1" }],
    event: { aggregateVersion: 2 },
  } as unknown as RouteOperatorMessageResultV1;

  return {
    createRoomWithExistingSessions: vi.fn(async (_input: CreateRoomWithExistingSessionsInput) => room),
    restoreRoomExistingSessions: vi.fn(async (_input: RestoreRoomExistingSessionsInput) => room),
    requestAddExistingSessionAtTurnBoundary: vi.fn(
      async (_input: RequestAddExistingSessionAtTurnBoundaryInput) => room,
    ),
    requestRemoveExistingSessionAtTurnBoundary: vi.fn(
      async (_input: RequestRemoveExistingSessionAtTurnBoundaryInput) => room,
    ),
    routeStructuredProtocolMessage: vi.fn(async (_input: RouteStructuredRoomProtocolMessageInput) => routed),
    recordPhaseGateEvidenceAtCompletedTurnBoundary: vi.fn(
      async (_input: RecordRoomPhaseGateEvidenceAtCompletedTurnBoundaryInput) => phaseGateEvidence,
    ),
    transitionRoleAssignmentAtCompletedTurnBoundary: vi.fn(
      async (_input: TransitionRoomRoleAssignmentAtCompletedTurnBoundaryInput) => assignment,
    ),
    routeOperatorMessageToSeat: vi.fn(async (_input: SendToRoomSeatInput) => routedOperatorMessage),
  };
}

function createExistingSessionCommand(projectId = PROJECT_ID): ProjectRoomCommandV1 {
  return {
    type: "room.create-existing-session.v1",
    projectId,
    commandId: "create-existing-room-1",
    input: {
      room: { id: "room-1" },
    } as unknown as CreateRoomWithExistingSessionsInput,
  };
}

function createExistingSessionPreflightCommand(): ProjectRoomCommandV1 {
  return {
    type: "room.preflight-existing-session.v1",
    projectId: PROJECT_ID,
    commandId: "preflight-existing-session-1",
    input: {
      connectorId: "happier-runtime",
      canonicalSessionUri: "codex://threads/019f22f6-6581-7781-bb37-84cf4d63d81d",
      requiredHostId: "windows-host-1",
    },
  };
}

function createRestoreExistingSessionsCommand(): ProjectRoomCommandV1 {
  return {
    type: "room.restore-existing-sessions.v1",
    projectId: PROJECT_ID,
    commandId: "restore-existing-room-1",
    input: {
      roomId: "room-1",
      expectedAggregateVersion: 3,
      idempotencyKey: "restore-existing-room-1",
    },
  };
}

function createAddExistingSessionCommand(): ProjectRoomCommandV1 {
  return {
    type: "room.request-add-existing-session.v1",
    projectId: PROJECT_ID,
    commandId: "add-existing-session-1",
    input: {
      roomId: "room-1",
      expectedAggregateVersion: 3,
      expectedMembershipVersion: 1,
      changeId: "change-add-reviewer",
      idempotencyKey: "add-existing-session-1",
      reason: "Add an independent reviewer",
      session: {
        seatId: "seat-reviewer",
        bindingId: "binding-reviewer-1",
        role: "reviewer",
        permissionScope: ["room:message", "candidate:review"],
        connectorId: "happier",
        canonicalSessionUri: "claude://sessions/reviewer-session",
        requiredHostId: "windows-host-1",
        requiredMachineId: "machine-1",
        idempotencyKey: "ensure-reviewer-session-1",
      },
    },
  };
}

function createRemoveExistingSessionCommand(): ProjectRoomCommandV1 {
  return {
    type: "room.request-remove-existing-session.v1",
    projectId: PROJECT_ID,
    commandId: "remove-existing-session-1",
    input: {
      roomId: "room-1",
      seatId: "seat-reviewer",
      expectedAggregateVersion: 3,
      expectedMembershipVersion: 1,
      changeId: "change-remove-reviewer",
      idempotencyKey: "remove-existing-session-1",
      reason: "Reviewer completed the assignment",
    },
  };
}

function createStructuredProtocolCommand(): ProjectRoomCommandV1 {
  return {
    type: "room.ingest-structured-protocol.v1",
    projectId: PROJECT_ID,
    commandId: "ingest-structured-protocol-1",
    input: {
      roomId: "room-1",
      expectedAggregateVersion: 1,
      idempotencyKey: "ingest-1",
      message: { contractVersion: 1 },
    },
  };
}

function createRoleTransitionCommand(): ProjectRoomCommandV1 {
  return {
    type: "room.transition-role-assignment.v1",
    projectId: PROJECT_ID,
    commandId: "transition-role-assignment-1",
    input: {
      roomId: "room-1",
      expectedAggregateVersion: 1,
      boundaryTurnId: "turn-1",
      targetPhaseId: "review",
      phaseGateEvidenceId: "phase-gate-evidence-1",
      idempotencyKey: "transition-1",
      roleAssignment: {},
    } as unknown as TransitionRoomRoleAssignmentAtCompletedTurnBoundaryInput,
  };
}

function createRecordPhaseGateEvidenceCommand(): ProjectRoomCommandV1 {
  return {
    type: "room.record-phase-gate-evidence.v1",
    projectId: PROJECT_ID,
    commandId: "record-phase-gate-evidence-1",
    input: {
      roomId: "room-1",
      expectedAggregateVersion: 1,
      idempotencyKey: "record-phase-gate-evidence-1",
      evidence: { id: "phase-gate-evidence-1" },
    } as unknown as RecordRoomPhaseGateEvidenceAtCompletedTurnBoundaryInput,
  };
}

function createSendToSeatCommand(): ProjectRoomCommandV1 {
  return {
    type: "room.send-to-seat.v1",
    projectId: PROJECT_ID,
    commandId: "send-to-seat-1",
    input: {
      roomId: "room-1",
      seatId: "seat-1",
      expectedAggregateVersion: 1,
      commandId: "send-to-seat-1",
      correlationId: "operator-message-1",
      idempotencyKey: "send-to-seat-1",
      intent: "instruction",
      content: "Please independently review the current candidate.",
      authorityEnvelope: {},
    } as unknown as SendToRoomSeatInput,
  };
}

function createEvolutionShadowCommand(): ProjectRoomCommandV1 {
  return {
    type: "room.record-evolution-shadow.v1",
    projectId: PROJECT_ID,
    commandId: "record-evolution-shadow-1",
    input: {
      contractVersion: 1,
      roomId: "room-1",
      hypothesisId: "hypothesis-1",
      candidateVersionId: "candidate-1",
    },
  };
}

describe("ProjectRoomCommandGateway", () => {
  it("runs a read-only existing-Session preflight without resolving the mutating spine", async () => {
    const preflightResult: RoomExistingSessionPreflightResultV1 = {
      contractVersion: 1,
      state: "identity_verified",
      request: {
        connectorId: "happier-runtime",
        canonicalSessionUri: "codex://threads/019f22f6-6581-7781-bb37-84cf4d63d81d",
        requiredHostId: "windows-host-1",
      },
      identity: {
        connectorId: "happier-runtime",
        providerId: "codex",
        nativeSessionId: "019f22f6-6581-7781-bb37-84cf4d63d81d",
        happierSessionId: "happier-session-1",
        serverProfileId: "server-1",
        machineId: "machine-1",
        hostId: "windows-host-1",
      },
      checkedAt: "2026-07-20T06:00:00.000Z",
      providerTurnStarted: false,
      capabilities: [],
      health: {
        state: "unknown",
        checkedAt: null,
        authentication: "unknown",
        rateLimit: "unknown",
        reasonCodes: [],
        retryAfterMs: null,
      },
    };
    const preflight = {
      preflight: vi.fn(async (_input: RoomExistingSessionPreflightRequestV1) => preflightResult),
    } satisfies ProjectRoomExistingSessionPreflightV1;
    const resolveSpine = vi.fn(() => null);
    const gateway = new ProjectRoomCommandGateway({
      projectId: PROJECT_ID,
      resolveSpine,
      resolvePreflight: () => preflight,
    });
    const command = createExistingSessionPreflightCommand();

    const result = await gateway.execute(command, DASHBOARD_OPERATOR);

    expect(preflight.preflight).toHaveBeenCalledWith(command.input);
    expect(resolveSpine).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      type: "room.preflight-existing-session.v1",
      projectId: PROJECT_ID,
      commandId: "preflight-existing-session-1",
      actor: { kind: "dashboard_operator", principalId: "operator-1" },
      value: { providerTurnStarted: false, identity: { nativeSessionId: "019f22f6-6581-7781-bb37-84cf4d63d81d" } },
    });
    await expect(gateway.execute(command, CONNECTOR_ADAPTER)).rejects.toMatchObject<ProjectRoomCommandError>({
      code: "PROJECT_ROOM_COMMAND_PRINCIPAL_FORBIDDEN",
    });
  });

  it("withholds preflight when the Engine has not completed connector discovery", async () => {
    const gateway = createGateway(null);

    await expect(gateway.execute(createExistingSessionPreflightCommand(), DASHBOARD_OPERATOR))
      .rejects.toMatchObject<ProjectRoomCommandError>({
        code: "PROJECT_ROOM_COMMAND_ENGINE_UNAVAILABLE",
      });
  });

  it("admits immutable phase-gate evidence only from the trusted controller", async () => {
    const spine = createSpine();
    const gateway = createGateway(spine);
    const command = createRecordPhaseGateEvidenceCommand();

    await expect(gateway.execute(command, DASHBOARD_OPERATOR)).rejects.toMatchObject({
      code: "PROJECT_ROOM_COMMAND_PRINCIPAL_FORBIDDEN",
    });
    const result = await gateway.execute(command, CONTROLLER);
    expect(result).toMatchObject({
      type: "room.record-phase-gate-evidence.v1",
      actor: { kind: "controller", principalId: CONTROLLER.principalId },
      value: { id: "phase-gate-evidence-1" },
    });
    expect(spine.recordPhaseGateEvidenceAtCompletedTurnBoundary).toHaveBeenCalledWith(command.input);
  });

  it("dispatches an operator's exact-existing-Session command and returns the trusted actor", async () => {
    const spine = createSpine();
    const gateway = createGateway(spine);
    const command = createExistingSessionCommand();

    const result = await gateway.execute(command, DASHBOARD_OPERATOR);

    expect(spine.createRoomWithExistingSessions).toHaveBeenCalledWith(command.input);
    expect(result).toMatchObject({
      type: "room.create-existing-session.v1",
      projectId: PROJECT_ID,
      commandId: "create-existing-room-1",
      actor: { kind: "dashboard_operator", principalId: "operator-1" },
      value: { room: { id: "room-1", projectId: PROJECT_ID } },
    });
  });

  it("routes restore and safe-boundary membership requests through the authenticated operator", async () => {
    const spine = createSpine();
    const gateway = createGateway(spine);
    const restore = createRestoreExistingSessionsCommand();
    const add = createAddExistingSessionCommand();
    const remove = createRemoveExistingSessionCommand();

    const restoreResult = await gateway.execute(restore, DASHBOARD_OPERATOR);
    const addResult = await gateway.execute(add, DASHBOARD_OPERATOR);
    const removeResult = await gateway.execute(remove, DASHBOARD_OPERATOR);

    expect(spine.restoreRoomExistingSessions).toHaveBeenCalledWith(restore.input);
    expect(spine.requestAddExistingSessionAtTurnBoundary).toHaveBeenCalledWith(add.input);
    expect(spine.requestRemoveExistingSessionAtTurnBoundary).toHaveBeenCalledWith(remove.input);
    expect([restoreResult, addResult, removeResult]).toEqual([
      expect.objectContaining({
        type: "room.restore-existing-sessions.v1",
        actor: { kind: "dashboard_operator", principalId: "operator-1" },
        value: expect.objectContaining({ room: expect.objectContaining({ aggregateVersion: 3 }) }),
      }),
      expect.objectContaining({
        type: "room.request-add-existing-session.v1",
        actor: { kind: "dashboard_operator", principalId: "operator-1" },
        value: expect.objectContaining({ membershipVersion: 1 }),
      }),
      expect.objectContaining({
        type: "room.request-remove-existing-session.v1",
        actor: { kind: "dashboard_operator", principalId: "operator-1" },
        value: expect.objectContaining({ membershipVersion: 1 }),
      }),
    ]);

    await expect(gateway.execute(add, CONNECTOR_ADAPTER)).rejects.toMatchObject({
      code: "PROJECT_ROOM_COMMAND_PRINCIPAL_FORBIDDEN",
    });
  });

  it("rejects a top-level project scope mismatch before calling the spine", async () => {
    const spine = createSpine();
    const gateway = createGateway(spine);

    await expect(gateway.execute(createExistingSessionCommand("other-project"), DASHBOARD_OPERATOR))
      .rejects.toMatchObject<ProjectRoomCommandError>({
        code: "PROJECT_ROOM_COMMAND_PROJECT_MISMATCH",
      });

    expect(spine.createRoomWithExistingSessions).not.toHaveBeenCalled();
  });

  it("does not accept a payload actor as an escalation over the trusted principal", async () => {
    const spine = createSpine();
    const gateway = createGateway(spine);
    const command = {
      ...createStructuredProtocolCommand(),
      actor: { kind: "controller", principalId: "payload-forged-controller" },
      principal: { kind: "controller", principalId: "payload-forged-principal" },
    } as ProjectRoomCommandV1;

    await expect(gateway.execute(command, DASHBOARD_OPERATOR))
      .rejects.toMatchObject<ProjectRoomCommandError>({
        code: "PROJECT_ROOM_COMMAND_PRINCIPAL_FORBIDDEN",
      });
    expect(spine.routeStructuredProtocolMessage).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "anonymous", authenticated: false },
    { kind: "no_auth", authenticated: false },
  ] as const)("rejects $kind write callers", async (principal) => {
    const gateway = createGateway(createSpine());

    await expect(gateway.execute(createExistingSessionCommand(), principal))
      .rejects.toMatchObject<ProjectRoomCommandError>({
        code: "PROJECT_ROOM_COMMAND_PRINCIPAL_UNAUTHENTICATED",
      });
  });

  it("limits structured ingress and role transition to internal trusted principals", async () => {
    const spine = createSpine();
    const gateway = createGateway(spine);
    const structured = createStructuredProtocolCommand();
    const transition = createRoleTransitionCommand();

    await expect(gateway.execute(structured, DASHBOARD_OPERATOR))
      .rejects.toMatchObject<ProjectRoomCommandError>({
        code: "PROJECT_ROOM_COMMAND_PRINCIPAL_FORBIDDEN",
      });
    await expect(gateway.execute(transition, DASHBOARD_OPERATOR))
      .rejects.toMatchObject<ProjectRoomCommandError>({
        code: "PROJECT_ROOM_COMMAND_PRINCIPAL_FORBIDDEN",
      });

    await gateway.execute(structured, CONNECTOR_ADAPTER);
    await gateway.execute(transition, CONTROLLER);

    expect(spine.routeStructuredProtocolMessage).toHaveBeenCalledWith(structured.input);
    expect(spine.transitionRoleAssignmentAtCompletedTurnBoundary).toHaveBeenCalledWith(transition.input);
  });

  it("admits an operator message only as an authority-bound outbox command", async () => {
    const spine = createSpine();
    const gateway = createGateway(spine);
    const command = createSendToSeatCommand();

    const result = await gateway.execute(command, DASHBOARD_OPERATOR);

    expect(spine.routeOperatorMessageToSeat).toHaveBeenCalledWith(command.input);
    expect(result).toMatchObject({
      type: "room.send-to-seat.v1",
      actor: { kind: "dashboard_operator", principalId: "operator-1" },
      value: { deliveries: [{ id: "outbox-1", roomId: "room-1" }], event: { aggregateVersion: 2 } },
    });
    await expect(gateway.execute(command, CONNECTOR_ADAPTER)).rejects.toMatchObject({
      code: "PROJECT_ROOM_COMMAND_PRINCIPAL_FORBIDDEN",
    });
  });

  it("admits a bounded Evolution Shadow receipt only from the authenticated dashboard operator", async () => {
    const shadowResult: RoomEvolutionAuthorizedShadowResultV1 = {
      status: "shadow_recorded",
      receipt: {
        experimentId: "evolution-shadow-1",
        projectId: PROJECT_ID,
        roomId: "room-1",
        hypothesisId: "hypothesis-1",
        candidateVersionId: "candidate-1",
        state: "planned",
        capacityPool: "evolution_paused",
        createdAt: "2026-07-19T10:15:00.000Z",
      },
    };
    const evolutionShadow = {
      record: vi.fn(async () => shadowResult),
    } as unknown as RoomEvolutionAuthorizedShadowRunner;
    const gateway = createGateway(createSpine(), evolutionShadow);
    const command = createEvolutionShadowCommand();

    const result = await gateway.execute(command, DASHBOARD_OPERATOR);

    expect(result).toMatchObject({
      type: "room.record-evolution-shadow.v1",
      projectId: PROJECT_ID,
      commandId: "record-evolution-shadow-1",
      actor: { kind: "dashboard_operator", principalId: "operator-1" },
      value: shadowResult,
    });
    expect(evolutionShadow.record).toHaveBeenCalledWith({
      ...command.input,
      commandId: command.commandId,
    }, { kind: "dashboard_operator", principalId: "operator-1" });
    await expect(gateway.execute(command, CONTROLLER)).rejects.toMatchObject({
      code: "PROJECT_ROOM_COMMAND_PRINCIPAL_FORBIDDEN",
    });
    expect(evolutionShadow.record).toHaveBeenCalledTimes(1);
  });

  it("fails closed while the project Engine has no live Room spine", async () => {
    const gateway = createGateway(null);

    await expect(gateway.execute(createExistingSessionCommand(), DASHBOARD_OPERATOR))
      .rejects.toMatchObject<ProjectRoomCommandError>({
        code: "PROJECT_ROOM_COMMAND_ENGINE_UNAVAILABLE",
      });
  });

  it("rejects malformed commands before resolving the spine", async () => {
    const spine = createSpine();
    const gateway = createGateway(spine);
    const command = {
      ...createExistingSessionCommand(),
      commandId: " ",
    } as ProjectRoomCommandV1;

    await expect(gateway.execute(command, DASHBOARD_OPERATOR))
      .rejects.toMatchObject<ProjectRoomCommandError>({
        code: "PROJECT_ROOM_COMMAND_INVALID",
      });
    expect(spine.createRoomWithExistingSessions).not.toHaveBeenCalled();
  });
});

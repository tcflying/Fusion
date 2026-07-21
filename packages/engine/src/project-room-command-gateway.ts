import type {
  RoomAggregateV1,
  RoomPhaseGateEvidenceProjectionV1,
  RoomRoleAssignmentProjectionV1,
  RouteRoomProtocolMessageResultV1,
  RouteOperatorMessageResultV1,
} from "@fusion/core";
import type {
  CreateRoomWithExistingSessionsInput,
  RoomExistingSessionSpine,
  RecordRoomPhaseGateEvidenceAtCompletedTurnBoundaryInput,
  RouteStructuredRoomProtocolMessageInput,
  SendToRoomSeatInput,
  TransitionRoomRoleAssignmentAtCompletedTurnBoundaryInput,
} from "./room-existing-session-spine.js";
import type {
  RoomExistingSessionPreflightRequestV1,
  RoomExistingSessionPreflightResultV1,
  RoomExistingSessionPreflightService,
} from "./room-existing-session-preflight.js";
import type {
  RecordRoomEvolutionAuthorizedShadowInputV1,
  RoomEvolutionAuthorizedShadowResultV1,
  RoomEvolutionAuthorizedShadowRunner,
} from "./room-evolution-authorized-shadow.js";

export type ProjectRoomCommandPrincipalKindV1 =
  | "dashboard_operator"
  | "controller"
  | "connector_adapter"
  | "anonymous"
  | "no_auth";

/**
 * This value is constructed by an authenticated server-side caller, never from
 * an HTTP body or a Room command payload. `anonymous` and `no_auth` are kept in
 * the input union so the command boundary can reject them explicitly.
 */
export type ProjectRoomTrustedPrincipalV1 =
  | {
      readonly kind: "dashboard_operator" | "controller" | "connector_adapter";
      readonly principalId: string;
      readonly authenticated: true;
    }
  | {
      readonly kind: "anonymous" | "no_auth";
      readonly principalId?: null;
      readonly authenticated: false;
    };

export interface ProjectRoomCommandActorV1 {
  readonly kind: Exclude<ProjectRoomCommandPrincipalKindV1, "anonymous" | "no_auth">;
  readonly principalId: string;
}

export interface ProjectRoomCreateExistingSessionCommandV1 {
  readonly type: "room.create-existing-session.v1";
  readonly projectId: string;
  readonly commandId: string;
  readonly input: CreateRoomWithExistingSessionsInput;
}

/**
 * A read-only cockpit import probe. This deliberately does not run
 * `ensureExisting` or create any Room/binding/provider state.
 */
export interface ProjectRoomPreflightExistingSessionCommandV1 {
  readonly type: "room.preflight-existing-session.v1";
  readonly projectId: string;
  readonly commandId: string;
  readonly input: RoomExistingSessionPreflightRequestV1;
}

export interface ProjectRoomIngestStructuredProtocolCommandV1 {
  readonly type: "room.ingest-structured-protocol.v1";
  readonly projectId: string;
  readonly commandId: string;
  readonly input: RouteStructuredRoomProtocolMessageInput;
}

export interface ProjectRoomTransitionRoleAssignmentCommandV1 {
  readonly type: "room.transition-role-assignment.v1";
  readonly projectId: string;
  readonly commandId: string;
  readonly input: TransitionRoomRoleAssignmentAtCompletedTurnBoundaryInput;
}

export interface ProjectRoomRecordPhaseGateEvidenceCommandV1 {
  readonly type: "room.record-phase-gate-evidence.v1";
  readonly projectId: string;
  readonly commandId: string;
  readonly input: RecordRoomPhaseGateEvidenceAtCompletedTurnBoundaryInput;
}

export interface ProjectRoomSendToSeatCommandV1 {
  readonly type: "room.send-to-seat.v1";
  readonly projectId: string;
  readonly commandId: string;
  readonly input: SendToRoomSeatInput;
}

export interface ProjectRoomRecordEvolutionShadowCommandV1 {
  readonly type: "room.record-evolution-shadow.v1";
  readonly projectId: string;
  readonly commandId: string;
  /** The gateway alone supplies commandId from its authenticated command envelope. */
  readonly input: Omit<RecordRoomEvolutionAuthorizedShadowInputV1, "commandId">;
}

export type ProjectRoomCommandV1 =
  | ProjectRoomPreflightExistingSessionCommandV1
  | ProjectRoomCreateExistingSessionCommandV1
  | ProjectRoomIngestStructuredProtocolCommandV1
  | ProjectRoomRecordPhaseGateEvidenceCommandV1
  | ProjectRoomTransitionRoleAssignmentCommandV1
  | ProjectRoomSendToSeatCommandV1
  | ProjectRoomRecordEvolutionShadowCommandV1;

interface ProjectRoomCommandResultBaseV1 {
  readonly projectId: string;
  readonly commandId: string;
  /** Trusted gateway identity for the caller; this is not taken from command payload. */
  readonly actor: ProjectRoomCommandActorV1;
}

export type ProjectRoomCommandResultV1 =
  | (ProjectRoomCommandResultBaseV1 & {
      readonly type: "room.preflight-existing-session.v1";
      readonly value: RoomExistingSessionPreflightResultV1;
    })
  | (ProjectRoomCommandResultBaseV1 & {
      readonly type: "room.create-existing-session.v1";
      readonly value: RoomAggregateV1;
    })
  | (ProjectRoomCommandResultBaseV1 & {
      readonly type: "room.ingest-structured-protocol.v1";
      readonly value: RouteRoomProtocolMessageResultV1;
    })
  | (ProjectRoomCommandResultBaseV1 & {
      readonly type: "room.record-phase-gate-evidence.v1";
      readonly value: RoomPhaseGateEvidenceProjectionV1;
    })
  | (ProjectRoomCommandResultBaseV1 & {
      readonly type: "room.transition-role-assignment.v1";
      readonly value: RoomRoleAssignmentProjectionV1;
    })
  | (ProjectRoomCommandResultBaseV1 & {
      readonly type: "room.send-to-seat.v1";
      readonly value: RouteOperatorMessageResultV1;
    })
  | (ProjectRoomCommandResultBaseV1 & {
      readonly type: "room.record-evolution-shadow.v1";
      readonly value: RoomEvolutionAuthorizedShadowResultV1;
    });

export type ProjectRoomCommandErrorCode =
  | "PROJECT_ROOM_COMMAND_ENGINE_UNAVAILABLE"
  | "PROJECT_ROOM_COMMAND_INVALID"
  | "PROJECT_ROOM_COMMAND_PROJECT_MISMATCH"
  | "PROJECT_ROOM_COMMAND_PRINCIPAL_UNAUTHENTICATED"
  | "PROJECT_ROOM_COMMAND_PRINCIPAL_FORBIDDEN";

export class ProjectRoomCommandError extends Error {
  constructor(
    readonly code: ProjectRoomCommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectRoomCommandError";
  }
}

export type ProjectRoomCommandSpineV1 = Pick<
  RoomExistingSessionSpine,
  | "createRoomWithExistingSessions"
  | "routeStructuredProtocolMessage"
  | "recordPhaseGateEvidenceAtCompletedTurnBoundary"
  | "transitionRoleAssignmentAtCompletedTurnBoundary"
  | "routeOperatorMessageToSeat"
>;

export type ProjectRoomExistingSessionPreflightV1 = Pick<
  RoomExistingSessionPreflightService,
  "preflight"
>;

export type ProjectRoomEvolutionShadowRunnerV1 = Pick<RoomEvolutionAuthorizedShadowRunner, "record">;

export interface ProjectRoomCommandGatewayOptions {
  readonly projectId: string;
  /** Returns null whenever the project engine has not completed Room startup or is stopping. */
  readonly resolveSpine: () => ProjectRoomCommandSpineV1 | null;
  /** Read-only existing-session identity/health probe available before dispatch composition is ready. */
  readonly resolvePreflight?: () => ProjectRoomExistingSessionPreflightV1 | null;
  /** Returns null whenever the bounded evolution receipt runner is not lifecycle-ready. */
  readonly resolveEvolutionShadow?: () => ProjectRoomEvolutionShadowRunnerV1 | null;
}

/*
FNXC:SessionRoomCommandGateway 2026-07-19-07:01:
Room writes need one project-scoped Engine boundary rather than a Dashboard
caller retaining the raw Existing-Session spine. The boundary admits only an
already authenticated server-side principal, never trusts a payload actor, and
keeps protocol ingress and role changes controller-only. It deliberately does
not claim to close Core's separate durable gate-evidence/RBAC work.

FNXC:SessionRoomCommandGateway 2026-07-19-17:12:
Operator messages may use this same boundary only as authority-bound outbox
intents. The gateway does not mint or widen an envelope; Core remains the
enforcer for target, content hash, optimistic version, and message-only scope.

FNXC:RoomEvolutionShadow 2026-07-19-19:07:
An Evolution Shadow request is admitted only from the authenticated dashboard
operator and receives the gateway-owned command id. It reaches a bounded
ledger receipt runner, never the source-candidate, provider, evaluator,
canary, promotion, or rollback paths.
*/
export class ProjectRoomCommandGateway {
  constructor(private readonly options: ProjectRoomCommandGatewayOptions) {
    assertNonEmptyString(options.projectId, "projectId");
  }

  async execute(
    command: ProjectRoomCommandV1,
    trustedPrincipal: ProjectRoomTrustedPrincipalV1,
  ): Promise<ProjectRoomCommandResultV1> {
    const actor = toTrustedActor(trustedPrincipal);
    assertCommand(command);
    this.assertProjectScope(command);
    assertCommandPermission(command.type, actor);

    if (command.type === "room.preflight-existing-session.v1") {
      const preflight = this.options.resolvePreflight?.() ?? null;
      if (!preflight) {
        throw new ProjectRoomCommandError(
          "PROJECT_ROOM_COMMAND_ENGINE_UNAVAILABLE",
          "The project Room existing-session preflight is unavailable until connector discovery has completed",
        );
      }
      const value = await preflight.preflight(command.input);
      return {
        type: command.type,
        projectId: this.options.projectId,
        commandId: command.commandId,
        actor,
        value,
      };
    }

    if (command.type === "room.record-evolution-shadow.v1") {
      const evolutionShadow = this.options.resolveEvolutionShadow?.() ?? null;
      if (!evolutionShadow) {
        throw new ProjectRoomCommandError(
          "PROJECT_ROOM_COMMAND_ENGINE_UNAVAILABLE",
          "The project Room Evolution Shadow runner is unavailable until the Engine Room lifecycle is running",
        );
      }
      const value = await evolutionShadow.record({
        contractVersion: command.input.contractVersion,
        commandId: command.commandId,
        roomId: command.input.roomId,
        hypothesisId: command.input.hypothesisId,
        candidateVersionId: command.input.candidateVersionId,
      }, actor);
      return {
        type: command.type,
        projectId: this.options.projectId,
        commandId: command.commandId,
        actor,
        value,
      };
    }

    const spine = this.options.resolveSpine();
    if (!spine) {
      throw new ProjectRoomCommandError(
        "PROJECT_ROOM_COMMAND_ENGINE_UNAVAILABLE",
        "The project Room command gateway is unavailable until the Engine Room lifecycle is running",
      );
    }

    switch (command.type) {
      case "room.create-existing-session.v1": {
        const value = await spine.createRoomWithExistingSessions(command.input);
        return {
          type: command.type,
          projectId: this.options.projectId,
          commandId: command.commandId,
          actor,
          value,
        };
      }
      case "room.ingest-structured-protocol.v1": {
        const value = await spine.routeStructuredProtocolMessage(command.input);
        return {
          type: command.type,
          projectId: this.options.projectId,
          commandId: command.commandId,
          actor,
          value,
        };
      }
      case "room.transition-role-assignment.v1": {
        const value = await spine.transitionRoleAssignmentAtCompletedTurnBoundary(command.input);
        return {
          type: command.type,
          projectId: this.options.projectId,
          commandId: command.commandId,
          actor,
          value,
        };
      }
      case "room.record-phase-gate-evidence.v1": {
        const value = await spine.recordPhaseGateEvidenceAtCompletedTurnBoundary(command.input);
        return {
          type: command.type,
          projectId: this.options.projectId,
          commandId: command.commandId,
          actor,
          value,
        };
      }
      case "room.send-to-seat.v1": {
        const value = await spine.routeOperatorMessageToSeat(command.input);
        return {
          type: command.type,
          projectId: this.options.projectId,
          commandId: command.commandId,
          actor,
          value,
        };
      }
      default:
        throw new ProjectRoomCommandError(
          "PROJECT_ROOM_COMMAND_INVALID",
          `Unsupported project Room command type ${String((command as { type?: unknown }).type)}`,
        );
    }
  }

  private assertProjectScope(command: ProjectRoomCommandV1): void {
    if (command.projectId !== this.options.projectId) {
      throw new ProjectRoomCommandError(
        "PROJECT_ROOM_COMMAND_PROJECT_MISMATCH",
        "The Room command projectId does not match the owning ProjectEngine",
      );
    }
  }
}

function toTrustedActor(principal: ProjectRoomTrustedPrincipalV1): ProjectRoomCommandActorV1 {
  if (!isRecord(principal) || principal.authenticated !== true) {
    throw new ProjectRoomCommandError(
      "PROJECT_ROOM_COMMAND_PRINCIPAL_UNAUTHENTICATED",
      "Anonymous and no-auth callers cannot issue Room write commands",
    );
  }
  if (
    principal.kind !== "dashboard_operator"
    && principal.kind !== "controller"
    && principal.kind !== "connector_adapter"
  ) {
    throw new ProjectRoomCommandError(
      "PROJECT_ROOM_COMMAND_PRINCIPAL_UNAUTHENTICATED",
      "The Room command principal is not an authenticated trusted caller",
    );
  }
  if (typeof principal.principalId !== "string" || !principal.principalId.trim()) {
    throw new ProjectRoomCommandError(
      "PROJECT_ROOM_COMMAND_INVALID",
      "An authenticated Room command principal requires a non-empty principalId",
    );
  }
  return { kind: principal.kind, principalId: principal.principalId };
}

function assertCommand(command: ProjectRoomCommandV1): void {
  if (!isRecord(command)) {
    throw new ProjectRoomCommandError(
      "PROJECT_ROOM_COMMAND_INVALID",
      "A Room command must be a structured object",
    );
  }
  assertNonEmptyString(command.projectId, "command.projectId");
  assertNonEmptyString(command.commandId, "command.commandId");
  if (
    command.type !== "room.create-existing-session.v1"
    && command.type !== "room.preflight-existing-session.v1"
    && command.type !== "room.ingest-structured-protocol.v1"
    && command.type !== "room.record-phase-gate-evidence.v1"
    && command.type !== "room.transition-role-assignment.v1"
    && command.type !== "room.send-to-seat.v1"
    && command.type !== "room.record-evolution-shadow.v1"
  ) {
    throw new ProjectRoomCommandError(
      "PROJECT_ROOM_COMMAND_INVALID",
      `Unsupported project Room command type ${String(command.type)}`,
    );
  }
}

function assertCommandPermission(
  commandType: ProjectRoomCommandV1["type"],
  actor: ProjectRoomCommandActorV1,
): void {
  const permitted = (
    commandType === "room.preflight-existing-session.v1"
      ? actor.kind === "dashboard_operator" || actor.kind === "controller"
      : commandType === "room.create-existing-session.v1"
      ? actor.kind === "dashboard_operator" || actor.kind === "controller"
    : commandType === "room.record-evolution-shadow.v1"
      ? actor.kind === "dashboard_operator"
    : commandType === "room.ingest-structured-protocol.v1"
      ? actor.kind === "controller" || actor.kind === "connector_adapter"
      : commandType === "room.send-to-seat.v1"
        ? actor.kind === "dashboard_operator" || actor.kind === "controller"
        : actor.kind === "controller"
  );
  if (!permitted) {
    throw new ProjectRoomCommandError(
      "PROJECT_ROOM_COMMAND_PRINCIPAL_FORBIDDEN",
      `Principal kind ${actor.kind} cannot execute ${commandType}`,
    );
  }
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ProjectRoomCommandError(
      "PROJECT_ROOM_COMMAND_INVALID",
      `${field} must be a non-empty string`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

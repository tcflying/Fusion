import type { Request } from "express";
import {
  ROOM_AUTHORITY_CONTRACT_BOUNDS,
  type RoomAuthorityEnvelopeV1,
  type RoomMessageIntent,
} from "@fusion/core";
import type { ProjectEngine } from "@fusion/engine";
import { ApiError } from "./api-error.js";
import type {
  RoomControlPlaneAuthorizationInput,
  RoomControlPlaneAuthorizationDecision,
  RoomControlPlaneLiveEventPortV1,
  RoomControlPlaneLiveEventReconnectInputV1,
  RoomControlPlaneLiveEventReconnectResultV1,
  RoomControlPlaneLiveEventScopeV1,
  RoomControlPlaneListRoomsInputV1,
  RoomControlPlaneMutationInputV1,
  RoomControlPlaneMutationResultV1,
  RoomControlPlanePageV1,
  RoomControlPlaneResourceReadInputV1,
  RoomControlPlaneRoomProjectionInputV1,
  RoomControlPlaneRouteDependencies,
  RoomControlPlaneRoutePort,
} from "./routes/register-room-control-plane-routes.js";
import type { ProjectContext } from "./routes/types.js";

export type RoomControlPlaneProjectEngine = Pick<
  ProjectEngine,
  "getProjectId" | "getRoomControlPlaneReadService" | "getRoomControlPlaneLiveEventService" | "executeProjectRoomCommand"
>;

type RoomControlPlaneReadService = NonNullable<
  ReturnType<RoomControlPlaneProjectEngine["getRoomControlPlaneReadService"]>
>;
type RoomControlPlaneLiveEventService = NonNullable<
  ReturnType<RoomControlPlaneProjectEngine["getRoomControlPlaneLiveEventService"]>
>;
type RoomControlPlaneOperatorMessageCommand = Extract<
  Parameters<RoomControlPlaneProjectEngine["executeProjectRoomCommand"]>[0],
  { readonly type: "room.send-to-seat.v1" }
>;
type RoomControlPlaneTrustedPrincipal = Parameters<
  RoomControlPlaneProjectEngine["executeProjectRoomCommand"]
>[1];

export interface RoomControlPlaneEngineResolverInput {
  readonly request: Request;
  readonly projectId: string;
  readonly store: ProjectContext["store"];
  readonly actorId: string;
}

export type RoomControlPlaneEngineResolver = (
  input: RoomControlPlaneEngineResolverInput,
) => RoomControlPlaneProjectEngine | null | undefined | Promise<RoomControlPlaneProjectEngine | null | undefined>;

export interface RoomControlPlaneEngineRouteDependenciesOptions {
  readonly authorizeProject: (
    input: RoomControlPlaneAuthorizationInput,
  ) => Promise<RoomControlPlaneAuthorizationDecision>;
  readonly resolveProjectEngine: RoomControlPlaneEngineResolver;
}

type ReadServiceLike = Pick<RoomControlPlaneReadService, "listRooms" | "getRoomProjection">;
type LiveEventServiceLike = Pick<RoomControlPlaneLiveEventService, "reconnect" | "subscribe">;
type ResolvedEngineReadService = {
  readonly engine: RoomControlPlaneProjectEngine;
  readonly service: ReadServiceLike;
};

const ROOM_MESSAGE_INTENTS = [
  "instruction",
  "proposal",
  "question",
  "critique",
  "challenge",
  "verdict",
  "handoff",
  "help_request",
] as const satisfies readonly RoomMessageIntent[];
const OPERATOR_MESSAGE_PAYLOAD_KEYS = ["seatId", "intent", "content", "authorityEnvelope"] as const;

function isNonEmptyIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256;
}

function isProjectEngine(value: unknown): value is RoomControlPlaneProjectEngine {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    getProjectId?: unknown;
    getRoomControlPlaneReadService?: unknown;
    getRoomControlPlaneLiveEventService?: unknown;
    executeProjectRoomCommand?: unknown;
  };
  return typeof candidate.getProjectId === "function"
    && typeof candidate.getRoomControlPlaneReadService === "function"
    && typeof candidate.getRoomControlPlaneLiveEventService === "function"
    && typeof candidate.executeProjectRoomCommand === "function";
}

function isReadService(value: unknown): value is ReadServiceLike {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    listRooms?: unknown;
    getRoomProjection?: unknown;
  };
  return typeof candidate.listRooms === "function"
    && typeof candidate.getRoomProjection === "function";
}

function isLiveEventService(value: unknown): value is LiveEventServiceLike {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { reconnect?: unknown; subscribe?: unknown };
  return typeof candidate.reconnect === "function" && typeof candidate.subscribe === "function";
}

function unavailable(code: string, message: string, projectId: string): ApiError {
  return new ApiError(503, message, { code, projectId });
}

function assertPortProject(projectId: string, expectedProjectId: string): void {
  if (!isNonEmptyIdentifier(projectId) || projectId !== expectedProjectId) {
    throw new ApiError(403, "Room control-plane route port cannot cross project scope", {
      code: "ROOM_CONTROL_PLANE_PORT_PROJECT_SCOPE_MISMATCH",
      projectId,
    });
  }
}

function assertLiveEventScope(
  input: RoomControlPlaneLiveEventScopeV1,
  expectedProjectId: string,
): void {
  assertPortProject(input.projectId, expectedProjectId);
  if (!isNonEmptyIdentifier(input.roomId)) {
    throw new ApiError(400, "Room live event delivery requires a bounded Room identifier.", {
      code: "ROOM_EVENT_PORT_ROOM_SCOPE_INVALID",
    });
  }
}

function assertEngineProject(engine: RoomControlPlaneProjectEngine, projectId: string): void {
  let engineProjectId: string;
  try {
    engineProjectId = engine.getProjectId();
  } catch (_error) {
    throw unavailable(
      "ROOM_PROJECT_ENGINE_UNAVAILABLE",
      "The project Engine is unavailable for Room live events.",
      projectId,
    );
  }
  if (!isNonEmptyIdentifier(engineProjectId) || engineProjectId !== projectId) {
    throw unavailable(
      "ROOM_ENGINE_PROJECT_MISMATCH",
      "The resolved Engine does not belong to the requested project.",
      projectId,
    );
  }
}

function resolveLiveEventService(
  engine: RoomControlPlaneProjectEngine,
  projectId: string,
): LiveEventServiceLike {
  assertEngineProject(engine, projectId);
  let service: unknown;
  try {
    service = engine.getRoomControlPlaneLiveEventService();
  } catch (_error) {
    throw unavailable(
      "ROOM_CONTROL_PLANE_LIVE_EVENT_SERVICE_UNAVAILABLE",
      "The project Room live event service is unavailable.",
      projectId,
    );
  }
  if (service === null || service === undefined) {
    throw unavailable(
      "ROOM_CONTROL_PLANE_LIVE_EVENT_SERVICE_UNAVAILABLE",
      "The project Room live event service is unavailable or disabled.",
      projectId,
    );
  }
  if (!isLiveEventService(service)) {
    throw unavailable(
      "ROOM_CONTROL_PLANE_LIVE_EVENT_SERVICE_INVALID",
      "The project Room live event service does not expose the canonical cursor boundary.",
      projectId,
    );
  }
  return service;
}

function createLiveEventPort(
  projectId: string,
  service: LiveEventServiceLike,
): RoomControlPlaneLiveEventPortV1 {
  return {
    async reconnect(input: RoomControlPlaneLiveEventReconnectInputV1): Promise<RoomControlPlaneLiveEventReconnectResultV1> {
      assertLiveEventScope(input, projectId);
      let result: unknown;
      try {
        result = await service.reconnect({
          projectId: input.projectId,
          roomId: input.roomId,
          afterCursor: input.afterCursor,
          limit: input.limit,
        });
      } catch (_error) {
        throw unavailable(
          "ROOM_CONTROL_PLANE_LIVE_EVENT_RECONNECT_UNAVAILABLE",
          "The project Room canonical event replay is unavailable.",
          projectId,
        );
      }
      return result as RoomControlPlaneLiveEventReconnectResultV1;
    },
    subscribe(input, listener): () => void {
      assertLiveEventScope(input, projectId);
      if (typeof listener !== "function") {
        throw new ApiError(503, "Room live event listener boundary is invalid.", {
          code: "ROOM_EVENT_PORT_LISTENER_INVALID",
        });
      }
      let unsubscribe: unknown;
      try {
        unsubscribe = service.subscribe(
          { projectId: input.projectId, roomId: input.roomId },
          (notification) => listener(notification as never),
        );
      } catch (_error) {
        throw unavailable(
          "ROOM_CONTROL_PLANE_LIVE_EVENT_SUBSCRIBE_UNAVAILABLE",
          "The project Room live event subscription is unavailable.",
          projectId,
        );
      }
      if (typeof unsubscribe !== "function") {
        throw unavailable(
          "ROOM_CONTROL_PLANE_LIVE_EVENT_SUBSCRIBE_INVALID",
          "The project Room live event subscription is unavailable.",
          projectId,
        );
      }
      return unsubscribe as () => void;
    },
  };
}

async function resolveReadService(
  resolver: RoomControlPlaneEngineResolver,
  input: RoomControlPlaneEngineResolverInput,
): Promise<ResolvedEngineReadService> {
  let candidate: RoomControlPlaneProjectEngine | null | undefined;
  try {
    candidate = await resolver(input);
  } catch (_error) {
    throw unavailable(
      "ROOM_PROJECT_ENGINE_UNAVAILABLE",
      "The project Engine is unavailable for Room control-plane reads.",
      input.projectId,
    );
  }

  if (!candidate) {
    throw unavailable(
      "ROOM_PROJECT_ENGINE_UNAVAILABLE",
      "The project Engine is unavailable for Room control-plane reads.",
      input.projectId,
    );
  }
  if (!isProjectEngine(candidate)) {
    throw unavailable(
      "ROOM_PROJECT_ENGINE_INVALID",
      "The resolved project Engine does not expose the required Room control-plane boundary.",
      input.projectId,
    );
  }

  let engineProjectId: string;
  try {
    engineProjectId = candidate.getProjectId();
  } catch (_error) {
    throw unavailable(
      "ROOM_PROJECT_ENGINE_UNAVAILABLE",
      "The project Engine is unavailable for Room control-plane reads.",
      input.projectId,
    );
  }
  if (!isNonEmptyIdentifier(engineProjectId) || engineProjectId !== input.projectId) {
    throw unavailable(
      "ROOM_ENGINE_PROJECT_MISMATCH",
      "The resolved Engine does not belong to the requested project.",
      input.projectId,
    );
  }

  let service: unknown;
  try {
    service = candidate.getRoomControlPlaneReadService();
  } catch (_error) {
    throw unavailable(
      "ROOM_CONTROL_PLANE_READ_SERVICE_UNAVAILABLE",
      "The project Room control-plane read service is unavailable.",
      input.projectId,
    );
  }
  if (service === null || service === undefined) {
    throw unavailable(
      "ROOM_CONTROL_PLANE_READ_SERVICE_UNAVAILABLE",
      "The project Room control-plane read service is unavailable or disabled.",
      input.projectId,
    );
  }
  if (!isReadService(service)) {
    throw unavailable(
      "ROOM_CONTROL_PLANE_READ_SERVICE_INVALID",
      "The project Room control-plane read service does not expose canonical read operations.",
      input.projectId,
    );
  }
  return { engine: candidate, service };
}

function unsupportedResourceRead(input: RoomControlPlaneResourceReadInputV1): never {
  throw new ApiError(501, "This Room resource is not available from the Engine read service.", {
    code: "ROOM_CONTROL_PLANE_RESOURCE_READ_UNSUPPORTED",
    projectId: input.projectId,
    roomId: input.roomId,
    resource: input.resource,
  });
}

function unsupportedMutation(input: RoomControlPlaneMutationInputV1): never {
  throw new ApiError(501, "Room control-plane mutations are not available from the Engine read service.", {
    code: "ROOM_CONTROL_PLANE_MUTATION_UNSUPPORTED",
    projectId: input.projectId,
    roomId: input.roomId,
    resource: input.resource,
    operation: input.operation,
    action: input.action,
  });
}

function invalidOperatorMessageMutation(input: RoomControlPlaneMutationInputV1, message: string): never {
  throw new ApiError(400, message, {
    code: "ROOM_CONTROL_PLANE_OPERATOR_ACTION_INVALID",
    projectId: input.projectId,
    roomId: input.roomId,
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactOperatorMessagePayloadKeys(value: Readonly<Record<string, unknown>>): boolean {
  const keys = Object.keys(value);
  return keys.length === OPERATOR_MESSAGE_PAYLOAD_KEYS.length
    && OPERATOR_MESSAGE_PAYLOAD_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isRoomMessageIntent(value: unknown): value is RoomMessageIntent {
  return typeof value === "string" && (ROOM_MESSAGE_INTENTS as readonly string[]).includes(value);
}

function isBoundedOperatorMessageContent(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= ROOM_AUTHORITY_CONTRACT_BOUNDS.maxContentLength;
}

/*
FNXC:RoomControlPlaneEngineRoute 2026-07-19-17:20:
Dashboard exposes exactly one Room write: a project-scoped operator send to one seat.
The route-derived room, command, and actor identities are authoritative; payloads cannot
replace them or provide idempotency/correlation values. Keep the authority envelope opaque
and unchanged so Core/Engine remain its sole validator, signer, and scope enforcer.
Success is acknowledged only from the Engine's canonical event aggregateVersion.
*/
function createOperatorMessageCommand(input: RoomControlPlaneMutationInputV1): RoomControlPlaneOperatorMessageCommand {
  if (!isNonEmptyIdentifier(input.roomId)) {
    return invalidOperatorMessageMutation(input, "Room operator actions require a non-empty routed roomId.");
  }
  if (!isNonEmptyIdentifier(input.commandId)) {
    return invalidOperatorMessageMutation(input, "Room operator actions require a non-empty routed commandId.");
  }
  if (!isNonEmptyIdentifier(input.actorId)) {
    return invalidOperatorMessageMutation(input, "Room operator actions require an authorized operator identity.");
  }
  if (!isRecord(input.payload) || !hasExactOperatorMessagePayloadKeys(input.payload)) {
    return invalidOperatorMessageMutation(
      input,
      "Room operator message payloads may contain only seatId, intent, content, and authorityEnvelope.",
    );
  }

  const { seatId, intent, content, authorityEnvelope } = input.payload;
  if (!isNonEmptyIdentifier(seatId) || !isRoomMessageIntent(intent) || !isBoundedOperatorMessageContent(content)) {
    return invalidOperatorMessageMutation(input, "Room operator message payload is invalid.");
  }
  if (!isRecord(authorityEnvelope)) {
    return invalidOperatorMessageMutation(input, "Room operator messages require an authorityEnvelope object.");
  }

  return {
    type: "room.send-to-seat.v1",
    projectId: input.projectId,
    commandId: input.commandId,
    input: {
      roomId: input.roomId,
      seatId,
      expectedAggregateVersion: input.expectedAggregateVersion,
      commandId: input.commandId,
      idempotencyKey: input.commandId,
      correlationId: input.commandId,
      intent,
      content,
      authorityEnvelope: authorityEnvelope as unknown as RoomAuthorityEnvelopeV1,
    },
  };
}

function canonicalAggregateVersion(
  value: unknown,
  input: RoomControlPlaneMutationInputV1,
): number {
  const result = isRecord(value) ? value : null;
  const resultValue = result
    && result.type === "room.send-to-seat.v1"
    && result.projectId === input.projectId
    && result.commandId === input.commandId
    && isRecord(result.value)
    ? result.value
    : null;
  const event = resultValue && isRecord(resultValue.event) ? resultValue.event : null;
  const aggregateVersion = event?.aggregateVersion;
  if (
    typeof aggregateVersion !== "number"
    || !Number.isInteger(aggregateVersion)
    || aggregateVersion < 0
  ) {
    throw unavailable(
      "ROOM_CONTROL_PLANE_MUTATION_RESPONSE_INVALID",
      "The project Engine returned an invalid Room operator action result.",
      input.projectId,
    );
  }
  return aggregateVersion;
}

async function mutateOperatorMessage(
  engine: RoomControlPlaneProjectEngine,
  input: RoomControlPlaneMutationInputV1,
): Promise<RoomControlPlaneMutationResultV1> {
  const command = createOperatorMessageCommand(input);
  const trustedPrincipal: RoomControlPlaneTrustedPrincipal = {
    kind: "dashboard_operator",
    principalId: input.actorId,
    authenticated: true,
  };

  let result: unknown;
  try {
    result = await engine.executeProjectRoomCommand(command, trustedPrincipal);
  } catch (_error) {
    throw unavailable(
      "ROOM_PROJECT_ENGINE_UNAVAILABLE",
      "The project Engine is unavailable for Room control-plane mutations.",
      input.projectId,
    );
  }

  return { accepted: true, aggregateVersion: canonicalAggregateVersion(result, input) };
}

function createEngineBackedPort(
  projectId: string,
  engine: RoomControlPlaneProjectEngine,
  service: ReadServiceLike,
): RoomControlPlaneRoutePort {
  return {
    async listRooms(input: RoomControlPlaneListRoomsInputV1): Promise<RoomControlPlanePageV1> {
      assertPortProject(input.projectId, projectId);
      return await service.listRooms(input);
    },
    async getRoomProjection(input: RoomControlPlaneRoomProjectionInputV1): Promise<unknown | null> {
      assertPortProject(input.projectId, projectId);
      return await service.getRoomProjection(input);
    },
    async listResource(input: RoomControlPlaneResourceReadInputV1): Promise<RoomControlPlanePageV1> {
      assertPortProject(input.projectId, projectId);
      return unsupportedResourceRead(input);
    },
    async openRoomEventCursor(input) {
      assertPortProject(input.projectId, projectId);
      if (!isNonEmptyIdentifier(input.roomId)) {
        throw new ApiError(400, "Room live event delivery requires a bounded Room identifier.", {
          code: "ROOM_EVENT_PORT_ROOM_SCOPE_INVALID",
        });
      }
      return createLiveEventPort(projectId, resolveLiveEventService(engine, projectId));
    },
    async mutate(input: RoomControlPlaneMutationInputV1): Promise<RoomControlPlaneMutationResultV1> {
      assertPortProject(input.projectId, projectId);
      if (input.resource === "room" && input.operation === "operator_action" && input.action === "send_to_seat") {
        return await mutateOperatorMessage(engine, input);
      }
      return unsupportedMutation(input);
    },
  };
}

export function createRoomControlPlaneEngineRouteDependencies(
  options: RoomControlPlaneEngineRouteDependenciesOptions,
): RoomControlPlaneRouteDependencies {
  if (!options || typeof options.authorizeProject !== "function") {
    throw new TypeError("Room control-plane Engine route dependencies require an explicit authorizeProject callback.");
  }
  if (typeof options.resolveProjectEngine !== "function") {
    throw new TypeError("Room control-plane Engine route dependencies require a project Engine resolver.");
  }

  return {
    authorizeProject: options.authorizeProject,
    async resolvePort(input): Promise<RoomControlPlaneRoutePort> {
      if (!isNonEmptyIdentifier(input.projectId)) {
        throw new ApiError(403, "Room control-plane routes require a bounded project scope.", {
          code: "ROOM_CONTROL_PLANE_PORT_PROJECT_SCOPE_INVALID",
        });
      }
      const { engine, service } = await resolveReadService(options.resolveProjectEngine, input);
      return createEngineBackedPort(input.projectId, engine, service);
    },
  };
}

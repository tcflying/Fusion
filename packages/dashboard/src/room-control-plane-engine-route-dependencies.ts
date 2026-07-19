import type { Request } from "express";
import type { ProjectEngine } from "@fusion/engine";
import { ApiError } from "./api-error.js";
import type {
  RoomControlPlaneAuthorizationInput,
  RoomControlPlaneAuthorizationDecision,
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
  "getProjectId" | "getRoomControlPlaneReadService"
>;

type RoomControlPlaneReadService = NonNullable<
  ReturnType<RoomControlPlaneProjectEngine["getRoomControlPlaneReadService"]>
>;

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

function isNonEmptyIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256;
}

function isProjectEngine(value: unknown): value is RoomControlPlaneProjectEngine {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    getProjectId?: unknown;
    getRoomControlPlaneReadService?: unknown;
  };
  return typeof candidate.getProjectId === "function"
    && typeof candidate.getRoomControlPlaneReadService === "function";
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

async function resolveReadService(
  resolver: RoomControlPlaneEngineResolver,
  input: RoomControlPlaneEngineResolverInput,
): Promise<ReadServiceLike> {
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
  return service;
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

function createReadOnlyPort(projectId: string, service: ReadServiceLike): RoomControlPlaneRoutePort {
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
    async mutate(input: RoomControlPlaneMutationInputV1): Promise<RoomControlPlaneMutationResultV1> {
      assertPortProject(input.projectId, projectId);
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
      const service = await resolveReadService(options.resolveProjectEngine, input);
      return createReadOnlyPort(input.projectId, service);
    },
  };
}

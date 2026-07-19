import type { Request } from "express";
import { z } from "zod";
import { ApiError } from "../api-error.js";
import type { ApiRoutesContext, ProjectContext } from "./types.js";

export const ROOM_CONTROL_PLANE_RESOURCES = [
  "participants",
  "messages",
  "task-nodes",
  "protocol",
  "candidates",
  "evidence",
  "alerts",
  "replay",
] as const;

export type RoomControlPlaneResource = (typeof ROOM_CONTROL_PLANE_RESOURCES)[number];
export type RoomControlPlaneOperation = "create" | "update" | "delete" | "command" | "operator_action";
export type RoomControlPlaneAccess = "read" | "write";

export interface RoomControlPlaneAuthorizationInput {
  readonly request: Request;
  readonly projectId: string;
  readonly store: ProjectContext["store"];
  readonly access: RoomControlPlaneAccess;
  readonly resource: "room" | RoomControlPlaneResource;
  readonly roomId: string | null;
}

export type RoomControlPlaneAuthorizationDecision =
  | {
    readonly allowed: true;
    readonly actorId: string;
    readonly roles?: readonly string[];
  }
  | {
    readonly allowed: false;
    readonly reason?: string;
  };

export interface RoomControlPlanePageV1 {
  readonly items: readonly unknown[];
  readonly nextCursor: string | null;
}

export interface RoomControlPlaneListRoomsInputV1 {
  readonly projectId: string;
  readonly cursor: string | null;
  readonly limit: number | null;
}

export interface RoomControlPlaneRoomProjectionInputV1 {
  readonly projectId: string;
  readonly roomId: string;
}

export interface RoomControlPlaneResourceReadInputV1 extends RoomControlPlaneRoomProjectionInputV1 {
  readonly resource: RoomControlPlaneResource;
  readonly cursor: string | null;
  readonly limit: number | null;
}

export interface RoomControlPlaneMutationInputV1 {
  readonly projectId: string;
  readonly roomId: string | null;
  readonly resource: "room" | RoomControlPlaneResource;
  readonly operation: RoomControlPlaneOperation;
  readonly action: string;
  readonly expectedAggregateVersion: number;
  readonly commandId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly actorId: string;
}

export type RoomControlPlaneMutationResultV1 =
  | {
    readonly accepted: true;
    readonly aggregateVersion: number;
    readonly result?: unknown;
  }
  | {
    readonly accepted: false;
    readonly reason: string;
    readonly currentAggregateVersion?: number;
  };

export interface RoomControlPlaneRoutePort {
  listRooms(input: RoomControlPlaneListRoomsInputV1): Promise<RoomControlPlanePageV1>;
  getRoomProjection(input: RoomControlPlaneRoomProjectionInputV1): Promise<unknown | null>;
  listResource(input: RoomControlPlaneResourceReadInputV1): Promise<RoomControlPlanePageV1>;
  mutate(input: RoomControlPlaneMutationInputV1): Promise<RoomControlPlaneMutationResultV1>;
}

export interface RoomControlPlaneRouteDependencies {
  authorizeProject(input: RoomControlPlaneAuthorizationInput): Promise<RoomControlPlaneAuthorizationDecision>;
  resolvePort(input: {
    readonly request: Request;
    readonly projectId: string;
    readonly store: ProjectContext["store"];
    readonly actorId: string;
  }): Promise<RoomControlPlaneRoutePort>;
}

const identifierSchema = z.string().trim().min(1).max(256);
const expectedAggregateVersionSchema = z.number().int().nonnegative();
const actionSchema = z.string().trim().min(1).max(128).regex(/^[a-z][a-z0-9._-]*$/u);
const payloadSchema = z.record(z.unknown());
const listQuerySchema = z.object({
  projectId: identifierSchema.optional(),
  cursor: identifierSchema.optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
}).strict();
const roomParamsSchema = z.object({ roomId: identifierSchema }).strict();
const resourceParamsSchema = roomParamsSchema.extend({ resource: z.enum(ROOM_CONTROL_PLANE_RESOURCES) }).strict();
const mutationBodySchema = z.object({
  projectId: identifierSchema.optional(),
  expectedAggregateVersion: expectedAggregateVersionSchema,
  commandId: identifierSchema.optional(),
  payload: payloadSchema.default({}),
}).strict();
const actionBodySchema = mutationBodySchema.extend({ action: actionSchema }).strict();
const createRoomBodySchema = mutationBodySchema.extend({ expectedAggregateVersion: z.literal(0) }).strict();

type RoomRouteScope = {
  readonly projectId: string;
  readonly store: ProjectContext["store"];
  readonly actorId: string;
  readonly port: RoomControlPlaneRoutePort;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ApiError(400, "Invalid Room control-plane request", {
    code: "ROOM_ROUTE_VALIDATION_FAILED",
    issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })),
  });
}

function normalizePage(value: RoomControlPlanePageV1): RoomControlPlanePageV1 {
  if (!value || !Array.isArray(value.items) || (value.nextCursor !== null && !isNonEmptyString(value.nextCursor))) {
    throw new ApiError(503, "Room control-plane read port returned an invalid projection", {
      code: "ROOM_CONTROL_PLANE_PORT_INVALID_RESPONSE",
    });
  }
  return { items: value.items, nextCursor: value.nextCursor };
}

function assertMutationAccepted(value: RoomControlPlaneMutationResultV1): Extract<RoomControlPlaneMutationResultV1, { accepted: true }> {
  if (value && value.accepted === true && Number.isInteger(value.aggregateVersion) && value.aggregateVersion >= 0) {
    return value;
  }
  if (value && value.accepted === false) {
    const isVersionConflict = value.reason === "version_conflict";
    throw new ApiError(409, isVersionConflict ? "Room aggregate version conflict" : "Room mutation was rejected", {
      code: isVersionConflict ? "ROOM_AGGREGATE_VERSION_CONFLICT" : "ROOM_MUTATION_REJECTED",
      ...(value.currentAggregateVersion !== undefined ? { currentAggregateVersion: value.currentAggregateVersion } : {}),
    });
  }
  throw new ApiError(503, "Room control-plane write port returned an invalid response", {
    code: "ROOM_CONTROL_PLANE_PORT_INVALID_RESPONSE",
  });
}

async function resolveScope(input: {
  readonly context: ApiRoutesContext;
  readonly dependencies: RoomControlPlaneRouteDependencies;
  readonly request: Request;
  readonly access: RoomControlPlaneAccess;
  readonly resource: "room" | RoomControlPlaneResource;
  readonly roomId: string | null;
  readonly bodyProjectId?: string;
}): Promise<RoomRouteScope> {
  const projectContext = await input.context.getProjectContext(input.request);
  const projectId = projectContext.projectId;
  if (!isNonEmptyString(projectId)) {
    throw new ApiError(403, "Operational Room routes require an authenticated project scope", {
      code: "ROOM_PROJECT_SCOPE_REQUIRED",
    });
  }

  const requestedProjectId = input.context.getProjectIdFromRequest(input.request);
  if (
    (isNonEmptyString(requestedProjectId) && requestedProjectId !== projectId)
    || (isNonEmptyString(input.bodyProjectId) && input.bodyProjectId !== projectId)
  ) {
    throw new ApiError(403, "Requested project does not match the resolved project scope", {
      code: "ROOM_PROJECT_SCOPE_MISMATCH",
    });
  }

  const authorization = await input.dependencies.authorizeProject({
    request: input.request,
    projectId,
    store: projectContext.store,
    access: input.access,
    resource: input.resource,
    roomId: input.roomId,
  });
  if (!authorization || authorization.allowed !== true || !isNonEmptyString(authorization.actorId)) {
    throw new ApiError(403, "Room project access is denied", { code: "ROOM_PROJECT_ACCESS_DENIED" });
  }

  const port = await input.dependencies.resolvePort({
    request: input.request,
    projectId,
    store: projectContext.store,
    actorId: authorization.actorId,
  });
  if (!port) {
    throw new ApiError(503, "Room control-plane storage is unavailable", {
      code: "ROOM_CONTROL_PLANE_PORT_UNAVAILABLE",
    });
  }

  return { projectId, store: projectContext.store, actorId: authorization.actorId, port };
}

function rethrowRouteError(context: ApiRoutesContext, error: unknown): never {
  if (error instanceof ApiError) throw error;
  return context.rethrowAsApiError(error, "Room control-plane route failed");
}

function mutationResponse(res: import("express").Response, mutation: Extract<RoomControlPlaneMutationResultV1, { accepted: true }>, status = 200): void {
  res.status(status).json({
    accepted: true,
    aggregateVersion: mutation.aggregateVersion,
    ...(mutation.result !== undefined ? { result: mutation.result } : {}),
  });
}

export function registerRoomControlPlaneRoutes(
  context: ApiRoutesContext,
  dependencies: RoomControlPlaneRouteDependencies,
): void {
  context.router.get("/rooms", async (req, res) => {
    try {
      const query = parseOrThrow(listQuerySchema, req.query);
      const scope = await resolveScope({
        context,
        dependencies,
        request: req,
        access: "read",
        resource: "room",
        roomId: null,
      });
      const page = normalizePage(await scope.port.listRooms({
        projectId: scope.projectId,
        cursor: query.cursor ?? null,
        limit: query.limit ?? null,
      }));
      res.json({ rooms: page.items, nextCursor: page.nextCursor });
    } catch (error) {
      rethrowRouteError(context, error);
    }
  });

  context.router.post("/rooms", async (req, res) => {
    try {
      const body = parseOrThrow(createRoomBodySchema, req.body);
      const scope = await resolveScope({
        context,
        dependencies,
        request: req,
        access: "write",
        resource: "room",
        roomId: null,
        bodyProjectId: body.projectId,
      });
      const mutation = assertMutationAccepted(await scope.port.mutate({
        projectId: scope.projectId,
        roomId: null,
        resource: "room",
        operation: "create",
        action: "create",
        expectedAggregateVersion: body.expectedAggregateVersion,
        commandId: body.commandId ?? null,
        payload: body.payload ?? {},
        actorId: scope.actorId,
      }));
      mutationResponse(res, mutation, 201);
    } catch (error) {
      rethrowRouteError(context, error);
    }
  });

  context.router.get("/rooms/:roomId", async (req, res) => {
    try {
      const params = parseOrThrow(roomParamsSchema, req.params);
      const scope = await resolveScope({
        context,
        dependencies,
        request: req,
        access: "read",
        resource: "room",
        roomId: params.roomId,
      });
      const room = await scope.port.getRoomProjection({ projectId: scope.projectId, roomId: params.roomId });
      if (room === null) {
        throw new ApiError(404, `Room ${params.roomId} not found`, { code: "ROOM_NOT_FOUND", roomId: params.roomId });
      }
      if (room === undefined) {
        throw new ApiError(503, "Room control-plane read port returned an invalid projection", {
          code: "ROOM_CONTROL_PLANE_PORT_INVALID_RESPONSE",
        });
      }
      res.json({ room });
    } catch (error) {
      rethrowRouteError(context, error);
    }
  });

  context.router.patch("/rooms/:roomId", async (req, res) => {
    try {
      const params = parseOrThrow(roomParamsSchema, req.params);
      const body = parseOrThrow(mutationBodySchema, req.body);
      const scope = await resolveScope({
        context,
        dependencies,
        request: req,
        access: "write",
        resource: "room",
        roomId: params.roomId,
        bodyProjectId: body.projectId,
      });
      const mutation = assertMutationAccepted(await scope.port.mutate({
        projectId: scope.projectId,
        roomId: params.roomId,
        resource: "room",
        operation: "update",
        action: "update",
        expectedAggregateVersion: body.expectedAggregateVersion,
        commandId: body.commandId ?? null,
        payload: body.payload ?? {},
        actorId: scope.actorId,
      }));
      mutationResponse(res, mutation);
    } catch (error) {
      rethrowRouteError(context, error);
    }
  });

  context.router.delete("/rooms/:roomId", async (req, res) => {
    try {
      const params = parseOrThrow(roomParamsSchema, req.params);
      const body = parseOrThrow(mutationBodySchema, req.body);
      const scope = await resolveScope({
        context,
        dependencies,
        request: req,
        access: "write",
        resource: "room",
        roomId: params.roomId,
        bodyProjectId: body.projectId,
      });
      const mutation = assertMutationAccepted(await scope.port.mutate({
        projectId: scope.projectId,
        roomId: params.roomId,
        resource: "room",
        operation: "delete",
        action: "delete",
        expectedAggregateVersion: body.expectedAggregateVersion,
        commandId: body.commandId ?? null,
        payload: body.payload ?? {},
        actorId: scope.actorId,
      }));
      mutationResponse(res, mutation);
    } catch (error) {
      rethrowRouteError(context, error);
    }
  });

  context.router.get("/rooms/:roomId/:resource", async (req, res) => {
    try {
      const params = parseOrThrow(resourceParamsSchema, req.params);
      const query = parseOrThrow(listQuerySchema, req.query);
      const scope = await resolveScope({
        context,
        dependencies,
        request: req,
        access: "read",
        resource: params.resource,
        roomId: params.roomId,
      });
      const page = normalizePage(await scope.port.listResource({
        projectId: scope.projectId,
        roomId: params.roomId,
        resource: params.resource,
        cursor: query.cursor ?? null,
        limit: query.limit ?? null,
      }));
      res.json({ items: page.items, nextCursor: page.nextCursor });
    } catch (error) {
      rethrowRouteError(context, error);
    }
  });

  context.router.post("/rooms/:roomId/:resource/actions", async (req, res) => {
    try {
      const params = parseOrThrow(resourceParamsSchema, req.params);
      const body = parseOrThrow(actionBodySchema, req.body);
      const scope = await resolveScope({
        context,
        dependencies,
        request: req,
        access: "write",
        resource: params.resource,
        roomId: params.roomId,
        bodyProjectId: body.projectId,
      });
      const mutation = assertMutationAccepted(await scope.port.mutate({
        projectId: scope.projectId,
        roomId: params.roomId,
        resource: params.resource,
        operation: "command",
        action: body.action,
        expectedAggregateVersion: body.expectedAggregateVersion,
        commandId: body.commandId ?? null,
        payload: body.payload ?? {},
        actorId: scope.actorId,
      }));
      mutationResponse(res, mutation);
    } catch (error) {
      rethrowRouteError(context, error);
    }
  });

  context.router.post("/rooms/:roomId/actions", async (req, res) => {
    try {
      const params = parseOrThrow(roomParamsSchema, req.params);
      const body = parseOrThrow(actionBodySchema, req.body);
      const scope = await resolveScope({
        context,
        dependencies,
        request: req,
        access: "write",
        resource: "room",
        roomId: params.roomId,
        bodyProjectId: body.projectId,
      });
      const mutation = assertMutationAccepted(await scope.port.mutate({
        projectId: scope.projectId,
        roomId: params.roomId,
        resource: "room",
        operation: "operator_action",
        action: body.action,
        expectedAggregateVersion: body.expectedAggregateVersion,
        commandId: body.commandId ?? null,
        payload: body.payload ?? {},
        actorId: scope.actorId,
      }));
      mutationResponse(res, mutation);
    } catch (error) {
      rethrowRouteError(context, error);
    }
  });
}

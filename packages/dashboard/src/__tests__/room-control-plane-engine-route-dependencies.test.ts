import express from "express";
import type { TaskStore } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api-error.js";
import {
  createRoomControlPlaneEngineRouteDependencies,
  type RoomControlPlaneProjectEngine,
} from "../room-control-plane-engine-route-dependencies.js";
import { request } from "../test-request.js";
import {
  registerRoomControlPlaneRoutes,
  type RoomControlPlaneRouteDependencies,
} from "../routes/register-room-control-plane-routes.js";
import type { ApiRoutesContext } from "../routes/types.js";

const PROJECT_ID = "project-alpha";
const OTHER_PROJECT_ID = "project-beta";
const ROOM_ID = "room-1";

type ReadService = {
  readonly listRooms: ReturnType<typeof vi.fn>;
  readonly getRoomProjection: ReturnType<typeof vi.fn>;
};

function createReadService(): ReadService {
  return {
    listRooms: vi.fn(async () => ({
      items: [{ id: ROOM_ID, projectId: PROJECT_ID, objective: "Coordinate verified sessions" }],
      nextCursor: "cursor-next",
    })),
    getRoomProjection: vi.fn(async () => ({
      roomId: ROOM_ID,
      objective: "Coordinate verified sessions",
      phase: "implementation",
    })),
  };
}

function createEngine(projectId: string, service: unknown): RoomControlPlaneProjectEngine {
  return {
    getProjectId: () => projectId,
    getRoomControlPlaneReadService: () => service,
  } as unknown as RoomControlPlaneProjectEngine;
}

function createApp(input: {
  readonly authorizeProject?: RoomControlPlaneRouteDependencies["authorizeProject"];
  readonly resolveProjectEngine?: (input: {
    readonly projectId: string;
    readonly actorId: string;
  }) => RoomControlPlaneProjectEngine | undefined | Promise<RoomControlPlaneProjectEngine | undefined>;
} = {}) {
  const router = express.Router();
  const authorizeProject = input.authorizeProject ?? vi.fn(async () => ({ allowed: true as const, actorId: "operator-1" }));
  const resolveProjectEngine = vi.fn(async (resolution: {
    readonly projectId: string;
    readonly actorId: string;
  }) => input.resolveProjectEngine?.(resolution));
  const store = {} as TaskStore;
  const context = {
    router,
    store,
    runtimeLogger: {} as never,
    planningLogger: {} as never,
    chatLogger: {} as never,
    getProjectIdFromRequest(req: express.Request): string | undefined {
      return typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    },
    getScopedStore: vi.fn(async () => store),
    getProjectContext: vi.fn(async () => ({ store, engine: undefined, projectId: PROJECT_ID })),
    prioritizeProjectsForCurrentDirectory: vi.fn((projects) => projects),
    emitRemoteRouteDiagnostic: vi.fn(),
    emitAuthSyncAuditLog: vi.fn(),
    parseScopeParam: vi.fn(),
    resolveAutomationStore: vi.fn(),
    resolveRoutineStore: vi.fn(),
    resolveRoutineRunner: vi.fn(),
    registerDispose: vi.fn(),
    dispose: vi.fn(),
    rethrowAsApiError(error: unknown): never {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, error instanceof Error ? error.message : "Internal server error");
    },
  } as ApiRoutesContext;

  registerRoomControlPlaneRoutes(context, createRoomControlPlaneEngineRouteDependencies({
    authorizeProject,
    resolveProjectEngine,
  }));

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ApiError) {
      res.status(error.statusCode).json({ error: error.message, details: error.details });
      return;
    }
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  });

  return { app, authorizeProject, resolveProjectEngine };
}

describe("Room control-plane Engine route dependencies", () => {
  it("requires an explicit authorization callback instead of defaulting to allow", () => {
    expect(() => createRoomControlPlaneEngineRouteDependencies({
      resolveProjectEngine: async () => undefined,
    } as never)).toThrow("authorizeProject");
  });

  it("denies before resolving an Engine when the explicit authorization callback rejects access", async () => {
    const service = createReadService();
    const { app, resolveProjectEngine } = createApp({
      authorizeProject: vi.fn(async () => ({ allowed: false as const, reason: "observer" })),
      resolveProjectEngine: () => createEngine(PROJECT_ID, service),
    });

    const response = await request(app, "GET", `/api/rooms?projectId=${PROJECT_ID}`);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ details: { code: "ROOM_PROJECT_ACCESS_DENIED" } });
    expect(resolveProjectEngine).not.toHaveBeenCalled();
    expect(service.listRooms).not.toHaveBeenCalled();
  });

  it("rejects an Engine that belongs to a different project before it can expose Room data", async () => {
    const service = createReadService();
    const { app } = createApp({
      resolveProjectEngine: () => createEngine(OTHER_PROJECT_ID, service),
    });

    const response = await request(app, "GET", `/api/rooms?projectId=${PROJECT_ID}`);

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ details: { code: "ROOM_ENGINE_PROJECT_MISMATCH" } });
    expect(service.listRooms).not.toHaveBeenCalled();
  });

  it.each([
    ["no Engine is running for the project", undefined, "ROOM_PROJECT_ENGINE_UNAVAILABLE"],
    ["the Engine has its Room read service disabled", createEngine(PROJECT_ID, undefined), "ROOM_CONTROL_PLANE_READ_SERVICE_UNAVAILABLE"],
    ["the resolved Room service does not expose canonical reads", createEngine(PROJECT_ID, {}), "ROOM_CONTROL_PLANE_READ_SERVICE_INVALID"],
  ])("fails closed when %s", async (_description, engine, expectedCode) => {
    const { app } = createApp({ resolveProjectEngine: () => engine });

    const response = await request(app, "GET", `/api/rooms?projectId=${PROJECT_ID}`);

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ details: { code: expectedCode } });
  });

  it("forwards only project-bound list and projection reads to the Engine service", async () => {
    const service = createReadService();
    const { app, resolveProjectEngine } = createApp({
      resolveProjectEngine: ({ projectId, actorId }) => {
        expect(projectId).toBe(PROJECT_ID);
        expect(actorId).toBe("operator-1");
        return createEngine(PROJECT_ID, service);
      },
    });

    const list = await request(app, "GET", `/api/rooms?projectId=${PROJECT_ID}&cursor=cursor-before&limit=7`);
    const projection = await request(app, "GET", `/api/rooms/${ROOM_ID}?projectId=${PROJECT_ID}`);

    expect(list.status).toBe(200);
    expect(list.body).toEqual({
      rooms: [{ id: ROOM_ID, projectId: PROJECT_ID, objective: "Coordinate verified sessions" }],
      nextCursor: "cursor-next",
    });
    expect(projection.status).toBe(200);
    expect(projection.body).toEqual({
      room: { roomId: ROOM_ID, objective: "Coordinate verified sessions", phase: "implementation" },
    });
    expect(resolveProjectEngine).toHaveBeenCalledTimes(2);
    expect(service.listRooms).toHaveBeenCalledWith({ projectId: PROJECT_ID, cursor: "cursor-before", limit: 7 });
    expect(service.getRoomProjection).toHaveBeenCalledWith({ projectId: PROJECT_ID, roomId: ROOM_ID });
  });

  it("fails resource and mutation actions closed without manufacturing an in-memory port", async () => {
    const service = createReadService();
    const { app } = createApp({ resolveProjectEngine: () => createEngine(PROJECT_ID, service) });

    const resource = await request(app, "GET", `/api/rooms/${ROOM_ID}/participants?projectId=${PROJECT_ID}`);
    const mutation = await request(
      app,
      "POST",
      `/api/rooms/${ROOM_ID}/messages/actions?projectId=${PROJECT_ID}`,
      JSON.stringify({ expectedAggregateVersion: 3, action: "send", payload: { content: "do not dispatch" } }),
      { "content-type": "application/json" },
    );

    expect(resource.status).toBe(501);
    expect(resource.body).toMatchObject({ details: { code: "ROOM_CONTROL_PLANE_RESOURCE_READ_UNSUPPORTED" } });
    expect(mutation.status).toBe(501);
    expect(mutation.body).toMatchObject({ details: { code: "ROOM_CONTROL_PLANE_MUTATION_UNSUPPORTED" } });
    expect(service.listRooms).not.toHaveBeenCalled();
    expect(service.getRoomProjection).not.toHaveBeenCalled();
  });
});

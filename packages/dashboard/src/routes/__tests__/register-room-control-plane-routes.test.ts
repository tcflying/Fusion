import express from "express";
import type { TaskStore } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api-error.js";
import { request } from "../../test-request.js";
import type { ApiRoutesContext } from "../types.js";
import {
  registerRoomControlPlaneRoutes,
  type RoomControlPlaneRouteDependencies,
  type RoomControlPlaneRoutePort,
} from "../register-room-control-plane-routes.js";

const PROJECT_ID = "project-alpha";
const OTHER_PROJECT_ID = "project-beta";
const ROOM_ID = "room-1";

function createPort(overrides: Partial<RoomControlPlaneRoutePort> = {}) {
  const listRooms = vi.fn(async () => ({ items: [{ id: ROOM_ID, projectId: PROJECT_ID }], nextCursor: null }));
  const getRoomProjection = vi.fn(async () => ({ id: ROOM_ID, projectId: PROJECT_ID, aggregateVersion: 7 }));
  const listResource = vi.fn(async (input: { resource: string }) => ({
    items: [{ id: `${input.resource}-1`, roomId: ROOM_ID }],
    nextCursor: null,
  }));
  const mutate = vi.fn(async () => ({
    accepted: true as const,
    aggregateVersion: 8,
    result: { committed: true },
  }));

  return {
    port: {
      listRooms,
      getRoomProjection,
      listResource,
      mutate,
      openRoomEventCursor: vi.fn() as RoomControlPlaneRoutePort["openRoomEventCursor"],
      ...overrides,
    } satisfies RoomControlPlaneRoutePort,
    calls: { listRooms, getRoomProjection, listResource, mutate },
  };
}

function createApp(input: {
  readonly contextProjectId?: string | undefined;
  readonly dependencies?: Partial<RoomControlPlaneRouteDependencies> | undefined;
  readonly port?: RoomControlPlaneRoutePort | undefined;
} = {}) {
  const router = express.Router();
  const { port, calls } = input.port ? { port: input.port, calls: undefined } : createPort();
  const authorizeProject = vi.fn(async () => ({ allowed: true as const, actorId: "operator-1" }));
  const resolvePort = vi.fn(async () => port);
  const context = {
    router,
    store: {} as TaskStore,
    runtimeLogger: {} as never,
    planningLogger: {} as never,
    chatLogger: {} as never,
    getProjectIdFromRequest(req: express.Request): string | undefined {
      return typeof req.query.projectId === "string"
        ? req.query.projectId
        : (typeof req.body?.projectId === "string" ? req.body.projectId : undefined);
    },
    getScopedStore: vi.fn(async () => ({} as TaskStore)),
    getProjectContext: vi.fn(async () => ({
      store: {} as TaskStore,
      engine: undefined,
      projectId: input.contextProjectId ?? PROJECT_ID,
    })),
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

  registerRoomControlPlaneRoutes(context, {
    authorizeProject,
    resolvePort,
    ...input.dependencies,
  });

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((_req: express.Request, res: express.Response) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ApiError) {
      res.status(error.statusCode).json({ error: error.message, details: error.details });
      return;
    }
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  });

  return { app, calls, authorizeProject, resolvePort, context };
}

function json(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

describe("Room control-plane routes", () => {
  it("fails closed when the project authorization port denies the request", async () => {
    const { app, calls, resolvePort } = createApp({
      dependencies: {
        authorizeProject: async () => ({ allowed: false, reason: "observer role" }),
      },
    });

    const response = await request(app, "GET", `/api/rooms?projectId=${PROJECT_ID}`);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ details: { code: "ROOM_PROJECT_ACCESS_DENIED" } });
    expect(resolvePort).not.toHaveBeenCalled();
    expect(calls?.listRooms).not.toHaveBeenCalled();
  });

  it("rejects a request whose declared project scope differs from the resolved project", async () => {
    const { app, authorizeProject, resolvePort } = createApp({ contextProjectId: PROJECT_ID });

    const response = await request(app, "GET", `/api/rooms?projectId=${OTHER_PROJECT_ID}`);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ details: { code: "ROOM_PROJECT_SCOPE_MISMATCH" } });
    expect(authorizeProject).not.toHaveBeenCalled();
    expect(resolvePort).not.toHaveBeenCalled();
  });

  it("rejects an invalid mutation body before authorization or persistence", async () => {
    const { app, authorizeProject, resolvePort, calls } = createApp();

    const response = await request(
      app,
      "POST",
      `/api/rooms/${ROOM_ID}/messages/actions?projectId=${PROJECT_ID}`,
      json({ action: "send", payload: { content: "hello" } }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ details: { code: "ROOM_ROUTE_VALIDATION_FAILED" } });
    expect(authorizeProject).not.toHaveBeenCalled();
    expect(resolvePort).not.toHaveBeenCalled();
    expect(calls?.mutate).not.toHaveBeenCalled();
  });

  it("returns a conflict and never reports success when the port rejects the aggregate version", async () => {
    const { port } = createPort({
      mutate: async () => ({
        accepted: false,
        reason: "version_conflict",
        currentAggregateVersion: 9,
      }),
    });
    const { app } = createApp({ port });

    const response = await request(
      app,
      "PATCH",
      `/api/rooms/${ROOM_ID}?projectId=${PROJECT_ID}`,
      json({ expectedAggregateVersion: 7, payload: { objective: "updated" } }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      details: {
        code: "ROOM_AGGREGATE_VERSION_CONFLICT",
        currentAggregateVersion: 9,
      },
    });
  });

  it("provides project-scoped projection CRUD and resource reads/actions without claiming Chat Room routes", async () => {
    const { app, calls } = createApp();

    const list = await request(app, "GET", `/api/rooms?projectId=${PROJECT_ID}`);
    const created = await request(
      app,
      "POST",
      `/api/rooms?projectId=${PROJECT_ID}`,
      json({ expectedAggregateVersion: 0, payload: { objective: "coordinate sessions" } }),
      { "content-type": "application/json" },
    );
    const room = await request(app, "GET", `/api/rooms/${ROOM_ID}?projectId=${PROJECT_ID}`);
    const updated = await request(
      app,
      "PATCH",
      `/api/rooms/${ROOM_ID}?projectId=${PROJECT_ID}`,
      json({ expectedAggregateVersion: 7, payload: { objective: "updated objective" } }),
      { "content-type": "application/json" },
    );
    const removed = await request(
      app,
      "DELETE",
      `/api/rooms/${ROOM_ID}?projectId=${PROJECT_ID}`,
      json({ expectedAggregateVersion: 8 }),
      { "content-type": "application/json" },
    );

    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ rooms: [{ id: ROOM_ID, projectId: PROJECT_ID }] });
    expect(created.status).toBe(201);
    expect(room.status).toBe(200);
    expect(room.body).toMatchObject({ room: { id: ROOM_ID, aggregateVersion: 7 } });
    expect(updated.status).toBe(200);
    expect(removed.status).toBe(200);
    expect(calls?.listRooms).toHaveBeenCalledWith(expect.objectContaining({ projectId: PROJECT_ID }));
    expect(calls?.mutate).toHaveBeenCalledWith(expect.objectContaining({
      projectId: PROJECT_ID,
      resource: "room",
      operation: "create",
      expectedAggregateVersion: 0,
      actorId: "operator-1",
    }));

    for (const resource of ["participants", "messages", "task-nodes", "protocol", "candidates", "evidence", "alerts", "replay"] as const) {
      const read = await request(app, "GET", `/api/rooms/${ROOM_ID}/${resource}?projectId=${PROJECT_ID}`);
      const action = await request(
        app,
        "POST",
        `/api/rooms/${ROOM_ID}/${resource}/actions?projectId=${PROJECT_ID}`,
        json({ expectedAggregateVersion: 8, action: "refresh", payload: { source: "cockpit" } }),
        { "content-type": "application/json" },
      );

      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ items: [{ roomId: ROOM_ID }] });
      expect(action.status).toBe(200);
    }

    const operatorAction = await request(
      app,
      "POST",
      `/api/rooms/${ROOM_ID}/actions?projectId=${PROJECT_ID}`,
      json({ expectedAggregateVersion: 8, action: "pause", payload: { reason: "operator requested" } }),
      { "content-type": "application/json" },
    );
    const chatRoom = await request(app, "GET", `/api/chat/rooms?projectId=${PROJECT_ID}`);

    expect(operatorAction.status).toBe(200);
    expect(chatRoom.status).toBe(404);
    expect(calls?.listResource).toHaveBeenCalledTimes(8);
    expect(calls?.mutate).toHaveBeenCalledTimes(12);
  });
});

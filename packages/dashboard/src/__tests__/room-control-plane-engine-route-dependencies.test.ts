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

function createEngine(projectId: string, service: unknown, liveEventService: unknown = undefined): RoomControlPlaneProjectEngine {
  return {
    getProjectId: () => projectId,
    getRoomControlPlaneReadService: () => service,
    getRoomControlPlaneLiveEventService: () => liveEventService,
    executeProjectRoomCommand: async () => {
      throw new Error("Unexpected Room command");
    },
  } as unknown as RoomControlPlaneProjectEngine;
}

function operatorMessagePayload(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    seatId: "seat-1",
    intent: "instruction",
    content: "Review the verified candidate before the next Room decision.",
    authorityEnvelope: { envelope: "provided-by-caller" },
    ...overrides,
  };
}

function operatorActionRequestBody(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    expectedAggregateVersion: 3,
    commandId: "route-command-1",
    action: "send_to_seat",
    payload: operatorMessagePayload(),
    ...overrides,
  });
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

  it("routes only the canonical operator send-to-seat command and returns the Engine event version", async () => {
    const service = createReadService();
    const executeProjectRoomCommand = vi.fn(async () => ({
      type: "room.send-to-seat.v1",
      projectId: PROJECT_ID,
      commandId: "route-command-1",
      actor: { kind: "dashboard_operator", principalId: "operator-1" },
      value: { event: { aggregateVersion: 11 } },
    }));
    const { app } = createApp({
      resolveProjectEngine: () => ({
        ...createEngine(PROJECT_ID, service),
        executeProjectRoomCommand: executeProjectRoomCommand as RoomControlPlaneProjectEngine["executeProjectRoomCommand"],
      }),
    });

    const response = await request(
      app,
      "POST",
      `/api/rooms/${ROOM_ID}/actions?projectId=${PROJECT_ID}`,
      operatorActionRequestBody(),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ accepted: true, aggregateVersion: 11 });
    expect(executeProjectRoomCommand).toHaveBeenCalledWith({
      type: "room.send-to-seat.v1",
      projectId: PROJECT_ID,
      commandId: "route-command-1",
      input: {
        roomId: ROOM_ID,
        seatId: "seat-1",
        expectedAggregateVersion: 3,
        commandId: "route-command-1",
        idempotencyKey: "route-command-1",
        correlationId: "route-command-1",
        intent: "instruction",
        content: "Review the verified candidate before the next Room decision.",
        authorityEnvelope: { envelope: "provided-by-caller" },
      },
    }, {
      kind: "dashboard_operator",
      principalId: "operator-1",
      authenticated: true,
    });
  });

  it("rejects a Room operator action without the externally routed commandId", async () => {
    const service = createReadService();
    const executeProjectRoomCommand = vi.fn();
    const { app } = createApp({
      resolveProjectEngine: () => ({
        ...createEngine(PROJECT_ID, service),
        executeProjectRoomCommand: executeProjectRoomCommand as RoomControlPlaneProjectEngine["executeProjectRoomCommand"],
      }),
    });

    const response = await request(
      app,
      "POST",
      `/api/rooms/${ROOM_ID}/actions?projectId=${PROJECT_ID}`,
      operatorActionRequestBody({ commandId: undefined }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ details: { code: "ROOM_CONTROL_PLANE_OPERATOR_ACTION_INVALID" } });
    expect(executeProjectRoomCommand).not.toHaveBeenCalled();
  });

  it("rejects payload attempts to override identity or command correlation fields", async () => {
    const service = createReadService();
    const executeProjectRoomCommand = vi.fn();
    const { app } = createApp({
      resolveProjectEngine: () => ({
        ...createEngine(PROJECT_ID, service),
        executeProjectRoomCommand: executeProjectRoomCommand as RoomControlPlaneProjectEngine["executeProjectRoomCommand"],
      }),
    });

    const response = await request(
      app,
      "POST",
      `/api/rooms/${ROOM_ID}/actions?projectId=${PROJECT_ID}`,
      operatorActionRequestBody({
        payload: operatorMessagePayload({
          actorId: "payload-actor",
          principal: { kind: "controller" },
          commandId: "payload-command",
          idempotencyKey: "payload-idempotency",
          correlationId: "payload-correlation",
        }),
      }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ details: { code: "ROOM_CONTROL_PLANE_OPERATOR_ACTION_INVALID" } });
    expect(executeProjectRoomCommand).not.toHaveBeenCalled();
  });

  it("rejects a cross-project Engine before it can execute a Room operator action", async () => {
    const service = createReadService();
    const executeProjectRoomCommand = vi.fn();
    const { app } = createApp({
      resolveProjectEngine: () => ({
        ...createEngine(OTHER_PROJECT_ID, service),
        executeProjectRoomCommand: executeProjectRoomCommand as RoomControlPlaneProjectEngine["executeProjectRoomCommand"],
      }),
    });

    const response = await request(
      app,
      "POST",
      `/api/rooms/${ROOM_ID}/actions?projectId=${PROJECT_ID}`,
      operatorActionRequestBody(),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ details: { code: "ROOM_ENGINE_PROJECT_MISMATCH" } });
    expect(executeProjectRoomCommand).not.toHaveBeenCalled();
  });

  it("denies an unauthorized Room operator action before resolving an Engine", async () => {
    const service = createReadService();
    const { app, resolveProjectEngine } = createApp({
      authorizeProject: vi.fn(async () => ({ allowed: false as const, reason: "observer" })),
      resolveProjectEngine: () => createEngine(PROJECT_ID, service),
    });

    const response = await request(
      app,
      "POST",
      `/api/rooms/${ROOM_ID}/actions?projectId=${PROJECT_ID}`,
      operatorActionRequestBody(),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ details: { code: "ROOM_PROJECT_ACCESS_DENIED" } });
    expect(resolveProjectEngine).not.toHaveBeenCalled();
  });

  it("fails closed when no project Engine is available for a Room operator action", async () => {
    const { app } = createApp({ resolveProjectEngine: () => undefined });

    const response = await request(
      app,
      "POST",
      `/api/rooms/${ROOM_ID}/actions?projectId=${PROJECT_ID}`,
      operatorActionRequestBody(),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ details: { code: "ROOM_PROJECT_ENGINE_UNAVAILABLE" } });
  });

  it("keeps every other Room operator action explicitly unsupported", async () => {
    const service = createReadService();
    const executeProjectRoomCommand = vi.fn();
    const { app } = createApp({
      resolveProjectEngine: () => ({
        ...createEngine(PROJECT_ID, service),
        executeProjectRoomCommand: executeProjectRoomCommand as RoomControlPlaneProjectEngine["executeProjectRoomCommand"],
      }),
    });

    const response = await request(
      app,
      "POST",
      `/api/rooms/${ROOM_ID}/actions?projectId=${PROJECT_ID}`,
      operatorActionRequestBody({ action: "broadcast" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(501);
    expect(response.body).toMatchObject({ details: { code: "ROOM_CONTROL_PLANE_MUTATION_UNSUPPORTED" } });
    expect(executeProjectRoomCommand).not.toHaveBeenCalled();
  });

  it("fails closed instead of inferring an aggregate version from an invalid Engine result", async () => {
    const service = createReadService();
    const executeProjectRoomCommand = vi.fn(async () => ({
      type: "room.send-to-seat.v1",
      projectId: PROJECT_ID,
      commandId: "route-command-1",
      actor: { kind: "dashboard_operator", principalId: "operator-1" },
      value: { event: { aggregateVersion: "4" } },
    }));
    const { app } = createApp({
      resolveProjectEngine: () => ({
        ...createEngine(PROJECT_ID, service),
        executeProjectRoomCommand: executeProjectRoomCommand as RoomControlPlaneProjectEngine["executeProjectRoomCommand"],
      }),
    });

    const response = await request(
      app,
      "POST",
      `/api/rooms/${ROOM_ID}/actions?projectId=${PROJECT_ID}`,
      operatorActionRequestBody(),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ details: { code: "ROOM_CONTROL_PLANE_MUTATION_RESPONSE_INVALID" } });
  });

  it("uses the project Engine canonical live service for the event cursor and never substitutes read state", async () => {
    const service = createReadService();
    const unsubscribe = vi.fn();
    const reconnect = vi.fn(async () => ({
      ok: true,
      outcome: "reconciliation_required",
      scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
      replaySource: null,
      events: [],
      nextCursor: null,
      hasMore: false,
      connection: { state: "unknown", reason: "internal secret", changedAt: null },
      alerts: [],
    }));
    const subscribe = vi.fn(() => unsubscribe);
    const { app } = createApp({
      resolveProjectEngine: () => createEngine(PROJECT_ID, service, { reconnect, subscribe }),
    });

    const response = await request(app, "GET", `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ details: { code: "ROOM_EVENT_RECONCILIATION_REQUIRED" } });
    expect(JSON.stringify(response.body)).not.toContain("internal secret");
    expect(subscribe).toHaveBeenCalledWith({ projectId: PROJECT_ID, roomId: ROOM_ID }, expect.any(Function));
    expect(reconnect).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      afterCursor: null,
      limit: 128,
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(service.getRoomProjection).not.toHaveBeenCalled();
  });

  it("fails closed for an unavailable live event service without changing existing Room reads", async () => {
    const service = createReadService();
    const { app } = createApp({ resolveProjectEngine: () => createEngine(PROJECT_ID, service) });

    const response = await request(app, "GET", `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ details: { code: "ROOM_CONTROL_PLANE_LIVE_EVENT_SERVICE_UNAVAILABLE" } });
    expect(service.getRoomProjection).not.toHaveBeenCalled();
  });

  it("rechecks Engine project identity before opening a Room event cursor", async () => {
    const service = createReadService();
    const getProjectId = vi.fn()
      .mockReturnValueOnce(PROJECT_ID)
      .mockReturnValueOnce(OTHER_PROJECT_ID);
    const liveService = {
      reconnect: vi.fn(),
      subscribe: vi.fn(),
    };
    const { app } = createApp({
      resolveProjectEngine: () => ({
        ...createEngine(PROJECT_ID, service, liveService),
        getProjectId,
      }),
    });

    const response = await request(app, "GET", `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ details: { code: "ROOM_ENGINE_PROJECT_MISMATCH" } });
    expect(liveService.subscribe).not.toHaveBeenCalled();
    expect(liveService.reconnect).not.toHaveBeenCalled();
  });
});

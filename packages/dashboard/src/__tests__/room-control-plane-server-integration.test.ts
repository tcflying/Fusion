// @vitest-environment node

import { EventEmitter } from "node:events";
import http from "node:http";
import type { Socket } from "node:net";
import { PassThrough } from "node:stream";
import express from "express";
import type {
  AsyncRoomStore,
  RoomAggregateV1,
  RoomSummaryV1,
  RoomTaskGraphProjectionV1,
  TaskStore,
} from "@fusion/core";
import { RoomControlPlaneReadService } from "@fusion/engine";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as serverModule from "../server.js";
import { createServer, type RoomControlPlaneProjectAuthorizer } from "../server.js";
import { request } from "../test-request.js";

const PROJECT_ID = "project-room-server";
const ROOM_ID = "room-server-1";
const UPDATED_AT = "2026-07-19T08:00:00.000Z";
const DAEMON_TOKEN = "daemon-room-control-plane-token";

class MockSocket extends PassThrough {
  public writable = true;
  public readable = true;
  public remoteAddress = "127.0.0.1";
  public encrypted = false;

  setTimeout(): this {
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  destroySoon(): void {
    this.destroy();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for Room server SSE output");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function openSseStream(app: express.Express, path: string) {
  const socket = new MockSocket();
  const req = new http.IncomingMessage(socket as unknown as Socket);
  const res = new http.ServerResponse(req);
  const chunks: Buffer[] = [];
  req.method = "GET";
  req.url = path;
  req.httpVersion = "1.1";
  req.headers = { host: "127.0.0.1" };
  res.assignSocket(socket as unknown as Socket);
  const originalWrite = res.write.bind(res);
  res.write = ((chunk: string | Buffer, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined));
    return originalWrite(chunk as never, encoding as never, callback);
  }) as typeof res.write;

  app(req, res);
  await new Promise((resolve) => process.nextTick(resolve));
  req.complete = true;
  req.emit("end");
  await waitFor(() => res.headersSent || res.writableEnded);
  return {
    status: res.statusCode,
    headers: res.getHeaders(),
    readText(): string {
      return Buffer.concat(chunks).toString("utf8");
    },
    close(): void {
      req.emit("close");
      res.emit("close");
      socket.destroy();
    },
  };
}

function roomEvent(cursor: string) {
  return {
    contractVersion: 1,
    id: `server-event-${cursor}`,
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    aggregateVersion: Number(cursor),
    eventType: "room_projection_changed",
    actorType: "controller",
    actorId: "server-room-controller",
    correlationId: `server-correlation-${cursor}`,
    causationId: null,
    payload: { cursor },
    occurredAt: `2026-07-19T18:30:${cursor.padStart(2, "0")}.000Z`,
    cursor,
  };
}

function roomEnvelope(cursor: string) {
  return {
    contractVersion: 1,
    scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
    cursor,
    sequence: Number(cursor),
    streamSequence: null,
    eventId: `server-event-${cursor}`,
    eventType: "room_projection_changed",
    aggregateVersion: Number(cursor),
    occurredAt: `2026-07-19T18:30:${cursor.padStart(2, "0")}.000Z`,
    actor: { type: "controller", id: "server-room-controller" },
    event: roomEvent(cursor),
  };
}

function createLiveEventService() {
  let listener: ((notification: unknown) => void) | undefined;
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  const reconnect = vi.fn(async () => ({
    ok: true,
    outcome: "replayed",
    scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
    replaySource: "canonical_port",
    events: [roomEnvelope("1")],
    nextCursor: "1",
    hasMore: false,
    connection: { state: "connected", reason: null, changedAt: "2026-07-19T18:30:00.000Z" },
    alerts: [],
  }));
  const subscribe = vi.fn((_scope: unknown, candidate: (notification: unknown) => void) => {
    listener = candidate;
    return unsubscribe;
  });
  return {
    service: { reconnect, subscribe },
    calls: { reconnect, subscribe, unsubscribe },
    emit(cursor: string): void {
      listener?.({
        contractVersion: 1,
        type: "canonical_room_event",
        scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
        envelope: roomEnvelope(cursor),
        connection: { state: "connected", reason: null, changedAt: "2026-07-19T18:30:00.000Z" },
        alerts: [],
      });
    },
  };
}

class MemoryStore extends EventEmitter {
  getAsyncLayer(): null {
    return null;
  }

  getRootDir(): string {
    return "/room-control-plane-server";
  }

  getFusionDir(): string {
    return "/room-control-plane-server/.fusion";
  }

  getDatabase() {
    return {
      exec: vi.fn(),
      prepare: vi.fn().mockReturnValue({
        run: vi.fn().mockReturnValue({ changes: 0 }),
        get: vi.fn(),
        all: vi.fn().mockReturnValue([]),
      }),
    };
  }

  getSettings = vi.fn(async () => ({}));
  getSettingsFast = vi.fn(async () => ({}));
}

function roomSummary(): RoomSummaryV1 {
  return {
    contractVersion: 1,
    id: ROOM_ID,
    projectId: PROJECT_ID,
    objective: "Expose canonical Room reads through the server",
    protocolId: "implementation",
    protocolVersion: 1,
    lifecycleState: "running",
    aggregateVersion: 7,
    membershipVersion: 1,
    activeTurnId: null,
    seatCount: 0,
    createdAt: "2026-07-19T07:00:00.000Z",
    updatedAt: UPDATED_AT,
  };
}

function roomAggregate(): RoomAggregateV1 {
  return {
    room: {
      contractVersion: 1,
      id: ROOM_ID,
      projectId: PROJECT_ID,
      objective: "Expose canonical Room reads through the server",
      protocolId: "implementation",
      protocolVersion: 1,
      state: "running",
      aggregateVersion: 7,
      createdAt: "2026-07-19T07:00:00.000Z",
      updatedAt: UPDATED_AT,
    },
    membershipVersion: 1,
    activeTurnId: null,
    seats: [],
    bindings: [],
    turns: [],
    pendingMembershipChanges: [],
  } as RoomAggregateV1;
}

function roomTaskGraph(): RoomTaskGraphProjectionV1 {
  return {
    roomId: ROOM_ID,
    aggregateVersion: 7,
    dagVersion: 1,
    nodes: [],
    edges: [],
    readyNodeIds: [],
    criticalPathNodeIds: [],
  } as RoomTaskGraphProjectionV1;
}

function createReadService() {
  const listRoomSummaries = vi.fn(async () => ({
    rooms: [roomSummary()],
    nextCursor: null,
  }));
  const getRoom = vi.fn(async () => roomAggregate());
  const getTaskGraph = vi.fn(async () => roomTaskGraph());
  const roomStore = {
    listRoomSummaries,
    getRoom,
    getTaskGraph,
  } as unknown as AsyncRoomStore;

  return {
    service: new RoomControlPlaneReadService({ projectId: PROJECT_ID, roomStore }),
    calls: { listRoomSummaries, getRoom, getTaskGraph },
  };
}

function createProjectEngine(store: TaskStore, service: RoomControlPlaneReadService, liveEventService: unknown = undefined) {
  const getRoomControlPlaneReadService = vi.fn(() => service);
  const getRoomControlPlaneLiveEventService = vi.fn(() => liveEventService);
  const executeProjectRoomCommand = vi.fn(async () => {
    throw new Error("Room commands are not exercised by this read-only server fixture");
  });
  return {
    engine: {
      getProjectId: () => PROJECT_ID,
      getTaskStore: () => store,
      getRoomControlPlaneReadService,
      getRoomControlPlaneLiveEventService,
      executeProjectRoomCommand,
    },
    calls: { getRoomControlPlaneReadService, getRoomControlPlaneLiveEventService, executeProjectRoomCommand },
  };
}

function createEngineManager(engine: ReturnType<typeof createProjectEngine>["engine"]) {
  const getEngine = vi.fn((projectId: string) => (projectId === PROJECT_ID ? engine : undefined));
  return {
    manager: {
      getEngine,
      onProjectAccessed: vi.fn(),
    } as never,
    calls: { getEngine },
  };
}

function createDaemonAuthorizationInput(
  store: TaskStore,
  input: Readonly<{ readonly authorization?: string; readonly queryToken?: string }>,
): Parameters<RoomControlPlaneProjectAuthorizer>[0] {
  const query = new URLSearchParams({ projectId: PROJECT_ID });
  if (input.queryToken !== undefined) query.set("fn_token", input.queryToken);
  return {
    request: {
      headers: input.authorization === undefined ? {} : { authorization: input.authorization },
      url: `/api/rooms/${ROOM_ID}/events?${query.toString()}`,
    } as never,
    projectId: PROJECT_ID,
    store,
    access: "read",
    resource: "room",
    roomId: ROOM_ID,
  };
}

describe("Room control-plane server wiring", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new MemoryStore() as unknown as TaskStore;
  });

  it("creates a daemon Room authorizer that accepts only its configured bearer token", async () => {
    const factory = (serverModule as {
      readonly createDaemonRoomControlPlaneAuthorizer?: (daemonToken: string) => RoomControlPlaneProjectAuthorizer;
    }).createDaemonRoomControlPlaneAuthorizer;

    expect(factory).toBeTypeOf("function");
    if (typeof factory !== "function") return;

    const authorize = factory(DAEMON_TOKEN);
    const headerAccepted = await authorize(createDaemonAuthorizationInput(store, {
      authorization: `Bearer ${DAEMON_TOKEN}`,
    }));
    const eventSourceAccepted = await authorize(createDaemonAuthorizationInput(store, {
      queryToken: DAEMON_TOKEN,
    }));
    const rejected = await authorize(createDaemonAuthorizationInput(store, {
      authorization: "Bearer wrong-daemon-token",
    }));

    expect(headerAccepted).toEqual({ allowed: true, actorId: "fusion-daemon-operator" });
    expect(eventSourceAccepted).toEqual({ allowed: true, actorId: "fusion-daemon-operator" });
    expect(rejected).toEqual({ allowed: false, reason: "daemon-token-required" });
    expect(JSON.stringify(headerAccepted)).not.toContain(DAEMON_TOKEN);
  });

  it("mounts canonical ProjectEngine list and get reads after explicit project authorization", async () => {
    const { service, calls: serviceCalls } = createReadService();
    const { engine, calls: engineCalls } = createProjectEngine(store, service);
    const { manager } = createEngineManager(engine);
    const authorizeProject = vi.fn<RoomControlPlaneProjectAuthorizer>(async () => ({
      allowed: true,
      actorId: "operator-room-server",
    }));
    const app = createServer(store, {
      engineManager: manager,
      roomControlPlaneAuthorizeProject: authorizeProject,
    });

    const list = await request(app, "GET", `/api/rooms?projectId=${PROJECT_ID}`);
    const projection = await request(app, "GET", `/api/rooms/${ROOM_ID}?projectId=${PROJECT_ID}`);

    expect(list.status).toBe(200);
    expect(list.body).toEqual({ rooms: [roomSummary()], nextCursor: null });
    expect(projection.status).toBe(200);
    expect(projection.body).toMatchObject({
      room: {
        roomId: ROOM_ID,
        objective: "Expose canonical Room reads through the server",
        phase: "unstarted",
      },
    });
    expect(authorizeProject).toHaveBeenCalledWith(expect.objectContaining({
      projectId: PROJECT_ID,
      access: "read",
      resource: "room",
    }));
    expect(engineCalls.getRoomControlPlaneReadService).toHaveBeenCalledTimes(2);
    expect(serviceCalls.listRoomSummaries).toHaveBeenCalledWith({ cursor: undefined, limit: undefined });
    expect(serviceCalls.getRoom).toHaveBeenCalledWith(ROOM_ID);
    expect(serviceCalls.getTaskGraph).toHaveBeenCalledWith(ROOM_ID);
  });

  it("mounts authenticated canonical Room SSE through the Engine live-event getter and cleans up on disconnect", async () => {
    const { service } = createReadService();
    const live = createLiveEventService();
    const { engine } = createProjectEngine(store, service, live.service);
    const { manager } = createEngineManager(engine);
    const authorizeProject = vi.fn<RoomControlPlaneProjectAuthorizer>(async () => ({
      allowed: true,
      actorId: "operator-room-server",
    }));
    const app = createServer(store, {
      engineManager: manager,
      roomControlPlaneAuthorizeProject: authorizeProject,
    });

    const stream = await openSseStream(app, `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);

    expect(stream.status).toBe(200);
    expect(String(stream.headers["content-type"])).toContain("text/event-stream");
    expect(stream.readText()).toContain("id: 1\nevent: room.event");
    expect(authorizeProject).toHaveBeenCalledWith(expect.objectContaining({
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      resource: "room",
      access: "read",
    }));
    expect(live.calls.subscribe).toHaveBeenCalledWith({ projectId: PROJECT_ID, roomId: ROOM_ID }, expect.any(Function));
    expect(live.calls.reconnect).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      afterCursor: null,
      limit: 128,
    });

    live.emit("2");
    await waitFor(() => stream.readText().includes("id: 2\nevent: room.event"));
    stream.close();
    await waitFor(() => live.calls.unsubscribe.mock.calls.length === 1);
  });

  it("denies project authorization before resolving the Engine read service", async () => {
    const { service } = createReadService();
    const { engine, calls: engineCalls } = createProjectEngine(store, service);
    const { manager } = createEngineManager(engine);
    const authorizeProject = vi.fn<RoomControlPlaneProjectAuthorizer>(async () => ({
      allowed: false,
      reason: "observer",
    }));
    const app = createServer(store, {
      engineManager: manager,
      roomControlPlaneAuthorizeProject: authorizeProject,
    });

    const response = await request(app, "GET", `/api/rooms?projectId=${PROJECT_ID}`);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ details: { code: "ROOM_PROJECT_ACCESS_DENIED" } });
    expect(engineCalls.getRoomControlPlaneReadService).not.toHaveBeenCalled();
  });

  it("does not register Room control-plane routes without an explicit project authorizer, even with a daemon bearer token", async () => {
    const { service } = createReadService();
    const { engine, calls: engineCalls } = createProjectEngine(store, service);
    const { manager } = createEngineManager(engine);
    const app = createServer(store, {
      engineManager: manager,
      daemon: { token: "daemon-bearer-is-not-project-authorization" },
    });

    const response = await request(
      app,
      "GET",
      `/api/rooms?projectId=${PROJECT_ID}`,
      undefined,
      { authorization: "Bearer daemon-bearer-is-not-project-authorization" },
    );

    expect(response.status).toBe(404);
    expect(engineCalls.getRoomControlPlaneReadService).not.toHaveBeenCalled();
  });

  it("keeps unsupported Room resource and mutation operations unavailable", async () => {
    const { service, calls: serviceCalls } = createReadService();
    const { engine } = createProjectEngine(store, service);
    const { manager } = createEngineManager(engine);
    const app = createServer(store, {
      engineManager: manager,
      roomControlPlaneAuthorizeProject: async () => ({
        allowed: true,
        actorId: "operator-room-server",
      }),
    });

    const resource = await request(
      app,
      "GET",
      `/api/rooms/${ROOM_ID}/participants?projectId=${PROJECT_ID}`,
    );
    const mutation = await request(
      app,
      "POST",
      `/api/rooms?projectId=${PROJECT_ID}`,
      JSON.stringify({ expectedAggregateVersion: 0, payload: { objective: "must not create" } }),
      { "content-type": "application/json" },
    );

    expect(resource.status).toBe(501);
    expect(resource.body).toMatchObject({ details: { code: "ROOM_CONTROL_PLANE_RESOURCE_READ_UNSUPPORTED" } });
    expect(mutation.status).toBe(501);
    expect(mutation.body).toMatchObject({ details: { code: "ROOM_CONTROL_PLANE_MUTATION_UNSUPPORTED" } });
    expect(serviceCalls.listRoomSummaries).not.toHaveBeenCalled();
    expect(serviceCalls.getRoom).not.toHaveBeenCalled();
    expect(serviceCalls.getTaskGraph).not.toHaveBeenCalled();
  });
});

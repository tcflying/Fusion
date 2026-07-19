// @vitest-environment node

import express from "express";
import http from "node:http";
import type { Socket } from "node:net";
import { PassThrough } from "node:stream";
import type { TaskStore } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api-error.js";
import { request } from "../test-request.js";
import {
  registerRoomControlPlaneRoutes,
  type RoomControlPlaneRouteDependencies,
  type RoomControlPlaneRoutePort,
} from "../routes/register-room-control-plane-routes.js";
import type { ApiRoutesContext } from "../routes/types.js";

const PROJECT_ID = "project-room-events";
const OTHER_PROJECT_ID = "project-room-events-other";
const ROOM_ID = "room-room-events";

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
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for Room SSE output");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function openSseStream(
  app: express.Express,
  path: string,
  headers: Record<string, string> = {},
  options: Readonly<{ writeReturnsFalseAt?: number; waitTimeoutMs?: number }> = {},
) {
  const socket = new MockSocket();
  const req = new http.IncomingMessage(socket as unknown as Socket);
  const res = new http.ServerResponse(req);
  const chunks: Buffer[] = [];

  req.method = "GET";
  req.url = path;
  req.httpVersion = "1.1";
  req.headers = { host: "127.0.0.1", ...headers };
  res.assignSocket(socket as unknown as Socket);

  const originalWrite = res.write.bind(res);
  let writeCount = 0;
  res.write = ((chunk: string | Buffer, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
    writeCount += 1;
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined));
    const wrote = originalWrite(chunk as never, encoding as never, callback);
    return options.writeReturnsFalseAt === writeCount ? false : wrote;
  }) as typeof res.write;

  app(req, res);
  await new Promise((resolve) => process.nextTick(resolve));
  req.complete = true;
  req.emit("end");
  await waitFor(() => res.headersSent || res.writableEnded || res.destroyed, options.waitTimeoutMs);

  return {
    status: res.statusCode,
    headers: res.getHeaders(),
    readText(): string {
      return Buffer.concat(chunks).toString("utf8");
    },
    isDestroyed(): boolean {
      return res.destroyed;
    },
    close(): void {
      req.emit("close");
      res.emit("close");
      socket.destroy();
    },
  };
}

function roomEvent(cursor: string, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    contractVersion: 1,
    id: `event-${cursor}`,
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    aggregateVersion: Number(cursor),
    eventType: "room_projection_changed",
    actorType: "controller",
    actorId: "room-controller",
    correlationId: `correlation-${cursor}`,
    causationId: null,
    payload: { cursor },
    occurredAt: `2026-07-19T18:00:${cursor.padStart(2, "0")}.000Z`,
    cursor,
    ...overrides,
  };
}

function envelope(cursor: string, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    contractVersion: 1,
    scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
    cursor,
    sequence: Number(cursor),
    streamSequence: null,
    eventId: `event-${cursor}`,
    eventType: "room_projection_changed",
    aggregateVersion: Number(cursor),
    occurredAt: `2026-07-19T18:00:${cursor.padStart(2, "0")}.000Z`,
    actor: { type: "controller", id: "room-controller" },
    event: roomEvent(cursor),
    ...overrides,
  };
}

function connection(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    state: "connected",
    reason: null,
    changedAt: "2026-07-19T18:00:00.000Z",
    ...overrides,
  };
}

function replay(events: readonly unknown[], overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    ok: true,
    outcome: events.length > 0 ? "replayed" : "up_to_date",
    scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
    replaySource: "canonical_port",
    events,
    nextCursor: events.length > 0 ? (events.at(-1) as { cursor: string }).cursor : null,
    hasMore: false,
    connection: connection(),
    alerts: [],
    ...overrides,
  };
}

function notification(cursor: string, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    contractVersion: 1,
    type: "canonical_room_event",
    scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
    envelope: envelope(cursor),
    connection: connection(),
    alerts: [],
    ...overrides,
  };
}

function sseEventIds(value: string): string[] {
  return [...value.matchAll(/^id: ([^\n]+)\nevent: room\.event\n/gmu)].map((match) => match[1] ?? "");
}

function createEventPort(input: {
  readonly reconnect?: (input: unknown) => Promise<unknown>;
  readonly subscribe?: (input: unknown, listener: (notification: unknown) => void) => () => void;
} = {}) {
  let listener: ((notification: unknown) => void) | undefined;
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  const reconnect = vi.fn(input.reconnect ?? (async () => replay([])));
  const subscribe = vi.fn(input.subscribe ?? ((_input: unknown, candidate: (notification: unknown) => void) => {
    listener = candidate;
    return unsubscribe;
  }));
  const liveEventPort = { reconnect, subscribe };
  const openRoomEventCursor = vi.fn(async () => liveEventPort);
  const port = {
    listRooms: vi.fn(async () => ({ items: [], nextCursor: null })),
    getRoomProjection: vi.fn(async () => null),
    listResource: vi.fn(async () => ({ items: [], nextCursor: null })),
    mutate: vi.fn(async () => ({ accepted: false, reason: "unsupported" })),
    openRoomEventCursor,
  } as unknown as RoomControlPlaneRoutePort;

  return {
    port,
    calls: { openRoomEventCursor, reconnect, subscribe, unsubscribe },
    emit(value: unknown): void {
      listener?.(value);
    },
  };
}

function createApp(port: RoomControlPlaneRoutePort, authorizeProject: RoomControlPlaneRouteDependencies["authorizeProject"] = async () => ({
  allowed: true,
  actorId: "operator-room-events",
})) {
  const router = express.Router();
  const store = {} as TaskStore;
  const dependencies: RoomControlPlaneRouteDependencies = {
    authorizeProject,
    resolvePort: vi.fn(async () => port),
  };
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

  registerRoomControlPlaneRoutes(context, dependencies);
  const app = express();
  app.use("/api", router);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ApiError) {
      res.status(error.statusCode).json({ error: error.message, details: error.details });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  });
  return { app, dependencies };
}

describe("Room control-plane authenticated event cursor route", () => {
  it("authorizes the event stream before it can resolve an Engine-backed cursor port", async () => {
    const fixture = createEventPort();
    const { app, dependencies } = createApp(
      fixture.port,
      vi.fn(async () => ({ allowed: false as const, reason: "observer" })),
    );

    const response = await request(app, "GET", `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ details: { code: "ROOM_PROJECT_ACCESS_DENIED" } });
    expect(dependencies.resolvePort).not.toHaveBeenCalled();
    expect(fixture.calls.openRoomEventCursor).not.toHaveBeenCalled();
  });

  it("unsubscribes if the client closes while subscribe is returning its cleanup function", async () => {
    let requestToClose: http.IncomingMessage | undefined;
    const unsubscribe = vi.fn();
    const fixture = createEventPort({
      subscribe: () => {
        requestToClose?.emit("close");
        return unsubscribe;
      },
    });
    const { app } = createApp(fixture.port);
    const socket = new MockSocket();
    const req = new http.IncomingMessage(socket as unknown as Socket);
    const res = new http.ServerResponse(req);
    requestToClose = req;
    req.method = "GET";
    req.url = `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`;
    req.httpVersion = "1.1";
    req.headers = { host: "127.0.0.1" };
    res.assignSocket(socket as unknown as Socket);

    app(req, res);
    await new Promise((resolve) => process.nextTick(resolve));
    req.complete = true;
    req.emit("end");
    await waitFor(() => unsubscribe.mock.calls.length === 1);

    expect(fixture.calls.reconnect).not.toHaveBeenCalled();
    res.destroy();
    socket.destroy();
  });

  it("subscribes before canonical replay and emits replay plus a racing live event exactly once in cursor order", async () => {
    const fixture = createEventPort();
    fixture.calls.reconnect.mockImplementation(async () => {
      fixture.emit(notification("2"));
      fixture.emit(notification("3"));
      return replay([envelope("1"), envelope("2")]);
    });
    const { app } = createApp(fixture.port);

    const stream = await openSseStream(app, `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);

    expect(stream.status).toBe(200);
    expect(String(stream.headers["content-type"])).toContain("text/event-stream");
    expect(fixture.calls.subscribe.mock.invocationCallOrder[0]).toBeLessThan(fixture.calls.reconnect.mock.invocationCallOrder[0] ?? Infinity);
    expect(sseEventIds(stream.readText())).toEqual(["1", "2", "3"]);
    expect(stream.readText()).not.toContain("reason:");

    fixture.emit(notification("4"));
    await waitFor(() => sseEventIds(stream.readText()).length === 4);
    expect(sseEventIds(stream.readText())).toEqual(["1", "2", "3", "4"]);

    stream.close();
    await waitFor(() => fixture.calls.unsubscribe.mock.calls.length === 1);
  });

  it("honors a strict Last-Event-ID cursor and rejects conflicting or malformed cursor input before subscription", async () => {
    const fixture = createEventPort();
    const { app } = createApp(fixture.port);

    const stream = await openSseStream(
      app,
      `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}&cursor=4`,
      { "last-event-id": "4" },
    );
    expect(fixture.calls.reconnect).toHaveBeenCalledWith(expect.objectContaining({ afterCursor: "4" }));
    stream.close();

    const conflict = await request(app, "GET", `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}&cursor=4`, undefined, {
      "last-event-id": "5",
    });
    const malformed = await request(app, "GET", `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}&cursor=04`);

    expect(conflict.status).toBe(400);
    expect(conflict.body).toMatchObject({ details: { code: "ROOM_EVENT_CURSOR_CONFLICT" } });
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ details: { code: "ROOM_ROUTE_VALIDATION_FAILED" } });
    expect(fixture.calls.subscribe).toHaveBeenCalledTimes(1);
  });

  it("accepts the already-authenticated EventSource token without relaxing strict business query validation", async () => {
    const fixture = createEventPort({ reconnect: async () => replay([], { nextCursor: "4" }) });
    const { app } = createApp(fixture.port);

    const stream = await openSseStream(
      app,
      `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}&cursor=4&fn_token=daemon-token`,
    );
    expect(stream.status).toBe(200);
    expect(fixture.calls.reconnect).toHaveBeenCalledWith(expect.objectContaining({ afterCursor: "4" }));
    stream.close();

    const unknown = await request(
      app,
      "GET",
      `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}&fn_token=daemon-token&unexpected=value`,
    );
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ details: { code: "ROOM_ROUTE_VALIDATION_FAILED" } });
  });

  it("does not cross the resolved project scope before it can reach the event port", async () => {
    const fixture = createEventPort();
    const { app, dependencies } = createApp(fixture.port);

    const response = await request(app, "GET", `/api/rooms/${ROOM_ID}/events?projectId=${OTHER_PROJECT_ID}`);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ details: { code: "ROOM_PROJECT_SCOPE_MISMATCH" } });
    expect(dependencies.resolvePort).not.toHaveBeenCalled();
    expect(fixture.calls.subscribe).not.toHaveBeenCalled();
  });

  it("fails closed and redacts canonical reconciliation diagnostics before opening SSE", async () => {
    const fixture = createEventPort({
      reconnect: async () => replay([], {
        outcome: "reconciliation_required",
        replaySource: null,
        connection: connection({ reason: "provider token: never expose" }),
        alerts: [{
          code: "canonical_replay_failed",
          severity: "critical",
          message: "database password: never expose",
          scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
          cursor: null,
          expectedStreamSequence: null,
          observedStreamSequence: null,
        }],
      }),
    });
    const { app } = createApp(fixture.port);

    const response = await request(app, "GET", `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ details: { code: "ROOM_EVENT_RECONCILIATION_REQUIRED" } });
    expect(JSON.stringify(response.body)).not.toContain("password");
    expect(fixture.calls.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("rejects memory replay but delivers a complete canonical page before cursor-resuming an incomplete replay", async () => {
    const memoryFixture = createEventPort({
      reconnect: async () => replay([], { replaySource: "memory" }),
    });
    const incompleteFixture = createEventPort({
      reconnect: async () => replay([envelope("1")], { hasMore: true }),
    });
    const memoryApp = createApp(memoryFixture.port).app;
    const incompleteApp = createApp(incompleteFixture.port).app;

    const memory = await request(memoryApp, "GET", `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);
    const incomplete = await openSseStream(incompleteApp, `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);

    expect(memory.status).toBe(503);
    expect(memory.body).toMatchObject({ details: { code: "ROOM_EVENT_REPLAY_NOT_CANONICAL" } });
    expect(memoryFixture.calls.unsubscribe).toHaveBeenCalledTimes(1);
    expect(incomplete.status).toBe(200);
    expect(sseEventIds(incomplete.readText())).toEqual(["1"]);
    expect(incomplete.readText()).toContain("event: room.replay.continue");
    expect(incomplete.readText()).toContain('"type":"room_replay_continue"');
    await waitFor(() => incompleteFixture.calls.unsubscribe.mock.calls.length === 1);
    expect(incompleteFixture.calls.unsubscribe).toHaveBeenCalledTimes(1);
    incomplete.close();
  });

  it("stops and emits only sanitized alert metadata when a live payload is not a verified canonical envelope", async () => {
    const fixture = createEventPort({ reconnect: async () => replay([envelope("1")]) });
    const { app } = createApp(fixture.port);
    const stream = await openSseStream(app, `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);

    fixture.emit(notification("3", {
      envelope: envelope("3", { event: roomEvent("3", { projectId: OTHER_PROJECT_ID }) }),
      alerts: [{
        code: "canonical_replay_invalid",
        severity: "critical",
        message: "secret invalid payload explanation",
        scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
        cursor: "3",
        expectedStreamSequence: null,
        observedStreamSequence: null,
      }],
    }));

    await waitFor(() => stream.readText().includes("event: room.alert"));
    expect(stream.readText()).toContain('"code":"canonical_replay_invalid"');
    expect(stream.readText()).not.toContain("secret invalid payload explanation");
    expect(fixture.calls.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("terminates and unsubscribes when a live SSE write signals Node backpressure", async () => {
    const fixture = createEventPort();
    const { app } = createApp(fixture.port);
    const stream = await openSseStream(
      app,
      `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`,
      {},
      { writeReturnsFalseAt: 2 },
    );

    try {
      fixture.emit(notification("1"));
      await waitFor(() => fixture.calls.unsubscribe.mock.calls.length === 1);
    } finally {
      stream.close();
    }
  });

  it("fails closed and releases its subscription when hot live events outrun canonical replay", async () => {
    let resolveReplay: ((value: unknown) => void) | undefined;
    const fixture = createEventPort({
      reconnect: () => new Promise<unknown>((resolve) => {
        resolveReplay = resolve;
      }),
    });
    const { app } = createApp(fixture.port);
    const opening = openSseStream(
      app,
      `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`,
      {},
      { waitTimeoutMs: 10_000 },
    );

    await waitFor(() => resolveReplay !== undefined && fixture.calls.subscribe.mock.calls.length === 1);
    for (let cursor = 1; cursor <= 129; cursor += 1) fixture.emit(notification(String(cursor)));

    try {
      await waitFor(() => fixture.calls.unsubscribe.mock.calls.length === 1);
    } finally {
      resolveReplay?.(replay([]));
      const stream = await opening;
      stream.close();
    }
  });

  it("destroys a backpressured canonical replay continuation instead of retaining the response buffer", async () => {
    const fixture = createEventPort({ reconnect: async () => replay([envelope("1")], { hasMore: true }) });
    const { app } = createApp(fixture.port);
    const stream = await openSseStream(
      app,
      `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`,
      {},
      { writeReturnsFalseAt: 3 },
    );

    await waitFor(() => fixture.calls.unsubscribe.mock.calls.length === 1);

    expect(stream.isDestroyed()).toBe(true);
    stream.close();
  });

});

// @vitest-environment node

import express from "express";
import http from "node:http";
import type { Socket } from "node:net";
import { PassThrough } from "node:stream";
import type { AsyncRoomStore, RoomEventRecordV1, TaskStore } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";
import { RoomControlPlaneLiveEventService } from "../../../engine/src/room-control-plane-live-event-service.js";
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
  const originalEnd = res.end.bind(res);
  res.end = ((chunk?: string | Buffer, encoding?: BufferEncoding | (() => void), callback?: () => void) => {
    if (chunk !== undefined) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined));
    }
    return originalEnd(chunk as never, encoding as never, callback as never);
  }) as typeof res.end;

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
    isEnded(): boolean {
      return res.writableEnded;
    },
    isDestroyed(): boolean {
      return res.destroyed;
    },
    close(): void {
      req.emit("close");
      res.emit("close");
      socket.destroy();
    },
    abort(): void {
      req.emit("aborted");
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

function deferred<T>() {
  let resolve: (value: T) => void;
  let reject: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve: resolve!, reject: reject! };
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

type WatermarkedSubscription = (() => void) & {
  readonly activate: (afterCursor: string | null) => boolean;
  readonly closed?: Promise<unknown>;
};

function termination(
  reason: "service_stopped" | "durable_poll_failed" | "canonical_page_invalid",
  overrides: Readonly<Record<string, unknown>> = {},
) {
  const isServiceStopped = reason === "service_stopped";
  const isDurablePollFailed = reason === "durable_poll_failed";
  return {
    contractVersion: 1,
    type: "room_live_event_terminated",
    reason,
    scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
    connection: {
      state: isServiceStopped ? "disconnected" : "degraded",
      reason: isServiceStopped
        ? "engine_live_service_stopped"
        : isDurablePollFailed
          ? "canonical_durable_poll_failed"
          : "canonical_durable_page_invalid",
      changedAt: null,
    },
    alerts: [{
      code: isServiceStopped ? "stream_disconnected" : isDurablePollFailed ? "canonical_replay_failed" : "canonical_replay_invalid",
      severity: "critical",
      scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
      cursor: null,
      expectedStreamSequence: null,
      observedStreamSequence: null,
    }],
    ...overrides,
  };
}

function createEventPort(input: {
  readonly reconnect?: (input: unknown) => Promise<unknown>;
  readonly subscribe?: (input: unknown, listener: (notification: unknown) => void) => WatermarkedSubscription;
  readonly subscribeTermination?: (input: unknown, listener: (signal: unknown) => void) => () => void;
  readonly deliverBufferedReplayDuplicates?: boolean;
} = {}) {
  let listener: ((notification: unknown) => void) | undefined;
  let holdingForReplayWatermark = false;
  const pendingBeforeReplayWatermark: unknown[] = [];
  let pendingReplayWatermarkOverflowed = false;
  let terminationListener: ((signal: unknown) => void) | undefined;
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  const activate = vi.fn((afterCursor: string | null) => {
    holdingForReplayWatermark = false;
    if (pendingReplayWatermarkOverflowed) return false;
    const watermark = afterCursor === null ? null : Number(afterCursor);
    for (const value of pendingBeforeReplayWatermark.splice(0)) {
      const sequence = (value as { envelope?: { sequence?: unknown } }).envelope?.sequence;
      if (!input.deliverBufferedReplayDuplicates && typeof sequence === "number" && watermark !== null && sequence <= watermark) continue;
      listener?.(value);
    }
    return true;
  });
  const subscription = Object.assign(unsubscribe, { activate, closed }) as WatermarkedSubscription;
  const reconnect = vi.fn(input.reconnect ?? (async () => replay([])));
  const subscribe = vi.fn(input.subscribe ?? ((subscriptionInput: unknown, candidate: (notification: unknown) => void) => {
    listener = candidate;
    holdingForReplayWatermark = (subscriptionInput as { holdUntilReplayWatermark?: unknown }).holdUntilReplayWatermark === true;
    return subscription;
  }));
  const unsubscribeTermination = vi.fn(() => {
    terminationListener = undefined;
  });
  const subscribeTermination = vi.fn(input.subscribeTermination ?? ((_input: unknown, candidate: (signal: unknown) => void) => {
    terminationListener = candidate;
    return unsubscribeTermination;
  }));
  const liveEventPort = { reconnect, subscribe, subscribeTermination };
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
    calls: { openRoomEventCursor, reconnect, subscribe, unsubscribe, subscribeTermination, unsubscribeTermination },
    emit(value: unknown): void {
      if (holdingForReplayWatermark) {
        if (pendingBeforeReplayWatermark.length >= 128) {
          pendingReplayWatermarkOverflowed = true;
          return;
        }
        pendingBeforeReplayWatermark.push(value);
        return;
      }
      listener?.(value);
    },
    terminate(signal: unknown): void {
      terminationListener?.(signal);
    },
    stop(): void {
      resolveClosed?.();
    },
  };
}

function createApp(
  port: RoomControlPlaneRoutePort,
  authorizeProject: RoomControlPlaneRouteDependencies["authorizeProject"] = async () => ({
    allowed: true,
    actorId: "operator-room-events",
  }),
  options: Readonly<{
    maxLiveEventConnections?: number;
    maxLiveEventConnectionsPerScope?: number;
    maxLiveEventConnectionsPerActor?: number;
    maxLiveEventConnectionLifetimeMs?: number;
  }> = {},
) {
  const router = express.Router();
  const store = {} as TaskStore;
  const dependencies = {
    authorizeProject,
    resolvePort: vi.fn(async () => port),
    ...options,
  } as RoomControlPlaneRouteDependencies;
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
    const subscription = Object.assign(unsubscribe, { activate: () => true }) as WatermarkedSubscription;
    const fixture = createEventPort({
      subscribe: () => {
        requestToClose?.emit("close");
        return subscription;
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

  it("rejects excess streams for one authenticated actor and releases the slot after termination", async () => {
    const fixture = createEventPort({ reconnect: async () => replay([envelope("1")]) });
    const { app } = createApp(fixture.port, undefined, { maxLiveEventConnectionsPerActor: 1 });
    const first = await openSseStream(app, `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);
    let reopened: Awaited<ReturnType<typeof openSseStream>> | undefined;

    try {
      const limited = await request(app, "GET", `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);
      expect(limited.status).toBe(429);
      expect(limited.body).toMatchObject({
        details: {
          code: "ROOM_EVENT_ACTOR_CONNECTION_LIMIT_REACHED",
          retryAfter: 1,
          retryable: true,
        },
      });
      expect(fixture.calls.subscribe).toHaveBeenCalledTimes(1);

      fixture.terminate(termination("service_stopped"));
      await waitFor(() => first.isEnded());
      expect(fixture.calls.unsubscribe).toHaveBeenCalledTimes(1);
      expect(fixture.calls.unsubscribeTermination).toHaveBeenCalledTimes(1);

      reopened = await openSseStream(app, `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);
      expect(reopened.status).toBe(200);
      expect(fixture.calls.subscribe).toHaveBeenCalledTimes(2);
    } finally {
      reopened?.close();
      first.close();
    }
  });

  it("releases authenticated-actor capacity after client close and abort", async () => {
    const fixture = createEventPort({ reconnect: async () => replay([envelope("1")]) });
    const { app } = createApp(fixture.port, undefined, { maxLiveEventConnectionsPerActor: 1 });
    const first = await openSseStream(app, `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);
    let second: Awaited<ReturnType<typeof openSseStream>> | undefined;
    let reopened: Awaited<ReturnType<typeof openSseStream>> | undefined;

    try {
      first.close();
      await waitFor(() => fixture.calls.unsubscribe.mock.calls.length === 1);
      await waitFor(() => fixture.calls.unsubscribeTermination.mock.calls.length === 1);

      second = await openSseStream(app, `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);
      expect(second.status).toBe(200);
      second.abort();
      await waitFor(() => fixture.calls.unsubscribe.mock.calls.length === 2);
      await waitFor(() => fixture.calls.unsubscribeTermination.mock.calls.length === 2);

      reopened = await openSseStream(app, `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);
      expect(reopened.status).toBe(200);
    } finally {
      reopened?.close();
      second?.close();
      first.close();
    }
  });

  it("fails closed at the route-wide stream limit before it opens a second Engine subscription", async () => {
    const fixture = createEventPort({ reconnect: async () => replay([envelope("1")]) });
    const { app } = createApp(
      fixture.port,
      async (input) => ({
        allowed: true as const,
        actorId: input.request.header("x-room-actor") === "operator-b" ? "operator-b" : "operator-a",
      }),
      {
        maxLiveEventConnections: 1,
        maxLiveEventConnectionsPerScope: 1,
        maxLiveEventConnectionsPerActor: 1,
      },
    );
    const first = await openSseStream(
      app,
      `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`,
      { "x-room-actor": "operator-a" },
    );
    let limited: Awaited<ReturnType<typeof openSseStream>> | undefined;

    try {
      limited = await openSseStream(
        app,
        `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`,
        { "x-room-actor": "operator-b" },
      );
      expect(limited.status).toBe(429);
      expect(limited.readText()).toContain("ROOM_EVENT_CONNECTION_LIMIT_REACHED");
      expect(fixture.calls.subscribe).toHaveBeenCalledTimes(1);

      fixture.terminate(termination("service_stopped"));
      await waitFor(() => first.isEnded());
    } finally {
      limited?.close();
      first.close();
    }
  });

  it("fails closed at the project-and-Room stream limit across different authorized actors", async () => {
    const fixture = createEventPort({ reconnect: async () => replay([envelope("1")]) });
    const { app } = createApp(
      fixture.port,
      async (input) => ({
        allowed: true as const,
        actorId: input.request.header("x-room-actor") === "operator-b" ? "operator-b" : "operator-a",
      }),
      {
        maxLiveEventConnections: 3,
        maxLiveEventConnectionsPerScope: 1,
        maxLiveEventConnectionsPerActor: 3,
      },
    );
    const first = await openSseStream(
      app,
      `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`,
      { "x-room-actor": "operator-a" },
    );
    let limited: Awaited<ReturnType<typeof openSseStream>> | undefined;

    try {
      limited = await openSseStream(
        app,
        `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`,
        { "x-room-actor": "operator-b" },
      );
      expect(limited.status).toBe(429);
      expect(limited.readText()).toContain("ROOM_EVENT_SCOPE_CONNECTION_LIMIT_REACHED");
      expect(fixture.calls.subscribe).toHaveBeenCalledTimes(1);
    } finally {
      limited?.close();
      first.close();
    }
  });

  it("terminates the response when the Engine live service stops instead of retaining a heartbeat-only stream", async () => {
    const fixture = createEventPort({ reconnect: async () => replay([envelope("1")]) });
    const { app } = createApp(fixture.port);
    const stream = await openSseStream(app, `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);

    fixture.terminate(termination("service_stopped"));

    await waitFor(() => stream.isEnded());
    expect(stream.readText()).toContain('"state":"disconnected"');
    expect(stream.readText()).toContain('"reason":"engine_live_service_stopped"');
    expect(stream.readText()).toContain('"code":"stream_disconnected"');
    expect(stream.readText()).not.toContain(": heartbeat");
    expect(fixture.calls.unsubscribe).toHaveBeenCalledTimes(1);
    expect(fixture.calls.unsubscribeTermination).toHaveBeenCalledTimes(1);
    stream.close();
  });

  it("bounds the heartbeat lifecycle and releases the connection lease when the stream lifetime expires", async () => {
    const fixture = createEventPort({ reconnect: async () => replay([envelope("1")]) });
    const { app } = createApp(fixture.port, undefined, { maxLiveEventConnectionLifetimeMs: 1 });
    const stream = await openSseStream(app, `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);

    await waitFor(() => stream.isEnded());
    expect(stream.readText()).toContain('"code":"stream_disconnected"');
    expect(fixture.calls.unsubscribe).toHaveBeenCalledTimes(1);
    expect(fixture.calls.unsubscribeTermination).toHaveBeenCalledTimes(1);
    stream.close();
  });

  it("retains the callable subscription.closed signal as a safe reconnect boundary", async () => {
    const fixture = createEventPort({ reconnect: async () => replay([envelope("1")]) });
    const { app } = createApp(fixture.port);
    const stream = await openSseStream(app, `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);

    fixture.stop();

    await waitFor(() => stream.isEnded());
    expect(stream.readText()).toContain('"code":"stream_disconnected"');
    expect(fixture.calls.unsubscribe).toHaveBeenCalledTimes(1);
    stream.close();
  });

  it("writes a degraded connection and canonical alert before closing when the Engine durable poll fails", async () => {
    const fixture = createEventPort({ reconnect: async () => replay([envelope("1")]) });
    const { app } = createApp(fixture.port);
    const stream = await openSseStream(app, `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);

    fixture.terminate(termination("durable_poll_failed"));

    await waitFor(() => stream.isEnded());
    expect(stream.readText()).toContain("event: room.connection");
    expect(stream.readText()).toContain('"state":"degraded"');
    expect(stream.readText()).toContain('"reason":"canonical_durable_poll_failed"');
    expect(stream.readText()).toContain("event: room.alert");
    expect(stream.readText()).toContain('"code":"canonical_replay_failed"');
    expect(stream.readText()).not.toContain(": heartbeat");
    expect(fixture.calls.unsubscribe).toHaveBeenCalledTimes(1);
    expect(fixture.calls.unsubscribeTermination).toHaveBeenCalledTimes(1);
    stream.close();
  });

  it("writes only safe canonical metadata before closing an invalid durable page", async () => {
    const fixture = createEventPort({ reconnect: async () => replay([envelope("1")]) });
    const { app } = createApp(fixture.port);
    const stream = await openSseStream(app, `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);

    fixture.terminate(termination("canonical_page_invalid"));

    await waitFor(() => stream.isEnded());
    expect(stream.readText()).toContain('"state":"degraded"');
    expect(stream.readText()).toContain('"reason":"canonical_durable_page_invalid"');
    expect(stream.readText()).toContain('"code":"canonical_replay_invalid"');
    expect(stream.readText()).not.toContain(": heartbeat");
    stream.close();
  });

  it("renders a real Engine durable poll failure as a degraded terminal SSE stream", async () => {
    let canonicalReadCount = 0;
    const store = {
      subscribe: vi.fn(() => () => undefined),
      listEventPage: vi.fn(async () => {
        canonicalReadCount += 1;
        if (canonicalReadCount === 1) return { events: [], hasMore: false };
        throw new Error("canonical ledger unavailable");
      }),
    } as unknown as AsyncRoomStore;
    const liveService = new RoomControlPlaneLiveEventService({ projectId: PROJECT_ID, roomStore: store });
    const port = {
      listRooms: vi.fn(async () => ({ items: [], nextCursor: null })),
      getRoomProjection: vi.fn(async () => null),
      listResource: vi.fn(async () => ({ items: [], nextCursor: null })),
      mutate: vi.fn(async () => ({ accepted: false, reason: "unsupported" })),
      openRoomEventCursor: vi.fn(async () => ({
        reconnect: (input: { readonly projectId: string; readonly roomId: string; readonly afterCursor: string | null; readonly limit?: number }) => liveService.reconnect(input),
        subscribe: (
          input: { readonly projectId: string; readonly roomId: string; readonly holdUntilReplayWatermark?: boolean; readonly afterCursor?: string | null },
          listener: (notification: unknown) => void,
        ) => liveService.subscribe(input, listener),
        subscribeTermination: (
          input: { readonly projectId: string; readonly roomId: string },
          listener: (signal: unknown) => void,
        ) => liveService.subscribeTermination(input, listener),
      })),
    } as unknown as RoomControlPlaneRoutePort;
    const { app } = createApp(port);
    liveService.start();

    try {
      const stream = await openSseStream(app, `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);
      await waitFor(() => stream.isEnded());
      expect(stream.readText()).toContain("event: room.connection");
      expect(stream.readText()).toContain('"state":"degraded"');
      expect(stream.readText()).toContain('"reason":"canonical_durable_poll_failed"');
      expect(stream.readText()).toContain("event: room.alert");
      expect(stream.readText()).toContain('"code":"canonical_replay_failed"');
      expect(stream.readText()).not.toContain(": heartbeat");
      stream.close();
    } finally {
      liveService.stop();
    }
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

  it("projects only bounded canonical provenance to the browser event frame", async () => {
    const providerBody = "provider-response-must-not-reach-browser";
    const fixture = createEventPort({
      reconnect: async () => replay([
        envelope("1", { event: roomEvent("1", { payload: { providerBody } }) }),
      ]),
    });
    const { app } = createApp(fixture.port);

    const stream = await openSseStream(app, `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);
    const body = stream.readText();

    expect(body).toContain('"type":"canonical_room_event"');
    expect(body).toContain('"provenance":{"cursor":"1","eventId":"event-1","type":"room_projection_changed"');
    expect(body).toContain('"correlationId":"correlation-1"');
    expect(body).toContain('"causationId":null');
    expect(body).not.toContain(providerBody);
    expect(body).not.toContain('"envelope"');
    expect(body).not.toContain('"payload"');

    stream.close();
  });

  it("dedupes an exact buffered canonical replay duplicate but keeps later events", async () => {
    const fixture = createEventPort({ deliverBufferedReplayDuplicates: true });
    fixture.calls.reconnect.mockImplementation(async () => {
      fixture.emit(notification("2"));
      fixture.emit(notification("3"));
      return replay([envelope("1"), envelope("2")]);
    });
    const { app } = createApp(fixture.port);

    const stream = await openSseStream(app, `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);

    expect(sseEventIds(stream.readText())).toEqual(["1", "2", "3"]);
    expect(stream.readText()).not.toContain("canonical_replay_invalid");
    expect(stream.isEnded()).toBe(false);
    stream.close();
    await waitFor(() => fixture.calls.unsubscribe.mock.calls.length === 1);
  });

  it("keeps a real durable poll behind the replay watermark when a cursor reconnect races history", async () => {
    const durableEvents = ["1", "2", "3", "4", "5"].map((cursor) => roomEvent(cursor) as RoomEventRecordV1);
    const replayAfterFour = deferred<{ readonly events: readonly RoomEventRecordV1[]; readonly hasMore: boolean }>();
    const listeners = new Set<(event: RoomEventRecordV1) => void>();
    const listEventPage = vi.fn(async (_roomId: string, afterCursor?: string) => {
      if (afterCursor === "4") return replayAfterFour.promise;
      const after = afterCursor === undefined ? 0 : Number(afterCursor);
      return {
        events: durableEvents.filter((event) => Number(event.cursor) > after),
        hasMore: false,
      };
    });
    const store = {
      subscribe(listener: (event: RoomEventRecordV1) => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      listEventPage,
    } as unknown as AsyncRoomStore;
    const service = new RoomControlPlaneLiveEventService({
      projectId: PROJECT_ID,
      roomStore: store,
      durablePollIntervalMs: 250,
    });
    const subscribedInputs: unknown[] = [];
    const port = {
      listRooms: vi.fn(async () => ({ items: [], nextCursor: null })),
      getRoomProjection: vi.fn(async () => null),
      listResource: vi.fn(async () => ({ items: [], nextCursor: null })),
      mutate: vi.fn(async () => ({ accepted: false, reason: "unsupported" })),
      openRoomEventCursor: vi.fn(async () => ({
        reconnect: (input: { readonly projectId: string; readonly roomId: string; readonly afterCursor: string | null; readonly limit?: number }) => service.reconnect(input),
        subscribe: (
          input: { readonly projectId: string; readonly roomId: string; readonly afterCursor: string | null },
          listener: (notification: unknown) => void,
        ) => {
          subscribedInputs.push(input);
          return service.subscribe(input, listener);
        },
        subscribeTermination: (
          input: { readonly projectId: string; readonly roomId: string },
          listener: (signal: unknown) => void,
        ) => service.subscribeTermination(input, listener),
      })),
    } as unknown as RoomControlPlaneRoutePort;
    const { app } = createApp(port);
    service.start();

    try {
      const opening = openSseStream(
        app,
        `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}&cursor=4`,
        {},
        { waitTimeoutMs: 10_000 },
      );
      await waitFor(() => subscribedInputs.length === 1);
      expect(subscribedInputs).toEqual([{
        projectId: PROJECT_ID,
        roomId: ROOM_ID,
        actorId: "operator-room-events",
        afterCursor: "4",
        holdUntilReplayWatermark: true,
      }]);
      replayAfterFour.resolve({ events: [durableEvents[4]!], hasMore: false });

      const stream = await opening;
      expect(stream.status).toBe(200);
      expect(sseEventIds(stream.readText())).toEqual(["5"]);
      expect(stream.isEnded()).toBe(false);
      expect(stream.readText()).not.toContain("canonical_replay_invalid");
      expect(listEventPage).not.toHaveBeenCalledWith(ROOM_ID, undefined, expect.anything());
      stream.close();
    } finally {
      replayAfterFour.resolve({ events: [durableEvents[4]!], hasMore: false });
      service.stop();
    }
  });

  it("treats a canonical Last-Event-ID as authoritative over a stale query cursor while rejecting malformed input", async () => {
    const fixture = createEventPort({
      reconnect: async (input) => replay([], {
        nextCursor: (input as { readonly afterCursor: string | null }).afterCursor,
      }),
    });
    const { app } = createApp(fixture.port);

    const stream = await openSseStream(
      app,
      `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}&cursor=4`,
      { "last-event-id": "4" },
    );
    expect(fixture.calls.reconnect).toHaveBeenCalledWith(expect.objectContaining({ afterCursor: "4" }));
    stream.close();

    const staleQuery = await openSseStream(
      app,
      `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}&cursor=4`,
      { "last-event-id": "5" },
    );
    expect(staleQuery.status).toBe(200);
    expect(fixture.calls.reconnect).toHaveBeenLastCalledWith(expect.objectContaining({ afterCursor: "5" }));
    staleQuery.close();

    const malformedHeader = await request(app, "GET", `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}&cursor=4`, undefined, {
      "last-event-id": "04",
    });
    const malformedQuery = await request(app, "GET", `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}&cursor=04`, undefined, {
      "last-event-id": "5",
    });

    expect(malformedHeader.status).toBe(400);
    expect(malformedHeader.body).toMatchObject({ details: { code: "ROOM_EVENT_CURSOR_INVALID" } });
    expect(malformedQuery.status).toBe(400);
    expect(malformedQuery.body).toMatchObject({ details: { code: "ROOM_ROUTE_VALIDATION_FAILED" } });
    expect(fixture.calls.subscribe).toHaveBeenCalledTimes(2);
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
      resolveReplay?.(replay([]));
      await waitFor(() => fixture.calls.unsubscribe.mock.calls.length === 1);
    } finally {
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

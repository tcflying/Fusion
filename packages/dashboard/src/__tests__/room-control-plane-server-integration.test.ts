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
import {
  ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
  createInMemoryRoomRbacRegistry,
  createTrustedRoomDeviceCredential,
} from "@fusion/core";
import { RoomControlPlaneReadService } from "@fusion/engine";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as serverModule from "../server.js";
import { createServer, type RoomControlPlaneProjectAuthorizer } from "../server.js";
import { DEFAULT_ROOM_CONTROL_PLANE_TRUSTED_DEVICE_COOKIE_NAME } from "../room-control-plane-rbac-authorizer.js";
import { request } from "../test-request.js";

const PROJECT_ID = "project-room-server";
const ROOM_ID = "room-server-1";
const UPDATED_AT = "2026-07-19T08:00:00.000Z";
const DAEMON_TOKEN = "daemon-room-control-plane-token";
const ROOM_RBAC_PUBLIC_ORIGIN = "http://127.0.0.1";

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

async function openSseStream(app: express.Express, path: string, headers: Record<string, string> = {}) {
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
    isEnded(): boolean {
      return res.writableEnded;
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
  let terminationListener: ((signal: unknown) => void) | undefined;
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  const activate = vi.fn(() => true);
  const subscription = Object.assign(unsubscribe, { activate });
  const unsubscribeTermination = vi.fn(() => {
    terminationListener = undefined;
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
    return subscription;
  });
  const subscribeTermination = vi.fn((_scope: unknown, candidate: (signal: unknown) => void) => {
    terminationListener = candidate;
    return unsubscribeTermination;
  });
  return {
    service: { reconnect, subscribe, subscribeTermination },
    calls: { reconnect, subscribe, subscribeTermination, unsubscribe, unsubscribeTermination, activate },
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
    stop(): void {
      terminationListener?.({
        contractVersion: 1,
        type: "room_live_event_terminated",
        reason: "service_stopped",
        scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
        connection: {
          state: "disconnected",
          reason: "engine_live_service_stopped",
          changedAt: "2026-07-19T18:30:00.000Z",
        },
        alerts: [{
          code: "stream_disconnected",
          severity: "critical",
          scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
          cursor: null,
          expectedStreamSequence: null,
          observedStreamSequence: null,
        }],
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

function createProjectEngine(
  store: TaskStore,
  service: RoomControlPlaneReadService,
  liveEventService: unknown = undefined,
  executeHandler?: (command: unknown) => Promise<unknown>,
) {
  const getRoomControlPlaneReadService = vi.fn(() => service);
  const getRoomControlPlaneLiveEventService = vi.fn(() => liveEventService);
  const executeProjectRoomCommand = vi.fn(async (command: unknown) => {
    if (executeHandler) return await executeHandler(command);
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

async function createProjectOperatorRbac() {
  const registry = createInMemoryRoomRbacRegistry();
  const credential = createTrustedRoomDeviceCredential();
  const requestedAt = new Date();
  await registry.issueTrustedDeviceSession({
    contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
    projectId: PROJECT_ID,
    sessionId: "server-rbac-session",
    principalId: "server-rbac-operator",
    deviceId: "server-rbac-device",
    credential,
    issuedAt: new Date(requestedAt.getTime() - 60_000).toISOString(),
    expiresAt: new Date(requestedAt.getTime() + 60 * 60_000).toISOString(),
    idempotencyKey: "server-rbac-session",
  });
  await registry.grantRole({
    contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
    projectId: PROJECT_ID,
    grantId: "server-rbac-operator-grant",
    principalId: "server-rbac-operator",
    role: "operator",
    roomId: null,
    grantedAt: requestedAt.toISOString(),
    expectedAuthorizationVersion: 0,
    idempotencyKey: "server-rbac-operator-grant",
  });
  return { registry, credential };
}

function roomRbacOptions(
  resolveRegistry: NonNullable<Parameters<typeof createServer>[1]>["roomControlPlaneRbac"] extends infer Options
    ? Options extends { readonly resolveRegistry: infer Resolver } ? Resolver : never
    : never,
) {
  return {
    resolveRegistry,
    publicOrigin: ROOM_RBAC_PUBLIC_ORIGIN,
    allowLoopbackHttp: true,
  };
}

function trustedDeviceHeaders(credential: string): Record<string, string> {
  return {
    cookie: `${DEFAULT_ROOM_CONTROL_PLANE_TRUSTED_DEVICE_COOKIE_NAME}=${credential}`,
    origin: ROOM_RBAC_PUBLIC_ORIGIN,
    "sec-fetch-site": "same-origin",
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

  it("treats a daemon bearer only as transport authentication and never as a Room principal", async () => {
    const factory = (serverModule as {
      readonly createDaemonRoomControlPlaneAuthorizer?: (daemonToken: string) => RoomControlPlaneProjectAuthorizer;
    }).createDaemonRoomControlPlaneAuthorizer;

    expect(factory).toBeTypeOf("function");
    if (typeof factory !== "function") return;

    const authorize = factory(DAEMON_TOKEN);
    const headerTransportAuthenticated = await authorize(createDaemonAuthorizationInput(store, {
      authorization: `Bearer ${DAEMON_TOKEN}`,
    }));
    const eventSourceTransportAuthenticated = await authorize(createDaemonAuthorizationInput(store, {
      queryToken: DAEMON_TOKEN,
    }));
    const rejected = await authorize(createDaemonAuthorizationInput(store, {
      authorization: "Bearer wrong-daemon-token",
    }));

    expect(headerTransportAuthenticated).toEqual({ allowed: false, reason: "trusted-device-principal-required" });
    expect(eventSourceTransportAuthenticated).toEqual({ allowed: false, reason: "trusted-device-principal-required" });
    expect(rejected).toEqual({ allowed: false, reason: "daemon-token-required" });
    expect(JSON.stringify(headerTransportAuthenticated)).not.toContain(DAEMON_TOKEN);
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

  it("keeps an old connector compatible when Engine returns canonical withheld provider telemetry", async () => {
    const connectorId = "legacy-connector";
    const canonicalSessionUri = "codex://threads/legacy-session";
    const requiredHostId = "legacy-host";
    const identity = {
      connectorId,
      providerId: "happier",
      nativeSessionId: "legacy-native-session",
      happierSessionId: null,
      serverProfileId: null,
      machineId: null,
      hostId: requiredHostId,
    };
    const executeHandler = vi.fn(async () => ({
      type: "room.preflight-existing-session.v1" as const,
      projectId: PROJECT_ID,
      commandId: "server-legacy-telemetry:1",
      actor: { kind: "dashboard_operator" as const, principalId: "operator-room-server" },
      value: {
        contractVersion: 1,
        state: "identity_verified",
        request: { connectorId, canonicalSessionUri, requiredHostId },
        identity,
        checkedAt: "2026-07-21T03:00:00.000Z",
        providerTurnStarted: false,
        capabilities: [{ name: "ensureExisting", state: "verified" }],
        health: {
          state: "healthy",
          checkedAt: "2026-07-21T03:00:00.000Z",
          authentication: "authenticated",
          rateLimit: "clear",
          reasonCodes: [],
          retryAfterMs: null,
        },
        providerTelemetry: {
          contractVersion: 1,
          state: "withheld",
          identity,
          reason: "connector_telemetry_unsupported",
        },
      },
    }));
    const { service } = createReadService();
    const { engine, calls: engineCalls } = createProjectEngine(store, service, undefined, executeHandler);
    const { manager } = createEngineManager(engine);
    const authorizeProject = vi.fn<RoomControlPlaneProjectAuthorizer>(async () => ({
      allowed: true,
      actorId: "operator-room-server",
    }));
    const app = createServer(store, {
      engineManager: manager,
      roomControlPlaneAuthorizeProject: authorizeProject,
    });

    const response = await request(
      app,
      "POST",
      `/api/rooms/session-preflight?projectId=${PROJECT_ID}`,
      JSON.stringify({
        commandId: "server-legacy-telemetry",
        sessions: [{ connectorId, canonicalSessionUri, requiredHostId }],
      }),
      { "content-type": "application/json" },
    );

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const result = response.body.results[0].result;
    expect(result.providerTelemetry).toEqual({
      contractVersion: 1,
      state: "withheld",
      identity: result.identity,
      reason: "connector_telemetry_unsupported",
    });
    expect(engineCalls.executeProjectRoomCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: "room.preflight-existing-session.v1",
      projectId: PROJECT_ID,
      commandId: "server-legacy-telemetry:1",
    }), {
      kind: "dashboard_operator",
      principalId: "operator-room-server",
      authenticated: true,
    });
    expect(executeHandler).toHaveBeenCalledOnce();
  });

  it("mounts authenticated canonical Room SSE through the Engine live-event getter and terminates when its subscription closes", async () => {
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
    expect(live.calls.subscribe).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      actorId: "operator-room-server",
      holdUntilReplayWatermark: true,
      afterCursor: null,
    }, expect.any(Function));
    expect(live.calls.reconnect).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      afterCursor: null,
      limit: 128,
    });
    expect(live.calls.activate).toHaveBeenCalledWith("1");

    live.emit("2");
    await waitFor(() => stream.readText().includes("id: 2\nevent: room.event"));
    live.stop();
    await waitFor(() => stream.isEnded());
    expect(stream.readText()).toContain('"reason":"engine_live_service_stopped"');
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

  it("does not expose Room metadata or trusted-device pairing when daemon transport authentication is disabled", async () => {
    const { service } = createReadService();
    const { engine, calls: engineCalls } = createProjectEngine(store, service);
    const { manager } = createEngineManager(engine);
    const app = createServer(store, {
      engineManager: manager,
      roomControlPlaneRbac: roomRbacOptions(async () => createInMemoryRoomRbacRegistry()),
    });

    const metadata = await request(app, "GET", `/api/rooms?projectId=${PROJECT_ID}`);
    const pairing = await request(
      app,
      "POST",
      `/api/rooms/device-sessions?projectId=${PROJECT_ID}`,
      JSON.stringify({ projectId: PROJECT_ID, principalId: "forged-owner", deviceId: "forged-device" }),
      { "content-type": "application/json" },
    );

    expect(metadata.status).toBe(404);
    expect(pairing.status).toBe(404);
    expect(engineCalls.getRoomControlPlaneReadService).not.toHaveBeenCalled();
  });

  it("requires daemon transport and an existing durable owner before pairing a device", async () => {
    const { service } = createReadService();
    const { engine } = createProjectEngine(store, service);
    const { manager } = createEngineManager(engine);
    const registry = createInMemoryRoomRbacRegistry();
    const ownerCredential = createTrustedRoomDeviceCredential();
    const now = new Date();
    await registry.issueTrustedDeviceSession({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_ID,
      sessionId: "server-owner-session",
      principalId: "server-owner",
      deviceId: "server-owner-device",
      credential: ownerCredential,
      issuedAt: new Date(now.getTime() - 60_000).toISOString(),
      expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
      idempotencyKey: "server-owner-session",
    });
    await registry.grantRole({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_ID,
      grantId: "server-owner-grant",
      principalId: "server-owner",
      role: "owner",
      roomId: null,
      grantedAt: now.toISOString(),
      expectedAuthorizationVersion: 0,
      idempotencyKey: "server-owner-grant",
    });
    const app = createServer(store, {
      engineManager: manager,
      roomControlPlaneRbac: roomRbacOptions(async () => registry),
      daemon: { token: DAEMON_TOKEN },
    });

    const missingTransport = await request(
      app,
      "POST",
      `/api/rooms/device-sessions?projectId=${PROJECT_ID}`,
      JSON.stringify({}),
      { "content-type": "application/json" },
    );
    const bearerOnly = await request(
      app,
      "POST",
      `/api/rooms/device-sessions?projectId=${PROJECT_ID}`,
      undefined,
      { authorization: `Bearer ${DAEMON_TOKEN}` },
    );
    const forgedBody = await request(
      app,
      "POST",
      `/api/rooms/device-sessions?projectId=${PROJECT_ID}`,
      JSON.stringify({ principalId: "forged-owner", deviceId: "forged-device" }),
      { ...trustedDeviceHeaders(ownerCredential), "content-type": "application/json", authorization: `Bearer ${DAEMON_TOKEN}` },
    );
    const paired = await request(
      app,
      "POST",
      `/api/rooms/device-sessions?projectId=${PROJECT_ID}`,
      JSON.stringify({}),
      { ...trustedDeviceHeaders(ownerCredential), "content-type": "application/json", authorization: `Bearer ${DAEMON_TOKEN}` },
    );

    expect(missingTransport.status).toBe(401);
    expect(bearerOnly.status).toBe(403);
    expect(bearerOnly.body).toMatchObject({ details: { code: "ROOM_DEVICE_SESSION_ACCESS_DENIED" } });
    expect(forgedBody.status).toBe(400);
    expect(paired.status).toBe(201);
    expect(paired.body).toMatchObject({
      session: {
        deviceId: expect.any(String),
        expiresAt: expect.any(String),
      },
    });
    expect(paired.body.session).not.toHaveProperty("principalId");
  });

  it("does not start an untrusted project Engine when durable RBAC denies before project context resolution", async () => {
    const onProjectAccessed = vi.fn();
    const manager = {
      getEngine: vi.fn(() => undefined),
      onProjectAccessed,
    } as never;
    const app = createServer(store, {
      engineManager: manager,
      roomControlPlaneRbac: roomRbacOptions(async () => createInMemoryRoomRbacRegistry()),
      daemon: { token: DAEMON_TOKEN },
    });

    const response = await request(
      app,
      "GET",
      `/api/rooms?projectId=${PROJECT_ID}`,
      undefined,
      { authorization: `Bearer ${DAEMON_TOKEN}` },
    );

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ details: { code: "ROOM_PROJECT_ACCESS_DENIED" } });
    expect(onProjectAccessed).not.toHaveBeenCalled();
  });

  it("requires daemon transport auth plus the explicit durable RBAC resolver before any Engine port access", async () => {
    const { service, calls: serviceCalls } = createReadService();
    const live = createLiveEventService();
    const { engine, calls: engineCalls } = createProjectEngine(store, service, live.service);
    const { manager, calls: managerCalls } = createEngineManager(engine);
    const { registry, credential } = await createProjectOperatorRbac();
    const legacyAuthorizer = vi.fn<RoomControlPlaneProjectAuthorizer>(async () => ({
      allowed: false,
      reason: "legacy callback must not replace explicit durable RBAC",
    }));
    const resolveRegistry = vi.fn(async ({ projectId }: { projectId: string }) => (
      projectId === PROJECT_ID ? registry : undefined
    ));
    const app = createServer(store, {
      engineManager: manager,
      roomControlPlaneAuthorizeProject: legacyAuthorizer,
      roomControlPlaneRbac: roomRbacOptions(resolveRegistry),
      daemon: { token: DAEMON_TOKEN },
    });

    const forged = await request(
      app,
      "GET",
      `/api/rooms?projectId=${PROJECT_ID}&fn_token=${credential}`,
      undefined,
      { authorization: `Bearer ${DAEMON_TOKEN}`, "x-room-principal-id": "forged-owner" },
    );
    expect(forged.status).toBe(403);
    expect(engineCalls.getRoomControlPlaneReadService).not.toHaveBeenCalled();
    expect(managerCalls.getEngine).not.toHaveBeenCalled();
    expect(legacyAuthorizer).not.toHaveBeenCalled();

    const unauthenticated = await request(app, "GET", `/api/rooms?projectId=${PROJECT_ID}`);
    expect(unauthenticated.status).toBe(401);
    expect(engineCalls.getRoomControlPlaneReadService).not.toHaveBeenCalled();
    expect(managerCalls.getEngine).not.toHaveBeenCalled();

    const trustedTransportHeaders = {
      ...trustedDeviceHeaders(credential),
      authorization: `Bearer ${DAEMON_TOKEN}`,
    };
    const list = await request(app, "GET", `/api/rooms?projectId=${PROJECT_ID}`, undefined, trustedTransportHeaders);
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ rooms: [roomSummary()], nextCursor: null });
    expect(serviceCalls.listRoomSummaries).toHaveBeenCalledOnce();
    expect(legacyAuthorizer).not.toHaveBeenCalled();

    const deniedStream = await openSseStream(
      app,
      `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}&fn_token=${credential}`,
      { authorization: `Bearer ${DAEMON_TOKEN}` },
    );
    expect(deniedStream.status).toBe(403);
    expect(live.calls.subscribe).not.toHaveBeenCalled();

    const stream = await openSseStream(
      app,
      `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`,
      trustedTransportHeaders,
    );
    expect(stream.status).toBe(200);
    expect(stream.readText()).toContain("id: 1\nevent: room.event");
    expect(live.calls.subscribe).toHaveBeenCalledOnce();
    expect(resolveRegistry).toHaveBeenCalledTimes(2);
    stream.close();
    await waitFor(() => live.calls.unsubscribe.mock.calls.length === 1);
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

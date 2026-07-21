import express from "express";
import type { TaskStore } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api-error.js";
import { createAuthMiddleware } from "../../auth-middleware.js";
import { request } from "../../test-request.js";
import type { ApiRoutesContext } from "../types.js";
import {
  registerRoomControlPlaneRoutes,
  type RoomControlPlaneExistingSessionPreflightInputV1,
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
  readonly daemonBearerToken?: string | undefined;
} = {}) {
  const router = express.Router();
  const { port, calls } = input.port ? { port: input.port, calls: undefined } : createPort();
  const authorizeProject = vi.fn(async () => ({ allowed: true as const, actorId: "operator-1" }));
  const resolvePort = vi.fn(async () => port);
  const getProjectContext = vi.fn(async () => ({
    store: {} as TaskStore,
    engine: undefined,
    projectId: input.contextProjectId ?? PROJECT_ID,
  }));
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
    getProjectContext,
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
  if (input.daemonBearerToken) app.use(createAuthMiddleware(input.daemonBearerToken));
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

  return { app, calls, authorizeProject, resolvePort, getProjectContext, context };
}

function json(body: Record<string, unknown>): string {
  return JSON.stringify(body);
}

type ExistingSessionPreflightIdentity = Readonly<{
  connectorId: string;
  providerId: string;
  nativeSessionId: string;
  happierSessionId: string | null;
  serverProfileId: string | null;
  machineId: string | null;
  hostId: string;
}>;

function existingSessionPreflightIdentity(
  input: RoomControlPlaneExistingSessionPreflightInputV1,
  providerId: string,
): ExistingSessionPreflightIdentity {
  return {
    connectorId: input.connectorId,
    providerId,
    nativeSessionId: `native-${input.requiredHostId}`,
    happierSessionId: null,
    serverProfileId: null,
    machineId: input.requiredMachineId ?? null,
    hostId: input.requiredHostId,
  };
}

function reportedProviderTelemetry(identity: ExistingSessionPreflightIdentity): Record<string, unknown> {
  return {
    contractVersion: 1,
    state: "reported",
    identity,
    providerId: "codex",
    source: "happier_persisted_in_band_provider_snapshot",
    observedAt: "2026-07-21T03:00:00.000Z",
    expiresAt: "2026-07-21T04:00:00.000Z",
    freshness: "fresh",
    limitations: {
      providerAvailability: "not_inferred",
      capacity: "not_reported",
      onDemandProviderRefresh: "not_attempted",
      accountIdentity: "not_reported",
      rawSnapshot: "not_reported",
    },
  };
}

function withheldProviderTelemetry(identity: ExistingSessionPreflightIdentity): Record<string, unknown> {
  return {
    contractVersion: 1,
    state: "withheld",
    identity,
    reason: "connector_telemetry_unsupported",
  };
}

function existingSessionPreflightResult(
  input: RoomControlPlaneExistingSessionPreflightInputV1,
  identity: ExistingSessionPreflightIdentity,
  providerTelemetry: unknown,
): Record<string, unknown> {
  return {
    contractVersion: 1,
    state: "identity_verified",
    request: {
      connectorId: input.connectorId,
      canonicalSessionUri: input.canonicalSessionUri,
      requiredHostId: input.requiredHostId,
      ...(input.requiredMachineId === undefined ? {} : { requiredMachineId: input.requiredMachineId }),
    },
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
    providerTelemetry,
  };
}

function existingSessionPreflightBody(sessions: readonly Record<string, unknown>[]): string {
  return json({ commandId: "route-telemetry", sessions });
}

describe("Room control-plane routes", () => {
  it("returns exact reported and withheld provider telemetry projections for identity-verified existing Sessions", async () => {
    const preflightExistingSession = vi.fn(async (input: RoomControlPlaneExistingSessionPreflightInputV1) => {
      const identity = existingSessionPreflightIdentity(
        input,
        input.requiredHostId === "reported-host" ? "codex" : "happier",
      );
      const providerTelemetry = identity.providerId === "codex"
        ? reportedProviderTelemetry(identity)
        : withheldProviderTelemetry(identity);
      return {
        commandId: input.commandId,
        result: existingSessionPreflightResult(input, identity, providerTelemetry),
      };
    });
    const { port } = createPort({ preflightExistingSession });
    const { app } = createApp({ port });

    const response = await request(
      app,
      "POST",
      `/api/rooms/session-preflight?projectId=${PROJECT_ID}`,
      existingSessionPreflightBody([
        {
          connectorId: "connector-reported",
          canonicalSessionUri: "codex://threads/reported",
          requiredHostId: "reported-host",
        },
        {
          connectorId: "connector-legacy",
          canonicalSessionUri: "codex://threads/legacy",
          requiredHostId: "legacy-host",
        },
      ]),
      { "content-type": "application/json" },
    );

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const [reported, withheld] = response.body.results;
    expect(reported.result.providerTelemetry).toEqual({
      contractVersion: 1,
      state: "reported",
      identity: reported.result.identity,
      providerId: "codex",
      source: "happier_persisted_in_band_provider_snapshot",
      observedAt: "2026-07-21T03:00:00.000Z",
      expiresAt: "2026-07-21T04:00:00.000Z",
      freshness: "fresh",
      limitations: {
        providerAvailability: "not_inferred",
        capacity: "not_reported",
        onDemandProviderRefresh: "not_attempted",
        accountIdentity: "not_reported",
        rawSnapshot: "not_reported",
      },
    });
    expect(withheld.result.providerTelemetry).toEqual({
      contractVersion: 1,
      state: "withheld",
      identity: withheld.result.identity,
      reason: "connector_telemetry_unsupported",
    });
    expect(Object.keys(reported.result.providerTelemetry).sort()).toEqual([
      "contractVersion",
      "expiresAt",
      "freshness",
      "identity",
      "limitations",
      "observedAt",
      "providerId",
      "source",
      "state",
    ]);
    expect(Object.keys(withheld.result.providerTelemetry).sort()).toEqual([
      "contractVersion",
      "identity",
      "reason",
      "state",
    ]);
  });

  it("fails closed when provider telemetry includes sensitive extras", async () => {
    const preflightExistingSession = vi.fn(async (input: RoomControlPlaneExistingSessionPreflightInputV1) => {
      const identity = existingSessionPreflightIdentity(input, "codex");
      return {
        commandId: input.commandId,
        result: existingSessionPreflightResult(input, identity, {
          ...reportedProviderTelemetry(identity),
          rawSnapshot: "provider-raw-secret",
          quota: "provider-quota-secret",
          profile: "provider-profile-secret",
          account: "provider-account-secret",
        }),
      };
    });
    const { port } = createPort({ preflightExistingSession });
    const { app } = createApp({ port });

    const response = await request(
      app,
      "POST",
      `/api/rooms/session-preflight?projectId=${PROJECT_ID}`,
      existingSessionPreflightBody([{
        connectorId: "connector-reported",
        canonicalSessionUri: "codex://threads/reported",
        requiredHostId: "reported-host",
      }]),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ details: { code: "ROOM_EXISTING_SESSION_PREFLIGHT_PORT_INVALID" } });
    expect(JSON.stringify(response.body)).not.toContain("provider-raw-secret");
    expect(JSON.stringify(response.body)).not.toContain("provider-quota-secret");
    expect(JSON.stringify(response.body)).not.toContain("provider-profile-secret");
    expect(JSON.stringify(response.body)).not.toContain("provider-account-secret");
  });

  it("fails closed when provider telemetry identity differs from the verified preflight identity", async () => {
    const preflightExistingSession = vi.fn(async (input: RoomControlPlaneExistingSessionPreflightInputV1) => {
      const identity = existingSessionPreflightIdentity(input, "codex");
      return {
        commandId: input.commandId,
        result: existingSessionPreflightResult(input, identity, reportedProviderTelemetry({
          ...identity,
          nativeSessionId: "other-native-session",
        })),
      };
    });
    const { port } = createPort({ preflightExistingSession });
    const { app } = createApp({ port });

    const response = await request(
      app,
      "POST",
      `/api/rooms/session-preflight?projectId=${PROJECT_ID}`,
      existingSessionPreflightBody([{
        connectorId: "connector-reported",
        canonicalSessionUri: "codex://threads/reported",
        requiredHostId: "reported-host",
      }]),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ details: { code: "ROOM_EXISTING_SESSION_PREFLIGHT_PORT_INVALID" } });
  });

  it("fails closed when the project authorization port denies the request", async () => {
    const { app, calls, resolvePort, getProjectContext } = createApp({
      dependencies: {
        authorizeProject: async () => ({ allowed: false, reason: "observer role" }),
      },
    });

    const response = await request(app, "GET", `/api/rooms?projectId=${PROJECT_ID}`);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ details: { code: "ROOM_PROJECT_ACCESS_DENIED" } });
    expect(getProjectContext).not.toHaveBeenCalled();
    expect(resolvePort).not.toHaveBeenCalled();
    expect(calls?.listRooms).not.toHaveBeenCalled();
  });

  it("issues a trusted-device cookie only through the configured durable pairing issuer", async () => {
    const issueTrustedDeviceSession = vi.fn(async () => ({
      credential: "a".repeat(43),
      sessionId: "paired-session",
      principalId: "paired-principal",
      deviceId: "paired-device",
      expiresAt: "2030-01-01T00:00:00.000Z",
    }));
    const authorizeProject = Object.assign(vi.fn(async () => ({ allowed: true as const, actorId: "operator-1" })), {
      issueTrustedDeviceSession,
    });
    const { app } = createApp({ dependencies: { authorizeProject } });

    const response = await request(
      app,
      "POST",
      `/api/rooms/device-sessions?projectId=${PROJECT_ID}`,
      json({}),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      session: {
        sessionId: "paired-session",
        deviceId: "paired-device",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
    });
    expect(String(response.headers["set-cookie"])).toContain("__Host-fusion-room-device=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(issueTrustedDeviceSession).toHaveBeenCalledWith(expect.objectContaining({
      projectId: PROJECT_ID,
    }));
    expect(issueTrustedDeviceSession.mock.calls[0]?.[0]).not.toHaveProperty("principalId");
    expect(issueTrustedDeviceSession.mock.calls[0]?.[0]).not.toHaveProperty("deviceId");
  });

  it("does not mount a direct trusted-device issuer when the control plane has no durable pairing capability", async () => {
    const { app } = createApp();

    const response = await request(
      app,
      "POST",
      `/api/rooms/device-sessions?projectId=${PROJECT_ID}`,
      json({}),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(404);
  });

  it("requires the existing daemon bearer before the durable pairing issuer can create a device session", async () => {
    const issueTrustedDeviceSession = vi.fn(async () => ({
      credential: "b".repeat(43),
      sessionId: "daemon-paired-session",
      principalId: "paired-principal",
      deviceId: "paired-device",
      expiresAt: "2030-01-01T00:00:00.000Z",
    }));
    const authorizeProject = Object.assign(vi.fn(async () => ({ allowed: true as const, actorId: "operator-1" })), {
      issueTrustedDeviceSession,
    });
    const { app } = createApp({
      daemonBearerToken: "daemon-pairing-token",
      dependencies: { authorizeProject },
    });
    const body = json({});

    const rejected = await request(app, "POST", `/api/rooms/device-sessions?projectId=${PROJECT_ID}`, body, { "content-type": "application/json" });
    const accepted = await request(app, "POST", `/api/rooms/device-sessions?projectId=${PROJECT_ID}`, body, {
      "content-type": "application/json",
      authorization: "Bearer daemon-pairing-token",
    });

    expect(rejected.status).toBe(401);
    expect(accepted.status).toBe(201);
    expect(issueTrustedDeviceSession).toHaveBeenCalledTimes(1);
  });

  it("revokes a paired trusted-device session through the configured durable pairing issuer", async () => {
    const revokeTrustedDeviceSession = vi.fn(async () => ({
      sessionId: "paired-session",
      revokedAt: "2030-01-01T00:01:00.000Z",
      sessionVersion: 2,
    }));
    const authorizeProject = Object.assign(vi.fn(async () => ({ allowed: true as const, actorId: "operator-1" })), {
      issueTrustedDeviceSession: vi.fn(),
      revokeTrustedDeviceSession,
    });
    const { app } = createApp({ dependencies: { authorizeProject } });

    const response = await request(
      app,
      "DELETE",
      "/api/rooms/device-sessions/paired-session",
      json({ projectId: PROJECT_ID, expectedSessionVersion: 1 }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ session: {
      sessionId: "paired-session",
      revokedAt: "2030-01-01T00:01:00.000Z",
      sessionVersion: 2,
    } });
    expect(revokeTrustedDeviceSession).toHaveBeenCalledWith(expect.objectContaining({
      projectId: PROJECT_ID,
      sessionId: "paired-session",
      expectedSessionVersion: 1,
    }));
  });

  it("rejects a request whose declared project scope differs from the resolved project", async () => {
    const { app, authorizeProject, resolvePort } = createApp({ contextProjectId: PROJECT_ID });

    const response = await request(app, "GET", `/api/rooms?projectId=${OTHER_PROJECT_ID}`);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ details: { code: "ROOM_PROJECT_SCOPE_MISMATCH" } });
    expect(authorizeProject).toHaveBeenCalledWith(expect.objectContaining({ projectId: OTHER_PROJECT_ID }));
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

  it("rejects caller-selected pairing project and principal before the issuer or project context runs", async () => {
    const issueTrustedDeviceSession = vi.fn(async () => ({
      credential: "c".repeat(43),
      sessionId: "would-not-be-issued",
      principalId: "would-not-be-issued",
      deviceId: "would-not-be-issued",
      expiresAt: "2030-01-01T00:00:00.000Z",
    }));
    const authorizeProject = Object.assign(vi.fn(async () => ({ allowed: true as const, actorId: "operator-1" })), {
      issueTrustedDeviceSession,
    });
    const { app, getProjectContext } = createApp({ dependencies: { authorizeProject } });

    const response = await request(
      app,
      "POST",
      `/api/rooms/device-sessions?projectId=${PROJECT_ID}`,
      json({ projectId: OTHER_PROJECT_ID, principalId: "forged-owner", deviceId: "forged-device" }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ details: { code: "ROOM_ROUTE_VALIDATION_FAILED" } });
    expect(issueTrustedDeviceSession).not.toHaveBeenCalled();
    expect(getProjectContext).not.toHaveBeenCalled();
  });

  it("uses the resolved query scope and returns no caller principal from a trusted-device pairing response", async () => {
    const issueTrustedDeviceSession = vi.fn(async () => ({
      credential: "d".repeat(43),
      sessionId: "server-generated-session",
      principalId: "durable-owner",
      deviceId: "server-generated-device",
      expiresAt: "2030-01-01T00:00:00.000Z",
    }));
    const authorizeProject = Object.assign(vi.fn(async () => ({ allowed: true as const, actorId: "operator-1" })), {
      issueTrustedDeviceSession,
    });
    const { app, getProjectContext } = createApp({ dependencies: { authorizeProject } });

    const response = await request(
      app,
      "POST",
      `/api/rooms/device-sessions?projectId=${PROJECT_ID}`,
      json({}),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(201);
    expect(response.body).toEqual({
      session: {
        sessionId: "server-generated-session",
        deviceId: "server-generated-device",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
    });
    expect(issueTrustedDeviceSession).toHaveBeenCalledWith(expect.objectContaining({ projectId: PROJECT_ID }));
    expect(issueTrustedDeviceSession.mock.calls[0]?.[0]).not.toHaveProperty("principalId");
    expect(issueTrustedDeviceSession.mock.calls[0]?.[0]).not.toHaveProperty("deviceId");
    expect(getProjectContext).not.toHaveBeenCalled();
  });

  it("maps an unexpected Room-port error to a stable browser-safe response", async () => {
    const rawProviderFailure = "provider-body=do-not-expose";
    const { port } = createPort({
      listRooms: async () => {
        throw new Error(rawProviderFailure);
      },
    });
    const { app } = createApp({ port });

    const response = await request(app, "GET", `/api/rooms?projectId=${PROJECT_ID}`);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: "Room control-plane request failed.",
      details: { code: "ROOM_CONTROL_PLANE_ROUTE_FAILED" },
    });
    expect(JSON.stringify(response.body)).not.toContain(rawProviderFailure);
  });
});

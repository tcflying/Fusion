import express from "express";
import type { AsyncRoomStore, TaskStore } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";
import { RoomControlPlaneLiveEventService } from "../../../engine/src/room-control-plane-live-event-service.js";
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

function createEngine(
  projectId: string,
  service: unknown,
  liveEventService: unknown = undefined,
  executionStatus: unknown = undefined,
): RoomControlPlaneProjectEngine {
  return {
    getProjectId: () => projectId,
    getRoomControlPlaneReadService: () => service,
    getRoomControlPlaneLiveEventService: () => liveEventService,
    getRoomControlPlaneExecutionStatus: () => executionStatus,
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

function evolutionShadowRequestBody(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    contractVersion: 1,
    hypothesisId: "hypothesis-shadow-1",
    candidateVersionId: "candidate-shadow-1",
    ...overrides,
  });
}

function existingSessionPreflightRequestBody(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    commandId: "cockpit-preflight",
    sessions: [{
      connectorId: "happier-runtime",
      canonicalSessionUri: "codex://threads/019f22f6-6581-7781-bb37-84cf4d63d81d",
      requiredHostId: "windows-host-1",
    }],
    ...overrides,
  });
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
  input: {
    readonly connectorId: string;
    readonly requiredHostId: string;
    readonly requiredMachineId?: string;
  },
  providerId = "happier",
): ExistingSessionPreflightIdentity {
  return {
    connectorId: input.connectorId,
    providerId,
    nativeSessionId: "019f22f6-6581-7781-bb37-84cf4d63d81d",
    happierSessionId: "cmrlz93zb002jg1888442usqo",
    serverProfileId: "srv_lbLN2rpeYpZBvdYD7njB20g85I8BJsYx",
    machineId: input.requiredMachineId ?? "windows-machine-1",
    hostId: input.requiredHostId,
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

function existingSessionPreflightValue(input: {
  readonly connectorId: string;
  readonly canonicalSessionUri: string;
  readonly requiredHostId: string;
  readonly requiredMachineId?: string;
}, options: Readonly<{
  providerId?: string;
  providerTelemetry?: unknown;
}> = {}): Record<string, unknown> {
  const identity = existingSessionPreflightIdentity(input, options.providerId);
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
    checkedAt: "2026-07-20T07:30:00.000Z",
    providerTurnStarted: false,
    capabilities: [
      { name: "ensureExisting", state: "verified" },
      { name: "status", state: "verified" },
      { name: "history", state: "verified" },
      { name: "send", state: "verified" },
    ],
    health: {
      state: "healthy",
      checkedAt: "2026-07-20T07:30:00.000Z",
      authentication: "authenticated",
      rateLimit: "clear",
      reasonCodes: [],
      retryAfterMs: null,
    },
    providerTelemetry: options.providerTelemetry ?? withheldProviderTelemetry(identity),
  };
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
  app.use((_req, res) => {
    res.status(404).json({ error: "Route not found" });
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

  it("exposes safe execution withholding even when the Room read service is unavailable", async () => {
    const status = {
      contractVersion: 1,
      projectId: PROJECT_ID,
      state: "read_only_withheld",
      reasonCodes: ["durable_async_layer_missing"],
      changedAt: "2026-07-20T01:00:00.000Z",
      readServiceAvailable: false,
      liveEventServiceAvailable: false,
      controllerStarted: false,
    };
    const { app } = createApp({
      resolveProjectEngine: () => createEngine(PROJECT_ID, undefined, undefined, status),
    });

    const response = await request(app, "GET", `/api/room-control-plane/status?projectId=${PROJECT_ID}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status });
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

  it("maps create, restore, attach, and remove to exact Engine Room commands with CAS", async () => {
    const service = createReadService();
    const executeProjectRoomCommand = vi.fn(async (command: { type: string; commandId: string }) => ({
      type: command.type,
      projectId: PROJECT_ID,
      commandId: command.commandId,
      actor: { kind: "dashboard_operator", principalId: "operator-1" },
      value: {
        room: { id: ROOM_ID, projectId: PROJECT_ID, aggregateVersion: 8 },
        membershipVersion: 4,
        pendingMembershipChanges: [],
      },
    }));
    const { app } = createApp({
      resolveProjectEngine: () => ({
        ...createEngine(PROJECT_ID, service),
        executeProjectRoomCommand: executeProjectRoomCommand as RoomControlPlaneProjectEngine["executeProjectRoomCommand"],
      }),
    });
    const createPayload = {
      room: {
        id: ROOM_ID,
        objective: "Coordinate exact existing Sessions",
        protocolId: "analysis-decision",
        protocolVersion: 1,
        createdBy: "operator-1",
      },
      sessions: [
        {
          seatId: "seat-codex",
          bindingId: "binding-codex-1",
          role: "implementer",
          permissionScope: ["room:message"],
          connectorId: "happier",
          canonicalSessionUri: "codex://threads/thread-1",
          requiredHostId: "windows-host-1",
          requiredMachineId: "machine-1",
          idempotencyKey: "ensure-codex-1",
        },
        {
          seatId: "seat-claude",
          bindingId: "binding-claude-1",
          role: "reviewer",
          permissionScope: ["room:message", "candidate:review"],
          connectorId: "happier",
          canonicalSessionUri: "claude://sessions/session-2",
          requiredHostId: "windows-host-1",
          requiredMachineId: "machine-1",
          idempotencyKey: "ensure-claude-1",
        },
      ],
      roleAssignment: {
        capabilitySnapshot: {
          contractVersion: 1,
          snapshotId: "operator-certified-snapshot-1",
          revision: 1,
          capturedAt: "2026-07-27T06:00:00.000Z",
          bindings: [],
        },
        constraints: { locks: [], forbids: [] },
      },
    };
    const addSession = {
      seatId: "seat-opencode",
      bindingId: "binding-opencode-1",
      role: "reviewer",
      permissionScope: ["room:message"],
      connectorId: "happier",
      canonicalSessionUri: "opencode://sessions/session-3",
      requiredHostId: "windows-host-1",
      requiredMachineId: "machine-1",
      idempotencyKey: "ensure-opencode-1",
    };

    const created = await request(
      app,
      "POST",
      `/api/rooms?projectId=${PROJECT_ID}`,
      JSON.stringify({
        expectedAggregateVersion: 0,
        commandId: "create-room-command-1",
        payload: createPayload,
      }),
      { "content-type": "application/json" },
    );
    const restored = await request(
      app,
      "POST",
      `/api/rooms/${ROOM_ID}/actions?projectId=${PROJECT_ID}`,
      JSON.stringify({
        expectedAggregateVersion: 8,
        commandId: "restore-room-command-1",
        action: "restore_existing_sessions",
        payload: {},
      }),
      { "content-type": "application/json" },
    );
    const attached = await request(
      app,
      "POST",
      `/api/rooms/${ROOM_ID}/actions?projectId=${PROJECT_ID}`,
      JSON.stringify({
        expectedAggregateVersion: 8,
        commandId: "add-session-command-1",
        action: "request_add_existing_session",
        payload: {
          expectedMembershipVersion: 4,
          changeId: "change-add-opencode",
          reason: "Add an independent reviewer",
          session: addSession,
        },
      }),
      { "content-type": "application/json" },
    );
    const removed = await request(
      app,
      "POST",
      `/api/rooms/${ROOM_ID}/actions?projectId=${PROJECT_ID}`,
      JSON.stringify({
        expectedAggregateVersion: 8,
        commandId: "remove-session-command-1",
        action: "request_remove_existing_session",
        payload: {
          expectedMembershipVersion: 4,
          changeId: "change-remove-opencode",
          reason: "Reviewer completed the assignment",
          seatId: "seat-opencode",
        },
      }),
      { "content-type": "application/json" },
    );

    expect([created.status, restored.status, attached.status, removed.status]).toEqual([201, 200, 200, 200]);
    expect([created.body.aggregateVersion, restored.body.aggregateVersion, attached.body.aggregateVersion, removed.body.aggregateVersion])
      .toEqual([8, 8, 8, 8]);
    expect(executeProjectRoomCommand.mock.calls.map(([command]) => command)).toEqual([
      {
        type: "room.create-existing-session.v1",
        projectId: PROJECT_ID,
        commandId: "create-room-command-1",
        input: createPayload,
      },
      {
        type: "room.restore-existing-sessions.v1",
        projectId: PROJECT_ID,
        commandId: "restore-room-command-1",
        input: {
          roomId: ROOM_ID,
          expectedAggregateVersion: 8,
          idempotencyKey: "restore-room-command-1",
        },
      },
      {
        type: "room.request-add-existing-session.v1",
        projectId: PROJECT_ID,
        commandId: "add-session-command-1",
        input: {
          roomId: ROOM_ID,
          expectedAggregateVersion: 8,
          expectedMembershipVersion: 4,
          changeId: "change-add-opencode",
          idempotencyKey: "add-session-command-1",
          reason: "Add an independent reviewer",
          session: addSession,
        },
      },
      {
        type: "room.request-remove-existing-session.v1",
        projectId: PROJECT_ID,
        commandId: "remove-session-command-1",
        input: {
          roomId: ROOM_ID,
          seatId: "seat-opencode",
          expectedAggregateVersion: 8,
          expectedMembershipVersion: 4,
          changeId: "change-remove-opencode",
          idempotencyKey: "remove-session-command-1",
          reason: "Reviewer completed the assignment",
        },
      },
    ]);
    expect(executeProjectRoomCommand.mock.calls.every(([, principal]) => (
      principal.kind === "dashboard_operator"
      && principal.principalId === "operator-1"
      && principal.authenticated === true
    ))).toBe(true);
  });

  it("preflights multiple existing Sessions through the route-owned read-only command without creating a Room or provider turn, including canonical legacy telemetry withholding", async () => {
    const service = createReadService();
    const executeProjectRoomCommand = vi.fn(async (command: {
      readonly type: string;
      readonly projectId: string;
      readonly commandId: string;
      readonly input: {
        readonly connectorId: string;
        readonly canonicalSessionUri: string;
        readonly requiredHostId: string;
        readonly requiredMachineId?: string;
      };
    }) => ({
      type: "room.preflight-existing-session.v1" as const,
      projectId: command.projectId,
      commandId: command.commandId,
      actor: { kind: "dashboard_operator" as const, principalId: "operator-1" },
      value: existingSessionPreflightValue(command.input),
    }));
    const { app, authorizeProject } = createApp({
      resolveProjectEngine: () => ({
        ...createEngine(PROJECT_ID, service),
        executeProjectRoomCommand: executeProjectRoomCommand as RoomControlPlaneProjectEngine["executeProjectRoomCommand"],
      }),
    });

    const response = await request(
      app,
      "POST",
      `/api/rooms/session-preflight?projectId=${PROJECT_ID}`,
      existingSessionPreflightRequestBody({
        sessions: [
          {
            connectorId: "happier-runtime",
            canonicalSessionUri: "codex://threads/019f22f6-6581-7781-bb37-84cf4d63d81d",
            requiredHostId: "windows-host-1",
          },
          {
            connectorId: "happier-runtime",
            canonicalSessionUri: "claude://sessions/claude-session-2",
            requiredHostId: "windows-host-2",
            requiredMachineId: "windows-machine-2",
          },
        ],
      }),
      { "content-type": "application/json" },
    );

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      results: [
        {
          commandId: "cockpit-preflight:1",
          result: {
            state: "identity_verified",
            providerTurnStarted: false,
            identity: { connectorId: "happier-runtime", hostId: "windows-host-1" },
            providerTelemetry: {
              state: "withheld",
              identity: { connectorId: "happier-runtime", hostId: "windows-host-1" },
              reason: "connector_telemetry_unsupported",
            },
          },
        },
        {
          commandId: "cockpit-preflight:2",
          result: {
            state: "identity_verified",
            providerTurnStarted: false,
            identity: { connectorId: "happier-runtime", hostId: "windows-host-2", machineId: "windows-machine-2" },
          },
        },
      ],
    });
    expect(authorizeProject).toHaveBeenCalledWith(expect.objectContaining({
      projectId: PROJECT_ID,
      access: "write",
      resource: "room",
      roomId: null,
      operation: "command",
      action: "preflight_existing_session",
    }));
    expect(executeProjectRoomCommand).toHaveBeenCalledTimes(2);
    expect(executeProjectRoomCommand).toHaveBeenNthCalledWith(1, {
      type: "room.preflight-existing-session.v1",
      projectId: PROJECT_ID,
      commandId: "cockpit-preflight:1",
      input: {
        connectorId: "happier-runtime",
        canonicalSessionUri: "codex://threads/019f22f6-6581-7781-bb37-84cf4d63d81d",
        requiredHostId: "windows-host-1",
      },
    }, {
      kind: "dashboard_operator",
      principalId: "operator-1",
      authenticated: true,
    });
    expect(executeProjectRoomCommand).toHaveBeenNthCalledWith(2, {
      type: "room.preflight-existing-session.v1",
      projectId: PROJECT_ID,
      commandId: "cockpit-preflight:2",
      input: {
        connectorId: "happier-runtime",
        canonicalSessionUri: "claude://sessions/claude-session-2",
        requiredHostId: "windows-host-2",
        requiredMachineId: "windows-machine-2",
      },
    }, {
      kind: "dashboard_operator",
      principalId: "operator-1",
      authenticated: true,
    });
  });

  it("projects canonical reported Codex provider telemetry through the Engine dependency without exposing omitted fields", async () => {
    const service = createReadService();
    const executeProjectRoomCommand = vi.fn(async (command: {
      readonly projectId: string;
      readonly commandId: string;
      readonly input: {
        readonly connectorId: string;
        readonly canonicalSessionUri: string;
        readonly requiredHostId: string;
        readonly requiredMachineId?: string;
      };
    }) => {
      const identity = existingSessionPreflightIdentity(command.input, "codex");
      return {
        type: "room.preflight-existing-session.v1" as const,
        projectId: command.projectId,
        commandId: command.commandId,
        actor: { kind: "dashboard_operator" as const, principalId: "operator-1" },
        value: existingSessionPreflightValue(command.input, {
          providerId: "codex",
          providerTelemetry: reportedProviderTelemetry(identity),
        }),
      };
    });
    const { app } = createApp({
      resolveProjectEngine: () => ({
        ...createEngine(PROJECT_ID, service),
        executeProjectRoomCommand: executeProjectRoomCommand as RoomControlPlaneProjectEngine["executeProjectRoomCommand"],
      }),
    });

    const response = await request(
      app,
      "POST",
      `/api/rooms/session-preflight?projectId=${PROJECT_ID}`,
      existingSessionPreflightRequestBody(),
      { "content-type": "application/json" },
    );

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const result = response.body.results[0].result;
    expect(result.providerTelemetry).toEqual({
      contractVersion: 1,
      state: "reported",
      identity: result.identity,
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
    expect(Object.keys(result.providerTelemetry).sort()).toEqual([
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
    expect(Object.keys(result.providerTelemetry.limitations).sort()).toEqual([
      "accountIdentity",
      "capacity",
      "onDemandProviderRefresh",
      "providerAvailability",
      "rawSnapshot",
    ]);
    expect(executeProjectRoomCommand).toHaveBeenCalledOnce();
  });

  it("bounds existing-Session preflight fan-out to four Engine commands", async () => {
    const service = createReadService();
    let active = 0;
    let maximumActive = 0;
    const executeProjectRoomCommand = vi.fn(async (command: {
      readonly projectId: string;
      readonly commandId: string;
      readonly input: {
        readonly connectorId: string;
        readonly canonicalSessionUri: string;
        readonly requiredHostId: string;
        readonly requiredMachineId?: string;
      };
    }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return {
        type: "room.preflight-existing-session.v1" as const,
        projectId: command.projectId,
        commandId: command.commandId,
        actor: { kind: "dashboard_operator" as const, principalId: "operator-1" },
        value: existingSessionPreflightValue(command.input),
      };
    });
    const { app } = createApp({
      resolveProjectEngine: () => ({
        ...createEngine(PROJECT_ID, service),
        executeProjectRoomCommand: executeProjectRoomCommand as RoomControlPlaneProjectEngine["executeProjectRoomCommand"],
      }),
    });
    const sessions = Array.from({ length: 6 }, (_value, index) => ({
      connectorId: "happier-runtime",
      canonicalSessionUri: `codex://threads/thread-${index + 1}`,
      requiredHostId: "windows-host-1",
    }));

    const response = await request(
      app,
      "POST",
      `/api/rooms/session-preflight?projectId=${PROJECT_ID}`,
      existingSessionPreflightRequestBody({ sessions }),
      { "content-type": "application/json" },
    );

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(executeProjectRoomCommand).toHaveBeenCalledTimes(6);
    expect(maximumActive).toBe(4);
  });

  it("does not resolve an Engine when existing-Session preflight authorization is denied", async () => {
    const service = createReadService();
    const { app, resolveProjectEngine } = createApp({
      authorizeProject: vi.fn(async () => ({ allowed: false as const, reason: "observer" })),
      resolveProjectEngine: () => createEngine(PROJECT_ID, service),
    });

    const response = await request(
      app,
      "POST",
      `/api/rooms/session-preflight?projectId=${PROJECT_ID}`,
      existingSessionPreflightRequestBody(),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ details: { code: "ROOM_PROJECT_ACCESS_DENIED" } });
    expect(resolveProjectEngine).not.toHaveBeenCalled();
  });

  it("withholds the HTTP response when an Engine returns an invalid preflight payload", async () => {
    const service = createReadService();
    const executeProjectRoomCommand = vi.fn(async (command: {
      readonly projectId: string;
      readonly commandId: string;
    }) => ({
      type: "room.preflight-existing-session.v1" as const,
      projectId: command.projectId,
      commandId: command.commandId,
      actor: { kind: "dashboard_operator" as const, principalId: "operator-1" },
      value: { secret: "must-not-reach-browser" },
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
      `/api/rooms/session-preflight?projectId=${PROJECT_ID}`,
      existingSessionPreflightRequestBody(),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ details: { code: "ROOM_EXISTING_SESSION_PREFLIGHT_PORT_INVALID" } });
    expect(JSON.stringify(response.body)).not.toContain("must-not-reach-browser");
  });

  it("records a bounded Evolution Shadow receipt through a route-owned command and authenticated Dashboard principal", async () => {
    const service = createReadService();
    const executeProjectRoomCommand = vi.fn(async (command: {
      readonly commandId: string;
    }) => ({
      type: "room.record-evolution-shadow.v1" as const,
      projectId: PROJECT_ID,
      commandId: command.commandId,
      actor: { kind: "dashboard_operator" as const, principalId: "operator-1" },
      value: {
        status: "shadow_recorded" as const,
        receipt: {
          experimentId: "evolution-shadow:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          projectId: PROJECT_ID,
          roomId: ROOM_ID,
          hypothesisId: "hypothesis-shadow-1",
          candidateVersionId: "candidate-shadow-1",
          state: "planned" as const,
          capacityPool: "evolution_paused" as const,
          createdAt: "2026-07-19T12:00:00.000Z",
        },
      },
    }));
    const { app, authorizeProject } = createApp({
      resolveProjectEngine: () => ({
        ...createEngine(PROJECT_ID, service),
        executeProjectRoomCommand: executeProjectRoomCommand as RoomControlPlaneProjectEngine["executeProjectRoomCommand"],
      }),
    });

    const response = await request(
      app,
      "POST",
      `/api/rooms/${ROOM_ID}/evolution-shadow?projectId=${PROJECT_ID}`,
      evolutionShadowRequestBody(),
      { "content-type": "application/json" },
    );

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({
      accepted: true,
      commandId: expect.stringMatching(/^room-evolution-shadow:[0-9a-f-]{36}$/u),
      result: {
        status: "shadow_recorded",
        receipt: {
          projectId: PROJECT_ID,
          roomId: ROOM_ID,
          hypothesisId: "hypothesis-shadow-1",
          candidateVersionId: "candidate-shadow-1",
          state: "planned",
          capacityPool: "evolution_paused",
        },
      },
    });
    expect(authorizeProject).toHaveBeenCalledWith(expect.objectContaining({
      projectId: PROJECT_ID,
      access: "write",
      resource: "room",
      roomId: ROOM_ID,
      operation: "command",
      action: "record_evolution_shadow",
    }));
    expect(executeProjectRoomCommand).toHaveBeenCalledWith(expect.objectContaining({
      type: "room.record-evolution-shadow.v1",
      projectId: PROJECT_ID,
      commandId: response.body.commandId,
      input: {
        contractVersion: 1,
        roomId: ROOM_ID,
        hypothesisId: "hypothesis-shadow-1",
        candidateVersionId: "candidate-shadow-1",
      },
    }), {
      kind: "dashboard_operator",
      principalId: "operator-1",
      authenticated: true,
    });
  });

  it("returns an explicitly withheld Evolution Shadow outcome without pretending to run full self-evolution", async () => {
    const service = createReadService();
    const executeProjectRoomCommand = vi.fn(async (command: {
      readonly commandId: string;
    }) => ({
      type: "room.record-evolution-shadow.v1" as const,
      projectId: PROJECT_ID,
      commandId: command.commandId,
      actor: { kind: "dashboard_operator" as const, principalId: "operator-1" },
      value: { status: "withheld" as const, reason: "evolution_ledger_unavailable" as const },
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
      `/api/rooms/${ROOM_ID}/evolution-shadow?projectId=${PROJECT_ID}`,
      evolutionShadowRequestBody(),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      accepted: true,
      commandId: expect.stringMatching(/^room-evolution-shadow:[0-9a-f-]{36}$/u),
      result: { status: "withheld", reason: "evolution_ledger_unavailable" },
    });
    expect(executeProjectRoomCommand).toHaveBeenCalledTimes(1);
  });

  it("denies Evolution Shadow before resolving an Engine when Room authorization rejects the scoped command", async () => {
    const service = createReadService();
    const { app, resolveProjectEngine } = createApp({
      authorizeProject: vi.fn(async () => ({ allowed: false as const, reason: "not-an-operator" })),
      resolveProjectEngine: () => createEngine(PROJECT_ID, service),
    });

    const response = await request(
      app,
      "POST",
      `/api/rooms/${ROOM_ID}/evolution-shadow?projectId=${PROJECT_ID}`,
      evolutionShadowRequestBody(),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ details: { code: "ROOM_PROJECT_ACCESS_DENIED" } });
    expect(resolveProjectEngine).not.toHaveBeenCalled();
  });

  it("rejects client attempts to widen Evolution Shadow identity, project, or command scope", async () => {
    const service = createReadService();
    const executeProjectRoomCommand = vi.fn();
    const { app, resolveProjectEngine } = createApp({
      resolveProjectEngine: () => ({
        ...createEngine(PROJECT_ID, service),
        executeProjectRoomCommand: executeProjectRoomCommand as RoomControlPlaneProjectEngine["executeProjectRoomCommand"],
      }),
    });

    const response = await request(
      app,
      "POST",
      `/api/rooms/${ROOM_ID}/evolution-shadow?projectId=${PROJECT_ID}`,
      evolutionShadowRequestBody({
        actorId: "payload-actor",
        projectId: OTHER_PROJECT_ID,
        commandId: "payload-command-id",
      }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ details: { code: "ROOM_ROUTE_VALIDATION_FAILED" } });
    expect(resolveProjectEngine).not.toHaveBeenCalled();
    expect(executeProjectRoomCommand).not.toHaveBeenCalled();
  });

  it("rejects a project scope that cannot be matched to the resolved Room context before recording Evolution Shadow", async () => {
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
      `/api/rooms/${ROOM_ID}/evolution-shadow?projectId=${OTHER_PROJECT_ID}`,
      evolutionShadowRequestBody(),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ details: { code: "ROOM_PROJECT_SCOPE_MISMATCH" } });
    expect(executeProjectRoomCommand).not.toHaveBeenCalled();
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
    const subscription = Object.assign(unsubscribe, { activate: () => true });
    const subscribe = vi.fn(() => subscription);
    const subscribeTermination = vi.fn(() => vi.fn());
    const { app } = createApp({
      resolveProjectEngine: () => createEngine(PROJECT_ID, service, { reconnect, subscribe, subscribeTermination }),
    });

    const response = await request(app, "GET", `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ details: { code: "ROOM_EVENT_RECONCILIATION_REQUIRED" } });
    expect(JSON.stringify(response.body)).not.toContain("internal secret");
    expect(subscribe).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      actorId: "operator-1",
      afterCursor: null,
      holdUntilReplayWatermark: true,
    }, expect.any(Function));
    expect(reconnect).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      afterCursor: null,
      limit: 128,
    });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(service.getRoomProjection).not.toHaveBeenCalled();
  });

  it("adapts the real Engine live service shape, including its explicit scoped termination boundary", async () => {
    const service = createReadService();
    const roomStore = {
      subscribe: vi.fn(() => () => undefined),
      listEventPage: vi.fn(async () => {
        throw new Error("canonical ledger unavailable");
      }),
    } as unknown as AsyncRoomStore;
    const liveService = new RoomControlPlaneLiveEventService({ projectId: PROJECT_ID, roomStore });
    const subscribe = vi.spyOn(liveService, "subscribe");
    const subscribeTermination = vi.spyOn(liveService, "subscribeTermination");
    const { app } = createApp({
      resolveProjectEngine: () => createEngine(PROJECT_ID, service, liveService),
    });

    const response = await request(app, "GET", `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ details: { code: "ROOM_EVENT_RECONCILIATION_REQUIRED" } });
    expect(subscribeTermination).toHaveBeenCalledWith(
      { projectId: PROJECT_ID, roomId: ROOM_ID },
      expect.any(Function),
    );
    expect(subscribe).toHaveBeenCalledWith(
      {
        projectId: PROJECT_ID,
        roomId: ROOM_ID,
        actorId: "operator-1",
        afterCursor: null,
        holdUntilReplayWatermark: true,
      },
      expect.any(Function),
    );
  });

  it("maps a retryable Engine subscription capacity rejection to an observable route error", async () => {
    const service = createReadService();
    const roomStore = {
      subscribe: vi.fn(() => () => undefined),
      listEventPage: vi.fn(async () => ({ events: [], hasMore: false })),
    } as unknown as AsyncRoomStore;
    const liveService = new RoomControlPlaneLiveEventService({
      projectId: PROJECT_ID,
      roomStore,
      maxLiveEventSubscriptions: 1,
    });
    const held = liveService.subscribe({ projectId: PROJECT_ID, roomId: ROOM_ID }, () => undefined);
    const dependencies = createRoomControlPlaneEngineRouteDependencies({
      authorizeProject: async () => ({ allowed: true as const, actorId: "operator-1" }),
      resolveProjectEngine: async () => createEngine(PROJECT_ID, service, liveService),
    });

    let routeSubscription: (() => void) | undefined;
    try {
      const port = await dependencies.resolvePort({
        request: new Request(`http://localhost/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`),
        projectId: PROJECT_ID,
        store: {} as TaskStore,
        actorId: "operator-1",
      });
      const livePort = await port.openRoomEventCursor({ projectId: PROJECT_ID, roomId: ROOM_ID });
      let thrown: unknown;
      try {
        routeSubscription = livePort.subscribe({
          projectId: PROJECT_ID,
          roomId: ROOM_ID,
          actorId: "operator-1",
        }, () => undefined);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toMatchObject({
        statusCode: 429,
        details: expect.objectContaining({
          code: "ROOM_CONTROL_PLANE_LIVE_EVENT_SUBSCRIPTION_LIMITED",
          retryAfter: 1,
          retryable: true,
        }),
      });
    } finally {
      routeSubscription?.();
      held();
      liveService.stop();
    }
  });

  it("fails closed before subscribing when the canonical Engine lacks explicit termination", async () => {
    const service = createReadService();
    const reconnect = vi.fn(async () => ({
      ok: true,
      outcome: "up_to_date",
      scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
      replaySource: "canonical_port",
      events: [],
      nextCursor: null,
      hasMore: false,
      connection: { state: "connected", reason: null, changedAt: null },
      alerts: [],
    }));
    const subscribe = vi.fn(() => Object.assign(vi.fn(), { activate: () => true }));
    const { app } = createApp({
      resolveProjectEngine: () => createEngine(PROJECT_ID, service, { reconnect, subscribe }),
    });

    const response = await request(app, "GET", `/api/rooms/${ROOM_ID}/events?projectId=${PROJECT_ID}`);

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ details: { code: "ROOM_CONTROL_PLANE_LIVE_EVENT_SERVICE_INVALID" } });
    expect(subscribe).not.toHaveBeenCalled();
    expect(reconnect).not.toHaveBeenCalled();
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
      subscribeTermination: vi.fn(),
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

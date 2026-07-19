// @vitest-environment node

import { EventEmitter } from "node:events";
import type {
  AsyncRoomStore,
  RoomAggregateV1,
  RoomSummaryV1,
  RoomTaskGraphProjectionV1,
  TaskStore,
} from "@fusion/core";
import { RoomControlPlaneReadService } from "@fusion/engine";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type RoomControlPlaneProjectAuthorizer } from "../server.js";
import { request } from "../test-request.js";

const PROJECT_ID = "project-room-server";
const ROOM_ID = "room-server-1";
const UPDATED_AT = "2026-07-19T08:00:00.000Z";

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

function createProjectEngine(store: TaskStore, service: RoomControlPlaneReadService) {
  const getRoomControlPlaneReadService = vi.fn(() => service);
  return {
    engine: {
      getProjectId: () => PROJECT_ID,
      getTaskStore: () => store,
      getRoomControlPlaneReadService,
    },
    calls: { getRoomControlPlaneReadService },
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

describe("Room control-plane server wiring", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new MemoryStore() as unknown as TaskStore;
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

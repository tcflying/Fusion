// @vitest-environment node

import express from "express";
import type { TaskStore } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";
import { createApiRoutes } from "../../routes.js";
import { request } from "../../test-request.js";
import type {
  RoomControlPlaneRouteDependencies,
  RoomControlPlaneRoutePort,
} from "../register-room-control-plane-routes.js";

const PROJECT_ID = "project-room-bootstrap";

function createStore() {
  return {
    getRootDir: () => "/workspace",
    getSecretsStore: () => ({ revealSecret: vi.fn() }),
    getSettingsByScope: async () => ({ global: { mcpServers: { enabled: true, servers: [] } }, project: {} }),
  } as TaskStore;
}

function createRoutePort() {
  const listRooms = vi.fn(async () => ({
    items: [{ id: "room-bootstrap", status: "active" }],
    nextCursor: null,
  }));
  const port = {
    listRooms,
    getRoomProjection: vi.fn(async () => null),
    listResource: vi.fn(async () => ({ items: [], nextCursor: null })),
    mutate: vi.fn(async () => ({ accepted: true as const, aggregateVersion: 1 })),
    openRoomEventCursor: vi.fn() as RoomControlPlaneRoutePort["openRoomEventCursor"],
  } satisfies RoomControlPlaneRoutePort;
  return { port, listRooms };
}

function createApp(dependencies?: RoomControlPlaneRouteDependencies) {
  const store = createStore();
  const engine = { getTaskStore: () => store };
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(store, {
    engineManager: {
      getEngine: vi.fn(() => engine),
      onProjectAccessed: vi.fn(),
    } as never,
    ...(dependencies ? { roomControlPlaneRouteDependencies: dependencies } : {}),
  }));
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  return app;
}

describe("Room control-plane route bootstrap", () => {
  it("does not expose Room control-plane routes without an injected dependency port", async () => {
    const response = await request(createApp(), "GET", `/api/rooms?projectId=${PROJECT_ID}`);

    expect(response.status).toBe(404);
  });

  it("registers Room control-plane routes only when the authorized dependency port is injected", async () => {
    const { port, listRooms } = createRoutePort();
    const authorizeProject = vi.fn(async () => ({ allowed: true as const, actorId: "operator-bootstrap" }));
    const resolvePort = vi.fn(async () => port);
    const response = await request(
      createApp({ authorizeProject, resolvePort }),
      "GET",
      `/api/rooms?projectId=${PROJECT_ID}`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ rooms: [{ id: "room-bootstrap", status: "active" }], nextCursor: null });
    expect(authorizeProject).toHaveBeenCalledWith(expect.objectContaining({
      projectId: PROJECT_ID,
      access: "read",
      resource: "room",
      roomId: null,
    }));
    expect(resolvePort).toHaveBeenCalledWith(expect.objectContaining({
      projectId: PROJECT_ID,
      actorId: "operator-bootstrap",
    }));
    expect(listRooms).toHaveBeenCalledWith({ projectId: PROJECT_ID, cursor: null, limit: null });
  });
});

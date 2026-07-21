/**
 * FNXC:HostBootstrap 2026-07-20-05:20:
 * This is a no-PostgreSQL unit seam for the host-layer contract. The external
 * integration suite also covers it when psql is available, but this proof must
 * remain runnable on Windows machines that intentionally do not ship psql.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  const connections = {
    runtime: { source: "shared-runtime-connection" },
    migration: { execute: vi.fn() },
    close: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue(undefined),
  };
  const projectLayer = {
    db: connections.runtime,
    projectId: "project-host-layer",
    close: vi.fn().mockResolvedValue(undefined),
  };
  const hostLayer = {
    db: connections.runtime,
    projectId: undefined,
    close: vi.fn().mockResolvedValue(undefined),
  };
  const createConnectionSet = vi.fn().mockResolvedValue(connections);
  const createConnectionSetFromUrl = vi.fn().mockResolvedValue(connections);
  const applySchemaBaseline = vi.fn().mockResolvedValue(undefined);
  const createAsyncDataLayer = vi.fn().mockImplementation(
    (_connections: unknown, options?: { projectId?: string }) =>
      options?.projectId ? projectLayer : hostLayer,
  );
  const taskStoreInit = vi.fn().mockResolvedValue(undefined);
  const taskStoreClose = vi.fn().mockResolvedValue(undefined);
  const TaskStore = vi.fn().mockImplementation(function (
    _rootDir: string,
    _globalSettingsDir: string | undefined,
    options: { asyncLayer?: unknown },
  ) {
    return {
      init: taskStoreInit,
      close: taskStoreClose,
      getAsyncLayer: vi.fn(() => options.asyncLayer),
    };
  });

  return {
    connections,
    projectLayer,
    hostLayer,
    createConnectionSet,
    createConnectionSetFromUrl,
    applySchemaBaseline,
    createAsyncDataLayer,
    taskStoreInit,
    taskStoreClose,
    TaskStore,
  };
});

vi.mock("../../postgres/connection.js", () => ({
  createConnectionSet: state.createConnectionSet,
  createConnectionSetFromUrl: state.createConnectionSetFromUrl,
  DatabaseConnectionError: class DatabaseConnectionError extends Error {},
}));

vi.mock("../../postgres/schema-applier.js", () => ({
  applySchemaBaseline: state.applySchemaBaseline,
}));

vi.mock("../../postgres/data-layer.js", () => ({
  createAsyncDataLayer: state.createAsyncDataLayer,
}));

vi.mock("../../store.js", () => ({
  TaskStore: state.TaskStore,
}));

import { createTaskStoreForBackend } from "../../postgres/startup-factory.js";

describe("startup-factory: host async layer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.connections.migration.execute.mockResolvedValue([{ id: "project-host-layer" }]);
    state.createConnectionSet.mockResolvedValue(state.connections);
    state.createConnectionSetFromUrl.mockResolvedValue(state.connections);
    state.applySchemaBaseline.mockResolvedValue(undefined);
    state.taskStoreInit.mockResolvedValue(undefined);
    state.taskStoreClose.mockResolvedValue(undefined);
  });

  it("keeps the project layer scoped while exposing an unscoped sibling over the same connections", async () => {
    const boot = await createTaskStoreForBackend({
      rootDir: "C:\\fusion-host-layer-project",
      env: { DATABASE_URL: "postgresql://localhost:5432/fusion_host_layer_test" },
    });

    expect(boot).not.toBeNull();
    expect(boot!.asyncLayer).toBe(state.projectLayer);
    expect(boot!.asyncLayer.projectId).toBe("project-host-layer");
    expect(boot!.hostAsyncLayer).toBe(state.hostLayer);
    expect(boot!.hostAsyncLayer.projectId).toBeUndefined();
    expect(boot!.hostAsyncLayer.db).toBe(boot!.asyncLayer.db);
    expect(state.createAsyncDataLayer).toHaveBeenNthCalledWith(
      1,
      state.connections,
      { projectId: "project-host-layer" },
    );
    expect(state.createAsyncDataLayer).toHaveBeenNthCalledWith(2, state.connections);

    await boot!.shutdown();

    expect(state.taskStoreClose).toHaveBeenCalledTimes(1);
    expect(state.hostLayer.close).not.toHaveBeenCalled();
  });
});

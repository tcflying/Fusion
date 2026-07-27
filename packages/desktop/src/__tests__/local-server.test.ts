import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;
  class SimpleEmitter {
    private listeners = new Map<string, Handler[]>();
    on(event: string, handler: Handler) {
      const current = this.listeners.get(event) ?? [];
      current.push(handler);
      this.listeners.set(event, current);
      return this;
    }
    once(event: string, handler: Handler) {
      const wrapped: Handler = (...args) => {
        this.removeListener(event, wrapped);
        handler(...args);
      };
      return this.on(event, wrapped);
    }
    removeListener(event: string, handler: Handler) {
      const current = this.listeners.get(event) ?? [];
      this.listeners.set(event, current.filter((item) => item !== handler));
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      const current = this.listeners.get(event) ?? [];
      for (const handler of current) {
        handler(...args);
      }
    }
  }

  // FN-7623: pluginStore/pluginLoader mocks proving local-server.ts wires the plugin subsystem
  // into createServer (the fix for "Plugin install mode is not supported" and the Browse-registry
  // "Plugin \"registry\" not found" symptoms).
  const pluginStoreInstance = {
    init: vi.fn(async () => undefined),
  };
  const pluginSchemaContracts = [{
    pluginId: "fusion-plugin-postgres-schema",
    postgresSchema: { version: 1, tables: [] },
  }];
  const pluginLoaderInstance = {
    loadAllPlugins: vi.fn(async () => ({ loaded: 2, errors: 0 })),
    getPluginSchemaInitHooks: vi.fn(() => pluginSchemaContracts),
  };
  const runPluginSchemaInits = vi.fn(async () => undefined);
  const PluginLoader = vi.fn(function () {
    return pluginLoaderInstance;
  });

  // FN-7637: bundled-plugin auto-install mocks proving local-server.ts wires
  // ensureBundledPluginInstalled/isBundledPluginId from @fusion/core into both the startup
  // auto-install pass (Dependency Graph before loadAllPlugins) and the createServer(...)
  // callback option consumed by PUT /api/plugins/:id/settings.
  const ensureBundledPluginInstalled = vi.fn(async () => "installed" as const);
  const isBundledPluginId = vi.fn((id: string) => id.startsWith("fusion-plugin-"));
  const resolveDesktopBundlePluginDirs = vi.fn((pluginId: string) => [`/desktop/node_modules/@fusion-plugin-examples/${pluginId.replace(/^fusion-plugin-/, "")}`]);

  const store = {
    init: vi.fn(async () => undefined),
    watch: vi.fn(async () => undefined),
    close: vi.fn(),
    getPluginStore: vi.fn(() => pluginStoreInstance),
    runPluginSchemaInits,
    getAsyncLayer: vi.fn(() => ({ projectId: "project-1" } as never)),
  };
  const backendShutdown = vi.fn(async () => store.close());
  const centralCore = {
    init: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    getProjectByPath: vi.fn(async () => ({ id: "project-1", name: "Repo", path: "/repo", status: "active" })),
    // Default: an operator who already onboarded a project. resolveDesktopRuntimePrimaryProject
    // picks the first one; the runtime NEVER auto-registers the runtime root.
    listProjects: vi.fn(async () => [{ id: "project-1", name: "Repo", path: "/repo", status: "active" }]),
    registerProject: vi.fn(async ({ path, name }: { path: string; name: string }) => ({ id: "project-1", name, path, status: "initializing" })),
    updateProject: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ id, name: "Repo", path: "/repo", status: patch.status ?? "active" })),
  };
  const roomRbacAsyncLayer = { projectId: "project-1" };
  const roomRbacRegistry = { source: "durable-room-rbac-registry" };
  const engine = {
    id: "engine-1",
    getTaskStore: vi.fn(() => ({
      getAsyncLayer: vi.fn(() => roomRbacAsyncLayer),
    })),
  };
  const engineMap = new Map([["project-1", engine]]);
  const engineManager = {
    startAll: vi.fn(async () => undefined),
    startReconciliation: vi.fn(),
    stopAll: vi.fn(async () => undefined),
    getAllEngines: vi.fn(() => engineMap),
    getEngine: vi.fn((projectId: string) => engineMap.get(projectId)),
    ensureEngine: vi.fn(async () => engine),
    onProjectAccessed: vi.fn(),
  };

  class TaskStore {
    constructor(_rootDir: string) {}
    init = store.init;
    watch = store.watch;
    close = store.close;
    getPluginStore = store.getPluginStore;
    getAsyncLayer = store.getAsyncLayer;
    getDatabase = vi.fn(() => ({ runPluginSchemaInits }));
  }

  const server = Object.assign(new SimpleEmitter(), {
    address: vi.fn(() => ({ port: 4545 })),
    close: vi.fn((cb: () => void) => cb()),
  });

  const listen = vi.fn(() => {
    queueMicrotask(() => server.emit("listening"));
    return server;
  });

  const createServer = vi.fn(() => ({ listen }));

  const CentralCore = vi.fn(function () {
    return centralCore;
  });
  const ProjectEngineManager = vi.fn(function () {
    return engineManager;
  });

  // FN-7622: mirrors @fusion/engine's real seedDashboardProviders() shape — wraps the raw
  // authStorage into a distinguishable WRAPPED object so tests can assert local-server.ts passes
  // the wrapped storage (not the raw one) into createServer, and returns a disposer.
  const modelRegistry = { listModels: vi.fn(() => []), refresh: vi.fn() };
  const createFusionModelRegistry = vi.fn(async () => modelRegistry);
  const seedDashboardProvidersDispose = vi.fn();
  const seedDashboardProviders = vi.fn(async ({ authStorage }: { authStorage: unknown }) => ({
    authStorage: { ...(authStorage as object), __wrapped: true },
    dispose: seedDashboardProvidersDispose,
  }));
  const createPostgresRoomRbacRegistry = vi.fn(() => roomRbacRegistry);
  const createDashboardAuthContext = vi.fn((input: { host: string; noAuth?: boolean }) => ({
    mode: "loopback-no-auth" as const,
    host: input.host,
  }));
  const createTaskStoreForBackend = vi.fn(async () => null);

  return {
    TaskStore,
    backendShutdown,
    CentralCore,
    PluginLoader,
    ProjectEngineManager,
    createServer,
    store,
    listen,
    centralCore,
    engineManager,
    engine,
    pluginStoreInstance,
    pluginLoaderInstance,
    runPluginSchemaInits,
    createFusionModelRegistry,
    modelRegistry,
    seedDashboardProviders,
    seedDashboardProvidersDispose,
    createPostgresRoomRbacRegistry,
    createDashboardAuthContext,
    createTaskStoreForBackend,
    ensureBundledPluginInstalled,
    isBundledPluginId,
    resolveDesktopBundlePluginDirs,
    roomRbacAsyncLayer,
    roomRbacRegistry,
  };
});

vi.mock("@fusion/core", () => ({
  TaskStore: mocks.TaskStore,
  /* FNXC:MigrationHoldingPage 2026-07-17-13:50: local-server.ts formats migration progress for the launch gate. */
  formatMigrationProgress: (event: { phase: string }) => `migration ${event.phase}`,
  CentralCore: mocks.CentralCore,
  createPostgresRoomRbacRegistry: mocks.createPostgresRoomRbacRegistry,
  createTaskStoreForBackend: mocks.createTaskStoreForBackend,
  PluginLoader: mocks.PluginLoader,
  ensureBundledPluginInstalled: mocks.ensureBundledPluginInstalled,
  isBundledPluginId: mocks.isBundledPluginId,
}));
vi.mock("../bundled-plugin-dirs.js", () => ({ resolveDesktopBundlePluginDirs: mocks.resolveDesktopBundlePluginDirs }));
vi.mock("@fusion/dashboard", () => ({
  createDashboardAuthContext: mocks.createDashboardAuthContext,
  createServer: mocks.createServer,
}));
vi.mock("@fusion/engine", () => ({
  ProjectEngineManager: mocks.ProjectEngineManager,
  createFusionAuthStorage: () => ({ reload: () => undefined, getOAuthProviders: () => [], hasAuth: () => false }),
  createFusionModelRegistry: mocks.createFusionModelRegistry,
  // FN-7622: seedDashboardProviders is asserted directly in provider-registration.test.ts; this
  // desktop-side mock just proves local-server.ts calls it and wires its returned WRAPPED auth
  // storage (not the raw one) into createServer.
  seedDashboardProviders: mocks.seedDashboardProviders,
}));

describe("DesktopLocalServerManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createTaskStoreForBackend.mockResolvedValue(null);
  });

  it("starts local runtime and exposes port", async () => {
    const { DesktopLocalServerManager } = await import("../local-server.ts");
    const manager = new DesktopLocalServerManager("/repo");

    const runtime = await manager.start();

    expect(runtime.port).toBe(4545);
    expect(manager.getPort()).toBe(4545);
    expect(manager.getState().status).toBe("ready");
    expect(mocks.engineManager.startAll).toHaveBeenCalledTimes(1);
    expect(mocks.CentralCore).toHaveBeenCalledWith(undefined, undefined);
    // No auto-registration of the runtime root; the primary engine is the first existing project.
    expect(mocks.centralCore.registerProject).not.toHaveBeenCalled();
    expect(mocks.engineManager.ensureEngine).toHaveBeenCalledWith("project-1");
    expect(mocks.createServer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        engine: mocks.engine,
        engineManager: mocks.engineManager,
        centralCore: mocks.centralCore,
      }),
    );
  });

  it("uses the backend boot's unscoped host layer for CentralCore", async () => {
    const { DesktopLocalServerManager } = await import("../local-server.ts");
    const hostAsyncLayer = { scope: "host" };
    mocks.createTaskStoreForBackend.mockResolvedValueOnce({
      taskStore: mocks.store,
      hostAsyncLayer,
      shutdown: vi.fn(async () => undefined),
    });
    const manager = new DesktopLocalServerManager("/repo");

    await manager.start();

    expect(mocks.CentralCore).toHaveBeenCalledWith(undefined, { asyncLayer: hostAsyncLayer });

    await manager.stop();
  });

  it("composes the legacy packaged server with durable Room RBAC on loopback", async () => {
    const { DesktopLocalServerManager } = await import("../local-server.ts");
    const manager = new DesktopLocalServerManager("/repo");

    await manager.start();

    const serverOptions = mocks.createServer.mock.calls[0]?.[1] as {
      dashboardAuthContext?: unknown;
      roomControlPlaneRbac?: {
        resolveRegistry(input: { projectId: string }): Promise<unknown> | unknown;
        resolvePublicOrigin(request: { socket: { localAddress?: string; localPort?: number } }): string;
        authorizeDaemonTransport(request: {
          headers: Record<string, string | undefined>;
          socket: { localAddress?: string; localPort?: number };
        }): Promise<boolean> | boolean;
      };
    };
    expect(mocks.createDashboardAuthContext).toHaveBeenCalledWith({
      host: "127.0.0.1",
      noAuth: true,
    });
    expect(serverOptions.dashboardAuthContext).toEqual({
      mode: "loopback-no-auth",
      host: "127.0.0.1",
    });
    expect(serverOptions.roomControlPlaneRbac).toBeDefined();
    expect(await serverOptions.roomControlPlaneRbac?.resolveRegistry({ projectId: "project-1" }))
      .toBe(mocks.roomRbacRegistry);
    expect(mocks.createPostgresRoomRbacRegistry).toHaveBeenCalledWith(mocks.roomRbacAsyncLayer);
    expect(serverOptions.roomControlPlaneRbac?.resolvePublicOrigin({
      socket: { localAddress: "127.0.0.1", localPort: 4545 },
    })).toBe("http://127.0.0.1:4545");
    expect(await serverOptions.roomControlPlaneRbac?.authorizeDaemonTransport({
      headers: {
        host: "127.0.0.1:4545",
        origin: "http://127.0.0.1:4545",
        "sec-fetch-site": "same-origin",
      },
      socket: { localAddress: "127.0.0.1", localPort: 4545 },
    })).toBe(true);
    expect(mocks.listen).toHaveBeenCalledWith(0, "127.0.0.1");

    await manager.stop();
  });

  it("stops local runtime and resets state", async () => {
    const { DesktopLocalServerManager } = await import("../local-server.ts");
    const manager = new DesktopLocalServerManager("/repo");
    await manager.start();

    await manager.stop();

    expect(mocks.engineManager.stopAll).toHaveBeenCalled();
    expect(mocks.centralCore.close).toHaveBeenCalled();
    expect(mocks.store.close).toHaveBeenCalled();
    expect(manager.getState().status).toBe("idle");
    expect(manager.getPort()).toBeUndefined();
  });

  it("sets error state when startup fails", async () => {
    mocks.store.init.mockRejectedValueOnce(new Error("init failed"));
    const { DesktopLocalServerManager } = await import("../local-server.ts");
    const manager = new DesktopLocalServerManager("/repo");

    await expect(manager.start()).rejects.toThrow("init failed");
    expect(manager.getState()).toMatchObject({ status: "error", error: "init failed" });
  });

  it("cleans up engine and central core when server creation fails", async () => {
    mocks.createServer.mockImplementationOnce(() => {
      throw new Error("server failed");
    });
    const { DesktopLocalServerManager } = await import("../local-server.ts");
    const manager = new DesktopLocalServerManager("/repo");

    await expect(manager.start()).rejects.toThrow("server failed");

    expect(mocks.engineManager.stopAll).toHaveBeenCalled();
    expect(mocks.centralCore.close).toHaveBeenCalled();
    expect(mocks.store.close).toHaveBeenCalled();
    expect(manager.getState()).toMatchObject({ status: "error", error: "server failed" });
  });

  it("never auto-registers a project and starts engine-less when no projects exist", async () => {
    mocks.centralCore.listProjects.mockResolvedValueOnce([]);
    const { DesktopLocalServerManager } = await import("../local-server.ts");
    const manager = new DesktopLocalServerManager("/repo");

    const runtime = await manager.start();

    // Fresh install: the runtime must NOT create a project for its root; the dashboard onboards.
    expect(mocks.centralCore.registerProject).not.toHaveBeenCalled();
    expect(mocks.engineManager.ensureEngine).not.toHaveBeenCalled();
    // The server still starts (engine-less) so the dashboard can render its onboarding empty state.
    expect(runtime.port).toBe(4545);
    expect(mocks.createServer).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ engine: expect.anything() }),
    );
  });

  it("returns existing runtime when start is called twice", async () => {
    const { DesktopLocalServerManager } = await import("../local-server.ts");
    const manager = new DesktopLocalServerManager("/repo");

    const first = await manager.start();
    const second = await manager.start();

    expect(first).toBe(second);
    expect(mocks.listen).toHaveBeenCalledTimes(1);
  });

  /*
   * FN-7622 symptom verification: before this fix, DesktopLocalServerManager.start() passed the
   * RAW authStorage straight to createServer and never called any provider-seeding sequence, so
   * the desktop's Authentication page / model routes only ever saw OAuth + CLI providers (never
   * built-in API-key providers or user customProviders[]) — the truncated-catalog symptom vs. the
   * CLI/web build. Assert the fix: seedDashboardProviders is invoked with the store (so it can
   * read globalSettings.customProviders) and createServer receives its returned WRAPPED auth
   * storage, not the raw one, and the seeding disposer is invoked on stop().
   *
   * FNXC:DesktopModelRegistry 2026-07-27-15:49:
   * This second desktop startup surface must also await the shared asynchronous registry factory.
   */
  it("seeds providers via seedDashboardProviders and passes the WRAPPED auth storage to createServer (FN-7622)", async () => {
    const { DesktopLocalServerManager } = await import("../local-server.ts");
    const manager = new DesktopLocalServerManager("/repo");

    await manager.start();

    expect(mocks.seedDashboardProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        store: expect.objectContaining({ init: mocks.store.init, watch: mocks.store.watch }),
        authStorage: expect.anything(),
        modelRegistry: mocks.modelRegistry,
      }),
    );
    expect(mocks.createServer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        authStorage: expect.objectContaining({ __wrapped: true }),
        modelRegistry: mocks.modelRegistry,
      }),
    );

    await manager.stop();
    expect(mocks.seedDashboardProvidersDispose).toHaveBeenCalledTimes(1);
  });

  /*
   * FN-7623 symptom verification: before this fix, DesktopLocalServerManager.start() called
   * createServer WITHOUT pluginStore/pluginLoader, so the registry sub-router never mounted
   * ("Plugin \"registry\" not found" on Browse registry) and install threw "Plugin install mode
   * is not supported: plugin loader not available". Assert the fix: createServer now receives
   * pluginStore, pluginLoader, and pluginRunner (aliased to the same PluginLoader instance).
   *
   * FNXC:DesktopPluginSchema 2026-07-27-15:49:
   * The legacy packaged server must share PluginLoader's single schema-execution ownership.
   */
  it("wires PluginStore + PluginLoader into createServer (FN-7623)", async () => {
    const { DesktopLocalServerManager } = await import("../local-server.ts");
    const manager = new DesktopLocalServerManager("/repo");
    await manager.start();

    expect(mocks.store.getPluginStore).toHaveBeenCalledTimes(1);
    expect(mocks.pluginStoreInstance.init).toHaveBeenCalledTimes(1);
    expect(mocks.PluginLoader).toHaveBeenCalledWith(
      expect.objectContaining({ pluginStore: mocks.pluginStoreInstance, taskStore: expect.anything() }),
    );
    expect(mocks.pluginLoaderInstance.loadAllPlugins).toHaveBeenCalledTimes(1);
    /* FNXC:DesktopPluginSchema 2026-07-14-23:31: The host verifies single schema ownership by leaving execution to PluginLoader instead of replaying collected contracts. */
    expect(mocks.runPluginSchemaInits).not.toHaveBeenCalled();
    expect(mocks.createServer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        pluginStore: mocks.pluginStoreInstance,
        pluginLoader: mocks.pluginLoaderInstance,
        pluginRunner: mocks.pluginLoaderInstance,
      }),
    );
  });

  it("boots the dashboard without plugin wiring when the plugin subsystem fails to init (fail-soft)", async () => {
    mocks.pluginStoreInstance.init.mockRejectedValueOnce(new Error("plugin db locked"));
    const { DesktopLocalServerManager } = await import("../local-server.ts");
    const manager = new DesktopLocalServerManager("/repo");

    const runtime = await manager.start();

    expect(runtime.port).toBe(4545);
    expect(mocks.createServer).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ pluginStore: expect.anything() }),
    );
  });

  /*
   * FN-7637 symptom verification: before this fix, DesktopLocalServerManager.start() never invoked
   * ensureBundledPluginInstalled and never passed an ensureBundledPluginInstalled callback into
   * createServer(...), so bundled runtime plugins (Dependency Graph, Hermes, OpenClaw, Paperclip, …)
   * were never auto-installed on desktop the way they are under the CLI dashboard command. Assert the
   * fix: the startup pass calls the shared helper for the bundled Dependency Graph id using the
   * desktop bundle-dir resolver, and createServer receives a callable ensureBundledPluginInstalled
   * option.
   */
  it("auto-installs the bundled Dependency Graph plugin at startup and wires ensureBundledPluginInstalled into createServer (FN-7637)", async () => {
    const { DesktopLocalServerManager } = await import("../local-server.ts");
    const manager = new DesktopLocalServerManager("/repo");

    await manager.start();

    expect(mocks.ensureBundledPluginInstalled).toHaveBeenCalledWith(
      mocks.pluginStoreInstance,
      mocks.pluginLoaderInstance,
      "fusion-plugin-dependency-graph",
      mocks.resolveDesktopBundlePluginDirs,
    );
    expect(mocks.createServer).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ensureBundledPluginInstalled: expect.any(Function) }),
    );
  });

  it("the wired ensureBundledPluginInstalled callback delegates to the shared helper for a lazy-install id", async () => {
    const { DesktopLocalServerManager } = await import("../local-server.ts");
    const manager = new DesktopLocalServerManager("/repo");

    await manager.start();

    const callOptions = mocks.createServer.mock.calls[0]?.[1] as { ensureBundledPluginInstalled: (id: string) => Promise<boolean> };
    mocks.ensureBundledPluginInstalled.mockClear();
    mocks.ensureBundledPluginInstalled.mockResolvedValueOnce("installed");

    const result = await callOptions.ensureBundledPluginInstalled("fusion-plugin-hermes-runtime");

    expect(result).toBe(true);
    expect(mocks.ensureBundledPluginInstalled).toHaveBeenCalledWith(
      mocks.pluginStoreInstance,
      mocks.pluginLoaderInstance,
      "fusion-plugin-hermes-runtime",
      mocks.resolveDesktopBundlePluginDirs,
    );
  });

  it("the wired ensureBundledPluginInstalled callback returns false for a missing bundle", async () => {
    const { DesktopLocalServerManager } = await import("../local-server.ts");
    const manager = new DesktopLocalServerManager("/repo");

    await manager.start();

    const callOptions = mocks.createServer.mock.calls[0]?.[1] as { ensureBundledPluginInstalled: (id: string) => Promise<boolean> };
    mocks.ensureBundledPluginInstalled.mockResolvedValueOnce("missing-bundle");

    const result = await callOptions.ensureBundledPluginInstalled("fusion-plugin-reports");

    expect(result).toBe(false);
  });

  it("does not wire ensureBundledPluginInstalled into createServer when the plugin subsystem fails to init (fail-soft)", async () => {
    mocks.pluginStoreInstance.init.mockRejectedValueOnce(new Error("plugin db locked"));
    const { DesktopLocalServerManager } = await import("../local-server.ts");
    const manager = new DesktopLocalServerManager("/repo");

    const runtime = await manager.start();

    expect(runtime.port).toBe(4545);
    expect(mocks.createServer).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({ ensureBundledPluginInstalled: expect.anything() }),
    );
  });
});

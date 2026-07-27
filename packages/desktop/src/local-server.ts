import type { AddressInfo } from "node:net";
import { once } from "node:events";
import type { Server } from "node:http";

import { resolveDesktopRuntimePrimaryProject } from "./engine-runtime.js";
import { resolveDesktopBundlePluginDirs } from "./bundled-plugin-dirs.js";
import { resolveDesktopSystemControl } from "./local-runtime.js";
import {
  createDesktopRoomRbacOptions,
  DESKTOP_LOCAL_BIND_HOST,
} from "./room-rbac-composition.js";

/*
 * FNXC:DesktopRuntime 2026-07-07-12:00:
 * FN-7623: this legacy desktop local server path had the same missing plugin-subsystem wiring as
 * local-runtime.ts — createServer() never received pluginStore/pluginLoader, so Settings -> Plugins
 * Browse registry ("Plugin \"registry\" not found") and plugin install ("Plugin install mode is not
 * supported: plugin loader not available") were both dead in this path too. Keep both desktop server
 * paths consistent (see local-runtime.ts's matching comment).
 */
type PluginStoreLike = { init(): Promise<void> };

type TaskStoreLike = {
  init(): Promise<void>;
  watch(): Promise<void>;
  close(): void;
  getPluginStore(): PluginStoreLike;
};

type RuntimeCleanup = () => Promise<void> | void;

export interface DesktopLocalRuntime {
  store: TaskStoreLike;
  server: Server;
  port: number;
  cleanup?: RuntimeCleanup;
}

export interface DesktopLocalServerState {
  status: "idle" | "starting" | "ready" | "error";
  port?: number;
  error?: string | null;
}

export class DesktopLocalServerManager {
  private runtime: DesktopLocalRuntime | null = null;
  private state: DesktopLocalServerState = { status: "idle", error: null };

  constructor(private readonly rootDir: string) {}

  getState(): DesktopLocalServerState {
    return this.state;
  }

  getPort(): number | undefined {
    return this.runtime?.port;
  }

  async start(): Promise<DesktopLocalRuntime> {
    if (this.runtime) {
      this.state = { status: "ready", port: this.runtime.port, error: null };
      return this.runtime;
    }

    this.state = { status: "starting", error: null };

    let store: TaskStoreLike | null = null;
    let server: Server | null = null;
    let cleanup: RuntimeCleanup | undefined;

    try {
      const { TaskStore, createTaskStoreForBackend } = await import("@fusion/core");
      const {
        CentralCore,
        PluginLoader,
        createPostgresRoomRbacRegistry,
        ensureBundledPluginInstalled,
        isBundledPluginId,
      } = await import("@fusion/core");
      const { createDashboardAuthContext, createServer, getCliPackageVersion, isUnresolvedCliPackageVersion } = await import("@fusion/dashboard");
      const { ProjectEngineManager, createFusionAuthStorage, createFusionModelRegistry, seedDashboardProviders } = await import("@fusion/engine");
      // FNXC:BackendFlip 2026-06-26-14:40:
      // Consult the startup factory to boot a PostgreSQL-backed TaskStore.
      // Post default-flip: the factory boots embedded PG by default when
      // DATABASE_URL is unset, external PG when DATABASE_URL is set, and
      // returns null only when the operator opted out via
      // FUSION_NO_EMBEDDED_PG=1 (legacy SQLite path).
      const backendBoot = await createTaskStoreForBackend({ rootDir: this.rootDir });
      if (backendBoot) {
        store = backendBoot.taskStore as unknown as TaskStoreLike;
        (store as TaskStoreLike & { __backendShutdown?: () => Promise<void> }).__backendShutdown =
          backendBoot.shutdown;
      } else {
        store = new TaskStore(this.rootDir) as TaskStoreLike;
      }
      await store.init();
      await store.watch();
      /*
       * FNXC:DesktopRuntime 2026-06-20-23:39:
       * This legacy desktop local server path still needs to launch project engines so every embedded desktop server follows the same executable-by-default contract.
       */
      /*
       * FNXC:DesktopHostBootstrap 2026-07-19-23:40:
       * DesktopLocalServerManager shares the backend boot's unscoped host layer with CentralCore.
       * Global Room policy and capacity cannot read through the root project's partition, and this
       * consumer never closes the shared pool; backendBoot.shutdown remains its sole owner.
       */
      const centralCore = new CentralCore(
        undefined,
        backendBoot ? { asyncLayer: backendBoot.hostAsyncLayer } : undefined,
      );
      const resolvedFusionVersion = getCliPackageVersion(import.meta.url);
      const fusionVersion = isUnresolvedCliPackageVersion(resolvedFusionVersion) ? undefined : resolvedFusionVersion;
      const engineManager = new ProjectEngineManager(centralCore, { cliPackageVersion: fusionVersion });
      const roomControlPlaneRbac = createDesktopRoomRbacOptions({
        engineManager,
        createRegistry: createPostgresRoomRbacRegistry,
      });
      const dashboardAuthContext = createDashboardAuthContext({
        host: DESKTOP_LOCAL_BIND_HOST,
        noAuth: true,
      });
      const providerSeeding: { dispose?: () => void } = {};
      cleanup = async () => {
        providerSeeding.dispose?.();
        await engineManager.stopAll();
        await centralCore.close?.();
      };
      await centralCore.init();
      // FNXC:DesktopRuntime 2026-07-03-03:30: never auto-register the runtime root as a project (see engine-runtime.ts).
      await engineManager.startAll();
      engineManager.startReconciliation();
      const rootProject = await resolveDesktopRuntimePrimaryProject(centralCore);
      const primaryEngine = rootProject ? await engineManager.ensureEngine(rootProject.id) : undefined;
      /*
       * FNXC:DesktopRuntime 2026-07-07-00:00:
       * FN-7622: this legacy path had the same truncated-provider-list gap as local-runtime.ts — wire
       * auth storage AND run it through the shared seedDashboardProviders() sequence (built-in Zai/
       * API-key seeding, wrapAuthStorageWithApiKeyProviders, registerCustomProviders) so this path
       * surfaces the same provider catalog as the CLI and the embedded runtime path. Pass the WRAPPED
       * authStorage to createServer, not the raw one.
      */
      const authStorage = createFusionAuthStorage();
      /*
       * FNXC:DesktopModelRegistry 2026-07-27-15:49:
       * Keep this legacy desktop startup path aligned with LocalRuntimeManager by resolving the
       * asynchronous model registry before provider seeding or dashboard server construction.
       */
      const modelRegistry = await createFusionModelRegistry(authStorage);
      const { authStorage: wrappedAuthStorage, dispose } = await seedDashboardProviders({
        store: store as never,
        authStorage,
        modelRegistry,
      });
      providerSeeding.dispose = dispose;

      /*
       * FNXC:DesktopRuntime 2026-07-07-12:00:
       * FN-7623: mirror the CLI dashboard command's plugin wiring — construct the store's PluginStore,
       * build a PluginLoader, load enabled plugins, and run schema-init hooks — so this legacy path's
       * registry sub-router mounts and install works too. Fail soft: a broken plugin subsystem must not
       * prevent the embedded dashboard from booting.
       *
       * FNXC:DesktopRuntime 2026-07-07-12:30:
       * FN-7637: mirror local-runtime.ts's bundled-plugin auto-install wiring so BOTH desktop startup
       * paths auto-install bundled runtime plugins (Dependency Graph, Hermes, OpenClaw, Paperclip, …)
       * identically — same shared @fusion/core helper, same resolveDesktopBundlePluginDirs resolver, same
       * lazy-install callback exposed to PUT /api/plugins/:id/settings. See local-runtime.ts's matching
       * comment for the full rationale.
       */
      let pluginStore: PluginStoreLike | undefined;
      let pluginLoader: InstanceType<typeof PluginLoader> | undefined;
      let ensureBundledPluginInstalledCallback: ((pluginId: string) => Promise<boolean>) | undefined;
      try {
        pluginStore = store.getPluginStore();
        await pluginStore.init();
        pluginLoader = new PluginLoader({ pluginStore: pluginStore as never, taskStore: store as never, fusionVersion });

        const boundPluginStore = pluginStore;
        const boundPluginLoader = pluginLoader;

        try {
          await ensureBundledPluginInstalled(
            boundPluginStore as never,
            boundPluginLoader,
            "fusion-plugin-dependency-graph",
            resolveDesktopBundlePluginDirs,
          );
        } catch {
          // Bundled dependency-graph auto-install failure must not block startup (FN-7637, mirrors FN-7623 fail-soft).
        }

        await pluginLoader.loadAllPlugins();
        /*
         * FNXC:DesktopPluginSchema 2026-07-27-15:49:
         * PluginLoader already executes PostgreSQL schema contracts during load. Keep this legacy
         * desktop host from replaying the collected contracts through the removed SQLite-era seam.
         */

        ensureBundledPluginInstalledCallback = async (pluginId: string): Promise<boolean> => {
          if (!isBundledPluginId(pluginId)) {
            return false;
          }
          const status = await ensureBundledPluginInstalled(boundPluginStore as never, boundPluginLoader, pluginId, resolveDesktopBundlePluginDirs);
          return status !== "missing-bundle";
        };
      } catch {
        // Plugin subsystem failures must not block embedded dashboard startup (FN-7623).
        pluginStore = undefined;
        pluginLoader = undefined;
        ensureBundledPluginInstalledCallback = undefined;
      }

      /*
       * FNXC:DesktopRoomRbacComposition 2026-07-27-15:23:
       * Keep the legacy packaged server path aligned with LocalRuntimeManager: use the durable
       * trusted-device registry/issuer composition, a verified loopback Dashboard auth context,
       * and a listener bound only to the controlled loopback host.
       */
      const app = createServer(store as never, {
        fusionVersion,
        ...(primaryEngine ? { engine: primaryEngine } : {}),
        engineManager,
        centralCore,
        dashboardAuthContext,
        roomControlPlaneRbac,
        authStorage: wrappedAuthStorage,
        modelRegistry,
        ...(pluginStore && pluginLoader ? { pluginStore: pluginStore as never, pluginLoader, pluginRunner: pluginLoader } : {}),
        ...(ensureBundledPluginInstalledCallback ? { ensureBundledPluginInstalled: ensureBundledPluginInstalledCallback } : {}),
        onProjectFirstAccessed: (projectId: string) => engineManager.onProjectAccessed(projectId),
        // FNXC:SystemPanel 2026-07-12-14:20: System panel restart via Electron
        // app.relaunch(); see resolveDesktopSystemControl in local-runtime.ts.
        ...(await resolveDesktopSystemControl()),
      });
      server = app.listen(0, DESKTOP_LOCAL_BIND_HOST);

      await Promise.race([
        once(server, "listening"),
        once(server, "error").then(([error]) => {
          throw error;
        }),
      ]);

      const address = server.address() as AddressInfo | null;
      if (!address?.port) {
        throw new Error("Failed to resolve local server port");
      }

      this.runtime = { store, server, port: address.port, cleanup };
      this.state = { status: "ready", port: address.port, error: null };
      return this.runtime;
    } catch (error) {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
      }
      await cleanup?.();
      store?.close();
      this.state = {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.runtime) {
      this.state = { status: "idle", error: null };
      return;
    }

    const runtime = this.runtime;
    this.runtime = null;

    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    await runtime.cleanup?.();
    runtime.store.close();
    // FNXC:RuntimeStartupWiring 2026-06-24-10:35:
    // Release the backend connection pool / embedded PG cluster if the store
    // was booted via the startup factory. store.close() already closes the
    // AsyncDataLayer pool; this adds embedded-cluster teardown. Best-effort.
    const backendShutdown = (runtime.store as TaskStoreLike & { __backendShutdown?: () => Promise<void> }).__backendShutdown;
    if (backendShutdown) {
      await backendShutdown().catch(() => undefined);
    }
    this.state = { status: "idle", error: null };
  }
}

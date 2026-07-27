/**
 * ProjectEngineManager — uniform lifecycle management for all project engines.
 *
 * Every registered project gets an identical ProjectEngine. There is no
 * "primary" or "default" engine — each is created from CentralCore metadata
 * and started through the same code path.
 *
 * The manager is the single owner of all engines. It handles:
 *   - Eager startup of all registered projects via `startAll()`
 *   - Background reconciliation of newly registered projects via `startReconciliation()`
 *   - Lazy startup of newly-accessed projects via `ensureEngine()` and `onProjectAccessed()`
 *   - Deduplication of concurrent start requests for the same project
 *   - Graceful shutdown of all engines via `stopAll()`
 */

import type {
  CentralCore,
  TaskStore,
  RegisteredProject,
} from "@fusion/core";
import { ProjectEngine } from "./project-engine.js";
import type { ProjectEngineOptions } from "./project-engine.js";
import type { RoomHostCompositionProviderV1 } from "./room-host-composition.js";
import {
  createRoomHostCompositionOperatorPolicyProvider,
  type RoomHostCompositionOperatorAdapterRegistryV1,
} from "./room-host-composition-operator-policy-provider.js";
import type { ProjectRuntimeConfig } from "./project-runtime.js";
import { AgentSemaphore } from "./concurrency.js";
import {
  acquireEngineSingleton,
  EngineAlreadyRunningError,
  type EngineSingletonLock,
} from "./engine-singleton-lock.js";
import { runtimeLog } from "./logger.js";

/**
 * Options shared across all engines created by the manager.
 * These are injected by the CLI layer (dashboard.ts / serve.ts).
 */
export interface EngineManagerOptions {
  /**
   * FNXC:StorageMigrationNotice 2026-07-12-00:00:
   * The manager carries the resolved CLI package version to each per-project engine so the one-time Postgres-migration inbox message is evaluated per project while remaining gated to the same released runtime version.
   */
  cliPackageVersion?: ProjectEngineOptions["cliPackageVersion"];
  getMergeStrategy?: ProjectEngineOptions["getMergeStrategy"];
  processPullRequestMerge?: ProjectEngineOptions["processPullRequestMerge"];
  createGroupPr?: ProjectEngineOptions["createGroupPr"];
  syncGroupPr?: ProjectEngineOptions["syncGroupPr"];
  prNodeGithubOps?: ProjectEngineOptions["prNodeGithubOps"];
  prReconcileGithubOps?: ProjectEngineOptions["prReconcileGithubOps"];
  getTaskMergeBlocker?: ProjectEngineOptions["getTaskMergeBlocker"];
  onInsightRunProcessed?: ProjectEngineOptions["onInsightRunProcessed"];
  /**
   * FNXC:RoomHostComposition 2026-07-20-02:28:
   * The manager forwards the one host-owned Room composition authority by
   * identity. It must not derive capacity, provider limits, connector facts, or
   * raw Room seams from project settings while the provider resolves the bundle.
   */
  roomHostCompositionProvider?: RoomHostCompositionProviderV1;
  /**
   * Opt-in host-owned registry for a CentralCore Room operator-policy bundle.
   * It is deliberately separate from raw seams and an already-built provider:
   * mixing the origins would make the active execution authority ambiguous.
   */
  roomHostCompositionOperatorAdapterRegistry?: RoomHostCompositionOperatorAdapterRegistryV1;
  roomGlobalConcurrencyVerifiedPolicy?: ProjectEngineOptions["roomGlobalConcurrencyVerifiedPolicy"];
  roomProviderBackpressureVerifiedFactory?: ProjectEngineOptions["roomProviderBackpressureVerifiedFactory"];
  roomCapabilityRegistryRefreshVerifiedFactory?: ProjectEngineOptions["roomCapabilityRegistryRefreshVerifiedFactory"];
  roomTaskDispatchCapacityAdmissionVerifiedFactory?: ProjectEngineOptions["roomTaskDispatchCapacityAdmissionVerifiedFactory"];
  /**
   * FNXC:SessionRoomProductionProof 2026-07-27-16:42:
   * Forward the host-owned evidence provider unchanged. ProjectEngine rechecks
   * its current, project-bound proof before composing or continuing Room work.
   */
  roomProductionReadinessProofProvider?: ProjectEngineOptions["roomProductionReadinessProofProvider"];
  // FNXC:SqliteFinalRemoval 2026-06-26-11:20: shared TaskStore from the central
  // backend boot so all engines reuse one connection pool (no second embedded PG).
  externalTaskStore?: ProjectEngineOptions["externalTaskStore"];
}

/** Default interval for background reconciliation (30 seconds). */
export const DEFAULT_RECONCILIATION_INTERVAL_MS = 30_000;

async function settleWithBoundedConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(items.length, concurrency));
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = {
          status: "fulfilled",
          value: await run(items[index]),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizeOwnedRootForComparison(root: string): string {
  const normalized = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export class ProjectEngineManager {
  private engines = new Map<string, ProjectEngine>();
  private starting = new Map<string, Promise<ProjectEngine>>();
  private singletonLocks = new Map<string, EngineSingletonLock>();
  /**
   * FNXC:DashboardHealth 2026-06-21-03:30:
   * Engine availability must reflect machine-level truth, not only engines this
   * process owns. Projects whose engine is owned by ANOTHER fusion process on
   * this machine are tracked here, populated when `acquireEngineSingleton`
   * rejects with {@link EngineAlreadyRunningError} — that error is positive
   * proof an engine is live for the project, just not owned by us. We keep
   * retrying to start (so we take over if the other process dies), but the
   * dashboard must report the engine as available rather than showing a false
   * "engine not running" banner.
   */
  private externalEngines = new Set<string>();
  private stopped = false;

  /**
   * Shared global semaphore — ONE instance across ALL project engines.
   * Enforces the cross-project globalMaxConcurrent limit. Without this,
   * each engine creates its own semaphore and the global limit is not shared.
   */
  private globalSemaphore: AgentSemaphore;
  private currentGlobalLimit = 1;
  private readonly initialGlobalLimitReady: Promise<void>;
  private initialGlobalLimitError?: Error;
  private concurrencyListener?: (...args: unknown[]) => void;

  /** Reconciliation state for background project startup. */
  private reconciliationInterval: ReturnType<typeof setInterval> | null = null;
  private reconciliationStopped = false;
  private reconciliationInFlight: Promise<void> | undefined;
  private readonly resolvedRoomHostCompositionProvider?: RoomHostCompositionProviderV1;

  constructor(
    private centralCore: CentralCore,
    private options: EngineManagerOptions = {},
  ) {
    const hasRawVerifiedRoomComposition =
      options.roomGlobalConcurrencyVerifiedPolicy !== undefined
      || options.roomProviderBackpressureVerifiedFactory !== undefined
      || options.roomCapabilityRegistryRefreshVerifiedFactory !== undefined
      || options.roomTaskDispatchCapacityAdmissionVerifiedFactory !== undefined;
    if (
      options.roomHostCompositionOperatorAdapterRegistry !== undefined
      && options.roomHostCompositionProvider !== undefined
    ) {
      throw new Error(
        "ProjectEngineManager rejects an explicit Room host composition provider with an operator adapter registry",
      );
    }
    if (
      options.roomHostCompositionOperatorAdapterRegistry !== undefined
      && hasRawVerifiedRoomComposition
    ) {
      throw new Error(
        "ProjectEngineManager rejects an operator adapter registry with raw verified Room composition seams",
      );
    }
    /*
    FNXC:RoomHostCompositionOperatorManager 2026-07-20-09:32:
    The manager may construct the CentralCore-backed provider only when a host
    explicitly supplies its live adapter registry. It does not enable a default
    policy, infer adapter facts, or silently merge this authority with legacy
    raw seams; missing/expired policy or unverified adapters remain withheld.
    */
    this.resolvedRoomHostCompositionProvider = options.roomHostCompositionProvider
      ?? (options.roomHostCompositionOperatorAdapterRegistry === undefined
        ? undefined
        : createRoomHostCompositionOperatorPolicyProvider({
          authorityReader: centralCore,
          adapterRegistry: options.roomHostCompositionOperatorAdapterRegistry,
        }));
    // Dynamic getter so live changes to globalMaxConcurrent take effect immediately
    this.globalSemaphore = new AgentSemaphore(() => this.currentGlobalLimit);

    // Listen for concurrency changes from CentralCore
    if (typeof centralCore.on === "function") {
      this.concurrencyListener = (state: unknown) => {
        const s = state as { globalMaxConcurrent?: number };
        if (
          typeof s.globalMaxConcurrent === "number"
          && Number.isInteger(s.globalMaxConcurrent)
          && s.globalMaxConcurrent > 0
        ) {
          this.currentGlobalLimit = s.globalMaxConcurrent;
          runtimeLog.log(`Global concurrency limit updated to ${this.currentGlobalLimit}`);
        }
      };
      centralCore.on("concurrency:changed", this.concurrencyListener);
    }

    /*
    FNXC:GlobalConcurrencyHydration 2026-07-27-02:37:
    No project engine may start against a guessed semaphore limit. Capture the
    one authoritative CentralCore hydration and make every startup path await
    it. Retain a normalized error instead of leaving a rejected constructor
    promise unhandled; startup then fails closed with the original cause.
    */
    this.initialGlobalLimitReady = this.refreshGlobalLimit().catch((error) => {
      this.initialGlobalLimitError = error instanceof Error
        ? error
        : new Error(String(error));
      runtimeLog.error(
        `Global concurrency limit hydration failed: ${this.initialGlobalLimitError.message}`,
      );
    });
  }

  private async refreshGlobalLimit(): Promise<void> {
    const state = await this.centralCore.getGlobalConcurrencyState();
    if (
      !Number.isInteger(state.globalMaxConcurrent)
      || state.globalMaxConcurrent <= 0
    ) {
      throw new Error(
        `Invalid global concurrency limit: ${String(state.globalMaxConcurrent)}`,
      );
    }
    this.currentGlobalLimit = state.globalMaxConcurrent;
  }

  private async awaitInitialGlobalLimit(): Promise<void> {
    await this.initialGlobalLimitReady;
    if (this.initialGlobalLimitError) {
      throw this.initialGlobalLimitError;
    }
  }

  // ── Public accessors ──

  /** Get a running engine by projectId. Returns undefined if not started. */
  getEngine(projectId: string): ProjectEngine | undefined {
    return this.engines.get(projectId);
  }

  /** Get all running engines. */
  getAllEngines(): ReadonlyMap<string, ProjectEngine> {
    return this.engines;
  }

  /**
   * Whether an engine is running for any project on this machine — including
   * engines owned by another fusion process (detected via the singleton lock).
   * Drives the dashboard's "engine available" health so a UI-only launch
   * alongside an already-running engine does not show a false banner.
   */
  hasRunningEngine(): boolean {
    return this.engines.size > 0 || this.externalEngines.size > 0;
  }

  /** Project ids whose engine is owned by another fusion process on this machine. */
  getExternalEngineIds(): ReadonlySet<string> {
    return this.externalEngines;
  }

  /** Get the TaskStore for a project from its engine. */
  getStore(projectId: string): TaskStore | undefined {
    return this.engines.get(projectId)?.getTaskStore();
  }

  /** Check if an engine is running or starting for this project. */
  has(projectId: string): boolean {
    return this.engines.has(projectId) || this.starting.has(projectId);
  }

  // ── Pause / Resume ────────────────────────────────────────────────────

  /**
   * Pause a project: update its status in CentralCore and stop its engine.
   * This prevents the reconciliation loop from restarting the engine.
   */
  async pauseProject(projectId: string): Promise<void> {
    if (this.stopped) throw new Error("ProjectEngineManager is stopped");

    runtimeLog.log(`Pausing project ${projectId}`);

    // Update CentralCore status
    await this.centralCore.updateProject(projectId, { status: "paused" });
    await this.centralCore.updateProjectHealth(projectId, { status: "paused" });

    // Stop the engine if running
    const engine = this.engines.get(projectId);
    if (engine) {
      await engine.stop();
      this.engines.delete(projectId);
      runtimeLog.log(`Stopped engine for paused project ${projectId}`);
    }

    // Remove from starting set to prevent a stalled start from completing
    this.starting.delete(projectId);

    await this.releaseSingleton(projectId);
  }

  /**
   * Resume a paused project: update its status in CentralCore and start its engine.
   */
  async resumeProject(projectId: string): Promise<void> {
    if (this.stopped) throw new Error("ProjectEngineManager is stopped");

    runtimeLog.log(`Resuming project ${projectId}`);

    // Update CentralCore status
    await this.centralCore.updateProject(projectId, { status: "active" });
    await this.centralCore.updateProjectHealth(projectId, { status: "active" });

    // Start the engine
    await this.ensureEngine(projectId);
  }

  // ── Lifecycle ──

  /**
   * Ensure an engine is running for the given project.
   * If already started, returns immediately. If starting, deduplicates.
   * If not started, creates and starts a new engine from CentralCore metadata.
   */
  async ensureEngine(
    projectId: string,
    overrides?: Partial<ProjectEngineOptions>,
  ): Promise<ProjectEngine> {
    if (this.stopped) throw new Error("ProjectEngineManager is stopped");
    await this.awaitInitialGlobalLimit();

    // Check if the project is paused before starting
    const project = await this.centralCore.getProject(projectId);
    if (project && (project.status as string) === "paused") {
      throw new Error(`Project ${projectId} is paused`);
    }

    const existing = this.engines.get(projectId);
    if (existing) return existing;

    // Deduplicate concurrent start requests
    const pending = this.starting.get(projectId);
    if (pending) return pending;

    const promise = this.createAndStart(projectId, overrides);
    this.starting.set(projectId, promise);

    try {
      const engine = await promise;
      return engine;
    } catch (err) {
      // Clean up on failure so a retry can attempt again
      this.starting.delete(projectId);
      throw err;
    }
  }

  /**
   * Start engines for all registered projects.
   * Failures for individual projects are logged but don't stop others.
   */
  async startAll(): Promise<void> {
    await this.awaitInitialGlobalLimit();
    const projects = await this.centralCore.listProjects();
    if (projects.length === 0) return;

    runtimeLog.log(`Starting engines for ${projects.length} registered project(s)`);

    /*
    FNXC:BoundedEngineStartup 2026-07-27-02:37:
    Multi-project boot must not fan every engine out at once. Reuse the hydrated
    host concurrency limit as the startup bound so limit=1 remains serial from
    initialization through dispatch instead of oversubscribing before per-task
    semaphore admission exists.
    */
    const results = await settleWithBoundedConcurrency(
      projects,
      this.currentGlobalLimit,
      (project) => this.ensureEngine(project.id),
    );

    let started = 0;
    let failed = 0;
    for (const result of results) {
      if (result.status === "fulfilled") {
        started++;
      } else if (result.reason instanceof EngineAlreadyRunningError) {
        // Engine owned by another process — expected, already logged once.
        continue;
      } else {
        failed++;
        runtimeLog.warn(`Engine start failed: ${result.reason}`);
      }
    }

    runtimeLog.log(`Engine startup complete: ${started} started, ${failed} failed`);
  }

  /** Gracefully stop all engines and reconciliation. */
  async stopAll(): Promise<void> {
    this.stopped = true;
    this.reconciliationStopped = true;

    // Stop reconciliation interval
    if (this.reconciliationInterval !== null) {
      clearInterval(this.reconciliationInterval);
      this.reconciliationInterval = null;
    }

    // Remove concurrency change listener
    if (this.concurrencyListener && typeof this.centralCore.off === "function") {
      this.centralCore.off("concurrency:changed", this.concurrencyListener);
      this.concurrencyListener = undefined;
    }

    /*
    FNXC:LocalNodeOfflineOrder 2026-07-27-02:53:
    Persist the local node's offline state before any project backend stops.
    Otherwise a shutdown can leave a still-online node record pointing at
    engines whose provider and task runtimes have already disappeared.
    */
    try {
      await this.centralCore.markLocalNodeOffline();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runtimeLog.warn(`Local node offline persistence failed: ${message}`);
    }

    const stops = Array.from(this.engines.entries()).map(
      async ([id, engine]) => {
        try {
          await engine.stop();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          runtimeLog.warn(`Engine ${id} stop error: ${message}`);
        }
      },
    );
    await Promise.all(stops);
    this.engines.clear();
    this.starting.clear();
    this.externalEngines.clear();

    // Release all singleton locks so another fusion process can take over.
    const releases = Array.from(this.singletonLocks.values()).map((lock) =>
      lock.release().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        runtimeLog.warn(`Singleton lock release error: ${message}`);
      }),
    );
    await Promise.all(releases);
    this.singletonLocks.clear();
  }

  private async releaseSingleton(projectId: string): Promise<void> {
    const lock = this.singletonLocks.get(projectId);
    if (!lock) return;
    this.singletonLocks.delete(projectId);
    try {
      await lock.release();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runtimeLog.warn(
        `Singleton lock release error for ${projectId}: ${message}`,
      );
    }
  }

  /**
   * Fire-and-forget engine start — suitable as a callback for
   * onProjectFirstAccessed in the server layer.
   */
  onProjectAccessed(projectId: string): void {
    if (this.has(projectId)) return;
    this.ensureEngine(projectId).catch((err) => {
      // Expected when another process owns the engine — already logged once.
      if (err instanceof EngineAlreadyRunningError) return;
      const message = err instanceof Error ? err.message : String(err);
      runtimeLog.warn(
        `Failed to start engine for project ${projectId}: ${message}`,
      );
    });
  }

  // ── Background Reconciliation ────────────────────────────────────────

  /**
   * Start background reconciliation to detect and start engines for
   * newly registered projects without requiring UI access.
   *
   * This runs on an interval, checking for projects that have been
   * registered but don't have running engines yet.
   *
   * Idempotent — safe to call multiple times. Reconciliation stops
   * when `stopReconciliation()` or `stopAll()` is called.
   *
   * @param intervalMs How often to check for new projects (default: 30 seconds)
   */
  startReconciliation(intervalMs: number = DEFAULT_RECONCILIATION_INTERVAL_MS): void {
    if (this.stopped || this.reconciliationStopped) return;
    if (this.reconciliationInterval !== null) return; // Already running

    runtimeLog.log(`Starting project engine reconciliation (interval: ${intervalMs}ms)`);

    // Run an immediate reconciliation tick, then schedule periodic checks
    this.reconcile().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      runtimeLog.warn(`Reconciliation tick failed: ${message}`);
    });

    this.reconciliationInterval = setInterval(() => {
      if (this.reconciliationStopped) {
        this.stopReconciliation();
        return;
      }
      this.reconcile().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        runtimeLog.warn(`Reconciliation tick failed: ${message}`);
      });
    }, intervalMs);

    // Prevent the interval from keeping the process alive
    this.reconciliationInterval.unref?.();
  }

  /**
   * Stop background reconciliation.
   * Idempotent — safe to call even if reconciliation is not running.
   */
  stopReconciliation(): void {
    this.reconciliationStopped = true;
    if (this.reconciliationInterval !== null) {
      clearInterval(this.reconciliationInterval);
      this.reconciliationInterval = null;
      runtimeLog.log("Stopped project engine reconciliation");
    }
  }

  /**
   * Check for registered projects that don't have engines and start them.
   * This is the core reconciliation logic used by both `startReconciliation`
   * and `startAll()`.
   */
  private reconcile(): Promise<void> {
    if (this.reconciliationInFlight) return this.reconciliationInFlight;

    const run = this.reconcileOnce();
    this.reconciliationInFlight = run;
    void run.then(
      () => {
        if (this.reconciliationInFlight === run) {
          this.reconciliationInFlight = undefined;
        }
      },
      () => {
        if (this.reconciliationInFlight === run) {
          this.reconciliationInFlight = undefined;
        }
      },
    );
    return run;
  }

  private async reconcileOnce(): Promise<void> {
    if (this.stopped || this.reconciliationStopped) return;

    try {
      const projects = await this.centralCore.listProjects();
      if (projects.length === 0) return;

      // Filter out paused projects — they should not have engines started
      const activeProjects = projects.filter((p) => (p.status as string) !== "paused");

      // Find projects that don't have running or pending engines
      const missing = activeProjects.filter((p) => !this.has(p.id));
      if (missing.length === 0) return;

      runtimeLog.log(
        `Reconciliation: found ${missing.length} project(s) without engines`,
      );

      /*
      FNXC:GlobalConcurrencyHydration 2026-07-28-02:05:
      Reconciliation is a second multi-project startup entry point. It must
      share startAll's hydrated limit and one in-flight pass; otherwise a later
      interval can launch projects skipped by an earlier limit=1 pass.
      */
      const results = await settleWithBoundedConcurrency(
        missing,
        this.currentGlobalLimit,
        async (project) => {
          if (this.stopped || this.reconciliationStopped) return;
          await this.ensureEngine(project.id);
        },
      );
      for (const [index, result] of results.entries()) {
        if (result.status !== "rejected" || result.reason instanceof EngineAlreadyRunningError) {
          continue;
        }
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        runtimeLog.warn(
          `Failed to start engine for project ${missing[index].id}: ${message}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      runtimeLog.warn(`Reconciliation failed: ${message}`);
    }
  }

  // ── Internal ──

  private async createAndStart(
    projectId: string,
    overrides?: Partial<ProjectEngineOptions>,
  ): Promise<ProjectEngine> {
    const project = await this.centralCore.getProject(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found in CentralCore`);
    }

    // Prevent starting engines for paused projects
    if ((project.status as string) === "paused") {
      throw new Error(`Project ${projectId} is paused`);
    }

    const runtimeConfig = await this.buildRuntimeConfig(project);
    const engineOptions = this.buildEngineOptions(
      project,
      runtimeConfig.workingDirectory,
      overrides,
    );

    // Acquire the per-machine singleton guard before spinning up any engine
    // subsystems. This prevents two fusion processes from running engines for
    // the same project on one machine.
    const singleton = await acquireEngineSingleton(
      projectId,
      runtimeConfig.workingDirectory,
      (err) => {
        runtimeLog.warn(
          `Engine singleton lock for ${projectId} was compromised: ${err.message}`,
        );
      },
    ).catch((err) => {
      if (err instanceof EngineAlreadyRunningError) {
        // An engine IS running for this project — another fusion process owns
        // it. Record it so the dashboard reports the engine as available, and
        // log only on the first detection to avoid spamming every 30s
        // reconciliation tick while the other process stays alive.
        if (!this.externalEngines.has(projectId)) {
          runtimeLog.warn(
            `Refusing to start engine for ${projectId}: ${err.message}`,
          );
        }
        this.externalEngines.add(projectId);
      }
      throw err;
    });
    this.singletonLocks.set(projectId, singleton);
    // Acquiring the singleton proves no other process owns the engine, so clear
    // any prior "owned by another process" marker now — before engine.start().
    // If start fails below we release the lock and a later tick retries; leaving
    // the marker set here would make hasRunningEngine() report a phantom engine.
    this.externalEngines.delete(projectId);

    const engine = new ProjectEngine(
      runtimeConfig,
      this.centralCore,
      engineOptions,
    );

    try {
      await engine.start();
    } catch (err) {
      // If engine start fails we must release the singleton so a retry can
      // re-acquire it.
      await this.releaseSingleton(projectId);
      throw err;
    }

    this.engines.set(projectId, engine);
    this.starting.delete(projectId);
    runtimeLog.log(
      `Started engine for ${project.name ?? projectId} (${projectId})`,
    );

    return engine;
  }

  private async buildRuntimeConfig(project: RegisteredProject): Promise<ProjectRuntimeConfig> {
    const settings = project.settings as
      | Record<string, unknown>
      | undefined;

    return {
      fusionVersion: this.options.cliPackageVersion,
      projectId: project.id,
      workingDirectory: await this.centralCore.resolveLocalProjectWorkingDirectory(project.id),
      isolationMode:
        (project.isolationMode as "in-process" | "child-process") ??
        "in-process",
      maxConcurrent: (settings?.maxConcurrent as number) ?? 4,
      maxWorktrees: (settings?.maxWorktrees as number) ?? 10,
      // Shared global semaphore — all engines share one concurrency pool
      globalSemaphore: this.globalSemaphore,
    };
  }

  private buildEngineOptions(
    project: RegisteredProject,
    workingDirectory: string,
    overrides?: Partial<ProjectEngineOptions>,
  ): ProjectEngineOptions {
    const sharedTaskStore = this.options.externalTaskStore;
    const sharesTaskStoreRoot =
      sharedTaskStore !== undefined
      && normalizeOwnedRootForComparison(sharedTaskStore.getRootDir())
        === normalizeOwnedRootForComparison(workingDirectory);

    return {
      projectId: project.id,
      cliPackageVersion: this.options.cliPackageVersion,
      getMergeStrategy: this.options.getMergeStrategy,
      processPullRequestMerge: this.options.processPullRequestMerge,
      createGroupPr: this.options.createGroupPr,
      syncGroupPr: this.options.syncGroupPr,
      prNodeGithubOps: this.options.prNodeGithubOps,
      prReconcileGithubOps: this.options.prReconcileGithubOps,
      getTaskMergeBlocker: this.options.getTaskMergeBlocker,
      onInsightRunProcessed: this.options.onInsightRunProcessed,
      roomHostCompositionProvider: this.resolvedRoomHostCompositionProvider,
      roomGlobalConcurrencyVerifiedPolicy: this.options.roomGlobalConcurrencyVerifiedPolicy,
      roomProviderBackpressureVerifiedFactory: this.options.roomProviderBackpressureVerifiedFactory,
      roomCapabilityRegistryRefreshVerifiedFactory: this.options.roomCapabilityRegistryRefreshVerifiedFactory,
      roomTaskDispatchCapacityAdmissionVerifiedFactory: this.options.roomTaskDispatchCapacityAdmissionVerifiedFactory,
      roomProductionReadinessProofProvider: this.options.roomProductionReadinessProofProvider,
      /*
      FNXC:ExternalTaskStoreRootOwnership 2026-07-27-02:53:
      A central TaskStore is project-root scoped. Reuse it only for the engine
      whose resolved working directory owns that root; injecting it into every
      project would cross-contaminate task persistence.
      */
      ...(sharesTaskStoreRoot ? { externalTaskStore: sharedTaskStore } : {}),
      ...overrides,
    };
  }
}

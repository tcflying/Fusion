import { beforeEach, describe, expect, it, vi } from "vitest";

const roomControllerSeams = vi.hoisted(() => ({
  constructorCalls: [] as Array<Record<string, unknown>>,
  startMocks: [] as Array<ReturnType<typeof vi.fn>>,
  stopMocks: [] as Array<ReturnType<typeof vi.fn>>,
  passiveWorker: {
    runRoom: vi.fn(async () => undefined),
  },
  simulateWorkerRestart: false,
}));

const roomAuditDispatcherSeams = vi.hoisted(() => ({
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
  enqueue: vi.fn(async () => undefined),
}));

const durableRoomRecoveryWorkerSeams = vi.hoisted(() => ({
  constructorCalls: [] as Array<Record<string, unknown>>,
  runRoom: vi.fn(async () => undefined),
}));

const pluginRunnerSeams = vi.hoisted(() => ({
  registrations: [] as Array<Record<string, unknown>>,
  createRuntimeContext: vi.fn(async () => ({ pluginId: "room-connector-plugin" })),
}));

vi.mock("../room-durable-recovery-worker.js", () => ({
  DurableRoomRecoveryWorker: class MockDurableRoomRecoveryWorker {
    readonly runRoom = durableRoomRecoveryWorkerSeams.runRoom;

    constructor(options: Record<string, unknown>) {
      durableRoomRecoveryWorkerSeams.constructorCalls.push(options);
    }
  },
}));

vi.mock("../room-controller.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../room-controller.js")>();
  class MockRoomController {
    readonly start: ReturnType<typeof vi.fn>;
    readonly stop: ReturnType<typeof vi.fn>;

    constructor(private readonly options: Record<string, unknown>) {
      roomControllerSeams.constructorCalls.push(options);
      this.start = vi.fn(async () => {
        if (!roomControllerSeams.simulateWorkerRestart) return;
        const worker = this.options.worker as {
          runRoom(input: Record<string, unknown>): Promise<void>;
        };
        const runInput = {
          room: { room: { id: "room-restart-1", projectId: "project-1", aggregateVersion: 3 } },
          lease: {
            contractVersion: 1,
            id: "lease-room-restart-1",
            roomId: "room-restart-1",
            kind: "room_worker",
            resourceId: "room-restart-1",
            holderId: "worker-1",
            hostId: "host-1",
            epoch: 1,
            acquiredAt: "2026-07-17T12:00:00.000Z",
            heartbeatAt: "2026-07-17T12:00:00.000Z",
            expiresAt: "2026-07-17T12:01:00.000Z",
            releasedAt: null,
          },
          signal: new AbortController().signal,
          assertLeaseAuthority: async () => ({
            contractVersion: 1,
            id: "lease-room-restart-1",
            roomId: "room-restart-1",
            kind: "room_worker",
            resourceId: "room-restart-1",
            holderId: "worker-1",
            hostId: "host-1",
            epoch: 1,
            acquiredAt: "2026-07-17T12:00:00.000Z",
            heartbeatAt: "2026-07-17T12:00:00.000Z",
            expiresAt: "2026-07-17T12:01:00.000Z",
            releasedAt: null,
          }),
        };
        await worker.runRoom(runInput);
        await worker.runRoom({
          ...runInput,
          lease: {
            ...(runInput.lease as Record<string, unknown>),
            id: "lease-room-restart-2",
            epoch: 2,
          },
        });
      });
      this.stop = vi.fn(async () => undefined);
      roomControllerSeams.startMocks.push(this.start);
      roomControllerSeams.stopMocks.push(this.stop);
    }
  }
  return {
    ...actual,
    PASSIVE_ROOM_WORKER: roomControllerSeams.passiveWorker,
    RoomController: MockRoomController,
  };
});

import { ProjectEngine, type ProjectEngineOptions } from "../project-engine.js";
import { RoomControlPlaneLiveEventService } from "../room-control-plane-live-event-service.js";

const mocks = vi.hoisted(() => ({
  automationStoreInit: vi.fn(async () => undefined),
  createAiPromptExecutor: vi.fn(async () => vi.fn()),
  cronRunnerStart: vi.fn(),
  cronRunnerStop: vi.fn(),
  currentStore: null as Record<string, unknown> | null,
  notificationServiceStart: vi.fn(async () => undefined),
  runtimeConfigurePrMonitoring: vi.fn(),
  runtimeStart: vi.fn(async () => undefined),
  runtimeStop: vi.fn(async () => undefined),
  syncAutoSummarizeAutomation: vi.fn(async () => undefined),
  syncInsightExtractionAutomation: vi.fn(async () => undefined),
  syncMemoryDreamsAutomation: vi.fn(async () => undefined),
  syncScheduledEvalBatchAutomation: vi.fn(async () => undefined),
}));

vi.mock("@fusion/core", async (importOriginal) => {
  const { createEngineCoreMock } = await import("../test/mockCore.js");
  return createEngineCoreMock(() => importOriginal<typeof import("@fusion/core")>(), {
    AutomationStore: class MockAutomationStore {
      init = mocks.automationStoreInit;
    },
    syncAutoSummarizeAutomation: mocks.syncAutoSummarizeAutomation,
    syncInsightExtractionAutomation: mocks.syncInsightExtractionAutomation,
    syncMemoryDreamsAutomation: mocks.syncMemoryDreamsAutomation,
    syncScheduledEvalBatchAutomation: mocks.syncScheduledEvalBatchAutomation,
  });
});

vi.mock("../auth-storage.js", () => ({
  createFusionAuthStorage: vi.fn(() => ({
    get: vi.fn(() => undefined),
    getOAuthProviders: vi.fn(() => []),
    reload: vi.fn(),
  })),
  getFusionOAuthAlertStatePath: vi.fn(() => "G:\\fusion-test\\oauth-alert-state.json"),
}));

vi.mock("../cron-runner.js", () => ({
  CronRunner: vi.fn().mockImplementation(function () {
    return { start: mocks.cronRunnerStart, stop: mocks.cronRunnerStop };
  }),
  createAiPromptExecutor: mocks.createAiPromptExecutor,
}));

vi.mock("../merger.js", () => ({
  sweepStaleAutostashes: vi.fn(async () => ({ dropped: 0 })),
  VerificationError: class VerificationError extends Error {},
}));

vi.mock("../notification/index.js", () => ({
  NotificationService: vi.fn().mockImplementation(function () {
    return { start: mocks.notificationServiceStart, stop: vi.fn() };
  }),
  OAuthAlertStateStore: vi.fn().mockImplementation(function () {
    return {};
  }),
  OAuthExpiryMonitor: vi.fn().mockImplementation(function () {
    return { start: vi.fn(async () => undefined), stop: vi.fn() };
  }),
  OAuthRefreshScheduler: vi.fn().mockImplementation(function () {
    return { start: vi.fn(async () => undefined), stop: vi.fn() };
  }),
  OAuthValidityLogger: vi.fn().mockImplementation(function () {
    return { start: vi.fn(async () => undefined), stop: vi.fn() };
  }),
}));

vi.mock("../notifier.js", () => ({
  NtfyNotifier: vi.fn().mockImplementation(function () {
    return {
      notifyGridlock: vi.fn(),
      start: vi.fn(async () => undefined),
      stop: vi.fn(),
    };
  }),
}));

vi.mock("../pr-comment-handler.js", () => ({
  PrCommentHandler: vi.fn().mockImplementation(function () {
    return { createFollowUpTask: vi.fn(), handleNewComments: vi.fn() };
  }),
}));

vi.mock("../pr-monitor.js", () => ({
  PrMonitor: vi.fn().mockImplementation(function () {
    return { onNewComments: vi.fn() };
  }),
}));

vi.mock("../runtimes/in-process-runtime.js", () => ({
  InProcessRuntime: vi.fn().mockImplementation(function () {
    return {
      configurePrMonitoring: mocks.runtimeConfigurePrMonitoring,
      getAgentStore: vi.fn(() => undefined),
      getHeartbeatMonitor: vi.fn(() => undefined),
      getMessageStore: vi.fn(() => undefined),
      getPluginRunner: vi.fn(() => pluginRunnerSeams.registrations.length > 0
        ? {
          getPluginSessionConnectors: () => pluginRunnerSeams.registrations,
          createRuntimeContext: pluginRunnerSeams.createRuntimeContext,
        }
        : undefined),
      getRoutineRunner: vi.fn(() => undefined),
      getRoutineStore: vi.fn(() => undefined),
      getTaskStore: vi.fn(() => mocks.currentStore),
      getTriggerScheduler: vi.fn(() => undefined),
      setActiveMergeTaskIdProvider: vi.fn(),
      setMergeActiveClearer: vi.fn(),
      setMergeEnqueuer: vi.fn(),
      setMergePendingProvider: vi.fn(),
      setMergeRequester: vi.fn(),
      start: mocks.runtimeStart,
      stop: mocks.runtimeStop,
    };
  }),
}));

interface RoomControllerLifecycle {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

interface RoomControllerFactoryContext {
  readonly projectId: string;
  readonly taskStore: unknown;
  readonly asyncLayer: unknown;
  readonly roomStore: unknown;
  readonly connectorRegistry: unknown;
}

type RoomControllerFactory = (context: RoomControllerFactoryContext) => RoomControllerLifecycle;

const asyncLayer = { projectId: "project-1" };

function createMockStore(): Record<string, unknown> {
  return {
    addTaskComment: vi.fn(async () => undefined),
    emit: vi.fn(),
    getActiveMergingTask: vi.fn(() => null),
    getAsyncLayer: vi.fn(() => asyncLayer),
    getBranchGroup: vi.fn(() => null),
    getCompletionHandoffAcceptedMarker: vi.fn(() => null),
    getSettings: vi.fn(async () => ({
      autoMerge: false,
      enginePaused: false,
      globalPause: false,
      experimentalFeatures: { sessionRoomControlPlane: true },
      maintenanceIntervalMs: 900_000,
      pollIntervalMs: 15_000,
    })),
    getTask: vi.fn(async (taskId: string) => ({
      id: taskId,
      column: "in-review",
      mergeRetries: 0,
      paused: false,
      status: null,
    })),
    listTasks: vi.fn(async () => []),
    logEntry: vi.fn(async () => undefined),
    moveTask: vi.fn(async () => undefined),
    off: vi.fn(),
    on: vi.fn(),
    parseFileScopeFromPrompt: vi.fn(async () => []),
    recordRunAuditEvent: vi.fn(async () => undefined),
    updateTask: vi.fn(async () => undefined),
  };
}

function createEngine(
  roomControllerFactory?: RoomControllerFactory,
  overrides: Partial<ProjectEngineOptions> = {},
): ProjectEngine {
  const options = {
    skipNotifier: true,
    roomRunAuditDispatcherFactory: (context: RoomControllerFactoryContext) => ({
      start: roomAuditDispatcherSeams.start,
      stop: roomAuditDispatcherSeams.stop,
      enqueue: async (event: Record<string, unknown>) => {
        await roomAuditDispatcherSeams.enqueue(event);
        await (context.taskStore as unknown as {
          recordRunAuditEvent(input: Record<string, unknown>): Promise<void>;
        }).recordRunAuditEvent(event);
      },
    }),
    ...overrides,
  } as unknown as ProjectEngineOptions;
  if (roomControllerFactory) {
    (options as { roomControllerFactory?: RoomControllerFactory }).roomControllerFactory = roomControllerFactory;
  }
  return new ProjectEngine(
    {
      projectId: "project-1",
      workingDirectory: "G:\\fusion-test\\project-1",
      isolationMode: "in-process",
      maxConcurrent: 2,
      maxWorktrees: 2,
    },
    {} as never,
    options,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentStore = createMockStore();
  roomControllerSeams.constructorCalls.length = 0;
  roomControllerSeams.startMocks.length = 0;
  roomControllerSeams.stopMocks.length = 0;
  roomControllerSeams.simulateWorkerRestart = false;
  roomControllerSeams.passiveWorker.runRoom.mockClear();
  durableRoomRecoveryWorkerSeams.constructorCalls.length = 0;
  durableRoomRecoveryWorkerSeams.runRoom.mockClear();
  roomAuditDispatcherSeams.start.mockClear();
  roomAuditDispatcherSeams.stop.mockClear();
  roomAuditDispatcherSeams.enqueue.mockClear();
  pluginRunnerSeams.registrations.length = 0;
  pluginRunnerSeams.createRuntimeContext.mockClear();
});

/*
FNXC:SessionRoomController 2026-07-17-20:14:
ProjectEngine owns the RoomController backend lifecycle. It must start Room
workers only after the project runtime has initialized their durable stores.
*/
describe("ProjectEngine RoomController lifecycle integration", () => {
  it("starts the RoomController after the project runtime starts", async () => {
    const roomController = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const roomControllerFactory = vi.fn(() => roomController);
    const engine = createEngine(roomControllerFactory);

    await engine.start();
    try {
      expect(
        roomController.start,
        "ProjectEngine.start must start its backend-owned RoomController",
      ).toHaveBeenCalledTimes(1);
      expect(mocks.runtimeStart.mock.invocationCallOrder[0]).toBeLessThan(
        roomControllerFactory.mock.invocationCallOrder[0]!,
      );
      expect(roomControllerFactory.mock.invocationCallOrder[0]).toBeLessThan(
        roomController.start.mock.invocationCallOrder[0]!,
      );
      expect(roomControllerFactory).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "project-1",
        taskStore: mocks.currentStore,
        asyncLayer,
        roomStore: expect.any(Object),
        connectorRegistry: expect.any(Object),
      }));
      expect(engine.getRoomExistingSessionSpine()).not.toBeNull();
    } finally {
      await engine.stop();
    }
    expect(engine.getRoomExistingSessionSpine()).toBeNull();
  });

  /*
  FNXC:SessionRoomController 2026-07-17-20:17:
  ProjectEngine shutdown must stop Room workers and relinquish their leases
  before the core runtime tears down the durable project stores they require.
  */
  it("stops the RoomController before the project runtime stops", async () => {
    const roomController = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const engine = createEngine(vi.fn(() => roomController));

    await engine.start();
    await engine.stop();

    expect(
      roomController.stop,
      "ProjectEngine.stop must stop its backend-owned RoomController",
    ).toHaveBeenCalledTimes(1);
    expect(roomController.stop.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runtimeStop.mock.invocationCallOrder[0]!,
    );
  });

  it("starts one canonical live-event service after the Room store and clears it during stop", async () => {
    const start = vi.spyOn(RoomControlPlaneLiveEventService.prototype, "start");
    const stop = vi.spyOn(RoomControlPlaneLiveEventService.prototype, "stop");
    const engine = createEngine();

    try {
      expect(engine.getRoomControlPlaneLiveEventService()).toBeUndefined();

      await engine.start();

      const service = engine.getRoomControlPlaneLiveEventService();
      expect(service).toBeInstanceOf(RoomControlPlaneLiveEventService);
      expect(start).toHaveBeenCalledTimes(1);

      await engine.start();
      expect(engine.getRoomControlPlaneLiveEventService()).toBe(service);
      expect(start).toHaveBeenCalledTimes(1);

      await engine.stop();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(engine.getRoomControlPlaneLiveEventService()).toBeUndefined();
    } finally {
      await engine.stop();
      start.mockRestore();
      stop.mockRestore();
    }
  });

  it("does not expose a live-event service when the feature is disabled", async () => {
    const start = vi.spyOn(RoomControlPlaneLiveEventService.prototype, "start");
    const getSettings = (mocks.currentStore as {
      getSettings: ReturnType<typeof vi.fn>;
    }).getSettings;
    getSettings.mockResolvedValueOnce({
      autoMerge: false,
      enginePaused: false,
      globalPause: false,
      experimentalFeatures: {},
      maintenanceIntervalMs: 900_000,
      pollIntervalMs: 15_000,
    });
    const engine = createEngine();

    try {
      await engine.start();
      expect(start).not.toHaveBeenCalled();
      expect(engine.getRoomControlPlaneLiveEventService()).toBeUndefined();
    } finally {
      await engine.stop();
      start.mockRestore();
    }
  });

  it("fails closed without a live-event service when Room async initialization is unavailable", async () => {
    const start = vi.spyOn(RoomControlPlaneLiveEventService.prototype, "start");
    const getAsyncLayer = (mocks.currentStore as {
      getAsyncLayer: ReturnType<typeof vi.fn>;
    }).getAsyncLayer;
    getAsyncLayer.mockReturnValueOnce(undefined);
    const engine = createEngine();

    try {
      await engine.start();
      expect(start).not.toHaveBeenCalled();
      expect(engine.getRoomControlPlaneLiveEventService()).toBeUndefined();
    } finally {
      await engine.stop();
      start.mockRestore();
    }
  });

  it("stops and hides the live-event service when Room controller startup fails", async () => {
    const start = vi.spyOn(RoomControlPlaneLiveEventService.prototype, "start");
    const stop = vi.spyOn(RoomControlPlaneLiveEventService.prototype, "stop");
    const roomController = {
      start: vi.fn(async () => {
        throw new Error("room startup failed");
      }),
      stop: vi.fn(async () => undefined),
    };
    const engine = createEngine(vi.fn(() => roomController));

    try {
      await expect(engine.start()).rejects.toThrow("room startup failed");
      expect(start).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(engine.getRoomControlPlaneLiveEventService()).toBeUndefined();
    } finally {
      await engine.stop();
      start.mockRestore();
      stop.mockRestore();
    }
  });

  it("rolls back the RoomController and runtime when Room startup fails", async () => {
    const roomController = {
      start: vi.fn(async () => {
        throw new Error("room startup failed");
      }),
      stop: vi.fn(async () => undefined),
    };
    const engine = createEngine(vi.fn(() => roomController));

    await expect(engine.start()).rejects.toThrow("room startup failed");

    expect(roomController.stop).toHaveBeenCalledTimes(1);
    expect(mocks.runtimeStop).toHaveBeenCalledTimes(1);
    expect(roomController.start.mock.invocationCallOrder[0]).toBeLessThan(
      roomController.stop.mock.invocationCallOrder[0]!,
    );
    expect(roomController.stop.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runtimeStop.mock.invocationCallOrder[0]!,
    );
  });

  it("rolls back the RoomController and runtime when a later awaited subsystem fails", async () => {
    const roomController = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    mocks.notificationServiceStart.mockRejectedValueOnce(
      new Error("notification subsystem startup failed"),
    );
    const engine = createEngine(vi.fn(() => roomController), { skipNotifier: false });

    await expect(engine.start()).rejects.toThrow("notification subsystem startup failed");

    expect(roomController.start).toHaveBeenCalledTimes(1);
    expect(roomController.stop).toHaveBeenCalledTimes(1);
    expect(mocks.runtimeStop).toHaveBeenCalledTimes(1);
    expect(mocks.notificationServiceStart.mock.invocationCallOrder[0]).toBeLessThan(
      roomController.stop.mock.invocationCallOrder[0]!,
    );
    expect(roomController.stop.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runtimeStop.mock.invocationCallOrder[0]!,
    );
  });

  it("routes Room lifecycle audits into the existing project TaskStore audit writer", async () => {
    const engine = createEngine();

    await engine.start();
    try {
      expect(roomAuditDispatcherSeams.start).toHaveBeenCalledTimes(1);
      expect(roomAuditDispatcherSeams.start.mock.invocationCallOrder[0]).toBeLessThan(
        roomControllerSeams.startMocks.at(-1)!.mock.invocationCallOrder[0]!,
      );
      const constructed = roomControllerSeams.constructorCalls.at(-1);
      const recordRunAuditEvent = constructed?.recordRunAuditEvent as (
        event: Record<string, unknown>,
      ) => Promise<void>;
      const event = {
        id: "room-audit-wiring-1",
        projectId: "project-1",
        timestamp: "2026-07-17T13:25:00.000Z",
        agentId: "room-worker-1",
        runId: "room-controller:wiring",
        domain: "database",
        mutationType: "room:worker-started",
        target: "room-1",
        metadata: { roomId: "room-1" },
      };

      await recordRunAuditEvent(event);

      expect(roomAuditDispatcherSeams.enqueue).toHaveBeenCalledWith(event);
      expect(mocks.currentStore?.recordRunAuditEvent).toHaveBeenCalledWith(event);
    } finally {
      await engine.stop();
    }
    expect(roomControllerSeams.stopMocks.at(-1)).toHaveBeenCalledTimes(1);
    expect(roomAuditDispatcherSeams.stop).toHaveBeenCalledTimes(1);
    expect(roomControllerSeams.stopMocks.at(-1)!.mock.invocationCallOrder[0]).toBeLessThan(
      roomAuditDispatcherSeams.stop.mock.invocationCallOrder[0]!,
    );
    expect(roomAuditDispatcherSeams.stop.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runtimeStop.mock.invocationCallOrder[0]!,
    );
  });

  /*
  FNXC:SessionRoomController 2026-07-17-23:18:
  Task 4.7 RED rejects the placeholder PASSIVE Room worker on the default
  ProjectEngine wiring. Startup may keep the controller lifecycle, but restart
  recovery must come from a real production worker rather than the abort-only
  placeholder.
  */
  it("default ProjectEngine wiring passes the durable recovery worker into the production controller", async () => {
    const engine = createEngine();

    await engine.start();
    try {
      const constructed = roomControllerSeams.constructorCalls.at(-1);
      expect(
        constructed?.worker,
        "Task 4.7 requires the default RoomController worker to be recovery-capable in production",
      ).not.toBe(roomControllerSeams.passiveWorker);
      expect(durableRoomRecoveryWorkerSeams.constructorCalls).toHaveLength(1);
    } finally {
      await engine.stop();
    }
  });

  it("registers plugin-provided Session Connectors in the default durable recovery worker", async () => {
    const connector = {
      contractVersion: 1,
      id: "room-connector-test",
      version: "1.0.0",
      getCapabilities: vi.fn(),
      ensureExisting: vi.fn(),
      create: vi.fn(),
      getStatus: vi.fn(),
      readHistory: vi.fn(),
      subscribeEvents: vi.fn(),
      send: vi.fn(),
      interrupt: vi.fn(),
      resume: vi.fn(),
      takeover: vi.fn(),
      getHealth: vi.fn(),
      getDeepLinks: vi.fn(),
    };
    const factory = vi.fn(async () => connector);
    pluginRunnerSeams.registrations.push({
      pluginId: "room-connector-plugin",
      sessionConnector: {
        metadata: { connectorId: connector.id, name: "Room connector test" },
        factory,
      },
    });
    const engine = createEngine();

    await engine.start();
    try {
      const workerOptions = durableRoomRecoveryWorkerSeams.constructorCalls.at(-1);
      const registry = workerOptions?.registry as { has(connectorId: string): boolean };
      expect(registry.has(connector.id)).toBe(true);
      expect(pluginRunnerSeams.createRuntimeContext).toHaveBeenCalledWith("room-connector-plugin");
      expect(factory).toHaveBeenCalledTimes(1);
    } finally {
      await engine.stop();
    }
  });

  it("re-enters durable crash recovery when the default Room worker restarts", async () => {
    roomControllerSeams.simulateWorkerRestart = true;
    const engine = createEngine();

    await engine.start();
    try {
      expect(
        roomControllerSeams.passiveWorker.runRoom,
        "Task 4.7 requires restart recovery to call a real Room recovery worker, not PASSIVE_ROOM_WORKER twice",
      ).not.toHaveBeenCalled();
      expect(durableRoomRecoveryWorkerSeams.runRoom).toHaveBeenCalledTimes(2);
    } finally {
      await engine.stop();
    }
  });
});

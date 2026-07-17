import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectEngine, type ProjectEngineOptions } from "../project-engine.js";

const mocks = vi.hoisted(() => ({
  automationStoreInit: vi.fn(async () => undefined),
  createAiPromptExecutor: vi.fn(async () => vi.fn()),
  cronRunnerStart: vi.fn(),
  cronRunnerStop: vi.fn(),
  currentStore: null as Record<string, unknown> | null,
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
    return { start: vi.fn(async () => undefined), stop: vi.fn() };
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
    updateTask: vi.fn(async () => undefined),
  };
}

function createEngine(roomControllerFactory: RoomControllerFactory): ProjectEngine {
  const options = {
    skipNotifier: true,
    roomControllerFactory,
  } as unknown as ProjectEngineOptions;
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
      expect(roomControllerFactory).toHaveBeenCalledWith({
        projectId: "project-1",
        taskStore: mocks.currentStore,
        asyncLayer,
      });
    } finally {
      await engine.stop();
    }
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
});

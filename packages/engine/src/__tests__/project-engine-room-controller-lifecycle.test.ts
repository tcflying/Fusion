import { beforeEach, describe, expect, it, vi } from "vitest";

const roomControllerSeams = vi.hoisted(() => ({
  construct: vi.fn(),
  constructorCalls: [] as Array<Record<string, unknown>>,
  startMocks: [] as Array<ReturnType<typeof vi.fn>>,
  stopMocks: [] as Array<ReturnType<typeof vi.fn>>,
  startImplementation: undefined as (() => Promise<void>) | undefined,
  stopImplementation: undefined as (() => Promise<void>) | undefined,
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

const roomGlobalConcurrencyRuntimeSeams = vi.hoisted(() => ({
  capacityAdmission: null as Record<string, unknown> | null,
  create: vi.fn(),
  recoverDanglingClaims: vi.fn(),
}));

const pluginRunnerSeams = vi.hoisted(() => ({
  registrations: [] as Array<Record<string, unknown>>,
  createRuntimeContext: vi.fn(async (pluginId: string, hostExtensions: Record<string, unknown> = {}) => ({
    pluginId,
    ...hostExtensions,
  })),
}));

vi.mock("../room-durable-recovery-worker.js", () => ({
  DurableRoomRecoveryWorker: class MockDurableRoomRecoveryWorker {
    readonly runRoom = durableRoomRecoveryWorkerSeams.runRoom;

    constructor(options: Record<string, unknown>) {
      durableRoomRecoveryWorkerSeams.constructorCalls.push(options);
    }
  },
}));

vi.mock("../room-global-concurrency-runtime.js", () => ({
  createRoomGlobalConcurrencyRuntime: roomGlobalConcurrencyRuntimeSeams.create,
}));

vi.mock("../room-controller.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../room-controller.js")>();
  class MockRoomController {
    readonly start: ReturnType<typeof vi.fn>;
    readonly stop: ReturnType<typeof vi.fn>;

    constructor(private readonly options: Record<string, unknown>) {
      roomControllerSeams.construct(options);
      roomControllerSeams.constructorCalls.push(options);
      this.start = vi.fn(async () => {
        await roomControllerSeams.startImplementation?.();
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
      this.stop = vi.fn(async () => {
        await roomControllerSeams.stopImplementation?.();
      });
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

vi.mock("../merger-ai.js", () => ({
  WorkspacePartialLandError: class WorkspacePartialLandError extends Error {},
  WorkspaceRepoLandBusyError: class WorkspaceRepoLandBusyError extends Error {},
  landWorkspaceTask: vi.fn(async () => undefined),
  runAiMerge: vi.fn(async () => undefined),
}));

vi.mock("../research/provider-registry.js", () => ({
  ResearchProviderRegistry: class MockResearchProviderRegistry {
    getAvailableProviders(): string[] {
      return [];
    }

    getProvider(): undefined {
      return undefined;
    }
  },
}));

import { ProjectEngine, type ProjectEngineOptions } from "../project-engine.js";
import type { RoomHostCompositionProviderV1 } from "../room-host-composition.js";
import { RoomControlPlaneLiveEventService } from "../room-control-plane-live-event-service.js";
import { runtimeLog } from "../logger.js";
import { SessionConnectorRegistry } from "../session-connector-registry.js";
import {
  SESSION_CONNECTOR_CAPABILITIES,
  SESSION_ROOM_REQUIRED_PRODUCTION_CONTROLS,
  type SessionRoomControlPlaneProductionReadinessProofV1,
} from "@fusion/core";
import type {
  ProjectRoomCommandV1,
  ProjectRoomTrustedPrincipalV1,
} from "../project-room-command-gateway.js";

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

function createRoomProductionReadinessProof(
  connectorIds: readonly string[],
): SessionRoomControlPlaneProductionReadinessProofV1 {
  const now = Date.now();
  return {
    contractVersion: 1,
    proofId: "project-engine-room-production-proof-r1",
    issuer: "project-engine-lifecycle-test",
    projectId: "project-1",
    connectorIds,
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    controls: SESSION_ROOM_REQUIRED_PRODUCTION_CONTROLS.map((control) => ({
      control,
      state: "verified",
      evidenceRef: `test://project-engine-room-production/${control}`,
      sourceRevision: "project-engine-lifecycle-test-r1",
      verifiedAt: new Date(now - 1_000).toISOString(),
    })),
  };
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const roomDashboardOperator: ProjectRoomTrustedPrincipalV1 = {
  kind: "dashboard_operator",
  principalId: "dashboard-operator-1",
  authenticated: true,
};

function createInvalidExistingSessionRoomCommand(): ProjectRoomCommandV1 {
  return {
    type: "room.create-existing-session.v1",
    projectId: "project-1",
    commandId: "room-command-lifecycle-1",
    input: {
      room: { id: "room-command-lifecycle-1", projectId: "project-1" },
      sessions: [],
      roleAssignment: {},
    } as never,
  };
}

function createEvolutionShadowRoomCommand(): ProjectRoomCommandV1 {
  return {
    type: "room.record-evolution-shadow.v1",
    projectId: "project-1",
    commandId: "room-evolution-shadow-lifecycle-1",
    input: {
      contractVersion: 1,
      roomId: "room-evolution-shadow-1",
      hypothesisId: "hypothesis-evolution-shadow-1",
      candidateVersionId: "candidate-evolution-shadow-1",
    },
  };
}

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
  centralCoreOverride?: Record<string, unknown>,
): ProjectEngine {
  const roomGlobalConcurrencyVerifiedPolicy = {
    controllerAdmission: { slots: 1, workClass: "normal" },
    verificationId: "test-verified-policy-1",
    verifiedAt: "2026-07-20T01:18:00.000Z",
  } as never;
  const roomProviderBackpressureVerifiedFactory = vi.fn(() => ({
    corePorts: { read: vi.fn(), commit: vi.fn(), renew: vi.fn(), release: vi.fn() },
    trustedAdmissionSnapshot: { read: vi.fn() },
    roomWorkerAuthority: { resolve: vi.fn() },
  }));
  const roomCapabilityRegistryRefreshVerifiedFactory = vi.fn(() => ({
    observationPort: { observe: vi.fn() },
    reportFreshness: {
      maxObservationAgeMs: 60_000,
      maxFutureSkewMs: 5_000,
    },
    registryFreshness: {
      maxSnapshotAgeMs: 60_000,
      maxSignalAgeMs: 60_000,
      maxFutureSkewMs: 5_000,
    },
  }));
  const roomTaskDispatchCapacityAdmissionVerifiedFactory = vi.fn(() => ({
    capacityAdmissionSource: { getCapacityGovernorInput: vi.fn(async () => null) },
    capabilityRoutingPolicy: {
      freshness: {
        maxCapabilityRegistryAgeMs: 60_000,
        maxCapabilitySignalAgeMs: 60_000,
        maxFutureSkewMs: 5_000,
      },
      requirements: {
        requiredTools: [],
        minimumAvailableContextTokens: 1,
        domain: "default",
        minimumIndependentEvidence: 0,
        minimumCalibrationOutcomeCount: 0,
        minimumQualityScore: 0,
      },
      providerLimits: [],
    },
  }));
  const options = {
    skipNotifier: true,
    roomProductionReadinessProofProvider: vi.fn(async (
      context: { readonly connectorIds: readonly string[] },
    ) =>
      createRoomProductionReadinessProof(context.connectorIds)),
    roomGlobalConcurrencyVerifiedPolicy,
    roomProviderBackpressureVerifiedFactory,
    roomCapabilityRegistryRefreshVerifiedFactory,
    roomTaskDispatchCapacityAdmissionVerifiedFactory,
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
  const centralCore = centralCoreOverride ?? {
    readGlobalCapacityPolicyAuthorityV1: vi.fn(async () => ({
      contractVersion: 1,
      policy: {
        reservations: { verifierSlots: 0, recoverySlots: 0, legacyTaskTriageSlots: 0 },
        snapshotTtlMs: 30_000,
        leaseTtlMs: 120_000,
      },
      policyHash: `sha256:${"a".repeat(64)}`,
      revision: 1,
      updatedAt: "2026-07-20T01:18:00.000Z",
      createProjectPorts: vi.fn(),
    })),
  };
  return new ProjectEngine(
    {
      projectId: "project-1",
      workingDirectory: "G:\\fusion-test\\project-1",
      isolationMode: "in-process",
      maxConcurrent: 2,
      maxWorktrees: 2,
    },
    centralCore as never,
    options,
  );
}

function createReadyRoomHostCompositionProvider(): {
  readonly provider: RoomHostCompositionProviderV1;
  readonly providerBackpressureFactory: ReturnType<typeof vi.fn>;
  readonly capabilityRefreshFactory: ReturnType<typeof vi.fn>;
  readonly taskDispatchFactory: ReturnType<typeof vi.fn>;
} {
  const providerBackpressureFactory = vi.fn(() => ({
    corePorts: { read: vi.fn(), commit: vi.fn(), renew: vi.fn(), release: vi.fn() },
    trustedAdmissionSnapshot: { read: vi.fn() },
    roomWorkerAuthority: { resolve: vi.fn() },
  }));
  const capabilityRefreshFactory = vi.fn(() => ({
    observationPort: { observe: vi.fn() },
    reportFreshness: {
      maxObservationAgeMs: 60_000,
      maxFutureSkewMs: 5_000,
    },
    registryFreshness: {
      maxSnapshotAgeMs: 60_000,
      maxSignalAgeMs: 60_000,
      maxFutureSkewMs: 5_000,
    },
  }));
  const taskDispatchFactory = vi.fn(() => ({
    capacityAdmissionSource: { getCapacityGovernorInput: vi.fn(async () => null) },
    capabilityRoutingPolicy: {
      freshness: {
        maxCapabilityRegistryAgeMs: 60_000,
        maxCapabilitySignalAgeMs: 60_000,
        maxFutureSkewMs: 5_000,
      },
      requirements: {
        requiredTools: [],
        minimumAvailableContextTokens: 1,
        domain: "default",
        minimumIndependentEvidence: 0,
        minimumCalibrationOutcomeCount: 0,
        minimumQualityScore: 0,
      },
      providerLimits: [],
    },
  }));
  const provider: RoomHostCompositionProviderV1 = {
    resolve: vi.fn(async (context) => {
      const now = Date.now();
      return {
        state: "ready",
        composition: {
          globalConcurrencyVerifiedPolicy: {
            controllerAdmission: { slots: 1, workClass: "normal" },
            verificationId: "host-bundle-policy-1",
            verifiedAt: new Date(now - 1_000).toISOString(),
          } as never,
          providerBackpressureVerifiedFactory: providerBackpressureFactory,
          capabilityRegistryRefreshVerifiedFactory: capabilityRefreshFactory,
          taskDispatchCapacityAdmissionVerifiedFactory: taskDispatchFactory,
          authority: {
            bundleId: "host-composition-bundle-1",
            issuer: "test-host-authority",
            revision: 1,
            projectId: context.projectId,
            hostId: context.hostId,
            connectorIds: context.connectorIds,
            issuedAt: new Date(now - 1_000).toISOString(),
            expiresAt: new Date(now + 60_000).toISOString(),
          },
        },
      };
    }),
  };
  return {
    provider,
    providerBackpressureFactory,
    capabilityRefreshFactory,
    taskDispatchFactory,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentStore = createMockStore();
  roomControllerSeams.construct.mockClear();
  roomControllerSeams.constructorCalls.length = 0;
  roomControllerSeams.startMocks.length = 0;
  roomControllerSeams.stopMocks.length = 0;
  roomControllerSeams.startImplementation = undefined;
  roomControllerSeams.stopImplementation = undefined;
  roomControllerSeams.simulateWorkerRestart = false;
  roomControllerSeams.passiveWorker.runRoom.mockClear();
  durableRoomRecoveryWorkerSeams.constructorCalls.length = 0;
  durableRoomRecoveryWorkerSeams.runRoom.mockClear();
  roomGlobalConcurrencyRuntimeSeams.capacityAdmission = {
    globalAccounting: { acquire: vi.fn(), release: vi.fn() },
    slots: 1,
    workClass: "normal",
  };
  roomGlobalConcurrencyRuntimeSeams.recoverDanglingClaims.mockResolvedValue({
    action: "recovered",
    recoveredClaimIds: [],
    replayedClaimIds: [],
    rejected: [],
  });
  roomGlobalConcurrencyRuntimeSeams.create.mockReturnValue({
    capacityAdmission: roomGlobalConcurrencyRuntimeSeams.capacityAdmission,
    recovery: { recoverDanglingClaims: roomGlobalConcurrencyRuntimeSeams.recoverDanglingClaims },
  });
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
  it("withholds Room execution when the flag has no per-control production proof", async () => {
    const engine = createEngine(undefined, {
      roomProductionReadinessProofProvider: undefined,
    });

    await engine.start();
    try {
      expect(engine.getRoomControlPlaneReadService()).toBeDefined();
      expect(engine.getRoomControlPlaneLiveEventService()).toBeUndefined();
      expect(roomControllerSeams.construct).not.toHaveBeenCalled();
      expect(engine.getRoomControlPlaneExecutionStatus()).toMatchObject({
        state: "read_only_withheld",
        reasonCodes: ["production_readiness_proof_missing"],
        controllerStarted: false,
      });
    } finally {
      await engine.stop();
    }
  });

  it("constructs provider send enforcement only from an explicit verified host factory", async () => {
    const corePorts = {
      read: vi.fn(),
      commit: vi.fn(),
      renew: vi.fn(),
      release: vi.fn(),
    };
    const trustedAdmissionSnapshot = { read: vi.fn() };
    const roomWorkerAuthority = { resolve: vi.fn() };
    const roomProviderBackpressureVerifiedFactory = vi.fn(() => ({
      corePorts,
      trustedAdmissionSnapshot,
      roomWorkerAuthority,
    }));
    const engine = createEngine(undefined, {
      roomProviderBackpressureVerifiedFactory,
    } as Partial<ProjectEngineOptions>);

    await engine.start();
    try {
      expect(roomProviderBackpressureVerifiedFactory).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "project-1",
        asyncLayer,
        roomStore: expect.any(Object),
        workerId: expect.any(String),
        hostId: expect.any(String),
      }));
      expect(durableRoomRecoveryWorkerSeams.constructorCalls.at(-1)).toEqual(expect.objectContaining({
        providerBackpressureSendGate: expect.objectContaining({
          admit: expect.any(Function),
        }),
      }));
      expect(corePorts.read).not.toHaveBeenCalled();
      expect(trustedAdmissionSnapshot.read).not.toHaveBeenCalled();
      expect(roomWorkerAuthority.resolve).not.toHaveBeenCalled();
    } finally {
      await engine.stop();
    }
  });

  it("withholds all Room workers when no verified provider admission source is configured", async () => {
    const warning = vi.spyOn(runtimeLog, "warn").mockImplementation(() => undefined);
    const engine = createEngine(undefined, {
      roomProviderBackpressureVerifiedFactory: undefined,
    });

    await engine.start();
    try {
      expect(roomControllerSeams.construct).not.toHaveBeenCalled();
      expect(durableRoomRecoveryWorkerSeams.constructorCalls).toHaveLength(0);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(
        "provider_backpressure_factory",
      ));
    } finally {
      warning.mockRestore();
      await engine.stop();
    }
  });

  it("withholds provider delivery when the Room durable Core store is unavailable", async () => {
    const roomProviderBackpressureVerifiedFactory = vi.fn(() => ({
      corePorts: { read: vi.fn(), commit: vi.fn(), renew: vi.fn(), release: vi.fn() },
      trustedAdmissionSnapshot: { read: vi.fn() },
      roomWorkerAuthority: { resolve: vi.fn() },
    }));
    (mocks.currentStore as Record<string, unknown>).getAsyncLayer = vi.fn(() => null);
    const warning = vi.spyOn(runtimeLog, "warn").mockImplementation(() => undefined);
    const engine = createEngine(undefined, {
      roomProviderBackpressureVerifiedFactory,
    } as Partial<ProjectEngineOptions>);

    try {
      await engine.start();
      expect(roomProviderBackpressureVerifiedFactory).not.toHaveBeenCalled();
      expect(durableRoomRecoveryWorkerSeams.constructorCalls).toHaveLength(0);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(
        "Provider delivery is blocked because no durable Core store is available",
      ));
    } finally {
      warning.mockRestore();
      await engine.stop();
    }
  });

  it("rejects a custom Room worker when verified provider enforcement would otherwise be bypassed", async () => {
    const roomProviderBackpressureVerifiedFactory = vi.fn(() => ({
      corePorts: { read: vi.fn(), commit: vi.fn(), renew: vi.fn(), release: vi.fn() },
      trustedAdmissionSnapshot: { read: vi.fn() },
      roomWorkerAuthority: { resolve: vi.fn() },
    }));
    const engine = createEngine(undefined, {
      roomWorker: { runRoom: vi.fn(async () => undefined) },
      roomProviderBackpressureVerifiedFactory,
    } as Partial<ProjectEngineOptions>);

    try {
      await expect(engine.start()).rejects.toThrow("custom roomWorker");
      expect(mocks.runtimeStart).not.toHaveBeenCalled();
      expect(roomProviderBackpressureVerifiedFactory).not.toHaveBeenCalled();
      expect(durableRoomRecoveryWorkerSeams.constructorCalls).toHaveLength(0);
    } finally {
      await engine.stop();
    }
  });

  it("rejects a custom Room controller when verified provider enforcement would otherwise be bypassed", async () => {
    const roomProviderBackpressureVerifiedFactory = vi.fn(() => ({
      corePorts: { read: vi.fn(), commit: vi.fn(), renew: vi.fn(), release: vi.fn() },
      trustedAdmissionSnapshot: { read: vi.fn() },
      roomWorkerAuthority: { resolve: vi.fn() },
    }));
    const roomController = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const roomControllerFactory = vi.fn(() => roomController);
    const engine = createEngine(roomControllerFactory, {
      roomProviderBackpressureVerifiedFactory,
    } as Partial<ProjectEngineOptions>);

    try {
      await expect(engine.start()).rejects.toThrow("custom roomControllerFactory");
      expect(mocks.runtimeStart).not.toHaveBeenCalled();
      expect(roomProviderBackpressureVerifiedFactory).not.toHaveBeenCalled();
      expect(roomControllerFactory).not.toHaveBeenCalled();
    } finally {
      await engine.stop();
    }
  });

  it("uses source-preserving registry observations for stale and future capability refresh evidence", async () => {
    const STALE_AT = "2026-07-20T00:00:00.000Z";
    const FUTURE_AT = "2026-07-20T00:10:00.000Z";
    const AS_OF = "2026-07-20T00:05:00.000Z";
    const hostId = "host-source";
    const sourceTimedConnector = (connectorId: string, observedAt: string) => ({
      contractVersion: 1,
      id: connectorId,
      version: "1.0.0",
      getCapabilities: vi.fn(async () => ({
        contractVersion: 1,
        connectorId,
        connectorVersion: "1.0.0",
        sourceRevision: `${connectorId}-revision`,
        verifiedAt: observedAt,
        capabilities: Object.fromEntries(SESSION_CONNECTOR_CAPABILITIES.map((name) => [name, {
          state: "verified",
          evidenceRef: `evidence://${connectorId}/${name}`,
          reasonCode: null,
          lastVerifiedAt: observedAt,
        }])),
      })),
      ensureExisting: vi.fn(),
      create: vi.fn(),
      getStatus: vi.fn(),
      readHistory: vi.fn(),
      subscribeEvents: vi.fn(),
      send: vi.fn(),
      interrupt: vi.fn(),
      resume: vi.fn(),
      takeover: vi.fn(),
      getHealth: vi.fn(async (requestedHostId: string) => ({
        connectorId,
        hostId: requestedHostId,
        state: "healthy",
        checkedAt: observedAt,
        authentication: "authenticated",
        daemon: "running",
        server: "reachable",
        backend: "ready",
        rateLimit: "clear",
        host: "reachable",
        capabilities: Object.fromEntries(SESSION_CONNECTOR_CAPABILITIES.map((name) => [name, "verified"])),
        reasonCodes: [],
        retryAfterMs: null,
      })),
      getDeepLinks: vi.fn(),
    });
    const connectorRegistry = new SessionConnectorRegistry();
    connectorRegistry.register(sourceTimedConnector("source-stale", STALE_AT) as never);
    connectorRegistry.register(sourceTimedConnector("source-future", FUTURE_AT) as never);
    const forgedObservationPort = {
      observe: vi.fn(async () => {
        throw new Error("host-supplied observation port must not run");
      }),
    };
    const capabilityRegistryRefresh = {
      reportFreshness: {
        maxObservationAgeMs: 60_000,
        maxFutureSkewMs: 5_000,
      },
      registryFreshness: {
        maxSnapshotAgeMs: 60_000,
        maxSignalAgeMs: 60_000,
        maxFutureSkewMs: 5_000,
      },
    };
    const capacityAdmissionSource = {
      getCapacityGovernorInput: vi.fn(async () => null),
    };
    const capabilityRoutingPolicy = {
      freshness: {
        maxSnapshotAgeMs: 60_000,
        maxSignalAgeMs: 60_000,
        maxFutureSkewMs: 5_000,
      },
      requirements: {
        requiredTools: [],
        minimumAvailableContextTokens: 1,
        domain: "default",
        minimumIndependentEvidence: 0,
        minimumCalibrationOutcomeCount: 0,
        minimumQualityScore: 0,
      },
      providerLimits: [],
    };
    const capabilityRoutingPolicySource = {
      getCapabilityRoutingPolicy: vi.fn(async () => capabilityRoutingPolicy),
    };
    const roomCapabilityRegistryRefreshVerifiedFactory = vi.fn(() => ({
      ...capabilityRegistryRefresh,
      observationPort: forgedObservationPort,
    }));
    const roomTaskDispatchCapacityAdmissionVerifiedFactory = vi.fn(() => ({
      capacityAdmissionSource,
      capabilityRoutingPolicySource,
    }));
    const engine = createEngine(undefined, {
      roomSessionConnectorRegistry: connectorRegistry,
      roomCapabilityRegistryRefreshVerifiedFactory,
      roomTaskDispatchCapacityAdmissionVerifiedFactory,
    } as Partial<ProjectEngineOptions>);

    await engine.start();
    try {
      expect(roomCapabilityRegistryRefreshVerifiedFactory).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "project-1",
        asyncLayer,
        roomStore: expect.any(Object),
        workerId: expect.any(String),
        hostId: expect.any(String),
      }));
      expect(roomTaskDispatchCapacityAdmissionVerifiedFactory).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "project-1",
        asyncLayer,
        roomStore: expect.any(Object),
        workerId: expect.any(String),
        hostId: expect.any(String),
      }));
      expect(mocks.runtimeStart.mock.invocationCallOrder[0]).toBeLessThan(
        roomCapabilityRegistryRefreshVerifiedFactory.mock.invocationCallOrder[0]!,
      );
      expect(roomCapabilityRegistryRefreshVerifiedFactory.mock.invocationCallOrder[0]).toBeLessThan(
        roomTaskDispatchCapacityAdmissionVerifiedFactory.mock.invocationCallOrder[0]!,
      );
      expect(roomTaskDispatchCapacityAdmissionVerifiedFactory.mock.invocationCallOrder[0]).toBeLessThan(
        roomControllerSeams.construct.mock.invocationCallOrder[0]!,
      );
      expect(roomControllerSeams.construct.mock.invocationCallOrder[0]).toBeLessThan(
        roomControllerSeams.startMocks.at(-1)!.mock.invocationCallOrder[0]!,
      );

      const controllerOptions = roomControllerSeams.constructorCalls.at(-1)!;
      const refresh = controllerOptions.capabilityRegistryRefresh as {
        observationPort: {
          observe(input: Record<string, unknown>): Promise<{
            capabilities: unknown;
            health: unknown;
            rateLimit: unknown;
          }>;
        };
        reportFreshness: unknown;
        registryFreshness: unknown;
      };
      expect(refresh.observationPort).not.toBe(forgedObservationPort);
      expect((controllerOptions.capabilityRegistryRefresh as Record<string, unknown>).reportFreshness).toBe(
        capabilityRegistryRefresh.reportFreshness,
      );
      expect((controllerOptions.capabilityRegistryRefresh as Record<string, unknown>).registryFreshness).toBe(
        capabilityRegistryRefresh.registryFreshness,
      );

      const binding = (connectorId: string) => ({
        contractVersion: 1,
        id: `binding-${connectorId}`,
        roomId: "room-source",
        seatId: `seat-${connectorId}`,
        generation: 1,
        connectorId,
        providerId: "provider-source",
        nativeSessionId: `native-${connectorId}`,
        happierSessionId: null,
        serverProfileId: null,
        machineId: null,
        hostId,
        state: "attached",
        attachedAt: AS_OF,
        detachedAt: null,
        replacedByBindingId: null,
      });
      const [stale, future] = await Promise.all([
        refresh.observationPort.observe({
          contractVersion: 1,
          projectId: "project-1",
          roomId: "room-source",
          binding: binding("source-stale"),
          asOf: AS_OF,
        }),
        refresh.observationPort.observe({
          contractVersion: 1,
          projectId: "project-1",
          roomId: "room-source",
          binding: binding("source-future"),
          asOf: AS_OF,
        }),
      ]);
      expect(stale.capabilities).toMatchObject({
        state: "known",
        source: "controlled_connector_runtime_observation_port",
        observedAt: STALE_AT,
      });
      expect(stale.health).toMatchObject({ state: "known", observedAt: STALE_AT });
      expect(stale.rateLimit).toMatchObject({ state: "known", observedAt: STALE_AT });
      expect(future.capabilities).toMatchObject({
        state: "known",
        source: "controlled_connector_runtime_observation_port",
        observedAt: FUTURE_AT,
      });
      expect(future.health).toMatchObject({ state: "known", observedAt: FUTURE_AT });
      expect(future.rateLimit).toMatchObject({ state: "known", observedAt: FUTURE_AT });
      expect(forgedObservationPort.observe).not.toHaveBeenCalled();

      const taskDispatcher = controllerOptions.taskDispatcher as object;
      const dispatcherOptions = Reflect.get(taskDispatcher, "options") as Record<string, unknown>;
      expect(dispatcherOptions.capacityAdmissionSource).toBe(capacityAdmissionSource);
      expect(dispatcherOptions.capabilityRoutingPolicy).toBeUndefined();
      expect(dispatcherOptions.capabilityRoutingPolicySource).toBe(
        capabilityRoutingPolicySource,
      );
      expect(capacityAdmissionSource.getCapacityGovernorInput).not.toHaveBeenCalled();
    } finally {
      await engine.stop();
    }
  });

  it("keeps the Room read service available but withholds worker execution when verified composition is incomplete", async () => {
    const warning = vi.spyOn(runtimeLog, "warn").mockImplementation(() => undefined);
    const engine = createEngine(undefined, {
      roomGlobalConcurrencyVerifiedPolicy: undefined,
      roomProviderBackpressureVerifiedFactory: undefined,
      roomCapabilityRegistryRefreshVerifiedFactory: undefined,
      roomTaskDispatchCapacityAdmissionVerifiedFactory: undefined,
    });

    await engine.start();
    try {
      expect(engine.getRoomControlPlaneReadService()).toBeDefined();
      expect(engine.getRoomControlPlaneLiveEventService()).toBeUndefined();
      expect(roomControllerSeams.construct).not.toHaveBeenCalled();
      expect(durableRoomRecoveryWorkerSeams.constructorCalls).toHaveLength(0);
      expect(roomGlobalConcurrencyRuntimeSeams.create).not.toHaveBeenCalled();
      expect(roomAuditDispatcherSeams.start).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(
        "Session Room worker execution for project-1 is withheld because verified composition is incomplete (global_concurrency_policy, provider_backpressure_factory, capability_registry_refresh_factory, task_dispatch_capacity_factory)",
      ));
    } finally {
      warning.mockRestore();
      await engine.stop();
    }
  });

  it("keeps the Room read service available but withholds workers when CentralCore has no installed capacity authority", async () => {
    const warning = vi.spyOn(runtimeLog, "warn").mockImplementation(() => undefined);
    const centralCore = {
      readGlobalCapacityPolicyAuthorityV1: vi.fn(async () => {
        throw new Error("Global capacity policy authority is not installed");
      }),
    };
    const engine = createEngine(undefined, {}, centralCore);

    await engine.start();
    try {
      expect(centralCore.readGlobalCapacityPolicyAuthorityV1).toHaveBeenCalledTimes(1);
      expect(engine.getRoomControlPlaneReadService()).toBeDefined();
      expect(roomControllerSeams.construct).not.toHaveBeenCalled();
      expect(roomGlobalConcurrencyRuntimeSeams.create).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(
        "central_global_capacity_policy",
      ));
    } finally {
      warning.mockRestore();
      await engine.stop();
    }
  });

  it("contains a malformed CentralCore capacity authority and keeps the Room control plane read-only", async () => {
    const warning = vi.spyOn(runtimeLog, "warn").mockImplementation(() => undefined);
    const malformedAuthority = {
      contractVersion: 1,
      policy: { reservations: {} },
      policyHash: "not-a-verified-policy-hash",
      revision: 0,
      updatedAt: "not-a-canonical-timestamp",
    };
    const centralCore = {
      readGlobalCapacityPolicyAuthorityV1: vi.fn(async () => malformedAuthority),
    };
    roomGlobalConcurrencyRuntimeSeams.create.mockImplementationOnce(() => {
      throw new Error("Room runtime rejected malformed central capacity authority");
    });
    const engine = createEngine(undefined, {}, centralCore);

    await expect(engine.start()).resolves.toBeUndefined();
    try {
      expect(centralCore.readGlobalCapacityPolicyAuthorityV1).toHaveBeenCalledTimes(1);
      expect(roomGlobalConcurrencyRuntimeSeams.create).toHaveBeenCalledWith(expect.objectContaining({
        globalCapacityAuthority: malformedAuthority,
      }));
      expect(engine.getRoomControlPlaneReadService()).toBeDefined();
      expect(engine.getRoomControlPlaneLiveEventService()).toBeUndefined();
      expect(roomControllerSeams.construct).not.toHaveBeenCalled();
      expect(durableRoomRecoveryWorkerSeams.constructorCalls).toHaveLength(0);
      expect(roomGlobalConcurrencyRuntimeSeams.recoverDanglingClaims).not.toHaveBeenCalled();
      expect(roomAuditDispatcherSeams.start).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(
        "central_global_capacity_runtime_invalid",
      ));
    } finally {
      warning.mockRestore();
      await engine.stop();
    }
  });

  it("contains a malformed host placement policy and keeps the Room control plane read-only", async () => {
    const warning = vi.spyOn(runtimeLog, "warn").mockImplementation(() => undefined);
    const malformedVerifiedPolicy = {
      controllerAdmission: { slots: 0, workClass: "normal" },
      verificationId: "policy-with-zero-slots",
      verifiedAt: "2026-07-20T01:18:00.000Z",
    } as never;
    roomGlobalConcurrencyRuntimeSeams.create.mockImplementationOnce(() => {
      throw new Error("Room runtime rejected malformed controller admission policy");
    });
    const engine = createEngine(undefined, {
      roomGlobalConcurrencyVerifiedPolicy: malformedVerifiedPolicy,
    });

    await expect(engine.start()).resolves.toBeUndefined();
    try {
      expect(roomGlobalConcurrencyRuntimeSeams.create).toHaveBeenCalledWith(expect.objectContaining({
        verifiedPolicy: malformedVerifiedPolicy,
      }));
      expect(engine.getRoomControlPlaneReadService()).toBeDefined();
      expect(engine.getRoomControlPlaneLiveEventService()).toBeUndefined();
      expect(roomControllerSeams.construct).not.toHaveBeenCalled();
      expect(durableRoomRecoveryWorkerSeams.constructorCalls).toHaveLength(0);
      expect(roomGlobalConcurrencyRuntimeSeams.recoverDanglingClaims).not.toHaveBeenCalled();
      expect(roomAuditDispatcherSeams.start).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(
        "central_global_capacity_runtime_invalid",
      ));
    } finally {
      warning.mockRestore();
      await engine.stop();
    }
  });

  it("resolves one complete host composition only after the connector registry and Room store exist", async () => {
    const {
      provider,
      providerBackpressureFactory,
      capabilityRefreshFactory,
      taskDispatchFactory,
    } = createReadyRoomHostCompositionProvider();
    const engine = createEngine(undefined, {
      roomGlobalConcurrencyVerifiedPolicy: undefined,
      roomProviderBackpressureVerifiedFactory: undefined,
      roomCapabilityRegistryRefreshVerifiedFactory: undefined,
      roomTaskDispatchCapacityAdmissionVerifiedFactory: undefined,
      roomHostCompositionProvider: provider,
    });

    await engine.start();
    try {
      expect(provider.resolve).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "project-1",
        taskStore: mocks.currentStore,
        asyncLayer,
        roomStore: expect.any(Object),
        connectorRegistry: expect.objectContaining({ ids: expect.any(Function) }),
        connectorIds: [],
        hostId: expect.any(String),
      }));
      expect(roomControllerSeams.construct).toHaveBeenCalledTimes(1);
      expect(roomGlobalConcurrencyRuntimeSeams.create).toHaveBeenCalledWith(expect.objectContaining({
        verifiedPolicy: expect.objectContaining({ verificationId: "host-bundle-policy-1" }),
      }));
      expect(providerBackpressureFactory).toHaveBeenCalledTimes(1);
      expect(capabilityRefreshFactory).toHaveBeenCalledTimes(1);
      expect(taskDispatchFactory).toHaveBeenCalledTimes(1);
    } finally {
      await engine.stop();
    }
  });

  it("withholds execution when the host composition provider declines or fails without falling back to raw seams", async () => {
    const warning = vi.spyOn(runtimeLog, "warn").mockImplementation(() => undefined);
    const provider: RoomHostCompositionProviderV1 = {
      resolve: vi.fn(async () => ({ state: "withheld", reason: "global_arbiter_not_unified" })),
    };
    const engine = createEngine(undefined, {
      roomGlobalConcurrencyVerifiedPolicy: undefined,
      roomProviderBackpressureVerifiedFactory: undefined,
      roomCapabilityRegistryRefreshVerifiedFactory: undefined,
      roomTaskDispatchCapacityAdmissionVerifiedFactory: undefined,
      roomHostCompositionProvider: provider,
    });

    await engine.start();
    try {
      expect(engine.getRoomControlPlaneReadService()).toBeDefined();
      expect(roomControllerSeams.construct).not.toHaveBeenCalled();
      expect(durableRoomRecoveryWorkerSeams.constructorCalls).toHaveLength(0);
      expect(roomGlobalConcurrencyRuntimeSeams.create).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(
        "host_composition_global_arbiter_not_unified",
      ));
    } finally {
      warning.mockRestore();
      await engine.stop();
    }
  });

  it("contains a host composition provider exception and leaves Room execution withheld", async () => {
    const warning = vi.spyOn(runtimeLog, "warn").mockImplementation(() => undefined);
    const provider: RoomHostCompositionProviderV1 = {
      resolve: vi.fn(async () => {
        throw new Error("host authority transport unavailable");
      }),
    };
    const engine = createEngine(undefined, {
      roomGlobalConcurrencyVerifiedPolicy: undefined,
      roomProviderBackpressureVerifiedFactory: undefined,
      roomCapabilityRegistryRefreshVerifiedFactory: undefined,
      roomTaskDispatchCapacityAdmissionVerifiedFactory: undefined,
      roomHostCompositionProvider: provider,
    });

    await engine.start();
    try {
      expect(engine.getRoomControlPlaneReadService()).toBeDefined();
      expect(roomControllerSeams.construct).not.toHaveBeenCalled();
      expect(durableRoomRecoveryWorkerSeams.constructorCalls).toHaveLength(0);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(
        "host_composition_host_composition_provider_failed",
      ));
    } finally {
      warning.mockRestore();
      await engine.stop();
    }
  });

  it("withholds an invalid ready bundle instead of trusting a partial host result", async () => {
    const warning = vi.spyOn(runtimeLog, "warn").mockImplementation(() => undefined);
    const provider: RoomHostCompositionProviderV1 = {
      resolve: vi.fn(async () => ({ state: "ready", composition: {} } as never)),
    };
    const engine = createEngine(undefined, {
      roomGlobalConcurrencyVerifiedPolicy: undefined,
      roomProviderBackpressureVerifiedFactory: undefined,
      roomCapabilityRegistryRefreshVerifiedFactory: undefined,
      roomTaskDispatchCapacityAdmissionVerifiedFactory: undefined,
      roomHostCompositionProvider: provider,
    });

    await engine.start();
    try {
      expect(engine.getRoomControlPlaneReadService()).toBeDefined();
      expect(roomControllerSeams.construct).not.toHaveBeenCalled();
      expect(durableRoomRecoveryWorkerSeams.constructorCalls).toHaveLength(0);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(
        "host_composition_incomplete_host_composition",
      ));
    } finally {
      warning.mockRestore();
      await engine.stop();
    }
  });

  it("rejects mixed host-bundle and raw verified Room composition before starting the runtime", async () => {
    const { provider } = createReadyRoomHostCompositionProvider();
    const engine = createEngine(undefined, { roomHostCompositionProvider: provider });

    try {
      await expect(engine.start()).rejects.toThrow("roomHostCompositionProvider with raw verified Room composition seams");
      expect(mocks.runtimeStart).not.toHaveBeenCalled();
      expect(provider.resolve).not.toHaveBeenCalled();
    } finally {
      await engine.stop();
    }
  });

  it("rejects custom Room controllers and workers when verified default-composition ports are configured", async () => {
    const roomCapabilityRegistryRefreshVerifiedFactory = vi.fn(() => ({}));
    const roomController = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const roomControllerFactory = vi.fn(() => roomController);
    const customControllerEngine = createEngine(roomControllerFactory, {
      roomCapabilityRegistryRefreshVerifiedFactory,
    } as Partial<ProjectEngineOptions>);

    try {
      await expect(customControllerEngine.start()).rejects.toThrow("custom roomControllerFactory");
      expect(roomCapabilityRegistryRefreshVerifiedFactory).not.toHaveBeenCalled();
      expect(roomControllerFactory).not.toHaveBeenCalled();
    } finally {
      await customControllerEngine.stop();
    }

    const roomTaskDispatchCapacityAdmissionVerifiedFactory = vi.fn(() => ({}));
    const customWorkerEngine = createEngine(undefined, {
      roomWorker: { runRoom: vi.fn(async () => undefined) },
      roomTaskDispatchCapacityAdmissionVerifiedFactory,
    } as Partial<ProjectEngineOptions>);

    try {
      await expect(customWorkerEngine.start()).rejects.toThrow("custom roomWorker");
      expect(roomTaskDispatchCapacityAdmissionVerifiedFactory).not.toHaveBeenCalled();
      expect(durableRoomRecoveryWorkerSeams.constructorCalls).toHaveLength(0);
    } finally {
      await customWorkerEngine.stop();
    }
  });

  it("wires an explicitly verified global capacity runtime before default Room admission", async () => {
    const engine = createEngine(undefined, {
      roomGlobalConcurrencyVerifiedPolicy: {
        controllerAdmission: { slots: 1, workClass: "normal" },
        verificationId: "verified-policy-1",
        verifiedAt: "2026-07-19T18:30:00.000Z",
      } as never,
    });

    await engine.start();
    try {
      expect(roomGlobalConcurrencyRuntimeSeams.create).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "project-1",
        globalCapacityAuthority: expect.objectContaining({
          policyHash: `sha256:${"a".repeat(64)}`,
          createProjectPorts: expect.any(Function),
        }),
        refreshGlobalCapacityAuthority: expect.any(Function),
      }));
      expect(roomGlobalConcurrencyRuntimeSeams.recoverDanglingClaims).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "project-1",
      }));
      expect(roomGlobalConcurrencyRuntimeSeams.recoverDanglingClaims.mock.invocationCallOrder[0]).toBeLessThan(
        roomControllerSeams.startMocks.at(-1)!.mock.invocationCallOrder[0]!,
      );
      expect(roomControllerSeams.constructorCalls.at(-1)).toMatchObject({
        capacityAdmission: roomGlobalConcurrencyRuntimeSeams.capacityAdmission,
      });
      expect(
        Reflect.get(engine as object, "getRoomGlobalConcurrencyRuntime"),
        "ProjectEngine must not expose Room capacity admission ports or global accounting through its public API",
      ).toBeUndefined();
    } finally {
      await engine.stop();
    }
  });

  it("rejects a custom Room factory when verified global capacity policy is enabled", async () => {
    const roomController = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const roomControllerFactory = vi.fn(() => roomController);
    const engine = createEngine(roomControllerFactory, {
      roomGlobalConcurrencyVerifiedPolicy: {
        controllerAdmission: { slots: 1, workClass: "normal" },
        verificationId: "verified-policy-custom-factory-1",
        verifiedAt: "2026-07-19T18:30:00.000Z",
      } as never,
    });

    try {
      await expect(engine.start()).rejects.toThrow("custom roomControllerFactory");
      expect(mocks.runtimeStart).not.toHaveBeenCalled();
      expect(roomGlobalConcurrencyRuntimeSeams.create).not.toHaveBeenCalled();
      expect(roomControllerFactory).not.toHaveBeenCalled();
      expect(roomController.start).not.toHaveBeenCalled();
    } finally {
      await engine.stop();
    }
  });

  it("records a durable audit event before Room work when capacity recovery is held", async () => {
    roomGlobalConcurrencyRuntimeSeams.recoverDanglingClaims.mockResolvedValueOnce({
      action: "held",
      recoveredClaimIds: [],
      replayedClaimIds: [],
      rejected: [{ claimId: "claim-unverified", reason: "snapshot_stale" }],
    });
    const engine = createEngine(undefined, {
      roomGlobalConcurrencyVerifiedPolicy: {
        controllerAdmission: { slots: 1, workClass: "normal" },
        verificationId: "verified-policy-held-1",
        verifiedAt: "2026-07-19T18:30:00.000Z",
      } as never,
    });

    await engine.start();
    try {
      expect(roomAuditDispatcherSeams.enqueue).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "project-1",
        agentId: "room-global-concurrency",
        domain: "database",
        mutationType: "room:global-concurrency-recovery-held",
        target: "project-1",
        metadata: { rejectedClaimCount: 1 },
      }));
      expect(roomAuditDispatcherSeams.start.mock.invocationCallOrder[0]).toBeLessThan(
        roomAuditDispatcherSeams.enqueue.mock.invocationCallOrder[0]!,
      );
      expect(roomAuditDispatcherSeams.enqueue.mock.invocationCallOrder[0]).toBeLessThan(
        roomControllerSeams.startMocks.at(-1)!.mock.invocationCallOrder[0]!,
      );
      expect(mocks.currentStore?.recordRunAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        mutationType: "room:global-concurrency-recovery-held",
      }));
    } finally {
      await engine.stop();
    }
  });

  it("starts the RoomController after the project runtime starts", async () => {
    const engine = createEngine();

    const command = createInvalidExistingSessionRoomCommand();
    expect("getRoomExistingSessionSpine" in engine).toBe(false);
    await expect(engine.executeProjectRoomCommand(command, roomDashboardOperator)).rejects.toMatchObject({
      code: "PROJECT_ROOM_COMMAND_ENGINE_UNAVAILABLE",
    });

    await engine.start();
    try {
      expect(
        roomControllerSeams.startMocks.at(-1),
        "ProjectEngine.start must start its backend-owned RoomController",
      ).toHaveBeenCalledTimes(1);
      expect(mocks.runtimeStart.mock.invocationCallOrder[0]).toBeLessThan(
        roomControllerSeams.construct.mock.invocationCallOrder.at(-1)!,
      );
      expect(roomControllerSeams.construct).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "project-1",
        roomStore: expect.any(Object),
        worker: expect.objectContaining({ runRoom: expect.any(Function) }),
      }));
      await expect(engine.executeProjectRoomCommand(command, roomDashboardOperator)).rejects.toMatchObject({
        code: "ROOM_EXISTING_SESSION_INVALID_REQUEST",
      });
    } finally {
      await engine.stop();
    }
    await expect(engine.executeProjectRoomCommand(command, roomDashboardOperator)).rejects.toMatchObject({
      code: "PROJECT_ROOM_COMMAND_ENGINE_UNAVAILABLE",
    });
  });

  it("binds the bounded Evolution Shadow runner to the Room lifecycle and authenticated command gateway", async () => {
    const record = vi.fn(async () => ({
      status: "shadow_recorded" as const,
      receipt: {
        experimentId: "evolution-shadow-lifecycle-1",
        projectId: "project-1",
        roomId: "room-evolution-shadow-1",
        hypothesisId: "hypothesis-evolution-shadow-1",
        candidateVersionId: "candidate-evolution-shadow-1",
        state: "planned" as const,
        capacityPool: "evolution_paused" as const,
        createdAt: "2026-07-19T11:15:00.000Z",
      },
    }));
    const roomEvolutionAuthorizedShadowFactory = vi.fn(() => ({ record }));
    const engine = createEngine(undefined, {
      roomEvolutionAuthorizedShadowFactory,
    } as Partial<ProjectEngineOptions>);
    const command = createEvolutionShadowRoomCommand();

    await expect(engine.executeProjectRoomCommand(command, roomDashboardOperator)).rejects.toMatchObject({
      code: "PROJECT_ROOM_COMMAND_ENGINE_UNAVAILABLE",
    });

    await engine.start();
    try {
      expect(roomEvolutionAuthorizedShadowFactory).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "project-1",
        ledger: expect.objectContaining({ appendExperiment: expect.any(Function) }),
      }));
      expect(mocks.runtimeStart.mock.invocationCallOrder[0]).toBeLessThan(
        roomEvolutionAuthorizedShadowFactory.mock.invocationCallOrder[0]!,
      );
      expect(roomEvolutionAuthorizedShadowFactory.mock.invocationCallOrder[0]).toBeLessThan(
        roomControllerSeams.startMocks.at(-1)!.mock.invocationCallOrder[0]!,
      );

      await expect(engine.executeProjectRoomCommand(command, roomDashboardOperator)).resolves.toMatchObject({
        type: "room.record-evolution-shadow.v1",
        projectId: "project-1",
        commandId: "room-evolution-shadow-lifecycle-1",
        actor: { kind: "dashboard_operator", principalId: "dashboard-operator-1" },
        value: {
          status: "shadow_recorded",
          receipt: {
            state: "planned",
            capacityPool: "evolution_paused",
          },
        },
      });
      expect(record).toHaveBeenCalledWith({
        contractVersion: 1,
        commandId: "room-evolution-shadow-lifecycle-1",
        roomId: "room-evolution-shadow-1",
        hypothesisId: "hypothesis-evolution-shadow-1",
        candidateVersionId: "candidate-evolution-shadow-1",
      }, {
        kind: "dashboard_operator",
        principalId: "dashboard-operator-1",
      });
    } finally {
      await engine.stop();
    }

    await expect(engine.executeProjectRoomCommand(command, roomDashboardOperator)).rejects.toMatchObject({
      code: "PROJECT_ROOM_COMMAND_ENGINE_UNAVAILABLE",
    });
  });

  it("cancels a runtime start that is pending when stop begins before a Room controller can be created", async () => {
    const runtimeStartGate = deferred();
    mocks.runtimeStart.mockImplementationOnce(async () => runtimeStartGate.promise);
    const engine = createEngine();

    try {
      const starting = engine.start();
      expect(mocks.runtimeStart).toHaveBeenCalledTimes(1);

      const stopping = engine.stop();
      runtimeStartGate.resolve();
      await Promise.all([starting, stopping]);

      expect(roomControllerSeams.construct).not.toHaveBeenCalled();
      expect(roomControllerSeams.startMocks).toHaveLength(0);
      expect(mocks.runtimeStop).toHaveBeenCalledTimes(1);
    } finally {
      await engine.stop();
    }
  });

  it("waits for an in-flight Room controller start before stopping that controller", async () => {
    const controllerStartEntered = deferred();
    const releaseControllerStart = deferred();
    roomControllerSeams.startImplementation = async () => {
      controllerStartEntered.resolve();
      await releaseControllerStart.promise;
    };
    const engine = createEngine();

    try {
      const starting = engine.start();
      await controllerStartEntered.promise;

      const stopping = engine.stop();
      await Promise.resolve();
      await Promise.resolve();
      const controllerStopBeganWhileStartWasInFlight = roomControllerSeams.stopMocks.at(-1)!.mock.calls.length > 0;
      releaseControllerStart.resolve();
      await Promise.all([starting, stopping]);

      expect(roomControllerSeams.startMocks.at(-1)).toHaveBeenCalledTimes(1);
      expect(roomControllerSeams.stopMocks.at(-1)).toHaveBeenCalledTimes(1);
      expect(controllerStopBeganWhileStartWasInFlight).toBe(false);
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
    const engine = createEngine();

    await engine.start();
    await engine.stop();

    expect(
      roomControllerSeams.stopMocks.at(-1),
      "ProjectEngine.stop must stop its backend-owned RoomController",
    ).toHaveBeenCalledTimes(1);
    expect(roomControllerSeams.stopMocks.at(-1)!.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runtimeStop.mock.invocationCallOrder[0]!,
    );
  });

  it("clears recurring engine timers after the Room lifecycle stops", async () => {
    vi.useFakeTimers();
    const engine = createEngine();

    try {
      await engine.start();
      await engine.stop();

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await engine.stop();
      vi.useRealTimers();
    }
  });

  it("exposes the project-bound Room read service only while the Room control plane is running", async () => {
    const engine = createEngine();

    expect(engine.getRoomControlPlaneReadService()).toBeUndefined();
    await engine.start();
    expect(engine.getRoomControlPlaneReadService()).toBeDefined();
    await engine.stop();
    expect(engine.getRoomControlPlaneReadService()).toBeUndefined();
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
    roomControllerSeams.startImplementation = async () => {
      throw new Error("room startup failed");
    };
    const engine = createEngine();

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
    roomControllerSeams.startImplementation = async () => {
      throw new Error("room startup failed");
    };
    const engine = createEngine();

    await expect(engine.start()).rejects.toThrow("room startup failed");

    expect(roomControllerSeams.stopMocks.at(-1)).toHaveBeenCalledTimes(1);
    expect(mocks.runtimeStop).toHaveBeenCalledTimes(1);
    expect(roomControllerSeams.startMocks.at(-1)!.mock.invocationCallOrder[0]).toBeLessThan(
      roomControllerSeams.stopMocks.at(-1)!.mock.invocationCallOrder[0]!,
    );
    expect(roomControllerSeams.stopMocks.at(-1)!.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.runtimeStop.mock.invocationCallOrder[0]!,
    );
  });

  it("rolls back the RoomController and runtime when a later awaited subsystem fails", async () => {
    mocks.notificationServiceStart.mockRejectedValueOnce(
      new Error("notification subsystem startup failed"),
    );
    const engine = createEngine(undefined, { skipNotifier: false });

    await expect(engine.start()).rejects.toThrow("notification subsystem startup failed");

    expect(roomControllerSeams.startMocks.at(-1)).toHaveBeenCalledTimes(1);
    expect(roomControllerSeams.stopMocks.at(-1)).toHaveBeenCalledTimes(1);
    expect(mocks.runtimeStop).toHaveBeenCalledTimes(1);
    expect(mocks.notificationServiceStart.mock.invocationCallOrder[0]).toBeLessThan(
      roomControllerSeams.stopMocks.at(-1)!.mock.invocationCallOrder[0]!,
    );
    expect(roomControllerSeams.stopMocks.at(-1)!.mock.invocationCallOrder[0]).toBeLessThan(
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

  it("passes explicitly configured immutable evidence workflows into the default fenced controller", async () => {
    const workflows = {
      arbitration: { arbitrate: vi.fn(async () => ({ status: "withheld" as const })) },
      synthesis: { synthesize: vi.fn(async () => ({ status: "withheld" as const })) },
    };
    const workflowFactory = vi.fn(() => workflows);
    const engine = createEngine(undefined, { roomEvidenceWorkflowsFactory: workflowFactory });

    await engine.start();
    try {
      expect(workflowFactory).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "project-1",
        roomStore: expect.any(Object),
        workerId: expect.any(String),
        hostId: expect.any(String),
      }));
      expect(roomControllerSeams.constructorCalls.at(-1)?.evidenceWorkflows).toBe(workflows);
    } finally {
      await engine.stop();
    }
  });

  it("wires the durable dependency dispatcher into the production controller", async () => {
    const engine = createEngine();

    await engine.start();
    try {
      const constructed = roomControllerSeams.constructorCalls.at(-1);
      expect(
        constructed?.taskDispatcher,
        "Task 5.7 requires production RoomController startup to dispatch durable DAG intent before recovery",
      ).toEqual(expect.objectContaining({
        dispatchReadyTasks: expect.any(Function),
      }));
    } finally {
      await engine.stop();
    }
  });

  it("rejects an unqualified custom Room worker instead of creating an ungoverned worker path", async () => {
    const customWorker = { runRoom: vi.fn(async () => undefined) };
    const engine = createEngine(undefined, { roomWorker: customWorker });

    try {
      await expect(engine.start()).rejects.toThrow("custom roomWorker");
      expect(mocks.runtimeStart).not.toHaveBeenCalled();
      expect(roomControllerSeams.construct).not.toHaveBeenCalled();
    } finally {
      await engine.stop();
    }
  });

  it("rejects even a dispatch-qualified custom Room worker because it can bypass verified provider delivery", async () => {
    const customWorker = {
      supportsDurableTaskDispatch: true,
      runRoom: vi.fn(async () => undefined),
    };
    const engine = createEngine(undefined, { roomWorker: customWorker });

    try {
      await expect(engine.start()).rejects.toThrow("custom roomWorker");
      expect(mocks.runtimeStart).not.toHaveBeenCalled();
      expect(roomControllerSeams.construct).not.toHaveBeenCalled();
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
      expect(pluginRunnerSeams.createRuntimeContext).toHaveBeenCalledWith(
        "room-connector-plugin",
        expect.objectContaining({
          sessionConnectorWriteAuthorizer: expect.objectContaining({ authorize: expect.any(Function) }),
        }),
      );
      expect(factory).toHaveBeenCalledWith(expect.objectContaining({
        pluginId: "room-connector-plugin",
        sessionConnectorWriteAuthorizer: expect.objectContaining({ authorize: expect.any(Function) }),
      }));
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

  it("publishes a lifecycle-safe Room execution status without treating startup as runtime health", async () => {
    const engine = createEngine();

    expect(engine.getRoomControlPlaneExecutionStatus()).toMatchObject({
      contractVersion: 1,
      projectId: "project-1",
      state: "not_started",
      reasonCodes: [],
      readServiceAvailable: false,
      liveEventServiceAvailable: false,
      controllerStarted: false,
    });

    await engine.start();
    try {
      expect(engine.getRoomControlPlaneExecutionStatus()).toMatchObject({
        contractVersion: 1,
        projectId: "project-1",
        state: "execution_started",
        reasonCodes: [],
        readServiceAvailable: true,
        liveEventServiceAvailable: true,
        controllerStarted: true,
      });
    } finally {
      await engine.stop();
    }

    expect(engine.getRoomControlPlaneExecutionStatus()).toMatchObject({
      contractVersion: 1,
      projectId: "project-1",
      state: "stopped",
      reasonCodes: [],
      readServiceAvailable: false,
      liveEventServiceAvailable: false,
      controllerStarted: false,
    });
  });

  it("makes incomplete verified composition visible as read-only withholding with exact safe reasons", async () => {
    const engine = createEngine(undefined, {
      roomGlobalConcurrencyVerifiedPolicy: undefined,
      roomProviderBackpressureVerifiedFactory: undefined,
      roomCapabilityRegistryRefreshVerifiedFactory: undefined,
      roomTaskDispatchCapacityAdmissionVerifiedFactory: undefined,
    });

    await engine.start();
    try {
      expect(engine.getRoomControlPlaneExecutionStatus()).toMatchObject({
        contractVersion: 1,
        projectId: "project-1",
        state: "read_only_withheld",
        reasonCodes: [
          "global_concurrency_policy",
          "provider_backpressure_factory",
          "capability_registry_refresh_factory",
          "task_dispatch_capacity_factory",
        ],
        readServiceAvailable: true,
        liveEventServiceAvailable: false,
        controllerStarted: false,
      });
    } finally {
      await engine.stop();
    }
  });
});

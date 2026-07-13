import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { CliSessionStore } from "@fusion/core";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { createCliSessionNativeSessionBinding } from "../agent-runtime.js";
import type { PluginRunner } from "../plugin-runner.js";
import { reviewStep } from "../reviewer.js";

const cli = vi.hoisted(() => ({
  resolveHappierCliSettings: vi.fn(() => ({ executable: "happier", timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 })),
  archiveHappierSession: vi.fn(async () => undefined),
  createHappierSession: vi.fn(),
  sendHappierMessage: vi.fn(),
  getHappierSessionStatus: vi.fn(),
  getHappierSessionHistory: vi.fn(),
}));

vi.mock("../../../../plugins/fusion-plugin-happier-runtime/src/cli-spawn.js", () => cli);
vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  reviewerLog: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../pi.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pi.js")>();
  return { ...actual, createFnAgent: vi.fn() };
});

import { HappierRuntimeAdapter } from "../../../../plugins/fusion-plugin-happier-runtime/src/runtime-adapter.js";

pgDescribe("AgentRuntime native session persistence binding", () => {
  const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
    prefix: "fusion_agent_runtime_native_session",
  });
  let store: CliSessionStore;

  beforeAll(h.beforeAll);

  beforeEach(async () => {
    await h.beforeEach();
    vi.clearAllMocks();
    store = await CliSessionStore.create(h.layer(), "project-happier");
  });

  afterEach(h.afterEach);
  afterAll(h.afterAll);

  it("persists a created native id and exposes it to a fresh runtime binding", async () => {
    const fusionSession = store.createSession({
      id: "cli-happier-1",
      taskId: "FN-HAPPIER-1",
      purpose: "execute",
      projectId: "project-happier",
      adapterId: "happier",
    });
    const firstRuntimeBinding = createCliSessionNativeSessionBinding({ store, sessionId: fusionSession.id });

    expect(firstRuntimeBinding.nativeSessionId).toBeNull();
    await firstRuntimeBinding.persistNativeSessionId("hp_session_durable");

    await store.flush();
    const restartedStore = await CliSessionStore.create(h.layer(), "project-happier");
    const restartedRuntimeBinding = createCliSessionNativeSessionBinding({ store: restartedStore, sessionId: fusionSession.id });
    expect(restartedRuntimeBinding.nativeSessionId).toBe("hp_session_durable");
  });

  it("fails closed when the owning Fusion session no longer exists", async () => {
    expect(() => createCliSessionNativeSessionBinding({ store, sessionId: "cli-missing" })).toThrow(
      /CLI session not found/,
    );
  });

  it("wires persistence through the production reviewer path and reloads it for a fresh runtime", async () => {
    const taskStore = h.store();
    const projectRoot = taskStore.getRootDir();
    const task = await taskStore.createTask({
      title: "Happier production reviewer binding",
      description: "Exercise the actual reviewStep orchestration path",
    });
    const histories = new Map<string, Array<{
      id: string;
      createdAt: number;
      role: "user" | "assistant";
      raw: { content: { type: "text"; text: string } };
    }>>();
    let messageNumber = 0;
    cli.createHappierSession.mockResolvedValue({
      sessionId: "hp_engine_durable",
      session: { id: "hp_engine_durable", active: true },
      created: true,
    });
    cli.getHappierSessionStatus.mockImplementation(async (sessionId: string) => ({
      sessionId,
      session: { id: sessionId, active: true },
      agentState: { pendingRequestsCount: 0 },
    }));
    cli.getHappierSessionHistory.mockImplementation(async (sessionId: string) => ({
      sessionId,
      format: "raw",
      messages: [...(histories.get(sessionId) ?? [])],
    }));
    cli.sendHappierMessage.mockImplementation(async ({ sessionId, message, localId }: { sessionId: string; message: string; localId: string }) => {
      const messages = histories.get(sessionId) ?? [];
      messageNumber += 1;
      messages.push(
        {
          id: `user-${messageNumber}`,
          localId,
          createdAt: messageNumber * 1_000,
          role: "user",
          raw: { content: { type: "text", text: message } },
        },
        {
          id: `assistant-${messageNumber}`,
          createdAt: messageNumber * 1_000 + 1,
          role: "assistant",
          raw: { content: { type: "text", text: "### Verdict: APPROVE\n### Summary\nProduction binding is durable." } },
        },
      );
      histories.set(sessionId, messages);
      return { sessionId, localId, waited: true };
    });

    const pluginRunner = {
      getPromptContributionsForSurface: vi.fn(async () => []),
      getRuntimeById: vi.fn(() => ({
        pluginId: "fusion-plugin-happier-runtime",
        runtime: {
          metadata: { runtimeId: "happier", name: "Happier Runtime", version: "0.2.73" },
          factory: async () => new HappierRuntimeAdapter({ backend: "codex" }),
        },
      })),
      createRuntimeContext: vi.fn(async () => ({
        pluginId: "fusion-plugin-happier-runtime",
        taskStore: {},
        settings: {},
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        emitEvent: vi.fn(),
      })),
    } as unknown as PluginRunner;

    const assignedAgent = {
      id: "agent-happier-reviewer",
      name: "Happier reviewer",
      runtimeConfig: { runtimeHint: "happier" },
      memory: undefined,
    };
    const agentStore = {
      getAgent: vi.fn(async () => assignedAgent),
      listAgents: vi.fn(async () => []),
    };
    const reviewOptions = {
      store: taskStore,
      taskId: task.id,
      task: { ...task, assignedAgentId: assignedAgent.id },
      rootDir: projectRoot,
      pluginRunner,
      agentStore,
      settings: await taskStore.getSettings(),
    } as const;

    try {
      const first = await reviewStep(projectRoot, task.id, 1, "Runtime", "code", task.description, undefined, reviewOptions);
      expect(first.verdict).toBe("APPROVE");

      const persistedStore = await CliSessionStore.create(h.layer(), taskStore.getFusionDir());
      const persistedSessions = persistedStore.listByTask(task.id);
      expect(persistedSessions).toHaveLength(1);
      expect(persistedSessions[0].nativeSessionId).toBe("hp_engine_durable");

      const restarted = await reviewStep(projectRoot, task.id, 1, "Runtime", "code", task.description, undefined, reviewOptions);
      expect(restarted.verdict).toBe("APPROVE");
      expect(cli.createHappierSession).toHaveBeenCalledTimes(1);
      expect(cli.sendHappierMessage).toHaveBeenCalledTimes(2);
      const restartStatusOrder = cli.getHappierSessionStatus.mock.invocationCallOrder.find(
        (order) => order > cli.sendHappierMessage.mock.invocationCallOrder[0],
      );
      expect(restartStatusOrder).toBeDefined();
      expect(restartStatusOrder!).toBeLessThan(cli.sendHappierMessage.mock.invocationCallOrder[1]);
    } finally {
      // The shared PostgreSQL harness owns the TaskStore and cleanup lifecycle.
    }
  });
});

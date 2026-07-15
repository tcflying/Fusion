// @vitest-environment node

import express from "express";
import {
  CliSessionStore,
  HAPPIER_RUNTIME_PLUGIN_ID,
  type Agent,
  type Task,
  type TaskStore,
} from "@fusion/core";
import {
  readTaskHappierDirectSessionBinding,
  resolveTaskHappierCliSessionId,
} from "@fusion/engine";
import {
  HappierCliError,
  type HappierDirectSessionEnsureResult,
} from "@fusion-plugin-examples/happier-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api-error.js";
import { request } from "../../test-request.js";
import type { ApiRoutesContext } from "../types.js";
import {
  HAPPIER_BRIDGE_AGENT_NAME,
  HAPPIER_BRIDGE_RUNTIME_CONFIG,
  registerHappierDirectSessionRoutes,
  type HappierDirectSessionRouteDependencies,
} from "../register-happier-direct-session-routes.js";

/*
FNXC:HappierTaskBinding 2026-07-15-21:00:
Task-scoped Happier connection routes must bind only paused non-terminal tasks, rebuild Web URLs from current persisted plugin settings, preserve typed failures, and assign exactly one compatible project-local bridge agent without starting work.
*/

const PROJECT_ID = "project-happier-route";
const DEFAULT_SETTINGS = {
  executable: "happier-custom",
  entrypoint: "G:\\happier\\dist\\index.mjs",
  homeDir: "G:\\happier-home",
  activeServerId: "stack-main",
  serverUrl: "https://server.happier.example",
  publicServerUrl: "https://public.happier.example",
  webappUrl: "https://app.happier.example/base/",
  profile: "fusion",
  backend: "codex" as const,
  timeoutMs: 12_000,
  maxOutputBytes: 65_536,
};

const ENSURED_A: HappierDirectSessionEnsureResult = {
  providerId: "codex",
  remoteSessionId: "thread-a",
  machineId: "machine-a",
  serverId: "server/a",
  sessionId: "happier session a",
  created: true,
  openUrl: "https://cli-returned.invalid/must-not-be-persisted",
};

type TestResponseBody = Record<string, any>;

interface StoredCliSession {
  id: string;
  taskId: string | null;
  chatSessionId: string | null;
  purpose: string;
  projectId: string;
  adapterId: string;
  agentState: string;
  terminationReason: string | null;
  nativeSessionId: string | null;
  resumeAttempts: number;
  autonomyPosture: string | null;
  worktreePath: string | null;
  createdAt: string;
  updatedAt: string;
}

function createInMemoryTaskStore() {
  const tasks = new Map<string, Task & { prompt?: string }>();
  const cliSessions = new Map<string, StoredCliSession>();
  let pluginSettings: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  const database = {
    getProjectIdentity: () => ({ id: PROJECT_ID }),
    bumpLastModified: () => undefined,
    transactionImmediate: <T>(operation: () => T): T => operation(),
    prepare: (sql: string) => ({
      get: (id: string) => cliSessions.get(id),
      run: (...params: unknown[]) => {
        if (/^\s*INSERT/iu.test(sql)) {
          const columns = /\(([^)]+)\)\s*VALUES/iu.exec(sql)?.[1]
            ?.split(",")
            .map((column) => column.trim());
          if (!columns) throw new Error(`Unsupported insert: ${sql}`);
          const row = Object.fromEntries(columns.map((column, index) => [column, params[index]])) as unknown as StoredCliSession;
          if (!cliSessions.has(row.id)) cliSessions.set(row.id, row);
          return { changes: 1 };
        }
        if (/^\s*UPDATE/iu.test(sql)) {
          const id = String(params.at(-1));
          const row = cliSessions.get(id);
          if (!row) return { changes: 0 };
          const assignments = /SET\s+(.+)\s+WHERE/isu.exec(sql)?.[1]
            ?.split(",")
            .map((assignment) => assignment.trim().split("=")[0].trim());
          if (!assignments) throw new Error(`Unsupported update: ${sql}`);
          if (/nativeSessionId IS NULL/iu.test(sql) && row.nativeSessionId !== null) return { changes: 0 };
          assignments.forEach((column, index) => {
            (row as unknown as Record<string, unknown>)[column] = params[index];
          });
          return { changes: 1 };
        }
        throw new Error(`Unsupported SQL: ${sql}`);
      },
    }),
  };
  const pluginStore = {
    getPlugin: vi.fn(async (id: string) => {
      if (id !== HAPPIER_RUNTIME_PLUGIN_ID) throw Object.assign(new Error("Plugin not found"), { code: "ENOENT" });
      return { id, settings: { ...pluginSettings } };
    }),
    updatePluginSettings: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      pluginSettings = { ...pluginSettings, ...patch };
      return { id: HAPPIER_RUNTIME_PLUGIN_ID, settings: { ...pluginSettings } };
    }),
  };
  const store = {
    getFusionDir: () => "G:\\in-memory-project\\.fusion",
    getRootDir: () => "G:\\in-memory-project",
    getAsyncLayer: () => null,
    getDatabase: () => database,
    getPluginStore: () => pluginStore,
    getTask: vi.fn(async (id: string) => {
      const task = tasks.get(id);
      if (!task) throw new Error(`Task ${id} not found`);
      return { ...task };
    }),
    updateTask: vi.fn(async (id: string, patch: Partial<Task>) => {
      const task = tasks.get(id);
      if (!task) throw new Error(`Task ${id} not found`);
      const updated = { ...task, ...patch, updatedAt: new Date().toISOString() };
      tasks.set(id, updated);
      return { ...updated };
    }),
  } as unknown as TaskStore;
  return { store, tasks, cliSessions, pluginStore };
}

function createInMemoryAgentStore() {
  const agents = new Map<string, Agent>();
  let sequence = 0;
  return {
    agents,
    findAgentByName: vi.fn(async (name: string) =>
      [...agents.values()].find((agent) => agent.name === name) ?? null),
    createAgent: vi.fn(async (input: { name: string; role: string; runtimeConfig?: Record<string, unknown> }) => {
      sequence += 1;
      const now = new Date().toISOString();
      const agent = {
        id: `agent-${sequence}`,
        name: input.name,
        role: input.role,
        state: "active",
        createdAt: now,
        updatedAt: now,
        runtimeConfig: {
          ...(input.runtimeConfig ?? {}),
          enabled: true,
          heartbeatIntervalMs: 3_600_000,
        },
        metadata: {},
      } as Agent;
      agents.set(agent.id, agent);
      return agent;
    }),
    updateAgent: vi.fn(async (id: string, patch: Partial<Agent>) => {
      const current = agents.get(id);
      if (!current) throw new Error(`Agent ${id} not found`);
      const updated = { ...current, ...patch, updatedAt: new Date().toISOString() } as Agent;
      agents.set(id, updated);
      return updated;
    }),
    assignTask: vi.fn(async (id: string, taskId: string) => {
      const current = agents.get(id);
      if (!current) throw new Error(`Agent ${id} not found`);
      const updated = { ...current, taskId, updatedAt: new Date().toISOString() } as Agent;
      agents.set(id, updated);
      return updated;
    }),
    listAgents: vi.fn(async () => [...agents.values()]),
    getAgent: vi.fn(async (id: string) => agents.get(id) ?? null),
  };
}

describe("Happier direct-session task routes", () => {
  let store: TaskStore;
  let tasks: Map<string, Task & { prompt?: string }>;
  let pluginStore: ReturnType<typeof createInMemoryTaskStore>["pluginStore"];
  let agentStore: ReturnType<typeof createInMemoryAgentStore>;
  let ensureHappierDirectSession: ReturnType<typeof vi.fn>;
  let taskSequence = 0;

  beforeEach(async () => {
    const taskHarness = createInMemoryTaskStore();
    store = taskHarness.store;
    tasks = taskHarness.tasks;
    pluginStore = taskHarness.pluginStore;
    agentStore = createInMemoryAgentStore();
    ensureHappierDirectSession = vi.fn().mockResolvedValue(ENSURED_A);
  });

  async function createTask(input: { column?: string; paused?: boolean } = {}): Promise<Task> {
    taskSequence += 1;
    const now = new Date().toISOString();
    const task = {
      id: `FN-HAPPIER-${taskSequence}`,
      description: `Happier route task ${taskSequence}`,
      column: input.column ?? "todo",
      dependencies: [],
      steps: [],
      currentStep: 0,
      log: [],
      createdAt: now,
      updatedAt: now,
      prompt: `# ${taskSequence}\nHappier route prompt`,
      ...(input.paused === false ? {} : { paused: true, userPaused: true }),
    } as Task & { prompt?: string };
    tasks.set(task.id, task);
    return task;
  }

  function createApp(overrides: Partial<HappierDirectSessionRouteDependencies> = {}) {
    const router = express.Router();
    const engineCalls = {
      createWorktree: vi.fn(),
      executeTask: vi.fn(),
      sendPrompt: vi.fn(),
      start: vi.fn(),
    };
    const getProjectContext = vi.fn(async () => ({
      store,
      engine: engineCalls as never,
      projectId: PROJECT_ID,
    }));
    const context = {
      router,
      store,
      getProjectContext,
      rethrowAsApiError(error: unknown): never {
        throw error;
      },
    } as unknown as ApiRoutesContext;

    registerHappierDirectSessionRoutes(context, {
      ensureHappierDirectSession,
      createAgentStore: vi.fn(async () => agentStore),
      ...overrides,
    });

    const app = express();
    app.use(express.json());
    app.use("/api", router);
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (error instanceof ApiError) {
        res.status(error.statusCode).json({ error: error.message, details: error.details });
        return;
      }
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    });
    return { app, engineCalls, getProjectContext };
  }

  async function post(app: express.Express, taskId: string, body: Record<string, unknown> = {}) {
    return request(
      app,
      "POST",
      `/api/tasks/${taskId}/happier-direct-session`,
      JSON.stringify({ projectId: PROJECT_ID, uri: "codex://threads/thread-a", ...body }),
      { "content-type": "application/json" },
    );
  }

  it("GET returns 404 for unknown/deleted tasks and disconnected for an unbound live task", async () => {
    const live = await createTask();
    const deleted = await createTask();
    tasks.delete(deleted.id);
    const { app, getProjectContext } = createApp();

    const unknownResponse = await request(app, "GET", `/api/tasks/FN-UNKNOWN/happier-direct-session?projectId=${PROJECT_ID}`);
    const deletedResponse = await request(app, "GET", `/api/tasks/${deleted.id}/happier-direct-session?projectId=${PROJECT_ID}`);
    const disconnectedResponse = await request(app, "GET", `/api/tasks/${live.id}/happier-direct-session?projectId=${PROJECT_ID}`);

    expect(unknownResponse.status).toBe(404);
    expect((unknownResponse.body as TestResponseBody).details.code).toBe("TASK_NOT_FOUND");
    expect(deletedResponse.status).toBe(404);
    expect((deletedResponse.body as TestResponseBody).details.code).toBe("TASK_NOT_FOUND");
    expect(disconnectedResponse.status).toBe(200);
    expect(disconnectedResponse.body).toEqual({ connected: false, taskId: live.id });
    expect(getProjectContext).toHaveBeenCalledTimes(3);
  });

  it("GET rebuilds a fresh openUrl from changed persisted webappUrl without storing either URL", async () => {
    const task = await createTask();
    const { app } = createApp();
    const connected = await post(app, task.id);
    expect(connected.status).toBe(200);

    const cliSessionId = resolveTaskHappierCliSessionId({ taskId: task.id, purpose: "execute" });
    const cliStore = new CliSessionStore(store.getFusionDir(), store.getDatabase());
    const persisted = cliStore.getSession(cliSessionId);
    expect(persisted?.autonomyPosture?.happierDirectSession).not.toHaveProperty("openUrl");
    expect(JSON.stringify(persisted?.autonomyPosture)).not.toContain("cli-returned.invalid");

    await pluginStore.updatePluginSettings(HAPPIER_RUNTIME_PLUGIN_ID, {
      webappUrl: "https://new.happier.example/root/",
    });
    const response = await request(app, "GET", `/api/tasks/${task.id}/happier-direct-session?projectId=${PROJECT_ID}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      taskId: task.id,
      cliSessionId,
      nativeSessionId: ENSURED_A.sessionId,
      providerId: ENSURED_A.providerId,
      remoteSessionId: ENSURED_A.remoteSessionId,
      machineId: ENSURED_A.machineId,
      serverId: ENSURED_A.serverId,
      openUrl: "https://new.happier.example/root/session/server%2Fa/happier%20session%20a",
    });
  });

  it("GET reports malformed persisted binding metadata as a typed integrity failure", async () => {
    const task = await createTask();
    const { app } = createApp();
    expect((await post(app, task.id)).status).toBe(200);

    const cliSessionId = resolveTaskHappierCliSessionId({ taskId: task.id, purpose: "execute" });
    const cliStore = new CliSessionStore(store.getFusionDir(), store.getDatabase());
    const session = cliStore.getSession(cliSessionId);
    expect(session).toBeDefined();
    cliStore.updateSession(cliSessionId, {
      autonomyPosture: {
        ...(session?.autonomyPosture ?? {}),
        happierDirectSession: { providerId: "codex" },
      } as never,
    });

    const response = await request(app, "GET", `/api/tasks/${task.id}/happier-direct-session?projectId=${PROJECT_ID}`);
    expect(response.status).toBe(409);
    expect((response.body as TestResponseBody).details).toMatchObject({
      code: "HAPPIER_DIRECT_SESSION_INTEGRITY",
      taskId: task.id,
    });
  });

  it.each([
    { label: "done", column: "done", paused: true, expectedStatus: 409 },
    { label: "archived", column: "archived", paused: true, expectedStatus: 409 },
    { label: "in-progress", column: "in-progress", paused: true, expectedStatus: 409 },
    { label: "in-review", column: "in-review", paused: true, expectedStatus: 409 },
    { label: "unpaused", column: "todo", paused: false, expectedStatus: 409 },
  ])("POST rejects $label tasks before calling Happier", async ({ column, paused, expectedStatus }) => {
    const task = await createTask({ column, paused });
    const { app } = createApp();
    const response = await post(app, task.id);
    expect(response.status).toBe(expectedStatus);
    expect((response.body as TestResponseBody).details.code).toBe("HAPPIER_TASK_NOT_CONNECTABLE");
    expect(ensureHappierDirectSession).not.toHaveBeenCalled();
  });

  it("POST rejects a deleted task before calling Happier", async () => {
    const task = await createTask();
    tasks.delete(task.id);
    const { app } = createApp();
    const response = await post(app, task.id);
    expect(response.status).toBe(404);
    expect(ensureHappierDirectSession).not.toHaveBeenCalled();
  });

  it("POST uses persisted settings once, binds idempotently, reuses one exact bridge agent, and does not start work", async () => {
    const task = await createTask();
    const before = await store.getTask(task.id);
    const { app, engineCalls } = createApp();

    const first = await post(app, task.id, { machineId: "machine-a" });
    const second = await post(app, task.id, { machineId: "machine-a" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject(first.body as TestResponseBody);
    expect(ensureHappierDirectSession).toHaveBeenCalledTimes(2);
    expect(ensureHappierDirectSession).toHaveBeenNthCalledWith(1, {
      uri: "codex://threads/thread-a",
      machineId: "machine-a",
      settings: DEFAULT_SETTINGS,
    });
    expect(ensureHappierDirectSession).toHaveBeenNthCalledWith(2, {
      uri: "codex://threads/thread-a",
      machineId: "machine-a",
      settings: DEFAULT_SETTINGS,
    });

    const agents = await agentStore.listAgents({ includeEphemeral: false });
    const bridgeAgents = agents.filter((agent) => agent.name === HAPPIER_BRIDGE_AGENT_NAME);
    expect(bridgeAgents).toHaveLength(1);
    expect(bridgeAgents[0]?.runtimeConfig).toEqual(HAPPIER_BRIDGE_RUNTIME_CONFIG);
    expect(bridgeAgents[0]?.taskId).toBe(task.id);

    const after = await store.getTask(task.id);
    expect(after.assignedAgentId).toBe(bridgeAgents[0]?.id);
    expect(after.column).toBe(before.column);
    expect(after.status).toBe(before.status);
    expect(after.paused).toBe(before.paused);
    expect(after.userPaused).toBe(before.userPaused);
    expect(after.worktree).toBe(before.worktree);
    expect(after.prompt).toBe(before.prompt);
    for (const call of Object.values(engineCalls)) expect(call).not.toHaveBeenCalled();
  });

  it("POST returns 409 for a different native session without replacing the first binding", async () => {
    const task = await createTask();
    const { app } = createApp();
    expect((await post(app, task.id)).status).toBe(200);
    ensureHappierDirectSession.mockResolvedValueOnce({ ...ENSURED_A, sessionId: "happier-session-b" });

    const response = await post(app, task.id);
    expect(response.status).toBe(409);
    expect((response.body as TestResponseBody).details.code).toBe("HAPPIER_DIRECT_SESSION_CONFLICT");
    await expect(readTaskHappierDirectSessionBinding({ store, taskId: task.id })).resolves.toMatchObject({
      nativeSessionId: ENSURED_A.sessionId,
    });
  });

  it.each([
    ["daemon_unavailable", 503],
    ["auth_required", 401],
    ["candidate_not_found", 404],
    ["candidate_ambiguous", 409],
    ["machine_mismatch", 409],
  ] as const)("POST preserves CLI code %s and leaves no binding or assignment", async (officialCode, expectedStatus) => {
    const task = await createTask();
    ensureHappierDirectSession.mockRejectedValueOnce(
      new HappierCliError("process", `failure: ${officialCode}`, undefined, officialCode),
    );
    const { app } = createApp();

    const response = await post(app, task.id);
    expect(response.status).toBe(expectedStatus);
    expect((response.body as TestResponseBody).details.code).toBe(officialCode);
    await expect(readTaskHappierDirectSessionBinding({ store, taskId: task.id })).resolves.toBeNull();
    expect((await store.getTask(task.id)).assignedAgentId).toBeUndefined();
    await expect(agentStore.findAgentByName(HAPPIER_BRIDGE_AGENT_NAME)).resolves.toBeNull();
  });

  it("POST conflicts with an incompatible same-name agent without rewriting it and preserves the successful binding", async () => {
    const task = await createTask();
    const existing = await agentStore.createAgent({
      name: HAPPIER_BRIDGE_AGENT_NAME,
      role: "executor",
      runtimeConfig: { runtimeHint: "other" },
    });
    const beforeRuntime = existing.runtimeConfig;
    const { app } = createApp();

    const response = await post(app, task.id);
    expect(response.status).toBe(409);
    expect((response.body as TestResponseBody).details).toMatchObject({
      code: "HAPPIER_BRIDGE_AGENT_CONFLICT",
      sessionBound: true,
      nativeSessionId: ENSURED_A.sessionId,
    });
    expect((await agentStore.getAgent(existing.id))?.runtimeConfig).toEqual(beforeRuntime);
    await expect(readTaskHappierDirectSessionBinding({ store, taskId: task.id })).resolves.toMatchObject({
      nativeSessionId: ENSURED_A.sessionId,
    });
    expect((await store.getTask(task.id)).assignedAgentId).toBeUndefined();
  });

  it("POST returns a typed partial error when assignment fails after binding and retry does not create a second session", async () => {
    const task = await createTask();
    const assignTaskToBridge = vi.fn()
      .mockRejectedValueOnce(new Error("assignment unavailable"))
      .mockResolvedValueOnce({ agentId: "agent-retry" });
    const { app } = createApp({ assignTaskToBridge });

    const first = await post(app, task.id);
    expect(first.status).toBe(500);
    expect((first.body as TestResponseBody).details).toMatchObject({
      code: "HAPPIER_SESSION_BOUND_ASSIGNMENT_FAILED",
      sessionBound: true,
      nativeSessionId: ENSURED_A.sessionId,
    });
    await expect(readTaskHappierDirectSessionBinding({ store, taskId: task.id })).resolves.toMatchObject({
      nativeSessionId: ENSURED_A.sessionId,
    });

    const second = await post(app, task.id);
    expect(second.status).toBe(200);
    expect(assignTaskToBridge).toHaveBeenCalledTimes(2);
    expect(ensureHappierDirectSession).toHaveBeenCalledTimes(2);
    expect((second.body as TestResponseBody).nativeSessionId).toBe(ENSURED_A.sessionId);
  });
});

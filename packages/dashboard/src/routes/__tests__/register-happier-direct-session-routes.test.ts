// @vitest-environment node

import { join } from "node:path";
import express from "express";
import {
  AgentStore,
  AsyncCliSessionStore,
  HAPPIER_RUNTIME_PLUGIN_ID,
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
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
} from "../../../../core/src/__test-utils__/pg-test-harness.js";
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
FNXC:HappierTaskBinding 2026-07-16-12:10:
Task-scoped Happier route tests use Fusion's current real PostgreSQL-backed TaskStore and AgentStore because the SQLite runtime was removed. Only the official CLI boundary is simulated, and that simulation must retain remote-session state across POSTs.
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

type TestResponseBody = Record<string, any>;

function createStatefulOfficialEnsure() {
  const sessions = new Map<string, Omit<HappierDirectSessionEnsureResult, "created">>();
  const ensure = vi.fn(async (input: { uri: string; machineId?: string }) => {
    const key = `${input.uri}\u0000${input.machineId ?? ""}`;
    const existing = sessions.get(key);
    if (existing) return { ...existing, created: false };
    const created = {
      providerId: "codex",
      remoteSessionId: `thread-${sessions.size + 1}`,
      machineId: input.machineId ?? "machine-a",
      serverId: "server/a",
      sessionId: `happier-session-${sessions.size + 1}`,
      openUrl: "https://cli-returned.invalid/must-not-be-persisted",
    };
    sessions.set(key, created);
    return { ...created, created: true };
  });
  return { ensure, sessions };
}

const describe = pgDescribe;

describe("Happier direct-session task routes", () => {
  const h = createSharedPgTaskStoreTestHarness({ prefix: "happier_route" });
  let store: TaskStore;
  let agentStore: AgentStore;
  let ensureHarness: ReturnType<typeof createStatefulOfficialEnsure>;
  let taskSequence = 0;

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  afterEach(h.afterEach);

  beforeEach(async () => {
    await h.beforeEach();
    store = h.store();
    agentStore = new AgentStore({
      rootDir: store.getFusionDir(),
      taskStore: store,
      asyncLayer: h.layer(),
    });
    await agentStore.init();
    ensureHarness = createStatefulOfficialEnsure();
    await store.getPluginStore().registerPlugin({
      manifest: {
        id: HAPPIER_RUNTIME_PLUGIN_ID,
        name: "Happier Runtime",
        version: "0.0.0",
      },
      path: join(h.rootDir(), "plugins", "happier-runtime"),
      settings: DEFAULT_SETTINGS,
    });
  });

  async function createTask(input: { column?: Task["column"]; paused?: boolean } = {}): Promise<Task> {
    taskSequence += 1;
    const created = await store.createTask({ description: `Happier route task ${taskSequence}` });
    const targetColumn = input.column ?? "todo";
    if (targetColumn === "archived") {
      await store.moveTask(created.id, "archived");
    } else if (targetColumn !== "triage") {
      await store.moveTask(created.id, "todo");
      if (targetColumn === "in-progress" || targetColumn === "in-review" || targetColumn === "done") {
        await store.moveTask(created.id, "in-progress");
      }
      if (targetColumn === "in-review" || targetColumn === "done") {
        await store.moveTask(created.id, "in-review");
      }
      if (targetColumn === "done") {
        await store.moveTask(created.id, "done");
      }
    }
    return store.updateTask(created.id, {
      paused: input.paused === false ? false : true,
      userPaused: input.paused === false ? false : true,
      worktree: `G:\\worktrees\\${created.id}`,
    });
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
      ensureHappierDirectSession: ensureHarness.ensure as never,
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
    await store.deleteTask(deleted.id);
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
    expect((await post(app, task.id)).status).toBe(200);

    const persisted = await readTaskHappierDirectSessionBinding({ store, taskId: task.id });
    expect(persisted).not.toHaveProperty("openUrl");
    expect(JSON.stringify(persisted)).not.toContain("cli-returned.invalid");

    await store.getPluginStore().updatePluginSettings(HAPPIER_RUNTIME_PLUGIN_ID, {
      webappUrl: "https://new.happier.example/root/",
    });
    const response = await request(app, "GET", `/api/tasks/${task.id}/happier-direct-session?projectId=${PROJECT_ID}`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      connected: true,
      taskId: task.id,
      cliSessionId: resolveTaskHappierCliSessionId({ taskId: task.id, purpose: "execute" }),
      nativeSessionId: "thread-1",
      providerId: "codex",
      happierSessionId: "happier-session-1",
      machineId: "machine-a",
      serverProfileId: "server/a",
      openUrl: "https://new.happier.example/root/session/happier-session-1?serverId=server%2Fa",
    });
    expect(response.body).not.toHaveProperty("remoteSessionId");
    expect(response.body).not.toHaveProperty("serverId");
  });

  it("GET reports malformed persisted binding metadata as a typed integrity failure", async () => {
    const task = await createTask();
    const { app } = createApp();
    expect((await post(app, task.id)).status).toBe(200);
    const cliSessionId = resolveTaskHappierCliSessionId({ taskId: task.id, purpose: "execute" });
    const cliStore = new AsyncCliSessionStore(h.layer());
    const session = await cliStore.getSession(cliSessionId);
    expect(session).toBeDefined();
    await cliStore.updateSession(cliSessionId, {
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
    { label: "done", column: "done" as const, paused: true },
    { label: "archived", column: "archived" as const, paused: true },
    { label: "in-progress", column: "in-progress" as const, paused: true },
    { label: "in-review", column: "in-review" as const, paused: true },
    { label: "unpaused", column: "todo" as const, paused: false },
  ])("POST rejects $label tasks before calling Happier", async ({ column, paused }) => {
    const task = await createTask({ column, paused });
    const { app } = createApp();
    const response = await post(app, task.id);
    expect(response.status).toBe(409);
    expect((response.body as TestResponseBody).details.code).toBe("HAPPIER_TASK_NOT_CONNECTABLE");
    expect(ensureHarness.ensure).not.toHaveBeenCalled();
  });

  it("POST rejects a deleted task before calling Happier", async () => {
    const task = await createTask();
    await store.deleteTask(task.id);
    const { app } = createApp();
    expect((await post(app, task.id)).status).toBe(404);
    expect(ensureHarness.ensure).not.toHaveBeenCalled();
  });

  it("POST rejects an unsafe Happier web origin before ensuring or persisting a binding", async () => {
    const task = await createTask();
    await store.getPluginStore().updatePluginSettings(HAPPIER_RUNTIME_PLUGIN_ID, {
      webappUrl: "javascript:alert(1)",
    });
    const { app } = createApp();

    const response = await post(app, task.id);

    expect(response.status).toBe(409);
    expect((response.body as TestResponseBody).details.code).toBe("HAPPIER_WEBAPP_URL_INVALID");
    expect(ensureHarness.ensure).not.toHaveBeenCalled();
    await expect(readTaskHappierDirectSessionBinding({ store, taskId: task.id })).resolves.toBeNull();
  });

  it("POST persists one stateful remote session, one exact-role bridge, and one assignment across retries", async () => {
    const task = await createTask();
    const before = await store.getTask(task.id);
    const promptBefore = await store.readPromptForArchive(task.id);
    const { app, engineCalls } = createApp();

    const first = await post(app, task.id, { machineId: "machine-a" });
    const second = await post(app, task.id, { machineId: "machine-a" });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body).toMatchObject({ created: true, nativeSessionId: "thread-1", happierSessionId: "happier-session-1" });
    expect(second.body).toMatchObject({ created: false, nativeSessionId: "thread-1", happierSessionId: "happier-session-1" });
    expect(ensureHarness.ensure).toHaveBeenCalledTimes(2);
    expect(ensureHarness.sessions).toHaveLength(1);
    expect(ensureHarness.ensure).toHaveBeenNthCalledWith(1, {
      uri: "codex://threads/thread-a",
      machineId: "machine-a",
      settings: DEFAULT_SETTINGS,
    });
    expect(ensureHarness.ensure).toHaveBeenNthCalledWith(2, {
      uri: "codex://threads/thread-a",
      machineId: "machine-a",
      settings: DEFAULT_SETTINGS,
    });

    const bridgeAgents = (await agentStore.listAgents({ includeEphemeral: false }))
      .filter((agent) => agent.name === HAPPIER_BRIDGE_AGENT_NAME);
    expect(bridgeAgents).toHaveLength(1);
    expect(bridgeAgents[0]).toMatchObject({
      role: "executor",
      runtimeConfig: HAPPIER_BRIDGE_RUNTIME_CONFIG,
      taskId: task.id,
    });
    const binding = await readTaskHappierDirectSessionBinding({ store, taskId: task.id });
    expect(binding).toMatchObject({ nativeSessionId: "thread-1", happierSessionId: "happier-session-1" });

    const after = await store.getTask(task.id);
    expect(after.assignedAgentId).toBe(bridgeAgents[0]?.id);
    expect(after.column).toBe(before.column);
    expect(after.status).toBe(before.status);
    expect(after.paused).toBe(before.paused);
    expect(after.userPaused).toBe(before.userPaused);
    expect(after.worktree).toBe(before.worktree);
    expect(await store.readPromptForArchive(task.id)).toBe(promptBefore);
    for (const call of Object.values(engineCalls)) expect(call).not.toHaveBeenCalled();
  });

  it("POST returns 409 before assignment for an exact-config same-name agent with the wrong role", async () => {
    const task = await createTask();
    const existing = await agentStore.createAgent({
      name: HAPPIER_BRIDGE_AGENT_NAME,
      role: "reviewer",
      runtimeConfig: { ...HAPPIER_BRIDGE_RUNTIME_CONFIG },
    });
    await agentStore.updateAgent(existing.id, { runtimeConfig: { ...HAPPIER_BRIDGE_RUNTIME_CONFIG } });
    const assignSpy = vi.spyOn(agentStore, "assignTask");
    const { app } = createApp();

    const response = await post(app, task.id);
    expect(response.status).toBe(409);
    expect((response.body as TestResponseBody).details).toMatchObject({
      code: "HAPPIER_BRIDGE_AGENT_CONFLICT",
      agentId: existing.id,
      sessionBound: true,
      nativeSessionId: "thread-1",
      happierSessionId: "happier-session-1",
    });
    expect(assignSpy).not.toHaveBeenCalled();
    expect((await agentStore.getAgent(existing.id))?.role).toBe("reviewer");
    expect((await store.getTask(task.id)).assignedAgentId).toBeUndefined();
  });

  it("POST conflicts with an incompatible same-name runtime without rewriting it or assigning", async () => {
    const task = await createTask();
    const existing = await agentStore.createAgent({
      name: HAPPIER_BRIDGE_AGENT_NAME,
      role: "executor",
      runtimeConfig: { runtimeHint: "other" },
    });
    const beforeRuntime = existing.runtimeConfig;
    const assignSpy = vi.spyOn(agentStore, "assignTask");
    const { app } = createApp();

    const response = await post(app, task.id);
    expect(response.status).toBe(409);
    expect((response.body as TestResponseBody).details.code).toBe("HAPPIER_BRIDGE_AGENT_CONFLICT");
    expect(assignSpy).not.toHaveBeenCalled();
    expect((await agentStore.getAgent(existing.id))?.runtimeConfig).toEqual(beforeRuntime);
    expect((await store.getTask(task.id)).assignedAgentId).toBeUndefined();
  });

  it("POST returns 409 for a different native session without replacing the first binding", async () => {
    const task = await createTask();
    const { app } = createApp();
    expect((await post(app, task.id)).status).toBe(200);

    const response = await post(app, task.id, { uri: "codex://threads/thread-b" });
    expect(response.status).toBe(409);
    expect((response.body as TestResponseBody).details.code).toBe("HAPPIER_DIRECT_SESSION_CONFLICT");
    await expect(readTaskHappierDirectSessionBinding({ store, taskId: task.id })).resolves.toMatchObject({
      nativeSessionId: "thread-1",
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
    ensureHarness.ensure.mockRejectedValueOnce(
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

  it("POST maps only an explicit plugin ENOENT to HAPPIER_PLUGIN_NOT_CONFIGURED", async () => {
    const task = await createTask();
    await store.getPluginStore().unregisterPlugin(HAPPIER_RUNTIME_PLUGIN_ID);
    const { app } = createApp();

    const response = await post(app, task.id);
    expect(response.status).toBe(409);
    expect((response.body as TestResponseBody).details.code).toBe("HAPPIER_PLUGIN_NOT_CONFIGURED");
    expect(ensureHarness.ensure).not.toHaveBeenCalled();
  });

  it.each([
    Object.assign(new Error("backend unavailable"), { code: "ECONNREFUSED" }),
    Object.assign(new Error("database read failed"), { code: "DB_READ_FAILED" }),
    Object.assign(new Error("permission denied"), { code: "EACCES" }),
    Object.assign(new Error("corrupt plugin row"), { code: "DATA_CORRUPT" }),
  ])("POST propagates non-ENOENT plugin-store failures as 500", async (pluginError) => {
    const task = await createTask();
    vi.spyOn(store.getPluginStore(), "getPlugin").mockRejectedValueOnce(pluginError);
    const { app } = createApp();

    const response = await post(app, task.id);
    expect(response.status).toBe(500);
    expect((response.body as TestResponseBody).error).toBe(pluginError.message);
    expect(ensureHarness.ensure).not.toHaveBeenCalled();
  });

  it("POST returns a typed partial error when assignment fails after binding and retry reuses the remote session", async () => {
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
      nativeSessionId: "thread-1",
      happierSessionId: "happier-session-1",
    });
    await expect(readTaskHappierDirectSessionBinding({ store, taskId: task.id })).resolves.toMatchObject({
      nativeSessionId: "thread-1",
      happierSessionId: "happier-session-1",
    });

    const second = await post(app, task.id);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ created: false, nativeSessionId: "thread-1", happierSessionId: "happier-session-1" });
    expect(assignTaskToBridge).toHaveBeenCalledTimes(2);
    expect(ensureHarness.ensure).toHaveBeenCalledTimes(2);
    expect(ensureHarness.sessions).toHaveLength(1);
  });
});

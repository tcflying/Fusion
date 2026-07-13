import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliSessionStore, Database } from "@fusion/core";
import { createCliSessionNativeSessionBinding } from "../agent-runtime.js";
import { createResolvedAgentSession } from "../agent-session-helpers.js";
import type { PluginRunner } from "../plugin-runner.js";

const cli = vi.hoisted(() => ({
  resolveHappierCliSettings: vi.fn(() => ({ executable: "happier", timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 })),
  createHappierSession: vi.fn(),
  sendHappierMessage: vi.fn(),
  getHappierSessionStatus: vi.fn(),
  getHappierSessionHistory: vi.fn(),
}));

vi.mock("../../../../plugins/fusion-plugin-happier-runtime/src/cli-spawn.js", () => cli);
vi.mock("../logger.js", () => ({
  createLogger: vi.fn(() => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() })),
}));
vi.mock("../pi.js", () => ({
  createFnAgent: vi.fn(),
  promptWithFallback: vi.fn(),
  describeModel: vi.fn(() => "pi/default"),
}));

import { HappierRuntimeAdapter } from "../../../../plugins/fusion-plugin-happier-runtime/src/runtime-adapter.js";

describe("AgentRuntime native session persistence binding", () => {
  let tmpDir: string;
  let fusionDir: string;
  let database: Database;
  let store: CliSessionStore;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "fusion-agent-runtime-native-session-"));
    fusionDir = join(tmpDir, ".fusion");
    database = new Database(fusionDir, { inMemory: true });
    database.init();
    store = new CliSessionStore(fusionDir, database);
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    database.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("persists a created native id and exposes it to a fresh runtime binding", async () => {
    const fusionSession = store.createSession({
      id: "cli-happier-1",
      taskId: "FN-HAPPIER-1",
      purpose: "execute",
      projectId: "project-happier",
      adapterId: "happier",
    });
    const firstRuntimeBinding = createCliSessionNativeSessionBinding(store, fusionSession.id);

    expect(firstRuntimeBinding.nativeSessionId).toBeNull();
    await firstRuntimeBinding.persistNativeSessionId("hp_session_durable");

    const restartedStore = new CliSessionStore(fusionDir, database);
    const restartedRuntimeBinding = createCliSessionNativeSessionBinding(restartedStore, fusionSession.id);
    expect(restartedRuntimeBinding.nativeSessionId).toBe("hp_session_durable");
  });

  it("fails closed when the owning Fusion session no longer exists", async () => {
    expect(() => createCliSessionNativeSessionBinding(store, "cli-missing")).toThrow(
      /CLI session not found/,
    );
  });

  it("persists then reconciles one Happier id through the real engine runtime path", async () => {
    const fusionSession = store.createSession({
      id: "cli-happier-engine-path",
      taskId: "FN-HAPPIER-ENGINE",
      purpose: "execute",
      projectId: "project-happier",
      adapterId: "happier",
    });
    const histories = new Map<string, unknown[]>();
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
    cli.sendHappierMessage.mockImplementation(async ({ sessionId, message }: { sessionId: string; message: string }) => {
      const messages = histories.get(sessionId) ?? [];
      messages.push(
        { id: `user-${messages.length}`, role: "user", content: { type: "text", text: message } },
        { id: `assistant-${messages.length + 1}`, role: "assistant", content: { type: "text", text: `reply:${message}` } },
      );
      histories.set(sessionId, messages);
      return { sessionId, localId: `user-${messages.length - 2}`, waited: true };
    });

    const pluginRunner = {
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

    const first = await createResolvedAgentSession({
      sessionPurpose: "executor",
      runtimeHint: "happier",
      pluginRunner,
      cwd: tmpDir,
      systemPrompt: "first runtime",
      nativeSession: createCliSessionNativeSessionBinding(store, fusionSession.id),
    });
    await (first.session as unknown as { promptWithFallback(prompt: string): Promise<void> })
      .promptWithFallback("before restart");

    expect(store.getSession(fusionSession.id)?.nativeSessionId).toBe("hp_engine_durable");
    const restartedStore = new CliSessionStore(fusionDir, database);
    const restarted = await createResolvedAgentSession({
      sessionPurpose: "executor",
      runtimeHint: "happier",
      pluginRunner,
      cwd: tmpDir,
      systemPrompt: "restarted runtime",
      nativeSession: createCliSessionNativeSessionBinding(restartedStore, fusionSession.id),
    });
    await (restarted.session as unknown as { promptWithFallback(prompt: string): Promise<void> })
      .promptWithFallback("after restart");

    expect(cli.createHappierSession).toHaveBeenCalledTimes(1);
    expect(restarted.session.sessionId).toBe("hp_engine_durable");
    const restartStatusOrder = cli.getHappierSessionStatus.mock.invocationCallOrder.find(
      (order) => order > cli.sendHappierMessage.mock.invocationCallOrder[0],
    );
    expect(restartStatusOrder).toBeDefined();
    expect(restartStatusOrder!).toBeLessThan(cli.sendHappierMessage.mock.invocationCallOrder[1]);
  });
});

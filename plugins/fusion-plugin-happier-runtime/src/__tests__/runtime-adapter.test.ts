import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeNativeSessionBinding, AgentRuntimeOptions } from "@fusion/engine/agent-runtime";
import { HappierCliError } from "../types.js";
import type { HappierAgentSession } from "../types.js";

const cli = vi.hoisted(() => ({
  resolveHappierCliSettings: vi.fn(() => ({ executable: "happier", timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 })),
  createHappierSession: vi.fn(),
  sendHappierMessage: vi.fn(),
  getHappierSessionStatus: vi.fn(),
  getHappierSessionHistory: vi.fn(),
}));

vi.mock("../cli-spawn.js", () => cli);

import { HappierRecoveryError, HappierRuntimeAdapter } from "../runtime-adapter.js";

type HistoryMessage = {
  id: string;
  role: "user" | "assistant";
  content: { type: "text"; text: string };
};

let nextSessionNumber: number;
let nextMessageNumber: number;
let histories: Map<string, HistoryMessage[]>;

function historyFor(sessionId: string): HistoryMessage[] {
  const existing = histories.get(sessionId);
  if (existing) return existing;
  const created: HistoryMessage[] = [];
  histories.set(sessionId, created);
  return created;
}

function nativeBinding(nativeSessionId: string | null = null) {
  const persistNativeSessionId = vi.fn(async () => undefined);
  const binding: AgentRuntimeNativeSessionBinding = {
    nativeSessionId,
    persistNativeSessionId,
  };
  return { binding, persistNativeSessionId };
}

function makeOptions(
  binding: AgentRuntimeNativeSessionBinding,
  overrides: Partial<AgentRuntimeOptions> = {},
): AgentRuntimeOptions {
  return {
    cwd: "G:\\fusion\\task",
    systemPrompt: "You are a Fusion agent.",
    nativeSession: binding,
    ...overrides,
  };
}

function resumableStatus(sessionId = "hp_session_1") {
  return {
    sessionId,
    session: { id: sessionId, active: true },
    agentState: { pendingRequestsCount: 0, controlledByUser: false },
  };
}

describe("HappierRuntimeAdapter", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    nextSessionNumber = 1;
    nextMessageNumber = 1;
    histories = new Map();

    cli.createHappierSession.mockImplementation(async () => {
      const sessionId = `hp_session_${nextSessionNumber++}`;
      historyFor(sessionId);
      return { sessionId, session: { id: sessionId }, created: true };
    });
    cli.sendHappierMessage.mockImplementation(async ({ sessionId, message }: { sessionId: string; message: string }) => {
      const localId = `user-${nextMessageNumber++}`;
      const assistantId = `assistant-${nextMessageNumber++}`;
      historyFor(sessionId).push(
        { id: localId, role: "user", content: { type: "text", text: message } },
        { id: assistantId, role: "assistant", content: { type: "text", text: `reply:${message}` } },
      );
      return { sessionId, localId, waited: true };
    });
    cli.getHappierSessionStatus.mockImplementation(async (sessionId: string) => resumableStatus(sessionId));
    cli.getHappierSessionHistory.mockImplementation(async (sessionId: string) => ({
      sessionId,
      format: "raw",
      messages: [...historyFor(sessionId)],
    }));
  });

  it("persists the first native id before send, creates once, and reuses it", async () => {
    const native = nativeBinding();
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(native.binding));

    await runtime.promptWithFallback(result.session, "first prompt");
    await runtime.promptWithFallback(result.session, "second prompt");

    expect(cli.createHappierSession).toHaveBeenCalledTimes(1);
    expect(native.persistNativeSessionId).toHaveBeenCalledOnce();
    expect(native.persistNativeSessionId).toHaveBeenCalledWith("hp_session_1");
    expect(native.persistNativeSessionId.mock.invocationCallOrder[0]).toBeLessThan(
      cli.sendHappierMessage.mock.invocationCallOrder[0],
    );
    expect(cli.sendHappierMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionId: "hp_session_1", message: "second prompt" }),
      expect.anything(),
    );
    expect(result.session.sessionId).toBe("hp_session_1");
  });

  it("reconciles a persisted native id before sending after restart", async () => {
    const native = nativeBinding("hp_session_1");
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(native.binding));

    await runtime.promptWithFallback(result.session, "after restart");

    expect(cli.createHappierSession).not.toHaveBeenCalled();
    expect(native.persistNativeSessionId).not.toHaveBeenCalled();
    expect(cli.getHappierSessionStatus).toHaveBeenCalledWith("hp_session_1", expect.anything());
    expect(cli.sendHappierMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "hp_session_1", message: "after restart" }),
      expect.anything(),
    );
    expect(cli.getHappierSessionStatus.mock.invocationCallOrder[0]).toBeLessThan(
      cli.sendHappierMessage.mock.invocationCallOrder[0],
    );
  });

  it("reuses and reconciles the id persisted by a previous runtime instance", async () => {
    let persistedNativeSessionId: string | null = null;
    const firstBinding: AgentRuntimeNativeSessionBinding = {
      nativeSessionId: null,
      persistNativeSessionId: async (nativeSessionId) => {
        persistedNativeSessionId = nativeSessionId;
      },
    };
    const firstRuntime = new HappierRuntimeAdapter({ backend: "codex" });
    const firstSession = await firstRuntime.createSession(makeOptions(firstBinding));
    await firstRuntime.promptWithFallback(firstSession.session, "before restart");

    expect(persistedNativeSessionId).toBe("hp_session_1");
    const restartedRuntime = new HappierRuntimeAdapter({ backend: "codex" });
    const restartedSession = await restartedRuntime.createSession(makeOptions({
      nativeSessionId: persistedNativeSessionId,
      persistNativeSessionId: async () => undefined,
    }));
    await restartedRuntime.promptWithFallback(restartedSession.session, "after restart");

    expect(cli.createHappierSession).toHaveBeenCalledTimes(1);
    expect(restartedSession.session.sessionId).toBe("hp_session_1");
    const restartStatusCall = cli.getHappierSessionStatus.mock.invocationCallOrder.find(
      (order) => order > cli.sendHappierMessage.mock.invocationCallOrder[0],
    );
    expect(restartStatusCall).toBeDefined();
    expect(restartStatusCall!).toBeLessThan(cli.sendHappierMessage.mock.invocationCallOrder[1]);
  });

  it("preserves blocked for a missing persisted session and never replaces it", async () => {
    cli.getHappierSessionStatus.mockRejectedValue(new HappierCliError("session", "session not found"));
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(nativeBinding("missing").binding));

    await expect(runtime.promptWithFallback(result.session, "do not replace")).rejects.toMatchObject({
      name: "HappierRecoveryError",
      code: "session-missing",
    });
    expect((result.session as HappierAgentSession).state.status).toBe("blocked");
    expect(cli.createHappierSession).not.toHaveBeenCalled();
    expect(cli.sendHappierMessage).not.toHaveBeenCalled();
  });

  it("preserves blocked for a non-resumable persisted session", async () => {
    cli.getHappierSessionStatus.mockResolvedValue({
      sessionId: "hp_session_1",
      session: { id: "hp_session_1", status: "completed" },
      agentState: { status: "completed", resumable: false },
    });
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(nativeBinding("hp_session_1").binding));

    await expect(runtime.promptWithFallback(result.session, "do not replace")).rejects.toMatchObject({
      name: "HappierRecoveryError",
      code: "session-not-resumable",
    });
    expect((result.session as HappierAgentSession).state.status).toBe("blocked");
    expect(cli.createHappierSession).not.toHaveBeenCalled();
    expect(cli.sendHappierMessage).not.toHaveBeenCalled();
  });

  it("resumes an inactive session only when official status explicitly marks it resumable", async () => {
    cli.getHappierSessionStatus.mockResolvedValue({
      sessionId: "hp_session_1",
      session: { id: "hp_session_1", active: false, resumable: true },
      agentState: { status: "idle", resumable: true },
    });
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(nativeBinding("hp_session_1").binding));

    await runtime.promptWithFallback(result.session, "resume explicitly");

    expect(cli.createHappierSession).not.toHaveBeenCalled();
    expect(cli.sendHappierMessage).toHaveBeenCalledOnce();
  });

  it("serializes concurrent first prompts so one native session is created", async () => {
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(nativeBinding().binding));

    await Promise.all([
      runtime.promptWithFallback(result.session, "first concurrent prompt"),
      runtime.promptWithFallback(result.session, "second concurrent prompt"),
    ]);

    expect(cli.createHappierSession).toHaveBeenCalledTimes(1);
    expect(cli.sendHappierMessage).toHaveBeenCalledTimes(2);
    expect(cli.sendHappierMessage.mock.calls.map((call) => call[0].message)).toEqual([
      "first concurrent prompt",
      "second concurrent prompt",
    ]);
  });

  it("serializes sends for one runtime session", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const originalSend = cli.sendHappierMessage.getMockImplementation()!;
    cli.sendHappierMessage.mockImplementationOnce(async (...args: unknown[]) => {
      await firstGate;
      return originalSend(...args);
    });
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(nativeBinding().binding));

    const prompts = Promise.all([
      runtime.promptWithFallback(result.session, "serialized one"),
      runtime.promptWithFallback(result.session, "serialized two"),
    ]);
    await vi.waitFor(() => expect(cli.sendHappierMessage).toHaveBeenCalledTimes(1));
    releaseFirst();
    await prompts;

    expect(cli.sendHappierMessage).toHaveBeenCalledTimes(2);
  });

  it("allows different runtime sessions to send concurrently", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalSend = cli.sendHappierMessage.getMockImplementation()!;
    let active = 0;
    let maxActive = 0;
    cli.sendHappierMessage.mockImplementation(async (...args: unknown[]) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      const result = await originalSend(...args);
      active -= 1;
      return result;
    });
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const first = await runtime.createSession(makeOptions(nativeBinding().binding));
    const second = await runtime.createSession(makeOptions(nativeBinding().binding));

    const prompts = Promise.all([
      runtime.promptWithFallback(first.session, "session one"),
      runtime.promptWithFallback(second.session, "session two"),
    ]);
    await vi.waitFor(() => expect(cli.sendHappierMessage).toHaveBeenCalledTimes(2));
    expect(maxActive).toBe(2);
    release();
    await prompts;
  });

  it("emits only newly-produced assistant text after successful --wait metadata", async () => {
    histories.set("hp_session_1", [
      { id: "old-assistant", role: "assistant", content: { type: "text", text: "old output" } },
    ]);
    const onText = vi.fn();
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(nativeBinding("hp_session_1").binding, { onText }));

    await runtime.promptWithFallback(result.session, "new prompt");

    expect(onText).toHaveBeenCalledWith("reply:new prompt");
    expect(onText).not.toHaveBeenCalledWith("old output");
    expect(onText.mock.calls.flat().join("\n")).toBe("reply:new prompt");
  });

  it("accepts an ambiguous send only when bounded history positively proves acceptance", async () => {
    cli.sendHappierMessage.mockImplementationOnce(async ({ sessionId, message }: { sessionId: string; message: string }) => {
      historyFor(sessionId).push(
        { id: "accepted-user", role: "user", content: { type: "text", text: message } },
        { id: "accepted-assistant", role: "assistant", content: { type: "text", text: "accepted reply" } },
      );
      throw new HappierCliError("timeout", "send timed out");
    });
    const onText = vi.fn();
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(nativeBinding().binding, { onText }));

    await runtime.promptWithFallback(result.session, "ambiguous");

    expect(cli.getHappierSessionStatus).toHaveBeenCalledTimes(1);
    expect(cli.sendHappierMessage).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith("accepted reply");
  });

  it("does not treat history absence as rejection and never resends an ambiguous prompt", async () => {
    cli.sendHappierMessage.mockRejectedValueOnce(new HappierCliError("timeout", "send timed out"));
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(nativeBinding().binding));

    await expect(runtime.promptWithFallback(result.session, "unknown outcome")).rejects.toMatchObject({
      name: "HappierRecoveryError",
      code: "ambiguous-send-unresolved",
    });
    expect((result.session as HappierAgentSession).state.status).toBe("blocked");
    expect(cli.getHappierSessionStatus).toHaveBeenCalledTimes(1);
    expect(cli.sendHappierMessage).toHaveBeenCalledTimes(1);
  });

  it("blocks before send when native-id persistence fails", async () => {
    const native = nativeBinding();
    native.persistNativeSessionId.mockRejectedValue(new Error("database unavailable"));
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(native.binding));

    await expect(runtime.promptWithFallback(result.session, "must persist first")).rejects.toBeInstanceOf(
      HappierRecoveryError,
    );
    expect((result.session as HappierAgentSession).state.status).toBe("blocked");
    expect(cli.sendHappierMessage).not.toHaveBeenCalled();
  });
});

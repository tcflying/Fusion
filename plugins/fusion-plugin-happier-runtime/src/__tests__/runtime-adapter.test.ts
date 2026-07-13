import { beforeEach, describe, expect, it, vi } from "vitest";
import { HappierCliError } from "../types.js";
import type { AgentRuntimeOptions } from "../types.js";

const cli = vi.hoisted(() => ({
  resolveHappierCliSettings: vi.fn(() => ({ executable: "happier", timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 })),
  createHappierSession: vi.fn(),
  sendHappierMessage: vi.fn(),
  getHappierSessionStatus: vi.fn(),
  getHappierSessionHistory: vi.fn(),
}));

vi.mock("../cli-spawn.js", () => cli);

import { HappierRecoveryError, HappierRuntimeAdapter } from "../runtime-adapter.js";

function makeOptions(overrides: Partial<AgentRuntimeOptions> = {}): AgentRuntimeOptions {
  return {
    cwd: "G:\\fusion\\task",
    systemPrompt: "You are a Fusion agent.",
    ...overrides,
  };
}

function createdSession() {
  return { sessionId: "hp_session_1", session: { id: "hp_session_1" }, created: true };
}

function resumableStatus() {
  return {
    sessionId: "hp_session_1",
    session: { id: "hp_session_1", active: true },
    agentState: { pendingRequestsCount: 0, controlledByUser: false },
  };
}

describe("HappierRuntimeAdapter", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    cli.createHappierSession.mockResolvedValue(createdSession());
    cli.sendHappierMessage.mockResolvedValue({ sessionId: "hp_session_1", waited: true });
    cli.getHappierSessionStatus.mockResolvedValue(resumableStatus());
    cli.getHappierSessionHistory.mockResolvedValue({
      sessionId: "hp_session_1",
      format: "raw",
      messages: [],
    });
  });

  it("creates exactly one native session on the first prompt and reuses it", async () => {
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions());

    await runtime.promptWithFallback(result.session, "first prompt");
    await runtime.promptWithFallback(result.session, "second prompt");

    expect(cli.createHappierSession).toHaveBeenCalledTimes(1);
    expect(cli.sendHappierMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionId: "hp_session_1", message: "second prompt" }),
      expect.anything(),
    );
    expect(result.session.sessionId).toBe("hp_session_1");
  });

  it("reconciles a persisted native id before sending after restart", async () => {
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(
      makeOptions({ sessionId: "hp_session_1" }),
    );

    await runtime.promptWithFallback(result.session, "after restart");

    expect(cli.createHappierSession).not.toHaveBeenCalled();
    expect(cli.getHappierSessionStatus).toHaveBeenCalledWith(
      "hp_session_1",
      expect.anything(),
    );
    expect(cli.sendHappierMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "hp_session_1", message: "after restart" }),
      expect.anything(),
    );
    expect(cli.getHappierSessionStatus.mock.invocationCallOrder[0]).toBeLessThan(
      cli.sendHappierMessage.mock.invocationCallOrder[0],
    );
    expect(result.session.sessionId).toBe("hp_session_1");
  });

  it("returns a typed recovery failure for a missing persisted session without replacement", async () => {
    cli.getHappierSessionStatus.mockRejectedValue(
      new HappierCliError("session", "session not found"),
    );
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions({ sessionId: "missing" }));

    await expect(runtime.promptWithFallback(result.session, "do not replace")).rejects.toMatchObject({
      name: "HappierRecoveryError",
      code: "session-missing",
    });
    expect(result.session.state.status).toBe("blocked");
    expect(cli.createHappierSession).not.toHaveBeenCalled();
    expect(cli.sendHappierMessage).not.toHaveBeenCalled();
  });

  it("returns a typed recovery failure for a non-resumable persisted session", async () => {
    cli.getHappierSessionStatus.mockResolvedValue({
      sessionId: "hp_session_1",
      session: { id: "hp_session_1", status: "completed" },
      agentState: { status: "completed", resumable: false },
    });
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions({ sessionId: "hp_session_1" }));

    await expect(runtime.promptWithFallback(result.session, "do not replace")).rejects.toMatchObject({
      name: "HappierRecoveryError",
      code: "session-not-resumable",
    });
    expect(result.session.state.status).toBe("blocked");
    expect(cli.createHappierSession).not.toHaveBeenCalled();
    expect(cli.sendHappierMessage).not.toHaveBeenCalled();
  });

  it("reconciles an ambiguous send once and avoids a duplicate when history contains the prompt", async () => {
    cli.sendHappierMessage.mockRejectedValueOnce(new HappierCliError("timeout", "send timed out"));
    cli.getHappierSessionHistory.mockResolvedValue({
      sessionId: "hp_session_1",
      format: "raw",
      messages: [{ role: "user", content: { type: "text", text: "ambiguous" } }],
    });
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions());

    await runtime.promptWithFallback(result.session, "ambiguous");

    expect(cli.getHappierSessionStatus).toHaveBeenCalledTimes(1);
    expect(cli.getHappierSessionHistory).toHaveBeenCalledTimes(1);
    expect(cli.sendHappierMessage).toHaveBeenCalledTimes(1);
  });

  it("resends at most once only after reconciliation proves the prompt was not accepted", async () => {
    cli.sendHappierMessage
      .mockRejectedValueOnce(new HappierCliError("timeout", "send timed out"))
      .mockResolvedValueOnce({ sessionId: "hp_session_1", waited: true });
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions());

    await runtime.promptWithFallback(result.session, "not accepted");

    expect(cli.getHappierSessionStatus).toHaveBeenCalledTimes(1);
    expect(cli.getHappierSessionHistory).toHaveBeenCalledTimes(1);
    expect(cli.sendHappierMessage).toHaveBeenCalledTimes(2);
  });

  it("exposes a typed recovery error when an ambiguous send cannot be reconciled", async () => {
    cli.sendHappierMessage.mockRejectedValueOnce(new HappierCliError("timeout", "send timed out"));
    cli.getHappierSessionHistory.mockRejectedValue(new HappierCliError("server", "history unavailable"));
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions());

    await expect(runtime.promptWithFallback(result.session, "unknown outcome")).rejects.toBeInstanceOf(
      HappierRecoveryError,
    );
    expect(cli.sendHappierMessage).toHaveBeenCalledTimes(1);
  });
});

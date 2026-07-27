import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRuntimeNativeSessionBinding, AgentRuntimeOptions } from "@fusion/engine/agent-runtime";
import { HappierCliError } from "../types.js";
import type { HappierAgentSession } from "../types.js";

const cli = vi.hoisted(() => ({
  resolveHappierCliSettings: vi.fn((settings: Record<string, unknown> = {}) => ({
    executable: "happier",
    timeoutMs: 30_000,
    timeoutSeconds: 300,
    maxOutputBytes: 1024 * 1024,
    ...settings,
  })),
  archiveHappierSession: vi.fn(async () => undefined),
  createHappierSession: vi.fn(),
  sendHappierMessage: vi.fn(),
  stopHappierSession: vi.fn(),
  startHappierResumeProcess: vi.fn(),
  setHappierSessionTitle: vi.fn(async () => undefined),
  setHappierSessionModel: vi.fn(async () => undefined),
  setHappierSessionPermissionMode: vi.fn(async () => undefined),
  listHappierSessions: vi.fn(),
  getHappierSessionStatus: vi.fn(),
  getHappierSessionHistory: vi.fn(),
}));

vi.mock("../cli-spawn.js", () => cli);

vi.mock("../cli-attestation.js", () => ({
  verifyHappierCliAttestation: vi.fn(async () => ({
    ok: true,
    trustLevel: "local_custom_pinned_source_build",
    sourceRoot: "G:\\codex-project\\happier",
    entrypointPath: "G:\\codex-project\\happier\\apps\\cli\\package-dist\\index.mjs",
    cliVersion: "0.2.10",
    sourceCommit: "6e059c41d865343c1efc9c98676e5af3882d85ff",
    entrypointSha256: "sha256:8ad722284c12ca87c946f3a94b66b14f5640bf768e719c8791b1cb0234312786",
    verifiedAt: "2026-07-27T04:40:00.000Z",
    evidence: {
      version: "cli_--version",
      package: "package_json",
      source: "git_head",
      artifact: "sha256_file_bytes",
    },
  })),
}));

const createIntents = vi.hoisted(() => ({
  records: new Map<string, Record<string, unknown>>(),
}));

vi.mock("../create-intent-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../create-intent-store.js")>();
  return {
    ...actual,
    createHappierCreateIntentStore: () => ({
      read: async (keyHash: string) => createIntents.records.get(keyHash) ?? null,
      write: async (record: Record<string, unknown>) => {
        createIntents.records.set(record.keyHash as string, structuredClone(record));
      },
    }),
  };
});

const stopStates = vi.hoisted(() => ({
  records: new Map<string, Record<string, unknown>>(),
}));

vi.mock("../stop-state-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../stop-state-store.js")>();
  return {
    ...actual,
    createHappierStopStateStore: () => ({
      read: async (keyHash: string) => stopStates.records.get(keyHash) ?? null,
      write: async (record: Record<string, unknown>) => {
        stopStates.records.set(record.keyHash as string, structuredClone(record));
      },
    }),
  };
});

import { HappierRecoveryError, HappierRuntimeAdapter } from "../runtime-adapter.js";

type RawHistoryRow = {
  id: string;
  localId?: string;
  createdAt: number;
  role: string;
  raw: Record<string, unknown>;
};

let nextSessionNumber: number;
let nextMessageNumber: number;
let nextBindingNumber: number;
let histories: Map<string, RawHistoryRow[]>;

function rawTextRow(
  id: string,
  createdAt: number,
  role: RawHistoryRow["role"],
  text: string,
  localId?: string,
): RawHistoryRow {
  return { id, ...(localId ? { localId } : {}), createdAt, role, raw: { content: { type: "text", text } } };
}

function rawCodexRow(id: string, createdAt: number, text: string): RawHistoryRow {
  return {
    id,
    createdAt,
    role: "agent",
    raw: { content: { type: "codex", provider: "codex", data: { type: "message", message: text } } },
  };
}

function rawEventMessageRow(id: string, createdAt: number, text: string): RawHistoryRow {
  return {
    id,
    createdAt,
    role: "agent",
    raw: { content: { type: "event", data: { type: "message", message: text } } },
  };
}

function historyFor(sessionId: string): RawHistoryRow[] {
  const existing = histories.get(sessionId);
  if (existing) return existing;
  const created: RawHistoryRow[] = [];
  histories.set(sessionId, created);
  return created;
}

function nativeBinding(nativeSessionId: string | null = null, key = `binding-${nextBindingNumber++}`) {
  let persisted = nativeSessionId;
  const refreshNativeSessionId = vi.fn(async () => persisted);
  const claimNativeSessionId = vi.fn(async (candidate: string) => {
    if (!persisted) {
      persisted = candidate;
      binding.nativeSessionId = candidate;
      return { claimed: true, nativeSessionId: candidate };
    }
    return { claimed: false, nativeSessionId: persisted };
  });
  const persistNativeSessionId = vi.fn(async (candidate: string) => {
    const result = await claimNativeSessionId(candidate);
    if (result.nativeSessionId !== candidate) throw new Error("native id already claimed");
  });
  const binding: AgentRuntimeNativeSessionBinding = {
    key,
    nativeSessionId,
    refreshNativeSessionId,
    claimNativeSessionId,
    persistNativeSessionId,
  };
  return { binding, refreshNativeSessionId, claimNativeSessionId, persistNativeSessionId };
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
    nextBindingNumber = 1;
    histories = new Map();
    createIntents.records.clear();
    stopStates.records.clear();

    cli.createHappierSession.mockImplementation(async () => {
      const sessionId = `hp_session_${nextSessionNumber++}`;
      historyFor(sessionId);
      return { sessionId, session: { id: sessionId }, created: true };
    });
    cli.sendHappierMessage.mockImplementation(async ({ sessionId, message, localId }: { sessionId: string; message: string; localId: string }) => {
      const userId = `user-${nextMessageNumber++}`;
      const assistantId = `assistant-${nextMessageNumber++}`;
      historyFor(sessionId).push(
        rawTextRow(userId, nextMessageNumber * 1_000, "user", message, localId),
        rawTextRow(assistantId, nextMessageNumber * 1_000 + 1, "assistant", `reply:${message}`),
      );
      return { sessionId, localId, waited: true };
    });
    cli.getHappierSessionStatus.mockImplementation(async (sessionId: string) => resumableStatus(sessionId));
    cli.stopHappierSession.mockImplementation(async (sessionId: string) => ({
      sessionId,
      stopped: true,
    }));
    cli.startHappierResumeProcess.mockImplementation(async (sessionId: string) => ({
      sessionId,
      pid: 42,
      stop: vi.fn(async () => true),
    }));
    cli.listHappierSessions.mockResolvedValue({
      sessions: [],
      nextCursor: null,
      hasNext: false,
    });
    cli.getHappierSessionHistory.mockImplementation(async (sessionId: string) => ({
      sessionId,
      format: "raw",
      messages: [...historyFor(sessionId)],
    }));
  });

  it("fails closed before session or provider I/O when CLI attestation drifts", async () => {
    const native = nativeBinding();
    const runtime = new HappierRuntimeAdapter({ backend: "codex" }, {
      attestCli: async () => ({ ok: false, reasonCode: "cli_artifact_hash_mismatch" }),
    });

    await expect(runtime.createSession(makeOptions(native.binding))).rejects.toMatchObject({
      code: "process",
      officialCode: "cli_artifact_hash_mismatch",
    });
    expect(cli.createHappierSession).not.toHaveBeenCalled();
    expect(cli.sendHappierMessage).not.toHaveBeenCalled();
  });

  it("persists the first native id before send, creates once, and reuses it", async () => {
    const native = nativeBinding();
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(native.binding));

    await runtime.promptWithFallback(result.session, "first prompt");
    await runtime.promptWithFallback(result.session, "second prompt");

    expect(cli.createHappierSession).toHaveBeenCalledTimes(1);
    expect(native.claimNativeSessionId).toHaveBeenCalledOnce();
    expect(native.claimNativeSessionId).toHaveBeenCalledWith("hp_session_1");
    expect(native.claimNativeSessionId.mock.invocationCallOrder[0]).toBeLessThan(
      cli.sendHappierMessage.mock.invocationCallOrder[0],
    );
    expect(cli.sendHappierMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sessionId: "hp_session_1", message: "second prompt" }),
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(result.session.sessionId).toBe("hp_session_1");
  });

  it("passes the prompt AbortSignal and a stable Fusion tag into first create without claiming a cancelled create", async () => {
    const native = nativeBinding(null, "create-cancel-binding");
    cli.createHappierSession.mockRejectedValueOnce(
      new HappierCliError("timeout", "Happier CLI invocation aborted"),
    );
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(native.binding));

    await expect(runtime.promptWithFallback(result.session, "cancel first create")).rejects.toMatchObject({
      code: "timeout",
      message: "Happier CLI invocation aborted",
    });
    expect(cli.createHappierSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "G:\\fusion\\task",
        backend: "codex",
        tag: expect.stringMatching(/^fusion-happier-v1-[a-f0-9]{32}$/u),
      }),
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(native.claimNativeSessionId).not.toHaveBeenCalled();
  });

  it("uses taskTitle and calls beforeSpawnSession at the final remote-create decision point", async () => {
    const lifecycle: string[] = [];
    const beforeSpawnSession = vi.fn(async () => {
      lifecycle.push("before-spawn");
    });
    cli.listHappierSessions.mockImplementationOnce(async () => {
      lifecycle.push("list");
      return { sessions: [], nextCursor: null, hasNext: false };
    });
    cli.createHappierSession.mockImplementationOnce(async () => {
      lifecycle.push("create");
      historyFor("hp_titled_session");
      return {
        sessionId: "hp_titled_session",
        session: { id: "hp_titled_session" },
        created: true,
      };
    });
    const native = nativeBinding(null, "title-before-spawn-binding");
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(native.binding, {
      taskTitle: "Operator-visible task title",
      beforeSpawnSession,
    }));

    await runtime.promptWithFallback(result.session, "start titled task");

    expect(lifecycle).toEqual(["list", "before-spawn", "create"]);
    expect(beforeSpawnSession).toHaveBeenCalledOnce();
    expect(cli.createHappierSession).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Operator-visible task title" }),
      expect.anything(),
      expect.any(AbortSignal),
    );
  });

  it("never creates or claims when the final beforeSpawnSession gate rejects", async () => {
    const native = nativeBinding(null, "before-spawn-reject-binding");
    const beforeSpawnSession = vi.fn(async () => {
      throw new Error("task paused before Provider spawn");
    });
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(native.binding, {
      beforeSpawnSession,
    }));

    await expect(
      runtime.promptWithFallback(result.session, "must remain paused"),
    ).rejects.toThrow("task paused before Provider spawn");

    expect(beforeSpawnSession).toHaveBeenCalledOnce();
    expect(cli.createHappierSession).not.toHaveBeenCalled();
    expect(native.claimNativeSessionId).not.toHaveBeenCalled();
  });

  it("forwards defaultModelId, system instructions, and readonly permission to the official send", async () => {
    const native = nativeBinding("hp_readonly_session", "readonly-runtime-options-binding");
    historyFor("hp_readonly_session");
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(native.binding, {
      defaultModelId: "gpt-5.6-sol",
      systemPrompt: "Inspect only. Do not modify files.",
      tools: "readonly",
    }));

    await runtime.promptWithFallback(result.session, "Review the current diff.");

    expect(cli.sendHappierMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "hp_readonly_session",
        message: "Review the current diff.",
        systemPrompt: "Inspect only. Do not modify files.",
        modelId: "gpt-5.6-sol",
        permissionMode: "read-only",
      }),
      expect.anything(),
      expect.any(AbortSignal),
    );
  });

  it("maps coding tools to Happier safe-yolo for persistent control and send", async () => {
    const sessionId = "hp_coding_session";
    historyFor(sessionId);
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(
      nativeBinding(sessionId, "coding-runtime-options-binding").binding,
      { tools: "coding" },
    ));

    await runtime.promptWithFallback(result.session, "Implement the bounded change.");

    expect(cli.setHappierSessionPermissionMode).toHaveBeenCalledWith(
      sessionId,
      "safe-yolo",
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(cli.sendHappierMessage).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: "safe-yolo" }),
      expect.anything(),
      expect.any(AbortSignal),
    );
  });

  it("persists visible title, model, and permission once before the first official send", async () => {
    const sessionId = "hp_visible_options";
    const native = nativeBinding(sessionId, "visible-runtime-options-binding");
    historyFor(sessionId);
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(native.binding, {
      taskTitle: "Visible Fusion task",
      defaultModelId: "gpt-5.6-sol",
      tools: "readonly",
    }));

    await runtime.promptWithFallback(result.session, "first prompt");
    await runtime.promptWithFallback(result.session, "second prompt");

    expect(cli.setHappierSessionTitle).toHaveBeenCalledOnce();
    expect(cli.setHappierSessionTitle).toHaveBeenCalledWith(
      sessionId,
      "Visible Fusion task",
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(cli.setHappierSessionModel).toHaveBeenCalledOnce();
    expect(cli.setHappierSessionModel).toHaveBeenCalledWith(
      sessionId,
      "gpt-5.6-sol",
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(cli.setHappierSessionPermissionMode).toHaveBeenCalledOnce();
    expect(cli.setHappierSessionPermissionMode).toHaveBeenCalledWith(
      sessionId,
      "read-only",
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(cli.setHappierSessionPermissionMode.mock.invocationCallOrder[0]).toBeLessThan(
      cli.sendHappierMessage.mock.invocationCallOrder[0],
    );
    expect(cli.sendHappierMessage).toHaveBeenCalledTimes(2);
  });

  it("recovers a tagged remote create after a lost response without creating or sending twice", async () => {
    const native = nativeBinding(null, "lost-create-response-binding");
    const remoteSessions: Record<string, unknown>[] = [];
    let firstCreate = true;
    cli.listHappierSessions.mockImplementation(async () => ({
      sessions: [...remoteSessions],
      nextCursor: null,
      hasNext: false,
    }));
    cli.createHappierSession.mockImplementation(async (input: {
      cwd: string;
      backend: string;
      tag: string;
    }) => {
      if (!firstCreate) throw new Error("duplicate create attempted");
      firstCreate = false;
      remoteSessions.push({
        id: "hp_lost_create_response",
        createdAt: 1,
        updatedAt: 1,
        active: true,
        archivedAt: null,
        tag: input.tag,
        path: input.cwd,
        agentId: input.backend,
      });
      historyFor("hp_lost_create_response");
      throw new HappierCliError("process", "simulated transport loss after remote create");
    });
    const firstRuntime = new HappierRuntimeAdapter({ backend: "codex" });
    const first = await firstRuntime.createSession(makeOptions(native.binding));

    await expect(firstRuntime.promptWithFallback(first.session, "first attempt")).rejects.toMatchObject({
      code: "process",
    });

    const restartedRuntime = new HappierRuntimeAdapter({ backend: "codex" });
    const restarted = await restartedRuntime.createSession(makeOptions(native.binding));
    await restartedRuntime.promptWithFallback(restarted.session, "restart recovery");

    expect(cli.createHappierSession).toHaveBeenCalledTimes(1);
    expect(cli.listHappierSessions).toHaveBeenCalledTimes(2);
    expect(native.claimNativeSessionId).toHaveBeenCalledOnce();
    expect(native.claimNativeSessionId).toHaveBeenCalledWith("hp_lost_create_response");
    expect(restarted.session.sessionId).toBe("hp_lost_create_response");
    expect(cli.sendHappierMessage).toHaveBeenCalledTimes(1);
    expect(cli.sendHappierMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "hp_lost_create_response",
        message: "restart recovery",
      }),
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect([...createIntents.records.values()]).toContainEqual(expect.objectContaining({
      state: "claimed",
      canonicalSessionId: "hp_lost_create_response",
    }));
  });

  it("archives the returned candidate and records cleanup when native-id claim fails", async () => {
    const native = nativeBinding(null, "claim-failure-binding");
    native.claimNativeSessionId.mockRejectedValueOnce(new Error("simulated claim crash"));
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(native.binding));

    await expect(runtime.promptWithFallback(result.session, "claim failure")).rejects.toMatchObject({
      name: "HappierRecoveryError",
      code: "native-session-persistence-failed",
      nativeSessionId: "hp_session_1",
    });
    expect(cli.archiveHappierSession).toHaveBeenCalledWith("hp_session_1", expect.anything());
    expect(cli.sendHappierMessage).not.toHaveBeenCalled();
    expect([...createIntents.records.values()]).toContainEqual(expect.objectContaining({
      state: "cleaned",
      candidateSessionIds: ["hp_session_1"],
      canonicalSessionId: null,
      cleanupSessionIds: [],
    }));
  });

  it("records cleanup_required and blocks when a claim failure leaves an unarchived orphan", async () => {
    const native = nativeBinding(null, "claim-cleanup-failure-binding");
    native.claimNativeSessionId.mockRejectedValueOnce(new Error("simulated claim crash"));
    cli.archiveHappierSession.mockRejectedValueOnce(new Error("simulated archive outage"));
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(native.binding));

    await expect(runtime.promptWithFallback(result.session, "claim cleanup failure")).rejects.toMatchObject({
      name: "HappierRecoveryError",
      code: "orphan-cleanup-failed",
      nativeSessionId: "hp_session_1",
    });
    expect((result.session as HappierAgentSession).state.status).toBe("blocked");
    expect([...createIntents.records.values()]).toContainEqual(expect.objectContaining({
      state: "cleanup_required",
      cleanupSessionIds: ["hp_session_1"],
    }));
  });

  it("selects one deterministic tagged candidate and archives every non-canonical duplicate", async () => {
    const native = nativeBinding(null, "duplicate-tag-binding");
    const identity = (await import("../create-intent-store.js")).buildHappierCreateIntentIdentity({
      bindingKey: native.binding.key,
      cwd: "G:\\fusion\\task",
      backend: "codex",
    });
    createIntents.records.set(identity.keyHash, {
      contractVersion: 1,
      ...identity,
      state: "pending_create",
      candidateSessionIds: [],
      canonicalSessionId: null,
      cleanupSessionIds: [],
      updatedAt: "2026-07-27T03:31:00.000Z",
    });
    cli.listHappierSessions.mockResolvedValueOnce({
      sessions: [
        {
          id: "hp_duplicate_newer",
          createdAt: 20,
          updatedAt: 20,
          active: true,
          archivedAt: null,
          tag: identity.tag,
          path: identity.cwd,
          agentId: "codex",
        },
        {
          id: "hp_duplicate_older",
          createdAt: 10,
          updatedAt: 10,
          active: true,
          archivedAt: null,
          tag: identity.tag,
          path: identity.cwd,
          agentId: "codex",
        },
      ],
      nextCursor: null,
      hasNext: false,
    });
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(native.binding));
    await runtime.promptWithFallback(result.session, "deduplicate candidates");

    expect(cli.createHappierSession).not.toHaveBeenCalled();
    expect(native.claimNativeSessionId).toHaveBeenCalledWith("hp_duplicate_older");
    expect(cli.archiveHappierSession).toHaveBeenCalledTimes(1);
    expect(cli.archiveHappierSession).toHaveBeenCalledWith("hp_duplicate_newer", expect.anything());
    expect(result.session.sessionId).toBe("hp_duplicate_older");
  });

  it("cancels after a create response without claiming and archives the known candidate", async () => {
    const native = nativeBinding(null, "create-response-cancel-binding");
    cli.createHappierSession.mockImplementationOnce((
      _input: unknown,
      _settings: unknown,
      signal?: AbortSignal,
    ) => new Promise((resolve) => {
      signal?.addEventListener("abort", () => {
        resolve({
          sessionId: "hp_cancelled_create",
          session: { id: "hp_cancelled_create" },
          created: true,
        });
      }, { once: true });
    }));
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(native.binding));
    const managed = result.session as typeof result.session & { abort?: () => Promise<void> };

    const prompt = runtime.promptWithFallback(result.session, "cancel after create response");
    await vi.waitFor(() => expect(cli.createHappierSession).toHaveBeenCalledOnce());
    await managed.abort!();
    await expect(prompt).rejects.toMatchObject({ code: "timeout" });

    expect(native.claimNativeSessionId).not.toHaveBeenCalled();
    expect(cli.archiveHappierSession).toHaveBeenCalledWith("hp_cancelled_create", expect.anything());
    expect([...createIntents.records.values()]).toContainEqual(expect.objectContaining({
      state: "cleaned",
      candidateSessionIds: ["hp_cancelled_create"],
    }));
  });

  it("reconciles a persisted native id before sending after restart", async () => {
    const native = nativeBinding("hp_session_1");
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(native.binding));

    await runtime.promptWithFallback(result.session, "after restart");

    expect(cli.createHappierSession).not.toHaveBeenCalled();
    expect(native.claimNativeSessionId).not.toHaveBeenCalled();
    expect(cli.getHappierSessionStatus).toHaveBeenCalledWith(
      "hp_session_1",
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(cli.sendHappierMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "hp_session_1", message: "after restart" }),
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(cli.getHappierSessionStatus.mock.invocationCallOrder[0]).toBeLessThan(
      cli.sendHappierMessage.mock.invocationCallOrder[0],
    );
  });

  /*
  FNXC:HappierRuntime 2026-07-15-21:14:
  A task-bound Direct Session is prebound before execution starts. Executor
  cancellation calls abort then dispose, so the adapter must abort the official
  CLI operation carrying that persisted ID without creating or substituting one.
  */
  it("cancels the first prebound prompt through the same native id without persisting an alternate id", async () => {
    const ensuredSessionId = "hp_prebound_direct_session";
    const native = nativeBinding(ensuredSessionId, "task-bound-direct-session");
    const lifecycle: string[] = [];
    let cancelledSessionId: string | undefined;
    native.refreshNativeSessionId.mockImplementationOnce(async () => {
      lifecycle.push(`refresh:${ensuredSessionId}`);
      return ensuredSessionId;
    });
    cli.getHappierSessionStatus.mockImplementationOnce(async (sessionId: string) => {
      lifecycle.push(`status:${sessionId}`);
      return resumableStatus(sessionId);
    });
    cli.sendHappierMessage.mockImplementationOnce((
      { sessionId }: { sessionId: string },
      _settings: unknown,
      signal?: AbortSignal,
    ) => new Promise<never>((_resolve, reject) => {
      lifecycle.push(`send:${sessionId}`);
      signal?.addEventListener("abort", () => {
        cancelledSessionId = sessionId;
        lifecycle.push(`cancel:${sessionId}`);
        reject(new HappierCliError("timeout", "Happier CLI invocation aborted"));
      }, { once: true });
    }));
    cli.stopHappierSession.mockImplementationOnce(async (sessionId: string) => {
      lifecycle.push(`stop:${sessionId}`);
      return { sessionId, stopped: true };
    });
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(native.binding));
    const sessionWithAbort = result.session as typeof result.session & { abort?: () => Promise<void> };

    const prompt = runtime.promptWithFallback(result.session, "first user-authorized prompt");
    await vi.waitFor(() => expect(cli.sendHappierMessage).toHaveBeenCalledOnce());

    expect(sessionWithAbort.abort).toBeTypeOf("function");
    await sessionWithAbort.abort!();
    result.session.dispose();
    await expect(prompt).rejects.toMatchObject({
      code: "timeout",
      message: "Happier CLI invocation aborted",
    });

    expect(lifecycle).toEqual([
      `refresh:${ensuredSessionId}`,
      `status:${ensuredSessionId}`,
      `send:${ensuredSessionId}`,
      `cancel:${ensuredSessionId}`,
      `stop:${ensuredSessionId}`,
    ]);
    expect(cancelledSessionId).toBe(ensuredSessionId);
    expect(cli.sendHappierMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: ensuredSessionId,
        message: "first user-authorized prompt",
      }),
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(cli.getHappierSessionHistory).toHaveBeenCalledTimes(1);
    const observedNativeIds = [
      ...cli.getHappierSessionStatus.mock.calls.map((call) => call[0]),
      ...cli.getHappierSessionHistory.mock.calls.map((call) => call[0]),
      ...cli.sendHappierMessage.mock.calls.map((call) => call[0].sessionId),
      ...cli.stopHappierSession.mock.calls.map((call) => call[0]),
      cancelledSessionId,
    ];
    expect(new Set(observedNativeIds)).toEqual(new Set([ensuredSessionId]));
    expect(cli.createHappierSession).not.toHaveBeenCalled();
    expect(native.claimNativeSessionId).not.toHaveBeenCalled();
    expect(native.persistNativeSessionId).not.toHaveBeenCalled();
    expect(cli.archiveHappierSession).not.toHaveBeenCalled();
  });

  it("keeps cancellation recovering and rejects when the official remote stop is unconfirmed", async () => {
    const ensuredSessionId = "hp_stop_unconfirmed";
    const native = nativeBinding(ensuredSessionId, "stop-unconfirmed-binding");
    cli.stopHappierSession.mockRejectedValueOnce(
      new HappierCliError(
        "protocol",
        "Happier session stop did not confirm stopped true",
        undefined,
        "stop_unconfirmed",
      ),
    );
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(native.binding));
    const managed = result.session as typeof result.session & { abort?: () => Promise<void> };

    await expect(managed.abort!()).rejects.toMatchObject({
      name: "HappierRecoveryError",
      code: "stop-unconfirmed",
      nativeSessionId: ensuredSessionId,
    });
    expect(result.session.state).toMatchObject({
      status: "recovering",
      errorMessage: "Happier did not confirm that the remote session stopped",
    });
    expect(cli.stopHappierSession).toHaveBeenCalledWith(ensuredSessionId, expect.anything());
  });

  it("durably records exact identity with recovering stop_unconfirmed after remote stop failure", async () => {
    const sessionId = "hp_stop_durable";
    const native = nativeBinding(sessionId, "durable-stop-owner");
    cli.stopHappierSession.mockRejectedValueOnce(
      new HappierCliError(
        "protocol",
        "Happier session stop did not confirm stopped true",
        undefined,
        "stop_unconfirmed",
      ),
    );
    const runtime = new HappierRuntimeAdapter({
      backend: "codex",
      happierSessionBindings: [{
        canonicalSessionUri: "codex://threads/019f5569-6e91-7eb2-9460-5c1ccc32a8a7",
        happierSessionId: sessionId,
        serverProfileId: "srv_local",
        machineId: "machine_windows_1",
      }],
    });
    const result = await runtime.createSession(makeOptions(native.binding));
    const managed = result.session as typeof result.session & { abort?: () => Promise<void> };

    await expect(managed.abort!()).rejects.toMatchObject({
      code: "stop-unconfirmed",
      nativeSessionId: sessionId,
    });

    expect([...stopStates.records.values()]).toContainEqual(expect.objectContaining({
      happierSessionId: sessionId,
      serverProfileId: "srv_local",
      machineId: "machine_windows_1",
      providerId: "codex",
      providerSessionId: "019f5569-6e91-7eb2-9460-5c1ccc32a8a7",
      canonicalSessionUri: "codex://threads/019f5569-6e91-7eb2-9460-5c1ccc32a8a7",
      state: "recovering",
      reasonCode: "stop_unconfirmed",
    }));
  });

  it("blocks restart send while the exact durable identity remains stop_unconfirmed", async () => {
    const sessionId = "hp_stop_restart_block";
    const native = nativeBinding(sessionId, "durable-stop-restart-owner");
    const settings = {
      backend: "codex" as const,
      happierSessionBindings: [{
        canonicalSessionUri: "codex://threads/019f5569-6e91-7eb2-9460-5c1ccc32a8a7",
        happierSessionId: sessionId,
        serverProfileId: "srv_local",
        machineId: "machine_windows_1",
      }],
    };
    cli.stopHappierSession.mockRejectedValueOnce(
      new HappierCliError(
        "protocol",
        "Happier session stop did not confirm stopped true",
        undefined,
        "stop_unconfirmed",
      ),
    );
    const firstRuntime = new HappierRuntimeAdapter(settings);
    const first = await firstRuntime.createSession(makeOptions(native.binding));
    const firstManaged = first.session as typeof first.session & { abort?: () => Promise<void> };
    await expect(firstManaged.abort!()).rejects.toMatchObject({ code: "stop-unconfirmed" });

    const restartedRuntime = new HappierRuntimeAdapter(settings);
    const restarted = await restartedRuntime.createSession(makeOptions(native.binding));

    await expect(
      restartedRuntime.promptWithFallback(restarted.session, "must remain fenced"),
    ).rejects.toMatchObject({
      name: "HappierRecoveryError",
      code: "stop-unconfirmed",
      nativeSessionId: sessionId,
    });
    expect(cli.createHappierSession).not.toHaveBeenCalled();
    expect(cli.sendHappierMessage).not.toHaveBeenCalled();
  });

  it("reuses and reconciles the id persisted by a previous runtime instance", async () => {
    const firstBinding = nativeBinding(null, "restart-binding");
    const firstRuntime = new HappierRuntimeAdapter({ backend: "codex" });
    const firstSession = await firstRuntime.createSession(makeOptions(firstBinding.binding));
    await firstRuntime.promptWithFallback(firstSession.session, "before restart");

    expect(firstBinding.binding.nativeSessionId).toBe("hp_session_1");
    const restartedRuntime = new HappierRuntimeAdapter({ backend: "codex" });
    const restartedBinding = nativeBinding(firstBinding.binding.nativeSessionId, "restart-binding");
    const restartedSession = await restartedRuntime.createSession(makeOptions(restartedBinding.binding));
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

  it("resumes an inactive exact Session when official status reports active false", async () => {
    cli.getHappierSessionStatus
      .mockResolvedValueOnce({
        sessionId: "hp_session_1",
        session: { id: "hp_session_1", active: false },
        agentState: { status: "idle" },
      })
      .mockImplementation(async (sessionId: string) => resumableStatus(sessionId));
    const settings = {
      backend: "codex" as const,
      connectTimeoutMs: 5_000,
      happierSessionBindings: [{
        canonicalSessionUri: "codex://threads/provider-thread-1",
        happierSessionId: "hp_session_1",
        serverProfileId: "server-1",
        machineId: "machine-1",
      }],
    };
    const runtime = new HappierRuntimeAdapter(settings);
    const result = await runtime.createSession(makeOptions(nativeBinding("hp_session_1").binding));

    await runtime.promptWithFallback(result.session, "resume explicitly");

    expect(cli.startHappierResumeProcess).toHaveBeenCalledOnce();
    expect(cli.startHappierResumeProcess).toHaveBeenCalledWith(
      "hp_session_1",
      expect.objectContaining(settings),
      expect.any(AbortSignal),
    );
    expect(cli.startHappierResumeProcess.mock.invocationCallOrder[0])
      .toBeLessThan(cli.sendHappierMessage.mock.invocationCallOrder[0]);
    expect(cli.createHappierSession).not.toHaveBeenCalled();
    expect(cli.sendHappierMessage).toHaveBeenCalledOnce();
  });

  it("stops the resume lease and never creates a replacement when exact binding identity drifts", async () => {
    const binding = {
      canonicalSessionUri: "codex://threads/provider-thread-1",
      happierSessionId: "hp_session_1",
      serverProfileId: "server-1",
      machineId: "machine-1",
    };
    let statusCalls = 0;
    cli.getHappierSessionStatus.mockImplementation(async (sessionId: string) => {
      statusCalls += 1;
      if (statusCalls === 1) {
        return {
          sessionId,
          session: { id: sessionId, active: false, resumable: true },
          agentState: { status: "idle", resumable: true },
        };
      }
      binding.machineId = "machine-drifted";
      return resumableStatus(sessionId);
    });
    const stopResume = vi.fn(async () => true);
    cli.startHappierResumeProcess.mockResolvedValue({
      sessionId: "hp_session_1",
      pid: 42,
      stop: stopResume,
    });
    const runtime = new HappierRuntimeAdapter({
      backend: "codex",
      connectTimeoutMs: 5_000,
      happierSessionBindings: [binding],
    });
    const result = await runtime.createSession(
      makeOptions(nativeBinding("hp_session_1", "resume-drift-binding").binding),
    );

    await expect(
      runtime.promptWithFallback(result.session, "must not replace"),
    ).rejects.toMatchObject({
      name: "HappierRecoveryError",
      code: "status-check-failed",
      nativeSessionId: "hp_session_1",
    });

    expect(stopResume).toHaveBeenCalledOnce();
    expect(cli.createHappierSession).not.toHaveBeenCalled();
    expect(cli.sendHappierMessage).not.toHaveBeenCalled();
  });

  it("never creates a replacement when official Happier resume fails", async () => {
    cli.getHappierSessionStatus.mockResolvedValueOnce({
      sessionId: "hp_session_1",
      session: { id: "hp_session_1", active: false },
      agentState: { status: "idle" },
    });
    cli.startHappierResumeProcess.mockRejectedValueOnce(
      new HappierCliError("process", "official resume failed"),
    );
    const runtime = new HappierRuntimeAdapter({
      backend: "codex",
      connectTimeoutMs: 5_000,
      happierSessionBindings: [{
        canonicalSessionUri: "codex://threads/provider-thread-1",
        happierSessionId: "hp_session_1",
        serverProfileId: "server-1",
        machineId: "machine-1",
      }],
    });
    const result = await runtime.createSession(
      makeOptions(nativeBinding("hp_session_1", "resume-failure-binding").binding),
    );

    await expect(
      runtime.promptWithFallback(result.session, "must not replace"),
    ).rejects.toMatchObject({
      name: "HappierRecoveryError",
      code: "status-check-failed",
      nativeSessionId: "hp_session_1",
    });
    expect(cli.createHappierSession).not.toHaveBeenCalled();
    expect(cli.sendHappierMessage).not.toHaveBeenCalled();
  });

  it("waits for the resumed Provider process tree before completing abort", async () => {
    cli.getHappierSessionStatus
      .mockResolvedValueOnce({
        sessionId: "hp_session_1",
        session: { id: "hp_session_1", active: false, resumable: true },
        agentState: { status: "idle", resumable: true },
      })
      .mockImplementation(async (sessionId: string) => resumableStatus(sessionId));
    let confirmProcessStop!: (confirmed: boolean) => void;
    const stopResume = vi.fn(() => new Promise<boolean>((resolveStop) => {
      confirmProcessStop = resolveStop;
    }));
    cli.startHappierResumeProcess.mockResolvedValue({
      sessionId: "hp_session_1",
      pid: 42,
      stop: stopResume,
    });
    const runtime = new HappierRuntimeAdapter({
      backend: "codex",
      connectTimeoutMs: 5_000,
      happierSessionBindings: [{
        canonicalSessionUri: "codex://threads/provider-thread-1",
        happierSessionId: "hp_session_1",
        serverProfileId: "server-1",
        machineId: "machine-1",
      }],
    });
    const result = await runtime.createSession(
      makeOptions(nativeBinding("hp_session_1", "resume-abort-binding").binding),
    );
    await runtime.promptWithFallback(result.session, "resume before abort");
    const managed = result.session as typeof result.session & { abort?: () => Promise<void> };

    let abortSettled = false;
    const abort = managed.abort!().then(() => {
      abortSettled = true;
    });
    await vi.waitFor(() => expect(stopResume).toHaveBeenCalledOnce());
    expect(abortSettled).toBe(false);
    expect(cli.stopHappierSession).not.toHaveBeenCalled();

    confirmProcessStop(true);
    await expect(abort).resolves.toBeUndefined();
    expect(cli.stopHappierSession).toHaveBeenCalledWith(
      "hp_session_1",
      expect.anything(),
    );
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

  it("serializes concurrent first prompts across adapter and session objects sharing one canonical key", async () => {
    let persisted: string | null = null;
    const makeSharedBinding = (): AgentRuntimeNativeSessionBinding => ({
      key: "shared-canonical-session",
      nativeSessionId: persisted,
      refreshNativeSessionId: async () => persisted,
      claimNativeSessionId: async (candidate) => {
        if (!persisted) {
          persisted = candidate;
          return { claimed: true, nativeSessionId: candidate };
        }
        return { claimed: false, nativeSessionId: persisted };
      },
      persistNativeSessionId: async () => undefined,
    });
    const firstRuntime = new HappierRuntimeAdapter({ backend: "codex" });
    const secondRuntime = new HappierRuntimeAdapter({ backend: "codex" });
    const first = await firstRuntime.createSession(makeOptions(makeSharedBinding()));
    const second = await secondRuntime.createSession(makeOptions(makeSharedBinding()));

    await Promise.all([
      firstRuntime.promptWithFallback(first.session, "shared first"),
      secondRuntime.promptWithFallback(second.session, "shared second"),
    ]);

    expect(cli.createHappierSession).toHaveBeenCalledTimes(1);
    expect(persisted).toBe("hp_session_1");
    expect(first.session.sessionId).toBe("hp_session_1");
    expect(second.session.sessionId).toBe("hp_session_1");
  });

  it("keeps the atomic claim winner and archives a cross-process loser", async () => {
    const binding = nativeBinding(null, "cas-loser");
    binding.claimNativeSessionId.mockResolvedValueOnce({ claimed: false, nativeSessionId: "hp_winner" });
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(binding.binding));

    await runtime.promptWithFallback(result.session, "use winner");

    expect(cli.archiveHappierSession).toHaveBeenCalledWith("hp_session_1", expect.anything());
    expect(result.session.sessionId).toBe("hp_winner");
    expect(cli.sendHappierMessage).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "hp_winner", message: "use winner" }),
      expect.anything(),
      expect.any(AbortSignal),
    );
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
      rawTextRow("old-assistant", 1_000, "assistant", "old output"),
    ]);
    const onText = vi.fn();
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(nativeBinding("hp_session_1").binding, { onText }));

    await runtime.promptWithFallback(result.session, "new prompt");

    expect(onText).toHaveBeenCalledWith("reply:new prompt");
    expect(onText).not.toHaveBeenCalledWith("old output");
    expect(onText.mock.calls.flat().join("\n")).toBe("reply:new prompt");
  });

  it("emits official Codex agent message rows as assistant output", async () => {
    cli.sendHappierMessage.mockImplementationOnce(async ({ sessionId, message, localId }: { sessionId: string; message: string; localId: string }) => {
      historyFor(sessionId).push(
        rawTextRow("codex-user", 2_000, "user", message, localId),
        rawCodexRow("codex-agent", 2_001, "codex provider text"),
      );
      return { sessionId, localId, waited: true };
    });
    const onText = vi.fn();
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(nativeBinding().binding, { onText }));

    await runtime.promptWithFallback(result.session, "official codex output");

    expect(onText).toHaveBeenCalledWith("codex provider text");
  });

  it("fails closed when Happier returns a provider process error as an agent message", async () => {
    cli.sendHappierMessage.mockImplementationOnce(async ({ sessionId, message, localId }: { sessionId: string; message: string; localId: string }) => {
      historyFor(sessionId).push(
        rawTextRow("failed-user", 2_000, "user", message, localId),
        rawEventMessageRow("failed-agent", 2_001, "Codex process error: thread/start timed out"),
      );
      return { sessionId, localId, waited: true };
    });
    const onText = vi.fn();
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(nativeBinding().binding, { onText }));

    await expect(runtime.promptWithFallback(result.session, "provider failure")).rejects.toMatchObject({
      name: "HappierRecoveryError",
      code: "provider-process-failed",
    });
    expect((result.session as HappierAgentSession).state.status).toBe("blocked");
    expect(onText).not.toHaveBeenCalled();
  });

  it("does not infer a process failure from provider-authored text outside an event row", async () => {
    cli.sendHappierMessage.mockImplementationOnce(async ({ sessionId, message, localId }: { sessionId: string; message: string; localId: string }) => {
      historyFor(sessionId).push(
        rawTextRow("quoted-error-user", 2_000, "user", message, localId),
        rawCodexRow("quoted-error-agent", 2_001, "Codex process error: this is quoted assistant text"),
      );
      return { sessionId, localId, waited: true };
    });
    const onText = vi.fn();
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(nativeBinding().binding, { onText }));

    await expect(runtime.promptWithFallback(result.session, "quote the error prefix")).resolves.toBeUndefined();
    expect(onText).toHaveBeenCalledWith("Codex process error: this is quoted assistant text");
  });

  it("fails closed on a provider process error while reconciling an ambiguous send", async () => {
    cli.sendHappierMessage.mockImplementationOnce(async ({ sessionId, message, localId }: { sessionId: string; message: string; localId: string }) => {
      historyFor(sessionId).push(
        rawTextRow("ambiguous-failed-user", 2_000, "user", message, localId),
        rawEventMessageRow("ambiguous-failed-agent", 2_001, "Codex process error: thread/start timed out"),
      );
      throw new HappierCliError("timeout", "send wait timed out");
    });
    const onText = vi.fn();
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(nativeBinding().binding, { onText }));

    await expect(runtime.promptWithFallback(result.session, "ambiguous provider failure")).rejects.toMatchObject({
      name: "HappierRecoveryError",
      code: "provider-process-failed",
    });
    expect((result.session as HappierAgentSession).state.status).toBe("blocked");
    expect(onText).not.toHaveBeenCalled();
  });

  it("accepts an ambiguous send only when bounded history positively proves acceptance", async () => {
    cli.sendHappierMessage.mockImplementationOnce(async ({ sessionId, message, localId }: { sessionId: string; message: string; localId: string }) => {
      historyFor(sessionId).push(
        rawTextRow("accepted-user", 2_000, "user", message, localId),
        rawTextRow("accepted-assistant", 2_001, "assistant", "accepted reply"),
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

  it("does not accept another surface's identical text without the exact local id", async () => {
    cli.sendHappierMessage.mockImplementationOnce(async ({ sessionId, message }: { sessionId: string; message: string }) => {
      historyFor(sessionId).push(
        rawTextRow("other-user", 2_000, "user", message, "other-surface-id"),
        rawTextRow("other-assistant", 2_001, "assistant", "other reply"),
      );
      throw new HappierCliError("timeout", "send timed out");
    });
    const onText = vi.fn();
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(nativeBinding().binding, { onText }));

    await expect(runtime.promptWithFallback(result.session, "same text")).rejects.toMatchObject({
      code: "ambiguous-send-unresolved",
    });
    expect(onText).not.toHaveBeenCalled();
    expect(cli.sendHappierMessage).toHaveBeenCalledTimes(1);
  });

  it("blocks a mismatched send response correlation id without retrying", async () => {
    cli.sendHappierMessage.mockRejectedValueOnce(new HappierCliError("protocol", "mismatched localId"));
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(nativeBinding().binding));

    await expect(runtime.promptWithFallback(result.session, "protocol mismatch")).rejects.toMatchObject({
      code: "history-reconciliation-failed",
    });
    expect((result.session as HappierAgentSession).state.status).toBe("blocked");
    expect(cli.sendHappierMessage).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the pre-send marker disappears from the bounded window", async () => {
    histories.set("hp_session_1", [
      rawTextRow("watermark-marker", 1_000, "assistant", "existing output"),
    ]);
    cli.sendHappierMessage.mockImplementationOnce(async ({ sessionId, message }: { sessionId: string; message: string }) => {
      histories.set(sessionId, [
        rawTextRow("new-user", 2_000, "user", message),
        rawTextRow("new-assistant", 2_001, "assistant", "must not emit"),
      ]);
      return { sessionId, localId: "new-user", waited: true };
    });
    const onText = vi.fn();
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(nativeBinding("hp_session_1").binding, { onText }));

    await expect(runtime.promptWithFallback(result.session, "window truncated")).rejects.toMatchObject({
      name: "HappierRecoveryError",
      code: "history-reconciliation-failed",
    });
    expect((result.session as HappierAgentSession).state.status).toBe("blocked");
    expect(onText).not.toHaveBeenCalled();
    expect(cli.sendHappierMessage).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the bounded window drops an older watermark row", async () => {
    histories.set("hp_session_1", [
      rawTextRow("watermark-oldest", 900, "assistant", "older output"),
      rawTextRow("watermark-latest", 1_000, "assistant", "latest output"),
    ]);
    cli.sendHappierMessage.mockImplementationOnce(async ({ sessionId, message }: { sessionId: string; message: string }) => {
      histories.set(sessionId, [
        rawTextRow("watermark-latest", 1_000, "assistant", "latest output"),
        rawTextRow("truncated-user", 2_000, "user", message),
        rawTextRow("truncated-assistant", 2_001, "assistant", "must not emit"),
      ]);
      return { sessionId, localId: "truncated-user", waited: true };
    });
    const onText = vi.fn();
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(nativeBinding("hp_session_1").binding, { onText }));

    await expect(runtime.promptWithFallback(result.session, "partial window truncation")).rejects.toMatchObject({
      name: "HappierRecoveryError",
      code: "history-reconciliation-failed",
    });
    expect((result.session as HappierAgentSession).state.status).toBe("blocked");
    expect(onText).not.toHaveBeenCalled();
  });

  it("blocks an ambiguous send when the bounded window lost the pre-send marker", async () => {
    histories.set("hp_session_1", [
      rawTextRow("ambiguous-marker", 1_000, "assistant", "existing output"),
    ]);
    cli.sendHappierMessage.mockImplementationOnce(async ({ sessionId, message }: { sessionId: string; message: string }) => {
      histories.set(sessionId, [
        rawTextRow("ambiguous-user", 2_000, "user", message),
        rawTextRow("ambiguous-assistant", 2_001, "assistant", "unprovable output"),
      ]);
      throw new HappierCliError("timeout", "send timed out");
    });
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(nativeBinding("hp_session_1").binding));

    await expect(runtime.promptWithFallback(result.session, "ambiguous truncated")).rejects.toMatchObject({
      name: "HappierRecoveryError",
      code: "ambiguous-send-unresolved",
    });
    expect((result.session as HappierAgentSession).state.status).toBe("blocked");
    expect(cli.sendHappierMessage).toHaveBeenCalledTimes(1);
  });

  it("blocks before send when native-id persistence fails", async () => {
    const native = nativeBinding();
    native.claimNativeSessionId.mockRejectedValue(new Error("database unavailable"));
    const runtime = new HappierRuntimeAdapter({ backend: "codex" });
    const result = await runtime.createSession(makeOptions(native.binding));

    await expect(runtime.promptWithFallback(result.session, "must persist first")).rejects.toBeInstanceOf(
      HappierRecoveryError,
    );
    expect((result.session as HappierAgentSession).state.status).toBe("blocked");
    expect(cli.sendHappierMessage).not.toHaveBeenCalled();
  });
});

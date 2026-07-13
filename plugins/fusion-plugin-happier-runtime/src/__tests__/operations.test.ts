import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeHappierJsonForKind } = vi.hoisted(() => ({ invokeHappierJsonForKind: vi.fn() }));

vi.mock("../cli-spawn.js", async () => {
  const actual = await vi.importActual<typeof import("../cli-spawn.js")>("../cli-spawn.js");
  return { ...actual, invokeHappierJsonForKind };
});

import {
  listHappierRuns,
  readHappierRun,
  startHappierDelegate,
  startHappierPlan,
  startHappierReview,
  withHappierOperationMetadata,
  waitForHappierRun,
} from "../operations.js";

describe("Happier multi-agent operations", () => {
  beforeEach(() => vi.clearAllMocks());

  it("constructs the official review start command and preserves partial failure", async () => {
    invokeHappierJsonForKind.mockResolvedValue({
      sessionId: "sess-1",
      results: [
        { key: "claude", ok: true, result: { runId: "run-1", callId: "call-1", sidechainId: "side-1" } },
        { key: "codex", ok: false, errorCode: "execution_run_busy", error: "busy" },
      ],
    });

    const result = await startHappierReview({
      sessionId: "sess-1",
      engines: ["claude", "codex"],
      instructions: "Review the change.\nCheck concurrency.",
    });

    expect(invokeHappierJsonForKind).toHaveBeenCalledWith(
      ["session", "review", "start", "sess-1", "--engines", "claude,codex", "--instructions", "Review the change.\nCheck concurrency.", "--json"],
      "session_review_start",
      undefined,
      undefined,
    );
    expect(result.status).toBe("partial_failure");
    expect(result.participants).toEqual([
      expect.objectContaining({ key: "claude", ok: true, status: "started", runId: "run-1" }),
      expect.objectContaining({ key: "codex", ok: false, status: "failed", errorCode: "execution_run_busy" }),
    ]);
    expect(withHappierOperationMetadata({ owner: "fusion-run-1" }, result)).toEqual({
      owner: "fusion-run-1",
      happierOperation: expect.objectContaining({
        version: 1,
        sessionId: "sess-1",
        operation: "review",
        status: "partial_failure",
        participants: [
          expect.objectContaining({ key: "claude", runId: "run-1", callId: "call-1", sidechainId: "side-1", status: "started" }),
          expect.objectContaining({ key: "codex", errorCode: "execution_run_busy", status: "failed" }),
        ],
      }),
    });
  });

  it("constructs official plan and delegate commands with normalized backend keys", async () => {
    invokeHappierJsonForKind
      .mockResolvedValueOnce({ sessionId: "sess-1", results: [{ key: "agent:claude", ok: true, result: { runId: "plan-1", callId: "c1", sidechainId: "s1" } }] })
      .mockResolvedValueOnce({ sessionId: "sess-1", results: [{ key: "acpBackend:opencode", ok: true, result: { runId: "delegate-1", callId: "c2", sidechainId: "s2" } }] });

    await startHappierPlan({ sessionId: "sess-1", backends: ["claude"], instructions: "Plan it." });
    await startHappierDelegate({ sessionId: "sess-1", backends: ["acpBackend:opencode"], instructions: "Build it." });

    expect(invokeHappierJsonForKind.mock.calls[0]?.[0]).toEqual([
      "session", "plan", "start", "sess-1", "--backends", "claude", "--instructions", "Plan it.", "--json",
    ]);
    expect(invokeHappierJsonForKind.mock.calls[1]?.[0]).toEqual([
      "session", "delegate", "start", "sess-1", "--backends", "acpBackend:opencode", "--instructions", "Build it.", "--json",
    ]);
  });

  it("constructs run get, list, and wait commands and validates returned state", async () => {
    const run = {
      runId: "run-1",
      callId: "call-1",
      sidechainId: "side-1",
      intent: "review",
      backendTarget: { kind: "builtInAgent", agentId: "claude" },
      status: "running",
    };
    invokeHappierJsonForKind
      .mockResolvedValueOnce({ sessionId: "sess-1", run, structuredMeta: { kind: "review_findings.v2", payload: {} } })
      .mockResolvedValueOnce({ sessionId: "sess-1", runs: [run] })
      .mockResolvedValueOnce({ sessionId: "sess-1", runId: "run-1", status: "succeeded" });

    expect((await readHappierRun("sess-1", "run-1", { includeStructured: true })).run.status).toBe("running");
    expect((await listHappierRuns("sess-1", { backend: "agent:claude", status: "running", limit: 5 })).runs).toHaveLength(1);
    expect((await waitForHappierRun("sess-1", "run-1", { timeoutSeconds: 42 })).status).toBe("succeeded");

    expect(invokeHappierJsonForKind.mock.calls[0]?.[0]).toEqual(["session", "run", "get", "sess-1", "run-1", "--include-structured", "--json"]);
    expect(invokeHappierJsonForKind.mock.calls[1]?.[0]).toEqual(["session", "run", "list", "sess-1", "--backend", "agent:claude", "--status", "running", "--limit", "5", "--json"]);
    expect(invokeHappierJsonForKind.mock.calls[2]?.[0]).toEqual(["session", "run", "wait", "sess-1", "run-1", "--timeout", "42", "--json"]);
  });

  it("rejects malformed participant ids before spawning the CLI", async () => {
    await expect(startHappierPlan({ sessionId: "sess-1", backends: ["claude,codex"], instructions: "Plan." })).rejects.toThrow(/participant/i);
    expect(invokeHappierJsonForKind).not.toHaveBeenCalled();
  });

  it("rejects missing, duplicate, or malformed participant results", async () => {
    invokeHappierJsonForKind
      .mockResolvedValueOnce({ sessionId: "sess-1", results: [] })
      .mockResolvedValueOnce({
        sessionId: "sess-1",
        results: [
          { key: "claude", ok: true, result: { runId: "run-1", callId: "call-1", sidechainId: "side-1" } },
          { key: "claude", ok: false, errorCode: "busy" },
        ],
      })
      .mockResolvedValueOnce({ sessionId: "sess-1", results: [{ key: "claude", ok: true, result: { runId: "run-1" } }] });

    await expect(startHappierReview({ sessionId: "sess-1", engines: ["claude"], instructions: "Review." })).rejects.toThrow(/result count/i);
    await expect(startHappierReview({ sessionId: "sess-1", engines: ["claude", "codex"], instructions: "Review." })).rejects.toThrow(/participant key/i);
    await expect(startHappierReview({ sessionId: "sess-1", engines: ["claude"], instructions: "Review." })).rejects.toThrow(/run metadata|callId/i);
  });

  it("rejects invalid run state instead of coercing it", async () => {
    invokeHappierJsonForKind.mockResolvedValue({
      sessionId: "sess-1",
      run: {
        runId: "run-1",
        callId: "call-1",
        sidechainId: "side-1",
        intent: "review",
        backendTarget: { kind: "builtInAgent", agentId: "claude" },
        status: "unknown",
      },
    });
    await expect(readHappierRun("sess-1", "run-1")).rejects.toThrow(/run status/i);
  });

  it("rejects mismatched session ids across start and run operations", async () => {
    const run = {
      runId: "run-1",
      callId: "call-1",
      sidechainId: "side-1",
      intent: "review",
      backendTarget: { kind: "builtInAgent", agentId: "claude" },
      status: "running",
    };
    invokeHappierJsonForKind
      .mockResolvedValueOnce({ sessionId: "sess-other", results: [{ key: "claude", ok: true, result: { runId: "run-1", callId: "call-1", sidechainId: "side-1" } }] })
      .mockResolvedValueOnce({ sessionId: "sess-other", run })
      .mockResolvedValueOnce({ sessionId: "sess-other", runs: [run] })
      .mockResolvedValueOnce({ sessionId: "sess-other", runId: "run-1", status: "succeeded" });

    await expect(startHappierReview({ sessionId: "sess-1", engines: ["claude"], instructions: "Review." })).rejects.toThrow(/session id/i);
    await expect(readHappierRun("sess-1", "run-1")).rejects.toThrow(/session id/i);
    await expect(listHappierRuns("sess-1")).rejects.toThrow(/session id/i);
    await expect(waitForHappierRun("sess-1", "run-1")).rejects.toThrow(/session id/i);
  });

  it("rejects mismatched run ids from get and wait", async () => {
    const run = {
      runId: "run-other",
      callId: "call-1",
      sidechainId: "side-1",
      intent: "review",
      backendTarget: { kind: "builtInAgent", agentId: "claude" },
      status: "running",
    };
    invokeHappierJsonForKind
      .mockResolvedValueOnce({ sessionId: "sess-1", run })
      .mockResolvedValueOnce({ sessionId: "sess-1", runId: "run-other", status: "succeeded" });

    await expect(readHappierRun("sess-1", "run-1")).rejects.toThrow(/run id/i);
    await expect(waitForHappierRun("sess-1", "run-1")).rejects.toThrow(/run id/i);
  });
});

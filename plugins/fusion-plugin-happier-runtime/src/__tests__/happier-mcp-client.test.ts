import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mockSpawn,
}));

import { openHappierMcpClient } from "../happier-mcp-client.js";

type RpcRequest = Readonly<{
  jsonrpc: string;
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}>;

type FakeMcpChild = Readonly<{
  child: ChildProcessWithoutNullStreams;
  requests: RpcRequest[];
  kill: ReturnType<typeof vi.fn>;
  respond(id: number, result: Record<string, unknown>): void;
}>;

/*
 * FNXC:HappierOfficialMcpBridge 2026-07-19-20:12:
 * This is an in-memory JSON-RPC peer. It proves stdio argv and tool frames
 * without starting Happier or touching an authenticated local session.
 */
function fakeMcpChild(options: Readonly<{
  deferToolNames?: readonly string[];
  emitSpawn?: boolean;
}> = {}): FakeMcpChild {
  const child = new EventEmitter();
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const requests: RpcRequest[] = [];
  const kill = vi.fn(() => {
    queueMicrotask(() => {
      Object.assign(child, { exitCode: 0 });
      child.emit("close", 0);
    });
    return true;
  });
  Object.assign(stdin, {
    write: vi.fn((payload: string, ...argumentsAfterPayload: unknown[]) => {
      const request = JSON.parse(payload) as RpcRequest;
      requests.push(request);
      const callback = argumentsAfterPayload.find(
        (argument): argument is (error?: Error | null) => void => typeof argument === "function",
      );
      if (typeof request.id === "number") {
        const requestedTool = request.method === "tools/call"
          ? String((request.params as { name?: unknown } | undefined)?.name ?? "")
          : "";
        if (options.deferToolNames?.includes(requestedTool)) {
          callback?.(undefined);
          return true;
        }
        const result = request.method === "tools/list"
          ? { tools: [{ name: "session_status_get" }] }
          : request.method === "tools/call"
            ? { structuredContent: { session: { id: "happier-session-1" } } }
            : {};
        queueMicrotask(() => stdout.emit("data", Buffer.from(`${JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result,
        })}\n`, "utf8")));
      }
      callback?.(undefined);
      return true;
    }),
    end: vi.fn(),
  });
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    kill,
  });
  if (options.emitSpawn !== false) queueMicrotask(() => child.emit("spawn"));
  return {
    child: child as unknown as ChildProcessWithoutNullStreams,
    requests,
    kill,
    respond: (id, result) => stdout.emit("data", Buffer.from(`${JSON.stringify({
      jsonrpc: "2.0",
      id,
      result,
    })}\n`, "utf8")),
  };
}

afterEach(() => {
  mockSpawn.mockReset();
});

describe("official Happier MCP stdio client", () => {
  it("uses a distinct spawn deadline before MCP connection negotiation", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeMcpChild({ emitSpawn: false });
      mockSpawn.mockReturnValue(fake.child);
      const observed = openHappierMcpClient({
        settings: {
          executable: "happier",
          spawnTimeoutMs: 1_000,
          connectTimeoutMs: 10_000,
          toolTimeoutMs: 20_000,
          maxOutputBytes: 8_192,
        },
        sessionId: "happier-session-1",
      });
      const rejection = expect(observed).rejects.toMatchObject({
        code: "timeout",
        officialCode: "cli_spawn_timeout",
      });

      await vi.advanceTimersByTimeAsync(1_000);

      await rejection;
      expect(fake.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses happier mcp serve and sends documented JSON-RPC tool frames", async () => {
    const fake = fakeMcpChild();
    mockSpawn.mockReturnValue(fake.child);

    const client = await openHappierMcpClient({
      settings: { executable: "happier", timeoutMs: 5_000, maxOutputBytes: 8_192 },
      sessionId: "happier-session-1",
    });
    await expect(client.listTools()).resolves.toEqual([{ name: "session_status_get" }]);
    await expect(client.callTool({
      name: "session_status_get",
      arguments: { sessionId: "happier-session-1" },
    })).resolves.toMatchObject({
      structuredContent: { session: { id: "happier-session-1" } },
    });
    await client.close();

    const [executable, args, spawnOptions] = mockSpawn.mock.calls[0]!;
    expect(executable).toBe("happier");
    expect(args.slice(-4)).toEqual(["mcp", "serve", "--session", "happier-session-1"]);
    expect(spawnOptions).toEqual(
      expect.objectContaining({ shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }),
    );
    expect(fake.requests).toEqual([
      expect.objectContaining({ method: "initialize" }),
      expect.objectContaining({ method: "notifications/initialized" }),
      expect.objectContaining({ method: "tools/list", params: {} }),
      expect.objectContaining({
        method: "tools/call",
        params: { name: "session_status_get", arguments: { sessionId: "happier-session-1" } },
      }),
    ]);
    expect(fake.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("keeps an MCP wait request alive through its inner timeout plus grace", async () => {
    /*
     * FNXC:HappierTimeoutHierarchy 2026-07-27-02:55:
     * MCP transport deadlines follow the same hierarchy as one-shot CLI waits;
     * the generic tool budget cannot preempt session_wait_idle.
     */
    vi.useFakeTimers();
    try {
      const fake = fakeMcpChild({ deferToolNames: ["session_wait_idle"] });
      mockSpawn.mockReturnValue(fake.child);
      const client = await openHappierMcpClient({
        settings: {
          executable: "happier",
          timeoutMs: 30_000,
          waitTimeoutGraceMs: 5_000,
          maxOutputBytes: 8_192,
        },
        sessionId: "happier-session-1",
      });
      let outcome:
        | Readonly<{ ok: true; value: unknown }>
        | Readonly<{ ok: false; error: unknown }>
        | undefined;
      const observed = client.callTool({
        name: "session_wait_idle",
        arguments: {
          sessionId: "happier-session-1",
          timeoutSeconds: 31,
        },
      }).then(
        (value) => {
          outcome = { ok: true, value };
          return outcome;
        },
        (error: unknown) => {
          outcome = { ok: false, error };
          return outcome;
        },
      );

      await vi.advanceTimersByTimeAsync(31_000);

      expect(outcome).toBeUndefined();
      const request = fake.requests.find((candidate) =>
        candidate.method === "tools/call"
        && candidate.params?.name === "session_wait_idle");
      expect(request?.id).toEqual(expect.any(Number));
      fake.respond(request!.id!, {
        structuredContent: {
          sessionId: "happier-session-1",
          idle: true,
          observedAt: "2026-07-27T02:55:00.000Z",
        },
      });
      await expect(observed).resolves.toMatchObject({ ok: true });
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

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
}>;

/*
 * FNXC:HappierOfficialMcpBridge 2026-07-19-20:12:
 * This is an in-memory JSON-RPC peer. It proves stdio argv and tool frames
 * without starting Happier or touching an authenticated local session.
 */
function fakeMcpChild(): FakeMcpChild {
  const child = new EventEmitter();
  const stdin = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const requests: RpcRequest[] = [];
  const kill = vi.fn(() => true);
  Object.assign(stdin, {
    write: vi.fn((payload: string, ...argumentsAfterPayload: unknown[]) => {
      const request = JSON.parse(payload) as RpcRequest;
      requests.push(request);
      const callback = argumentsAfterPayload.find(
        (argument): argument is (error?: Error | null) => void => typeof argument === "function",
      );
      if (typeof request.id === "number") {
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
  return { child: child as unknown as ChildProcessWithoutNullStreams, requests, kill };
}

afterEach(() => {
  mockSpawn.mockReset();
});

describe("official Happier MCP stdio client", () => {
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

    expect(mockSpawn).toHaveBeenCalledWith(
      "happier",
      ["mcp", "serve", "--session", "happier-session-1"],
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
});

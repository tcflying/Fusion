import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

import {
  buildHappierInvocation,
  createHappierSession,
  getHappierSessionHistory,
  getHappierSessionStatus,
  invokeHappierJson,
  parseHappierJson,
  resolveHappierCliSettings,
  sendHappierMessage,
} from "../cli-spawn.js";
import type { HappierCliSettings } from "../types.js";

function settings(overrides: Partial<HappierCliSettings> = {}): HappierCliSettings {
  return {
    executable: "happier",
    timeoutMs: 5000,
    maxOutputBytes: 4096,
    ...overrides,
  };
}

function fakeChild(): {
  child: ChildProcess;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  close: (code: number | null) => void;
  error: (value: NodeJS.ErrnoException) => void;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const kill = vi.fn();
  Object.assign(child, { stdout, stderr, kill });
  return {
    child,
    stdout: (value) => stdout.emit("data", Buffer.from(value)),
    stderr: (value) => stderr.emit("data", Buffer.from(value)),
    close: (code) => child.emit("close", code),
    error: (value) => child.emit("error", value),
    kill,
  };
}

afterEach(() => {
  mockSpawn.mockReset();
  vi.unstubAllEnvs();
});

describe("Happier CLI settings and invocation", () => {
  it("builds a source CLI invocation without shell interpolation", () => {
    expect(
      buildHappierInvocation(["session", "status", "abc", "--json"], {
        executable: "C:\\Program Files\\nodejs\\node.exe",
        entrypoint: "G:\\codex-project\\happier\\apps\\cli\\dist\\index.mjs",
        serverUrl: "http://127.0.0.1:52211",
        webappUrl: "http://127.0.0.1:8081",
      }),
    ).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "G:\\codex-project\\happier\\apps\\cli\\dist\\index.mjs",
        "--server-url",
        "http://127.0.0.1:52211",
        "--webapp-url",
        "http://127.0.0.1:8081",
        "session",
        "status",
        "abc",
        "--json",
      ],
    });
  });

  it("keeps direct executable mode and profile flags in argv", () => {
    expect(
      buildHappierInvocation(["auth", "status", "--json"], settings({ profile: "dev" })),
    ).toEqual({
      command: "happier",
      args: ["--profile", "dev", "auth", "status", "--json"],
    });
  });

  it("resolves non-secret settings from explicit values and environment fallbacks", () => {
    vi.stubEnv("HAPPIER_CLI_EXECUTABLE", "env-happier");
    vi.stubEnv("HAPPIER_SERVER_URL", "http://127.0.0.1:52211");

    expect(resolveHappierCliSettings({ timeoutMs: 1200 })).toMatchObject({
      executable: "env-happier",
      serverUrl: "http://127.0.0.1:52211",
      timeoutMs: 1200,
    });
  });
});

describe("Happier JSON parsing and invocation", () => {
  it("rejects non-JSON and redacts sensitive output", async () => {
    await expect(parseHappierJson('token=secret-value bearer abc123')).rejects.toMatchObject({
      code: "invalid-json",
    });
    await expect(parseHappierJson('token=secret-value bearer abc123')).rejects.not.toThrow("secret-value");
    await expect(parseHappierJson('token=secret-value bearer abc123')).rejects.not.toThrow("abc123");
  });

  it("maps a nonzero authentication process to a stable error code", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const promise = invokeHappierJson(["auth", "status", "--json"], settings());
    fake.stderr("authentication failed token=secret-value");
    fake.close(1);

    await expect(promise).rejects.toMatchObject({ code: "authentication" });
    await expect(promise).rejects.not.toThrow("secret-value");
  });

  it("times out and terminates a hanging process", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const promise = invokeHappierJson(["session", "status", "abc", "--json"], settings({ timeoutMs: 1 }));

    await expect(promise).rejects.toMatchObject({ code: "timeout" });
    expect(fake.kill).toHaveBeenCalled();
  });

  it("maps spawn failures and redacts bounded diagnostics", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const promise = invokeHappierJson(["session", "status", "abc", "--json"], settings());
    fake.error(Object.assign(new Error("backend key=secret-value unavailable"), { code: "ENOENT" }));

    await expect(promise).rejects.toMatchObject({ code: "process" });
    await expect(promise).rejects.not.toThrow("secret-value");
  });

  it("rejects a non-object JSON envelope", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const promise = invokeHappierJson(["session", "status", "abc", "--json"], settings());
    fake.stdout("[]");
    fake.close(0);

    await expect(promise).rejects.toMatchObject({ code: "invalid-json" });
  });
});

describe("Happier session wrappers", () => {
  it("constructs official session commands and validates the returned id", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const promise = createHappierSession(
      { cwd: "G:\\repo", backend: "codex", title: "Task 1" },
      settings(),
    );
    fake.stdout('{"sessionId":"hp_session_1"}');
    fake.close(0);

    await expect(promise).resolves.toMatchObject({ sessionId: "hp_session_1" });
    expect(mockSpawn).toHaveBeenCalledWith(
      "happier",
      ["session", "create", "--path", "G:\\repo", "--backend", "codex", "--title", "Task 1", "--json"],
      expect.objectContaining({ shell: false, stdio: ["ignore", "pipe", "pipe"] }),
    );
  });

  it("constructs send, status, and raw history commands", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);

    const sendPromise = sendHappierMessage(
      { sessionId: "hp_session_1", message: "hello", timeoutSeconds: 30 },
      settings(),
    );
    fake.stdout('{"status":"completed"}');
    fake.close(0);
    await expect(sendPromise).resolves.toMatchObject({ sessionId: "hp_session_1" });

    const statusPromise = getHappierSessionStatus("hp_session_1", settings());
    fake.stdout('{"status":"ready"}');
    fake.close(0);
    await expect(statusPromise).resolves.toMatchObject({ sessionId: "hp_session_1" });

    const historyPromise = getHappierSessionHistory("hp_session_1", 10, settings());
    fake.stdout('{"messages":[]}');
    fake.close(0);
    await expect(historyPromise).resolves.toMatchObject({ sessionId: "hp_session_1" });

    expect(mockSpawn.mock.calls.map((call) => call[1])).toEqual([
      ["session", "send", "hp_session_1", "hello", "--wait", "--timeout", "30", "--json"],
      ["session", "status", "hp_session_1", "--json"],
      ["session", "history", "hp_session_1", "--limit", "10", "--format", "raw", "--json"],
    ]);
  });
});

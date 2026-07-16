import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mockSpawn,
}));

import {
  archiveHappierSession,
  buildHappierSessionOpenUrl,
  buildHappierInvocation,
  createHappierSession,
  ensureHappierDirectSession,
  getHappierSessionHistory,
  getHappierSessionStatus,
  invokeHappierJson,
  parseHappierJson,
  resolveHappierCliSettings,
  sendHappierMessage,
} from "../cli-spawn.js";
import type { HappierCliSettings } from "../types.js";

const CREATE_SUCCESS =
  '{"v":1,"ok":true,"kind":"session_create","data":{"session":{"id":" sess_integration_create_123 ","tag":"MyTag","title":"My Title","active":true},"created":true}}';
const SEND_SUCCESS =
  '{"v":1,"ok":true,"kind":"session_send","data":{"sessionId":"sess_integration_send_123","localId":"local-1","waited":true}}';
const STATUS_SUCCESS =
  '{"v":1,"ok":true,"kind":"session_status","data":{"session":{"id":"sess_integration_status_123","active":true},"agentState":{"pendingRequestsCount":0,"controlledByUser":false}}}';
const HISTORY_SUCCESS =
  '{"v":1,"ok":true,"kind":"session_history","data":{"sessionId":"sess_integration_history_123","format":"raw","messages":[{"id":"message-1","localId":"local-1","createdAt":1,"role":"user","raw":{"content":{"type":"text","text":"hello"}}}]}}';
const AUTH_FAILURE =
  '{"v":1,"ok":false,"kind":"session_send","error":{"code":"not_authenticated","message":"accessToken=do-not-leak"}}';
const DIRECT_SESSION_SUCCESS =
  '{"v":1,"ok":true,"kind":"direct_session_ensure","data":{"providerId":"codex","remoteSessionId":"remote-1","machineId":"machine-1","serverId":"server-1","sessionId":"session-1","created":true,"openUrl":"https://app.happier.dev/session/session-1"}}';

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

beforeEach(() => {
  for (const key of [
    "HAPPIER_CLI_EXECUTABLE",
    "HAPPIER_CLI_ENTRYPOINT",
    "HAPPIER_HOME_DIR",
    "HAPPIER_ACTIVE_SERVER_ID",
    "HAPPIER_SERVER_URL",
    "HAPPIER_PUBLIC_SERVER_URL",
    "HAPPIER_WEBAPP_URL",
    "HAPPIER_PROFILE",
    "HAPPIER_CLI_TIMEOUT_MS",
    "HAPPIER_CLI_MAX_OUTPUT_BYTES",
  ]) {
    vi.stubEnv(key, "");
  }
});

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
        publicServerUrl: "http://localhost:52211",
        webappUrl: "http://127.0.0.1:8081",
      }),
    ).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [
        "G:\\codex-project\\happier\\apps\\cli\\dist\\index.mjs",
        "--server-url",
        "http://127.0.0.1:52211",
        "--public-server-url",
        "http://localhost:52211",
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

describe("Happier official JSON envelopes", () => {
  it("parses the official success envelope shape", async () => {
    await expect(parseHappierJson(CREATE_SUCCESS)).resolves.toEqual({
      v: 1,
      ok: true,
      kind: "session_create",
      data: {
        session: { id: " sess_integration_create_123 ", tag: "MyTag", title: "My Title", active: true },
        created: true,
      },
    });
  });

  it("rejects malformed JSON with bounded, recursively redacted diagnostics", async () => {
    const raw = '{"accessToken":"access-secret","nested":{"client_secret":"client-secret","private-key":"private-secret"';

    await expect(parseHappierJson(raw, 80)).rejects.toMatchObject({ code: "invalid-json" });
    await expect(parseHappierJson(raw, 80)).rejects.not.toThrow("access-secret");
    await expect(parseHappierJson(raw, 80)).rejects.not.toThrow("client-secret");
    await expect(parseHappierJson(raw, 80)).rejects.not.toThrow("private-secret");
    await expect(parseHappierJson(raw, 80)).rejects.toSatisfy((error: Error) => error.message.length < 240);
  });

  it("redacts textual secrets in parseable invalid-envelope diagnostics", async () => {
    const raw = '{"message":"Bearer live-token; accessToken=live-access; keep this context"}';

    await expect(parseHappierJson(raw)).rejects.toMatchObject({ code: "invalid-json" });
    await expect(parseHappierJson(raw)).rejects.not.toThrow("live-token");
    await expect(parseHappierJson(raw)).rejects.not.toThrow("live-access");
    await expect(parseHappierJson(raw)).rejects.toThrow("Bearer [REDACTED]");
    await expect(parseHappierJson(raw)).rejects.toThrow("accessToken=[REDACTED]");
    await expect(parseHappierJson(raw)).rejects.toThrow("keep this context");
  });

  it("maps the official error code before considering any message text", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const promise = invokeHappierJson(["session", "send", "abc", "hello", "--json"], settings());
    fake.stdout(AUTH_FAILURE);
    fake.close(1);

    await expect(promise).rejects.toMatchObject({ code: "authentication", officialCode: "not_authenticated" });
    await expect(promise).rejects.not.toThrow("do-not-leak");
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});

describe("Happier JSON process boundary", () => {
  it("passes the selected Happier stack identity to the child without dropping inherited env", async () => {
    vi.stubEnv("FUSION_HAPPIER_TEST_MARKER", "preserved");
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const stackSettings = settings({
      executable: "happier",
      serverUrl: "http://127.0.0.1:52211",
      webappUrl: "http://stack.localhost:52211",
      homeDir: "C:\\Users\\datoo\\.happier\\stacks\\fusion\\cli",
      activeServerId: "stack_fusion__id_default",
      publicServerUrl: "http://localhost:52211",
    } as Partial<HappierCliSettings> & {
      homeDir: string;
      activeServerId: string;
      publicServerUrl: string;
    });

    const promise = invokeHappierJson(["auth", "status", "--json"], stackSettings);
    fake.stdout('{"v":1,"ok":true,"kind":"auth_status","data":{"authenticated":false}}');
    fake.close(0);

    await expect(promise).resolves.toEqual({ authenticated: false });
    expect(mockSpawn).toHaveBeenCalledWith(
      "happier",
      [
        "--server-url",
        "http://127.0.0.1:52211",
        "--public-server-url",
        "http://localhost:52211",
        "--webapp-url",
        "http://stack.localhost:52211",
        "auth",
        "status",
        "--json",
      ],
      expect.objectContaining({
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: expect.objectContaining({
          FUSION_HAPPIER_TEST_MARKER: "preserved",
          HAPPIER_HOME_DIR: "C:\\Users\\datoo\\.happier\\stacks\\fusion\\cli",
          HAPPIER_ACTIVE_SERVER_ID: "stack_fusion__id_default",
          HAPPIER_SERVER_URL: "http://127.0.0.1:52211",
          HAPPIER_PUBLIC_SERVER_URL: "http://localhost:52211",
          HAPPIER_WEBAPP_URL: "http://stack.localhost:52211",
        }),
      }),
    );
  });

  it("returns data from an official success envelope", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const promise = invokeHappierJson(["session", "status", "abc", "--json"], settings());
    fake.stdout(STATUS_SUCCESS);
    fake.close(0);

    await expect(promise).resolves.toEqual({
      session: { id: "sess_integration_status_123", active: true },
      agentState: { pendingRequestsCount: 0, controlledByUser: false },
    });
  });

  it("times out and terminates a hanging process", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const promise = invokeHappierJson(["session", "status", "abc", "--json"], settings({ timeoutMs: 1 }));

    await expect(promise).rejects.toMatchObject({ code: "timeout" });
    expect(fake.kill).toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("terminates when stdout exceeds the hard output cap", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const promise = invokeHappierJson(["session", "status", "abc", "--json"], settings({ maxOutputBytes: 8 }));
    fake.stdout("123456789");

    await expect(promise).rejects.toMatchObject({ code: "output-limit" });
    expect(fake.kill).toHaveBeenCalled();
  });

  it("terminates when stderr exceeds the hard output cap", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const promise = invokeHappierJson(["session", "status", "abc", "--json"], settings({ maxOutputBytes: 8 }));
    fake.stderr("123456789");

    await expect(promise).rejects.toMatchObject({ code: "output-limit" });
    expect(fake.kill).toHaveBeenCalled();
  });

  it("terminates and rejects when the caller aborts", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const controller = new AbortController();
    const promise = invokeHappierJson(["session", "status", "abc", "--json"], settings(), controller.signal);
    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: "timeout" });
    expect(fake.kill).toHaveBeenCalledWith("SIGTERM");
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("maps nonzero process failures using textual fallback and redacts diagnostics", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const promise = invokeHappierJson(["session", "status", "abc", "--json"], settings());
    fake.stderr("authentication failed accessToken=secret-value");
    fake.close(1);

    await expect(promise).rejects.toMatchObject({ code: "authentication" });
    await expect(promise).rejects.not.toThrow("secret-value");
  });

  it("maps spawn failures to process errors", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const promise = invokeHappierJson(["session", "status", "abc", "--json"], settings());
    fake.error(Object.assign(new Error("spawn unavailable"), { code: "ENOENT" }));

    await expect(promise).rejects.toMatchObject({ code: "process" });
  });
});

describe("Happier session wrappers", () => {
  it.each([
    ["U+0000", "\u0000"],
    ["U+001F", "\u001f"],
    ["U+007F", "\u007f"],
  ])("rejects %s in session ids before spawning the CLI", async (_label, controlCharacter) => {
    await expect(archiveHappierSession(`sess-${controlCharacter}-1`, settings())).rejects.toMatchObject({
      code: "session",
    });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("ensures a direct session with exact shell-free argv and stack settings", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const uri = "happier://direct/session?provider=codex&name=$(whoami)";
    const machineId = "machine id; echo pwned";
    const promise = ensureHappierDirectSession({
      uri,
      machineId,
      settings: settings({
        executable: "C:\\Program Files\\Happier\\happier.exe",
        serverUrl: "https://server.example/path with spaces",
        profile: "profile & safe",
        homeDir: "C:\\Happier Home\\stack;safe",
      }),
    });
    fake.stdout(DIRECT_SESSION_SUCCESS);
    fake.close(0);

    await expect(promise).resolves.toEqual({
      providerId: "codex",
      remoteSessionId: "remote-1",
      machineId: "machine-1",
      serverId: "server-1",
      sessionId: "session-1",
      created: true,
      openUrl: "https://app.happier.dev/session/session-1",
    });
    expect(mockSpawn).toHaveBeenCalledWith(
      "C:\\Program Files\\Happier\\happier.exe",
      [
        "--server-url",
        "https://server.example/path with spaces",
        "--profile",
        "profile & safe",
        "direct-session",
        "ensure",
        "--uri",
        uri,
        "--machine-id",
        machineId,
        "--json",
      ],
      expect.objectContaining({
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: expect.objectContaining({ HAPPIER_HOME_DIR: "C:\\Happier Home\\stack;safe" }),
      }),
    );
  });

  it("omits machine-id when ensuring a direct session without one", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const promise = ensureHappierDirectSession({ uri: "happier://direct/codex/remote-1", settings: settings() });
    fake.stdout(DIRECT_SESSION_SUCCESS);
    fake.close(0);

    await expect(promise).resolves.toMatchObject({ sessionId: "session-1" });
    expect(mockSpawn.mock.calls[0]?.[1]).toEqual([
      "direct-session",
      "ensure",
      "--uri",
      "happier://direct/codex/remote-1",
      "--json",
    ]);
  });

  it.each([
    ["malformed envelope", "not-json", 0, "invalid-json"],
    [
      "wrong envelope kind",
      '{"v":1,"ok":true,"kind":"session_create","data":{"providerId":"codex","remoteSessionId":"remote-1","machineId":"machine-1","serverId":"server-1","sessionId":"session-1","created":true,"openUrl":"https://app/session-1"}}',
      0,
      "invalid-json",
    ],
    ["non-zero exit", "not-json", 17, "process"],
  ])("preserves typed errors for %s", async (_name, stdout, exitCode, expectedCode) => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const promise = ensureHappierDirectSession({ uri: "happier://direct/codex/remote-1", settings: settings() });
    fake.stdout(stdout);
    fake.close(exitCode);

    await expect(promise).rejects.toMatchObject({ code: expectedCode });
  });

  it.each(["providerId", "remoteSessionId", "sessionId"] as const)(
    "rejects a successful direct-session envelope with empty %s",
    async (field) => {
      const fake = fakeChild();
      mockSpawn.mockReturnValue(fake.child);
      const data = {
        providerId: "codex",
        remoteSessionId: "remote-1",
        machineId: "machine-1",
        serverId: "server-1",
        sessionId: "session-1",
        created: true,
        openUrl: "https://app/session-1",
        [field]: "   ",
      };
      const promise = ensureHappierDirectSession({ uri: "happier://direct/codex/remote-1", settings: settings() });
      fake.stdout(JSON.stringify({ v: 1, ok: true, kind: "direct_session_ensure", data }));
      fake.close(0);

      await expect(promise).rejects.toMatchObject({ code: "session" });
    },
  );

  it("normalizes the webapp trailing slash and encodes session-open ids", () => {
    expect(buildHappierSessionOpenUrl("https://app.happier.dev/", "server/id", "session id?#")).toBe(
      "https://app.happier.dev/session/server%2Fid/session%20id%3F%23",
    );
  });

  it("retries a bounded synchronous Windows spawn file lock", async () => {
    const recovered = fakeChild();
    mockSpawn
      .mockImplementationOnce(() => { throw Object.assign(new Error("spawn EBUSY: resource busy or locked"), { code: "EBUSY" }); })
      .mockReturnValueOnce(recovered.child);

    const promise = createHappierSession({ cwd: "G:\\repo", backend: "codex", title: "Task 1" }, settings());
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    expect(mockSpawn).toHaveBeenCalledTimes(2);
    recovered.stdout(CREATE_SUCCESS);
    recovered.close(0);

    await expect(promise).resolves.toMatchObject({ sessionId: "sess_integration_create_123" });
  });

  it("never retries a post-spawn EBUSY because the command may already have side effects", async () => {
    const child = fakeChild();
    mockSpawn.mockReturnValue(child.child);
    const promise = createHappierSession({ cwd: "G:\\repo", backend: "codex", title: "Task 1" }, settings());
    child.stderr("Error: EBUSY: resource busy or locked, open 'runtime-module.js'");
    child.close(1);

    await expect(promise).rejects.toMatchObject({ code: "process" });
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it("constructs the official create command and trims data.session.id", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const promise = createHappierSession({ cwd: "G:\\repo", backend: "codex", title: "Task 1" }, settings());
    fake.stdout(CREATE_SUCCESS);
    fake.close(0);

    await expect(promise).resolves.toMatchObject({ sessionId: "sess_integration_create_123", created: true });
    expect(mockSpawn).toHaveBeenCalledWith(
      "happier",
      ["session", "create", "--path", "G:\\repo", "--backend", "codex", "--title", "Task 1", "--json"],
      expect.objectContaining({ shell: false, stdio: ["ignore", "pipe", "pipe"] }),
    );
  });

  it("constructs exact send, status, and raw history commands from official data", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);

    const sendPromise = sendHappierMessage(
      { sessionId: " sess_integration_send_123 ", message: "hello", localId: "local-1", timeoutSeconds: 30 },
      settings(),
    );
    fake.stdout(SEND_SUCCESS);
    fake.close(0);
    await expect(sendPromise).resolves.toMatchObject({ sessionId: "sess_integration_send_123", localId: "local-1", waited: true });

    const statusPromise = getHappierSessionStatus(" sess_integration_status_123 ", settings());
    fake.stdout(STATUS_SUCCESS);
    fake.close(0);
    await expect(statusPromise).resolves.toMatchObject({ sessionId: "sess_integration_status_123", session: expect.any(Object) });

    const historyPromise = getHappierSessionHistory("sess_integration_history_123", 10, settings());
    fake.stdout(HISTORY_SUCCESS);
    fake.close(0);
    await expect(historyPromise).resolves.toMatchObject({ sessionId: "sess_integration_history_123", messages: expect.any(Array) });

    expect(mockSpawn.mock.calls.map((call) => call[1])).toEqual([
      ["session", "send", "sess_integration_send_123", "hello", "--local-id", "local-1", "--wait", "--timeout", "30", "--json"],
      ["session", "status", "sess_integration_status_123", "--json"],
      ["session", "history", "sess_integration_history_123", "--limit", "10", "--format", "raw", "--json"],
    ]);
  });

  it("rejects invalid official session data instead of inventing an id", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const promise = createHappierSession({ cwd: "G:\\repo", backend: "codex", title: "Task 1" }, settings());
    fake.stdout('{"v":1,"ok":true,"kind":"session_create","data":{"created":true}}');
    fake.close(0);

    await expect(promise).rejects.toMatchObject({ code: "session" });
  });

  it("rejects a send response whose local id does not match the requested idempotency key", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const promise = sendHappierMessage(
      { sessionId: "sess_integration_send_123", message: "hello", localId: "expected-local", timeoutSeconds: 30 },
      settings(),
    );
    fake.stdout(SEND_SUCCESS);
    fake.close(0);

    await expect(promise).rejects.toMatchObject({ code: "protocol" });
  });

  it("constructs the official archive command used to clean up a lost native-session claim", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const promise = archiveHappierSession("sess_orphan", settings());
    fake.stdout('{"v":1,"ok":true,"kind":"session_archive","data":{"sessionId":"sess_orphan","archivedAt":1}}');
    fake.close(0);

    await expect(promise).resolves.toBeUndefined();
    expect(mockSpawn).toHaveBeenLastCalledWith(
      "happier",
      ["session", "archive", "sess_orphan", "--json"],
      expect.objectContaining({ shell: false, stdio: ["ignore", "pipe", "pipe"] }),
    );
  });
});

describe("package entrypoint", () => {
  it("exports the Task 1 contract from src/index.ts", async () => {
    const entry = await import("../index.js");
    expect(entry.createHappierSession).toBeTypeOf("function");
    expect(entry.ensureHappierDirectSession).toBeTypeOf("function");
    expect(entry.invokeHappierJson).toBeTypeOf("function");
  }, 15_000);
});

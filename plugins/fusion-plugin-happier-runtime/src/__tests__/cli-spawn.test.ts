import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

const { mockSpawn, mockExecFile } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockExecFile: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mockSpawn,
  execFile: mockExecFile,
}));

import {
  archiveHappierSession,
  buildHappierSessionOpenUrl,
  buildHappierInvocation,
  createHappierSession,
  ensureHappierDirectSession,
  buildHappierProcessEnv,
  followHappierDirectSessionTranscriptEvents,
  getHappierDirectSessionCapabilities,
  getHappierSessionHistory,
  getHappierSessionStatus,
  invokeHappierJson,
  parseHappierJson,
  readHappierDirectSessionTranscript,
  resolveHappierCliSettings,
  sendHappierMessage,
} from "../cli-spawn.js";
import {
  HAPPIER_DIRECT_SESSION_CAPABILITY_FINGERPRINT,
  HAPPIER_DIRECT_SESSION_RUNTIME_MANIFEST,
} from "../happier-direct-session-capabilities.js";
import type { HappierCliSettings } from "../types.js";
import * as packageEntrypoint from "../index.js";

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
const DIRECT_TRANSCRIPT_SUCCESS =
  '{"v":1,"ok":true,"kind":"direct_session_transcript_read_after","data":{"machineId":"machine-1","providerId":"codex","remoteSessionId":"remote-1","sessionId":"session-1","source":{"kind":"codexHome","home":"user"},"fromCursor":null,"nextCursor":"cursor-2","truncated":false,"items":[{"id":"message-1","localId":"local-1","createdAtMs":1752729000000,"raw":{"role":"user","text":"hello"}}]}}';
const DIRECT_TRANSCRIPT_EVENT =
  '{"v":1,"ok":true,"kind":"direct_session_transcript_delta","data":{"machineId":"machine-1","providerId":"codex","remoteSessionId":"remote-1","sessionId":"session-1","source":{"kind":"codexHome","home":"user"},"fromCursor":"cursor-2","nextCursor":"cursor-3","truncated":false,"items":[{"id":"message-2","createdAtMs":1752729001000,"raw":{"role":"assistant","text":"world"}}]}}';
const DIRECT_STATUS_EVENT =
  '{"v":1,"ok":true,"kind":"direct_session_status_delta","data":{"eventType":"status","machineId":"machine-1","providerId":"codex","remoteSessionId":"remote-1","sessionId":"session-1","source":{"kind":"codexHome","home":"user"},"isRunning":true,"lastActivityAtMs":1752729001000,"observedAtMs":1752729001500}}';

/*
FNXC:HappierOfficialMcpBridge 2026-07-19-19:29:
The direct-session argv probe is only a legacy local-extension fixture. It is
not treated as official Happier capability evidence or as production routing.
*/
const LOCAL_HAPPIER_DIRECT_SESSION_CAPABILITY_MANIFEST_FIXTURE = HAPPIER_DIRECT_SESSION_RUNTIME_MANIFEST;
const LOCAL_HAPPIER_DIRECT_SESSION_CAPABILITY_FINGERPRINT_FIXTURE = HAPPIER_DIRECT_SESSION_CAPABILITY_FINGERPRINT;
const DIRECT_CAPABILITIES_SUCCESS = JSON.stringify({
  v: 1,
  ok: true,
  kind: "direct_session_capabilities",
  data: {
    ...LOCAL_HAPPIER_DIRECT_SESSION_CAPABILITY_MANIFEST_FIXTURE,
    fingerprint: LOCAL_HAPPIER_DIRECT_SESSION_CAPABILITY_FINGERPRINT_FIXTURE,
    cliVersion: "0.2.10",
  },
});

function settings(overrides: Partial<HappierCliSettings> = {}): HappierCliSettings {
  return {
    executable: "happier",
    timeoutMs: 5000,
    maxOutputBytes: 4096,
    ...overrides,
  };
}

function fakeChild(pid?: number): {
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
  const kill = vi.fn(() => true);
  Object.assign(child, { stdout, stderr, kill, pid });
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
  mockExecFile.mockReset();
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

  it("passes local extension opt-ins explicitly and clears inherited enablement otherwise", () => {
    expect(buildHappierProcessEnv({
      enableLocalRuntimeSnapshot: true,
      enableLocalReconciliationHistory: true,
    }, {})).toMatchObject({
      HAPPIER_ENABLE_FUSION_RUNTIME_SNAPSHOT_V1: "1",
      HAPPIER_ENABLE_FUSION_RECONCILIATION_HISTORY_V1: "1",
    });
    expect(buildHappierProcessEnv({
      enableLocalRuntimeSnapshot: false,
      enableLocalReconciliationHistory: false,
    }, {
      HAPPIER_ENABLE_FUSION_RUNTIME_SNAPSHOT_V1: "1",
      HAPPIER_ENABLE_FUSION_RECONCILIATION_HISTORY_V1: "1",
    })).toMatchObject({
      HAPPIER_ENABLE_FUSION_RUNTIME_SNAPSHOT_V1: "0",
      HAPPIER_ENABLE_FUSION_RECONCILIATION_HISTORY_V1: "0",
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
    const raw = '{"accessToken":"access-secret","nested":{"client_secret":"client-secret","private-key":"private-secret","text":"private-plaintext"';

    await expect(parseHappierJson(raw, 80)).rejects.toMatchObject({ code: "invalid-json" });
    await expect(parseHappierJson(raw, 80)).rejects.not.toThrow("access-secret");
    await expect(parseHappierJson(raw, 80)).rejects.not.toThrow("client-secret");
    await expect(parseHappierJson(raw, 80)).rejects.not.toThrow("private-secret");
    await expect(parseHappierJson(raw, 80)).rejects.not.toThrow("private-plaintext");
    await expect(parseHappierJson(raw, 80)).rejects.toSatisfy((error: Error) => error.message.length < 240);
  });

  it("redacts textual secrets in parseable invalid-envelope diagnostics", async () => {
    const raw = '{"message":"Bearer live-token; accessToken=live-access; keep this context"}';

    await expect(parseHappierJson(raw)).rejects.toMatchObject({ code: "invalid-json" });
    await expect(parseHappierJson(raw)).rejects.not.toThrow("live-token");
    await expect(parseHappierJson(raw)).rejects.not.toThrow("live-access");
    await expect(parseHappierJson(raw)).rejects.not.toThrow("keep this context");
    await expect(parseHappierJson(raw)).rejects.toThrow("invalid JSON envelope");
  });

  it("never echoes an untrusted one-shot envelope kind", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const promise = invokeHappierJson(
      ["session", "status", "session-1", "--json"],
      settings(),
      undefined,
      "session_status",
    );
    fake.stdout('{"v":1,"ok":true,"kind":"private-transcript-plaintext","data":{}}');
    fake.close(0);

    await expect(promise).rejects.toMatchObject({ code: "invalid-json" });
    await expect(promise).rejects.not.toThrow("private-transcript-plaintext");
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
  it("keeps the local-extension manifest probe isolated with exact shell-free argv", async () => {
    expect(LOCAL_HAPPIER_DIRECT_SESSION_CAPABILITY_MANIFEST_FIXTURE)
      .toEqual(HAPPIER_DIRECT_SESSION_RUNTIME_MANIFEST);
    expect(LOCAL_HAPPIER_DIRECT_SESSION_CAPABILITY_FINGERPRINT_FIXTURE)
      .toBe(HAPPIER_DIRECT_SESSION_CAPABILITY_FINGERPRINT);

    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const promise = getHappierDirectSessionCapabilities(settings());
    fake.stdout(DIRECT_CAPABILITIES_SUCCESS);
    fake.close(0);

    await expect(promise).resolves.toEqual({
      ...LOCAL_HAPPIER_DIRECT_SESSION_CAPABILITY_MANIFEST_FIXTURE,
      fingerprint: LOCAL_HAPPIER_DIRECT_SESSION_CAPABILITY_FINGERPRINT_FIXTURE,
      cliVersion: "0.2.10",
    });
    expect(mockSpawn).toHaveBeenCalledWith(
      "happier",
      ["direct-session", "capabilities", "--json"],
      expect.objectContaining({ shell: false, stdio: ["ignore", "pipe", "pipe"] }),
    );
  });

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

  it("retains the direct-session argv only as an explicit local-extension call", async () => {
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
    ["codex", "codex://threads/codex-native-1"],
    ["claude", "claude://sessions/claude-native-1"],
    ["opencode", "opencode://sessions/opencode-native-1"],
  ] as const)("preserves the %s canonical URI and returned native identity", async (providerId, uri) => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const nativeSessionId = `${providerId}-native-1`;
    const promise = ensureHappierDirectSession({ uri, settings: settings() });
    fake.stdout(JSON.stringify({
      v: 1,
      ok: true,
      kind: "direct_session_ensure",
      data: {
        providerId,
        remoteSessionId: nativeSessionId,
        machineId: "machine-1",
        serverId: "server-1",
        sessionId: `happier-${providerId}-1`,
        created: false,
        openUrl: `https://app.happier.dev/session/happier-${providerId}-1`,
      },
    }));
    fake.close(0);

    await expect(promise).resolves.toMatchObject({ providerId, remoteSessionId: nativeSessionId });
    expect(mockSpawn.mock.calls[0]?.[1]).toEqual([
      "direct-session", "ensure", "--uri", uri, "--json",
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

  it("reads a legacy local Direct Session transcript from a nullable startup cursor", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const promise = readHappierDirectSessionTranscript({
      providerId: "codex",
      remoteSessionId: "remote-1",
      sessionId: "session-1",
      machineId: "machine-1",
      afterCursor: null,
      limit: 25,
    }, settings());

    fake.stdout(DIRECT_TRANSCRIPT_SUCCESS);
    fake.close(0);

    await expect(promise).resolves.toMatchObject({
      fromCursor: null,
      nextCursor: "cursor-2",
      truncated: false,
      items: [{ id: "message-1", localId: "local-1" }],
    });
    expect(mockSpawn).toHaveBeenCalledWith(
      "happier",
      [
        "direct-session", "read-after",
        "--provider", "codex",
        "--remote-session-id", "remote-1",
        "--session-id", "session-1",
        "--machine-id", "machine-1",
        "--source-json", JSON.stringify({ kind: "codexHome", home: "user" }),
        "--after-cursor", "null",
        "--limit", "25",
        "--json",
      ],
      expect.objectContaining({ shell: false, stdio: ["ignore", "pipe", "pipe"] }),
    );
  });

  it.each([
    ["claude", { kind: "claudeConfig" }],
    ["opencode", { kind: "opencodeServer" }],
  ] as const)("binds %s transcript reads to its provider-specific default source", async (providerId, source) => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const promise = readHappierDirectSessionTranscript({
      providerId,
      remoteSessionId: `${providerId}-native-1`,
      sessionId: `happier-${providerId}-1`,
      machineId: "machine-1",
      afterCursor: null,
      limit: 25,
    }, settings());
    fake.stdout(JSON.stringify({
      v: 1,
      ok: true,
      kind: "direct_session_transcript_read_after",
      data: {
        machineId: "machine-1",
        providerId,
        remoteSessionId: `${providerId}-native-1`,
        sessionId: `happier-${providerId}-1`,
        source,
        fromCursor: null,
        nextCursor: "cursor-2",
        truncated: false,
        items: [],
      },
    }));
    fake.close(0);

    await expect(promise).resolves.toMatchObject({ providerId, source });
    expect(mockSpawn.mock.calls[0]?.[1]).toEqual([
      "direct-session", "read-after",
      "--provider", providerId,
      "--remote-session-id", `${providerId}-native-1`,
      "--session-id", `happier-${providerId}-1`,
      "--machine-id", "machine-1",
      "--source-json", JSON.stringify(source),
      "--after-cursor", "null",
      "--limit", "25",
      "--json",
    ]);
  });

  it("streams bounded legacy local Direct Session NDJSON and terminates on iterator return", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const stream = followHappierDirectSessionTranscriptEvents({
      providerId: "codex",
      remoteSessionId: "remote-1",
      sessionId: "session-1",
      machineId: "machine-1",
      afterCursor: "cursor-2",
      limit: 25,
    }, settings());
    const iterator = stream[Symbol.asyncIterator]();
    const first = iterator.next();

    fake.stdout(`${DIRECT_TRANSCRIPT_EVENT}\n`);
    await expect(first).resolves.toMatchObject({
      done: false,
      value: {
        fromCursor: "cursor-2",
        nextCursor: "cursor-3",
        items: [{ id: "message-2" }],
      },
    });
    const second = iterator.next();
    fake.stdout(`${DIRECT_STATUS_EVENT}\n`);
    await expect(second).resolves.toMatchObject({
      done: false,
      value: {
        eventType: "status",
        isRunning: true,
        lastActivityAtMs: 1_752_729_001_000,
        observedAtMs: 1_752_729_001_500,
      },
    });
    expect(mockSpawn.mock.calls[0]?.[1]).toEqual([
      "direct-session", "events",
      "--provider", "codex",
      "--remote-session-id", "remote-1",
      "--session-id", "session-1",
      "--machine-id", "machine-1",
      "--source-json", JSON.stringify({ kind: "codexHome", home: "user" }),
      "--after-cursor", "cursor-2",
      "--limit", "25",
      "--ndjson",
    ]);

    let returnSettled = false;
    const returned = iterator.return?.().then((result) => {
      returnSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(returnSettled).toBe(false);
    expect(fake.kill).toHaveBeenCalledWith("SIGTERM");
    fake.close(0);
    await expect(returned).resolves.toEqual({ done: true, value: undefined });
  });

  it("terminates the full Windows Direct Session process tree before iterator return settles", async () => {
    if (process.platform !== "win32") return;
    const fake = fakeChild(42424);
    mockSpawn.mockReturnValue(fake.child);
    const iterator = followHappierDirectSessionTranscriptEvents({
      providerId: "codex",
      remoteSessionId: "remote-1",
      sessionId: "session-1",
      machineId: "machine-1",
      afterCursor: "cursor-2",
      limit: 25,
    }, settings())[Symbol.asyncIterator]();
    const next = iterator.next();
    const returned = iterator.return?.();

    expect(mockExecFile).toHaveBeenCalledWith(
      "taskkill.exe",
      ["/PID", "42424", "/T", "/F"],
      expect.objectContaining({ shell: false, timeout: 2_000, windowsHide: true }),
      expect.any(Function),
    );
    const callback = mockExecFile.mock.calls[0]?.[3] as (error: Error | null) => void;
    callback(null);
    fake.close(0);
    await expect(next).resolves.toEqual({ done: true, value: undefined });
    await expect(returned).resolves.toEqual({ done: true, value: undefined });
  });

  it("rejects iterator cancellation when Windows process-tree termination fails", async () => {
    if (process.platform !== "win32") return;
    const fake = fakeChild(42425);
    mockSpawn.mockReturnValue(fake.child);
    const iterator = followHappierDirectSessionTranscriptEvents({
      providerId: "codex",
      remoteSessionId: "remote-1",
      sessionId: "session-1",
      machineId: "machine-1",
      afterCursor: "cursor-2",
      limit: 25,
    }, settings())[Symbol.asyncIterator]();
    const next = iterator.next();
    const returned = iterator.return?.();
    const returnedFailure = expect(returned).rejects.toMatchObject({ code: "process" });
    const returnedRedaction = expect(returned).rejects.not.toThrow("private-plaintext");
    const callback = mockExecFile.mock.calls[0]?.[3] as (error: Error | null) => void;
    callback(new Error("taskkill timed out with private-plaintext"));
    fake.close(0);

    expect(fake.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(next).resolves.toEqual({ done: true, value: undefined });
    await returnedFailure;
    await returnedRedaction;
  });

  it("rejects iterator cancellation when the child never confirms close", async () => {
    if (process.platform !== "win32") return;
    vi.useFakeTimers();
    try {
      const fake = fakeChild(42426);
      mockSpawn.mockReturnValue(fake.child);
      const iterator = followHappierDirectSessionTranscriptEvents({
        providerId: "codex",
        remoteSessionId: "remote-1",
        sessionId: "session-1",
        machineId: "machine-1",
        afterCursor: "cursor-2",
        limit: 25,
      }, settings())[Symbol.asyncIterator]();
      const next = iterator.next();
      const returned = iterator.return?.();
      const returnedFailure = expect(returned).rejects.toMatchObject({ code: "process" });
      const callback = mockExecFile.mock.calls[0]?.[3] as (error: Error | null) => void;
      callback(null);
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(next).resolves.toEqual({ done: true, value: undefined });
      await returnedFailure;
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when a Direct transcript envelope drifts to another native Session", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const promise = readHappierDirectSessionTranscript({
      providerId: "codex",
      remoteSessionId: "remote-1",
      sessionId: "session-1",
      machineId: "machine-1",
      afterCursor: null,
      limit: 25,
    }, settings());
    fake.stdout(DIRECT_TRANSCRIPT_SUCCESS.replace('"remoteSessionId":"remote-1"', '"remoteSessionId":"other"'));
    fake.close(0);

    await expect(promise).rejects.toMatchObject({ code: "protocol" });
  });

  it("never includes transcript plaintext in malformed NDJSON diagnostics", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const stream = followHappierDirectSessionTranscriptEvents({
      providerId: "codex",
      remoteSessionId: "remote-1",
      sessionId: "session-1",
      machineId: "machine-1",
      afterCursor: "cursor-2",
      limit: 25,
    }, settings());
    const next = stream[Symbol.asyncIterator]().next();
    fake.stdout('{"transcript":"private-plaintext","token":"secret-value"\n');

    await expect(next).rejects.toMatchObject({ code: "invalid-json" });
    await expect(next).rejects.not.toThrow("private-plaintext");
    await expect(next).rejects.not.toThrow("secret-value");
    expect(fake.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("never echoes an untrusted NDJSON envelope kind", async () => {
    const fake = fakeChild();
    mockSpawn.mockReturnValue(fake.child);
    const stream = followHappierDirectSessionTranscriptEvents({
      providerId: "codex",
      remoteSessionId: "remote-1",
      sessionId: "session-1",
      machineId: "machine-1",
      afterCursor: "cursor-2",
      limit: 25,
    }, settings());
    const next = stream[Symbol.asyncIterator]().next();
    fake.stdout('{"v":1,"ok":true,"kind":"private-transcript-plaintext","data":{}}\n');

    await expect(next).rejects.toMatchObject({ code: "invalid-json" });
    await expect(next).rejects.not.toThrow("private-transcript-plaintext");
  });

  it("normalizes the webapp trailing slash and encodes session-open ids", () => {
    expect(buildHappierSessionOpenUrl("https://app.happier.dev/", "server/id", "session id?#")).toBe(
      "https://app.happier.dev/session/session%20id%3F%23?serverId=server%2Fid",
    );
  });

  it.each([
    "javascript:alert(1)",
    "https://user:password@app.happier.dev",
    "https://app.happier.dev/?accessToken=secret",
    "https://app.happier.dev/#session",
  ])("rejects an unsafe current Happier web origin: %s", (webappUrl) => {
    expect(() => buildHappierSessionOpenUrl(webappUrl, "server-1", "session-1"))
      .toThrow("Happier webapp URL or Session identity is unsafe");
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
  /*
   * FNXC:HappierMcp 2026-07-19-19:52:
   * Entry exports are a module-load contract, not a per-test performance gate.
   * Keep this import at module scope so parallel Vite transforms cannot mask it.
   */
  it("exports the Task 1 contract from src/index.ts", () => {
    expect(packageEntrypoint.createHappierSession).toBeTypeOf("function");
    expect(packageEntrypoint.ensureHappierDirectSession).toBeTypeOf("function");
    expect(packageEntrypoint.invokeHappierJson).toBeTypeOf("function");
  }, 15_000);
});

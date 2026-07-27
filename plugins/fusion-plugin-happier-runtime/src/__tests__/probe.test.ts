import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mockSpawn,
}));

import { HappierCliError } from "../types.js";
import {
  probeHappierRuntime,
  runHappierProbeCommand,
  type HappierProbeDependencies,
} from "../probe.js";

const help = { exitCode: 0, stdout: "Happier backend help" };
const authOk = {
  exitCode: 0,
  stdout: JSON.stringify({ v: 1, ok: true, kind: "auth_status", data: { authenticated: true } }),
};
const authMissing = {
  exitCode: 0,
  stdout: JSON.stringify({ v: 1, ok: false, kind: "auth_status", error: { code: "not_authenticated" } }),
};
const profiles = {
  exitCode: 0,
  stdout: JSON.stringify({
    v: 1,
    ok: true,
    kind: "profiles_list",
    data: {
      authenticated: true,
      profiles: [
        { id: "anthropic", supportedAgentIds: ["claude"] },
        { id: "codex", supportedAgentIds: ["codex"] },
      ],
    },
  }),
};
const boundSessionId = "session-codex-1";
const boundCodexSettings = {
  backend: "codex" as const,
  happierSessionBindings: [{
    canonicalSessionUri: "codex://threads/thread-1",
    happierSessionId: boundSessionId,
    serverProfileId: "server-1",
    machineId: "machine-1",
  }],
};
const boundSessionStatus = {
  exitCode: 0,
  stdout: JSON.stringify({
    v: 1,
    ok: true,
    kind: "session_status",
    data: {
      session: { id: boundSessionId, active: true },
      agentState: { controlledByUser: false, pendingRequestsCount: 0 },
    },
  }),
};
const boundSessionModels = {
  exitCode: 0,
  stdout: JSON.stringify({
    v: 1,
    ok: true,
    kind: "session_actions_execute",
    data: {
      sessionId: boundSessionId,
      actionId: "agents.models.list",
      result: {
        agentId: "codex",
        items: [
          { id: "default", label: "Default" },
          { id: "gpt-5.6-sol", label: "GPT 5.6 Sol" },
        ],
        source: "session_metadata",
      },
    },
  }),
};

const attestationOk = {
  ok: true as const,
  trustLevel: "local_custom_pinned_source_build" as const,
  sourceRoot: "G:\\codex-project\\happier",
  entrypointPath: "G:\\codex-project\\happier\\apps\\cli\\package-dist\\index.mjs",
  cliVersion: "0.2.10",
  sourceCommit: "6e059c41d865343c1efc9c98676e5af3882d85ff",
  entrypointSha256: "sha256:8ad722284c12ca87c946f3a94b66b14f5640bf768e719c8791b1cb0234312786" as const,
  verifiedAt: "2026-07-27T04:10:00.000Z",
  evidence: {
    version: "cli_--version" as const,
    package: "package_json" as const,
    source: "git_head" as const,
    artifact: "sha256_file_bytes" as const,
  },
};

function status(overrides: Record<string, unknown> = {}) {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      report: { authProfiles: [{ isActive: true, reachability: "reachable" }] },
      daemonStatus: {
        daemon: { running: true },
        auth: { authenticated: true },
      },
      ...overrides,
    }),
  };
}

function runner(
  results: Record<string, unknown>,
  attestation: HappierProbeDependencies["attestCli"] = async () => attestationOk,
): HappierProbeDependencies {
  return {
    attestCli: attestation,
    run: async (args) => {
      const key = args.join(" ");
      const value = results[key];
      if (value instanceof Error) throw value;
      if (!value) throw new Error(`unexpected command: ${key}`);
      return value as { exitCode: number | null; stdout: string };
    },
  };
}

afterEach(() => {
  mockSpawn.mockReset();
  vi.unstubAllEnvs();
});

describe("probeHappierRuntime", () => {
  it("runs probe commands inside the selected Happier stack environment without arbitrary inherited env", async () => {
    vi.stubEnv("FUSION_HAPPIER_PROBE_MARKER", "preserved");
    const child = new EventEmitter() as ChildProcess;
    const stdout = new EventEmitter();
    Object.assign(child, { stdout, kill: vi.fn() });
    mockSpawn.mockReturnValue(child);

    const promise = runHappierProbeCommand(["auth", "status", "--json"], {
      executable: "happier",
      homeDir: "C:\\Users\\datoo\\.happier\\stacks\\fusion\\cli",
      activeServerId: "stack_fusion__id_default",
      serverUrl: "http://127.0.0.1:52211",
      publicServerUrl: "http://localhost:52211",
      webappUrl: "http://stack.localhost:52211",
    });
    stdout.emit("data", Buffer.from("probe-output"));
    child.emit("close", 0);

    await expect(promise).resolves.toEqual({ exitCode: 0, stdout: "probe-output" });
    expect(mockSpawn).toHaveBeenCalledWith(
      "happier",
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          HAPPIER_HOME_DIR: "C:\\Users\\datoo\\.happier\\stacks\\fusion\\cli",
          HAPPIER_ACTIVE_SERVER_ID: "stack_fusion__id_default",
          HAPPIER_SERVER_URL: "http://127.0.0.1:52211",
          HAPPIER_PUBLIC_SERVER_URL: "http://localhost:52211",
          HAPPIER_WEBAPP_URL: "http://stack.localhost:52211",
        }),
      }),
    );
    const spawnedEnvironment = mockSpawn.mock.calls[0]?.[2]?.env as NodeJS.ProcessEnv;
    expect(spawnedEnvironment).not.toHaveProperty("FUSION_HAPPIER_PROBE_MARKER");
  });

  it("reports a missing executable without probing later layers", async () => {
    const health = await probeHappierRuntime({}, runner({ "codex --help": new Error("ENOENT token=secret") }));
    expect(health).toMatchObject({ discovered: false, executable: false, ready: false });
    expect(health.details).toEqual(["executable-not-found"]);
    expect(JSON.stringify(health)).not.toContain("secret");
  });

  it("does not treat an executable but unauthenticated runtime as ready", async () => {
    const health = await probeHappierRuntime({}, runner({
      "codex --help": help,
      "auth status --json": authMissing,
      "status --json": status({
        report: { authProfiles: [{ isActive: true, reachability: "not-probed" }] },
        daemonStatus: { daemon: { running: true }, auth: { authenticated: false } },
      }),
      "profiles list --json": profiles,
    }));
    expect(health).toMatchObject({
      executable: true,
      server: false,
      serverState: "not-probed",
      authenticated: false,
      daemon: true,
      backend: false,
      ready: false,
    });
  });

  it("distinguishes an unreachable server", async () => {
    const health = await probeHappierRuntime({}, runner({
      "codex --help": help,
      "auth status --json": {
        exitCode: 0,
        stdout: JSON.stringify({ v: 1, ok: false, kind: "auth_status", error: { code: "server_unreachable" } }),
      },
      "status --json": status({
        report: { authProfiles: [{ isActive: true, reachability: "unreachable" }] },
        daemonStatus: { daemon: { running: true }, auth: { authenticated: false } },
      }),
      "profiles list --json": profiles,
    }));
    expect(health.server).toBe(false);
    expect(health.serverState).toBe("unreachable");
    expect(health.details).toContain("server-unreachable");
  });

  it("distinguishes a stopped daemon", async () => {
    const health = await probeHappierRuntime({}, runner({
      "codex --help": help,
      "auth status --json": authOk,
      "status --json": status({ daemonStatus: { daemon: { running: false }, auth: { authenticated: true } } }),
      "profiles list --json": profiles,
    }));
    expect(health).toMatchObject({ server: true, authenticated: true, daemon: false, ready: false });
  });

  it("reports an unavailable selected backend", async () => {
    const health = await probeHappierRuntime({ backend: "codex" }, runner({
      "codex --help": help,
      "auth status --json": authOk,
      "status --json": status(),
      "profiles list --json": { ...profiles, stdout: JSON.stringify({ v: 1, ok: true, kind: "profiles_list", data: { profiles: [] } }) },
    }));
    expect(health).toMatchObject({ backendId: "codex", backend: false, ready: false });
  });

  it("does not treat a profile catalog entry as bound backend or model health", async () => {
    const health = await probeHappierRuntime({}, runner({
      "codex --help": help,
      "auth status --json": authOk,
      "status --json": status(),
      "profiles list --json": profiles,
    }));
    expect(health).toEqual({
      discovered: true,
      executable: true,
      server: true,
      serverState: "reachable",
      authenticated: true,
      daemon: true,
      backend: false,
      ready: false,
      backendId: "codex",
      modelId: null,
      modelState: "not_reported",
      attestation: attestationOk,
      details: ["backend-machine-availability-unverified"],
    });
  });

  it("treats the official verified reachability value as reachable without overriding model truth", async () => {
    const health = await probeHappierRuntime(boundCodexSettings, runner({
      "codex --help": help,
      "auth status --json": authOk,
      "status --json": status({
        report: { authProfiles: [{ isActive: true, reachability: "verified" }] },
      }),
      "profiles list --json": profiles,
      [`session status ${boundSessionId} --live --json`]: boundSessionStatus,
      [`session actions execute ${boundSessionId} agents.models.list --input-json {"agentId":"codex","limit":200} --json`]:
        boundSessionModels,
    }));

    expect(health).toMatchObject({
      server: true,
      serverState: "reachable",
      authenticated: true,
      daemon: true,
      backend: true,
      ready: false,
    });
  });

  it("does not infer server reachability from authentication when status JSON is malformed", async () => {
    const health = await probeHappierRuntime({}, runner({
      "codex --help": help,
      "auth status --json": authOk,
      "status --json": { exitCode: 0, stdout: "token=top-secret not-json" },
      "profiles list --json": profiles,
    }));
    expect(health.ready).toBe(false);
    expect(health.server).toBe(false);
    expect(health.serverState).toBe("not-probed");
    expect(health.details).toContain("server-not-probed");
    expect(health.details).toContain("status-invalid");
    expect(JSON.stringify(health)).not.toContain("top-secret");
  });

  it("preserves auth evidence that the server is unreachable when status JSON is malformed", async () => {
    const health = await probeHappierRuntime({}, runner({
      "codex --help": help,
      "auth status --json": {
        exitCode: 0,
        stdout: JSON.stringify({ v: 1, ok: false, kind: "auth_status", error: { code: "server_unreachable" } }),
      },
      "status --json": { exitCode: 0, stdout: "not-json" },
      "profiles list --json": profiles,
    }));
    expect(health.server).toBe(false);
    expect(health.serverState).toBe("unreachable");
    expect(health.details).toContain("server-unreachable");
    expect(health.details).toContain("status-invalid");
  });

  it("reports timeouts without leaking exception text", async () => {
    const health = await probeHappierRuntime({}, runner({
      "codex --help": new HappierCliError("timeout", "Bearer should-not-leak"),
    }));
    expect(health.details).toEqual(["executable-timeout"]);
    expect(JSON.stringify(health)).not.toContain("should-not-leak");
  });

  it("fails closed before any CLI layer when build attestation is rejected", async () => {
    const run = vi.fn();
    const health = await probeHappierRuntime({}, {
      run,
      attestCli: async () => ({ ok: false, reasonCode: "cli_artifact_hash_mismatch" }),
    });

    expect(run).not.toHaveBeenCalled();
    expect(health).toMatchObject({
      discovered: false,
      executable: false,
      ready: false,
      attestation: { ok: false, reasonCode: "cli_artifact_hash_mismatch" },
      details: ["cli-attestation-failed"],
    });
  });

  it("uses official bound-session status and model inventory without claiming an unreported selected model", async () => {
    const run = vi.fn(runner({
      "codex --help": help,
      "auth status --json": authOk,
      "status --json": status(),
      "profiles list --json": profiles,
      [`session status ${boundSessionId} --live --json`]: boundSessionStatus,
      [`session actions execute ${boundSessionId} agents.models.list --input-json {"agentId":"codex","limit":200} --json`]:
        boundSessionModels,
    }).run);

    const health = await probeHappierRuntime(boundCodexSettings, {
      run,
      attestCli: async () => attestationOk,
    });

    expect(run).toHaveBeenCalledWith(
      ["session", "status", boundSessionId, "--live", "--json"],
      boundCodexSettings,
    );
    expect(run).toHaveBeenCalledWith(
      [
        "session",
        "actions",
        "execute",
        boundSessionId,
        "agents.models.list",
        "--input-json",
        "{\"agentId\":\"codex\",\"limit\":200}",
        "--json",
      ],
      boundCodexSettings,
    );
    expect(health).toMatchObject({
      backendId: "codex",
      backend: true,
      modelId: null,
      modelState: "not_reported",
      ready: false,
    });
    expect(health.details).toContain("model-not-reported");
  });

  it("does not infer OpenCode machine availability from catalog compatibility", async () => {
    const opencodeProfiles = {
      exitCode: 0,
      stdout: JSON.stringify({
        v: 1,
        ok: true,
        kind: "profiles_list",
        data: { profiles: [{ id: "opencode", supportedAgentIds: ["opencode"] }] },
      }),
    };
    const health = await probeHappierRuntime({ backend: "opencode" }, runner({
      "opencode --help": help,
      "auth status --json": authOk,
      "status --json": status(),
      "profiles list --json": opencodeProfiles,
    }));

    expect(health).toMatchObject({ backendId: "opencode", backend: false, ready: false });
    expect(health.details).toContain("backend-machine-availability-unverified");
  });

});

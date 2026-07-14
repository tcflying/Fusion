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

function runner(results: Record<string, unknown>): HappierProbeDependencies {
  return {
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
  it("runs probe commands inside the selected Happier stack environment", async () => {
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
          FUSION_HAPPIER_PROBE_MARKER: "preserved",
          HAPPIER_HOME_DIR: "C:\\Users\\datoo\\.happier\\stacks\\fusion\\cli",
          HAPPIER_ACTIVE_SERVER_ID: "stack_fusion__id_default",
          HAPPIER_SERVER_URL: "http://127.0.0.1:52211",
          HAPPIER_PUBLIC_SERVER_URL: "http://localhost:52211",
          HAPPIER_WEBAPP_URL: "http://stack.localhost:52211",
        }),
      }),
    );
  });

  it("reports a missing executable without probing later layers", async () => {
    const health = await probeHappierRuntime({}, runner({ "claude --help": new Error("ENOENT token=secret") }));
    expect(health).toMatchObject({ discovered: false, executable: false, ready: false });
    expect(health.details).toEqual(["executable-not-found"]);
    expect(JSON.stringify(health)).not.toContain("secret");
  });

  it("does not treat an executable but unauthenticated runtime as ready", async () => {
    const health = await probeHappierRuntime({}, runner({
      "claude --help": help,
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
      backend: true,
      ready: false,
    });
  });

  it("distinguishes an unreachable server", async () => {
    const health = await probeHappierRuntime({}, runner({
      "claude --help": help,
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
      "claude --help": help,
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

  it("requires every layer for full readiness", async () => {
    const health = await probeHappierRuntime({}, runner({
      "claude --help": help,
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
      backend: true,
      ready: true,
      backendId: "claude",
      details: [],
    });
  });

  it("treats the official verified reachability value as reachable", async () => {
    const health = await probeHappierRuntime({ backend: "codex" }, runner({
      "codex --help": help,
      "auth status --json": authOk,
      "status --json": status({
        report: { authProfiles: [{ isActive: true, reachability: "verified" }] },
      }),
      "profiles list --json": profiles,
    }));

    expect(health).toMatchObject({
      server: true,
      serverState: "reachable",
      authenticated: true,
      daemon: true,
      backend: true,
      ready: true,
    });
  });

  it("does not infer server reachability from authentication when status JSON is malformed", async () => {
    const health = await probeHappierRuntime({}, runner({
      "claude --help": help,
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
      "claude --help": help,
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
      "claude --help": new HappierCliError("timeout", "Bearer should-not-leak"),
    }));
    expect(health.details).toEqual(["executable-timeout"]);
    expect(JSON.stringify(health)).not.toContain("should-not-leak");
  });
});

import { describe, expect, it } from "vitest";

import { HappierCliError } from "../types.js";
import { probeHappierRuntime, type HappierProbeDependencies } from "../probe.js";

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

describe("probeHappierRuntime", () => {
  it("reports a missing executable without probing later layers", async () => {
    const health = await probeHappierRuntime({}, runner({ "--help": new Error("ENOENT token=secret") }));
    expect(health).toMatchObject({ discovered: false, executable: false, ready: false });
    expect(health.details).toEqual(["executable-not-found"]);
    expect(JSON.stringify(health)).not.toContain("secret");
  });

  it("does not treat an executable but unauthenticated runtime as ready", async () => {
    const health = await probeHappierRuntime({}, runner({
      "--help": help,
      "auth status --json": authMissing,
      "status --json": status({
        report: { authProfiles: [{ isActive: true, reachability: "not-probed" }] },
        daemonStatus: { daemon: { running: true }, auth: { authenticated: false } },
      }),
      "profiles list --json": profiles,
    }));
    expect(health).toMatchObject({ executable: true, server: false, authenticated: false, daemon: true, backend: true, ready: false });
  });

  it("distinguishes an unreachable server", async () => {
    const health = await probeHappierRuntime({}, runner({
      "--help": help,
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
    expect(health.details).toContain("server-unreachable");
  });

  it("distinguishes a stopped daemon", async () => {
    const health = await probeHappierRuntime({}, runner({
      "--help": help,
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
      "--help": help,
      "auth status --json": authOk,
      "status --json": status(),
      "profiles list --json": profiles,
    }));
    expect(health).toEqual({
      discovered: true,
      executable: true,
      server: true,
      authenticated: true,
      daemon: true,
      backend: true,
      ready: true,
      backendId: "claude",
      details: [],
    });
  });

  it("fails closed on malformed status JSON", async () => {
    const health = await probeHappierRuntime({}, runner({
      "--help": help,
      "auth status --json": authOk,
      "status --json": { exitCode: 0, stdout: "token=top-secret not-json" },
      "profiles list --json": profiles,
    }));
    expect(health.ready).toBe(false);
    expect(health.details).toContain("status-invalid");
    expect(JSON.stringify(health)).not.toContain("top-secret");
  });

  it("reports timeouts without leaking exception text", async () => {
    const health = await probeHappierRuntime({}, runner({
      "--help": new HappierCliError("timeout", "Bearer should-not-leak"),
    }));
    expect(health.details).toEqual(["executable-timeout"]);
    expect(JSON.stringify(health)).not.toContain("should-not-leak");
  });
});

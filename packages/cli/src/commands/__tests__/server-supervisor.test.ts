import { describe, expect, it, vi } from "vitest";
import {
  buildSupervisedChildArgs,
  buildSupervisedChildEnv,
  createHostSystemRestartControl,
  formatSupervisorRestartCommand,
  runServerSupervisorLoop,
  SERVER_NON_RETRYABLE_EXIT_CODE,
  SERVER_RESTART_EXIT_CODE,
  shouldSuperviseServerCommand,
} from "../server-supervisor.js";

/*
FNXC:ServerSupervisor 2026-07-27-03:54:
Serve and daemon enter the shared foreground supervisor by default unless a
live supervising parent owns the child. The loop also exercises Dashboard's
established restart exit-code contract.
*/
describe("shouldSuperviseServerCommand", () => {
  it("supervises serve and daemon by default", () => {
    expect(shouldSuperviseServerCommand("serve", ["serve"], {}, [])).toBe(true);
    expect(shouldSuperviseServerCommand("daemon", ["daemon"], {}, [])).toBe(true);
  });

  it("trusts a supervisor stamp only when its pid is the live parent", () => {
    const stampedEnv = {
      FUSION_RESTART_SUPERVISED: "1",
      FUSION_SUPERVISOR_PID: "4242",
    };

    expect(shouldSuperviseServerCommand("serve", ["serve"], stampedEnv, [], 4242)).toBe(false);
    expect(shouldSuperviseServerCommand("serve", ["serve"], stampedEnv, [], 99)).toBe(true);
  });

  it("fails closed on an inherited flag without a parent pid", () => {
    expect(
      shouldSuperviseServerCommand(
        "daemon",
        ["daemon"],
        { FUSION_RESTART_SUPERVISED: "1" },
        [],
        4242,
      ),
    ).toBe(true);
  });

  it("ignores the retired no-supervise flag but honors debug and token-only modes", () => {
    expect(
      shouldSuperviseServerCommand(
        "serve",
        ["serve", "--no-supervise"],
        {},
        [],
      ),
    ).toBe(true);
    expect(
      shouldSuperviseServerCommand(
        "daemon",
        ["daemon", "--token-only"],
        {},
        [],
      ),
    ).toBe(false);
    expect(
      shouldSuperviseServerCommand(
        "serve",
        ["serve"],
        {},
        ["--inspect"],
      ),
    ).toBe(false);
  });
});

describe("buildSupervisedChildEnv", () => {
  it("stamps the actual parent pid on every supervised child", () => {
    expect(buildSupervisedChildEnv({ KEEP: "yes" }, 4242)).toMatchObject({
      KEEP: "yes",
      FUSION_RESTART_SUPERVISED: "1",
      FUSION_SUPERVISOR_PID: "4242",
    });
  });
});

describe("buildSupervisedChildArgs", () => {
  it("preserves the selected host command while removing supervisor-only flags", () => {
    expect(
      buildSupervisedChildArgs("serve", [
        "serve",
        "--port",
        "4050",
        "--supervise",
        "--no-supervise",
      ]),
    ).toEqual(["serve", "--port", "4050"]);
  });
});

describe("formatSupervisorRestartCommand", () => {
  it("omits explicit bearer tokens from the crash-recovery log command", () => {
    const token = "fn_test_bearer_that_must_not_reach_logs";

    const restartCommand = formatSupervisorRestartCommand(
      "node",
      ["packages/cli/src/bin.ts"],
      ["serve", "--port", "4050", "--token", token],
    );

    expect(restartCommand).not.toContain(token);
    expect(restartCommand).not.toContain("--token");
    expect(restartCommand).toContain("serve --port 4050");
  });
});

describe("createHostSystemRestartControl", () => {
  it("routes one System restart through graceful shutdown with exit 86", async () => {
    const scheduled: Array<() => void> = [];
    const shutdown = vi.fn(async (_exitCode: number) => undefined);
    const control = createHostSystemRestartControl({
      supervised: true,
      canRestart: () => true,
      schedule: (callback) => {
        scheduled.push(callback);
      },
      log: vi.fn(),
    });
    control.bindShutdown(shutdown);

    expect(control.systemControl.requestRestart("test-restart")).toBe(true);
    expect(control.systemControl.requestRestart("duplicate")).toBe(false);
    expect(shutdown).not.toHaveBeenCalled();

    scheduled[0]?.();
    await Promise.resolve();

    expect(shutdown).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledWith(SERVER_RESTART_EXIT_CODE);
  });

  it("fails closed without a live supervising parent", () => {
    const control = createHostSystemRestartControl({
      supervised: false,
      canRestart: () => true,
      schedule: vi.fn(),
      log: vi.fn(),
    });
    control.bindShutdown(vi.fn());

    expect(control.systemControl.requestRestart("test-restart")).toBe(false);
  });
});

describe("runServerSupervisorLoop", () => {
  it("relaunches once after an ordinary child crash", async () => {
    const exits = [
      { code: 1, signal: null },
      { code: 0, signal: null },
    ];
    const spawnChild = vi.fn(async () => exits.shift()!);
    const sleep = vi.fn(async () => undefined);

    const result = await runServerSupervisorLoop({
      command: "serve",
      port: 4050,
      spawnChild,
      sleep,
      now: () => 1_000,
      log: vi.fn(),
      error: vi.fn(),
      restartCommand: "fn serve --port 4050",
    });

    expect(spawnChild).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(result).toEqual({ exitCode: 0, crashRestarts: 1 });
  });

  it("respawns a System restart immediately without consuming crash budget", async () => {
    const exits = [
      { code: SERVER_RESTART_EXIT_CODE, signal: null },
      { code: 0, signal: null },
    ];
    const sleep = vi.fn(async () => undefined);

    const result = await runServerSupervisorLoop({
      command: "dashboard",
      port: 4050,
      spawnChild: vi.fn(async () => exits.shift()!),
      sleep,
      now: () => 1_000,
      log: vi.fn(),
      error: vi.fn(),
      restartCommand: "fn dashboard --port 4050",
    });

    expect(sleep).not.toHaveBeenCalled();
    expect(result).toEqual({ exitCode: 0, crashRestarts: 0 });
  });

  it("stops after the bounded crash budget is exhausted", async () => {
    const spawnChild = vi.fn(async () => ({ code: 1, signal: null }));
    const sleep = vi.fn(async () => undefined);
    const error = vi.fn();

    const result = await runServerSupervisorLoop({
      command: "daemon",
      port: 4050,
      spawnChild,
      sleep,
      now: () => 1_000,
      log: vi.fn(),
      error,
      restartCommand: "fn daemon --port 4050",
    });

    expect(spawnChild).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("exhausted its crash budget"));
    expect(result).toEqual({ exitCode: 1, crashRestarts: 4 });
  });

  it("propagates a classified non-retryable startup exit without relaunching", async () => {
    const spawnChild = vi.fn(async () => ({
      code: SERVER_NON_RETRYABLE_EXIT_CODE,
      signal: null,
    }));

    const result = await runServerSupervisorLoop({
      command: "serve",
      port: 4050,
      spawnChild,
      sleep: vi.fn(async () => undefined),
      now: () => 1_000,
      log: vi.fn(),
      error: vi.fn(),
      restartCommand: "fn serve --port 4050",
    });

    expect(spawnChild).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      exitCode: SERVER_NON_RETRYABLE_EXIT_CODE,
      crashRestarts: 0,
    });
  });
});

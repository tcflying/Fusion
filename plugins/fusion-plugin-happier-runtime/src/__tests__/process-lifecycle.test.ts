import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  terminateAndWaitHappierProcessTree,
  terminateHappierProcessTree,
} from "../process-lifecycle.js";

function fakeChild(pid = 4242) {
  const child = new EventEmitter() as ChildProcess;
  const kill = vi.fn(() => true);
  Object.assign(child, { pid, exitCode: null, signalCode: null, kill });
  return { child, kill };
}

describe("terminateHappierProcessTree", () => {
  it("does not settle cleanup until the child confirms close", async () => {
    const child = new EventEmitter() as ChildProcess;
    const kill = vi.fn(() => true);
    Object.assign(child, { exitCode: null, signalCode: null, kill });
    let settled = false;
    const cleanup = terminateAndWaitHappierProcessTree(child, 1_000).then((value) => {
      settled = true;
      return value;
    });

    await Promise.resolve();
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(settled).toBe(false);
    child.emit("close", 0);
    await expect(cleanup).resolves.toBe(true);
  });

  it("uses taskkill with a hard deadline and retries only bounded Windows lock failures", async () => {
    const fake = fakeChild();
    const busy = Object.assign(new Error("locked"), { code: "EBUSY" });
    const execFile = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: object,
      callback: (error: Error | null) => void,
    ) => callback(execFile.mock.calls.length === 1 ? busy : null));

    await expect(terminateHappierProcessTree(fake.child, {
      platform: "win32",
      execFile: execFile as never,
      delay: async () => undefined,
      now: (() => {
        let value = 1_000;
        return () => value++;
      })(),
    })).resolves.toBe(true);

    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile).toHaveBeenNthCalledWith(
      1,
      "taskkill.exe",
      ["/PID", "4242", "/T", "/F"],
      expect.objectContaining({
        shell: false,
        timeout: 2_000,
        windowsHide: true,
      }),
      expect.any(Function),
    );
    expect(fake.kill).not.toHaveBeenCalled();
  });

  it("stops after three transient failures and falls back to the direct child signal", async () => {
    const fake = fakeChild();
    const denied = Object.assign(new Error("denied"), { code: "EPERM" });
    const execFile = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: object,
      callback: (error: Error | null) => void,
    ) => callback(denied));

    await expect(terminateHappierProcessTree(fake.child, {
      platform: "win32",
      execFile: execFile as never,
      delay: async () => undefined,
      now: () => 1_000,
    })).resolves.toBe(false);

    expect(execFile).toHaveBeenCalledTimes(3);
    expect(fake.kill).toHaveBeenCalledWith("SIGTERM");
  });
});

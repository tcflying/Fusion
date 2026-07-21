import { describe, expect, it, vi } from "vitest";

import { ProjectEngine } from "../project-engine.js";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("ProjectEngine Room shutdown concurrency", () => {
  it("serializes concurrent stop calls through controller, dispatcher, then runtime", async () => {
    const controllerStopEntered = deferred();
    const releaseControllerStop = deferred();
    const controllerStop = vi.fn(async () => {
      controllerStopEntered.resolve();
      await releaseControllerStop.promise;
    });
    const dispatcherStop = vi.fn(async () => undefined);
    const runtimeStop = vi.fn(async () => undefined);
    const engine = new ProjectEngine(
      {
        projectId: "project-1",
        workingDirectory: "G:\\fusion-test\\project-1",
        isolationMode: "in-process",
        maxConcurrent: 2,
        maxWorktrees: 2,
      },
      {} as never,
      { skipNotifier: true },
    );
    Object.assign(engine as unknown as Record<string, unknown>, {
      started: true,
      runtimeStarted: true,
      roomController: { start: vi.fn(), stop: controllerStop },
      roomRunAuditDispatcher: { start: vi.fn(), stop: dispatcherStop },
      runtime: { stop: runtimeStop },
    });

    const firstStop = engine.stop();
    await controllerStopEntered.promise;
    const secondStop = engine.stop();
    await Promise.resolve();

    expect(controllerStop).toHaveBeenCalledTimes(1);
    expect(dispatcherStop).not.toHaveBeenCalled();
    expect(runtimeStop).not.toHaveBeenCalled();

    releaseControllerStop.resolve();
    await Promise.all([firstStop, secondStop]);

    expect(controllerStop).toHaveBeenCalledTimes(1);
    expect(dispatcherStop).toHaveBeenCalledTimes(1);
    expect(runtimeStop).toHaveBeenCalledTimes(1);
    expect(controllerStop.mock.invocationCallOrder[0]).toBeLessThan(
      dispatcherStop.mock.invocationCallOrder[0]!,
    );
    expect(dispatcherStop.mock.invocationCallOrder[0]).toBeLessThan(
      runtimeStop.mock.invocationCallOrder[0]!,
    );
  });
});

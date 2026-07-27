import { describe, expect, it, vi } from "vitest";
import { StartupBackgroundTaskTracker } from "../startup-background-task-tracker.js";

describe("StartupBackgroundTaskTracker", () => {
  it("drains tracked work and removes it after settlement", async () => {
    let resolveOperation!: () => void;
    const operation = new Promise<void>((resolve) => {
      resolveOperation = resolve;
    });
    const tracker = new StartupBackgroundTaskTracker({
      onFailure: vi.fn(),
      onTimeout: vi.fn(),
    });

    tracker.track("mission recovery", operation);
    expect(tracker.pendingCount).toBe(1);

    const drain = tracker.drain(1_000);
    resolveOperation();
    await drain;

    expect(tracker.pendingCount).toBe(0);
  });
});

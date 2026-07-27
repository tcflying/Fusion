import { describe, expect, it, vi } from "vitest";

import { probeHappierBindingCapabilities } from "../capability-probe.js";

describe("probeHappierBindingCapabilities", () => {
  it("bounds concurrency, samples every binding, and timestamps verification after all probes", async () => {
    let active = 0;
    let maximumActive = 0;
    let clock = Date.parse("2026-07-27T04:45:00.000Z");
    const bindings = Array.from({ length: 5 }, (_, index) => ({
      canonicalSessionUri: `codex://threads/thread-${index}`,
      providerId: "codex" as const,
      happierSessionId: `happier-${index}`,
      serverProfileId: "server-1",
      machineId: `machine-${index}`,
    }));
    const open = vi.fn(async ({ happierSessionId }: { happierSessionId: string }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      return {
        listTools: async () => {
          if (happierSessionId === "happier-3") throw new Error("unavailable");
          return [{ name: "session_status_get" }, { name: "session_history_get" }];
        },
        callTool: vi.fn(),
        close: async () => {
          active -= 1;
        },
      };
    });

    const result = await probeHappierBindingCapabilities(bindings, open, {
      concurrency: 2,
      now: () => new Date(clock++).toISOString(),
      monotonicNow: (() => {
        let value = 100;
        return () => value++;
      })(),
    });

    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(open).toHaveBeenCalledTimes(5);
    expect(result.availableTools).toEqual(new Set());
    expect(result.samples).toHaveLength(5);
    expect(result.samples.filter((sample) => sample.state === "available")).toHaveLength(4);
    expect(result.samples.filter((sample) => sample.state === "unavailable")).toHaveLength(1);
    expect(result.samples.every((sample) =>
      Date.parse(sample.sampledAt) <= Date.parse(result.verifiedAt)
      && sample.latencyMs >= 0)).toBe(true);
  });
});

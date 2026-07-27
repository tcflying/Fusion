import { describe, expect, it, vi } from "vitest";

import { resumeHappierSessionStrictly } from "../strict-resume.js";
import type { HappierResumeProcessLease } from "../cli-spawn.js";
import type { HappierStopIdentity } from "../stop-state-store.js";
import type { HappierCliSettings } from "../types.js";

const SETTINGS: HappierCliSettings = {
  executable: "happier",
  connectTimeoutMs: 5_000,
};

function exactIdentity(
  overrides: Partial<HappierStopIdentity> = {},
): HappierStopIdentity {
  return Object.freeze({
    keyHash: "a".repeat(64),
    happierSessionId: "happier-session-1",
    serverProfileId: "server-1",
    machineId: "machine-1",
    providerId: "codex",
    providerSessionId: "provider-thread-1",
    canonicalSessionUri: "codex://threads/provider-thread-1",
    ...overrides,
  });
}

describe("strict Happier resume", () => {
  it("returns a resume lease only after exact active-session and binding revalidation", async () => {
    const identity = exactIdentity();
    const lease: HappierResumeProcessLease = {
      sessionId: identity.happierSessionId,
      pid: 42,
      stop: vi.fn(async () => true),
    };
    const startResumeProcess = vi.fn(async () => lease);
    const getStatus = vi.fn(async () => ({
      sessionId: identity.happierSessionId,
      session: {
        id: identity.happierSessionId,
        active: true,
      },
    }));
    const readCurrentIdentity = vi.fn(async () => identity);

    await expect(
      resumeHappierSessionStrictly(
        {
          expectedIdentity: identity,
          settings: SETTINGS,
          readCurrentIdentity,
        },
        {
          startResumeProcess,
          getStatus,
          delay: vi.fn(async () => undefined),
        },
      ),
    ).resolves.toBe(lease);

    expect(startResumeProcess).toHaveBeenCalledTimes(1);
    expect(startResumeProcess).toHaveBeenCalledWith(
      identity.happierSessionId,
      SETTINGS,
      undefined,
    );
    expect(getStatus).toHaveBeenCalledWith(
      identity.happierSessionId,
      SETTINGS,
      undefined,
    );
    expect(readCurrentIdentity).toHaveBeenCalledTimes(2);
    expect(lease.stop).not.toHaveBeenCalled();
  });
});

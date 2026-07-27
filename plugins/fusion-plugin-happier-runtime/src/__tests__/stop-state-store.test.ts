import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildHappierStopIdentity,
  createHappierStopStateStore,
} from "../stop-state-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("Happier durable stop state", () => {
  it("persists exact session identity with recovering stop_unconfirmed state across store instances", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".happier-stop-state-test-"));
    temporaryDirectories.push(directory);
    const identity = buildHappierStopIdentity({
      bindingKey: "fusion-cli-session-secret-owner",
      happierSessionId: "hp_session_1",
      backend: "codex",
      binding: {
        canonicalSessionUri: "codex://threads/019f5569-6e91-7eb2-9460-5c1ccc32a8a7",
        happierSessionId: "hp_session_1",
        serverProfileId: "srv_local",
        machineId: "machine_windows_1",
      },
    });
    const first = createHappierStopStateStore({ directory });

    await first.write({
      contractVersion: 1,
      ...identity,
      state: "stop_requested",
      reasonCode: null,
      updatedAt: "2026-07-27T16:02:59.000Z",
    });
    await first.write({
      contractVersion: 1,
      ...identity,
      state: "recovering",
      reasonCode: "stop_unconfirmed",
      updatedAt: "2026-07-27T16:03:00.000Z",
    });

    const second = createHappierStopStateStore({ directory });
    await expect(second.read(identity.keyHash)).resolves.toEqual({
      contractVersion: 1,
      ...identity,
      state: "recovering",
      reasonCode: "stop_unconfirmed",
      updatedAt: "2026-07-27T16:03:00.000Z",
    });
    expect(identity).toMatchObject({
      happierSessionId: "hp_session_1",
      serverProfileId: "srv_local",
      machineId: "machine_windows_1",
      providerId: "codex",
      providerSessionId: "019f5569-6e91-7eb2-9460-5c1ccc32a8a7",
    });
    expect(JSON.stringify(identity)).not.toContain("fusion-cli-session-secret-owner");
  });
});

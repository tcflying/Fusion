import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createHappierDeliveryFenceStore,
  type HappierDeliveryFenceInput,
} from "../delivery-fence-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    force: true,
    recursive: true,
  })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "fusion-happier-delivery-fence-"));
  temporaryDirectories.push(directory);
  const input: HappierDeliveryFenceInput = {
    canonicalSessionUri: "codex://threads/thread-1",
    providerId: "codex",
    nativeSessionId: "thread-1",
    happierSessionId: "happier-1",
    serverProfileId: "server-1",
    machineId: "machine-1",
    localMessageId: "local-1",
    contentHash: `sha256:${"a".repeat(64)}`,
  };
  return { directory, input };
}

describe("Happier delivery fence store", () => {
  it("persists pending localId/contentHash authority across connector restarts", async () => {
    const value = await fixture();
    const first = createHappierDeliveryFenceStore({
      directory: value.directory,
      now: () => "2026-07-27T04:25:00.000Z",
    });
    const restarted = createHappierDeliveryFenceStore({
      directory: value.directory,
      now: () => "2026-07-27T04:26:00.000Z",
    });

    await expect(first.reserve(value.input)).resolves.toMatchObject({ state: "created" });
    await expect(restarted.reserve(value.input)).resolves.toMatchObject({
      state: "pending",
      record: {
        localMessageId: "local-1",
        contentHash: value.input.contentHash,
      },
    });
    await expect(restarted.reserve({
      ...value.input,
      contentHash: `sha256:${"b".repeat(64)}`,
    })).resolves.toMatchObject({ state: "conflict" });
  });

  it("replays the exact confirmed receipt without reopening transport", async () => {
    const value = await fixture();
    const first = createHappierDeliveryFenceStore({ directory: value.directory });
    const restarted = createHappierDeliveryFenceStore({ directory: value.directory });
    const reserved = await first.reserve(value.input);
    expect(reserved.state).toBe("created");
    const receipt = {
      outcome: "confirmed" as const,
      connectorAcknowledgementId: "happier-receipt:abc",
      nativeMessageId: "native-1",
      cursor: null,
      acceptedAt: "2026-07-27T04:25:01.000Z",
    };

    await expect(first.confirm(value.input, receipt)).resolves.toMatchObject({
      state: "confirmed",
      record: { receipt },
    });
    await expect(restarted.reserve(value.input)).resolves.toMatchObject({
      state: "confirmed",
      record: { receipt },
    });
  });
});

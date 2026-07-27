import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildHappierCreateIntentIdentity,
  createHappierCreateIntentStore,
} from "../create-intent-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

describe("Happier durable create intents", () => {
  it("persists a stable tag and crash-recovery record before another store instance reads it", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".happier-create-intent-test-"));
    temporaryDirectories.push(directory);
    const identity = buildHappierCreateIntentIdentity({
      bindingKey: "sensitive-binding-key",
      cwd: "G:\\fusion\\task",
      backend: "codex",
    });
    const first = createHappierCreateIntentStore({ directory });

    await first.write({
      contractVersion: 1,
      keyHash: identity.keyHash,
      tag: identity.tag,
      cwd: identity.cwd,
      backend: identity.backend,
      state: "pending_create",
      candidateSessionIds: [],
      canonicalSessionId: null,
      cleanupSessionIds: [],
      updatedAt: "2026-07-27T03:25:00.000Z",
    });

    const second = createHappierCreateIntentStore({ directory });
    await expect(second.read(identity.keyHash)).resolves.toMatchObject({
      keyHash: identity.keyHash,
      tag: expect.stringMatching(/^fusion-happier-v1-[a-f0-9]{32}$/u),
      cwd: identity.cwd,
      backend: "codex",
      state: "pending_create",
      candidateSessionIds: [],
    });
    const persisted = await readFile(join(directory, `${identity.keyHash}.json`), "utf8");
    expect(persisted).not.toContain("sensitive-binding-key");
  });

  it("fails closed on a corrupt or identity-mismatched intent instead of treating it as absent", async () => {
    const directory = await mkdtemp(join(process.cwd(), ".happier-create-intent-test-"));
    temporaryDirectories.push(directory);
    const store = createHappierCreateIntentStore({ directory });
    const identity = buildHappierCreateIntentIdentity({
      bindingKey: "binding-corrupt",
      cwd: "G:\\fusion\\task",
      backend: "codex",
    });
    await store.write({
      contractVersion: 1,
      keyHash: identity.keyHash,
      tag: identity.tag,
      cwd: identity.cwd,
      backend: identity.backend,
      state: "pending_create",
      candidateSessionIds: [],
      canonicalSessionId: null,
      cleanupSessionIds: [],
      updatedAt: "2026-07-27T03:25:00.000Z",
    });

    await expect(store.read("0".repeat(64))).resolves.toBeNull();
    await expect(store.read(identity.keyHash.slice(1).padEnd(64, "0"))).resolves.toBeNull();
    await expect(store.read("../escape")).rejects.toThrow(/intent key hash is invalid/u);
  });
});

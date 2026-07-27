import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createHappierApprovalStateStore,
  type HappierApprovalStateInput,
} from "../approval-state-store.js";

const temporaryDirectories: string[] = [];
const NOW = "2026-07-27T15:59:00.000Z";
const INPUT: HappierApprovalStateInput = {
  artifactId: "approval-restart-1",
  operation: "session_message_send",
  identity: {
    connectorId: "happier",
    providerId: "codex",
    nativeSessionId: "native-thread-1",
    happierSessionId: "happier-session-1",
    serverProfileId: "server-1",
    machineId: "machine-1",
    hostId: "host-1",
  },
  bindingId: "binding-1",
  logicalMessageId: "logical-1",
  localMessageId: "local-1",
  idempotencyKey: "idempotency-1",
  contentHash: `sha256:${"a".repeat(64)}`,
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

describe("Happier approval state store", () => {
  it("restores a waiting approval with its complete immutable Session identity", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fusion-happier-approval-"));
    temporaryDirectories.push(directory);

    const first = createHappierApprovalStateStore({ directory, now: () => NOW });
    await expect(first.recordWaiting(INPUT)).resolves.toMatchObject({
      state: "waiting_approval",
      artifactId: INPUT.artifactId,
      operation: INPUT.operation,
      identity: INPUT.identity,
    });

    const restarted = createHappierApprovalStateStore({ directory, now: () => NOW });
    await expect(restarted.read(INPUT)).resolves.toMatchObject({
      state: "waiting_approval",
      artifactId: INPUT.artifactId,
      operation: INPUT.operation,
      identity: INPUT.identity,
      bindingId: INPUT.bindingId,
      logicalMessageId: INPUT.logicalMessageId,
      localMessageId: INPUT.localMessageId,
      idempotencyKey: INPUT.idempotencyKey,
      contentHash: INPUT.contentHash,
    });
  });

  it("restores the exact reconciled provider receipt after approval execution", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fusion-happier-approval-"));
    temporaryDirectories.push(directory);
    const receipt = {
      outcome: "confirmed" as const,
      connectorAcknowledgementId: "happier:happier-session-1:local-1",
      nativeMessageId: "native-message-1",
      cursor: "cursor-1",
      acceptedAt: NOW,
    };

    const first = createHappierApprovalStateStore({ directory, now: () => NOW });
    await first.recordWaiting(INPUT);
    await expect(first.markReconciled(INPUT, receipt)).resolves.toMatchObject({
      state: "reconciled",
      receipt,
    });

    const restarted = createHappierApprovalStateStore({ directory, now: () => NOW });
    await expect(restarted.read(INPUT)).resolves.toMatchObject({
      state: "reconciled",
      receipt,
    });
  });
});

import { writeFileSync } from "node:fs";

import { dispatchRoomDelivery } from "../../room-delivery-coordinator.js";
import { SessionConnectorRegistry } from "../../session-connector-registry.js";
import { AsyncRoomLeaseStore } from "../../../../core/src/async-room-lease-store.js";
import { AsyncRoomStore } from "../../../../core/src/async-room-store.js";
import { createConnectionSetFromUrl } from "../../../../core/src/postgres/connection.js";
import type { ResolvedBackend } from "../../../../core/src/postgres/backend-resolver.js";
import { createAsyncDataLayer } from "../../../../core/src/postgres/data-layer.js";
import {
  connectorIdentityFromBinding,
  createFileBackedRoomConnectorDouble,
} from "../../../../core/src/__tests__/postgres/fixtures/file-backed-room-connector.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing environment variable ${name}`);
  return value;
}

async function main(): Promise<void> {
  const dbUrl = requireEnv("FUSION_ROOM_CRASH_DB_URL");
  const projectId = requireEnv("FUSION_ROOM_CRASH_PROJECT_ID");
  const roomId = requireEnv("FUSION_ROOM_CRASH_ROOM_ID");
  const bindingId = requireEnv("FUSION_ROOM_CRASH_BINDING_ID");
  const outboxId = requireEnv("FUSION_ROOM_CRASH_OUTBOX_ID");
  const content = requireEnv("FUSION_ROOM_CRASH_CONTENT");
  const connectorId = requireEnv("FUSION_ROOM_CRASH_CONNECTOR_ID");
  const stateFilePath = requireEnv("FUSION_ROOM_CRASH_STATE_FILE");
  const markerFilePath = requireEnv("FUSION_ROOM_CRASH_MARKER_FILE");
  const hostId = requireEnv("FUSION_ROOM_CRASH_HOST_ID");
  const now = requireEnv("FUSION_ROOM_CRASH_NOW");
  const expiresAt = requireEnv("FUSION_ROOM_CRASH_EXPIRES_AT");
  const backend = {
    mode: "external",
    runtimeUrl: dbUrl,
    migrationUrl: dbUrl,
    migrationUrlOverridden: false,
  } satisfies ResolvedBackend;

  const connections = await createConnectionSetFromUrl(backend, { poolMax: 4 });
  try {
    const layer = createAsyncDataLayer(connections, { projectId });
    const roomStore = new AsyncRoomStore(layer);
    const leaseStore = new AsyncRoomLeaseStore(layer);
    const workerLease = await leaseStore.acquireLease({
      leaseId: `lease-room-worker-child-${roomId}`,
      roomId,
      kind: "room_worker",
      resourceId: roomId,
      holderId: `room-worker-child-${roomId}`,
      hostId,
      expectedEpoch: null,
      now,
      expiresAt,
    });
    const senderLease = await leaseStore.acquireLease({
      leaseId: `lease-sender-child-${bindingId}`,
      roomId,
      kind: "sender",
      resourceId: bindingId,
      holderId: `room-worker-child-${roomId}`,
      hostId,
      expectedEpoch: null,
      now,
      expiresAt,
    });
    if (!workerLease.ok || !senderLease.ok) {
      throw new Error("Child process could not claim Room worker/sender leases");
    }

    const binding = await roomStore.getBinding(bindingId);
    if (!binding) throw new Error(`Missing Room binding ${bindingId}`);
    const registry = new SessionConnectorRegistry({ now: () => Date.parse(now) });
    registry.register(createFileBackedRoomConnectorDouble({
      connectorId,
      stateFilePath,
      checkedAt: now,
    }));

    await dispatchRoomDelivery({
      store: {
        getDelivery: (targetOutboxId) => roomStore.getDelivery(targetOutboxId),
        getBinding: (targetBindingId) => roomStore.getBinding(targetBindingId),
        beginDeliveryAttempt: (input) => roomStore.beginDeliveryAttempt(input),
        completeDeliveryAttempt: async () => {
          writeFileSync(markerFilePath, "after-external-send-before-ack", "utf8");
          await new Promise<void>(() => undefined);
          throw new Error("unreachable");
        },
        reconcileDelivery: (input) => roomStore.reconcileDelivery(input),
      },
      registry,
      identity: connectorIdentityFromBinding({
        connectorId: binding.connectorId,
        providerId: binding.providerId,
        nativeSessionId: binding.nativeSessionId,
        happierSessionId: binding.happierSessionId,
        serverProfileId: binding.serverProfileId,
        machineId: binding.machineId,
        hostId: binding.hostId,
      }),
      outboxId,
      attemptId: `attempt-child-${outboxId}`,
      senderFence: {
        leaseId: senderLease.lease.id,
        roomId: senderLease.lease.roomId,
        kind: "sender",
        resourceId: senderLease.lease.resourceId,
        holderId: senderLease.lease.holderId,
        hostId: senderLease.lease.hostId,
        expectedEpoch: senderLease.lease.epoch,
      },
      content,
      reconciliationFromCursor: null,
      now,
      audit: {
        runId: `room-child-dispatch:${roomId}`,
        agentId: workerLease.lease.holderId,
      },
    });
  } finally {
    await connections.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

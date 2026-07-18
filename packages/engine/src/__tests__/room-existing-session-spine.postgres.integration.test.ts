import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AsyncRoomStore,
  SESSION_CONNECTOR_CAPABILITIES,
  applySchemaBaseline,
  createAsyncDataLayer,
  createConnectionSetFromUrl,
  hashRoomValue,
  type SessionConnectorCapabilitiesV1,
  type SessionConnectorCapabilityName,
  type SessionConnectorCapabilityState,
  type SessionConnectorHealthV1,
  type SessionConnectorIdentityV1,
  type SessionConnectorResultV1,
  type SessionConnectorV1,
} from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import { EmbeddedPostgresLifecycle } from "../../../core/src/postgres/embedded-lifecycle.js";
import { roomInboxReceipts } from "../../../core/src/postgres/schema/room.js";
import { RoomExistingSessionSpine } from "../room-existing-session-spine.js";
import { SessionConnectorRegistry } from "../session-connector-registry.js";

const NOW = "2026-07-18T02:57:00.000Z";
const PROJECT_ID = "project-existing-session-spine-pg";
const ROOM_ID = "room-existing-session-spine-pg";
const CONNECTOR_ID = "deterministic-existing-session-pg";
const EMBEDDED_DATABASE_TIMEOUT_MS = 60_000;

const SESSIONS = [
  {
    seatId: "seat-codex-pg",
    bindingId: "binding-codex-pg",
    role: "producer",
    canonicalSessionUri: "codex://threads/existing-pg-1",
    identity: {
      connectorId: CONNECTOR_ID,
      providerId: "codex",
      nativeSessionId: "existing-pg-1",
      happierSessionId: "happier-existing-pg-1",
      serverProfileId: "server-existing-pg",
      machineId: "machine-existing-pg",
      hostId: "host-existing-pg",
    },
  },
  {
    seatId: "seat-claude-pg",
    bindingId: "binding-claude-pg",
    role: "reviewer",
    canonicalSessionUri: "claude://sessions/existing-pg-2",
    identity: {
      connectorId: CONNECTOR_ID,
      providerId: "claude",
      nativeSessionId: "existing-pg-2",
      happierSessionId: "happier-existing-pg-2",
      serverProfileId: "server-existing-pg",
      machineId: "machine-existing-pg",
      hostId: "host-existing-pg",
    },
  },
] as const satisfies readonly {
  readonly seatId: string;
  readonly bindingId: string;
  readonly role: string;
  readonly canonicalSessionUri: string;
  readonly identity: SessionConnectorIdentityV1;
}[];

function ok<T>(value: T): SessionConnectorResultV1<T> {
  return { ok: true, value };
}

function unavailable(message: string): SessionConnectorResultV1<never> {
  return {
    ok: false,
    error: { code: "unavailable", message, retryable: false },
  };
}

function capabilityState(name: SessionConnectorCapabilityName): SessionConnectorCapabilityState {
  return name === "ensureExisting" || name === "history" ? "verified" : "unavailable";
}

function capabilities(): SessionConnectorCapabilitiesV1 {
  const entries = Object.fromEntries(SESSION_CONNECTOR_CAPABILITIES.map((name) => {
    const state = capabilityState(name);
    return [name, {
      state,
      evidenceRef: state === "verified" ? `deterministic-pg://${name}` : null,
      reasonCode: state === "verified" ? null : "operation_unavailable",
      lastVerifiedAt: state === "verified" ? NOW : null,
    }];
  })) as SessionConnectorCapabilitiesV1["capabilities"];
  return {
    contractVersion: 1,
    connectorId: CONNECTOR_ID,
    connectorVersion: "deterministic-pg-v1",
    sourceRevision: "test-double-not-live-provider",
    verifiedAt: NOW,
    capabilities: entries,
  };
}

function healthCapabilities(): SessionConnectorHealthV1["capabilities"] {
  return Object.fromEntries(SESSION_CONNECTOR_CAPABILITIES.map((name) => [
    name,
    capabilityState(name),
  ])) as SessionConnectorHealthV1["capabilities"];
}

function createDeterministicConnector(): SessionConnectorV1 {
  const identities = new Map(SESSIONS.map((session) => [
    session.canonicalSessionUri,
    session.identity,
  ]));
  return {
    contractVersion: 1,
    id: CONNECTOR_ID,
    version: "deterministic-pg-v1",
    getCapabilities: vi.fn(async () => capabilities()),
    ensureExisting: vi.fn(async (input) => {
      const identity = identities.get(input.canonicalSessionUri);
      if (!identity) return unavailable("Unknown deterministic existing Session");
      return ok({
        identity,
        createdLink: false,
        providerTurnStarted: false,
        attachedAt: NOW,
        capabilities: capabilities(),
      });
    }),
    create: vi.fn(async () => unavailable("Provider Session creation is forbidden")),
    getStatus: vi.fn(async () => unavailable("Status is not needed by this fixture")),
    readHistory: vi.fn(async (input) => {
      const cursor = `cursor-${input.identity.nativeSessionId}`;
      if (input.afterCursor === cursor) {
        return ok({
          items: [],
          nextCursor: cursor,
          completeThroughCursor: cursor,
          truncated: false,
        });
      }
      return ok({
        items: [{
          nativeMessageId: `native-response-${input.identity.nativeSessionId}`,
          logicalMessageId: null,
          role: "assistant" as const,
          contentHash: hashRoomValue(`response:${input.identity.nativeSessionId}`),
          occurredAt: NOW,
          cursor,
        }],
        nextCursor: cursor,
        completeThroughCursor: cursor,
        truncated: false,
      });
    }),
    subscribeEvents: vi.fn(async () => unavailable("Events are intentionally unavailable")),
    send: vi.fn(async () => unavailable("Provider writes are forbidden in this spine test")),
    interrupt: vi.fn(async () => unavailable("Provider writes are forbidden in this spine test")),
    resume: vi.fn(async () => unavailable("Provider writes are forbidden in this spine test")),
    takeover: vi.fn(async () => unavailable("Provider writes are forbidden in this spine test")),
    getHealth: vi.fn(async (hostId) => ({
      connectorId: CONNECTOR_ID,
      hostId,
      state: "healthy",
      checkedAt: NOW,
      authentication: "authenticated",
      daemon: "running",
      server: "reachable",
      backend: "ready",
      rateLimit: "clear",
      host: "reachable",
      capabilities: healthCapabilities(),
      reasonCodes: [],
      retryAfterMs: null,
    })),
    getDeepLinks: vi.fn(async () => unavailable("Deep links are not needed by this fixture")),
  };
}

/*
FNXC:SessionRoomExistingSpine 2026-07-18-10:57:
Task 4.6 needs one Engine integration proof that two exact existing Sessions are
created, restored, and ingested through the real AsyncRoomStore/PostgreSQL path.
The spine may ensure identities and read history, but provider-write methods must
remain untouched because fenced delivery workers own external dispatch.
*/
describe("Room existing-Session spine with real PostgreSQL", () => {
  it("creates, restores, and ingests two exact Sessions without provider writes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "fusion-engine-existing-spine-pg-"));
    const lifecycle = new EmbeddedPostgresLifecycle({
      dataDir,
      database: "fusion",
      user: "postgres",
      password: "password",
    });
    let connections: Awaited<ReturnType<typeof createConnectionSetFromUrl>> | null = null;

    try {
      const backend = await lifecycle.start();
      connections = await createConnectionSetFromUrl(backend, { poolMax: 4 });
      await applySchemaBaseline(connections.migration, { pluginHooks: [] });
      const layer = createAsyncDataLayer(connections, { projectId: PROJECT_ID });
      const connector = createDeterministicConnector();
      const registry = new SessionConnectorRegistry({ now: () => Date.parse(NOW) });
      registry.register(connector);
      const options = {
        projectId: PROJECT_ID,
        connectorRegistry: registry,
        now: () => NOW,
        ingestionLimits: {
          historyPageSize: 10,
          maxHistoryPagesPerReconciliation: 1,
          maxEvents: 1,
          maxStreamReconnects: 0,
          maxDegradedPolls: 0,
        },
      } as const;

      const writerStore = new AsyncRoomStore(layer);
      const writerSpine = new RoomExistingSessionSpine({ ...options, roomStore: writerStore });
      const created = await writerSpine.createRoomWithExistingSessions({
        room: {
          id: ROOM_ID,
          objective: "Continue two exact existing Sessions through PostgreSQL",
          protocolId: "implementation",
          protocolVersion: 1,
        },
        sessions: SESSIONS.map((session) => ({
          seatId: session.seatId,
          bindingId: session.bindingId,
          role: session.role,
          permissionScope: ["room:message"],
          connectorId: CONNECTOR_ID,
          canonicalSessionUri: session.canonicalSessionUri,
          requiredHostId: session.identity.hostId,
          requiredMachineId: session.identity.machineId!,
          idempotencyKey: `ensure:${session.seatId}`,
        })),
      });

      const restoredStore = new AsyncRoomStore(layer);
      const restoredSpine = new RoomExistingSessionSpine({ ...options, roomStore: restoredStore });
      const restored = await restoredSpine.restoreRoom(ROOM_ID);
      expect({
        ...restored,
        seats: restored.seats.toSorted((left, right) => left.id.localeCompare(right.id)),
        bindings: restored.bindings.toSorted((left, right) => left.id.localeCompare(right.id)),
      }).toEqual({
        ...created,
        seats: created.seats.toSorted((left, right) => left.id.localeCompare(right.id)),
        bindings: created.bindings.toSorted((left, right) => left.id.localeCompare(right.id)),
      });
      expect(restored.bindings.map((binding) => ({
        connectorId: binding.connectorId,
        providerId: binding.providerId,
        nativeSessionId: binding.nativeSessionId,
        happierSessionId: binding.happierSessionId,
        serverProfileId: binding.serverProfileId,
        machineId: binding.machineId,
        hostId: binding.hostId,
      })).toSorted((left, right) => left.providerId.localeCompare(right.providerId))).toEqual(
        SESSIONS.map((session) => session.identity)
          .toSorted((left, right) => left.providerId.localeCompare(right.providerId)),
      );

      for (const session of SESSIONS) {
        const result = await restoredSpine.ingestSeat({
          roomId: ROOM_ID,
          seatId: session.seatId,
        });
        expect(result).toMatchObject({
          outcome: "degraded_limit",
          transcriptCursor: `cursor-${session.identity.nativeSessionId}`,
        });
        expect(await restoredStore.getConnectorIngestionState({
          roomId: ROOM_ID,
          bindingId: session.bindingId,
        })).toMatchObject({
          mode: "stopped",
          transcriptCursor: `cursor-${session.identity.nativeSessionId}`,
          lastNativeMessageId: `native-response-${session.identity.nativeSessionId}`,
        });
      }

      const receipts = await layer.db.select().from(roomInboxReceipts);
      expect(receipts.map((receipt) => ({
        bindingId: receipt.bindingId,
        nativeMessageId: receipt.nativeMessageId,
        nativeCursor: receipt.nativeCursor,
        source: receipt.source,
      })).toSorted((left, right) => left.bindingId.localeCompare(right.bindingId))).toEqual(
        SESSIONS.map((session) => ({
          bindingId: session.bindingId,
          nativeMessageId: `native-response-${session.identity.nativeSessionId}`,
          nativeCursor: `cursor-${session.identity.nativeSessionId}`,
          source: "history",
        })).toSorted((left, right) => left.bindingId.localeCompare(right.bindingId)),
      );
      expect(connector.ensureExisting).toHaveBeenCalledTimes(2);
      expect(connector.create).not.toHaveBeenCalled();
      expect(connector.send).not.toHaveBeenCalled();
      expect(connector.interrupt).not.toHaveBeenCalled();
      expect(connector.resume).not.toHaveBeenCalled();
      expect(connector.takeover).not.toHaveBeenCalled();
    } finally {
      await connections?.close();
      await lifecycle.stop();
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, EMBEDDED_DATABASE_TIMEOUT_MS);
});

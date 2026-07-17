import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AsyncRoomStore } from "../../async-room-store.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import {
  roomBindings,
  roomInboxReceipts,
  roomSeats,
} from "../../postgres/schema/room.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const contexts: EmbeddedTestContext[] = [];

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-connector-ingestion-"));
  const lifecycle = new EmbeddedPostgresLifecycle({
    dataDir,
    database: "fusion",
    user: "postgres",
    password: "password",
  });
  const backend = await lifecycle.start();
  const context = {
    dataDir,
    lifecycle,
    connections: await createConnectionSetFromUrl(backend, { poolMax: 4 }),
  } satisfies EmbeddedTestContext;
  contexts.push(context);
  await applySchemaBaseline(context.connections.migration, { pluginHooks: [] });
  return context;
}

afterEach(async () => {
  while (contexts.length > 0) {
    const context = contexts.pop();
    if (!context) continue;
    if (context.connections) {
      await context.connections.close();
      context.connections = null;
    }
    await context.lifecycle.stop();
    rmSync(context.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("Room connector transcript ingestion", () => {
  it("persists cursors, detects gaps, and deduplicates by native id with hash fallback", async () => {
    const context = await startEmbeddedDatabase();
    const layer = createAsyncDataLayer(context.connections!, { projectId: "project-1" });
    const store = new AsyncRoomStore(layer);
    const created = await store.createRoom({
      id: "room-ingestion-1",
      projectId: "project-1",
      objective: "Ingest one native Session without cursor gaps",
      protocolId: "implementation",
      protocolVersion: 1,
      now: "2026-07-17T06:00:00.000Z",
    }, {
      eventId: "event-ingestion-room-created",
      actorType: "system",
      actorId: "room-worker-1",
      correlationId: "correlation-ingestion-room-created",
      causationId: null,
      occurredAt: "2026-07-17T06:00:00.000Z",
    });
    await layer.db.insert(roomSeats).values({
      id: "seat-ingestion-1",
      projectId: "project-1",
      roomId: created.room.id,
      role: "producer",
      roleVersion: 1,
      roleHistory: [],
      permissionScope: ["room:message"],
      state: "active",
      activeBindingId: "binding-ingestion-1",
      createdAt: "2026-07-17T06:00:00.000Z",
      updatedAt: "2026-07-17T06:00:00.000Z",
    });
    await layer.db.insert(roomBindings).values({
      id: "binding-ingestion-1",
      projectId: "project-1",
      roomId: created.room.id,
      seatId: "seat-ingestion-1",
      generation: 1,
      connectorId: "happier",
      providerId: "codex",
      nativeSessionId: "codex-thread-ingestion-1",
      happierSessionId: "happier-session-ingestion-1",
      serverProfileId: "server-1",
      hostId: "windows-host-1",
      state: "attached",
      attachedAt: "2026-07-17T06:00:00.000Z",
    });

    expect(await store.getConnectorIngestionState({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
    })).toMatchObject({
      mode: "starting",
      transcriptCursor: null,
      statusCursor: null,
      lastNativeMessageId: null,
    });

    const first = await store.recordConnectorTranscriptBatch({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      source: "history",
      fromCursor: null,
      nextCursor: "cursor-2",
      truncated: false,
      modeAfterCommit: "streaming",
      receivedAt: "2026-07-17T06:01:00.000Z",
      items: [
        {
          nativeMessageId: "native-message-1",
          logicalMessageId: null,
          nativeCursor: "cursor-1",
          payloadHash: "sha256:payload-1",
          role: "user",
          occurredAt: "2026-07-17T06:00:10.000Z",
        },
        {
          nativeMessageId: "native-message-2",
          logicalMessageId: "fusion-room-local-2",
          nativeCursor: "cursor-2",
          payloadHash: "sha256:payload-2",
          role: "assistant",
          occurredAt: "2026-07-17T06:00:20.000Z",
        },
      ],
    });
    expect(first).toMatchObject({
      insertedCount: 2,
      duplicateCount: 0,
      gapDetected: false,
      state: { mode: "streaming", transcriptCursor: "cursor-2" },
    });

    const completeReplay = await store.recordConnectorTranscriptBatch({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      source: "history",
      fromCursor: null,
      nextCursor: "cursor-2",
      truncated: false,
      modeAfterCommit: "streaming",
      receivedAt: "2026-07-17T06:01:10.000Z",
      items: [
        {
          nativeMessageId: "native-message-1",
          logicalMessageId: null,
          nativeCursor: "cursor-1",
          payloadHash: "sha256:payload-1",
          role: "user",
          occurredAt: "2026-07-17T06:00:10.000Z",
        },
        {
          nativeMessageId: "native-message-2",
          logicalMessageId: "fusion-room-local-2",
          nativeCursor: "cursor-2",
          payloadHash: "sha256:payload-2",
          role: "assistant",
          occurredAt: "2026-07-17T06:00:20.000Z",
        },
      ],
    });
    expect(completeReplay).toMatchObject({
      insertedCount: 0,
      duplicateCount: 2,
      duplicateNativeMessageIdCount: 2,
      gapDetected: false,
      state: { transcriptCursor: "cursor-2" },
    });

    await expect(store.recordConnectorTranscriptBatch({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      source: "history",
      fromCursor: "cursor-2",
      nextCursor: "cursor-arbitrary-empty-advance",
      truncated: false,
      modeAfterCommit: "streaming",
      receivedAt: "2026-07-17T06:01:20.000Z",
      items: [],
    })).rejects.toMatchObject({ code: "connector_batch_invalid" });
    await expect(store.recordConnectorTranscriptBatch({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      source: "history",
      fromCursor: "cursor-2",
      nextCursor: "cursor-truncated-empty-advance",
      truncated: true,
      modeAfterCommit: "reconciling",
      receivedAt: "2026-07-17T06:01:20.500Z",
      items: [],
    })).rejects.toMatchObject({ code: "connector_batch_invalid" });
    await expect(store.recordConnectorTranscriptBatch({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      source: "event",
      fromCursor: "cursor-2",
      nextCursor: "cursor-2",
      truncated: false,
      modeAfterCommit: "streaming",
      receivedAt: "2026-07-17T06:01:21.000Z",
      items: [{
        nativeMessageId: "native-message-without-cursor-advance",
        logicalMessageId: null,
        nativeCursor: "cursor-hidden-new-message",
        payloadHash: "sha256:hidden-new-message",
        role: "assistant",
        occurredAt: "2026-07-17T06:01:20.000Z",
      }],
    })).rejects.toMatchObject({ code: "connector_batch_invalid" });
    await expect(store.recordConnectorTranscriptBatch({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      source: "history",
      fromCursor: "cursor-2",
      nextCursor: "cursor-middle",
      truncated: false,
      modeAfterCommit: "streaming",
      receivedAt: "2026-07-17T06:01:22.000Z",
      items: [
        {
          nativeMessageId: "native-message-middle",
          logicalMessageId: null,
          nativeCursor: "cursor-middle",
          payloadHash: "sha256:payload-middle",
          role: "assistant",
          occurredAt: "2026-07-17T06:01:21.000Z",
        },
        {
          nativeMessageId: "native-message-after-middle",
          logicalMessageId: null,
          nativeCursor: "cursor-after-middle",
          payloadHash: "sha256:payload-after-middle",
          role: "assistant",
          occurredAt: "2026-07-17T06:01:22.000Z",
        },
      ],
    })).rejects.toMatchObject({ code: "connector_batch_invalid" });

    const overlap = await store.recordConnectorTranscriptBatch({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      source: "history",
      fromCursor: "cursor-2",
      nextCursor: "cursor-3",
      truncated: false,
      modeAfterCommit: "streaming",
      receivedAt: "2026-07-17T06:02:00.000Z",
      items: [
        {
          nativeMessageId: "native-message-2",
          logicalMessageId: "fusion-room-local-2",
          nativeCursor: "cursor-2-overlap",
          payloadHash: "sha256:payload-2",
          role: "assistant",
          occurredAt: "2026-07-17T06:00:20.000Z",
        },
        {
          nativeMessageId: null,
          logicalMessageId: null,
          nativeCursor: "cursor-3",
          payloadHash: "sha256:payload-without-native-id",
          role: "tool",
          occurredAt: "2026-07-17T06:00:30.000Z",
        },
      ],
    });
    expect(overlap).toMatchObject({
      insertedCount: 1,
      duplicateCount: 1,
      duplicateNativeMessageIdCount: 1,
      duplicatePayloadHashCount: 0,
      gapDetected: false,
      state: { transcriptCursor: "cursor-3" },
    });

    const hashReplay = await store.recordConnectorTranscriptBatch({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      source: "history",
      fromCursor: "cursor-3",
      nextCursor: "cursor-3",
      truncated: false,
      modeAfterCommit: "streaming",
      receivedAt: "2026-07-17T06:02:30.000Z",
      items: [{
        nativeMessageId: null,
        logicalMessageId: null,
        nativeCursor: "cursor-3-replay",
        payloadHash: "sha256:payload-without-native-id",
        role: "tool",
        occurredAt: "2026-07-17T06:00:30.000Z",
      }],
    });
    expect(hashReplay).toMatchObject({
      insertedCount: 0,
      duplicateCount: 1,
      duplicateNativeMessageIdCount: 0,
      duplicatePayloadHashCount: 1,
    });

    const fallbackLogicalEnrichment = await store.recordConnectorTranscriptBatch({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      source: "event",
      fromCursor: "cursor-3",
      nextCursor: "cursor-3",
      truncated: false,
      modeAfterCommit: "streaming",
      receivedAt: "2026-07-17T06:02:35.000Z",
      items: [{
        nativeMessageId: null,
        logicalMessageId: "logical-fallback-a",
        nativeCursor: "cursor-3-enrichment",
        payloadHash: "sha256:payload-without-native-id",
        role: "tool",
        occurredAt: "2026-07-17T06:00:30.000Z",
      }],
    });
    expect(fallbackLogicalEnrichment).toMatchObject({
      insertedCount: 0,
      duplicatePayloadHashCount: 1,
      gapDetected: false,
    });
    await expect(store.recordConnectorTranscriptBatch({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      source: "event",
      fromCursor: "cursor-3",
      nextCursor: "cursor-3",
      truncated: false,
      modeAfterCommit: "streaming",
      receivedAt: "2026-07-17T06:02:36.000Z",
      items: [{
        nativeMessageId: null,
        logicalMessageId: "logical-fallback-b",
        nativeCursor: "cursor-3-conflicting-logical-id",
        payloadHash: "sha256:payload-without-native-id",
        role: "tool",
        occurredAt: "2026-07-17T06:00:30.000Z",
      }],
    })).rejects.toMatchObject({ code: "inbox_payload_conflict" });
    await expect(store.recordConnectorTranscriptBatch({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      source: "history",
      fromCursor: "cursor-3",
      nextCursor: "cursor-logical-conflict",
      truncated: false,
      modeAfterCommit: "streaming",
      receivedAt: "2026-07-17T06:02:37.000Z",
      items: [{
        nativeMessageId: null,
        logicalMessageId: "logical-fallback-a",
        nativeCursor: "cursor-logical-conflict",
        payloadHash: "sha256:different-payload-for-same-logical-id",
        role: "assistant",
        occurredAt: "2026-07-17T06:00:37.000Z",
      }],
    })).rejects.toMatchObject({ code: "inbox_payload_conflict" });

    await expect(store.recordConnectorTranscriptBatch({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      source: "history",
      fromCursor: "cursor-3",
      nextCursor: "cursor-3",
      truncated: false,
      modeAfterCommit: "streaming",
      receivedAt: "2026-07-17T06:02:40.000Z",
      items: [{
        nativeMessageId: "native-message-2",
        logicalMessageId: "fusion-room-local-2",
        nativeCursor: "cursor-conflicting-native-id",
        payloadHash: "sha256:conflicting-payload",
        role: "assistant",
        occurredAt: "2026-07-17T06:00:20.000Z",
      }],
    })).rejects.toMatchObject({ code: "inbox_payload_conflict" });

    const gap = await store.recordConnectorTranscriptBatch({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      source: "event",
      fromCursor: "cursor-1",
      nextCursor: "cursor-4",
      truncated: false,
      modeAfterCommit: "streaming",
      receivedAt: "2026-07-17T06:03:00.000Z",
      items: [{
        nativeMessageId: "native-message-4",
        logicalMessageId: null,
        nativeCursor: "cursor-4",
        payloadHash: "sha256:payload-4",
        role: "assistant",
        occurredAt: "2026-07-17T06:00:40.000Z",
      }],
    });
    expect(gap).toMatchObject({
      insertedCount: 0,
      duplicateCount: 0,
      gapDetected: true,
      state: {
        mode: "reconciling",
        transcriptCursor: "cursor-3",
        gapExpectedCursor: "cursor-3",
        gapObservedCursor: "cursor-1",
      },
    });

    const prematureEvent = await store.recordConnectorTranscriptBatch({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      source: "event",
      fromCursor: "cursor-3",
      nextCursor: "cursor-3",
      truncated: false,
      modeAfterCommit: "streaming",
      receivedAt: "2026-07-17T06:03:30.000Z",
      items: [],
    });
    expect(prematureEvent).toMatchObject({
      insertedCount: 0,
      gapDetected: true,
      state: {
        mode: "reconciling",
        transcriptCursor: "cursor-3",
        gapExpectedCursor: "cursor-3",
        gapObservedCursor: "cursor-1",
      },
    });

    const completeReplayRepair = await store.recordConnectorTranscriptBatch({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      source: "history",
      fromCursor: "cursor-3",
      nextCursor: "cursor-3",
      truncated: false,
      modeAfterCommit: "streaming",
      receivedAt: "2026-07-17T06:03:40.000Z",
      items: [{
        nativeMessageId: null,
        logicalMessageId: "logical-fallback-a",
        nativeCursor: "cursor-3",
        payloadHash: "sha256:payload-without-native-id",
        role: "tool",
        occurredAt: "2026-07-17T06:00:30.000Z",
      }],
    });
    expect(completeReplayRepair).toMatchObject({
      insertedCount: 0,
      duplicateCount: 1,
      gapDetected: false,
      state: {
        mode: "streaming",
        transcriptCursor: "cursor-3",
        gapExpectedCursor: null,
        gapObservedCursor: null,
        gapDetectedAt: null,
      },
    });

    const repaired = await store.recordConnectorTranscriptBatch({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      source: "history",
      fromCursor: "cursor-3",
      nextCursor: "cursor-4",
      truncated: false,
      modeAfterCommit: "streaming",
      receivedAt: "2026-07-17T06:04:00.000Z",
      items: [{
        nativeMessageId: "native-message-4",
        logicalMessageId: null,
        nativeCursor: "cursor-4",
        payloadHash: "sha256:payload-4",
        role: "assistant",
        occurredAt: "2026-07-17T06:00:40.000Z",
      }],
    });
    expect(repaired).toMatchObject({
      insertedCount: 1,
      gapDetected: false,
      state: {
        mode: "streaming",
        transcriptCursor: "cursor-4",
        gapExpectedCursor: null,
        gapObservedCursor: null,
      },
    });

    const truncated = await store.recordConnectorTranscriptBatch({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      source: "history",
      fromCursor: "cursor-4",
      nextCursor: "cursor-5",
      truncated: true,
      modeAfterCommit: "reconciling",
      receivedAt: "2026-07-17T06:05:00.000Z",
      items: [{
        nativeMessageId: "native-message-5",
        logicalMessageId: null,
        nativeCursor: "cursor-5",
        payloadHash: "sha256:payload-5",
        role: "assistant",
        occurredAt: "2026-07-17T06:00:50.000Z",
      }],
    });
    expect(truncated).toMatchObject({
      insertedCount: 1,
      gapDetected: false,
      state: { mode: "reconciling", transcriptCursor: "cursor-5" },
    });

    const degraded = await store.recordConnectorTranscriptBatch({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      source: "history",
      fromCursor: "cursor-5",
      nextCursor: "cursor-5",
      truncated: true,
      modeAfterCommit: "degraded",
      receivedAt: "2026-07-17T06:05:30.000Z",
      items: [],
    });
    expect(degraded).toMatchObject({
      gapDetected: false,
      state: { mode: "degraded", transcriptCursor: "cursor-5" },
    });

    const concurrent = await Promise.all([
      store.recordConnectorTranscriptBatch({
        roomId: created.room.id,
        bindingId: "binding-ingestion-1",
        source: "event",
        fromCursor: "cursor-5",
        nextCursor: "cursor-7a",
        truncated: false,
        modeAfterCommit: "streaming",
        receivedAt: "2026-07-17T06:05:40.000Z",
        items: [{
          nativeMessageId: "native-message-7a",
          logicalMessageId: null,
          nativeCursor: "cursor-7a",
          payloadHash: "sha256:payload-7a",
          role: "assistant",
          occurredAt: "2026-07-17T06:00:57.000Z",
        }],
      }),
      store.recordConnectorTranscriptBatch({
        roomId: created.room.id,
        bindingId: "binding-ingestion-1",
        source: "event",
        fromCursor: "cursor-5",
        nextCursor: "cursor-7b",
        truncated: false,
        modeAfterCommit: "streaming",
        receivedAt: "2026-07-17T06:05:41.000Z",
        items: [{
          nativeMessageId: "native-message-7b",
          logicalMessageId: null,
          nativeCursor: "cursor-7b",
          payloadHash: "sha256:payload-7b",
          role: "assistant",
          occurredAt: "2026-07-17T06:00:58.000Z",
        }],
      }),
    ]);
    expect(concurrent.map((result) => result.insertedCount).sort()).toEqual([0, 1]);
    expect(concurrent.map((result) => result.gapDetected).sort()).toEqual([false, true]);

    const status = await store.recordConnectorStatus({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      state: "waiting_input",
      statusCursor: "status-cursor-7",
      nativeWriterDetected: true,
      occurredAt: "2026-07-17T06:06:00.000Z",
    });
    expect(status).toMatchObject({
      connectorStatus: "waiting_input",
      statusCursor: "status-cursor-7",
      nativeWriterDetected: true,
      lastStatusAt: "2026-07-17T06:06:00.000Z",
    });
    expect(await store.recordConnectorStatus({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      state: "waiting_input",
      statusCursor: "status-cursor-7",
      nativeWriterDetected: true,
      occurredAt: "2026-07-17T06:06:30.000Z",
    })).toEqual(status);
    await expect(store.recordConnectorStatus({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      state: "running",
      statusCursor: "status-cursor-7",
      nativeWriterDetected: true,
      occurredAt: "2026-07-17T06:06:30.000Z",
    })).rejects.toMatchObject({ code: "delivery_state_conflict" });
    expect(await store.recordConnectorStatus({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      state: "running",
      statusCursor: "status-cursor-stale",
      nativeWriterDetected: false,
      occurredAt: "2026-07-17T06:05:59.000Z",
    })).toEqual(status);
    const stopped = await store.recordConnectorIngestionMode({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      mode: "stopped",
      occurredAt: "2026-07-17T06:07:00.000Z",
    });
    expect(stopped).toMatchObject({
      mode: "stopped",
      connectorStatus: "waiting_input",
      statusCursor: "status-cursor-7",
      nativeWriterDetected: true,
    });
    expect(await store.recordConnectorIngestionMode({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      mode: "polling",
      occurredAt: "2026-07-17T06:06:59.000Z",
    })).toEqual(stopped);
    expect(await store.recordConnectorTranscriptBatch({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      source: "event",
      fromCursor: stopped.transcriptCursor,
      nextCursor: stopped.transcriptCursor,
      truncated: false,
      modeAfterCommit: "streaming",
      receivedAt: "2026-07-17T06:06:30.000Z",
      items: [],
    })).toMatchObject({
      state: { mode: "stopped", updatedAt: "2026-07-17T06:07:00.000Z" },
    });
    const newerStatus = await store.recordConnectorStatus({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      state: "idle",
      statusCursor: "status-cursor-8",
      nativeWriterDetected: false,
      occurredAt: "2026-07-17T06:08:00.000Z",
    });
    expect(newerStatus).toMatchObject({
      mode: "stopped",
      lastModeAt: "2026-07-17T06:07:00.000Z",
      lastStatusAt: "2026-07-17T06:08:00.000Z",
      updatedAt: "2026-07-17T06:08:00.000Z",
    });
    expect(await store.recordConnectorIngestionMode({
      roomId: created.room.id,
      bindingId: "binding-ingestion-1",
      mode: "reconciling",
      occurredAt: "2026-07-17T06:07:30.000Z",
    })).toMatchObject({
      mode: "reconciling",
      lastModeAt: "2026-07-17T06:07:30.000Z",
      lastStatusAt: "2026-07-17T06:08:00.000Z",
      updatedAt: "2026-07-17T06:08:00.000Z",
    });
    expect(await layer.db.select().from(roomInboxReceipts)).toHaveLength(6);
  });
});

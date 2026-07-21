import { describe, expect, it, vi } from "vitest";

import {
  RoomSessionConnectorIngestionPersistence,
  type RoomConnectorIngestionStore,
} from "../room-session-connector-ingestion-persistence.js";

const IDENTITY = {
  connectorId: "happier",
  providerId: "codex",
  nativeSessionId: "codex-thread-1",
  happierSessionId: "happier-session-1",
  serverProfileId: "server-1",
  machineId: "machine-1",
  hostId: "windows-host-1",
} as const;

const INITIAL_STATE = {
  contractVersion: 1 as const,
  roomId: "room-1",
  bindingId: "binding-1",
  mode: "starting" as const,
  transcriptCursor: "cursor-5",
  statusCursor: "status-4",
  lastNativeMessageId: "native-5",
  lastPayloadHash: "sha256:5",
  connectorStatus: "idle" as const,
  nativeWriterDetected: false,
  gapExpectedCursor: null,
  gapObservedCursor: null,
  gapDetectedAt: null,
  lastTranscriptAt: "2026-07-17T10:00:00.000Z",
  lastStatusAt: "2026-07-17T10:00:00.000Z",
  lastModeAt: "2026-07-17T10:00:00.000Z",
  updatedAt: "2026-07-17T10:00:00.000Z",
};

function createStore(overrides: Partial<RoomConnectorIngestionStore> = {}) {
  return {
    getConnectorIngestionState: vi.fn(async () => INITIAL_STATE),
    recordConnectorTranscriptBatch: vi.fn(async () => ({
      state: { ...INITIAL_STATE, mode: "streaming" as const, transcriptCursor: "cursor-6" },
      insertedCount: 1,
      duplicateCount: 2,
      duplicateNativeMessageIdCount: 1,
      duplicatePayloadHashCount: 1,
      gapDetected: false,
    })),
    recordConnectorStatus: vi.fn(async () => INITIAL_STATE),
    recordConnectorIngestionMode: vi.fn(async () => INITIAL_STATE),
    ...overrides,
  } satisfies RoomConnectorIngestionStore;
}

describe("Room Session Connector ingestion persistence", () => {
  it("maps provider-neutral checkpoints, transcript hashes, status, and awaited modes to one binding", async () => {
    const store = createStore();
    const persistence = new RoomSessionConnectorIngestionPersistence({
      store,
      roomId: "room-1",
      bindingId: "binding-1",
      identity: IDENTITY,
      now: () => "2026-07-17T10:01:00.000Z",
    });

    await expect(persistence.loadCheckpoint({ identity: IDENTITY })).resolves.toEqual({
      transcriptCursor: "cursor-5",
      statusCursor: "status-4",
    });
    await expect(persistence.persistTranscriptBatch({
      source: "event",
      identity: IDENTITY,
      fromCursor: "cursor-5",
      nextCursor: "cursor-6",
      completeThroughCursor: "cursor-6",
      items: [{
        nativeMessageId: "native-6",
        logicalMessageId: null,
        role: "assistant",
        contentHash: "sha256:6",
        occurredAt: "2026-07-17T10:00:30.000Z",
        cursor: "cursor-6",
      }],
    })).resolves.toEqual({
      committedCursor: "cursor-6",
      insertedCount: 1,
      duplicateNativeMessageIdCount: 1,
      duplicateContentHashCount: 1,
    });
    expect(store.recordConnectorTranscriptBatch).toHaveBeenCalledWith({
      roomId: "room-1",
      bindingId: "binding-1",
      source: "event",
      fromCursor: "cursor-5",
      nextCursor: "cursor-6",
      truncated: false,
      modeAfterCommit: "streaming",
      receivedAt: "2026-07-17T10:01:00.000Z",
      items: [{
        nativeMessageId: "native-6",
        logicalMessageId: null,
        nativeCursor: "cursor-6",
        payloadHash: "sha256:6",
        role: "assistant",
        occurredAt: "2026-07-17T10:00:30.000Z",
      }],
    });

    await persistence.persistStatus({
      identity: IDENTITY,
      statusCursor: "status-5",
      occurredAt: "2026-07-17T10:00:45.000Z",
      status: {
        identity: IDENTITY,
        state: "running",
        lastActivityAt: "2026-07-17T10:00:40.000Z",
        connectorCursor: "cursor-6",
        nativeWriterDetected: true,
      },
    });
    expect(store.recordConnectorStatus).toHaveBeenCalledWith({
      roomId: "room-1",
      bindingId: "binding-1",
      state: "running",
      statusCursor: "status-5",
      nativeWriterDetected: true,
      occurredAt: "2026-07-17T10:00:45.000Z",
    });

    await persistence.persistMode({
      mode: "degraded",
      reason: "events_not_verified",
      transcriptCursor: "cursor-6",
      statusCursor: "status-5",
    });
    expect(store.recordConnectorIngestionMode).toHaveBeenCalledWith({
      roomId: "room-1",
      bindingId: "binding-1",
      mode: "degraded",
      occurredAt: "2026-07-17T10:01:00.000Z",
    });
    await persistence.persistMode({
      mode: "stopped",
      reason: "finished",
      transcriptCursor: "cursor-6",
      statusCursor: "status-5",
    });
    expect(store.recordConnectorIngestionMode).toHaveBeenNthCalledWith(2, {
      roomId: "room-1",
      bindingId: "binding-1",
      mode: "stopped",
      occurredAt: "2026-07-17T10:01:00.001Z",
    });
  });

  it("fails closed on identity drift or a database-detected cursor gap", async () => {
    const store = createStore({
      recordConnectorTranscriptBatch: vi.fn(async () => ({
        state: {
          ...INITIAL_STATE,
          mode: "reconciling" as const,
          gapExpectedCursor: "cursor-5",
          gapObservedCursor: "cursor-3",
        },
        insertedCount: 0,
        duplicateCount: 0,
        duplicateNativeMessageIdCount: 0,
        duplicatePayloadHashCount: 0,
        gapDetected: true,
      })),
    });
    const persistence = new RoomSessionConnectorIngestionPersistence({
      store,
      roomId: "room-1",
      bindingId: "binding-1",
      identity: IDENTITY,
    });

    await expect(persistence.loadCheckpoint({
      identity: { ...IDENTITY, nativeSessionId: "different-thread" },
    })).rejects.toMatchObject({ code: "SESSION_CONNECTOR_IDENTITY_CONFLICT" });
    await expect(persistence.persistTranscriptBatch({
      source: "history",
      identity: IDENTITY,
      fromCursor: "cursor-3",
      nextCursor: "cursor-6",
      completeThroughCursor: "cursor-6",
      items: [],
    })).rejects.toMatchObject({ code: "SESSION_CONNECTOR_CURSOR_GAP" });
  });
});

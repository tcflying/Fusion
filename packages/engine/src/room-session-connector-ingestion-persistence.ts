import type {
  AsyncRoomStore,
  RoomConnectorIngestionStateV1,
  SessionConnectorIdentityV1,
} from "@fusion/core";

import type {
  SessionConnectorIngestionCheckpoint,
  SessionConnectorIngestionModeState,
  SessionConnectorIngestionPersistencePort,
  SessionConnectorStatusUpdate,
  SessionConnectorTranscriptBatch,
  SessionConnectorTranscriptPersistResult,
} from "./session-connector-ingestion.js";

export type RoomConnectorIngestionStore = Pick<
  AsyncRoomStore,
  | "getConnectorIngestionState"
  | "recordConnectorTranscriptBatch"
  | "recordConnectorStatus"
  | "recordConnectorIngestionMode"
>;

export type RoomSessionConnectorIngestionPersistenceErrorCode =
  | "SESSION_CONNECTOR_IDENTITY_CONFLICT"
  | "SESSION_CONNECTOR_CURSOR_GAP";

export class RoomSessionConnectorIngestionPersistenceError extends Error {
  readonly code: RoomSessionConnectorIngestionPersistenceErrorCode;

  constructor(code: RoomSessionConnectorIngestionPersistenceErrorCode, message: string) {
    super(message);
    this.name = "RoomSessionConnectorIngestionPersistenceError";
    this.code = code;
  }
}

export interface RoomSessionConnectorIngestionPersistenceOptions {
  readonly store: RoomConnectorIngestionStore;
  readonly roomId: string;
  readonly bindingId: string;
  readonly identity: SessionConnectorIdentityV1;
  readonly now?: () => string;
}

/*
FNXC:RoomSessionConnectorIngestionPersistence 2026-07-17-06:32:
The engine may observe at-least-once provider events, but only this adapter may
translate them into one immutable Room binding. Every call rechecks the complete
Session identity and awaits PostgreSQL cursor/status/mode persistence before the
coordinator can advance; no transcript plaintext or credentials cross this seam.
*/
export class RoomSessionConnectorIngestionPersistence
implements SessionConnectorIngestionPersistencePort {
  private readonly now: () => string;
  private lastModeOccurredAt: string | null = null;

  constructor(private readonly options: RoomSessionConnectorIngestionPersistenceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async loadCheckpoint(input: {
    readonly identity: SessionConnectorIdentityV1;
  }): Promise<SessionConnectorIngestionCheckpoint> {
    this.assertIdentity(input.identity);
    const state = await this.options.store.getConnectorIngestionState({
      roomId: this.options.roomId,
      bindingId: this.options.bindingId,
    });
    return checkpointFromState(state);
  }

  async persistTranscriptBatch(
    input: SessionConnectorTranscriptBatch,
  ): Promise<SessionConnectorTranscriptPersistResult> {
    this.assertIdentity(input.identity);
    const committedCursor = input.completeThroughCursor;
    const result = await this.options.store.recordConnectorTranscriptBatch({
      roomId: this.options.roomId,
      bindingId: this.options.bindingId,
      source: input.source,
      fromCursor: input.fromCursor,
      nextCursor: committedCursor,
      truncated: false,
      modeAfterCommit: input.source === "event" ? "streaming" : "reconciling",
      receivedAt: this.now(),
      items: input.items.map((item) => ({
        nativeMessageId: item.nativeMessageId,
        logicalMessageId: item.logicalMessageId,
        nativeCursor: item.cursor,
        payloadHash: item.contentHash,
        role: item.role,
        occurredAt: item.occurredAt,
      })),
    });
    if (result.gapDetected) {
      throw new RoomSessionConnectorIngestionPersistenceError(
        "SESSION_CONNECTOR_CURSOR_GAP",
        "The durable Room cursor rejected a non-contiguous Session transcript batch",
      );
    }
    return {
      committedCursor: result.state.transcriptCursor,
      insertedCount: result.insertedCount,
      duplicateNativeMessageIdCount: result.duplicateNativeMessageIdCount,
      duplicateContentHashCount: result.duplicatePayloadHashCount,
    };
  }

  async persistStatus(input: SessionConnectorStatusUpdate): Promise<void> {
    this.assertIdentity(input.identity);
    await this.options.store.recordConnectorStatus({
      roomId: this.options.roomId,
      bindingId: this.options.bindingId,
      state: input.status.state,
      statusCursor: input.statusCursor,
      nativeWriterDetected: input.status.nativeWriterDetected,
      occurredAt: input.occurredAt,
    });
  }

  async persistMode(input: SessionConnectorIngestionModeState): Promise<void> {
    const occurredAt = this.nextModeOccurredAt();
    await this.options.store.recordConnectorIngestionMode({
      roomId: this.options.roomId,
      bindingId: this.options.bindingId,
      mode: input.mode,
      occurredAt,
    });
  }

  private assertIdentity(actual: SessionConnectorIdentityV1): void {
    const expected = this.options.identity;
    if (
      actual.connectorId !== expected.connectorId
      || actual.providerId !== expected.providerId
      || actual.nativeSessionId !== expected.nativeSessionId
      || actual.happierSessionId !== expected.happierSessionId
      || actual.serverProfileId !== expected.serverProfileId
      || actual.machineId !== expected.machineId
      || actual.hostId !== expected.hostId
    ) {
      throw new RoomSessionConnectorIngestionPersistenceError(
        "SESSION_CONNECTOR_IDENTITY_CONFLICT",
        "The Session connector identity does not match this immutable Room binding",
      );
    }
  }

  private nextModeOccurredAt(): string {
    const candidate = this.now();
    if (this.lastModeOccurredAt === null) {
      this.lastModeOccurredAt = candidate;
      return candidate;
    }
    const candidateMs = Date.parse(candidate);
    const previousMs = Date.parse(this.lastModeOccurredAt);
    const next = Number.isFinite(candidateMs) && Number.isFinite(previousMs) && candidateMs <= previousMs
      ? new Date(previousMs + 1).toISOString()
      : candidate;
    this.lastModeOccurredAt = next;
    return next;
  }
}

function checkpointFromState(
  state: RoomConnectorIngestionStateV1,
): SessionConnectorIngestionCheckpoint {
  return {
    transcriptCursor: state.transcriptCursor,
    statusCursor: state.statusCursor,
  };
}

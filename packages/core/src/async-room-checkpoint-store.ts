import { and, asc, desc, eq, inArray } from "drizzle-orm";

import {
  loadRoomAggregateProjection,
  loadRoomEvents,
} from "./async-room-store.js";
import type {
  RoomCheckpointRecordV1,
  RoomEventRecordV1,
} from "./room-contracts/storage.js";
import type { RoomAggregateV1 } from "./room-domain.js";
import { hashRoomValue } from "./room-integrity.js";
import {
  applyRoomProjectionEvents,
  parseRoomAggregateProjection,
  rebuildRoomProjectionFromEvents,
} from "./room-projection-replay.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import {
  roomCheckpoints,
  roomOutbox,
} from "./postgres/schema/room.js";

type QueryHandle = AsyncDataLayer["db"] | DbTransaction;

export interface AsyncRoomCheckpointStoreOptions {
  readonly projectId?: string;
}

export interface CreateRoomCheckpointInput {
  readonly id: string;
  readonly roomId: string;
  readonly turnId: string;
  readonly expectedAggregateVersion: number;
  readonly protocolState: Readonly<Record<string, unknown>>;
  readonly dagVersion: number;
  readonly bindingCursors: Readonly<Record<string, string | null>>;
  readonly artifactRefs: readonly string[];
  readonly now: string;
}

export interface ReplaceRoomCheckpointAfterDeliveryRecoveryInput
  extends CreateRoomCheckpointInput {
  readonly previousCheckpointId: string;
}

export interface StoredRoomCheckpointV1 extends RoomCheckpointRecordV1 {
  readonly eventId: string;
  readonly projectionHash: string;
  readonly projection: RoomAggregateV1;
}

export interface RoomProjectionReplayResult {
  readonly aggregate: RoomAggregateV1;
  readonly checkpointId: string | null;
  readonly replayedEventCount: number;
  readonly lastEventCursor: string;
}

export type RoomCheckpointStoreErrorCode =
  | "checkpoint_room_not_found"
  | "checkpoint_version_conflict"
  | "checkpoint_turn_conflict"
  | "checkpoint_binding_conflict"
  | "checkpoint_anchor_conflict"
  | "checkpoint_identity_conflict"
  | "checkpoint_hash_conflict"
  | "projection_drift";

export class RoomCheckpointStoreError extends Error {
  readonly code: RoomCheckpointStoreErrorCode;

  constructor(code: RoomCheckpointStoreErrorCode, message: string) {
    super(message);
    this.name = "RoomCheckpointStoreError";
    this.code = code;
  }
}

/**
 * Durable turn-boundary snapshots plus deterministic append-only event replay.
 * A checkpoint accelerates recovery; it never replaces or truncates Room events.
 *
 * FNXC:SessionRoomCheckpointReplay 2026-07-17-08:20:
 * Browsers and workers may disappear at any point. Recovery therefore starts
 * from a hash-verified PostgreSQL checkpoint and replays every later event with
 * contiguous aggregate versions. Unknown events, missing anchors, tampered
 * snapshots, and mutable-projection drift stop recovery visibly instead of
 * manufacturing a plausible but unauditable Room state.
 */
export class AsyncRoomCheckpointStore {
  private readonly projectId: string;

  constructor(
    private readonly layer: AsyncDataLayer,
    options: AsyncRoomCheckpointStoreOptions = {},
  ) {
    const projectId = options.projectId ?? layer.projectId;
    if (!projectId) {
      throw new Error("AsyncRoomCheckpointStore requires an explicit projectId or project-bound AsyncDataLayer");
    }
    if (layer.projectId && options.projectId && layer.projectId !== options.projectId) {
      throw new Error(
        `AsyncRoomCheckpointStore project mismatch: layer=${layer.projectId}, options=${options.projectId}`,
      );
    }
    this.projectId = projectId;
  }

  async createCheckpoint(
    input: CreateRoomCheckpointInput,
  ): Promise<StoredRoomCheckpointV1> {
    validateCheckpointInput(input);
    return this.layer.transactionImmediate(async (tx) => {
      const aggregate = await loadRoomAggregateProjection(
        tx,
        this.projectId,
        input.roomId,
      );
      if (!aggregate) {
        throw new RoomCheckpointStoreError(
          "checkpoint_room_not_found",
          `Operational Room ${input.roomId} does not exist`,
        );
      }
      if (aggregate.room.aggregateVersion !== input.expectedAggregateVersion) {
        throw new RoomCheckpointStoreError(
          "checkpoint_version_conflict",
          `Room ${input.roomId} expected aggregate version ${input.expectedAggregateVersion} but is ${aggregate.room.aggregateVersion}`,
        );
      }
      if (Date.parse(input.now) < Date.parse(aggregate.room.updatedAt)) {
        throw new RoomCheckpointStoreError(
          "checkpoint_version_conflict",
          `Checkpoint time cannot precede the current Room projection`,
        );
      }
      const turn = aggregate.turns.find((candidate) => candidate.id === input.turnId);
      const settledTurn = turn && ["completed", "cancelled", "uncertain", "checkpointed"].includes(turn.state);
      if (!turn || (aggregate.activeTurnId !== input.turnId && !settledTurn)) {
        throw new RoomCheckpointStoreError(
          "checkpoint_turn_conflict",
          `Turn ${input.turnId} is not the active or settled turn of Room ${input.roomId}`,
        );
      }
      for (const bindingId of Object.keys(input.bindingCursors)) {
        if (!aggregate.bindings.some((binding) => binding.id === bindingId)) {
          throw new RoomCheckpointStoreError(
            "checkpoint_binding_conflict",
            `Checkpoint cursor references unknown Room binding ${bindingId}`,
          );
        }
      }

      const events = await loadRoomEvents(tx, this.projectId, input.roomId);
      const anchor = events.at(-1);
      if (!anchor || anchor.aggregateVersion !== aggregate.room.aggregateVersion) {
        throw new RoomCheckpointStoreError(
          "checkpoint_anchor_conflict",
          `Room ${input.roomId} has no event anchor for aggregate version ${aggregate.room.aggregateVersion}`,
        );
      }
      const eventCursor = cursorAsSafeNumber(anchor);
      const projectionHash = hashRoomValue(aggregate);
      const pendingRows = await tx
        .select({ id: roomOutbox.id })
        .from(roomOutbox)
        .where(
          and(
            eq(roomOutbox.projectId, this.projectId),
            eq(roomOutbox.roomId, input.roomId),
            inArray(roomOutbox.deliveryState, ["pending", "dispatching", "delivery_uncertain"]),
          ),
        )
        .orderBy(asc(roomOutbox.id));
      const pendingOutboxIds = pendingRows.map((row) => row.id);

      const existing = await findCheckpointAtVersion(
        tx,
        this.projectId,
        input.roomId,
        input.expectedAggregateVersion,
      );
      if (existing) {
        if (
          existing.id === input.id
          && existing.turnId === input.turnId
          && existing.eventId === anchor.id
          && existing.eventCursor === anchor.cursor
          && existing.projectionHash === projectionHash
          && hashRoomValue(existing.protocolState) === hashRoomValue(input.protocolState)
          && existing.dagVersion === input.dagVersion
          && hashRoomValue(existing.bindingCursors) === hashRoomValue(input.bindingCursors)
          && hashRoomValue(existing.pendingOutboxIds) === hashRoomValue(pendingOutboxIds)
          && hashRoomValue(existing.artifactRefs) === hashRoomValue(input.artifactRefs)
        ) {
          return existing;
        }
        throw new RoomCheckpointStoreError(
          "checkpoint_version_conflict",
          `Room ${input.roomId} already has a different checkpoint at aggregate version ${input.expectedAggregateVersion}`,
        );
      }

      const rows = await tx
        .insert(roomCheckpoints)
        .values({
          id: input.id,
          projectId: this.projectId,
          roomId: input.roomId,
          turnId: input.turnId,
          aggregateVersion: input.expectedAggregateVersion,
          eventId: anchor.id,
          eventCursor,
          projectionHash,
          projection: aggregate,
          protocolState: input.protocolState,
          dagVersion: input.dagVersion,
          bindingCursors: input.bindingCursors,
          pendingOutboxIds,
          artifactRefs: input.artifactRefs,
          createdAt: input.now,
        })
        .returning();
      if (!rows[0]) {
        throw new RoomCheckpointStoreError(
          "checkpoint_version_conflict",
          `Checkpoint ${input.id} was not persisted`,
        );
      }
      return rowToStoredCheckpoint(rows[0]);
    });
  }

  /**
   * Replace the one checkpoint allowed at an aggregate version after durable
   * delivery reconciliation. This is deliberately narrower than
   * createCheckpoint: the Room/event/protocol/DAG/artifact snapshot must be
   * identical, the pending outbox set may only shrink, every removed outbox
   * must now be confirmed, and binding cursors must equal each confirmed native
   * cursor when one exists. A valid acknowledgement-only confirmation removes
   * pending work without inventing a cursor.
   *
   * FNXC:SessionRoomCrashRecovery 2026-07-18-09:05:
   * Recovery cursors are opaque. Prove strict progress through persisted
   * confirmed rows by requiring each cursor to be non-empty and different from
   * the prior cursor for its binding, then require the replacement checkpoint
   * to equal the final database result without lexicographic ordering.
   */
  async replaceCheckpointAfterDeliveryRecovery(
    input: ReplaceRoomCheckpointAfterDeliveryRecoveryInput,
  ): Promise<StoredRoomCheckpointV1> {
    validateCheckpointInput(input);
    if (!input.previousCheckpointId.trim() || input.id === input.previousCheckpointId) {
      throw new RoomCheckpointStoreError(
        "checkpoint_version_conflict",
        "Delivery recovery checkpoint replacement requires distinct non-empty checkpoint IDs",
      );
    }

    return this.layer.transactionImmediate(async (tx) => {
      const aggregate = await loadRoomAggregateProjection(tx, this.projectId, input.roomId);
      if (!aggregate) {
        throw new RoomCheckpointStoreError(
          "checkpoint_room_not_found",
          `Operational Room ${input.roomId} does not exist`,
        );
      }
      if (aggregate.room.aggregateVersion !== input.expectedAggregateVersion) {
        throw new RoomCheckpointStoreError(
          "checkpoint_version_conflict",
          `Room ${input.roomId} expected aggregate version ${input.expectedAggregateVersion} but is ${aggregate.room.aggregateVersion}`,
        );
      }

      const existing = await findCheckpointById(
        tx,
        this.projectId,
        input.roomId,
        input.previousCheckpointId,
      );
      if (!existing || existing.aggregateVersion !== input.expectedAggregateVersion) {
        throw new RoomCheckpointStoreError(
          "checkpoint_version_conflict",
          `Checkpoint ${input.previousCheckpointId} is not the recovery base for Room ${input.roomId}`,
        );
      }
      const events = await loadRoomEvents(tx, this.projectId, input.roomId);
      const anchor = events.at(-1);
      const projectionHash = hashRoomValue(aggregate);
      if (
        !anchor
        || anchor.id !== existing.eventId
        || anchor.cursor !== existing.eventCursor
        || anchor.aggregateVersion !== existing.aggregateVersion
        || projectionHash !== existing.projectionHash
        || existing.turnId !== input.turnId
        || hashRoomValue(existing.protocolState) !== hashRoomValue(input.protocolState)
        || existing.dagVersion !== input.dagVersion
        || hashRoomValue(existing.artifactRefs) !== hashRoomValue(input.artifactRefs)
      ) {
        throw new RoomCheckpointStoreError(
          "checkpoint_version_conflict",
          `Checkpoint ${input.previousCheckpointId} differs outside delivery recovery state`,
        );
      }
      if (Date.parse(input.now) < Date.parse(existing.createdAt)) {
        throw new RoomCheckpointStoreError(
          "checkpoint_version_conflict",
          "Delivery recovery checkpoint time cannot move backwards",
        );
      }

      /*
      REPEATABLE READ gives every projection/outbox query one stable database
      snapshot without taking the room -> outbox row-lock order that can cycle
      against delivery claim and native-writer takeover. A concurrent delivery
      committed after this snapshot remains pending in this checkpoint and is
      safely consumed by the next recovery pass.
      */
      const currentPendingRows = await tx
        .select({ id: roomOutbox.id })
        .from(roomOutbox)
        .where(and(
          eq(roomOutbox.projectId, this.projectId),
          eq(roomOutbox.roomId, input.roomId),
          inArray(roomOutbox.deliveryState, ["pending", "dispatching", "delivery_uncertain"]),
        ))
        .orderBy(asc(roomOutbox.id));
      const currentPendingOutboxIds = currentPendingRows.map((row) => row.id);
      const priorPending = new Set(existing.pendingOutboxIds);
      const currentPending = new Set(currentPendingOutboxIds);
      const added = currentPendingOutboxIds.filter((id) => !priorPending.has(id));
      const removed = existing.pendingOutboxIds.filter((id) => !currentPending.has(id));
      if (added.length > 0 || removed.length === 0) {
        throw new RoomCheckpointStoreError(
          "checkpoint_version_conflict",
          "Delivery recovery checkpoint pending outbox IDs must be a strict subset",
        );
      }

      const resolvedRows = await tx
        .select({
          id: roomOutbox.id,
          bindingId: roomOutbox.bindingId,
          deliveryState: roomOutbox.deliveryState,
          nativeCursor: roomOutbox.nativeCursor,
          updatedAt: roomOutbox.updatedAt,
        })
        .from(roomOutbox)
        .where(and(
          eq(roomOutbox.projectId, this.projectId),
          eq(roomOutbox.roomId, input.roomId),
          inArray(roomOutbox.id, removed),
        ))
        .orderBy(asc(roomOutbox.updatedAt), asc(roomOutbox.id));
      if (
        resolvedRows.length !== removed.length
        || resolvedRows.some((row) =>
          row.deliveryState !== "confirmed" || Date.parse(row.updatedAt) > Date.parse(input.now)
        )
      ) {
        throw new RoomCheckpointStoreError(
          "checkpoint_version_conflict",
          "Delivery recovery checkpoint may remove only durably confirmed outbox records",
        );
      }

      const expectedBindingCursors: Record<string, string | null> = {
        ...existing.bindingCursors,
      };
      const affectedBindingIds = new Set<string>();
      const seenBindingCursors = new Map<string, Set<string>>();
      for (const row of resolvedRows) {
        const checkpointCursor = existing.bindingCursors[row.bindingId] ?? null;
        if (!row.nativeCursor) continue;
        let seen = seenBindingCursors.get(row.bindingId);
        if (!seen) {
          seen = new Set<string>();
          if (checkpointCursor) seen.add(checkpointCursor);
          seenBindingCursors.set(row.bindingId, seen);
        }
        if (seen.has(row.nativeCursor)) {
          throw new RoomCheckpointStoreError(
            "checkpoint_version_conflict",
            `Confirmed outbox ${row.id} repeats an opaque cursor for binding ${row.bindingId}`,
          );
        }
        seen.add(row.nativeCursor);
        expectedBindingCursors[row.bindingId] = row.nativeCursor;
        affectedBindingIds.add(row.bindingId);
      }
      if ([...affectedBindingIds].some((bindingId) =>
        expectedBindingCursors[bindingId] === (existing.bindingCursors[bindingId] ?? null)
      )) {
        throw new RoomCheckpointStoreError(
          "checkpoint_version_conflict",
          "Delivery recovery checkpoint cursors must advance for every affected binding",
        );
      }
      if (hashRoomValue(expectedBindingCursors) !== hashRoomValue(input.bindingCursors)) {
        throw new RoomCheckpointStoreError(
          "checkpoint_version_conflict",
          "Delivery recovery checkpoint cursors must match confirmed native delivery evidence",
        );
      }

      const rows = await tx
        .update(roomCheckpoints)
        .set({
          id: input.id,
          bindingCursors: input.bindingCursors,
          pendingOutboxIds: currentPendingOutboxIds,
          createdAt: input.now,
        })
        .where(and(
          eq(roomCheckpoints.projectId, this.projectId),
          eq(roomCheckpoints.roomId, input.roomId),
          eq(roomCheckpoints.id, input.previousCheckpointId),
          eq(roomCheckpoints.aggregateVersion, input.expectedAggregateVersion),
        ))
        .returning();
      if (!rows[0]) {
        throw new RoomCheckpointStoreError(
          "checkpoint_version_conflict",
          `Checkpoint ${input.previousCheckpointId} lost its recovery replacement race`,
        );
      }
      return rowToStoredCheckpoint(rows[0]);
    }, { isolationLevel: "repeatable read" });
  }

  async getLatestCheckpoint(roomId: string): Promise<StoredRoomCheckpointV1 | null> {
    return findLatestCheckpoint(this.layer.db, this.projectId, roomId);
  }

  async replayProjection(roomId: string): Promise<RoomProjectionReplayResult> {
    return this.layer.transaction(
      async (tx) => {
        const current = await loadRoomAggregateProjection(tx, this.projectId, roomId);
        if (!current) {
          throw new RoomCheckpointStoreError(
            "checkpoint_room_not_found",
            `Operational Room ${roomId} does not exist`,
          );
        }
        const events = await loadRoomEvents(tx, this.projectId, roomId);
        const checkpointRow = await findLatestCheckpointRow(tx, this.projectId, roomId);
        let checkpoint: StoredRoomCheckpointV1 | null = null;
        let aggregate: RoomAggregateV1;
        let replayedEvents: readonly RoomEventRecordV1[];

        if (checkpointRow) {
          if (hashRoomValue(checkpointRow.projection) !== checkpointRow.projectionHash) {
            throw new RoomCheckpointStoreError(
              "checkpoint_hash_conflict",
              `Checkpoint ${checkpointRow.id} hash does not match its persisted projection`,
            );
          }
          const storedCheckpoint = rowToStoredCheckpoint(checkpointRow);
          checkpoint = storedCheckpoint;
          const base = parseRoomAggregateProjection(storedCheckpoint.projection);
          if (
            base.room.id !== roomId
            || base.room.projectId !== this.projectId
            || base.room.aggregateVersion !== storedCheckpoint.aggregateVersion
          ) {
            throw new RoomCheckpointStoreError(
              "checkpoint_identity_conflict",
              `Checkpoint ${storedCheckpoint.id} projection identity or version does not match its record`,
            );
          }
          const anchor = events.find(
            (event) => event.id === storedCheckpoint.eventId
              && event.cursor === storedCheckpoint.eventCursor
              && event.aggregateVersion === storedCheckpoint.aggregateVersion,
          );
          if (!anchor) {
            throw new RoomCheckpointStoreError(
              "checkpoint_anchor_conflict",
              `Checkpoint ${storedCheckpoint.id} event anchor is missing from the immutable Room stream`,
            );
          }
          const anchorCursor = BigInt(storedCheckpoint.eventCursor);
          replayedEvents = events.filter((event) => BigInt(event.cursor) > anchorCursor);
          aggregate = applyRoomProjectionEvents(base, replayedEvents);
        } else {
          replayedEvents = events;
          aggregate = rebuildRoomProjectionFromEvents(events);
        }

        if (hashRoomValue(aggregate) !== hashRoomValue(current)) {
          throw new RoomCheckpointStoreError(
            "projection_drift",
            `Replayed Room ${roomId} projection differs from the mutable PostgreSQL projection`,
          );
        }
        const lastEvent = events.at(-1);
        if (!lastEvent) {
          throw new RoomCheckpointStoreError(
            "checkpoint_anchor_conflict",
            `Room ${roomId} has no immutable events`,
          );
        }
        return {
          aggregate,
          checkpointId: checkpoint?.id ?? null,
          replayedEventCount: checkpoint ? replayedEvents.length : events.length,
          lastEventCursor: lastEvent.cursor,
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
}

async function findLatestCheckpoint(
  handle: QueryHandle,
  projectId: string,
  roomId: string,
): Promise<StoredRoomCheckpointV1 | null> {
  const row = await findLatestCheckpointRow(handle, projectId, roomId);
  return row ? rowToStoredCheckpoint(row) : null;
}

async function findLatestCheckpointRow(
  handle: QueryHandle,
  projectId: string,
  roomId: string,
): Promise<typeof roomCheckpoints.$inferSelect | null> {
  const rows = await handle
    .select()
    .from(roomCheckpoints)
    .where(and(eq(roomCheckpoints.projectId, projectId), eq(roomCheckpoints.roomId, roomId)))
    .orderBy(desc(roomCheckpoints.aggregateVersion))
    .limit(1);
  return rows[0] ?? null;
}

async function findCheckpointAtVersion(
  handle: QueryHandle,
  projectId: string,
  roomId: string,
  aggregateVersion: number,
): Promise<StoredRoomCheckpointV1 | null> {
  const rows = await handle
    .select()
    .from(roomCheckpoints)
    .where(
      and(
        eq(roomCheckpoints.projectId, projectId),
        eq(roomCheckpoints.roomId, roomId),
        eq(roomCheckpoints.aggregateVersion, aggregateVersion),
      ),
    )
    .limit(1);
  return rows[0] ? rowToStoredCheckpoint(rows[0]) : null;
}

async function findCheckpointById(
  handle: QueryHandle,
  projectId: string,
  roomId: string,
  checkpointId: string,
): Promise<StoredRoomCheckpointV1 | null> {
  const rows = await handle
    .select()
    .from(roomCheckpoints)
    .where(and(
      eq(roomCheckpoints.projectId, projectId),
      eq(roomCheckpoints.roomId, roomId),
      eq(roomCheckpoints.id, checkpointId),
    ))
    .limit(1);
  return rows[0] ? rowToStoredCheckpoint(rows[0]) : null;
}

function rowToStoredCheckpoint(
  row: typeof roomCheckpoints.$inferSelect,
): StoredRoomCheckpointV1 {
  if (!row.turnId) {
    throw new RoomCheckpointStoreError(
      "checkpoint_turn_conflict",
      `Checkpoint ${row.id} has no turn identity`,
    );
  }
  const projection = parseRoomAggregateProjection(row.projection);
  return {
    contractVersion: 1,
    id: row.id,
    roomId: row.roomId,
    turnId: row.turnId,
    aggregateVersion: Number(row.aggregateVersion),
    eventId: row.eventId,
    eventCursor: String(row.eventCursor),
    projectionHash: row.projectionHash,
    projection,
    protocolState: asRecord(row.protocolState),
    dagVersion: Number(row.dagVersion),
    bindingCursors: asNullableStringRecord(row.bindingCursors),
    pendingOutboxIds: asStringArray(row.pendingOutboxIds),
    artifactRefs: asStringArray(row.artifactRefs),
    createdAt: row.createdAt,
  };
}

function validateCheckpointInput(input: CreateRoomCheckpointInput): void {
  for (const [field, value] of Object.entries({
    id: input.id,
    roomId: input.roomId,
    turnId: input.turnId,
  })) {
    if (value.trim().length === 0) {
      throw new RoomCheckpointStoreError(
        "checkpoint_identity_conflict",
        `${field} must not be empty`,
      );
    }
  }
  if (!Number.isSafeInteger(input.expectedAggregateVersion) || input.expectedAggregateVersion < 0) {
    throw new RoomCheckpointStoreError(
      "checkpoint_version_conflict",
      `expectedAggregateVersion must be a non-negative safe integer`,
    );
  }
  if (!Number.isSafeInteger(input.dagVersion) || input.dagVersion < 0) {
    throw new RoomCheckpointStoreError(
      "checkpoint_version_conflict",
      `dagVersion must be a non-negative safe integer`,
    );
  }
  if (!Number.isFinite(Date.parse(input.now))) {
    throw new RoomCheckpointStoreError(
      "checkpoint_identity_conflict",
      `Checkpoint now must be an ISO timestamp`,
    );
  }
  if (new Set(input.artifactRefs).size !== input.artifactRefs.length) {
    throw new RoomCheckpointStoreError(
      "checkpoint_identity_conflict",
      `Checkpoint artifact references must be unique`,
    );
  }
  for (const [bindingId, cursor] of Object.entries(input.bindingCursors)) {
    if (!bindingId || (cursor !== null && typeof cursor !== "string")) {
      throw new RoomCheckpointStoreError(
        "checkpoint_binding_conflict",
        `Checkpoint binding cursors must map non-empty binding IDs to strings or null`,
      );
    }
  }
}

function cursorAsSafeNumber(event: RoomEventRecordV1): number {
  const cursor = Number(event.cursor);
  if (!Number.isSafeInteger(cursor) || cursor < 1) {
    throw new RoomCheckpointStoreError(
      "checkpoint_anchor_conflict",
      `Room event ${event.id} cursor ${event.cursor} cannot be stored safely in this runtime`,
    );
  }
  return cursor;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function asStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function asNullableStringRecord(value: unknown): Readonly<Record<string, string | null>> {
  const source = asRecord(value);
  const result: Record<string, string | null> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (typeof entry === "string" || entry === null) result[key] = entry;
  }
  return result;
}

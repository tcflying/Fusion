import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import type {
  RoomLeaseKind,
  RoomLeaseRecordV1,
} from "./room-contracts/storage.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import {
  operationalRooms,
  roomBindings,
  roomLeases,
} from "./postgres/schema/room.js";

type QueryHandle = AsyncDataLayer["db"] | DbTransaction;

export interface AsyncRoomLeaseStoreOptions {
  readonly projectId?: string;
}

export interface StoredRoomLeaseV1 extends RoomLeaseRecordV1 {
  readonly heartbeatAt: string;
}

export interface AcquireRoomLeaseInput {
  readonly leaseId: string;
  readonly roomId: string;
  readonly kind: RoomLeaseKind;
  readonly resourceId: string;
  readonly holderId: string;
  readonly hostId: string;
  readonly expectedEpoch: number | null;
  readonly now: string;
  readonly expiresAt: string;
}

export type AcquireRoomLeaseResult =
  | {
      readonly ok: true;
      readonly action: "acquired" | "taken_over";
      readonly lease: StoredRoomLeaseV1;
    }
  | {
      readonly ok: false;
      readonly reason: "active" | "stale_epoch";
      readonly current: StoredRoomLeaseV1 | null;
    };

export interface RenewRoomLeaseInput {
  readonly leaseId: string;
  readonly roomId: string;
  readonly kind: RoomLeaseKind;
  readonly resourceId: string;
  readonly holderId: string;
  readonly hostId: string;
  readonly expectedEpoch: number;
  readonly now: string;
  readonly expiresAt: string;
}

export interface ReleaseRoomLeaseInput {
  readonly leaseId: string;
  readonly roomId: string;
  readonly kind: RoomLeaseKind;
  readonly resourceId: string;
  readonly holderId: string;
  readonly hostId: string;
  readonly expectedEpoch: number;
  readonly now: string;
}

export interface AssertRoomLeaseFenceInput {
  readonly leaseId: string;
  readonly roomId: string;
  readonly kind: RoomLeaseKind;
  readonly resourceId: string;
  readonly holderId: string;
  readonly hostId: string;
  readonly expectedEpoch: number;
  readonly now: string;
}

export type MutateRoomLeaseResult =
  | { readonly ok: true; readonly lease: StoredRoomLeaseV1 }
  | {
      readonly ok: false;
      readonly reason: "not_found" | "stale_fence" | "expired";
      readonly current: StoredRoomLeaseV1 | null;
    };

export type RoomLeaseStoreErrorCode =
  | "invalid_lease_request"
  | "lease_resource_conflict"
  | "lease_write_conflict";

export class RoomLeaseStoreError extends Error {
  readonly code: RoomLeaseStoreErrorCode;

  constructor(code: RoomLeaseStoreErrorCode, message: string) {
    super(message);
    this.name = "RoomLeaseStoreError";
    this.code = code;
  }
}

export class RoomLeaseFenceError extends Error {
  readonly code = "stale_lease_fence" as const;
  readonly current: StoredRoomLeaseV1 | null;

  constructor(message: string, current: StoredRoomLeaseV1 | null) {
    super(message);
    this.name = "RoomLeaseFenceError";
    this.current = current;
  }
}

/**
 * PostgreSQL persistence for Room worker, sender, workspace, and human takeover
 * leases. The lease row is append-only across ownership epochs; heartbeats and
 * final release mutate only the currently-owned epoch.
 *
 * FNXC:SessionRoomLeaseFence 2026-07-17-06:15:
 * A process remaining alive after expiry is not proof of authority. Every
 * protected write must present the exact active lease ID, holder, host, and
 * epoch in the same database transaction as that write. An expired takeover
 * releases the old row and appends a higher epoch, permanently fencing the old
 * worker even when it resumes after a network or process pause.
 */
export class AsyncRoomLeaseStore {
  private readonly projectId: string;

  constructor(
    private readonly layer: AsyncDataLayer,
    options: AsyncRoomLeaseStoreOptions = {},
  ) {
    const projectId = options.projectId ?? layer.projectId;
    if (!projectId) {
      throw new Error("AsyncRoomLeaseStore requires an explicit projectId or project-bound AsyncDataLayer");
    }
    if (layer.projectId && options.projectId && layer.projectId !== options.projectId) {
      throw new Error(
        `AsyncRoomLeaseStore project mismatch: layer=${layer.projectId}, options=${options.projectId}`,
      );
    }
    this.projectId = projectId;
  }

  async acquireLease(input: AcquireRoomLeaseInput): Promise<AcquireRoomLeaseResult> {
    validateLeaseWindow(input.now, input.expiresAt);
    validateRequiredLeaseFields(input);

    return this.layer.transactionImmediate(async (tx): Promise<AcquireRoomLeaseResult> => {
      await lockLeaseResource(tx, this.projectId, input.kind, input.resourceId);
      await validateLeaseResource(tx, this.projectId, input);

      const active = await findActiveLease(tx, this.projectId, input.kind, input.resourceId);
      const latest = await findLatestLease(tx, this.projectId, input.kind, input.resourceId);
      ensureMonotonicLeaseTime(input.now, latest);

      if (active && timestampMs(active.expiresAt, "current lease expiresAt") > timestampMs(input.now, "now")) {
        return { ok: false, reason: "active", current: active };
      }

      if (active) {
        if (input.expectedEpoch !== active.epoch) {
          return { ok: false, reason: "stale_epoch", current: active };
        }
        const released = await tx
          .update(roomLeases)
          .set({ releasedAt: input.now })
          .where(
            and(
              eq(roomLeases.projectId, this.projectId),
              eq(roomLeases.id, active.id),
              eq(roomLeases.epoch, active.epoch),
              isNull(roomLeases.releasedAt),
            ),
          )
          .returning({ id: roomLeases.id });
        if (released.length !== 1) {
          throw new RoomLeaseStoreError(
            "lease_write_conflict",
            `Expired lease ${active.id} changed during takeover`,
          );
        }
        const lease = await insertLease(tx, this.projectId, input, active.epoch + 1);
        return { ok: true, action: "taken_over", lease };
      }

      if (latest) {
        if (input.expectedEpoch !== latest.epoch) {
          return { ok: false, reason: "stale_epoch", current: latest };
        }
      } else if (input.expectedEpoch !== null && input.expectedEpoch !== 0) {
        return { ok: false, reason: "stale_epoch", current: null };
      }

      const lease = await insertLease(tx, this.projectId, input, (latest?.epoch ?? 0) + 1);
      return { ok: true, action: "acquired", lease };
    });
  }

  async renewLease(input: RenewRoomLeaseInput): Promise<MutateRoomLeaseResult> {
    validateLeaseWindow(input.now, input.expiresAt);
    validateRequiredLeaseFields(input);

    return this.layer.transactionImmediate(async (tx): Promise<MutateRoomLeaseResult> => {
      await lockLeaseResource(tx, this.projectId, input.kind, input.resourceId);
      const current = await findActiveLease(tx, this.projectId, input.kind, input.resourceId);
      if (!current) {
        return {
          ok: false,
          reason: "not_found",
          current: await findLatestLease(tx, this.projectId, input.kind, input.resourceId),
        };
      }
      if (!leaseFenceMatches(current, input)) {
        return { ok: false, reason: "stale_fence", current };
      }
      ensureMonotonicLeaseTime(input.now, current);
      if (timestampMs(current.expiresAt, "current lease expiresAt") <= timestampMs(input.now, "now")) {
        return { ok: false, reason: "expired", current };
      }
      if (timestampMs(input.expiresAt, "expiresAt") < timestampMs(current.expiresAt, "current lease expiresAt")) {
        throw new RoomLeaseStoreError(
          "invalid_lease_request",
          `Lease renewal ${input.leaseId} cannot shorten its expiry`,
        );
      }

      const rows = await tx
        .update(roomLeases)
        .set({ heartbeatAt: input.now, expiresAt: input.expiresAt })
        .where(activeFencePredicate(this.projectId, input))
        .returning();
      if (!rows[0]) {
        return {
          ok: false,
          reason: "stale_fence",
          current: await findActiveLease(tx, this.projectId, input.kind, input.resourceId),
        };
      }
      return { ok: true, lease: rowToStoredLease(rows[0]) };
    });
  }

  async releaseLease(input: ReleaseRoomLeaseInput): Promise<MutateRoomLeaseResult> {
    timestampMs(input.now, "now");
    validateRequiredLeaseFields(input);

    return this.layer.transactionImmediate(async (tx): Promise<MutateRoomLeaseResult> => {
      await lockLeaseResource(tx, this.projectId, input.kind, input.resourceId);
      const current = await findActiveLease(tx, this.projectId, input.kind, input.resourceId);
      if (!current) {
        return {
          ok: false,
          reason: "not_found",
          current: await findLatestLease(tx, this.projectId, input.kind, input.resourceId),
        };
      }
      if (!leaseFenceMatches(current, input)) {
        return { ok: false, reason: "stale_fence", current };
      }
      ensureMonotonicLeaseTime(input.now, current);

      const rows = await tx
        .update(roomLeases)
        .set({ releasedAt: input.now })
        .where(activeFencePredicate(this.projectId, input))
        .returning();
      if (!rows[0]) {
        return {
          ok: false,
          reason: "stale_fence",
          current: await findActiveLease(tx, this.projectId, input.kind, input.resourceId),
        };
      }
      return { ok: true, lease: rowToStoredLease(rows[0]) };
    });
  }

  async assertFence(input: AssertRoomLeaseFenceInput): Promise<StoredRoomLeaseV1> {
    return assertRoomLeaseFence(this.layer.db, this.projectId, input);
  }

  async getActiveLease(
    kind: RoomLeaseKind,
    resourceId: string,
  ): Promise<StoredRoomLeaseV1 | null> {
    return findActiveLease(this.layer.db, this.projectId, kind, resourceId);
  }

  async listLeaseHistory(
    kind: RoomLeaseKind,
    resourceId: string,
  ): Promise<readonly StoredRoomLeaseV1[]> {
    const rows = await this.layer.db
      .select()
      .from(roomLeases)
      .where(
        and(
          eq(roomLeases.projectId, this.projectId),
          eq(roomLeases.kind, kind),
          eq(roomLeases.resourceId, resourceId),
        ),
      )
      .orderBy(asc(roomLeases.epoch));
    return rows.map(rowToStoredLease);
  }
}

/**
 * Transaction-composable fence assertion. Protected persistence must call this
 * with its own transaction handle immediately before the guarded mutation.
 */
export async function assertRoomLeaseFence(
  handle: QueryHandle,
  projectId: string,
  input: AssertRoomLeaseFenceInput,
): Promise<StoredRoomLeaseV1> {
  timestampMs(input.now, "now");
  validateRequiredLeaseFields(input);
  const current = await findActiveLease(handle, projectId, input.kind, input.resourceId);
  if (
    !current
    || !leaseFenceMatches(current, input)
    || timestampMs(current.expiresAt, "current lease expiresAt") <= timestampMs(input.now, "now")
  ) {
    throw new RoomLeaseFenceError(
      `Stale lease fence rejected for ${input.kind}:${input.resourceId} at epoch ${input.expectedEpoch}`,
      current,
    );
  }
  return current;
}

async function validateLeaseResource(
  handle: QueryHandle,
  projectId: string,
  input: AcquireRoomLeaseInput,
): Promise<void> {
  const rooms = await handle
    .select({ id: operationalRooms.id })
    .from(operationalRooms)
    .where(and(eq(operationalRooms.projectId, projectId), eq(operationalRooms.id, input.roomId)))
    .limit(1);
  if (rooms.length !== 1) {
    throw new RoomLeaseStoreError(
      "lease_resource_conflict",
      `Operational Room ${input.roomId} does not exist in project ${projectId}`,
    );
  }

  if ((input.kind === "room_worker" || input.kind === "human_takeover") && input.resourceId !== input.roomId) {
    throw new RoomLeaseStoreError(
      "lease_resource_conflict",
      `${input.kind} lease resource must be its Room ID`,
    );
  }
  if (input.kind === "sender") {
    const bindings = await handle
      .select({ id: roomBindings.id, hostId: roomBindings.hostId })
      .from(roomBindings)
      .where(
        and(
          eq(roomBindings.projectId, projectId),
          eq(roomBindings.roomId, input.roomId),
          eq(roomBindings.id, input.resourceId),
          eq(roomBindings.state, "attached"),
        ),
      )
      .limit(1);
    if (bindings.length !== 1) {
      throw new RoomLeaseStoreError(
        "lease_resource_conflict",
        `Sender lease resource ${input.resourceId} is not an attached binding of Room ${input.roomId}`,
      );
    }
    if (bindings[0]?.hostId !== input.hostId) {
      throw new RoomLeaseStoreError(
        "lease_resource_conflict",
        `Sender lease for binding ${input.resourceId} must remain on host ${bindings[0]?.hostId}`,
      );
    }
  }
}

async function insertLease(
  tx: DbTransaction,
  projectId: string,
  input: AcquireRoomLeaseInput,
  epoch: number,
): Promise<StoredRoomLeaseV1> {
  const rows = await tx
    .insert(roomLeases)
    .values({
      id: input.leaseId,
      projectId,
      roomId: input.roomId,
      kind: input.kind,
      resourceId: input.resourceId,
      holderId: input.holderId,
      hostId: input.hostId,
      epoch,
      acquiredAt: input.now,
      heartbeatAt: input.now,
      expiresAt: input.expiresAt,
      releasedAt: null,
    })
    .returning();
  if (!rows[0]) {
    throw new RoomLeaseStoreError(
      "lease_write_conflict",
      `Lease ${input.leaseId} was not inserted`,
    );
  }
  return rowToStoredLease(rows[0]);
}

async function lockLeaseResource(
  tx: DbTransaction,
  projectId: string,
  kind: RoomLeaseKind,
  resourceId: string,
): Promise<void> {
  const lockKey = `fusion-room-lease-v1:${projectId}:${kind}:${resourceId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
}

async function findActiveLease(
  handle: QueryHandle,
  projectId: string,
  kind: RoomLeaseKind,
  resourceId: string,
): Promise<StoredRoomLeaseV1 | null> {
  const rows = await handle
    .select()
    .from(roomLeases)
    .where(
      and(
        eq(roomLeases.projectId, projectId),
        eq(roomLeases.kind, kind),
        eq(roomLeases.resourceId, resourceId),
        isNull(roomLeases.releasedAt),
      ),
    )
    .limit(1);
  return rows[0] ? rowToStoredLease(rows[0]) : null;
}

async function findLatestLease(
  handle: QueryHandle,
  projectId: string,
  kind: RoomLeaseKind,
  resourceId: string,
): Promise<StoredRoomLeaseV1 | null> {
  const rows = await handle
    .select()
    .from(roomLeases)
    .where(
      and(
        eq(roomLeases.projectId, projectId),
        eq(roomLeases.kind, kind),
        eq(roomLeases.resourceId, resourceId),
      ),
    )
    .orderBy(desc(roomLeases.epoch))
    .limit(1);
  return rows[0] ? rowToStoredLease(rows[0]) : null;
}

function activeFencePredicate(
  projectId: string,
  input: RenewRoomLeaseInput | ReleaseRoomLeaseInput,
) {
  return and(
    eq(roomLeases.projectId, projectId),
    eq(roomLeases.roomId, input.roomId),
    eq(roomLeases.id, input.leaseId),
    eq(roomLeases.kind, input.kind),
    eq(roomLeases.resourceId, input.resourceId),
    eq(roomLeases.holderId, input.holderId),
    eq(roomLeases.hostId, input.hostId),
    eq(roomLeases.epoch, input.expectedEpoch),
    isNull(roomLeases.releasedAt),
  );
}

function leaseFenceMatches(
  current: StoredRoomLeaseV1,
  input: RenewRoomLeaseInput | ReleaseRoomLeaseInput | AssertRoomLeaseFenceInput,
): boolean {
  return current.id === input.leaseId
    && current.roomId === input.roomId
    && current.kind === input.kind
    && current.resourceId === input.resourceId
    && current.holderId === input.holderId
    && current.hostId === input.hostId
    && current.epoch === input.expectedEpoch
    && current.releasedAt === null;
}

function rowToStoredLease(row: typeof roomLeases.$inferSelect): StoredRoomLeaseV1 {
  const epoch = Number(row.epoch);
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw new RoomLeaseStoreError(
      "lease_write_conflict",
      `Persisted lease ${row.id} has invalid epoch ${String(row.epoch)}`,
    );
  }
  return {
    contractVersion: 1,
    id: row.id,
    roomId: row.roomId,
    kind: row.kind as RoomLeaseKind,
    resourceId: row.resourceId,
    holderId: row.holderId,
    hostId: row.hostId,
    epoch,
    acquiredAt: row.acquiredAt,
    heartbeatAt: row.heartbeatAt,
    expiresAt: row.expiresAt,
    releasedAt: row.releasedAt,
  };
}

function validateRequiredLeaseFields(input: {
  readonly leaseId: string;
  readonly roomId: string;
  readonly resourceId: string;
  readonly holderId: string;
  readonly hostId: string;
  readonly expectedEpoch: number | null;
}): void {
  for (const [field, value] of Object.entries({
    leaseId: input.leaseId,
    roomId: input.roomId,
    resourceId: input.resourceId,
    holderId: input.holderId,
    hostId: input.hostId,
  })) {
    if (value.trim().length === 0) {
      throw new RoomLeaseStoreError("invalid_lease_request", `${field} must not be empty`);
    }
  }
  if (input.expectedEpoch !== null && (!Number.isSafeInteger(input.expectedEpoch) || input.expectedEpoch < 0)) {
    throw new RoomLeaseStoreError(
      "invalid_lease_request",
      `expectedEpoch must be a non-negative safe integer or null`,
    );
  }
}

function validateLeaseWindow(now: string, expiresAt: string): void {
  if (timestampMs(expiresAt, "expiresAt") <= timestampMs(now, "now")) {
    throw new RoomLeaseStoreError(
      "invalid_lease_request",
      `Lease expiresAt must be later than now`,
    );
  }
}

function ensureMonotonicLeaseTime(now: string, current: StoredRoomLeaseV1 | null): void {
  if (!current) return;
  const boundary = current.releasedAt ?? current.heartbeatAt;
  if (timestampMs(now, "now") < timestampMs(boundary, "current lease time boundary")) {
    throw new RoomLeaseStoreError(
      "invalid_lease_request",
      `Lease time cannot move backwards before the current heartbeat or release`,
    );
  }
}

function timestampMs(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new RoomLeaseStoreError("invalid_lease_request", `${label} must be an ISO timestamp`);
  }
  return parsed;
}

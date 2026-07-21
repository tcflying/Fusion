import { and, asc, eq, isNull, lte, ne, or } from "drizzle-orm";

import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import {
  roomRbacAuthorizationStates,
  roomRbacGrants,
  roomRbacRegistryOperations,
  roomTrustedDeviceSessions,
} from "./postgres/schema/room.js";
import {
  RoomRbacRegistry,
  RoomRbacRegistryError,
  type RoomRbacAuthorizationStateV1,
  type RoomRbacRegistryOperationKindV1,
  type RoomRbacRegistryOperationRecordV1,
  type RoomRbacRegistryPersistenceV1,
  type RoomRbacRegistryTransactionV1,
  type StoredRoomTrustedDeviceSessionV1,
} from "./room-rbac-registry.js";
import type { RoomRbacGrantV1 } from "./room-rbac-policy.js";

function storedSession(row: typeof roomTrustedDeviceSessions.$inferSelect): StoredRoomTrustedDeviceSessionV1 {
  return Object.freeze({
    source: "trusted_device_session_registry",
    projectId: row.projectId,
    sessionId: row.sessionId,
    credentialDigest: row.credentialDigest,
    principalId: row.principalId,
    deviceId: row.deviceId,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    sessionVersion: row.sessionVersion,
  });
}

function authorizationState(row: typeof roomRbacAuthorizationStates.$inferSelect): RoomRbacAuthorizationStateV1 {
  return Object.freeze({
    projectId: row.projectId,
    authorizationVersion: row.authorizationVersion,
    updatedAt: row.updatedAt,
  });
}

function grant(row: typeof roomRbacGrants.$inferSelect): RoomRbacGrantV1 {
  return Object.freeze({
    grantId: row.grantId,
    principalId: row.principalId,
    role: row.role as RoomRbacGrantV1["role"],
    projectId: row.projectId,
    roomId: row.roomId,
    grantedAt: row.grantedAt,
    revokedAt: row.revokedAt,
  });
}

function operation(row: typeof roomRbacRegistryOperations.$inferSelect): RoomRbacRegistryOperationRecordV1 {
  return Object.freeze({
    projectId: row.projectId,
    commandKind: row.commandKind as RoomRbacRegistryOperationKindV1,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    entityType: row.entityType as RoomRbacRegistryOperationRecordV1["entityType"],
    entityId: row.entityId,
    authorizationVersion: row.authorizationVersion,
    sessionVersion: row.sessionVersion,
    occurredAt: row.occurredAt,
  });
}

class PostgresRoomRbacRegistryTransaction implements RoomRbacRegistryTransactionV1 {
  constructor(
    private readonly layer: AsyncDataLayer,
    private readonly transaction: DbTransaction,
  ) {}

  private assertProjectScope(projectId: string): void {
    if (this.layer.projectId && this.layer.projectId !== projectId) {
      throw new RoomRbacRegistryError("invalid_input", "Room RBAC registry data layer is bound to a different project");
    }
  }

  async getTrustedDeviceSession(projectId: string, sessionId: string): Promise<StoredRoomTrustedDeviceSessionV1 | null> {
    this.assertProjectScope(projectId);
    const row = await this.transaction.select().from(roomTrustedDeviceSessions)
      .where(and(eq(roomTrustedDeviceSessions.projectId, projectId), eq(roomTrustedDeviceSessions.sessionId, sessionId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row ? storedSession(row) : null;
  }

  async getTrustedDeviceSessionByCredentialDigest(projectId: string, credentialDigest: string): Promise<StoredRoomTrustedDeviceSessionV1 | null> {
    this.assertProjectScope(projectId);
    const row = await this.transaction.select().from(roomTrustedDeviceSessions)
      .where(and(eq(roomTrustedDeviceSessions.projectId, projectId), eq(roomTrustedDeviceSessions.credentialDigest, credentialDigest)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row ? storedSession(row) : null;
  }

  async hasTrustedDeviceSessionOutsideProject(projectId: string, credentialDigest: string): Promise<boolean> {
    this.assertProjectScope(projectId);
    const row = await this.transaction.select({ sessionId: roomTrustedDeviceSessions.sessionId }).from(roomTrustedDeviceSessions)
      .where(and(eq(roomTrustedDeviceSessions.credentialDigest, credentialDigest), ne(roomTrustedDeviceSessions.projectId, projectId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row !== null;
  }

  async insertTrustedDeviceSession(session: StoredRoomTrustedDeviceSessionV1): Promise<void> {
    this.assertProjectScope(session.projectId);
    await this.transaction.insert(roomTrustedDeviceSessions).values({
      projectId: session.projectId,
      sessionId: session.sessionId,
      credentialDigest: session.credentialDigest,
      principalId: session.principalId,
      deviceId: session.deviceId,
      issuedAt: session.issuedAt,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
      sessionVersion: session.sessionVersion,
    });
  }

  async replaceTrustedDeviceSession(session: StoredRoomTrustedDeviceSessionV1, expectedSessionVersion: number): Promise<boolean> {
    this.assertProjectScope(session.projectId);
    const rows = await this.transaction.update(roomTrustedDeviceSessions)
      .set({ revokedAt: session.revokedAt, sessionVersion: session.sessionVersion })
      .where(and(
        eq(roomTrustedDeviceSessions.projectId, session.projectId),
        eq(roomTrustedDeviceSessions.sessionId, session.sessionId),
        eq(roomTrustedDeviceSessions.sessionVersion, expectedSessionVersion),
      ))
      .returning({ sessionId: roomTrustedDeviceSessions.sessionId });
    return rows.length === 1;
  }

  async getAuthorizationState(projectId: string): Promise<RoomRbacAuthorizationStateV1 | null> {
    this.assertProjectScope(projectId);
    const row = await this.transaction.select().from(roomRbacAuthorizationStates)
      .where(eq(roomRbacAuthorizationStates.projectId, projectId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row ? authorizationState(row) : null;
  }

  async compareAndSetAuthorizationState(state: RoomRbacAuthorizationStateV1, expectedAuthorizationVersion: number): Promise<boolean> {
    this.assertProjectScope(state.projectId);
    if (expectedAuthorizationVersion === 0) {
      const rows = await this.transaction.insert(roomRbacAuthorizationStates)
        .values({
          projectId: state.projectId,
          authorizationVersion: state.authorizationVersion,
          updatedAt: state.updatedAt,
        })
        .onConflictDoNothing()
        .returning({ projectId: roomRbacAuthorizationStates.projectId });
      return rows.length === 1;
    }
    const rows = await this.transaction.update(roomRbacAuthorizationStates)
      .set({ authorizationVersion: state.authorizationVersion, updatedAt: state.updatedAt })
      .where(and(
        eq(roomRbacAuthorizationStates.projectId, state.projectId),
        eq(roomRbacAuthorizationStates.authorizationVersion, expectedAuthorizationVersion),
      ))
      .returning({ projectId: roomRbacAuthorizationStates.projectId });
    return rows.length === 1;
  }

  async getGrant(projectId: string, grantId: string): Promise<RoomRbacGrantV1 | null> {
    this.assertProjectScope(projectId);
    const row = await this.transaction.select().from(roomRbacGrants)
      .where(and(eq(roomRbacGrants.projectId, projectId), eq(roomRbacGrants.grantId, grantId)))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row ? grant(row) : null;
  }

  async insertGrant(value: RoomRbacGrantV1): Promise<void> {
    this.assertProjectScope(value.projectId);
    await this.transaction.insert(roomRbacGrants).values({
      projectId: value.projectId,
      grantId: value.grantId,
      principalId: value.principalId,
      role: value.role,
      roomId: value.roomId,
      grantedAt: value.grantedAt,
      revokedAt: value.revokedAt,
    });
  }

  async revokeGrant(projectId: string, grantId: string, revokedAt: string): Promise<boolean> {
    this.assertProjectScope(projectId);
    const rows = await this.transaction.update(roomRbacGrants)
      .set({ revokedAt })
      .where(and(
        eq(roomRbacGrants.projectId, projectId),
        eq(roomRbacGrants.grantId, grantId),
        isNull(roomRbacGrants.revokedAt),
      ))
      .returning({ grantId: roomRbacGrants.grantId });
    return rows.length === 1;
  }

  async listSnapshotGrants(input: {
    readonly projectId: string;
    readonly principalId: string;
    readonly roomId: string | null;
    readonly requestedAt: string;
  }): Promise<readonly RoomRbacGrantV1[]> {
    this.assertProjectScope(input.projectId);
    const roomScope = input.roomId === null
      ? isNull(roomRbacGrants.roomId)
      : or(isNull(roomRbacGrants.roomId), eq(roomRbacGrants.roomId, input.roomId));
    const rows = await this.transaction.select().from(roomRbacGrants)
      .where(and(
        eq(roomRbacGrants.projectId, input.projectId),
        eq(roomRbacGrants.principalId, input.principalId),
        isNull(roomRbacGrants.revokedAt),
        lte(roomRbacGrants.grantedAt, input.requestedAt),
        roomScope,
      ))
      .orderBy(asc(roomRbacGrants.grantId));
    return Object.freeze(rows.map(grant));
  }

  async getOperation(input: {
    readonly projectId: string;
    readonly commandKind: RoomRbacRegistryOperationKindV1;
    readonly idempotencyKey: string;
  }): Promise<RoomRbacRegistryOperationRecordV1 | null> {
    this.assertProjectScope(input.projectId);
    const row = await this.transaction.select().from(roomRbacRegistryOperations)
      .where(and(
        eq(roomRbacRegistryOperations.projectId, input.projectId),
        eq(roomRbacRegistryOperations.commandKind, input.commandKind),
        eq(roomRbacRegistryOperations.idempotencyKey, input.idempotencyKey),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return row ? operation(row) : null;
  }

  async insertOperation(value: RoomRbacRegistryOperationRecordV1): Promise<void> {
    this.assertProjectScope(value.projectId);
    await this.transaction.insert(roomRbacRegistryOperations).values({
      projectId: value.projectId,
      commandKind: value.commandKind,
      idempotencyKey: value.idempotencyKey,
      requestHash: value.requestHash,
      entityType: value.entityType,
      entityId: value.entityId,
      authorizationVersion: value.authorizationVersion,
      sessionVersion: value.sessionVersion,
      occurredAt: value.occurredAt,
    });
  }
}

class PostgresRoomRbacRegistryPersistence implements RoomRbacRegistryPersistenceV1 {
  constructor(private readonly layer: AsyncDataLayer) {}

  async transaction<T>(operation: (transaction: RoomRbacRegistryTransactionV1) => Promise<T>): Promise<T> {
    return this.layer.transactionImmediate(async (transaction) => operation(
      new PostgresRoomRbacRegistryTransaction(this.layer, transaction),
    ), { isolationLevel: "repeatable read" });
  }
}

export function createPostgresRoomRbacRegistry(layer: AsyncDataLayer): RoomRbacRegistry {
  return new RoomRbacRegistry(new PostgresRoomRbacRegistryPersistence(layer));
}

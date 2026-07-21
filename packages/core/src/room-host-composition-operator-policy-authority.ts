import { and, eq, sql } from "drizzle-orm";

import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import {
  projects,
  roomHostCompositionOperatorPolicyAuthority,
} from "./postgres/schema/central.js";
import { hashRoomValue } from "./room-integrity.js";

export const ROOM_HOST_COMPOSITION_OPERATOR_POLICY_AUTHORITY_CONTRACT_VERSION = 1 as const;
export const ROOM_HOST_COMPOSITION_OPERATOR_POLICY_AUTHORITY_LOCK_KEY = "fusion-room-host-composition-operator-policy-v1";

export type RoomHostCompositionOperatorWorkClassV1 = "normal" | "verifier" | "recovery";

/**
 * Pure operator-selected configuration only. Live model/account/tool/quota,
 * node health, latency, quality, and capacity facts are deliberately absent:
 * the Engine must obtain them from a verified runtime observation adapter.
 */
export interface RoomHostCompositionOperatorPolicyV1 {
  readonly connectorIds: readonly string[];
  readonly controllerAdmission: Readonly<{
    readonly workClass: RoomHostCompositionOperatorWorkClassV1;
    readonly slots: number;
  }>;
  readonly adapterBindings: Readonly<{
    readonly capabilityObservationAdapterId: string;
    readonly providerAdmissionSnapshotAdapterId: string;
    readonly capacityTelemetryAdapterId: string;
    readonly roomWorkerAuthorityAdapterId: string;
  }>;
}

export interface RoomHostCompositionOperatorPolicyAuthorityRecordV1 {
  readonly contractVersion: typeof ROOM_HOST_COMPOSITION_OPERATOR_POLICY_AUTHORITY_CONTRACT_VERSION;
  readonly projectId: string;
  readonly hostId: string;
  readonly bundleId: string;
  /** Host-controlled principal label; the persistence hash is not an identity proof. */
  readonly issuer: string;
  readonly policy: RoomHostCompositionOperatorPolicyV1;
  readonly policyHash: string;
  readonly revision: number;
  readonly issuedAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
}

export interface RoomHostCompositionOperatorPolicyAuthorityScopeV1 {
  readonly projectId: string;
  readonly hostId: string;
}

export interface InstallRoomHostCompositionOperatorPolicyAuthorityInputV1 extends RoomHostCompositionOperatorPolicyAuthorityScopeV1 {
  /** 0 creates a record; a nonzero value can only replace an explicitly revoked revision. */
  readonly expectedRevision: number;
  readonly bundleId: string;
  readonly issuer: string;
  /** Explicit finite authority. The store never invents a default TTL. */
  readonly expiresAt: string;
  readonly policy: RoomHostCompositionOperatorPolicyV1;
}

export interface RevokeRoomHostCompositionOperatorPolicyAuthorityInputV1 extends RoomHostCompositionOperatorPolicyAuthorityScopeV1 {
  readonly expectedRevision: number;
  readonly reason: string;
}

export interface CreateRoomHostCompositionOperatorPolicyAuthorityStoreInputV1 {
  /** Unscoped central host layer; project-bound layers cannot administer host policy. */
  readonly layer: AsyncDataLayer;
  /** Host-owned clock; callers cannot supply issued/updated/revoked timestamps. */
  readonly now?: () => string;
}

export interface RoomHostCompositionOperatorPolicyAuthorityStoreV1 {
  read(scope: RoomHostCompositionOperatorPolicyAuthorityScopeV1): Promise<RoomHostCompositionOperatorPolicyAuthorityRecordV1>;
  install(input: InstallRoomHostCompositionOperatorPolicyAuthorityInputV1): Promise<RoomHostCompositionOperatorPolicyAuthorityRecordV1>;
  revoke(input: RevokeRoomHostCompositionOperatorPolicyAuthorityInputV1): Promise<RoomHostCompositionOperatorPolicyAuthorityRecordV1>;
}

export class RoomHostCompositionOperatorPolicyAuthorityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RoomHostCompositionOperatorPolicyAuthorityError";
  }
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  return actual.length === canonicalExpected.length && actual.every((key, index) => key === canonicalExpected[index]);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isSafeReason(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_:-]{0,127}$/u.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function assertScope(value: RoomHostCompositionOperatorPolicyAuthorityScopeV1): void {
  if (!isBoundedIdentifier(value?.projectId) || !isBoundedIdentifier(value?.hostId)) {
    throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition authority scope is invalid");
  }
}

function freezePolicy(value: unknown): RoomHostCompositionOperatorPolicyV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["connectorIds", "controllerAdmission", "adapterBindings"])) {
    throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition operator policy is invalid");
  }
  const connectorIds = value.connectorIds;
  const admission = value.controllerAdmission;
  const adapterBindings = value.adapterBindings;
  if (
    !Array.isArray(connectorIds)
    || connectorIds.length === 0
    || !connectorIds.every(isBoundedIdentifier)
    || !isRecord(admission)
    || !hasExactKeys(admission, ["workClass", "slots"])
    || (admission.workClass !== "normal" && admission.workClass !== "verifier" && admission.workClass !== "recovery")
    || !isPositiveSafeInteger(admission.slots)
    || admission.slots > 2_147_483_647
    || !isRecord(adapterBindings)
    || !hasExactKeys(adapterBindings, [
      "capabilityObservationAdapterId",
      "providerAdmissionSnapshotAdapterId",
      "capacityTelemetryAdapterId",
      "roomWorkerAuthorityAdapterId",
    ])
    || !isBoundedIdentifier(adapterBindings.capabilityObservationAdapterId)
    || !isBoundedIdentifier(adapterBindings.providerAdmissionSnapshotAdapterId)
    || !isBoundedIdentifier(adapterBindings.capacityTelemetryAdapterId)
    || !isBoundedIdentifier(adapterBindings.roomWorkerAuthorityAdapterId)
  ) {
    throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition operator policy is invalid");
  }
  const sortedConnectorIds = [...connectorIds];
  if (
    sortedConnectorIds.some((connectorId, index) => index > 0 && sortedConnectorIds[index - 1] >= connectorId)
  ) {
    throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition operator policy is invalid");
  }
  return Object.freeze({
    connectorIds: Object.freeze(sortedConnectorIds),
    controllerAdmission: Object.freeze({
      workClass: admission.workClass,
      slots: admission.slots,
    }),
    adapterBindings: Object.freeze({
      capabilityObservationAdapterId: adapterBindings.capabilityObservationAdapterId,
      providerAdmissionSnapshotAdapterId: adapterBindings.providerAdmissionSnapshotAdapterId,
      capacityTelemetryAdapterId: adapterBindings.capacityTelemetryAdapterId,
      roomWorkerAuthorityAdapterId: adapterBindings.roomWorkerAuthorityAdapterId,
    }),
  });
}

function hashAuthorityEnvelope(input: Omit<RoomHostCompositionOperatorPolicyAuthorityRecordV1, "policyHash" | "updatedAt">): string {
  return hashRoomValue({
    contractVersion: input.contractVersion,
    projectId: input.projectId,
    hostId: input.hostId,
    bundleId: input.bundleId,
    issuer: input.issuer,
    policy: input.policy,
    revision: input.revision,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    revokedAt: input.revokedAt,
    revokedReason: input.revokedReason,
  });
}

function freezeRecord(input: Omit<RoomHostCompositionOperatorPolicyAuthorityRecordV1, "contractVersion" | "policyHash">): RoomHostCompositionOperatorPolicyAuthorityRecordV1 {
  const record = {
    contractVersion: ROOM_HOST_COMPOSITION_OPERATOR_POLICY_AUTHORITY_CONTRACT_VERSION,
    projectId: input.projectId,
    hostId: input.hostId,
    bundleId: input.bundleId,
    issuer: input.issuer,
    policy: freezePolicy(input.policy),
    revision: input.revision,
    issuedAt: input.issuedAt,
    updatedAt: input.updatedAt,
    expiresAt: input.expiresAt,
    revokedAt: input.revokedAt,
    revokedReason: input.revokedReason,
  } as const;
  return Object.freeze({ ...record, policyHash: hashAuthorityEnvelope(record) });
}

function assertHostLayer(input: CreateRoomHostCompositionOperatorPolicyAuthorityStoreInputV1): void {
  if (!input.layer) {
    throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition authority requires a central data layer");
  }
  if (input.layer.projectId !== undefined) {
    throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition authority rejects project-bound data layers");
  }
  if (input.now !== undefined && typeof input.now !== "function") {
    throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition authority clock is invalid");
  }
}

/**
 * FNXC:RoomHostCompositionOperatorAuthority 2026-07-20-09:18:
 * A host must deliberately select a finite, project-and-host-scoped adapter
 * bundle before Room execution can start. This store persists only static
 * adapter identities and controller placement; runtime provider facts remain
 * outside it and must be independently observed. Revocation is explicit and
 * does not silently replace a currently active policy.
 */
export function createRoomHostCompositionOperatorPolicyAuthorityStore(
  input: CreateRoomHostCompositionOperatorPolicyAuthorityStoreInputV1,
): RoomHostCompositionOperatorPolicyAuthorityStoreV1 {
  assertHostLayer(input);
  const now = input.now ?? (() => new Date().toISOString());
  const implementation = new RoomHostCompositionOperatorPolicyAuthorityStore(input.layer, now);
  return Object.freeze({
    read: implementation.read.bind(implementation),
    install: implementation.install.bind(implementation),
    revoke: implementation.revoke.bind(implementation),
  });
}

class RoomHostCompositionOperatorPolicyAuthorityStore {
  public constructor(
    private readonly layer: AsyncDataLayer,
    private readonly now: () => string,
  ) {}

  public async read(
    scope: RoomHostCompositionOperatorPolicyAuthorityScopeV1,
  ): Promise<RoomHostCompositionOperatorPolicyAuthorityRecordV1> {
    assertScope(scope);
    const asOf = this.currentTime();
    return this.layer.transactionImmediate(async (tx) => {
      await lockAuthority(tx, scope);
      const record = await loadVerifiedRecord(tx, scope);
      if (record.revokedAt !== null) {
        throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition authority is revoked");
      }
      if (Date.parse(asOf) >= Date.parse(record.expiresAt)) {
        throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition authority is expired");
      }
      if (Date.parse(asOf) < Date.parse(record.issuedAt)) {
        throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition authority is not yet valid");
      }
      return record;
    });
  }

  public async install(
    input: InstallRoomHostCompositionOperatorPolicyAuthorityInputV1,
  ): Promise<RoomHostCompositionOperatorPolicyAuthorityRecordV1> {
    assertScope(input);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition authority install revision is invalid");
    }
    if (!isBoundedIdentifier(input.bundleId) || !isBoundedIdentifier(input.issuer) || !isCanonicalTimestamp(input.expiresAt)) {
      throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition authority install input is invalid");
    }
    const policy = freezePolicy(input.policy);
    const issuedAt = this.currentTime();
    if (Date.parse(input.expiresAt) <= Date.parse(issuedAt)) {
      throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition authority expiry must be in the future");
    }
    return this.layer.transactionImmediate(async (tx) => {
      await lockAuthority(tx, input);
      await assertRegisteredProject(tx, input.projectId);
      const current = await loadVerifiedRecordOrNull(tx, input);
      if (current === null) {
        if (input.expectedRevision !== 0) {
          throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition authority installation requires expected revision 0");
        }
        const record = freezeRecord({
          projectId: input.projectId,
          hostId: input.hostId,
          bundleId: input.bundleId,
          issuer: input.issuer,
          policy,
          revision: 1,
          issuedAt,
          updatedAt: issuedAt,
          expiresAt: input.expiresAt,
          revokedAt: null,
          revokedReason: null,
        });
        await tx.insert(roomHostCompositionOperatorPolicyAuthority).values(toRow(record));
        return record;
      }
      if (current.revision !== input.expectedRevision) {
        throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition authority revision is stale");
      }
      if (current.revokedAt === null) {
        throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition authority is already installed and must be revoked before replacement");
      }
      const record = freezeRecord({
        projectId: input.projectId,
        hostId: input.hostId,
        bundleId: input.bundleId,
        issuer: input.issuer,
        policy,
        revision: current.revision + 1,
        issuedAt,
        updatedAt: issuedAt,
        expiresAt: input.expiresAt,
        revokedAt: null,
        revokedReason: null,
      });
      const updated = await tx
        .update(roomHostCompositionOperatorPolicyAuthority)
        .set(toRow(record))
        .where(and(
          eq(roomHostCompositionOperatorPolicyAuthority.projectId, input.projectId),
          eq(roomHostCompositionOperatorPolicyAuthority.hostId, input.hostId),
          eq(roomHostCompositionOperatorPolicyAuthority.revision, current.revision),
        ))
        .returning({ revision: roomHostCompositionOperatorPolicyAuthority.revision });
      if (!updated[0]) {
        throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition authority changed while locked");
      }
      return record;
    });
  }

  public async revoke(
    input: RevokeRoomHostCompositionOperatorPolicyAuthorityInputV1,
  ): Promise<RoomHostCompositionOperatorPolicyAuthorityRecordV1> {
    assertScope(input);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 || !isSafeReason(input.reason)) {
      throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition authority revocation input is invalid");
    }
    const revokedAt = this.currentTime();
    return this.layer.transactionImmediate(async (tx) => {
      await lockAuthority(tx, input);
      const current = await loadVerifiedRecord(tx, input);
      if (current.revision !== input.expectedRevision) {
        throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition authority revision is stale");
      }
      if (current.revokedAt !== null) {
        throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition authority is already revoked");
      }
      const record = freezeRecord({
        projectId: current.projectId,
        hostId: current.hostId,
        bundleId: current.bundleId,
        issuer: current.issuer,
        policy: current.policy,
        revision: current.revision + 1,
        issuedAt: current.issuedAt,
        updatedAt: revokedAt,
        expiresAt: current.expiresAt,
        revokedAt,
        revokedReason: input.reason,
      });
      const updated = await tx
        .update(roomHostCompositionOperatorPolicyAuthority)
        .set(toRow(record))
        .where(and(
          eq(roomHostCompositionOperatorPolicyAuthority.projectId, input.projectId),
          eq(roomHostCompositionOperatorPolicyAuthority.hostId, input.hostId),
          eq(roomHostCompositionOperatorPolicyAuthority.revision, current.revision),
        ))
        .returning({ revision: roomHostCompositionOperatorPolicyAuthority.revision });
      if (!updated[0]) {
        throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition authority changed while locked");
      }
      return record;
    });
  }

  private currentTime(): string {
    const value = this.now();
    if (!isCanonicalTimestamp(value)) {
      throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition authority clock returned an invalid timestamp");
    }
    return value;
  }
}

function toRow(record: RoomHostCompositionOperatorPolicyAuthorityRecordV1) {
  return {
    projectId: record.projectId,
    hostId: record.hostId,
    bundleId: record.bundleId,
    issuer: record.issuer,
    policyJson: record.policy,
    policyHash: record.policyHash,
    revision: record.revision,
    issuedAt: record.issuedAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    revokedReason: record.revokedReason,
  };
}

async function lockAuthority(
  tx: DbTransaction,
  scope: RoomHostCompositionOperatorPolicyAuthorityScopeV1,
): Promise<void> {
  const key = `${ROOM_HOST_COMPOSITION_OPERATOR_POLICY_AUTHORITY_LOCK_KEY}:${scope.projectId}:${scope.hostId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
}

async function assertRegisteredProject(tx: DbTransaction, projectId: string): Promise<void> {
  const rows = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!rows[0]) {
    throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition authority project is not registered");
  }
}

async function loadRawRecord(
  tx: DbTransaction,
  scope: RoomHostCompositionOperatorPolicyAuthorityScopeV1,
): Promise<(typeof roomHostCompositionOperatorPolicyAuthority.$inferSelect) | null> {
  const rows = await tx
    .select()
    .from(roomHostCompositionOperatorPolicyAuthority)
    .where(and(
      eq(roomHostCompositionOperatorPolicyAuthority.projectId, scope.projectId),
      eq(roomHostCompositionOperatorPolicyAuthority.hostId, scope.hostId),
    ))
    .limit(1);
  return rows[0] ?? null;
}

async function loadVerifiedRecordOrNull(
  tx: DbTransaction,
  scope: RoomHostCompositionOperatorPolicyAuthorityScopeV1,
): Promise<RoomHostCompositionOperatorPolicyAuthorityRecordV1 | null> {
  const row = await loadRawRecord(tx, scope);
  return row ? rowToRecord(row) : null;
}

async function loadVerifiedRecord(
  tx: DbTransaction,
  scope: RoomHostCompositionOperatorPolicyAuthorityScopeV1,
): Promise<RoomHostCompositionOperatorPolicyAuthorityRecordV1> {
  const record = await loadVerifiedRecordOrNull(tx, scope);
  if (record === null) {
    throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition authority is not installed");
  }
  return record;
}

function rowToRecord(
  row: typeof roomHostCompositionOperatorPolicyAuthority.$inferSelect,
): RoomHostCompositionOperatorPolicyAuthorityRecordV1 {
  if (
    !isBoundedIdentifier(row.projectId)
    || !isBoundedIdentifier(row.hostId)
    || !isBoundedIdentifier(row.bundleId)
    || !isBoundedIdentifier(row.issuer)
    || !isPositiveSafeInteger(row.revision)
    || !isCanonicalTimestamp(row.issuedAt)
    || !isCanonicalTimestamp(row.updatedAt)
    || !isCanonicalTimestamp(row.expiresAt)
    || (row.revokedAt !== null && !isCanonicalTimestamp(row.revokedAt))
    || (row.revokedReason !== null && !isSafeReason(row.revokedReason))
    || (row.revokedAt === null) !== (row.revokedReason === null)
    || Date.parse(row.issuedAt) >= Date.parse(row.expiresAt)
    || Date.parse(row.issuedAt) > Date.parse(row.updatedAt)
    || (row.revokedAt !== null && Date.parse(row.revokedAt) < Date.parse(row.issuedAt))
  ) {
    throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition authority record is malformed");
  }
  const record = freezeRecord({
    projectId: row.projectId,
    hostId: row.hostId,
    bundleId: row.bundleId,
    issuer: row.issuer,
    policy: freezePolicy(row.policyJson),
    revision: row.revision,
    issuedAt: row.issuedAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    revokedReason: row.revokedReason,
  });
  if (row.policyHash !== record.policyHash) {
    throw new RoomHostCompositionOperatorPolicyAuthorityError("Room host composition authority hash does not match its record");
  }
  return record;
}

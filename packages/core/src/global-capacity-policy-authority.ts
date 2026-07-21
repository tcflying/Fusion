import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";

import {
  GLOBAL_CAPACITY_LEDGER_LOCK_KEY,
  GLOBAL_CAPACITY_LEDGER_STATE_ID,
  assertGlobalCapacityLedgerPolicy,
  createGlobalCapacityLedgerPostgresPorts,
  hashGlobalCapacityLedgerPolicy,
  type GlobalCapacityLedgerPolicyV1,
  type GlobalCapacityLedgerPostgresPortsV1,
} from "./global-capacity-ledger-postgres.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import {
  globalCapacityClaims,
  globalCapacityPolicyAuthority,
  globalCapacityState,
} from "./postgres/schema/central.js";
import { roomGlobalConcurrencyClaims } from "./postgres/schema/room.js";

export const GLOBAL_CAPACITY_POLICY_AUTHORITY_CONTRACT_VERSION = 1 as const;
export const GLOBAL_CAPACITY_POLICY_AUTHORITY_ID = "global-capacity-policy-authority-v1";

export interface GlobalCapacityPolicyAuthorityRecordV1 {
  readonly contractVersion: typeof GLOBAL_CAPACITY_POLICY_AUTHORITY_CONTRACT_VERSION;
  readonly policy: GlobalCapacityLedgerPolicyV1;
  readonly policyHash: string;
  readonly revision: number;
  readonly updatedAt: string;
}

export interface InstallGlobalCapacityPolicyAuthorityInputV1 {
  /** Initial installation is explicit and only accepts the no-record revision. */
  readonly expectedRevision: 0;
  readonly policy: GlobalCapacityLedgerPolicyV1;
}

export interface UpdateGlobalCapacityPolicyAuthorityInputV1 {
  readonly expectedRevision: number;
  readonly policy: GlobalCapacityLedgerPolicyV1;
}

export interface CreateGlobalCapacityPolicyAuthorityStoreInputV1 {
  /** Unscoped central host layer; project-bound layers cannot administer global policy. */
  readonly layer: AsyncDataLayer;
  /** Host-owned clock; callers cannot choose a persisted authority timestamp. */
  readonly now?: () => string;
}

export interface GlobalCapacityPolicyAuthorityStoreV1 {
  read(): Promise<GlobalCapacityPolicyAuthorityRecordV1>;
  install(input: InstallGlobalCapacityPolicyAuthorityInputV1): Promise<GlobalCapacityPolicyAuthorityRecordV1>;
  update(input: UpdateGlobalCapacityPolicyAuthorityInputV1): Promise<GlobalCapacityPolicyAuthorityRecordV1>;
}

export interface GlobalCapacityPolicyAuthorityV1 extends GlobalCapacityPolicyAuthorityRecordV1 {
  createProjectPorts(projectId: string): GlobalCapacityLedgerPostgresPortsV1;
}

export class GlobalCapacityPolicyAuthorityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GlobalCapacityPolicyAuthorityError";
  }
}

interface LedgerStateRow {
  readonly revision: number;
  readonly policyHash: string;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function freezePolicy(value: unknown): GlobalCapacityLedgerPolicyV1 {
  assertGlobalCapacityLedgerPolicy(value);
  return Object.freeze({
    reservations: Object.freeze({
      verifierSlots: value.reservations.verifierSlots,
      recoverySlots: value.reservations.recoverySlots,
      legacyTaskTriageSlots: value.reservations.legacyTaskTriageSlots,
    }),
    snapshotTtlMs: value.snapshotTtlMs,
    leaseTtlMs: value.leaseTtlMs,
  });
}

function freezeRecord(input: Omit<GlobalCapacityPolicyAuthorityRecordV1, "contractVersion">): GlobalCapacityPolicyAuthorityRecordV1 {
  return Object.freeze({
    contractVersion: GLOBAL_CAPACITY_POLICY_AUTHORITY_CONTRACT_VERSION,
    policy: freezePolicy(input.policy),
    policyHash: input.policyHash,
    revision: input.revision,
    updatedAt: input.updatedAt,
  });
}

function assertHostLayer(input: CreateGlobalCapacityPolicyAuthorityStoreInputV1): void {
  if (!input.layer) {
    throw new GlobalCapacityPolicyAuthorityError("Global capacity policy authority requires a central data layer");
  }
  if (input.layer.projectId !== undefined) {
    throw new GlobalCapacityPolicyAuthorityError("Global capacity policy authority rejects project-bound data layers");
  }
  if (input.now !== undefined && typeof input.now !== "function") {
    throw new GlobalCapacityPolicyAuthorityError("Global capacity policy authority clock is invalid");
  }
}

/**
 * FNXC:GlobalCapacityPolicyAuthority 2026-07-20-04:04:
 * A central host, not the first project request or any settings surface, must
 * deliberately install the one reservation policy before capacity ports run.
 * Installation and replacement share the ledger advisory lock and state hash;
 * a policy change is withheld while live capacity claims could have been
 * admitted under the prior policy.
 */
export function createGlobalCapacityPolicyAuthorityStore(
  input: CreateGlobalCapacityPolicyAuthorityStoreInputV1,
): GlobalCapacityPolicyAuthorityStoreV1 {
  assertHostLayer(input);
  const now = input.now ?? (() => new Date().toISOString());
  const implementation = new GlobalCapacityPolicyAuthorityStore(input.layer, now);
  return Object.freeze({
    read: implementation.read.bind(implementation),
    install: implementation.install.bind(implementation),
    update: implementation.update.bind(implementation),
  });
}

export async function loadGlobalCapacityPolicyAuthority(
  input: CreateGlobalCapacityPolicyAuthorityStoreInputV1,
): Promise<GlobalCapacityPolicyAuthorityV1> {
  assertHostLayer(input);
  const now = input.now ?? (() => new Date().toISOString());
  const store = new GlobalCapacityPolicyAuthorityStore(input.layer, now);
  const record = await store.read();
  return Object.freeze({
    ...record,
    createProjectPorts: (projectId: string): GlobalCapacityLedgerPostgresPortsV1 =>
      createGlobalCapacityLedgerPostgresPorts({
        layer: input.layer,
        policy: record.policy,
        projectId,
        now,
      }),
  });
}

class GlobalCapacityPolicyAuthorityStore {
  public constructor(
    private readonly layer: AsyncDataLayer,
    private readonly now: () => string,
  ) {}

  public async read(): Promise<GlobalCapacityPolicyAuthorityRecordV1> {
    return this.layer.transactionImmediate(async (tx) => {
      await lockLedgerAuthority(tx);
      return loadVerifiedRecord(tx);
    });
  }

  public async install(input: InstallGlobalCapacityPolicyAuthorityInputV1): Promise<GlobalCapacityPolicyAuthorityRecordV1> {
    if (input.expectedRevision !== 0) {
      throw new GlobalCapacityPolicyAuthorityError("Global capacity policy installation requires expected revision 0");
    }
    const policy = freezePolicy(input.policy);
    const policyHash = hashGlobalCapacityLedgerPolicy(policy);
    const updatedAt = this.currentTime();
    return this.layer.transactionImmediate(async (tx) => {
      await lockLedgerAuthority(tx);
      if (await loadRawPolicyRow(tx)) {
        throw new GlobalCapacityPolicyAuthorityError("Global capacity policy authority is already installed");
      }
      const state = await loadLedgerState(tx);
      if (state && state.policyHash !== policyHash) {
        throw new GlobalCapacityPolicyAuthorityError("Global capacity ledger state conflicts with the requested policy");
      }
      if (await hasLiveCapacityClaims(tx, updatedAt)) {
        throw new GlobalCapacityPolicyAuthorityError("Global capacity policy installation is unsafe while live capacity claims exist");
      }
      const record = freezeRecord({ policy, policyHash, revision: 1, updatedAt });
      await tx.insert(globalCapacityPolicyAuthority).values({
        id: GLOBAL_CAPACITY_POLICY_AUTHORITY_ID,
        policyJson: record.policy,
        policyHash,
        revision: record.revision,
        updatedAt,
      });
      if (!state) {
        await tx.insert(globalCapacityState).values({
          id: GLOBAL_CAPACITY_LEDGER_STATE_ID,
          revision: 0,
          policyHash,
          updatedAt,
        });
      }
      return record;
    });
  }

  public async update(input: UpdateGlobalCapacityPolicyAuthorityInputV1): Promise<GlobalCapacityPolicyAuthorityRecordV1> {
    if (!isNonNegativeSafeInteger(input.expectedRevision)) {
      throw new GlobalCapacityPolicyAuthorityError("Global capacity policy update revision is invalid");
    }
    const policy = freezePolicy(input.policy);
    const policyHash = hashGlobalCapacityLedgerPolicy(policy);
    const updatedAt = this.currentTime();
    return this.layer.transactionImmediate(async (tx) => {
      await lockLedgerAuthority(tx);
      const current = await loadVerifiedRecord(tx);
      if (current.revision !== input.expectedRevision) {
        throw new GlobalCapacityPolicyAuthorityError("Global capacity policy authority revision is stale");
      }
      /*
      FNXC:GlobalCapacityRoomLeaseEpoch 2026-07-20-07:47:
      A running Room controller aligns its fenced Room lease to the installed
      central lease TTL. Allowing that TTL to change under an otherwise-idle
      controller would reintroduce a divergent expiry during its next acquire.
      Reservations and snapshot freshness may refresh live, but changing the
      lease epoch requires a deliberate control-plane restart/cutover instead.
      */
      if (current.policy.leaseTtlMs !== policy.leaseTtlMs) {
        throw new GlobalCapacityPolicyAuthorityError(
          "Global capacity policy replacement cannot change the installed lease TTL",
        );
      }
      const state = await requireSynchronizedLedgerState(tx, current.policyHash);
      if (current.policyHash !== policyHash) {
        await expireCapacityClaims(tx, updatedAt);
        if (await hasLiveCapacityClaims(tx, updatedAt)) {
          throw new GlobalCapacityPolicyAuthorityError("Global capacity policy replacement is unsafe while live capacity claims exist");
        }
      }
      const next = freezeRecord({
        policy,
        policyHash,
        revision: current.revision + 1,
        updatedAt,
      });
      const updated = await tx
        .update(globalCapacityPolicyAuthority)
        .set({ policyJson: next.policy, policyHash, revision: next.revision, updatedAt })
        .where(and(
          eq(globalCapacityPolicyAuthority.id, GLOBAL_CAPACITY_POLICY_AUTHORITY_ID),
          eq(globalCapacityPolicyAuthority.revision, current.revision),
        ))
        .returning({ revision: globalCapacityPolicyAuthority.revision });
      if (!updated[0]) {
        throw new GlobalCapacityPolicyAuthorityError("Global capacity policy authority changed while locked");
      }
      if (current.policyHash !== policyHash) {
        const synchronized = await tx
          .update(globalCapacityState)
          .set({
            policyHash,
            revision: sql`${globalCapacityState.revision} + 1`,
            updatedAt,
          })
          .where(and(
            eq(globalCapacityState.id, GLOBAL_CAPACITY_LEDGER_STATE_ID),
            eq(globalCapacityState.revision, state.revision),
          ))
          .returning({ revision: globalCapacityState.revision });
        if (!synchronized[0]) {
          throw new GlobalCapacityPolicyAuthorityError("Global capacity ledger state changed while locked");
        }
      }
      return next;
    });
  }

  private currentTime(): string {
    const value = this.now();
    if (!isCanonicalTimestamp(value)) {
      throw new GlobalCapacityPolicyAuthorityError("Global capacity policy authority clock returned an invalid timestamp");
    }
    return value;
  }
}

async function lockLedgerAuthority(tx: DbTransaction): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${GLOBAL_CAPACITY_LEDGER_LOCK_KEY}))`);
}

async function loadRawPolicyRow(tx: DbTransaction): Promise<(typeof globalCapacityPolicyAuthority.$inferSelect) | null> {
  const rows = await tx
    .select()
    .from(globalCapacityPolicyAuthority)
    .where(eq(globalCapacityPolicyAuthority.id, GLOBAL_CAPACITY_POLICY_AUTHORITY_ID))
    .limit(1);
  return rows[0] ?? null;
}

async function loadVerifiedRecord(tx: DbTransaction): Promise<GlobalCapacityPolicyAuthorityRecordV1> {
  const row = await loadRawPolicyRow(tx);
  if (!row) {
    throw new GlobalCapacityPolicyAuthorityError("Global capacity policy authority is not installed");
  }
  if (!isNonNegativeSafeInteger(row.revision) || row.revision < 1 || !isCanonicalTimestamp(row.updatedAt)) {
    throw new GlobalCapacityPolicyAuthorityError("Global capacity policy authority record is malformed");
  }
  const policy = freezePolicy(row.policyJson);
  const policyHash = hashGlobalCapacityLedgerPolicy(policy);
  if (row.policyHash !== policyHash) {
    throw new GlobalCapacityPolicyAuthorityError("Global capacity policy authority hash does not match its policy");
  }
  await requireSynchronizedLedgerState(tx, policyHash);
  return freezeRecord({ policy, policyHash, revision: row.revision, updatedAt: row.updatedAt });
}

async function loadLedgerState(tx: DbTransaction): Promise<LedgerStateRow | null> {
  const rows = await tx
    .select({
      revision: globalCapacityState.revision,
      policyHash: globalCapacityState.policyHash,
    })
    .from(globalCapacityState)
    .where(eq(globalCapacityState.id, GLOBAL_CAPACITY_LEDGER_STATE_ID))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (!isNonNegativeSafeInteger(row.revision) || typeof row.policyHash !== "string" || row.policyHash.length === 0) {
    throw new GlobalCapacityPolicyAuthorityError("Global capacity ledger state is malformed");
  }
  return row;
}

async function requireSynchronizedLedgerState(tx: DbTransaction, policyHash: string): Promise<LedgerStateRow> {
  const state = await loadLedgerState(tx);
  if (!state || state.policyHash !== policyHash) {
    throw new GlobalCapacityPolicyAuthorityError("Global capacity ledger state is missing or diverges from the central policy authority");
  }
  return state;
}

async function expireCapacityClaims(tx: DbTransaction, updatedAt: string): Promise<void> {
  await tx
    .update(globalCapacityClaims)
    .set({ releasedAt: updatedAt })
    .where(and(
      isNull(globalCapacityClaims.releasedAt),
      lte(globalCapacityClaims.expiresAt, updatedAt),
    ));
}

async function hasLiveCapacityClaims(tx: DbTransaction, updatedAt: string): Promise<boolean> {
  const centralRows = await tx
    .select({ id: globalCapacityClaims.id })
    .from(globalCapacityClaims)
    .where(and(
      isNull(globalCapacityClaims.releasedAt),
      gt(globalCapacityClaims.expiresAt, updatedAt),
    ))
    .limit(1);
  if (centralRows.length > 0) return true;
  /*
   * FNXC:GlobalCapacityLegacyRoomCutover 2026-07-20-07:16:
   * A policy replacement changes the limits used by central claims. An
   * unexpired pre-central Room claim is still live work even though it lives in
   * the retired table, so installation and replacement must both wait for it
   * to drain rather than treating it as a free slot.
   */
  const legacyRoomRows = await tx
    .select({ id: roomGlobalConcurrencyClaims.id })
    .from(roomGlobalConcurrencyClaims)
    .where(and(
      isNull(roomGlobalConcurrencyClaims.releasedAt),
      gt(roomGlobalConcurrencyClaims.expiresAt, updatedAt),
    ))
    .limit(1);
  return legacyRoomRows.length > 0;
}

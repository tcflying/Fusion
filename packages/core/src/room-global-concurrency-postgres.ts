import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";

import { GLOBAL_CAPACITY_LEDGER_LOCK_KEY } from "./global-capacity-ledger-postgres.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import { globalCapacityPolicyAuthority } from "./postgres/schema/central.js";
import {
  operationalRooms,
  roomGlobalConcurrencyClaims,
  roomGlobalConcurrencyOperations,
  roomGlobalConcurrencyState,
} from "./postgres/schema/room.js";
import { hashRoomValue } from "./room-integrity.js";

export const ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION = 1 as const;

export type RoomGlobalConcurrencyPostgresWorkClassV1 = "normal" | "verifier" | "recovery";

export interface RoomGlobalConcurrencyPostgresReservationsV1 {
  readonly verifierSlots: number;
  readonly recoverySlots: number;
  readonly legacyTaskTriageSlots: number;
}

export interface RoomGlobalConcurrencyPostgresLegacySnapshotV1 {
  readonly activeTaskSlots: number;
  readonly activeTriageSlots: number;
  readonly queuedTaskSlots: number;
  readonly queuedTriageSlots: number;
}

export interface RoomGlobalConcurrencyPostgresClaimV1 {
  readonly claimId: string;
  readonly projectId: string;
  readonly roomId: string;
  readonly workClass: RoomGlobalConcurrencyPostgresWorkClassV1;
  readonly slots: number;
  readonly holderId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
}

export interface RoomGlobalConcurrencyPostgresSnapshotV1 {
  readonly contractVersion: typeof ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION;
  readonly snapshotId: string;
  readonly stateRevision: number;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly totalSlots: number | null;
  readonly reservations: RoomGlobalConcurrencyPostgresReservationsV1;
  readonly legacy: RoomGlobalConcurrencyPostgresLegacySnapshotV1;
  readonly roomClaims: readonly RoomGlobalConcurrencyPostgresClaimV1[];
}

export interface RoomGlobalConcurrencyPostgresSnapshotReadInputV1 {
  readonly contractVersion: typeof ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION;
  readonly projectId: string;
  readonly asOf: string;
}

export interface RoomGlobalConcurrencyPostgresSnapshotPortV1 {
  readSnapshot(input: RoomGlobalConcurrencyPostgresSnapshotReadInputV1): Promise<RoomGlobalConcurrencyPostgresSnapshotV1>;
}

export interface RoomGlobalConcurrencyPostgresAcquireInputV1 {
  readonly contractVersion: typeof ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION;
  readonly projectId: string;
  readonly roomId: string;
  readonly claimId: string;
  readonly operationId: string;
  readonly workClass: RoomGlobalConcurrencyPostgresWorkClassV1;
  readonly slots: number;
  readonly holderId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly asOf: string;
  readonly expiresAt: string;
}

export interface RoomGlobalConcurrencyPostgresReleaseInputV1 {
  readonly contractVersion: typeof ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION;
  readonly projectId: string;
  readonly roomId: string;
  readonly claimId: string;
  readonly operationId: string;
  readonly holderId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly asOf: string;
}

/**
 * FNXC:RoomGlobalConcurrency 2026-07-19-18:45:
 * Long-running workers extend a capacity claim through its existing fenced
 * binding only; this request deliberately has no mutable class, scope, slot,
 * account, or ownership fields.
 */
export interface RoomGlobalConcurrencyPostgresRenewInputV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly claimId: string;
  readonly operationId: string;
  readonly holderId: string;
  readonly leaseId: string;
  readonly fence: number;
  readonly asOf: string;
  readonly expiresAt: string;
}

export interface RecoverDanglingRoomGlobalConcurrencyPostgresClaimsInputV1 {
  readonly contractVersion: typeof ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION;
  readonly projectId: string;
  readonly recoveryOperationId: string;
  readonly recovererId: string;
  readonly asOf: string;
}

export interface RoomGlobalConcurrencyPostgresBudgetV1 {
  readonly totalSlots: number;
  readonly occupiedSlots: number;
  readonly legacyTaskTriageActiveSlots: number;
  readonly roomActiveSlots: number;
  readonly normalOccupiedSlots: number;
  readonly verifierOccupiedSlots: number;
  readonly recoveryOccupiedSlots: number;
  readonly protectedLegacyTaskTriageSlots: number;
  readonly normalLimitSlots: number;
  readonly verifierLimitSlots: number;
  readonly recoveryLimitSlots: number;
  readonly requestedWorkClass: RoomGlobalConcurrencyPostgresWorkClassV1;
  readonly requestedSlots: number;
}

interface RoomGlobalConcurrencyPostgresStoreCommandBaseV1 {
  readonly contractVersion: typeof ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION;
  readonly expectedSnapshotId: string;
  readonly claimId: string;
  readonly fence: number;
}

export interface RoomGlobalConcurrencyPostgresAcquireStoreCommandV1 extends RoomGlobalConcurrencyPostgresStoreCommandBaseV1 {
  readonly kind: "acquire";
  readonly request: RoomGlobalConcurrencyPostgresAcquireInputV1;
  readonly budget: RoomGlobalConcurrencyPostgresBudgetV1;
}

export interface RoomGlobalConcurrencyPostgresReleaseStoreCommandV1 extends RoomGlobalConcurrencyPostgresStoreCommandBaseV1 {
  readonly kind: "release";
  readonly request: RoomGlobalConcurrencyPostgresReleaseInputV1;
  readonly claim: RoomGlobalConcurrencyPostgresClaimV1 | null;
}

export interface RoomGlobalConcurrencyPostgresRecoverDanglingStoreCommandV1 extends RoomGlobalConcurrencyPostgresStoreCommandBaseV1 {
  readonly kind: "recover_dangling";
  readonly projectId: string;
  readonly recoveryOperationId: string;
  readonly recovererId: string;
  readonly asOf: string;
  readonly claim: RoomGlobalConcurrencyPostgresClaimV1;
}

export interface RoomGlobalConcurrencyPostgresRenewStoreCommandV1 extends RoomGlobalConcurrencyPostgresStoreCommandBaseV1 {
  readonly kind: "renew";
  readonly request: RoomGlobalConcurrencyPostgresRenewInputV1;
  readonly claim: RoomGlobalConcurrencyPostgresClaimV1;
}

export type RoomGlobalConcurrencyPostgresClaimStoreCommandV1 =
  | RoomGlobalConcurrencyPostgresAcquireStoreCommandV1
  | RoomGlobalConcurrencyPostgresReleaseStoreCommandV1
  | RoomGlobalConcurrencyPostgresRecoverDanglingStoreCommandV1
  | RoomGlobalConcurrencyPostgresRenewStoreCommandV1;

export type RoomGlobalConcurrencyPostgresClaimStoreResultV1 =
  | {
      readonly ok: true;
      readonly action: "acquired" | "released" | "recovered";
      readonly replayed: boolean;
      readonly claimId: string;
      readonly fence: number;
    }
  | {
      readonly ok: true;
      readonly action: "renewed";
      readonly replayed: boolean;
      readonly claimId: string;
      readonly fence: number;
      readonly stateRevision: number;
    }
  | {
      readonly ok: false;
      readonly reason: "claim_not_found" | "claim_expired" | "idempotency_conflict" | "snapshot_stale" | "stale_fence" | "renewal_regression" | "store_rejected";
    };

export type RoomGlobalConcurrencyPostgresRenewResultV1 = Extract<
  RoomGlobalConcurrencyPostgresClaimStoreResultV1,
  { readonly ok: true; readonly action: "renewed" }
> | Extract<RoomGlobalConcurrencyPostgresClaimStoreResultV1, { readonly ok: false }>;

export interface RoomGlobalConcurrencyPostgresClaimStorePortV1 {
  apply(command: RoomGlobalConcurrencyPostgresClaimStoreCommandV1): Promise<RoomGlobalConcurrencyPostgresClaimStoreResultV1>;
  renew(input: RoomGlobalConcurrencyPostgresRenewInputV1): Promise<RoomGlobalConcurrencyPostgresRenewResultV1>;
}

export interface RoomGlobalConcurrencyPostgresLegacySnapshotReadInputV1 {
  readonly contractVersion: typeof ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION;
  readonly projectId: string;
  readonly asOf: string;
  readonly transaction: DbTransaction;
}

export interface RoomGlobalConcurrencyPostgresLegacySnapshotReaderV1 {
  readSnapshot(
    input: RoomGlobalConcurrencyPostgresLegacySnapshotReadInputV1,
  ): Promise<RoomGlobalConcurrencyPostgresLegacySnapshotV1>;
}

export interface RoomGlobalConcurrencyPostgresPolicyV1 {
  readonly totalSlots: number | null;
  readonly reservations: RoomGlobalConcurrencyPostgresReservationsV1;
  readonly snapshotTtlMs: number;
}

export interface CreateRoomGlobalConcurrencyPostgresPortsInputV1 {
  readonly layer: AsyncDataLayer;
  readonly policy: RoomGlobalConcurrencyPostgresPolicyV1;
  readonly legacySnapshotReader: RoomGlobalConcurrencyPostgresLegacySnapshotReaderV1;
  readonly projectId?: string;
}

export interface RoomGlobalConcurrencyPostgresPortsV1 {
  readonly snapshotPort: RoomGlobalConcurrencyPostgresSnapshotPortV1;
  readonly claimStore: RoomGlobalConcurrencyPostgresClaimStorePortV1;
}

export class RoomGlobalConcurrencyPostgresError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoomGlobalConcurrencyPostgresError";
  }
}

const GLOBAL_STATE_ID = "room-global-concurrency-v1";
const GLOBAL_LOCK_KEY = "fusion-room-global-concurrency-v1";
const FOREIGN_CLAIM_PREFIX = "room-global-concurrency-foreign:";
const FOREIGN_PROJECT_ID = "room-global-concurrency-foreign-project";
const FOREIGN_ROOM_ID = "room-global-concurrency-foreign-room";
const WORK_CLASSES = new Set<RoomGlobalConcurrencyPostgresWorkClassV1>(["normal", "verifier", "recovery"]);

interface GlobalStateRowV1 {
  readonly id: string;
  readonly revision: number;
  readonly updatedAt: string;
}

interface CommandIdentityV1 {
  readonly projectId: string;
  readonly asOf: string;
  readonly operationKey: string;
  readonly requestHash: string;
  readonly expectedAction: "acquired" | "released" | "recovered" | "renewed";
  readonly storedCommandKind: "acquire" | "release" | "recover_dangling";
  readonly storedAction: "acquired" | "released" | "recovered";
}

export function createRoomGlobalConcurrencyPostgresPorts(
  input: CreateRoomGlobalConcurrencyPostgresPortsInputV1,
): RoomGlobalConcurrencyPostgresPortsV1 {
  const implementation = new RoomGlobalConcurrencyPostgresPorts(input);
  return Object.freeze({
    snapshotPort: Object.freeze({
      readSnapshot: implementation.readSnapshot.bind(implementation),
    }),
    claimStore: Object.freeze({
      apply: implementation.apply.bind(implementation),
      renew: implementation.renew.bind(implementation),
    }),
  });
}

class RoomGlobalConcurrencyPostgresPorts {
  private readonly boundProjectId: string | undefined;

  constructor(private readonly input: CreateRoomGlobalConcurrencyPostgresPortsInputV1) {
    if (!input.layer || !input.legacySnapshotReader || typeof input.legacySnapshotReader.readSnapshot !== "function") {
      throw new RoomGlobalConcurrencyPostgresError("Room global concurrency PostgreSQL ports require a data layer and legacy snapshot reader");
    }
    if (input.projectId && input.layer.projectId && input.projectId !== input.layer.projectId) {
      throw new RoomGlobalConcurrencyPostgresError("Room global concurrency PostgreSQL factory project scope conflicts with its data layer");
    }
    if (input.projectId !== undefined && !canonicalString(input.projectId)) {
      throw new RoomGlobalConcurrencyPostgresError("Room global concurrency PostgreSQL factory project scope is invalid");
    }
    validatePolicy(input.policy);
    this.boundProjectId = input.projectId ?? input.layer.projectId;
  }

  async readSnapshot(
    snapshotInput: RoomGlobalConcurrencyPostgresSnapshotReadInputV1,
  ): Promise<RoomGlobalConcurrencyPostgresSnapshotV1> {
    validateSnapshotReadInput(snapshotInput);
    this.assertProjectScope(snapshotInput.projectId);
    return this.input.layer.transactionImmediate(async (tx) => {
      const state = await lockAndRefreshState(tx, snapshotInput.asOf);
      return this.buildSnapshot(tx, state, snapshotInput.projectId, snapshotInput.asOf);
    });
  }

  async apply(
    command: RoomGlobalConcurrencyPostgresClaimStoreCommandV1,
  ): Promise<RoomGlobalConcurrencyPostgresClaimStoreResultV1> {
    const identity = commandIdentity(command);
    if (!identity) return { ok: false, reason: "store_rejected" };
    try {
      this.assertProjectScope(identity.projectId);
    } catch {
      return { ok: false, reason: "store_rejected" };
    }
    return this.input.layer.transactionImmediate(async (tx) => {
      if ((command.kind === "acquire" || command.kind === "renew") && await isCentralCapacityCutoverActive(tx)) {
        return { ok: false, reason: "store_rejected" };
      }
      const state = await lockAndRefreshState(tx, identity.asOf);
      if (command.kind === "renew") {
        return this.applyRenewWithSnapshot(tx, command, identity, state);
      }
      const replay = await findOperation(tx, identity.projectId, identity.storedCommandKind, identity.operationKey);
      if (replay) {
        if (
          replay.claimId !== command.claimId
          || replay.requestHash !== identity.requestHash
          || replay.action !== identity.storedAction
          || replay.fence !== command.fence
        ) {
          return { ok: false, reason: "idempotency_conflict" };
        }
        return successResult(identity, true, replay.claimId, replay.fence, state.revision);
      }

      const snapshot = await this.buildSnapshot(tx, state, identity.projectId, identity.asOf);
      if (snapshot.snapshotId !== command.expectedSnapshotId) {
        return { ok: false, reason: "snapshot_stale" };
      }
      switch (command.kind) {
        case "acquire":
          return this.applyAcquire(tx, command, identity, snapshot, state);
        case "release":
          return this.applyRelease(tx, command, identity, state);
        case "recover_dangling":
          return this.applyRecovery(tx, command, identity, state);
      }
    });
  }

  async renew(
    request: RoomGlobalConcurrencyPostgresRenewInputV1,
  ): Promise<RoomGlobalConcurrencyPostgresRenewResultV1> {
    if (!validRenewRequest(request)) return { ok: false, reason: "store_rejected" };
    try {
      this.assertProjectScope(request.projectId);
    } catch {
      return { ok: false, reason: "store_rejected" };
    }
    return this.input.layer.transactionImmediate(async (tx) => {
      if (await isCentralCapacityCutoverActive(tx)) {
        return { ok: false, reason: "store_rejected" };
      }
      const state = await lockAndRefreshState(tx, request.asOf);
      const claim = await findClaim(tx, request.projectId, request.claimId);
      if (!claim) return { ok: false, reason: "claim_not_found" };
      if (Date.parse(claim.expiresAt) <= Date.parse(request.asOf)) return { ok: false, reason: "claim_expired" };
      if (claim.releasedAt !== null) return { ok: false, reason: "claim_not_found" };
      const snapshot = await this.buildSnapshot(tx, state, request.projectId, request.asOf);
      const command: RoomGlobalConcurrencyPostgresRenewStoreCommandV1 = {
        contractVersion: ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION,
        kind: "renew",
        expectedSnapshotId: snapshot.snapshotId,
        claimId: request.claimId,
        fence: request.fence,
        request,
        claim: rowToClaim(claim),
      };
      const identity = commandIdentity(command);
      if (!identity) return { ok: false, reason: "store_rejected" };
      return (await this.applyRenew(tx, command, identity, state)) as RoomGlobalConcurrencyPostgresRenewResultV1;
    });
  }

  private async buildSnapshot(
    tx: DbTransaction,
    state: GlobalStateRowV1,
    projectId: string,
    asOf: string,
  ): Promise<RoomGlobalConcurrencyPostgresSnapshotV1> {
    const legacy = await this.input.legacySnapshotReader.readSnapshot({
      contractVersion: ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION,
      projectId,
      asOf,
      transaction: tx,
    });
    if (!validLegacySnapshot(legacy)) {
      throw new RoomGlobalConcurrencyPostgresError("Legacy task and triage snapshot is invalid");
    }
    const activeRows = await loadActiveClaims(tx, asOf);
    const ownClaims = activeRows
      .filter((claim) => claim.projectId === projectId)
      .map(rowToClaim);
    const foreignClaims = summarizeForeignClaims(activeRows, projectId, asOf, snapshotExpiry(asOf, this.input.policy.snapshotTtlMs));
    const snapshotClaims = [...ownClaims, ...foreignClaims];
    const expiresAt = snapshotExpiry(asOf, this.input.policy.snapshotTtlMs);
    const snapshotId = hashRoomValue({
      contractVersion: ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION,
      observedAt: asOf,
      revision: state.revision,
      policy: this.input.policy,
      legacy,
      claims: activeRows
        .map((claim) => ({
          id: claim.id,
          projectId: claim.projectId,
          roomId: claim.roomId,
          workClass: claim.workClass,
          slots: claim.slots,
          holderId: claim.holderId,
          leaseId: claim.leaseId,
          fence: claim.fence,
          acquiredAt: claim.acquiredAt,
          expiresAt: claim.expiresAt,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    });
    return Object.freeze({
      contractVersion: ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION,
      snapshotId,
      stateRevision: state.revision,
      observedAt: asOf,
      expiresAt,
      totalSlots: this.input.policy.totalSlots,
      reservations: Object.freeze({ ...this.input.policy.reservations }),
      legacy: Object.freeze({ ...legacy }),
      roomClaims: Object.freeze(snapshotClaims.map((claim) => Object.freeze(claim))),
    });
  }

  private async applyAcquire(
    tx: DbTransaction,
    command: RoomGlobalConcurrencyPostgresAcquireStoreCommandV1,
    identity: CommandIdentityV1,
    snapshot: RoomGlobalConcurrencyPostgresSnapshotV1,
    state: GlobalStateRowV1,
  ): Promise<RoomGlobalConcurrencyPostgresClaimStoreResultV1> {
    const existing = await findClaimById(tx, command.claimId);
    if (existing) return { ok: false, reason: "store_rejected" };
    if (!await roomExists(tx, command.request.projectId, command.request.roomId)) {
      return { ok: false, reason: "store_rejected" };
    }
    if (!canAdmit(snapshot, command.request.workClass, command.request.slots)) {
      return { ok: false, reason: "store_rejected" };
    }
    await tx.insert(roomGlobalConcurrencyClaims).values({
      id: command.request.claimId,
      projectId: command.request.projectId,
      roomId: command.request.roomId,
      workClass: command.request.workClass,
      slots: command.request.slots,
      holderId: command.request.holderId,
      leaseId: command.request.leaseId,
      fence: command.request.fence,
      acquiredAt: command.request.asOf,
      expiresAt: command.request.expiresAt,
      releasedAt: null,
    });
    await bumpState(tx, state, command.request.asOf);
    await insertOperation(tx, identity, command.claimId, command.fence);
    return {
      ok: true,
      action: "acquired",
      replayed: false,
      claimId: command.claimId,
      fence: command.fence,
    };
  }

  private async applyRelease(
    tx: DbTransaction,
    command: RoomGlobalConcurrencyPostgresReleaseStoreCommandV1,
    identity: CommandIdentityV1,
    state: GlobalStateRowV1,
  ): Promise<RoomGlobalConcurrencyPostgresClaimStoreResultV1> {
    const claim = await findClaim(tx, command.request.projectId, command.claimId);
    if (!claim || claim.releasedAt !== null) return { ok: false, reason: "claim_not_found" };
    if (
      claim.roomId !== command.request.roomId
      || claim.holderId !== command.request.holderId
      || claim.leaseId !== command.request.leaseId
      || claim.fence !== command.request.fence
    ) {
      return { ok: false, reason: "stale_fence" };
    }
    const released = await tx
      .update(roomGlobalConcurrencyClaims)
      .set({ releasedAt: command.request.asOf })
      .where(and(
        eq(roomGlobalConcurrencyClaims.id, claim.id),
        eq(roomGlobalConcurrencyClaims.projectId, claim.projectId),
        eq(roomGlobalConcurrencyClaims.fence, claim.fence),
        isNull(roomGlobalConcurrencyClaims.releasedAt),
      ))
      .returning({ id: roomGlobalConcurrencyClaims.id });
    if (!released[0]) return { ok: false, reason: "stale_fence" };
    await bumpState(tx, state, command.request.asOf);
    await insertOperation(tx, identity, command.claimId, command.fence);
    return {
      ok: true,
      action: "released",
      replayed: false,
      claimId: command.claimId,
      fence: command.fence,
    };
  }

  private async applyRecovery(
    tx: DbTransaction,
    command: RoomGlobalConcurrencyPostgresRecoverDanglingStoreCommandV1,
    identity: CommandIdentityV1,
    state: GlobalStateRowV1,
  ): Promise<RoomGlobalConcurrencyPostgresClaimStoreResultV1> {
    const claim = await findClaim(tx, command.projectId, command.claimId);
    if (!claim || claim.releasedAt !== null) return { ok: false, reason: "claim_not_found" };
    if (
      claim.roomId !== command.claim.roomId
      || claim.holderId !== command.claim.holderId
      || claim.leaseId !== command.claim.leaseId
      || claim.fence !== command.fence
    ) {
      return { ok: false, reason: "stale_fence" };
    }
    if (Date.parse(claim.expiresAt) > Date.parse(command.asOf)) {
      return { ok: false, reason: "store_rejected" };
    }
    const released = await tx
      .update(roomGlobalConcurrencyClaims)
      .set({ releasedAt: command.asOf })
      .where(and(
        eq(roomGlobalConcurrencyClaims.id, claim.id),
        eq(roomGlobalConcurrencyClaims.projectId, claim.projectId),
        eq(roomGlobalConcurrencyClaims.fence, claim.fence),
        isNull(roomGlobalConcurrencyClaims.releasedAt),
      ))
      .returning({ id: roomGlobalConcurrencyClaims.id });
    if (!released[0]) return { ok: false, reason: "stale_fence" };
    await bumpState(tx, state, command.asOf);
    await insertOperation(tx, identity, command.claimId, command.fence);
    return {
      ok: true,
      action: "recovered",
      replayed: false,
      claimId: command.claimId,
      fence: command.fence,
    };
  }

  private async applyRenew(
    tx: DbTransaction,
    command: RoomGlobalConcurrencyPostgresRenewStoreCommandV1,
    identity: CommandIdentityV1,
    state: GlobalStateRowV1,
  ): Promise<RoomGlobalConcurrencyPostgresClaimStoreResultV1> {
    const claim = await findClaim(tx, command.request.projectId, command.request.claimId);
    if (!claim) return { ok: false, reason: "claim_not_found" };
    if (Date.parse(claim.expiresAt) <= Date.parse(command.request.asOf)) {
      return { ok: false, reason: "claim_expired" };
    }
    if (claim.releasedAt !== null) return { ok: false, reason: "claim_not_found" };
    if (!renewMatchesClaim(command, claim)) return { ok: false, reason: "stale_fence" };
    const replay = await findOperation(tx, identity.projectId, identity.storedCommandKind, identity.operationKey);
    if (replay) {
      if (
        replay.claimId !== command.claimId
        || replay.requestHash !== identity.requestHash
        || replay.action !== identity.storedAction
        || replay.fence !== command.fence
      ) {
        return { ok: false, reason: "idempotency_conflict" };
      }
      return successResult(identity, true, replay.claimId, replay.fence, state.revision) as RoomGlobalConcurrencyPostgresRenewResultV1;
    }
    if (claim.expiresAt !== command.claim.expiresAt) return { ok: false, reason: "snapshot_stale" };
    if (Date.parse(command.request.expiresAt) <= Date.parse(claim.expiresAt)) {
      return { ok: false, reason: "renewal_regression" };
    }
    const renewed = await tx
      .update(roomGlobalConcurrencyClaims)
      .set({ expiresAt: command.request.expiresAt })
      .where(and(
        eq(roomGlobalConcurrencyClaims.id, claim.id),
        eq(roomGlobalConcurrencyClaims.projectId, claim.projectId),
        eq(roomGlobalConcurrencyClaims.roomId, claim.roomId),
        eq(roomGlobalConcurrencyClaims.holderId, claim.holderId),
        eq(roomGlobalConcurrencyClaims.leaseId, claim.leaseId),
        eq(roomGlobalConcurrencyClaims.fence, claim.fence),
        eq(roomGlobalConcurrencyClaims.expiresAt, claim.expiresAt),
        isNull(roomGlobalConcurrencyClaims.releasedAt),
      ))
      .returning({ id: roomGlobalConcurrencyClaims.id });
    if (!renewed[0]) return { ok: false, reason: "stale_fence" };
    const nextState = await bumpState(tx, state, command.request.asOf);
    await insertOperation(tx, identity, command.claimId, command.fence);
    return successResult(identity, false, command.claimId, command.fence, nextState.revision);
  }

  private async applyRenewWithSnapshot(
    tx: DbTransaction,
    command: RoomGlobalConcurrencyPostgresRenewStoreCommandV1,
    identity: CommandIdentityV1,
    state: GlobalStateRowV1,
  ): Promise<RoomGlobalConcurrencyPostgresClaimStoreResultV1> {
    const snapshot = await this.buildSnapshot(tx, state, identity.projectId, identity.asOf);
    if (snapshot.snapshotId !== command.expectedSnapshotId) return { ok: false, reason: "snapshot_stale" };
    return this.applyRenew(tx, command, identity, state);
  }

  private assertProjectScope(projectId: string): void {
    if (this.boundProjectId && this.boundProjectId !== projectId) {
      throw new RoomGlobalConcurrencyPostgresError("Room global concurrency request violates the factory project scope");
    }
  }
}

/*
FNXC:LegacyRoomCentralCutover 2026-07-20-07:27:
The retired Room-only claim writer must take the same central ledger lock as
policy installation before it decides whether it may acquire or renew. This
makes cutover a drain boundary: either the old writer commits first and blocks
installation through its live claim, or installation commits first and every
later old acquire/renew is withheld. Release remains available to drain work
that began before the cutover.
*/
async function isCentralCapacityCutoverActive(tx: DbTransaction): Promise<boolean> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${GLOBAL_CAPACITY_LEDGER_LOCK_KEY}))`);
  const rows = await tx
    .select({ id: globalCapacityPolicyAuthority.id })
    .from(globalCapacityPolicyAuthority)
    .limit(1);
  return rows.length > 0;
}

async function lockAndRefreshState(tx: DbTransaction, asOf: string): Promise<GlobalStateRowV1> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${GLOBAL_LOCK_KEY}))`);
  await tx
    .insert(roomGlobalConcurrencyState)
    .values({ id: GLOBAL_STATE_ID, revision: 0, updatedAt: asOf })
    .onConflictDoNothing({ target: roomGlobalConcurrencyState.id });
  const state = await loadState(tx);
  const expired = await tx
    .update(roomGlobalConcurrencyClaims)
    .set({ releasedAt: asOf })
    .where(and(isNull(roomGlobalConcurrencyClaims.releasedAt), lte(roomGlobalConcurrencyClaims.expiresAt, asOf)))
    .returning({ id: roomGlobalConcurrencyClaims.id });
  return expired.length > 0 ? bumpState(tx, state, asOf) : state;
}

async function loadState(tx: DbTransaction): Promise<GlobalStateRowV1> {
  const rows = await tx
    .select({
      id: roomGlobalConcurrencyState.id,
      revision: roomGlobalConcurrencyState.revision,
      updatedAt: roomGlobalConcurrencyState.updatedAt,
    })
    .from(roomGlobalConcurrencyState)
    .where(eq(roomGlobalConcurrencyState.id, GLOBAL_STATE_ID))
    .limit(1);
  const row = rows[0];
  if (!row) throw new RoomGlobalConcurrencyPostgresError("Room global concurrency state could not be initialized");
  return row;
}

async function bumpState(
  tx: DbTransaction,
  state: GlobalStateRowV1,
  updatedAt: string,
): Promise<GlobalStateRowV1> {
  const rows = await tx
    .update(roomGlobalConcurrencyState)
    .set({
      revision: sql`${roomGlobalConcurrencyState.revision} + 1`,
      updatedAt,
    })
    .where(and(
      eq(roomGlobalConcurrencyState.id, GLOBAL_STATE_ID),
      eq(roomGlobalConcurrencyState.revision, state.revision),
    ))
    .returning({
      id: roomGlobalConcurrencyState.id,
      revision: roomGlobalConcurrencyState.revision,
      updatedAt: roomGlobalConcurrencyState.updatedAt,
    });
  const row = rows[0];
  if (!row) throw new RoomGlobalConcurrencyPostgresError("Room global concurrency state changed while locked");
  return row;
}

async function loadActiveClaims(
  tx: DbTransaction,
  asOf: string,
): Promise<readonly (typeof roomGlobalConcurrencyClaims.$inferSelect)[]> {
  return tx
    .select()
    .from(roomGlobalConcurrencyClaims)
    .where(and(isNull(roomGlobalConcurrencyClaims.releasedAt), gt(roomGlobalConcurrencyClaims.expiresAt, asOf)));
}

async function findClaimById(
  tx: DbTransaction,
  claimId: string,
): Promise<(typeof roomGlobalConcurrencyClaims.$inferSelect) | null> {
  const rows = await tx
    .select()
    .from(roomGlobalConcurrencyClaims)
    .where(eq(roomGlobalConcurrencyClaims.id, claimId))
    .limit(1);
  return rows[0] ?? null;
}

async function findClaim(
  tx: DbTransaction,
  projectId: string,
  claimId: string,
): Promise<(typeof roomGlobalConcurrencyClaims.$inferSelect) | null> {
  const rows = await tx
    .select()
    .from(roomGlobalConcurrencyClaims)
    .where(and(
      eq(roomGlobalConcurrencyClaims.id, claimId),
      eq(roomGlobalConcurrencyClaims.projectId, projectId),
    ))
    .limit(1);
  return rows[0] ?? null;
}

async function roomExists(tx: DbTransaction, projectId: string, roomId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: operationalRooms.id })
    .from(operationalRooms)
    .where(and(eq(operationalRooms.projectId, projectId), eq(operationalRooms.id, roomId)))
    .limit(1);
  return rows.length === 1;
}

async function findOperation(
  tx: DbTransaction,
  projectId: string,
  commandKind: CommandIdentityV1["storedCommandKind"],
  operationKey: string,
): Promise<(typeof roomGlobalConcurrencyOperations.$inferSelect) | null> {
  const rows = await tx
    .select()
    .from(roomGlobalConcurrencyOperations)
    .where(and(
      eq(roomGlobalConcurrencyOperations.projectId, projectId),
      eq(roomGlobalConcurrencyOperations.commandKind, commandKind),
      eq(roomGlobalConcurrencyOperations.operationKey, operationKey),
    ))
    .limit(1);
  return rows[0] ?? null;
}

async function insertOperation(
  tx: DbTransaction,
  identity: CommandIdentityV1,
  claimId: string,
  fence: number,
): Promise<void> {
  await tx.insert(roomGlobalConcurrencyOperations).values({
    projectId: identity.projectId,
    commandKind: identity.storedCommandKind,
    operationKey: identity.operationKey,
    claimId,
    requestHash: identity.requestHash,
    action: identity.storedAction,
    fence,
    occurredAt: identity.asOf,
  });
}

function summarizeForeignClaims(
  rows: readonly (typeof roomGlobalConcurrencyClaims.$inferSelect)[],
  projectId: string,
  observedAt: string,
  expiresAt: string,
): readonly RoomGlobalConcurrencyPostgresClaimV1[] {
  const totals = new Map<RoomGlobalConcurrencyPostgresWorkClassV1, number>();
  for (const row of rows) {
    if (row.projectId === projectId) continue;
    const workClass = row.workClass as RoomGlobalConcurrencyPostgresWorkClassV1;
    totals.set(workClass, (totals.get(workClass) ?? 0) + row.slots);
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([workClass, slots]) => Object.freeze({
      claimId: FOREIGN_CLAIM_PREFIX + workClass,
      projectId: FOREIGN_PROJECT_ID,
      roomId: FOREIGN_ROOM_ID,
      workClass,
      slots,
      holderId: FOREIGN_PROJECT_ID,
      leaseId: FOREIGN_PROJECT_ID,
      fence: 1,
      acquiredAt: observedAt,
      expiresAt,
    }));
}

function rowToClaim(row: typeof roomGlobalConcurrencyClaims.$inferSelect): RoomGlobalConcurrencyPostgresClaimV1 {
  return {
    claimId: row.id,
    projectId: row.projectId,
    roomId: row.roomId,
    workClass: row.workClass as RoomGlobalConcurrencyPostgresWorkClassV1,
    slots: row.slots,
    holderId: row.holderId,
    leaseId: row.leaseId,
    fence: row.fence,
    acquiredAt: row.acquiredAt,
    expiresAt: row.expiresAt,
  };
}

function commandIdentity(command: unknown): CommandIdentityV1 | null {
  if (!isRecord(command)) return null;
  if (command.contractVersion !== ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION) return null;
  if (!canonicalString(command.expectedSnapshotId) || !canonicalString(command.claimId) || command.claimId.startsWith(FOREIGN_CLAIM_PREFIX)) return null;
  if (!positiveSafeInteger(command.fence)) return null;
  if (command.kind === "acquire" && validAcquireCommand(command)) {
    return {
      projectId: command.request.projectId,
      asOf: command.request.asOf,
      operationKey: command.request.operationId,
      requestHash: hashRoomValue({
        kind: command.kind,
        projectId: command.request.projectId,
        roomId: command.request.roomId,
        claimId: command.request.claimId,
        operationId: command.request.operationId,
        workClass: command.request.workClass,
        slots: command.request.slots,
        holderId: command.request.holderId,
        leaseId: command.request.leaseId,
        fence: command.request.fence,
        expiresAt: command.request.expiresAt,
      }),
      expectedAction: "acquired",
      storedCommandKind: "acquire",
      storedAction: "acquired",
    };
  }
  if (command.kind === "release" && validReleaseCommand(command)) {
    return {
      projectId: command.request.projectId,
      asOf: command.request.asOf,
      operationKey: command.request.operationId,
      requestHash: hashRoomValue({
        kind: command.kind,
        projectId: command.request.projectId,
        roomId: command.request.roomId,
        claimId: command.request.claimId,
        operationId: command.request.operationId,
        holderId: command.request.holderId,
        leaseId: command.request.leaseId,
        fence: command.request.fence,
      }),
      expectedAction: "released",
      storedCommandKind: "release",
      storedAction: "released",
    };
  }
  if (command.kind === "recover_dangling" && validRecoveryCommand(command)) {
    return {
      projectId: command.projectId,
      asOf: command.asOf,
      operationKey: hashRoomValue({ recoveryOperationId: command.recoveryOperationId, claimId: command.claimId }),
      requestHash: hashRoomValue({
        kind: command.kind,
        projectId: command.projectId,
        claimId: command.claimId,
        recoveryOperationId: command.recoveryOperationId,
        recovererId: command.recovererId,
        fence: command.fence,
      }),
      expectedAction: "recovered",
      storedCommandKind: "recover_dangling",
      storedAction: "recovered",
    };
  }
  if (command.kind === "renew" && validRenewCommand(command)) {
    return {
      projectId: command.request.projectId,
      asOf: command.request.asOf,
      operationKey: `renew:${hashRoomValue({ operationId: command.request.operationId, claimId: command.request.claimId })}`,
      requestHash: hashRoomValue({
        kind: command.kind,
        projectId: command.request.projectId,
        roomId: command.request.roomId,
        claimId: command.request.claimId,
        operationId: command.request.operationId,
        holderId: command.request.holderId,
        leaseId: command.request.leaseId,
        fence: command.request.fence,
        expiresAt: command.request.expiresAt,
      }),
      expectedAction: "renewed",
      // Existing migration constraints allow only acquire/release/recovery rows.
      // Namespace a compatible durable key instead of widening schema here.
      storedCommandKind: "acquire",
      storedAction: "acquired",
    };
  }
  return null;
}

function canAdmit(
  snapshot: RoomGlobalConcurrencyPostgresSnapshotV1,
  workClass: RoomGlobalConcurrencyPostgresWorkClassV1,
  requestedSlots: number,
): boolean {
  if (snapshot.totalSlots === null) return false;
  const legacyTaskTriageActiveSlots = snapshot.legacy.activeTaskSlots + snapshot.legacy.activeTriageSlots;
  const roomActiveSlots = snapshot.roomClaims.reduce((total, claim) => total + claim.slots, 0);
  const verifierOccupiedSlots = slotsForWorkClass(snapshot.roomClaims, "verifier");
  const recoveryOccupiedSlots = slotsForWorkClass(snapshot.roomClaims, "recovery");
  const normalOccupiedSlots = legacyTaskTriageActiveSlots + slotsForWorkClass(snapshot.roomClaims, "normal");
  const occupiedSlots = legacyTaskTriageActiveSlots + roomActiveSlots;
  const protectedLegacyTaskTriageSlots = Math.max(
    0,
    snapshot.reservations.legacyTaskTriageSlots - legacyTaskTriageActiveSlots,
  );
  const normalLimitSlots = Math.max(
    0,
    snapshot.totalSlots - snapshot.reservations.verifierSlots - snapshot.reservations.recoverySlots - protectedLegacyTaskTriageSlots,
  );
  const verifierLimitSlots = Math.max(
    0,
    snapshot.totalSlots - Math.max(0, snapshot.reservations.recoverySlots - recoveryOccupiedSlots) - protectedLegacyTaskTriageSlots,
  );
  const recoveryLimitSlots = Math.max(
    0,
    snapshot.totalSlots - Math.max(0, snapshot.reservations.verifierSlots - verifierOccupiedSlots) - protectedLegacyTaskTriageSlots,
  );
  if (occupiedSlots + requestedSlots > snapshot.totalSlots) return false;
  if (workClass === "normal") return normalOccupiedSlots + requestedSlots <= normalLimitSlots;
  if (workClass === "verifier") {
    return verifierOccupiedSlots + requestedSlots + normalOccupiedSlots + recoveryOccupiedSlots <= verifierLimitSlots;
  }
  return recoveryOccupiedSlots + requestedSlots + normalOccupiedSlots + verifierOccupiedSlots <= recoveryLimitSlots;
}

function slotsForWorkClass(
  claims: readonly RoomGlobalConcurrencyPostgresClaimV1[],
  workClass: RoomGlobalConcurrencyPostgresWorkClassV1,
): number {
  return claims
    .filter((claim) => claim.workClass === workClass)
    .reduce((total, claim) => total + claim.slots, 0);
}

function validatePolicy(policy: unknown): asserts policy is RoomGlobalConcurrencyPostgresPolicyV1 {
  if (!isRecord(policy) || !isRecord(policy.reservations)) {
    throw new RoomGlobalConcurrencyPostgresError("Room global concurrency policy is invalid");
  }
  if (policy.totalSlots !== null && !nonNegativeSafeInteger(policy.totalSlots)) {
    throw new RoomGlobalConcurrencyPostgresError("Room global concurrency total capacity is invalid");
  }
  if (
    !nonNegativeSafeInteger(policy.reservations.verifierSlots)
    || !nonNegativeSafeInteger(policy.reservations.recoverySlots)
    || !nonNegativeSafeInteger(policy.reservations.legacyTaskTriageSlots)
    || !positiveSafeInteger(policy.snapshotTtlMs)
  ) {
    throw new RoomGlobalConcurrencyPostgresError("Room global concurrency reservations are invalid");
  }
  if (
    policy.totalSlots !== null
    && policy.reservations.verifierSlots + policy.reservations.recoverySlots + policy.reservations.legacyTaskTriageSlots > policy.totalSlots
  ) {
    throw new RoomGlobalConcurrencyPostgresError("Room global concurrency reservations exceed total capacity");
  }
}

function validateSnapshotReadInput(input: unknown): asserts input is RoomGlobalConcurrencyPostgresSnapshotReadInputV1 {
  if (
    !isRecord(input)
    || input.contractVersion !== ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION
    || !canonicalString(input.projectId)
    || !canonicalTimestamp(input.asOf)
  ) {
    throw new RoomGlobalConcurrencyPostgresError("Room global concurrency snapshot request is invalid");
  }
}

function validAcquireCommand(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { readonly kind: "acquire"; readonly request: RoomGlobalConcurrencyPostgresAcquireInputV1 } {
  if (!isRecord(value.request)) return false;
  const request = value.request;
  return request.contractVersion === ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION
    && canonicalString(request.projectId)
    && canonicalString(request.roomId)
    && canonicalString(request.claimId)
    && !request.claimId.startsWith(FOREIGN_CLAIM_PREFIX)
    && request.claimId === value.claimId
    && canonicalString(request.operationId)
    && typeof request.workClass === "string"
    && WORK_CLASSES.has(request.workClass as RoomGlobalConcurrencyPostgresWorkClassV1)
    && positiveSafeInteger(request.slots)
    && canonicalString(request.holderId)
    && canonicalString(request.leaseId)
    && positiveSafeInteger(request.fence)
    && request.fence === value.fence
    && canonicalTimestamp(request.asOf)
    && canonicalTimestamp(request.expiresAt)
    && Date.parse(request.expiresAt) > Date.parse(request.asOf);
}

function validReleaseCommand(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { readonly kind: "release"; readonly request: RoomGlobalConcurrencyPostgresReleaseInputV1 } {
  if (!isRecord(value.request)) return false;
  const request = value.request;
  return request.contractVersion === ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION
    && canonicalString(request.projectId)
    && canonicalString(request.roomId)
    && canonicalString(request.claimId)
    && !request.claimId.startsWith(FOREIGN_CLAIM_PREFIX)
    && request.claimId === value.claimId
    && canonicalString(request.operationId)
    && canonicalString(request.holderId)
    && canonicalString(request.leaseId)
    && positiveSafeInteger(request.fence)
    && request.fence === value.fence
    && canonicalTimestamp(request.asOf);
}

function validRenewCommand(
  value: Record<string, unknown>,
): value is Record<string, unknown> & RoomGlobalConcurrencyPostgresRenewStoreCommandV1 {
  if (!isRecord(value.request) || !isRecord(value.claim)) return false;
  const request = value.request;
  return value.contractVersion === ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION
    && canonicalString(value.expectedSnapshotId)
    && validRenewRequest(request)
    && request.claimId === value.claimId
    && request.fence === value.fence
    && validClaim(value.claim)
    && value.claim.claimId === request.claimId
    && value.claim.projectId === request.projectId
    && value.claim.roomId === request.roomId;
}

function validRenewRequest(value: unknown): value is RoomGlobalConcurrencyPostgresRenewInputV1 {
  if (!isRecord(value)) return false;
  return canonicalString(value.projectId)
    && canonicalString(value.roomId)
    && canonicalString(value.claimId)
    && !value.claimId.startsWith(FOREIGN_CLAIM_PREFIX)
    && canonicalString(value.operationId)
    && canonicalString(value.holderId)
    && canonicalString(value.leaseId)
    && positiveSafeInteger(value.fence)
    && canonicalTimestamp(value.asOf)
    && canonicalTimestamp(value.expiresAt)
    && Date.parse(value.expiresAt) > Date.parse(value.asOf);
}

function renewMatchesClaim(
  command: RoomGlobalConcurrencyPostgresRenewStoreCommandV1,
  claim: typeof roomGlobalConcurrencyClaims.$inferSelect,
): boolean {
  const expected = command.claim;
  return claim.projectId === command.request.projectId
    && claim.roomId === command.request.roomId
    && claim.id === command.request.claimId
    && claim.holderId === command.request.holderId
    && claim.leaseId === command.request.leaseId
    && claim.fence === command.request.fence
    && claim.workClass === expected.workClass
    && claim.slots === expected.slots
    && claim.acquiredAt === expected.acquiredAt
    && claim.expiresAt === expected.expiresAt
    && claim.releasedAt === null;
}

function successResult(
  identity: CommandIdentityV1,
  replayed: boolean,
  claimId: string,
  fence: number,
  stateRevision: number,
): RoomGlobalConcurrencyPostgresClaimStoreResultV1 {
  if (identity.expectedAction === "renewed") {
    return { ok: true, action: "renewed", replayed, claimId, fence, stateRevision };
  }
  return { ok: true, action: identity.expectedAction, replayed, claimId, fence };
}

function validRecoveryCommand(
  value: Record<string, unknown>,
): value is Record<string, unknown> & RoomGlobalConcurrencyPostgresRecoverDanglingStoreCommandV1 {
  if (!isRecord(value.claim)) return false;
  const claim = value.claim;
  return canonicalString(value.projectId)
    && canonicalString(value.recoveryOperationId)
    && canonicalString(value.recovererId)
    && canonicalTimestamp(value.asOf)
    && claim.projectId === value.projectId
    && claim.claimId === value.claimId
    && !String(claim.claimId).startsWith(FOREIGN_CLAIM_PREFIX)
    && positiveSafeInteger(value.fence)
    && claim.fence === value.fence
    && validClaim(claim);
}

function validLegacySnapshot(value: unknown): value is RoomGlobalConcurrencyPostgresLegacySnapshotV1 {
  return isRecord(value)
    && nonNegativeSafeInteger(value.activeTaskSlots)
    && nonNegativeSafeInteger(value.activeTriageSlots)
    && nonNegativeSafeInteger(value.queuedTaskSlots)
    && nonNegativeSafeInteger(value.queuedTriageSlots);
}

function validClaim(value: unknown): value is RoomGlobalConcurrencyPostgresClaimV1 {
  return isRecord(value)
    && canonicalString(value.claimId)
    && canonicalString(value.projectId)
    && canonicalString(value.roomId)
    && typeof value.workClass === "string"
    && WORK_CLASSES.has(value.workClass as RoomGlobalConcurrencyPostgresWorkClassV1)
    && positiveSafeInteger(value.slots)
    && canonicalString(value.holderId)
    && canonicalString(value.leaseId)
    && positiveSafeInteger(value.fence)
    && canonicalTimestamp(value.acquiredAt)
    && canonicalTimestamp(value.expiresAt)
    && Date.parse(value.expiresAt) > Date.parse(value.acquiredAt);
}

function snapshotExpiry(asOf: string, ttlMs: number): string {
  const expiry = new Date(Date.parse(asOf) + ttlMs);
  if (!Number.isFinite(expiry.getTime())) {
    throw new RoomGlobalConcurrencyPostgresError("Room global concurrency snapshot expiry is invalid");
  }
  return expiry.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalString(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function canonicalTimestamp(value: unknown): value is string {
  if (!canonicalString(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

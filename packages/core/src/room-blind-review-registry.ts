import { and, eq, sql } from "drizzle-orm";

import {
  createRoomBlindReviewPack,
  type CreateRoomBlindReviewPackInputV1,
  type RoomBlindReviewPackHashV1,
  type RoomBlindReviewPackV1,
} from "./room-blind-review-pack.js";
import { hashRoomValue } from "./room-integrity.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import {
  operationalRooms,
  roomBlindReviewRegistries,
} from "./postgres/schema/room.js";

export const ROOM_BLIND_REVIEW_REGISTRY_CONTRACT_VERSION = 1 as const;

export interface RoomBlindReviewRegistryScopeV1 {
  readonly projectId: string;
  readonly roomId: string;
}

export interface SealRoomBlindReviewMappingInputV1 {
  readonly contractVersion: 1;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly idempotencyKey: string;
  readonly now: string;
  readonly expiresAt: string;
  readonly packInput: CreateRoomBlindReviewPackInputV1;
}

export interface ReadRoomBlindReviewPackInputV1 {
  readonly contractVersion: 1;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly reviewRoundId: string;
  readonly reviewerBindingId: string;
  readonly now: string;
}

/**
 * The sole public read projection. It deliberately excludes candidate IDs,
 * source records, and producer binding lineage held by the sealed mapping.
 */
export interface RoomBlindReviewPackViewV1 {
  readonly contractVersion: 1;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly reviewRoundId: string;
  readonly mappingIntegrityHash: RoomBlindReviewPackHashV1;
  readonly sealedAt: string;
  readonly expiresAt: string;
  readonly pack: RoomBlindReviewPackV1;
}

export interface SealedRoomBlindReviewPackResultV1 extends RoomBlindReviewPackViewV1 {
  readonly replayed: boolean;
}

export type RoomBlindReviewRegistryErrorCode =
  | "invalid_input"
  | "invalid_mapping"
  | "mapping_integrity_mismatch"
  | "idempotency_mismatch"
  | "review_already_sealed"
  | "review_not_found"
  | "review_expired"
  | "reviewer_not_authorized"
  | "reviewer_conflict"
  | "scope_not_found"
  | "scope_mismatch";

export class RoomBlindReviewRegistryError extends Error {
  constructor(
    readonly code: RoomBlindReviewRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RoomBlindReviewRegistryError";
  }
}

interface SealedCandidateMappingV1 {
  readonly candidateId: string;
  readonly opaqueCandidateId: string;
  readonly candidateHash: RoomBlindReviewPackHashV1;
  readonly sourceRecordId: string;
  readonly sourceHash: RoomBlindReviewPackHashV1;
  readonly artifactHash: RoomBlindReviewPackHashV1;
  readonly producerBindingIds: readonly string[];
}

interface SealedBlindReviewMappingV1 {
  readonly contractVersion: 1;
  readonly reviewRoundId: string;
  readonly sourceSetHash: RoomBlindReviewPackHashV1;
  readonly createdAt: string;
  readonly reviewerBindingIds: readonly string[];
  readonly candidates: readonly SealedCandidateMappingV1[];
  readonly integrityHash: RoomBlindReviewPackHashV1;
  readonly commandHash: RoomBlindReviewPackHashV1;
}

interface StoredBlindReviewRegistryRecord {
  readonly id: string;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly reviewRoundId: string;
  readonly idempotencyKey: string;
  readonly commandHash: RoomBlindReviewPackHashV1;
  readonly mappingIntegrityHash: RoomBlindReviewPackHashV1;
  readonly sealedMapping: unknown;
  readonly reviewPack: unknown;
  readonly sealedAt: string;
  readonly expiresAt: string;
}

interface NormalizedSealInput {
  readonly record: StoredBlindReviewRegistryRecord;
  readonly pack: RoomBlindReviewPackV1;
}

interface RegistryTransaction {
  lockReview(scope: RoomBlindReviewRegistryScopeV1, reviewRoundId: string): Promise<void>;
  findByIdempotency(
    scope: RoomBlindReviewRegistryScopeV1,
    idempotencyKey: string,
  ): Promise<StoredBlindReviewRegistryRecord | null>;
  findByReviewRound(
    scope: RoomBlindReviewRegistryScopeV1,
    reviewRoundId: string,
  ): Promise<StoredBlindReviewRegistryRecord | null>;
  insert(record: StoredBlindReviewRegistryRecord): Promise<"inserted" | "conflict">;
}

interface RegistryPersistence {
  transaction<TResult>(operation: (transaction: RegistryTransaction) => Promise<TResult>): Promise<TResult>;
}

/*
FNXC:RoomBlindReviewRegistry 2026-07-18-00:00:
OpenSpec 7.2 seals candidate-to-opaque bindings in one project/Room/review
record, commits a canonical hash, and never returns producer or candidate
identities from a reviewer read. Exact retry is idempotent; mismatched, expired,
or reviewer-conflicted submissions fail before a second mapping is committed.
*/
export class RoomBlindReviewRegistry {
  constructor(private readonly persistence: RegistryPersistence) {}

  async seal(input: SealRoomBlindReviewMappingInputV1): Promise<SealedRoomBlindReviewPackResultV1> {
    const normalized = normalizeSealInput(input);
    return this.persistence.transaction(async (transaction) => {
      await transaction.lockReview(normalized.record.scope, normalized.record.reviewRoundId);
      const idempotencyMatch = await transaction.findByIdempotency(
        normalized.record.scope,
        normalized.record.idempotencyKey,
      );
      if (idempotencyMatch) {
        const stored = validateStoredRecord(idempotencyMatch);
        if (stored.commandHash !== normalized.record.commandHash) {
          throw new RoomBlindReviewRegistryError(
            "idempotency_mismatch",
            "Blind-review idempotency key was previously committed with different mapping content",
          );
        }
        return toResult(stored, true);
      }

      const existingRound = await transaction.findByReviewRound(
        normalized.record.scope,
        normalized.record.reviewRoundId,
      );
      if (existingRound) {
        const stored = validateStoredRecord(existingRound);
        if (stored.mappingIntegrityHash !== normalized.record.mappingIntegrityHash) {
          throw new RoomBlindReviewRegistryError(
            "review_already_sealed",
            "A different blind-review mapping is already sealed for this review round",
          );
        }
        throw new RoomBlindReviewRegistryError(
          "review_already_sealed",
          "This blind-review round is already sealed under a different idempotency key",
        );
      }

      if (await transaction.insert(normalized.record) !== "inserted") {
        const concurrentIdempotency = await transaction.findByIdempotency(
          normalized.record.scope,
          normalized.record.idempotencyKey,
        );
        if (concurrentIdempotency) {
          const stored = validateStoredRecord(concurrentIdempotency);
          if (stored.commandHash !== normalized.record.commandHash) {
            throw new RoomBlindReviewRegistryError(
              "idempotency_mismatch",
              "Blind-review idempotency key was concurrently committed with different mapping content",
            );
          }
          return toResult(stored, true);
        }
        throw new RoomBlindReviewRegistryError(
          "review_already_sealed",
          "A concurrent submission sealed this blind-review round first",
        );
      }
      return toResult({
        record: normalized.record,
        mapping: parseSealedMapping(normalized.record.sealedMapping),
        pack: normalized.pack,
        mappingIntegrityHash: normalized.record.mappingIntegrityHash,
        commandHash: normalized.record.commandHash,
      }, false);
    });
  }

  async getPackForReviewer(input: ReadRoomBlindReviewPackInputV1): Promise<RoomBlindReviewPackViewV1> {
    const normalized = normalizeReadInput(input);
    return this.persistence.transaction(async (transaction) => {
      const record = await transaction.findByReviewRound(normalized.scope, normalized.reviewRoundId);
      if (!record) {
        throw new RoomBlindReviewRegistryError(
          "review_not_found",
          "No blind-review mapping exists in this project and Room scope",
        );
      }
      const stored = validateStoredRecord(record);
      if (Date.parse(normalized.now) >= Date.parse(stored.record.expiresAt)) {
        throw new RoomBlindReviewRegistryError(
          "review_expired",
          "The blind-review mapping expired before this reviewer access request",
        );
      }
      if (!stored.mapping.reviewerBindingIds.includes(normalized.reviewerBindingId)) {
        throw new RoomBlindReviewRegistryError(
          "reviewer_not_authorized",
          "This binding is not an authorized reviewer for the sealed review round",
        );
      }
      if (stored.mapping.candidates.some((candidate) => candidate.producerBindingIds.includes(normalized.reviewerBindingId))) {
        throw new RoomBlindReviewRegistryError(
          "reviewer_conflict",
          "A reviewer conflicts with sealed producer lineage and cannot receive this pack",
        );
      }
      return toView(stored);
    });
  }
}

/** Narrow deterministic seam for unit tests and controller simulations. */
export function createInMemoryRoomBlindReviewRegistry(): RoomBlindReviewRegistry {
  return new RoomBlindReviewRegistry(new InMemoryRegistryPersistence());
}

/** PostgreSQL seam for the durable Room control-plane path. */
export function createPostgresRoomBlindReviewRegistry(layer: AsyncDataLayer): RoomBlindReviewRegistry {
  return new RoomBlindReviewRegistry(new PostgresRegistryPersistence(layer));
}

class InMemoryRegistryPersistence implements RegistryPersistence {
  private readonly byIdempotency = new Map<string, StoredBlindReviewRegistryRecord>();
  private readonly byReviewRound = new Map<string, StoredBlindReviewRegistryRecord>();
  private tail: Promise<void> = Promise.resolve();

  async transaction<TResult>(operation: (transaction: RegistryTransaction) => Promise<TResult>): Promise<TResult> {
    const prior = this.tail;
    let release: (() => void) | undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await operation(new InMemoryRegistryTransaction(this.byIdempotency, this.byReviewRound));
    } finally {
      release?.();
    }
  }
}

class InMemoryRegistryTransaction implements RegistryTransaction {
  constructor(
    private readonly byIdempotency: Map<string, StoredBlindReviewRegistryRecord>,
    private readonly byReviewRound: Map<string, StoredBlindReviewRegistryRecord>,
  ) {}

  async lockReview(): Promise<void> {}

  async findByIdempotency(
    scope: RoomBlindReviewRegistryScopeV1,
    idempotencyKey: string,
  ): Promise<StoredBlindReviewRegistryRecord | null> {
    return copyRecord(this.byIdempotency.get(idempotencyStorageKey(scope, idempotencyKey)) ?? null);
  }

  async findByReviewRound(
    scope: RoomBlindReviewRegistryScopeV1,
    reviewRoundId: string,
  ): Promise<StoredBlindReviewRegistryRecord | null> {
    return copyRecord(this.byReviewRound.get(reviewRoundStorageKey(scope, reviewRoundId)) ?? null);
  }

  async insert(record: StoredBlindReviewRegistryRecord): Promise<"inserted" | "conflict"> {
    const idempotencyKey = idempotencyStorageKey(record.scope, record.idempotencyKey);
    const reviewRoundKey = reviewRoundStorageKey(record.scope, record.reviewRoundId);
    if (this.byIdempotency.has(idempotencyKey) || this.byReviewRound.has(reviewRoundKey)) return "conflict";
    const stored = copyRecord(record)!;
    this.byIdempotency.set(idempotencyKey, stored);
    this.byReviewRound.set(reviewRoundKey, stored);
    return "inserted";
  }
}

class PostgresRegistryPersistence implements RegistryPersistence {
  constructor(private readonly layer: AsyncDataLayer) {}

  async transaction<TResult>(operation: (transaction: RegistryTransaction) => Promise<TResult>): Promise<TResult> {
    return this.layer.transactionImmediate(async (tx) =>
      operation(new PostgresRegistryTransaction(tx, this.layer.projectId)),
    );
  }
}

class PostgresRegistryTransaction implements RegistryTransaction {
  constructor(
    private readonly tx: DbTransaction,
    private readonly boundProjectId: string | undefined,
  ) {}

  async lockReview(scope: RoomBlindReviewRegistryScopeV1, reviewRoundId: string): Promise<void> {
    this.assertBoundScope(scope);
    const lockKey = `fusion-room-blind-review-registry-v1:${scope.projectId}:${scope.roomId}:${reviewRoundId}`;
    await this.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
  }

  async findByIdempotency(
    scope: RoomBlindReviewRegistryScopeV1,
    idempotencyKey: string,
  ): Promise<StoredBlindReviewRegistryRecord | null> {
    this.assertBoundScope(scope);
    const rows = await this.tx
      .select()
      .from(roomBlindReviewRegistries)
      .where(and(
        eq(roomBlindReviewRegistries.projectId, scope.projectId),
        eq(roomBlindReviewRegistries.roomId, scope.roomId),
        eq(roomBlindReviewRegistries.idempotencyKey, idempotencyKey),
      ))
      .limit(1);
    return rows[0] ? rowToStoredRecord(rows[0]) : null;
  }

  async findByReviewRound(
    scope: RoomBlindReviewRegistryScopeV1,
    reviewRoundId: string,
  ): Promise<StoredBlindReviewRegistryRecord | null> {
    this.assertBoundScope(scope);
    const rows = await this.tx
      .select()
      .from(roomBlindReviewRegistries)
      .where(and(
        eq(roomBlindReviewRegistries.projectId, scope.projectId),
        eq(roomBlindReviewRegistries.roomId, scope.roomId),
        eq(roomBlindReviewRegistries.reviewRoundId, reviewRoundId),
      ))
      .limit(1);
    return rows[0] ? rowToStoredRecord(rows[0]) : null;
  }

  async insert(record: StoredBlindReviewRegistryRecord): Promise<"inserted" | "conflict"> {
    this.assertBoundScope(record.scope);
    await assertRoomScope(this.tx, record.scope);
    const rows = await this.tx
      .insert(roomBlindReviewRegistries)
      .values({
        id: record.id,
        projectId: record.scope.projectId,
        roomId: record.scope.roomId,
        reviewRoundId: record.reviewRoundId,
        idempotencyKey: record.idempotencyKey,
        commandHash: record.commandHash,
        mappingIntegrityHash: record.mappingIntegrityHash,
        sealedMapping: record.sealedMapping,
        reviewPack: record.reviewPack,
        sealedAt: record.sealedAt,
        expiresAt: record.expiresAt,
      })
      .onConflictDoNothing()
      .returning({ id: roomBlindReviewRegistries.id });
    return rows[0] ? "inserted" : "conflict";
  }

  private assertBoundScope(scope: RoomBlindReviewRegistryScopeV1): void {
    if (this.boundProjectId !== undefined && this.boundProjectId !== scope.projectId) {
      throw new RoomBlindReviewRegistryError(
        "scope_mismatch",
        "Blind-review registry scope does not match the bound project",
      );
    }
  }
}

function normalizeSealInput(input: SealRoomBlindReviewMappingInputV1): NormalizedSealInput {
  assertExactKeys(input, ["contractVersion", "scope", "idempotencyKey", "now", "expiresAt", "packInput"], "sealed mapping input");
  if (input.contractVersion !== ROOM_BLIND_REVIEW_REGISTRY_CONTRACT_VERSION) {
    throw invalidInput("Blind-review registry requires contract version 1");
  }
  const scope = normalizeScope(input.scope);
  const idempotencyKey = requireText(input.idempotencyKey, "Blind-review idempotency key");
  const sealedAt = requireTimestamp(input.now, "Blind-review seal time");
  const expiresAt = requireTimestamp(input.expiresAt, "Blind-review expiry time");
  if (Date.parse(expiresAt) <= Date.parse(sealedAt)) {
    throw new RoomBlindReviewRegistryError(
      "review_expired",
      "Blind-review expiry must be after the submitted seal time",
    );
  }
  const created = createRoomBlindReviewPack(input.packInput);
  if (!created.valid || !created.expectedPack) {
    throw packError(created.rejections.map((rejection) => rejection.code));
  }
  const pack = created.expectedPack;
  const sealedMapping = buildSealedMapping(input.packInput, pack, scope, expiresAt);
  const record: StoredBlindReviewRegistryRecord = {
    id: `blind-review-${hash({ scope, reviewRoundId: pack.reviewRoundId }).slice(7)}`,
    scope,
    reviewRoundId: pack.reviewRoundId,
    idempotencyKey,
    commandHash: sealedMapping.commandHash,
    mappingIntegrityHash: sealedMapping.integrityHash,
    sealedMapping,
    reviewPack: copyJson(pack),
    sealedAt,
    expiresAt,
  };
  return freeze({ record, pack });
}

function normalizeReadInput(input: ReadRoomBlindReviewPackInputV1): ReadRoomBlindReviewPackInputV1 {
  assertExactKeys(input, ["contractVersion", "scope", "reviewRoundId", "reviewerBindingId", "now"], "sealed mapping reader input");
  if (input.contractVersion !== ROOM_BLIND_REVIEW_REGISTRY_CONTRACT_VERSION) {
    throw invalidInput("Blind-review registry requires contract version 1");
  }
  return freeze({
    contractVersion: 1,
    scope: normalizeScope(input.scope),
    reviewRoundId: requireText(input.reviewRoundId, "Blind-review round id"),
    reviewerBindingId: requireText(input.reviewerBindingId, "Reviewer binding id"),
    now: requireTimestamp(input.now, "Reviewer read time"),
  });
}

function buildSealedMapping(
  input: CreateRoomBlindReviewPackInputV1,
  pack: RoomBlindReviewPackV1,
  scope: RoomBlindReviewRegistryScopeV1,
  expiresAt: string,
): SealedBlindReviewMappingV1 {
  const opaqueByCandidate = new Map(input.opaqueBindings.map((binding) => [binding.candidateId, binding.opaqueCandidateId]));
  const payload = {
    contractVersion: 1 as const,
    reviewRoundId: pack.reviewRoundId,
    sourceSetHash: pack.sourceSetHash,
    createdAt: pack.createdAt,
    reviewerBindingIds: [...pack.reviewerBindingIds].sort(),
    candidates: input.candidateLineage
      .map((candidate) => ({
        candidateId: candidate.candidateId,
        opaqueCandidateId: opaqueByCandidate.get(candidate.candidateId)!,
        candidateHash: candidate.candidateHash,
        sourceRecordId: candidate.sourceRecordId,
        sourceHash: candidate.sourceHash,
        artifactHash: candidate.artifactHash,
        producerBindingIds: [...candidate.producerBindingIds].sort(),
      }))
      .sort((left, right) => left.opaqueCandidateId.localeCompare(right.opaqueCandidateId)),
  };
  const integrityHash = hash(payload);
  const commandHash = hash({
    contractVersion: ROOM_BLIND_REVIEW_REGISTRY_CONTRACT_VERSION,
    scope,
    reviewRoundId: payload.reviewRoundId,
    expiresAt,
    mappingIntegrityHash: integrityHash,
  });
  return freeze({ ...payload, integrityHash, commandHash });
}

function validateStoredRecord(record: StoredBlindReviewRegistryRecord): {
  readonly record: StoredBlindReviewRegistryRecord;
  readonly mapping: SealedBlindReviewMappingV1;
  readonly pack: RoomBlindReviewPackV1;
  readonly mappingIntegrityHash: RoomBlindReviewPackHashV1;
  readonly commandHash: RoomBlindReviewPackHashV1;
} {
  const stored = copyRecord(record)!;
  const scope = normalizeScope(stored.scope);
  assertText(stored.id, "Stored blind-review registry id");
  assertText(stored.reviewRoundId, "Stored blind-review round id");
  assertText(stored.idempotencyKey, "Stored blind-review idempotency key");
  assertTimestamp(stored.sealedAt, "Stored blind-review seal time");
  assertTimestamp(stored.expiresAt, "Stored blind-review expiry time");
  const mapping = parseSealedMapping(stored.sealedMapping);
  const payload = {
    contractVersion: mapping.contractVersion,
    reviewRoundId: mapping.reviewRoundId,
    sourceSetHash: mapping.sourceSetHash,
    createdAt: mapping.createdAt,
    reviewerBindingIds: mapping.reviewerBindingIds,
    candidates: mapping.candidates,
  };
  const mappingIntegrityHash = hash(payload);
  const commandHash = hash({
    contractVersion: ROOM_BLIND_REVIEW_REGISTRY_CONTRACT_VERSION,
    scope,
    reviewRoundId: mapping.reviewRoundId,
    expiresAt: stored.expiresAt,
    mappingIntegrityHash,
  });
  if (
    mapping.reviewRoundId !== stored.reviewRoundId
    || mapping.integrityHash !== mappingIntegrityHash
    || stored.mappingIntegrityHash !== mappingIntegrityHash
    || mapping.commandHash !== commandHash
    || stored.commandHash !== commandHash
  ) {
    throw new RoomBlindReviewRegistryError(
      "mapping_integrity_mismatch",
      "Stored blind-review mapping failed its committed integrity check",
    );
  }
  const packInput: CreateRoomBlindReviewPackInputV1 = {
    contractVersion: 1,
    reviewRoundId: mapping.reviewRoundId,
    sourceSetHash: mapping.sourceSetHash,
    createdAt: mapping.createdAt,
    reviewers: mapping.reviewerBindingIds.map((bindingId) => ({ bindingId })),
    candidateLineage: mapping.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      candidateHash: candidate.candidateHash,
      sourceRecordId: candidate.sourceRecordId,
      sourceHash: candidate.sourceHash,
      artifactHash: candidate.artifactHash,
      producerBindingIds: candidate.producerBindingIds,
    })),
    opaqueBindings: mapping.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      opaqueCandidateId: candidate.opaqueCandidateId,
    })),
  };
  const rebuiltPack = createRoomBlindReviewPack(packInput);
  if (
    !rebuiltPack.valid
    || !rebuiltPack.expectedPack
    || hash(stored.reviewPack) !== hash(rebuiltPack.expectedPack)
  ) {
    throw new RoomBlindReviewRegistryError(
      "mapping_integrity_mismatch",
      "Stored blind-review pack no longer matches its sealed mapping",
    );
  }
  return freeze({ record: stored, mapping, pack: rebuiltPack.expectedPack, mappingIntegrityHash, commandHash });
}

function parseSealedMapping(value: unknown): SealedBlindReviewMappingV1 {
  if (!isRecord(value)) throw invalidMapping("Stored sealed mapping must be an object");
  assertMappingKeys(value, [
    "contractVersion", "reviewRoundId", "sourceSetHash", "createdAt", "reviewerBindingIds", "candidates", "integrityHash", "commandHash",
  ], "stored sealed mapping");
  if (value.contractVersion !== 1) throw invalidMapping("Stored sealed mapping requires contract version 1");
  const reviewerBindingIds = parseUniqueTextArray(value.reviewerBindingIds, "Stored reviewer bindings");
  const candidates = parseCandidates(value.candidates);
  if (candidates.length === 0) throw invalidMapping("Stored sealed mapping requires candidates");
  const candidateIds = new Set<string>();
  const opaqueIds = new Set<string>();
  for (const candidate of candidates) {
    if (candidateIds.has(candidate.candidateId) || opaqueIds.has(candidate.opaqueCandidateId)) {
      throw invalidMapping("Stored sealed mapping must retain one-to-one opaque candidate bindings");
    }
    candidateIds.add(candidate.candidateId);
    opaqueIds.add(candidate.opaqueCandidateId);
  }
  return freeze({
    contractVersion: 1,
    reviewRoundId: requireText(value.reviewRoundId, "Stored sealed review round id"),
    sourceSetHash: requireHash(value.sourceSetHash, "Stored sealed source set hash"),
    createdAt: requireTimestamp(value.createdAt, "Stored sealed creation time"),
    reviewerBindingIds,
    candidates,
    integrityHash: requireHash(value.integrityHash, "Stored sealed mapping integrity hash"),
    commandHash: requireHash(value.commandHash, "Stored sealed mapping command hash"),
  });
}

function parseCandidates(value: unknown): readonly SealedCandidateMappingV1[] {
  if (!Array.isArray(value)) throw invalidMapping("Stored sealed mapping candidates must be an array");
  return freeze(value.map((entry, index) => {
    if (!isRecord(entry)) throw invalidMapping(`Stored sealed candidate ${index} must be an object`);
    assertMappingKeys(entry, [
      "candidateId", "opaqueCandidateId", "candidateHash", "sourceRecordId", "sourceHash", "artifactHash", "producerBindingIds",
    ], `stored sealed candidate ${index}`);
    const producerBindingIds = parseUniqueTextArray(entry.producerBindingIds, `Stored producer lineage ${index}`);
    if (producerBindingIds.length === 0) throw invalidMapping("Stored sealed candidate requires producer lineage");
    return freeze({
      candidateId: requireText(entry.candidateId, "Stored candidate id"),
      opaqueCandidateId: requireText(entry.opaqueCandidateId, "Stored opaque candidate id"),
      candidateHash: requireHash(entry.candidateHash, "Stored candidate hash"),
      sourceRecordId: requireText(entry.sourceRecordId, "Stored source record id"),
      sourceHash: requireHash(entry.sourceHash, "Stored source hash"),
      artifactHash: requireHash(entry.artifactHash, "Stored artifact hash"),
      producerBindingIds,
    });
  }));
}

function toResult(
  stored: ReturnType<typeof validateStoredRecord>,
  replayed: boolean,
): SealedRoomBlindReviewPackResultV1 {
  return freeze({ ...toView(stored), replayed });
}

function toView(stored: ReturnType<typeof validateStoredRecord>): RoomBlindReviewPackViewV1 {
  return freeze({
    contractVersion: 1,
    scope: freeze({ ...stored.record.scope }),
    reviewRoundId: stored.record.reviewRoundId,
    mappingIntegrityHash: stored.mappingIntegrityHash,
    sealedAt: stored.record.sealedAt,
    expiresAt: stored.record.expiresAt,
    pack: copyJson(stored.pack),
  });
}

function rowToStoredRecord(row: typeof roomBlindReviewRegistries.$inferSelect): StoredBlindReviewRegistryRecord {
  return {
    id: row.id,
    scope: { projectId: row.projectId, roomId: row.roomId },
    reviewRoundId: row.reviewRoundId,
    idempotencyKey: row.idempotencyKey,
    commandHash: row.commandHash as RoomBlindReviewPackHashV1,
    mappingIntegrityHash: row.mappingIntegrityHash as RoomBlindReviewPackHashV1,
    sealedMapping: copyJson(row.sealedMapping),
    reviewPack: copyJson(row.reviewPack),
    sealedAt: row.sealedAt,
    expiresAt: row.expiresAt,
  };
}

async function assertRoomScope(tx: DbTransaction, scope: RoomBlindReviewRegistryScopeV1): Promise<void> {
  const rows = await tx
    .select({ id: operationalRooms.id })
    .from(operationalRooms)
    .where(and(
      eq(operationalRooms.projectId, scope.projectId),
      eq(operationalRooms.id, scope.roomId),
    ))
    .limit(1);
  if (!rows[0]) {
    throw new RoomBlindReviewRegistryError(
      "scope_not_found",
      "Blind-review registry could not resolve this Room in the submitted project scope",
    );
  }
}

function normalizeScope(value: unknown): RoomBlindReviewRegistryScopeV1 {
  if (!isRecord(value)) throw invalidInput("Blind-review scope must be an object");
  assertExactKeys(value, ["projectId", "roomId"], "blind-review scope");
  return freeze({
    projectId: requireText(value.projectId, "Blind-review project id"),
    roomId: requireText(value.roomId, "Blind-review Room id"),
  });
}

function idempotencyStorageKey(scope: RoomBlindReviewRegistryScopeV1, idempotencyKey: string): string {
  return `${scope.projectId}\u0000${scope.roomId}\u0000${idempotencyKey}`;
}

function reviewRoundStorageKey(scope: RoomBlindReviewRegistryScopeV1, reviewRoundId: string): string {
  return `${scope.projectId}\u0000${scope.roomId}\u0000${reviewRoundId}`;
}

function hash(value: unknown): RoomBlindReviewPackHashV1 {
  return hashRoomValue(value) as RoomBlindReviewPackHashV1;
}

function copyRecord(record: StoredBlindReviewRegistryRecord | null): StoredBlindReviewRegistryRecord | null {
  if (!record) return null;
  return {
    ...record,
    scope: { ...record.scope },
    sealedMapping: copyJson(record.sealedMapping),
    reviewPack: copyJson(record.reviewPack),
  };
}

function copyJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function parseUniqueTextArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw invalidMapping(`${label} must be an array`);
  const values = value.map((entry) => requireText(entry, label));
  if (new Set(values).size !== values.length) throw invalidMapping(`${label} must be unique`);
  return freeze([...values].sort());
}

function assertExactKeys(value: unknown, keys: readonly string[], label: string): void {
  if (!isRecord(value)) throw invalidInput(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalidInput(`${label} has unexpected properties`);
  }
}

function assertMappingKeys(value: unknown, keys: readonly string[], label: string): void {
  if (!isRecord(value)) throw invalidMapping(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalidMapping(`${label} has unexpected properties`);
  }
}

function assertText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) throw invalidInput(`${label} must be non-blank text`);
}

function requireText(value: unknown, label: string): string {
  assertText(value, label);
  return value;
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    throw invalidInput(`${label} must be a canonical ISO timestamp`);
  }
}

function requireTimestamp(value: unknown, label: string): string {
  assertTimestamp(value, label);
  return value;
}

function requireHash(value: unknown, label: string): RoomBlindReviewPackHashV1 {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw invalidMapping(`${label} must be a SHA-256 hash`);
  }
  return value as RoomBlindReviewPackHashV1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidInput(message: string): RoomBlindReviewRegistryError {
  return new RoomBlindReviewRegistryError("invalid_input", message);
}

function invalidMapping(message: string): RoomBlindReviewRegistryError {
  return new RoomBlindReviewRegistryError("invalid_mapping", message);
}

function packError(
  rejections: readonly string[],
  fallback: RoomBlindReviewRegistryErrorCode = "invalid_mapping",
): RoomBlindReviewRegistryError {
  const code = rejections.includes("reviewer_not_independent") ? "reviewer_conflict" : fallback;
  return new RoomBlindReviewRegistryError(code, code === "reviewer_conflict"
    ? "Blind-review reviewers conflict with producer lineage"
    : "Blind-review mapping does not satisfy the existing pack contract");
}

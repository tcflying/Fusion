import { and, eq, inArray, sql } from "drizzle-orm";

import {
  RoomEvidenceLedgerError,
  type RoomEvidenceLedgerAppendOutcome,
  type RoomEvidenceLedgerCandidateEvaluation,
  type RoomEvidenceLedgerEntry,
  type RoomEvidenceLedgerPersistence,
  type RoomEvidenceLedgerReferenceQuery,
  type RoomEvidenceLedgerReferenceSnapshot,
  type RoomEvidenceLedgerScope,
  type RoomEvidenceLedgerTransaction,
} from "./async-room-evidence-ledger.js";
import type {
  RoomArtifactRecordV1,
  RoomCandidateRecordV1,
  RoomConfidenceSnapshotV1,
  RoomDissentRecordV1,
  RoomEvidenceRecordV1,
  RoomGateResultV1,
  RoomPromotionRecordV1,
  RoomReviewRecordV1,
} from "./room-contracts/evidence.js";
import { ROOM_CONTRACT_VERSIONS } from "./room-contracts/versions.js";
import type { AsyncDataLayer, DbTransaction } from "./postgres/data-layer.js";
import {
  operationalRooms,
  roomArtifacts,
  roomCandidates,
  roomConfidenceSnapshots,
  roomDissents,
  roomEvidence,
  roomGateResults,
  roomPromotions,
  roomReviews,
} from "./postgres/schema/room.js";

/*
FNXC:SessionRoomEvidenceLedger 2026-07-19-08:21:
OpenSpec 7.1 requires each submitted immutable evidence node to resolve its
Room-scoped graph, assess any candidate promotion, and append without an
overwrite in one PostgreSQL transaction. This adapter keeps those reads and
the INSERT on one Drizzle transaction, scopes every lookup by project and Room,
and serializes promotion decisions per candidate so retries and contenders
surface deterministic immutable conflicts instead of creating a second verdict.
*/
export class AsyncRoomEvidenceLedgerPostgresPersistence implements RoomEvidenceLedgerPersistence {
  constructor(private readonly layer: AsyncDataLayer) {}

  async transaction<TResult>(
    operation: (transaction: RoomEvidenceLedgerTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    return this.layer.transactionImmediate(async (tx) =>
      operation(new DrizzleRoomEvidenceLedgerTransaction(tx, this.layer.projectId)),
    );
  }
}

class DrizzleRoomEvidenceLedgerTransaction implements RoomEvidenceLedgerTransaction {
  constructor(
    private readonly tx: DbTransaction,
    private readonly boundProjectId: string | undefined,
  ) {}

  async resolveReferences(
    input: RoomEvidenceLedgerReferenceQuery,
  ): Promise<RoomEvidenceLedgerReferenceSnapshot> {
    assertBoundProjectScope(this.boundProjectId, input.scope);
    await assertRoomScope(this.tx, input.scope);
    return {
      scope: { ...input.scope },
      artifacts: await loadArtifacts(this.tx, input.scope, input.artifactIds),
      evidence: await loadEvidence(this.tx, input.scope, input.evidenceIds),
      candidates: await loadCandidates(this.tx, input.scope, input.candidateIds),
      reviews: await loadReviews(this.tx, input.scope, input.reviewIds),
      dissents: await loadDissents(this.tx, input.scope, input.dissentIds),
      gateResults: await loadGateResults(this.tx, input.scope, input.gateResultIds),
    };
  }

  async loadCandidateEvaluation(input: {
    readonly scope: RoomEvidenceLedgerScope;
    readonly candidateId: string;
  }): Promise<RoomEvidenceLedgerCandidateEvaluation | null> {
    assertBoundProjectScope(this.boundProjectId, input.scope);
    await assertRoomScope(this.tx, input.scope);
    await lockCandidatePromotion(this.tx, input.scope, input.candidateId);

    const candidates = await loadCandidates(this.tx, input.scope, [input.candidateId], {
      missing: "null",
    });
    const candidate = candidates[0];
    if (!candidate) return null;

    const gateRows = await this.tx
      .select()
      .from(roomGateResults)
      .where(and(
        eq(roomGateResults.projectId, input.scope.projectId),
        eq(roomGateResults.roomId, input.scope.roomId),
        eq(roomGateResults.candidateId, input.candidateId),
      ));
    const reviewRows = await this.tx
      .select()
      .from(roomReviews)
      .where(and(
        eq(roomReviews.projectId, input.scope.projectId),
        eq(roomReviews.roomId, input.scope.roomId),
        eq(roomReviews.candidateId, input.candidateId),
      ));
    const dissentRows = await this.tx
      .select()
      .from(roomDissents)
      .where(and(
        eq(roomDissents.projectId, input.scope.projectId),
        eq(roomDissents.roomId, input.scope.roomId),
        eq(roomDissents.candidateId, input.candidateId),
      ));
    const promotionRows = await this.tx
      .select()
      .from(roomPromotions)
      .where(and(
        eq(roomPromotions.projectId, input.scope.projectId),
        eq(roomPromotions.roomId, input.scope.roomId),
        eq(roomPromotions.candidateId, input.candidateId),
      ));

    return {
      scope: { ...input.scope },
      candidate,
      gateResults: sortByCanonicalId(gateRows.map(rowToGateResult)),
      reviews: sortByCanonicalId(reviewRows.map(rowToReview)),
      dissents: sortByCanonicalId(dissentRows.map(rowToDissent)),
      promotions: sortByCanonicalId(promotionRows.map(rowToPromotion)),
    };
  }

  async append(input: {
    readonly scope: RoomEvidenceLedgerScope;
    readonly entry: RoomEvidenceLedgerEntry;
  }): Promise<RoomEvidenceLedgerAppendOutcome> {
    assertBoundProjectScope(this.boundProjectId, input.scope);
    assertEntryScope(input.scope, input.entry);
    await assertRoomScope(this.tx, input.scope);

    switch (input.entry.table) {
      case "room_artifacts":
        return appendArtifact(this.tx, input.scope, input.entry.record);
      case "room_evidence":
        return appendEvidence(this.tx, input.scope, input.entry.record);
      case "room_candidates":
        return appendCandidate(this.tx, input.scope, input.entry.record);
      case "room_reviews":
        return appendReview(this.tx, input.scope, input.entry.record);
      case "room_dissents":
        return appendDissent(this.tx, input.scope, input.entry.record);
      case "room_gate_results":
        return appendGateResult(this.tx, input.scope, input.entry.record);
      case "room_promotions":
        return appendPromotion(this.tx, input.scope, input.entry.record);
      case "room_confidence_snapshots":
        return appendConfidenceSnapshot(this.tx, input.scope, input.entry.record);
      default:
        throw new RoomEvidenceLedgerError(
          "invalid_input",
          "Unsupported Room evidence ledger entry",
        );
    }
  }
}

async function appendArtifact(
  tx: DbTransaction,
  scope: RoomEvidenceLedgerScope,
  record: RoomArtifactRecordV1,
): Promise<RoomEvidenceLedgerAppendOutcome> {
  const rows = await tx
    .insert(roomArtifacts)
    .values({
      id: record.id,
      projectId: scope.projectId,
      roomId: scope.roomId,
      nodeId: record.nodeId,
      candidateId: record.candidateId,
      kind: record.kind,
      mediaType: record.mediaType,
      uri: record.uri,
      contentHash: record.contentHash,
      producingBindingId: record.producingBindingId,
      sourceRevision: record.sourceRevision,
      sizeBytes: record.sizeBytes,
      createdAt: record.createdAt,
    })
    .onConflictDoNothing({ target: roomArtifacts.id })
    .returning({ id: roomArtifacts.id });
  return insertOutcome(record.id, rows);
}

async function appendEvidence(
  tx: DbTransaction,
  scope: RoomEvidenceLedgerScope,
  record: RoomEvidenceRecordV1,
): Promise<RoomEvidenceLedgerAppendOutcome> {
  const rows = await tx
    .insert(roomEvidence)
    .values({
      id: record.id,
      projectId: scope.projectId,
      roomId: scope.roomId,
      nodeId: record.nodeId,
      candidateId: record.candidateId,
      kind: record.kind,
      authoritativeSourceUri: record.authoritativeSourceUri,
      sourceVersionOrHash: record.sourceVersionOrHash,
      capturedAt: record.capturedAt,
      collectionMethod: record.collectionMethod,
      collectorBindingId: record.collectorBindingId,
      contentHash: record.contentHash,
      artifactIds: record.artifactIds,
      expiresAt: record.expiresAt,
    })
    .onConflictDoNothing({ target: roomEvidence.id })
    .returning({ id: roomEvidence.id });
  return insertOutcome(record.id, rows);
}

async function appendCandidate(
  tx: DbTransaction,
  scope: RoomEvidenceLedgerScope,
  record: RoomCandidateRecordV1,
): Promise<RoomEvidenceLedgerAppendOutcome> {
  const rows = await tx
    .insert(roomCandidates)
    .values({
      id: record.id,
      projectId: scope.projectId,
      roomId: scope.roomId,
      nodeId: record.nodeId,
      producingBindingId: record.producingBindingId,
      nativeSessionId: record.nativeSessionId,
      happierSessionId: record.happierSessionId,
      providerId: record.providerId,
      modelRef: record.modelRef,
      protocolId: record.protocolId,
      protocolVersion: record.protocolVersion,
      contextVersion: record.contextVersion,
      inputVersion: record.inputVersion,
      configVersion: record.configVersion,
      contentHash: record.contentHash,
      artifactIds: record.artifactIds,
      parentCandidateIds: record.parentCandidateIds,
      gateResultIds: record.gateResultIds,
      reviewIds: record.reviewIds,
      promotionState: record.promotionState,
      createdAt: record.createdAt,
    })
    .onConflictDoNothing({ target: roomCandidates.id })
    .returning({ id: roomCandidates.id });
  return insertOutcome(record.id, rows);
}

async function appendReview(
  tx: DbTransaction,
  scope: RoomEvidenceLedgerScope,
  record: RoomReviewRecordV1,
): Promise<RoomEvidenceLedgerAppendOutcome> {
  const rows = await tx
    .insert(roomReviews)
    .values({
      id: record.id,
      projectId: scope.projectId,
      roomId: scope.roomId,
      nodeId: record.nodeId,
      candidateId: record.candidateId,
      blindCandidateRef: record.blindCandidateRef,
      reviewerBindingId: record.reviewerBindingId,
      reviewerNativeSessionId: record.reviewerNativeSessionId,
      reviewerHappierSessionId: record.reviewerHappierSessionId,
      blind: record.blind ? 1 : 0,
      producerIdentityHidden: record.producerIdentityHidden ? 1 : 0,
      independentFromProducer: record.independentFromProducer ? 1 : 0,
      verdict: record.verdict,
      rubricVersion: record.rubricVersion,
      evidenceIds: record.evidenceIds,
      dissentIds: record.dissentIds,
      reviewContentHash: record.reviewContentHash,
      committedAt: record.committedAt,
    })
    .onConflictDoNothing({ target: roomReviews.id })
    .returning({ id: roomReviews.id });
  return insertOutcome(record.id, rows);
}

async function appendDissent(
  tx: DbTransaction,
  scope: RoomEvidenceLedgerScope,
  record: RoomDissentRecordV1,
): Promise<RoomEvidenceLedgerAppendOutcome> {
  const rows = await tx
    .insert(roomDissents)
    .values({
      id: record.id,
      projectId: scope.projectId,
      roomId: scope.roomId,
      nodeId: record.nodeId,
      candidateId: record.candidateId,
      reviewId: record.reviewId,
      severity: record.severity,
      state: record.state,
      ownerId: record.ownerId,
      evidenceIds: record.evidenceIds,
      contentHash: record.contentHash,
      resolution: record.resolution,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    })
    .onConflictDoNothing({ target: roomDissents.id })
    .returning({ id: roomDissents.id });
  return insertOutcome(record.id, rows);
}

async function appendGateResult(
  tx: DbTransaction,
  scope: RoomEvidenceLedgerScope,
  record: RoomGateResultV1,
): Promise<RoomEvidenceLedgerAppendOutcome> {
  const rows = await tx
    .insert(roomGateResults)
    .values({
      id: record.id,
      projectId: scope.projectId,
      roomId: scope.roomId,
      nodeId: record.nodeId,
      candidateId: record.candidateId,
      profileId: record.profileId,
      kind: record.kind,
      hard: record.hard ? 1 : 0,
      status: record.status,
      evidenceIds: record.evidenceIds,
      evaluatorBindingId: record.evaluatorBindingId,
      command: record.command,
      exitCode: record.exitCode,
      recordedAt: record.recordedAt,
    })
    .onConflictDoNothing({ target: roomGateResults.id })
    .returning({ id: roomGateResults.id });
  return insertOutcome(record.id, rows);
}

async function appendPromotion(
  tx: DbTransaction,
  scope: RoomEvidenceLedgerScope,
  record: RoomPromotionRecordV1,
): Promise<RoomEvidenceLedgerAppendOutcome> {
  await lockCandidatePromotion(tx, scope, record.candidateId);
  const existing = await tx
    .select({ id: roomPromotions.id })
    .from(roomPromotions)
    .where(and(
      eq(roomPromotions.projectId, scope.projectId),
      eq(roomPromotions.roomId, scope.roomId),
      eq(roomPromotions.candidateId, record.candidateId),
    ))
    .limit(1);
  if (existing[0]) return { status: "conflict", recordId: record.id };

  const rows = await tx
    .insert(roomPromotions)
    .values({
      id: record.id,
      projectId: scope.projectId,
      roomId: scope.roomId,
      nodeId: record.nodeId,
      candidateId: record.candidateId,
      decision: record.decision,
      decisionActorType: record.decisionActorType,
      decisionActorId: record.decisionActorId,
      hardGateResultIds: record.hardGateResultIds,
      reviewIds: record.reviewIds,
      unresolvedDissentIds: record.unresolvedDissentIds,
      evidenceIds: record.evidenceIds,
      rationale: record.rationale,
      decidedAt: record.decidedAt,
    })
    .onConflictDoNothing({ target: roomPromotions.id })
    .returning({ id: roomPromotions.id });
  return insertOutcome(record.id, rows);
}

async function appendConfidenceSnapshot(
  tx: DbTransaction,
  scope: RoomEvidenceLedgerScope,
  record: RoomConfidenceSnapshotV1,
): Promise<RoomEvidenceLedgerAppendOutcome> {
  const rows = await tx
    .insert(roomConfidenceSnapshots)
    .values({
      id: record.id,
      projectId: scope.projectId,
      roomId: scope.roomId,
      nodeId: record.nodeId,
      candidateId: record.candidateId,
      band: record.band,
      methodologyVersion: record.methodologyVersion,
      inputEvidenceHash: record.inputEvidenceHash,
      dimensions: record.dimensions,
      staleEvidenceIds: record.staleEvidenceIds,
      unresolvedDissentIds: record.unresolvedDissentIds,
      modelSelfReportExcluded: record.modelSelfReportExcluded ? 1 : 0,
      computedAt: record.computedAt,
    })
    .onConflictDoNothing({ target: roomConfidenceSnapshots.id })
    .returning({ id: roomConfidenceSnapshots.id });
  return insertOutcome(record.id, rows);
}

async function loadArtifacts(
  tx: DbTransaction,
  scope: RoomEvidenceLedgerScope,
  ids: readonly string[],
): Promise<readonly RoomArtifactRecordV1[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select()
    .from(roomArtifacts)
    .where(and(
      eq(roomArtifacts.projectId, scope.projectId),
      eq(roomArtifacts.roomId, scope.roomId),
      inArray(roomArtifacts.id, ids),
    ));
  return orderRequestedRows(ids, rows, "artifact").map(rowToArtifact);
}

async function loadEvidence(
  tx: DbTransaction,
  scope: RoomEvidenceLedgerScope,
  ids: readonly string[],
): Promise<readonly RoomEvidenceRecordV1[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select()
    .from(roomEvidence)
    .where(and(
      eq(roomEvidence.projectId, scope.projectId),
      eq(roomEvidence.roomId, scope.roomId),
      inArray(roomEvidence.id, ids),
    ));
  return orderRequestedRows(ids, rows, "evidence").map(rowToEvidence);
}

async function loadCandidates(
  tx: DbTransaction,
  scope: RoomEvidenceLedgerScope,
  ids: readonly string[],
  options: { readonly missing?: "error" | "null" } = {},
): Promise<readonly RoomCandidateRecordV1[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select()
    .from(roomCandidates)
    .where(and(
      eq(roomCandidates.projectId, scope.projectId),
      eq(roomCandidates.roomId, scope.roomId),
      inArray(roomCandidates.id, ids),
    ));
  if (options.missing === "null" && rows.length === 0) return [];
  return orderRequestedRows(ids, rows, "candidate").map(rowToCandidate);
}

async function loadReviews(
  tx: DbTransaction,
  scope: RoomEvidenceLedgerScope,
  ids: readonly string[],
): Promise<readonly RoomReviewRecordV1[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select()
    .from(roomReviews)
    .where(and(
      eq(roomReviews.projectId, scope.projectId),
      eq(roomReviews.roomId, scope.roomId),
      inArray(roomReviews.id, ids),
    ));
  return orderRequestedRows(ids, rows, "review").map(rowToReview);
}

async function loadDissents(
  tx: DbTransaction,
  scope: RoomEvidenceLedgerScope,
  ids: readonly string[],
): Promise<readonly RoomDissentRecordV1[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select()
    .from(roomDissents)
    .where(and(
      eq(roomDissents.projectId, scope.projectId),
      eq(roomDissents.roomId, scope.roomId),
      inArray(roomDissents.id, ids),
    ));
  return orderRequestedRows(ids, rows, "dissent").map(rowToDissent);
}

async function loadGateResults(
  tx: DbTransaction,
  scope: RoomEvidenceLedgerScope,
  ids: readonly string[],
): Promise<readonly RoomGateResultV1[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select()
    .from(roomGateResults)
    .where(and(
      eq(roomGateResults.projectId, scope.projectId),
      eq(roomGateResults.roomId, scope.roomId),
      inArray(roomGateResults.id, ids),
    ));
  return orderRequestedRows(ids, rows, "gate result").map(rowToGateResult);
}

async function assertRoomScope(tx: DbTransaction, scope: RoomEvidenceLedgerScope): Promise<void> {
  const rows = await tx
    .select({ id: operationalRooms.id })
    .from(operationalRooms)
    .where(and(
      eq(operationalRooms.projectId, scope.projectId),
      eq(operationalRooms.id, scope.roomId),
    ))
    .limit(1);
  if (!rows[0]) {
    throw new RoomEvidenceLedgerError(
      "reference_not_found",
      `Room evidence ledger could not resolve Room ${scope.roomId} in the submitted project scope`,
    );
  }
}

async function lockCandidatePromotion(
  tx: DbTransaction,
  scope: RoomEvidenceLedgerScope,
  candidateId: string,
): Promise<void> {
  const lockKey = `fusion-room-evidence-promotion-v1:${scope.projectId}:${scope.roomId}:${candidateId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
}

function assertBoundProjectScope(
  boundProjectId: string | undefined,
  scope: RoomEvidenceLedgerScope,
): void {
  if (boundProjectId !== undefined && boundProjectId !== scope.projectId) {
    throw new RoomEvidenceLedgerError(
      "scope_mismatch",
      `Ledger scope project ${scope.projectId} does not match the bound project ${boundProjectId}`,
    );
  }
}

function assertEntryScope(scope: RoomEvidenceLedgerScope, entry: RoomEvidenceLedgerEntry): void {
  if (entry.record.roomId !== scope.roomId) {
    throw new RoomEvidenceLedgerError(
      "scope_mismatch",
      `Ledger entry ${entry.table}:${entry.record.id} belongs to Room ${entry.record.roomId}, not ${scope.roomId}`,
    );
  }
}

function insertOutcome(
  recordId: string,
  rows: readonly { readonly id: string }[],
): RoomEvidenceLedgerAppendOutcome {
  return rows[0]
    ? { status: "inserted", recordId: rows[0].id }
    : { status: "conflict", recordId };
}

function orderRequestedRows<TRecord extends { readonly id: string }>(
  ids: readonly string[],
  rows: readonly TRecord[],
  label: string,
): readonly TRecord[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (!row) {
      throw new RoomEvidenceLedgerError(
        "reference_not_found",
        `Room evidence ledger could not resolve ${label} ${id} in the submitted project and Room scope`,
      );
    }
    return row;
  });
}

function sortByCanonicalId<TRecord extends { readonly id: string }>(records: readonly TRecord[]): readonly TRecord[] {
  return [...records].sort((left, right) => compareCanonicalIds(left.id, right.id));
}

function compareCanonicalIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function rowToArtifact(row: typeof roomArtifacts.$inferSelect): RoomArtifactRecordV1 {
  return {
    contractVersion: ROOM_CONTRACT_VERSIONS.evidence,
    id: row.id,
    roomId: row.roomId,
    nodeId: row.nodeId,
    candidateId: row.candidateId,
    kind: row.kind as RoomArtifactRecordV1["kind"],
    mediaType: row.mediaType,
    uri: row.uri,
    contentHash: row.contentHash,
    producingBindingId: row.producingBindingId,
    sourceRevision: row.sourceRevision,
    sizeBytes: row.sizeBytes,
    immutable: true,
    createdAt: row.createdAt,
  };
}

function rowToEvidence(row: typeof roomEvidence.$inferSelect): RoomEvidenceRecordV1 {
  return {
    contractVersion: ROOM_CONTRACT_VERSIONS.evidence,
    id: row.id,
    roomId: row.roomId,
    nodeId: row.nodeId,
    candidateId: row.candidateId,
    kind: row.kind as RoomEvidenceRecordV1["kind"],
    authoritativeSourceUri: row.authoritativeSourceUri,
    sourceVersionOrHash: row.sourceVersionOrHash,
    capturedAt: row.capturedAt,
    collectionMethod: row.collectionMethod,
    collectorBindingId: row.collectorBindingId,
    contentHash: row.contentHash,
    artifactIds: readReferenceIds(row.artifactIds, "stored evidence artifact ids"),
    authoritativeSourceRetained: true,
    expiresAt: row.expiresAt,
  };
}

function rowToCandidate(row: typeof roomCandidates.$inferSelect): RoomCandidateRecordV1 {
  return {
    contractVersion: ROOM_CONTRACT_VERSIONS.evidence,
    id: row.id,
    roomId: row.roomId,
    nodeId: row.nodeId,
    producingBindingId: row.producingBindingId,
    nativeSessionId: row.nativeSessionId,
    happierSessionId: row.happierSessionId,
    providerId: row.providerId,
    modelRef: row.modelRef,
    protocolId: row.protocolId,
    protocolVersion: row.protocolVersion,
    contextVersion: row.contextVersion,
    inputVersion: row.inputVersion,
    configVersion: row.configVersion,
    contentHash: row.contentHash,
    artifactIds: readReferenceIds(row.artifactIds, "stored candidate artifact ids"),
    parentCandidateIds: readReferenceIds(row.parentCandidateIds, "stored candidate parent ids"),
    gateResultIds: readReferenceIds(row.gateResultIds, "stored candidate gate result ids"),
    reviewIds: readReferenceIds(row.reviewIds, "stored candidate review ids"),
    promotionState: row.promotionState as RoomCandidateRecordV1["promotionState"],
    createdAt: row.createdAt,
  };
}

function rowToReview(row: typeof roomReviews.$inferSelect): RoomReviewRecordV1 {
  return {
    contractVersion: ROOM_CONTRACT_VERSIONS.evidence,
    id: row.id,
    roomId: row.roomId,
    nodeId: row.nodeId,
    candidateId: row.candidateId,
    blindCandidateRef: row.blindCandidateRef,
    reviewerBindingId: row.reviewerBindingId,
    reviewerNativeSessionId: row.reviewerNativeSessionId,
    reviewerHappierSessionId: row.reviewerHappierSessionId,
    blind: readStoredBoolean(row.blind, "stored review blind flag"),
    producerIdentityHidden: readStoredBoolean(row.producerIdentityHidden, "stored review producer identity flag"),
    independentFromProducer: readStoredBoolean(
      row.independentFromProducer,
      "stored review independence flag",
    ),
    verdict: row.verdict as RoomReviewRecordV1["verdict"],
    rubricVersion: row.rubricVersion,
    evidenceIds: readReferenceIds(row.evidenceIds, "stored review evidence ids"),
    dissentIds: readReferenceIds(row.dissentIds, "stored review dissent ids"),
    reviewContentHash: row.reviewContentHash,
    committedAt: row.committedAt,
  };
}

function rowToDissent(row: typeof roomDissents.$inferSelect): RoomDissentRecordV1 {
  return {
    contractVersion: ROOM_CONTRACT_VERSIONS.evidence,
    id: row.id,
    roomId: row.roomId,
    nodeId: row.nodeId,
    candidateId: row.candidateId,
    reviewId: row.reviewId,
    severity: row.severity as RoomDissentRecordV1["severity"],
    state: row.state as RoomDissentRecordV1["state"],
    ownerId: row.ownerId,
    evidenceIds: readReferenceIds(row.evidenceIds, "stored dissent evidence ids"),
    contentHash: row.contentHash,
    resolution: readDissentResolution(row.resolution),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToGateResult(row: typeof roomGateResults.$inferSelect): RoomGateResultV1 {
  return {
    contractVersion: ROOM_CONTRACT_VERSIONS.evidence,
    id: row.id,
    roomId: row.roomId,
    nodeId: row.nodeId,
    candidateId: row.candidateId,
    profileId: row.profileId,
    kind: row.kind as RoomGateResultV1["kind"],
    hard: readStoredBoolean(row.hard, "stored gate hard flag"),
    status: row.status as RoomGateResultV1["status"],
    evidenceIds: readReferenceIds(row.evidenceIds, "stored gate evidence ids"),
    evaluatorBindingId: row.evaluatorBindingId,
    command: row.command,
    exitCode: row.exitCode,
    recordedAt: row.recordedAt,
  };
}

function rowToPromotion(row: typeof roomPromotions.$inferSelect): RoomPromotionRecordV1 {
  return {
    contractVersion: ROOM_CONTRACT_VERSIONS.evidence,
    id: row.id,
    roomId: row.roomId,
    nodeId: row.nodeId,
    candidateId: row.candidateId,
    decision: row.decision as RoomPromotionRecordV1["decision"],
    decisionActorType: row.decisionActorType as RoomPromotionRecordV1["decisionActorType"],
    decisionActorId: row.decisionActorId,
    hardGateResultIds: readReferenceIds(row.hardGateResultIds, "stored promotion hard gate ids"),
    reviewIds: readReferenceIds(row.reviewIds, "stored promotion review ids"),
    unresolvedDissentIds: readReferenceIds(
      row.unresolvedDissentIds,
      "stored promotion unresolved dissent ids",
    ),
    evidenceIds: readReferenceIds(row.evidenceIds, "stored promotion evidence ids"),
    rationale: row.rationale,
    decidedAt: row.decidedAt,
  };
}

function readStoredBoolean(value: unknown, label: string): boolean {
  if (value === 0) return false;
  if (value === 1) return true;
  throw new RoomEvidenceLedgerError("invalid_input", `${label} must be stored as 0 or 1`);
}

function readReferenceIds(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new RoomEvidenceLedgerError("invalid_input", `${label} must be a JSON array of references`);
  }
  return [...value];
}

function readDissentResolution(value: unknown): RoomDissentRecordV1["resolution"] {
  if (value === null) return null;
  if (!isRecord(value) || !Array.isArray(value.evidenceIds)) {
    throw new RoomEvidenceLedgerError("invalid_input", "Stored dissent resolution is invalid");
  }
  if (
    (value.kind !== "resolved" && value.kind !== "disproved" && value.kind !== "operator_accepted_residual")
    || typeof value.actorId !== "string"
    || typeof value.rationale !== "string"
    || typeof value.resolvedAt !== "string"
  ) {
    throw new RoomEvidenceLedgerError("invalid_input", "Stored dissent resolution is invalid");
  }
  return {
    kind: value.kind,
    actorId: value.actorId,
    evidenceIds: readReferenceIds(value.evidenceIds, "stored dissent resolution evidence ids"),
    rationale: value.rationale,
    resolvedAt: value.resolvedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

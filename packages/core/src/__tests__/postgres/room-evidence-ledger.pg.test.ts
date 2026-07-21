import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";

import {
  AsyncRoomEvidenceLedger,
  type AppendRoomArtifactInputV1,
  type AppendRoomCandidateInputV1,
  type AppendRoomConfidenceSnapshotInputV1,
  type AppendRoomDissentInputV1,
  type AppendRoomEvidenceInputV1,
  type AppendRoomGateResultInputV1,
  type AppendRoomPromotionInputV1,
  type AppendRoomReviewInputV1,
  type RoomEvidenceLedgerScope,
} from "../../async-room-evidence-ledger.js";
import { AsyncRoomEvidenceLedgerPostgresPersistence } from "../../async-room-evidence-ledger-postgres.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
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
} from "../../postgres/schema/room.js";
import { hashRoomValue } from "../../room-integrity.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const PROJECT_ID = "project-room-evidence-ledger";
const ROOM_ID = "room-evidence-ledger";
const OTHER_ROOM_ID = "room-evidence-ledger-other";
const CREATED_AT = "2026-07-19T08:21:00.000Z";
const SCOPE = { projectId: PROJECT_ID, roomId: ROOM_ID } as const satisfies RoomEvidenceLedgerScope;
const OTHER_SCOPE = { projectId: PROJECT_ID, roomId: OTHER_ROOM_ID } as const satisfies RoomEvidenceLedgerScope;
const ARTIFACT_ID = "artifact-ledger-1";
const EVIDENCE_ID = "evidence-ledger-1";
const CANDIDATE_ID = "candidate-ledger-1";
const REVIEW_ID = "review-ledger-1";
const DISSENT_ID = "dissent-ledger-1";
const GATE_ID = "gate-ledger-1";
const PROMOTION_ID = "promotion-ledger-1";
const CONFIDENCE_ID = "confidence-ledger-1";

let sharedContext: EmbeddedTestContext | null = null;
let sharedLayer: AsyncDataLayer | null = null;

const hash = (value: string): string => hashRoomValue({ value });

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-evidence-ledger-"));
  const lifecycle = new EmbeddedPostgresLifecycle({
    dataDir,
    database: "fusion",
    user: "postgres",
    password: "password",
  });
  const backend = await lifecycle.start();
  const context = {
    dataDir,
    lifecycle,
    connections: await createConnectionSetFromUrl(backend, { poolMax: 4 }),
  } satisfies EmbeddedTestContext;
  await applySchemaBaseline(context.connections.migration, { pluginHooks: [] });
  return context;
}

beforeAll(async () => {
  sharedContext = await startEmbeddedDatabase();
  sharedLayer = createAsyncDataLayer(sharedContext.connections!, { projectId: PROJECT_ID });
}, 60_000);

beforeEach(async () => {
  await requireLayer().db.execute(sql.raw("TRUNCATE TABLE project.operational_rooms RESTART IDENTITY CASCADE"));
});

afterAll(async () => {
  const context = sharedContext;
  sharedContext = null;
  sharedLayer = null;
  if (!context) return;
  if (context.connections) {
    await context.connections.close();
    context.connections = null;
  }
  await context.lifecycle.stop();
  rmSync(context.dataDir, { recursive: true, force: true });
});

function requireLayer(): AsyncDataLayer {
  if (!sharedLayer) throw new Error("Room evidence-ledger PostgreSQL fixture was not started");
  return sharedLayer;
}

function createLedger(): AsyncRoomEvidenceLedger {
  return new AsyncRoomEvidenceLedger(new AsyncRoomEvidenceLedgerPostgresPersistence(requireLayer()));
}

async function createRoom(scope: RoomEvidenceLedgerScope): Promise<void> {
  await requireLayer().db.insert(operationalRooms).values({
    id: scope.roomId,
    projectId: scope.projectId,
    objective: "Persist a Room evidence-ledger graph",
    protocolId: "implementation",
    protocolVersion: 1,
    protocolPhaseId: null,
    lifecycleState: "ready",
    aggregateVersion: 0,
    taskGraphVersion: 0,
    membershipVersion: 0,
    activeTurnId: null,
    completionContract: {},
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
}

function candidateInput(
  scope: RoomEvidenceLedgerScope,
  overrides: Partial<AppendRoomCandidateInputV1> = {},
): AppendRoomCandidateInputV1 {
  return {
    scope,
    id: CANDIDATE_ID,
    nodeId: "node-ledger-1",
    producingBindingId: "binding-producer",
    nativeSessionId: "native-producer",
    happierSessionId: "happier-producer",
    providerId: "codex",
    modelRef: "provider-owned-model",
    protocolId: "implementation",
    protocolVersion: 1,
    contextVersion: "context-ledger-1",
    inputVersion: "input-ledger-1",
    configVersion: "config-ledger-1",
    contentHash: hash("candidate"),
    artifactIds: [ARTIFACT_ID],
    parentCandidateIds: [],
    gateResultIds: [GATE_ID],
    reviewIds: [REVIEW_ID],
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function artifactInput(
  scope: RoomEvidenceLedgerScope,
  overrides: Partial<AppendRoomArtifactInputV1> = {},
): AppendRoomArtifactInputV1 {
  return {
    scope,
    id: ARTIFACT_ID,
    nodeId: "node-ledger-1",
    candidateId: CANDIDATE_ID,
    kind: "code",
    mediaType: "text/plain",
    uri: "https://evidence.example/artifacts/ledger-1",
    contentHash: hash("artifact"),
    producingBindingId: "binding-producer",
    sourceRevision: "revision-ledger-1",
    sizeBytes: 42,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function evidenceInput(
  scope: RoomEvidenceLedgerScope,
  overrides: Partial<AppendRoomEvidenceInputV1> = {},
): AppendRoomEvidenceInputV1 {
  return {
    scope,
    id: EVIDENCE_ID,
    nodeId: "node-ledger-1",
    candidateId: CANDIDATE_ID,
    kind: "test",
    authoritativeSourceUri: "https://evidence.example/results/ledger-1",
    sourceVersionOrHash: "revision-ledger-1",
    capturedAt: CREATED_AT,
    collectionMethod: "vitest",
    collectorBindingId: "binding-verifier",
    contentHash: hash("evidence"),
    artifactIds: [ARTIFACT_ID],
    expiresAt: null,
    ...overrides,
  };
}

function dissentInput(
  scope: RoomEvidenceLedgerScope,
  overrides: Partial<AppendRoomDissentInputV1> = {},
): AppendRoomDissentInputV1 {
  return {
    scope,
    id: DISSENT_ID,
    nodeId: "node-ledger-1",
    candidateId: CANDIDATE_ID,
    reviewId: null,
    severity: "minor",
    ownerId: "seat-security-reviewer",
    evidenceIds: [EVIDENCE_ID],
    contentHash: hash("dissent"),
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function reviewInput(
  scope: RoomEvidenceLedgerScope,
  overrides: Partial<AppendRoomReviewInputV1> = {},
): AppendRoomReviewInputV1 {
  return {
    scope,
    id: REVIEW_ID,
    nodeId: "node-ledger-1",
    candidateId: CANDIDATE_ID,
    blindCandidateRef: "blind-ledger-a",
    reviewerBindingId: "binding-reviewer",
    reviewerNativeSessionId: "native-reviewer",
    reviewerHappierSessionId: "happier-reviewer",
    blind: true,
    producerIdentityHidden: true,
    independentFromProducer: true,
    verdict: "accept",
    rubricVersion: "rubric-ledger-1",
    evidenceIds: [EVIDENCE_ID],
    dissentIds: [DISSENT_ID],
    reviewContentHash: hash("review"),
    committedAt: CREATED_AT,
    ...overrides,
  };
}

function gateResultInput(
  scope: RoomEvidenceLedgerScope,
  overrides: Partial<AppendRoomGateResultInputV1> = {},
): AppendRoomGateResultInputV1 {
  return {
    scope,
    id: GATE_ID,
    nodeId: "node-ledger-1",
    candidateId: CANDIDATE_ID,
    profileId: "locked-constraints",
    kind: "policy",
    hard: true,
    status: "passed",
    evidenceIds: [EVIDENCE_ID],
    evaluatorBindingId: "binding-verifier",
    command: "pnpm test:gate",
    exitCode: 0,
    recordedAt: CREATED_AT,
    ...overrides,
  };
}

function promotionInput(
  scope: RoomEvidenceLedgerScope,
  overrides: Partial<AppendRoomPromotionInputV1> = {},
): AppendRoomPromotionInputV1 {
  return {
    scope,
    id: PROMOTION_ID,
    nodeId: "node-ledger-1",
    candidateId: CANDIDATE_ID,
    decision: "promoted",
    decisionActorType: "independent_arbiter",
    decisionActorId: "binding-arbiter",
    hardGateResultIds: [GATE_ID],
    reviewIds: [REVIEW_ID],
    unresolvedDissentIds: [DISSENT_ID],
    evidenceIds: [EVIDENCE_ID],
    rationale: "The required hard gate passed and an independent review accepted the candidate.",
    decidedAt: CREATED_AT,
    ...overrides,
  };
}

function confidenceSnapshotInput(
  scope: RoomEvidenceLedgerScope,
  overrides: Partial<AppendRoomConfidenceSnapshotInputV1> = {},
): AppendRoomConfidenceSnapshotInputV1 {
  return {
    scope,
    id: CONFIDENCE_ID,
    nodeId: "node-ledger-1",
    candidateId: CANDIDATE_ID,
    methodologyVersion: "room-confidence/v1",
    computedAt: "2026-07-19T08:22:00.000Z",
    requiredEvidenceKinds: ["test"],
    evidenceIds: [EVIDENCE_ID],
    calibration: {
      source: "authorized_outcome_calibration",
      domain: "code",
      outcomeCount: 24,
      meanAbsoluteError: 0.05,
      observedAt: CREATED_AT,
      evidenceIds: [EVIDENCE_ID],
    },
    ...overrides,
  };
}

describe("AsyncRoomEvidenceLedger PostgreSQL persistence", () => {
  it("persists an immutable derived confidence snapshot without model self-report input", async () => {
    await createRoom(SCOPE);
    const ledger = createLedger();
    const secondReviewId = "review-ledger-2";

    await ledger.appendCandidate(candidateInput(SCOPE, { reviewIds: [REVIEW_ID, secondReviewId] }));
    await ledger.appendArtifact(artifactInput(SCOPE));
    await ledger.appendEvidence(evidenceInput(SCOPE));
    await ledger.appendReview(reviewInput(SCOPE, { dissentIds: [] }));
    await ledger.appendReview(reviewInput(SCOPE, {
      id: secondReviewId,
      blindCandidateRef: "blind-ledger-b",
      reviewerBindingId: "binding-reviewer-2",
      reviewerNativeSessionId: "native-reviewer-2",
      reviewerHappierSessionId: "happier-reviewer-2",
      dissentIds: [],
    }));
    await ledger.appendGateResult(gateResultInput(SCOPE));

    const snapshot = await ledger.appendConfidenceSnapshot(confidenceSnapshotInput(SCOPE));

    expect(snapshot).toMatchObject({
      table: "room_confidence_snapshots",
      record: {
        id: CONFIDENCE_ID,
        band: "high",
        modelSelfReportExcluded: true,
      },
    });
    await expect(ledger.appendConfidenceSnapshot(confidenceSnapshotInput(SCOPE))).rejects.toMatchObject({
      code: "immutable_conflict",
    });

    const rows = await requireLayer().db
      .select()
      .from(roomConfidenceSnapshots)
      .where(and(
        eq(roomConfidenceSnapshots.projectId, PROJECT_ID),
        eq(roomConfidenceSnapshots.roomId, ROOM_ID),
      ));
    expect(rows).toMatchObject([{
      id: CONFIDENCE_ID,
      candidateId: CANDIDATE_ID,
      band: "high",
      methodologyVersion: "room-confidence/v1",
      staleEvidenceIds: [],
      unresolvedDissentIds: [],
      modelSelfReportExcluded: 1,
    }]);
    expect(rows).toHaveLength(1);
  });

  it("persists an immutable Room-scoped artifact, evidence, candidate, review, dissent, gate, and promotion graph", async () => {
    await createRoom(SCOPE);
    const ledger = createLedger();

    await ledger.appendCandidate(candidateInput(SCOPE));
    await ledger.appendArtifact(artifactInput(SCOPE));
    await ledger.appendEvidence(evidenceInput(SCOPE));
    await ledger.appendDissent(dissentInput(SCOPE));
    await ledger.appendReview(reviewInput(SCOPE));
    await ledger.appendGateResult(gateResultInput(SCOPE));
    const promotion = await ledger.appendPromotion(promotionInput(SCOPE));

    expect(promotion).toMatchObject({ table: "room_promotions", record: { id: PROMOTION_ID } });

    const layer = requireLayer();
    const [artifacts, evidence, candidates, reviews, dissents, gateResults, promotions] = await Promise.all([
      layer.db.select().from(roomArtifacts).where(and(eq(roomArtifacts.projectId, PROJECT_ID), eq(roomArtifacts.roomId, ROOM_ID))),
      layer.db.select().from(roomEvidence).where(and(eq(roomEvidence.projectId, PROJECT_ID), eq(roomEvidence.roomId, ROOM_ID))),
      layer.db.select().from(roomCandidates).where(and(eq(roomCandidates.projectId, PROJECT_ID), eq(roomCandidates.roomId, ROOM_ID))),
      layer.db.select().from(roomReviews).where(and(eq(roomReviews.projectId, PROJECT_ID), eq(roomReviews.roomId, ROOM_ID))),
      layer.db.select().from(roomDissents).where(and(eq(roomDissents.projectId, PROJECT_ID), eq(roomDissents.roomId, ROOM_ID))),
      layer.db.select().from(roomGateResults).where(and(eq(roomGateResults.projectId, PROJECT_ID), eq(roomGateResults.roomId, ROOM_ID))),
      layer.db.select().from(roomPromotions).where(and(eq(roomPromotions.projectId, PROJECT_ID), eq(roomPromotions.roomId, ROOM_ID))),
    ]);

    expect(artifacts).toMatchObject([{ id: ARTIFACT_ID, candidateId: CANDIDATE_ID, contentHash: hash("artifact") }]);
    expect(evidence).toMatchObject([{ id: EVIDENCE_ID, candidateId: CANDIDATE_ID, artifactIds: [ARTIFACT_ID] }]);
    expect(candidates).toMatchObject([{
      id: CANDIDATE_ID,
      artifactIds: [ARTIFACT_ID],
      gateResultIds: [GATE_ID],
      reviewIds: [REVIEW_ID],
      promotionState: "pending",
    }]);
    expect(reviews).toMatchObject([{ id: REVIEW_ID, candidateId: CANDIDATE_ID, independentFromProducer: 1 }]);
    expect(dissents).toMatchObject([{ id: DISSENT_ID, candidateId: CANDIDATE_ID, state: "open" }]);
    expect(gateResults).toMatchObject([{ id: GATE_ID, candidateId: CANDIDATE_ID, hard: 1, status: "passed" }]);
    expect(promotions).toMatchObject([{ id: PROMOTION_ID, candidateId: CANDIDATE_ID, decision: "promoted" }]);
  });

  it("surfaces a duplicate immutable ID as a conflict and preserves the first row", async () => {
    await createRoom(SCOPE);
    const ledger = createLedger();

    await ledger.appendArtifact(artifactInput(SCOPE, { candidateId: null }));
    await expect(ledger.appendArtifact(artifactInput(SCOPE, {
      candidateId: null,
      sourceRevision: "revision-ledger-overwrite-attempt",
    }))).rejects.toMatchObject({ code: "immutable_conflict" });

    const rows = await requireLayer().db
      .select()
      .from(roomArtifacts)
      .where(and(eq(roomArtifacts.projectId, PROJECT_ID), eq(roomArtifacts.roomId, ROOM_ID)));
    expect(rows).toMatchObject([{ id: ARTIFACT_ID, sourceRevision: "revision-ledger-1" }]);
    expect(rows).toHaveLength(1);
  });

  it("rejects a candidate reference that belongs to another Room", async () => {
    await createRoom(SCOPE);
    await createRoom(OTHER_SCOPE);
    const ledger = createLedger();
    const foreignCandidateId = "candidate-ledger-foreign";

    await ledger.appendCandidate(candidateInput(OTHER_SCOPE, {
      id: foreignCandidateId,
      artifactIds: [],
      gateResultIds: [],
      reviewIds: [],
    }));

    await expect(ledger.appendEvidence(evidenceInput(SCOPE, {
      candidateId: foreignCandidateId,
      artifactIds: [],
    }))).rejects.toMatchObject({ code: "reference_not_found" });

    const rows = await requireLayer().db
      .select()
      .from(roomEvidence)
      .where(and(eq(roomEvidence.projectId, PROJECT_ID), eq(roomEvidence.roomId, ROOM_ID)));
    expect(rows).toHaveLength(0);
  });

  it("rejects self-review and self-promotion through the facade and PostgreSQL adapter", async () => {
    await createRoom(SCOPE);
    const ledger = createLedger();
    const selfCandidateId = "candidate-ledger-self";
    const selfReviewId = "review-ledger-self";
    const selfGateId = "gate-ledger-self";

    await ledger.appendCandidate(candidateInput(SCOPE, {
      id: selfCandidateId,
      artifactIds: [],
      gateResultIds: [selfGateId],
      reviewIds: [selfReviewId],
    }));

    await expect(ledger.appendReview(reviewInput(SCOPE, {
      id: selfReviewId,
      candidateId: selfCandidateId,
      evidenceIds: [],
      dissentIds: [],
      reviewerBindingId: "binding-producer",
      reviewerNativeSessionId: "native-producer",
      reviewerHappierSessionId: "happier-producer",
    }))).rejects.toMatchObject({ code: "self_review_forbidden" });

    await ledger.appendGateResult(gateResultInput(SCOPE, {
      id: selfGateId,
      candidateId: selfCandidateId,
      evidenceIds: [],
    }));
    await ledger.appendReview(reviewInput(SCOPE, {
      id: selfReviewId,
      candidateId: selfCandidateId,
      evidenceIds: [],
      dissentIds: [],
    }));

    await expect(ledger.appendPromotion(promotionInput(SCOPE, {
      id: "promotion-ledger-self",
      candidateId: selfCandidateId,
      hardGateResultIds: [selfGateId],
      reviewIds: [selfReviewId],
      unresolvedDissentIds: [],
      evidenceIds: [],
      decisionActorId: "binding-producer",
    }))).rejects.toMatchObject({ code: "self_promotion_forbidden" });

    const [reviews, promotions] = await Promise.all([
      requireLayer().db.select().from(roomReviews).where(and(eq(roomReviews.projectId, PROJECT_ID), eq(roomReviews.roomId, ROOM_ID))),
      requireLayer().db.select().from(roomPromotions).where(and(eq(roomPromotions.projectId, PROJECT_ID), eq(roomPromotions.roomId, ROOM_ID))),
    ]);
    expect(reviews).toMatchObject([{ id: selfReviewId, reviewerBindingId: "binding-reviewer" }]);
    expect(promotions).toHaveLength(0);
  });
});

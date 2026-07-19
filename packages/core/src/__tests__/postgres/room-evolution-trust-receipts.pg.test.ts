import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AsyncRoomEvolutionLedger,
  type AppendRoomEvolutionCanarySuccessOutcomeInputV1,
  type AppendRoomEvolutionTrustedBindingInputV1,
  type RoomEvolutionLedgerScope,
} from "../../async-room-evolution-ledger.js";
import { AsyncRoomEvolutionLedgerPostgresPersistence } from "../../async-room-evolution-ledger-postgres.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import {
  operationalRooms,
  roomBindings,
  roomEvolutionCanarySuccessOutcomes,
  roomEvolutionPromotionDecisions,
  roomEvolutionTrustedBindings,
  roomRbacGrants,
  roomSeats,
} from "../../postgres/schema/room.js";
import { hashRoomValue } from "../../room-integrity.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const PROJECT_ID = "project-evolution-trust-pg";
const ROOM_ID = "room-evolution-trust-pg";
const CREATED_AT = "2026-07-19T20:00:00.000Z";
const EXPIRES_AT = "2026-07-20T20:00:00.000Z";
const SCOPE = {
  projectId: PROJECT_ID,
  roomId: ROOM_ID,
  scopeKind: "room",
  scopeKey: `room:${ROOM_ID}`,
} as const satisfies RoomEvolutionLedgerScope;
const hash = (value: unknown): string => hashRoomValue(value);
const evidence = (id: string) => ({
  id,
  source: "durable_room_ledger" as const,
  sourceRef: `source:${id}`,
  evidenceHash: hash({ id }),
  observedAt: CREATED_AT,
});

let sharedContext: EmbeddedTestContext | null = null;
let sharedLayer: AsyncDataLayer | null = null;

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-evolution-trust-"));
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
}, 60_000);

function requireLayer(): AsyncDataLayer {
  if (!sharedLayer) throw new Error("Room evolution trust PostgreSQL fixture was not started");
  return sharedLayer;
}

function ledger(): AsyncRoomEvolutionLedger {
  return new AsyncRoomEvolutionLedger(new AsyncRoomEvolutionLedgerPostgresPersistence(requireLayer()));
}

async function seedRoomIdentities(): Promise<void> {
  await requireLayer().db.insert(operationalRooms).values({
    id: ROOM_ID,
    projectId: PROJECT_ID,
    objective: "Persist trusted controlled-evolution identities.",
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
  await requireLayer().db.insert(roomSeats).values([
    {
      id: "seat-producer",
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      role: "producer",
      roleVersion: 1,
      roleHistory: [],
      permissionScope: [],
      state: "active",
      activeBindingId: "binding-producer",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    {
      id: "seat-evaluator",
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      role: "evaluator",
      roleVersion: 1,
      roleHistory: [],
      permissionScope: [],
      state: "active",
      activeBindingId: "binding-evaluator",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
  ]);
  await requireLayer().db.insert(roomBindings).values([
    {
      id: "binding-producer",
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      seatId: "seat-producer",
      generation: 1,
      connectorId: "connector-test",
      providerId: "provider-test",
      nativeSessionId: "native-producer",
      happierSessionId: null,
      serverProfileId: null,
      machineId: null,
      hostId: "host-test",
      state: "attached",
      attachedAt: CREATED_AT,
      detachedAt: null,
      replacedByBindingId: null,
      replacementReason: null,
    },
    {
      id: "binding-evaluator",
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      seatId: "seat-evaluator",
      generation: 1,
      connectorId: "connector-test",
      providerId: "provider-test",
      nativeSessionId: "native-evaluator",
      happierSessionId: null,
      serverProfileId: null,
      machineId: null,
      hostId: "host-test",
      state: "attached",
      attachedAt: CREATED_AT,
      detachedAt: null,
      replacedByBindingId: null,
      replacementReason: null,
    },
  ]);
  await requireLayer().db.insert(roomRbacGrants).values({
    projectId: PROJECT_ID,
    grantId: "grant-owner",
    principalId: "owner-principal",
    role: "owner",
    roomId: ROOM_ID,
    grantedAt: CREATED_AT,
    revokedAt: null,
  });
}

function trustedBinding(
  id: string,
  actorId: string,
  purpose: AppendRoomEvolutionTrustedBindingInputV1["purpose"],
  roomBindingId: string,
  roleId: string,
): AppendRoomEvolutionTrustedBindingInputV1 {
  return {
    scope: SCOPE,
    id,
    actorId,
    purpose,
    subjectRoomId: ROOM_ID,
    roomBindingId,
    roomBindingGeneration: 1,
    roleId,
    roleVersion: 1,
    bindingVersion: 1,
    issuedByPrincipalId: "owner-principal",
    issuerGrantId: "grant-owner",
    issuedAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
  };
}

function canarySuccess(): AppendRoomEvolutionCanarySuccessOutcomeInputV1 {
  return {
    scope: SCOPE,
    id: "canary-success-pg-1",
    canaryId: "canary-pg-1",
    experimentId: "experiment-pg-1",
    candidateVersionId: "candidate-pg-next",
    candidateHash: hash("candidate-pg-next-artifact"),
    candidateBindingId: "trust-producer",
    candidateBindingVersion: 1,
    evaluatorBindingId: "trust-evaluator",
    evaluatorBindingVersion: 1,
    gateResultIds: ["gate-pg-1"],
    allocationHash: hash({ fraction: 0.1 }),
    artifactHash: hash("canary-success-artifact"),
    metrics: { quality: 0.96 },
    evidence: [evidence("canary-success-pg")],
    evidenceHash: hash("canary-success-pg"),
    completedAt: CREATED_AT,
  };
}

async function seedVerifiedCanaryGraph(): Promise<AsyncRoomEvolutionLedger> {
  const value = ledger();
  await value.appendHypothesis({
    scope: SCOPE,
    id: "hypothesis-pg-1",
    revision: 1,
    state: "proposed",
    sourceSignalKinds: ["failure"],
    evidence: [evidence("hypothesis-pg")],
    evidenceHash: hash("hypothesis-pg"),
    declaredScope: ["protocol"],
    riskClass: "moderate",
    expectedMechanism: "Require trusted independent evidence before promotion.",
    affectedDomains: ["orchestration"],
    createdByActorId: "evolution-controller",
    createdAt: CREATED_AT,
  });
  await value.appendTrustedBinding(trustedBinding(
    "trust-producer",
    "actor-producer",
    "candidate_producer",
    "binding-producer",
    "producer",
  ));
  await value.appendTrustedBinding(trustedBinding(
    "trust-evaluator",
    "actor-evaluator",
    "independent_evaluator",
    "binding-evaluator",
    "evaluator",
  ));
  await value.appendVerifiedCandidateVersion({
    candidate: {
      scope: SCOPE,
      id: "candidate-pg-baseline",
      hypothesisId: "hypothesis-pg-1",
      versionNumber: 1,
      candidateKind: "protocol",
      baseRevision: "strategy@baseline",
      candidateRef: "strategy@candidate-baseline",
      isolationKind: "versioned_policy_store",
      isolationRef: "policy-store-baseline",
      immutableInput: { version: "baseline" },
      inputHash: hash("candidate-pg-baseline-input"),
      producedByActorId: "actor-producer",
      baseCandidateVersionId: null,
      rollbackTargetCandidateVersionId: null,
      createdAt: CREATED_AT,
    },
    candidateHash: hash("candidate-pg-baseline-artifact"),
    producerBindingId: "trust-producer",
    producerBindingVersion: 1,
  });
  await value.appendVerifiedCandidateVersion({
    candidate: {
      scope: SCOPE,
      id: "candidate-pg-next",
      hypothesisId: "hypothesis-pg-1",
      versionNumber: 2,
      candidateKind: "protocol",
      baseRevision: "strategy@candidate-baseline",
      candidateRef: "strategy@candidate-next",
      isolationKind: "versioned_policy_store",
      isolationRef: "policy-store-next",
      immutableInput: { version: "next" },
      inputHash: hash("candidate-pg-next-input"),
      producedByActorId: "actor-producer",
      baseCandidateVersionId: "candidate-pg-baseline",
      rollbackTargetCandidateVersionId: "candidate-pg-baseline",
      createdAt: CREATED_AT,
    },
    candidateHash: hash("candidate-pg-next-artifact"),
    producerBindingId: "trust-producer",
    producerBindingVersion: 1,
  });
  await value.appendExperiment({
    scope: SCOPE,
    id: "experiment-pg-1",
    hypothesisId: "hypothesis-pg-1",
    candidateVersionId: "candidate-pg-next",
    state: "planned",
    inputSnapshotHash: hash("experiment-pg-input"),
    authorizationEvidence: { pool: "evolution_low_priority" },
    authorizationHash: hash("experiment-pg-auth"),
    capacityPool: "evolution_low_priority",
    createdByActorId: "evolution-controller",
    createdAt: CREATED_AT,
  });
  await value.appendVerifiedGateResult({
    gate: {
      scope: SCOPE,
      id: "gate-pg-1",
      experimentId: "experiment-pg-1",
      candidateVersionId: "candidate-pg-next",
      benchmarkResultId: null,
      gateName: "independent-hard-gate",
      gateClass: "hard",
      outcome: "passed",
      evaluatorActorId: "actor-evaluator",
      evaluatorKind: "independent_reviewer",
      candidateProducerActorId: "actor-producer",
      metrics: { quality: 0.96 },
      evidence: [evidence("gate-pg")],
      evidenceHash: hash("gate-pg"),
      promotionEligible: true,
      completedAt: CREATED_AT,
    },
    candidateHash: hash("candidate-pg-next-artifact"),
    candidateBindingId: "trust-producer",
    candidateBindingVersion: 1,
    evaluatorBindingId: "trust-evaluator",
    evaluatorBindingVersion: 1,
    evaluationArtifactHash: hash("gate-pg-artifact"),
  });
  await value.appendCanary({
    scope: SCOPE,
    id: "canary-pg-1",
    experimentId: "experiment-pg-1",
    candidateVersionId: "candidate-pg-next",
    allocationVersion: 1,
    allocation: { fraction: 0.1 },
    successCriteria: { quality: { min: 0.9 } },
    failureCriteria: { correctionRate: { max: 0.05 } },
    state: "running",
    rollbackTargetCandidateVersionId: "candidate-pg-baseline",
    createdAt: CREATED_AT,
  });
  return value;
}

describe("AsyncRoomEvolutionLedgerPostgresPersistence trust receipts", () => {
  it("durably validates trusted roles and read-backs a success receipt before promotion", async () => {
    await seedRoomIdentities();
    const value = await seedVerifiedCanaryGraph();

    const success = await value.appendCanarySuccessOutcome(canarySuccess());
    const promotion = await value.appendVerifiedPromotionDecision({
      decision: {
        scope: SCOPE,
        id: "promotion-pg-1",
        experimentId: "experiment-pg-1",
        candidateVersionId: "candidate-pg-next",
        canaryId: "canary-pg-1",
        decision: "promoted",
        riskClass: "moderate",
        authorityTier: "independent",
        candidateProducerActorId: "actor-producer",
        decisionActorId: "actor-evaluator",
        approvalRequestId: null,
        authorizationEvidence: { policy: "pre-authorized" },
        evidence: [evidence("promotion-pg")],
        evidenceHash: hash("promotion-pg"),
        rollbackTargetCandidateVersionId: "candidate-pg-baseline",
        decidedAt: CREATED_AT,
      },
      canarySuccessOutcomeId: success.record.id,
      decisionBindingId: "trust-evaluator",
      decisionBindingVersion: 1,
    });

    const persisted = await value.readReferences({
      scope: SCOPE,
      hypothesisIds: [],
      candidateVersionIds: ["candidate-pg-next"],
      trustedBindingIds: ["trust-producer", "trust-evaluator"],
      experimentIds: [],
      benchmarkCaseIds: [],
      benchmarkResultIds: [],
      gateResultIds: ["gate-pg-1"],
      canaryIds: [],
      canaryObservationIds: [],
      canarySuccessOutcomeIds: [success.record.id],
      promotionDecisionIds: [promotion.record.id],
      rollbackIds: [],
    });

    expect(persisted.candidateVersions).toMatchObject([{
      id: "candidate-pg-next",
      candidateHash: hash("candidate-pg-next-artifact"),
      producerBindingId: "trust-producer",
      producerBindingVersion: 1,
    }]);
    expect(persisted.gateResults).toMatchObject([{
      id: "gate-pg-1",
      candidateHash: hash("candidate-pg-next-artifact"),
      candidateBindingId: "trust-producer",
      candidateBindingVersion: 1,
      evaluatorBindingId: "trust-evaluator",
      evaluatorBindingVersion: 1,
      evaluationArtifactHash: hash("gate-pg-artifact"),
      metricsHash: hash({ quality: 0.96 }),
    }]);
    expect(persisted.canarySuccessOutcomes).toMatchObject([{
      id: success.record.id,
      candidateHash: hash("candidate-pg-next-artifact"),
      gateResultIds: ["gate-pg-1"],
      metricsHash: hash({ quality: 0.96 }),
    }]);
    expect(persisted.promotionDecisions).toMatchObject([{
      id: promotion.record.id,
      canarySuccessOutcomeId: success.record.id,
      candidateHash: hash("candidate-pg-next-artifact"),
      decisionBindingId: "trust-evaluator",
      decisionBindingVersion: 1,
    }]);

    expect(await requireLayer().db.select({ id: roomEvolutionTrustedBindings.id }).from(roomEvolutionTrustedBindings))
      .toEqual([{ id: "trust-producer" }, { id: "trust-evaluator" }]);
    expect(await requireLayer().db.select({ id: roomEvolutionCanarySuccessOutcomes.id }).from(roomEvolutionCanarySuccessOutcomes))
      .toEqual([{ id: success.record.id }]);
    expect(await requireLayer().db.select({ id: roomEvolutionPromotionDecisions.id }).from(roomEvolutionPromotionDecisions))
      .toEqual([{ id: promotion.record.id }]);

    await expect(value.appendCanarySuccessOutcome({
      ...canarySuccess(),
      id: "canary-success-pg-conflict",
    })).rejects.toMatchObject({ code: "immutable_conflict" });
  });
});

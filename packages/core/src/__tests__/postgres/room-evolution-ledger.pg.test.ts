import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AsyncRoomEvolutionLedger,
  type AppendRoomEvolutionBenchmarkCaseInputV1,
  type AppendRoomEvolutionBenchmarkResultInputV1,
  type AppendRoomEvolutionCanaryInputV1,
  type AppendRoomEvolutionCanaryObservationInputV1,
  type AppendRoomEvolutionCandidateVersionInputV1,
  type AppendRoomEvolutionExperimentInputV1,
  type AppendRoomEvolutionGateResultInputV1,
  type AppendRoomEvolutionHypothesisInputV1,
  type AppendRoomEvolutionPromotionDecisionInputV1,
  type AppendRoomEvolutionRollbackInputV1,
  type AppendRoomEvolutionTrustedBindingInputV1,
  type AppendVerifiedRoomEvolutionCandidateVersionInputV1,
  type AppendVerifiedRoomEvolutionGateResultInputV1,
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
  roomEvolutionBenchmarkCases,
  roomEvolutionBenchmarkResults,
  roomEvolutionCanaries,
  roomEvolutionCanaryObservations,
  roomEvolutionCandidateVersions,
  roomEvolutionExperiments,
  roomEvolutionGateResults,
  roomEvolutionHypotheses,
  roomEvolutionPromotionDecisions,
  roomEvolutionRollbacks,
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

const PROJECT_ID = "project-evolution-ledger-pg";
const ROOM_ID = "room-evolution-ledger-pg";
const CREATED_AT = "2026-07-19T12:00:00.000Z";
const GATE_COMPLETED_AT = "2026-07-19T12:00:01.000Z";
const CANARY_CREATED_AT = "2026-07-19T12:00:02.000Z";
const CANARY_OBSERVED_AT = "2026-07-19T12:00:03.000Z";
const PROMOTION_DECIDED_AT = "2026-07-19T12:00:04.000Z";
const ROLLBACK_EXECUTED_AT = "2026-07-19T12:00:05.000Z";
const EXPIRES_AT = "2026-07-20T12:00:00.000Z";
const SCOPE = {
  projectId: PROJECT_ID,
  roomId: ROOM_ID,
  scopeKind: "room",
  scopeKey: "room:room-evolution-ledger-pg",
} as const satisfies RoomEvolutionLedgerScope;
const hash = (value: unknown): string => hashRoomValue(value);
const evidence = (id: string) => ({
  id,
  source: "durable_room_ledger" as const,
  sourceRef: "source:" + id,
  evidenceHash: hash({ id }),
  observedAt: CREATED_AT,
});

let sharedContext: EmbeddedTestContext | null = null;
let sharedLayer: AsyncDataLayer | null = null;

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-evolution-ledger-"));
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
  if (!sharedLayer) throw new Error("Room evolution-ledger PostgreSQL fixture was not started");
  return sharedLayer;
}

function createLedger(): AsyncRoomEvolutionLedger {
  return new AsyncRoomEvolutionLedger(new AsyncRoomEvolutionLedgerPostgresPersistence(requireLayer()));
}

async function createRoom(): Promise<void> {
  await requireLayer().db.insert(operationalRooms).values({
    id: ROOM_ID,
    projectId: PROJECT_ID,
    objective: "Persist a bounded controlled-evolution graph",
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

function hypothesisInput(): AppendRoomEvolutionHypothesisInputV1 {
  return {
    scope: SCOPE,
    id: "hypothesis-evolution-pg-1",
    revision: 1,
    state: "proposed",
    sourceSignalKinds: ["failure", "quality"],
    evidence: [evidence("hypothesis-evolution-pg-evidence")],
    evidenceHash: hash("hypothesis-evolution-pg"),
    declaredScope: ["task_decomposition"],
    riskClass: "moderate",
    expectedMechanism: "A bounded policy can reduce retries while preserving independent quality checks.",
    affectedDomains: ["orchestration"],
    createdByActorId: "evolution-controller",
    createdAt: CREATED_AT,
  };
}

function baselineCandidateInput(): AppendRoomEvolutionCandidateVersionInputV1 {
  return {
    scope: SCOPE,
    id: "candidate-evolution-pg-baseline",
    hypothesisId: "hypothesis-evolution-pg-1",
    versionNumber: 1,
    candidateKind: "source_code",
    baseRevision: "main@0000000",
    candidateRef: "baseline@0000001",
    isolationKind: "worktree",
    isolationRef: "worktree-evolution-pg-baseline",
    immutableInput: { task: "baseline" },
    inputHash: hash("candidate-evolution-pg-baseline"),
    producedByActorId: "worker-candidate",
    baseCandidateVersionId: null,
    rollbackTargetCandidateVersionId: null,
    createdAt: CREATED_AT,
  };
}

function candidateInput(): AppendRoomEvolutionCandidateVersionInputV1 {
  return {
    scope: SCOPE,
    id: "candidate-evolution-pg-2",
    hypothesisId: "hypothesis-evolution-pg-1",
    versionNumber: 2,
    candidateKind: "source_code",
    baseRevision: "baseline@0000001",
    candidateRef: "candidate@0000002",
    isolationKind: "worktree",
    isolationRef: "worktree-evolution-pg-candidate",
    immutableInput: { task: "candidate" },
    inputHash: hash("candidate-evolution-pg-2"),
    producedByActorId: "worker-candidate",
    baseCandidateVersionId: "candidate-evolution-pg-baseline",
    rollbackTargetCandidateVersionId: "candidate-evolution-pg-baseline",
    createdAt: CREATED_AT,
  };
}

function experimentInput(): AppendRoomEvolutionExperimentInputV1 {
  return {
    scope: SCOPE,
    id: "experiment-evolution-pg-1",
    hypothesisId: "hypothesis-evolution-pg-1",
    candidateVersionId: "candidate-evolution-pg-2",
    state: "planned",
    inputSnapshotHash: hash("experiment-evolution-pg-input"),
    authorizationEvidence: { policy: "evolution-low-priority" },
    authorizationHash: hash("experiment-evolution-pg-authorization"),
    capacityPool: "evolution_low_priority",
    createdByActorId: "evolution-controller",
    createdAt: CREATED_AT,
  };
}

function benchmarkCaseInput(): AppendRoomEvolutionBenchmarkCaseInputV1 {
  return {
    scope: SCOPE,
    id: "benchmark-case-evolution-pg-1",
    domain: "orchestration",
    caseKind: "golden",
    containsPrivateRoomData: false,
    sourceAuthorizationId: null,
    authorizationEvidence: {},
    casePayload: { task: "decompose" },
    expectedOutcome: { retryCount: 0 },
    contentHash: hash("benchmark-case-evolution-pg"),
    createdAt: CREATED_AT,
  };
}

function benchmarkResultInput(): AppendRoomEvolutionBenchmarkResultInputV1 {
  return {
    scope: SCOPE,
    id: "benchmark-result-evolution-pg-1",
    experimentId: "experiment-evolution-pg-1",
    candidateVersionId: "candidate-evolution-pg-2",
    benchmarkCaseId: "benchmark-case-evolution-pg-1",
    evaluatorActorId: "reviewer-benchmark",
    evaluatorKind: "independent_reviewer",
    outcome: "passed",
    metrics: { quality: 0.95 },
    evidence: [evidence("benchmark-result-evolution-pg-evidence")],
    evidenceHash: hash("benchmark-result-evolution-pg"),
    completedAt: GATE_COMPLETED_AT,
  };
}

function gateResultInput(): AppendRoomEvolutionGateResultInputV1 {
  return {
    scope: SCOPE,
    id: "gate-result-evolution-pg-1",
    experimentId: "experiment-evolution-pg-1",
    candidateVersionId: "candidate-evolution-pg-2",
    benchmarkResultId: "benchmark-result-evolution-pg-1",
    gateName: "quality-regression",
    gateClass: "hard",
    outcome: "passed",
    evaluatorActorId: "reviewer-gate",
    evaluatorKind: "independent_reviewer",
    candidateProducerActorId: "worker-candidate",
    metrics: { quality: 0.95 },
    evidence: [evidence("gate-result-evolution-pg-evidence")],
    evidenceHash: hash("gate-result-evolution-pg"),
    promotionEligible: true,
    completedAt: CREATED_AT,
  };
}

function canaryInput(): AppendRoomEvolutionCanaryInputV1 {
  return {
    scope: SCOPE,
    id: "canary-evolution-pg-1",
    experimentId: "experiment-evolution-pg-1",
    candidateVersionId: "candidate-evolution-pg-2",
    allocationVersion: 1,
    allocation: { ratio: 0.1 },
    successCriteria: { quality: { min: 0.9 }, hardGateResultIds: ["gate-result-evolution-pg-1"] },
    failureCriteria: { retryCount: { max: 1 } },
    state: "planned",
    rollbackTargetCandidateVersionId: "candidate-evolution-pg-baseline",
    createdAt: CANARY_CREATED_AT,
  };
}

function observationInput(): AppendRoomEvolutionCanaryObservationInputV1 {
  return {
    scope: SCOPE,
    id: "canary-observation-evolution-pg-1",
    canaryId: "canary-evolution-pg-1",
    metricName: "quality",
    metricValue: { value: 0.95 },
    threshold: { min: 0.9 },
    breached: false,
    evidence: [evidence("canary-observation-evolution-pg-evidence")],
    evidenceHash: hash("canary-observation-evolution-pg"),
    observedAt: CANARY_OBSERVED_AT,
  };
}

function promotionInput(): AppendRoomEvolutionPromotionDecisionInputV1 {
  return {
    scope: SCOPE,
    id: "promotion-evolution-pg-1",
    experimentId: "experiment-evolution-pg-1",
    candidateVersionId: "candidate-evolution-pg-2",
    canaryId: "canary-evolution-pg-1",
    decision: "rollback_required",
    riskClass: "moderate",
    authorityTier: "independent",
    candidateProducerActorId: "worker-candidate",
    decisionActorId: "reviewer-promotion",
    approvalRequestId: null,
    authorizationEvidence: { policy: "evolution-preauthorized" },
    evidence: [evidence("promotion-evolution-pg-evidence")],
    evidenceHash: hash("promotion-evolution-pg"),
    rollbackTargetCandidateVersionId: "candidate-evolution-pg-baseline",
    decidedAt: PROMOTION_DECIDED_AT,
  };
}

function rollbackInput(): AppendRoomEvolutionRollbackInputV1 {
  return {
    scope: SCOPE,
    id: "rollback-evolution-pg-1",
    promotionDecisionId: "promotion-evolution-pg-1",
    canaryId: "canary-evolution-pg-1",
    fromCandidateVersionId: "candidate-evolution-pg-2",
    toCandidateVersionId: "candidate-evolution-pg-baseline",
    triggerKind: "automatic",
    reason: "Canary breach requires a bounded rollback.",
    evidence: [evidence("rollback-evolution-pg-evidence")],
    evidenceHash: hash("rollback-evolution-pg"),
    executedAt: ROLLBACK_EXECUTED_AT,
  };
}

describe("AsyncRoomEvolutionLedgerPostgresPersistence", () => {
  it("writes the entire 0022 graph by INSERT only and database triggers reject mutation", async () => {
    await createRoom();
    const ledger = createLedger();

    await ledger.appendHypothesis(hypothesisInput());
    await ledger.appendTrustedBinding(trustedBinding(
      "trust-producer",
      "worker-candidate",
      "candidate_producer",
      "binding-producer",
      "producer",
    ));
    await ledger.appendTrustedBinding(trustedBinding(
      "trust-evaluator",
      "reviewer-gate",
      "independent_evaluator",
      "binding-evaluator",
      "evaluator",
    ));
    await ledger.appendVerifiedCandidateVersion({
      candidate: baselineCandidateInput(),
      candidateHash: hash("candidate-evolution-pg-baseline-artifact"),
      producerBindingId: "trust-producer",
      producerBindingVersion: 1,
    });
    await ledger.appendVerifiedCandidateVersion({
      candidate: candidateInput(),
      candidateHash: hash("candidate-evolution-pg-2-artifact"),
      producerBindingId: "trust-producer",
      producerBindingVersion: 1,
    });
    await ledger.appendExperiment(experimentInput());
    await ledger.appendBenchmarkCase(benchmarkCaseInput());
    await ledger.appendBenchmarkResult(benchmarkResultInput());
    await ledger.appendVerifiedGateResult({
      gate: gateResultInput(),
      candidateHash: hash("candidate-evolution-pg-2-artifact"),
      candidateBindingId: "trust-producer",
      candidateBindingVersion: 1,
      evaluatorBindingId: "trust-evaluator",
      evaluatorBindingVersion: 1,
      evaluationArtifactHash: hash("gate-result-evolution-pg-artifact"),
    });
    await ledger.appendCanary(canaryInput());
    await ledger.appendCanaryObservation(observationInput());
    await ledger.appendPromotionDecision(promotionInput());
    await ledger.appendRollback(rollbackInput());

    expect(await requireLayer().db.select({ id: roomEvolutionHypotheses.id }).from(roomEvolutionHypotheses))
      .toEqual([{ id: "hypothesis-evolution-pg-1" }]);
    expect(await requireLayer().db.select({ id: roomEvolutionCandidateVersions.id }).from(roomEvolutionCandidateVersions))
      .toEqual([{ id: "candidate-evolution-pg-baseline" }, { id: "candidate-evolution-pg-2" }]);
    expect(await requireLayer().db.select({ id: roomEvolutionTrustedBindings.id }).from(roomEvolutionTrustedBindings))
      .toEqual([{ id: "trust-producer" }, { id: "trust-evaluator" }]);
    expect(await requireLayer().db.select({ id: roomEvolutionExperiments.id }).from(roomEvolutionExperiments))
      .toEqual([{ id: "experiment-evolution-pg-1" }]);
    expect(await requireLayer().db.select({ id: roomEvolutionBenchmarkCases.id }).from(roomEvolutionBenchmarkCases))
      .toEqual([{ id: "benchmark-case-evolution-pg-1" }]);
    expect(await requireLayer().db.select({ id: roomEvolutionBenchmarkResults.id }).from(roomEvolutionBenchmarkResults))
      .toEqual([{ id: "benchmark-result-evolution-pg-1" }]);
    expect(await requireLayer().db.select({ id: roomEvolutionGateResults.id }).from(roomEvolutionGateResults))
      .toEqual([{ id: "gate-result-evolution-pg-1" }]);
    expect(await requireLayer().db.select({ id: roomEvolutionCanaries.id }).from(roomEvolutionCanaries))
      .toEqual([{ id: "canary-evolution-pg-1" }]);
    expect(await requireLayer().db.select({ id: roomEvolutionCanaryObservations.id }).from(roomEvolutionCanaryObservations))
      .toEqual([{ id: "canary-observation-evolution-pg-1" }]);
    expect(await requireLayer().db.select({ id: roomEvolutionPromotionDecisions.id }).from(roomEvolutionPromotionDecisions))
      .toEqual([{ id: "promotion-evolution-pg-1" }]);
    expect(await requireLayer().db.select({ id: roomEvolutionRollbacks.id }).from(roomEvolutionRollbacks))
      .toEqual([{ id: "rollback-evolution-pg-1" }]);

    await expect(ledger.appendHypothesis(hypothesisInput())).rejects.toMatchObject({ code: "immutable_conflict" });
    let mutationError: unknown = null;
    try {
      await requireLayer().db
        .update(roomEvolutionHypotheses)
        .set({ state: "promoted" })
        .where(eq(roomEvolutionHypotheses.id, "hypothesis-evolution-pg-1"));
    } catch (error) {
      mutationError = error;
    }
    expect(mutationError).toBeTruthy();
    expect((mutationError as { readonly cause?: { readonly message?: string } }).cause?.message)
      .toMatch(/append-only/i);
  });
});

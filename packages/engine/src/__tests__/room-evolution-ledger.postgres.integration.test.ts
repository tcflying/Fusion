import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AsyncRoomEvolutionLedger,
  AsyncRoomEvolutionLedgerPostgresPersistence,
  applySchemaBaseline,
  createAsyncDataLayer,
  createConnectionSetFromUrl,
  evaluateRoomEvolutionPromotion,
  hashRoomValue,
  type EvaluateRoomEvolutionPromotionInputV1,
  type RoomEvolutionLedgerScope,
} from "@fusion/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EmbeddedPostgresLifecycle } from "../../../core/src/postgres/embedded-lifecycle.js";
import {
  operationalRooms,
  roomEvolutionPromotionDecisions,
} from "../../../core/src/postgres/schema/room.js";
import {
  RoomEvolutionPromotionLedgerAdapter,
  type RoomEvolutionPromotionContextSnapshotV1,
} from "../room-evolution-promotion-ledger-adapter.js";
import type { AppendRoomEvolutionPromotionDecisionInputV1 as EnginePromotionDecisionInput } from "../room-evolution-promotion-commit-coordinator.js";

/*
FNXC:RoomEvolutionPostgresIntegration 2026-07-19-15:25:
Task 10.5 requires the Engine promotion adapter to prove its independently
evaluated, lineage-bound decision reaches only the canonical PostgreSQL ledger.
Self-acceptance and context drift must fail before an immutable decision row exists.
*/
const PROJECT_ID = "project-engine-evolution-pg";
const ROOM_ID = "room-engine-evolution-pg";
const HYPOTHESIS_ID = "hypothesis-engine-evolution-pg";
const BASELINE_CANDIDATE_ID = "candidate-engine-evolution-baseline";
const CANDIDATE_ID = "candidate-engine-evolution-candidate";
const EXPERIMENT_ID = "experiment-engine-evolution-pg";
const CANARY_ID = "canary-engine-evolution-pg";
const PROPOSAL_ID = "proposal-engine-evolution-pg";
const PRODUCER_ACTOR_ID = "worker-engine-evolution-producer";
const ARBITER_ACTOR_ID = "worker-engine-evolution-arbiter";
const EVALUATED_AT = "2026-07-19T15:25:00.000Z";
const CANDIDATE_HASH = hashRoomValue({ candidate: CANDIDATE_ID, revision: 2 });
const SCOPE = {
  projectId: PROJECT_ID,
  roomId: ROOM_ID,
  scopeKind: "room",
  scopeKey: `room:${ROOM_ID}`,
} as const satisfies RoomEvolutionLedgerScope;

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: Awaited<ReturnType<typeof createConnectionSetFromUrl>> | null;
}

let sharedContext: EmbeddedTestContext | null = null;
let sharedLayer: ReturnType<typeof createAsyncDataLayer> | null = null;

function evidence(id: string) {
  return {
    id,
    source: "durable_room_ledger" as const,
    sourceRef: `source:${id}`,
    evidenceHash: hashRoomValue({ id }),
    observedAt: EVALUATED_AT,
  };
}

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-engine-evolution-pg-"));
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

afterAll(async () => {
  const context = sharedContext;
  sharedContext = null;
  sharedLayer = null;
  if (!context) return;
  await context.connections?.close();
  context.connections = null;
  await context.lifecycle.stop();
  rmSync(context.dataDir, { recursive: true, force: true });
});

function requireLayer(): ReturnType<typeof createAsyncDataLayer> {
  if (!sharedLayer) throw new Error("Engine evolution PostgreSQL fixture was not started");
  return sharedLayer;
}

function createLedger(): AsyncRoomEvolutionLedger {
  return new AsyncRoomEvolutionLedger(new AsyncRoomEvolutionLedgerPostgresPersistence(requireLayer()));
}

async function seedPromotionLineage(): Promise<AsyncRoomEvolutionLedger> {
  const layer = requireLayer();
  await layer.db.insert(operationalRooms).values({
    id: ROOM_ID,
    projectId: PROJECT_ID,
    objective: "Persist an independently evaluated Engine promotion decision",
    protocolId: "implementation",
    protocolVersion: 1,
    protocolPhaseId: null,
    lifecycleState: "ready",
    aggregateVersion: 0,
    taskGraphVersion: 0,
    membershipVersion: 0,
    activeTurnId: null,
    completionContract: {},
    createdAt: EVALUATED_AT,
    updatedAt: EVALUATED_AT,
  });

  const ledger = createLedger();
  await ledger.appendHypothesis({
    scope: SCOPE,
    id: HYPOTHESIS_ID,
    revision: 1,
    state: "proposed",
    sourceSignalKinds: ["failure", "quality"],
    evidence: [evidence("hypothesis-engine-evolution")],
    evidenceHash: hashRoomValue(HYPOTHESIS_ID),
    declaredScope: ["task_decomposition"],
    riskClass: "moderate",
    expectedMechanism: "A bounded policy improves task decomposition without weakening independent review.",
    affectedDomains: ["orchestration"],
    createdByActorId: "evolution-controller-engine-pg",
    createdAt: EVALUATED_AT,
  });
  await ledger.appendCandidateVersion({
    scope: SCOPE,
    id: BASELINE_CANDIDATE_ID,
    hypothesisId: HYPOTHESIS_ID,
    versionNumber: 1,
    candidateKind: "source_code",
    baseRevision: "main@0000000",
    candidateRef: "baseline@0000001",
    isolationKind: "worktree",
    isolationRef: "worktree-engine-evolution-baseline",
    immutableInput: { role: "baseline" },
    inputHash: hashRoomValue(BASELINE_CANDIDATE_ID),
    producedByActorId: "worker-engine-evolution-baseline",
    baseCandidateVersionId: null,
    rollbackTargetCandidateVersionId: null,
    createdAt: EVALUATED_AT,
  });
  await ledger.appendCandidateVersion({
    scope: SCOPE,
    id: CANDIDATE_ID,
    hypothesisId: HYPOTHESIS_ID,
    versionNumber: 2,
    candidateKind: "source_code",
    baseRevision: "baseline@0000001",
    candidateRef: "candidate@0000002",
    isolationKind: "worktree",
    isolationRef: "worktree-engine-evolution-candidate",
    immutableInput: { candidateHash: CANDIDATE_HASH },
    inputHash: CANDIDATE_HASH,
    producedByActorId: PRODUCER_ACTOR_ID,
    baseCandidateVersionId: BASELINE_CANDIDATE_ID,
    rollbackTargetCandidateVersionId: BASELINE_CANDIDATE_ID,
    createdAt: EVALUATED_AT,
  });
  await ledger.appendExperiment({
    scope: SCOPE,
    id: EXPERIMENT_ID,
    hypothesisId: HYPOTHESIS_ID,
    candidateVersionId: CANDIDATE_ID,
    state: "planned",
    inputSnapshotHash: hashRoomValue({ experiment: EXPERIMENT_ID }),
    authorizationEvidence: { policy: "evolution-low-priority" },
    authorizationHash: hashRoomValue({ authorization: EXPERIMENT_ID }),
    capacityPool: "evolution_low_priority",
    createdByActorId: "evolution-controller-engine-pg",
    createdAt: EVALUATED_AT,
  });
  await ledger.appendCanary({
    scope: SCOPE,
    id: CANARY_ID,
    experimentId: EXPERIMENT_ID,
    candidateVersionId: CANDIDATE_ID,
    allocationVersion: 1,
    allocation: { ratio: 0.1 },
    successCriteria: { quality: { min: 0.9 } },
    failureCriteria: { correctionRate: { max: 0.05 } },
    state: "planned",
    rollbackTargetCandidateVersionId: BASELINE_CANDIDATE_ID,
    createdAt: EVALUATED_AT,
  });
  await ledger.appendCanaryObservation({
    scope: SCOPE,
    id: "canary-observation-engine-evolution-pg",
    canaryId: CANARY_ID,
    metricName: "quality",
    metricValue: { value: 0.97 },
    threshold: { min: 0.9 },
    breached: false,
    evidence: [evidence("canary-observation-engine-evolution")],
    evidenceHash: hashRoomValue({ canary: CANARY_ID, metric: "quality" }),
    observedAt: EVALUATED_AT,
  });
  return ledger;
}

function promotionEvaluation(): EvaluateRoomEvolutionPromotionInputV1 {
  return {
    contractVersion: 1,
    proposal: {
      id: PROPOSAL_ID,
      candidateHash: CANDIDATE_HASH,
      proposerBindingIds: ["binding-engine-evolution-producer"],
      requestedAt: EVALUATED_AT,
    },
    requiredHardGateIds: ["gate-correctness", "gate-security"],
    hardGateResults: [
      {
        gateId: "gate-correctness",
        status: "passed",
        evaluatorBindingIds: ["binding-engine-evolution-reviewer"],
        evidenceHash: hashRoomValue("gate-correctness-engine-evolution"),
      },
      {
        gateId: "gate-security",
        status: "passed",
        evaluatorBindingIds: ["binding-engine-evolution-reviewer"],
        evidenceHash: hashRoomValue("gate-security-engine-evolution"),
      },
    ],
    risks: [],
    canary: {
      source: "durable_room_evolution_canary_ledger",
      canaryId: CANARY_ID,
      candidateHash: CANDIDATE_HASH,
      completedAt: EVALUATED_AT,
      sampleCount: 100,
      minimumSampleCount: 10,
      qualityScore: 0.97,
      minimumQualityScore: 0.9,
      metrics: [{ id: "quality", baseline: 0.96, canary: 0.97, maxDegradation: 0.02 }],
      evaluatorBindingIds: ["binding-engine-evolution-reviewer"],
    },
    evaluatedAt: EVALUATED_AT,
  };
}

function promotionContext(
  overrides: Partial<RoomEvolutionPromotionContextSnapshotV1> = {},
): RoomEvolutionPromotionContextSnapshotV1 {
  return {
    contractVersion: 1,
    scope: SCOPE,
    proposalId: PROPOSAL_ID,
    candidateHash: CANDIDATE_HASH,
    experimentId: EXPERIMENT_ID,
    candidateVersionId: CANDIDATE_ID,
    canaryId: CANARY_ID,
    rollbackTargetCandidateVersionId: BASELINE_CANDIDATE_ID,
    riskClass: "moderate",
    changeSurfaces: ["policy"],
    autoPromotionPreAuthorized: false,
    hardGates: [
      { gateClass: "correctness", outcome: "passed", evaluatorActorId: "gate-engine" },
      { gateClass: "security", outcome: "passed", evaluatorActorId: "security-reviewer" },
      { gateClass: "user_constraints", outcome: "passed", evaluatorActorId: "constraint-engine" },
      { gateClass: "evidence_integrity", outcome: "passed", evaluatorActorId: "evidence-reviewer" },
      { gateClass: "regression", outcome: "passed", evaluatorActorId: "test-runner" },
    ],
    authorityTier: "independent",
    candidateProducerActorId: PRODUCER_ACTOR_ID,
    decisionActorId: ARBITER_ACTOR_ID,
    approvalRequestId: null,
    authorizationEvidence: { policy: "pre-authorized-moderate-policy" },
    evidence: [evidence("promotion-engine-evolution")],
    ...overrides,
  };
}

function promotionInput(
  decisionId: string,
  evaluation: EvaluateRoomEvolutionPromotionInputV1 = promotionEvaluation(),
): EnginePromotionDecisionInput {
  const evaluated = evaluateRoomEvolutionPromotion(evaluation);
  const outcome = evaluated.requiredRuntimeAction === "promote_candidate"
    ? "promoted"
    : evaluated.requiredRuntimeAction === "rollback_candidate"
      ? "rolled_back"
      : evaluated.evaluationPath === "hard_gate_blocked"
        ? "rejected"
        : "inconclusive";
  return {
    command: {
      commandId: `command:${decisionId}`,
      idempotencyKey: `idempotency:${decisionId}`,
      correlationId: `correlation:${decisionId}`,
      causationId: null,
    },
    decision: {
      contractVersion: 1,
      id: decisionId,
      proposalId: evaluation.proposal.id,
      candidateHash: evaluation.proposal.candidateHash,
      outcome,
      runtimeAction: evaluated.requiredRuntimeAction,
      evaluationPath: evaluated.evaluationPath,
      blockers: evaluated.blockers,
      evaluatedAt: evaluation.evaluatedAt,
    },
    evaluation,
  };
}

function createAdapter(
  ledger: AsyncRoomEvolutionLedger,
  overrides: Partial<RoomEvolutionPromotionContextSnapshotV1> = {},
): RoomEvolutionPromotionLedgerAdapter {
  return new RoomEvolutionPromotionLedgerAdapter({
    contextReader: { readPromotionContext: async () => promotionContext(overrides) },
    ledger,
  });
}

describe("Room evolution promotion adapter with real PostgreSQL", () => {
  it("persists an independently evaluated promotion through the Engine adapter and reads the immutable decision back", async () => {
    const ledger = await seedPromotionLineage();
    const appended = await createAdapter(ledger).appendDecision(promotionInput("promotion-engine-evolution-pg"));

    expect(appended).toEqual({
      recordId: "promotion-engine-evolution-pg",
      decisionId: "promotion-engine-evolution-pg",
      replayed: false,
    });
    const persisted = await requireLayer().db
      .select()
      .from(roomEvolutionPromotionDecisions);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      id: "promotion-engine-evolution-pg",
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      scopeKind: "room",
      scopeKey: SCOPE.scopeKey,
      experimentId: EXPERIMENT_ID,
      candidateVersionId: CANDIDATE_ID,
      canaryId: CANARY_ID,
      decision: "promoted",
      candidateProducerActorId: PRODUCER_ACTOR_ID,
      decisionActorId: ARBITER_ACTOR_ID,
      rollbackTargetCandidateVersionId: BASELINE_CANDIDATE_ID,
      decidedAt: EVALUATED_AT,
    });
    expect(persisted[0]?.evidenceHash).toBe(hashRoomValue({
      id: "promotion-engine-evolution-pg",
      scope: SCOPE,
      evidence: promotionContext().evidence,
    }));

    const selfAccepting = createAdapter(ledger, { decisionActorId: PRODUCER_ACTOR_ID });
    await expect(selfAccepting.appendDecision(promotionInput("promotion-engine-evolution-self")))
      .rejects.toMatchObject({ code: "self_acceptance_forbidden" });

    const contextMismatched = createAdapter(ledger, {
      candidateHash: hashRoomValue("engine-evolution-context-drift"),
    });
    await expect(contextMismatched.appendDecision(promotionInput("promotion-engine-evolution-mismatch")))
      .rejects.toMatchObject({ code: "context_snapshot_invalid" });

    const decisionsAfterRejectedWrites = await requireLayer().db
      .select({ id: roomEvolutionPromotionDecisions.id })
      .from(roomEvolutionPromotionDecisions);
    expect(decisionsAfterRejectedWrites).toEqual([{ id: "promotion-engine-evolution-pg" }]);
  });
});

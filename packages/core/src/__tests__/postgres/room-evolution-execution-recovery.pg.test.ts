import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AsyncRoomEvolutionExecutionStore,
  type CreateRoomEvolutionExecutionRunInputV1,
} from "../../room-evolution-execution-store.js";
import { AsyncRoomEvolutionExecutionPostgresPersistence } from "../../room-evolution-execution-postgres.js";
import { AsyncRoomEvolutionLedger } from "../../async-room-evolution-ledger.js";
import { AsyncRoomEvolutionLedgerPostgresPersistence } from "../../async-room-evolution-ledger-postgres.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import { roomEvolutionExecutionOutcomes, roomEvolutionExecutionRuns, roomEvolutionEffectOutbox } from "../../postgres/schema/room.js";
import { hashRoomValue } from "../../room-integrity.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const PROJECT_ID = "project-evolution-execution-pg";
const CREATED_AT = "2026-07-19T21:10:00.000Z";
const SCOPE = {
  projectId: PROJECT_ID,
  roomId: null,
  scopeKind: "project",
  scopeKey: `project:${PROJECT_ID}`,
} as const;

let sharedContext: EmbeddedTestContext | null = null;
let sharedLayer: AsyncDataLayer | null = null;

function executionStore(): AsyncRoomEvolutionExecutionStore {
  return new AsyncRoomEvolutionExecutionStore(
    new AsyncRoomEvolutionExecutionPostgresPersistence(requireLayer()),
  );
}

function executionInput(
  overrides: Partial<CreateRoomEvolutionExecutionRunInputV1> = {},
): CreateRoomEvolutionExecutionRunInputV1 {
  const request = { operation: "run-fixed-replay", shard: "one" };
  const effectPayload = { effect: "replay-case", caseId: "case-1" };
  return {
    scope: SCOPE,
    id: "execution-pg-1",
    idempotencyKey: "execution-request-pg-1",
    experimentId: "experiment-execution-pg-1",
    candidateVersionId: "candidate-execution-pg-1",
    request,
    requestHash: hashRoomValue(request),
    effects: [{
      id: "effect-pg-1",
      effectKey: "replay-case-1",
      effectKind: "replay_case",
      payload: effectPayload,
      payloadHash: hashRoomValue(effectPayload),
      maxAttempts: 2,
      availableAt: CREATED_AT,
    }],
    createdAt: CREATED_AT,
    ...overrides,
  };
}

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-evolution-execution-"));
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

function requireLayer(): AsyncDataLayer {
  if (!sharedLayer) throw new Error("Room evolution execution PostgreSQL fixture was not started");
  return sharedLayer;
}

async function seedExperiment(): Promise<void> {
  const ledger = new AsyncRoomEvolutionLedger(new AsyncRoomEvolutionLedgerPostgresPersistence(requireLayer()));
  const evidence = [{
    id: "evidence-execution-pg-1",
    source: "durable_room_ledger" as const,
    sourceRef: "ledger:execution-pg-1",
    evidenceHash: hashRoomValue("evidence-execution-pg-1"),
    observedAt: CREATED_AT,
  }];
  await ledger.appendHypothesis({
    scope: SCOPE,
    id: "hypothesis-execution-pg-1",
    revision: 1,
    state: "experimenting",
    sourceSignalKinds: ["failure"],
    evidence,
    evidenceHash: hashRoomValue(evidence),
    declaredScope: ["protocol"],
    riskClass: "moderate",
    expectedMechanism: "Persist effect claims before an Engine executes them.",
    affectedDomains: ["orchestration"],
    createdByActorId: "evolution-controller",
    createdAt: CREATED_AT,
  });
  await ledger.appendCandidateVersion({
    scope: SCOPE,
    id: "candidate-execution-pg-1",
    hypothesisId: "hypothesis-execution-pg-1",
    versionNumber: 1,
    candidateKind: "protocol",
    baseRevision: "strategy@base",
    candidateRef: "strategy@candidate",
    isolationKind: "versioned_policy_store",
    isolationRef: "policy-store-execution-pg",
    immutableInput: { protocol: "candidate" },
    inputHash: hashRoomValue({ protocol: "candidate" }),
    producedByActorId: "candidate-producer",
    baseCandidateVersionId: null,
    rollbackTargetCandidateVersionId: null,
    createdAt: CREATED_AT,
  });
  await ledger.appendExperiment({
    scope: SCOPE,
    id: "experiment-execution-pg-1",
    hypothesisId: "hypothesis-execution-pg-1",
    candidateVersionId: "candidate-execution-pg-1",
    state: "planned",
    inputSnapshotHash: hashRoomValue("execution-snapshot"),
    authorizationEvidence: { pool: "evolution_low_priority" },
    authorizationHash: hashRoomValue({ pool: "evolution_low_priority" }),
    capacityPool: "evolution_low_priority",
    createdByActorId: "evolution-controller",
    createdAt: CREATED_AT,
  });
}

beforeAll(async () => {
  sharedContext = await startEmbeddedDatabase();
  sharedLayer = createAsyncDataLayer(sharedContext.connections!, { projectId: PROJECT_ID });
}, 60_000);

beforeEach(async () => {
  await requireLayer().db.execute(sql.raw("TRUNCATE TABLE project.room_evolution_hypotheses RESTART IDENTITY CASCADE"));
  await seedExperiment();
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

describe("Room evolution execution/recovery PostgreSQL store", () => {
  it("persists idempotent execution effects, recovers an expired claim, and records only token-matched outcomes", async () => {
    const store = executionStore();
    const created = await store.createOrReadRun(executionInput());
    const replay = await store.createOrReadRun(executionInput({ id: "execution-pg-replay" }));

    expect(created).toMatchObject({ status: "created", run: { state: "pending" } });
    expect(replay).toMatchObject({ status: "idempotent", run: { id: "execution-pg-1" } });
    await expect(store.createOrReadRun(executionInput({
      request: { operation: "run-fixed-replay", shard: "different" },
      requestHash: hashRoomValue({ operation: "run-fixed-replay", shard: "different" }),
    }))).rejects.toMatchObject({ code: "idempotency_conflict" });

    const firstClaim = await store.claimNextEffect({
      scope: SCOPE,
      workerId: "worker-one",
      now: CREATED_AT,
      claimTtlMs: 1_000,
    });
    expect(firstClaim.claim).toMatchObject({ effect: { state: "claimed", attemptCount: 1 } });
    const firstToken = firstClaim.claim!.effect.claimToken!;

    await expect(store.recordEffectOutcome({
      scope: SCOPE,
      runId: "execution-pg-1",
      effectId: "effect-pg-1",
      claimToken: "stale-claim-token",
      outcome: "retryable_failure",
      outcomePayload: { retry: "connector pressure" },
      outcomeHash: hashRoomValue({ retry: "connector pressure" }),
      errorCode: "connector_pressure",
      retryAt: "2026-07-19T21:10:02.000Z",
      recordedAt: "2026-07-19T21:10:01.000Z",
    })).rejects.toMatchObject({ code: "claim_conflict" });

    const recovered = await store.claimNextEffect({
      scope: SCOPE,
      workerId: "worker-two",
      now: "2026-07-19T21:10:01.001Z",
      claimTtlMs: 1_000,
    });
    expect(recovered).toMatchObject({
      recoveredOutcome: { kind: "claim_expired", effectId: "effect-pg-1", attemptCount: 1 },
      claim: { effect: { state: "claimed", attemptCount: 2 } },
    });
    expect(recovered.claim!.effect.claimToken).not.toBe(firstToken);

    const successPayload = { result: "durably-recorded" };
    const completion = await store.recordEffectOutcome({
      scope: SCOPE,
      runId: "execution-pg-1",
      effectId: "effect-pg-1",
      claimToken: recovered.claim!.effect.claimToken!,
      outcome: "succeeded",
      outcomePayload: successPayload,
      outcomeHash: hashRoomValue(successPayload),
      errorCode: null,
      retryAt: null,
      recordedAt: "2026-07-19T21:10:01.500Z",
    });
    expect(completion).toMatchObject({
      run: { state: "succeeded", completedEffectCount: 1 },
      effect: { state: "succeeded", attemptCount: 2 },
      outcome: { kind: "succeeded", attemptCount: 2 },
    });
    expect(await store.claimNextEffect({
      scope: SCOPE,
      workerId: "worker-three",
      now: "2026-07-19T21:10:03.000Z",
    })).toEqual({ claim: null, recoveredOutcome: null });

    expect(await requireLayer().db.select({ id: roomEvolutionExecutionRuns.id }).from(roomEvolutionExecutionRuns))
      .toEqual([{ id: "execution-pg-1" }]);
    expect(await requireLayer().db.select({ id: roomEvolutionEffectOutbox.id }).from(roomEvolutionEffectOutbox))
      .toEqual([{ id: "effect-pg-1" }]);
    expect(await requireLayer().db.select({ kind: roomEvolutionExecutionOutcomes.kind }).from(roomEvolutionExecutionOutcomes))
      .toEqual([{ kind: "claim_expired" }, { kind: "succeeded" }]);
  });
});

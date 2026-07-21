import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import {
  readSchemaMigrationSql,
  SCHEMA_MIGRATIONS,
  SCHEMA_ROOM_EVOLUTION_TRUST_RECEIPTS_VERSION,
} from "../../postgres/schema-applier.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const PROJECT_ID = "project-evolution-trust-receipts-legacy";
const ROOM_ID = "room-evolution-trust-receipts-legacy";
const SCOPE_KEY = `room:${ROOM_ID}`;
const CREATED_AT = "2026-07-19T21:00:00.000Z";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const LEGACY_SCHEMA_VERSION = "0026";

let context: EmbeddedTestContext | null = null;

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-evolution-trust-receipts-legacy-"));
  const lifecycle = new EmbeddedPostgresLifecycle({
    dataDir,
    database: "fusion",
    user: "postgres",
    password: "password",
  });
  const backend = await lifecycle.start();
  return {
    dataDir,
    lifecycle,
    connections: await createConnectionSetFromUrl(backend, { poolMax: 2 }),
  };
}

function requireMigration(): PostgresConnections["migration"] {
  if (!context?.connections) throw new Error("legacy trust-receipts upgrade fixture was not started");
  return context.connections.migration;
}

async function materializeLegacySchema(): Promise<void> {
  const targetIndex = SCHEMA_MIGRATIONS.findIndex(
    (migration) => migration.version === LEGACY_SCHEMA_VERSION,
  );
  if (targetIndex < 0) throw new Error("0026 legacy Room schema migration is not registered");
  const migration = requireMigration();
  for (const schemaMigration of SCHEMA_MIGRATIONS.slice(0, targetIndex + 1)) {
    await migration.execute(sql.raw(await readSchemaMigrationSql(schemaMigration.version)));
  }
}

async function seedAppendOnlyLegacyHistory(): Promise<void> {
  await requireMigration().execute(sql.raw(`
    INSERT INTO project.operational_rooms (
      id, project_id, objective, protocol_id, protocol_version,
      lifecycle_state, created_at, updated_at
    ) VALUES (
      '${ROOM_ID}', '${PROJECT_ID}', 'Legacy trust-receipt upgrade fixture',
      'implementation', 1, 'ready', '${CREATED_AT}', '${CREATED_AT}'
    );

    INSERT INTO project.room_evolution_hypotheses (
      id, project_id, room_id, scope_kind, scope_key, revision, state,
      source_signal_kinds, evidence, evidence_hash, declared_scope, risk_class,
      expected_mechanism, affected_domains, created_by_actor_id, created_at
    ) VALUES (
      'hypothesis-legacy', '${PROJECT_ID}', '${ROOM_ID}', 'room', '${SCOPE_KEY}', 1, 'experimenting',
      '[]'::jsonb, '[]'::jsonb, '${HASH_A}', '[]'::jsonb, 'low',
      'Preserve historical provenance without inventing trust receipts.', '[]'::jsonb, 'legacy-producer', '${CREATED_AT}'
    );

    INSERT INTO project.room_evolution_candidate_versions (
      id, project_id, room_id, scope_kind, scope_key, hypothesis_id, version_number,
      candidate_kind, base_revision, candidate_ref, isolation_kind, isolation_ref,
      immutable_input, input_hash, produced_by_actor_id, base_candidate_version_id,
      rollback_target_candidate_version_id, created_at
    ) VALUES
      (
        'candidate-legacy-baseline', '${PROJECT_ID}', '${ROOM_ID}', 'room', '${SCOPE_KEY}', 'hypothesis-legacy', 1,
        'protocol', 'strategy@old', 'strategy@baseline', 'versioned_policy_store', 'policy-baseline',
        '{}'::jsonb, '${HASH_A}', 'legacy-producer', NULL, NULL, '${CREATED_AT}'
      ),
      (
        'candidate-legacy-next', '${PROJECT_ID}', '${ROOM_ID}', 'room', '${SCOPE_KEY}', 'hypothesis-legacy', 2,
        'protocol', 'strategy@baseline', 'strategy@next', 'versioned_policy_store', 'policy-next',
        '{}'::jsonb, '${HASH_B}', 'legacy-producer', 'candidate-legacy-baseline', 'candidate-legacy-baseline', '${CREATED_AT}'
      );

    INSERT INTO project.room_evolution_experiments (
      id, project_id, room_id, scope_kind, scope_key, hypothesis_id, candidate_version_id,
      state, input_snapshot_hash, authorization_evidence, authorization_hash, capacity_pool,
      created_by_actor_id, created_at
    ) VALUES (
      'experiment-legacy', '${PROJECT_ID}', '${ROOM_ID}', 'room', '${SCOPE_KEY}', 'hypothesis-legacy', 'candidate-legacy-next',
      'planned', '${HASH_A}', '{}'::jsonb, '${HASH_B}', 'evolution_low_priority', 'legacy-controller', '${CREATED_AT}'
    );

    INSERT INTO project.room_evolution_gate_results (
      id, project_id, room_id, scope_kind, scope_key, experiment_id, candidate_version_id,
      benchmark_result_id, gate_name, gate_class, outcome, evaluator_actor_id, evaluator_kind,
      candidate_producer_actor_id, metrics, evidence, evidence_hash, promotion_eligible, completed_at
    ) VALUES (
      'gate-legacy', '${PROJECT_ID}', '${ROOM_ID}', 'room', '${SCOPE_KEY}', 'experiment-legacy', 'candidate-legacy-next',
      NULL, 'legacy-hard-gate', 'hard', 'passed', 'legacy-evaluator', 'independent_reviewer',
      'legacy-producer', '{}'::jsonb, '[]'::jsonb, '${HASH_C}', true, '${CREATED_AT}'
    );

    INSERT INTO project.room_evolution_canaries (
      id, project_id, room_id, scope_kind, scope_key, experiment_id, candidate_version_id,
      allocation_version, allocation, success_criteria, failure_criteria, state,
      rollback_target_candidate_version_id, created_at
    ) VALUES (
      'canary-legacy', '${PROJECT_ID}', '${ROOM_ID}', 'room', '${SCOPE_KEY}', 'experiment-legacy', 'candidate-legacy-next',
      1, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'succeeded', 'candidate-legacy-baseline', '${CREATED_AT}'
    );

    INSERT INTO project.room_evolution_promotion_decisions (
      id, project_id, room_id, scope_kind, scope_key, experiment_id, candidate_version_id,
      canary_id, decision, risk_class, authority_tier, candidate_producer_actor_id,
      decision_actor_id, approval_request_id, authorization_evidence, evidence, evidence_hash,
      rollback_target_candidate_version_id, decided_at
    ) VALUES (
      'promotion-legacy', '${PROJECT_ID}', '${ROOM_ID}', 'room', '${SCOPE_KEY}', 'experiment-legacy', 'candidate-legacy-next',
      'canary-legacy', 'promoted', 'low', 'independent', 'legacy-producer',
      'legacy-evaluator', NULL, '{}'::jsonb, '[]'::jsonb, '${HASH_C}',
      'candidate-legacy-baseline', '${CREATED_AT}'
    );
  `));
}

beforeEach(async () => {
  context = await startEmbeddedDatabase();
}, 60_000);

afterEach(async () => {
  const current = context;
  context = null;
  if (!current) return;
  if (current.connections) {
    await current.connections.close();
    current.connections = null;
  }
  await current.lifecycle.stop();
  rmSync(current.dataDir, { recursive: true, force: true });
}, 60_000);

describe("Room evolution trust-receipts legacy upgrade", () => {
  it("keeps append-only 0026 history readable while enforcing trust receipts for 0027 writes", async () => {
    await materializeLegacySchema();
    await seedAppendOnlyLegacyHistory();
    const migration = requireMigration();

    await expect(migration.execute(sql.raw(
      await readSchemaMigrationSql(SCHEMA_ROOM_EVOLUTION_TRUST_RECEIPTS_VERSION),
    ))).resolves.toBeDefined();

    const constraints = (await migration.execute(sql.raw(`
      SELECT conname AS "name", convalidated AS "validated"
      FROM pg_constraint
      WHERE conname IN (
        'room_evolution_gate_results_verified_shape_check',
        'room_evolution_promotions_verified_shape_check'
      )
      ORDER BY conname
    `))) as unknown as Array<{ name: string; validated: boolean }>;
    expect(constraints).toEqual([
      { name: "room_evolution_gate_results_verified_shape_check", validated: false },
      { name: "room_evolution_promotions_verified_shape_check", validated: false },
    ]);

    const legacyGate = (await migration.execute(sql.raw(`
      SELECT promotion_eligible AS "promotionEligible", candidate_hash AS "candidateHash"
      FROM project.room_evolution_gate_results WHERE id = 'gate-legacy'
    `))) as unknown as Array<{ promotionEligible: boolean; candidateHash: string | null }>;
    expect(legacyGate).toEqual([{ promotionEligible: true, candidateHash: null }]);

    const legacyPromotion = (await migration.execute(sql.raw(`
      SELECT decision, canary_success_outcome_id AS "canarySuccessOutcomeId", candidate_hash AS "candidateHash"
      FROM project.room_evolution_promotion_decisions WHERE id = 'promotion-legacy'
    `))) as unknown as Array<{
      decision: string;
      canarySuccessOutcomeId: string | null;
      candidateHash: string | null;
    }>;
    expect(legacyPromotion).toEqual([{
      decision: "promoted",
      canarySuccessOutcomeId: null,
      candidateHash: null,
    }]);

    await expect(migration.execute(sql.raw(`
      UPDATE project.room_evolution_gate_results
      SET promotion_eligible = false
      WHERE id = 'gate-legacy'
    `))).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringMatching(/append-only/i) }),
    });

    await expect(migration.execute(sql.raw(`
      INSERT INTO project.room_evolution_gate_results (
        id, project_id, room_id, scope_kind, scope_key, experiment_id, candidate_version_id,
        benchmark_result_id, gate_name, gate_class, outcome, evaluator_actor_id, evaluator_kind,
        candidate_producer_actor_id, metrics, evidence, evidence_hash, promotion_eligible, completed_at
      ) VALUES (
        'gate-untrusted-new', '${PROJECT_ID}', '${ROOM_ID}', 'room', '${SCOPE_KEY}', 'experiment-legacy', 'candidate-legacy-next',
        NULL, 'untrusted-new-gate', 'hard', 'passed', 'new-evaluator', 'independent_reviewer',
        'legacy-producer', '{}'::jsonb, '[]'::jsonb, '${HASH_A}', true, '${CREATED_AT}'
      )
    `))).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(/room_evolution_gate_results_verified_shape_check|verified provenance/i),
      }),
    });

    await expect(migration.execute(sql.raw(`
      INSERT INTO project.room_evolution_promotion_decisions (
        id, project_id, room_id, scope_kind, scope_key, experiment_id, candidate_version_id,
        canary_id, decision, risk_class, authority_tier, candidate_producer_actor_id,
        decision_actor_id, approval_request_id, authorization_evidence, evidence, evidence_hash,
        rollback_target_candidate_version_id, decided_at
      ) VALUES (
        'promotion-untrusted-new', '${PROJECT_ID}', '${ROOM_ID}', 'room', '${SCOPE_KEY}', 'experiment-legacy', 'candidate-legacy-next',
        'canary-legacy', 'promoted', 'low', 'independent', 'legacy-producer',
        'new-evaluator', NULL, '{}'::jsonb, '[]'::jsonb, '${HASH_A}',
        'candidate-legacy-baseline', '${CREATED_AT}'
      )
    `))).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(/room_evolution_promotions_verified_shape_check|verified provenance/i),
      }),
    });
  });
});

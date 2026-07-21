import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import {
  applySchemaBaseline,
  getAppliedMigrations,
  MIGRATION_BOOKKEEPING_TABLE,
  readSchemaMigrationSql,
  SCHEMA_MIGRATIONS,
  SCHEMA_ROOM_EVOLUTION_LEGACY_PROVENANCE_BRIDGE_VERSION,
  SCHEMA_ROOM_EVOLUTION_LEGACY_PROVENANCE_GUARD_VERSION,
  SCHEMA_ROOM_EVENT_REPLAY_PAGING_VERSION,
  SCHEMA_ROOM_EVOLUTION_TRUST_RECEIPTS_VERSION,
} from "../../postgres/schema-applier.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const PROJECT_ID = "project-evolution-legacy-upgrade";
const ROOM_ID = "room-evolution-legacy-upgrade";
const SCOPE_KEY = `room:${ROOM_ID}`;
const CREATED_AT = "2026-07-19T21:00:00.000Z";
const EXPIRES_AT = "2026-07-20T21:00:00.000Z";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;

let context: EmbeddedTestContext | null = null;

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-evolution-legacy-upgrade-"));
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

function requireConnections(): PostgresConnections {
  if (!context?.connections) throw new Error("legacy evolution upgrade fixture was not started");
  return context.connections;
}

async function expectPgError(promise: Promise<unknown>, matcher: RegExp): Promise<void> {
  try {
    await promise;
    expect.fail(`Expected PostgreSQL rejection matching ${matcher}, but query succeeded`);
  } catch (error) {
    const postgresError = error as Error & { cause?: Error };
    expect(`${postgresError.message} ${postgresError.cause?.message ?? ""}`).toMatch(matcher);
  }
}

async function materializeHistoricalSchemaThrough0026(): Promise<void> {
  const migration = requireConnections().migration;
  const targetIndex = SCHEMA_MIGRATIONS.findIndex(
    (candidate) => candidate.version === SCHEMA_ROOM_EVENT_REPLAY_PAGING_VERSION,
  );
  if (targetIndex < 0) {
    throw new Error("0026 Room event replay migration is not registered");
  }

  await migration.execute(sql.raw(`
    CREATE TABLE public.${MIGRATION_BOOKKEEPING_TABLE} (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `));
  for (const schemaMigration of SCHEMA_MIGRATIONS.slice(0, targetIndex + 1)) {
    await migration.execute(sql.raw(await readSchemaMigrationSql(schemaMigration.version)));
    await migration.execute(
      sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${schemaMigration.version})`,
    );
  }
}

async function seedLegacyPromotionSignals(): Promise<void> {
  const migration = requireConnections().migration;
  await migration.execute(sql.raw(`
    INSERT INTO project.operational_rooms (
      id, project_id, objective, protocol_id, protocol_version,
      lifecycle_state, created_at, updated_at
    ) VALUES (
      '${ROOM_ID}', '${PROJECT_ID}', 'Legacy provenance migration fixture',
      'implementation', 1, 'ready', '${CREATED_AT}', '${CREATED_AT}'
    );

    INSERT INTO project.room_seats (
      id, project_id, room_id, role, role_version, state, created_at, updated_at
    ) VALUES
      ('seat-producer', '${PROJECT_ID}', '${ROOM_ID}', 'producer', 1, 'active', '${CREATED_AT}', '${CREATED_AT}'),
      ('seat-evaluator', '${PROJECT_ID}', '${ROOM_ID}', 'evaluator', 1, 'active', '${CREATED_AT}', '${CREATED_AT}');

    INSERT INTO project.room_bindings (
      id, project_id, room_id, seat_id, generation, connector_id, provider_id,
      native_session_id, host_id, state, attached_at
    ) VALUES
      ('binding-producer', '${PROJECT_ID}', '${ROOM_ID}', 'seat-producer', 1, 'connector-test', 'provider-test', 'native-producer', 'host-test', 'attached', '${CREATED_AT}'),
      ('binding-evaluator', '${PROJECT_ID}', '${ROOM_ID}', 'seat-evaluator', 1, 'connector-test', 'provider-test', 'native-evaluator', 'host-test', 'attached', '${CREATED_AT}');

    INSERT INTO project.room_rbac_grants (
      project_id, grant_id, principal_id, role, room_id, granted_at, revoked_at
    ) VALUES (
      '${PROJECT_ID}', 'grant-owner', 'owner-principal', 'owner', '${ROOM_ID}', '${CREATED_AT}', NULL
    );

    INSERT INTO project.room_evolution_hypotheses (
      id, project_id, room_id, scope_kind, scope_key, revision, state,
      source_signal_kinds, evidence, evidence_hash, declared_scope, risk_class,
      expected_mechanism, affected_domains, created_by_actor_id, created_at
    ) VALUES (
      'hypothesis-legacy', '${PROJECT_ID}', '${ROOM_ID}', 'room', '${SCOPE_KEY}', 1, 'experimenting',
      '[]'::jsonb, '[]'::jsonb, '${HASH_A}', '[]'::jsonb, 'low',
      'Keep old evidence auditable while fail-closing it.', '[]'::jsonb, 'legacy-producer', '${CREATED_AT}'
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

async function seedTrustedBindingsAfterUpgrade(): Promise<void> {
  const migration = requireConnections().migration;
  await migration.execute(sql.raw(`
    INSERT INTO project.room_evolution_trusted_bindings (
      id, project_id, room_id, scope_kind, scope_key, actor_id, purpose, subject_room_id,
      room_binding_id, room_binding_generation, role_id, role_version, binding_version,
      issued_by_principal_id, issuer_grant_id, issued_at, expires_at, integrity_hash
    ) VALUES
      (
        'trust-producer', '${PROJECT_ID}', '${ROOM_ID}', 'room', '${SCOPE_KEY}', 'producer-actor', 'candidate_producer', '${ROOM_ID}',
        'binding-producer', 1, 'producer', 1, 1, 'owner-principal', 'grant-owner', '${CREATED_AT}', '${EXPIRES_AT}', '${HASH_A}'
      ),
      (
        'trust-evaluator', '${PROJECT_ID}', '${ROOM_ID}', 'room', '${SCOPE_KEY}', 'evaluator-actor', 'independent_evaluator', '${ROOM_ID}',
        'binding-evaluator', 1, 'evaluator', 1, 1, 'owner-principal', 'grant-owner', '${CREATED_AT}', '${EXPIRES_AT}', '${HASH_B}'
      );
  `));
}

async function seedVerifiedGateAfterUpgrade(): Promise<void> {
  const migration = requireConnections().migration;
  await migration.execute(sql.raw(`
    INSERT INTO project.room_evolution_gate_results (
      id, project_id, room_id, scope_kind, scope_key, experiment_id, candidate_version_id,
      benchmark_result_id, gate_name, gate_class, outcome, evaluator_actor_id, evaluator_kind,
      candidate_producer_actor_id, candidate_hash, candidate_binding_id, candidate_binding_version,
      evaluator_binding_id, evaluator_binding_version, evaluation_artifact_hash, metrics, metrics_hash,
      evidence, evidence_hash, promotion_eligible, completed_at
    ) VALUES (
      'gate-strict-post-0027', '${PROJECT_ID}', '${ROOM_ID}', 'room', '${SCOPE_KEY}', 'experiment-legacy', 'candidate-legacy-next',
      NULL, 'strict-post-0027-gate', 'hard', 'passed', 'legacy-evaluator', 'independent_reviewer',
      'legacy-producer', '${HASH_A}', 'trust-producer', 1,
      'trust-evaluator', 1, '${HASH_B}', '{}'::jsonb, '${HASH_C}',
      '[]'::jsonb, '${HASH_A}', true, '${CREATED_AT}'
    )
  `));
}

async function prepareHistorical0027WithoutBridge(): Promise<void> {
  await materializeHistoricalSchemaThrough0026();
  await seedLegacyPromotionSignals();

  const migration = requireConnections().migration;
  await migration.execute(sql.raw(`
    DROP TRIGGER room_evolution_gate_results_append_only ON project.room_evolution_gate_results;
    DROP TRIGGER room_evolution_canaries_append_only ON project.room_evolution_canaries;
    DROP TRIGGER room_evolution_promotion_decisions_append_only ON project.room_evolution_promotion_decisions;

    UPDATE project.room_evolution_gate_results
    SET promotion_eligible = false
    WHERE promotion_eligible = true;
    UPDATE project.room_evolution_canaries
    SET state = 'paused'
    WHERE state = 'succeeded';
    UPDATE project.room_evolution_promotion_decisions
    SET decision = 'inconclusive'
    WHERE decision = 'promoted';

    CREATE TRIGGER room_evolution_gate_results_append_only
      BEFORE UPDATE OR DELETE ON project.room_evolution_gate_results
      FOR EACH ROW EXECUTE FUNCTION project.room_evolution_reject_history_mutation();
    CREATE TRIGGER room_evolution_canaries_append_only
      BEFORE UPDATE OR DELETE ON project.room_evolution_canaries
      FOR EACH ROW EXECUTE FUNCTION project.room_evolution_reject_history_mutation();
    CREATE TRIGGER room_evolution_promotion_decisions_append_only
      BEFORE UPDATE OR DELETE ON project.room_evolution_promotion_decisions
      FOR EACH ROW EXECUTE FUNCTION project.room_evolution_reject_history_mutation();
  `));
  await migration.execute(sql.raw(await readSchemaMigrationSql(SCHEMA_ROOM_EVOLUTION_TRUST_RECEIPTS_VERSION)));
  await migration.execute(
    sql`INSERT INTO public.${sql.identifier(MIGRATION_BOOKKEEPING_TABLE)} (version) VALUES (${SCHEMA_ROOM_EVOLUTION_TRUST_RECEIPTS_VERSION})`,
  );
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

describe("Room evolution legacy provenance upgrade", () => {
  it("quarantines 0026 eligible/promoted history before 0027 and rejects its later reuse", async () => {
    await materializeHistoricalSchemaThrough0026();
    await seedLegacyPromotionSignals();

    const applied = await applySchemaBaseline(requireConnections().migration, { pluginHooks: [] });

    expect(applied.appliedVersions).toEqual(expect.arrayContaining([
      SCHEMA_ROOM_EVOLUTION_LEGACY_PROVENANCE_BRIDGE_VERSION,
      SCHEMA_ROOM_EVOLUTION_TRUST_RECEIPTS_VERSION,
      SCHEMA_ROOM_EVOLUTION_LEGACY_PROVENANCE_GUARD_VERSION,
    ]));
    expect(await getAppliedMigrations(requireConnections().migration)).toEqual(
      expect.arrayContaining([
        "0026",
        SCHEMA_ROOM_EVOLUTION_LEGACY_PROVENANCE_BRIDGE_VERSION,
        SCHEMA_ROOM_EVOLUTION_TRUST_RECEIPTS_VERSION,
        SCHEMA_ROOM_EVOLUTION_LEGACY_PROVENANCE_GUARD_VERSION,
      ]),
    );

    const migration = requireConnections().migration;
    const legacyGate = (await migration.execute(sql.raw(`
      SELECT promotion_eligible AS "promotionEligible", candidate_hash AS "candidateHash"
      FROM project.room_evolution_gate_results WHERE id = 'gate-legacy'
    `))) as unknown as Array<{ promotionEligible: boolean; candidateHash: string | null }>;
    expect(legacyGate).toEqual([{ promotionEligible: false, candidateHash: null }]);

    const legacyPromotion = (await migration.execute(sql.raw(`
      SELECT decision, canary_success_outcome_id AS "canarySuccessOutcomeId", candidate_hash AS "candidateHash"
      FROM project.room_evolution_promotion_decisions WHERE id = 'promotion-legacy'
    `))) as unknown as Array<{
      decision: string;
      canarySuccessOutcomeId: string | null;
      candidateHash: string | null;
    }>;
    expect(legacyPromotion).toEqual([{
      decision: "inconclusive",
      canarySuccessOutcomeId: null,
      candidateHash: null,
    }]);

    const legacyCanary = (await migration.execute(sql.raw(`
      SELECT state
      FROM project.room_evolution_canaries WHERE id = 'canary-legacy'
    `))) as unknown as Array<{ state: string }>;
    expect(legacyCanary).toEqual([{ state: "paused" }]);

    const quarantined = (await migration.execute(sql.raw(`
      SELECT record_kind AS "recordKind", record_id AS "recordId",
        legacy_snapshot ->> 'promotion_eligible' AS "legacyPromotionEligible",
        legacy_snapshot ->> 'state' AS "legacyState",
        legacy_snapshot ->> 'decision' AS "legacyDecision"
      FROM project.room_evolution_legacy_provenance_quarantines
      WHERE project_id = '${PROJECT_ID}' AND scope_key = '${SCOPE_KEY}'
      ORDER BY record_kind
    `))) as unknown as Array<{
      recordKind: string;
      recordId: string;
      legacyPromotionEligible: string | null;
      legacyState: string | null;
      legacyDecision: string | null;
    }>;
    expect(quarantined).toEqual([
      {
        recordKind: "canary",
        recordId: "canary-legacy",
        legacyPromotionEligible: null,
        legacyState: "succeeded",
        legacyDecision: null,
      },
      {
        recordKind: "gate_result",
        recordId: "gate-legacy",
        legacyPromotionEligible: "true",
        legacyState: null,
        legacyDecision: null,
      },
      {
        recordKind: "promotion_decision",
        recordId: "promotion-legacy",
        legacyPromotionEligible: null,
        legacyState: null,
        legacyDecision: "promoted",
      },
    ]);

    await expectPgError(migration.execute(sql.raw(`
      UPDATE project.room_evolution_legacy_provenance_quarantines
      SET quarantine_reason = 'mutated'
      WHERE record_id = 'gate-legacy'
    `)), /append-only/i);
    await expect(migration.execute(sql.raw(`
      UPDATE project.room_evolution_gate_results
      SET promotion_eligible = true
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
        message: expect.stringMatching(/room_evolution_promotions_verified_shape_check|verified provenance|legacy provenance/i),
      }),
    });

    await seedTrustedBindingsAfterUpgrade();
    await expect(migration.execute(sql.raw(`
      INSERT INTO project.room_evolution_canary_success_outcomes (
        id, project_id, room_id, scope_kind, scope_key, canary_id, experiment_id,
        candidate_version_id, candidate_hash, candidate_binding_id, candidate_binding_version,
        evaluator_binding_id, evaluator_binding_version, gate_result_ids, allocation_hash,
        artifact_hash, metrics, metrics_hash, evidence, evidence_hash, completed_at
      ) VALUES (
        'canary-success-from-legacy-gate', '${PROJECT_ID}', '${ROOM_ID}', 'room', '${SCOPE_KEY}', 'canary-legacy', 'experiment-legacy',
        'candidate-legacy-next', '${HASH_A}', 'trust-producer', 1,
        'trust-evaluator', 1, '["gate-legacy"]'::jsonb, '${HASH_A}',
        '${HASH_B}', '{}'::jsonb, '${HASH_B}', '[]'::jsonb, '${HASH_C}', '${CREATED_AT}'
      )
    `))).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringMatching(/promotion-eligible verified gate|legacy provenance/i),
      }),
    });
  });

  it("adds only compatibility migrations to an existing 0027 database and preserves verified receipts", async () => {
    await prepareHistorical0027WithoutBridge();
    await seedTrustedBindingsAfterUpgrade();
    await seedVerifiedGateAfterUpgrade();

    const applied = await applySchemaBaseline(requireConnections().migration, { pluginHooks: [] });
    expect(applied.appliedVersions).toEqual(expect.arrayContaining([
      SCHEMA_ROOM_EVOLUTION_LEGACY_PROVENANCE_BRIDGE_VERSION,
      SCHEMA_ROOM_EVOLUTION_LEGACY_PROVENANCE_GUARD_VERSION,
    ]));
    expect(applied.appliedVersions).not.toContain(SCHEMA_ROOM_EVOLUTION_TRUST_RECEIPTS_VERSION);

    const migration = requireConnections().migration;
    const strictGate = (await migration.execute(sql.raw(`
      SELECT promotion_eligible AS "promotionEligible", candidate_hash AS "candidateHash"
      FROM project.room_evolution_gate_results WHERE id = 'gate-strict-post-0027'
    `))) as unknown as Array<{ promotionEligible: boolean; candidateHash: string | null }>;
    expect(strictGate).toEqual([{ promotionEligible: true, candidateHash: HASH_A }]);

    const untouchedCanary = (await migration.execute(sql.raw(`
      SELECT state FROM project.room_evolution_canaries WHERE id = 'canary-legacy'
    `))) as unknown as Array<{ state: string }>;
    expect(untouchedCanary).toEqual([{ state: "paused" }]);

    const quarantines = (await migration.execute(sql.raw(`
      SELECT record_id
      FROM project.room_evolution_legacy_provenance_quarantines
    `))) as unknown as Array<{ record_id: string }>;
    expect(quarantines).toEqual([]);

    const reapplied = await applySchemaBaseline(requireConnections().migration, { pluginHooks: [] });
    expect(reapplied.appliedVersions).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";

import {
  readSchemaMigrationSql,
  SCHEMA_MIGRATIONS,
  SCHEMA_ROOM_EVOLUTION_CONTROLLER_VERSION,
  SCHEMA_ROOM_EVOLUTION_LEGACY_PROVENANCE_BRIDGE_VERSION,
  SCHEMA_ROOM_EVOLUTION_LEGACY_PROVENANCE_GUARD_VERSION,
  SCHEMA_ROOM_EVOLUTION_TRUST_RECEIPTS_VERSION,
} from "../postgres/schema-applier.js";

describe("Room evolution schema migration registration", () => {
  it("registers the append-only controlled-evolution migration in the canonical baseline sequence", async () => {
    expect(SCHEMA_ROOM_EVOLUTION_CONTROLLER_VERSION).toBe("0022");
    expect(SCHEMA_MIGRATIONS).toContainEqual({
      version: "0022",
      filename: "0022_room_evolution_controller.sql",
    });

    await expect(readSchemaMigrationSql("0022")).resolves.toContain(
      "CREATE TABLE project.room_evolution_hypotheses",
    );
  });

  it("bridges legacy success signals before trust receipts and guards them afterward", async () => {
    expect(SCHEMA_ROOM_EVOLUTION_LEGACY_PROVENANCE_BRIDGE_VERSION).toBe("0026a");
    expect(SCHEMA_ROOM_EVOLUTION_TRUST_RECEIPTS_VERSION).toBe("0027");
    expect(SCHEMA_ROOM_EVOLUTION_LEGACY_PROVENANCE_GUARD_VERSION).toBe("0027a");
    const bridgeIndex = SCHEMA_MIGRATIONS.findIndex(
      (migration) => migration.version === SCHEMA_ROOM_EVOLUTION_LEGACY_PROVENANCE_BRIDGE_VERSION,
    );
    const trustReceiptIndex = SCHEMA_MIGRATIONS.findIndex(
      (migration) => migration.version === SCHEMA_ROOM_EVOLUTION_TRUST_RECEIPTS_VERSION,
    );
    const guardIndex = SCHEMA_MIGRATIONS.findIndex(
      (migration) => migration.version === SCHEMA_ROOM_EVOLUTION_LEGACY_PROVENANCE_GUARD_VERSION,
    );
    expect(bridgeIndex).toBeGreaterThanOrEqual(0);
    expect(trustReceiptIndex).toBeGreaterThan(bridgeIndex);
    expect(guardIndex).toBeGreaterThan(trustReceiptIndex);

    await expect(readSchemaMigrationSql("0026a")).resolves.toContain(
      "CREATE TABLE project.room_evolution_legacy_provenance_quarantines",
    );

    await expect(readSchemaMigrationSql("0027")).resolves.toContain(
      "CREATE TABLE project.room_evolution_trusted_bindings",
    );
    await expect(readSchemaMigrationSql("0027")).resolves.toContain(
      "CREATE TABLE project.room_evolution_canary_success_outcomes",
    );
    await expect(readSchemaMigrationSql("0027a")).resolves.toContain(
      "room_evolution_canary_success_outcomes_legacy_provenance_guard",
    );
  });
});

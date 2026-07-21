import { describe, expect, it } from "vitest";

import {
  readSchemaMigrationSql,
  SCHEMA_MIGRATIONS,
  SCHEMA_ROOM_EVOLUTION_EXECUTION_RECOVERY_VERSION,
  SCHEMA_ROOM_EVOLUTION_TRUST_RECEIPTS_VERSION,
} from "../postgres/schema-applier.js";

describe("Room evolution execution recovery schema migration", () => {
  it("registers 0028 immediately after trusted evolution receipts and creates only durable execution records", async () => {
    expect(SCHEMA_ROOM_EVOLUTION_TRUST_RECEIPTS_VERSION).toBe("0058");
    expect(SCHEMA_ROOM_EVOLUTION_EXECUTION_RECOVERY_VERSION).toBe("0060");
    expect(SCHEMA_MIGRATIONS.find((migration) => migration.version === SCHEMA_ROOM_EVOLUTION_EXECUTION_RECOVERY_VERSION)).toEqual({
      version: "0060",
      filename: "0028_room_evolution_execution_recovery.sql",
    });

    const migration = await readSchemaMigrationSql(SCHEMA_ROOM_EVOLUTION_EXECUTION_RECOVERY_VERSION);
    expect(migration).toContain("CREATE TABLE project.room_evolution_execution_runs");
    expect(migration).toContain("CREATE TABLE project.room_evolution_effect_outbox");
    expect(migration).toContain("CREATE TABLE project.room_evolution_execution_outcomes");
    expect(migration).not.toContain("provider send");
  });
});

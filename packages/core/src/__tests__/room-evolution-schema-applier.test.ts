import { describe, expect, it } from "vitest";

import {
  readSchemaMigrationSql,
  SCHEMA_MIGRATIONS,
  SCHEMA_ROOM_EVOLUTION_CONTROLLER_VERSION,
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

  it("registers trust bindings and successful-canary receipts only after the 0026 paging migration", async () => {
    expect(SCHEMA_ROOM_EVOLUTION_TRUST_RECEIPTS_VERSION).toBe("0027");
    expect(SCHEMA_MIGRATIONS.at(-1)).toEqual({
      version: "0027",
      filename: "0027_room_evolution_trust_receipts.sql",
    });

    await expect(readSchemaMigrationSql("0027")).resolves.toContain(
      "CREATE TABLE project.room_evolution_trusted_bindings",
    );
    await expect(readSchemaMigrationSql("0027")).resolves.toContain(
      "CREATE TABLE project.room_evolution_canary_success_outcomes",
    );
  });
});

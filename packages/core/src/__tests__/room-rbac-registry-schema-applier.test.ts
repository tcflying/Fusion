import { describe, expect, it } from "vitest";

import {
  readSchemaMigrationSql,
  SCHEMA_MIGRATIONS,
  SCHEMA_ROOM_PROVIDER_BACKPRESSURE_VERSION,
  SCHEMA_ROOM_RBAC_REGISTRY_VERSION,
} from "../postgres/schema-applier.js";

describe("Room RBAC registry schema migration", () => {
  it("registers the project-scoped trusted-device and role-grant migration after provider backpressure", async () => {
    expect(SCHEMA_ROOM_RBAC_REGISTRY_VERSION).toBe("0055");
    const rbacMigrationIndex = SCHEMA_MIGRATIONS.findIndex((migration) => migration.version === SCHEMA_ROOM_RBAC_REGISTRY_VERSION);
    const providerBackpressureMigrationIndex = SCHEMA_MIGRATIONS.findIndex((migration) => migration.version === SCHEMA_ROOM_PROVIDER_BACKPRESSURE_VERSION);
    expect(SCHEMA_MIGRATIONS[rbacMigrationIndex]).toEqual({
      version: "0055",
      filename: "0025_room_rbac_registry.sql",
    });
    expect(rbacMigrationIndex).toBe(providerBackpressureMigrationIndex + 1);

    await expect(readSchemaMigrationSql(SCHEMA_ROOM_RBAC_REGISTRY_VERSION)).resolves.toContain("CREATE TABLE project.room_trusted_device_sessions");
    await expect(readSchemaMigrationSql(SCHEMA_ROOM_RBAC_REGISTRY_VERSION)).resolves.toContain("credential_digest");
    await expect(readSchemaMigrationSql(SCHEMA_ROOM_RBAC_REGISTRY_VERSION)).resolves.toContain("CREATE TABLE project.room_rbac_grants");
  });
});

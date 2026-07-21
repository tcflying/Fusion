import { describe, expect, it } from "vitest";

import {
  readSchemaMigrationSql,
  SCHEMA_MIGRATIONS,
  SCHEMA_ROOM_EVENT_REPLAY_PAGING_VERSION,
} from "../postgres/schema-applier.js";

describe("Room event replay paging schema migration", () => {
  it("registers the canonical Room cursor index after the RBAC registry migration", async () => {
    expect(SCHEMA_ROOM_EVENT_REPLAY_PAGING_VERSION).toBe("0026");
    expect(SCHEMA_MIGRATIONS.at(-1)).toEqual({
      version: "0026",
      filename: "0026_room_event_replay_paging.sql",
    });
    await expect(readSchemaMigrationSql(SCHEMA_ROOM_EVENT_REPLAY_PAGING_VERSION)).resolves.toContain(
      "CREATE INDEX idx_room_events_project_room_cursor",
    );
  });
});

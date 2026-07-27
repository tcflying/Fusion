/*
 * FNXC:StaleBinaryGuard 2026-07-27-06:49:
 * FUS-P1-009 keeps pure CLI-dist/schema-generation assertions out of the high-churn PostgreSQL parity suite. These checks require no database and must retain precise operator-facing stale-build diagnostics.
 */
import { describe, expect, it } from "vitest";
import {
  SCHEMA_BASELINE_VERSION,
  assertBinaryNotOlderThanDatabase,
} from "../../postgres/index.js";

describe("schema-applier stale dist diagnostics", () => {
  it("names dist staleness and both schema generations in the operator error", () => {
    const future = String(Number(SCHEMA_BASELINE_VERSION) + 1).padStart(4, "0");

    expect(() => assertBinaryNotOlderThanDatabase([future])).toThrow(
      `Fusion dist stale: PostgreSQL schema ${future} is newer than this runtime's build-info schema ${SCHEMA_BASELINE_VERSION}.`,
    );
  });

  it("refuses a build-info schema that differs from the bundled runtime schema", () => {
    const previous = process.env.FUSION_CLI_DIST_SCHEMA_VERSION;
    process.env.FUSION_CLI_DIST_SCHEMA_VERSION = "0074";
    try {
      expect(() => assertBinaryNotOlderThanDatabase(["0074"])).toThrow(
        `Fusion dist stale: CLI dist build-info schema 0074 does not match bundled runtime schema ${SCHEMA_BASELINE_VERSION}.`,
      );
    } finally {
      if (previous === undefined) {
        delete process.env.FUSION_CLI_DIST_SCHEMA_VERSION;
      } else {
        process.env.FUSION_CLI_DIST_SCHEMA_VERSION = previous;
      }
    }
  });
});

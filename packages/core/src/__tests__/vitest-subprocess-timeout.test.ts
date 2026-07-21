import { describe, expect, it } from "vitest";

import { __fusionSubprocessTimeoutTestHooks } from "../__test-utils__/vitest-setup.js";

describe("Vitest subprocess timeout classification", () => {
  it("widens only embedded PostgreSQL commands", () => {
    const hooks = __fusionSubprocessTimeoutTestHooks;
    expect(hooks.testSubprocessTimeoutMs("git status --short")).toBe(hooks.defaultTimeoutMs);
    expect(hooks.testSubprocessTimeoutMs("node worker.js")).toBe(hooks.defaultTimeoutMs);
    expect(hooks.testSubprocessTimeoutMs("node C:\\tmp\\postgres")).toBe(hooks.defaultTimeoutMs);
    expect(hooks.testSubprocessTimeoutMs("git -C C:\\tmp\\postgres status")).toBe(
      hooks.defaultTimeoutMs,
    );
    expect(hooks.testSubprocessTimeoutMs("node C:\\tmp\\initdb.exe")).toBe(
      hooks.defaultTimeoutMs,
    );
    expect(hooks.testSubprocessTimeoutMs("C:\\tools\\initdb.exe --pgdata test")).toBe(
      Math.max(hooks.defaultTimeoutMs, hooks.embeddedPostgresTimeoutMs),
    );
    expect(hooks.testSubprocessTimeoutMs("/opt/postgres/bin/pg_ctl start")).toBe(
      Math.max(hooks.defaultTimeoutMs, hooks.embeddedPostgresTimeoutMs),
    );
    expect(hooks.testSubprocessTimeoutMs("postgres -D test-data")).toBe(
      Math.max(hooks.defaultTimeoutMs, hooks.embeddedPostgresTimeoutMs),
    );
  });
});

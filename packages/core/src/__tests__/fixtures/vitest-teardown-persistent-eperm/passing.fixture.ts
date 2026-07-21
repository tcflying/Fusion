import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";

it("executes its ordinary assertion before the fixture teardown fails", () => {
  const marker = process.env.FUSION_VITEST_TEARDOWN_PASS_MARKER;
  if (!marker) throw new Error("Missing FUSION_VITEST_TEARDOWN_PASS_MARKER.");

  writeFileSync(marker, "ordinary test executed\n");
  expect(2 + 2).toBe(4);
});

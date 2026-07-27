/*
FNXC:CI 2026-06-21-00:04:
Tests for the line-count guardrail. Pin the behavior the guard promises: a new
file at exactly MAX_LINES passes but one line over fails; grandfathered files may
sit at or below their recorded ceiling but a single line of growth is a failure;
and shrunk, under-cap, or deleted baseline entries surface as tightenable so the
ratchet can only move down. Line counting must agree whether or not the file ends
in a trailing newline.
*/
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_LINES,
  buildRatchetedBaseline,
  countLines,
  evaluate,
  formatFailureMessage,
  listSourceFiles,
  planBaselineUpdate,
} from "../check-file-line-count.mjs";

test("countLines counts a trailing-newline file without an extra empty line", () => {
  assert.equal(countLines("a\nb\nc\n"), 3);
});

test("countLines counts a file with no trailing newline", () => {
  assert.equal(countLines("a\nb\nc"), 3);
});

test("countLines treats an empty file as zero lines", () => {
  assert.equal(countLines(""), 0);
});

test("listSourceFiles includes tracked and untracked source files", () => {
  let invocation;
  const files = listSourceFiles((command, args, options) => {
    invocation = { command, args, options };
    return {
      status: 0,
      stdout:
        "packages/tracked.ts\0scripts/untracked.mjs\0plugins/generated.d.ts\0docs/ignored.ts\0",
      stderr: "",
    };
  });

  assert.equal(invocation.command, "git");
  assert.deepEqual(invocation.args, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    "packages",
    "scripts",
    "plugins",
  ]);
  assert.equal(invocation.options.encoding, "utf8");
  assert.deepEqual(files, ["packages/tracked.ts", "scripts/untracked.mjs"]);
});

test("evaluate flags a new file over the cap", () => {
  const { violations } = evaluate({ "packages/x/src/new.ts": MAX_LINES + 1 }, {});
  assert.equal(violations.length, 1);
  assert.equal(violations[0].grandfathered, false);
  assert.equal(violations[0].ceiling, MAX_LINES);
});

test("evaluate passes a new file at exactly the cap", () => {
  const { violations } = evaluate({ "packages/x/src/new.ts": MAX_LINES }, {});
  assert.equal(violations.length, 0);
});

test("evaluate allows a grandfathered file at or below its recorded ceiling", () => {
  const baseline = { "packages/x/src/big.ts": 5000 };
  const { violations } = evaluate({ "packages/x/src/big.ts": 4800 }, baseline);
  assert.equal(violations.length, 0);
});

test("evaluate flags a grandfathered file that grew past its ceiling", () => {
  const baseline = { "packages/x/src/big.ts": 5000 };
  const { violations } = evaluate({ "packages/x/src/big.ts": 5001 }, baseline);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].grandfathered, true);
  assert.equal(violations[0].ceiling, 5000);
});

test("evaluate reports a grandfathered file that shrank as tightenable", () => {
  const baseline = { "packages/x/src/big.ts": 5000 };
  const { staleBaseline } = evaluate({ "packages/x/src/big.ts": 4500 }, baseline);
  assert.equal(staleBaseline.some((s) => s.reason === "shrank"), true);
});

test("evaluate reports a grandfathered file that dropped under the cap as tightenable", () => {
  const baseline = { "packages/x/src/big.ts": 5000 };
  const { violations, staleBaseline } = evaluate(
    { "packages/x/src/big.ts": MAX_LINES - 1 },
    baseline,
  );
  assert.equal(violations.length, 0);
  assert.equal(staleBaseline.some((s) => s.reason === "under-cap"), true);
});

test("evaluate reports a deleted baseline file as tightenable", () => {
  const baseline = { "packages/x/src/gone.ts": 5000 };
  const { staleBaseline } = evaluate({}, baseline);
  assert.equal(staleBaseline.some((s) => s.reason === "deleted"), true);
});

test("buildRatchetedBaseline only lowers existing ceilings", () => {
  const baseline = {
    "packages/x/src/grew.ts": 5000,
    "packages/x/src/shrank.ts": 5000,
    "packages/x/src/under-cap.ts": 3000,
    "packages/x/src/deleted.ts": 3000,
  };
  const counts = {
    "packages/x/src/grew.ts": 5100,
    "packages/x/src/shrank.ts": 4500,
    "packages/x/src/under-cap.ts": MAX_LINES,
    "packages/x/src/new.ts": 3000,
  };

  assert.deepEqual(buildRatchetedBaseline(counts, baseline), {
    "packages/x/src/grew.ts": 5000,
    "packages/x/src/shrank.ts": 4500,
  });
});

test("planBaselineUpdate rejects fresh growth without adopting it", () => {
  const baseline = {
    "packages/x/src/grew.ts": 5000,
    "packages/x/src/shrank.ts": 5000,
  };
  const counts = {
    "packages/x/src/grew.ts": 5001,
    "packages/x/src/shrank.ts": 4500,
    "packages/x/src/new.ts": MAX_LINES + 1,
  };

  const plan = planBaselineUpdate(counts, baseline);

  assert.equal(plan.accepted, false);
  assert.deepEqual(plan.baseline, {
    "packages/x/src/grew.ts": 5000,
    "packages/x/src/shrank.ts": 4500,
  });
  assert.deepEqual(
    plan.violations.map(({ filePath, grandfathered }) => ({ filePath, grandfathered })),
    [
      { filePath: "packages/x/src/grew.ts", grandfathered: true },
      { filePath: "packages/x/src/new.ts", grandfathered: false },
    ],
  );
});

test("formatFailureMessage separates grandfathered growth from new over-cap files", () => {
  const msg = formatFailureMessage([
    {
      filePath: "packages/x/src/grew.ts",
      lines: 5001,
      ceiling: 5000,
      grandfathered: true,
    },
    {
      filePath: "packages/x/src/new.ts",
      lines: 2001,
      ceiling: MAX_LINES,
      grandfathered: false,
    },
  ]);

  assert.match(msg, /Grandfathered files that grew \(1\):/);
  assert.match(msg, /New or untracked files over the hard cap \(1\):/);
});

test("formatFailureMessage cites the file, count, and remediation", () => {
  const msg = formatFailureMessage([
    { filePath: "packages/x/src/new.ts", lines: 2500, ceiling: MAX_LINES, grandfathered: false },
  ]);
  assert.match(msg, /packages\/x\/src\/new\.ts: 2500 lines/);
  assert.match(msg, /focused modules/);
});

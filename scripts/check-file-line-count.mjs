#!/usr/bin/env node
/*
FNXC:CI 2026-06-21-00:04:
New source files must not be born as god-files. This guard caps new files under
packages/scripts/plugins at MAX_LINES (2000) lines to keep the codebase
splittable and reviewable. The 106 files already over the cap can't be
refactored in one PR, so they are grandfathered through a ratchet baseline
(line-count-baseline.json): each is pinned to its current count and may shrink
but never grow, applying steady downward pressure without blocking unrelated
work. Generated/lock/locale/.d.ts files are out of scope so the guard only
governs hand-written source.

FNXC:CI 2026-06-21-00:30:
FN-6849 re-ratcheted 26 grandfathered ceilings to current counts after organic
feature and test growth, while also tightening three entries that had already
shrunk. Large-file reduction remains the intended long-term direction, but that
work belongs in dedicated follow-up refactors rather than a pretest-unblock
maintenance change.

FNXC:CI 2026-06-21-12:35:
FN-6871 corrects the stale premise that line-count drift blocks `pnpm test`: FN-5048 removed this guard from pretest, so it now runs only through the opt-in `check:line-count` audit. Eleven grandfathered files were re-ratcheted to current counts after small organic feature/test growth; broad shrink/refactor work for these god-files remains the long-term direction and belongs in dedicated follow-up tasks.

FNXC:CI 2026-06-21-23:53:
FN-6917 re-confirms the `pnpm test`-blocking premise is stale because FN-5048 left this guard opt-in under `check:line-count` only. Twenty files were re-ratcheted after organic feature/test growth; `TerminalModal.tsx` was grandfathered after crossing the hard cap as a long-existing file, with focused split follow-up FN-6918. Wholesale god-file shrink/refactor remains the long-term direction and stays deferred to dedicated follow-ups.

FNXC:CI 2026-06-25-00:00:
FN-7013 re-confirms the `pnpm test`-blocking premise is stale: FN-5048 removed this guard from pretest and left it opt-in under `check:line-count` only. Sixty-one current violations were re-ratcheted after organic feature/test growth and eight stale baseline entries were tightened or pruned. `AgentLogViewer.test.tsx` and `merger-ai.ts` were temporarily grandfathered after crossing the hard cap as long-existing files, with focused split follow-ups FN-7028 and FN-7029. Wholesale god-file shrink/refactor remains the long-term direction and stays deferred to dedicated follow-ups.

FNXC:CI 2026-06-25-17:44:
FN-7035 split the two new hard-cap crossers (`ChatView.core.test.tsx` and `notifier.test.ts`) into focused sibling suites rather than grandfathering them. Six existing grandfathered entries were re-ratcheted to current counts after organic test and feature growth; `store.ts` and `types.ts` drift was left out of scope for a follow-up. Wholesale god-file shrink remains long-term deferred work for dedicated refactors.

FNXC:CI 2026-06-25-22:08:
FN-7046 repaired the deferred `store.ts`/`types.ts` line-count drift by re-ratcheting only those two baseline ceilings after organic Code Review workflow-step and MCP configuration growth. Wholesale god-file shrink remains long-term deferred work for dedicated refactors, and unrelated line-count violations must not be bundled into this scoped repair.

FNXC:CI 2026-06-25-23:10:
FN-7050 repaired the `routes.ts`/`executor.ts` line-count drift by re-ratcheting only those two baseline ceilings after organic execution-lane model growth. Wholesale god-file shrink remains long-term deferred work for dedicated refactors, and this repair intentionally excludes FN-7046's `store.ts`/`types.ts` entries and FN-7044's `areas.test.tsx` split.

FNXC:CI 2026-07-27-06:49:
FUS-P1-009 freezes every new source file at the 2,000-line cap, including untracked worktree files, while reporting grandfathered growth separately. Baseline maintenance is ratchet-only so a newly oversized file or fresh growth cannot be silently adopted by `--update`.

FNXC:CI 2026-07-27-07:36:
The FUS-P1-009 migration explicitly seeds paths that were already oversized in the task-start committed snapshot, then re-pins only pre-existing grandfathered paths after focused high-heat splits. A path that first crosses 2,000 lines in the working tree remains absent from the baseline and fails as new growth.

FNXC:CI 2026-07-27-17:02:
FUS-P1-009 makes baseline maintenance fail closed when the working tree contains grandfathered growth or a newly oversized source file. `--update` may calculate lower ceilings, but it must not write them or report success until every fresh violation is removed.
*/
// Repo-wide guard: hand-written source files may not exceed a hard line-count
// cap (MAX_LINES). This stops the next god-file from being born while leaving
// today's known offenders to be refactored down over time.
//
// Existing oversized files are grandfathered via scripts/line-count-baseline.json,
// which records each file's current line count as its personal ceiling. The
// baseline is a RATCHET: a grandfathered file may shrink (or stay put) but may
// never grow past its recorded count, and once it drops to the cap it is removed
// from the baseline and can never regress. New files get no grandfathering and
// must stay at or under MAX_LINES.
//
// Generated, vendored, and data files are out of scope: only source extensions
// under SCAN_ROOTS are scanned, and *.d.ts is excluded. Lockfiles, CHANGELOG,
// locale JSON, and snapshots never match because of the extension filter.
//
// Run `node scripts/check-file-line-count.mjs --update` to ratchet existing
// ceilings down. The command never adds paths or raises ceilings.
//
// FNXC:TestInfrastructure 2026-06-21-10:00:
// Line-count drift remains visible through the explicit check:line-count audit,
// but it must not block `pnpm test` from reaching the real test runner. The test
// preflight owns fast safety checks; broad god-file cleanup is tracked separately
// so unrelated task completion is not stuck before tests start.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

export const MAX_LINES = 2000;

const SCAN_ROOTS = ["packages", "scripts", "plugins"];
const SOURCE_EXT = /\.(m?[jt]sx?|cjs)$/;
const DECLARATION_EXT = /\.d\.ts$/;

const BASELINE_PATH = fileURLToPath(new URL("./line-count-baseline.json", import.meta.url));

export function loadBaseline(path = BASELINE_PATH) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function listSourceFiles(runGit = spawnSync) {
  const result = runGit(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...SCAN_ROOTS,
    ],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || "git ls-files failed");
  }
  return result.stdout
    .split("\0")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((path) => SCAN_ROOTS.some((root) => path.startsWith(`${root}/`)))
    .filter((path) => SOURCE_EXT.test(path) && !DECLARATION_EXT.test(path));
}

export function countLines(content) {
  if (content === "") return 0;
  const withoutTrailingNewline = content.endsWith("\n") ? content.slice(0, -1) : content;
  return withoutTrailingNewline.split(/\r?\n/).length;
}

// Returns { violations, staleBaseline } for the given file→lineCount map.
// `violations` are hard failures; `staleBaseline` lists baseline entries that
// could be tightened (file shrank to/under the cap, or no longer exists).
export function evaluate(counts, baseline = loadBaseline()) {
  const violations = [];
  for (const [filePath, lines] of Object.entries(counts)) {
    const ceiling = filePath in baseline ? baseline[filePath] : MAX_LINES;
    if (lines > ceiling) {
      violations.push({
        filePath,
        lines,
        ceiling,
        grandfathered: filePath in baseline,
      });
    }
  }

  const staleBaseline = [];
  for (const [filePath, recorded] of Object.entries(baseline)) {
    if (!(filePath in counts)) {
      staleBaseline.push({ filePath, reason: "deleted" });
    } else if (counts[filePath] <= MAX_LINES) {
      staleBaseline.push({ filePath, reason: "under-cap", lines: counts[filePath] });
    } else if (counts[filePath] < recorded) {
      staleBaseline.push({ filePath, reason: "shrank", lines: counts[filePath], recorded });
    }
  }

  return { violations, staleBaseline };
}

export function collectCounts(files = listSourceFiles()) {
  const counts = {};
  for (const filePath of files) {
    // A tracked file that can't be read must fail the guard, not be skipped:
    // silently continuing would let an unreadable file evade the cap (false pass).
    let content;
    try {
      content = readFileSync(filePath, "utf8");
    } catch (error) {
      throw new Error(`[check-file-line-count] failed to read tracked file ${filePath}: ${error.message}`);
    }
    counts[filePath] = countLines(content);
  }
  return counts;
}

export function formatFailureMessage(violations) {
  const grandfatheredGrowth = violations.filter((violation) => violation.grandfathered);
  const newOverCap = violations.filter((violation) => !violation.grandfathered);
  const sections = [];
  if (grandfatheredGrowth.length > 0) {
    sections.push(
      `Grandfathered files that grew (${grandfatheredGrowth.length}):`,
      ...grandfatheredGrowth.map(
        ({ filePath, lines, ceiling }) =>
          `${filePath}: ${lines} lines (grandfathered ceiling ${ceiling} — this file grew and must shrink, not expand)`,
      ),
    );
  }
  if (newOverCap.length > 0) {
    if (sections.length > 0) sections.push("");
    sections.push(
      `New or untracked files over the hard cap (${newOverCap.length}):`,
      ...newOverCap.map(
        ({ filePath, lines, ceiling }) => `${filePath}: ${lines} lines (cap ${ceiling})`,
      ),
    );
  }
  return [
    `[check-file-line-count] ${violations.length} file(s) exceed the line-count guardrail:`,
    "",
    ...sections,
    "",
    `New source files must stay at or under ${MAX_LINES} lines. Split the file into`,
    "focused modules. Grandfathered files (in scripts/line-count-baseline.json) may",
    "shrink but never grow; refactor them down rather than raising their ceiling.",
    "`node scripts/check-file-line-count.mjs --update` only tightens existing",
    "ceilings; it will not adopt a new oversized file or grandfather fresh growth.",
  ].join("\n");
}

export function buildRatchetedBaseline(counts, currentBaseline = loadBaseline()) {
  const baseline = {};
  for (const filePath of Object.keys(currentBaseline).sort()) {
    const lines = counts[filePath];
    if (lines > MAX_LINES) {
      baseline[filePath] = Math.min(lines, currentBaseline[filePath]);
    }
  }
  return baseline;
}

export function planBaselineUpdate(counts, currentBaseline = loadBaseline()) {
  const { violations } = evaluate(counts, currentBaseline);
  return {
    accepted: violations.length === 0,
    baseline: buildRatchetedBaseline(counts, currentBaseline),
    violations,
  };
}

export function main(argv = process.argv.slice(2)) {
  const counts = collectCounts();
  const currentBaseline = loadBaseline();

  if (argv.includes("--update")) {
    const update = planBaselineUpdate(counts, currentBaseline);
    if (!update.accepted) {
      console.error(formatFailureMessage(update.violations));
      return 1;
    }
    const baseline = update.baseline;
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    console.error(
      `[check-file-line-count] baseline ratcheted: ${Object.keys(baseline).length} existing file(s) remain over ${MAX_LINES} lines; no new paths or raised ceilings were adopted.`,
    );
    return 0;
  }

  const { violations, staleBaseline } = evaluate(counts, currentBaseline);

  // Any stale entry — shrunk, dropped under the cap, or deleted — means the
  // baseline can ratchet down. Deleted-only entries must trigger this note too,
  // otherwise removed files sit in the baseline forever with no prompt to prune.
  if (staleBaseline.length > 0) {
    console.error(
      `[check-file-line-count] note: ${staleBaseline.length} baseline entr(ies) can be tightened ` +
        "(files shrank, dropped under the cap, or were deleted). Run with --update to ratchet the baseline down.",
    );
  }

  if (violations.length === 0) return 0;
  console.error(formatFailureMessage(violations));
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main();
}

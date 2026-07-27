/**
 * FNXC:AutoMerge 2026-07-27-17:02:
 * FUS-P1-009 extracts ProjectEngine's pure retry/signature decisions and its
 * git reachability probe into a focused guardrail module. Preserve retry
 * arithmetic, diagnostic classification, command timeouts, and no-op handling
 * exactly so reducing the lifecycle owner's line ceiling cannot change merge
 * outcomes.
 */
import { resolveMaxAutoMergeRetries } from "@fusion/core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { VerificationError } from "./merger.js";
import {
  computeVerificationFailureSignature,
  extractFailingTestFiles,
} from "./verification-followup-dedup.js";

const execFileAsync = promisify(execFile);

/*
FNXC:Workspace 2026-06-22-05:10 (Phase C review B6 — unify partial-land retry seam):
The workspace PARTIAL-land retry decision (some sub-repos landed, one failed) is the SAME
arithmetic as the conflict-retry decision MINUS the `autoResolveConflicts` gate (a partial
land is retryable regardless of conflict-resolution settings, because the landed repos'
`landedSha` is persisted and a re-run skips them — U2 idempotency). To keep the
`resolveMaxAutoMergeRetries(settings)` arithmetic in ONE place we collapse the former
`shouldRetryWorkspacePartialLand` into this function via `skipAutoResolveCheck`. When set,
the `autoResolveConflicts` gate is bypassed; otherwise behavior is byte-identical to before.
`currentRetries + 1 < MAX` keeps the LAST attempt's failure parking in the same tick rather
than scheduling an Nth timer that a restart could strand.
*/
export function shouldRetryAutoMergeConflict(
  currentRetries: number,
  settings: { autoResolveConflicts?: boolean; maxAutoMergeRetries?: unknown } | null | undefined,
  opts?: { skipAutoResolveCheck?: boolean },
): { shouldRetry: boolean; maxAutoMergeRetries: number; nextRetryCount: number } {
  const maxAutoMergeRetries = resolveMaxAutoMergeRetries(settings);
  const autoResolveOk = opts?.skipAutoResolveCheck === true || settings?.autoResolveConflicts !== false;
  return {
    shouldRetry: autoResolveOk && currentRetries + 1 < maxAutoMergeRetries,
    maxAutoMergeRetries,
    nextRetryCount: currentRetries + 1,
  };
}

/**
 * FN-5627: Defense-in-depth gate for the auto-merge "merge already confirmed"
 * fast-path. Verifies the task's recorded `mergeDetails.commitSha` is actually
 * reachable from the integration branch tip before promoting in-review → done.
 *
 * Returns:
 *  - { reachable: true } when commitSha is an ancestor of integrationBranch.
 *  - { reachable: false, reason } when it is NOT reachable (the merger poisoned
 *    the row with mergeConfirmed=true before ref-advance succeeded, OR a self-
 *    healing path set the flag prematurely). Caller must refuse the fast-path.
 *  - { reachable: true, skipped: "no-commit-sha" } when commitSha is unset —
 *    legacy/no-op finalize paths and verified-no-op merges legitimately have
 *    no commitSha; the fast-path must remain functional for those.
 */
export async function verifyMergeConfirmedReachability(args: {
  commitSha: string | undefined;
  integrationBranch: string | undefined;
  cwd: string;
}): Promise<
  | { reachable: true; skipped?: "no-commit-sha" | "no-integration-branch" }
  | { reachable: false; reason: "not-ancestor" | "commit-missing" | "git-error"; diagnostic: string }
> {
  const { commitSha, integrationBranch, cwd } = args;
  // No commit sha = legitimate no-op/verified-short-circuit/early-recovery case.
  if (!commitSha || !commitSha.trim()) {
    return { reachable: true, skipped: "no-commit-sha" };
  }
  // No integration branch resolvable = degrade safely (caller continues fast-path);
  // this keeps the gate from breaking ancient tasks missing mergeTargetBranch.
  if (!integrationBranch || !integrationBranch.trim()) {
    return { reachable: true, skipped: "no-integration-branch" };
  }
  // Verify the commit exists locally before testing ancestry — git
  // merge-base --is-ancestor returns exit 128 for missing commits, which we
  // want to surface as "commit-missing" rather than "not-ancestor".
  try {
    await execFileAsync("git", ["cat-file", "-e", `${commitSha}^{commit}`], {
      cwd,
      timeout: 10_000,
    });
  } catch (error: unknown) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    return { reachable: false, reason: "commit-missing", diagnostic };
  }
  try {
    await execFileAsync(
      "git",
      ["merge-base", "--is-ancestor", commitSha, `refs/heads/${integrationBranch}`],
      { cwd, timeout: 10_000 },
    );
    return { reachable: true };
  } catch (error: unknown) {
    // Exit code 1 = not an ancestor. Other non-zero = git error.
    const err = error as { code?: number; message?: string };
    const code = typeof err.code === "number" ? err.code : undefined;
    const diagnostic = err.message ?? String(error);
    if (code === 1) {
      return { reachable: false, reason: "not-ancestor", diagnostic };
    }
    return { reachable: false, reason: "git-error", diagnostic };
  }
}

export function buildVerificationFailureSignature(error: VerificationError): string {
  const commandResult = error.verificationResult.testResult ?? error.verificationResult.buildResult;
  const lane = commandResult?.command?.trim()
    || error.verificationResult.failedCommand?.trim()
    || "verification-failure";
  const failingTestFiles = commandResult
    ? extractFailingTestFiles(commandResult.stdout, commandResult.stderr)
    : [];
  return computeVerificationFailureSignature({
    lane,
    failingTestFiles,
    failedCommand: commandResult?.command ?? error.verificationResult.failedCommand ?? null,
  }).signature;
}

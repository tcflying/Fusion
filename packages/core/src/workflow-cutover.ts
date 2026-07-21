import type { WorkflowParityDriftReport, WorkflowParitySummary } from "./workflow-parity.js";

/**
 * Opt-in authoritative cutover flag for routing the coding lifecycle through the
 * workflow interpreter. The cutover is guarded by rollout-readiness checks and
 * remains reversible by disabling the flag.
 */
export const WORKFLOW_INTERPRETER_AUTHORITATIVE_FLAG = "workflowInterpreterAuthoritative" as const;

export interface InterpreterCutoverReadinessInput {
  /** Explicit operator opt-in; default runtime remains legacy when false. */
  authoritativeFlagEnabled: boolean;
  /** Aggregated parity signal from the audit trail (for example `store.getWorkflowParitySummary()`). */
  paritySummary?: Pick<WorkflowParitySummary, "observed" | "drift" | "recentDrift"> | null;
  /** Optional unresolved drift reports surfaced directly by the caller. */
  unresolvedDriftReports?: readonly Pick<WorkflowParityDriftReport, "agree" | "diffs">[] | null;
  /** Minimum observed parity runs required before cutover may proceed. Default: 1. */
  minimumObservedRuns?: number;
}

export interface InterpreterCutoverReadinessResult {
  ready: boolean;
  reasons: string[];
}

function normalizeMinimumObservedRuns(value: number | undefined): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value!));
}

function countUnresolvedDriftReports(
  reports: readonly Pick<WorkflowParityDriftReport, "agree" | "diffs">[] | null | undefined,
): number {
  if (!reports || reports.length === 0) return 0;
  return reports.filter((report) => report.agree === false || report.diffs.length > 0).length;
}

/**
 * Pure rollout-readiness guard for the interpreter-authoritative cutover.
 * Callers supply explicit parity evidence; this function performs no I/O.
 *
 * FNXC:WorkflowInterpreterCutover 2026-06-23-21:58:
 * workflowInterpreterDualObserve is retired and inert. Authoritative cutover must use the explicit authoritative flag plus clean populated parity summaries as evidence, without reactivating hidden shadow observation.
 */
export function evaluateInterpreterCutoverReadiness(
  input: InterpreterCutoverReadinessInput,
): InterpreterCutoverReadinessResult {
  const reasons: string[] = [];
  const minimumObservedRuns = normalizeMinimumObservedRuns(input.minimumObservedRuns);

  if (!input.authoritativeFlagEnabled) {
    reasons.push("experimentalFeatures.workflowInterpreterAuthoritative is disabled");
  }

  const paritySummary = input.paritySummary;
  if (!paritySummary) {
    reasons.push("workflow parity summary unavailable");
  } else {
    if (paritySummary.observed < minimumObservedRuns) {
      reasons.push(
        `workflow parity observation window too small (${paritySummary.observed}/${minimumObservedRuns} observed)`,
      );
    }
    if (paritySummary.drift > 0) {
      reasons.push(`workflow parity drift above zero (${paritySummary.drift} drift events)`);
    }
  }

  const unresolvedDriftCount = countUnresolvedDriftReports(input.unresolvedDriftReports);
  if (unresolvedDriftCount > 0) {
    reasons.push(`workflow parity has unresolved drift reports (${unresolvedDriftCount})`);
  }

  return {
    ready: reasons.length === 0,
    reasons,
  };
}

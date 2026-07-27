/**
 * FNXC:PlannerOversight 2026-07-27-17:02:
 * FUS-P1-009 moves ProjectEngine's planner-recovery handler construction and
 * intervention deduplication into one focused collaborator. Keep the existing
 * TaskStore channels, audit payloads, dedup keys, and best-effort failure
 * behavior unchanged while preventing lifecycle orchestration from absorbing
 * more planner policy wiring.
 */
import type {
  PlannerInterventionSourceLink,
  PlannerOversightStage,
  TaskStore,
} from "@fusion/core";
import {
  emitOverseerConfirmation,
  emitOverseerEscalation,
  emitOverseerObservation,
  emitOverseerRecoveryAttempt,
  emitOverseerRetry,
  emitOverseerSteering,
} from "@fusion/core";
import { runtimeLog } from "./logger.js";
import type { OverseerStageObservation } from "./planner-overseer.js";
import type { PlannerRecoveryHandlers } from "./planner-recovery-controller.js";
import { createRunAuditor, generateSyntheticRunId } from "./run-audit.js";

interface PlannerEscalationDecision {
  watchedStage: PlannerOversightStage | null;
  reason: string;
  attemptCount: number;
  attemptLimit: number;
  sourceLinks: ReadonlyArray<{ kind: string; ref: string; url?: string }>;
}

export class ProjectEnginePlannerRecoveryWiring {
  /**
   * FNXC:PlannerOversight 2026-07-04-19:45:
   * FN-7551 requirement: real overseer decision points (observation,
   * steering/retry/targeted-fix, confirmation request+resolution, and
   * bounded-recovery escalation) must emit exactly one `overseer:intervention`
   * run-audit entry through the FN-7520 `emitOverseer*` façade with the real
   * `TaskStore`, so the dashboard intervention timeline reflects live engine
   * activity instead of only synthetic unit-test entries. Emission must be
   * deduped so the 45s poll does not flood the timeline: this map tracks the
   * last emitted `"stage:signal"` per taskId for observations, mirroring
   * FN-7514's `lastWithheldReason` dedup pattern. Cleared alongside the
   * monitor/controller ring buffers whenever a task leaves the in-flight set.
   */
  private readonly observationEmitDedup = new Map<string, string>();

  /**
   * FNXC:PlannerOversight 2026-07-04-19:45:
   * FN-7551: tracks `(taskId, stage)` pairs that have already had a bounded-
   * recovery escalation emitted so a stage that stays exhausted across many
   * subsequent polls emits exactly one `escalate` entry, not one per poll.
   */
  private readonly escalationEmitDedup = new Set<string>();

  /**
   * FNXC:PlannerOversight 2026-07-04-19:45:
   * FN-7551 mapping helper: converts the `{kind, ref, url?}` source-link shape
   * shared by `OverseerSourceLink` (FN-7511 observations) and
   * `PlannerRecoverySourceLink` (FN-7512/FN-7513 decisions) into the FN-7520
   * façade's `PlannerInterventionSourceLink` shape (`{kind, label, target, url}`),
   * using `ref` as both `label` and `target` when no richer label exists.
   * Never throws; an empty/undefined input yields `undefined` so callers can
   * omit `sourceLinks` entirely rather than pass an empty array.
   */
  private toInterventionSourceLinks(
    links: ReadonlyArray<{ kind: string; ref: string; url?: string }> | undefined,
  ): PlannerInterventionSourceLink[] | undefined {
    if (!links || links.length === 0) return undefined;
    return links.map((link) => ({
      kind: link.kind as PlannerInterventionSourceLink["kind"],
      label: link.ref || link.kind,
      target: link.ref,
      url: link.url,
    }));
  }

  /**
   * FNXC:PlannerOversight 2026-07-04-19:45:
   * FN-7551: best-effort wrapper shared by every non-observation emission
   * call-site (steering/retry/targeted-fix/confirmation/escalation) —
   * swallows and logs any façade/store failure so an audit-emission error
   * never breaks the dispatching handler or the poll (mirrors the
   * try/catch-degrade-to-no-op contract every FN-7512/FN-7513/FN-7514
   * handler already follows).
   */
  private emitInterventionSafe(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      runtimeLog.warn(`Failed to emit overseer intervention: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * FNXC:PlannerOversight 2026-07-04-19:45:
   * FN-7551: emits one `overseer:intervention` `observe` entry through
   * `emitOverseerObservation` for a real `OverseerStageObservation`, deduped
   * per `(taskId, stage:signal)` so a 45s poll of an unchanged watched stage
   * does not append a new observation entry every cycle — only a changed
   * `(stage, signal)` pair emits. Best-effort: any store/façade failure is
   * swallowed so it never breaks `PlannerOverseerMonitor#observeTask`/the poll.
   */
  emitObservationDeduped(store: TaskStore, observation: OverseerStageObservation): void {
    try {
      const dedupKey = `${observation.stage}:${observation.signal}`;
      const last = this.observationEmitDedup.get(observation.taskId);
      if (last === dedupKey) {
        return;
      }
      this.observationEmitDedup.set(observation.taskId, dedupKey);
      emitOverseerObservation({
        store,
        taskId: observation.taskId,
        stage: observation.stage,
        reason: observation.reason,
        sourceLinks: this.toInterventionSourceLinks(observation.sources),
      });
    } catch (err) {
      runtimeLog.warn(
        `Failed to emit overseer observation intervention for ${observation.taskId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * FNXC:PlannerOversight 2026-07-04-19:45:
   * FN-7551: emits one `overseer:intervention` `escalate` entry through
   * `emitOverseerEscalation` when a `(taskId, stage)` pair's bounded-recovery
   * budget is exhausted, deduped so it is emitted exactly once while the
   * stage stays exhausted across subsequent polls (a stage that later
   * un-exhausts — e.g. cleared via `clear(taskId)` on terminal transition —
   * clears the dedup entry and may escalate again in a future exhaustion).
   * Best-effort; never throws out of the poll.
   */
  emitEscalationDeduped(
    store: TaskStore,
    taskId: string,
    decision: PlannerEscalationDecision,
  ): void {
    if (!decision.watchedStage) return;
    const dedupKey = `${taskId}::${decision.watchedStage}`;
    if (this.escalationEmitDedup.has(dedupKey)) {
      return;
    }
    this.escalationEmitDedup.add(dedupKey);
    this.emitInterventionSafe(() =>
      emitOverseerEscalation({
        store,
        taskId,
        stage: decision.watchedStage as PlannerOversightStage,
        reason: decision.reason,
        attemptCount: decision.attemptCount,
        attemptLimit: decision.attemptLimit,
        sourceLinks: this.toInterventionSourceLinks(decision.sourceLinks),
      }),
    );
  }

  /** FN-7551: clears observation/escalation dedup entries for `taskId`. */
  clearTask(taskId: string): void {
    this.observationEmitDedup.delete(taskId);
    const prefix = `${taskId}::`;
    for (const key of [...this.escalationEmitDedup]) {
      if (key.startsWith(prefix)) {
        this.escalationEmitDedup.delete(key);
      }
    }
  }

  /**
   * FNXC:PlannerOversight 2026-07-04-12:00:
   * Concrete FN-7512 handler wiring — ONLY reuses existing mechanisms:
   * `injectGuidance`/`requestTargetedFix` post a planner-authored steering
   * comment via `store.addSteeringComment` (the same channel the executor's
   * real-time injection listener already watches); `retryStep` calls the
   * store's existing in-progress→todo retry/re-enqueue path
   * (`moveTask(id, "todo", { preserveProgress: true })`), preserving
   * progress exactly like the auto-recovery/self-healing retry handlers do.
   * No new session/tool/merge channel is introduced.
   */
  buildHandlers(store: TaskStore): PlannerRecoveryHandlers {
    return {
      injectGuidance: async (task, decision) => {
        const text = `[planner-oversight] ${decision.reason}`;
        await store.addSteeringComment(task.id, text, "agent");
        // FN-7551: emit the steering intervention entry AFTER the steering
        // comment succeeds, through the real store, so the timeline reflects
        // the same guidance the agent actually saw.
        this.emitInterventionSafe(() =>
          emitOverseerSteering({
            store,
            taskId: task.id,
            stage: (decision.watchedStage ?? "executor") as PlannerOversightStage,
            reason: decision.reason,
            sourceLinks: this.toInterventionSourceLinks(decision.sourceLinks),
          }),
        );
      },
      retryStep: async (task, decision) => {
        await store.moveTask(task.id, "todo", { preserveProgress: true, moveSource: "engine" } as Parameters<TaskStore["moveTask"]>[2]);
        // FN-7551: the attempt just dispatched — record it as attemptCount + 1
        // (decision.attemptCount is the count BEFORE this dispatch).
        this.emitInterventionSafe(() =>
          emitOverseerRetry({
            store,
            taskId: task.id,
            stage: (decision.watchedStage ?? "executor") as PlannerOversightStage,
            reason: decision.reason,
            attemptCount: decision.attemptCount + 1,
            attemptLimit: decision.attemptLimit,
            sourceLinks: this.toInterventionSourceLinks(decision.sourceLinks),
          }),
        );
      },
      requestTargetedFix: async (task, decision) => {
        const sourceRef = decision.sourceLinks[0]?.ref;
        const text = sourceRef
          ? `[planner-oversight] targeted-fix requested: ${decision.reason} (source: ${sourceRef})`
          : `[planner-oversight] targeted-fix requested: ${decision.reason}`;
        await store.addSteeringComment(task.id, text, "agent");
        this.emitInterventionSafe(() =>
          emitOverseerRecoveryAttempt({
            store,
            taskId: task.id,
            stage: (decision.watchedStage ?? "executor") as PlannerOversightStage,
            reason: decision.reason,
            attemptCount: decision.attemptCount + 1,
            attemptLimit: decision.attemptLimit,
            sourceLinks: this.toInterventionSourceLinks(decision.sourceLinks),
          }),
        );
      },
      // FNXC:PlannerOversight 2026-07-04-13:00:
      // FN-7513 requirement: merge/PR actions beyond guidance/retry, and any
      // destructive/external-service side effect, must never run
      // autonomously — `requestConfirmation` ONLY records a pending
      // `PlannerConfirmationRequest` via a planner-authored steering comment
      // (reusing the same `addSteeringComment` channel as bounded recovery)
      // so a human sees it; it never performs the side effect itself. The
      // dashboard confirmation UI/badge that lets a human act on this is
      // owned by FN-7515+/FN-7517.
      // FNXC:PlannerOversight 2026-07-08-00:00:
      // FN-7692 fix: this prefix previously read "confirmation required"
      // unconditionally, which contradicted `request.reason` once FN-7692
      // made that reason accurately advisory under an active auto-merge
      // policy. "checkpoint" is neutral and consistent whether the trailing
      // `reason` describes an advisory (auto-merge will proceed) or a
      // genuine block (human approval required) — messaging-only, no change
      // to the `addSteeringComment` channel/timing or `emitOverseerConfirmation`
      // below.
      requestConfirmation: async (task, request) => {
        const text = `[planner-oversight] merge checkpoint (${request.sideEffectClass}): ${request.reason}`;
        await store.addSteeringComment(task.id, text, "agent");
        this.emitInterventionSafe(() =>
          emitOverseerConfirmation({
            store,
            taskId: task.id,
            stage: request.watchedStage as PlannerOversightStage,
            reason: request.reason,
            sourceLinks: this.toInterventionSourceLinks(request.sourceLinks),
          }),
        );
      },
      // FNXC:PlannerOversight 2026-07-04-19:45:
      // FN-7551: audit-only confirmation-RESOLUTION emission. Invoked from
      // `PlannerRecoveryController.resolveConfirmation` for both "approved"
      // and "denied" outcomes, mirroring the request-path emission above so
      // the timeline shows both the request and its resolution. Never touches
      // the approve/deny execution path itself.
      onConfirmationResolved: async (taskId, request, resolution) => {
        this.emitInterventionSafe(() =>
          emitOverseerConfirmation({
            store,
            taskId,
            stage: request.watchedStage as PlannerOversightStage,
            reason: request.reason,
            outcome: resolution === "approved" ? "succeeded" : "skipped",
            sourceLinks: this.toInterventionSourceLinks(request.sourceLinks),
          }),
        );
      },
      // FNXC:PlannerOversight 2026-07-04-14:30:
      // FN-7513 code-review fix: a `"merge_pr"`-classified confirmation covers
      // TWO distinct proposed actions (`decidePlannerRecovery` sets
      // `proposedAction: "advance_merge"` for the `merger` stage and
      // `"advance_pull_request"` for the `pull-request` stage) — they must NOT
      // share one handler. Calling `store.mergeTask` unconditionally on every
      // approved merge_pr request would let an approved PR-stage confirmation
      // perform a direct task merge/cleanup instead of a PR-specific action,
      // bypassing the PR workflow entirely. Branch on `request.proposedAction`
      // (falling back to `request.watchedStage` defensively) and ONLY reuse
      // the existing `store.mergeTask` merge-advance mechanism for
      // `"advance_merge"` / the `merger` stage. `"advance_pull_request"` has
      // no existing PR-advance mechanism to reuse yet (FN-7515+/FN-7517 own
      // the PR-specific execution wiring) — it is intentionally a no-op here
      // so an approved PR confirmation never falls through to a merge.
      executeMergePrAction: async (taskId, request) => {
        const proposedAction = request.proposedAction;
        const isMergeAdvance = proposedAction === "advance_merge" || (!proposedAction && request.watchedStage === "merger");
        if (!isMergeAdvance) {
          // PR-stage (or any other non-merge-advance) approval: no reusable
          // PR-advance mechanism exists yet — deliberately do nothing rather
          // than fall back to a task merge.
          return;
        }
        await store.mergeTask(taskId);
      },
      // FN-7513: no destructive/external execution handler is wired yet —
      // `decidePlannerRecovery` does not currently produce a
      // `destructive_external` action (FN-7511 has no destructive-action
      // signal), so this is intentionally left unset; a future task can wire
      // a concrete handler using existing safe helpers when one is needed.
      // FNXC:PlannerOverseer 2026-07-04-15:00:
      // FN-7514 requirement: when the human-control guard (user-paused, or
      // autoMerge:false/human-review) withholds ALL oversight for a task,
      // record a bounded `overseer:oversight-withheld-human-control` no-action
      // run-audit event (metadata: taskId/reason/stage/oversightLevel) so the
      // withholding is observable, mirroring the `*-no-action` self-healing
      // convention. Audit-only — this handler performs no lifecycle mutation.
      recordHumanControlWithheld: async (task, decision, ctx) => {
        try {
          const auditor = createRunAuditor(store, {
            runId: generateSyntheticRunId("planner-overseer-human-control", task.id),
            agentId: "planner-overseer",
            taskId: task.id,
            phase: "planner-overseer-poll",
          });
          await auditor.database({
            type: "overseer:oversight-withheld-human-control",
            target: task.id,
            metadata: {
              taskId: task.id,
              reason: decision.reason,
              stage: (ctx as { stage?: string }).stage,
              oversightLevel: (ctx as { oversightLevel?: string }).oversightLevel,
            },
          });
        } catch (err: unknown) {
          runtimeLog.warn(
            `Failed to record overseer:oversight-withheld-human-control for ${task.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    };
  }
}

import {
  ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION,
  type AsyncDataLayer,
  type RoomGlobalConcurrencyPostgresLegacySnapshotReaderV1,
  type RoomGlobalConcurrencyPostgresLegacySnapshotV1,
  type RoomGlobalConcurrencyPostgresLegacySnapshotReadInputV1,
  type Task,
} from "@fusion/core";

export type RoomLegacyTaskTriageSnapshotTaskV1 = Omit<
  Pick<Task, "column" | "status" | "paused" | "userPaused" | "nextRecoveryAt" | "deletedAt">,
  "status" | "deletedAt"
> & {
  readonly status?: string | null;
  readonly deletedAt?: string | null;
};

/** The narrow TaskStore surface required by the legacy snapshot reader. */
export interface RoomLegacyTaskTriageSnapshotTaskStoreV1 {
  getAsyncLayer(): Pick<AsyncDataLayer, "projectId"> | null;
  listTasks(options?: { readonly includeArchived?: boolean; readonly slim?: boolean }): Promise<readonly RoomLegacyTaskTriageSnapshotTaskV1[]>;
}

export interface RoomLegacyTaskTriageSnapshotReaderOptionsV1 {
  readonly projectId: string;
  readonly taskStore: RoomLegacyTaskTriageSnapshotTaskStoreV1;
}

export type RoomLegacyTaskTriageSnapshotReaderErrorCodeV1 =
  | "invalid_input"
  | "project_scope_mismatch"
  | "project_store_unbound"
  | "task_snapshot_malformed";

export class RoomLegacyTaskTriageSnapshotReaderError extends Error {
  public constructor(
    readonly code: RoomLegacyTaskTriageSnapshotReaderErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "RoomLegacyTaskTriageSnapshotReaderError";
  }
}

const ACTIVE_IN_REVIEW_TASK_STATUSES = new Set([
  "merging",
  "merging-pr",
  "merging-fix",
  "reviewing",
  "fixing",
]);

const QUEUED_TASK_STATUSES = new Set<string | null | undefined>([undefined, null, "queued"]);
const QUEUED_TRIAGE_STATUSES = new Set<string | null | undefined>([
  undefined,
  null,
  "queued",
  "needs-replan",
  "plan-review-unavailable",
]);

function canonicalString(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function canonicalTimestamp(value: unknown): value is string {
  if (!canonicalString(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertTaskShape(value: unknown): asserts value is RoomLegacyTaskTriageSnapshotTaskV1 {
  if (!isRecord(value) || typeof value.column !== "string") {
    throw new RoomLegacyTaskTriageSnapshotReaderError(
      "task_snapshot_malformed",
      "TaskStore returned a malformed task while reading legacy concurrency.",
    );
  }
  if (
    (value.status !== undefined && value.status !== null && typeof value.status !== "string")
    || (value.deletedAt !== undefined && value.deletedAt !== null && typeof value.deletedAt !== "string")
    || (value.paused !== undefined && typeof value.paused !== "boolean")
    || (value.userPaused !== undefined && typeof value.userPaused !== "boolean")
    || (value.nextRecoveryAt !== undefined && typeof value.nextRecoveryAt !== "string")
  ) {
    throw new RoomLegacyTaskTriageSnapshotReaderError(
      "task_snapshot_malformed",
      "TaskStore returned an invalid task state while reading legacy concurrency.",
    );
  }
}

function isLiveTask(task: RoomLegacyTaskTriageSnapshotTaskV1): boolean {
  return task.deletedAt === undefined || task.deletedAt === null;
}

function isActiveTask(task: RoomLegacyTaskTriageSnapshotTaskV1): boolean {
  if (!isLiveTask(task) || task.column === "archived") return false;
  if (task.column === "in-progress") return true;
  return task.column === "in-review"
    && task.paused !== true
    && ACTIVE_IN_REVIEW_TASK_STATUSES.has(task.status ?? "");
}

function isActiveTriage(task: RoomLegacyTaskTriageSnapshotTaskV1): boolean {
  return isLiveTask(task)
    && task.paused !== true
    && (task.column === "triage" || task.column === "todo")
    && task.status === "planning";
}

function isRecoveryEligible(task: RoomLegacyTaskTriageSnapshotTaskV1, asOfMs: number): boolean {
  if (task.nextRecoveryAt === undefined) return true;
  const nextRecoveryAtMs = Date.parse(task.nextRecoveryAt);
  return Number.isFinite(nextRecoveryAtMs) && nextRecoveryAtMs <= asOfMs;
}

function isQueuedTask(task: RoomLegacyTaskTriageSnapshotTaskV1, asOfMs: number): boolean {
  return isLiveTask(task)
    && task.column === "todo"
    && task.paused !== true
    && task.userPaused !== true
    && isRecoveryEligible(task, asOfMs)
    && QUEUED_TASK_STATUSES.has(task.status);
}

function isQueuedTriage(task: RoomLegacyTaskTriageSnapshotTaskV1, asOfMs: number): boolean {
  if (
    !isLiveTask(task)
    || task.paused === true
    || task.userPaused === true
    || !isRecoveryEligible(task, asOfMs)
  ) {
    return false;
  }
  if (task.column === "triage") return QUEUED_TRIAGE_STATUSES.has(task.status);
  return task.column === "todo" && task.status === "needs-replan";
}

function validateReadInput(
  input: RoomGlobalConcurrencyPostgresLegacySnapshotReadInputV1,
  expectedProjectId: string,
): void {
  if (
    !isRecord(input)
    || input.contractVersion !== ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION
    || !canonicalString(input.projectId)
    || !canonicalTimestamp(input.asOf)
  ) {
    throw new RoomLegacyTaskTriageSnapshotReaderError(
      "invalid_input",
      "Room legacy task/triage snapshot input is invalid.",
    );
  }
  if (input.projectId !== expectedProjectId) {
    throw new RoomLegacyTaskTriageSnapshotReaderError(
      "project_scope_mismatch",
      "Room legacy task/triage snapshot input violates the reader project scope.",
    );
  }
}

/**
 * FNXC:RoomLegacyTaskTriageSnapshot 2026-07-19-17:12:
 * Core's PostgreSQL global-concurrency port needs a fail-closed compatibility
 * reader for existing TaskStore work before Room controller wiring lands.
 * Require the TaskStore's AsyncDataLayer to be bound to the same project as the
 * Core input; an unbound/global store could merge another project's task rows.
 *
 * `activeTaskSlots` mirrors the legacy shared-agent occupancy predicate for
 * every `in-progress` task and unpaused active review/merge state.
 * `activeTriageSlots` mirrors TriageProcessor's actual planning count: an
 * unpaused `planning` task in either `triage` or plan-in-place `todo`.
 * Queued values are deliberately narrower telemetry: only known, schedulable
 * legacy states are counted. Custom workflow columns and todo cards whose
 * unplanned PROMPT.md state cannot be inferred from listTasks() remain out of
 * the queue rather than being guessed as active or ready.
 *
 * TaskStore.listTasks() does not accept Core's transaction handle, so this is
 * a project-scoped list snapshot rather than a single cross-port SQL snapshot.
 * A list/read error or malformed row propagates instead of returning zero, so
 * global Room admission remains fail-closed.
 */
export class RoomLegacyTaskTriageSnapshotReader implements RoomGlobalConcurrencyPostgresLegacySnapshotReaderV1 {
  private readonly projectId: string;
  private readonly taskStore: RoomLegacyTaskTriageSnapshotTaskStoreV1;

  public constructor(options: RoomLegacyTaskTriageSnapshotReaderOptionsV1) {
    if (!isRecord(options) || !canonicalString(options.projectId)) {
      throw new RoomLegacyTaskTriageSnapshotReaderError(
        "invalid_input",
        "Room legacy task/triage snapshot reader requires a canonical project id.",
      );
    }
    if (
      !options.taskStore
      || typeof options.taskStore.getAsyncLayer !== "function"
      || typeof options.taskStore.listTasks !== "function"
    ) {
      throw new RoomLegacyTaskTriageSnapshotReaderError(
        "invalid_input",
        "Room legacy task/triage snapshot reader requires a TaskStore reader.",
      );
    }
    this.projectId = options.projectId;
    this.taskStore = options.taskStore;
  }

  public async readSnapshot(
    input: RoomGlobalConcurrencyPostgresLegacySnapshotReadInputV1,
  ): Promise<RoomGlobalConcurrencyPostgresLegacySnapshotV1> {
    validateReadInput(input, this.projectId);
    const layer = this.taskStore.getAsyncLayer();
    if (layer?.projectId !== this.projectId) {
      throw new RoomLegacyTaskTriageSnapshotReaderError(
        "project_store_unbound",
        "Room legacy task/triage snapshot reader requires a project-bound TaskStore matching its input scope.",
      );
    }

    const tasks = await this.taskStore.listTasks({ includeArchived: false, slim: true });
    const asOfMs = Date.parse(input.asOf);
    const snapshot = {
      activeTaskSlots: 0,
      activeTriageSlots: 0,
      queuedTaskSlots: 0,
      queuedTriageSlots: 0,
    };

    for (const task of tasks) {
      assertTaskShape(task);
      if (isActiveTask(task)) snapshot.activeTaskSlots += 1;
      if (isActiveTriage(task)) snapshot.activeTriageSlots += 1;
      if (isQueuedTask(task, asOfMs)) snapshot.queuedTaskSlots += 1;
      if (isQueuedTriage(task, asOfMs)) snapshot.queuedTriageSlots += 1;
    }

    return Object.freeze(snapshot);
  }
}

export function createRoomLegacyTaskTriageSnapshotReader(
  options: RoomLegacyTaskTriageSnapshotReaderOptionsV1,
): RoomGlobalConcurrencyPostgresLegacySnapshotReaderV1 {
  return new RoomLegacyTaskTriageSnapshotReader(options);
}

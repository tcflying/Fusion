import { describe, expect, it } from "vitest";

import type {
  RoomGlobalConcurrencyPostgresLegacySnapshotReadInputV1,
} from "@fusion/core";

import {
  createRoomLegacyTaskTriageSnapshotReader,
  RoomLegacyTaskTriageSnapshotReader,
  type RoomLegacyTaskTriageSnapshotTaskV1,
  type RoomLegacyTaskTriageSnapshotTaskStoreV1,
} from "../room-legacy-task-triage-snapshot-reader.js";

const PROJECT_ID = "project-legacy-snapshot";
const AS_OF = "2026-07-19T14:00:00.000Z";

function readInput(
  overrides: Partial<RoomGlobalConcurrencyPostgresLegacySnapshotReadInputV1> = {},
): RoomGlobalConcurrencyPostgresLegacySnapshotReadInputV1 {
  return {
    contractVersion: 1,
    projectId: PROJECT_ID,
    asOf: AS_OF,
    transaction: {} as RoomGlobalConcurrencyPostgresLegacySnapshotReadInputV1["transaction"],
    ...overrides,
  };
}

function task(
  overrides: Partial<RoomLegacyTaskTriageSnapshotTaskV1> = {},
): RoomLegacyTaskTriageSnapshotTaskV1 {
  return {
    column: "todo",
    ...overrides,
  };
}

function taskStore(
  tasks: readonly RoomLegacyTaskTriageSnapshotTaskV1[],
  projectId = PROJECT_ID,
): RoomLegacyTaskTriageSnapshotTaskStoreV1 {
  return {
    getAsyncLayer: () => ({ projectId }),
    listTasks: async () => tasks,
  };
}

describe("Room legacy task/triage snapshot reader", () => {
  it("counts the scheduler's definite active task and triage slot holders", async () => {
    const reader = new RoomLegacyTaskTriageSnapshotReader({
      projectId: PROJECT_ID,
      taskStore: taskStore([
        task({ column: "in-progress" }),
        task({ column: "in-progress", paused: true }),
        task({ column: "in-review", status: "reviewing" }),
        task({ column: "in-review", status: "merging", paused: true }),
        task({ column: "triage", status: "planning" }),
        task({ column: "todo", status: "planning" }),
      ]),
    });

    const snapshot = await reader.readSnapshot(readInput());

    expect(snapshot).toEqual({
      activeTaskSlots: 3,
      activeTriageSlots: 2,
      queuedTaskSlots: 0,
      queuedTriageSlots: 0,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it("counts only known, schedulable legacy task and triage queues", async () => {
    const reader = createRoomLegacyTaskTriageSnapshotReader({
      projectId: PROJECT_ID,
      taskStore: taskStore([
        task({ column: "todo" }),
        task({ column: "todo", status: "queued" }),
        task({ column: "triage" }),
        task({ column: "triage", status: "queued" }),
        task({ column: "triage", status: "needs-replan" }),
        task({ column: "triage", status: "plan-review-unavailable" }),
        task({ column: "todo", status: "needs-replan" }),
        task({ column: "triage", status: "planning" }),
        task({ column: "todo", paused: true }),
        task({ column: "triage", userPaused: true }),
        task({ column: "todo", nextRecoveryAt: "2026-07-19T14:01:00.000Z" }),
        task({ column: "triage", status: "awaiting-approval" }),
        task({ column: "triage", status: "failed" }),
        task({ column: "triage", status: "stuck-killed" }),
      ]),
    });

    await expect(reader.readSnapshot(readInput())).resolves.toEqual({
      activeTaskSlots: 0,
      activeTriageSlots: 1,
      queuedTaskSlots: 2,
      queuedTriageSlots: 5,
    });
  });

  it("does not promote archived, deleted, or unknown legacy state to an active slot", async () => {
    const reader = new RoomLegacyTaskTriageSnapshotReader({
      projectId: PROJECT_ID,
      taskStore: taskStore([
        task({ column: "archived", status: "planning" }),
        task({ column: "in-progress", deletedAt: "2026-07-19T13:00:00.000Z" }),
        task({ column: "in-review", status: "unknown-runtime-state" }),
        task({ column: "triage", status: "unknown-runtime-state" }),
        task({ column: "custom-workflow-column", status: "planning" }),
        task({ column: "todo", status: "unknown-runtime-state" }),
      ]),
    });

    await expect(reader.readSnapshot(readInput())).resolves.toEqual({
      activeTaskSlots: 0,
      activeTriageSlots: 0,
      queuedTaskSlots: 0,
      queuedTriageSlots: 0,
    });
  });

  it("rejects a reader invocation that does not match the TaskStore project binding", async () => {
    const reader = new RoomLegacyTaskTriageSnapshotReader({
      projectId: PROJECT_ID,
      taskStore: taskStore([], "project-other"),
    });

    await expect(reader.readSnapshot(readInput())).rejects.toThrow(/project-bound TaskStore/i);
    await expect(reader.readSnapshot(readInput({ projectId: "project-other" }))).rejects.toThrow(/project scope/i);
  });

  it("propagates TaskStore read failures so global concurrency fails closed", async () => {
    const failure = new Error("task store unavailable");
    const reader = new RoomLegacyTaskTriageSnapshotReader({
      projectId: PROJECT_ID,
      taskStore: {
        getAsyncLayer: () => ({ projectId: PROJECT_ID }),
        listTasks: async () => {
          throw failure;
        },
      },
    });

    await expect(reader.readSnapshot(readInput())).rejects.toBe(failure);
  });
});

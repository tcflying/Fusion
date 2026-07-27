import { describe, expect, it, vi } from "vitest";

import { ProjectEngine } from "../project-engine.js";
import {
  ROOM_PARTICIPANT_RUN_TASK_PROJECTION_CONTRACT_VERSION,
  RoomParticipantRunTaskProjector,
  type RoomParticipantRunTaskProjectionStore,
} from "../room-participant-run-task-projection.js";

const OBSERVED_AT = "2026-07-27T08:45:00.000Z";

function projectionStore() {
  return {
    logEntry: vi.fn().mockResolvedValue({ id: "task-room-1" }),
  } satisfies RoomParticipantRunTaskProjectionStore;
}

describe("RoomParticipantRunTaskProjector", () => {
  it.each(["review", "plan", "delegate"] as const)(
    "durably projects a %s participant into the owning Fusion run and task",
    async (operation) => {
      const store = projectionStore();
      const projector = new RoomParticipantRunTaskProjector({
        projectId: "project-room-1",
        store,
      });

      const result = await projector.record({
        roomId: "room-1",
        taskId: "task-room-1",
        fusionRunId: "fusion-run-1",
        fusionAgentId: "room-controller",
        operation,
        participantKey: "agent:critic",
        participantState: "succeeded",
        participantRunId: "happier-run-1",
        callId: "call-1",
        sidechainId: "sidechain-1",
        bindingId: "binding-1",
        observedAt: OBSERVED_AT,
        evidenceRef: "sha256:participant-state:aaaaaaaa",
      });

      expect(result).toEqual({
        contractVersion: ROOM_PARTICIPANT_RUN_TASK_PROJECTION_CONTRACT_VERSION,
        projectId: "project-room-1",
        roomId: "room-1",
        taskId: "task-room-1",
        fusionRunId: "fusion-run-1",
        fusionAgentId: "room-controller",
        operation,
        participantKey: "agent:critic",
        participantState: "succeeded",
        participantRunId: "happier-run-1",
        callId: "call-1",
        sidechainId: "sidechain-1",
        bindingId: "binding-1",
        observedAt: OBSERVED_AT,
        evidenceRef: "sha256:participant-state:aaaaaaaa",
      });
      expect(store.logEntry).toHaveBeenCalledWith(
        "task-room-1",
        `[room-participant] ${operation}/agent:critic: succeeded`,
        JSON.stringify({
          contractVersion: ROOM_PARTICIPANT_RUN_TASK_PROJECTION_CONTRACT_VERSION,
          projectId: "project-room-1",
          roomId: "room-1",
          operation,
          participantKey: "agent:critic",
          participantState: "succeeded",
          participantRunId: "happier-run-1",
          callId: "call-1",
          sidechainId: "sidechain-1",
          bindingId: "binding-1",
          observedAt: OBSERVED_AT,
          evidenceRef: "sha256:participant-state:aaaaaaaa",
        }),
        {
          runId: "fusion-run-1",
          agentId: "room-controller",
        },
      );
    },
  );

  it("exposes the same durable projection through ProjectEngine", async () => {
    const store = projectionStore();
    const engine = Object.create(ProjectEngine.prototype) as ProjectEngine;
    Object.assign(engine as object, {
      config: { projectId: "project-room-1" },
      runtime: { getTaskStore: () => store },
    });

    await engine.recordRoomParticipantRunTaskState({
      roomId: "room-1",
      taskId: "task-room-1",
      fusionRunId: "fusion-run-1",
      fusionAgentId: "room-controller",
      operation: "review",
      participantKey: "agent:reviewer",
      participantState: "running",
      participantRunId: "happier-run-2",
      bindingId: "binding-1",
      observedAt: OBSERVED_AT,
      evidenceRef: "sha256:participant-state:bbbbbbbb",
    });

    expect(store.logEntry).toHaveBeenCalledOnce();
    expect(store.logEntry).toHaveBeenCalledWith(
      "task-room-1",
      "[room-participant] review/agent:reviewer: running",
      expect.any(String),
      { runId: "fusion-run-1", agentId: "room-controller" },
    );
  });
});

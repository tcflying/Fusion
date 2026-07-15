import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeTask,
  noop,
  noopDelete,
  noopMerge,
  noopMove,
  noopOpenDetail,
  setupTaskDetailModalHooks,
} from "./TaskDetailModal.test-helpers";
import {
  buildHappierContinuationCommand,
  TaskDetailContent,
  type CliSessionSummaryRecord,
} from "../TaskDetailModal";

setupTaskDetailModalHooks();

describe("TaskDetailModal Happier direct session", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/happier-direct-session")) {
        return new Response(JSON.stringify({ connected: false, taskId: "FN-099" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ sessions: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads and shows the card on detail open before a terminal session exists", async () => {
    render(
      <TaskDetailContent
        task={makeTask({ column: "todo", paused: true, status: "paused" })}
        projectId="project-500"
        onMoveTask={noopMove}
        onDeleteTask={noopDelete}
        onMergeTask={noopMerge}
        onOpenDetail={noopOpenDetail}
        addToast={noop}
        initialTab="definition"
      />,
    );

    expect(screen.getByRole("heading", { name: "Happier Direct Session" })).toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(
      "/api/tasks/FN-099/happier-direct-session?projectId=project-500",
      expect.objectContaining({ method: "GET" }),
    ));
    expect(screen.queryByRole("button", { name: "Session" })).not.toBeInTheDocument();
  });

  it("preserves the existing terminal continuation command for a bound Happier session", () => {
    const session: CliSessionSummaryRecord = {
      id: "cli-1",
      taskId: "FN-099",
      projectId: "project-500",
      adapterId: "happier",
      nativeSessionId: "session'id",
      agentState: "done",
      terminationReason: null,
    };

    expect(buildHappierContinuationCommand(session)).toBe(
      "happier session send 'session''id' '<message>' --wait --timeout 300",
    );
  });
});

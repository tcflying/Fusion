import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  TaskDetailContent,
  type CliSessionSummaryRecord,
} from "../TaskDetailModal";

vi.mock("../SessionTerminal", () => ({
  SessionTerminal: () => <div aria-label="Session terminal surface" />,
}));

setupTaskDetailModalHooks();

describe("TaskDetailModal Happier direct session", () => {
  let cliSessions: CliSessionSummaryRecord[];
  const clipboardWrite = vi.fn();

  beforeEach(() => {
    cliSessions = [];
    clipboardWrite.mockReset();
    clipboardWrite.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/happier-direct-session")) {
        return new Response(JSON.stringify({ connected: false, taskId: "FN-099" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ sessions: cliSessions }), {
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

  it("opens the real Session tab and keeps continuation UI available alongside the new card", async () => {
    const session: CliSessionSummaryRecord = {
      id: "cli-1",
      taskId: "FN-099",
      projectId: "project-500",
      adapterId: "happier",
      nativeSessionId: "session'id",
      agentState: "done",
      terminationReason: null,
    };
    cliSessions = [session];
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

    const sessionTab = await screen.findByRole("button", { name: "Session" });
    fireEvent.click(sessionTab);

    expect(screen.getByRole("heading", { name: "Happier Direct Session" })).toBeInTheDocument();
    const continuation = await screen.findByTestId("happier-session-binding");
    expect(within(continuation).getByText("Happier Session ID")).toBeInTheDocument();
    expect(within(continuation).getByText("session'id")).toBeInTheDocument();
    fireEvent.click(within(continuation).getByRole("button", { name: "Copy session send command" }));

    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(
      "happier session send 'session''id' '<message>' --wait --timeout 300",
    ));
  });
});

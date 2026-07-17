import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  isSessionRoomControlPlaneEnabled,
  SESSION_ROOM_CONTROL_PLANE_FLAG,
} from "@fusion/core";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectHappierDirectSession,
  fetchHappierDirectSession,
  HappierDirectSessionApiError,
  type HappierDirectSessionConnected,
} from "../../api";
import { HappierDirectSessionCard } from "../HappierDirectSessionCard";

const disconnected = { connected: false, taskId: "FN-500" } as const;
const connected: HappierDirectSessionConnected = {
  connected: true,
  taskId: "FN-500",
  cliSessionId: "cli-executor-FN-500-primary",
  nativeSessionId: "native-session-abcdefghijklmnopqrstuvwxyz-0123456789",
  providerId: "codex",
  happierSessionId: "happier-session-abcdefghijklmnopqrstuvwxyz-0123456789",
  machineId: "machine-abcdefghijklmnopqrstuvwxyz-0123456789",
  serverProfileId: "server-abcdefghijklmnopqrstuvwxyz-0123456789",
  linkedAt: "2026-07-15T00:00:00.000Z",
  openUrl: "https://app.happier.dev/session/session-1?serverId=server-1",
};
const postConnected = {
  ...connected,
  created: true,
  agentId: "agent-happier-500",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Happier direct-session API", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GETs the task-scoped binding with the current project", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(disconnected));

    await expect(fetchHappierDirectSession("FN / 5", "project / 5")).resolves.toEqual(disconnected);

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/FN%20%2F%205/happier-direct-session?projectId=project+%2F+5",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("POSTs the exact URI and optional machine ID without normalizing either value", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(postConnected));
    const uri = "happier://direct/session?provider=codex&name=$(whoami)  ";
    const machineId = "machine id; echo untouched";

    const response = await connectHappierDirectSession("FN-500", "project-500", { uri, machineId });

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/tasks/FN-500/happier-direct-session",
    );
    expect(request).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(request.body))).toEqual({ projectId: "project-500", uri, machineId });
    expect(response.created).toBe(true);
    expect(response.agentId).toBe("agent-happier-500");
  });

  it("throws a coded error with server details intact", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      error: "Happier daemon is unavailable",
      details: { code: "daemon_unavailable", retryable: true },
    }, 503));

    await expect(fetchHappierDirectSession("FN-500", "project-500")).rejects.toMatchObject({
      name: "HappierDirectSessionApiError",
      code: "daemon_unavailable",
      status: 503,
      details: { code: "daemon_unavailable", retryable: true },
    });
    expect(HappierDirectSessionApiError).toBeTypeOf("function");
  });
});

describe("HappierDirectSessionCard", () => {
  const fetchMock = vi.fn();
  const openMock = vi.fn();
  const clipboardWrite = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    openMock.mockReset();
    clipboardWrite.mockReset();
    clipboardWrite.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("open", openMock);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWrite },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the legacy task-detail connection card while the Room gate is off", async () => {
    expect(
      isSessionRoomControlPlaneEnabled({
        experimentalFeatures: { [SESSION_ROOM_CONTROL_PLANE_FLAG]: false },
      }),
    ).toBe(false);
    fetchMock.mockResolvedValueOnce(jsonResponse(disconnected));

    render(<HappierDirectSessionCard taskId="FN-500" projectId="project-500" taskPaused />);

    expect(screen.getByRole("heading", { name: "Happier Direct Session" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("is visible before a live process exists and loads the binding on detail open", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(disconnected));

    render(<HappierDirectSessionCard taskId="FN-500" projectId="project-500" taskPaused />);

    expect(screen.getByRole("heading", { name: "Happier Direct Session" })).toBeInTheDocument();
    expect(screen.getByLabelText("Native Session URI")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(screen.getByText("Machine ID (optional)")).toBeInTheDocument();
    expect(screen.getByText(/does not start the Fusion task/i)).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("deduplicates a pending Connect, updates connected IDs, and opens Happier", async () => {
    const user = userEvent.setup();
    let resolvePost!: (response: Response) => void;
    const postResponse = new Promise<Response>((resolvePromise) => { resolvePost = resolvePromise; });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(disconnected))
      .mockImplementationOnce(() => postResponse);
    openMock.mockReturnValue({ closed: false });
    render(<HappierDirectSessionCard taskId="FN-500" projectId="project-500" taskPaused />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const uri = "happier://direct/session?provider=codex&name=exact value";
    await user.type(screen.getByLabelText("Native Session URI"), uri);
    fireEvent.click(screen.getByText("Machine ID (optional)"));
    await user.type(screen.getByLabelText("Machine ID"), "machine exact");
    const connect = screen.getByRole("button", { name: "Connect" });
    await user.click(connect);
    await user.click(connect);

    expect(connect).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body))).toEqual({
      projectId: "project-500",
      uri,
      machineId: "machine exact",
    });

    await act(async () => { resolvePost(jsonResponse(connected)); });

    expect(await screen.findByText("Bound, not running")).toBeInTheDocument();
    expect(screen.getByText("codex")).toBeInTheDocument();
    expect(screen.getByText(connected.nativeSessionId)).toBeInTheDocument();
    expect(screen.getByText(connected.happierSessionId)).toBeInTheDocument();
    expect(screen.getByText(connected.machineId)).toBeInTheDocument();
    expect(screen.getByText(connected.serverProfileId)).toBeInTheDocument();
    expect(screen.getByText("Server/profile ID")).toBeInTheDocument();
    expect(openMock).toHaveBeenCalledWith(connected.openUrl, "_blank", "noopener,noreferrer");
  });

  it("resets identity-bound form and candidate state when the selected task changes", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(disconnected))
      .mockResolvedValueOnce(jsonResponse({
        error: "Choose a machine",
        details: {
          code: "candidate_ambiguous",
          candidates: [{ machineId: "machine-a", label: "Workstation A" }],
        },
      }, 409))
      .mockResolvedValueOnce(jsonResponse({ connected: false, taskId: "FN-501" }));
    const view = render(<HappierDirectSessionCard taskId="FN-500" projectId="project-500" taskPaused />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await user.type(screen.getByLabelText("Native Session URI"), "happier://direct/codex/remote-a");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await user.selectOptions(await screen.findByLabelText("Machine ID"), "machine-a");

    view.rerender(<HappierDirectSessionCard taskId="FN-501" projectId="project-501" taskPaused />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(screen.getByLabelText("Native Session URI")).toHaveValue("");
    expect(screen.getByText("Machine ID (optional)")).toBeInTheDocument();
    expect(screen.getByLabelText("Machine ID")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });

  it("ignores a stale POST result and releases pending state after a deterministic task rerender race", async () => {
    const user = userEvent.setup();
    const stalePost = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(disconnected))
      .mockImplementationOnce(() => stalePost.promise)
      .mockResolvedValueOnce(jsonResponse({ connected: false, taskId: "FN-501" }));
    const view = render(<HappierDirectSessionCard taskId="FN-500" projectId="project-500" taskPaused />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await user.type(screen.getByLabelText("Native Session URI"), "happier://direct/codex/remote-a");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByRole("button", { name: "Connecting…" })).toBeDisabled();

    view.rerender(<HappierDirectSessionCard taskId="FN-501" projectId="project-501" taskPaused />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(screen.getByLabelText("Native Session URI")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
    await act(async () => { stalePost.resolve(jsonResponse(postConnected)); });
    expect(screen.queryByText(connected.nativeSessionId)).not.toBeInTheDocument();
    expect(openMock).not.toHaveBeenCalled();
  });

  it("invalidates a pending successful POST when the card unmounts", async () => {
    const user = userEvent.setup();
    const stalePost = deferred<Response>();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock
      .mockResolvedValueOnce(jsonResponse(disconnected))
      .mockImplementationOnce(() => stalePost.promise);
    openMock.mockReturnValue({ closed: false });
    const view = render(<HappierDirectSessionCard taskId="FN-500" projectId="project-500" taskPaused />);

    try {
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await user.type(screen.getByLabelText("Native Session URI"), "happier://direct/codex/remote-a");
      await user.click(screen.getByRole("button", { name: "Connect" }));
      view.unmount();

      await act(async () => { stalePost.resolve(jsonResponse(postConnected)); });

      expect(openMock).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(consoleError.mock.calls.some(([message]) => (
        /state update.*unmounted component/i.test(String(message))
      ))).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not start a partial-binding refresh after the card unmounts", async () => {
    const user = userEvent.setup();
    const stalePost = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(disconnected))
      .mockImplementationOnce(() => stalePost.promise);
    const view = render(<HappierDirectSessionCard taskId="FN-500" projectId="project-500" taskPaused />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await user.type(screen.getByLabelText("Native Session URI"), "happier://direct/codex/remote-a");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    view.unmount();

    await act(async () => {
      stalePost.resolve(jsonResponse({
        error: "Session bound, but bridge assignment failed",
        details: {
          code: "HAPPIER_SESSION_BOUND_ASSIGNMENT_FAILED",
          sessionBound: true,
          nativeSessionId: connected.nativeSessionId,
        },
      }, 500));
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(openMock).not.toHaveBeenCalled();
  });

  it("ignores a stale partial-binding refresh that resolves after the task changes", async () => {
    const user = userEvent.setup();
    const staleRefresh = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(disconnected))
      .mockResolvedValueOnce(jsonResponse({
        error: "Session bound, but bridge assignment failed",
        details: {
          code: "HAPPIER_SESSION_BOUND_ASSIGNMENT_FAILED",
          sessionBound: true,
          nativeSessionId: connected.nativeSessionId,
        },
      }, 500))
      .mockImplementationOnce(() => staleRefresh.promise)
      .mockResolvedValueOnce(jsonResponse({ connected: false, taskId: "FN-501" }));
    const view = render(<HappierDirectSessionCard taskId="FN-500" projectId="project-500" taskPaused />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await user.type(screen.getByLabelText("Native Session URI"), "happier://direct/codex/remote-a");
    await user.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    view.rerender(<HappierDirectSessionCard taskId="FN-501" projectId="project-501" taskPaused />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    await act(async () => { staleRefresh.resolve(jsonResponse(connected)); });

    expect(screen.queryByText(connected.nativeSessionId)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
  });

  it("keeps the connected state and exposes a fallback link when the popup is blocked", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(disconnected))
      .mockResolvedValueOnce(jsonResponse(connected));
    openMock.mockReturnValue(null);
    render(<HappierDirectSessionCard taskId="FN-500" projectId="project-500" taskPaused={false} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await user.type(screen.getByLabelText("Native Session URI"), "happier://direct/codex/remote-1");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open in Happier (popup blocked)" })).toHaveAttribute(
      "href",
      connected.openUrl,
    );
  });

  it.each([
    ["daemon_unavailable", "Happier daemon is unavailable"],
    ["auth_required", "Happier authentication is required"],
    ["candidate_not_found", "No matching Happier session was found"],
  ])("shows stable %s failures and retries the same request", async (code, message) => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(disconnected))
      .mockResolvedValueOnce(jsonResponse({ error: message, details: { code } }, 409))
      .mockResolvedValueOnce(jsonResponse(connected));
    openMock.mockReturnValue({ closed: false });
    render(<HappierDirectSessionCard taskId="FN-500" projectId="project-500" taskPaused />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await user.type(screen.getByLabelText("Native Session URI"), "happier://direct/codex/remote-1");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(code);
    expect(alert).toHaveTextContent(message);
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Bound, not running")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).body).toBe(
      (fetchMock.mock.calls[1]?.[1] as RequestInit).body,
    );
  });

  it("turns an ambiguous candidate error into a machine selector", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(disconnected))
      .mockResolvedValueOnce(jsonResponse({
        error: "Choose a machine",
        details: {
          code: "candidate_ambiguous",
          candidates: [
            { machineId: "machine-a", label: "Workstation A" },
            { machineId: "machine-b", label: "Workstation B" },
          ],
        },
      }, 409))
      .mockResolvedValueOnce(jsonResponse(connected));
    openMock.mockReturnValue({ closed: false });
    render(<HappierDirectSessionCard taskId="FN-500" projectId="project-500" taskPaused />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await user.type(screen.getByLabelText("Native Session URI"), "happier://direct/codex/remote-1");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    const selector = await screen.findByLabelText("Machine ID");
    expect(selector.tagName).toBe("SELECT");
    await user.selectOptions(selector, "machine-b");
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body))).toEqual({
      projectId: "project-500",
      uri: "happier://direct/codex/remote-1",
      machineId: "machine-b",
    });
  });

  it("expands the optional machine ID after an ambiguity response without candidates", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(disconnected))
      .mockResolvedValueOnce(jsonResponse({
        error: "Choose a machine",
        details: { code: "candidate_ambiguous" },
      }, 409));
    render(<HappierDirectSessionCard taskId="FN-500" projectId="project-500" taskPaused />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await user.type(screen.getByLabelText("Native Session URI"), "happier://direct/codex/remote-1");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    const details = (await screen.findByText("Machine ID (optional)")).closest("details");
    expect(details).toHaveAttribute("open");
    expect(screen.getByLabelText("Machine ID")).toBeInTheDocument();
  });

  it("refreshes a successfully bound session while preserving an assignment failure and retry", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(disconnected))
      .mockResolvedValueOnce(jsonResponse({
        error: "Session bound, but bridge assignment failed",
        details: {
          code: "HAPPIER_SESSION_BOUND_ASSIGNMENT_FAILED",
          sessionBound: true,
          nativeSessionId: connected.nativeSessionId,
        },
      }, 500))
      .mockResolvedValueOnce(jsonResponse(connected));
    render(<HappierDirectSessionCard taskId="FN-500" projectId="project-500" taskPaused />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await user.type(screen.getByLabelText("Native Session URI"), "happier://direct/codex/remote-1");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    expect(await screen.findByText("Bound, not running")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("HAPPIER_SESSION_BOUND_ASSIGNMENT_FAILED");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps the original partial-binding error when the binding refresh also fails", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(disconnected))
      .mockResolvedValueOnce(jsonResponse({
        error: "Session bound, but bridge assignment failed",
        details: {
          code: "HAPPIER_SESSION_BOUND_ASSIGNMENT_FAILED",
          sessionBound: true,
          nativeSessionId: connected.nativeSessionId,
        },
      }, 500))
      .mockResolvedValueOnce(jsonResponse({
        error: "Refresh temporarily unavailable",
        details: { code: "HAPPIER_DAEMON_UNAVAILABLE" },
      }, 503));
    render(<HappierDirectSessionCard taskId="FN-500" projectId="project-500" taskPaused />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await user.type(screen.getByLabelText("Native Session URI"), "happier://direct/codex/remote-1");
    await user.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.queryByText(connected.nativeSessionId)).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("HAPPIER_SESSION_BOUND_ASSIGNMENT_FAILED");
    expect(screen.getByRole("alert")).toHaveTextContent("Session bound, but bridge assignment failed");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("wraps long IDs and gives each full value an accessible copy action", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(connected));
    render(<HappierDirectSessionCard taskId="FN-500" projectId="project-500" taskPaused />);

    expect(await screen.findByText(connected.nativeSessionId)).toHaveClass("happier-direct-session-card__id-value");
    for (const [label, value] of [
      ["Copy native session ID", connected.nativeSessionId],
      ["Copy Happier session ID", connected.happierSessionId],
      ["Copy machine ID", connected.machineId],
      ["Copy server/profile ID", connected.serverProfileId],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(clipboardWrite).toHaveBeenLastCalledWith(value);
    }
  });

  it("offers an accessible manual-copy fallback when the Clipboard API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    fetchMock.mockResolvedValueOnce(jsonResponse(connected));
    render(<HappierDirectSessionCard taskId="FN-500" projectId="project-500" taskPaused />);
    await screen.findByText(connected.nativeSessionId);

    fireEvent.click(screen.getByRole("button", { name: "Copy native session ID" }));

    const fallback = await screen.findByRole("alert");
    expect(fallback).toHaveTextContent("Native session ID could not be copied");
    expect(fallback).toHaveTextContent(connected.nativeSessionId);
  });

  it("keeps controls shrinkable inside a narrow host and declares stacked mobile actions", () => {
    const css = readFileSync(resolve(__dirname, "../TaskDetailModal.css"), "utf8");
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    fetchMock.mockResolvedValueOnce(jsonResponse(disconnected));
    const { container } = render(
      <div style={{ width: 320, maxWidth: 320, overflowX: "auto" }}>
        <HappierDirectSessionCard taskId="FN-500" projectId="project-500" taskPaused />
      </div>,
    );
    const card = container.querySelector(".happier-direct-session-card") as HTMLElement;
    const formRow = container.querySelector(".happier-direct-session-card__form-row") as HTMLElement;
    const uriInput = screen.getByLabelText("Native Session URI");

    expect(window.getComputedStyle(card).maxWidth).toBe("100%");
    expect(window.getComputedStyle(card).overflowX).toBe("hidden");
    expect(window.getComputedStyle(formRow).minWidth).toBe("0px");
    expect(window.getComputedStyle(uriInput).minWidth).toBe("0px");
    expect(css).toMatch(/\.happier-direct-session-card__form-row\s*\{[^}]*min-width:\s*0/s);
    expect(css).toMatch(/\.happier-direct-session-card__id-value\s*\{[^}]*overflow-wrap:\s*anywhere/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*\.happier-direct-session-card__actions\s*\{[^}]*flex-direction:\s*column/s);
    expect(css).toMatch(/@media\s*\(max-width:\s*768px\)[\s\S]*\.happier-direct-session-card__form-row\s*\{[^}]*flex-direction:\s*column/s);
    style.remove();
  });
});

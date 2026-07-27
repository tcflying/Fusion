import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomCockpitCommandPanel } from "../RoomCockpitCommandPanel";

afterEach(() => {
  cleanup();
});

describe("RoomCockpitCommandPanel", () => {
  it("keeps the route launcher compact until the operator explicitly chooses a command", async () => {
    const user = userEvent.setup();
    const commandIdFactory = vi.fn(() => "explicit-command-1");

    render(
      <RoomCockpitCommandPanel
        projectId="project-live"
        activeRoomId="room-live"
        initiallyExpanded={false}
        commandIdFactory={commandIdFactory}
      />,
    );

    expect(screen.getByRole("heading", { name: "Room command console" })).toBeVisible();
    expect(screen.queryByLabelText("Command ID")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send operator action" })).not.toBeInTheDocument();
    expect(commandIdFactory).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Open Room command console" }));
    expect(commandIdFactory).toHaveBeenCalledWith("create");
    await user.click(screen.getByRole("button", { name: "Send operator action" }));
    expect(screen.getByLabelText("Command ID")).toHaveValue("explicit-command-1");
    expect(screen.getByLabelText("Target Room ID")).toHaveValue("room-live");
  });

  it("reviews and confirms an explicit existing-session Room create before recording the accepted audit result", async () => {
    const user = userEvent.setup();
    const fetchCommand = vi.fn(async () => new Response(
      JSON.stringify({ accepted: true, aggregateVersion: 1 }),
      { status: 201, headers: { "content-type": "application/json" } },
    ));

    render(
      <RoomCockpitCommandPanel
        projectId="project-live"
        fetchCommand={fetchCommand}
        commandIdFactory={() => "create-room-command-1"}
        now={() => "2026-07-27T06:31:00.000+08:00"}
      />,
    );

    expect(screen.getByLabelText("Command ID")).toHaveValue("create-room-command-1");
    expect(screen.getByLabelText("Expected aggregate version (CAS)")).toHaveValue(0);
    expect(screen.getByLabelText("Server profile")).toBeVisible();
    expect(screen.getByLabelText("Machine")).toBeVisible();
    expect(screen.getByLabelText("Provider")).toBeVisible();
    expect(screen.getByLabelText("Native Session")).toBeVisible();
    expect(screen.getByLabelText("Model")).toBeVisible();
    expect(screen.getByLabelText("Permission scope")).toBeVisible();
    expect(screen.getByLabelText("Health")).toBeVisible();
    expect(screen.getByText(/never auto-creates capability certification/i)).toBeVisible();

    fireEvent.change(screen.getByLabelText("New Room ID"), { target: { value: "room-live" } });
    fireEvent.change(screen.getByLabelText("Objective"), { target: { value: "Coordinate two verified existing Sessions." } });
    fireEvent.change(screen.getByLabelText("Seat ID"), { target: { value: "seat-codex" } });
    fireEvent.change(screen.getByLabelText("Binding ID"), { target: { value: "binding-codex-1" } });
    fireEvent.change(screen.getByLabelText("Canonical Session URI"), { target: { value: "codex://threads/thread-1" } });
    fireEvent.change(screen.getByLabelText("Host ID"), { target: { value: "windows-host-1" } });
    fireEvent.change(screen.getByLabelText("Server profile"), { target: { value: "server-local" } });
    fireEvent.change(screen.getByLabelText("Machine"), { target: { value: "machine-1" } });
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "codex" } });
    fireEvent.change(screen.getByLabelText("Native Session"), { target: { value: "thread-1" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-5.6-sol" } });
    fireEvent.change(screen.getByLabelText("Permission scope"), { target: { value: "room:message, candidate:review" } });
    fireEvent.change(screen.getByLabelText("Health"), { target: { value: "healthy" } });
    fireEvent.change(screen.getByLabelText("Session idempotency key"), { target: { value: "ensure-codex-1" } });
    fireEvent.change(screen.getByLabelText("Capability snapshot JSON"), {
      target: {
        value: JSON.stringify({
          contractVersion: 1,
          snapshotId: "operator-certified-snapshot-1",
          revision: 1,
          capturedAt: "2026-07-27T06:00:00.000Z",
          bindings: [],
        }),
      },
    });
    fireEvent.change(screen.getByLabelText("Role constraints JSON"), {
      target: { value: JSON.stringify({ locks: [], forbids: [] }) },
    });

    await user.click(screen.getByRole("button", { name: "Review create command" }));

    expect(fetchCommand).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Confirm create from existing sessions" })).toBeVisible();
    expect(screen.getByText("create-room-command-1")).toBeVisible();
    expect(screen.getByText("server-local / machine-1 / codex / thread-1 / gpt-5.6-sol / room:message, candidate:review / healthy")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Confirm and execute create" }));

    await waitFor(() => expect(fetchCommand).toHaveBeenCalledTimes(1));
    const [path, init] = fetchCommand.mock.calls[0] ?? [];
    expect(path).toBe("/api/rooms?projectId=project-live");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(init?.body))).toEqual({
      expectedAggregateVersion: 0,
      commandId: "create-room-command-1",
      payload: {
        room: {
          id: "room-live",
          objective: "Coordinate two verified existing Sessions.",
          protocolId: "fusion-room",
          protocolVersion: 1,
        },
        sessions: [{
          seatId: "seat-codex",
          bindingId: "binding-codex-1",
          role: "participant",
          permissionScope: ["room:message", "candidate:review"],
          connectorId: "happier-runtime",
          canonicalSessionUri: "codex://threads/thread-1",
          requiredHostId: "windows-host-1",
          requiredMachineId: "machine-1",
          idempotencyKey: "ensure-codex-1",
        }],
        roleAssignment: {
          capabilitySnapshot: {
            contractVersion: 1,
            snapshotId: "operator-certified-snapshot-1",
            revision: 1,
            capturedAt: "2026-07-27T06:00:00.000Z",
            bindings: [],
          },
          constraints: { locks: [], forbids: [] },
        },
      },
    });
    expect(screen.getByRole("list", { name: "Room command audit results" })).toHaveTextContent(
      "create-room-command-1",
    );
    expect(screen.getByRole("list", { name: "Room command audit results" })).toHaveTextContent(
      "accepted at aggregate version 1",
    );
  });

  it("adds multiple existing Session drafts only after an explicit operator click and submits every reviewed binding", async () => {
    const user = userEvent.setup();
    const fetchCommand = vi.fn(async () => new Response(
      JSON.stringify({ accepted: true, aggregateVersion: 1 }),
      { status: 201, headers: { "content-type": "application/json" } },
    ));

    render(
      <RoomCockpitCommandPanel
        projectId="project-live"
        fetchCommand={fetchCommand}
        commandIdFactory={() => "create-multi-session-command-1"}
      />,
    );

    expect(screen.queryByRole("group", { name: "Existing Session 2" })).not.toBeInTheDocument();
    expect(fetchCommand).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Add another existing Session" }));
    expect(screen.getByRole("group", { name: "Existing Session 2" })).toBeVisible();
    expect(fetchCommand).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("New Room ID"), { target: { value: "room-multi" } });
    fireEvent.change(screen.getByLabelText("Objective"), { target: { value: "Coordinate reviewed existing Sessions." } });

    const fillSession = (
      ordinal: number,
      values: {
        readonly seatId: string;
        readonly bindingId: string;
        readonly sessionUri: string;
        readonly hostId: string;
        readonly server: string;
        readonly machine: string;
        readonly provider: string;
        readonly nativeSession: string;
        readonly model: string;
        readonly permission: string;
        readonly idempotencyKey: string;
      },
    ): void => {
      const sessionGroup = within(screen.getByRole("group", { name: `Existing Session ${ordinal}` }));
      fireEvent.change(sessionGroup.getByLabelText("Seat ID"), { target: { value: values.seatId } });
      fireEvent.change(sessionGroup.getByLabelText("Binding ID"), { target: { value: values.bindingId } });
      fireEvent.change(sessionGroup.getByLabelText("Canonical Session URI"), { target: { value: values.sessionUri } });
      fireEvent.change(sessionGroup.getByLabelText("Host ID"), { target: { value: values.hostId } });
      fireEvent.change(sessionGroup.getByLabelText("Server profile"), { target: { value: values.server } });
      fireEvent.change(sessionGroup.getByLabelText("Machine"), { target: { value: values.machine } });
      fireEvent.change(sessionGroup.getByLabelText("Provider"), { target: { value: values.provider } });
      fireEvent.change(sessionGroup.getByLabelText("Native Session"), { target: { value: values.nativeSession } });
      fireEvent.change(sessionGroup.getByLabelText("Model"), { target: { value: values.model } });
      fireEvent.change(sessionGroup.getByLabelText("Permission scope"), { target: { value: values.permission } });
      fireEvent.change(sessionGroup.getByLabelText("Health"), { target: { value: "healthy" } });
      fireEvent.change(sessionGroup.getByLabelText("Session idempotency key"), {
        target: { value: values.idempotencyKey },
      });
    };

    fillSession(1, {
      seatId: "seat-codex",
      bindingId: "binding-codex",
      sessionUri: "codex://threads/thread-1",
      hostId: "windows-host-1",
      server: "server-local",
      machine: "machine-1",
      provider: "openai",
      nativeSession: "thread-1",
      model: "gpt-5",
      permission: "read,write",
      idempotencyKey: "session-command-codex",
    });
    fillSession(2, {
      seatId: "seat-opencode",
      bindingId: "binding-opencode",
      sessionUri: "opencode://sessions/session-2",
      hostId: "windows-host-2",
      server: "server-remote",
      machine: "machine-2",
      provider: "opencode",
      nativeSession: "session-2",
      model: "operator-model",
      permission: "read",
      idempotencyKey: "session-command-opencode",
    });
    fireEvent.change(screen.getByLabelText("Capability snapshot JSON"), {
      target: { value: JSON.stringify({ certificationId: "cert-1" }) },
    });
    fireEvent.change(screen.getByLabelText("Role constraints JSON"), {
      target: { value: JSON.stringify({ maxParticipants: 2 }) },
    });

    await user.click(screen.getByRole("button", { name: "Review create command" }));
    expect(fetchCommand).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm and execute create" }));
    await waitFor(() => expect(fetchCommand).toHaveBeenCalledTimes(1));

    const [, init] = fetchCommand.mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body));
    expect(body.payload.sessions).toEqual([
      {
        seatId: "seat-codex",
        bindingId: "binding-codex",
        role: "participant",
        permissionScope: ["read", "write"],
        connectorId: "happier-runtime",
        canonicalSessionUri: "codex://threads/thread-1",
        requiredHostId: "windows-host-1",
        requiredMachineId: "machine-1",
        idempotencyKey: "session-command-codex",
      },
      {
        seatId: "seat-opencode",
        bindingId: "binding-opencode",
        role: "participant",
        permissionScope: ["read"],
        connectorId: "happier-runtime",
        canonicalSessionUri: "opencode://sessions/session-2",
        requiredHostId: "windows-host-2",
        requiredMachineId: "machine-2",
        idempotencyKey: "session-command-opencode",
      },
    ]);
  });

  it("stages an attach request with explicit membership CAS and Session evidence before sending the canonical add action", async () => {
    const user = userEvent.setup();
    const fetchCommand = vi.fn(async () => new Response(
      JSON.stringify({ accepted: true, aggregateVersion: 9 }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    render(
      <RoomCockpitCommandPanel
        projectId="project-live"
        activeRoomId="room-live"
        fetchCommand={fetchCommand}
        commandIdFactory={(operation) => operation === "attach" ? "add-session-command-1" : "unused-command"}
        now={() => "2026-07-27T06:39:00.000+08:00"}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Attach / add existing Session" }));

    expect(screen.getByLabelText("Target Room ID")).toHaveValue("room-live");
    fireEvent.change(screen.getByLabelText("Expected aggregate version (CAS)"), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("Expected membership version"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Membership change ID"), { target: { value: "change-add-opencode" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Add an independent reviewer" } });
    fireEvent.change(screen.getByLabelText("Seat ID"), { target: { value: "seat-opencode" } });
    fireEvent.change(screen.getByLabelText("Binding ID"), { target: { value: "binding-opencode-1" } });
    fireEvent.change(screen.getByLabelText("Canonical Session URI"), { target: { value: "opencode://sessions/session-3" } });
    fireEvent.change(screen.getByLabelText("Host ID"), { target: { value: "windows-host-1" } });
    fireEvent.change(screen.getByLabelText("Server profile"), { target: { value: "server-local" } });
    fireEvent.change(screen.getByLabelText("Machine"), { target: { value: "machine-1" } });
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "opencode" } });
    fireEvent.change(screen.getByLabelText("Native Session"), { target: { value: "session-3" } });
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-5.6-terra" } });
    fireEvent.change(screen.getByLabelText("Permission scope"), { target: { value: "room:message" } });
    fireEvent.change(screen.getByLabelText("Health"), { target: { value: "healthy" } });
    fireEvent.change(screen.getByLabelText("Session idempotency key"), { target: { value: "ensure-opencode-1" } });

    await user.click(screen.getByRole("button", { name: "Review attach command" }));

    expect(fetchCommand).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Confirm attach / add existing Session" })).toBeVisible();
    expect(screen.getByText("server-local / machine-1 / opencode / session-3 / gpt-5.6-terra / room:message / healthy")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Confirm and execute attach" }));

    await waitFor(() => expect(fetchCommand).toHaveBeenCalledTimes(1));
    const [path, init] = fetchCommand.mock.calls[0] ?? [];
    expect(path).toBe("/api/rooms/room-live/actions?projectId=project-live");
    expect(JSON.parse(String(init?.body))).toEqual({
      expectedAggregateVersion: 8,
      commandId: "add-session-command-1",
      action: "request_add_existing_session",
      payload: {
        expectedMembershipVersion: 4,
        changeId: "change-add-opencode",
        reason: "Add an independent reviewer",
        session: {
          seatId: "seat-opencode",
          bindingId: "binding-opencode-1",
          role: "participant",
          permissionScope: ["room:message"],
          connectorId: "happier-runtime",
          canonicalSessionUri: "opencode://sessions/session-3",
          requiredHostId: "windows-host-1",
          requiredMachineId: "machine-1",
          idempotencyKey: "ensure-opencode-1",
        },
      },
    });
    expect(screen.getByRole("list", { name: "Room command audit results" })).toHaveTextContent(
      "attach / add-session-command-1",
    );
  });

  it("restores only the selected Room durable bindings after a separate CAS confirmation", async () => {
    const user = userEvent.setup();
    const fetchCommand = vi.fn(async () => new Response(
      JSON.stringify({ accepted: true, aggregateVersion: 8 }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    render(
      <RoomCockpitCommandPanel
        projectId="project-live"
        activeRoomId="room-live"
        fetchCommand={fetchCommand}
        commandIdFactory={(operation) => operation === "restore" ? "restore-room-command-1" : "unused-command"}
        now={() => "2026-07-27T06:42:00.000+08:00"}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Restore existing Sessions" }));
    fireEvent.change(screen.getByLabelText("Expected aggregate version (CAS)"), { target: { value: "8" } });
    await user.click(screen.getByRole("button", { name: "Review restore command" }));

    expect(fetchCommand).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Confirm restore existing Sessions" })).toBeVisible();
    expect(screen.getByText(/uses only the Room's durable canonical bindings/i)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Confirm and execute restore" }));

    await waitFor(() => expect(fetchCommand).toHaveBeenCalledTimes(1));
    const [path, init] = fetchCommand.mock.calls[0] ?? [];
    expect(path).toBe("/api/rooms/room-live/actions?projectId=project-live");
    expect(JSON.parse(String(init?.body))).toEqual({
      expectedAggregateVersion: 8,
      commandId: "restore-room-command-1",
      action: "restore_existing_sessions",
      payload: {},
    });
    expect(screen.getByRole("list", { name: "Room command audit results" })).toHaveTextContent(
      "restore / restore-room-command-1",
    );
  });

  it("requires confirmation for participant exit and exposes a rejected CAS audit without claiming removal", async () => {
    const user = userEvent.setup();
    const fetchCommand = vi.fn(async () => new Response(
      JSON.stringify({
        details: {
          code: "ROOM_AGGREGATE_VERSION_CONFLICT",
          currentAggregateVersion: 9,
        },
      }),
      { status: 409, headers: { "content-type": "application/json" } },
    ));

    render(
      <RoomCockpitCommandPanel
        projectId="project-live"
        activeRoomId="room-live"
        fetchCommand={fetchCommand}
        commandIdFactory={(operation) => operation === "remove" ? "remove-session-command-1" : "unused-command"}
        now={() => "2026-07-27T06:44:00.000+08:00"}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Remove / exit participant" }));
    fireEvent.change(screen.getByLabelText("Expected aggregate version (CAS)"), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("Expected membership version"), { target: { value: "4" } });
    fireEvent.change(screen.getByLabelText("Membership change ID"), { target: { value: "change-remove-opencode" } });
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Reviewer completed the assignment" } });
    fireEvent.change(screen.getByLabelText("Seat ID to remove"), { target: { value: "seat-opencode" } });

    await user.click(screen.getByRole("button", { name: "Review remove command" }));
    expect(fetchCommand).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Confirm remove / exit participant" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Confirm and execute remove" }));

    await waitFor(() => expect(fetchCommand).toHaveBeenCalledTimes(1));
    const [path, init] = fetchCommand.mock.calls[0] ?? [];
    expect(path).toBe("/api/rooms/room-live/actions?projectId=project-live");
    expect(JSON.parse(String(init?.body))).toEqual({
      expectedAggregateVersion: 8,
      commandId: "remove-session-command-1",
      action: "request_remove_existing_session",
      payload: {
        expectedMembershipVersion: 4,
        changeId: "change-remove-opencode",
        reason: "Reviewer completed the assignment",
        seatId: "seat-opencode",
      },
    });
    const audit = screen.getByRole("list", { name: "Room command audit results" });
    expect(audit).toHaveTextContent("remove / remove-session-command-1");
    expect(audit).toHaveTextContent("rejected by CAS; current aggregate version 9");
    expect(audit).not.toHaveTextContent("accepted");
  });

  it("sends an operator action only after reviewing an explicit authority envelope and CAS", async () => {
    const user = userEvent.setup();
    const fetchCommand = vi.fn(async () => new Response(
      JSON.stringify({ accepted: true, aggregateVersion: 9 }),
      { status: 202, headers: { "content-type": "application/json" } },
    ));

    render(
      <RoomCockpitCommandPanel
        projectId="project-live"
        activeRoomId="room-live"
        fetchCommand={fetchCommand}
        commandIdFactory={(operation) => operation === "send" ? "send-operator-command-1" : "unused-command"}
        now={() => "2026-07-27T06:49:00.000+08:00"}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Send operator action" }));
    fireEvent.change(screen.getByLabelText("Expected aggregate version (CAS)"), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("Target Seat ID"), { target: { value: "seat-codex" } });
    fireEvent.change(screen.getByLabelText("Message intent"), { target: { value: "instruction" } });
    fireEvent.change(screen.getByLabelText("Operator message"), {
      target: { value: "Review the verified candidate before the next Room decision." },
    });
    fireEvent.change(screen.getByLabelText("Authority envelope JSON"), {
      target: { value: JSON.stringify({ envelope: "operator-provided-authority" }) },
    });

    expect(screen.getByText(/never creates, mints, or infers an authority envelope/i)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Review operator action" }));
    expect(fetchCommand).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Confirm send operator action" })).toBeVisible();
    expect(screen.getByText(
      "The Cockpit forwards only the operator-provided authority envelope; it does not mint, sign, expand, or validate authority.",
    )).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Confirm and execute send" }));

    await waitFor(() => expect(fetchCommand).toHaveBeenCalledTimes(1));
    const [path, init] = fetchCommand.mock.calls[0] ?? [];
    expect(path).toBe("/api/rooms/room-live/actions?projectId=project-live");
    expect(JSON.parse(String(init?.body))).toEqual({
      expectedAggregateVersion: 8,
      commandId: "send-operator-command-1",
      action: "send_to_seat",
      payload: {
        seatId: "seat-codex",
        intent: "instruction",
        content: "Review the verified candidate before the next Room decision.",
        authorityEnvelope: {
          envelope: "operator-provided-authority",
        },
      },
    });
    expect(screen.getByRole("list", { name: "Room command audit results" })).toHaveTextContent(
      "send / send-operator-command-1",
    );
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  RoomCockpitView,
  type RoomCockpitProjectionV1,
} from "../RoomCockpitView";

const projection: RoomCockpitProjectionV1 = {
  roomId: "room-axiom",
  objective: "Prove the evidence chain before releasing the candidate.",
  phase: "Independent evidence review",
  health: {
    state: "degraded",
    detail: "One provider is reconnecting; independent work remains active.",
  },
  completion: {
    acceptedNodes: 3,
    total: 7,
    blockedNodes: 1,
  },
  criticalPathNodeIds: ["task-verdict"],
  confidence: {
    band: "medium",
    snapshotId: "confidence-42",
    dimensions: [
      { name: "evidence coverage", band: "high", rationale: "Three independent sources agree." },
      { name: "dissent", band: "medium", rationale: "One critique is still open." },
    ],
  },
  capacity: {
    theoreticalSlots: 12,
    configuredSlots: 8,
    activeSlots: 6,
    queueDepth: 3,
    telemetry: {
      availability: "available",
      detail: "Runtime capacity telemetry was observed from the persistent feed.",
      source: "persistent_runtime_telemetry",
      observedAt: "2026-07-19T08:40:00.000Z",
      structuralFields: ["theoreticalSlots", "configuredSlots", "activeSlots", "queueDepth", "utilizationRatio"],
      observedFields: ["reservedVerifierSlots", "reservedRecoverySlots", "throughputPerMinute", "idleReasons"],
    },
    reservedVerifierSlots: 1,
    reservedRecoverySlots: 1,
    utilizationRatio: 0.75,
    throughputPerMinute: 4.2,
    idleReasons: [{ reason: "recovery_reserved", slots: 1 }],
  },
  tasks: [
    {
      id: "task-research",
      title: "Research independent sources",
      state: "accepted",
      ownerSeatId: "seat-claude",
      dependencyNodeIds: [],
      critical: false,
      attempt: 1,
      progressSignature: "evidence:3/3",
      inputs: ["approved brief"],
      outputs: ["source packet"],
      gateIds: ["source-provenance"],
      evidenceIds: ["evidence-source-1"],
      waitReason: null,
      nextRecoveryAction: null,
    },
    {
      id: "task-verdict",
      title: "Review evidence chain",
      state: "waiting_dependency",
      ownerSeatId: "seat-codex",
      dependencyNodeIds: ["task-research"],
      critical: true,
      attempt: 2,
      progressSignature: "gate:waiting",
      inputs: ["source packet"],
      outputs: ["review verdict"],
      gateIds: ["independent-review"],
      evidenceIds: ["evidence-source-1", "evidence-review-2"],
      waitReason: "The source packet needs a fresh verifier receipt.",
      nextRecoveryAction: "Run verifier on the latest packet.",
    },
  ],
  edges: [
    {
      id: "edge-research-verdict",
      fromNodeId: "task-research",
      toNodeId: "task-verdict",
      kind: "depends_on",
    },
  ],
  alerts: [
    {
      id: "alert-provider",
      severity: "severe",
      state: "open",
      rootCause: "Provider reconnect is pending.",
      impact: "One reviewer cannot receive new work until recovery completes.",
      evidenceIds: ["evidence-provider-7"],
      attemptedRecovery: ["Reconnect attempt 1"],
      nextRetryAt: "2026-07-19T10:30:00.000Z",
      actions: [
        {
          id: "retry-provider",
          label: "Retry provider",
          requiresConfirmation: false,
        },
      ],
    },
  ],
};

const composerInput = {
  participants: [
    {
      seatId: "seat-controller",
      label: "Control lead",
      verification: { state: "verified" as const, recordId: "participant-proof-controller" },
    },
  ],
  controllerSeatId: "seat-controller",
};

const participantTelemetry = {
  seatId: "seat-controller",
  bindingId: "binding-controller-v1",
  nativeSessionId: "codex://threads/019f22f6-6581-7781-bb37-84cf4d63d81d",
  happierSessionId: "happier-session-controller",
  role: "Control lead",
  provider: "OpenAI Codex",
  model: "gpt-5.6",
  host: "local-control-plane",
  heartbeat: {
    freshness: "fresh",
    lastObservedAt: "2026-07-19T08:40:00.000Z",
    recoveryOwner: null,
  },
  context: { usedTokens: 120, limitTokens: 1024 },
  throughput: { eventsPerMinute: 4.2 },
  limits: { configuredConcurrent: 1, effectiveConcurrent: 1 },
  wait: { reason: null, retryAt: null },
  leases: {
    sender: { state: "held", holderId: "sender-lease-controller" },
    workspace: { state: "available", holderId: null },
  },
};

const actionableAlert = {
  alertId: "alert-capacity-001",
  dedupeKey: "provider-capacity:openai:west",
  severity: "critical",
  impact: "Room progress is blocked until a provider capacity lease is restored.",
  summary: "Provider capacity lease is exhausted",
  status: "blocked",
  evidence: {
    referenceId: "evidence-capacity-044",
    hash: "sha256:10c77e239fd0fa0ab1c99de58234d942bcf514554feb6ea3c17ebcf68bb43f79",
  },
  action: {
    actionId: "rebalance-provider-capacity",
    label: "Rebalance provider capacity",
    confirmationRequired: false,
    guard: {
      authorizationId: "authority-capacity-02",
      evidenceReferenceId: "evidence-capacity-044",
    },
  },
};

const connectedProjection: RoomCockpitProjectionV1 = {
  ...projection,
  participants: [participantTelemetry],
  evidence: {
    availability: "withheld",
    reason: "The independent reviewer receipt is not authorized for this viewer.",
    referenceId: "withheld-review-17",
  },
  composer: composerInput,
  actionableAlerts: [actionableAlert],
};

const unavailableCapacityProjection: RoomCockpitProjectionV1 = {
  ...projection,
  capacity: {
    theoreticalSlots: 12,
    configuredSlots: 8,
    activeSlots: 6,
    queueDepth: 3,
    utilizationRatio: 0.75,
    telemetry: {
      availability: "unavailable",
      detail: "No persistent runtime telemetry is available from the canonical Room aggregate.",
      structuralFields: ["theoreticalSlots", "configuredSlots", "activeSlots", "queueDepth", "utilizationRatio"],
      observedFields: ["reservedVerifierSlots", "reservedRecoverySlots", "throughputPerMinute", "idleReasons"],
    },
    reservedVerifierSlots: null,
    reservedRecoverySlots: null,
    throughputPerMinute: null,
    idleReasons: null,
  },
};

describe("RoomCockpitView", () => {
  it("renders the task-first operating picture and exposes DAG node details by keyboard", async () => {
    const user = userEvent.setup();
    const onSelectTask = vi.fn();

    render(
      <RoomCockpitView
        state="ready"
        projection={projection}
        callbacks={{ onSelectTask }}
      />,
    );

    expect(screen.getByText(projection.objective)).toBeInTheDocument();
    expect(screen.getByText("Independent evidence review")).toBeInTheDocument();
    expect(screen.getByText("3 / 7 accepted")).toBeInTheDocument();
    expect(screen.getByText("6 / 8 active slots")).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Runtime capacity telemetry available" })).toHaveTextContent(
      "Runtime capacity telemetry was observed from the persistent feed.",
    );
    expect(screen.getByText("3 queued · 4.2 / min")).toBeInTheDocument();
    expect(screen.getByText("Research independent sources → Review evidence chain")).toBeInTheDocument();

    const task = screen.getByRole("button", {
      name: /Review evidence chain, waiting dependency, critical path/i,
    });
    task.focus();
    await user.keyboard("{Enter}");

    expect(onSelectTask).toHaveBeenCalledWith(expect.objectContaining({ id: "task-verdict" }));
    expect(screen.getByRole("heading", { name: "Node detail" })).toBeInTheDocument();
    expect(screen.getByText("Run verifier on the latest packet.")).toBeInTheDocument();
  });

  it("renders distinct loading, empty, and permission states without inventing a Room projection", async () => {
    const user = userEvent.setup();
    const onRequestAccess = vi.fn();
    const { rerender } = render(<RoomCockpitView state="loading" />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading Room telemetry");
    expect(screen.getByLabelText("Room cockpit loading")).toHaveAttribute("aria-busy", "true");

    rerender(<RoomCockpitView state="empty" />);
    expect(screen.getByRole("heading", { name: "No Room projection yet" })).toBeInTheDocument();

    rerender(
      <RoomCockpitView
        state="permission-denied"
        callbacks={{ onRequestAccess }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Room access is restricted");
    await user.click(screen.getByRole("button", { name: "Request Room access" }));
    expect(onRequestAccess).toHaveBeenCalledTimes(1);
  });

  it("wires independently validated panels through supplied projections and guarded callbacks", async () => {
    const user = userEvent.setup();
    const onGuardedComposerSubmit = vi.fn().mockResolvedValue({ state: "accepted", receiptId: "receipt-001" });
    const onGuardedAlertAction = vi.fn();

    render(
      <RoomCockpitView
        state="ready"
        projection={connectedProjection}
        callbacks={{ onGuardedComposerSubmit, onGuardedAlertAction }}
      />,
    );

    expect(screen.getByRole("article", { name: "Participant seat-controller" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Evidence withheld" })).toHaveTextContent("withheld-review-17");
    expect(screen.getByRole("heading", { name: "Compose Room draft" })).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Alert provider-capacity:openai:west: critical" })).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Draft message" }), "Verify the capacity receipt.");
    await user.click(screen.getByRole("button", { name: "Submit guarded draft" }));
    await screen.findByText(/Guard accepted delivery/i);
    expect(onGuardedComposerSubmit).toHaveBeenCalledWith({
      body: "Verify the capacity receipt.",
      target: { mode: "controller", seatIds: ["seat-controller"] },
    });

    await user.click(screen.getByRole("button", { name: "Rebalance provider capacity" }));
    await waitFor(() => expect(onGuardedAlertAction).toHaveBeenCalledTimes(1));
    expect(onGuardedAlertAction).toHaveBeenCalledWith(expect.objectContaining({
      alertId: "alert-capacity-001",
      actionId: "rebalance-provider-capacity",
    }));
  });

  it("keeps absent data and unproven callbacks visible instead of manufacturing a control surface", () => {
    render(
      <RoomCockpitView
        state="ready"
        projection={{ ...projection, composer: composerInput, actionableAlerts: [actionableAlert] }}
      />,
    );

    expect(screen.getByText("Participant telemetry unavailable.")).toHaveAttribute("role", "status");
    expect(screen.getByRole("status", { name: "Evidence unavailable" })).toHaveTextContent("No verified candidate evidence packet has been projected for this Room.");
    expect(screen.getByRole("status", { name: "Draft composer unavailable" })).toHaveTextContent("No guarded draft delivery callback is connected for this Room.");
    expect(screen.getByText("Action handler unavailable.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rebalance provider capacity" })).toBeDisabled();

    const css = readFileSync(resolve(__dirname, "../RoomCockpitView.module.css"), "utf8");
    expect(css).toContain(".supplementalGrid");
    expect(css).toContain(".composerUnavailable");
  });

  it("withholds unavailable observed capacity telemetry without rendering null as zero or an empty idle list", () => {
    render(<RoomCockpitView state="ready" projection={unavailableCapacityProjection} />);

    expect(screen.getByRole("status", { name: "Runtime capacity telemetry unavailable" })).toHaveTextContent(
      "No persistent runtime telemetry is available from the canonical Room aggregate.",
    );
    expect(screen.getAllByText("Unavailable")).toHaveLength(2);
    expect(screen.getByText("Idle-capacity reasons are unavailable.")).toBeInTheDocument();
    expect(screen.queryByText("0.0 / min")).not.toBeInTheDocument();
    expect(screen.queryByText("No unassigned capacity reported.")).not.toBeInTheDocument();

    const css = readFileSync(resolve(__dirname, "../RoomCockpitView.module.css"), "utf8");
    expect(css).toContain(".capacityTelemetryState");
  });
});

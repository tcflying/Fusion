import { render, screen } from "@testing-library/react";
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

  it("keeps degraded telemetry visible, exposes alert callbacks, and never treats alert action as self-approval", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    const onSelectAlert = vi.fn();
    const onInvokeAlertAction = vi.fn();

    render(
      <RoomCockpitView
        state="degraded"
        projection={projection}
        callbacks={{ onRefresh, onSelectAlert, onInvokeAlertAction }}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Telemetry degraded");
    await user.click(screen.getByRole("button", { name: "Refresh Room telemetry" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: /Inspect severe alert: Provider reconnect is pending/i }));
    expect(onSelectAlert).toHaveBeenCalledWith(expect.objectContaining({ id: "alert-provider" }));

    await user.click(screen.getByRole("button", { name: "Retry provider" }));
    expect(onInvokeAlertAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: "alert-provider" }),
      expect.objectContaining({ id: "retry-provider" }),
    );
  });
});

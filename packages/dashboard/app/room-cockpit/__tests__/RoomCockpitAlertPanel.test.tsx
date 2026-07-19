import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  RoomCockpitAlertPanel,
  type RoomCockpitAlertActionRequestV1,
  type RoomCockpitAlertV1,
} from "../RoomCockpitAlertPanel";

const alert: RoomCockpitAlertV1 = {
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
    confirmationRequired: true,
    guard: {
      authorizationId: "authority-capacity-02",
      evidenceReferenceId: "evidence-capacity-044",
    },
  },
};

describe("RoomCockpitAlertPanel", () => {
  it("deduplicates exact alert mirrors deterministically and preserves one actionable record", () => {
    const mirroredAlert = { ...alert, alertId: "alert-capacity-009" };
    render(<RoomCockpitAlertPanel alerts={[mirroredAlert, alert]} onAction={vi.fn()} />);

    const list = screen.getByRole("list", { name: "Verified actionable Room alerts" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("1 verified alert")).toBeInTheDocument();
    const card = within(list).getByRole("article", { name: "Alert provider-capacity:openai:west: critical" });
    expect(within(card).getByText("evidence-capacity-044")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Prepare Rebalance provider capacity" })).toBeEnabled();
  });

  it("requires an explicit confirmation before dispatching a guarded action", async () => {
    const onAction = vi.fn<(request: RoomCockpitAlertActionRequestV1) => void>();
    const user = userEvent.setup();
    render(<RoomCockpitAlertPanel alerts={[alert]} onAction={onAction} />);

    await user.click(screen.getByRole("button", { name: "Prepare Rebalance provider capacity" }));
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Confirmation required before Rebalance provider capacity is handed off.");

    await user.click(screen.getByRole("button", { name: "Confirm Rebalance provider capacity" }));
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));

    const request = onAction.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      alertId: "alert-capacity-001",
      dedupeKey: "provider-capacity:openai:west",
      actionId: "rebalance-provider-capacity",
      evidence: { referenceId: "evidence-capacity-044" },
      guard: { authorizationId: "authority-capacity-02", evidenceReferenceId: "evidence-capacity-044" },
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request?.evidence)).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("Awaiting an authoritative status update.");
  });

  it("renders callback rejection without claiming the action completed", async () => {
    const onAction = vi.fn().mockResolvedValue({ accepted: false });
    const directAction = {
      ...alert,
      action: {
        ...alert.action,
        confirmationRequired: false,
      },
    };
    const user = userEvent.setup();
    render(<RoomCockpitAlertPanel alerts={[directAction]} onAction={onAction} />);

    await user.click(screen.getByRole("button", { name: "Rebalance provider capacity" }));
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("alert")).toHaveTextContent("Action handoff was rejected. No success state was recorded.");
    expect(screen.queryByText("Awaiting an authoritative status update.")).not.toBeInTheDocument();
  });

  it("withholds malformed feeds and conflicting duplicates instead of selecting a version", () => {
    const malformed = {
      ...alert,
      evidence: {
        ...alert.evidence,
        hash: "sha256:not-a-real-durable-hash",
      },
    };
    const { rerender } = render(<RoomCockpitAlertPanel alerts={[malformed]} />);

    expect(screen.getByRole("alert")).toHaveTextContent("Alert feed withheld because a record is malformed or a deduplication key conflicts.");
    expect(screen.queryByRole("list", { name: "Verified actionable Room alerts" })).not.toBeInTheDocument();

    rerender(<RoomCockpitAlertPanel alerts={[alert, { ...alert, severity: "warning" }]} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Alert feed withheld because a record is malformed or a deduplication key conflicts.");
  });

  it("keeps semantic audit labels plus unavailable and empty feed states distinct", () => {
    const { rerender } = render(<RoomCockpitAlertPanel alerts={[alert]} />);
    const card = screen.getByRole("article", { name: "Alert provider-capacity:openai:west: critical" });

    expect(within(card).getByRole("region", { name: "Alert audit fields for provider-capacity:openai:west" })).toBeInTheDocument();
    expect(within(card).getByText("Impact")).toBeInTheDocument();
    expect(within(card).getByText("Current status")).toBeInTheDocument();
    expect(within(card).getByText("Durable evidence")).toBeInTheDocument();
    expect(within(card).getByRole("region", { name: "Guarded action for provider-capacity:openai:west" })).toBeInTheDocument();

    rerender(<RoomCockpitAlertPanel />);
    expect(screen.getByRole("status")).toHaveTextContent("Alert telemetry unavailable.");

    rerender(<RoomCockpitAlertPanel alerts={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("No actionable alert records are currently projected.");

    const css = readFileSync(resolve(__dirname, "../RoomCockpitAlertPanel.module.css"), "utf8");
    expect(css).toContain("@media (max-width: 768px)");
    expect(css).toContain("grid-template-columns: 1fr");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

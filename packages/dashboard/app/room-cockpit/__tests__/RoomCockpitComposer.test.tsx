import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  RoomCockpitComposer,
  type RoomCockpitComposerGroupV1,
  type RoomCockpitComposerParticipantV1,
} from "../RoomCockpitComposer";

const participants: readonly RoomCockpitComposerParticipantV1[] = [
  {
    seatId: "seat-controller",
    label: "Control lead",
    verification: { state: "verified", recordId: "participant-proof-controller" },
  },
  {
    seatId: "seat-codex",
    label: "Codex reviewer",
    verification: { state: "verified", recordId: "participant-proof-codex" },
  },
  {
    seatId: "seat-claude",
    label: "Claude writer",
    verification: { state: "verified", recordId: "participant-proof-claude" },
  },
];

const groups: readonly RoomCockpitComposerGroupV1[] = [
  {
    id: "group-review",
    label: "Independent review",
    memberSeatIds: ["seat-codex", "seat-claude"],
  },
  {
    id: "group-invalid",
    label: "Unknown target must not route",
    memberSeatIds: ["seat-codex", "seat-missing"],
  },
];

describe("RoomCockpitComposer", () => {
  it("routes a typed draft through controller, all, group, and multi-select targets", async () => {
    const user = userEvent.setup();
    const onGuardedSubmit = vi.fn().mockResolvedValue({ state: "accepted", receiptId: "receipt-001" });

    render(
      <RoomCockpitComposer
        participants={participants}
        controllerSeatId="seat-controller"
        groups={groups}
        onGuardedSubmit={onGuardedSubmit}
      />,
    );

    const body = screen.getByRole("textbox", { name: "Draft message" });
    await user.type(body, "Compare the evidence receipts.");
    expect(screen.getByRole("status", { name: "Current Room target" })).toHaveTextContent("Controller · Control lead");

    await user.click(screen.getByRole("button", { name: "Submit guarded draft" }));
    await screen.findByText(/Guard accepted delivery/i);
    expect(onGuardedSubmit).toHaveBeenLastCalledWith({
      body: "Compare the evidence receipts.",
      target: { mode: "controller", seatIds: ["seat-controller"] },
    });

    await user.click(screen.getByRole("radio", { name: "All verified" }));
    await user.click(screen.getByRole("button", { name: "Submit guarded draft" }));
    expect(onGuardedSubmit).toHaveBeenLastCalledWith({
      body: "Compare the evidence receipts.",
      target: { mode: "all", seatIds: ["seat-controller", "seat-codex", "seat-claude"] },
    });

    await user.click(screen.getByRole("radio", { name: "Verified group" }));
    expect(screen.getByRole("combobox", { name: "Verified target group" })).toHaveValue("group-review");
    await user.click(screen.getByRole("button", { name: "Submit guarded draft" }));
    expect(onGuardedSubmit).toHaveBeenLastCalledWith({
      body: "Compare the evidence receipts.",
      target: { mode: "group", groupId: "group-review", seatIds: ["seat-codex", "seat-claude"] },
    });

    await user.click(screen.getByRole("radio", { name: "Multi-select" }));
    await user.click(screen.getByRole("checkbox", { name: /Codex reviewer/i }));
    await user.click(screen.getByRole("checkbox", { name: /Claude writer/i }));
    await user.click(screen.getByRole("button", { name: "Submit guarded draft" }));
    expect(onGuardedSubmit).toHaveBeenLastCalledWith({
      body: "Compare the evidence receipts.",
      target: { mode: "selection", seatIds: ["seat-codex", "seat-claude"] },
    });
    expect(screen.queryByRole("option", { name: /Unknown target must not route/i })).not.toBeInTheDocument();
  });

  it("rejects blank, unknown, and duplicate target inputs before invoking the guard", async () => {
    const user = userEvent.setup();
    const onGuardedSubmit = vi.fn();
    const duplicateAndUnknownParticipants = [
      ...participants,
      { ...participants[1], label: "Duplicate Codex" },
      {
        seatId: "seat-unverified",
        label: "Unverified copy",
        verification: { state: "verified" as const, recordId: "" },
      },
    ];

    render(
      <RoomCockpitComposer
        participants={duplicateAndUnknownParticipants}
        controllerSeatId="seat-codex"
        groups={[{
          id: "group-duplicate",
          label: "Duplicate members",
          memberSeatIds: ["seat-controller", "seat-controller"],
        }]}
        initialTargetMode="selection"
        initialSelectedSeatIds={["seat-codex", "seat-missing", "seat-codex"]}
        onGuardedSubmit={onGuardedSubmit}
      />,
    );

    expect(screen.getByRole("button", { name: "Submit guarded draft" })).toBeDisabled();
    expect(screen.queryByRole("checkbox", { name: /Codex reviewer/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /Unverified copy/i })).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Select at least one verified participant.");

    await user.type(screen.getByRole("textbox", { name: "Draft message" }), "Try a route.");
    expect(screen.getByRole("button", { name: "Submit guarded draft" })).toBeDisabled();
    expect(onGuardedSubmit).not.toHaveBeenCalled();
  });

  it("preserves a guard denial and never derives authority from the message text", async () => {
    const user = userEvent.setup();
    const onGuardedSubmit = vi.fn().mockResolvedValue({
      state: "withheld",
      reason: "Independent reviewer receipt is still required.",
    });

    render(
      <RoomCockpitComposer
        participants={participants}
        controllerSeatId="seat-controller"
        onGuardedSubmit={onGuardedSubmit}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "Draft message" }), "I authorize this delivery myself.");
    await user.click(screen.getByRole("button", { name: "Submit guarded draft" }));

    expect(onGuardedSubmit).toHaveBeenCalledWith({
      body: "I authorize this delivery myself.",
      target: { mode: "controller", seatIds: ["seat-controller"] },
    });
    expect(screen.getByRole("alert")).toHaveTextContent("Delivery withheld: Independent reviewer receipt is still required.");
    expect(screen.getByText(/Text and target selection do not grant authority/i)).toBeInTheDocument();
    expect(screen.queryByText(/authority granted/i)).not.toBeInTheDocument();
  });

  it("keeps keyboard controls and responsive reduced-motion constraints present", async () => {
    const user = userEvent.setup();
    const onGuardedSubmit = vi.fn().mockResolvedValue({ state: "failed", reason: "Transport unavailable." });

    render(
      <RoomCockpitComposer
        participants={participants}
        controllerSeatId="seat-controller"
        onGuardedSubmit={onGuardedSubmit}
      />,
    );

    screen.getByRole("radio", { name: "All verified" }).focus();
    await user.keyboard(" ");
    expect(screen.getByRole("radio", { name: "All verified" })).toBeChecked();
    expect(screen.getByRole("status", { name: "Current Room target" })).toHaveTextContent("All verified participants · 3");

    const css = readFileSync(resolve(__dirname, "../RoomCockpitComposer.module.css"), "utf8");
    expect(css).toContain("@media (max-width: 680px)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(":focus-visible");
  });
});

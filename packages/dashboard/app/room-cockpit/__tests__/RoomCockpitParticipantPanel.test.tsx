import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  RoomCockpitParticipantPanel,
  type RoomCockpitParticipantV1,
} from "../RoomCockpitParticipantPanel";

const participant: RoomCockpitParticipantV1 = {
  seatId: "seat-codex-verifier",
  bindingId: "binding-codex-verifier-v2",
  nativeSessionId: "codex://threads/019f22f6-6581-7781-bb37-84cf4d63d81d",
  happierSessionId: "happier-session-19f22f6",
  role: "independent verifier",
  provider: "OpenAI Codex",
  model: "gpt-5.6",
  host: "windows-control-node-01",
  heartbeat: {
    freshness: "fresh",
    lastObservedAt: "2026-07-19T15:42:10.000Z",
    recoveryOwner: null,
  },
  context: {
    usedTokens: 32768,
    limitTokens: 114688,
  },
  throughput: {
    eventsPerMinute: 6.4,
  },
  limits: {
    configuredConcurrent: 2,
    effectiveConcurrent: 1,
  },
  wait: {
    reason: "Waiting for the authoritative evidence receipt.",
    retryAt: "2026-07-19T15:44:00.000Z",
  },
  leases: {
    sender: {
      state: "held",
      holderId: "room-controller-7",
      expiresAt: "2026-07-19T15:47:00.000Z",
    },
    workspace: {
      state: "held",
      holderId: "workspace-lease-42",
      expiresAt: "2026-07-19T16:00:00.000Z",
    },
  },
};

describe("RoomCockpitParticipantPanel", () => {
  it("renders one semantic participant card from a complete recorded projection", () => {
    render(<RoomCockpitParticipantPanel participants={[participant]} />);

    const list = screen.getByRole("list", { name: "Room participant telemetry" });
    const card = within(list).getByRole("article", { name: "Participant seat-codex-verifier" });

    expect(within(card).getByRole("heading", { name: "Independent verifier" })).toBeInTheDocument();
    expect(within(card).getAllByText("seat-codex-verifier")).toHaveLength(2);
    expect(within(card).getByText("binding-codex-verifier-v2")).toBeInTheDocument();
    expect(within(card).getByText("codex://threads/019f22f6-6581-7781-bb37-84cf4d63d81d")).toBeInTheDocument();
    expect(within(card).getByText("happier-session-19f22f6")).toBeInTheDocument();
    expect(within(card).getByText("OpenAI Codex")).toBeInTheDocument();
    expect(within(card).getByText("gpt-5.6")).toBeInTheDocument();
    expect(within(card).getByText("windows-control-node-01")).toBeInTheDocument();
    expect(within(card).getAllByText("fresh")).toHaveLength(2);
    expect(within(card).getByText("32768 / 114688 tokens")).toBeInTheDocument();
    expect(within(card).getByText("6.4 events/min")).toBeInTheDocument();
    expect(within(card).getByText("2 configured / 1 effective")).toBeInTheDocument();
    expect(within(card).getByText("Waiting for the authoritative evidence receipt.")).toBeInTheDocument();
    expect(within(card).getByText("held · room-controller-7")).toBeInTheDocument();
    expect(within(card).getByText("held · workspace-lease-42")).toBeInTheDocument();
    expect(within(card).getByRole("meter", { name: "Context utilization for seat-codex-verifier" })).toHaveAttribute("value", "32768");
    expect(within(card).getByRole("meter", { name: "Context utilization for seat-codex-verifier" })).toHaveAttribute("max", "114688");
  });

  it("fails closed field-by-field for malformed or absent telemetry without inventing a participant", () => {
    const malformed = {
      seatId: "seat-partial",
      bindingId: 42,
      nativeSessionId: "",
      happierSessionId: null,
      role: null,
      provider: "OpenAI Codex",
      model: { guessed: "gpt-5.6" },
      host: "",
      heartbeat: { freshness: "invented", lastObservedAt: "soon", recoveryOwner: 11 },
      context: { usedTokens: 8000, limitTokens: "unknown" },
      throughput: { eventsPerMinute: "fast" },
      limits: { configuredConcurrent: -1, effectiveConcurrent: 3 },
      wait: { reason: ["blocked"], retryAt: "tomorrow" },
      leases: { sender: { state: "held", holderId: 7, expiresAt: "later" }, workspace: null },
    };

    render(<RoomCockpitParticipantPanel participants={[malformed]} />);

    const card = screen.getByRole("article", { name: "Participant seat-partial" });
    expect(within(card).getAllByText("seat-partial")).toHaveLength(2);
    expect(within(card).getByText("OpenAI Codex")).toBeInTheDocument();
    expect(within(card).getAllByText("Unknown").length).toBeGreaterThan(0);
    expect(within(card).getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(within(card).queryByText("gpt-5.6")).not.toBeInTheDocument();
    expect(within(card).queryByText("42")).not.toBeInTheDocument();
    expect(within(card).queryByRole("meter")).not.toBeInTheDocument();
  });

  it("keeps an unavailable panel explicit and preserves responsive and reduced-motion rules", () => {
    const { rerender } = render(<RoomCockpitParticipantPanel />);

    expect(screen.getByRole("status")).toHaveTextContent("Participant telemetry unavailable.");
    expect(screen.queryByRole("list", { name: "Room participant telemetry" })).not.toBeInTheDocument();

    rerender(<RoomCockpitParticipantPanel participants={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("No verified participant seats are currently projected.");

    const css = readFileSync(resolve(__dirname, "../RoomCockpitParticipantPanel.module.css"), "utf8");
    expect(css).toContain("@media (max-width: 768px)");
    expect(css).toContain("grid-template-columns: 1fr");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

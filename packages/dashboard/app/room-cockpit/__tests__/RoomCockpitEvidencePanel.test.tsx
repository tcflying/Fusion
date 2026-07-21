import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  RoomCockpitEvidencePanel,
  parseRoomCockpitEvidencePanelEnvelope,
  type RoomCockpitEvidencePanelEnvelopeV1,
} from "../RoomCockpitEvidencePanel";

const evidence: RoomCockpitEvidencePanelEnvelopeV1 = {
  availability: "available",
  candidate: {
    candidateId: "candidate-story-17",
    candidateHash: "sha256:11c99eead9d5a6fa9fedf79ce258d7ef41b478e9c91c5525e2ce0dfb2bd89e23",
    candidateVersionId: "strategy-v17",
    baseVersionId: "strategy-v16",
    intentSummary: "Tighten verifier handoff without widening the authority boundary.",
    diffSummary: "One isolated strategy delta; no provider, network, or credential surface changed.",
    evidenceIds: ["evidence-candidate-17"],
  },
  hardGates: [
    {
      gateId: "authority-boundary",
      state: "passed",
      summary: "Canonical authority envelope and independent signature checks both matched.",
      evidenceIds: ["evidence-gate-authority"],
    },
    {
      gateId: "regression-ledger",
      state: "passed",
      summary: "Focused regression evidence completed against the isolated candidate.",
      evidenceIds: ["evidence-gate-regression"],
    },
  ],
  independentAssessment: {
    status: "arbitrated",
    reviewerCount: 3,
    dissentSummary: "One reviewer questioned canary breadth; the recorded arbitration limited it.",
    arbitration: {
      status: "resolved",
      summary: "Independent arbitration kept the constrained allocation and retained rollback coverage.",
      evidenceIds: ["evidence-arbitration-17"],
    },
    decision: {
      status: "promoted",
      authorityTier: "independent",
      decisionId: "decision-17",
      summary: "Independent decision promoted only the verified candidate version.",
      evidenceIds: ["evidence-decision-17"],
    },
    evidenceIds: ["evidence-review-17"],
  },
  canary: {
    status: "passed",
    canaryId: "canary-17",
    summary: "Constrained canary met its criteria without exhausting reserved recovery capacity.",
    evidenceIds: ["evidence-canary-17"],
  },
  promotion: {
    status: "promoted",
    decisionId: "decision-17",
    authorityTier: "independent",
    summary: "Promotion persisted after independent arbitration and a passed canary.",
    evidenceIds: ["evidence-promotion-17"],
  },
  rollback: {
    status: "armed",
    rollbackId: "rollback-17",
    targetVersionId: "strategy-v16",
    summary: "Rollback remains armed against the prior immutable strategy version.",
    evidenceIds: ["evidence-rollback-17"],
  },
};

describe("RoomCockpitEvidencePanel", () => {
  it("renders the verified candidate, hard-gate chain, independent decision, and promotion lineage without approval controls", () => {
    render(<RoomCockpitEvidencePanel evidence={evidence} />);

    expect(screen.getByRole("region", { name: "Candidate evidence ledger" })).toBeInTheDocument();
    expect(screen.getByText("candidate-story-17")).toBeInTheDocument();
    expect(screen.getByText(evidence.candidate.candidateHash)).toBeInTheDocument();
    expect(screen.getByText("strategy-v17")).toBeInTheDocument();
    expect(screen.getByText(evidence.candidate.intentSummary)).toBeInTheDocument();
    expect(screen.getByText(evidence.candidate.diffSummary)).toBeInTheDocument();
    expect(screen.getByText("authority-boundary")).toBeInTheDocument();
    expect(screen.getByText(/one reviewer questioned canary breadth/i)).toBeInTheDocument();
    expect(screen.getByText("canary / passed")).toBeInTheDocument();
    expect(screen.getByText("promotion / promoted")).toBeInTheDocument();
    expect(screen.getByText("rollback / armed")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve|promote|accept/i })).not.toBeInTheDocument();
  });

  it("withholds malformed evidence instead of showing a forged candidate hash or decision", () => {
    const forgedHash = {
      ...evidence,
      candidate: {
        ...evidence.candidate,
        candidateHash: "sha256:NOT-A-LOWERCASE-CANONICAL-HASH",
      },
    };

    render(<RoomCockpitEvidencePanel evidence={forgedHash} />);

    expect(parseRoomCockpitEvidencePanelEnvelope(forgedHash)).toBeNull();
    expect(parseRoomCockpitEvidencePanelEnvelope({
      ...evidence,
      candidate: { ...evidence.candidate, baseVersionId: undefined },
    })).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Evidence withheld");
    expect(screen.queryByText("candidate-story-17")).not.toBeInTheDocument();
    expect(screen.queryByText("decision-17")).not.toBeInTheDocument();
  });

  it("rejects a promotion that bypasses failed hard gates or a failed canary", () => {
    const bypassedPromotion = {
      ...evidence,
      hardGates: [{ ...evidence.hardGates[0], state: "failed" as const }],
      canary: { ...evidence.canary, status: "failed" as const },
    };

    render(<RoomCockpitEvidencePanel evidence={bypassedPromotion} />);

    expect(parseRoomCockpitEvidencePanelEnvelope(bypassedPromotion)).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Evidence withheld");
    expect(screen.queryByText("Promotion persisted after independent arbitration and a passed canary.")).not.toBeInTheDocument();
  });

  it("distinguishes intentionally withheld and unavailable evidence states", () => {
    const { rerender } = render(
      <RoomCockpitEvidencePanel
        evidence={{
          availability: "withheld",
          reason: "The independent reviewer receipt is not authorized for this viewer.",
          referenceId: "withheld-review-17",
        }}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Evidence withheld");
    expect(screen.getByText("withheld-review-17")).toBeInTheDocument();

    rerender(
      <RoomCockpitEvidencePanel
        evidence={{
          availability: "unavailable",
          reason: "The durable evidence read model has not caught up to the Room cursor.",
        }}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Evidence unavailable");
    expect(screen.queryByText("withheld-review-17")).not.toBeInTheDocument();
  });
});

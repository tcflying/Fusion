import { describe, expect, it, vi } from "vitest";

import {
  collectAuthorizedRoomEvolutionOutcomeSignals,
  type AppendRoomEvolutionHypothesisInputV1,
  type RoomEvolutionHypothesisTemplateV1,
  type RoomEvolutionOutcomeObservationV1,
} from "@fusion/core";

import {
  RoomEvolutionHypothesisCommitCoordinator,
  type RoomEvolutionHypothesisLedgerPortV1,
} from "../room-evolution-hypothesis-commit-coordinator.js";

const HASH = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function observation(
  id: string,
  kind: RoomEvolutionOutcomeObservationV1["kind"],
): RoomEvolutionOutcomeObservationV1 {
  const values: Record<RoomEvolutionOutcomeObservationV1["kind"], Pick<RoomEvolutionOutcomeObservationV1, "source" | "unit" | "value">> = {
    failure: { source: "deterministic_gate", unit: "count", value: 1 },
    correction: { source: "human_correction", unit: "count", value: 1 },
    confidence: { source: "durable_room_ledger", unit: "ratio", value: 0.3 },
    retry: { source: "durable_room_ledger", unit: "count", value: 1 },
    dissent: { source: "independent_review", unit: "count", value: 1 },
    quality: { source: "authorized_observed_outcome", unit: "ratio", value: 0.9 },
    stability: { source: "room_metric", unit: "ratio", value: 0.9 },
    utilization: { source: "room_metric", unit: "ratio", value: 0.8 },
    latency: { source: "room_metric", unit: "milliseconds", value: 100 },
  };
  return {
    contractVersion: 1,
    id,
    projectId: "project-evolution-commit",
    roomId: "room-evolution-commit",
    kind,
    source: values[kind].source,
    sourceRef: `source-${id}`,
    evidenceHash: HASH,
    observedAt: "2026-07-19T14:30:00.000Z",
    unit: values[kind].unit,
    value: values[kind].value,
  };
}

function signals() {
  const result = collectAuthorizedRoomEvolutionOutcomeSignals({
    contractVersion: 1,
    projectId: "project-evolution-commit",
    asOf: "2026-07-19T14:30:30.000Z",
    maxObservationAgeMs: 60_000,
    observations: [observation("failure-1", "failure"), observation("retry-1", "retry")],
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function template(): RoomEvolutionHypothesisTemplateV1 {
  return {
    contractVersion: 1,
    id: "template-retry",
    scopeKind: "room",
    revision: 1,
    triggerSignalKinds: ["failure", "retry"],
    minimumObservationCount: 2,
    declaredScope: ["task_decomposition"],
    riskClass: "moderate",
    expectedMechanism: "Decrease failed retry loops.",
    affectedDomains: ["coding"],
    createdByActorId: "evolution-controller",
  };
}

describe("Room evolution hypothesis commit coordinator", () => {
  it("derives only from authorized signals and appends the exact immutable hypothesis to the durable ledger", async () => {
    const ledger: RoomEvolutionHypothesisLedgerPortV1 = {
      appendHypothesis: vi.fn(async (input: AppendRoomEvolutionHypothesisInputV1) => ({
        table: "room_evolution_hypotheses" as const,
        record: {
          contractVersion: 1 as const,
          id: input.id,
          projectId: input.scope.projectId,
          roomId: input.scope.roomId,
          scopeKind: input.scope.scopeKind,
          scopeKey: input.scope.scopeKey,
          revision: input.revision,
          state: input.state,
          sourceSignalKinds: input.sourceSignalKinds,
          evidence: input.evidence,
          evidenceHash: input.evidenceHash,
          declaredScope: input.declaredScope,
          riskClass: input.riskClass,
          expectedMechanism: input.expectedMechanism,
          affectedDomains: input.affectedDomains,
          createdByActorId: input.createdByActorId,
          createdAt: input.createdAt,
        },
      })),
    };
    const coordinator = new RoomEvolutionHypothesisCommitCoordinator({ ledger });

    const result = await coordinator.commit({
      contractVersion: 1,
      signals: signals(),
      templates: [template()],
    });

    expect(result).toMatchObject({ status: "committed", committedHypothesisIds: ["hypothesis:template-retry:room:room-evolution-commit:v1"] });
    expect(ledger.appendHypothesis).toHaveBeenCalledWith(expect.objectContaining({
      scope: {
        projectId: "project-evolution-commit",
        roomId: "room-evolution-commit",
        scopeKind: "room",
        scopeKey: "room:room-evolution-commit",
      },
      state: "proposed",
      sourceSignalKinds: ["failure", "retry"],
      evidence: [
        expect.objectContaining({ id: "failure-1", source: "deterministic_gate" }),
        expect.objectContaining({ id: "retry-1", source: "durable_room_ledger" }),
      ],
    }));
  });

  it("does not write anything when the signal set cannot produce a complete authorized trigger", async () => {
    const ledger: RoomEvolutionHypothesisLedgerPortV1 = { appendHypothesis: vi.fn() };
    const coordinator = new RoomEvolutionHypothesisCommitCoordinator({ ledger });
    const incomplete = collectAuthorizedRoomEvolutionOutcomeSignals({
      contractVersion: 1,
      projectId: "project-evolution-commit",
      asOf: "2026-07-19T14:30:30.000Z",
      maxObservationAgeMs: 60_000,
      observations: [observation("failure-only", "failure")],
    });
    if (!incomplete.ok) throw new Error(JSON.stringify(incomplete.issues));

    const result = await coordinator.commit({ contractVersion: 1, signals: incomplete.value, templates: [template()] });

    expect(result).toEqual({ status: "no_hypotheses" });
    expect(ledger.appendHypothesis).not.toHaveBeenCalled();
  });
});

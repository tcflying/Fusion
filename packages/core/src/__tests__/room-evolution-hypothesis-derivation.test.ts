import { describe, expect, it } from "vitest";

import {
  collectAuthorizedRoomEvolutionOutcomeSignals,
  type RoomEvolutionOutcomeObservationV1,
} from "../room-evolution-outcome-signals.js";
import {
  deriveAuthorizedRoomEvolutionHypotheses,
  type RoomEvolutionHypothesisTemplateV1,
} from "../room-evolution-hypothesis-derivation.js";

const PROJECT_ID = "project-hypothesis";
const AS_OF = "2026-07-19T13:50:00.000Z";
const HASH = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function signals(observations: readonly RoomEvolutionOutcomeObservationV1[]) {
  const result = collectAuthorizedRoomEvolutionOutcomeSignals({
    contractVersion: 1,
    projectId: PROJECT_ID,
    asOf: AS_OF,
    maxObservationAgeMs: 60_000,
    observations,
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

function observation(
  id: string,
  kind: RoomEvolutionOutcomeObservationV1["kind"],
  roomId = "room-hypothesis-alpha",
): RoomEvolutionOutcomeObservationV1 {
  const defaults: Record<RoomEvolutionOutcomeObservationV1["kind"], Pick<
    RoomEvolutionOutcomeObservationV1,
    "source" | "unit" | "value"
  >> = {
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
    projectId: PROJECT_ID,
    roomId,
    kind,
    source: defaults[kind].source,
    sourceRef: `evidence-${id}`,
    evidenceHash: HASH,
    observedAt: "2026-07-19T13:49:30.000Z",
    unit: defaults[kind].unit,
    value: defaults[kind].value,
  };
}

function template(
  overrides: Partial<RoomEvolutionHypothesisTemplateV1> = {},
): RoomEvolutionHypothesisTemplateV1 {
  return {
    contractVersion: 1,
    id: "template-decomposition",
    scopeKind: "room",
    revision: 1,
    triggerSignalKinds: ["failure", "retry"],
    minimumObservationCount: 2,
    declaredScope: ["task_decomposition"],
    riskClass: "moderate",
    expectedMechanism: "Reduce repeated no-progress decomposition retries.",
    affectedDomains: ["coding"],
    createdByActorId: "evolution-controller",
    ...overrides,
  };
}

describe("authorized Room evolution hypothesis derivation", () => {
  it("derives a versioned proposed hypothesis from repeated trusted signals and retains only bounded evidence references", () => {
    const result = deriveAuthorizedRoomEvolutionHypotheses({
      contractVersion: 1,
      signals: signals([
        observation("signal-failure-a", "failure"),
        observation("signal-retry-a", "retry"),
      ]),
      templates: [template()],
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("Expected a derived hypothesis");
    expect(result.value).toMatchObject([{
      projectId: PROJECT_ID,
      roomId: "room-hypothesis-alpha",
      scopeKind: "room",
      scopeKey: "room:room-hypothesis-alpha",
      revision: 1,
      state: "proposed",
      sourceSignalKinds: ["failure", "retry"],
      declaredScope: ["task_decomposition"],
      modelSelfReportExcluded: true,
      evidence: [
        { observationId: "signal-failure-a", kind: "failure" },
        { observationId: "signal-retry-a", kind: "retry" },
      ],
    }]);
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it("does not invent a hypothesis when a trigger lacks its required repeated evidence", () => {
    const result = deriveAuthorizedRoomEvolutionHypotheses({
      contractVersion: 1,
      signals: signals([observation("signal-failure-only", "failure")]),
      templates: [template({ minimumObservationCount: 2 })],
    });

    expect(result).toEqual({ ok: true, value: [] });
  });

  it("derives independent room-scoped hypotheses without cross-room evidence leakage", () => {
    const result = deriveAuthorizedRoomEvolutionHypotheses({
      contractVersion: 1,
      signals: signals([
        observation("signal-failure-alpha", "failure", "room-hypothesis-alpha"),
        observation("signal-retry-alpha", "retry", "room-hypothesis-alpha"),
        observation("signal-failure-beta", "failure", "room-hypothesis-beta"),
        observation("signal-retry-beta", "retry", "room-hypothesis-beta"),
      ]),
      templates: [template()],
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("Expected two isolated hypotheses");
    expect(result.value.map((entry) => entry.scopeKey)).toEqual([
      "room:room-hypothesis-alpha",
      "room:room-hypothesis-beta",
    ]);
    expect(result.value[0]?.evidence.every((entry) => entry.observationId.endsWith("alpha"))).toBe(true);
    expect(result.value[1]?.evidence.every((entry) => entry.observationId.endsWith("beta"))).toBe(true);
  });
});

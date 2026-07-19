import { describe, expect, it } from "vitest";

import {
  collectAuthorizedRoomEvolutionOutcomeSignals,
  type RoomEvolutionOutcomeObservationV1,
} from "../room-evolution-outcome-signals.js";

const PROJECT_ID = "project-evolution-signals";
const AS_OF = "2026-07-19T13:30:00.000Z";
const HASH = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function observation(
  kind: RoomEvolutionOutcomeObservationV1["kind"],
  overrides: Partial<RoomEvolutionOutcomeObservationV1> = {},
): RoomEvolutionOutcomeObservationV1 {
  const defaults: Record<RoomEvolutionOutcomeObservationV1["kind"], Pick<
    RoomEvolutionOutcomeObservationV1,
    "source" | "unit" | "value"
  >> = {
    failure: { source: "deterministic_gate", unit: "count", value: 1 },
    correction: { source: "human_correction", unit: "count", value: 1 },
    confidence: { source: "durable_room_ledger", unit: "ratio", value: 0.4 },
    retry: { source: "durable_room_ledger", unit: "count", value: 2 },
    dissent: { source: "independent_review", unit: "count", value: 1 },
    quality: { source: "authorized_observed_outcome", unit: "ratio", value: 0.8 },
    stability: { source: "room_metric", unit: "ratio", value: 0.9 },
    utilization: { source: "room_metric", unit: "ratio", value: 0.75 },
    latency: { source: "room_metric", unit: "milliseconds", value: 320 },
  };
  return {
    contractVersion: 1,
    id: `signal-${kind}`,
    projectId: PROJECT_ID,
    roomId: "room-evolution-alpha",
    kind,
    source: defaults[kind].source,
    sourceRef: `evidence-${kind}`,
    evidenceHash: HASH,
    observedAt: "2026-07-19T13:29:00.000Z",
    unit: defaults[kind].unit,
    value: defaults[kind].value,
    ...overrides,
  };
}

describe("authorized Room evolution outcome signal collection", () => {
  it("collects the complete authorized signal surface deterministically without model self-report", () => {
    const result = collectAuthorizedRoomEvolutionOutcomeSignals({
      contractVersion: 1,
      projectId: PROJECT_ID,
      asOf: AS_OF,
      maxObservationAgeMs: 60_000,
      observations: [
        observation("latency"),
        observation("failure"),
        observation("utilization"),
        observation("correction"),
        observation("confidence"),
        observation("retry"),
        observation("dissent"),
        observation("quality"),
        observation("stability"),
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        projectId: PROJECT_ID,
        asOf: AS_OF,
        modelSelfReportExcluded: true,
        coverage: expect.arrayContaining([
          { kind: "failure", state: "observed", observationIds: ["signal-failure"] },
          { kind: "latency", state: "observed", observationIds: ["signal-latency"] },
        ]),
      },
    });
    if (!result.ok) throw new Error("Expected a collected outcome-signal set");
    expect(result.value.observations.map((entry) => entry.id)).toEqual([
      "signal-confidence",
      "signal-correction",
      "signal-dissent",
      "signal-failure",
      "signal-latency",
      "signal-quality",
      "signal-retry",
      "signal-stability",
      "signal-utilization",
    ]);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.observations)).toBe(true);
  });

  it("withholds untrusted, stale, future, duplicate, or cross-project observations", () => {
    const result = collectAuthorizedRoomEvolutionOutcomeSignals({
      contractVersion: 1,
      projectId: PROJECT_ID,
      asOf: AS_OF,
      maxObservationAgeMs: 60_000,
      observations: [
        observation("failure", { source: "model_self_report" as never }),
        observation("retry", { id: "signal-failure" }),
        observation("quality", { projectId: "project-other" }),
        observation("latency", { observedAt: "2026-07-19T13:00:00.000Z" }),
        observation("stability", { observedAt: "2026-07-19T13:31:00.000Z" }),
      ],
    });

    expect(result).toMatchObject({ ok: false });
    if (result.ok) throw new Error("Expected malformed observations to be withheld");
    expect(result.issues.map((entry) => entry.code)).toEqual(expect.arrayContaining([
      "duplicate_observation",
      "future_observation",
      "project_scope_mismatch",
      "stale_observation",
      "untrusted_source",
    ]));
  });

  it("keeps absent signal kinds explicitly unknown instead of fabricating zero-valued telemetry", () => {
    const result = collectAuthorizedRoomEvolutionOutcomeSignals({
      contractVersion: 1,
      projectId: PROJECT_ID,
      asOf: AS_OF,
      maxObservationAgeMs: 60_000,
      observations: [observation("failure")],
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error("Expected one valid outcome observation");
    expect(result.value.coverage).toContainEqual({
      kind: "latency",
      state: "unknown",
      observationIds: [],
    });
  });
});

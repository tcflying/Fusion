import { describe, expect, it } from "vitest";

import {
  selectAuthorizedRoomEvolutionBenchmarkSnapshot,
  type RoomEvolutionBenchmarkAuthorizationV1,
  type RoomEvolutionBenchmarkCaseV1,
  type RoomEvolutionBenchmarkCollectionKindV1,
  type RoomEvolutionBenchmarkCollectionPlanV1,
  type SelectAuthorizedRoomEvolutionBenchmarkSnapshotInputV1,
} from "../room-evolution-benchmark-policy.js";

const PROJECT_ID = "project-benchmark";
const ROOM_ID = "room-benchmark";
const AS_OF = "2026-07-19T15:00:00.000Z";
const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const HASH_C = `sha256:${"c".repeat(64)}`;
const HASH_D = `sha256:${"d".repeat(64)}`;

function authorization(id: string): RoomEvolutionBenchmarkAuthorizationV1 {
  return {
    id,
    evidenceHash: HASH_A,
    grantedByActorId: "governance-approver",
    grantedAt: AS_OF,
  };
}

function benchmarkCase(
  collection: RoomEvolutionBenchmarkCollectionKindV1,
  id: string,
  overrides: Partial<RoomEvolutionBenchmarkCaseV1> = {},
): RoomEvolutionBenchmarkCaseV1 {
  const source = collection === "fixed"
    ? {
      kind: "human_curated_fixed" as const,
      reference: `catalog:${id}`,
      evidenceHash: HASH_B,
      inclusionAuthority: "human_curator" as const,
      authorActorId: "benchmark-curator",
      authorization: null,
    }
    : collection === "rolling_difficult"
      ? {
        kind: "authorized_difficulty_pool" as const,
        reference: `difficulty-pool:${id}`,
        evidenceHash: HASH_B,
        inclusionAuthority: "independent_benchmark_governance" as const,
        authorActorId: "benchmark-governance",
        authorization: null,
      }
      : collection === "adversarial"
        ? {
          kind: "independent_adversarial_corpus" as const,
          reference: `adversarial-corpus:${id}`,
          evidenceHash: HASH_B,
          inclusionAuthority: "independent_benchmark_governance" as const,
          authorActorId: "benchmark-governance",
          authorization: null,
        }
        : {
          kind: "authorized_historical_outcome" as const,
          reference: `authorized-history:${id}`,
          evidenceHash: HASH_B,
          inclusionAuthority: "authorized_historical_ingestion" as const,
          authorActorId: "history-ingestion",
          authorization: authorization(`source-auth:${id}`),
        };
  return {
    contractVersion: 1,
    id,
    version: 1,
    contentHash: HASH_C,
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    domain: "coding",
    collection,
    difficulty: collection === "rolling_difficult" ? 80 : 50,
    risk: { classification: "low", authorization: null },
    privacy: { containsPrivateData: false, authorization: null },
    source,
    ...overrides,
  };
}

function plan(
  collection: RoomEvolutionBenchmarkCollectionKindV1,
  maximumCases = 1,
): RoomEvolutionBenchmarkCollectionPlanV1 {
  return { collection, minimumCases: 1, maximumCases };
}

function input(
  overrides: Partial<SelectAuthorizedRoomEvolutionBenchmarkSnapshotInputV1> = {},
): SelectAuthorizedRoomEvolutionBenchmarkSnapshotInputV1 {
  return {
    contractVersion: 1,
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    snapshotId: "benchmark-snapshot-1",
    catalogVersion: 7,
    asOf: AS_OF,
    baseline: {
      candidateVersionId: "candidate-baseline-v1",
      immutableArtifactHash: HASH_A,
      producerActorIds: ["baseline-author"],
    },
    candidate: {
      candidateVersionId: "candidate-next-v2",
      immutableArtifactHash: HASH_D,
      producerActorIds: ["candidate-author"],
    },
    plans: [
      plan("fixed"),
      plan("rolling_difficult"),
      plan("adversarial"),
      plan("authorized_historical_replay"),
    ],
    cases: [
      benchmarkCase("fixed", "fixed-1"),
      benchmarkCase("rolling_difficult", "rolling-easy", { difficulty: 20 }),
      benchmarkCase("rolling_difficult", "rolling-hard", { difficulty: 95 }),
      benchmarkCase("adversarial", "adversarial-1"),
      benchmarkCase("authorized_historical_replay", "history-1"),
    ],
    ...overrides,
  };
}

function selected(value: SelectAuthorizedRoomEvolutionBenchmarkSnapshotInputV1) {
  const result = selectAuthorizedRoomEvolutionBenchmarkSnapshot(value);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

describe("Room evolution benchmark policy", () => {
  it("selects a bounded, repeatable four-collection snapshot shared by baseline and candidate", () => {
    const first = selected(input());
    const second = selected(input({ cases: [...input().cases].reverse() }));

    expect(first).toEqual(second);
    expect(first.snapshot.selectedCases).toHaveLength(4);
    expect(first.snapshot.selectedCases.filter((entry) => entry.collection === "fixed")).toHaveLength(1);
    expect(first.snapshot.selectedCases).toContainEqual(expect.objectContaining({ id: "rolling-hard" }));
    expect(first.baselineEvaluation).toMatchObject({
      benchmarkSnapshotId: first.snapshot.id,
      benchmarkSnapshotHash: first.snapshot.snapshotHash,
    });
    expect(first.candidateEvaluation).toMatchObject({
      benchmarkSnapshotId: first.snapshot.id,
      benchmarkSnapshotHash: first.snapshot.snapshotHash,
    });
    expect(Object.isFrozen(first.snapshot)).toBe(true);
    expect(Object.isFrozen(first.snapshot.selectedCases)).toBe(true);
  });

  it("fails closed when private or high-risk benchmark data lacks its own authorization", () => {
    const result = selectAuthorizedRoomEvolutionBenchmarkSnapshot(input({
      cases: [
        benchmarkCase("fixed", "private-high-risk", {
          risk: { classification: "high", authorization: null },
          privacy: { containsPrivateData: true, authorization: null },
        }),
      ],
      plans: [{ collection: "fixed", minimumCases: 1, maximumCases: 1 }],
    }));

    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "unauthorized_high_risk_case" }),
        expect.objectContaining({ code: "unauthorized_private_case" }),
      ]),
    });
  });

  it("rejects candidate or model self-enrollment into the benchmark catalog", () => {
    const candidateAuthored = benchmarkCase("fixed", "candidate-authored", {
      source: {
        ...benchmarkCase("fixed", "candidate-authored").source,
        authorActorId: "candidate-author",
      },
    });
    const modelAuthored = benchmarkCase("fixed", "model-authored", {
      source: {
        ...benchmarkCase("fixed", "model-authored").source,
        inclusionAuthority: "candidate_or_model" as never,
      },
    });
    const result = selectAuthorizedRoomEvolutionBenchmarkSnapshot(input({
      cases: [candidateAuthored, modelAuthored],
      plans: [{ collection: "fixed", minimumCases: 1, maximumCases: 2 }],
    }));

    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "self_enrollment_forbidden" }),
        expect.objectContaining({ code: "unauthorized_case_source" }),
      ]),
    });
  });

  it("requires an explicit source authorization for historical replay", () => {
    const historical = benchmarkCase("authorized_historical_replay", "history-without-source-auth", {
      source: {
        ...benchmarkCase("authorized_historical_replay", "history-without-source-auth").source,
        authorization: null,
      },
    });
    const result = selectAuthorizedRoomEvolutionBenchmarkSnapshot(input({
      cases: [historical],
      plans: [{ collection: "authorized_historical_replay", minimumCases: 1, maximumCases: 1 }],
    }));

    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "unauthorized_historical_replay" }),
      ]),
    });
  });
});

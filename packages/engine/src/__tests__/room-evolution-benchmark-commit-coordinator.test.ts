import { describe, expect, it, vi } from "vitest";
import {
  hashRoomValue,
  type RoomEvolutionBenchmarkCaseV1,
  type SelectAuthorizedRoomEvolutionBenchmarkSnapshotInputV1,
} from "@fusion/core";
import {
  RoomEvolutionBenchmarkCommitCoordinator,
  type RoomEvolutionBenchmarkCommitCoordinatorDependenciesV1,
} from "../room-evolution-benchmark-commit-coordinator.js";

const HASH = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const AS_OF = "2026-07-19T14:50:00.000Z";

function authorization(id: string) {
  return { id, evidenceHash: HASH, grantedByActorId: "benchmark-governance", grantedAt: AS_OF };
}

function materializationBody(collection: RoomEvolutionBenchmarkCaseV1["collection"]) {
  return {
    casePayload: { catalogCaseId: `case-${collection}`, collection },
    expectedOutcome: { status: "pass" },
  };
}

function materializationHash(collection: RoomEvolutionBenchmarkCaseV1["collection"]): string {
  const materialization = materializationBody(collection);
  return hashRoomValue(materialization);
}

function benchmarkCase(collection: RoomEvolutionBenchmarkCaseV1["collection"]): RoomEvolutionBenchmarkCaseV1 {
  const sourceByCollection = {
    fixed: { kind: "human_curated_fixed" as const, inclusionAuthority: "human_curator" as const, authorization: null },
    rolling_difficult: { kind: "authorized_difficulty_pool" as const, inclusionAuthority: "human_curator" as const, authorization: null },
    adversarial: { kind: "independent_adversarial_corpus" as const, inclusionAuthority: "independent_benchmark_governance" as const, authorization: null },
    authorized_historical_replay: {
      kind: "authorized_historical_outcome" as const,
      inclusionAuthority: "authorized_historical_ingestion" as const,
      authorization: authorization("history-authorized"),
    },
  }[collection];
  return {
    contractVersion: 1,
    id: `case-${collection}`,
    version: 1,
    contentHash: materializationHash(collection),
    projectId: "project-evolution",
    roomId: null,
    domain: "coding",
    collection,
    difficulty: collection === "rolling_difficult" ? 95 : 50,
    risk: { classification: "low", authorization: null },
    privacy: { containsPrivateData: false, authorization: null },
    source: {
      kind: sourceByCollection.kind,
      reference: `catalog://${collection}`,
      evidenceHash: HASH,
      inclusionAuthority: sourceByCollection.inclusionAuthority,
      authorActorId: "benchmark-governance",
      authorization: sourceByCollection.authorization,
    },
  };
}

function selectionInput(): SelectAuthorizedRoomEvolutionBenchmarkSnapshotInputV1 {
  const collections = ["fixed", "rolling_difficult", "adversarial", "authorized_historical_replay"] as const;
  return {
    contractVersion: 1,
    projectId: "project-evolution",
    roomId: null,
    snapshotId: "snapshot-evolution-v2",
    catalogVersion: 2,
    asOf: AS_OF,
    baseline: {
      candidateVersionId: "candidate-v1",
      immutableArtifactHash: HASH,
      producerActorIds: ["producer-baseline"],
    },
    candidate: {
      candidateVersionId: "candidate-v2",
      immutableArtifactHash: HASH,
      producerActorIds: ["producer-candidate"],
    },
    plans: collections.map((collection) => ({ collection, minimumCases: 1, maximumCases: 1 })),
    cases: collections.map(benchmarkCase),
  };
}

function materializations(input: SelectAuthorizedRoomEvolutionBenchmarkSnapshotInputV1) {
  return input.cases.map((entry) => {
    const body = materializationBody(entry.collection);
    return {
      caseId: entry.id,
      version: entry.version,
      contentHash: entry.contentHash,
      ...body,
      createdAt: AS_OF,
    };
  });
}

function dependencies(overrides: Partial<RoomEvolutionBenchmarkCommitCoordinatorDependenciesV1> = {}) {
  const ledger = {
    appendBenchmarkCase: vi.fn(async (input: { readonly id: string; readonly contentHash: string }) => ({
      table: "room_evolution_benchmark_cases" as const,
      record: { id: input.id, contentHash: input.contentHash },
    })),
  };
  return { dependencies: { ledger, ...overrides } as RoomEvolutionBenchmarkCommitCoordinatorDependenciesV1, ledger };
}

describe("Room evolution benchmark commit coordinator", () => {
  it("selects only authorized four-family benchmark cases and appends their immutable catalog versions", async () => {
    const input = selectionInput();
    const harness = dependencies();
    const coordinator = new RoomEvolutionBenchmarkCommitCoordinator(harness.dependencies);

    const result = await coordinator.selectAndCommit({
      contractVersion: 1,
      selection: input,
      materializations: materializations(input),
    });

    expect(result).toMatchObject({
      status: "committed",
      snapshot: { id: "snapshot-evolution-v2", selectedCases: expect.arrayContaining([
        expect.objectContaining({ collection: "fixed" }),
        expect.objectContaining({ collection: "rolling_difficult" }),
        expect.objectContaining({ collection: "adversarial" }),
        expect.objectContaining({ collection: "authorized_historical_replay" }),
      ]) },
    });
    expect(harness.ledger.appendBenchmarkCase).toHaveBeenCalledTimes(4);
    expect(harness.ledger.appendBenchmarkCase).toHaveBeenCalledWith(expect.objectContaining({
      id: "benchmark:case-fixed:v1",
      caseKind: "golden",
      containsPrivateRoomData: false,
    }));
    expect(harness.ledger.appendBenchmarkCase).toHaveBeenCalledWith(expect.objectContaining({
      id: "benchmark:case-authorized_historical_replay:v1",
      caseKind: "historical_replay",
      sourceAuthorizationId: "history-authorized",
    }));
  });

  it("does not append any case when a selected benchmark lacks its immutable materialization", async () => {
    const input = selectionInput();
    const harness = dependencies();
    const coordinator = new RoomEvolutionBenchmarkCommitCoordinator(harness.dependencies);

    const result = await coordinator.selectAndCommit({
      contractVersion: 1,
      selection: input,
      materializations: materializations(input).slice(1),
    });

    expect(result).toMatchObject({ status: "withheld", reason: "selected_case_materialization_missing" });
    expect(harness.ledger.appendBenchmarkCase).not.toHaveBeenCalled();
  });

  it("does not persist a case when the independent benchmark policy rejects its source or privacy authorization", async () => {
    const input = selectionInput();
    const harness = dependencies();
    const coordinator = new RoomEvolutionBenchmarkCommitCoordinator(harness.dependencies);
    const unauthorizedCases = input.cases.map((entry) => entry.id === "case-authorized_historical_replay"
      ? { ...entry, source: { ...entry.source, authorization: null } }
      : entry);

    const result = await coordinator.selectAndCommit({
      contractVersion: 1,
      selection: { ...input, cases: unauthorizedCases },
      materializations: materializations(input),
    });

    expect(result).toMatchObject({ status: "policy_rejected" });
    expect(harness.ledger.appendBenchmarkCase).not.toHaveBeenCalled();
  });

  it("rejects a payload that no longer matches its immutable declared content hash", async () => {
    const input = selectionInput();
    const harness = dependencies();
    const coordinator = new RoomEvolutionBenchmarkCommitCoordinator(harness.dependencies);
    const materials = materializations(input);
    const tampered = [
      { ...materials[0], casePayload: { ...materials[0].casePayload, tampered: true } },
      ...materials.slice(1),
    ];

    const result = await coordinator.selectAndCommit({
      contractVersion: 1,
      selection: input,
      materializations: tampered,
    });

    expect(result).toMatchObject({ status: "withheld", reason: "selected_case_materialization_invalid" });
    expect(harness.ledger.appendBenchmarkCase).not.toHaveBeenCalled();
  });
});

import {
  AsyncRoomEvidenceLedger,
  hashRoomValue,
  type RoomCandidateRecordV1,
  type RoomEvidenceLedgerEntry,
  type RoomEvidenceLedgerPersistence,
  type RoomEvidenceLedgerReferenceSnapshot,
  type RoomEvidenceLedgerTransaction,
  type RoomEvidenceRecordV1,
} from "@fusion/core";
import { describe, expect, it } from "vitest";

import {
  RoomDeterministicEvidenceGateCoordinator,
  createRoomDeterministicEvidenceGateEvidenceBindingHash,
  createRoomDeterministicEvidenceGateEvidenceReader,
  createRoomDeterministicEvidenceGateLedgerPort,
  type ExecuteRoomDeterministicEvidenceGatesV1,
  type RoomDeterministicEvidenceGateCoordinatorDependenciesV1,
  type RoomDeterministicEvidenceGateLedgerPortV1,
  type RoomDeterministicEvidenceGateRunnerInputV1,
  type RoomDeterministicEvidenceGateRunnerOutputV1,
} from "../room-deterministic-evidence-gate-coordinator.js";

const AT = "2026-07-19T14:30:00.000Z";
const HASH = (character: string) => `sha256:${character.repeat(64)}`;
const SCOPE = { projectId: "project-deterministic-evidence", roomId: "room-deterministic-evidence" } as const;
const SCOPE_HASH = hashRoomValue(SCOPE);
const CANDIDATE_HASH = HASH("a");
const ROOM_HASH = HASH("b");
const GATE_KINDS = ["rule", "test", "source", "runtime"] as const;
type GateKind = (typeof GATE_KINDS)[number];

class MemoryRoomEvidenceLedgerPersistence implements RoomEvidenceLedgerPersistence {
  readonly entries: RoomEvidenceLedgerEntry[] = [];

  constructor(
    private readonly storedCandidate: RoomCandidateRecordV1,
    private readonly storedEvidence: readonly RoomEvidenceRecordV1[],
  ) {}

  async transaction<TResult>(
    operation: (transaction: RoomEvidenceLedgerTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    return operation({
      resolveReferences: async (input) => this.resolveReferences(input.scope, input.candidateIds, input.evidenceIds),
      loadCandidateEvaluation: async () => null,
      append: async ({ entry }) => {
        if (this.entries.some((existing) => existing.table === entry.table && existing.record.id === entry.record.id)) {
          return { status: "conflict", recordId: entry.record.id };
        }
        this.entries.push(entry);
        return { status: "inserted", recordId: entry.record.id };
      },
    });
  }

  private resolveReferences(
    scope: { readonly projectId: string; readonly roomId: string },
    candidateIds: readonly string[],
    evidenceIds: readonly string[],
  ): RoomEvidenceLedgerReferenceSnapshot {
    const sameScope = scope.projectId === SCOPE.projectId && scope.roomId === SCOPE.roomId;
    return {
      scope,
      artifacts: [],
      evidence: sameScope
        ? this.storedEvidence.filter((entry) => evidenceIds.includes(entry.id))
        : [],
      candidates: sameScope && candidateIds.includes(this.storedCandidate.id)
        ? [this.storedCandidate]
        : [],
      reviews: [],
      dissents: [],
      gateResults: [],
    };
  }
}

function request(): ExecuteRoomDeterministicEvidenceGatesV1 {
  return {
    contractVersion: 1,
    scope: SCOPE,
    candidate: {
      id: "candidate-deterministic-evidence",
      nodeId: "node-deterministic-evidence",
      contentHash: CANDIDATE_HASH,
      roomHash: ROOM_HASH,
      scopeHash: SCOPE_HASH,
      producingBindingId: "binding-candidate-producer",
    },
    gates: GATE_KINDS.map((kind) => ({
      id: `gate-${kind}`,
      kind,
      gateResultId: `gate-result-${kind}`,
      profileId: "profile-deterministic-evidence",
    })),
  };
}

function candidate(input: ExecuteRoomDeterministicEvidenceGatesV1): RoomCandidateRecordV1 {
  return {
    contractVersion: 1,
    id: input.candidate.id,
    roomId: input.scope.roomId,
    nodeId: input.candidate.nodeId,
    producingBindingId: input.candidate.producingBindingId,
    nativeSessionId: "native-candidate",
    happierSessionId: "happier-candidate",
    providerId: "codex",
    modelRef: "gpt-5.6",
    protocolId: "protocol-deterministic-evidence",
    protocolVersion: 1,
    contextVersion: "context-v1",
    inputVersion: "input-v1",
    configVersion: "config-v1",
    contentHash: input.candidate.contentHash,
    artifactIds: [],
    parentCandidateIds: [],
    gateResultIds: input.gates.map((gate) => gate.gateResultId).sort(),
    reviewIds: [],
    promotionState: "pending",
    createdAt: AT,
  } as RoomCandidateRecordV1;
}

function evidence(
  input: ExecuteRoomDeterministicEvidenceGatesV1,
  kind: GateKind,
): RoomEvidenceRecordV1 {
  const gate = input.gates.find((entry) => entry.kind === kind);
  if (!gate) throw new Error(`missing fixture gate for ${kind}`);
  const id = `evidence-${kind}`;
  const contentHash = HASH(String.fromCharCode(99 + GATE_KINDS.indexOf(kind)));
  return {
    contractVersion: 1,
    id,
    roomId: input.scope.roomId,
    nodeId: input.candidate.nodeId,
    candidateId: input.candidate.id,
    kind: kind === "rule" ? "policy" : kind,
    authoritativeSourceUri: `https://evidence.example/${kind}`,
    sourceVersionOrHash: createRoomDeterministicEvidenceGateEvidenceBindingHash({
      contractVersion: 1,
      scope: input.scope,
      candidate: input.candidate,
      gate,
      evidenceId: id,
      evidenceContentHash: contentHash,
    }),
    capturedAt: AT,
    collectionMethod: `independent-${kind}-runner`,
    collectorBindingId: `binding-${kind}`,
    contentHash,
    artifactIds: [],
    authoritativeSourceRetained: true,
    expiresAt: null,
  } as RoomEvidenceRecordV1;
}

type OutputMutation = (
  output: RoomDeterministicEvidenceGateRunnerOutputV1,
  kind: GateKind,
) => unknown;

function runner(
  kind: GateKind,
  evidenceRecord: RoomEvidenceRecordV1,
  mutate: OutputMutation | undefined,
) {
  return {
    bindingId: `binding-${kind}`,
    async run(input: RoomDeterministicEvidenceGateRunnerInputV1): Promise<unknown> {
      const output: RoomDeterministicEvidenceGateRunnerOutputV1 = {
        contractVersion: 1,
        gateId: input.gate.id,
        kind,
        scope: input.scope,
        candidateId: input.candidate.id,
        nodeId: input.candidate.nodeId,
        candidateHash: input.candidate.contentHash,
        roomHash: input.candidate.roomHash,
        scopeHash: input.candidate.scopeHash,
        executionHash: input.executionHash,
        verdict: "passed",
        evidenceId: evidenceRecord.id,
        evidenceContentHash: evidenceRecord.contentHash,
        evidenceBindingHash: createRoomDeterministicEvidenceGateEvidenceBindingHash({
          contractVersion: 1,
          scope: input.scope,
          candidate: input.candidate,
          gate: input.gate,
          evidenceId: evidenceRecord.id,
          evidenceContentHash: evidenceRecord.contentHash,
        }),
        evaluatorBindingId: `binding-${kind}`,
        verification: "independent_execution",
        command: kind === "test" ? "pnpm test" : null,
        exitCode: kind === "test" ? 0 : null,
        recordedAt: AT,
      };
      return mutate?.(output, kind) ?? output;
    },
  };
}

function harness(options: {
  readonly mutate?: OutputMutation;
  readonly gateLedger?: RoomDeterministicEvidenceGateLedgerPortV1;
} = {}) {
  const input = request();
  const evidenceRecords = GATE_KINDS.map((kind) => evidence(input, kind));
  const persistence = new MemoryRoomEvidenceLedgerPersistence(candidate(input), evidenceRecords);
  const coreLedger = new AsyncRoomEvidenceLedger(persistence);
  const dependencies: RoomDeterministicEvidenceGateCoordinatorDependenciesV1 = {
    runners: {
      rule: runner("rule", evidenceRecords[0]!, options.mutate),
      test: runner("test", evidenceRecords[1]!, options.mutate),
      source: runner("source", evidenceRecords[2]!, options.mutate),
      runtime: runner("runtime", evidenceRecords[3]!, options.mutate),
    },
    immutableEvidenceReader: createRoomDeterministicEvidenceGateEvidenceReader(persistence),
    gateLedger: options.gateLedger ?? createRoomDeterministicEvidenceGateLedgerPort(coreLedger),
  };
  return {
    input,
    persistence,
    coordinator: new RoomDeterministicEvidenceGateCoordinator(dependencies),
  };
}

describe("RoomDeterministicEvidenceGateCoordinator", () => {
  it("runs all four independent hard gates and appends only their immutable Core ledger records", async () => {
    const testHarness = harness();

    const result = await testHarness.coordinator.execute(testHarness.input);

    expect(result).toMatchObject({ status: "gates_recorded", promotionEligible: true });
    const persistedGates = testHarness.persistence.entries.filter((entry) => entry.table === "room_gate_results");
    expect(persistedGates).toHaveLength(4);
    expect(persistedGates.map((entry) => entry.record.id)).toEqual([
      "gate-result-rule",
      "gate-result-test",
      "gate-result-source",
      "gate-result-runtime",
    ]);
    expect(persistedGates.every((entry) => entry.record.hard === true && entry.record.status === "passed")).toBe(true);
  });

  it.each([
    [
      "a runner self-reports its own pass",
      (output: RoomDeterministicEvidenceGateRunnerOutputV1, kind: GateKind) => kind === "test"
        ? { ...output, verification: "runner_self_report" as const }
        : output,
      "runner_self_report",
    ],
    [
      "a runner returns a cross-scope result",
      (output: RoomDeterministicEvidenceGateRunnerOutputV1, kind: GateKind) => kind === "source"
        ? { ...output, scope: { projectId: "project-other", roomId: output.scope.roomId } }
        : output,
      "cross_scope",
    ],
    [
      "evidence content hash drifts from the immutable record",
      (output: RoomDeterministicEvidenceGateRunnerOutputV1, kind: GateKind) => kind === "runtime"
        ? { ...output, evidenceContentHash: HASH("a") }
        : output,
      "evidence_mismatch",
    ],
    [
      "a deterministic hard gate fails",
      (output: RoomDeterministicEvidenceGateRunnerOutputV1, kind: GateKind) => kind === "rule"
        ? { ...output, verdict: "failed" as const }
        : output,
      "hard_gate_failed",
    ],
  ])("withholds promotion eligibility and writes no gate when %s", async (_label, mutate, code) => {
    const testHarness = harness({ mutate });

    const result = await testHarness.coordinator.execute(testHarness.input);

    expect(result).toMatchObject({ status: "withheld", promotionEligible: false, reason: { code } });
    expect(testHarness.persistence.entries).toHaveLength(0);
  });

  it("fails closed when the immutable ledger acknowledgement throws", async () => {
    const testHarness = harness({
      gateLedger: {
        async appendGateResult() {
          throw new Error("immutable ledger acknowledgement lost");
        },
      },
    });

    const result = await testHarness.coordinator.execute(testHarness.input);

    expect(result).toMatchObject({
      status: "append_failed",
      promotionEligible: false,
      appendedGateResultIds: [],
    });
    expect(testHarness.persistence.entries).toHaveLength(0);
  });
});

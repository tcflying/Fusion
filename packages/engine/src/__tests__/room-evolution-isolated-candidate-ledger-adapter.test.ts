import { describe, expect, it } from "vitest";

import {
  hashRoomValue,
  type AppendRoomEvolutionCandidateVersionInputV1,
  type RoomEvolutionCandidateVersionRecordV1,
  type RoomEvolutionLedgerAppendResult,
  type RoomEvolutionLedgerScope,
} from "@fusion/core";

import {
  RoomEvolutionIsolatedCandidateLedgerAdapter,
  RoomEvolutionIsolatedCandidateLedgerAdapterError,
  type RequestRoomEvolutionIsolatedCandidateLedgerV1,
  type RoomEvolutionIsolatedCandidateLedgerContextSnapshotV1,
} from "../room-evolution-isolated-candidate-ledger-adapter.js";
import type {
  RoomEvolutionIsolatedCandidateGitWorktreePortV1,
  RoomEvolutionIsolatedCandidateGitWorktreeReceiptV1,
  RoomEvolutionIsolatedCandidateGitWorktreeRequestV1,
} from "../room-evolution-isolated-candidate-coordinator.js";

const BASE_REVISION = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ROLLBACK_REVISION = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CREATED_AT = "2026-07-19T15:36:00.000Z";
const CORE_SCOPE = {
  projectId: "project-evolution-isolation",
  roomId: "room-evolution-isolation",
  scopeKind: "room",
  scopeKey: "room:room-evolution-isolation",
} as const satisfies RoomEvolutionLedgerScope;

function request(): RequestRoomEvolutionIsolatedCandidateLedgerV1 {
  const candidateRequest = {
    contractVersion: 1 as const,
    command: {
      commandId: "command-isolated-candidate-ledger-001",
      idempotencyKey: "idem-isolated-candidate-ledger-001",
      correlationId: "correlation-isolated-candidate-ledger-001",
      causationId: null,
    },
    scope: {
      projectId: CORE_SCOPE.projectId,
      roomId: CORE_SCOPE.roomId,
    },
    candidate: {
      id: "candidate-source-ledger-002",
      hypothesisId: "hypothesis-evolution-ledger-001",
      kind: "source" as const,
      riskClass: "moderate" as const,
      mechanism: "source_code" as const,
      declaredScope: ["engine:room-evolution"],
      repositoryRootPath: "C:\\repo\\main",
      baseRevision: BASE_REVISION,
      rollbackTarget: {
        candidateVersionId: "candidate-baseline-ledger-001",
        revision: ROLLBACK_REVISION,
        candidateRef: "refs/heads/fusion/evolution/candidate-baseline-ledger-001",
      },
      createdByActorId: "worker-evolution-ledger-001",
    },
    approval: null,
  };
  return {
    contractVersion: 1,
    request: candidateRequest,
    candidateVersion: {
      id: candidateRequest.candidate.id,
      hypothesisId: candidateRequest.candidate.hypothesisId,
      candidateHash: hashRoomValue(candidateRequest),
      versionNumber: 2,
      baseCandidateVersionId: "candidate-baseline-ledger-001",
      rollbackTargetCandidateVersionId: "candidate-baseline-ledger-001",
    },
  };
}

function context(input: RequestRoomEvolutionIsolatedCandidateLedgerV1): RoomEvolutionIsolatedCandidateLedgerContextSnapshotV1 {
  return {
    contractVersion: 1,
    scope: CORE_SCOPE,
    candidateId: input.candidateVersion.id,
    hypothesisId: input.candidateVersion.hypothesisId,
    candidateHash: input.candidateVersion.candidateHash,
    versionNumber: input.candidateVersion.versionNumber,
    baseCandidateVersionId: input.candidateVersion.baseCandidateVersionId,
    rollbackTargetCandidateVersionId: input.candidateVersion.rollbackTargetCandidateVersionId,
    producedByActorId: input.request.candidate.createdByActorId,
    createdAt: CREATED_AT,
  };
}

function receipt(input: RoomEvolutionIsolatedCandidateGitWorktreeRequestV1): RoomEvolutionIsolatedCandidateGitWorktreeReceiptV1 {
  return {
    contractVersion: 1,
    candidateId: input.candidateId,
    scope: input.scope,
    repositoryRootPath: input.repositoryRootPath,
    branchRef: input.branchRef,
    worktreeName: input.worktreeName,
    worktreePath: `${input.repositoryRootPath}\\.worktrees\\${input.worktreeName}`,
    baseRevision: input.baseRevision,
    rollbackTarget: input.rollbackTarget,
    checkout: {
      kind: "linked_worktree",
      cleanliness: "clean",
      occupancy: "dedicated",
      mutationTarget: "candidate_worktree",
    },
  };
}

function acknowledgment(
  input: AppendRoomEvolutionCandidateVersionInputV1,
): RoomEvolutionLedgerAppendResult<"room_evolution_candidate_versions", RoomEvolutionCandidateVersionRecordV1> {
  return {
    table: "room_evolution_candidate_versions",
    record: {
      contractVersion: 1,
      id: input.id,
      projectId: input.scope.projectId,
      roomId: input.scope.roomId,
      scopeKind: input.scope.scopeKind,
      scopeKey: input.scope.scopeKey,
      hypothesisId: input.hypothesisId,
      versionNumber: input.versionNumber,
      candidateKind: input.candidateKind,
      baseRevision: input.baseRevision,
      candidateRef: input.candidateRef,
      isolationKind: input.isolationKind,
      isolationRef: input.isolationRef,
      immutableInput: input.immutableInput,
      inputHash: input.inputHash,
      producedByActorId: input.producedByActorId,
      baseCandidateVersionId: input.baseCandidateVersionId,
      rollbackTargetCandidateVersionId: input.rollbackTargetCandidateVersionId,
      createdAt: input.createdAt,
    },
  };
}

function harness(options: {
  readonly suppliedContext?: RoomEvolutionIsolatedCandidateLedgerContextSnapshotV1 | null;
  readonly acknowledge?: (
    input: AppendRoomEvolutionCandidateVersionInputV1,
  ) => RoomEvolutionLedgerAppendResult<"room_evolution_candidate_versions", RoomEvolutionCandidateVersionRecordV1>;
} = {}) {
  const input = request();
  const gitRequests: RoomEvolutionIsolatedCandidateGitWorktreeRequestV1[] = [];
  const appendInputs: AppendRoomEvolutionCandidateVersionInputV1[] = [];
  const git: RoomEvolutionIsolatedCandidateGitWorktreePortV1 = {
    async createDedicatedCandidate(candidate) {
      gitRequests.push(candidate);
      return receipt(candidate);
    },
  };
  const adapter = new RoomEvolutionIsolatedCandidateLedgerAdapter({
    git,
    contextReader: {
      async readIsolatedCandidateContext() {
        return options.suppliedContext ?? context(input);
      },
    },
    ledger: {
      async appendCandidateVersion(candidate) {
        appendInputs.push(candidate);
        return options.acknowledge?.(candidate) ?? acknowledgment(candidate);
      },
    },
  });
  return { adapter, appendInputs, gitRequests, input };
}

describe("RoomEvolutionIsolatedCandidateLedgerAdapter", () => {
  it("creates through the existing coordinator and persists the exact authorized candidate version", async () => {
    const { adapter, appendInputs, gitRequests, input } = harness();

    const result = await adapter.create(input);

    expect(result).toMatchObject({
      status: "created",
      candidate: { id: input.candidateVersion.id },
      rollbackLineage: { toCandidateVersionId: input.candidateVersion.rollbackTargetCandidateVersionId },
    });
    expect(gitRequests).toHaveLength(1);
    expect(appendInputs).toHaveLength(1);
    expect(appendInputs[0]).toMatchObject({
      scope: CORE_SCOPE,
      id: input.candidateVersion.id,
      hypothesisId: input.candidateVersion.hypothesisId,
      versionNumber: input.candidateVersion.versionNumber,
      candidateKind: "source_code",
      baseRevision: BASE_REVISION,
      candidateRef: `fusion/evolution/${input.candidateVersion.id}`,
      isolationKind: "worktree",
      isolationRef: "C:\\repo\\main\\.worktrees\\evolution-candidate-source-ledger-002",
      producedByActorId: input.request.candidate.createdByActorId,
      baseCandidateVersionId: input.candidateVersion.baseCandidateVersionId,
      rollbackTargetCandidateVersionId: input.candidateVersion.rollbackTargetCandidateVersionId,
      createdAt: CREATED_AT,
    });
    expect(appendInputs[0]?.inputHash).toBe(hashRoomValue(appendInputs[0]?.immutableInput));
    expect(appendInputs[0]?.inputHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(appendInputs[0]?.immutableInput).toMatchObject({
      contractVersion: 1,
      candidateVersion: input.candidateVersion,
      request: input.request,
      authorizedContext: context(input),
    });
  });

  it.each([
    ["identity", { id: "candidate-source-ledger-other" }],
    ["hash", { candidateHash: `sha256:${"f".repeat(64)}` }],
    ["bare hash", { candidateHash: "f".repeat(64) }],
    ["uppercase hash", { candidateHash: `sha256:${"F".repeat(64)}` }],
    ["version", { versionNumber: 3 }],
  ])("rejects a caller-supplied %s mismatch before Git isolation", async (_label, override) => {
    const { adapter, appendInputs, gitRequests, input } = harness();
    const malformed = {
      ...input,
      candidateVersion: { ...input.candidateVersion, ...override },
    } as RequestRoomEvolutionIsolatedCandidateLedgerV1;

    await expect(adapter.create(malformed)).rejects.toBeInstanceOf(RoomEvolutionIsolatedCandidateLedgerAdapterError);
    expect(gitRequests).toEqual([]);
    expect(appendInputs).toEqual([]);
  });

  it("rejects a Core acknowledgement that changes a bound candidate field", async () => {
    const { adapter, appendInputs, input } = harness({
      acknowledge: (append) => ({
        ...acknowledgment(append),
        record: { ...acknowledgment(append).record, candidateRef: "fusion/evolution/tampered" },
      }),
    });

    const result = await adapter.create(input);

    expect(result).toMatchObject({
      status: "record_failed",
      reason: { code: "record_append_failed" },
    });
    expect(appendInputs).toHaveLength(1);
  });
});

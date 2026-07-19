import { describe, expect, it } from "vitest";

import type { RoomEvidenceLedgerScope } from "@fusion/core";

import {
  RoomEvolutionIsolatedCandidateCoordinator,
  type RequestRoomEvolutionIsolatedCandidateV1,
  type RoomEvolutionIsolatedCandidateGitWorktreePortV1,
  type RoomEvolutionIsolatedCandidateGitWorktreeReceiptV1,
  type RoomEvolutionIsolatedCandidateGitWorktreeRequestV1,
  type RoomEvolutionIsolatedCandidateRecordPortV1,
  type RoomEvolutionIsolatedCandidateRecordV1,
} from "../room-evolution-isolated-candidate-coordinator.js";

const BASE_REVISION = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ROLLBACK_REVISION = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SCOPE = {
  projectId: "project-evolution-isolation",
  roomId: "room-evolution-isolation",
} as const satisfies RoomEvidenceLedgerScope;

function candidateRequest(): RequestRoomEvolutionIsolatedCandidateV1 {
  return {
    contractVersion: 1,
    command: {
      commandId: "command-isolated-candidate-001",
      idempotencyKey: "idem-isolated-candidate-001",
      correlationId: "correlation-isolated-candidate-001",
      causationId: null,
    },
    scope: SCOPE,
    candidate: {
      id: "candidate-policy-001",
      hypothesisId: "hypothesis-evolution-001",
      kind: "policy",
      riskClass: "moderate",
      mechanism: "routing",
      declaredScope: ["engine:room-routing"],
      repositoryRootPath: "/repo/main",
      baseRevision: BASE_REVISION,
      rollbackTarget: {
        candidateVersionId: "candidate-baseline-001",
        revision: ROLLBACK_REVISION,
        candidateRef: "refs/heads/fusion/evolution/candidate-baseline-001",
      },
      createdByActorId: "operator-evolution-001",
    },
    approval: null,
  };
}

function receipt(
  input: RoomEvolutionIsolatedCandidateGitWorktreeRequestV1,
): RoomEvolutionIsolatedCandidateGitWorktreeReceiptV1 {
  return {
    contractVersion: 1,
    candidateId: input.candidateId,
    scope: input.scope,
    repositoryRootPath: input.repositoryRootPath,
    branchRef: input.branchRef,
    worktreeName: input.worktreeName,
    worktreePath: `${input.repositoryRootPath}/.worktrees/${input.worktreeName}`,
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

function harness(
  prepare: (
    input: RoomEvolutionIsolatedCandidateGitWorktreeRequestV1,
  ) => Promise<RoomEvolutionIsolatedCandidateGitWorktreeReceiptV1> = async (input) => receipt(input),
  append: (input: RoomEvolutionIsolatedCandidateRecordV1) => Promise<{
    candidateId: string;
    scope: RoomEvidenceLedgerScope;
    rollbackLineageRecorded: true;
  }> = async (input) => ({
    candidateId: input.candidate.id,
    scope: input.scope,
    rollbackLineageRecorded: true,
  }),
): {
  readonly coordinator: RoomEvolutionIsolatedCandidateCoordinator;
  readonly requests: RoomEvolutionIsolatedCandidateGitWorktreeRequestV1[];
  readonly records: RoomEvolutionIsolatedCandidateRecordV1[];
} {
  const requests: RoomEvolutionIsolatedCandidateGitWorktreeRequestV1[] = [];
  const records: RoomEvolutionIsolatedCandidateRecordV1[] = [];
  const git: RoomEvolutionIsolatedCandidateGitWorktreePortV1 = {
    async createDedicatedCandidate(input) {
      requests.push(input);
      return prepare(input);
    },
  };
  const candidateRecords: RoomEvolutionIsolatedCandidateRecordPortV1 = {
    async appendCreatedCandidate(input) {
      records.push(input);
      return append(input);
    },
  };
  return {
    coordinator: new RoomEvolutionIsolatedCandidateCoordinator({ git, records: candidateRecords }),
    requests,
    records,
  };
}

describe("RoomEvolutionIsolatedCandidateCoordinator", () => {
  it("creates a bounded policy candidate through a dedicated branch/worktree request and records rollback lineage", async () => {
    const { coordinator, requests, records } = harness();

    const result = await coordinator.create(candidateRequest());

    expect(result).toMatchObject({
      status: "created",
      candidate: {
        id: "candidate-policy-001",
        kind: "policy",
        riskClass: "moderate",
        baseRevision: BASE_REVISION,
      },
      isolation: {
        branchRef: "fusion/evolution/candidate-policy-001",
        worktreeName: "evolution-candidate-policy-001",
        worktreePath: "/repo/main/.worktrees/evolution-candidate-policy-001",
      },
      rollbackLineage: {
        fromCandidateId: "candidate-policy-001",
        toCandidateVersionId: "candidate-baseline-001",
        targetRevision: ROLLBACK_REVISION,
        execution: "not_requested",
      },
    });
    expect(requests).toEqual([
      expect.objectContaining({
        candidateId: "candidate-policy-001",
        scope: SCOPE,
        branchRef: "fusion/evolution/candidate-policy-001",
        worktreeName: "evolution-candidate-policy-001",
        baseRevision: BASE_REVISION,
        rollbackTarget: candidateRequest().candidate.rollbackTarget,
      }),
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(records).toEqual([
      expect.objectContaining({
        candidate: expect.objectContaining({ id: "candidate-policy-001" }),
        rollbackLineage: expect.objectContaining({
          toCandidateVersionId: "candidate-baseline-001",
          execution: "not_requested",
        }),
      }),
    ]);
  });

  it("does not invoke the Git port for a high-risk candidate without a bound human approval", async () => {
    const { coordinator, requests } = harness();
    const base = candidateRequest();

    const result = await coordinator.create({
      ...base,
      candidate: { ...base.candidate, riskClass: "high" },
    });

    expect(result).toMatchObject({
      status: "withheld",
      reason: { code: "high_risk_approval_required" },
    });
    expect(requests).toEqual([]);
  });

  it("does not invoke the Git port for an approval bound to a different Room scope", async () => {
    const { coordinator, requests } = harness();
    const base = candidateRequest();
    const candidate = { ...base.candidate, riskClass: "high" as const };

    const result = await coordinator.create({
      ...base,
      candidate,
      approval: {
        id: "approval-evolution-wrong-room",
        status: "approved",
        candidateId: candidate.id,
        scope: { projectId: SCOPE.projectId, roomId: "room-other" },
        riskClass: "high",
        approvedByActorId: "human-approver-001",
        approvedAt: "2026-07-19T14:30:00.000Z",
      },
    });

    expect(result).toMatchObject({ status: "withheld", reason: { code: "invalid_request" } });
    expect(requests).toEqual([]);
  });

  it("accepts a high-risk source candidate only with a matching human approval", async () => {
    const { coordinator, requests } = harness();
    const base = candidateRequest();
    const candidate = {
      ...base.candidate,
      id: "candidate-source-001",
      kind: "source" as const,
      riskClass: "high" as const,
      mechanism: "source_code" as const,
    };

    const result = await coordinator.create({
      ...base,
      candidate,
      approval: {
        id: "approval-evolution-001",
        status: "approved",
        candidateId: candidate.id,
        scope: SCOPE,
        riskClass: "high",
        approvedByActorId: "human-approver-001",
        approvedAt: "2026-07-19T14:30:00.000Z",
      },
    });

    expect(result).toMatchObject({ status: "created", candidate: { id: candidate.id, kind: "source" } });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.approval).toMatchObject({ id: "approval-evolution-001", candidateId: candidate.id });
  });

  it("rejects a Git receipt that points the candidate at the shared main worktree", async () => {
    const { coordinator, requests, records } = harness(async (input) => ({
      ...receipt(input),
      worktreePath: input.repositoryRootPath,
    }));

    const result = await coordinator.create(candidateRequest());

    expect(result).toMatchObject({
      status: "isolation_rejected",
      reason: { code: "base_worktree_returned" },
    });
    expect(requests).toHaveLength(1);
    expect(records).toEqual([]);
  });

  it("rejects dirty or shared checkout receipts instead of exposing a candidate", async () => {
    for (const checkout of [
      { kind: "linked_worktree" as const, cleanliness: "dirty" as const, occupancy: "dedicated" as const, mutationTarget: "candidate_worktree" as const },
      { kind: "linked_worktree" as const, cleanliness: "clean" as const, occupancy: "shared" as const, mutationTarget: "candidate_worktree" as const },
      { kind: "linked_worktree" as const, cleanliness: "clean" as const, occupancy: "dedicated" as const, mutationTarget: "base_worktree" as const },
    ]) {
      const { coordinator } = harness(async (input) => ({ ...receipt(input), checkout }));

      const result = await coordinator.create(candidateRequest());

      expect(result).toMatchObject({ status: "isolation_rejected" });
    }
  });

  it("withholds malformed candidate identity, mechanism, and base revision before any Git request", async () => {
    const { coordinator, requests } = harness();
    const base = candidateRequest();

    const result = await coordinator.create({
      ...base,
      candidate: {
        ...base.candidate,
        id: "",
        kind: "source",
        mechanism: "routing",
        baseRevision: "main",
      },
    });

    expect(result).toMatchObject({ status: "withheld", reason: { code: "invalid_request" } });
    expect(requests).toEqual([]);
  });

  it("rejects a receipt that did not preserve the requested immutable base revision", async () => {
    const { coordinator } = harness(async (input) => ({
      ...receipt(input),
      baseRevision: ROLLBACK_REVISION,
    }));

    const result = await coordinator.create(candidateRequest());

    expect(result).toMatchObject({
      status: "isolation_rejected",
      reason: { code: "base_revision_mismatch" },
    });
  });

  it("does not expose a candidate when immutable rollback-lineage recording fails", async () => {
    const { coordinator, records } = harness(undefined, async () => {
      throw new Error("candidate record unavailable");
    });

    const result = await coordinator.create(candidateRequest());

    expect(result).toMatchObject({
      status: "record_failed",
      reason: { code: "record_append_failed" },
      record: {
        rollbackLineage: { toCandidateVersionId: "candidate-baseline-001" },
      },
    });
    expect(records).toHaveLength(1);
  });
});

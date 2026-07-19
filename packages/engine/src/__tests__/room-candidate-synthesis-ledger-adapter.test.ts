import { describe, expect, it, vi } from "vitest";
import { AsyncRoomEvidenceLedger } from "@fusion/core";
import type {
  AppendRoomCandidateInputV1,
  RoomCandidateRecordV1,
  RoomEvidenceLedgerAppendResult,
  RoomEvidenceLedgerEntry,
  RoomEvidenceLedgerScope,
} from "@fusion/core";

import {
  RoomCandidateSynthesisLedgerAdapter,
  type RoomCandidateSynthesisCandidateLedgerPortV1,
} from "../room-candidate-synthesis-ledger-adapter.js";
import type { AppendRoomCandidateSynthesisInputV1 } from "../room-candidate-synthesis-coordinator.js";

const SCOPE = {
  projectId: "project-candidate-synthesis-adapter",
  roomId: "room-candidate-synthesis-adapter",
} as const satisfies RoomEvidenceLedgerScope;
const NODE_ID = "node-candidate-synthesis-adapter";
const CREATED_AT = "2026-07-19T14:00:00.000Z";
const HASH = `sha256:${"a".repeat(64)}`;

function child(
  overrides: Partial<RoomCandidateRecordV1> = {},
): RoomCandidateRecordV1 {
  return {
    contractVersion: 1,
    id: "candidate-synthesized-child",
    roomId: SCOPE.roomId,
    nodeId: NODE_ID,
    producingBindingId: "binding-synthesizer",
    nativeSessionId: "native-synthesizer",
    happierSessionId: "happier-synthesizer",
    providerId: "happier",
    modelRef: "provider-owned-model",
    protocolId: "implementation",
    protocolVersion: 1,
    contextVersion: "context-v2",
    inputVersion: "input-v2",
    configVersion: "config-v2",
    contentHash: HASH,
    artifactIds: ["artifact-synthesized-child"],
    parentCandidateIds: ["candidate-parent-a", "candidate-parent-b"],
    gateResultIds: [],
    reviewIds: [],
    promotionState: "pending",
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function parentCandidate(id: string): RoomCandidateRecordV1 {
  return child({
    id,
    producingBindingId: `binding-${id}`,
    nativeSessionId: `native-${id}`,
    happierSessionId: `happier-${id}`,
    artifactIds: [],
    parentCandidateIds: [],
  });
}

function synthesisInput(
  overrides: Partial<AppendRoomCandidateSynthesisInputV1> = {},
): AppendRoomCandidateSynthesisInputV1 {
  const candidate = child();
  return {
    command: {
      commandId: "command-candidate-synthesis",
      idempotencyKey: "idempotency-candidate-synthesis",
      correlationId: "correlation-candidate-synthesis",
      causationId: "cause-candidate-synthesis",
    },
    comparison: {
      persistence: "committed",
      id: "comparison-candidate-synthesis",
      scope: SCOPE,
      nodeId: NODE_ID,
      parentCandidateIds: candidate.parentCandidateIds,
      conclusion: "The committed comparison requires a distinct child candidate.",
      concludedAt: CREATED_AT,
    },
    child: candidate,
    revalidation: {
      contractVersion: 1,
      status: "required",
      required: true,
      hardGates: true,
      independentReview: true,
      promotion: true,
      inheritedVerdictsIgnored: true,
      parentCandidateIds: candidate.parentCandidateIds,
      reason: "synthesized_child_requires_fresh_validation",
    },
    ...overrides,
  };
}

function persistedResult(
  input: AppendRoomCandidateInputV1,
): RoomEvidenceLedgerAppendResult<"room_candidates", RoomCandidateRecordV1> {
  return {
    table: "room_candidates",
    record: {
      contractVersion: 1,
      id: input.id,
      roomId: input.scope.roomId,
      nodeId: input.nodeId,
      producingBindingId: input.producingBindingId,
      nativeSessionId: input.nativeSessionId,
      happierSessionId: input.happierSessionId,
      providerId: input.providerId,
      modelRef: input.modelRef,
      protocolId: input.protocolId,
      protocolVersion: input.protocolVersion,
      contextVersion: input.contextVersion,
      inputVersion: input.inputVersion,
      configVersion: input.configVersion,
      contentHash: input.contentHash,
      artifactIds: input.artifactIds,
      parentCandidateIds: input.parentCandidateIds,
      gateResultIds: input.gateResultIds,
      reviewIds: input.reviewIds,
      promotionState: "pending",
      createdAt: input.createdAt,
    },
  };
}

function adapterWith(
  appendCandidate: RoomCandidateSynthesisCandidateLedgerPortV1["appendCandidate"],
): RoomCandidateSynthesisLedgerAdapter {
  return new RoomCandidateSynthesisLedgerAdapter({
    candidateLedger: { appendCandidate },
  });
}

describe("RoomCandidateSynthesisLedgerAdapter", () => {
  it("drives the real AsyncRoomEvidenceLedger appendCandidate boundary", async () => {
    const entries: RoomEvidenceLedgerEntry[] = [];
    const ledger = new AsyncRoomEvidenceLedger({
      transaction: async (operation) => operation({
        resolveReferences: async (query) => ({
          scope: query.scope,
          artifacts: [],
          evidence: [],
          candidates: query.candidateIds.map(parentCandidate),
          reviews: [],
          dissents: [],
          gateResults: [],
        }),
        loadCandidateEvaluation: async () => null,
        append: async ({ entry }) => {
          entries.push(entry);
          return { status: "inserted", recordId: entry.record.id };
        },
      }),
    });
    const adapter = new RoomCandidateSynthesisLedgerAdapter({ candidateLedger: ledger });

    await expect(adapter.appendSynthesis(synthesisInput())).resolves.toMatchObject({
      candidateId: "candidate-synthesized-child",
      revalidationRecorded: true,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      table: "room_candidates",
      record: {
        id: "candidate-synthesized-child",
        parentCandidateIds: ["candidate-parent-a", "candidate-parent-b"],
        gateResultIds: [],
        reviewIds: [],
        promotionState: "pending",
      },
    });
  });

  it("persists a complete immutable child through appendCandidate and records fresh-validation obligations", async () => {
    const appendCandidate = vi.fn(async (input: AppendRoomCandidateInputV1) => persistedResult(input));
    const adapter = adapterWith(appendCandidate);

    const result = await adapter.appendSynthesis(synthesisInput());

    expect(result).toEqual({
      recordId: "candidate-synthesized-child",
      candidateId: "candidate-synthesized-child",
      revalidationRecorded: true,
      replayed: false,
    });
    expect(appendCandidate).toHaveBeenCalledTimes(1);
    expect(appendCandidate).toHaveBeenCalledWith({
      scope: SCOPE,
      id: "candidate-synthesized-child",
      nodeId: NODE_ID,
      producingBindingId: "binding-synthesizer",
      nativeSessionId: "native-synthesizer",
      happierSessionId: "happier-synthesizer",
      providerId: "happier",
      modelRef: "provider-owned-model",
      protocolId: "implementation",
      protocolVersion: 1,
      contextVersion: "context-v2",
      inputVersion: "input-v2",
      configVersion: "config-v2",
      contentHash: HASH,
      artifactIds: ["artifact-synthesized-child"],
      parentCandidateIds: ["candidate-parent-a", "candidate-parent-b"],
      gateResultIds: [],
      reviewIds: [],
      createdAt: CREATED_AT,
    });
  });

  it.each([
    ["gate results", { gateResultIds: ["gate-parent-passed"] }],
    ["reviews", { reviewIds: ["review-parent-accepted"] }],
    ["promotion state", { promotionState: "eligible" as const }],
  ])("rejects an inherited parent %s before it can reach the ledger", async (_label, childOverrides) => {
    const appendCandidate = vi.fn(async (input: AppendRoomCandidateInputV1) => persistedResult(input));
    const adapter = adapterWith(appendCandidate);
    const input = synthesisInput({ child: child(childOverrides) });

    await expect(adapter.appendSynthesis(input)).rejects.toThrow("fresh validation");
    expect(appendCandidate).not.toHaveBeenCalled();
  });

  it("rejects a synthesized child that reuses a parent candidate identity", async () => {
    const appendCandidate = vi.fn(async (input: AppendRoomCandidateInputV1) => persistedResult(input));
    const adapter = adapterWith(appendCandidate);
    const input = synthesisInput({ child: child({ id: "candidate-parent-a" }) });

    await expect(adapter.appendSynthesis(input)).rejects.toThrow("must be distinct from every parent candidate");
    expect(appendCandidate).not.toHaveBeenCalled();
  });

  it("propagates an appendCandidate failure instead of fabricating a creation record", async () => {
    const appendCandidate = vi.fn(async () => {
      throw new Error("durable candidate ledger unavailable");
    });
    const adapter = adapterWith(appendCandidate);

    await expect(adapter.appendSynthesis(synthesisInput())).rejects.toThrow("durable candidate ledger unavailable");
    expect(appendCandidate).toHaveBeenCalledTimes(1);
  });

  it("rejects an append response that did not preserve the requested child and revalidation boundary", async () => {
    const appendCandidate = vi.fn(async (input: AppendRoomCandidateInputV1) => persistedResult({
      ...input,
      gateResultIds: ["gate-inherited-by-bug"],
    }));
    const adapter = adapterWith(appendCandidate);

    await expect(adapter.appendSynthesis(synthesisInput())).rejects.toThrow("does not match the immutable synthesized child");
    expect(appendCandidate).toHaveBeenCalledTimes(1);
  });
});

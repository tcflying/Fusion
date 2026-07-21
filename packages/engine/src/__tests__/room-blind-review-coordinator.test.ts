import { describe, expect, it } from "vitest";
import {
  createInMemoryRoomBlindReviewRegistry,
  hashRoomValue,
  type RoomBlindReviewCandidateLineageV1,
  type RoomBlindReviewPackHashV1,
} from "@fusion/core";

import {
  RoomBlindReviewCoordinator,
  type CreateRoomBlindReviewFanoutInputV1,
  type RoomBlindReviewCandidateAuthorityV1,
  type RoomBlindReviewCoordinatorOptions,
  type RoomBlindReviewRecordedTerminalVerdictV1,
  type RoomBlindReviewRegistryPortV1,
  type RoomBlindReviewRevealAuthorizerV1,
  type RoomBlindReviewRevealPortV1,
  type RoomBlindReviewVerdictLedgerV1,
} from "../room-blind-review-coordinator.js";

const PROJECT_ID = "project-blind-review-coordinator";
const ROOM_ID = "room-blind-review-coordinator";
const REVIEW_ROUND_ID = "review-round-coordinator-1";
const CREATED_AT = "2026-07-18T13:00:00.000Z";
const EXPIRES_AT = "2026-07-18T13:30:00.000Z";

const hash = (value: string): RoomBlindReviewPackHashV1 => hashRoomValue({ value }) as RoomBlindReviewPackHashV1;

function candidate(
  candidateId: string,
  producerBindingIds: readonly string[],
): RoomBlindReviewCandidateLineageV1 & { readonly opaqueCandidateId: string } {
  return {
    candidateId,
    candidateHash: hash(`candidate:${candidateId}`),
    sourceRecordId: `source:${candidateId}`,
    sourceHash: hash(`source:${candidateId}`),
    artifactHash: hash(`artifact:${candidateId}`),
    producerBindingIds,
    opaqueCandidateId: `opaque_${hash(`opaque:${candidateId}`).slice(7, 31)}`,
  };
}

const CANDIDATE_ALPHA = candidate("candidate-alpha", ["binding-producer-alpha"]);
const CANDIDATE_BETA = candidate("candidate-beta", ["binding-producer-beta"]);

function fanoutInput(
  overrides: Partial<CreateRoomBlindReviewFanoutInputV1> = {},
): CreateRoomBlindReviewFanoutInputV1 {
  return {
    contractVersion: 1,
    idempotencyKey: "blind-review-fanout-v1",
    now: CREATED_AT,
    reviewRound: {
      contractVersion: 1,
      scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
      reviewRoundId: REVIEW_ROUND_ID,
      sourceSetHash: hash("source-set"),
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      reviewerBindingIds: ["binding-reviewer"],
    },
    candidateSubmissions: [CANDIDATE_ALPHA, CANDIDATE_BETA],
    ...overrides,
  };
}

interface CoordinatorFixture {
  readonly coordinator: RoomBlindReviewCoordinator;
  readonly revealRequests: unknown[];
}

function coordinatorFixture(input: {
  readonly candidates?: readonly RoomBlindReviewCandidateLineageV1[];
  readonly authorizeReveal?: boolean;
  readonly injectRegistryLeak?: boolean;
} = {}): CoordinatorFixture {
  const backing = createInMemoryRoomBlindReviewRegistry();
  const candidateAuthority: RoomBlindReviewCandidateAuthorityV1 = {
    readCandidateLineage: async ({ candidateId }) =>
      (input.candidates ?? [CANDIDATE_ALPHA, CANDIDATE_BETA]).find((entry) => entry.candidateId === candidateId) ?? null,
  };
  const registry: RoomBlindReviewRegistryPortV1 = input.injectRegistryLeak
    ? leakyRegistry(backing)
    : backing;
  const records = new Map<string, RoomBlindReviewRecordedTerminalVerdictV1>();
  const verdictLedger: RoomBlindReviewVerdictLedgerV1 = {
    recordTerminalVerdict: async (recordInput) => {
      const existing = records.get(recordInput.idempotencyKey);
      if (existing) {
        return { ...existing, replayed: true };
      }
      const record: RoomBlindReviewRecordedTerminalVerdictV1 = {
        contractVersion: 1,
        recordId: `verdict:${recordInput.idempotencyKey}`,
        scope: recordInput.scope,
        reviewRoundId: recordInput.reviewRoundId,
        reviewerBindingId: recordInput.reviewerBindingId,
        idempotencyKey: recordInput.idempotencyKey,
        registryProof: recordInput.registryProof,
        verdict: recordInput.verdict,
        recordedAt: recordInput.now,
        replayed: false,
      };
      records.set(record.idempotencyKey, record);
      return record;
    },
    getTerminalVerdict: async ({ recordId }) =>
      [...records.values()].find((record) => record.recordId === recordId) ?? null,
  };
  const revealAuthorizer: RoomBlindReviewRevealAuthorizerV1 = {
    authorizeReveal: async (request) => {
      if (!input.authorizeReveal) return null;
      return {
        contractVersion: 1,
        authorizationId: `authorization:${request.terminalVerdictRecord.recordId}`,
        scope: request.scope,
        reviewRoundId: request.reviewRoundId,
        requesterBindingId: request.requesterBindingId,
        terminalVerdictRecordId: request.terminalVerdictRecord.recordId,
        issuedAt: request.now,
        expiresAt: EXPIRES_AT,
      };
    },
  };
  const revealRequests: unknown[] = [];
  const revealPort: RoomBlindReviewRevealPortV1 = {
    reveal: async (request) => {
      revealRequests.push(request);
      return {
        contractVersion: 1,
        scope: request.scope,
        reviewRoundId: request.reviewRoundId,
        terminalVerdictRecordId: request.terminalVerdictRecord.recordId,
        authorizationId: request.authorization.authorizationId,
        mappingIntegrityHash: request.terminalVerdictRecord.registryProof.mappingIntegrityHash,
        revealedAt: request.now,
        replayed: false,
        mappings: [{
          opaqueCandidateId: CANDIDATE_ALPHA.opaqueCandidateId,
          candidateId: CANDIDATE_ALPHA.candidateId,
          sourceRecordId: CANDIDATE_ALPHA.sourceRecordId,
          producerBindingIds: CANDIDATE_ALPHA.producerBindingIds,
        }],
      };
    },
  };
  const options: RoomBlindReviewCoordinatorOptions = {
    projectId: PROJECT_ID,
    candidateAuthority,
    registry,
    verdictLedger,
    revealAuthorizer,
    revealPort,
  };
  return { coordinator: new RoomBlindReviewCoordinator(options), revealRequests };
}

function leakyRegistry(
  backing: ReturnType<typeof createInMemoryRoomBlindReviewRegistry>,
): RoomBlindReviewRegistryPortV1 {
  const withLeak = <T extends { readonly pack: object }>(value: T): T => ({
    ...value,
    pack: {
      ...value.pack,
      producerBindingIds: ["binding-producer-alpha"],
      modelLabel: "claude-leaked",
      sessionLabel: "session-leaked",
    },
  }) as T;
  return {
    seal: async (input) => withLeak(await backing.seal(input)),
    getPackForReviewer: async (input) => withLeak(await backing.getPackForReviewer(input)),
  };
}

describe("RoomBlindReviewCoordinator", () => {
  it("delivers only an opaque reviewer payload even if a registry response carries producer, model, or session labels", async () => {
    const { coordinator } = coordinatorFixture({ injectRegistryLeak: true });
    const sealed = await coordinator.createFanout(fanoutInput());
    const delivery = await coordinator.deliverPack({
      contractVersion: 1,
      scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
      reviewRoundId: REVIEW_ROUND_ID,
      reviewerBindingId: "binding-reviewer",
      now: "2026-07-18T13:01:00.000Z",
    });

    expect(sealed.reviewPack.candidates).toHaveLength(2);
    expect(JSON.stringify(sealed)).not.toContain("candidate-alpha");
    expect(JSON.stringify(delivery)).not.toContain("binding-producer-alpha");
    expect(JSON.stringify(delivery)).not.toContain("claude-leaked");
    expect(JSON.stringify(delivery)).not.toContain("session-leaked");
    expect(delivery.reviewPack.candidates[0]).not.toHaveProperty("candidateId");
  });

  it("replays an identical fan-out idempotency key without creating a second mapping", async () => {
    const { coordinator } = coordinatorFixture();

    const first = await coordinator.createFanout(fanoutInput());
    const replayed = await coordinator.createFanout(fanoutInput());

    expect(first).toMatchObject({ replayed: false, reviewRoundId: REVIEW_ROUND_ID });
    expect(replayed).toMatchObject({ replayed: true, registryProof: first.registryProof });
  });

  it("fails closed before sealing unknown, duplicate, or producer-conflicted candidate submissions", async () => {
    const { coordinator } = coordinatorFixture();
    const unknown = candidate("candidate-unknown", ["binding-producer-unknown"]);
    const conflict = candidate("candidate-conflict", ["binding-reviewer"]);
    const { coordinator: conflictCoordinator } = coordinatorFixture({
      candidates: [CANDIDATE_ALPHA, CANDIDATE_BETA, conflict],
    });

    await expect(coordinator.createFanout(fanoutInput({ candidateSubmissions: [unknown] })))
      .rejects.toMatchObject({ code: "unknown_candidate" });
    await expect(coordinator.createFanout(fanoutInput({ candidateSubmissions: [CANDIDATE_ALPHA, CANDIDATE_ALPHA] })))
      .rejects.toMatchObject({ code: "duplicate_candidate" });
    await expect(conflictCoordinator.createFanout(fanoutInput({
      candidateSubmissions: [conflict],
      reviewRound: { ...fanoutInput().reviewRound, reviewRoundId: "review-round-conflict" },
    }))).rejects.toMatchObject({ code: "reviewer_conflict" });
  });

  it("rejects an opaque identifier that embeds a raw candidate or producer identity", async () => {
    const { coordinator } = coordinatorFixture();
    const identityLeakingOpaque = {
      ...CANDIDATE_ALPHA,
      opaqueCandidateId: "opaque_candidate-alpha_randomized_1234",
    };

    await expect(coordinator.createFanout(fanoutInput({ candidateSubmissions: [identityLeakingOpaque] })))
      .rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects a blind-review round with no reviewer bindings before it is sealed", async () => {
    const { coordinator } = coordinatorFixture();

    await expect(coordinator.createFanout(fanoutInput({
      reviewRound: { ...fanoutInput().reviewRound, reviewerBindingIds: [] },
    }))).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("records a final blocked verdict but never invokes reveal until a later authorized request", async () => {
    const { coordinator, revealRequests } = coordinatorFixture();
    await coordinator.createFanout(fanoutInput());
    const delivery = await coordinator.deliverPack({
      contractVersion: 1,
      scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
      reviewRoundId: REVIEW_ROUND_ID,
      reviewerBindingId: "binding-reviewer",
      now: "2026-07-18T13:01:00.000Z",
    });

    const recorded = await coordinator.recordTerminalVerdict({
      contractVersion: 1,
      scope: delivery.scope,
      reviewRoundId: delivery.reviewRoundId,
      reviewerBindingId: delivery.reviewerBindingId,
      idempotencyKey: "blocked-verdict-v1",
      now: "2026-07-18T13:02:00.000Z",
      registryProof: delivery.registryProof,
      verdict: {
        contractVersion: 1,
        outcome: "blocked",
        final: true,
        selectedOpaqueCandidateIds: [],
        evidenceRefs: ["review-evidence-blocked"],
      },
    });

    expect(recorded).toMatchObject({ verdict: { outcome: "blocked", final: true }, replayed: false });
    expect(revealRequests).toEqual([]);
  });

  it("rejects a terminal verdict that lacks the sealed registry proof", async () => {
    const { coordinator } = coordinatorFixture();
    await coordinator.createFanout(fanoutInput());
    const delivery = await coordinator.deliverPack({
      contractVersion: 1,
      scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
      reviewRoundId: REVIEW_ROUND_ID,
      reviewerBindingId: "binding-reviewer",
      now: "2026-07-18T13:01:00.000Z",
    });

    await expect(coordinator.recordTerminalVerdict({
      contractVersion: 1,
      scope: delivery.scope,
      reviewRoundId: delivery.reviewRoundId,
      reviewerBindingId: delivery.reviewerBindingId,
      idempotencyKey: "missing-proof-verdict-v1",
      now: "2026-07-18T13:02:00.000Z",
      registryProof: undefined as unknown as typeof delivery.registryProof,
      verdict: {
        contractVersion: 1,
        outcome: "partial",
        final: true,
        selectedOpaqueCandidateIds: [],
        evidenceRefs: ["review-evidence-partial"],
      },
    })).rejects.toMatchObject({ code: "registry_proof_missing" });
  });

  it("rejects a review verdict that was not explicitly marked final", async () => {
    const { coordinator } = coordinatorFixture();
    await coordinator.createFanout(fanoutInput());
    const delivery = await coordinator.deliverPack({
      contractVersion: 1,
      scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
      reviewRoundId: REVIEW_ROUND_ID,
      reviewerBindingId: "binding-reviewer",
      now: "2026-07-18T13:01:00.000Z",
    });

    await expect(coordinator.recordTerminalVerdict({
      contractVersion: 1,
      scope: delivery.scope,
      reviewRoundId: delivery.reviewRoundId,
      reviewerBindingId: delivery.reviewerBindingId,
      idempotencyKey: "nonterminal-verdict-v1",
      now: "2026-07-18T13:02:00.000Z",
      registryProof: delivery.registryProof,
      verdict: {
        contractVersion: 1,
        outcome: "partial",
        final: false as unknown as true,
        selectedOpaqueCandidateIds: [],
        evidenceRefs: ["review-evidence-partial"],
      },
    })).rejects.toMatchObject({ code: "terminal_verdict_required" });
  });

  it("rejects reveal before a durable terminal verdict and rejects an unauthorized reveal after it", async () => {
    const { coordinator, revealRequests } = coordinatorFixture();
    await coordinator.createFanout(fanoutInput());
    const delivery = await coordinator.deliverPack({
      contractVersion: 1,
      scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
      reviewRoundId: REVIEW_ROUND_ID,
      reviewerBindingId: "binding-reviewer",
      now: "2026-07-18T13:01:00.000Z",
    });

    await expect(coordinator.requestReveal({
      contractVersion: 1,
      scope: delivery.scope,
      reviewRoundId: REVIEW_ROUND_ID,
      requesterBindingId: "binding-operator",
      terminalVerdictRecordId: "missing-verdict",
      idempotencyKey: "reveal-missing-verdict-v1",
      now: "2026-07-18T13:02:00.000Z",
    })).rejects.toMatchObject({ code: "terminal_verdict_not_recorded" });

    const recorded = await coordinator.recordTerminalVerdict({
      contractVersion: 1,
      scope: delivery.scope,
      reviewRoundId: delivery.reviewRoundId,
      reviewerBindingId: delivery.reviewerBindingId,
      idempotencyKey: "dissent-verdict-v1",
      now: "2026-07-18T13:02:00.000Z",
      registryProof: delivery.registryProof,
      verdict: {
        contractVersion: 1,
        outcome: "dissent",
        final: true,
        selectedOpaqueCandidateIds: [],
        evidenceRefs: ["review-evidence-dissent"],
      },
    });

    await expect(coordinator.requestReveal({
      contractVersion: 1,
      scope: delivery.scope,
      reviewRoundId: REVIEW_ROUND_ID,
      requesterBindingId: "binding-operator",
      terminalVerdictRecordId: recorded.recordId,
      idempotencyKey: "reveal-unauthorized-v1",
      now: "2026-07-18T13:03:00.000Z",
    })).rejects.toMatchObject({ code: "reveal_not_authorized" });
    expect(revealRequests).toEqual([]);
  });

  it("delegates the confidential mapping only after a recorded final verdict and authorized reveal", async () => {
    const { coordinator, revealRequests } = coordinatorFixture({ authorizeReveal: true });
    await coordinator.createFanout(fanoutInput());
    const delivery = await coordinator.deliverPack({
      contractVersion: 1,
      scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
      reviewRoundId: REVIEW_ROUND_ID,
      reviewerBindingId: "binding-reviewer",
      now: "2026-07-18T13:01:00.000Z",
    });
    const recorded = await coordinator.recordTerminalVerdict({
      contractVersion: 1,
      scope: delivery.scope,
      reviewRoundId: delivery.reviewRoundId,
      reviewerBindingId: delivery.reviewerBindingId,
      idempotencyKey: "accepted-verdict-v1",
      now: "2026-07-18T13:02:00.000Z",
      registryProof: delivery.registryProof,
      verdict: {
        contractVersion: 1,
        outcome: "accepted",
        final: true,
        selectedOpaqueCandidateIds: [CANDIDATE_ALPHA.opaqueCandidateId],
        evidenceRefs: ["review-evidence-accepted"],
      },
    });

    const revealed = await coordinator.requestReveal({
      contractVersion: 1,
      scope: delivery.scope,
      reviewRoundId: REVIEW_ROUND_ID,
      requesterBindingId: "binding-operator",
      terminalVerdictRecordId: recorded.recordId,
      idempotencyKey: "reveal-authorized-v1",
      now: "2026-07-18T13:03:00.000Z",
    });

    expect(revealRequests).toHaveLength(1);
    expect(revealed).toMatchObject({
      terminalVerdictRecordId: recorded.recordId,
      mappings: [expect.objectContaining({ candidateId: CANDIDATE_ALPHA.candidateId })],
    });
  });
});

import { hashRoomValue, type RoomCandidateRecordV1, type RoomBlindReviewPackHashV1 } from "@fusion/core";
import { describe, expect, it } from "vitest";

import {
  RoomCandidateFanoutBlindReviewCoordinator,
  type RoomCandidateFanoutCandidateEvidenceV1,
  type RoomCandidateFanoutBlindReviewAppendPortV1,
  type RoomCandidateFanoutBlindReviewInputV1,
  type RoomCandidateFanoutBlindReviewRandomizerV1,
  type RoomCandidateFanoutBlindReviewSourceV1,
} from "../room-candidate-fanout-blind-review-coordinator.js";

const PROJECT_ID = "project-fanout-blind-review";
const ROOM_ID = "room-fanout-blind-review";
const NODE_ID = "node-draft";
const NOW = "2026-07-19T12:00:00.000Z";
const EXPIRES_AT = "2026-07-19T13:00:00.000Z";

const hash = (value: unknown): RoomBlindReviewPackHashV1 => hashRoomValue(value) as RoomBlindReviewPackHashV1;

function candidateEvidence(
  id: string,
  producerBindingId: string,
  overrides: Partial<RoomCandidateRecordV1> = {},
): RoomCandidateFanoutCandidateEvidenceV1 {
  const candidate: RoomCandidateRecordV1 = {
    contractVersion: 1,
    id,
    roomId: ROOM_ID,
    nodeId: NODE_ID,
    producingBindingId: producerBindingId,
    nativeSessionId: `native-${id}`,
    happierSessionId: `happier-${id}`,
    providerId: "provider-test",
    modelRef: `model-${id}`,
    protocolId: "protocol-blind-v1",
    protocolVersion: 1,
    contextVersion: "context-v1",
    inputVersion: "input-v1",
    configVersion: "config-v1",
    contentHash: hash({ id, kind: "candidate" }),
    artifactIds: [`artifact-${id}`],
    parentCandidateIds: [],
    gateResultIds: [],
    reviewIds: [],
    promotionState: "pending",
    createdAt: NOW,
    ...overrides,
  };
  return {
    contractVersion: 1,
    scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
    candidate,
    sourceRecordId: `source-${id}`,
    sourceHash: hash({ id, kind: "source" }),
    artifactHash: hash({ id, kind: "artifact" }),
    producerBindingIds: [producerBindingId],
  };
}

function request(
  overrides: Partial<RoomCandidateFanoutBlindReviewInputV1> = {},
): RoomCandidateFanoutBlindReviewInputV1 {
  return {
    contractVersion: 1,
    scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
    nodeId: NODE_ID,
    reviewRoundId: "review-round-fanout-v1",
    idempotencyKey: "fanout-blind-review-v1",
    now: NOW,
    createdAt: NOW,
    expiresAt: EXPIRES_AT,
    candidateIds: ["candidate-alpha", "candidate-beta"],
    reviewerBindingIds: ["binding-reviewer-a", "binding-reviewer-b"],
    minimumReviewerCount: 2,
    ...overrides,
  };
}

function fixture(options: {
  readonly candidates?: readonly RoomCandidateFanoutCandidateEvidenceV1[];
  readonly randomizer?: RoomCandidateFanoutBlindReviewRandomizerV1;
  readonly append?: RoomCandidateFanoutBlindReviewAppendPortV1;
} = {}) {
  const candidates = options.candidates ?? [
    candidateEvidence("candidate-alpha", "binding-producer-alpha"),
    candidateEvidence("candidate-beta", "binding-producer-beta"),
  ];
  const sourceCalls: unknown[] = [];
  const randomizerCalls: unknown[] = [];
  const appendCalls: unknown[] = [];
  const source: RoomCandidateFanoutBlindReviewSourceV1 = {
    async readImmutableCandidateEvidence(input) {
      sourceCalls.push(input);
      return candidates;
    },
  };
  const randomizer = options.randomizer ?? {
    async randomize(input) {
      randomizerCalls.push(input);
      return {
        contractVersion: 1 as const,
        randomizerReceiptId: "randomizer-receipt-v1",
        seed: "secret-seed-not-for-reviewers",
        opaqueBindings: input.candidateIds.map((candidateId, index) => ({
          candidateId,
          opaqueCandidateId: index === 0
            ? "opaque_J7x8mQp2Rk4Vn6Za"
            : "opaque_K5w9Ts3Lc7Yh2BdE",
        })),
      };
    },
  } satisfies RoomCandidateFanoutBlindReviewRandomizerV1;
  const append = options.append ?? {
    async appendBlindReviewFanout(input) {
      appendCalls.push(input);
      return {
        contractVersion: 1 as const,
        scope: input.scope,
        reviewRoundId: input.packInput.reviewRoundId,
        sourceSetHash: input.packInput.sourceSetHash,
        seedHash: input.randomizationAudit.seedHash,
        mappingHash: input.randomizationAudit.mappingHash,
        sealedAt: input.now,
        replayed: false,
      };
    },
  } satisfies RoomCandidateFanoutBlindReviewAppendPortV1;
  return {
    coordinator: new RoomCandidateFanoutBlindReviewCoordinator({
      projectId: PROJECT_ID,
      source,
      randomizer,
      append,
    }),
    sourceCalls,
    randomizerCalls,
    appendCalls,
  };
}

function expectWithheld(
  result: Awaited<ReturnType<RoomCandidateFanoutBlindReviewCoordinator["prepare"]>>,
  code: string,
): void {
  expect(result).toMatchObject({ status: "withheld", code });
}

describe("RoomCandidateFanoutBlindReviewCoordinator", () => {
  it("fans out immutable compatible candidates through real source, randomizer, and append boundaries without leaking producer or session identity", async () => {
    const { coordinator, sourceCalls, randomizerCalls, appendCalls } = fixture();

    const result = await coordinator.prepare(request());

    expect(result.status).toBe("prepared");
    if (result.status !== "prepared") throw new Error("Expected prepared blind-review fan-out");
    expect(sourceCalls).toHaveLength(1);
    expect(randomizerCalls).toHaveLength(1);
    expect(appendCalls).toHaveLength(1);
    expect(randomizerCalls[0]).toMatchObject({ idempotencyKey: "fanout-blind-review-v1" });
    expect(appendCalls[0]).toMatchObject({
      sealedRandomization: {
        randomizerReceiptId: "randomizer-receipt-v1",
        seed: "secret-seed-not-for-reviewers",
      },
      randomizationAudit: result.randomizationAudit,
    });
    expect(result.reviewPack).toMatchObject({
      contractVersion: 1,
      purpose: "blind_review_only",
      reviewRoundId: "review-round-fanout-v1",
      candidates: [
        { opaqueCandidateId: "opaque_J7x8mQp2Rk4Vn6Za" },
        { opaqueCandidateId: "opaque_K5w9Ts3Lc7Yh2BdE" },
      ],
    });
    expect(result.randomizationAudit.seedHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.randomizationAudit.mappingHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    const reviewerPayload = JSON.stringify(result);
    expect(reviewerPayload).not.toContain("candidate-alpha");
    expect(reviewerPayload).not.toContain("binding-producer-alpha");
    expect(reviewerPayload).not.toContain("native-candidate-alpha");
    expect(reviewerPayload).not.toContain("happier-candidate-alpha");
    expect(reviewerPayload).not.toContain("secret-seed-not-for-reviewers");
  });

  it("withholds the fan-out before randomization when candidates do not share the same immutable input, config, and protocol", async () => {
    const { coordinator, randomizerCalls, appendCalls } = fixture({
      candidates: [
        candidateEvidence("candidate-alpha", "binding-producer-alpha"),
        candidateEvidence("candidate-beta", "binding-producer-beta", { configVersion: "config-v2" }),
      ],
    });

    const result = await coordinator.prepare(request());

    expectWithheld(result, "candidate_execution_mismatch");
    expect(randomizerCalls).toEqual([]);
    expect(appendCalls).toEqual([]);
  });

  it("withholds the fan-out before randomization when a source candidate crosses the requested Room scope", async () => {
    const scopedElsewhere = candidateEvidence("candidate-beta", "binding-producer-beta");
    const { coordinator, randomizerCalls, appendCalls } = fixture({
      candidates: [
        candidateEvidence("candidate-alpha", "binding-producer-alpha"),
        { ...scopedElsewhere, scope: { projectId: PROJECT_ID, roomId: "room-other" } },
      ],
    });

    const result = await coordinator.prepare(request());

    expectWithheld(result, "candidate_scope_mismatch");
    expect(randomizerCalls).toEqual([]);
    expect(appendCalls).toEqual([]);
  });

  it("withholds the fan-out when the requested minimum independent reviewer count is not met", async () => {
    const { coordinator, sourceCalls, randomizerCalls, appendCalls } = fixture();

    const result = await coordinator.prepare(request({ minimumReviewerCount: 3 }));

    expectWithheld(result, "minimum_reviewers_not_met");
    expect(sourceCalls).toEqual([]);
    expect(randomizerCalls).toEqual([]);
    expect(appendCalls).toEqual([]);
  });

  it("withholds the fan-out before randomization when a candidate producer is assigned as a reviewer", async () => {
    const { coordinator, randomizerCalls, appendCalls } = fixture();

    const result = await coordinator.prepare(request({
      reviewerBindingIds: ["binding-producer-alpha", "binding-reviewer-b"],
    }));

    expectWithheld(result, "reviewer_conflict");
    expect(randomizerCalls).toEqual([]);
    expect(appendCalls).toEqual([]);
  });

  it("withholds the fan-out when randomized opaque bindings are incomplete or identity-leaking", async () => {
    const { coordinator, appendCalls } = fixture({
      randomizer: {
        async randomize() {
          return {
            contractVersion: 1,
            randomizerReceiptId: "randomizer-receipt-v1",
            seed: "secret-seed-not-for-reviewers",
            opaqueBindings: [{
              candidateId: "candidate-alpha",
              opaqueCandidateId: "opaque_candidate-alpha_1234567890",
            }],
          };
        },
      },
    });

    const result = await coordinator.prepare(request());

    expectWithheld(result, "randomization_invalid");
    expect(appendCalls).toEqual([]);
  });

  it("withholds the fan-out when the randomizer audit receipt itself embeds a candidate identity", async () => {
    const { coordinator, appendCalls } = fixture({
      randomizer: {
        async randomize(input) {
          return {
            contractVersion: 1,
            randomizerReceiptId: "receipt-candidate-alpha-leak",
            seed: "secret-seed-not-for-reviewers",
            opaqueBindings: input.candidateIds.map((candidateId, index) => ({
              candidateId,
              opaqueCandidateId: index === 0
                ? "opaque_J7x8mQp2Rk4Vn6Za"
                : "opaque_K5w9Ts3Lc7Yh2BdE",
            })),
          };
        },
      },
    });

    const result = await coordinator.prepare(request());

    expectWithheld(result, "randomization_invalid");
    expect(appendCalls).toEqual([]);
  });

  it("binds the randomization audit hash to the exact idempotency command and reviewer roster", async () => {
    const first = await fixture().coordinator.prepare(request());
    const second = await fixture().coordinator.prepare(request({
      idempotencyKey: "fanout-blind-review-v2",
      reviewerBindingIds: ["binding-reviewer-c", "binding-reviewer-d"],
    }));

    expect(first.status).toBe("prepared");
    expect(second.status).toBe("prepared");
    if (first.status !== "prepared" || second.status !== "prepared") throw new Error("Expected prepared blind-review fan-outs");
    expect(second.randomizationAudit.mappingHash).not.toBe(first.randomizationAudit.mappingHash);
  });

  it("does not emit a prepared pack when the durable append boundary fails", async () => {
    const { coordinator } = fixture({
      append: {
        async appendBlindReviewFanout() {
          throw new Error("durable registry unavailable");
        },
      },
    });

    const result = await coordinator.prepare(request());

    expectWithheld(result, "append_failed");
  });
});

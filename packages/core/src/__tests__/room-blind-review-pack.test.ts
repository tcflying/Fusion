import { describe, expect, it } from "vitest";

import {
  createRoomBlindReviewPack,
  validateRoomBlindReviewPack,
  type CreateRoomBlindReviewPackInputV1,
} from "../room-blind-review-pack.js";

const hash = (letter: string) => `sha256:${letter.repeat(64)}` as const;

function validInput(): CreateRoomBlindReviewPackInputV1 {
  return {
    contractVersion: 1,
    reviewRoundId: "round-7",
    sourceSetHash: hash("a"),
    createdAt: "2026-07-19T10:30:00.000Z",
    reviewers: [{ bindingId: "reviewer-independent" }],
    candidateLineage: [
      {
        candidateId: "candidate-alpha",
        candidateHash: hash("b"),
        sourceRecordId: "evidence-101",
        sourceHash: hash("c"),
        artifactHash: hash("d"),
        producerBindingIds: ["writer-alpha"],
      },
      {
        candidateId: "candidate-beta",
        candidateHash: hash("e"),
        sourceRecordId: "evidence-102",
        sourceHash: hash("f"),
        artifactHash: hash("0"),
        producerBindingIds: ["writer-beta"],
      },
    ],
    opaqueBindings: [
      { candidateId: "candidate-beta", opaqueCandidateId: "opaque_vRXp_PkTg7m3z6aA9Q1" },
      { candidateId: "candidate-alpha", opaqueCandidateId: "opaque_Z7k2xw8mQpV3sN6dL4r" },
    ],
  };
}

describe("Room blind-review packs", () => {
  it("fans out a frozen deterministic redaction view without source or producer identity", () => {
    const result = createRoomBlindReviewPack(validInput());

    expect(result.valid).toBe(true);
    expect(result.expectedPack).toEqual({
      contractVersion: 1,
      purpose: "blind_review_only",
      reviewRoundId: "round-7",
      sourceSetHash: hash("a"),
      createdAt: "2026-07-19T10:30:00.000Z",
      reviewerBindingIds: ["reviewer-independent"],
      candidates: [
        { opaqueCandidateId: "opaque_vRXp_PkTg7m3z6aA9Q1", candidateHash: hash("e"), artifactHash: hash("0") },
        { opaqueCandidateId: "opaque_Z7k2xw8mQpV3sN6dL4r", candidateHash: hash("b"), artifactHash: hash("d") },
      ],
    });
    expect(Object.isFrozen(result.expectedPack)).toBe(true);
    expect(JSON.stringify(result.expectedPack)).not.toContain("candidate-alpha");
    expect(JSON.stringify(result.expectedPack)).not.toContain("writer-alpha");
  });

  it("rejects a reviewer present in any candidate producer lineage", () => {
    const input = validInput();
    input.reviewers = [{ bindingId: "writer-alpha" }];

    expect(createRoomBlindReviewPack(input).rejections).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "reviewer_not_independent" })]),
    );
  });

  it("rejects duplicate or non-opaque candidate randomization bindings", () => {
    const input = validInput();
    input.opaqueBindings = [
      { candidateId: "candidate-alpha", opaqueCandidateId: "candidate-alpha" },
      { candidateId: "candidate-beta", opaqueCandidateId: "candidate-alpha" },
    ];

    expect(createRoomBlindReviewPack(input).rejections).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "invalid_opaque_identity" })]),
    );
  });

  it("rejects source and candidate hash lineage tampering", () => {
    const input = validInput();
    input.candidateLineage[0] = { ...input.candidateLineage[0], sourceHash: "not-a-sha" as `sha256:${string}` };

    expect(createRoomBlindReviewPack(input).rejections).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "candidate_lineage_mismatch" })]),
    );
  });

  it("rejects a reviewer-visible pack when a candidate hash is modified", () => {
    const input = validInput();
    const pack = createRoomBlindReviewPack(input).expectedPack!;
    const tampered = { ...pack, candidates: [{ ...pack.candidates[0], artifactHash: hash("1") }, ...pack.candidates.slice(1)] };

    expect(validateRoomBlindReviewPack(input, tampered).rejections).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "redaction_view_mismatch" })]),
    );
  });

  it("rejects hidden identity and any acceptance/promotion authority fields", () => {
    const input = validInput();
    const pack = createRoomBlindReviewPack(input).expectedPack!;
    const forged = { ...pack, acceptance: "accepted", candidateId: "candidate-alpha" };

    expect(validateRoomBlindReviewPack(input, forged).rejections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "forbidden_review_authority" }),
        expect.objectContaining({ code: "unexpected_property", path: "$.pack.candidateId" }),
      ]),
    );
  });

  it("rejects opaque mappings that reference a non-fan-out candidate", () => {
    const input = validInput();
    input.opaqueBindings = [
      ...input.opaqueBindings,
      { candidateId: "candidate-ghost", opaqueCandidateId: "opaque_Q7x2mY9sLd4vN6kP3r" },
    ];

    expect(createRoomBlindReviewPack(input).rejections).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "opaque_binding_mismatch" })]),
    );
  });
});

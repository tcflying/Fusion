import { describe, expect, it } from "vitest";

import {
  createInMemoryRoomBlindReviewRegistry,
  type ReadRoomBlindReviewPackInputV1,
  type SealRoomBlindReviewMappingInputV1,
} from "../room-blind-review-registry.js";
import type {
  CreateRoomBlindReviewPackInputV1,
  RoomBlindReviewPackHashV1,
} from "../room-blind-review-pack.js";
import { hashRoomValue } from "../room-integrity.js";

const PROJECT_ID = "project-blind-review-registry";
const ROOM_ID = "room-blind-review-registry";
const REVIEW_ID = "review-round-registry-1";
const SEALED_AT = "2026-07-18T12:00:00.000Z";
const EXPIRES_AT = "2026-07-18T12:30:00.000Z";

const hash = (value: string): RoomBlindReviewPackHashV1 => hashRoomValue({ value }) as RoomBlindReviewPackHashV1;

function packInput(
  overrides: Partial<CreateRoomBlindReviewPackInputV1> = {},
): CreateRoomBlindReviewPackInputV1 {
  return {
    contractVersion: 1,
    reviewRoundId: REVIEW_ID,
    sourceSetHash: hash("source-set"),
    createdAt: SEALED_AT,
    reviewers: [{ bindingId: "binding-reviewer" }],
    candidateLineage: [
      {
        candidateId: "candidate-alpha",
        candidateHash: hash("candidate-alpha"),
        sourceRecordId: "source-alpha",
        sourceHash: hash("source-alpha"),
        artifactHash: hash("artifact-alpha"),
        producerBindingIds: ["binding-producer-alpha"],
      },
      {
        candidateId: "candidate-beta",
        candidateHash: hash("candidate-beta"),
        sourceRecordId: "source-beta",
        sourceHash: hash("source-beta"),
        artifactHash: hash("artifact-beta"),
        producerBindingIds: ["binding-producer-beta"],
      },
    ],
    opaqueBindings: [
      { candidateId: "candidate-alpha", opaqueCandidateId: "opaque_candidate_alpha_0001" },
      { candidateId: "candidate-beta", opaqueCandidateId: "opaque_candidate_beta_0002" },
    ],
    ...overrides,
  };
}

function sealInput(
  overrides: Partial<SealRoomBlindReviewMappingInputV1> = {},
): SealRoomBlindReviewMappingInputV1 {
  return {
    contractVersion: 1,
    scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
    idempotencyKey: "seal-blind-review-registry-v1",
    now: SEALED_AT,
    expiresAt: EXPIRES_AT,
    packInput: packInput(),
    ...overrides,
  };
}

function readInput(overrides: Partial<ReadRoomBlindReviewPackInputV1> = {}): ReadRoomBlindReviewPackInputV1 {
  return {
    contractVersion: 1,
    scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
    reviewRoundId: REVIEW_ID,
    reviewerBindingId: "binding-reviewer",
    now: "2026-07-18T12:10:00.000Z",
    ...overrides,
  };
}

describe("Room blind-review registry", () => {
  it("seals a deterministic opaque mapping while returning only the existing redacted pack", async () => {
    const registry = createInMemoryRoomBlindReviewRegistry();
    const sealed = await registry.seal(sealInput());

    expect(sealed).toMatchObject({
      replayed: false,
      reviewRoundId: REVIEW_ID,
      pack: {
        purpose: "blind_review_only",
        candidates: [
          { opaqueCandidateId: "opaque_candidate_alpha_0001" },
          { opaqueCandidateId: "opaque_candidate_beta_0002" },
        ],
      },
    });
    expect(JSON.stringify(sealed)).not.toContain("candidate-alpha");
    expect(JSON.stringify(sealed)).not.toContain("binding-producer-alpha");
    expect(sealed.pack.candidates[0]).not.toHaveProperty("candidateId");
    await expect(registry.getPackForReviewer(readInput())).resolves.toMatchObject({
      reviewRoundId: REVIEW_ID,
      mappingIntegrityHash: sealed.mappingIntegrityHash,
      pack: sealed.pack,
    });
    await expect(registry.seal(sealInput())).resolves.toMatchObject({ replayed: true });
  });

  it("rejects producer-reviewer conflicts before a mapping is persisted", async () => {
    const registry = createInMemoryRoomBlindReviewRegistry();
    await expect(registry.seal(sealInput({
      packInput: packInput({ reviewers: [{ bindingId: "binding-producer-alpha" }] }),
    }))).rejects.toMatchObject({ code: "reviewer_conflict" });
  });

  it("handles mismatched, expired, and replayed sealing submissions deterministically", async () => {
    const registry = createInMemoryRoomBlindReviewRegistry();
    await registry.seal(sealInput());

    await expect(registry.seal(sealInput({ expiresAt: "2026-07-18T12:31:00.000Z" })))
      .rejects.toMatchObject({ code: "idempotency_mismatch" });
    await expect(registry.seal(sealInput({ idempotencyKey: "seal-blind-review-registry-replayed" })))
      .rejects.toMatchObject({ code: "review_already_sealed" });

    const expired = createInMemoryRoomBlindReviewRegistry();
    await expect(expired.seal(sealInput({ expiresAt: SEALED_AT })))
      .rejects.toMatchObject({ code: "review_expired" });

    const shortLived = createInMemoryRoomBlindReviewRegistry();
    await shortLived.seal(sealInput({ expiresAt: "2026-07-18T12:05:00.000Z" }));
    await expect(shortLived.getPackForReviewer(readInput({ now: "2026-07-18T12:06:00.000Z" })))
      .rejects.toMatchObject({ code: "review_expired" });
  });
});

export const ROOM_BLIND_REVIEW_PACK_CONTRACT_VERSION = 1 as const;

export type RoomBlindReviewPackHashV1 = `sha256:${string}`;

export interface RoomBlindReviewCandidateLineageV1 {
  readonly candidateId: string;
  readonly candidateHash: RoomBlindReviewPackHashV1;
  readonly sourceRecordId: string;
  readonly sourceHash: RoomBlindReviewPackHashV1;
  readonly artifactHash: RoomBlindReviewPackHashV1;
  readonly producerBindingIds: readonly string[];
}

/**
 * This boundary is intentionally separate from the reviewer-facing pack. It is
 * retained by the controller/evidence ledger and is never a review input.
 */
export interface RoomBlindReviewOpaqueBindingV1 {
  readonly candidateId: string;
  readonly opaqueCandidateId: string;
}

export interface RoomBlindReviewReviewerV1 {
  readonly bindingId: string;
}

export interface RoomBlindReviewRedactedCandidateV1 {
  readonly opaqueCandidateId: string;
  readonly candidateHash: RoomBlindReviewPackHashV1;
  readonly artifactHash: RoomBlindReviewPackHashV1;
}

/**
 * The only object that may be delivered to a reviewer. There is deliberately
 * no candidate id, source record, producer identity, acceptance, or promotion
 * field in this contract.
 */
export interface RoomBlindReviewPackV1 {
  readonly contractVersion: 1;
  readonly purpose: "blind_review_only";
  readonly reviewRoundId: string;
  readonly sourceSetHash: RoomBlindReviewPackHashV1;
  readonly createdAt: string;
  readonly reviewerBindingIds: readonly string[];
  readonly candidates: readonly RoomBlindReviewRedactedCandidateV1[];
}

export interface CreateRoomBlindReviewPackInputV1 {
  readonly contractVersion: 1;
  readonly reviewRoundId: string;
  readonly sourceSetHash: RoomBlindReviewPackHashV1;
  readonly createdAt: string;
  readonly reviewers: readonly RoomBlindReviewReviewerV1[];
  readonly candidateLineage: readonly RoomBlindReviewCandidateLineageV1[];
  /**
   * A controller supplies cryptographically random opaque values once, then
   * persists this sealed mapping outside the reviewer-visible pack. Keeping
   * randomness injected makes this module deterministic and side-effect free.
   */
  readonly opaqueBindings: readonly RoomBlindReviewOpaqueBindingV1[];
}

export type RoomBlindReviewPackRejectionCodeV1 =
  | "invalid_input"
  | "invalid_pack"
  | "unexpected_property"
  | "duplicate_candidate"
  | "duplicate_reviewer"
  | "duplicate_opaque_identity"
  | "invalid_hash"
  | "invalid_timestamp"
  | "invalid_opaque_identity"
  | "missing_opaque_binding"
  | "opaque_binding_mismatch"
  | "reviewer_not_independent"
  | "candidate_lineage_mismatch"
  | "redaction_view_mismatch"
  | "forbidden_review_authority";

export interface RoomBlindReviewPackRejectionV1 {
  readonly code: RoomBlindReviewPackRejectionCodeV1;
  readonly path: string;
  readonly message: string;
}

export interface RoomBlindReviewPackValidationV1 {
  readonly valid: boolean;
  readonly expectedPack: RoomBlindReviewPackV1 | null;
  readonly rejections: readonly RoomBlindReviewPackRejectionV1[];
}

const HASH = /^sha256:[a-f0-9]{64}$/;
const OPAQUE_ID = /^opaque_[A-Za-z0-9_-]{16,128}$/;

/*
FNXC:RoomBlindReviewPack 2026-07-19:
Blind review is a fan-out observation boundary, never a promotion authority.
The creator must retain random opaque bindings in a durable confidential ledger;
reviewers receive only a deterministic, hash-bound redaction view. This pure
module neither creates randomness nor persists/seals it, so it cannot claim a
durable audit trail or turn a review package into acceptance evidence.
*/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isHash(value: unknown): value is RoomBlindReviewPackHashV1 {
  return typeof value === "string" && HASH.test(value);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function uniqueText(values: unknown): values is readonly string[] {
  return Array.isArray(values) && values.every(isText) && new Set(values).size === values.length;
}

function rejection(
  rejections: RoomBlindReviewPackRejectionV1[],
  code: RoomBlindReviewPackRejectionCodeV1,
  path: string,
  message: string,
): void {
  rejections.push({ code, path, message });
}

function rejectUnexpectedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  rejections: RoomBlindReviewPackRejectionV1[],
): boolean {
  const allowedSet = new Set(allowed);
  let valid = true;
  for (const key of Object.keys(value).sort()) {
    if (allowedSet.has(key)) continue;
    valid = false;
    rejection(rejections, key === "acceptance" || key === "promotion" || key === "accepted" || key === "promoted"
      ? "forbidden_review_authority"
      : "unexpected_property", `${path}.${key}`, `Property '${key}' is not valid in a blind review pack`);
  }
  return valid;
}

function freezePack(pack: RoomBlindReviewPackV1): RoomBlindReviewPackV1 {
  const candidates = pack.candidates.map((candidate) => Object.freeze({ ...candidate }));
  return Object.freeze({
    ...pack,
    reviewerBindingIds: Object.freeze([...pack.reviewerBindingIds]),
    candidates: Object.freeze(candidates),
  });
}

function buildExpectedPack(
  input: unknown,
  rejections: RoomBlindReviewPackRejectionV1[],
): RoomBlindReviewPackV1 | null {
  if (!isRecord(input)) {
    rejection(rejections, "invalid_input", "$", "Blind-review input must be an object");
    return null;
  }
  let valid = rejectUnexpectedKeys(
    input,
    ["contractVersion", "reviewRoundId", "sourceSetHash", "createdAt", "reviewers", "candidateLineage", "opaqueBindings"],
    "$",
    rejections,
  );
  if (
    input.contractVersion !== ROOM_BLIND_REVIEW_PACK_CONTRACT_VERSION
    || !isText(input.reviewRoundId)
    || !isHash(input.sourceSetHash)
    || !isTimestamp(input.createdAt)
    || !Array.isArray(input.reviewers)
    || !Array.isArray(input.candidateLineage)
    || !Array.isArray(input.opaqueBindings)
  ) {
    valid = false;
    rejection(rejections, "invalid_input", "$", "Input requires v1 identity, source hash, timestamp, reviewers, candidates, and opaque bindings");
  }

  const reviewerIds: string[] = [];
  if (Array.isArray(input.reviewers)) {
    input.reviewers.forEach((reviewer, index) => {
      const path = `$.reviewers[${index}]`;
      if (!isRecord(reviewer) || !rejectUnexpectedKeys(reviewer, ["bindingId"], path, rejections) || !isText(reviewer.bindingId)) {
        valid = false;
        rejection(rejections, "invalid_input", path, "Reviewer requires a binding id");
        return;
      }
      reviewerIds.push(reviewer.bindingId);
    });
  }
  if (new Set(reviewerIds).size !== reviewerIds.length) {
    valid = false;
    rejection(rejections, "duplicate_reviewer", "$.reviewers", "Each reviewer binding must occur exactly once");
  }

  const candidates = new Map<string, RoomBlindReviewCandidateLineageV1>();
  if (Array.isArray(input.candidateLineage)) {
    input.candidateLineage.forEach((candidate, index) => {
      const path = `$.candidateLineage[${index}]`;
      if (!isRecord(candidate) || !rejectUnexpectedKeys(candidate, ["candidateId", "candidateHash", "sourceRecordId", "sourceHash", "artifactHash", "producerBindingIds"], path, rejections)) {
        valid = false;
        return;
      }
      const candidateId = candidate.candidateId;
      const candidateHash = candidate.candidateHash;
      const sourceRecordId = candidate.sourceRecordId;
      const sourceHash = candidate.sourceHash;
      const artifactHash = candidate.artifactHash;
      const producerBindingIds = candidate.producerBindingIds;
      if (
        !isText(candidateId)
        || !isHash(candidateHash)
        || !isText(sourceRecordId)
        || !isHash(sourceHash)
        || !isHash(artifactHash)
        || !uniqueText(producerBindingIds)
        || producerBindingIds.length === 0
      ) {
        valid = false;
        rejection(rejections, "candidate_lineage_mismatch", path, "Candidate requires complete hash-bound source and non-empty producer lineage");
        return;
      }
      if (candidates.has(candidateId)) {
        valid = false;
        rejection(rejections, "duplicate_candidate", `${path}.candidateId`, "Candidate identity must occur exactly once");
        return;
      }
      candidates.set(candidateId, {
        candidateId,
        candidateHash,
        sourceRecordId,
        sourceHash,
        artifactHash,
        producerBindingIds: [...producerBindingIds].sort(),
      });
    });
  }
  if (candidates.size === 0) {
    valid = false;
    rejection(rejections, "invalid_input", "$.candidateLineage", "A blind-review fan-out requires at least one candidate");
  }

  const opaqueByCandidate = new Map<string, string>();
  const opaqueIds = new Set<string>();
  if (Array.isArray(input.opaqueBindings)) {
    input.opaqueBindings.forEach((binding, index) => {
      const path = `$.opaqueBindings[${index}]`;
      if (!isRecord(binding) || !rejectUnexpectedKeys(binding, ["candidateId", "opaqueCandidateId"], path, rejections) || !isText(binding.candidateId) || typeof binding.opaqueCandidateId !== "string") {
        valid = false;
        rejection(rejections, "invalid_opaque_identity", path, "Opaque binding requires candidate and opaque identities");
        return;
      }
      if (!OPAQUE_ID.test(binding.opaqueCandidateId)) {
        valid = false;
        rejection(rejections, "invalid_opaque_identity", `${path}.opaqueCandidateId`, "Opaque identities must be controller-randomized opaque_* tokens");
        return;
      }
      if (opaqueByCandidate.has(binding.candidateId) || opaqueIds.has(binding.opaqueCandidateId)) {
        valid = false;
        rejection(rejections, "duplicate_opaque_identity", path, "Opaque bindings must be one-to-one");
        return;
      }
      opaqueByCandidate.set(binding.candidateId, binding.opaqueCandidateId);
      opaqueIds.add(binding.opaqueCandidateId);
    });
  }
  for (const candidate of candidates.values()) {
    if (!opaqueByCandidate.has(candidate.candidateId)) {
      valid = false;
      rejection(rejections, "missing_opaque_binding", "$.opaqueBindings", `Candidate '${candidate.candidateId}' lacks an opaque binding`);
    }
    for (const reviewerId of reviewerIds) {
      if (candidate.producerBindingIds.includes(reviewerId)) {
        valid = false;
        rejection(rejections, "reviewer_not_independent", "$.reviewers", `Reviewer '${reviewerId}' is in candidate producer lineage`);
      }
    }
  }
  for (const candidateId of opaqueByCandidate.keys()) {
    if (!candidates.has(candidateId)) {
      valid = false;
      rejection(rejections, "opaque_binding_mismatch", "$.opaqueBindings", `Opaque binding references unknown candidate '${candidateId}'`);
    }
  }
  if (!valid) return null;

  const redactedCandidates: RoomBlindReviewRedactedCandidateV1[] = [...candidates.values()]
    .map((candidate) => ({
      opaqueCandidateId: opaqueByCandidate.get(candidate.candidateId)!,
      candidateHash: candidate.candidateHash,
      artifactHash: candidate.artifactHash,
    }))
    .sort((left, right) => left.opaqueCandidateId.localeCompare(right.opaqueCandidateId));
  return freezePack({
    contractVersion: 1,
    purpose: "blind_review_only",
    reviewRoundId: input.reviewRoundId as string,
    sourceSetHash: input.sourceSetHash as RoomBlindReviewPackHashV1,
    createdAt: input.createdAt as string,
    reviewerBindingIds: [...reviewerIds].sort(),
    candidates: redactedCandidates,
  });
}

export function createRoomBlindReviewPack(
  input: CreateRoomBlindReviewPackInputV1,
): RoomBlindReviewPackValidationV1 {
  const rejections: RoomBlindReviewPackRejectionV1[] = [];
  const expectedPack = buildExpectedPack(input, rejections);
  return Object.freeze({ valid: expectedPack !== null && rejections.length === 0, expectedPack, rejections: Object.freeze(rejections) });
}

/**
 * Rebuild the reviewer-visible projection from the confidential input and
 * reject every mutation. Callers must never interpret a valid pack as a pass,
 * acceptance, or promotion verdict; that decision belongs to a separate gate.
 */
export function validateRoomBlindReviewPack(
  input: CreateRoomBlindReviewPackInputV1,
  pack: unknown,
): RoomBlindReviewPackValidationV1 {
  const rejections: RoomBlindReviewPackRejectionV1[] = [];
  const expectedPack = buildExpectedPack(input, rejections);
  if (!isRecord(pack)) {
    rejection(rejections, "invalid_pack", "$.pack", "Pack must be an object");
  } else {
    rejectUnexpectedKeys(pack, ["contractVersion", "purpose", "reviewRoundId", "sourceSetHash", "createdAt", "reviewerBindingIds", "candidates"], "$.pack", rejections);
    if (
      pack.contractVersion !== 1
      || pack.purpose !== "blind_review_only"
      || !isText(pack.reviewRoundId)
      || !isHash(pack.sourceSetHash)
      || !isTimestamp(pack.createdAt)
      || !uniqueText(pack.reviewerBindingIds)
      || !Array.isArray(pack.candidates)
    ) {
      rejection(rejections, "invalid_pack", "$.pack", "Pack does not match the v1 blind-review-only contract");
    }
    if (expectedPack !== null && JSON.stringify(pack) !== JSON.stringify(expectedPack)) {
      rejection(rejections, "redaction_view_mismatch", "$.pack", "Pack differs from the deterministic redaction view bound to source lineage");
    }
  }
  return Object.freeze({ valid: expectedPack !== null && rejections.length === 0, expectedPack, rejections: Object.freeze(rejections) });
}

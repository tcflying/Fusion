import {
  createRoomBlindReviewPack,
  hashRoomValue,
  type CreateRoomBlindReviewPackInputV1,
  type RoomBlindReviewOpaqueBindingV1,
  type RoomBlindReviewPackHashV1,
  type RoomBlindReviewPackV1,
  type RoomBlindReviewRegistryScopeV1,
  type RoomCandidateRecordV1,
} from "@fusion/core";

export const ROOM_CANDIDATE_FANOUT_BLIND_REVIEW_CONTRACT_VERSION = 1 as const;

export interface RoomCandidateFanoutCandidateEvidenceV1 {
  readonly contractVersion: 1;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly candidate: RoomCandidateRecordV1;
  readonly sourceRecordId: string;
  readonly sourceHash: RoomBlindReviewPackHashV1;
  readonly artifactHash: RoomBlindReviewPackHashV1;
  readonly producerBindingIds: readonly string[];
}

export interface ReadRoomCandidateFanoutEvidenceInputV1 {
  readonly contractVersion: 1;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly nodeId: string;
  readonly candidateIds: readonly string[];
}

export interface RoomCandidateFanoutBlindReviewSourceV1 {
  readImmutableCandidateEvidence(
    input: ReadRoomCandidateFanoutEvidenceInputV1,
  ): Promise<readonly RoomCandidateFanoutCandidateEvidenceV1[]>;
}

export interface RoomCandidateFanoutBlindReviewRandomizationInputV1 {
  readonly contractVersion: 1;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly reviewRoundId: string;
  readonly idempotencyKey: string;
  readonly sourceSetHash: RoomBlindReviewPackHashV1;
  readonly candidateIds: readonly string[];
}

export interface RoomCandidateFanoutBlindReviewRandomizationV1 {
  readonly contractVersion: 1;
  readonly randomizerReceiptId: string;
  readonly seed: string;
  readonly opaqueBindings: readonly RoomBlindReviewOpaqueBindingV1[];
}

export interface RoomCandidateFanoutBlindReviewRandomizerV1 {
  randomize(
    input: RoomCandidateFanoutBlindReviewRandomizationInputV1,
  ): Promise<RoomCandidateFanoutBlindReviewRandomizationV1>;
}

export interface RoomCandidateFanoutBlindReviewRandomizationAuditV1 {
  readonly contractVersion: 1;
  readonly randomizerReceiptId: string;
  readonly seedHash: RoomBlindReviewPackHashV1;
  readonly mappingHash: RoomBlindReviewPackHashV1;
}

export interface RoomCandidateFanoutBlindReviewSealedRandomizationV1 {
  readonly contractVersion: 1;
  readonly randomizerReceiptId: string;
  readonly seed: string;
  readonly opaqueBindings: readonly RoomBlindReviewOpaqueBindingV1[];
}

export interface AppendRoomCandidateFanoutBlindReviewInputV1 {
  readonly contractVersion: 1;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly idempotencyKey: string;
  readonly now: string;
  readonly expiresAt: string;
  readonly packInput: CreateRoomBlindReviewPackInputV1;
  readonly sealedRandomization: RoomCandidateFanoutBlindReviewSealedRandomizationV1;
  readonly randomizationAudit: RoomCandidateFanoutBlindReviewRandomizationAuditV1;
}

export interface RoomCandidateFanoutBlindReviewAppendReceiptV1 {
  readonly contractVersion: 1;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly reviewRoundId: string;
  readonly sourceSetHash: RoomBlindReviewPackHashV1;
  readonly seedHash: RoomBlindReviewPackHashV1;
  readonly mappingHash: RoomBlindReviewPackHashV1;
  readonly sealedAt: string;
  readonly replayed: boolean;
}

export interface RoomCandidateFanoutBlindReviewAppendPortV1 {
  appendBlindReviewFanout(
    input: AppendRoomCandidateFanoutBlindReviewInputV1,
  ): Promise<RoomCandidateFanoutBlindReviewAppendReceiptV1>;
}

export interface RoomCandidateFanoutBlindReviewInputV1 {
  readonly contractVersion: 1;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly nodeId: string;
  readonly reviewRoundId: string;
  readonly idempotencyKey: string;
  readonly now: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly candidateIds: readonly string[];
  readonly reviewerBindingIds: readonly string[];
  readonly minimumReviewerCount: number;
}

export interface RoomCandidateFanoutBlindReviewCoordinatorOptionsV1 {
  readonly projectId: string;
  readonly source: RoomCandidateFanoutBlindReviewSourceV1;
  readonly randomizer: RoomCandidateFanoutBlindReviewRandomizerV1;
  readonly append: RoomCandidateFanoutBlindReviewAppendPortV1;
}

export type RoomCandidateFanoutBlindReviewWithheldCodeV1 =
  | "invalid_request"
  | "project_mismatch"
  | "minimum_candidates_not_met"
  | "minimum_reviewers_not_met"
  | "source_failed"
  | "source_response_invalid"
  | "candidate_scope_mismatch"
  | "candidate_node_mismatch"
  | "candidate_execution_mismatch"
  | "candidate_lineage_mismatch"
  | "reviewer_conflict"
  | "randomization_failed"
  | "randomization_invalid"
  | "blind_pack_invalid"
  | "append_failed"
  | "append_response_invalid";

export interface RoomCandidateFanoutBlindReviewWithheldResultV1 {
  readonly status: "withheld";
  readonly code: RoomCandidateFanoutBlindReviewWithheldCodeV1;
  readonly message: string;
}

export interface RoomCandidateFanoutBlindReviewPreparedResultV1 {
  readonly status: "prepared";
  readonly contractVersion: 1;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly reviewRoundId: string;
  readonly sourceSetHash: RoomBlindReviewPackHashV1;
  readonly randomizationAudit: RoomCandidateFanoutBlindReviewRandomizationAuditV1;
  readonly sealedAt: string;
  readonly replayed: boolean;
  readonly reviewPack: RoomBlindReviewPackV1;
}

export type RoomCandidateFanoutBlindReviewResultV1 =
  | RoomCandidateFanoutBlindReviewWithheldResultV1
  | RoomCandidateFanoutBlindReviewPreparedResultV1;

interface NormalizedRequest {
  readonly contractVersion: 1;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly nodeId: string;
  readonly reviewRoundId: string;
  readonly idempotencyKey: string;
  readonly now: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly candidateIds: readonly string[];
  readonly reviewerBindingIds: readonly string[];
  readonly minimumReviewerCount: number;
}

interface NormalizedCandidateEvidence {
  readonly evidence: RoomCandidateFanoutCandidateEvidenceV1;
  readonly candidateId: string;
  readonly candidateHash: RoomBlindReviewPackHashV1;
  readonly producerBindingIds: readonly string[];
}

interface CandidateExecutionFingerprint {
  readonly contextVersion: string;
  readonly inputVersion: string;
  readonly configVersion: string;
  readonly protocolId: string;
  readonly protocolVersion: number;
}

const HASH = /^sha256:[a-f0-9]{64}$/;
const OPAQUE_ID = /^opaque_[A-Za-z0-9_-]{16,128}$/;

export class RoomCandidateFanoutBlindReviewCoordinator {
  public constructor(
    private readonly options: RoomCandidateFanoutBlindReviewCoordinatorOptionsV1,
  ) {}

  public async prepare(
    rawInput: RoomCandidateFanoutBlindReviewInputV1,
  ): Promise<RoomCandidateFanoutBlindReviewResultV1> {
    const normalized = normalizeRequest(rawInput, this.options?.projectId);
    if (isWithheld(normalized)) return normalized;

    const source = this.options?.source;
    if (!source || typeof source.readImmutableCandidateEvidence !== "function") {
      return withheld("source_response_invalid", "Immutable candidate evidence source is unavailable.");
    }
    const randomizer = this.options?.randomizer;
    if (!randomizer || typeof randomizer.randomize !== "function") {
      return withheld("randomization_invalid", "Blind-identity randomizer is unavailable.");
    }
    const append = this.options?.append;
    if (!append || typeof append.appendBlindReviewFanout !== "function") {
      return withheld("append_failed", "Durable blind-review append boundary is unavailable.");
    }

    let sourceResponse: readonly RoomCandidateFanoutCandidateEvidenceV1[];
    try {
      sourceResponse = await source.readImmutableCandidateEvidence(freeze({
        contractVersion: 1,
        scope: copyScope(normalized.scope),
        nodeId: normalized.nodeId,
        candidateIds: freezeStrings(normalized.candidateIds),
      }));
    } catch (error) {
      return withheld("source_failed", `Immutable candidate evidence read failed: ${messageOf(error)}`);
    }
    const normalizedEvidence = normalizeEvidence(sourceResponse, normalized);
    if (isWithheld(normalizedEvidence)) return normalizedEvidence;
    const execution = sharedExecution(normalizedEvidence);
    if (execution === null) {
      return withheld(
        "candidate_execution_mismatch",
        "Blind-review fan-out candidates must share identical context, input, config, and protocol versions.",
      );
    }
    if (hasReviewerConflict(normalized.reviewerBindingIds, normalizedEvidence)) {
      return withheld(
        "reviewer_conflict",
        "A candidate producer cannot receive or perform review in its own blind-review fan-out.",
      );
    }

    const sourceSetHash = hashSourceSet(normalized, execution, normalizedEvidence);
    let randomization: RoomCandidateFanoutBlindReviewRandomizationV1;
    try {
      randomization = await randomizer.randomize(freeze({
        contractVersion: 1,
        scope: copyScope(normalized.scope),
        reviewRoundId: normalized.reviewRoundId,
        idempotencyKey: normalized.idempotencyKey,
        sourceSetHash,
        candidateIds: freezeStrings(normalized.candidateIds),
      }));
    } catch (error) {
      return withheld("randomization_failed", `Blind-identity randomization failed: ${messageOf(error)}`);
    }
    const opaqueBindings = normalizeOpaqueBindings(randomization, normalizedEvidence);
    if (isWithheld(opaqueBindings)) return opaqueBindings;
    const randomizationAudit = buildRandomizationAudit(normalized, sourceSetHash, randomization, opaqueBindings);
    if (isWithheld(randomizationAudit)) return randomizationAudit;

    const packInput = buildPackInput(normalized, sourceSetHash, normalizedEvidence, opaqueBindings);
    const packValidation = createRoomBlindReviewPack(packInput);
    if (!packValidation.valid || packValidation.expectedPack === null) {
      return withheld("blind_pack_invalid", "Core blind-review pack validation rejected the generated reviewer payload.");
    }

    let receipt: RoomCandidateFanoutBlindReviewAppendReceiptV1;
    try {
      receipt = await append.appendBlindReviewFanout(freeze({
        contractVersion: 1,
        scope: copyScope(normalized.scope),
        idempotencyKey: normalized.idempotencyKey,
        now: normalized.now,
        expiresAt: normalized.expiresAt,
        packInput,
        sealedRandomization: freeze({
          contractVersion: 1,
          randomizerReceiptId: randomization.randomizerReceiptId,
          seed: randomization.seed,
          opaqueBindings,
        }),
        randomizationAudit,
      }));
    } catch (error) {
      return withheld("append_failed", `Durable blind-review append failed: ${messageOf(error)}`);
    }
    if (!matchesReceipt(receipt, normalized, sourceSetHash, randomizationAudit)) {
      return withheld("append_response_invalid", "Durable blind-review append did not confirm the exact sealed fan-out.");
    }
    return freeze({
      status: "prepared" as const,
      contractVersion: 1,
      scope: copyScope(normalized.scope),
      reviewRoundId: normalized.reviewRoundId,
      sourceSetHash,
      randomizationAudit,
      sealedAt: receipt.sealedAt,
      replayed: receipt.replayed,
      reviewPack: packValidation.expectedPack,
    });
  }
}

function normalizeRequest(
  value: unknown,
  configuredProjectId: unknown,
): NormalizedRequest | RoomCandidateFanoutBlindReviewWithheldResultV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "contractVersion",
    "scope",
    "nodeId",
    "reviewRoundId",
    "idempotencyKey",
    "now",
    "createdAt",
    "expiresAt",
    "candidateIds",
    "reviewerBindingIds",
    "minimumReviewerCount",
  ])) {
    return withheld("invalid_request", "Blind-review fan-out input must contain exactly the v1 contract fields.");
  }
  if (value.contractVersion !== ROOM_CANDIDATE_FANOUT_BLIND_REVIEW_CONTRACT_VERSION) {
    return withheld("invalid_request", "Blind-review fan-out requires contract version 1.");
  }
  const scope = normalizeScope(value.scope);
  if (scope === null) return withheld("invalid_request", "Blind-review fan-out scope must contain a project and Room identity.");
  if (!isText(configuredProjectId) || scope.projectId !== configuredProjectId) {
    return withheld("project_mismatch", "Blind-review fan-out scope must remain within the configured project.");
  }
  const candidateIds = normalizeTextSet(value.candidateIds);
  if (candidateIds === null) return withheld("invalid_request", "Candidate IDs must be unique non-blank text.");
  if (candidateIds.length < 2) {
    return withheld("minimum_candidates_not_met", "Blind-review fan-out requires at least two immutable candidate records.");
  }
  const reviewerBindingIds = normalizeTextSet(value.reviewerBindingIds);
  if (reviewerBindingIds === null) return withheld("invalid_request", "Reviewer binding IDs must be unique non-blank text.");
  const rawMinimumReviewerCount = value.minimumReviewerCount;
  if (!isPositiveSafeInteger(rawMinimumReviewerCount)) {
    return withheld("invalid_request", "Minimum reviewer count must be a positive safe integer.");
  }
  const minimumReviewerCount: number = rawMinimumReviewerCount;
  if (reviewerBindingIds.length < minimumReviewerCount) {
    return withheld("minimum_reviewers_not_met", "The requested independent reviewer minimum is not met.");
  }
  const now = canonicalTimestamp(value.now);
  const createdAt = canonicalTimestamp(value.createdAt);
  const expiresAt = canonicalTimestamp(value.expiresAt);
  if (now === null || createdAt === null || expiresAt === null || Date.parse(expiresAt) <= Date.parse(createdAt)) {
    return withheld("invalid_request", "Blind-review fan-out timestamps must be canonical and expire after creation.");
  }
  if (!isText(value.nodeId) || !isText(value.reviewRoundId) || !isText(value.idempotencyKey)) {
    return withheld("invalid_request", "Blind-review fan-out requires non-blank node, review-round, and idempotency identities.");
  }
  return freeze({
    contractVersion: 1,
    scope,
    nodeId: value.nodeId,
    reviewRoundId: value.reviewRoundId,
    idempotencyKey: value.idempotencyKey,
    now,
    createdAt,
    expiresAt,
    candidateIds,
    reviewerBindingIds,
    minimumReviewerCount,
  });
}

function normalizeEvidence(
  value: unknown,
  request: NormalizedRequest,
): readonly NormalizedCandidateEvidence[] | RoomCandidateFanoutBlindReviewWithheldResultV1 {
  if (!Array.isArray(value) || value.length !== request.candidateIds.length) {
    return withheld("source_response_invalid", "Candidate evidence source did not return the exact requested candidate set.");
  }
  const byId = new Map<string, NormalizedCandidateEvidence>();
  for (const rawEvidence of value) {
    if (!isRecord(rawEvidence) || rawEvidence.contractVersion !== 1 || !isRecord(rawEvidence.scope) || !isRecord(rawEvidence.candidate)) {
      return withheld("source_response_invalid", "Candidate evidence source returned an invalid v1 evidence record.");
    }
    const scope = normalizeScope(rawEvidence.scope);
    if (scope === null || !sameScope(scope, request.scope)) {
      return withheld("candidate_scope_mismatch", "Candidate evidence crossed the requested project or Room scope.");
    }
    const candidate = rawEvidence.candidate as unknown as RoomCandidateRecordV1;
    if (!isText(candidate.id) || !isText(candidate.roomId) || !isText(candidate.nodeId) || !isText(candidate.producingBindingId)) {
      return withheld("source_response_invalid", "Candidate evidence did not contain a canonical candidate identity.");
    }
    if (candidate.roomId !== request.scope.roomId) {
      return withheld("candidate_scope_mismatch", "Candidate evidence belongs to a different Room.");
    }
    if (candidate.nodeId !== request.nodeId) {
      return withheld("candidate_node_mismatch", "Candidate evidence belongs to a different Room node.");
    }
    if (candidate.contractVersion !== 1 || candidate.promotionState !== "pending" || !isHash(candidate.contentHash)) {
      return withheld("candidate_lineage_mismatch", "Candidate evidence was not an immutable pending candidate record.");
    }
    if (!isText(rawEvidence.sourceRecordId) || !isHash(rawEvidence.sourceHash) || !isHash(rawEvidence.artifactHash)) {
      return withheld("candidate_lineage_mismatch", "Candidate evidence lacked immutable source or artifact hashes.");
    }
    const producerBindingIds = normalizeTextSet(rawEvidence.producerBindingIds);
    if (producerBindingIds === null || producerBindingIds.length === 0 || !producerBindingIds.includes(candidate.producingBindingId)) {
      return withheld("candidate_lineage_mismatch", "Candidate producer lineage must contain the durable producing binding.");
    }
    if (byId.has(candidate.id)) {
      return withheld("source_response_invalid", "Candidate evidence source returned duplicate candidate identities.");
    }
    byId.set(candidate.id, freeze({
      evidence: freeze({
        contractVersion: 1,
        scope: copyScope(scope),
        candidate,
        sourceRecordId: rawEvidence.sourceRecordId,
        sourceHash: rawEvidence.sourceHash,
        artifactHash: rawEvidence.artifactHash,
        producerBindingIds,
      }),
      candidateId: candidate.id,
      candidateHash: candidate.contentHash as RoomBlindReviewPackHashV1,
      producerBindingIds,
    }));
  }
  const normalized = request.candidateIds.map((candidateId) => byId.get(candidateId) ?? null);
  if (normalized.some((entry) => entry === null) || byId.size !== request.candidateIds.length) {
    return withheld("source_response_invalid", "Candidate evidence source did not resolve every requested candidate exactly once.");
  }
  return freeze(normalized as NormalizedCandidateEvidence[]);
}

function sharedExecution(evidence: readonly NormalizedCandidateEvidence[]): CandidateExecutionFingerprint | null {
  const first = evidence[0]?.evidence.candidate;
  if (!first) return null;
  const fingerprint = executionFingerprint(first);
  if (fingerprint === null) return null;
  for (const entry of evidence.slice(1)) {
    const next = executionFingerprint(entry.evidence.candidate);
    if (next === null || !sameExecution(fingerprint, next)) return null;
  }
  return freeze(fingerprint);
}

function executionFingerprint(candidate: RoomCandidateRecordV1): CandidateExecutionFingerprint | null {
  if (
    !isText(candidate.contextVersion)
    || !isText(candidate.inputVersion)
    || !isText(candidate.configVersion)
    || !isText(candidate.protocolId)
    || !Number.isSafeInteger(candidate.protocolVersion)
    || candidate.protocolVersion < 1
  ) {
    return null;
  }
  return {
    contextVersion: candidate.contextVersion,
    inputVersion: candidate.inputVersion,
    configVersion: candidate.configVersion,
    protocolId: candidate.protocolId,
    protocolVersion: candidate.protocolVersion,
  };
}

function hasReviewerConflict(
  reviewerBindingIds: readonly string[],
  evidence: readonly NormalizedCandidateEvidence[],
): boolean {
  const reviewers = new Set(reviewerBindingIds);
  return evidence.some((entry) => entry.producerBindingIds.some((bindingId) => reviewers.has(bindingId)));
}

function hashSourceSet(
  request: NormalizedRequest,
  execution: CandidateExecutionFingerprint,
  evidence: readonly NormalizedCandidateEvidence[],
): RoomBlindReviewPackHashV1 {
  return hashRoomValue({
    contractVersion: 1,
    scope: request.scope,
    nodeId: request.nodeId,
    execution,
    candidates: evidence.map((entry) => ({
      candidateId: entry.candidateId,
      candidateHash: entry.candidateHash,
      sourceRecordId: entry.evidence.sourceRecordId,
      sourceHash: entry.evidence.sourceHash,
      artifactHash: entry.evidence.artifactHash,
      producerBindingIds: entry.producerBindingIds,
    })),
  }) as RoomBlindReviewPackHashV1;
}

function normalizeOpaqueBindings(
  randomization: unknown,
  evidence: readonly NormalizedCandidateEvidence[],
): readonly RoomBlindReviewOpaqueBindingV1[] | RoomCandidateFanoutBlindReviewWithheldResultV1 {
  if (!isRecord(randomization)) {
    return withheld("randomization_invalid", "Blind-identity randomizer did not return a complete v1 receipt.");
  }
  const randomizerReceiptId = randomization.randomizerReceiptId;
  const seed = randomization.seed;
  const rawOpaqueBindings = randomization.opaqueBindings;
  if (randomization.contractVersion !== 1 || !isText(randomizerReceiptId) || !isText(seed) || !Array.isArray(rawOpaqueBindings)) {
    return withheld("randomization_invalid", "Blind-identity randomizer did not return a complete v1 receipt.");
  }
  const expected = new Map(evidence.map((entry) => [entry.candidateId, entry]));
  const protectedIdentityLabels = evidence.flatMap((entry) => [
    entry.candidateId,
    ...entry.producerBindingIds,
    entry.evidence.candidate.nativeSessionId,
    entry.evidence.candidate.happierSessionId,
  ]).filter((label) => isText(label) && label.length >= 4);
  if (protectedIdentityLabels.some((label) => randomizerReceiptId.toLowerCase().includes(label.toLowerCase()))) {
    return withheld("randomization_invalid", "Blind-identity randomizer receipt leaked candidate, producer, or session identity.");
  }
  const opaqueIds = new Set<string>();
  const byCandidate = new Map<string, RoomBlindReviewOpaqueBindingV1>();
  for (const rawBinding of rawOpaqueBindings) {
    if (!isRecord(rawBinding)) {
      return withheld("randomization_invalid", "Blind-identity randomizer returned an invalid opaque binding.");
    }
    const rawCandidateId = rawBinding.candidateId;
    const rawOpaqueCandidateId = rawBinding.opaqueCandidateId;
    if (!isText(rawCandidateId) || !isText(rawOpaqueCandidateId)) {
      return withheld("randomization_invalid", "Blind-identity randomizer returned an invalid opaque binding.");
    }
    const candidateId: string = rawCandidateId;
    const opaqueCandidateId: string = rawOpaqueCandidateId;
    const candidate = expected.get(candidateId);
    if (!candidate || byCandidate.has(candidateId) || opaqueIds.has(opaqueCandidateId) || !OPAQUE_ID.test(opaqueCandidateId)) {
      return withheld("randomization_invalid", "Blind-identity randomizer did not return a one-to-one opaque mapping.");
    }
    if (protectedIdentityLabels.some((label) => opaqueCandidateId.toLowerCase().includes(label.toLowerCase()))) {
      return withheld("randomization_invalid", "An opaque candidate identity leaked candidate or producer identity.");
    }
    const binding = freeze({ candidateId, opaqueCandidateId });
    byCandidate.set(binding.candidateId, binding);
    opaqueIds.add(binding.opaqueCandidateId);
  }
  if (byCandidate.size !== evidence.length) {
    return withheld("randomization_invalid", "Blind-identity randomizer omitted one or more requested candidates.");
  }
  return freeze([...byCandidate.values()].sort((left, right) => compareText(left.candidateId, right.candidateId)));
}

function buildRandomizationAudit(
  request: NormalizedRequest,
  sourceSetHash: RoomBlindReviewPackHashV1,
  randomization: RoomCandidateFanoutBlindReviewRandomizationV1,
  opaqueBindings: readonly RoomBlindReviewOpaqueBindingV1[],
): RoomCandidateFanoutBlindReviewRandomizationAuditV1 | RoomCandidateFanoutBlindReviewWithheldResultV1 {
  if (!isText(randomization.randomizerReceiptId) || !isText(randomization.seed)) {
    return withheld("randomization_invalid", "Blind-identity randomizer receipt cannot be committed without entropy provenance.");
  }
  const seedHash = hashRoomValue({
    contractVersion: 1,
    scope: request.scope,
    reviewRoundId: request.reviewRoundId,
    randomizerReceiptId: randomization.randomizerReceiptId,
    seed: randomization.seed,
  }) as RoomBlindReviewPackHashV1;
  const mappingHash = hashRoomValue({
    contractVersion: 1,
    scope: request.scope,
    reviewRoundId: request.reviewRoundId,
    idempotencyKey: request.idempotencyKey,
    expiresAt: request.expiresAt,
    reviewerBindingIds: request.reviewerBindingIds,
    sourceSetHash,
    seedHash,
    opaqueBindings,
  }) as RoomBlindReviewPackHashV1;
  return freeze({
    contractVersion: 1,
    randomizerReceiptId: randomization.randomizerReceiptId,
    seedHash,
    mappingHash,
  });
}

function buildPackInput(
  request: NormalizedRequest,
  sourceSetHash: RoomBlindReviewPackHashV1,
  evidence: readonly NormalizedCandidateEvidence[],
  opaqueBindings: readonly RoomBlindReviewOpaqueBindingV1[],
): CreateRoomBlindReviewPackInputV1 {
  return freeze({
    contractVersion: 1,
    reviewRoundId: request.reviewRoundId,
    sourceSetHash,
    createdAt: request.createdAt,
    reviewers: request.reviewerBindingIds.map((bindingId) => freeze({ bindingId })),
    candidateLineage: evidence.map((entry) => freeze({
      candidateId: entry.candidateId,
      candidateHash: entry.candidateHash,
      sourceRecordId: entry.evidence.sourceRecordId,
      sourceHash: entry.evidence.sourceHash,
      artifactHash: entry.evidence.artifactHash,
      producerBindingIds: entry.producerBindingIds,
    })),
    opaqueBindings,
  });
}

function matchesReceipt(
  value: unknown,
  request: NormalizedRequest,
  sourceSetHash: RoomBlindReviewPackHashV1,
  audit: RoomCandidateFanoutBlindReviewRandomizationAuditV1,
): value is RoomCandidateFanoutBlindReviewAppendReceiptV1 {
  const scope = isRecord(value) ? normalizeScope(value.scope) : null;
  return isRecord(value)
    && value.contractVersion === 1
    && scope !== null
    && sameScope(scope, request.scope)
    && value.reviewRoundId === request.reviewRoundId
    && value.sourceSetHash === sourceSetHash
    && value.seedHash === audit.seedHash
    && value.mappingHash === audit.mappingHash
    && canonicalTimestamp(value.sealedAt) !== null
    && typeof value.replayed === "boolean";
}

function normalizeScope(value: unknown): RoomBlindReviewRegistryScopeV1 | null {
  if (!isRecord(value) || !isText(value.projectId) || !isText(value.roomId)) return null;
  return freeze({ projectId: value.projectId, roomId: value.roomId });
}

function sameScope(left: RoomBlindReviewRegistryScopeV1, right: RoomBlindReviewRegistryScopeV1): boolean {
  return left.projectId === right.projectId && left.roomId === right.roomId;
}

function sameExecution(left: CandidateExecutionFingerprint, right: CandidateExecutionFingerprint): boolean {
  return left.contextVersion === right.contextVersion
    && left.inputVersion === right.inputVersion
    && left.configVersion === right.configVersion
    && left.protocolId === right.protocolId
    && left.protocolVersion === right.protocolVersion;
}

function normalizeTextSet(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || !value.every(isText)) return null;
  const normalized = [...value].sort(compareText);
  if (new Set(normalized).size !== normalized.length) return null;
  return freeze(normalized);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareText);
  const normalizedExpected = [...expected].sort(compareText);
  return actual.length === normalizedExpected.length && actual.every((key, index) => key === normalizedExpected[index]);
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? value : null;
}

function isHash(value: unknown): value is RoomBlindReviewPackHashV1 {
  return typeof value === "string" && HASH.test(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function copyScope(scope: RoomBlindReviewRegistryScopeV1): RoomBlindReviewRegistryScopeV1 {
  return freeze({ projectId: scope.projectId, roomId: scope.roomId });
}

function freezeStrings(values: readonly string[]): readonly string[] {
  return freeze([...values]);
}

function withheld(
  code: RoomCandidateFanoutBlindReviewWithheldCodeV1,
  message: string,
): RoomCandidateFanoutBlindReviewWithheldResultV1 {
  return freeze({ status: "withheld" as const, code, message });
}

function isWithheld(
  value: NormalizedRequest | readonly NormalizedCandidateEvidence[] | readonly RoomBlindReviewOpaqueBindingV1[] | RoomCandidateFanoutBlindReviewRandomizationAuditV1 | RoomCandidateFanoutBlindReviewWithheldResultV1,
): value is RoomCandidateFanoutBlindReviewWithheldResultV1 {
  return "status" in value && value.status === "withheld";
}

function messageOf(error: unknown): string {
  return error instanceof Error && isText(error.message) ? error.message : "unknown error";
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

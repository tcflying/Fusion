import type {
  CreateRoomBlindReviewPackInputV1,
  ReadRoomBlindReviewPackInputV1,
  RoomBlindReviewCandidateLineageV1,
  RoomBlindReviewPackHashV1,
  RoomBlindReviewPackV1,
  RoomBlindReviewPackViewV1,
  RoomBlindReviewRegistryScopeV1,
  SealRoomBlindReviewMappingInputV1,
  SealedRoomBlindReviewPackResultV1,
} from "@fusion/core";

export const ROOM_BLIND_REVIEW_COORDINATOR_CONTRACT_VERSION = 1 as const;

export const ROOM_BLIND_REVIEW_TERMINAL_VERDICT_OUTCOMES = [
  "accepted",
  "rejected",
  "partial",
  "blocked",
  "dissent",
] as const;

export type RoomBlindReviewTerminalVerdictOutcomeV1 =
  (typeof ROOM_BLIND_REVIEW_TERMINAL_VERDICT_OUTCOMES)[number];

export interface RoomBlindReviewCandidateSubmissionV1 extends RoomBlindReviewCandidateLineageV1 {
  /** A controller-generated opaque identity that is safe to put in a review pack. */
  readonly opaqueCandidateId: string;
}

export interface ReadRoomBlindReviewCandidateLineageInputV1 {
  readonly contractVersion: 1;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly candidateId: string;
}

/**
 * The candidate authority is an injected durable evidence reader. A caller's
 * candidate payload is never treated as proof that the candidate is known.
 */
export interface RoomBlindReviewCandidateAuthorityV1 {
  readCandidateLineage(
    input: ReadRoomBlindReviewCandidateLineageInputV1,
  ): Promise<RoomBlindReviewCandidateLineageV1 | null>;
}

export interface RoomBlindReviewRoundV1 {
  readonly contractVersion: 1;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly reviewRoundId: string;
  readonly sourceSetHash: RoomBlindReviewPackHashV1;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly reviewerBindingIds: readonly string[];
}

export interface CreateRoomBlindReviewFanoutInputV1 {
  readonly contractVersion: 1;
  readonly idempotencyKey: string;
  readonly now: string;
  readonly reviewRound: RoomBlindReviewRoundV1;
  readonly candidateSubmissions: readonly RoomBlindReviewCandidateSubmissionV1[];
}

/** Narrow port over Core's durable sealed mapping registry. */
export interface RoomBlindReviewRegistryPortV1 {
  seal(input: SealRoomBlindReviewMappingInputV1): Promise<SealedRoomBlindReviewPackResultV1>;
  getPackForReviewer(input: ReadRoomBlindReviewPackInputV1): Promise<RoomBlindReviewPackViewV1>;
}

/**
 * A proof is safe to carry through Engine messages. It identifies the sealed
 * redaction view without exposing the confidential candidate-to-producer map.
 */
export interface RoomBlindReviewRegistryProofV1 {
  readonly contractVersion: 1;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly reviewRoundId: string;
  readonly mappingIntegrityHash: RoomBlindReviewPackHashV1;
  readonly sealedAt: string;
  readonly expiresAt: string;
}

export interface RoomBlindReviewFanoutResultV1 {
  readonly contractVersion: 1;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly reviewRoundId: string;
  readonly replayed: boolean;
  readonly registryProof: RoomBlindReviewRegistryProofV1;
  readonly reviewPack: RoomBlindReviewPackV1;
}

export interface DeliverRoomBlindReviewPackInputV1 {
  readonly contractVersion: 1;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly reviewRoundId: string;
  readonly reviewerBindingId: string;
  readonly now: string;
}

export interface RoomBlindReviewPackDeliveryV1 {
  readonly contractVersion: 1;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly reviewRoundId: string;
  readonly reviewerBindingId: string;
  readonly deliveredAt: string;
  readonly registryProof: RoomBlindReviewRegistryProofV1;
  readonly reviewPack: RoomBlindReviewPackV1;
}

export interface RoomBlindReviewTerminalVerdictV1 {
  readonly contractVersion: 1;
  readonly outcome: RoomBlindReviewTerminalVerdictOutcomeV1;
  readonly final: true;
  readonly selectedOpaqueCandidateIds: readonly string[];
  readonly evidenceRefs: readonly string[];
}

export interface RecordRoomBlindReviewTerminalVerdictInputV1 {
  readonly contractVersion: 1;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly reviewRoundId: string;
  readonly reviewerBindingId: string;
  readonly idempotencyKey: string;
  readonly now: string;
  readonly registryProof: RoomBlindReviewRegistryProofV1;
  readonly verdict: RoomBlindReviewTerminalVerdictV1;
}

export interface RoomBlindReviewRecordedTerminalVerdictV1 {
  readonly contractVersion: 1;
  readonly recordId: string;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly reviewRoundId: string;
  readonly reviewerBindingId: string;
  readonly idempotencyKey: string;
  readonly registryProof: RoomBlindReviewRegistryProofV1;
  readonly verdict: RoomBlindReviewTerminalVerdictV1;
  readonly recordedAt: string;
  readonly replayed: boolean;
}

export interface ReadRoomBlindReviewTerminalVerdictInputV1 {
  readonly contractVersion: 1;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly reviewRoundId: string;
  readonly recordId: string;
}

/**
 * The ledger owns persistence and idempotency of a terminal review verdict.
 * A coordinator cannot manufacture a recorded verdict from a model response.
 */
export interface RoomBlindReviewVerdictLedgerV1 {
  recordTerminalVerdict(
    input: RecordRoomBlindReviewTerminalVerdictInputV1,
  ): Promise<RoomBlindReviewRecordedTerminalVerdictV1>;
  getTerminalVerdict(
    input: ReadRoomBlindReviewTerminalVerdictInputV1,
  ): Promise<RoomBlindReviewRecordedTerminalVerdictV1 | null>;
}

export interface RequestRoomBlindReviewRevealInputV1 {
  readonly contractVersion: 1;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly reviewRoundId: string;
  readonly requesterBindingId: string;
  readonly terminalVerdictRecordId: string;
  readonly idempotencyKey: string;
  readonly now: string;
}

export interface RoomBlindReviewRevealAuthorizationInputV1 {
  readonly contractVersion: 1;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly reviewRoundId: string;
  readonly requesterBindingId: string;
  readonly now: string;
  readonly terminalVerdictRecord: RoomBlindReviewRecordedTerminalVerdictV1;
}

export interface RoomBlindReviewRevealAuthorizationV1 {
  readonly contractVersion: 1;
  readonly authorizationId: string;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly reviewRoundId: string;
  readonly requesterBindingId: string;
  readonly terminalVerdictRecordId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface RoomBlindReviewRevealAuthorizerV1 {
  authorizeReveal(
    input: RoomBlindReviewRevealAuthorizationInputV1,
  ): Promise<RoomBlindReviewRevealAuthorizationV1 | null>;
}

export interface RoomBlindReviewRevealMappingV1 {
  readonly opaqueCandidateId: string;
  readonly candidateId: string;
  readonly sourceRecordId: string;
  readonly producerBindingIds: readonly string[];
}

export interface RoomBlindReviewRevealPortInputV1 {
  readonly contractVersion: 1;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly reviewRoundId: string;
  readonly requesterBindingId: string;
  readonly idempotencyKey: string;
  readonly now: string;
  readonly authorization: RoomBlindReviewRevealAuthorizationV1;
  readonly terminalVerdictRecord: RoomBlindReviewRecordedTerminalVerdictV1;
}

export interface RoomBlindReviewRevealResultV1 {
  readonly contractVersion: 1;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly reviewRoundId: string;
  readonly terminalVerdictRecordId: string;
  readonly authorizationId: string;
  readonly mappingIntegrityHash: RoomBlindReviewPackHashV1;
  readonly revealedAt: string;
  readonly replayed: boolean;
  readonly mappings: readonly RoomBlindReviewRevealMappingV1[];
}

/**
 * The registry/ledger adapter remains the sole owner of confidential mapping
 * lookup. Engine only proves the preconditions and delegates the reveal.
 */
export interface RoomBlindReviewRevealPortV1 {
  reveal(input: RoomBlindReviewRevealPortInputV1): Promise<RoomBlindReviewRevealResultV1>;
}

export interface RoomBlindReviewCoordinatorOptions {
  readonly projectId: string;
  readonly candidateAuthority: RoomBlindReviewCandidateAuthorityV1;
  readonly registry: RoomBlindReviewRegistryPortV1;
  readonly verdictLedger: RoomBlindReviewVerdictLedgerV1;
  readonly revealAuthorizer: RoomBlindReviewRevealAuthorizerV1;
  readonly revealPort: RoomBlindReviewRevealPortV1;
}

export type RoomBlindReviewCoordinatorErrorCodeV1 =
  | "invalid_input"
  | "project_mismatch"
  | "duplicate_candidate"
  | "unknown_candidate"
  | "candidate_proof_mismatch"
  | "reviewer_conflict"
  | "registry_response_invalid"
  | "registry_proof_missing"
  | "registry_proof_mismatch"
  | "unknown_opaque_candidate"
  | "terminal_verdict_required"
  | "terminal_verdict_not_recorded"
  | "terminal_verdict_record_mismatch"
  | "reveal_not_authorized"
  | "reveal_authorization_invalid"
  | "reveal_result_invalid";

export class RoomBlindReviewCoordinatorError extends Error {
  constructor(
    readonly code: RoomBlindReviewCoordinatorErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "RoomBlindReviewCoordinatorError";
  }
}

const TERMINAL_VERDICT_OUTCOME_SET = new Set<string>(ROOM_BLIND_REVIEW_TERMINAL_VERDICT_OUTCOMES);
const HASH = /^sha256:[a-f0-9]{64}$/;

/*
FNXC:RoomBlindReviewCoordinator 2026-07-18-13:15:
OpenSpec 7.2 requires the Engine fan-out seam to create or replay one durable,
sealed mapping before reviewers see any candidate. Candidate identity and
producer/provider/session labels are confidential inputs only; every outward
fan-out payload is rebuilt from the Core redaction contract instead of spreading
an adapter response.

FNXC:RoomBlindReviewCoordinator 2026-07-18-13:15:
An unblinded audit mapping may be requested only after an injected ledger has
recorded an explicit final verdict and an injected authorization decision grants
the requesting binding. This coordinator never executes a model or creates a
mapping itself; it delegates durable sealing and reveal to typed local ports.
*/
export class RoomBlindReviewCoordinator {
  constructor(private readonly options: RoomBlindReviewCoordinatorOptions) {
    if (!isNonBlankString(options?.projectId)) {
      throw new TypeError("RoomBlindReviewCoordinator requires a non-empty projectId");
    }
    if (typeof options?.candidateAuthority?.readCandidateLineage !== "function") {
      throw new TypeError("RoomBlindReviewCoordinator requires a candidateAuthority");
    }
    if (
      typeof options?.registry?.seal !== "function"
      || typeof options.registry.getPackForReviewer !== "function"
    ) {
      throw new TypeError("RoomBlindReviewCoordinator requires a sealed registry port");
    }
    if (
      typeof options?.verdictLedger?.recordTerminalVerdict !== "function"
      || typeof options.verdictLedger.getTerminalVerdict !== "function"
    ) {
      throw new TypeError("RoomBlindReviewCoordinator requires a terminal verdict ledger");
    }
    if (typeof options?.revealAuthorizer?.authorizeReveal !== "function") {
      throw new TypeError("RoomBlindReviewCoordinator requires a reveal authorizer");
    }
    if (typeof options?.revealPort?.reveal !== "function") {
      throw new TypeError("RoomBlindReviewCoordinator requires a reveal port");
    }
  }

  async createFanout(input: CreateRoomBlindReviewFanoutInputV1): Promise<RoomBlindReviewFanoutResultV1> {
    const normalized = normalizeCreateFanoutInput(input);
    this.assertProjectScope(normalized.reviewRound.scope);
    assertReviewerIndependence(normalized.reviewRound.reviewerBindingIds, normalized.candidateSubmissions);
    await this.assertCandidateProofs(normalized);

    const sealed = await this.options.registry.seal({
      contractVersion: 1,
      scope: normalized.reviewRound.scope,
      idempotencyKey: normalized.idempotencyKey,
      now: normalized.now,
      expiresAt: normalized.reviewRound.expiresAt,
      packInput: toPackInput(normalized),
    });
    const view = safeRegistryView(sealed, {
      scope: normalized.reviewRound.scope,
      reviewRoundId: normalized.reviewRound.reviewRoundId,
    });
    if (view.expiresAt !== normalized.reviewRound.expiresAt) {
      throw coordinatorError(
        "registry_response_invalid",
        "The sealed registry response did not retain the requested review expiry",
      );
    }
    if (typeof sealed.replayed !== "boolean") {
      throw coordinatorError("registry_response_invalid", "The sealed registry response did not state replay status");
    }
    return freeze({
      contractVersion: 1,
      scope: copyScope(view.scope),
      reviewRoundId: view.reviewRoundId,
      replayed: sealed.replayed,
      registryProof: toRegistryProof(view),
      reviewPack: view.pack,
    });
  }

  async deliverPack(input: DeliverRoomBlindReviewPackInputV1): Promise<RoomBlindReviewPackDeliveryV1> {
    const normalized = normalizeDeliveryInput(input);
    this.assertProjectScope(normalized.scope);
    const view = safeRegistryView(await this.options.registry.getPackForReviewer({
      contractVersion: 1,
      scope: normalized.scope,
      reviewRoundId: normalized.reviewRoundId,
      reviewerBindingId: normalized.reviewerBindingId,
      now: normalized.now,
    }), {
      scope: normalized.scope,
      reviewRoundId: normalized.reviewRoundId,
    });
    if (!view.pack.reviewerBindingIds.includes(normalized.reviewerBindingId)) {
      throw coordinatorError(
        "registry_response_invalid",
        "The sealed registry response did not authorize the requested reviewer",
      );
    }
    return freeze({
      contractVersion: 1,
      scope: copyScope(view.scope),
      reviewRoundId: view.reviewRoundId,
      reviewerBindingId: normalized.reviewerBindingId,
      deliveredAt: normalized.now,
      registryProof: toRegistryProof(view),
      reviewPack: view.pack,
    });
  }

  async recordTerminalVerdict(
    input: RecordRoomBlindReviewTerminalVerdictInputV1,
  ): Promise<RoomBlindReviewRecordedTerminalVerdictV1> {
    const normalized = normalizeRecordTerminalVerdictInput(input);
    this.assertProjectScope(normalized.scope);
    const view = safeRegistryView(await this.options.registry.getPackForReviewer({
      contractVersion: 1,
      scope: normalized.scope,
      reviewRoundId: normalized.reviewRoundId,
      reviewerBindingId: normalized.reviewerBindingId,
      now: normalized.now,
    }), {
      scope: normalized.scope,
      reviewRoundId: normalized.reviewRoundId,
    });
    const proof = toRegistryProof(view);
    if (!sameRegistryProof(normalized.registryProof, proof)) {
      throw coordinatorError(
        "registry_proof_mismatch",
        "A terminal review verdict must carry the exact proof from the sealed reviewer delivery",
      );
    }
    const opaqueIds = new Set(view.pack.candidates.map((candidate) => candidate.opaqueCandidateId));
    if (normalized.verdict.selectedOpaqueCandidateIds.some((candidateId) => !opaqueIds.has(candidateId))) {
      throw coordinatorError(
        "unknown_opaque_candidate",
        "A terminal review verdict selected a candidate absent from its sealed reviewer pack",
      );
    }
    const record = await this.options.verdictLedger.recordTerminalVerdict({
      ...normalized,
      registryProof: proof,
    });
    return validateRecordedTerminalVerdict(record, {
      scope: normalized.scope,
      reviewRoundId: normalized.reviewRoundId,
      reviewerBindingId: normalized.reviewerBindingId,
      idempotencyKey: normalized.idempotencyKey,
      registryProof: proof,
      verdict: normalized.verdict,
    });
  }

  async requestReveal(input: RequestRoomBlindReviewRevealInputV1): Promise<RoomBlindReviewRevealResultV1> {
    const normalized = normalizeRevealRequest(input);
    this.assertProjectScope(normalized.scope);
    const stored = await this.options.verdictLedger.getTerminalVerdict({
      contractVersion: 1,
      scope: normalized.scope,
      reviewRoundId: normalized.reviewRoundId,
      recordId: normalized.terminalVerdictRecordId,
    });
    if (!stored) {
      throw coordinatorError(
        "terminal_verdict_not_recorded",
        "Reveal is withheld until a durable final review verdict is recorded",
      );
    }
    const terminalVerdictRecord = validateRevealVerdictRecord(stored, normalized);
    const authorization = await this.options.revealAuthorizer.authorizeReveal({
      contractVersion: 1,
      scope: normalized.scope,
      reviewRoundId: normalized.reviewRoundId,
      requesterBindingId: normalized.requesterBindingId,
      now: normalized.now,
      terminalVerdictRecord,
    });
    if (!authorization) {
      throw coordinatorError("reveal_not_authorized", "Reveal was not granted to this binding");
    }
    const validAuthorization = validateRevealAuthorization(authorization, normalized, terminalVerdictRecord);
    const revealed = await this.options.revealPort.reveal({
      contractVersion: 1,
      scope: normalized.scope,
      reviewRoundId: normalized.reviewRoundId,
      requesterBindingId: normalized.requesterBindingId,
      idempotencyKey: normalized.idempotencyKey,
      now: normalized.now,
      authorization: validAuthorization,
      terminalVerdictRecord,
    });
    return validateRevealResult(revealed, normalized, terminalVerdictRecord, validAuthorization);
  }

  private assertProjectScope(scope: RoomBlindReviewRegistryScopeV1): void {
    if (scope.projectId !== this.options.projectId) {
      throw coordinatorError("project_mismatch", "Blind-review requests must remain inside the configured project");
    }
  }

  private async assertCandidateProofs(input: NormalizedCreateFanoutInput): Promise<void> {
    /*
    FNXC:RoomBlindReviewCoordinator 2026-07-18-13:20:
    Candidate proof reads are immutable and candidate IDs are already unique at
    this boundary, so a large MoA fan-out must validate them concurrently rather
    than artificially serializing review preparation. Any missing or mismatched
    proof still rejects the whole seal before the registry is called.
    */
    await Promise.all(input.candidateSubmissions.map(async (submission) => {
      const recorded = await this.options.candidateAuthority.readCandidateLineage({
        contractVersion: 1,
        scope: input.reviewRound.scope,
        candidateId: submission.candidateId,
      });
      if (!recorded) {
        throw coordinatorError(
          "unknown_candidate",
          "Blind-review fan-out requires every candidate to be present in the candidate authority",
        );
      }
      if (!sameCandidateLineage(recorded, submission)) {
        throw coordinatorError(
          "candidate_proof_mismatch",
          "Blind-review fan-out candidate data did not match its durable candidate proof",
        );
      }
    }));
  }
}

interface NormalizedCreateFanoutInput {
  readonly contractVersion: 1;
  readonly idempotencyKey: string;
  readonly now: string;
  readonly reviewRound: RoomBlindReviewRoundV1;
  readonly candidateSubmissions: readonly RoomBlindReviewCandidateSubmissionV1[];
}

interface NormalizedDeliveryInput {
  readonly contractVersion: 1;
  readonly scope: RoomBlindReviewRegistryScopeV1;
  readonly reviewRoundId: string;
  readonly reviewerBindingId: string;
  readonly now: string;
}

type NormalizedRecordTerminalVerdictInput = RecordRoomBlindReviewTerminalVerdictInputV1;

type NormalizedRevealRequest = RequestRoomBlindReviewRevealInputV1;

function normalizeCreateFanoutInput(input: CreateRoomBlindReviewFanoutInputV1): NormalizedCreateFanoutInput {
  const raw = requireRecord(input, "Blind-review fan-out input");
  assertExactKeys(raw, ["contractVersion", "idempotencyKey", "now", "reviewRound", "candidateSubmissions"], "Blind-review fan-out input");
  if (raw.contractVersion !== ROOM_BLIND_REVIEW_COORDINATOR_CONTRACT_VERSION) {
    throw coordinatorError("invalid_input", "Blind-review fan-out requires contract version 1");
  }
  const reviewRound = normalizeReviewRound(raw.reviewRound);
  const candidateSubmissions = normalizeCandidateSubmissions(raw.candidateSubmissions);
  if (candidateSubmissions.length === 0) {
    throw coordinatorError("invalid_input", "Blind-review fan-out requires at least one candidate submission");
  }
  return freeze({
    contractVersion: 1,
    idempotencyKey: requireText(raw.idempotencyKey, "Blind-review idempotency key"),
    now: requireTimestamp(raw.now, "Blind-review fan-out time"),
    reviewRound,
    candidateSubmissions,
  });
}

function normalizeReviewRound(value: unknown): RoomBlindReviewRoundV1 {
  const raw = requireRecord(value, "Blind-review review round");
  assertExactKeys(raw, [
    "contractVersion",
    "scope",
    "reviewRoundId",
    "sourceSetHash",
    "createdAt",
    "expiresAt",
    "reviewerBindingIds",
  ], "Blind-review review round");
  if (raw.contractVersion !== ROOM_BLIND_REVIEW_COORDINATOR_CONTRACT_VERSION) {
    throw coordinatorError("invalid_input", "Blind-review review round requires contract version 1");
  }
  const createdAt = requireTimestamp(raw.createdAt, "Blind-review round creation time");
  const expiresAt = requireTimestamp(raw.expiresAt, "Blind-review round expiry time");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) {
    throw coordinatorError("invalid_input", "Blind-review review round expiry must follow its creation time");
  }
  return freeze({
    contractVersion: 1,
    scope: normalizeScope(raw.scope),
    reviewRoundId: requireText(raw.reviewRoundId, "Blind-review round id"),
    sourceSetHash: requireHash(raw.sourceSetHash, "Blind-review source-set hash"),
    createdAt,
    expiresAt,
    reviewerBindingIds: requireNonEmptyUniqueTextArray(raw.reviewerBindingIds, "Blind-review reviewer bindings"),
  });
}

function normalizeCandidateSubmissions(value: unknown): readonly RoomBlindReviewCandidateSubmissionV1[] {
  if (!Array.isArray(value)) {
    throw coordinatorError("invalid_input", "Blind-review candidate submissions must be an array");
  }
  const candidateIds = new Set<string>();
  const opaqueIds = new Set<string>();
  const submissions = value.map((entry) => {
    const raw = requireRecord(entry, "Blind-review candidate submission");
    assertExactKeys(raw, [
      "candidateId",
      "candidateHash",
      "sourceRecordId",
      "sourceHash",
      "artifactHash",
      "producerBindingIds",
      "opaqueCandidateId",
    ], "Blind-review candidate submission");
    const candidateId = requireText(raw.candidateId, "Blind-review candidate id");
    const opaqueCandidateId = requireText(raw.opaqueCandidateId, "Blind-review opaque candidate id");
    if (candidateIds.has(candidateId)) {
      throw coordinatorError("duplicate_candidate", "Blind-review candidate ids must be unique");
    }
    if (opaqueIds.has(opaqueCandidateId)) {
      throw coordinatorError("duplicate_candidate", "Blind-review opaque candidate ids must be unique");
    }
    const producerBindingIds = requireNonEmptyUniqueTextArray(
      raw.producerBindingIds,
      "Blind-review producer bindings",
    );
    const identityLabels = [candidateId, ...producerBindingIds].filter((identity) => identity.length >= 4);
    if (identityLabels.some((identity) => opaqueCandidateId.toLowerCase().includes(identity.toLowerCase()))) {
      throw coordinatorError(
        "invalid_input",
        "Blind-review opaque candidate ids must not embed candidate or producer identity labels",
      );
    }
    candidateIds.add(candidateId);
    opaqueIds.add(opaqueCandidateId);
    return freeze({
      candidateId,
      candidateHash: requireHash(raw.candidateHash, "Blind-review candidate hash"),
      sourceRecordId: requireText(raw.sourceRecordId, "Blind-review source record id"),
      sourceHash: requireHash(raw.sourceHash, "Blind-review source hash"),
      artifactHash: requireHash(raw.artifactHash, "Blind-review artifact hash"),
      producerBindingIds,
      opaqueCandidateId,
    });
  });
  return freeze(submissions);
}

function assertReviewerIndependence(
  reviewerBindingIds: readonly string[],
  candidates: readonly RoomBlindReviewCandidateSubmissionV1[],
): void {
  const reviewers = new Set(reviewerBindingIds);
  if (candidates.some((candidate) => candidate.producerBindingIds.some((bindingId) => reviewers.has(bindingId)))) {
    throw coordinatorError(
      "reviewer_conflict",
      "Blind-review reviewers may not appear in submitted producer lineage",
    );
  }
}

function toPackInput(input: NormalizedCreateFanoutInput): CreateRoomBlindReviewPackInputV1 {
  return freeze({
    contractVersion: 1,
    reviewRoundId: input.reviewRound.reviewRoundId,
    sourceSetHash: input.reviewRound.sourceSetHash,
    createdAt: input.reviewRound.createdAt,
    reviewers: input.reviewRound.reviewerBindingIds.map((bindingId) => freeze({ bindingId })),
    candidateLineage: input.candidateSubmissions.map((submission) => freeze({
      candidateId: submission.candidateId,
      candidateHash: submission.candidateHash,
      sourceRecordId: submission.sourceRecordId,
      sourceHash: submission.sourceHash,
      artifactHash: submission.artifactHash,
      producerBindingIds: submission.producerBindingIds,
    })),
    opaqueBindings: input.candidateSubmissions.map((submission) => freeze({
      candidateId: submission.candidateId,
      opaqueCandidateId: submission.opaqueCandidateId,
    })),
  });
}

function normalizeDeliveryInput(input: DeliverRoomBlindReviewPackInputV1): NormalizedDeliveryInput {
  const raw = requireRecord(input, "Blind-review delivery input");
  assertExactKeys(raw, ["contractVersion", "scope", "reviewRoundId", "reviewerBindingId", "now"], "Blind-review delivery input");
  if (raw.contractVersion !== ROOM_BLIND_REVIEW_COORDINATOR_CONTRACT_VERSION) {
    throw coordinatorError("invalid_input", "Blind-review delivery requires contract version 1");
  }
  return freeze({
    contractVersion: 1,
    scope: normalizeScope(raw.scope),
    reviewRoundId: requireText(raw.reviewRoundId, "Blind-review delivery round id"),
    reviewerBindingId: requireText(raw.reviewerBindingId, "Blind-review delivery reviewer binding id"),
    now: requireTimestamp(raw.now, "Blind-review delivery time"),
  });
}

function normalizeRecordTerminalVerdictInput(
  input: RecordRoomBlindReviewTerminalVerdictInputV1,
): NormalizedRecordTerminalVerdictInput {
  const raw = requireRecord(input, "Blind-review terminal verdict input");
  assertExactKeys(raw, [
    "contractVersion",
    "scope",
    "reviewRoundId",
    "reviewerBindingId",
    "idempotencyKey",
    "now",
    "registryProof",
    "verdict",
  ], "Blind-review terminal verdict input");
  if (raw.contractVersion !== ROOM_BLIND_REVIEW_COORDINATOR_CONTRACT_VERSION) {
    throw coordinatorError("invalid_input", "Blind-review terminal verdict requires contract version 1");
  }
  return freeze({
    contractVersion: 1,
    scope: normalizeScope(raw.scope),
    reviewRoundId: requireText(raw.reviewRoundId, "Blind-review verdict round id"),
    reviewerBindingId: requireText(raw.reviewerBindingId, "Blind-review verdict reviewer binding id"),
    idempotencyKey: requireText(raw.idempotencyKey, "Blind-review verdict idempotency key"),
    now: requireTimestamp(raw.now, "Blind-review verdict time"),
    registryProof: normalizeRegistryProof(raw.registryProof),
    verdict: normalizeTerminalVerdict(raw.verdict),
  });
}

function normalizeTerminalVerdict(value: unknown): RoomBlindReviewTerminalVerdictV1 {
  const raw = requireRecord(value, "Blind-review terminal verdict");
  assertExactKeys(raw, [
    "contractVersion",
    "outcome",
    "final",
    "selectedOpaqueCandidateIds",
    "evidenceRefs",
  ], "Blind-review terminal verdict");
  if (
    raw.contractVersion !== ROOM_BLIND_REVIEW_COORDINATOR_CONTRACT_VERSION
    || raw.final !== true
    || !isTerminalVerdictOutcome(raw.outcome)
  ) {
    throw coordinatorError(
      "terminal_verdict_required",
      "Reveal authorization requires an explicit supported final review verdict",
    );
  }
  return freeze({
    contractVersion: 1,
    outcome: raw.outcome,
    final: true,
    selectedOpaqueCandidateIds: requireUniqueTextArray(raw.selectedOpaqueCandidateIds, "Selected opaque candidate ids"),
    evidenceRefs: requireNonEmptyUniqueTextArray(raw.evidenceRefs, "Terminal verdict evidence refs"),
  });
}

function normalizeRevealRequest(input: RequestRoomBlindReviewRevealInputV1): NormalizedRevealRequest {
  const raw = requireRecord(input, "Blind-review reveal request");
  assertExactKeys(raw, [
    "contractVersion",
    "scope",
    "reviewRoundId",
    "requesterBindingId",
    "terminalVerdictRecordId",
    "idempotencyKey",
    "now",
  ], "Blind-review reveal request");
  if (raw.contractVersion !== ROOM_BLIND_REVIEW_COORDINATOR_CONTRACT_VERSION) {
    throw coordinatorError("invalid_input", "Blind-review reveal requires contract version 1");
  }
  return freeze({
    contractVersion: 1,
    scope: normalizeScope(raw.scope),
    reviewRoundId: requireText(raw.reviewRoundId, "Blind-review reveal round id"),
    requesterBindingId: requireText(raw.requesterBindingId, "Blind-review reveal requester binding id"),
    terminalVerdictRecordId: requireText(raw.terminalVerdictRecordId, "Blind-review terminal verdict record id"),
    idempotencyKey: requireText(raw.idempotencyKey, "Blind-review reveal idempotency key"),
    now: requireTimestamp(raw.now, "Blind-review reveal time"),
  });
}

function safeRegistryView(
  value: unknown,
  expected: { readonly scope: RoomBlindReviewRegistryScopeV1; readonly reviewRoundId: string },
): RoomBlindReviewPackViewV1 {
  const raw = requireRecord(value, "Sealed blind-review registry response", "registry_response_invalid");
  if (
    raw.contractVersion !== 1
    || !sameScope(raw.scope, expected.scope)
    || raw.reviewRoundId !== expected.reviewRoundId
  ) {
    throw coordinatorError("registry_response_invalid", "The sealed registry response did not match the requested review scope");
  }
  const sealedAt = requireTimestamp(raw.sealedAt, "Sealed blind-review time", "registry_response_invalid");
  const expiresAt = requireTimestamp(raw.expiresAt, "Sealed blind-review expiry", "registry_response_invalid");
  if (Date.parse(expiresAt) <= Date.parse(sealedAt)) {
    throw coordinatorError("registry_response_invalid", "The sealed registry response contained an invalid expiry");
  }
  return freeze({
    contractVersion: 1,
    scope: copyScope(expected.scope),
    reviewRoundId: expected.reviewRoundId,
    mappingIntegrityHash: requireHash(raw.mappingIntegrityHash, "Sealed mapping integrity hash", "registry_response_invalid"),
    sealedAt,
    expiresAt,
    pack: safeReviewPack(raw.pack, expected.reviewRoundId),
  });
}

function safeReviewPack(value: unknown, expectedReviewRoundId: string): RoomBlindReviewPackV1 {
  const raw = requireRecord(value, "Sealed reviewer pack", "registry_response_invalid");
  if (
    raw.contractVersion !== 1
    || raw.purpose !== "blind_review_only"
    || raw.reviewRoundId !== expectedReviewRoundId
  ) {
    throw coordinatorError("registry_response_invalid", "The registry response did not contain a blind-review-only pack");
  }
  const reviewerBindingIds = requireNonEmptyUniqueTextArray(
    raw.reviewerBindingIds,
    "Sealed reviewer bindings",
    "registry_response_invalid",
  );
  if (!Array.isArray(raw.candidates) || raw.candidates.length === 0) {
    throw coordinatorError("registry_response_invalid", "The sealed reviewer pack must contain candidates");
  }
  const opaqueIds = new Set<string>();
  const candidates = raw.candidates.map((candidate) => {
    const entry = requireRecord(candidate, "Sealed reviewer candidate", "registry_response_invalid");
    const opaqueCandidateId = requireText(
      entry.opaqueCandidateId,
      "Sealed opaque candidate id",
      "registry_response_invalid",
    );
    if (opaqueIds.has(opaqueCandidateId)) {
      throw coordinatorError("registry_response_invalid", "The sealed reviewer pack repeated an opaque candidate id");
    }
    opaqueIds.add(opaqueCandidateId);
    return freeze({
      opaqueCandidateId,
      candidateHash: requireHash(entry.candidateHash, "Sealed candidate hash", "registry_response_invalid"),
      artifactHash: requireHash(entry.artifactHash, "Sealed artifact hash", "registry_response_invalid"),
    });
  });
  return freeze({
    contractVersion: 1,
    purpose: "blind_review_only",
    reviewRoundId: expectedReviewRoundId,
    sourceSetHash: requireHash(raw.sourceSetHash, "Sealed source-set hash", "registry_response_invalid"),
    createdAt: requireTimestamp(raw.createdAt, "Sealed pack creation time", "registry_response_invalid"),
    reviewerBindingIds,
    candidates: freeze(candidates),
  });
}

function toRegistryProof(view: RoomBlindReviewPackViewV1): RoomBlindReviewRegistryProofV1 {
  return freeze({
    contractVersion: 1,
    scope: copyScope(view.scope),
    reviewRoundId: view.reviewRoundId,
    mappingIntegrityHash: view.mappingIntegrityHash,
    sealedAt: view.sealedAt,
    expiresAt: view.expiresAt,
  });
}

function normalizeRegistryProof(value: unknown): RoomBlindReviewRegistryProofV1 {
  const raw = requireRecord(value, "Blind-review registry proof", "registry_proof_missing");
  assertExactKeys(raw, [
    "contractVersion",
    "scope",
    "reviewRoundId",
    "mappingIntegrityHash",
    "sealedAt",
    "expiresAt",
  ], "Blind-review registry proof", "registry_proof_missing");
  if (raw.contractVersion !== ROOM_BLIND_REVIEW_COORDINATOR_CONTRACT_VERSION) {
    throw coordinatorError("registry_proof_missing", "Blind-review registry proof requires contract version 1");
  }
  const sealedAt = requireTimestamp(raw.sealedAt, "Blind-review proof seal time", "registry_proof_missing");
  const expiresAt = requireTimestamp(raw.expiresAt, "Blind-review proof expiry time", "registry_proof_missing");
  if (Date.parse(expiresAt) <= Date.parse(sealedAt)) {
    throw coordinatorError("registry_proof_missing", "Blind-review registry proof has an invalid expiry");
  }
  return freeze({
    contractVersion: 1,
    scope: normalizeScope(raw.scope),
    reviewRoundId: requireText(raw.reviewRoundId, "Blind-review proof round id", "registry_proof_missing"),
    mappingIntegrityHash: requireHash(raw.mappingIntegrityHash, "Blind-review proof mapping hash", "registry_proof_missing"),
    sealedAt,
    expiresAt,
  });
}

function validateRecordedTerminalVerdict(
  value: unknown,
  expected: {
    readonly scope: RoomBlindReviewRegistryScopeV1;
    readonly reviewRoundId: string;
    readonly reviewerBindingId: string;
    readonly idempotencyKey: string;
    readonly registryProof: RoomBlindReviewRegistryProofV1;
    readonly verdict: RoomBlindReviewTerminalVerdictV1;
  },
): RoomBlindReviewRecordedTerminalVerdictV1 {
  const raw = requireRecord(value, "Recorded blind-review terminal verdict", "terminal_verdict_record_mismatch");
  if (
    raw.contractVersion !== 1
    || !isNonBlankString(raw.recordId)
    || !sameScope(raw.scope, expected.scope)
    || raw.reviewRoundId !== expected.reviewRoundId
    || raw.reviewerBindingId !== expected.reviewerBindingId
    || raw.idempotencyKey !== expected.idempotencyKey
    || typeof raw.replayed !== "boolean"
  ) {
    throw coordinatorError(
      "terminal_verdict_record_mismatch",
      "The verdict ledger response did not match the submitted terminal review verdict",
    );
  }
  const registryProof = normalizeRegistryProof(raw.registryProof);
  const verdict = normalizeTerminalVerdict(raw.verdict);
  if (
    !sameRegistryProof(registryProof, expected.registryProof)
    || !sameTerminalVerdict(verdict, expected.verdict)
  ) {
    throw coordinatorError(
      "terminal_verdict_record_mismatch",
      "The verdict ledger response was not bound to the sealed pack proof and final verdict",
    );
  }
  return freeze({
    contractVersion: 1,
    recordId: raw.recordId,
    scope: copyScope(expected.scope),
    reviewRoundId: expected.reviewRoundId,
    reviewerBindingId: expected.reviewerBindingId,
    idempotencyKey: expected.idempotencyKey,
    registryProof,
    verdict,
    recordedAt: requireTimestamp(raw.recordedAt, "Terminal verdict record time", "terminal_verdict_record_mismatch"),
    replayed: raw.replayed,
  });
}

function validateRevealVerdictRecord(
  value: unknown,
  request: NormalizedRevealRequest,
): RoomBlindReviewRecordedTerminalVerdictV1 {
  const raw = requireRecord(value, "Stored blind-review terminal verdict", "terminal_verdict_record_mismatch");
  if (
    raw.recordId !== request.terminalVerdictRecordId
    || !sameScope(raw.scope, request.scope)
    || raw.reviewRoundId !== request.reviewRoundId
  ) {
    throw coordinatorError(
      "terminal_verdict_record_mismatch",
      "The stored terminal verdict did not match the reveal request scope",
    );
  }
  const record = validateRecordedTerminalVerdict(raw, {
    scope: request.scope,
    reviewRoundId: request.reviewRoundId,
    reviewerBindingId: requireText(raw.reviewerBindingId, "Stored terminal verdict reviewer binding id", "terminal_verdict_record_mismatch"),
    idempotencyKey: requireText(raw.idempotencyKey, "Stored terminal verdict idempotency key", "terminal_verdict_record_mismatch"),
    registryProof: normalizeRegistryProof(raw.registryProof),
    verdict: normalizeTerminalVerdict(raw.verdict),
  });
  if (!record.verdict.final || !isTerminalVerdictOutcome(record.verdict.outcome)) {
    throw coordinatorError(
      "terminal_verdict_required",
      "Reveal requires a recorded final review verdict",
    );
  }
  return record;
}

function validateRevealAuthorization(
  value: unknown,
  request: NormalizedRevealRequest,
  terminalVerdictRecord: RoomBlindReviewRecordedTerminalVerdictV1,
): RoomBlindReviewRevealAuthorizationV1 {
  const raw = requireRecord(value, "Blind-review reveal authorization", "reveal_authorization_invalid");
  if (
    raw.contractVersion !== 1
    || !isNonBlankString(raw.authorizationId)
    || !sameScope(raw.scope, request.scope)
    || raw.reviewRoundId !== request.reviewRoundId
    || raw.requesterBindingId !== request.requesterBindingId
    || raw.terminalVerdictRecordId !== terminalVerdictRecord.recordId
  ) {
    throw coordinatorError("reveal_authorization_invalid", "Reveal authorization did not bind the requested verdict and actor");
  }
  const issuedAt = requireTimestamp(raw.issuedAt, "Reveal authorization issue time", "reveal_authorization_invalid");
  const expiresAt = requireTimestamp(raw.expiresAt, "Reveal authorization expiry time", "reveal_authorization_invalid");
  if (Date.parse(expiresAt) <= Date.parse(issuedAt) || Date.parse(request.now) >= Date.parse(expiresAt)) {
    throw coordinatorError("reveal_authorization_invalid", "Reveal authorization is expired or has an invalid lifetime");
  }
  return freeze({
    contractVersion: 1,
    authorizationId: raw.authorizationId,
    scope: copyScope(request.scope),
    reviewRoundId: request.reviewRoundId,
    requesterBindingId: request.requesterBindingId,
    terminalVerdictRecordId: terminalVerdictRecord.recordId,
    issuedAt,
    expiresAt,
  });
}

function validateRevealResult(
  value: unknown,
  request: NormalizedRevealRequest,
  terminalVerdictRecord: RoomBlindReviewRecordedTerminalVerdictV1,
  authorization: RoomBlindReviewRevealAuthorizationV1,
): RoomBlindReviewRevealResultV1 {
  const raw = requireRecord(value, "Blind-review reveal result", "reveal_result_invalid");
  if (
    raw.contractVersion !== 1
    || !sameScope(raw.scope, request.scope)
    || raw.reviewRoundId !== request.reviewRoundId
    || raw.terminalVerdictRecordId !== terminalVerdictRecord.recordId
    || raw.authorizationId !== authorization.authorizationId
    || !sameHash(raw.mappingIntegrityHash, terminalVerdictRecord.registryProof.mappingIntegrityHash)
    || typeof raw.replayed !== "boolean"
    || !Array.isArray(raw.mappings)
  ) {
    throw coordinatorError("reveal_result_invalid", "Reveal output did not match its authorization and recorded verdict");
  }
  const mappings = raw.mappings.map((entry) => {
    const mapping = requireRecord(entry, "Blind-review revealed mapping", "reveal_result_invalid");
    return freeze({
      opaqueCandidateId: requireText(mapping.opaqueCandidateId, "Revealed opaque candidate id", "reveal_result_invalid"),
      candidateId: requireText(mapping.candidateId, "Revealed candidate id", "reveal_result_invalid"),
      sourceRecordId: requireText(mapping.sourceRecordId, "Revealed source record id", "reveal_result_invalid"),
      producerBindingIds: requireNonEmptyUniqueTextArray(
        mapping.producerBindingIds,
        "Revealed producer bindings",
        "reveal_result_invalid",
      ),
    });
  });
  return freeze({
    contractVersion: 1,
    scope: copyScope(request.scope),
    reviewRoundId: request.reviewRoundId,
    terminalVerdictRecordId: terminalVerdictRecord.recordId,
    authorizationId: authorization.authorizationId,
    mappingIntegrityHash: terminalVerdictRecord.registryProof.mappingIntegrityHash,
    revealedAt: requireTimestamp(raw.revealedAt, "Reveal result time", "reveal_result_invalid"),
    replayed: raw.replayed,
    mappings: freeze(mappings),
  });
}

function sameCandidateLineage(
  recorded: RoomBlindReviewCandidateLineageV1,
  submitted: RoomBlindReviewCandidateSubmissionV1,
): boolean {
  return (
    recorded.candidateId === submitted.candidateId
    && recorded.candidateHash === submitted.candidateHash
    && recorded.sourceRecordId === submitted.sourceRecordId
    && recorded.sourceHash === submitted.sourceHash
    && recorded.artifactHash === submitted.artifactHash
    && sameTextSet(recorded.producerBindingIds, submitted.producerBindingIds)
  );
}

function sameRegistryProof(left: RoomBlindReviewRegistryProofV1, right: RoomBlindReviewRegistryProofV1): boolean {
  return (
    left.contractVersion === right.contractVersion
    && sameScope(left.scope, right.scope)
    && left.reviewRoundId === right.reviewRoundId
    && left.mappingIntegrityHash === right.mappingIntegrityHash
    && left.sealedAt === right.sealedAt
    && left.expiresAt === right.expiresAt
  );
}

function sameTerminalVerdict(left: RoomBlindReviewTerminalVerdictV1, right: RoomBlindReviewTerminalVerdictV1): boolean {
  return (
    left.contractVersion === right.contractVersion
    && left.outcome === right.outcome
    && left.final === right.final
    && sameTextSet(left.selectedOpaqueCandidateIds, right.selectedOpaqueCandidateIds)
    && sameTextSet(left.evidenceRefs, right.evidenceRefs)
  );
}

function normalizeScope(value: unknown): RoomBlindReviewRegistryScopeV1 {
  const raw = requireRecord(value, "Blind-review scope");
  assertExactKeys(raw, ["projectId", "roomId"], "Blind-review scope");
  return freeze({
    projectId: requireText(raw.projectId, "Blind-review project id"),
    roomId: requireText(raw.roomId, "Blind-review Room id"),
  });
}

function sameScope(value: unknown, expected: RoomBlindReviewRegistryScopeV1): boolean {
  return isRecord(value) && value.projectId === expected.projectId && value.roomId === expected.roomId;
}

function copyScope(scope: RoomBlindReviewRegistryScopeV1): RoomBlindReviewRegistryScopeV1 {
  return freeze({ projectId: scope.projectId, roomId: scope.roomId });
}

function sameHash(value: unknown, expected: RoomBlindReviewPackHashV1): boolean {
  return typeof value === "string" && value === expected && HASH.test(value);
}

function requireHash(
  value: unknown,
  label: string,
  code: RoomBlindReviewCoordinatorErrorCodeV1 = "invalid_input",
): RoomBlindReviewPackHashV1 {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw coordinatorError(code, `${label} must be a SHA-256 hash`);
  }
  return value as RoomBlindReviewPackHashV1;
}

function requireTimestamp(
  value: unknown,
  label: string,
  code: RoomBlindReviewCoordinatorErrorCodeV1 = "invalid_input",
): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    throw coordinatorError(code, `${label} must be a canonical ISO timestamp`);
  }
  return value;
}

function requireText(
  value: unknown,
  label: string,
  code: RoomBlindReviewCoordinatorErrorCodeV1 = "invalid_input",
): string {
  if (!isNonBlankString(value)) {
    throw coordinatorError(code, `${label} must be non-blank text`);
  }
  return value;
}

function requireUniqueTextArray(
  value: unknown,
  label: string,
  code: RoomBlindReviewCoordinatorErrorCodeV1 = "invalid_input",
): readonly string[] {
  if (!Array.isArray(value) || !value.every(isNonBlankString)) {
    throw coordinatorError(code, `${label} must be an array of non-blank text`);
  }
  const values = [...value];
  if (new Set(values).size !== values.length) {
    throw coordinatorError(code, `${label} must be unique`);
  }
  return freeze(values.sort());
}

function requireNonEmptyUniqueTextArray(
  value: unknown,
  label: string,
  code: RoomBlindReviewCoordinatorErrorCodeV1 = "invalid_input",
): readonly string[] {
  const values = requireUniqueTextArray(value, label, code);
  if (values.length === 0) {
    throw coordinatorError(code, `${label} must not be empty`);
  }
  return values;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
  code: RoomBlindReviewCoordinatorErrorCodeV1 = "invalid_input",
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw coordinatorError(code, `${label} has unexpected properties`);
  }
}

function requireRecord(
  value: unknown,
  label: string,
  code: RoomBlindReviewCoordinatorErrorCodeV1 = "invalid_input",
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw coordinatorError(code, `${label} must be an object`);
  }
  return value;
}

function isTerminalVerdictOutcome(value: unknown): value is RoomBlindReviewTerminalVerdictOutcomeV1 {
  return typeof value === "string" && TERMINAL_VERDICT_OUTCOME_SET.has(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameTextSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function coordinatorError(
  code: RoomBlindReviewCoordinatorErrorCodeV1,
  message: string,
): RoomBlindReviewCoordinatorError {
  return new RoomBlindReviewCoordinatorError(code, message);
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

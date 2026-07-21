import { hashRoomValue } from "./room-integrity.js";

export const ROOM_EVOLUTION_BENCHMARK_POLICY_CONTRACT_VERSION = 1 as const;

export const ROOM_EVOLUTION_BENCHMARK_COLLECTION_KINDS = [
  "fixed",
  "rolling_difficult",
  "adversarial",
  "authorized_historical_replay",
] as const;

export type RoomEvolutionBenchmarkCollectionKindV1 =
  (typeof ROOM_EVOLUTION_BENCHMARK_COLLECTION_KINDS)[number];
export type RoomEvolutionBenchmarkRiskClassificationV1 = "low" | "moderate" | "high" | "critical";
export type RoomEvolutionBenchmarkSourceKindV1 =
  | "human_curated_fixed"
  | "authorized_difficulty_pool"
  | "independent_adversarial_corpus"
  | "authorized_historical_outcome";
export type RoomEvolutionBenchmarkInclusionAuthorityV1 =
  | "human_curator"
  | "independent_benchmark_governance"
  | "authorized_historical_ingestion";

export interface RoomEvolutionBenchmarkAuthorizationV1 {
  readonly id: string;
  readonly evidenceHash: string;
  readonly grantedByActorId: string;
  readonly grantedAt: string;
}

export interface RoomEvolutionBenchmarkRiskV1 {
  readonly classification: RoomEvolutionBenchmarkRiskClassificationV1;
  readonly authorization: RoomEvolutionBenchmarkAuthorizationV1 | null;
}

export interface RoomEvolutionBenchmarkPrivacyV1 {
  readonly containsPrivateData: boolean;
  readonly authorization: RoomEvolutionBenchmarkAuthorizationV1 | null;
}

export interface RoomEvolutionBenchmarkCaseSourceV1 {
  readonly kind: RoomEvolutionBenchmarkSourceKindV1;
  readonly reference: string;
  readonly evidenceHash: string;
  readonly inclusionAuthority: RoomEvolutionBenchmarkInclusionAuthorityV1;
  readonly authorActorId: string;
  readonly authorization: RoomEvolutionBenchmarkAuthorizationV1 | null;
}

export interface RoomEvolutionBenchmarkCaseV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_BENCHMARK_POLICY_CONTRACT_VERSION;
  readonly id: string;
  readonly version: number;
  readonly contentHash: string;
  readonly projectId: string;
  readonly roomId: string | null;
  readonly domain: string;
  readonly collection: RoomEvolutionBenchmarkCollectionKindV1;
  readonly difficulty: number;
  readonly risk: RoomEvolutionBenchmarkRiskV1;
  readonly privacy: RoomEvolutionBenchmarkPrivacyV1;
  readonly source: RoomEvolutionBenchmarkCaseSourceV1;
}

export interface RoomEvolutionBenchmarkCollectionPlanV1 {
  readonly collection: RoomEvolutionBenchmarkCollectionKindV1;
  readonly minimumCases: number;
  readonly maximumCases: number;
}

export interface RoomEvolutionBenchmarkEvaluationTargetV1 {
  readonly candidateVersionId: string;
  readonly immutableArtifactHash: string;
  readonly producerActorIds: readonly string[];
}

export interface SelectAuthorizedRoomEvolutionBenchmarkSnapshotInputV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_BENCHMARK_POLICY_CONTRACT_VERSION;
  readonly projectId: string;
  readonly roomId: string | null;
  readonly snapshotId: string;
  readonly catalogVersion: number;
  readonly asOf: string;
  readonly baseline: RoomEvolutionBenchmarkEvaluationTargetV1;
  readonly candidate: RoomEvolutionBenchmarkEvaluationTargetV1;
  readonly plans: readonly RoomEvolutionBenchmarkCollectionPlanV1[];
  readonly cases: readonly RoomEvolutionBenchmarkCaseV1[];
}

export interface RoomEvolutionSelectedBenchmarkCaseV1 {
  readonly id: string;
  readonly version: number;
  readonly contentHash: string;
  readonly domain: string;
  readonly collection: RoomEvolutionBenchmarkCollectionKindV1;
  readonly riskClassification: RoomEvolutionBenchmarkRiskClassificationV1;
  readonly sourceKind: RoomEvolutionBenchmarkSourceKindV1;
}

export interface RoomEvolutionBenchmarkSnapshotV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_BENCHMARK_POLICY_CONTRACT_VERSION;
  readonly id: string;
  readonly projectId: string;
  readonly roomId: string | null;
  readonly catalogVersion: number;
  readonly asOf: string;
  readonly selectedCases: readonly RoomEvolutionSelectedBenchmarkCaseV1[];
  readonly snapshotHash: string;
}

export interface RoomEvolutionBenchmarkEvaluationBindingV1 {
  readonly candidateVersionId: string;
  readonly immutableArtifactHash: string;
  readonly benchmarkSnapshotId: string;
  readonly benchmarkSnapshotHash: string;
}

export interface RoomEvolutionBenchmarkSelectionV1 {
  readonly snapshot: RoomEvolutionBenchmarkSnapshotV1;
  readonly baselineEvaluation: RoomEvolutionBenchmarkEvaluationBindingV1;
  readonly candidateEvaluation: RoomEvolutionBenchmarkEvaluationBindingV1;
}

export type RoomEvolutionBenchmarkSelectionIssueCodeV1 =
  | "invalid_input"
  | "invalid_timestamp"
  | "duplicate_identifier"
  | "scope_mismatch"
  | "unauthorized_case_source"
  | "self_enrollment_forbidden"
  | "unauthorized_private_case"
  | "unauthorized_high_risk_case"
  | "unauthorized_historical_replay"
  | "insufficient_authorized_cases";

export interface RoomEvolutionBenchmarkSelectionIssueV1 {
  readonly code: RoomEvolutionBenchmarkSelectionIssueCodeV1;
  readonly path: string;
  readonly message: string;
}

export type SelectAuthorizedRoomEvolutionBenchmarkSnapshotResultV1 =
  | { readonly ok: true; readonly value: RoomEvolutionBenchmarkSelectionV1 }
  | { readonly ok: false; readonly issues: readonly RoomEvolutionBenchmarkSelectionIssueV1[] };

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH = /^sha256:[a-f0-9]{64}$/u;
const MAX_CASES_PER_COLLECTION = 64;
const MAX_CASES_PER_SNAPSHOT = 128;
const COLLECTIONS = new Set<string>(ROOM_EVOLUTION_BENCHMARK_COLLECTION_KINDS);
const RISK_CLASSIFICATIONS = new Set<string>(["low", "moderate", "high", "critical"]);
const SOURCE_KIND_BY_COLLECTION: Readonly<Record<
  RoomEvolutionBenchmarkCollectionKindV1,
  RoomEvolutionBenchmarkSourceKindV1
>> = {
  fixed: "human_curated_fixed",
  rolling_difficult: "authorized_difficulty_pool",
  adversarial: "independent_adversarial_corpus",
  authorized_historical_replay: "authorized_historical_outcome",
};
const AUTHORITIES_BY_COLLECTION: Readonly<Record<
  RoomEvolutionBenchmarkCollectionKindV1,
  readonly RoomEvolutionBenchmarkInclusionAuthorityV1[]
>> = {
  fixed: ["human_curator", "independent_benchmark_governance"],
  rolling_difficult: ["human_curator", "independent_benchmark_governance"],
  adversarial: ["independent_benchmark_governance"],
  authorized_historical_replay: ["authorized_historical_ingestion"],
};

export function selectAuthorizedRoomEvolutionBenchmarkSnapshot(
  input: SelectAuthorizedRoomEvolutionBenchmarkSnapshotInputV1,
): SelectAuthorizedRoomEvolutionBenchmarkSnapshotResultV1 {
  const issues: RoomEvolutionBenchmarkSelectionIssueV1[] = [];
  if (!isRecord(input) || !hasExactKeys(input, [
    "contractVersion",
    "projectId",
    "roomId",
    "snapshotId",
    "catalogVersion",
    "asOf",
    "baseline",
    "candidate",
    "plans",
    "cases",
  ])) {
    return failure([issue("invalid_input", "input", "Benchmark selection input must have the exact v1 shape")]);
  }
  if (input.contractVersion !== ROOM_EVOLUTION_BENCHMARK_POLICY_CONTRACT_VERSION) {
    issues.push(issue("invalid_input", "contractVersion", "Benchmark policy contract version is unsupported"));
  }
  if (!isIdentifier(input.projectId)) {
    issues.push(issue("invalid_input", "projectId", "Project id must be a canonical identifier"));
  }
  if (input.roomId !== null && !isIdentifier(input.roomId)) {
    issues.push(issue("invalid_input", "roomId", "Room id must be null or a canonical identifier"));
  }
  if (!isIdentifier(input.snapshotId)) {
    issues.push(issue("invalid_input", "snapshotId", "Snapshot id must be a canonical identifier"));
  }
  if (!isPositiveSafeInteger(input.catalogVersion)) {
    issues.push(issue("invalid_input", "catalogVersion", "Catalog version must be a positive safe integer"));
  }
  const asOfMs = parseCanonicalTimestamp(input.asOf, "asOf", issues);
  const baseline = parseTarget(input.baseline, "baseline", issues);
  const candidate = parseTarget(input.candidate, "candidate", issues);
  const plans = parsePlans(input.plans, issues);
  if (!Array.isArray(input.cases)) {
    issues.push(issue("invalid_input", "cases", "Benchmark cases must be an array"));
  }
  if (baseline && candidate && baseline.candidateVersionId === candidate.candidateVersionId) {
    issues.push(issue("invalid_input", "candidate", "Baseline and candidate must be distinct immutable versions"));
  }
  if (
    issues.length > 0
    || asOfMs === null
    || baseline === null
    || candidate === null
    || plans === null
    || !Array.isArray(input.cases)
  ) {
    return failure(issues);
  }

  const targetProducerActorIds = new Set([...baseline.producerActorIds, ...candidate.producerActorIds]);
  const caseIds = new Set<string>();
  const cases: RoomEvolutionBenchmarkCaseV1[] = [];
  for (const [index, value] of input.cases.entries()) {
    const parsed = parseCase(value, `cases[${index}]`, {
      projectId: input.projectId,
      roomId: input.roomId,
      asOfMs,
      targetProducerActorIds,
      caseIds,
    }, issues);
    if (parsed) cases.push(parsed);
  }
  if (issues.length > 0) return failure(issues);

  const selectedCases: RoomEvolutionSelectedBenchmarkCaseV1[] = [];
  for (const plan of plans) {
    const selection = selectCollectionCases(input.snapshotId, input.catalogVersion, plan, cases);
    if (selection.length < plan.minimumCases) {
      issues.push(issue(
        "insufficient_authorized_cases",
        `plans.${plan.collection}`,
        `Collection ${plan.collection} has ${selection.length} authorized cases but requires ${plan.minimumCases}`,
      ));
      continue;
    }
    selectedCases.push(...selection);
  }
  if (issues.length > 0) return failure(issues);
  if (selectedCases.length > MAX_CASES_PER_SNAPSHOT) {
    return failure([issue("invalid_input", "plans", "Benchmark snapshot exceeds the maximum authorized case count")]);
  }

  const immutableSelectedCases = Object.freeze(selectedCases.map((entry) => Object.freeze({ ...entry })));
  const snapshotHash = hashRoomValue({
    contractVersion: ROOM_EVOLUTION_BENCHMARK_POLICY_CONTRACT_VERSION,
    id: input.snapshotId,
    projectId: input.projectId,
    roomId: input.roomId,
    catalogVersion: input.catalogVersion,
    asOf: input.asOf,
    selectedCases: immutableSelectedCases,
  });
  const snapshot = Object.freeze({
    contractVersion: ROOM_EVOLUTION_BENCHMARK_POLICY_CONTRACT_VERSION,
    id: input.snapshotId,
    projectId: input.projectId,
    roomId: input.roomId,
    catalogVersion: input.catalogVersion,
    asOf: input.asOf,
    selectedCases: immutableSelectedCases,
    snapshotHash,
  });
  const baselineEvaluation = Object.freeze(bindEvaluation(baseline, snapshot));
  const candidateEvaluation = Object.freeze(bindEvaluation(candidate, snapshot));
  return success(Object.freeze({ snapshot, baselineEvaluation, candidateEvaluation }));
}

function parseTarget(
  value: unknown,
  path: string,
  issues: RoomEvolutionBenchmarkSelectionIssueV1[],
): RoomEvolutionBenchmarkEvaluationTargetV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, ["candidateVersionId", "immutableArtifactHash", "producerActorIds"])) {
    issues.push(issue("invalid_input", path, "Evaluation target must have the exact v1 shape"));
    return null;
  }
  const candidateVersionId = value.candidateVersionId;
  const immutableArtifactHash = value.immutableArtifactHash;
  const producerActorIdsValue = value.producerActorIds;
  if (!isIdentifier(candidateVersionId)) {
    issues.push(issue("invalid_input", `${path}.candidateVersionId`, "Candidate version id must be canonical"));
  }
  if (!isHash(immutableArtifactHash)) {
    issues.push(issue("invalid_input", `${path}.immutableArtifactHash`, "Candidate artifact hash must be SHA-256"));
  }
  const producerActorIds = parseUniqueIdentifiers(producerActorIdsValue, `${path}.producerActorIds`, issues, true);
  if (!isIdentifier(candidateVersionId) || !isHash(immutableArtifactHash) || producerActorIds === null) return null;
  return {
    candidateVersionId,
    immutableArtifactHash,
    producerActorIds,
  };
}

function parsePlans(
  value: unknown,
  issues: RoomEvolutionBenchmarkSelectionIssueV1[],
): readonly RoomEvolutionBenchmarkCollectionPlanV1[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > ROOM_EVOLUTION_BENCHMARK_COLLECTION_KINDS.length) {
    issues.push(issue("invalid_input", "plans", "Plans must contain between one and four collection plans"));
    return null;
  }
  const collections = new Set<string>();
  const plans: RoomEvolutionBenchmarkCollectionPlanV1[] = [];
  for (const [index, entry] of value.entries()) {
    const path = `plans[${index}]`;
    if (!isRecord(entry) || !hasExactKeys(entry, ["collection", "minimumCases", "maximumCases"])) {
      issues.push(issue("invalid_input", path, "Collection plan must have the exact v1 shape"));
      continue;
    }
    const collection = entry.collection;
    const minimumCases = entry.minimumCases;
    const maximumCases = entry.maximumCases;
    if (!isString(collection) || !COLLECTIONS.has(collection)) {
      issues.push(issue("invalid_input", `${path}.collection`, "Collection kind is unsupported"));
      continue;
    }
    if (collections.has(collection)) {
      issues.push(issue("duplicate_identifier", `${path}.collection`, "Collection plans must be unique"));
      continue;
    }
    collections.add(collection);
    if (!isNonNegativeSafeInteger(minimumCases) || !isPositiveSafeInteger(maximumCases)) {
      issues.push(issue("invalid_input", path, "Collection limits must be safe integers with a positive maximum"));
      continue;
    }
    if (minimumCases > maximumCases || maximumCases > MAX_CASES_PER_COLLECTION) {
      issues.push(issue("invalid_input", path, "Collection limits must be ordered and within the policy bound"));
      continue;
    }
    plans.push({
      collection: collection as RoomEvolutionBenchmarkCollectionKindV1,
      minimumCases,
      maximumCases,
    });
  }
  if (issues.length > 0) return null;
  return Object.freeze([...plans].sort((left, right) => collectionOrder(left.collection) - collectionOrder(right.collection)));
}

function parseCase(
  value: unknown,
  path: string,
  context: {
    readonly projectId: string;
    readonly roomId: string | null;
    readonly asOfMs: number;
    readonly targetProducerActorIds: ReadonlySet<string>;
    readonly caseIds: Set<string>;
  },
  issues: RoomEvolutionBenchmarkSelectionIssueV1[],
): RoomEvolutionBenchmarkCaseV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "contractVersion",
    "id",
    "version",
    "contentHash",
    "projectId",
    "roomId",
    "domain",
    "collection",
    "difficulty",
    "risk",
    "privacy",
    "source",
  ])) {
    issues.push(issue("invalid_input", path, "Benchmark case must have the exact v1 shape"));
    return null;
  }
  const contractVersion = value.contractVersion;
  const caseId = value.id;
  const version = value.version;
  const contentHash = value.contentHash;
  const projectId = value.projectId;
  const roomId = value.roomId;
  const domain = value.domain;
  const collectionValue = value.collection;
  const difficulty = value.difficulty;
  const riskValue = value.risk;
  const privacyValue = value.privacy;
  const sourceValue = value.source;
  if (contractVersion !== ROOM_EVOLUTION_BENCHMARK_POLICY_CONTRACT_VERSION) {
    issues.push(issue("invalid_input", `${path}.contractVersion`, "Benchmark case contract version is unsupported"));
  }
  if (!isIdentifier(caseId)) {
    issues.push(issue("invalid_input", `${path}.id`, "Benchmark case id must be canonical"));
  } else if (context.caseIds.has(caseId)) {
    issues.push(issue("duplicate_identifier", `${path}.id`, "Benchmark case ids must be unique within a snapshot"));
  } else {
    context.caseIds.add(caseId);
  }
  if (!isPositiveSafeInteger(version)) {
    issues.push(issue("invalid_input", `${path}.version`, "Benchmark case version must be a positive safe integer"));
  }
  if (!isHash(contentHash)) {
    issues.push(issue("invalid_input", `${path}.contentHash`, "Benchmark case content hash must be SHA-256"));
  }
  if (projectId !== context.projectId || roomId !== context.roomId) {
    issues.push(issue("scope_mismatch", path, "Benchmark case must match the requested Project and Room scope exactly"));
  }
  if (typeof domain !== "string" || domain.trim().length === 0 || domain.length > 128) {
    issues.push(issue("invalid_input", `${path}.domain`, "Benchmark domain must be a bounded nonblank string"));
  }
  if (!isString(collectionValue) || !COLLECTIONS.has(collectionValue)) {
    issues.push(issue("invalid_input", `${path}.collection`, "Benchmark collection is unsupported"));
  }
  if (!isDifficulty(difficulty)) {
    issues.push(issue("invalid_input", `${path}.difficulty`, "Benchmark difficulty must be an integer from zero to one hundred"));
  }
  const risk = parseRisk(riskValue, `${path}.risk`, context.asOfMs, issues);
  const privacy = parsePrivacy(privacyValue, `${path}.privacy`, context.asOfMs, issues);
  const source = parseSource(sourceValue, `${path}.source`, collectionValue, context.asOfMs, context.targetProducerActorIds, issues);
  if (
    contractVersion !== ROOM_EVOLUTION_BENCHMARK_POLICY_CONTRACT_VERSION
    || !isIdentifier(caseId)
    || !isPositiveSafeInteger(version)
    || !isHash(contentHash)
    || projectId !== context.projectId
    || roomId !== context.roomId
    || typeof domain !== "string"
    || domain.trim().length === 0
    || domain.length > 128
    || !isString(collectionValue)
    || !COLLECTIONS.has(collectionValue)
    || !isDifficulty(difficulty)
    || risk === null
    || privacy === null
    || source === null
  ) return null;
  return {
    contractVersion: ROOM_EVOLUTION_BENCHMARK_POLICY_CONTRACT_VERSION,
    id: caseId,
    version,
    contentHash,
    projectId: context.projectId,
    roomId: context.roomId,
    domain,
    collection: collectionValue as RoomEvolutionBenchmarkCollectionKindV1,
    difficulty,
    risk,
    privacy,
    source,
  };
}

function parseRisk(
  value: unknown,
  path: string,
  asOfMs: number,
  issues: RoomEvolutionBenchmarkSelectionIssueV1[],
): RoomEvolutionBenchmarkRiskV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, ["classification", "authorization"])) {
    issues.push(issue("invalid_input", path, "Risk must have the exact v1 shape"));
    return null;
  }
  const classification = value.classification;
  const authorizationValue = value.authorization;
  if (!isString(classification) || !RISK_CLASSIFICATIONS.has(classification)) {
    issues.push(issue("invalid_input", `${path}.classification`, "Risk classification is unsupported"));
  }
  const authorization = parseOptionalAuthorization(authorizationValue, `${path}.authorization`, asOfMs, issues);
  if ((classification === "high" || classification === "critical") && authorization === null) {
    issues.push(issue("unauthorized_high_risk_case", path, "High-risk benchmark data requires independent authorization"));
  }
  if (!isString(classification) || !RISK_CLASSIFICATIONS.has(classification) || authorization === undefined) return null;
  return {
    classification: classification as RoomEvolutionBenchmarkRiskClassificationV1,
    authorization,
  };
}

function parsePrivacy(
  value: unknown,
  path: string,
  asOfMs: number,
  issues: RoomEvolutionBenchmarkSelectionIssueV1[],
): RoomEvolutionBenchmarkPrivacyV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, ["containsPrivateData", "authorization"])) {
    issues.push(issue("invalid_input", path, "Privacy must have the exact v1 shape"));
    return null;
  }
  const containsPrivateData = value.containsPrivateData;
  const authorizationValue = value.authorization;
  if (typeof containsPrivateData !== "boolean") {
    issues.push(issue("invalid_input", `${path}.containsPrivateData`, "Privacy flag must be boolean"));
  }
  const authorization = parseOptionalAuthorization(authorizationValue, `${path}.authorization`, asOfMs, issues);
  if (containsPrivateData === true && authorization === null) {
    issues.push(issue("unauthorized_private_case", path, "Private benchmark data requires explicit authorization"));
  }
  if (typeof containsPrivateData !== "boolean" || authorization === undefined) return null;
  return { containsPrivateData, authorization };
}

function parseSource(
  value: unknown,
  path: string,
  collectionValue: unknown,
  asOfMs: number,
  targetProducerActorIds: ReadonlySet<string>,
  issues: RoomEvolutionBenchmarkSelectionIssueV1[],
): RoomEvolutionBenchmarkCaseSourceV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "kind",
    "reference",
    "evidenceHash",
    "inclusionAuthority",
    "authorActorId",
    "authorization",
  ])) {
    issues.push(issue("invalid_input", path, "Case source must have the exact v1 shape"));
    return null;
  }
  const sourceKind = value.kind;
  const reference = value.reference;
  const evidenceHash = value.evidenceHash;
  const inclusionAuthority = value.inclusionAuthority;
  const authorActorId = value.authorActorId;
  const authorizationValue = value.authorization;
  const collection = isString(collectionValue) && COLLECTIONS.has(collectionValue)
    ? collectionValue as RoomEvolutionBenchmarkCollectionKindV1
    : null;
  const hasAuthorizedSource = collection !== null
    && sourceKind === SOURCE_KIND_BY_COLLECTION[collection]
    && isString(inclusionAuthority)
    && AUTHORITIES_BY_COLLECTION[collection].includes(inclusionAuthority as RoomEvolutionBenchmarkInclusionAuthorityV1);
  if (!hasAuthorizedSource) {
    issues.push(issue("unauthorized_case_source", path, "Benchmark source must be independent and authorized for its collection"));
  }
  if (isIdentifier(authorActorId) && targetProducerActorIds.has(authorActorId)) {
    issues.push(issue("self_enrollment_forbidden", `${path}.authorActorId`, "Evaluation target producers cannot add benchmark cases"));
  }
  if (typeof reference !== "string" || reference.trim().length === 0 || reference.length > 256) {
    issues.push(issue("invalid_input", `${path}.reference`, "Source reference must be a bounded nonblank string"));
  }
  if (!isHash(evidenceHash)) {
    issues.push(issue("invalid_input", `${path}.evidenceHash`, "Source evidence hash must be SHA-256"));
  }
  if (!isIdentifier(authorActorId)) {
    issues.push(issue("invalid_input", `${path}.authorActorId`, "Source author actor id must be canonical"));
  }
  const authorization = parseOptionalAuthorization(authorizationValue, `${path}.authorization`, asOfMs, issues);
  if (collection === "authorized_historical_replay" && authorization === null) {
    issues.push(issue("unauthorized_historical_replay", path, "Historical replay requires a source authorization"));
  }
  if (
    !hasAuthorizedSource
    || !isIdentifier(authorActorId)
    || targetProducerActorIds.has(authorActorId)
    || typeof reference !== "string"
    || reference.trim().length === 0
    || reference.length > 256
    || !isHash(evidenceHash)
    || authorization === undefined
    || (collection === "authorized_historical_replay" && authorization === null)
  ) return null;
  return {
    kind: sourceKind as RoomEvolutionBenchmarkSourceKindV1,
    reference,
    evidenceHash,
    inclusionAuthority: inclusionAuthority as RoomEvolutionBenchmarkInclusionAuthorityV1,
    authorActorId,
    authorization,
  };
}

function parseOptionalAuthorization(
  value: unknown,
  path: string,
  asOfMs: number,
  issues: RoomEvolutionBenchmarkSelectionIssueV1[],
): RoomEvolutionBenchmarkAuthorizationV1 | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, ["id", "evidenceHash", "grantedByActorId", "grantedAt"])) {
    issues.push(issue("invalid_input", path, "Authorization must be null or have the exact v1 shape"));
    return undefined;
  }
  const id = value.id;
  const evidenceHash = value.evidenceHash;
  const grantedByActorId = value.grantedByActorId;
  const grantedAtValue = value.grantedAt;
  if (!isIdentifier(id)) {
    issues.push(issue("invalid_input", `${path}.id`, "Authorization id must be canonical"));
  }
  if (!isHash(evidenceHash)) {
    issues.push(issue("invalid_input", `${path}.evidenceHash`, "Authorization evidence hash must be SHA-256"));
  }
  if (!isIdentifier(grantedByActorId)) {
    issues.push(issue("invalid_input", `${path}.grantedByActorId`, "Authorization grantor actor id must be canonical"));
  }
  const grantedAt = parseCanonicalTimestamp(grantedAtValue, `${path}.grantedAt`, issues);
  if (grantedAt !== null && grantedAt > asOfMs) {
    issues.push(issue("invalid_timestamp", `${path}.grantedAt`, "Authorization cannot be granted after the snapshot time"));
  }
  if (!isIdentifier(id) || !isHash(evidenceHash) || !isIdentifier(grantedByActorId) || !isString(grantedAtValue) || grantedAt === null || grantedAt > asOfMs) {
    return undefined;
  }
  return {
    id,
    evidenceHash,
    grantedByActorId,
    grantedAt: grantedAtValue,
  };
}

function selectCollectionCases(
  snapshotId: string,
  catalogVersion: number,
  plan: RoomEvolutionBenchmarkCollectionPlanV1,
  cases: readonly RoomEvolutionBenchmarkCaseV1[],
): readonly RoomEvolutionSelectedBenchmarkCaseV1[] {
  const eligible = cases.filter((entry) => entry.collection === plan.collection);
  eligible.sort((left, right) => compareCaseSelection(snapshotId, catalogVersion, plan.collection, left, right));
  return eligible.slice(0, plan.maximumCases).map((entry) => ({
    id: entry.id,
    version: entry.version,
    contentHash: entry.contentHash,
    domain: entry.domain,
    collection: entry.collection,
    riskClassification: entry.risk.classification,
    sourceKind: entry.source.kind,
  }));
}

function compareCaseSelection(
  snapshotId: string,
  catalogVersion: number,
  collection: RoomEvolutionBenchmarkCollectionKindV1,
  left: RoomEvolutionBenchmarkCaseV1,
  right: RoomEvolutionBenchmarkCaseV1,
): number {
  if (collection === "rolling_difficult" && left.difficulty !== right.difficulty) {
    return right.difficulty - left.difficulty;
  }
  const leftRank = selectionRank(snapshotId, catalogVersion, left);
  const rightRank = selectionRank(snapshotId, catalogVersion, right);
  return leftRank.localeCompare(rightRank) || left.id.localeCompare(right.id) || left.version - right.version;
}

function selectionRank(snapshotId: string, catalogVersion: number, entry: RoomEvolutionBenchmarkCaseV1): string {
  return hashRoomValue({
    snapshotId,
    catalogVersion,
    collection: entry.collection,
    id: entry.id,
    version: entry.version,
    contentHash: entry.contentHash,
  });
}

function bindEvaluation(
  target: RoomEvolutionBenchmarkEvaluationTargetV1,
  snapshot: RoomEvolutionBenchmarkSnapshotV1,
): RoomEvolutionBenchmarkEvaluationBindingV1 {
  return {
    candidateVersionId: target.candidateVersionId,
    immutableArtifactHash: target.immutableArtifactHash,
    benchmarkSnapshotId: snapshot.id,
    benchmarkSnapshotHash: snapshot.snapshotHash,
  };
}

function collectionOrder(collection: RoomEvolutionBenchmarkCollectionKindV1): number {
  return ROOM_EVOLUTION_BENCHMARK_COLLECTION_KINDS.indexOf(collection);
}

function parseUniqueIdentifiers(
  value: unknown,
  path: string,
  issues: RoomEvolutionBenchmarkSelectionIssueV1[],
  requireAtLeastOne: boolean,
): readonly string[] | null {
  if (!Array.isArray(value) || (requireAtLeastOne && value.length === 0)) {
    issues.push(issue("invalid_input", path, "Actor ids must be a nonempty array"));
    return null;
  }
  const ids = new Set<string>();
  for (const [index, id] of value.entries()) {
    if (!isIdentifier(id)) {
      issues.push(issue("invalid_input", `${path}[${index}]`, "Actor id must be canonical"));
      continue;
    }
    if (ids.has(id)) {
      issues.push(issue("duplicate_identifier", `${path}[${index}]`, "Actor ids must be unique"));
      continue;
    }
    ids.add(id);
  }
  return issues.some((entry) => entry.path === path || entry.path.startsWith(`${path}[`)) ? null : Object.freeze([...ids].sort());
}

function parseCanonicalTimestamp(
  value: unknown,
  path: string,
  issues: RoomEvolutionBenchmarkSelectionIssueV1[],
): number | null {
  if (typeof value !== "string" || value.length === 0) {
    issues.push(issue("invalid_timestamp", path, "Timestamp must be an ISO-8601 UTC string"));
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    issues.push(issue("invalid_timestamp", path, "Timestamp must be canonical UTC ISO-8601"));
    return null;
  }
  return timestamp;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && HASH.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isDifficulty(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value <= 100;
}

function issue(
  code: RoomEvolutionBenchmarkSelectionIssueCodeV1,
  path: string,
  message: string,
): RoomEvolutionBenchmarkSelectionIssueV1 {
  return { code, path, message };
}

function success(value: RoomEvolutionBenchmarkSelectionV1): SelectAuthorizedRoomEvolutionBenchmarkSnapshotResultV1 {
  return { ok: true, value };
}

function failure(issues: readonly RoomEvolutionBenchmarkSelectionIssueV1[]): SelectAuthorizedRoomEvolutionBenchmarkSnapshotResultV1 {
  return { ok: false, issues: Object.freeze([...issues]) };
}

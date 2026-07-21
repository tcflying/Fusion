import type {
  RoomConfidenceDimensionName,
  RoomEvidenceKind,
  RoomGateKind,
} from "./room-contracts/evidence.js";

export const ROOM_EVALUATION_PROFILE_CONTRACT_VERSION = 1 as const;

export const ROOM_EVALUATION_DOMAINS = [
  "code",
  "diagnosis",
  "research",
  "documents",
  "creative_work",
  "external_automation",
] as const;

export type RoomEvaluationDomain = (typeof ROOM_EVALUATION_DOMAINS)[number];

export interface RoomEvaluationEvidenceRequirementV1 {
  readonly kind: RoomEvidenceKind;
  readonly purpose: string;
}

export interface RoomEvaluationHardGateV1 {
  readonly id: string;
  readonly kind: RoomGateKind;
  readonly requiredEvidenceKinds: readonly RoomEvidenceKind[];
  readonly purpose: string;
}

export interface RoomEvaluationIndependentReviewPolicyV1 {
  readonly required: true;
  readonly minimumAcceptingReviews: number;
  readonly reviewerMustDifferFromProducer: true;
  readonly blindWhenComparingCandidates: true;
}

export interface RoomEvaluationSafeguardV1 {
  readonly id: string;
  readonly kind: "risk" | "anti_cheat";
  readonly constraint: string;
  readonly requiredEvidenceKinds: readonly RoomEvidenceKind[];
}

export interface RoomEvaluationModelSelfReportPolicyV1 {
  readonly authoritative: false;
  readonly canSatisfyHardGate: false;
  readonly canRaiseConfidence: false;
}

export interface RoomEvaluationProfileV1 {
  readonly contractVersion: typeof ROOM_EVALUATION_PROFILE_CONTRACT_VERSION;
  readonly id: string;
  readonly domain: RoomEvaluationDomain;
  readonly requiredEvidenceKinds: readonly RoomEvidenceKind[];
  readonly evidenceRequirements: readonly RoomEvaluationEvidenceRequirementV1[];
  readonly hardGates: readonly RoomEvaluationHardGateV1[];
  readonly independentReview: RoomEvaluationIndependentReviewPolicyV1;
  readonly safeguards: readonly RoomEvaluationSafeguardV1[];
  readonly recommendedConfidenceDimensions: readonly RoomConfidenceDimensionName[];
  readonly modelSelfReportPolicy: RoomEvaluationModelSelfReportPolicyV1;
  readonly preservesSharedEvidenceAndDissentContract: true;
}

export interface RoomEvaluationProfileResolutionInputV1 {
  readonly contractVersion: typeof ROOM_EVALUATION_PROFILE_CONTRACT_VERSION;
  readonly domain: RoomEvaluationDomain;
}

const ALL_CONFIDENCE_DIMENSIONS: readonly RoomConfidenceDimensionName[] = [
  "evidence_coverage",
  "evidence_quality",
  "validation_strength",
  "independent_agreement",
  "unresolved_dissent",
  "historical_calibration",
  "freshness",
];

const MODEL_SELF_REPORT_POLICY: RoomEvaluationModelSelfReportPolicyV1 = {
  authoritative: false,
  canSatisfyHardGate: false,
  canRaiseConfidence: false,
};

const PROFILE_BY_DOMAIN: Readonly<Record<RoomEvaluationDomain, RoomEvaluationProfileV1>> = deepFreeze({
  code: profile({
    id: "room-evaluation:code:v1",
    domain: "code",
    requiredEvidenceKinds: ["user_constraint", "source", "schema", "test", "runtime", "review"],
    evidenceRequirements: [
      requirement("user_constraint", "Locks the requested behavior, scope, and prohibited changes."),
      requirement("source", "Pins the changed source revision and dependency baseline."),
      requirement("schema", "Records static type, schema, or interface validation."),
      requirement("test", "Records exact automated test command, exit status, and output artifact."),
      requirement("runtime", "Records target-environment execution or integration behavior."),
      requirement("review", "Records an independent review tied to candidate evidence."),
    ],
    hardGates: [
      gate("code-user-constraints", "user_constraint", ["user_constraint"], "User-locked scope and safety constraints pass."),
      gate("code-schema", "schema", ["schema", "source"], "Static contracts and migration shape are valid."),
      gate("code-tests", "test", ["test", "source"], "Relevant deterministic tests pass from recorded command output."),
      gate("code-runtime", "runtime", ["runtime", "test"], "The candidate works in the declared target runtime."),
    ],
    independentReview: reviewPolicy(1),
    safeguards: [
      safeguard("scope-regression", "risk", "Regression-sensitive changes require evidence from the affected boundary.", ["source", "test"]),
      safeguard("no-passing-claim-without-command", "anti_cheat", "A model assertion cannot substitute for the exact test command, exit status, and log artifact.", ["test"]),
      safeguard("no-self-acceptance", "anti_cheat", "The producing binding cannot be the accepting reviewer or sole promotion authority.", ["review"]),
    ],
    recommendedConfidenceDimensions: ALL_CONFIDENCE_DIMENSIONS,
  }),
  diagnosis: profile({
    id: "room-evaluation:diagnosis:v1",
    domain: "diagnosis",
    requiredEvidenceKinds: ["user_constraint", "source", "runtime", "test", "review"],
    evidenceRequirements: [
      requirement("user_constraint", "Locks the observed failure boundary and recovery constraints."),
      requirement("source", "Pins logs, traces, configuration, and source revision used for causal claims."),
      requirement("runtime", "Records reproduction and post-fix behavior in the affected environment."),
      requirement("test", "Records a minimal regression or reproduction test where one is feasible."),
      requirement("review", "Records an independent challenge of the claimed root cause."),
    ],
    hardGates: [
      gate("diagnosis-user-constraints", "user_constraint", ["user_constraint"], "Recovery honors the declared safety and scope boundary."),
      gate("diagnosis-causal-evidence", "source", ["source", "runtime"], "The root-cause claim is traceable to retained diagnostic evidence."),
      gate("diagnosis-reproduction", "runtime", ["runtime"], "The failure is reproduced or its non-reproducibility is evidenced."),
      gate("diagnosis-regression", "test", ["test", "source"], "The repair prevents the proven failure mode where automation is feasible."),
    ],
    independentReview: reviewPolicy(1),
    safeguards: [
      safeguard("correlation-is-not-causation", "risk", "Temporal correlation alone cannot close a causal diagnosis.", ["source", "runtime"]),
      safeguard("no-log-cherry-picking", "anti_cheat", "The diagnosis must retain the source log or trace range, not only a model summary.", ["source"]),
      safeguard("no-self-confirmed-root-cause", "anti_cheat", "The producer cannot make its own root-cause assertion the accepting review.", ["review"]),
    ],
    recommendedConfidenceDimensions: ALL_CONFIDENCE_DIMENSIONS,
  }),
  research: profile({
    id: "room-evaluation:research:v1",
    domain: "research",
    requiredEvidenceKinds: ["user_constraint", "source", "artifact", "review"],
    evidenceRequirements: [
      requirement("user_constraint", "Locks the question, jurisdiction, time boundary, and citation standard."),
      requirement("source", "Preserves authoritative sources, capture times, versions, and collection methods."),
      requirement("artifact", "Preserves the report, source map, or reproducible data extraction."),
      requirement("review", "Records an independent citation and claim-coverage review."),
    ],
    hardGates: [
      gate("research-user-constraints", "user_constraint", ["user_constraint"], "The report stays inside its locked question and time boundary."),
      gate("research-source-authority", "source", ["source"], "Decisive claims have retained authoritative sources and exact version or hash."),
      gate("research-citation-validity", "policy", ["source", "artifact"], "Citations support the asserted claim rather than a nearby inference."),
      gate("research-freshness", "source", ["source"], "Time-sensitive claims use evidence within their declared freshness boundary."),
    ],
    independentReview: reviewPolicy(2),
    safeguards: [
      safeguard("authority-and-freshness", "risk", "Low-authority or stale sources cannot be hidden behind aggregate agreement.", ["source"]),
      safeguard("no-citation-laundering", "anti_cheat", "A generated citation or secondary summary cannot replace the retained primary source for a decisive claim.", ["source"]),
      safeguard("no-unsupported-synthesis", "anti_cheat", "Interpretation beyond the sources must be labeled and independently reviewed.", ["source", "review"]),
    ],
    recommendedConfidenceDimensions: ALL_CONFIDENCE_DIMENSIONS,
  }),
  documents: profile({
    id: "room-evaluation:documents:v1",
    domain: "documents",
    requiredEvidenceKinds: ["user_constraint", "source", "schema", "artifact", "review"],
    evidenceRequirements: [
      requirement("user_constraint", "Locks audience, format, required sections, and forbidden claims."),
      requirement("source", "Preserves source material used for factual or contractual statements."),
      requirement("schema", "Records template, structure, or machine-readable document validation."),
      requirement("artifact", "Preserves the rendered document and source representation."),
      requirement("review", "Records independent completeness, fidelity, and usability review."),
    ],
    hardGates: [
      gate("document-user-constraints", "user_constraint", ["user_constraint"], "Required audience, format, and locked sections are satisfied."),
      gate("document-source-fidelity", "source", ["source", "artifact"], "Factual and contractual statements remain traceable to retained sources."),
      gate("document-structure", "schema", ["schema", "artifact"], "The output passes the declared structural or template contract."),
      gate("document-policy", "policy", ["user_constraint", "artifact"], "Policy, confidentiality, and publication constraints pass."),
    ],
    independentReview: reviewPolicy(1),
    safeguards: [
      safeguard("audience-harm", "risk", "A technically valid document still fails if it omits a reader-critical limitation or instruction.", ["user_constraint", "review"]),
      safeguard("no-source-invention", "anti_cheat", "Generated prose cannot invent citations, approvals, quotations, or document sections.", ["source", "artifact"]),
      safeguard("no-self-approval", "anti_cheat", "The document producer cannot be its only fidelity reviewer.", ["review"]),
    ],
    recommendedConfidenceDimensions: ALL_CONFIDENCE_DIMENSIONS,
  }),
  creative_work: profile({
    id: "room-evaluation:creative-work:v1",
    domain: "creative_work",
    requiredEvidenceKinds: ["user_constraint", "source", "artifact", "review"],
    evidenceRequirements: [
      requirement("user_constraint", "Locks brief, format, audience, narrative contract, and prohibited content."),
      requirement("source", "Pins authorized story bible, prior continuity, or licensed reference constraints."),
      requirement("artifact", "Preserves the complete candidate work rather than an outline-only substitute."),
      requirement("review", "Records independent review of continuity, payoff, craft, and audience fit."),
    ],
    hardGates: [
      gate("creative-user-constraints", "user_constraint", ["user_constraint", "artifact"], "The complete work fulfills locked brief, format, and safety constraints."),
      gate("creative-continuity", "source", ["source", "artifact"], "Character, world, and prior-story commitments remain consistent with authorized context."),
      gate("creative-policy", "policy", ["user_constraint", "artifact"], "Content, licensing, and prohibited-material rules pass."),
    ],
    independentReview: reviewPolicy(2),
    safeguards: [
      safeguard("continuity-and-reader-impact", "risk", "Narrative quality must consider causality, character consistency, payoff, and reader impact together.", ["source", "artifact", "review"]),
      safeguard("no-summary-substitution", "anti_cheat", "An outline, recap, or self-evaluation cannot substitute for the requested finished creative artifact.", ["artifact"]),
      safeguard("no-producer-only-taste", "anti_cheat", "The producer's own taste judgment cannot be the only quality acceptance signal.", ["review"]),
    ],
    recommendedConfidenceDimensions: ALL_CONFIDENCE_DIMENSIONS,
  }),
  external_automation: profile({
    id: "room-evaluation:external-automation:v1",
    domain: "external_automation",
    requiredEvidenceKinds: ["user_constraint", "policy", "source", "test", "runtime", "artifact", "review"],
    evidenceRequirements: [
      requirement("user_constraint", "Locks authority, target systems, permitted side effects, and rollback boundary."),
      requirement("policy", "Preserves authorization, privacy, and safety policy evidence."),
      requirement("source", "Pins target configuration, runbook, input version, and connector state."),
      requirement("test", "Records dry-run or isolated validation command and exact result."),
      requirement("runtime", "Records verified execution state and target-system response."),
      requirement("artifact", "Preserves run log, output, receipt, and rollback artifact where applicable."),
      requirement("review", "Records independent review of authority, side effects, and observed outcome."),
    ],
    hardGates: [
      gate("automation-authorization", "user_constraint", ["user_constraint", "policy"], "The actor, target, and side effect are explicitly authorized."),
      gate("automation-policy", "policy", ["policy", "source"], "Privacy, security, and system-specific policies pass before execution."),
      gate("automation-dry-run", "test", ["test", "source"], "The declared dry-run or isolated validation passes before live effects."),
      gate("automation-runtime-receipt", "runtime", ["runtime", "artifact"], "The target-system outcome and any rollback state are evidenced."),
    ],
    independentReview: reviewPolicy(2),
    safeguards: [
      safeguard("irreversible-side-effects", "risk", "High-impact or irreversible actions require explicit authority, receipt, and recovery evidence.", ["user_constraint", "policy", "runtime", "artifact"]),
      safeguard("no-simulated-success", "anti_cheat", "A claimed external success cannot rely on generated text, mock output, or an unverified local response.", ["runtime", "artifact"]),
      safeguard("no-authority-bypass", "anti_cheat", "A model cannot broaden target scope, credentials, or side effects through self-authored instructions.", ["user_constraint", "policy"]),
    ],
    recommendedConfidenceDimensions: ALL_CONFIDENCE_DIMENSIONS,
  }),
});

export function getRoomEvaluationProfile(domain: RoomEvaluationDomain): RoomEvaluationProfileV1 {
  return resolveRoomEvaluationProfile({
    contractVersion: ROOM_EVALUATION_PROFILE_CONTRACT_VERSION,
    domain,
  });
}

export function resolveRoomEvaluationProfile(input: unknown): RoomEvaluationProfileV1 {
  const resolution = normalizeResolutionInput(input);
  return immutableCopy(PROFILE_BY_DOMAIN[resolution.domain]);
}

function profile(input: Omit<
  RoomEvaluationProfileV1,
  "contractVersion" | "modelSelfReportPolicy" | "preservesSharedEvidenceAndDissentContract"
>): RoomEvaluationProfileV1 {
  return {
    contractVersion: ROOM_EVALUATION_PROFILE_CONTRACT_VERSION,
    ...input,
    modelSelfReportPolicy: MODEL_SELF_REPORT_POLICY,
    preservesSharedEvidenceAndDissentContract: true,
  };
}

function requirement(kind: RoomEvidenceKind, purpose: string): RoomEvaluationEvidenceRequirementV1 {
  return { kind, purpose };
}

function gate(
  id: string,
  kind: RoomGateKind,
  requiredEvidenceKinds: readonly RoomEvidenceKind[],
  purpose: string,
): RoomEvaluationHardGateV1 {
  return { id, kind, requiredEvidenceKinds, purpose };
}

function reviewPolicy(minimumAcceptingReviews: number): RoomEvaluationIndependentReviewPolicyV1 {
  return {
    required: true,
    minimumAcceptingReviews,
    reviewerMustDifferFromProducer: true,
    blindWhenComparingCandidates: true,
  };
}

function safeguard(
  id: string,
  kind: RoomEvaluationSafeguardV1["kind"],
  constraint: string,
  requiredEvidenceKinds: readonly RoomEvidenceKind[],
): RoomEvaluationSafeguardV1 {
  return { id, kind, constraint, requiredEvidenceKinds };
}

function normalizeResolutionInput(input: unknown): RoomEvaluationProfileResolutionInputV1 {
  if (!isPlainRecord(input)) {
    throw new Error("Room evaluation profile resolution input must be a plain record");
  }
  const expectedKeys = ["contractVersion", "domain"];
  const actualKeys = Object.keys(input).sort();
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new Error("Room evaluation profile resolution input has unknown, missing, or mutable-only fields");
  }
  if (input.contractVersion !== ROOM_EVALUATION_PROFILE_CONTRACT_VERSION) {
    throw new Error("Room evaluation profile contract version is unsupported");
  }
  if (typeof input.domain !== "string" || !ROOM_EVALUATION_DOMAINS.includes(input.domain as RoomEvaluationDomain)) {
    throw new Error("Room evaluation profile domain is unsupported");
  }
  return {
    contractVersion: ROOM_EVALUATION_PROFILE_CONTRACT_VERSION,
    domain: input.domain as RoomEvaluationDomain,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function immutableCopy<TValue>(value: TValue): TValue {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<TValue>(value: TValue, seen = new WeakSet<object>()): TValue {
  if (typeof value !== "object" || value === null) return value;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const nestedValue of Object.values(value)) deepFreeze(nestedValue, seen);
  return Object.freeze(value);
}

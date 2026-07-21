import styles from "./RoomCockpitEvidencePanel.module.css";

const ROOM_COCKPIT_EVIDENCE_AVAILABILITY = ["available", "withheld", "unavailable"] as const;
const ROOM_COCKPIT_HARD_GATE_STATES = ["passed", "failed", "withheld", "unavailable"] as const;
const ROOM_COCKPIT_REVIEW_STATES = ["consensus", "dissent_open", "arbitrated", "withheld", "unavailable"] as const;
const ROOM_COCKPIT_ARBITRATION_STATES = ["not_required", "pending", "resolved", "withheld", "unavailable"] as const;
const ROOM_COCKPIT_DECISION_STATES = [
  "pending",
  "promoted",
  "rejected",
  "rollback_required",
  "inconclusive",
  "withheld",
  "unavailable",
] as const;
const ROOM_COCKPIT_CANARY_STATES = ["not_started", "running", "passed", "failed", "withheld", "unavailable"] as const;
const ROOM_COCKPIT_PROMOTION_STATES = [
  "not_evaluated",
  "promoted",
  "rejected",
  "rollback_required",
  "inconclusive",
  "withheld",
  "unavailable",
] as const;
const ROOM_COCKPIT_ROLLBACK_STATES = ["not_required", "armed", "completed", "withheld", "unavailable"] as const;
const ROOM_COCKPIT_AUTHORITY_TIERS = ["automatic_pre_authorized", "independent", "human"] as const;

const SHA256_HASH = /^sha256:[a-f0-9]{64}$/;
const MAX_IDENTIFIER_LENGTH = 160;
const MAX_TEXT_LENGTH = 2_000;
const MAX_REFERENCE_COUNT = 50;

export type RoomCockpitEvidenceAvailabilityV1 = (typeof ROOM_COCKPIT_EVIDENCE_AVAILABILITY)[number];
export type RoomCockpitHardGateStateV1 = (typeof ROOM_COCKPIT_HARD_GATE_STATES)[number];
export type RoomCockpitReviewStateV1 = (typeof ROOM_COCKPIT_REVIEW_STATES)[number];
export type RoomCockpitArbitrationStateV1 = (typeof ROOM_COCKPIT_ARBITRATION_STATES)[number];
export type RoomCockpitDecisionStateV1 = (typeof ROOM_COCKPIT_DECISION_STATES)[number];
export type RoomCockpitCanaryStateV1 = (typeof ROOM_COCKPIT_CANARY_STATES)[number];
export type RoomCockpitPromotionStateV1 = (typeof ROOM_COCKPIT_PROMOTION_STATES)[number];
export type RoomCockpitRollbackStateV1 = (typeof ROOM_COCKPIT_ROLLBACK_STATES)[number];
export type RoomCockpitAuthorityTierV1 = (typeof ROOM_COCKPIT_AUTHORITY_TIERS)[number];

export interface RoomCockpitCandidateEvidenceV1 {
  readonly candidateId: string;
  readonly candidateHash: string;
  readonly candidateVersionId: string;
  readonly baseVersionId: string | null;
  readonly intentSummary: string;
  readonly diffSummary: string;
  readonly evidenceIds: readonly string[];
}

export interface RoomCockpitHardGateEvidenceV1 {
  readonly gateId: string;
  readonly state: RoomCockpitHardGateStateV1;
  readonly summary: string;
  readonly evidenceIds: readonly string[];
}

export interface RoomCockpitArbitrationEvidenceV1 {
  readonly status: RoomCockpitArbitrationStateV1;
  readonly summary: string | null;
  readonly evidenceIds: readonly string[];
}

export interface RoomCockpitDecisionEvidenceV1 {
  readonly status: RoomCockpitDecisionStateV1;
  readonly authorityTier: RoomCockpitAuthorityTierV1 | null;
  readonly decisionId: string | null;
  readonly summary: string | null;
  readonly evidenceIds: readonly string[];
}

export interface RoomCockpitIndependentAssessmentV1 {
  readonly status: RoomCockpitReviewStateV1;
  readonly reviewerCount: number | null;
  readonly dissentSummary: string | null;
  readonly arbitration: RoomCockpitArbitrationEvidenceV1 | null;
  readonly decision: RoomCockpitDecisionEvidenceV1 | null;
  readonly evidenceIds: readonly string[];
}

export interface RoomCockpitCanaryEvidenceV1 {
  readonly status: RoomCockpitCanaryStateV1;
  readonly canaryId: string | null;
  readonly summary: string | null;
  readonly evidenceIds: readonly string[];
}

export interface RoomCockpitPromotionEvidenceV1 {
  readonly status: RoomCockpitPromotionStateV1;
  readonly decisionId: string | null;
  readonly authorityTier: RoomCockpitAuthorityTierV1 | null;
  readonly summary: string | null;
  readonly evidenceIds: readonly string[];
}

export interface RoomCockpitRollbackEvidenceV1 {
  readonly status: RoomCockpitRollbackStateV1;
  readonly rollbackId: string | null;
  readonly targetVersionId: string | null;
  readonly summary: string | null;
  readonly evidenceIds: readonly string[];
}

export interface RoomCockpitEvidenceAvailableEnvelopeV1 {
  readonly availability: "available";
  readonly candidate: RoomCockpitCandidateEvidenceV1;
  readonly hardGates: readonly RoomCockpitHardGateEvidenceV1[];
  readonly independentAssessment: RoomCockpitIndependentAssessmentV1;
  readonly canary: RoomCockpitCanaryEvidenceV1;
  readonly promotion: RoomCockpitPromotionEvidenceV1;
  readonly rollback: RoomCockpitRollbackEvidenceV1;
}

export interface RoomCockpitEvidenceWithheldEnvelopeV1 {
  readonly availability: "withheld";
  readonly reason: string;
  readonly referenceId: string | null;
}

export interface RoomCockpitEvidenceUnavailableEnvelopeV1 {
  readonly availability: "unavailable";
  readonly reason: string;
  readonly referenceId: string | null;
}

export type RoomCockpitEvidencePanelEnvelopeV1 =
  | RoomCockpitEvidenceAvailableEnvelopeV1
  | RoomCockpitEvidenceWithheldEnvelopeV1
  | RoomCockpitEvidenceUnavailableEnvelopeV1;

export interface RoomCockpitEvidencePanelProps {
  /**
   * FNXC:RoomCockpitEvidence 2026-07-19-16:25:
   * Evidence reaches the cockpit through independently evolving read models, so this
   * boundary intentionally accepts unknown input and exposes only a validated,
   * read-only candidate ledger. It must never turn telemetry into an approval path.
   */
  readonly evidence?: unknown;
  readonly className?: string;
}

type UnknownRecord = Record<string, unknown>;

/**
 * Parses the external cockpit projection boundary before any candidate metadata
 * becomes visible. A null result means the payload cannot be treated as evidence.
 */
export function parseRoomCockpitEvidencePanelEnvelope(value: unknown): RoomCockpitEvidencePanelEnvelopeV1 | null {
  const record = asRecord(value);
  if (!record) return null;

  const availability = readEnum(record.availability, ROOM_COCKPIT_EVIDENCE_AVAILABILITY);
  if (!availability) return null;

  if (availability === "withheld" || availability === "unavailable") {
    const reason = readText(record.reason);
    const referenceId = record.referenceId === undefined ? null : readNullableIdentifier(record.referenceId);
    if (!reason || referenceId === undefined) return null;
    return { availability, reason, referenceId };
  }

  const candidate = parseCandidate(record.candidate);
  const hardGates = parseHardGates(record.hardGates);
  const independentAssessment = parseIndependentAssessment(record.independentAssessment);
  const canary = parseCanary(record.canary);
  const promotion = parsePromotion(record.promotion);
  const rollback = parseRollback(record.rollback);

  if (!candidate || !hardGates || !independentAssessment || !canary || !promotion || !rollback) {
    return null;
  }

  if (!hasConsistentPromotionLineage({ hardGates, independentAssessment, canary, promotion, rollback })) {
    return null;
  }

  return {
    availability,
    candidate,
    hardGates,
    independentAssessment,
    canary,
    promotion,
    rollback,
  };
}

export function RoomCockpitEvidencePanel({ evidence, className }: RoomCockpitEvidencePanelProps) {
  if (evidence === undefined || evidence === null) {
    return <EvidenceAvailabilityState
      availability="unavailable"
      reason="No verified candidate evidence packet has been projected for this Room."
      className={className}
    />;
  }

  const parsed = parseRoomCockpitEvidencePanelEnvelope(evidence);
  if (!parsed) {
    return <EvidenceAvailabilityState
      availability="withheld"
      reason="The candidate ledger failed contract validation, so no candidate, gate, or approval state is rendered."
      className={className}
      invalid
    />;
  }

  if (parsed.availability !== "available") {
    return <EvidenceAvailabilityState {...parsed} className={className} />;
  }

  return <EvidenceLedger evidence={parsed} className={className} />;
}

function EvidenceLedger({
  evidence,
  className,
}: {
  readonly evidence: RoomCockpitEvidenceAvailableEnvelopeV1;
  readonly className?: string;
}) {
  /**
   * FNXC:RoomCockpitEvidence 2026-07-19-16:31:
   * The industrial evidence surface deliberately uses native disclosure controls
   * for keyboard access and reduced-motion safety. Every apparent state is a
   * recorded read model value, never an interactive approval affordance.
   */
  const review = evidence.independentAssessment;

  return (
    <section className={joinClassNames(styles.root, className)} aria-labelledby="room-cockpit-evidence-title">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Immutable candidate trace / read-only</p>
          <h2 id="room-cockpit-evidence-title">Candidate evidence ledger</h2>
          <p className={styles.headerDetail}>This view exposes recorded evidence and decision lineage; it cannot approve or promote a candidate.</p>
        </div>
        <span className={styles.verifiedStamp}>validated projection</span>
      </header>

      <section className={styles.identityRail} aria-labelledby="room-cockpit-candidate-identity-title">
        <div className={styles.sectionHeading}>
          <p className={styles.sectionKicker}>Candidate identity</p>
          <h3 id="room-cockpit-candidate-identity-title">Immutable version binding</h3>
        </div>
        <dl className={styles.identityFacts}>
          <div>
            <dt>Candidate</dt>
            <dd>{evidence.candidate.candidateId}</dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd>{evidence.candidate.candidateVersionId}</dd>
          </div>
          <div>
            <dt>Baseline</dt>
            <dd>{evidence.candidate.baseVersionId ?? "not recorded"}</dd>
          </div>
          <div className={styles.hashFact}>
            <dt>Content hash</dt>
            <dd><code>{evidence.candidate.candidateHash}</code></dd>
          </div>
        </dl>
      </section>

      <section className={styles.intentGrid} aria-label="Candidate intent and isolated diff">
        <article className={styles.textTrace}>
          <p className={styles.sectionKicker}>Intent</p>
          <p>{evidence.candidate.intentSummary}</p>
        </article>
        <article className={styles.textTrace}>
          <p className={styles.sectionKicker}>Isolated diff</p>
          <p>{evidence.candidate.diffSummary}</p>
        </article>
      </section>

      <section className={styles.gateSection} aria-labelledby="room-cockpit-gates-title">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.sectionKicker}>Hard-gate evidence</p>
            <h3 id="room-cockpit-gates-title">Verification boundaries</h3>
          </div>
          <span className={styles.countReadout}>{evidence.hardGates.length} recorded</span>
        </div>
        {evidence.hardGates.length > 0 ? (
          <ol className={styles.gateList}>
            {evidence.hardGates.map((gate) => (
              <li key={gate.gateId} data-state={gate.state}>
                <details open>
                  <summary>
                    <span className={styles.gateStatus}>{gate.state.replaceAll("_", " ")}</span>
                    <strong>{gate.gateId}</strong>
                    <span className={styles.expandHint}>inspect evidence</span>
                  </summary>
                  <p>{gate.summary}</p>
                  <EvidenceReferences ids={gate.evidenceIds} />
                </details>
              </li>
            ))}
          </ol>
        ) : <p className={styles.withheldInline}>No hard-gate evidence has been projected for this candidate.</p>}
      </section>

      <section className={styles.reviewSection} aria-labelledby="room-cockpit-independent-review-title">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.sectionKicker}>Independent review</p>
            <h3 id="room-cockpit-independent-review-title">Dissent, arbitration, and decision</h3>
          </div>
          <span className={styles.reviewState} data-state={review.status}>{review.status.replaceAll("_", " ")}</span>
        </div>
        <div className={styles.reviewGrid}>
          <TraceCell label="Independent reviewers" value={review.reviewerCount === null ? "withheld" : String(review.reviewerCount)} />
          <TraceCell label="Dissent" value={review.dissentSummary ?? review.status.replaceAll("_", " ")} detail={review.dissentSummary} />
          <TraceCell
            label="Arbitration"
            value={review.arbitration?.status.replaceAll("_", " ") ?? "not recorded"}
            detail={review.arbitration?.summary ?? null}
            evidenceIds={review.arbitration?.evidenceIds ?? []}
          />
          <TraceCell
            label="Independent decision"
            value={review.decision?.status.replaceAll("_", " ") ?? "not recorded"}
            detail={review.decision?.summary ?? null}
            evidenceIds={review.decision?.evidenceIds ?? []}
          />
        </div>
        <EvidenceReferences ids={review.evidenceIds} />
      </section>

      <section className={styles.lineageSection} aria-labelledby="room-cockpit-lineage-title">
        <div className={styles.sectionHeading}>
          <div>
            <p className={styles.sectionKicker}>Change lineage</p>
            <h3 id="room-cockpit-lineage-title">Canary to rollback boundary</h3>
          </div>
          <span className={styles.readOnlyLabel}>no execution controls</span>
        </div>
        <ol className={styles.lineageList}>
          <LineageEntry
            label="canary"
            state={evidence.canary.status}
            identifier={evidence.canary.canaryId}
            summary={evidence.canary.summary}
            evidenceIds={evidence.canary.evidenceIds}
          />
          <LineageEntry
            label="promotion"
            state={evidence.promotion.status}
            identifier={evidence.promotion.decisionId}
            summary={evidence.promotion.summary}
            evidenceIds={evidence.promotion.evidenceIds}
            authorityTier={evidence.promotion.authorityTier}
          />
          <LineageEntry
            label="rollback"
            state={evidence.rollback.status}
            identifier={evidence.rollback.rollbackId}
            summary={evidence.rollback.summary}
            evidenceIds={evidence.rollback.evidenceIds}
            targetVersionId={evidence.rollback.targetVersionId}
          />
        </ol>
      </section>

      <footer className={styles.footerTrace}>
        <span>Candidate evidence references</span>
        <EvidenceReferences ids={evidence.candidate.evidenceIds} />
      </footer>
    </section>
  );
}

function EvidenceAvailabilityState({
  availability,
  reason,
  referenceId = null,
  className,
  invalid = false,
}: {
  readonly availability: Exclude<RoomCockpitEvidenceAvailabilityV1, "available">;
  readonly reason: string;
  readonly referenceId?: string | null;
  readonly className?: string;
  readonly invalid?: boolean;
}) {
  const title = availability === "withheld" ? "Evidence withheld" : "Evidence unavailable";

  return (
    <section
      className={joinClassNames(styles.availabilityState, className)}
      data-availability={availability}
      role={invalid ? "alert" : "status"}
      aria-live="polite"
      aria-label={title}
    >
      <p className={styles.eyebrow}>Candidate evidence / {availability}</p>
      <h2>{title}</h2>
      <p>{reason}</p>
      {referenceId ? <code>{referenceId}</code> : null}
    </section>
  );
}

function TraceCell({
  label,
  value,
  detail = null,
  evidenceIds = [],
}: {
  readonly label: string;
  readonly value: string;
  readonly detail?: string | null;
  readonly evidenceIds?: readonly string[];
}) {
  return (
    <article className={styles.traceCell}>
      <p>{label}</p>
      <strong>{value}</strong>
      {detail && detail !== value ? <span>{detail}</span> : null}
      <EvidenceReferences ids={evidenceIds} />
    </article>
  );
}

function LineageEntry({
  label,
  state,
  identifier,
  summary,
  evidenceIds,
  authorityTier = null,
  targetVersionId = null,
}: {
  readonly label: "canary" | "promotion" | "rollback";
  readonly state: string;
  readonly identifier: string | null;
  readonly summary: string | null;
  readonly evidenceIds: readonly string[];
  readonly authorityTier?: RoomCockpitAuthorityTierV1 | null;
  readonly targetVersionId?: string | null;
}) {
  return (
    <li data-state={state}>
      <div className={styles.lineageMarker} aria-hidden="true" />
      <div className={styles.lineageContent}>
        <p className={styles.lineageState}>{label} / {state.replaceAll("_", " ")}</p>
        {identifier ? <strong>{identifier}</strong> : <span className={styles.withheldInline}>No identifier recorded.</span>}
        {summary ? <p>{summary}</p> : null}
        {authorityTier ? <span className={styles.lineageMeta}>authority / {authorityTier.replaceAll("_", " ")}</span> : null}
        {targetVersionId ? <span className={styles.lineageMeta}>rollback target / {targetVersionId}</span> : null}
        <EvidenceReferences ids={evidenceIds} />
      </div>
    </li>
  );
}

function EvidenceReferences({ ids }: { readonly ids: readonly string[] }) {
  if (ids.length === 0) return null;
  return (
    <ul className={styles.referenceList} aria-label="Evidence references">
      {ids.map((id) => <li key={id}>{id}</li>)}
    </ul>
  );
}

function parseCandidate(value: unknown): RoomCockpitCandidateEvidenceV1 | null {
  const record = asRecord(value);
  if (!record) return null;

  const candidateId = readIdentifier(record.candidateId);
  const candidateHash = readHash(record.candidateHash);
  const candidateVersionId = readIdentifier(record.candidateVersionId);
  const baseVersionId = readNullableIdentifier(record.baseVersionId);
  const intentSummary = readText(record.intentSummary);
  const diffSummary = readText(record.diffSummary);
  const evidenceIds = readReferenceIds(record.evidenceIds);
  if (!candidateId || !candidateHash || !candidateVersionId || baseVersionId === undefined || !intentSummary || !diffSummary || !evidenceIds || evidenceIds.length === 0) {
    return null;
  }

  return { candidateId, candidateHash, candidateVersionId, baseVersionId, intentSummary, diffSummary, evidenceIds };
}

function parseHardGates(value: unknown): readonly RoomCockpitHardGateEvidenceV1[] | null {
  if (!Array.isArray(value) || value.length > MAX_REFERENCE_COUNT) return null;
  const gates = value.map(parseHardGate);
  if (gates.some((gate): gate is null => gate === null)) return null;
  const typedGates = gates as RoomCockpitHardGateEvidenceV1[];
  return new Set(typedGates.map((gate) => gate.gateId)).size === typedGates.length ? typedGates : null;
}

function parseHardGate(value: unknown): RoomCockpitHardGateEvidenceV1 | null {
  const record = asRecord(value);
  if (!record) return null;

  const gateId = readIdentifier(record.gateId);
  const state = readEnum(record.state, ROOM_COCKPIT_HARD_GATE_STATES);
  const summary = readText(record.summary);
  const evidenceIds = readReferenceIds(record.evidenceIds);
  if (!gateId || !state || !summary || !evidenceIds) return null;
  if ((state === "passed" || state === "failed") && evidenceIds.length === 0) return null;

  return { gateId, state, summary, evidenceIds };
}

function parseIndependentAssessment(value: unknown): RoomCockpitIndependentAssessmentV1 | null {
  const record = asRecord(value);
  if (!record) return null;

  const status = readEnum(record.status, ROOM_COCKPIT_REVIEW_STATES);
  const reviewerCount = readNullableCount(record.reviewerCount);
  const dissentSummary = readNullableText(record.dissentSummary);
  const arbitration = record.arbitration === null ? null : parseArbitration(record.arbitration);
  const decision = record.decision === null ? null : parseDecision(record.decision);
  const evidenceIds = readReferenceIds(record.evidenceIds);
  if (!status || reviewerCount === undefined || dissentSummary === undefined || arbitration === undefined || decision === undefined || !evidenceIds) {
    return null;
  }

  if (status === "consensus" && (reviewerCount === null || reviewerCount < 1 || dissentSummary !== null)) return null;
  if ((status === "dissent_open" || status === "arbitrated") && (reviewerCount === null || reviewerCount < 2 || !dissentSummary)) return null;
  if (status === "arbitrated" && arbitration?.status !== "resolved") return null;
  if (status === "dissent_open" && decision?.status === "promoted") return null;
  if ((status === "withheld" || status === "unavailable") && (reviewerCount !== null || dissentSummary !== null)) return null;

  return { status, reviewerCount, dissentSummary, arbitration, decision, evidenceIds };
}

function parseArbitration(value: unknown): RoomCockpitArbitrationEvidenceV1 | null | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const status = readEnum(record.status, ROOM_COCKPIT_ARBITRATION_STATES);
  const summary = readNullableText(record.summary);
  const evidenceIds = readReferenceIds(record.evidenceIds);
  if (!status || summary === undefined || !evidenceIds) return undefined;
  if ((status === "pending" || status === "resolved") && (!summary || evidenceIds.length === 0)) return undefined;

  return { status, summary, evidenceIds };
}

function parseDecision(value: unknown): RoomCockpitDecisionEvidenceV1 | null | undefined {
  const record = asRecord(value);
  if (!record) return undefined;

  const status = readEnum(record.status, ROOM_COCKPIT_DECISION_STATES);
  const authorityTier = readNullableEnum(record.authorityTier, ROOM_COCKPIT_AUTHORITY_TIERS);
  const decisionId = readNullableIdentifier(record.decisionId);
  const summary = readNullableText(record.summary);
  const evidenceIds = readReferenceIds(record.evidenceIds);
  if (!status || authorityTier === undefined || decisionId === undefined || summary === undefined || !evidenceIds) return undefined;

  const persistedDecision = status === "promoted" || status === "rejected" || status === "rollback_required" || status === "inconclusive";
  if (persistedDecision && (!authorityTier || !decisionId || !summary || evidenceIds.length === 0)) return undefined;

  return { status, authorityTier, decisionId, summary, evidenceIds };
}

function parseCanary(value: unknown): RoomCockpitCanaryEvidenceV1 | null {
  const record = asRecord(value);
  if (!record) return null;

  const status = readEnum(record.status, ROOM_COCKPIT_CANARY_STATES);
  const canaryId = readNullableIdentifier(record.canaryId);
  const summary = readNullableText(record.summary);
  const evidenceIds = readReferenceIds(record.evidenceIds);
  if (!status || canaryId === undefined || summary === undefined || !evidenceIds) return null;
  if ((status === "running" || status === "passed" || status === "failed") && !canaryId) return null;
  if ((status === "passed" || status === "failed") && (!summary || evidenceIds.length === 0)) return null;

  return { status, canaryId, summary, evidenceIds };
}

function parsePromotion(value: unknown): RoomCockpitPromotionEvidenceV1 | null {
  const record = asRecord(value);
  if (!record) return null;

  const status = readEnum(record.status, ROOM_COCKPIT_PROMOTION_STATES);
  const decisionId = readNullableIdentifier(record.decisionId);
  const authorityTier = readNullableEnum(record.authorityTier, ROOM_COCKPIT_AUTHORITY_TIERS);
  const summary = readNullableText(record.summary);
  const evidenceIds = readReferenceIds(record.evidenceIds);
  if (!status || decisionId === undefined || authorityTier === undefined || summary === undefined || !evidenceIds) return null;

  const persistedDecision = status === "promoted" || status === "rejected" || status === "rollback_required" || status === "inconclusive";
  if (persistedDecision && (!decisionId || !authorityTier || !summary || evidenceIds.length === 0)) return null;
  if ((status === "withheld" || status === "unavailable") && !summary) return null;

  return { status, decisionId, authorityTier, summary, evidenceIds };
}

function parseRollback(value: unknown): RoomCockpitRollbackEvidenceV1 | null {
  const record = asRecord(value);
  if (!record) return null;

  const status = readEnum(record.status, ROOM_COCKPIT_ROLLBACK_STATES);
  const rollbackId = readNullableIdentifier(record.rollbackId);
  const targetVersionId = readNullableIdentifier(record.targetVersionId);
  const summary = readNullableText(record.summary);
  const evidenceIds = readReferenceIds(record.evidenceIds);
  if (!status || rollbackId === undefined || targetVersionId === undefined || summary === undefined || !evidenceIds) return null;
  if ((status === "armed" || status === "completed") && (!targetVersionId || !summary || evidenceIds.length === 0)) return null;
  if (status === "completed" && !rollbackId) return null;

  return { status, rollbackId, targetVersionId, summary, evidenceIds };
}

function hasConsistentPromotionLineage({
  hardGates,
  independentAssessment,
  canary,
  promotion,
  rollback,
}: {
  readonly hardGates: readonly RoomCockpitHardGateEvidenceV1[];
  readonly independentAssessment: RoomCockpitIndependentAssessmentV1;
  readonly canary: RoomCockpitCanaryEvidenceV1;
  readonly promotion: RoomCockpitPromotionEvidenceV1;
  readonly rollback: RoomCockpitRollbackEvidenceV1;
}) {
  if (promotion.status === "promoted") {
    return hardGates.length > 0
      && hardGates.every((gate) => gate.state === "passed")
      && canary.status === "passed"
      && independentAssessment.status !== "dissent_open"
      && independentAssessment.status !== "withheld"
      && independentAssessment.status !== "unavailable"
      && independentAssessment.decision?.status === "promoted"
      && independentAssessment.decision.decisionId === promotion.decisionId;
  }

  if (promotion.status === "rollback_required") {
    return rollback.status === "armed" || rollback.status === "completed";
  }

  return true;
}

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as UnknownRecord : null;
}

function readEnum<const T extends readonly string[]>(value: unknown, values: T): T[number] | null {
  return typeof value === "string" && values.includes(value as T[number]) ? value as T[number] : null;
}

function readNullableEnum<const T extends readonly string[]>(value: unknown, values: T): T[number] | null | undefined {
  if (value === null) return null;
  return readEnum(value, values) ?? undefined;
}

function readIdentifier(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_IDENTIFIER_LENGTH ? value : null;
}

function readNullableIdentifier(value: unknown): string | null | undefined {
  if (value === null) return null;
  return readIdentifier(value) ?? undefined;
}

function readHash(value: unknown): string | null {
  return typeof value === "string" && SHA256_HASH.test(value) ? value : null;
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT_LENGTH ? value : null;
}

function readNullableText(value: unknown): string | null | undefined {
  if (value === null) return null;
  return readText(value) ?? undefined;
}

function readNullableCount(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_REFERENCE_COUNT ? value : undefined;
}

function readReferenceIds(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_REFERENCE_COUNT) return null;
  const ids = value.map(readIdentifier);
  if (ids.some((id): id is null => id === null)) return null;
  const typedIds = ids as string[];
  return new Set(typedIds).size === typedIds.length ? typedIds : null;
}

function joinClassNames(...classNames: Array<string | undefined>) {
  return classNames.filter(Boolean).join(" ");
}

import {
  deriveAuthorizedRoomEvolutionHypotheses,
  hashRoomValue,
  type AppendRoomEvolutionHypothesisInputV1,
  type AsyncRoomEvolutionLedger,
  type DeriveAuthorizedRoomEvolutionHypothesesInputV1,
  type RoomEvolutionEvidenceRefV1,
  type RoomEvolutionOutcomeObservationV1,
} from "@fusion/core";

export const ROOM_EVOLUTION_HYPOTHESIS_COMMIT_COORDINATOR_CONTRACT_VERSION = 1 as const;

export type RoomEvolutionHypothesisLedgerPortV1 = Pick<AsyncRoomEvolutionLedger, "appendHypothesis">;

export interface RoomEvolutionHypothesisCommitCoordinatorDependenciesV1 {
  readonly ledger: RoomEvolutionHypothesisLedgerPortV1;
}

export interface CommitRoomEvolutionHypothesesInputV1 extends DeriveAuthorizedRoomEvolutionHypothesesInputV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_HYPOTHESIS_COMMIT_COORDINATOR_CONTRACT_VERSION;
}

export type CommitRoomEvolutionHypothesesResultV1 =
  | { readonly status: "committed"; readonly committedHypothesisIds: readonly string[] }
  | { readonly status: "no_hypotheses" }
  | { readonly status: "withheld"; readonly reason: string }
  | { readonly status: "append_failed"; readonly hypothesisId: string; readonly reason: string };

export class RoomEvolutionHypothesisCommitCoordinator {
  public constructor(
    private readonly dependencies: RoomEvolutionHypothesisCommitCoordinatorDependenciesV1,
  ) {}

  public async commit(
    input: CommitRoomEvolutionHypothesesInputV1,
  ): Promise<CommitRoomEvolutionHypothesesResultV1> {
    if (input.contractVersion !== ROOM_EVOLUTION_HYPOTHESIS_COMMIT_COORDINATOR_CONTRACT_VERSION) {
      return Object.freeze({ status: "withheld" as const, reason: "unsupported_contract_version" });
    }
    if (!isLedgerPort(this.dependencies?.ledger)) {
      return Object.freeze({ status: "withheld" as const, reason: "ledger_unavailable" });
    }
    const derived = deriveAuthorizedRoomEvolutionHypotheses(input);
    if (!derived.ok) {
      return Object.freeze({ status: "withheld" as const, reason: "hypothesis_derivation_rejected" });
    }
    if (derived.value.length === 0) return Object.freeze({ status: "no_hypotheses" as const });

    const observations = new Map(input.signals.observations.map((observation) => [observation.id, observation]));
    const committed: string[] = [];
    for (const hypothesis of derived.value) {
      const evidence = toLedgerEvidence(hypothesis.evidence, observations);
      if (evidence === null) {
        return Object.freeze({ status: "withheld" as const, reason: "derived_evidence_missing_from_authorized_signal_set" });
      }
      const append = toAppendInput(input.signals.asOf, hypothesis, evidence);
      try {
        const persisted = await this.dependencies.ledger.appendHypothesis(append);
        if (
          persisted.table !== "room_evolution_hypotheses"
          || persisted.record.id !== append.id
          || persisted.record.projectId !== append.scope.projectId
          || persisted.record.roomId !== append.scope.roomId
          || persisted.record.scopeKey !== append.scope.scopeKey
        ) {
          return Object.freeze({ status: "append_failed" as const, hypothesisId: append.id, reason: "ledger_response_invalid" });
        }
      } catch (error) {
        return Object.freeze({
          status: "append_failed" as const,
          hypothesisId: append.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      committed.push(append.id);
    }
    return Object.freeze({ status: "committed" as const, committedHypothesisIds: Object.freeze(committed.sort()) });
  }
}

function toLedgerEvidence(
  references: readonly {
    readonly observationId: string;
    readonly kind: string;
    readonly sourceRef: string;
    readonly evidenceHash: string;
    readonly observedAt: string;
  }[],
  observations: ReadonlyMap<string, RoomEvolutionOutcomeObservationV1>,
): readonly RoomEvolutionEvidenceRefV1[] | null {
  const evidence: RoomEvolutionEvidenceRefV1[] = [];
  for (const reference of references) {
    const observation = observations.get(reference.observationId);
    if (
      !observation
      || observation.sourceRef !== reference.sourceRef
      || observation.evidenceHash !== reference.evidenceHash
      || observation.observedAt !== reference.observedAt
    ) {
      return null;
    }
    evidence.push(Object.freeze({
      id: observation.id,
      source: observation.source,
      sourceRef: observation.sourceRef,
      evidenceHash: observation.evidenceHash,
      observedAt: observation.observedAt,
    }));
  }
  return Object.freeze(evidence.sort((left, right) => left.id.localeCompare(right.id)));
}

function toAppendInput(
  createdAt: string,
  hypothesis: {
    readonly id: string;
    readonly projectId: string;
    readonly roomId: string | null;
    readonly scopeKind: "project" | "room";
    readonly scopeKey: string;
    readonly revision: number;
    readonly state: "proposed";
    readonly sourceSignalKinds: readonly AppendRoomEvolutionHypothesisInputV1["sourceSignalKinds"][number][];
    readonly declaredScope: readonly string[];
    readonly riskClass: AppendRoomEvolutionHypothesisInputV1["riskClass"];
    readonly expectedMechanism: string;
    readonly affectedDomains: readonly string[];
    readonly createdByActorId: string;
  },
  evidence: readonly RoomEvolutionEvidenceRefV1[],
): AppendRoomEvolutionHypothesisInputV1 {
  const scope = Object.freeze({
    projectId: hypothesis.projectId,
    roomId: hypothesis.roomId,
    scopeKind: hypothesis.scopeKind,
    scopeKey: hypothesis.scopeKey,
  });
  return Object.freeze({
    scope,
    id: hypothesis.id,
    revision: hypothesis.revision,
    state: hypothesis.state,
    sourceSignalKinds: Object.freeze([...hypothesis.sourceSignalKinds]),
    evidence,
    evidenceHash: hashRoomValue({ id: hypothesis.id, scope, evidence }),
    declaredScope: Object.freeze([...hypothesis.declaredScope]),
    riskClass: hypothesis.riskClass,
    expectedMechanism: hypothesis.expectedMechanism,
    affectedDomains: Object.freeze([...hypothesis.affectedDomains]),
    createdByActorId: hypothesis.createdByActorId,
    createdAt,
  });
}

function isLedgerPort(value: unknown): value is RoomEvolutionHypothesisLedgerPortV1 {
  return typeof value === "object"
    && value !== null
    && typeof (value as { appendHypothesis?: unknown }).appendHypothesis === "function";
}

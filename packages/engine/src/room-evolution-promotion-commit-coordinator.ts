import {
  evaluateRoomEvolutionPromotion,
  type EvaluateRoomEvolutionPromotionInputV1,
  type RoomEvolutionPromotionDecisionV1,
} from "@fusion/core";

export const ROOM_EVOLUTION_PROMOTION_COMMIT_COORDINATOR_CONTRACT_VERSION = 1 as const;

export interface RoomEvolutionPromotionCommandIdentityV1 {
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId: string | null;
}

export type RoomEvolutionPromotionDurableOutcomeV1 =
  | "promoted"
  | "rejected"
  | "rolled_back"
  | "inconclusive";

export interface RoomEvolutionPromotionDurableDecisionV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_PROMOTION_COMMIT_COORDINATOR_CONTRACT_VERSION;
  readonly id: string;
  readonly proposalId: string;
  readonly candidateHash: string;
  readonly outcome: RoomEvolutionPromotionDurableOutcomeV1;
  readonly runtimeAction: RoomEvolutionPromotionDecisionV1["requiredRuntimeAction"];
  readonly evaluationPath: RoomEvolutionPromotionDecisionV1["evaluationPath"];
  readonly blockers: readonly RoomEvolutionPromotionDecisionV1["blockers"][number][];
  readonly evaluatedAt: string;
}

export interface AppendRoomEvolutionPromotionDecisionInputV1 {
  readonly command: RoomEvolutionPromotionCommandIdentityV1;
  readonly decision: RoomEvolutionPromotionDurableDecisionV1;
  readonly evaluation: EvaluateRoomEvolutionPromotionInputV1;
}

export interface RoomEvolutionPromotionDecisionLedgerRecordV1 {
  readonly recordId: string;
  readonly decisionId: string;
  readonly replayed: boolean;
}

export interface RoomEvolutionPromotionDecisionLedgerPortV1 {
  appendDecision(
    input: AppendRoomEvolutionPromotionDecisionInputV1,
  ): Promise<RoomEvolutionPromotionDecisionLedgerRecordV1>;
}

export interface RoomEvolutionPromotionCommitCoordinatorDependenciesV1 {
  readonly ledger: RoomEvolutionPromotionDecisionLedgerPortV1;
}

export interface RequestRoomEvolutionPromotionCommitV1 {
  readonly command: RoomEvolutionPromotionCommandIdentityV1;
  readonly decisionId: string;
  readonly evaluation: EvaluateRoomEvolutionPromotionInputV1;
}

export type RoomEvolutionPromotionCommitResultV1 =
  | {
    readonly status: "committed";
    readonly decision: RoomEvolutionPromotionDurableDecisionV1;
    readonly evaluation: RoomEvolutionPromotionDecisionV1;
    readonly record: RoomEvolutionPromotionDecisionLedgerRecordV1;
  }
  | {
    readonly status: "withheld";
    readonly reason: { readonly code: "invalid_request" | "ledger_port_invalid"; readonly message: string };
  }
  | {
    readonly status: "append_failed";
    readonly decision: RoomEvolutionPromotionDurableDecisionV1;
    readonly evaluation: RoomEvolutionPromotionDecisionV1;
    readonly reason: { readonly code: "ledger_write_failed" | "ledger_write_invalid"; readonly message: string };
  };

export class RoomEvolutionPromotionCommitCoordinator {
  public constructor(
    private readonly dependencies: RoomEvolutionPromotionCommitCoordinatorDependenciesV1,
  ) {}

  public async evaluateAndCommit(
    input: RequestRoomEvolutionPromotionCommitV1,
  ): Promise<RoomEvolutionPromotionCommitResultV1> {
    if (!isRequest(input)) {
      return withheld("invalid_request", "Evolution promotion commit requires an exact command, decision identity, and evaluation input.");
    }
    if (!isLedgerPort(this.dependencies?.ledger)) {
      return withheld("ledger_port_invalid", "Evolution promotion decision ledger is unavailable.");
    }

    const evaluation = evaluateRoomEvolutionPromotion(input.evaluation);
    const decision = createDurableDecision(input, evaluation);
    try {
      const record = await this.dependencies.ledger.appendDecision({
        command: freezeCommand(input.command),
        decision,
        evaluation: freezeEvaluation(input.evaluation),
      });
      if (!isLedgerRecord(record, decision.id)) {
        return {
          status: "append_failed",
          decision,
          evaluation,
          reason: {
            code: "ledger_write_invalid",
            message: "Evolution decision ledger did not confirm the exact immutable decision.",
          },
        };
      }
      return {
        status: "committed",
        decision,
        evaluation,
        record: freeze({ recordId: record.recordId, decisionId: record.decisionId, replayed: record.replayed }),
      };
    } catch {
      return {
        status: "append_failed",
        decision,
        evaluation,
        reason: {
          code: "ledger_write_failed",
          message: "Evolution promotion decision was not reported committed because its immutable ledger append failed.",
        },
      };
    }
  }
}

function createDurableDecision(
  input: RequestRoomEvolutionPromotionCommitV1,
  evaluation: RoomEvolutionPromotionDecisionV1,
): RoomEvolutionPromotionDurableDecisionV1 {
  const outcome = evaluation.requiredRuntimeAction === "promote_candidate"
    ? "promoted"
    : evaluation.requiredRuntimeAction === "rollback_candidate"
      ? "rolled_back"
      : evaluation.evaluationPath === "hard_gate_blocked"
        ? "rejected"
        : "inconclusive";
  return freeze({
    contractVersion: ROOM_EVOLUTION_PROMOTION_COMMIT_COORDINATOR_CONTRACT_VERSION,
    id: input.decisionId,
    proposalId: input.evaluation.proposal.id,
    candidateHash: input.evaluation.proposal.candidateHash,
    outcome,
    runtimeAction: evaluation.requiredRuntimeAction,
    evaluationPath: evaluation.evaluationPath,
    blockers: freeze([...evaluation.blockers].map((blocker) => freeze({ ...blocker }))),
    evaluatedAt: input.evaluation.evaluatedAt,
  });
}

function isRequest(value: unknown): value is RequestRoomEvolutionPromotionCommitV1 {
  return isRecord(value)
    && hasExactKeys(value, ["command", "decisionId", "evaluation"])
    && isCommand(value.command)
    && isIdentifier(value.decisionId)
    && isEvaluation(value.evaluation);
}

function isCommand(value: unknown): value is RoomEvolutionPromotionCommandIdentityV1 {
  return isRecord(value)
    && hasExactKeys(value, ["commandId", "idempotencyKey", "correlationId", "causationId"])
    && isIdentifier(value.commandId)
    && isIdentifier(value.idempotencyKey)
    && isIdentifier(value.correlationId)
    && (value.causationId === null || isIdentifier(value.causationId));
}

function isEvaluation(value: unknown): value is EvaluateRoomEvolutionPromotionInputV1 {
  return isRecord(value)
    && value.contractVersion === 1
    && isRecord(value.proposal)
    && isIdentifier(value.proposal.id)
    && isHash(value.proposal.candidateHash)
    && typeof value.evaluatedAt === "string";
}

function isLedgerPort(value: unknown): value is RoomEvolutionPromotionDecisionLedgerPortV1 {
  return isRecord(value) && typeof value.appendDecision === "function";
}

function isLedgerRecord(value: unknown, decisionId: string): value is RoomEvolutionPromotionDecisionLedgerRecordV1 {
  return isRecord(value)
    && isIdentifier(value.recordId)
    && value.decisionId === decisionId
    && typeof value.replayed === "boolean";
}

function withheld(
  code: "invalid_request" | "ledger_port_invalid",
  message: string,
): RoomEvolutionPromotionCommitResultV1 {
  return { status: "withheld", reason: { code, message } };
}

function freezeCommand(value: RoomEvolutionPromotionCommandIdentityV1): RoomEvolutionPromotionCommandIdentityV1 {
  return freeze({ ...value });
}

function freezeEvaluation(value: EvaluateRoomEvolutionPromotionInputV1): EvaluateRoomEvolutionPromotionInputV1 {
  return freeze(structuredClone(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{16,128}$/iu.test(value);
}

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null) return value;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const nested of Object.values(value)) freeze(nested, seen);
  return Object.freeze(value);
}

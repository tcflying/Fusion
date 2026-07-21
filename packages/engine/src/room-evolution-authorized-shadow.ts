import {
  hashRoomValue,
  type AppendRoomEvolutionExperimentInputV1,
  type AsyncRoomEvolutionLedger,
  type RoomEvolutionLedgerAppendResult,
  type RoomEvolutionExperimentRecordV1,
} from "@fusion/core";

export const ROOM_EVOLUTION_AUTHORIZED_SHADOW_CONTRACT_VERSION = 1 as const;

export interface RoomEvolutionAuthorizedShadowActorV1 {
  readonly kind: "dashboard_operator";
  readonly principalId: string;
}

export interface RecordRoomEvolutionAuthorizedShadowInputV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_AUTHORIZED_SHADOW_CONTRACT_VERSION;
  readonly commandId: string;
  readonly roomId: string;
  /** Must name a hypothesis already accepted by the current durable Room gate/data layer. */
  readonly hypothesisId: string;
  /** Must name that hypothesis's existing durable candidate version. */
  readonly candidateVersionId: string;
}

export type RoomEvolutionAuthorizedShadowLedgerPortV1 = Pick<AsyncRoomEvolutionLedger, "appendExperiment">;

export interface RoomEvolutionAuthorizedShadowRunnerOptionsV1 {
  readonly projectId: string;
  readonly ledger: RoomEvolutionAuthorizedShadowLedgerPortV1 | null | undefined;
  readonly now?: () => string;
}

export interface RoomEvolutionAuthorizedShadowReceiptV1 {
  readonly experimentId: string;
  readonly projectId: string;
  readonly roomId: string;
  readonly hypothesisId: string;
  readonly candidateVersionId: string;
  readonly state: "planned";
  readonly capacityPool: "evolution_paused";
  readonly createdAt: string;
}

export type RoomEvolutionAuthorizedShadowWithheldReasonV1 =
  | "unsupported_contract_version"
  | "dashboard_operator_required"
  | "project_scope_invalid"
  | "existing_durable_references_required_no_safe_read_api"
  | "evolution_ledger_unavailable"
  | "durable_receipt_rejected"
  | "durable_receipt_invalid";

export type RoomEvolutionAuthorizedShadowResultV1 =
  | { readonly status: "shadow_recorded"; readonly receipt: RoomEvolutionAuthorizedShadowReceiptV1 }
  | { readonly status: "withheld"; readonly reason: RoomEvolutionAuthorizedShadowWithheldReasonV1 };

const SHADOW_PROHIBITED_OPERATIONS = [
  "source_worktree_creation",
  "provider_call",
  "evaluator",
  "canary",
  "promotion",
  "rollback",
] as const;

/*
FNXC:RoomEvolutionShadow 2026-07-19-19:07:
Evolution Shadow is an authenticated, provider-free observation receipt, not a
self-evolution runner. It may record exactly one existing-candidate experiment
as planned in the evolution_paused pool; it must never create a source worktree,
call a provider, evaluate, canary, promote, or roll back.

Core exposes append-time reference validation but no safe public evolution-read
API. Missing or rejected durable references are therefore withheld explicitly;
this boundary must not invent raw database reads or infer a candidate lineage.
*/
export class RoomEvolutionAuthorizedShadowRunner {
  public constructor(private readonly options: RoomEvolutionAuthorizedShadowRunnerOptionsV1) {}

  public async record(
    rawInput: RecordRoomEvolutionAuthorizedShadowInputV1,
    rawActor: RoomEvolutionAuthorizedShadowActorV1 | { readonly kind: string; readonly principalId: string },
  ): Promise<RoomEvolutionAuthorizedShadowResultV1> {
    const input = normalizeInput(rawInput);
    if (input === null) {
      return withheld("existing_durable_references_required_no_safe_read_api");
    }
    if (!isDashboardOperator(rawActor)) {
      return withheld("dashboard_operator_required");
    }
    if (!isIdentifier(this.options?.projectId)) {
      return withheld("project_scope_invalid");
    }
    if (!hasLedgerPort(this.options?.ledger)) {
      return withheld("evolution_ledger_unavailable");
    }

    const createdAt = this.options.now?.() ?? new Date().toISOString();
    if (!isCanonicalTimestamp(createdAt)) {
      return withheld("durable_receipt_invalid");
    }

    const scope = freeze({
      projectId: this.options.projectId,
      roomId: input.roomId,
      scopeKind: "room" as const,
      scopeKey: `room:${input.roomId}`,
    });
    const inputSnapshot = freeze({
      contractVersion: ROOM_EVOLUTION_AUTHORIZED_SHADOW_CONTRACT_VERSION,
      projectId: scope.projectId,
      roomId: scope.roomId,
      hypothesisId: input.hypothesisId,
      candidateVersionId: input.candidateVersionId,
      commandId: input.commandId,
    });
    const authorizationEvidence = freeze({
      contractVersion: ROOM_EVOLUTION_AUTHORIZED_SHADOW_CONTRACT_VERSION,
      kind: "operator_authorized_evolution_shadow",
      actor: freeze({ kind: rawActor.kind, principalId: rawActor.principalId }),
      commandId: input.commandId,
      prohibitedOperations: Object.freeze([...SHADOW_PROHIBITED_OPERATIONS]),
    });
    const inputSnapshotHash = hashRoomValue(inputSnapshot);
    const authorizationHash = hashRoomValue(authorizationEvidence);
    const experimentId = toExperimentId(inputSnapshotHash);
    if (experimentId === null) {
      return withheld("durable_receipt_invalid");
    }

    const appendInput: AppendRoomEvolutionExperimentInputV1 = freeze({
      scope,
      id: experimentId,
      hypothesisId: input.hypothesisId,
      candidateVersionId: input.candidateVersionId,
      state: "planned" as const,
      inputSnapshotHash,
      authorizationEvidence,
      authorizationHash,
      capacityPool: "evolution_paused" as const,
      createdByActorId: rawActor.principalId,
      createdAt,
    });

    let appended: RoomEvolutionLedgerAppendResult<"room_evolution_experiments", RoomEvolutionExperimentRecordV1>;
    try {
      appended = await this.options.ledger.appendExperiment(appendInput);
    } catch {
      return withheld("durable_receipt_rejected");
    }
    if (!isExactShadowReceipt(appended, appendInput)) {
      return withheld("durable_receipt_invalid");
    }

    return freeze({
      status: "shadow_recorded" as const,
      receipt: freeze({
        experimentId,
        projectId: scope.projectId,
        roomId: scope.roomId,
        hypothesisId: input.hypothesisId,
        candidateVersionId: input.candidateVersionId,
        state: "planned" as const,
        capacityPool: "evolution_paused" as const,
        createdAt,
      }),
    });
  }
}

function normalizeInput(value: unknown): RecordRoomEvolutionAuthorizedShadowInputV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "contractVersion",
    "commandId",
    "roomId",
    "hypothesisId",
    "candidateVersionId",
  ])) {
    return null;
  }
  if (value.contractVersion !== ROOM_EVOLUTION_AUTHORIZED_SHADOW_CONTRACT_VERSION) return null;
  if (
    !isIdentifier(value.commandId)
    || !isIdentifier(value.roomId)
    || !isIdentifier(value.hypothesisId)
    || !isIdentifier(value.candidateVersionId)
  ) {
    return null;
  }
  return freeze({
    contractVersion: value.contractVersion,
    commandId: value.commandId,
    roomId: value.roomId,
    hypothesisId: value.hypothesisId,
    candidateVersionId: value.candidateVersionId,
  });
}

function isDashboardOperator(value: unknown): value is RoomEvolutionAuthorizedShadowActorV1 {
  return isRecord(value)
    && hasExactKeys(value, ["kind", "principalId"])
    && value.kind === "dashboard_operator"
    && isIdentifier(value.principalId);
}

function hasLedgerPort(value: unknown): value is RoomEvolutionAuthorizedShadowLedgerPortV1 {
  return isRecord(value) && typeof value.appendExperiment === "function";
}

function isExactShadowReceipt(
  value: unknown,
  expected: AppendRoomEvolutionExperimentInputV1,
): value is RoomEvolutionLedgerAppendResult<"room_evolution_experiments", RoomEvolutionExperimentRecordV1> {
  if (!isRecord(value) || value.table !== "room_evolution_experiments" || !isRecord(value.record)) return false;
  const record = value.record;
  return record.contractVersion === 1
    && record.id === expected.id
    && record.projectId === expected.scope.projectId
    && record.roomId === expected.scope.roomId
    && record.scopeKind === expected.scope.scopeKind
    && record.scopeKey === expected.scope.scopeKey
    && record.hypothesisId === expected.hypothesisId
    && record.candidateVersionId === expected.candidateVersionId
    && record.state === "planned"
    && record.inputSnapshotHash === expected.inputSnapshotHash
    && record.authorizationHash === expected.authorizationHash
    && record.capacityPool === "evolution_paused"
    && record.createdByActorId === expected.createdByActorId
    && record.createdAt === expected.createdAt;
}

function toExperimentId(inputSnapshotHash: string): string | null {
  if (!/^sha256:[a-f0-9]{64}$/u.test(inputSnapshotHash)) return null;
  return `evolution-shadow:${inputSnapshotHash.slice("sha256:".length)}`;
}

function withheld(reason: RoomEvolutionAuthorizedShadowWithheldReasonV1): RoomEvolutionAuthorizedShadowResultV1 {
  return freeze({ status: "withheld" as const, reason });
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  return actual.length === canonicalExpected.length && actual.every((key, index) => key === canonicalExpected[index]);
}

function freeze<TValue>(value: TValue): TValue {
  if (typeof value !== "object" || value === null) return value;
  for (const nested of Object.values(value)) freeze(nested);
  return Object.freeze(value);
}

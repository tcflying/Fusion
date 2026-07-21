import {
  evaluateRoomTerminalization,
  hashRoomValue,
  type EvaluateRoomTerminalizationInputV1,
  type RecordRoomTerminalizationContractInputV1,
  type RecordRoomTerminalizationContractResultV1,
  type RoomCommandContext,
  type RoomTerminalizationDecisionV1,
  type TerminalizeRoomInputV1,
  type TerminalizeRoomResultV1,
} from "@fusion/core";

export interface RoomTerminalizationCommitStore {
  recordRoomTerminalizationContract(
    input: RecordRoomTerminalizationContractInputV1,
    context: RoomCommandContext,
  ): Promise<Pick<RecordRoomTerminalizationContractResultV1, "projection" | "replayed">>;
  terminalizeRoom(
    input: TerminalizeRoomInputV1,
    context: RoomCommandContext,
  ): Promise<Pick<TerminalizeRoomResultV1, "aggregate" | "projection" | "replayed">>;
}

export interface CommitRoomTerminalizationInputV1 {
  readonly roomId: string;
  readonly expectedAggregateVersion: number;
  readonly roomWorkerFence: RecordRoomTerminalizationContractInputV1["roomWorkerFence"];
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly completionContractRef: string;
  readonly gateEvidenceSetId: string;
  readonly independentVerificationRefs: readonly string[];
  readonly unresolvedRiskEvidence: RecordRoomTerminalizationContractInputV1["unresolvedRiskEvidence"];
  readonly cancellationReason: string | null;
  readonly terminalization: EvaluateRoomTerminalizationInputV1;
  /** The controller pins this timestamp before either durable command starts. */
  readonly occurredAt: string;
}

export interface RoomTerminalizationCommitCoordinatorOptions {
  readonly projectId: string;
  readonly controllerId: string;
  readonly store: RoomTerminalizationCommitStore;
}

export type CommitRoomTerminalizationResultV1 =
  | {
      readonly status: "withheld";
      readonly decision: RoomTerminalizationDecisionV1;
      readonly recorded: Pick<RecordRoomTerminalizationContractResultV1, "projection" | "replayed">;
    }
  | {
      readonly status: "terminalized";
      readonly decision: RoomTerminalizationDecisionV1;
      readonly recorded: Pick<RecordRoomTerminalizationContractResultV1, "projection" | "replayed">;
      readonly terminalized: Pick<TerminalizeRoomResultV1, "aggregate" | "projection" | "replayed">;
    };

export type RoomTerminalizationCommitCoordinatorErrorCode =
  | "invalid_terminalization_commit"
  | "terminalization_commit_drift";

export class RoomTerminalizationCommitCoordinatorError extends Error {
  constructor(
    readonly code: RoomTerminalizationCommitCoordinatorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RoomTerminalizationCommitCoordinatorError";
  }
}

/*
FNXC:RoomTerminalizationCommitCoordinator 2026-07-18-12:10:
The control plane must not stop at an Engine request queue. A controller that
still owns the Room-worker fence records the immutable contract first, then
uses that exact persisted hash for the sole terminal lifecycle mutation.
The two derived idempotency keys make acknowledgement-loss retries replay the
same record and terminal result without duplicating either side effect.
*/
export class RoomTerminalizationCommitCoordinator {
  constructor(private readonly options: RoomTerminalizationCommitCoordinatorOptions) {
    requireNonBlank(options.projectId, "projectId");
    requireNonBlank(options.controllerId, "controllerId");
    if (
      typeof options.store?.recordRoomTerminalizationContract !== "function"
      || typeof options.store?.terminalizeRoom !== "function"
    ) {
      throw new RoomTerminalizationCommitCoordinatorError(
        "invalid_terminalization_commit",
        "A terminalization commit coordinator requires both durable Room terminalization operations",
      );
    }
  }

  async commit(
    input: CommitRoomTerminalizationInputV1,
  ): Promise<CommitRoomTerminalizationResultV1> {
    validateInput(input);
    const decision = evaluateRoomTerminalization(input.terminalization);
    const eventId = `room-terminalization:${this.options.projectId}:${input.roomId}:${hashRoomValue(input.idempotencyKey)}`;
    const context = this.commandContext(eventId, input);
    const recorded = await this.options.store.recordRoomTerminalizationContract({
      roomId: input.roomId,
      expectedAggregateVersion: input.expectedAggregateVersion,
      roomWorkerFence: structuredClone(input.roomWorkerFence),
      idempotencyKey: `${input.idempotencyKey}:contract`,
      completionContractRef: input.completionContractRef,
      gateEvidenceSetId: input.gateEvidenceSetId,
      independentVerificationRefs: [...input.independentVerificationRefs],
      unresolvedRiskEvidence: structuredClone(input.unresolvedRiskEvidence),
      cancellationReason: input.cancellationReason,
      terminalization: structuredClone(input.terminalization),
      asOf: input.occurredAt,
    }, context);
    assertRecordedContract(this.options.projectId, input, decision, recorded);

    if (!recorded.projection.contract.decision.canTerminalize) {
      return Object.freeze({ status: "withheld" as const, decision, recorded });
    }

    const contract = recorded.projection.contract;
    const terminalized = await this.options.store.terminalizeRoom({
      roomId: input.roomId,
      expectedAggregateVersion: contract.aggregateVersion,
      roomWorkerFence: structuredClone(input.roomWorkerFence),
      idempotencyKey: `${input.idempotencyKey}:terminalize`,
      terminalContractId: contract.id,
      terminalContractHash: contract.contractHash,
      asOf: input.occurredAt,
    }, context);
    if (
      terminalized.projection.state !== "terminalized"
      || terminalized.projection.terminalization?.contractId !== contract.id
      || terminalized.projection.terminalization.contractHash !== contract.contractHash
    ) {
      throw new RoomTerminalizationCommitCoordinatorError(
        "terminalization_commit_drift",
        "The durable terminalization result does not bind the controller-recorded contract",
      );
    }
    return Object.freeze({ status: "terminalized" as const, decision, recorded, terminalized });
  }

  private commandContext(
    eventId: string,
    input: CommitRoomTerminalizationInputV1,
  ): RoomCommandContext {
    return {
      eventId,
      actorType: "controller",
      actorId: this.options.controllerId,
      correlationId: input.correlationId,
      causationId: input.causationId,
      occurredAt: input.occurredAt,
    };
  }
}

function validateInput(input: CommitRoomTerminalizationInputV1): void {
  if (!isRecord(input)) invalid("A terminalization commit must be a structured object");
  requireNonBlank(input.roomId, "roomId");
  requireNonBlank(input.idempotencyKey, "idempotencyKey");
  requireNonBlank(input.correlationId, "correlationId");
  requireNonBlank(input.completionContractRef, "completionContractRef");
  requireNonBlank(input.gateEvidenceSetId, "gateEvidenceSetId");
  requireCanonicalTimestamp(input.occurredAt, "occurredAt");
  if (!Number.isSafeInteger(input.expectedAggregateVersion) || input.expectedAggregateVersion < 0) {
    invalid("expectedAggregateVersion must be a non-negative safe integer");
  }
  if (!isRecord(input.roomWorkerFence)) invalid("roomWorkerFence must be structured");
  requireNonBlank(input.roomWorkerFence.leaseId, "roomWorkerFence.leaseId");
  requireNonBlank(input.roomWorkerFence.holderId, "roomWorkerFence.holderId");
  requireNonBlank(input.roomWorkerFence.hostId, "roomWorkerFence.hostId");
  if (!Number.isSafeInteger(input.roomWorkerFence.expectedEpoch) || input.roomWorkerFence.expectedEpoch < 0) {
    invalid("roomWorkerFence.expectedEpoch must be a non-negative safe integer");
  }
  if (!isRecord(input.terminalization)) invalid("terminalization must be structured");
  if (input.terminalization.evidence.evidenceSetId !== input.gateEvidenceSetId) {
    invalid("gateEvidenceSetId must exactly match terminalization.evidence.evidenceSetId");
  }
  if (input.terminalization.requestedOutcome === "cancelled") {
    if (input.cancellationReason === null) invalid("cancelled terminalization requires a cancellationReason");
    requireNonBlank(input.cancellationReason, "cancellationReason");
  } else if (input.cancellationReason !== null) {
    invalid("only cancelled terminalization may carry a cancellationReason");
  }
  assertDistinct(input.independentVerificationRefs, "independentVerificationRefs");
}

function assertRecordedContract(
  projectId: string,
  input: CommitRoomTerminalizationInputV1,
  decision: RoomTerminalizationDecisionV1,
  recorded: Pick<RecordRoomTerminalizationContractResultV1, "projection" | "replayed">,
): void {
  const contract = recorded.projection?.contract;
  if (!contract || contract.projectId !== projectId || contract.roomId !== input.roomId) {
    drift("The durable terminalization contract belongs to another Room or project");
  }
  if (
    contract.aggregateVersion <= input.expectedAggregateVersion
    || contract.gateEvidenceSetId !== input.gateEvidenceSetId
    || contract.completionContractRef !== input.completionContractRef
    || hashRoomValue(contract.terminalization) !== hashRoomValue(input.terminalization)
    || hashRoomValue(contract.decision) !== hashRoomValue(decision)
    || !contract.contractHash
  ) {
    drift("The durable terminalization contract no longer matches the controller command");
  }
}

function assertDistinct(values: readonly string[], field: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    requireNonBlank(value, field);
    if (seen.has(value)) invalid(`${field} must not contain duplicate references`);
    seen.add(value);
  }
}

function requireCanonicalTimestamp(value: unknown, field: string): void {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || Number.isNaN(Date.parse(value))) {
    invalid(`${field} must be a canonical UTC timestamp`);
  }
}

function requireNonBlank(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) invalid(`${field} must be non-empty`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new RoomTerminalizationCommitCoordinatorError("invalid_terminalization_commit", message);
}

function drift(message: string): never {
  throw new RoomTerminalizationCommitCoordinatorError("terminalization_commit_drift", message);
}

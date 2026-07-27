export const ROOM_PARTICIPANT_RUN_TASK_PROJECTION_CONTRACT_VERSION = 1 as const;

export type RoomParticipantOperationV1 = "review" | "plan" | "delegate";
export type RoomParticipantStateV1 =
  | "started"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timeout";

export interface RecordRoomParticipantRunTaskStateInputV1 {
  readonly roomId: string;
  readonly taskId: string;
  /** The owning Fusion run, not the provider-native participant run. */
  readonly fusionRunId: string;
  /** The Fusion actor whose run owns this participant observation. */
  readonly fusionAgentId: string;
  readonly operation: RoomParticipantOperationV1;
  readonly participantKey: string;
  readonly participantState: RoomParticipantStateV1;
  readonly participantRunId?: string;
  readonly callId?: string;
  readonly sidechainId?: string;
  readonly bindingId: string;
  readonly observedAt: string;
  /** Content-addressed or otherwise immutable reference; never raw model output. */
  readonly evidenceRef: string;
  readonly errorCode?: string;
}

export interface RoomParticipantRunTaskProjectionV1
  extends RecordRoomParticipantRunTaskStateInputV1 {
  readonly contractVersion:
    typeof ROOM_PARTICIPANT_RUN_TASK_PROJECTION_CONTRACT_VERSION;
  readonly projectId: string;
}

export interface RoomParticipantRunTaskProjectionStore {
  logEntry(
    taskId: string,
    action: string,
    outcome: string | undefined,
    runContext: { readonly runId: string; readonly agentId: string },
  ): Promise<unknown>;
}

export interface RoomParticipantRunTaskProjectorOptions {
  readonly projectId: string;
  readonly store: RoomParticipantRunTaskProjectionStore;
}

const OPERATIONS = new Set<RoomParticipantOperationV1>(["review", "plan", "delegate"]);
const STATES = new Set<RoomParticipantStateV1>([
  "started",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timeout",
]);

function requiredCanonicalText(value: unknown, field: string, maximum = 512): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maximum
    || value.trim() !== value
  ) {
    throw new Error(`${field} must be a canonical non-empty string`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      throw new Error(`${field} contains a forbidden control character`);
    }
  }
  return value;
}

function optionalCanonicalText(
  value: string | undefined,
  field: string,
  maximum = 512,
): string | undefined {
  return value === undefined
    ? undefined
    : requiredCanonicalText(value, field, maximum);
}

function assertInput(
  input: RecordRoomParticipantRunTaskStateInputV1,
): RecordRoomParticipantRunTaskStateInputV1 {
  if (!OPERATIONS.has(input.operation)) {
    throw new Error("operation is not supported");
  }
  if (!STATES.has(input.participantState)) {
    throw new Error("participantState is not supported");
  }
  if (!Number.isFinite(Date.parse(input.observedAt))) {
    throw new Error("observedAt must be an ISO-compatible timestamp");
  }

  return {
    roomId: requiredCanonicalText(input.roomId, "roomId", 256),
    taskId: requiredCanonicalText(input.taskId, "taskId", 256),
    fusionRunId: requiredCanonicalText(input.fusionRunId, "fusionRunId", 256),
    fusionAgentId: requiredCanonicalText(input.fusionAgentId, "fusionAgentId", 256),
    operation: input.operation,
    participantKey: requiredCanonicalText(input.participantKey, "participantKey", 256),
    participantState: input.participantState,
    ...(optionalCanonicalText(input.participantRunId, "participantRunId", 256)
      ? { participantRunId: input.participantRunId }
      : {}),
    ...(optionalCanonicalText(input.callId, "callId", 256)
      ? { callId: input.callId }
      : {}),
    ...(optionalCanonicalText(input.sidechainId, "sidechainId", 256)
      ? { sidechainId: input.sidechainId }
      : {}),
    bindingId: requiredCanonicalText(input.bindingId, "bindingId", 256),
    observedAt: input.observedAt,
    evidenceRef: requiredCanonicalText(input.evidenceRef, "evidenceRef", 1_024),
    ...(optionalCanonicalText(input.errorCode, "errorCode", 256)
      ? { errorCode: input.errorCode }
      : {}),
  };
}

/*
 * FNXC:RoomParticipantRunTaskProjection 2026-07-27-16:46:
 * Provider-native review/plan/delegate states are not Fusion task state by
 * themselves. Project them through TaskStore.logEntry with the owning Fusion
 * run context so PostgreSQL writes the task activity and run-audit mutation in
 * one durable boundary. The projection stores identifiers plus an immutable
 * evidence reference, never provider prose or tool payloads.
 */
export class RoomParticipantRunTaskProjector {
  private readonly projectId: string;

  constructor(private readonly options: RoomParticipantRunTaskProjectorOptions) {
    this.projectId = requiredCanonicalText(options.projectId, "projectId", 256);
  }

  async record(
    rawInput: RecordRoomParticipantRunTaskStateInputV1,
  ): Promise<RoomParticipantRunTaskProjectionV1> {
    const input = assertInput(rawInput);
    const projection: RoomParticipantRunTaskProjectionV1 = Object.freeze({
      contractVersion: ROOM_PARTICIPANT_RUN_TASK_PROJECTION_CONTRACT_VERSION,
      projectId: this.projectId,
      ...input,
    });
    const taskOutcome = JSON.stringify({
      contractVersion: projection.contractVersion,
      projectId: projection.projectId,
      roomId: projection.roomId,
      operation: projection.operation,
      participantKey: projection.participantKey,
      participantState: projection.participantState,
      ...(projection.participantRunId
        ? { participantRunId: projection.participantRunId }
        : {}),
      ...(projection.callId ? { callId: projection.callId } : {}),
      ...(projection.sidechainId ? { sidechainId: projection.sidechainId } : {}),
      bindingId: projection.bindingId,
      observedAt: projection.observedAt,
      evidenceRef: projection.evidenceRef,
      ...(projection.errorCode ? { errorCode: projection.errorCode } : {}),
    });
    await this.options.store.logEntry(
      projection.taskId,
      `[room-participant] ${projection.operation}/${projection.participantKey}: ${projection.participantState}`,
      taskOutcome,
      {
        runId: projection.fusionRunId,
        agentId: projection.fusionAgentId,
      },
    );
    return projection;
  }
}

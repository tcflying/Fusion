import {
  ROOM_STRATEGY_VERSION_PINNING_CONTRACT_VERSION,
  commitRoomStrategyVersionUpgrade,
  hashRoomValue,
  type EvaluateRoomStrategyVersionPinningInputV1,
  type RoomStrategyCompatibilityContractV1,
  type RoomStrategyRuntimeSnapshotV1,
  type RoomStrategySettledTurnBoundaryV1,
  type RoomStrategyUpgradeAuthorizationV1,
  type RoomStrategyUpgradeIndependentEvidenceV1,
  type RoomStrategyVersionPinV1,
  type RoomStrategyVersionPinningIssueV1,
  type RoomStrategyVersionReferenceV1,
  type RoomStrategyVersionUpgradeAppendAckV1,
  type RoomStrategyVersionUpgradeRecordV1,
} from "@fusion/core";

export const ROOM_STRATEGY_VERSION_RUNTIME_COORDINATOR_CONTRACT_VERSION = 1 as const;

type ProjectId = RoomStrategyRuntimeSnapshotV1["projectId"];
type RoomId = RoomStrategyRuntimeSnapshotV1["roomId"];

/**
 * FNXC:RoomStrategyRuntime 2026-07-19-16:04:
 * Runtime starts and upgrades must source strategy state from durable read ports, so callers can only name
 * a Room, an expected version, and an already-recorded target. Active turns, stale state, self-invented
 * strategy data, and inexact append acknowledgements must withhold the runtime action.
 */
export interface RoomStrategyVersionRuntimeStartInputV1 {
  readonly contractVersion: typeof ROOM_STRATEGY_VERSION_RUNTIME_COORDINATOR_CONTRACT_VERSION;
  readonly startId: string;
  readonly projectId: ProjectId;
  readonly roomId: RoomId;
  readonly strategyVersionId: string;
  readonly expectedAggregateVersion: number;
  readonly requestedAt: string;
}

export interface RoomStrategyVersionRuntimeUpgradeInputV1 {
  readonly contractVersion: typeof ROOM_STRATEGY_VERSION_RUNTIME_COORDINATOR_CONTRACT_VERSION;
  readonly upgradeId: string;
  readonly projectId: ProjectId;
  readonly roomId: RoomId;
  readonly targetStrategyVersionId: string;
  readonly expectedPinVersion: number;
  readonly expectedAggregateVersion: number;
  readonly requestedAt: string;
}

export interface RoomStrategyVersionRuntimeStartContextV1 {
  readonly contractVersion: typeof ROOM_STRATEGY_VERSION_RUNTIME_COORDINATOR_CONTRACT_VERSION;
  readonly room: RoomStrategyRuntimeSnapshotV1;
  readonly currentPin: RoomStrategyVersionPinV1 | null;
  readonly strategy: RoomStrategyVersionReferenceV1;
}

export interface RoomStrategyVersionRuntimeUpgradeContextV1 {
  readonly contractVersion: typeof ROOM_STRATEGY_VERSION_RUNTIME_COORDINATOR_CONTRACT_VERSION;
  readonly room: RoomStrategyRuntimeSnapshotV1;
  readonly currentPin: RoomStrategyVersionPinV1;
  readonly targetStrategy: RoomStrategyVersionReferenceV1;
  readonly turnBoundary: RoomStrategySettledTurnBoundaryV1;
  readonly compatibility: RoomStrategyCompatibilityContractV1;
  readonly authorization: RoomStrategyUpgradeAuthorizationV1;
  readonly independentEvidence: readonly RoomStrategyUpgradeIndependentEvidenceV1[];
}

export interface RoomStrategyVersionRuntimeReadPortV1 {
  readStartContext(
    input: RoomStrategyVersionRuntimeStartInputV1,
  ): Promise<RoomStrategyVersionRuntimeStartContextV1 | null>;
  readRecordedUpgradeContext(
    input: RoomStrategyVersionRuntimeUpgradeInputV1,
  ): Promise<RoomStrategyVersionRuntimeUpgradeContextV1 | null>;
}

export interface RoomStrategyVersionRuntimeInitialPinRecordV1 {
  readonly contractVersion: typeof ROOM_STRATEGY_VERSION_RUNTIME_COORDINATOR_CONTRACT_VERSION;
  readonly recordId: string;
  readonly recordHash: string;
  readonly projectId: ProjectId;
  readonly roomId: RoomId;
  readonly pin: RoomStrategyVersionPinV1;
  readonly promotionDecisionId: string;
  readonly recordedAt: string;
}

export interface RoomStrategyVersionRuntimeInitialPinAppendAckV1 {
  readonly status: "recorded";
  readonly recordId: string;
  readonly recordHash: string;
}

export interface RoomStrategyVersionRuntimeAppendPortV1 {
  appendInitialPin(
    record: RoomStrategyVersionRuntimeInitialPinRecordV1,
  ): Promise<RoomStrategyVersionRuntimeInitialPinAppendAckV1>;
  appendUpgrade(
    record: RoomStrategyVersionUpgradeRecordV1,
  ): Promise<RoomStrategyVersionUpgradeAppendAckV1>;
}

export interface RoomStrategyVersionRuntimeCoordinatorDependenciesV1 {
  readonly reader: RoomStrategyVersionRuntimeReadPortV1;
  readonly appendPort: RoomStrategyVersionRuntimeAppendPortV1;
}

export type RoomStrategyVersionRuntimeWithheldCodeV1 =
  | "invalid_input"
  | "dependency_unavailable"
  | "read_unavailable"
  | "read_failed"
  | "scope_mismatch"
  | "version_conflict"
  | "turn_not_settled"
  | "existing_pin_present"
  | "strategy_not_promoted"
  | "initial_pin_append_failed"
  | "initial_pin_ack_mismatch"
  | "core_rejected"
  | "append_ack_mismatch"
  | "upgrade_append_failed";

export interface RoomStrategyVersionRuntimeWithheldReasonV1 {
  readonly code: RoomStrategyVersionRuntimeWithheldCodeV1;
  readonly message: string;
}

export type RoomStrategyVersionRuntimeStartResultV1 =
  | {
    readonly status: "accepted";
    readonly pin: RoomStrategyVersionPinV1;
    readonly record: RoomStrategyVersionRuntimeInitialPinRecordV1;
  }
  | {
    readonly status: "withheld";
    readonly reason: RoomStrategyVersionRuntimeWithheldReasonV1;
  };

export type RoomStrategyVersionRuntimeUpgradeResultV1 =
  | {
    readonly status: "accepted";
    readonly record: RoomStrategyVersionUpgradeRecordV1;
  }
  | {
    readonly status: "withheld";
    readonly reason: RoomStrategyVersionRuntimeWithheldReasonV1;
    readonly issues?: readonly RoomStrategyVersionPinningIssueV1[];
  };

export class RoomStrategyVersionRuntimeCoordinator {
  public constructor(
    private readonly dependencies: RoomStrategyVersionRuntimeCoordinatorDependenciesV1,
  ) {}

  public async startPinnedRoom(
    input: RoomStrategyVersionRuntimeStartInputV1,
  ): Promise<RoomStrategyVersionRuntimeStartResultV1> {
    const normalized = normalizeStartInput(input);
    if (normalized === null) {
      return startWithheld("invalid_input", "Starting a Room requires an exact v1 start command.");
    }
    const reader = this.readPort();
    const appendPort = this.appendPort();
    if (reader === null || appendPort === null) {
      return startWithheld("dependency_unavailable", "Starting a Room requires injected read and append ports.");
    }

    let context: RoomStrategyVersionRuntimeStartContextV1 | null;
    try {
      context = await reader.readStartContext(normalized);
    } catch {
      return startWithheld("read_failed", "The durable start context could not be read.");
    }
    if (context === null) {
      return startWithheld("read_unavailable", "No durable start context is available for this Room and strategy.");
    }
    if (!isStartContext(context)) {
      return startWithheld("invalid_input", "The durable start context does not satisfy the v1 contract.");
    }
    const contextFailure = validateStartContext(normalized, context);
    if (contextFailure !== null) return contextFailure;
    const promotionDecisionId = context.strategy.promotionDecisionId;
    if (promotionDecisionId === null) {
      return startWithheld("strategy_not_promoted", "A Room may only start with a strategy that has a recorded promotion decision.");
    }

    const pin = freeze({
      projectId: normalized.projectId,
      roomId: normalized.roomId,
      pinVersion: 1,
      aggregateVersion: context.room.aggregateVersion,
      strategy: copyStrategy(context.strategy),
      pinnedAt: normalized.requestedAt,
    });
    const recordWithoutHash = {
      contractVersion: ROOM_STRATEGY_VERSION_RUNTIME_COORDINATOR_CONTRACT_VERSION,
      recordId: normalized.startId,
      projectId: normalized.projectId,
      roomId: normalized.roomId,
      pin,
      promotionDecisionId,
      recordedAt: normalized.requestedAt,
    };
    const record = freeze({
      ...recordWithoutHash,
      recordHash: hashRoomValue(recordWithoutHash),
    });
    try {
      const acknowledgement = await appendPort.appendInitialPin(record);
      if (!isExactInitialPinAcknowledgement(acknowledgement, record)) {
        return startWithheld(
          "initial_pin_ack_mismatch",
          "The initial strategy pin append did not acknowledge the exact immutable record.",
        );
      }
    } catch {
      return startWithheld(
        "initial_pin_append_failed",
        "The initial strategy pin was not reported accepted because its durable append failed.",
      );
    }
    return freeze({ status: "accepted" as const, pin, record });
  }

  public async requestRecordedUpgrade(
    input: RoomStrategyVersionRuntimeUpgradeInputV1,
  ): Promise<RoomStrategyVersionRuntimeUpgradeResultV1> {
    const normalized = normalizeUpgradeInput(input);
    if (normalized === null) {
      return upgradeWithheld("invalid_input", "A strategy upgrade requires an exact v1 upgrade command.");
    }
    const reader = this.readPort();
    const appendPort = this.appendPort();
    if (reader === null || appendPort === null) {
      return upgradeWithheld("dependency_unavailable", "A strategy upgrade requires injected read and append ports.");
    }

    let context: RoomStrategyVersionRuntimeUpgradeContextV1 | null;
    try {
      context = await reader.readRecordedUpgradeContext(normalized);
    } catch {
      return upgradeWithheld("read_failed", "The recorded strategy upgrade context could not be read.");
    }
    if (context === null) {
      return upgradeWithheld("read_unavailable", "No recorded compatible upgrade context is available for this Room.");
    }
    if (!isUpgradeContext(context)) {
      return upgradeWithheld("invalid_input", "The recorded strategy upgrade context does not satisfy the v1 contract.");
    }
    const contextFailure = validateUpgradeContext(normalized, context);
    if (contextFailure !== null) return contextFailure;

    const coreInput = toCoreUpgradeInput(normalized, context);
    try {
      const committed = await commitRoomStrategyVersionUpgrade({
        input: coreInput,
        appendPort: {
          append: (record) => appendPort.appendUpgrade(record),
        },
      });
      if (committed.ok) {
        return freeze({ status: "accepted" as const, record: freeze(structuredClone(committed.record)) });
      }
      if ("issues" in committed) {
        return freeze({
          status: "withheld" as const,
          reason: freeze({
            code: "core_rejected" as const,
            message: "Core RoomStrategyVersionPinning rejected the recorded upgrade context.",
          }),
          issues: freeze(committed.issues.map((issue) => freeze({ ...issue }))),
        });
      }
      {
        const reason = committed.reason;
        return upgradeWithheld(
          reason.code === "append_ack_mismatch" ? "append_ack_mismatch" : "upgrade_append_failed",
          reason.message,
        );
      }
    } catch {
      return upgradeWithheld(
        "upgrade_append_failed",
        "The strategy upgrade was not reported accepted because its durable append failed.",
      );
    }
  }

  private readPort(): RoomStrategyVersionRuntimeReadPortV1 | null {
    const reader = this.dependencies?.reader;
    return reader !== undefined
      && typeof reader.readStartContext === "function"
      && typeof reader.readRecordedUpgradeContext === "function"
      ? reader
      : null;
  }

  private appendPort(): RoomStrategyVersionRuntimeAppendPortV1 | null {
    const appendPort = this.dependencies?.appendPort;
    return appendPort !== undefined
      && typeof appendPort.appendInitialPin === "function"
      && typeof appendPort.appendUpgrade === "function"
      ? appendPort
      : null;
  }
}

function normalizeStartInput(value: unknown): RoomStrategyVersionRuntimeStartInputV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "contractVersion",
    "startId",
    "projectId",
    "roomId",
    "strategyVersionId",
    "expectedAggregateVersion",
    "requestedAt",
  ])) return null;
  if (
    value.contractVersion !== ROOM_STRATEGY_VERSION_RUNTIME_COORDINATOR_CONTRACT_VERSION
    || !isIdentifier(value.startId)
    || !isIdentifier(value.projectId)
    || !isIdentifier(value.roomId)
    || !isIdentifier(value.strategyVersionId)
    || !isNonNegativeInteger(value.expectedAggregateVersion)
    || !isCanonicalTimestamp(value.requestedAt)
  ) return null;
  return freeze({
    contractVersion: ROOM_STRATEGY_VERSION_RUNTIME_COORDINATOR_CONTRACT_VERSION,
    startId: value.startId,
    projectId: value.projectId as ProjectId,
    roomId: value.roomId as RoomId,
    strategyVersionId: value.strategyVersionId,
    expectedAggregateVersion: value.expectedAggregateVersion,
    requestedAt: value.requestedAt,
  });
}

function normalizeUpgradeInput(value: unknown): RoomStrategyVersionRuntimeUpgradeInputV1 | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    "contractVersion",
    "upgradeId",
    "projectId",
    "roomId",
    "targetStrategyVersionId",
    "expectedPinVersion",
    "expectedAggregateVersion",
    "requestedAt",
  ])) return null;
  if (
    value.contractVersion !== ROOM_STRATEGY_VERSION_RUNTIME_COORDINATOR_CONTRACT_VERSION
    || !isIdentifier(value.upgradeId)
    || !isIdentifier(value.projectId)
    || !isIdentifier(value.roomId)
    || !isIdentifier(value.targetStrategyVersionId)
    || !isPositiveInteger(value.expectedPinVersion)
    || !isNonNegativeInteger(value.expectedAggregateVersion)
    || !isCanonicalTimestamp(value.requestedAt)
  ) return null;
  return freeze({
    contractVersion: ROOM_STRATEGY_VERSION_RUNTIME_COORDINATOR_CONTRACT_VERSION,
    upgradeId: value.upgradeId,
    projectId: value.projectId as ProjectId,
    roomId: value.roomId as RoomId,
    targetStrategyVersionId: value.targetStrategyVersionId,
    expectedPinVersion: value.expectedPinVersion,
    expectedAggregateVersion: value.expectedAggregateVersion,
    requestedAt: value.requestedAt,
  });
}

function validateStartContext(
  input: RoomStrategyVersionRuntimeStartInputV1,
  context: RoomStrategyVersionRuntimeStartContextV1,
): RoomStrategyVersionRuntimeStartResultV1 | null {
  if (context.room.projectId !== input.projectId || context.room.roomId !== input.roomId || context.strategy.projectId !== input.projectId) {
    return startWithheld("scope_mismatch", "The durable strategy start context is not bound to the requested project and Room.");
  }
  if (context.room.aggregateVersion !== input.expectedAggregateVersion) {
    return startWithheld("version_conflict", "The durable Room aggregate version no longer matches the requested start version.");
  }
  if (context.room.activeTurnId !== null) {
    return startWithheld("turn_not_settled", "A Room may only start its first strategy pin before an active turn exists.");
  }
  if (context.currentPin !== null) {
    return startWithheld("existing_pin_present", "The durable Room already has a strategy pin; startup cannot silently replace it.");
  }
  if (context.strategy.strategyVersionId !== input.strategyVersionId) {
    return startWithheld("scope_mismatch", "The durable strategy does not match the requested strategy version.");
  }
  if (
    context.strategy.promotionState !== "promoted"
    || context.strategy.promotionDecisionId === null
    || context.strategy.promotedAt === null
    || Date.parse(context.strategy.promotedAt) > Date.parse(input.requestedAt)
  ) {
    return startWithheld("strategy_not_promoted", "A Room may only start with an already-promoted immutable strategy.");
  }
  return null;
}

function validateUpgradeContext(
  input: RoomStrategyVersionRuntimeUpgradeInputV1,
  context: RoomStrategyVersionRuntimeUpgradeContextV1,
): RoomStrategyVersionRuntimeUpgradeResultV1 | null {
  if (
    context.room.projectId !== input.projectId
    || context.room.roomId !== input.roomId
    || context.currentPin.projectId !== input.projectId
    || context.currentPin.roomId !== input.roomId
    || context.currentPin.strategy.projectId !== input.projectId
    || context.targetStrategy.projectId !== input.projectId
    || context.targetStrategy.strategyVersionId !== input.targetStrategyVersionId
    || context.turnBoundary.projectId !== input.projectId
    || context.turnBoundary.roomId !== input.roomId
    || !isBoundToScope(context.compatibility, input.projectId, input.roomId)
    || !isBoundToScope(context.authorization, input.projectId, input.roomId)
    || context.independentEvidence.some((evidence) => !isBoundToScope(evidence, input.projectId, input.roomId))
  ) {
    return upgradeWithheld("scope_mismatch", "The recorded upgrade context is not bound to the requested project and Room.");
  }
  if (
    context.room.aggregateVersion !== input.expectedAggregateVersion
    || context.currentPin.pinVersion !== input.expectedPinVersion
    || context.currentPin.aggregateVersion !== context.room.aggregateVersion
    || context.turnBoundary.aggregateVersion !== context.room.aggregateVersion
  ) {
    return upgradeWithheld("version_conflict", "The recorded upgrade context no longer matches the requested Room or pin version.");
  }
  if (
    context.room.activeTurnId !== null
    || context.turnBoundary.activeTurnId !== null
    || Date.parse(context.turnBoundary.settledAt) > Date.parse(input.requestedAt)
  ) {
    return upgradeWithheld("turn_not_settled", "A strategy upgrade may only activate after an already-settled Room turn.");
  }
  if (!isPromotedImmutable(context.currentPin.strategy) || !isPromotedImmutable(context.targetStrategy)) {
    return upgradeWithheld("strategy_not_promoted", "Current and target Room strategies must both be promoted immutable versions.");
  }
  return null;
}

function toCoreUpgradeInput(
  input: RoomStrategyVersionRuntimeUpgradeInputV1,
  context: RoomStrategyVersionRuntimeUpgradeContextV1,
): EvaluateRoomStrategyVersionPinningInputV1 {
  return freeze({
    contractVersion: ROOM_STRATEGY_VERSION_PINNING_CONTRACT_VERSION,
    asOf: input.requestedAt,
    room: copyRuntimeSnapshot(context.room),
    currentPin: copyPin(context.currentPin),
    request: freeze({
      upgradeId: input.upgradeId,
      projectId: input.projectId,
      roomId: input.roomId,
      expectedPinVersion: input.expectedPinVersion,
      expectedAggregateVersion: input.expectedAggregateVersion,
      requestedAt: input.requestedAt,
      targetStrategy: copyStrategy(context.targetStrategy),
      rollbackTarget: copyStrategy(context.currentPin.strategy),
    }),
    turnBoundary: freeze(structuredClone(context.turnBoundary)),
    compatibility: freeze(structuredClone(context.compatibility)),
    authorization: freeze(structuredClone(context.authorization)),
    independentEvidence: freeze(context.independentEvidence.map((evidence) => freeze(structuredClone(evidence)))),
  });
}

function isStartContext(value: unknown): value is RoomStrategyVersionRuntimeStartContextV1 {
  return isRecord(value)
    && value.contractVersion === ROOM_STRATEGY_VERSION_RUNTIME_COORDINATOR_CONTRACT_VERSION
    && isRuntimeSnapshot(value.room)
    && (value.currentPin === null || isPin(value.currentPin))
    && isStrategy(value.strategy);
}

function isUpgradeContext(value: unknown): value is RoomStrategyVersionRuntimeUpgradeContextV1 {
  return isRecord(value)
    && value.contractVersion === ROOM_STRATEGY_VERSION_RUNTIME_COORDINATOR_CONTRACT_VERSION
    && isRuntimeSnapshot(value.room)
    && isPin(value.currentPin)
    && isStrategy(value.targetStrategy)
    && isSettledTurnBoundary(value.turnBoundary)
    && isRecord(value.compatibility)
    && isRecord(value.authorization)
    && Array.isArray(value.independentEvidence)
    && value.independentEvidence.every(isRecord);
}

function isRuntimeSnapshot(value: unknown): value is RoomStrategyRuntimeSnapshotV1 {
  return isRecord(value)
    && isIdentifier(value.projectId)
    && isIdentifier(value.roomId)
    && isNonNegativeInteger(value.aggregateVersion)
    && (value.activeTurnId === null || isIdentifier(value.activeTurnId));
}

function isPin(value: unknown): value is RoomStrategyVersionPinV1 {
  return isRecord(value)
    && isIdentifier(value.projectId)
    && isIdentifier(value.roomId)
    && isPositiveInteger(value.pinVersion)
    && isNonNegativeInteger(value.aggregateVersion)
    && isStrategy(value.strategy)
    && isCanonicalTimestamp(value.pinnedAt);
}

function isStrategy(value: unknown): value is RoomStrategyVersionReferenceV1 {
  return isRecord(value)
    && isIdentifier(value.strategyVersionId)
    && isIdentifier(value.projectId)
    && isHash(value.immutableContentHash)
    && isPromotionState(value.promotionState)
    && (value.promotionDecisionId === null || isIdentifier(value.promotionDecisionId))
    && isIdentifier(value.producerActorId)
    && (value.promotedAt === null || isCanonicalTimestamp(value.promotedAt));
}

function isSettledTurnBoundary(value: unknown): value is RoomStrategySettledTurnBoundaryV1 {
  return isRecord(value)
    && isIdentifier(value.projectId)
    && isIdentifier(value.roomId)
    && isNonNegativeInteger(value.aggregateVersion)
    && value.activeTurnId === null
    && isIdentifier(value.settledTurnId)
    && (value.state === "completed" || value.state === "cancelled" || value.state === "uncertain")
    && isCanonicalTimestamp(value.settledAt);
}

function isPromotedImmutable(strategy: RoomStrategyVersionReferenceV1): boolean {
  return strategy.promotionState === "promoted"
    && strategy.promotionDecisionId !== null
    && strategy.promotedAt !== null;
}

function isBoundToScope(value: unknown, projectId: ProjectId, roomId: RoomId): boolean {
  return isRecord(value) && value.projectId === projectId && value.roomId === roomId;
}

function isExactInitialPinAcknowledgement(
  value: unknown,
  record: RoomStrategyVersionRuntimeInitialPinRecordV1,
): value is RoomStrategyVersionRuntimeInitialPinAppendAckV1 {
  return isRecord(value)
    && hasExactKeys(value, ["status", "recordId", "recordHash"])
    && value.status === "recorded"
    && value.recordId === record.recordId
    && value.recordHash === record.recordHash;
}

function copyRuntimeSnapshot(value: RoomStrategyRuntimeSnapshotV1): RoomStrategyRuntimeSnapshotV1 {
  return freeze({ ...value });
}

function copyPin(value: RoomStrategyVersionPinV1): RoomStrategyVersionPinV1 {
  return freeze({ ...value, strategy: copyStrategy(value.strategy) });
}

function copyStrategy(value: RoomStrategyVersionReferenceV1): RoomStrategyVersionReferenceV1 {
  return freeze({ ...value });
}

function startWithheld(
  code: RoomStrategyVersionRuntimeWithheldCodeV1,
  message: string,
): RoomStrategyVersionRuntimeStartResultV1 {
  return freeze({ status: "withheld" as const, reason: freeze({ code, message }) });
}

function upgradeWithheld(
  code: RoomStrategyVersionRuntimeWithheldCodeV1,
  message: string,
): RoomStrategyVersionRuntimeUpgradeResultV1 {
  return freeze({ status: "withheld" as const, reason: freeze({ code, message }) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isPromotionState(value: unknown): value is RoomStrategyVersionReferenceV1["promotionState"] {
  return value === "candidate" || value === "promoted" || value === "rejected" || value === "rolled_back";
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right);
}

function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null) return value;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const nested of Object.values(value)) freeze(nested, seen);
  return Object.freeze(value);
}

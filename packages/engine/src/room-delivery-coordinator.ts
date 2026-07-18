import {
  buildRoomConnectorLocalMessageId,
  hashRoomValue,
  SESSION_CONNECTOR_HISTORY_PAGE_LIMIT,
  type BeginRoomDeliveryAttemptInput,
  type CompleteRoomDeliveryAttemptInput,
  type ReconcileRoomDeliveryInput,
  type RoomBindingRecordV1,
  type RoomOutboxRecordV1,
  type SessionConnectorHistoryItemV1,
  type SessionConnectorIdentityV1,
  type SessionConnectorV1,
} from "@fusion/core";
import { SessionConnectorRegistry } from "./session-connector-registry.js";

export interface RoomDeliveryCoordinatorStore {
  getDelivery(outboxId: string): Promise<RoomOutboxRecordV1 | null>;
  getBinding(bindingId: string): Promise<RoomBindingRecordV1 | null>;
  beginDeliveryAttempt(input: BeginRoomDeliveryAttemptInput): Promise<RoomOutboxRecordV1>;
  completeDeliveryAttempt(input: CompleteRoomDeliveryAttemptInput): Promise<RoomOutboxRecordV1>;
  reconcileDelivery(input: ReconcileRoomDeliveryInput): Promise<RoomOutboxRecordV1>;
}

export interface RoomDeliveryAuditIdentity {
  readonly runId: string;
  readonly agentId: string;
  readonly taskId?: string;
}

/*
FNXC:RoomDeliverySenderFence 2026-07-18-07:29:
Every dispatch must carry the exact active sender lease fence into the durable
claim so a stale or displaced sender cannot begin an external delivery.
*/
export interface DispatchRoomDeliveryInput {
  readonly store: RoomDeliveryCoordinatorStore;
  readonly registry: SessionConnectorRegistry;
  readonly identity: SessionConnectorIdentityV1;
  readonly outboxId: string;
  readonly attemptId: string;
  readonly senderFence: NonNullable<BeginRoomDeliveryAttemptInput["senderFence"]>;
  readonly content: string;
  readonly reconciliationFromCursor: string | null;
  readonly now: string;
  readonly currentTime?: () => string;
  readonly signal?: AbortSignal;
  readonly assertAuthority?: () => Promise<void>;
  readonly audit: RoomDeliveryAuditIdentity;
}

export interface ReconcileAmbiguousRoomDeliveryInput {
  readonly store: RoomDeliveryCoordinatorStore;
  readonly registry: SessionConnectorRegistry;
  readonly identity: SessionConnectorIdentityV1;
  readonly outboxId: string;
  readonly historyPageSize: number;
  readonly maxHistoryPages: number;
  readonly now: string;
  readonly currentTime?: () => string;
  readonly signal?: AbortSignal;
  readonly assertAuthority?: () => Promise<void>;
  readonly audit: RoomDeliveryAuditIdentity;
}

export type RoomDeliveryCoordinatorErrorCode =
  | "delivery_not_found"
  | "delivery_state_conflict"
  | "delivery_identity_conflict"
  | "delivery_payload_conflict"
  | "connector_capability_unverified"
  | "invalid_reconciliation_bound";

export class RoomDeliveryCoordinatorError extends Error {
  constructor(
    readonly code: RoomDeliveryCoordinatorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RoomDeliveryCoordinatorError";
  }
}

/*
FNXC:RoomDeliveryReconciliation 2026-07-17-11:55:
The outbox is claimed before a provider send, and no coordinator retry is
allowed after an ambiguous result. Recovery starts from the pre-send history
cursor and proves one exact stable local-message identity before confirming;
unavailable, bounded, stalled, zero-match, and multi-match history all remain
visible delivery_uncertain states and never trigger send().
*/
export async function dispatchRoomDelivery(
  input: DispatchRoomDeliveryInput,
): Promise<RoomOutboxRecordV1> {
  assertAuditIdentity(input.audit);
  assertOptionalCursor(input.reconciliationFromCursor);
  await assertOperationAuthority(input);
  const delivery = await requireDelivery(input.store, input.outboxId);
  const binding = await requireBinding(input.store, delivery.bindingId);
  assertDispatchIdentity(delivery, binding, input.identity);
  if (delivery.state !== "pending") {
    throw new RoomDeliveryCoordinatorError(
      "delivery_state_conflict",
      `Room delivery ${input.outboxId} cannot dispatch from state ${delivery.state}`,
    );
  }
  if (hashRoomValue(input.content) !== delivery.payloadHash) {
    throw new RoomDeliveryCoordinatorError(
      "delivery_payload_conflict",
      `Room delivery ${input.outboxId} content does not match its durable payload hash`,
    );
  }

  const connector = await input.registry.requireVerified({
    connectorId: binding.connectorId,
    capability: "send",
    identity: input.identity,
    requiredHostId: binding.hostId,
  });

  const claimNow = await assertOperationAuthority(input);
  const claimed = await input.store.beginDeliveryAttempt({
    outboxId: input.outboxId,
    attemptId: input.attemptId,
    senderFence: input.senderFence,
    reconciliationFromCursor: input.reconciliationFromCursor,
    now: claimNow,
  });

  let result: Awaited<ReturnType<SessionConnectorV1["send"]>>;
  await assertOperationAuthority(input);
  try {
    /*
    Once send() starts, cancellation cannot prove that the provider side effect
    did not happen. Keep the worker Promise attached to the bounded connector
    operation and durably persist any late receipt; AbortSignal only fences the
    pre-send boundary and subsequent work.
    */
    result = await connector.send({
      contractVersion: 1,
      bindingId: claimed.bindingId,
      identity: input.identity,
      logicalMessageId: claimed.logicalMessageId,
      localMessageId: claimed.localMessageId,
      idempotencyKey: claimed.idempotencyKey,
      content: input.content,
      contentHash: claimed.payloadHash,
    });
  } catch {
    if (input.signal?.aborted) throw abortError();
    return input.store.completeDeliveryAttempt({
      outboxId: input.outboxId,
      attemptId: input.attemptId,
      outcome: "delivery_uncertain",
      connectorAcknowledgementId: null,
      nativeMessageId: null,
      nativeCursor: null,
      errorCode: "connector_send_exception",
      nextAttemptAt: null,
      now: operationTime(input),
      audit: input.audit,
    });
  }

  if (!result.ok) {
    return input.store.completeDeliveryAttempt({
      outboxId: input.outboxId,
      attemptId: input.attemptId,
      outcome: "delivery_uncertain",
      connectorAcknowledgementId: null,
      nativeMessageId: null,
      nativeCursor: null,
      errorCode: `connector_${result.error.code}`,
      nextAttemptAt: null,
      now: operationTime(input),
      audit: input.audit,
    });
  }

  const receipt = result.value;
  if (receipt.outcome === "rejected") {
    return input.store.completeDeliveryAttempt({
      outboxId: input.outboxId,
      attemptId: input.attemptId,
      outcome: "rejected",
      connectorAcknowledgementId: receipt.connectorAcknowledgementId,
      nativeMessageId: receipt.nativeMessageId,
      nativeCursor: receipt.cursor,
      errorCode: "connector_rejected",
      nextAttemptAt: null,
      now: operationTime(input),
      audit: input.audit,
    });
  }

  const hasAcceptanceEvidence = Boolean(
    receipt.connectorAcknowledgementId || receipt.nativeMessageId || receipt.cursor,
  );
  const confirmed = (receipt.outcome === "accepted" || receipt.outcome === "confirmed")
    && hasAcceptanceEvidence;
  return input.store.completeDeliveryAttempt({
    outboxId: input.outboxId,
    attemptId: input.attemptId,
    outcome: confirmed ? "confirmed" : "delivery_uncertain",
    connectorAcknowledgementId: receipt.connectorAcknowledgementId,
    nativeMessageId: receipt.nativeMessageId,
    nativeCursor: receipt.cursor,
    errorCode: confirmed ? null : "connector_delivery_uncertain",
    nextAttemptAt: null,
    now: operationTime(input),
    audit: input.audit,
  });
}

export async function reconcileAmbiguousRoomDelivery(
  input: ReconcileAmbiguousRoomDeliveryInput,
): Promise<RoomOutboxRecordV1> {
  assertAuditIdentity(input.audit);
  await assertOperationAuthority(input);
  assertBoundedPositiveInteger(
    input.historyPageSize,
    "historyPageSize",
    SESSION_CONNECTOR_HISTORY_PAGE_LIMIT,
  );
  assertBoundedPositiveInteger(input.maxHistoryPages, "maxHistoryPages", 100);

  const delivery = await requireDelivery(input.store, input.outboxId);
  const binding = await requireBinding(input.store, delivery.bindingId);
  assertDispatchIdentity(delivery, binding, input.identity);
  if (delivery.state === "confirmed") return delivery;
  if (delivery.state !== "dispatching" && delivery.state !== "delivery_uncertain") {
    throw new RoomDeliveryCoordinatorError(
      "delivery_state_conflict",
      `Room delivery ${input.outboxId} cannot reconcile from state ${delivery.state}`,
    );
  }

  let connector: SessionConnectorV1;
  try {
    connector = await input.registry.requireVerified({
      connectorId: binding.connectorId,
      capability: "history",
      identity: input.identity,
      requiredHostId: binding.hostId,
    });
  } catch {
    return persistUncertainReconciliation(input, delivery, "history_capability_unavailable", {});
  }

  const matches = new Map<string, SessionConnectorHistoryItemV1>();
  const visitedCursors = new Set<string | null>();
  let cursor = delivery.reconciliationFromCursor;
  let exhausted = false;
  let lastCompleteCursor: string | null = cursor;

  for (let pageNumber = 0; pageNumber < input.maxHistoryPages; pageNumber += 1) {
    if (visitedCursors.has(cursor)) {
      return persistUncertainReconciliation(input, delivery, "history_cursor_stalled", {
        pageNumber,
        cursor,
      });
    }
    visitedCursors.add(cursor);

    let pageResult: Awaited<ReturnType<SessionConnectorV1["readHistory"]>>;
    await assertOperationAuthority(input);
    try {
      pageResult = await raceConnectorOperation(connector.readHistory({
        contractVersion: 1,
        identity: input.identity,
        afterCursor: cursor,
        limit: input.historyPageSize,
      }), input.signal);
    } catch {
      if (input.signal?.aborted) throw abortError();
      return persistUncertainReconciliation(input, delivery, "history_read_exception", {
        pageNumber,
        cursor,
      });
    }
    if (!pageResult.ok) {
      return persistUncertainReconciliation(input, delivery, `history_${pageResult.error.code}`, {
        pageNumber,
        cursor,
        retryable: pageResult.error.retryable,
      });
    }

    for (const item of pageResult.value.items) {
      if (
        (item.role === "user" || item.role === "unknown")
        && item.logicalMessageId === delivery.localMessageId
      ) {
        matches.set(item.nativeMessageId, item);
      }
    }
    lastCompleteCursor = pageResult.value.completeThroughCursor;
    if (pageResult.value.truncated !== true) {
      exhausted = true;
      break;
    }
    if (pageResult.value.nextCursor === cursor || pageResult.value.nextCursor === null) {
      return persistUncertainReconciliation(input, delivery, "history_cursor_stalled", {
        pageNumber,
        cursor,
        nextCursor: pageResult.value.nextCursor,
      });
    }
    cursor = pageResult.value.nextCursor;
  }

  if (!exhausted) {
    return persistUncertainReconciliation(input, delivery, "history_reconciliation_limit", {
      maxHistoryPages: input.maxHistoryPages,
      lastCompleteCursor,
      matchCount: matches.size,
    });
  }
  if (matches.size !== 1) {
    return persistUncertainReconciliation(
      input,
      delivery,
      matches.size === 0 ? "history_match_not_found" : "ambiguous_history_match",
      { matchCount: matches.size, lastCompleteCursor },
    );
  }

  const match = matches.values().next().value!;
  const evidenceRef = buildReconciliationEvidenceRef(delivery, "confirmed", {
    nativeMessageId: match.nativeMessageId,
    cursor: match.cursor,
    occurredAt: match.occurredAt,
    historyContentHash: match.contentHash,
  });
  return input.store.reconcileDelivery({
    outboxId: input.outboxId,
    expectedAttemptCount: delivery.attemptCount,
    outcome: "confirmed",
    connectorAcknowledgementId: delivery.connectorAcknowledgementId,
    nativeMessageId: match.nativeMessageId,
    nativeCursor: match.cursor,
    errorCode: null,
    evidenceRef,
    now: operationTime(input),
    audit: input.audit,
  });
}

type ControlledConnectorOperation = {
  readonly now: string;
  readonly currentTime?: () => string;
  readonly signal?: AbortSignal;
  readonly assertAuthority?: () => Promise<void>;
};

async function assertOperationAuthority(input: ControlledConnectorOperation): Promise<string> {
  throwIfAborted(input.signal);
  await input.assertAuthority?.();
  throwIfAborted(input.signal);
  return operationTime(input);
}

function operationTime(input: ControlledConnectorOperation): string {
  const now = input.currentTime?.() ?? input.now;
  const parsed = Date.parse(now);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== now) {
    throw new RoomDeliveryCoordinatorError(
      "delivery_state_conflict",
      `Room delivery operation clock returned invalid timestamp ${now}`,
    );
  }
  return now;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error("Room connector operation aborted");
  error.name = "AbortError";
  return error;
}

async function raceConnectorOperation<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return operation;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let abortTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      if (abortTimer) clearTimeout(abortTimer);
    };
    const onAbort = () => {
      // Give a receipt that settled in the aborting turn one microtask checkpoint
      // to win. Otherwise abandon the wait and leave the durable dispatching row
      // for history reconciliation; never synthesize a rejection or retry send.
      abortTimer = setTimeout(() => {
        cleanup();
        reject(abortError());
      }, 0);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then((value) => {
      cleanup();
      resolve(value);
    }, (error: unknown) => {
      cleanup();
      reject(error);
    });
  });
}

async function persistUncertainReconciliation(
  input: ReconcileAmbiguousRoomDeliveryInput,
  delivery: RoomOutboxRecordV1,
  errorCode: string,
  details: Readonly<Record<string, unknown>>,
): Promise<RoomOutboxRecordV1> {
  return input.store.reconcileDelivery({
    outboxId: input.outboxId,
    expectedAttemptCount: delivery.attemptCount,
    outcome: "delivery_uncertain",
    connectorAcknowledgementId: delivery.connectorAcknowledgementId,
    nativeMessageId: delivery.nativeMessageId,
    nativeCursor: delivery.nativeCursor,
    errorCode,
    evidenceRef: buildReconciliationEvidenceRef(delivery, errorCode, details),
    now: operationTime(input),
    audit: input.audit,
  });
}

async function requireDelivery(
  store: RoomDeliveryCoordinatorStore,
  outboxId: string,
): Promise<RoomOutboxRecordV1> {
  const delivery = await store.getDelivery(outboxId);
  if (!delivery) {
    throw new RoomDeliveryCoordinatorError(
      "delivery_not_found",
      `Room delivery ${outboxId} does not exist`,
    );
  }
  return delivery;
}

async function requireBinding(
  store: RoomDeliveryCoordinatorStore,
  bindingId: string,
): Promise<RoomBindingRecordV1> {
  const binding = await store.getBinding(bindingId);
  if (!binding) {
    throw new RoomDeliveryCoordinatorError(
      "delivery_identity_conflict",
      `Room delivery binding ${bindingId} does not exist`,
    );
  }
  return binding;
}

function assertDispatchIdentity(
  delivery: RoomOutboxRecordV1,
  binding: RoomBindingRecordV1,
  identity: SessionConnectorIdentityV1,
): void {
  const expectedLocalMessageId = buildRoomConnectorLocalMessageId({
    logicalMessageId: delivery.logicalMessageId,
    bindingId: delivery.bindingId,
    idempotencyKey: delivery.idempotencyKey,
    payloadHash: delivery.payloadHash,
  });
  if (delivery.localMessageId !== expectedLocalMessageId) {
    throw new RoomDeliveryCoordinatorError(
      "delivery_identity_conflict",
      `Room delivery ${delivery.id} has a non-canonical local message identity`,
    );
  }
  const missingRequiredMachineIdentity = binding.connectorId === "happier"
    && (!binding.machineId?.trim() || !identity.machineId?.trim());
  if (
    binding.id !== delivery.bindingId
    || binding.roomId !== delivery.roomId
    || identity.connectorId !== binding.connectorId
    || identity.providerId !== binding.providerId
    || identity.nativeSessionId !== binding.nativeSessionId
    || identity.happierSessionId !== binding.happierSessionId
    || identity.serverProfileId !== binding.serverProfileId
    || identity.machineId !== binding.machineId
    || identity.hostId !== binding.hostId
    || missingRequiredMachineIdentity
  ) {
    throw new RoomDeliveryCoordinatorError(
      "delivery_identity_conflict",
      `Room delivery ${delivery.id} identity does not match its immutable binding`,
    );
  }
}

function assertBoundedPositiveInteger(value: number, name: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RoomDeliveryCoordinatorError(
      "invalid_reconciliation_bound",
      `${name} must be a positive safe integer no greater than ${maximum}`,
    );
  }
}

function assertAuditIdentity(audit: RoomDeliveryAuditIdentity): void {
  if (!audit.runId.trim() || !audit.agentId.trim()) {
    throw new RoomDeliveryCoordinatorError(
      "delivery_identity_conflict",
      "Room delivery requires non-empty run and agent audit identity",
    );
  }
}

function assertOptionalCursor(cursor: string | null): void {
  if (cursor !== null && cursor.trim().length === 0) {
    throw new RoomDeliveryCoordinatorError(
      "delivery_identity_conflict",
      "Room delivery reconciliation cursor cannot be blank",
    );
  }
}

function buildReconciliationEvidenceRef(
  delivery: RoomOutboxRecordV1,
  outcome: string,
  details: Readonly<Record<string, unknown>>,
): string {
  return `room-history:${hashRoomValue(JSON.stringify({
    contractVersion: 1,
    outboxId: delivery.id,
    bindingId: delivery.bindingId,
    logicalMessageId: delivery.logicalMessageId,
    localMessageId: delivery.localMessageId,
    payloadHash: delivery.payloadHash,
    reconciliationFromCursor: delivery.reconciliationFromCursor,
    outcome,
    details,
  }))}`;
}

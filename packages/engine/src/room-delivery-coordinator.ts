import {
  buildRoomConnectorLocalMessageId,
  hashRoomValue,
  SESSION_CONNECTOR_HISTORY_PAGE_LIMIT,
  type BeginRoomDeliveryAttemptInput,
  type CompleteRoomDeliveryAttemptInput,
  type DeferPendingRoomDeliveryInput,
  type ReconcileRoomDeliveryInput,
  type RoomBindingRecordV1,
  type RoomOutboxRecordV1,
  type RoomProviderBackpressureCleanupActions,
  type SessionConnectorHistoryItemV1,
  type SessionConnectorIdentityV1,
  type SessionConnectorResultV1,
  type SessionConnectorSendReceiptV1,
  type SessionConnectorSendRequestV1,
  type SessionConnectorV1,
} from "@fusion/core";
import {
  admitRoomProviderBackpressureConnectorSend,
  createRoomProviderBackpressureSendRequestBinding,
  hashRoomProviderBackpressureSendRequestBinding,
  revalidateAdmittedRoomProviderBackpressureConnectorSend,
  RoomProviderBackpressureGateTimeoutError,
  type RoomProviderBackpressureLateNoPermitOutcomeV1,
  type RoomProviderBackpressureSendCompletionV1,
  type RoomProviderBackpressureSendGateV1,
  type RoomProviderBackpressureSendGateRequestV1,
  type RoomProviderBackpressureSendPermitV1,
} from "./room-provider-backpressure-send-boundary.js";
import { isCoreSenderFencedRecoveryGate } from "./room-provider-backpressure-delivery-gate.js";
import { SessionConnectorRegistry } from "./session-connector-registry.js";

const DEFAULT_PROVIDER_BACKPRESSURE_GATE_DEADLINE_MS = 10_000;
const MAX_PROVIDER_BACKPRESSURE_GATE_DEADLINE_MS = 60_000;
const DEFAULT_PROVIDER_BACKPRESSURE_DEFER_RETRY_AFTER_MS = 1_000;
const MAX_PROVIDER_BACKPRESSURE_DEFER_RETRY_AFTER_MS = 60_000;
const DEFAULT_HISTORY_READ_DEADLINE_MS = 15_000;
const MAX_HISTORY_READ_DEADLINE_MS = 60_000;

export interface RoomDeliveryCoordinatorStore {
  getDelivery(outboxId: string): Promise<RoomOutboxRecordV1 | null>;
  getBinding(bindingId: string): Promise<RoomBindingRecordV1 | null>;
  beginDeliveryAttempt(input: BeginRoomDeliveryAttemptInput): Promise<RoomOutboxRecordV1>;
  deferPendingDelivery(input: DeferPendingRoomDeliveryInput): Promise<RoomOutboxRecordV1>;
  completeDeliveryAttempt(input: CompleteRoomDeliveryAttemptInput): Promise<RoomOutboxRecordV1>;
  reconcileDelivery(input: ReconcileRoomDeliveryInput): Promise<RoomOutboxRecordV1>;
}

export interface RoomDeliveryAuditIdentity {
  readonly runId: string;
  readonly agentId: string;
  readonly taskId?: string;
}

type RoomDeliveryProviderBackpressureCleanupActions =
  Pick<RoomProviderBackpressureCleanupActions, "enqueue" | "fencePendingOutbox">
  & Partial<Pick<
    RoomProviderBackpressureCleanupActions,
    "fencePendingAdmissionTimeout"
    | "bindAdmissionTimeoutReservation"
    | "recordAdmissionTimeoutTerminalOutcome"
  >>;

type RoomProviderAdmissionTimeoutCleanupActions = Pick<
  RoomProviderBackpressureCleanupActions,
  "fencePendingAdmissionTimeout"
  | "bindAdmissionTimeoutReservation"
  | "recordAdmissionTimeoutTerminalOutcome"
  | "fencePendingOutbox"
>;

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
  /*
  FNXC:RoomProviderBackpressureSendBoundary 2026-07-19-20:06:
  Provider enforcement remains opt-in until ProjectEngine can supply a complete
  Core-backed account/model/node authority and durable defer transition. Missing
  injection is visible integration debt, not evidence that provider limits are
  enforced; when injected, every admission gets a bounded deadline and signal.
  */
  readonly providerBackpressure?: RoomProviderBackpressureSendGateV1;
  readonly providerBackpressureDeadlineMs?: number;
  /**
   * Durable evidence sink for a reservation that failed pre-send cleanup. It
   * remains optional for legacy gates, but a configured sink must include the
   * project scope needed by Core to verify the immutable reservation fence.
   */
  readonly providerBackpressureCleanupActions?: RoomDeliveryProviderBackpressureCleanupActions;
  readonly providerBackpressureCleanupContext?: {
    readonly projectId: string;
  };
}

export interface ReconcileAmbiguousRoomDeliveryInput {
  readonly store: RoomDeliveryCoordinatorStore;
  readonly registry: SessionConnectorRegistry;
  readonly identity: SessionConnectorIdentityV1;
  readonly outboxId: string;
  readonly historyPageSize: number;
  readonly maxHistoryPages: number;
  /**
   * Bounds one connector history page so recovery cleanup cannot be held by a
   * connector call that never settles. The underlying connector operation is
   * never treated as a send retry or synthetic acknowledgement.
   */
  readonly historyReadDeadlineMs?: number;
  readonly now: string;
  readonly currentTime?: () => string;
  readonly signal?: AbortSignal;
  readonly assertAuthority?: () => Promise<void>;
  readonly audit: RoomDeliveryAuditIdentity;
}

export interface ReconcileApprovedRoomDeliveryInput {
  readonly store: RoomDeliveryCoordinatorStore; readonly registry: SessionConnectorRegistry;
  readonly identity: SessionConnectorIdentityV1; readonly outboxId: string;
  readonly senderFence: NonNullable<BeginRoomDeliveryAttemptInput["senderFence"]>;
  readonly content: string; readonly now: string; readonly currentTime?: () => string;
  readonly signal?: AbortSignal; readonly assertAuthority?: () => Promise<void>;
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

  /*
  FNXC:RoomProviderSendSafety 2026-07-19-22:31:
  Provider admission identity must be derived from the persisted outbox
  generation, never a process UUID or a worker-local attempt token. A restart
  after a lost persistence response can therefore replay the exact reservation
  request idempotently, while a real durable retry transition advances the
  generation. After a durable claim, provider-only pre-send withholding whose
  reservation cleanup completed can return the exact sender-fenced attempt to
  pending. An unconfirmed cleanup instead remains delivery_uncertain: retrying
  would obtain a fresh admission while the original Core reservation may still
  consume provider capacity. Non-cancellable permit renewal and cleanup are
  bounded; a receipt with acknowledgement evidence remains confirmed if its
  cleanup later times out, with that cleanup evidence recorded separately.
  */
  const deliveryAttemptId = input.providerBackpressure === undefined
    ? input.attemptId
    : createProviderBackpressureDeliveryAttemptId(delivery);
  let providerPermit: RoomProviderBackpressureSendPermitV1 | null = null;
  let providerRequest: RoomProviderBackpressureSendGateRequestV1 | null = null;
  let providerTimeoutFencedDelivery: RoomOutboxRecordV1 | null = null;
  if (input.providerBackpressure) {
    const providerAdmissionAt = operationTime(input);
    const gateDeadline = createProviderBackpressureGateDeadline(input, providerAdmissionAt);
    try {
      const requestBase = {
        contractVersion: 1,
        delivery,
        binding,
        identity: input.identity,
        attemptId: deliveryAttemptId,
        senderFence: input.senderFence,
        asOf: providerAdmissionAt,
        deadline: gateDeadline.deadline,
        signal: gateDeadline.signal,
      } as const;
      const requestBinding = createRoomProviderBackpressureSendRequestBinding(requestBase);
      providerRequest = Object.freeze({
        ...requestBase,
        requestBinding,
        requestHash: hashRoomProviderBackpressureSendRequestBinding(requestBinding),
      });
      const fenceLateAdmittedPermit = async (
        permit: RoomProviderBackpressureSendPermitV1,
        request: RoomProviderBackpressureSendGateRequestV1,
      ): Promise<void> => {
        if (providerTimeoutFencedDelivery === null) {
          await fencePendingProviderBackpressureDelivery(
            input,
            delivery,
            permit,
            "provider_late_admission_unsettled",
          );
        } else {
          await bindTimedOutProviderAdmissionPermit(input, delivery, request, permit);
        }
        await settlePreSendProviderPermit(input, permit, operationTime(input));
      };
      const preflight = await admitRoomProviderBackpressureConnectorSend({
        gate: input.providerBackpressure,
        request: providerRequest,
        onTimeout: async ({ request }) => {
          /*
          FNXC:RoomProviderAdmissionTimeoutTombstone 2026-07-20-23:27:
          A deadline is not a no-permit result. Before timeout can escape as a
          preflight defer, Core must atomically tombstone the stable gate request
          and fence its exact pending outbox generation as delivery_uncertain.
          Returning that committed snapshot, rather than scheduling pending,
          prevents a later dispatcher from racing the original late result.
          */
          providerTimeoutFencedDelivery = await fencePendingProviderAdmissionTimeout(
            input,
            delivery,
            request,
          );
        },
        onLateAdmittedPermit: async ({ permit, request }) => {
          /*
          FNXC:RoomProviderLateAdmissionFence 2026-07-20-22:38:
          A provider may admit after the caller deadline while the original
          outbox is retryable pending. Fence that exact generation before trying
          permit completion: a cleanup stall, callback crash, or later retry
          must never obtain a second admission or connector send. The cleanup
          worker may reopen it only after Core records a terminal action.
          */
          await fenceLateAdmittedPermit(permit, request);
        },
        onLateAdmittedPermitFailure: async ({ permit, request }) => {
          /*
          FNXC:RoomProviderLateAdmissionFenceReplay 2026-07-20-22:46:
          A lost Core response is ambiguous, not a reason to abandon a late
          provider reservation. Replay the same idempotent atomic fence before
          completing the untouched permit; a second failure is escalated by the
          gate boundary and never converted into a retryable normal delivery.
          */
          await fenceLateAdmittedPermit(permit, request);
        },
        onLateNoPermit: async ({ request, outcome }) => {
          /*
          FNXC:RoomProviderAdmissionTimeoutNoPermit 2026-07-20-23:27:
          A valid late defer proves that this exact gate request issued no
          permit. Persist only that immutable proof: DispatchRoomDelivery has
          no cleanup-worker lease and must not reopen the fenced outbox. A
          restart-safe recovery worker may resolve the proof only through
          Core's separately leased recovery contract.
          */
          await recordTimedOutProviderAdmissionNoPermit(input, delivery, request, outcome);
        },
      });
      if (preflight.action === "defer") {
        throwIfAborted(input.signal);
        if (preflight.reason === "provider_gate_timeout") {
          if (providerTimeoutFencedDelivery === null) {
            throw new RoomDeliveryCoordinatorError(
              "delivery_state_conflict",
              "Provider gate timeout returned without its durable Core tombstone snapshot",
            );
          }
          return providerTimeoutFencedDelivery;
        }
        return deferPendingProviderBackpressureDelivery(
          input,
          delivery,
          preflight.reason,
          preflight.retryAfterMs,
        );
      }

      let revalidatedAt: string;
      try {
        throwIfAborted(input.signal);
        revalidatedAt = await assertOperationAuthority(input);
      } catch (error) {
        const cleanupFailure = await settlePreSendProviderPermit(
          input,
          preflight.permit,
          operationTime(input),
        );
        if (cleanupFailure !== null) {
          return fencePendingProviderBackpressureDelivery(
            input,
            delivery,
            preflight.permit,
            cleanupFailure.reason,
          );
        }
        throw error;
      }
      const revalidated = revalidateAdmittedRoomProviderBackpressureConnectorSend({
        permit: preflight.permit,
        request: providerRequest,
        asOf: revalidatedAt,
      });
      if (revalidated.action === "defer") {
        const cleanupFailure = await settlePreSendProviderPermit(input, preflight.permit, revalidatedAt);
        if (cleanupFailure !== null && providerPermitCleanupNeedsDeferredAction(providerErrorCode(cleanupFailure.reason))) {
          return fencePendingProviderBackpressureDelivery(input, delivery, preflight.permit, cleanupFailure.reason);
        }
        return deferPendingProviderBackpressureDelivery(
          input,
          delivery,
          cleanupFailure?.reason ?? revalidated.reason,
          cleanupFailure?.retryAfterMs ?? revalidated.retryAfterMs,
        );
      }
      providerPermit = revalidated.permit;
    } finally {
      gateDeadline.dispose();
    }
  }

  let claimed: RoomOutboxRecordV1;
  try {
    const claimNow = await assertOperationAuthority(input);
    claimed = await input.store.beginDeliveryAttempt({
      outboxId: input.outboxId,
      attemptId: deliveryAttemptId,
      senderFence: input.senderFence,
      reconciliationFromCursor: input.reconciliationFromCursor,
      now: claimNow,
    });
  } catch (error) {
    if (providerPermit) {
      const cleanupFailure = await settlePreSendProviderPermit(input, providerPermit, operationTime(input));
      if (cleanupFailure !== null) {
        return fencePendingProviderBackpressureDelivery(input, delivery, providerPermit, cleanupFailure.reason);
      }
    }
    throw error;
  }

  let result: Awaited<ReturnType<SessionConnectorV1["send"]>>;
  try {
    await assertOperationAuthority(input);
  } catch (error) {
    if (providerPermit !== null) {
      const cleanupFailure = await settlePreSendProviderPermit(input, providerPermit, operationTime(input));
      if (cleanupFailure !== null) {
        return deferClaimedProviderBackpressureDelivery(
          input,
          claimed,
          deliveryAttemptId,
          cleanupFailure.reason,
          cleanupFailure.retryAfterMs,
          providerPermit,
        );
      }
    }
    throw error;
  }
  let providerCleanupFailureReason: string | null = null;
  let providerConnectorSendStarted = false;
  try {
    /*
    Once send() starts, cancellation cannot prove that the provider side effect
    did not happen. Keep the worker Promise attached to the bounded connector
    operation and durably persist any late receipt; AbortSignal only fences the
    pre-send boundary and subsequent work.
    */
    const sendRequest = {
      contractVersion: 1,
      bindingId: claimed.bindingId,
      identity: input.identity,
      logicalMessageId: claimed.logicalMessageId,
      localMessageId: claimed.localMessageId,
      idempotencyKey: claimed.idempotencyKey,
      content: input.content,
      contentHash: claimed.payloadHash,
      deliveryAuthorization: {
        outboxId: claimed.id,
        senderFence: input.senderFence,
      },
    } as const;
    if (providerPermit === null) {
      result = await connector.send(sendRequest);
    } else {
      if (providerRequest === null) {
        const cleanupFailure = await settlePreSendProviderPermit(
          input,
          providerPermit,
          operationTime(input),
        );
        return deferClaimedProviderBackpressureDelivery(
          input,
          claimed,
          deliveryAttemptId,
          cleanupFailure?.reason ?? "provider_request_binding_missing",
          cleanupFailure?.retryAfterMs ?? null,
          providerPermit,
        );
      }
      const renewal = await renewProviderPermitBeforeConnectorSend(
        input,
        providerPermit,
        deliveryAttemptId,
        operationTime(input),
      );
      if (renewal.action === "defer") {
        const cleanupFailure = await settlePreSendProviderPermit(
          input,
          providerPermit,
          operationTime(input),
        );
        return deferClaimedProviderBackpressureDelivery(
          input,
          claimed,
          deliveryAttemptId,
          cleanupFailure?.reason ?? renewal.reason,
          cleanupFailure?.retryAfterMs ?? renewal.retryAfterMs,
          providerPermit,
        );
      }
      /*
      FNXC:RoomProviderRenewalAuthorityFence 2026-07-19-23:45:
      Renewing a provider reservation can await long enough for a sender lease
      takeover or controller cancellation. The pre-renew assertion is no longer
      authority for connector.send; re-check the exact sender fence before the
      final permit validation and compensate the untouched reservation on loss.
      */
      await assertOperationAuthority(input);
      const finalRevalidation = revalidateAdmittedRoomProviderBackpressureConnectorSend({
        permit: providerPermit,
        request: providerRequest,
        asOf: operationTime(input),
      });
      if (finalRevalidation.action === "defer") {
        const cleanupFailure = await settlePreSendProviderPermit(
          input,
          providerPermit,
          operationTime(input),
        );
        return deferClaimedProviderBackpressureDelivery(
          input,
          claimed,
          deliveryAttemptId,
          cleanupFailure?.reason ?? finalRevalidation.reason,
          cleanupFailure?.retryAfterMs ?? finalRevalidation.retryAfterMs,
          providerPermit,
        );
      }

      providerConnectorSendStarted = true;
      result = await connector.send(sendRequest);
      const cleanupFailure = await settleProviderPermit(
        input,
        providerPermit,
        Object.freeze({
          kind: "connector_result" as const,
          completedAt: operationTime(input),
          outcome: result.ok ? result.value.outcome : "error",
          connectorErrorCode: result.ok ? null : result.error.code,
          retryAfterMs: result.ok ? null : result.error.retryAfterMs ?? null,
        }),
      );
      if (cleanupFailure !== null) providerCleanupFailureReason = cleanupFailure.reason;
    }
  } catch (error) {
    if (providerPermit !== null && !providerConnectorSendStarted) {
      const cleanupFailure = await settlePreSendProviderPermit(
        input,
        providerPermit,
        operationTime(input),
      );
      if (cleanupFailure !== null) {
        return deferClaimedProviderBackpressureDelivery(
          input,
          claimed,
          deliveryAttemptId,
          cleanupFailure.reason,
          cleanupFailure.retryAfterMs,
          providerPermit,
        );
      }
      throw error;
    }
    if (providerPermit !== null && providerConnectorSendStarted) {
      const cleanupFailure = await settleProviderPermit(
        input,
        providerPermit,
        Object.freeze({
          kind: "connector_exception" as const,
          completedAt: operationTime(input),
        }),
      );
      if (cleanupFailure !== null) providerCleanupFailureReason = cleanupFailure.reason;
    }
    if (input.signal?.aborted) throw abortError();
    return input.store.completeDeliveryAttempt({
      outboxId: input.outboxId,
      attemptId: deliveryAttemptId,
      senderFence: input.senderFence,
      outcome: "delivery_uncertain",
      connectorAcknowledgementId: null,
      nativeMessageId: null,
      nativeCursor: null,
      errorCode: providerCleanupFailureReason ?? "connector_send_exception",
      nextAttemptAt: null,
      now: operationTime(input),
      audit: input.audit,
    });
  }

  if (!result.ok) {
    /*
    FNXC:RoomDeliveryApproval 2026-07-27-16:10:
    A connector approval artifact acknowledges only a durable waiting state,
    never provider acceptance. Preserve the validated artifact reference on the
    uncertain outbox so restart recovery can invoke an explicit reconciliation;
    malformed or cross-Session safeDetails retain the generic connector error.
    */
    const approval = providerCleanupFailureReason === null
      ? connectorApprovalEvidence(result.error.safeDetails, input.identity)
      : null;
    return input.store.completeDeliveryAttempt({
      outboxId: input.outboxId,
      attemptId: deliveryAttemptId,
      senderFence: input.senderFence,
      outcome: "delivery_uncertain",
      connectorAcknowledgementId: approval?.artifactId ?? null,
      nativeMessageId: null,
      nativeCursor: null,
      errorCode: approval ? "connector_approval_waiting" : `connector_${result.error.code}`,
      nextAttemptAt: null,
      now: operationTime(input),
      audit: input.audit,
    });
  }

  const receipt = result.value;
  if (receipt.outcome === "rejected") {
    return input.store.completeDeliveryAttempt({
      outboxId: input.outboxId,
      attemptId: deliveryAttemptId,
      senderFence: input.senderFence,
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
    attemptId: deliveryAttemptId,
    senderFence: input.senderFence,
    outcome: confirmed ? "confirmed" : "delivery_uncertain",
    connectorAcknowledgementId: receipt.connectorAcknowledgementId,
    nativeMessageId: receipt.nativeMessageId,
    nativeCursor: receipt.cursor,
    errorCode: confirmed ? providerCleanupFailureReason : "connector_delivery_uncertain",
    nextAttemptAt: null,
    now: operationTime(input),
    audit: input.audit,
  });
}

type ApprovalReconciliationConnector = SessionConnectorV1 & {
  reconcileApproval(input: Readonly<{
    contractVersion: 1; artifactId: string; request: SessionConnectorSendRequestV1;
  }>): Promise<SessionConnectorResultV1<SessionConnectorSendReceiptV1>>;
};

/**
 * Reconcile a user-approved Happier action against provider history. This is a
 * separate recovery command from dispatch and cannot invoke send().
 */
export async function reconcileApprovedRoomDelivery(
  input: ReconcileApprovedRoomDeliveryInput,
): Promise<RoomOutboxRecordV1> {
  assertAuditIdentity(input.audit);
  await assertOperationAuthority(input);
  const delivery = await requireDelivery(input.store, input.outboxId);
  const binding = await requireBinding(input.store, delivery.bindingId);
  assertDispatchIdentity(delivery, binding, input.identity);
  if (
    delivery.state !== "delivery_uncertain"
    || delivery.lastErrorCode !== "connector_approval_waiting"
  ) {
    throw new RoomDeliveryCoordinatorError("delivery_state_conflict",
      `Room delivery ${input.outboxId} is not waiting for connector approval reconciliation`);
  }
  const artifactId = safeText(delivery.connectorAcknowledgementId, 512);
  if (!artifactId) {
    throw new RoomDeliveryCoordinatorError("delivery_state_conflict",
      `Room delivery ${input.outboxId} has no durable connector approval artifact`);
  }
  if (hashRoomValue(input.content) !== delivery.payloadHash) {
    throw new RoomDeliveryCoordinatorError("delivery_payload_conflict",
      `Room delivery ${input.outboxId} content does not match its durable payload hash`);
  }
  if (
    input.senderFence.roomId !== delivery.roomId
    || input.senderFence.resourceId !== delivery.bindingId
    || input.senderFence.hostId !== input.identity.hostId
  ) {
    throw new RoomDeliveryCoordinatorError("delivery_identity_conflict",
      `Room delivery ${input.outboxId} approval reconciliation has a mismatched sender fence`);
  }

  const connector = await input.registry.requireVerified({
    connectorId: binding.connectorId,
    capability: "send",
    identity: input.identity,
    requiredHostId: binding.hostId,
  });
  if (!isApprovalReconciliationConnector(connector)) {
    throw new RoomDeliveryCoordinatorError("connector_capability_unverified",
      `Session connector ${binding.connectorId} does not expose explicit approval reconciliation`);
  }
  const request = {
    contractVersion: 1,
    bindingId: delivery.bindingId,
    identity: input.identity,
    logicalMessageId: delivery.logicalMessageId,
    localMessageId: delivery.localMessageId,
    idempotencyKey: delivery.idempotencyKey,
    content: input.content,
    contentHash: delivery.payloadHash,
    deliveryAuthorization: {
      outboxId: delivery.id,
      senderFence: input.senderFence,
    },
  } as const satisfies SessionConnectorSendRequestV1;

  let result: SessionConnectorResultV1<SessionConnectorSendReceiptV1>;
  try {
    await assertOperationAuthority(input);
    result = await connector.reconcileApproval({ contractVersion: 1, artifactId, request });
    await assertOperationAuthority(input);
  } catch {
    return input.store.reconcileDelivery({
      outboxId: input.outboxId,
      expectedAttemptCount: delivery.attemptCount,
      outcome: "delivery_uncertain",
      connectorAcknowledgementId: artifactId,
      nativeMessageId: delivery.nativeMessageId,
      nativeCursor: delivery.nativeCursor,
      errorCode: "approval_reconciliation_failed",
      evidenceRef: buildReconciliationEvidenceRef(delivery, "approval_reconciliation_failed", {
        artifactId,
      }),
      now: operationTime(input),
      audit: input.audit,
    });
  }
  if (!result.ok) {
    const remainsWaiting = connectorApprovalEvidence(result.error.safeDetails, input.identity) !== null;
    const errorCode = remainsWaiting
      ? "connector_approval_waiting"
      : "approval_reconciliation_failed";
    return input.store.reconcileDelivery({
      outboxId: input.outboxId,
      expectedAttemptCount: delivery.attemptCount,
      outcome: "delivery_uncertain",
      connectorAcknowledgementId: artifactId,
      nativeMessageId: delivery.nativeMessageId,
      nativeCursor: delivery.nativeCursor,
      errorCode,
      evidenceRef: buildReconciliationEvidenceRef(delivery, errorCode,
        { artifactId, connectorErrorCode: result.error.code }),
      now: operationTime(input),
      audit: input.audit,
    });
  }

  const receipt = result.value;
  const hasExactReceipt = receipt.outcome === "confirmed"
    && Boolean(receipt.connectorAcknowledgementId)
    && Boolean(receipt.nativeMessageId);
  const errorCode = hasExactReceipt ? null : "approval_reconciliation_unconfirmed";
  const reconciliationOutcome = hasExactReceipt ? "approval_reconciled" : "approval_reconciliation_unconfirmed";
  return input.store.reconcileDelivery({
    outboxId: input.outboxId,
    expectedAttemptCount: delivery.attemptCount,
    outcome: hasExactReceipt ? "confirmed" : "delivery_uncertain",
    connectorAcknowledgementId: hasExactReceipt ? receipt.connectorAcknowledgementId : artifactId,
    nativeMessageId: hasExactReceipt ? receipt.nativeMessageId : delivery.nativeMessageId,
    nativeCursor: hasExactReceipt ? receipt.cursor : delivery.nativeCursor,
    errorCode,
    evidenceRef: buildReconciliationEvidenceRef(delivery, reconciliationOutcome, {
      artifactId, connectorAcknowledgementId: receipt.connectorAcknowledgementId,
      nativeMessageId: receipt.nativeMessageId, cursor: receipt.cursor,
    }),
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
    const historyDeadline = createHistoryReadDeadline(input);
    try {
      pageResult = await raceConnectorOperation(connector.readHistory({
        contractVersion: 1,
        identity: input.identity,
        afterCursor: cursor,
        limit: input.historyPageSize,
      }), historyDeadline.signal);
    } catch {
      if (input.signal?.aborted) throw abortError();
      return persistUncertainReconciliation(input, delivery, historyDeadline.timedOut()
        ? "history_read_timeout"
        : "history_read_exception", {
        pageNumber,
        cursor,
      });
    } finally {
      historyDeadline.dispose();
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

function providerBackpressureOperationDeadlineMs(input: DispatchRoomDeliveryInput): number {
  const timeoutMs = input.providerBackpressureDeadlineMs ?? DEFAULT_PROVIDER_BACKPRESSURE_GATE_DEADLINE_MS;
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0
    || timeoutMs > MAX_PROVIDER_BACKPRESSURE_GATE_DEADLINE_MS
  ) {
    throw new RoomDeliveryCoordinatorError(
      "delivery_state_conflict",
      `Room provider gate deadline must be a positive integer no greater than ${MAX_PROVIDER_BACKPRESSURE_GATE_DEADLINE_MS}`,
    );
  }
  return timeoutMs;
}

/*
 * FNXC:RoomHistoryReconciliationDeadline 2026-07-20-01:23:
 * Native history is evidence for an ambiguous send, not permission to block a
 * Room worker indefinitely. Bound each page locally and leave the outbox
 * uncertain on timeout; a later fenced recovery may inspect history again,
 * but no connector send is retried here.
 */
function historyReadOperationDeadlineMs(input: ReconcileAmbiguousRoomDeliveryInput): number {
  const timeoutMs = input.historyReadDeadlineMs ?? DEFAULT_HISTORY_READ_DEADLINE_MS;
  if (
    !Number.isSafeInteger(timeoutMs)
    || timeoutMs <= 0
    || timeoutMs > MAX_HISTORY_READ_DEADLINE_MS
  ) {
    throw new RoomDeliveryCoordinatorError(
      "invalid_reconciliation_bound",
      `Room history read deadline must be a positive integer no greater than ${MAX_HISTORY_READ_DEADLINE_MS}`,
    );
  }
  return timeoutMs;
}

function createHistoryReadDeadline(
  input: ReconcileAmbiguousRoomDeliveryInput,
): { readonly signal: AbortSignal; readonly timedOut: () => boolean; dispose(): void } {
  const timeoutMs = historyReadOperationDeadlineMs(input);
  const controller = new AbortController();
  let didTimeOut = false;
  const onOuterAbort = () => {
    controller.abort((input.signal as AbortSignal & { readonly reason?: unknown } | undefined)?.reason);
  };
  input.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const timeout = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    dispose: () => {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onOuterAbort);
    },
  };
}

function createProviderBackpressureGateDeadline(
  input: DispatchRoomDeliveryInput,
  asOf: string,
): { readonly deadline: string; readonly signal: AbortSignal; dispose(): void } {
  const timeoutMs = providerBackpressureOperationDeadlineMs(input);
  const deadline = new Date(Date.parse(asOf) + timeoutMs).toISOString();
  const controller = new AbortController();
  const onOuterAbort = () => {
    controller.abort((input.signal as AbortSignal & { readonly reason?: unknown } | undefined)?.reason);
  };
  input.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const timeout = setTimeout(() => {
    controller.abort(new RoomProviderBackpressureGateTimeoutError(deadline));
  }, timeoutMs);
  return {
    deadline,
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onOuterAbort);
    },
  };
}

function providerErrorCode(reason: string): string {
  return reason.startsWith("provider_") ? reason : `provider_${reason}`;
}

function createProviderBackpressureDeliveryAttemptId(delivery: RoomOutboxRecordV1): string {
  const durableGeneration = hashRoomValue({
    contractVersion: 1,
    deliveryId: delivery.id,
    roomId: delivery.roomId,
    logicalMessageId: delivery.logicalMessageId,
    bindingId: delivery.bindingId,
    idempotencyKey: delivery.idempotencyKey,
    payloadHash: delivery.payloadHash,
    state: delivery.state,
    attemptCount: delivery.attemptCount,
    connectorAcknowledgementId: delivery.connectorAcknowledgementId,
    nativeMessageId: delivery.nativeMessageId,
    nativeCursor: delivery.nativeCursor,
    reconciliationFromCursor: delivery.reconciliationFromCursor,
    reconciliationEvidenceRef: delivery.reconciliationEvidenceRef,
    lastErrorCode: delivery.lastErrorCode,
    nextAttemptAt: delivery.nextAttemptAt,
  });
  return `provider-admission:${delivery.id}:${durableGeneration}`;
}

type ProviderPermitRenewalBeforeSend =
  | { readonly action: "renewed" }
  | { readonly action: "defer"; readonly reason: string; readonly retryAfterMs: number };

async function renewProviderPermitBeforeConnectorSend(
  input: DispatchRoomDeliveryInput,
  permit: RoomProviderBackpressureSendPermitV1,
  deliveryAttemptId: string,
  asOf: string,
): Promise<ProviderPermitRenewalBeforeSend> {
  if (typeof permit.renew !== "function") {
    return {
      action: "defer",
      reason: "provider_reservation_renewal_unavailable",
      retryAfterMs: DEFAULT_PROVIDER_BACKPRESSURE_DEFER_RETRY_AFTER_MS,
    };
  }
  const bounded = await raceProviderPermitOperation(
    input,
    () => permit.renew!({
      asOf,
      operationId: `room-provider-renew:${hashRoomValue({
        requestId: permit.requestId,
        deliveryAttemptId,
      })}`,
    }),
  );
  if (bounded.action === "timed_out") {
    return {
      action: "defer",
      reason: "provider_reservation_renewal_timed_out",
      retryAfterMs: DEFAULT_PROVIDER_BACKPRESSURE_DEFER_RETRY_AFTER_MS,
    };
  }
  if (bounded.action === "aborted") {
    return {
      action: "defer",
      reason: "provider_reservation_renewal_aborted",
      retryAfterMs: DEFAULT_PROVIDER_BACKPRESSURE_DEFER_RETRY_AFTER_MS,
    };
  }
  if (bounded.action === "failed") {
    return {
      action: "defer",
      reason: "provider_reservation_renewal_unavailable",
      retryAfterMs: DEFAULT_PROVIDER_BACKPRESSURE_DEFER_RETRY_AFTER_MS,
    };
  }
  const result: unknown = bounded.value;
  if (typeof result !== "object" || result === null || !("action" in result)) {
    return {
      action: "defer",
      reason: "provider_reservation_renewal_invalid",
      retryAfterMs: DEFAULT_PROVIDER_BACKPRESSURE_DEFER_RETRY_AFTER_MS,
    };
  }
  const action = (result as { readonly action?: unknown }).action;
  if (action === "renewed") return { action: "renewed" };
  if (action === "defer") {
    const deferred = result as { readonly reason?: unknown; readonly retryAfterMs?: unknown };
    return {
      action: "defer",
      reason: typeof deferred.reason === "string"
        ? canonicalProviderBackpressureReason(providerErrorCode(deferred.reason))
        : "provider_reservation_renewal_invalid",
      retryAfterMs: Number.isSafeInteger(deferred.retryAfterMs) && (deferred.retryAfterMs as number) >= 0
        ? deferred.retryAfterMs as number
        : DEFAULT_PROVIDER_BACKPRESSURE_DEFER_RETRY_AFTER_MS,
    };
  }
  return {
    action: "defer",
    reason: "provider_reservation_renewal_invalid",
    retryAfterMs: DEFAULT_PROVIDER_BACKPRESSURE_DEFER_RETRY_AFTER_MS,
  };
}

/*
FNXC:RoomProviderBackpressureComposition 2026-07-19-21:15:
An admitted provider gate may defer before any connector side effect. That
decision must survive worker restart under the current sender fence, with a
bounded retry time and a canonical reason; returning an in-memory pending row
would let the recovery loop flood a constrained provider. A permit cleanup
failure is recorded as the retry reason only before send. Once a connector
receipt proves acceptance, capacity cleanup cannot overwrite that delivery fact.
*/
async function deferPendingProviderBackpressureDelivery(
  input: DispatchRoomDeliveryInput,
  delivery: RoomOutboxRecordV1,
  reason: string,
  retryAfterMs: number | null,
): Promise<RoomOutboxRecordV1> {
  const now = await assertOperationAuthority(input);
  return input.store.deferPendingDelivery({
    outboxId: delivery.id,
    expectedAttemptCount: delivery.attemptCount,
    senderFence: input.senderFence,
    reasonCode: canonicalProviderBackpressureReason(reason),
    nextAttemptAt: providerBackpressureRetryAt(now, retryAfterMs),
    now,
    audit: input.audit,
  });
}

async function fencePendingProviderAdmissionTimeout(
  input: DispatchRoomDeliveryInput,
  delivery: RoomOutboxRecordV1,
  request: RoomProviderBackpressureSendGateRequestV1,
): Promise<RoomOutboxRecordV1> {
  assertLateProviderAdmissionFenceConfigured(input);
  const actions = input.providerBackpressureCleanupActions!;
  const context = input.providerBackpressureCleanupContext!;
  const recoveryProtocol = providerAdmissionTimeoutRecoveryProtocol(input.providerBackpressure);
  const now = await assertOperationAuthority(input);
  const result: unknown = await actions.fencePendingAdmissionTimeout({
    projectId: context.projectId,
    roomId: delivery.roomId,
    gateAttemptId: request.attemptId,
    requestHash: request.requestHash,
    outboxId: delivery.id,
    outboxBindingId: delivery.bindingId,
    outboxAttemptCount: delivery.attemptCount,
    senderFence: input.senderFence,
    recoveryProtocol,
    errorCode: "provider_gate_timeout",
    now,
    audit: input.audit,
  });
  const proof = admissionTimeoutTombstoneProof(result);
  const fenced = proof?.outbox ?? null;
  const tombstone = proof?.tombstone ?? null;
  if (
    !fenced
    || !tombstone
    || tombstone.gateAttemptId !== request.attemptId
    || tombstone.requestHash !== request.requestHash
    || tombstone.outboxId !== delivery.id
    || tombstone.outboxBindingId !== delivery.bindingId
    || tombstone.outboxAttemptCount !== delivery.attemptCount
    || tombstone.recoveryProtocol !== recoveryProtocol
    || tombstone.state !== "pending"
    || tombstone.cleanupActionId !== null
    || tombstone.reservationId !== null
    || tombstone.terminalGateOutcomeId !== null
    || tombstone.resolvedAt !== null
    || fenced.id !== delivery.id
    || fenced.roomId !== delivery.roomId
    || fenced.bindingId !== delivery.bindingId
    || fenced.state !== "delivery_uncertain"
    || fenced.attemptCount !== delivery.attemptCount
    || fenced.connectorAcknowledgementId !== null
    || fenced.nativeMessageId !== null
    || fenced.nativeCursor !== null
    || fenced.reconciliationEvidenceRef !== null
    || fenced.nextAttemptAt !== null
    || fenced.lastErrorCode !== "provider_gate_timeout"
  ) {
    throw new RoomDeliveryCoordinatorError(
      "delivery_state_conflict",
      "Core provider admission timeout fence did not return the exact tombstone and outbox generation",
    );
  }
  return fenced;
}

/*
FNXC:RoomProviderAdmissionTimeoutRecovery 2026-07-21-01:20:
A serialized recovery marker never authorizes a restart path. Only the private
identity issued by the standard Core sender-fenced gate factory is eligible;
missing, wrapped, or custom gates are persisted as opaque so recovery cannot
manufacture a no-permit result.
*/
function providerAdmissionTimeoutRecoveryProtocol(
  gate: RoomProviderBackpressureSendGateV1 | undefined,
): "opaque" | "core_sender_fenced_v1" {
  return isCoreSenderFencedRecoveryGate(gate) ? "core_sender_fenced_v1" : "opaque";
}

async function bindTimedOutProviderAdmissionPermit(
  input: DispatchRoomDeliveryInput,
  delivery: RoomOutboxRecordV1,
  request: RoomProviderBackpressureSendGateRequestV1,
  permit: RoomProviderBackpressureSendPermitV1,
): Promise<RoomOutboxRecordV1> {
  assertLateProviderAdmissionFenceConfigured(input);
  const actions = input.providerBackpressureCleanupActions!;
  const context = input.providerBackpressureCleanupContext!;
  const descriptor = permit.cleanupDescriptor;
  if (!descriptor) {
    throw new RoomDeliveryCoordinatorError(
      "delivery_state_conflict",
      "A late provider permit requires its immutable cleanup descriptor before timeout tombstone binding",
    );
  }
  const now = operationTime(input);
  const actionIdentity = {
    projectId: context.projectId,
    roomId: delivery.roomId,
    outboxId: delivery.id,
    outboxBindingId: delivery.bindingId,
    outboxAttemptId: null,
    outboxAttemptCount: delivery.attemptCount,
    reservationId: permit.reservationId,
    requestId: permit.requestId,
    claimId: descriptor.claimId,
    originalWorkerFence: descriptor.originalWorkerFence,
    expectedAggregateVersion: descriptor.expectedAggregateVersion,
    reservationExpiresAt: descriptor.reservationExpiresAt,
    completionKind: "pre_claim_not_started" as const,
  };
  const identityHash = hashRoomValue(actionIdentity);
  const actionId = `room-provider-cleanup:${identityHash}`;
  const result: unknown = await actions.bindAdmissionTimeoutReservation({
    projectId: context.projectId,
    roomId: delivery.roomId,
    gateAttemptId: request.attemptId,
    requestHash: request.requestHash,
    cleanupAction: {
      ...actionIdentity,
      actionId,
      idempotencyKey: actionId,
      createdAt: now,
    },
    now,
    audit: input.audit,
  });
  const proof = boundAdmissionTimeoutProof(result);
  const bound = proof?.outbox ?? null;
  const tombstone = proof?.tombstone ?? null;
  if (
    !bound
    || !tombstone
    || tombstone.gateAttemptId !== request.attemptId
    || tombstone.requestHash !== request.requestHash
    || tombstone.outboxId !== delivery.id
    || tombstone.outboxBindingId !== delivery.bindingId
    || tombstone.outboxAttemptCount !== delivery.attemptCount
    || tombstone.state !== "reservation_bound"
    || tombstone.cleanupActionId !== actionId
    || tombstone.reservationId !== permit.reservationId
    || typeof tombstone.resolvedAt !== "string"
    || bound.id !== delivery.id
    || bound.roomId !== delivery.roomId
    || bound.bindingId !== delivery.bindingId
    || bound.state !== "delivery_uncertain"
    || bound.attemptCount !== delivery.attemptCount
    || bound.connectorAcknowledgementId !== null
    || bound.nativeMessageId !== null
    || bound.nativeCursor !== null
    || bound.reconciliationEvidenceRef !== null
    || bound.nextAttemptAt !== null
    || bound.lastErrorCode !== "provider_gate_timeout"
  ) {
    throw new RoomDeliveryCoordinatorError(
      "delivery_state_conflict",
      "Core provider admission timeout binding did not preserve the exact fenced outbox generation",
    );
  }
  return bound;
}

async function recordTimedOutProviderAdmissionNoPermit(
  input: DispatchRoomDeliveryInput,
  delivery: RoomOutboxRecordV1,
  request: RoomProviderBackpressureSendGateRequestV1,
  outcome: RoomProviderBackpressureLateNoPermitOutcomeV1,
): Promise<RoomOutboxRecordV1> {
  assertLateProviderAdmissionFenceConfigured(input);
  const actions = input.providerBackpressureCleanupActions!;
  const context = input.providerBackpressureCleanupContext!;
  const occurredAt = operationTime(input);
  const terminalGateOutcome = {
    outcomeId: `room-provider-admission-terminal:${hashRoomValue({
      contractVersion: 1,
      gateAttemptId: request.attemptId,
      requestHash: request.requestHash,
      action: outcome.action,
      reason: outcome.reason,
      retryAfterMs: outcome.retryAfterMs ?? null,
    })}`,
    outcome: "deferred_without_permit" as const,
    occurredAt,
  };
  const result: unknown = await actions.recordAdmissionTimeoutTerminalOutcome({
    projectId: context.projectId,
    roomId: delivery.roomId,
    gateAttemptId: request.attemptId,
    requestHash: request.requestHash,
    outboxId: delivery.id,
    outboxBindingId: delivery.bindingId,
    outboxAttemptCount: delivery.attemptCount,
    senderFence: input.senderFence,
    terminalGateOutcome,
    now: occurredAt,
    audit: input.audit,
  });
  const proof = recordedAdmissionTimeoutProof(result);
  const recorded = proof?.outbox ?? null;
  const tombstone = proof?.tombstone ?? null;
  const exactTerminalProof = tombstone?.terminalGateOutcomeId === terminalGateOutcome.outcomeId
    && tombstone.terminalGateOutcome === terminalGateOutcome.outcome
    && tombstone.terminalAt === terminalGateOutcome.occurredAt;
  const exactTarget = recorded?.id === delivery.id
    && recorded.roomId === delivery.roomId
    && recorded.bindingId === delivery.bindingId
    && recorded.attemptCount === delivery.attemptCount
    && recorded.connectorAcknowledgementId === null
    && recorded.nativeMessageId === null
    && recorded.nativeCursor === null
    && recorded.reconciliationEvidenceRef === null;
  const safelyRecorded = tombstone?.state === "terminal_outcome_recorded"
    && tombstone.cleanupActionId === null
    && tombstone.reservationId === null
    && tombstone.resolvedAt === null
    && tombstone.nextAttemptAt === null
    && recorded?.state === "delivery_uncertain"
    && recorded.nextAttemptAt === null
    && recorded.lastErrorCode === "provider_gate_timeout";
  const alreadyResolvedByRecovery = tombstone?.state === "terminal_without_permit"
    && tombstone.cleanupActionId === null
    && tombstone.reservationId === null
    && typeof tombstone.resolvedAt === "string"
    && typeof tombstone.nextAttemptAt === "string"
    && recorded?.state === "pending"
    && recorded.nextAttemptAt === tombstone.nextAttemptAt
    && recorded.lastErrorCode === "provider_gate_terminal_without_permit";
  if (
    !recorded
    || !tombstone
    || tombstone.gateAttemptId !== request.attemptId
    || tombstone.requestHash !== request.requestHash
    || tombstone.outboxId !== delivery.id
    || tombstone.outboxBindingId !== delivery.bindingId
    || tombstone.outboxAttemptCount !== delivery.attemptCount
    || !exactTerminalProof
    || !exactTarget
    || (!safelyRecorded && !alreadyResolvedByRecovery)
  ) {
    throw new RoomDeliveryCoordinatorError(
      "delivery_state_conflict",
      "Core provider admission timeout terminal proof did not preserve the exact fenced outbox generation",
    );
  }
  return recorded;
}

async function fencePendingProviderBackpressureDelivery(
  input: DispatchRoomDeliveryInput,
  delivery: RoomOutboxRecordV1,
  permit: RoomProviderBackpressureSendPermitV1 | null,
  reason: string,
): Promise<RoomOutboxRecordV1> {
  const actions = input.providerBackpressureCleanupActions;
  const context = input.providerBackpressureCleanupContext;
  const descriptor = permit?.cleanupDescriptor;
  const errorCode = canonicalProviderBackpressureReason(providerErrorCode(reason));
  if (!actions || !context || !descriptor || !canonicalProviderBackpressureContext(context.projectId)) {
    throw new RoomDeliveryCoordinatorError(
      "delivery_state_conflict",
      "An admitted provider permit with unresolved pre-claim cleanup requires the atomic Core cleanup fence",
    );
  }
  const now = operationTime(input);
  if (Date.parse(descriptor.reservationExpiresAt) <= Date.parse(now)) {
    return deferPendingProviderBackpressureDelivery(input, delivery, errorCode, null);
  }
  const actionIdentity = {
    projectId: context.projectId,
    roomId: delivery.roomId,
    outboxId: delivery.id,
    outboxBindingId: delivery.bindingId,
    outboxAttemptId: null,
    outboxAttemptCount: delivery.attemptCount,
    reservationId: permit!.reservationId,
    requestId: permit!.requestId,
    claimId: descriptor.claimId,
    originalWorkerFence: descriptor.originalWorkerFence,
    expectedAggregateVersion: descriptor.expectedAggregateVersion,
    reservationExpiresAt: descriptor.reservationExpiresAt,
    completionKind: "pre_claim_not_started" as const,
  };
  const identityHash = hashRoomValue(actionIdentity);
  /*
  FNXC:RoomProviderPreClaimFence 2026-07-20-22:20:
  Core commits the cleanup action and pending-to-uncertain transition together.
  Its returned outbox snapshot is therefore the sole proof of the fenced
  generation; Engine must not perform a second read that can fail after the
  safety transition and incorrectly permit another provider admission.
  */
  const fenceResult: unknown = await actions.fencePendingOutbox({
    action: {
      ...actionIdentity,
      actionId: `room-provider-cleanup:${identityHash}`,
      idempotencyKey: `room-provider-cleanup:${identityHash}`,
      createdAt: now,
    },
    senderFence: input.senderFence,
    errorCode,
    now,
    audit: input.audit,
  });
  const fenced = fencedOutboxSnapshot(fenceResult);
  if (!fenced || fenced.id !== delivery.id || fenced.roomId !== delivery.roomId || fenced.bindingId !== delivery.bindingId
    || fenced.state !== "delivery_uncertain" || fenced.attemptCount !== delivery.attemptCount
    || fenced.connectorAcknowledgementId !== null || fenced.nativeMessageId !== null
    || fenced.nativeCursor !== null || fenced.reconciliationEvidenceRef !== null
    || fenced.nextAttemptAt !== null || fenced.lastErrorCode !== errorCode) {
    throw new RoomDeliveryCoordinatorError(
      "delivery_state_conflict",
      "Atomic provider cleanup fence did not return proof for the exact pending outbox generation",
    );
  }
  return fenced;
}

function assertLateProviderAdmissionFenceConfigured(
  input: DispatchRoomDeliveryInput,
): asserts input is DispatchRoomDeliveryInput & {
  readonly providerBackpressureCleanupActions: RoomProviderAdmissionTimeoutCleanupActions;
  readonly providerBackpressureCleanupContext: { readonly projectId: string };
} {
  const actions = input.providerBackpressureCleanupActions;
  const context = input.providerBackpressureCleanupContext;
  if (
    !actions
    || typeof actions.fencePendingAdmissionTimeout !== "function"
    || typeof actions.bindAdmissionTimeoutReservation !== "function"
    || typeof actions.recordAdmissionTimeoutTerminalOutcome !== "function"
    || typeof actions.fencePendingOutbox !== "function"
    || !context
    || !canonicalProviderBackpressureContext(context.projectId)
  ) {
    throw new RoomDeliveryCoordinatorError(
      "delivery_state_conflict",
      "A timed-out provider gate requires the complete Core tombstone, late-permit binding, and terminal-proof APIs",
    );
  }
}

function admissionTimeoutTombstoneProof(value: unknown): {
  readonly tombstone: Record<string, unknown>;
  readonly outbox: RoomOutboxRecordV1;
} | null {
  if (typeof value !== "object" || value === null) return null;
  const result = value as { readonly status?: unknown; readonly tombstone?: unknown; readonly outbox?: unknown };
  if (result.status !== "created" && result.status !== "replayed") return null;
  if (typeof result.tombstone !== "object" || result.tombstone === null) return null;
  if (typeof result.outbox !== "object" || result.outbox === null) return null;
  return {
    tombstone: result.tombstone as Record<string, unknown>,
    outbox: result.outbox as RoomOutboxRecordV1,
  };
}

function boundAdmissionTimeoutProof(value: unknown): {
  readonly tombstone: Record<string, unknown>;
  readonly outbox: RoomOutboxRecordV1;
} | null {
  if (typeof value !== "object" || value === null) return null;
  const result = value as { readonly status?: unknown; readonly tombstone?: unknown; readonly outbox?: unknown };
  if (result.status !== "bound" && result.status !== "replayed") return null;
  if (typeof result.tombstone !== "object" || result.tombstone === null) return null;
  if (typeof result.outbox !== "object" || result.outbox === null) return null;
  return {
    tombstone: result.tombstone as Record<string, unknown>,
    outbox: result.outbox as RoomOutboxRecordV1,
  };
}

function recordedAdmissionTimeoutProof(value: unknown): {
  readonly tombstone: Record<string, unknown>;
  readonly outbox: RoomOutboxRecordV1;
} | null {
  if (typeof value !== "object" || value === null) return null;
  const result = value as { readonly status?: unknown; readonly tombstone?: unknown; readonly outbox?: unknown };
  if (result.status !== "recorded" && result.status !== "replayed") return null;
  if (typeof result.tombstone !== "object" || result.tombstone === null) return null;
  if (typeof result.outbox !== "object" || result.outbox === null) return null;
  return {
    tombstone: result.tombstone as Record<string, unknown>,
    outbox: result.outbox as RoomOutboxRecordV1,
  };
}

function fencedOutboxSnapshot(value: unknown): RoomOutboxRecordV1 | null {
  if (typeof value !== "object" || value === null || !("outbox" in value)) return null;
  const result = value as { readonly status?: unknown; readonly outbox?: unknown };
  if (result.status !== "created" && result.status !== "replayed") return null;
  const outbox = result.outbox;
  if (typeof outbox !== "object" || outbox === null) return null;
  return outbox as RoomOutboxRecordV1;
}

async function deferClaimedProviderBackpressureDelivery(
  input: DispatchRoomDeliveryInput,
  claimed: RoomOutboxRecordV1,
  attemptId: string,
  reason: string,
  retryAfterMs: number | null,
  permit: RoomProviderBackpressureSendPermitV1 | null,
): Promise<RoomOutboxRecordV1> {
  const errorCode = canonicalProviderBackpressureReason(providerErrorCode(reason));
  /*
  FNXC:RoomProviderPermitCleanupDeadline 2026-07-20-03:51:
  A timeout while completing an unused provider permit cannot strand a claimed
  outbox in dispatching or fabricate an uncertain connector side effect: no
  connector send started. However, the admitted provider reservation is no
  longer known to be released, so persisting its cleanup fence must be followed
  by delivery_uncertain rather than retryable pending. A restart must not obtain
  a second provider admission or send until the durable cleanup workflow closes
  the original reservation.
  */
  if (providerPermitCleanupNeedsDeferredAction(errorCode)) {
    await recordProviderCleanupAction(input, claimed, attemptId, permit, "pre_send_not_started");
    const now = operationTime(input);
    return input.store.completeDeliveryAttempt({
      outboxId: claimed.id,
      attemptId,
      senderFence: input.senderFence,
      outcome: "delivery_uncertain",
      connectorAcknowledgementId: null,
      nativeMessageId: null,
      nativeCursor: null,
      errorCode,
      nextAttemptAt: null,
      now,
      audit: input.audit,
    });
  }
  const now = operationTime(input);
  return input.store.completeDeliveryAttempt({
    outboxId: claimed.id,
    attemptId,
    senderFence: input.senderFence,
    outcome: "retryable_failure",
    connectorAcknowledgementId: null,
    nativeMessageId: null,
    nativeCursor: null,
    errorCode,
    nextAttemptAt: providerBackpressureRetryAt(now, retryAfterMs),
    now,
    audit: input.audit,
  });
}

/**
 * FNXC:RoomProviderCleanupAction 2026-07-20-00:30:
 * A provider permit that could not be released before any connector send is
 * neither safe to retry nor safe to silently forget. When the durable gate
 * supplies its original reservation fence, write that immutable expiry action
 * before moving the outbox to delivery_uncertain. The same immutable record is
 * also created for a permit admitted after its caller deadline, before its
 * original completion endpoint is called. The later Room worker may
 * observe only expiry; it must never reconstruct or release the historical
 * worker fence.
 */
async function recordProviderCleanupAction(
  input: DispatchRoomDeliveryInput,
  delivery: RoomOutboxRecordV1,
  attemptId: string,
  permit: RoomProviderBackpressureSendPermitV1 | null,
  completionKind: "pre_send_not_started" | "late_admission_not_started",
): Promise<void> {
  const actions = input.providerBackpressureCleanupActions;
  const context = input.providerBackpressureCleanupContext;
  const descriptor = permit?.cleanupDescriptor;
  if (!actions || !context || !descriptor) return;
  if (!canonicalProviderBackpressureContext(context.projectId)) {
    throw new RoomDeliveryCoordinatorError(
      "delivery_state_conflict",
      "Room provider cleanup actions require a canonical project scope",
    );
  }
  const createdAt = operationTime(input);
  if (Date.parse(descriptor.reservationExpiresAt) <= Date.parse(createdAt)) {
    // No live capacity reservation remains to fence; an expired permit cannot
    // be re-authorized by this path and requires no new cleanup action.
    return;
  }
  const exactPreSendAttempt = completionKind === "pre_send_not_started";
  const actionIdentity = {
    projectId: context.projectId,
    roomId: delivery.roomId,
    outboxId: exactPreSendAttempt ? delivery.id : null,
    outboxBindingId: exactPreSendAttempt ? delivery.bindingId : null,
    outboxAttemptId: exactPreSendAttempt ? attemptId : null,
    outboxAttemptCount: exactPreSendAttempt ? delivery.attemptCount : null,
    reservationId: permit!.reservationId,
    requestId: permit!.requestId,
    claimId: descriptor.claimId,
    originalWorkerFence: descriptor.originalWorkerFence,
    expectedAggregateVersion: descriptor.expectedAggregateVersion,
    reservationExpiresAt: descriptor.reservationExpiresAt,
    completionKind,
  };
  const identityHash = hashRoomValue(actionIdentity);
  await actions.enqueue({
    ...actionIdentity,
    actionId: `room-provider-cleanup:${identityHash}`,
    idempotencyKey: `room-provider-cleanup:${identityHash}`,
    createdAt,
  });
}

function canonicalProviderBackpressureContext(value: string): boolean {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function providerPermitCleanupNeedsDeferredAction(reason: string): boolean {
  return reason.startsWith("provider_reservation_cleanup_");
}

/*
FNXC:RoomProviderPermitDeadline 2026-07-19-23:12:
Permit renew and complete APIs cannot accept an AbortSignal. Race each call
against the configured provider deadline and the caller signal, while keeping
late handlers attached so a delayed rejection cannot escape. This permits a
sender-fenced pending/confirmed outbox transition even when provider cleanup
or renewal transport is permanently stalled. Cleanup intentionally ignores a
caller cancellation: a permit already admitted by Core must still be released
after every pre-send abort or authority loss, and remains deadline-bounded.
*/
type BoundedProviderPermitOperation<T> =
  | { readonly action: "completed"; readonly value: T }
  | { readonly action: "timed_out" }
  | { readonly action: "aborted" }
  | { readonly action: "failed" };

function raceProviderPermitOperation<T>(
  input: DispatchRoomDeliveryInput,
  operation: () => Promise<T>,
  options: { readonly respectOuterAbort?: boolean } = {},
): Promise<BoundedProviderPermitOperation<T>> {
  const timeoutMs = providerBackpressureOperationDeadlineMs(input);
  const signal = input.signal;
  const respectOuterAbort = options.respectOuterAbort !== false;
  if (respectOuterAbort && signal?.aborted) return Promise.resolve({ action: "aborted" });

  return new Promise<BoundedProviderPermitOperation<T>>((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      finish({ action: "aborted" });
    };
    const finish = (result: BoundedProviderPermitOperation<T>): void => {
      if (settled) return;
      settled = true;
      if (timeout !== null) clearTimeout(timeout);
      if (respectOuterAbort) signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    timeout = setTimeout(() => {
      finish({ action: "timed_out" });
    }, timeoutMs);
    if (respectOuterAbort) signal?.addEventListener("abort", onAbort, { once: true });
    let pending: Promise<T>;
    try {
      pending = operation();
    } catch {
      finish({ action: "failed" });
      return;
    }
    void pending.then(
      (value) => finish({ action: "completed", value }),
      () => finish({ action: "failed" }),
    );
  });
}

type ProviderPermitCleanupFailure = {
  readonly reason: string;
  readonly retryAfterMs: number;
};

async function settleProviderPermit(
  input: DispatchRoomDeliveryInput,
  permit: RoomProviderBackpressureSendPermitV1,
  completion: RoomProviderBackpressureSendCompletionV1,
): Promise<ProviderPermitCleanupFailure | null> {
  const bounded = await raceProviderPermitOperation(
    input,
    () => permit.complete(completion),
    { respectOuterAbort: false },
  );
  if (bounded.action === "timed_out") {
    return {
      reason: "provider_reservation_cleanup_timed_out",
      retryAfterMs: DEFAULT_PROVIDER_BACKPRESSURE_DEFER_RETRY_AFTER_MS,
    };
  }
  if (bounded.action === "aborted") {
    return {
      reason: "provider_reservation_cleanup_aborted",
      retryAfterMs: DEFAULT_PROVIDER_BACKPRESSURE_DEFER_RETRY_AFTER_MS,
    };
  }
  if (bounded.action === "failed") {
    return {
      reason: "provider_reservation_cleanup_failed",
      retryAfterMs: DEFAULT_PROVIDER_BACKPRESSURE_DEFER_RETRY_AFTER_MS,
    };
  }
  const cleanup = bounded.value;
  if (
    cleanup
    && cleanup.action === "cleanup_failed"
    && Number.isSafeInteger(cleanup.retryAfterMs)
    && cleanup.retryAfterMs >= 0
  ) {
    return {
      reason: canonicalProviderBackpressureReason(providerErrorCode(cleanup.reason)),
      retryAfterMs: cleanup.retryAfterMs,
    };
  }
  return null;
}

async function settlePreSendProviderPermit(
  input: DispatchRoomDeliveryInput,
  permit: RoomProviderBackpressureSendPermitV1,
  completedAt: string,
): Promise<ProviderPermitCleanupFailure | null> {
  return settleProviderPermit(input, permit, Object.freeze({ kind: "not_started", completedAt }));
}

function providerPermitCleanupError(reason: string): RoomDeliveryCoordinatorError {
  return new RoomDeliveryCoordinatorError(
    "delivery_state_conflict",
    `Room provider permit cleanup did not complete safely: ${canonicalProviderBackpressureReason(reason)}`,
  );
}

function canonicalProviderBackpressureReason(reason: string): string {
  return /^[a-z][a-z0-9_]{0,127}$/.test(reason)
    ? reason
    : "provider_gate_invalid_response";
}

function providerBackpressureRetryAt(now: string, retryAfterMs: number | null): string {
  const boundedRetryAfterMs = Number.isSafeInteger(retryAfterMs)
    && retryAfterMs !== null
    && retryAfterMs > 0
    ? Math.min(retryAfterMs, MAX_PROVIDER_BACKPRESSURE_DEFER_RETRY_AFTER_MS)
    : DEFAULT_PROVIDER_BACKPRESSURE_DEFER_RETRY_AFTER_MS;
  return new Date(Date.parse(now) + boundedRetryAfterMs).toISOString();
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

function connectorApprovalEvidence(
  safeDetails: Readonly<Record<string, unknown>> | undefined,
  expectedIdentity: SessionConnectorIdentityV1,
): Readonly<{ artifactId: string; operation: "session_message_send"; approvalStateRef: string }> | null {
  if (!safeDetails || safeDetails.actionState !== "approval_request_created") return null;
  const artifactId = safeText(safeDetails.artifactId, 512);
  const approvalStateRef = safeText(safeDetails.approvalStateRef, 64);
  const sessionIdentity = safeDetails.sessionIdentity;
  if (
    !artifactId
    || safeDetails.operation !== "session_message_send"
    || safeDetails.runtimeState !== "waitingOnInput"
    || safeDetails.reconciliationRequired !== true
    || !approvalStateRef || !/^[a-f0-9]{64}$/u.test(approvalStateRef)
    || !sessionIdentity || typeof sessionIdentity !== "object" || Array.isArray(sessionIdentity)
  ) {
    return null;
  }
  const identity = sessionIdentity as Readonly<Record<string, unknown>>;
  if (
    identity.connectorId !== expectedIdentity.connectorId
    || identity.providerId !== expectedIdentity.providerId
    || identity.nativeSessionId !== expectedIdentity.nativeSessionId
    || identity.happierSessionId !== expectedIdentity.happierSessionId
    || identity.serverProfileId !== expectedIdentity.serverProfileId
    || identity.machineId !== expectedIdentity.machineId || identity.hostId !== expectedIdentity.hostId
  ) {
    return null;
  }
  return Object.freeze({ artifactId, operation: "session_message_send", approvalStateRef });
}

function isApprovalReconciliationConnector(connector: SessionConnectorV1):
  connector is ApprovalReconciliationConnector {
  return typeof (connector as Partial<ApprovalReconciliationConnector>).reconcileApproval === "function";
}

function safeText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(trimmed)
    ? trimmed : null;
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

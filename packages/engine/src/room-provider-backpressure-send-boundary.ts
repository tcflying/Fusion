import {
  hashRoomValue,
  type BeginRoomDeliveryAttemptInput,
  type RoomBindingRecordV1,
  type RoomOutboxRecordV1,
  type RoomProviderBackpressureControllerResultV1,
  type RoomProviderBackpressurePolicyV1,
  type RoomProviderBackpressureScopeV1,
  type RoomProviderBackpressureTelemetryV1,
  type SessionConnectorIdentityV1,
  type SessionConnectorResultV1,
  type SessionConnectorSendReceiptV1,
} from "@fusion/core";

export const ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION = 1 as const;

export interface RoomProviderBackpressureSendRequestBindingV1 {
  readonly contractVersion: typeof ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION;
  readonly delivery: Readonly<Pick<
    RoomOutboxRecordV1,
    "id" | "roomId" | "logicalMessageId" | "localMessageId" | "bindingId" | "idempotencyKey" | "payloadHash"
  >>;
  readonly binding: Readonly<Pick<
    RoomBindingRecordV1,
    "id" | "roomId" | "seatId" | "generation" | "connectorId" | "providerId"
    | "nativeSessionId" | "happierSessionId" | "serverProfileId" | "machineId" | "hostId"
  >>;
  readonly identity: Readonly<SessionConnectorIdentityV1>;
  readonly attemptId: string;
  readonly senderFence: NonNullable<BeginRoomDeliveryAttemptInput["senderFence"]>;
  readonly deadline: string;
}

export function createRoomProviderBackpressureSendRequestBinding(
  input: Pick<
    RoomProviderBackpressureSendGateRequestV1,
    "delivery" | "binding" | "identity" | "attemptId" | "senderFence" | "deadline"
  >,
): RoomProviderBackpressureSendRequestBindingV1 {
  return Object.freeze({
    contractVersion: ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION,
    delivery: Object.freeze({
      id: input.delivery.id,
      roomId: input.delivery.roomId,
      logicalMessageId: input.delivery.logicalMessageId,
      localMessageId: input.delivery.localMessageId,
      bindingId: input.delivery.bindingId,
      idempotencyKey: input.delivery.idempotencyKey,
      payloadHash: input.delivery.payloadHash,
    }),
    binding: Object.freeze({
      id: input.binding.id,
      roomId: input.binding.roomId,
      seatId: input.binding.seatId,
      generation: input.binding.generation,
      connectorId: input.binding.connectorId,
      providerId: input.binding.providerId,
      nativeSessionId: input.binding.nativeSessionId,
      happierSessionId: input.binding.happierSessionId,
      serverProfileId: input.binding.serverProfileId,
      machineId: input.binding.machineId,
      hostId: input.binding.hostId,
    }),
    identity: Object.freeze({ ...input.identity }),
    attemptId: input.attemptId,
    senderFence: Object.freeze({ ...input.senderFence }),
    deadline: input.deadline,
  });
}

export function hashRoomProviderBackpressureSendRequestBinding(
  binding: RoomProviderBackpressureSendRequestBindingV1,
): string {
  return hashRoomValue(binding);
}

/**
 * Stable durable-admission identity. Deadline and sender fence are deliberately
 * omitted: both are short-lived execution authorities that can legitimately
 * advance when a crashed Room worker recovers the same immutable outbox send.
 */
export interface RoomProviderBackpressureAdmissionReplayBindingV1 {
  readonly contractVersion: typeof ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION;
  readonly delivery: Readonly<Pick<
    RoomOutboxRecordV1,
    "id" | "roomId" | "logicalMessageId" | "localMessageId" | "bindingId" | "idempotencyKey" | "payloadHash"
  >>;
  readonly binding: Readonly<Pick<
    RoomBindingRecordV1,
    "id" | "roomId" | "seatId" | "generation" | "connectorId" | "providerId"
    | "nativeSessionId" | "happierSessionId" | "serverProfileId" | "machineId" | "hostId"
  >>;
  readonly identity: Readonly<SessionConnectorIdentityV1>;
  readonly attemptId: string;
}

export function createRoomProviderBackpressureAdmissionReplayBinding(
  input: Pick<
    RoomProviderBackpressureSendGateRequestV1,
    "delivery" | "binding" | "identity" | "attemptId"
  >,
): RoomProviderBackpressureAdmissionReplayBindingV1 {
  /*
  FNXC:RoomProviderAdmissionReplay 2026-07-19-23:21:
  An outbox generation is the durable identity of one provider admission. Its
  retry must not depend on current clock, deadline, or sender fence because a
  recovered worker changes all three while it is still proving the same exact
  delivery and native Session binding.
  */
  return Object.freeze({
    contractVersion: ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION,
    delivery: Object.freeze({
      id: input.delivery.id,
      roomId: input.delivery.roomId,
      logicalMessageId: input.delivery.logicalMessageId,
      localMessageId: input.delivery.localMessageId,
      bindingId: input.delivery.bindingId,
      idempotencyKey: input.delivery.idempotencyKey,
      payloadHash: input.delivery.payloadHash,
    }),
    binding: Object.freeze({
      id: input.binding.id,
      roomId: input.binding.roomId,
      seatId: input.binding.seatId,
      generation: input.binding.generation,
      connectorId: input.binding.connectorId,
      providerId: input.binding.providerId,
      nativeSessionId: input.binding.nativeSessionId,
      happierSessionId: input.binding.happierSessionId,
      serverProfileId: input.binding.serverProfileId,
      machineId: input.binding.machineId,
      hostId: input.binding.hostId,
    }),
    identity: Object.freeze({ ...input.identity }),
    attemptId: input.attemptId,
  });
}

export function hashRoomProviderBackpressureAdmissionReplayBinding(
  binding: RoomProviderBackpressureAdmissionReplayBindingV1,
): string {
  return hashRoomValue(binding);
}

export interface RoomProviderBackpressureSendGateRequestV1 {
  readonly contractVersion: typeof ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION;
  readonly delivery: RoomOutboxRecordV1;
  readonly binding: RoomBindingRecordV1;
  readonly identity: SessionConnectorIdentityV1;
  readonly attemptId: string;
  readonly senderFence: NonNullable<BeginRoomDeliveryAttemptInput["senderFence"]>;
  readonly asOf: string;
  /** Immutable admission deadline. A gate receives an abort signal at this deadline. */
  readonly deadline: string;
  /** Aborts on dispatch cancellation or the immutable admission deadline. */
  readonly signal: AbortSignal;
  readonly requestBinding: RoomProviderBackpressureSendRequestBindingV1;
  readonly requestHash: string;
}

/**
 * This is intentionally an explicit snapshot rather than data synthesized from
 * a Room binding. Bindings identify only provider/connector/session ownership;
 * the account, model, node, telemetry, policy, and durable admission decision
 * must arrive from the provider-aware authority that owns those facts.
 */
export interface RoomProviderBackpressureSendAuthorityV1 {
  readonly scope: RoomProviderBackpressureScopeV1;
  readonly telemetry: RoomProviderBackpressureTelemetryV1;
  readonly policy: RoomProviderBackpressurePolicyV1;
  readonly decision: RoomProviderBackpressureControllerResultV1;
}

/**
 * Immutable reservation evidence needed if a pre-send cleanup cannot settle.
 * A later recovery worker may record expiry evidence, but it must never forge a
 * release with this historical worker fence.
 */
export interface RoomProviderBackpressureSendPermitCleanupDescriptorV1 {
  readonly claimId: string;
  readonly originalWorkerFence: {
    readonly leaseId: string;
    readonly holderId: string;
    readonly hostId: string;
    readonly epoch: number;
  };
  readonly expectedAggregateVersion: number;
  readonly reservationExpiresAt: string;
}

export type RoomProviderBackpressureSendCompletionV1 =
  | {
      readonly kind: "not_started";
      readonly completedAt: string;
    }
  | {
      readonly kind: "connector_result";
      readonly completedAt: string;
      /** Outcome-only handoff; connector messages and payloads never cross this boundary. */
      readonly outcome: SessionConnectorSendReceiptV1["outcome"] | "error";
      readonly connectorErrorCode: string | null;
      readonly retryAfterMs: number | null;
    }
  | {
      readonly kind: "connector_exception";
      readonly completedAt: string;
    };

/** Stable caller-chosen replay identity for one reservation lease renewal. */
export interface RoomProviderBackpressureSendPermitRenewInputV1 {
  readonly asOf: string;
  readonly operationId: string;
}

export type RoomProviderBackpressureSendPermitRenewResultV1 =
  | {
      readonly action: "renewed";
      readonly expiresAt: string;
      readonly replayed: boolean;
    }
  | {
      readonly action: "defer";
      readonly reason: string;
      readonly retryAfterMs: number;
    };

/**
 * Cleanup is intentionally separate from connector delivery. A known connector
 * receipt remains authoritative even if durable capacity accounting is delayed.
 */
export type RoomProviderBackpressureSendPermitCleanupResultV1 =
  | {
      readonly action: "released";
    }
  | {
      readonly action: "cleanup_failed";
      readonly reason: string;
      readonly retryAfterMs: number;
    };

export interface RoomProviderBackpressureSendPermitV1 {
  readonly contractVersion: typeof ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION;
  /** Opaque Core reservation identity; the Engine neither creates nor rewrites it. */
  readonly reservationId: string;
  /** Stable request identity used by the durable provider-admission owner. */
  readonly requestId: string;
  /** Exact immutable delivery/binding/identity/attempt/fence binding of this reservation. */
  readonly requestBinding: RoomProviderBackpressureSendRequestBindingV1;
  readonly requestHash: string;
  /** The reservation cannot authorize a send at or after this instant. */
  readonly expiresAt: string;
  readonly authority: RoomProviderBackpressureSendAuthorityV1;
  /** Present only when a durable provider gate can prove the original reservation fence. */
  readonly cleanupDescriptor?: RoomProviderBackpressureSendPermitCleanupDescriptorV1;
  /** Available on durable Engine permits; optional to preserve legacy gate compatibility. */
  renew?(input: RoomProviderBackpressureSendPermitRenewInputV1): Promise<RoomProviderBackpressureSendPermitRenewResultV1>;
  /** Release capacity without changing the already-known connector result. */
  release?(input: RoomProviderBackpressureSendCompletionV1): Promise<RoomProviderBackpressureSendPermitCleanupResultV1>;
  complete(
    input: RoomProviderBackpressureSendCompletionV1,
  ): Promise<RoomProviderBackpressureSendPermitCleanupResultV1 | void>;
}

export type RoomProviderBackpressureSendGateResultV1 =
  | {
      readonly contractVersion: typeof ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION;
      readonly action: "admit";
      readonly permit: RoomProviderBackpressureSendPermitV1;
    }
  | {
      readonly contractVersion: typeof ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION;
      readonly action: "defer";
      readonly reason: string;
      /** Advisory only until a Core outbox defer transition persists it. */
      readonly retryAfterMs?: number | null;
    };

/*
FNXC:RoomProviderAdmissionTimeoutRecovery 2026-07-21-00:50:
Only a gate that commits under the exact sender fence may be recovered after a
process dies before its late admission callback. Other gates remain opaque: a
recovery worker must preserve delivery_uncertain rather than infer that no
provider permit or connector send happened.
*/
export interface RoomProviderBackpressureAdmissionTimeoutRecoveryProtocolV1 {
  readonly contractVersion: typeof ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION;
  readonly kind: "core_sender_fenced_v1";
}

/**
 * The eventual Core-backed implementation owns read/decide/commit/release.
 * Engine can only ask it to admit one exact connector send and report whether
 * that send started or how it finished.
 */
export interface RoomProviderBackpressureSendGateV1 {
  readonly timeoutRecoveryProtocol?: RoomProviderBackpressureAdmissionTimeoutRecoveryProtocolV1;
  admit(input: RoomProviderBackpressureSendGateRequestV1): Promise<RoomProviderBackpressureSendGateResultV1>;
}

export type RoomProviderBackpressureSendPreflightV1 =
  | {
      readonly action: "admit";
      readonly permit: RoomProviderBackpressureSendPermitV1;
    }
  | {
      readonly action: "defer";
      readonly reason: string;
      readonly retryAfterMs: number | null;
    };

/**
 * Called only after a provider gate admits after the caller's deadline already
 * won. A durable coordinator may first record the immutable reservation fence,
 * then invoke the original permit completion without letting that sidecar block
 * the caller that already deferred the delivery.
 */
export type RoomProviderBackpressureLateAdmittedPermitHandlerV1 = (input: {
  readonly permit: RoomProviderBackpressureSendPermitV1;
  readonly request: RoomProviderBackpressureSendGateRequestV1;
}) => Promise<void>;

/**
 * Receives a late-admission durability failure so the owner can replay the same
 * idempotent Core fence rather than silently treating a lost response as a
 * completed provider boundary.
 */
export type RoomProviderBackpressureLateAdmittedPermitFailureHandlerV1 = (input: {
  readonly permit: RoomProviderBackpressureSendPermitV1;
  readonly request: RoomProviderBackpressureSendGateRequestV1;
  readonly error: unknown;
}) => Promise<void>;

/**
 * Runs after the caller's deadline wins but before its retryable timeout is
 * exposed. The request is the sole durable-fence input; a timeout does not
 * imply any provider outcome.
 */
export type RoomProviderBackpressureGateTimeoutHandlerV1 = (input: {
  readonly request: RoomProviderBackpressureSendGateRequestV1;
}) => Promise<void>;

/** A runtime-validated terminal gate outcome that proves no permit was issued. */
export type RoomProviderBackpressureLateNoPermitOutcomeV1 = Extract<
  RoomProviderBackpressureSendGateResultV1,
  { readonly action: "defer" }
>;

/**
 * Runs only after a timeout fence completes and the original gate later
 * returns a valid terminal no-permit outcome. Rejections and malformed gate
 * values deliberately leave the timeout fence unresolved.
 */
export type RoomProviderBackpressureLateNoPermitHandlerV1 = (input: {
  readonly request: RoomProviderBackpressureSendGateRequestV1;
  readonly outcome: RoomProviderBackpressureLateNoPermitOutcomeV1;
}) => Promise<void>;

/**
 * A callback failed after its timeout fence was exposed. This is a terminal
 * coordinator signal: it is not a no-permit result and cannot release the
 * existing fence or authorize a connector send.
 */
export type RoomProviderBackpressureLateSettlementFailureV1 =
  | {
      readonly callback: "onLateNoPermit";
      readonly request: RoomProviderBackpressureSendGateRequestV1;
      readonly outcome: RoomProviderBackpressureLateNoPermitOutcomeV1;
      readonly error: unknown;
    }
  | {
      readonly callback: "onLateAdmittedPermit" | "onLateAdmittedPermitFailure";
      readonly request: RoomProviderBackpressureSendGateRequestV1;
      readonly permit: RoomProviderBackpressureSendPermitV1;
      readonly error: unknown;
    };

/**
 * Persists or otherwise records an unresolved late-settlement failure. If this
 * reporter itself fails, the original timeout fence deliberately remains in
 * force; the boundary never converts that failure into a retryable defer.
 */
export type RoomProviderBackpressureLateSettlementFailureHandlerV1 = (
  input: RoomProviderBackpressureLateSettlementFailureV1,
) => Promise<void>;

/**
 * Coordinator callbacks for a gate whose response may outlive the caller's
 * deadline. The boundary preserves the timeout fence until only a validated
 * terminal result can resolve it.
 */
export interface RoomProviderBackpressureGateTimeoutCallbacksV1 {
  /** Required at runtime whenever any late-settlement callback is configured. */
  readonly onTimeout?: RoomProviderBackpressureGateTimeoutHandlerV1;
  readonly onLateNoPermit?: RoomProviderBackpressureLateNoPermitHandlerV1;
  readonly onLateAdmittedPermit?: RoomProviderBackpressureLateAdmittedPermitHandlerV1;
  readonly onLateAdmittedPermitFailure?: RoomProviderBackpressureLateAdmittedPermitFailureHandlerV1;
  readonly onLateSettlementFailure?: RoomProviderBackpressureLateSettlementFailureHandlerV1;
}

export class RoomProviderBackpressureGateTimeoutError extends Error {
  constructor(readonly deadline: string) {
    super("Room provider gate exceeded its admission deadline");
    this.name = "RoomProviderBackpressureGateTimeoutError";
  }
}

/** A timeout fence could not be durably established, so admission must stop. */
export class RoomProviderBackpressureGateTimeoutFenceError extends Error {
  readonly code = "provider_gate_timeout_fence_failed" as const;

  constructor(readonly fenceError: unknown) {
    super("Room provider timeout fence could not be established");
    this.name = "RoomProviderBackpressureGateTimeoutFenceError";
  }
}

export class RoomProviderBackpressurePreSendWithheldError extends Error {
  constructor(readonly reason: string) {
    super(`Room provider permit was withheld before connector send: ${reason}`);
    this.name = "RoomProviderBackpressurePreSendWithheldError";
  }
}

export class RoomProviderBackpressureCompletionUnconfirmedError extends Error {
  constructor(
    readonly connectorResult: SessionConnectorResultV1<SessionConnectorSendReceiptV1> | null,
  ) {
    super("Room provider reservation completion could not be confirmed");
    this.name = "RoomProviderBackpressureCompletionUnconfirmedError";
  }
}

/*
FNXC:RoomProviderBackpressureSendBoundary 2026-07-19-18:59:
The Room delivery path has an exact binding and connector identity but no
authoritative account, model, node, telemetry, policy, or durable reservation.
Do not derive any of those values from global controller capacity or placeholders.
When a provider gate is supplied, malformed scope, unknown/stale telemetry, or
an unconfirmed/non-durable admit is deferred before connector.send().
*/
export async function admitRoomProviderBackpressureConnectorSend(
  input: {
    readonly gate: RoomProviderBackpressureSendGateV1;
    readonly request: RoomProviderBackpressureSendGateRequestV1;
  } & RoomProviderBackpressureGateTimeoutCallbacksV1,
): Promise<RoomProviderBackpressureSendPreflightV1> {
  /*
  FNXC:RoomProviderTimeoutFenceCallbackContract 2026-07-20:
  A late-settlement callback can act only on a request that first acquired a
  durable timeout tombstone. Reject its incomplete callback configuration
  before starting the gate, so no unfenced retryable timeout can escape.
  */
  if (requiresProviderGateTimeoutFence(input) && input.onTimeout === undefined) {
    throw missingProviderGateTimeoutFenceError();
  }
  let raw: unknown;
  try {
    raw = await raceProviderGateAdmission(
      input.gate,
      input.request,
      input,
    );
  } catch (error) {
    if (error instanceof RoomProviderBackpressureGateTimeoutError) {
      return deferred("provider_gate_timeout");
    }
    if (error instanceof RoomProviderBackpressureGateTimeoutFenceError) {
      /*
      FNXC:RoomProviderGateTimeoutFenceFailure 2026-07-20-23:24:
      A retryable defer would let the coordinator attempt another delivery even
      though it could not establish the timeout tombstone. Propagate this
      terminal boundary error so neither a permit nor a normal retry escapes.
      */
      throw error;
    }
    return deferred("provider_gate_unavailable");
  }

  if (!isRecord(raw) || raw.contractVersion !== ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION) {
    return deferred("provider_gate_invalid_response");
  }
  if (raw.action === "defer") {
    if (!canonicalString(raw.reason)) return deferred("provider_gate_invalid_response");
    const retryAfterMs = raw.retryAfterMs ?? null;
    if (!nullableNonNegativeSafeInteger(retryAfterMs)) {
      return deferred("provider_gate_invalid_response");
    }
    return deferred(raw.reason, retryAfterMs);
  }
  if (raw.action !== "admit" || !isRecord(raw.permit)) {
    return deferred("provider_gate_invalid_response");
  }

  const permit = raw.permit as unknown as RoomProviderBackpressureSendPermitV1;
  const invalidReason = invalidPermitReason(permit, input.request, { allowAbortedSignal: true });
  if (invalidReason !== null) {
    /*
    FNXC:RoomProviderBackpressureSendBoundary 2026-07-19-20:10:
    An invalid permit can be a replay for another delivery. Never call its
    completion endpoint, because that could mutate an unrelated reservation.
    */
    return deferred(invalidReason);
  }
  return Object.freeze({ action: "admit", permit });
}

export function revalidateAdmittedRoomProviderBackpressureConnectorSend(
  input: {
    readonly permit: RoomProviderBackpressureSendPermitV1;
    readonly request: RoomProviderBackpressureSendGateRequestV1;
    readonly asOf: string;
  },
): RoomProviderBackpressureSendPreflightV1 {
  const request = Object.freeze({ ...input.request, asOf: input.asOf });
  const invalidReason = invalidPermitReason(input.permit, request);
  return invalidReason === null
    ? Object.freeze({ action: "admit", permit: input.permit })
    : deferred(invalidReason);
}

export async function sendWithAdmittedRoomProviderBackpressure(
  input: {
    readonly permit: RoomProviderBackpressureSendPermitV1;
    readonly request: RoomProviderBackpressureSendGateRequestV1;
    readonly completedAt: () => string;
    readonly send: () => Promise<SessionConnectorResultV1<SessionConnectorSendReceiptV1>>;
    /** Optional observability hook; its failure can never replace a connector result. */
    readonly onCleanupFailure?: (failure: Extract<
      RoomProviderBackpressureSendPermitCleanupResultV1,
      { readonly action: "cleanup_failed" }
    >) => void;
  },
): Promise<SessionConnectorResultV1<SessionConnectorSendReceiptV1>> {
  /*
  FNXC:RoomProviderBackpressureSendBoundary 2026-07-19-20:06:
  A permit is only an authorization for its exact immutable delivery request and
  finite telemetry/lease window. Recheck it at the last possible boundary before
  connector.send(), because a slow admission must never turn stale telemetry or
  an expired reservation into an external provider side effect.
  */
  const revalidated = revalidateAdmittedRoomProviderBackpressureConnectorSend({
    permit: input.permit,
    request: input.request,
    asOf: input.completedAt(),
  });
  if (revalidated.action === "defer") {
    reportCleanupFailure(input.onCleanupFailure, await settlePermit(input.permit, {
      kind: "not_started",
      completedAt: input.completedAt(),
    }));
    throw new RoomProviderBackpressurePreSendWithheldError(revalidated.reason);
  }

  let result: SessionConnectorResultV1<SessionConnectorSendReceiptV1>;
  try {
    result = await input.send();
  } catch (error) {
    const cleanup = await settlePermit(input.permit, Object.freeze({
      kind: "connector_exception",
      completedAt: input.completedAt(),
    }));
    reportCleanupFailure(input.onCleanupFailure, cleanup);
    if (cleanup.action === "cleanup_failed") {
      throw new RoomProviderBackpressureCompletionUnconfirmedError(null);
    }
    throw error;
  }

  const cleanup = await settlePermit(input.permit, Object.freeze({
    kind: "connector_result",
    completedAt: input.completedAt(),
    outcome: result.ok ? result.value.outcome : "error",
    connectorErrorCode: result.ok ? null : result.error.code,
    retryAfterMs: result.ok ? null : result.error.retryAfterMs ?? null,
  }));
  reportCleanupFailure(input.onCleanupFailure, cleanup);
  if (cleanup.action === "cleanup_failed") {
    throw new RoomProviderBackpressureCompletionUnconfirmedError(result);
  }
  return result;
}

export async function abandonAdmittedRoomProviderBackpressure(
  permit: RoomProviderBackpressureSendPermitV1,
  completedAt: string,
): Promise<void> {
  await permit.complete(Object.freeze({ kind: "not_started", completedAt }));
}

function invalidPermitReason(
  permit: RoomProviderBackpressureSendPermitV1,
  request: RoomProviderBackpressureSendGateRequestV1,
  options: { readonly allowAbortedSignal?: boolean } = {},
): string | null {
  if (
    permit.contractVersion !== ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION
    || !canonicalString(permit.reservationId)
    || !canonicalString(permit.requestId)
    || !canonicalString(permit.requestHash)
    || !canonicalTimestamp(permit.expiresAt)
    || typeof permit.complete !== "function"
    || !canonicalTimestamp(request.asOf)
    || !canonicalTimestamp(request.deadline)
    || !isAbortSignal(request.signal)
  ) {
    return "provider_gate_invalid_response";
  }
  const asOf = Date.parse(request.asOf);
  const deadline = Date.parse(request.deadline);
  if (request.signal.aborted && options.allowAbortedSignal !== true) {
    return request.signal.reason instanceof RoomProviderBackpressureGateTimeoutError
      ? "provider_gate_timeout"
      : "provider_gate_aborted";
  }
  if (asOf >= deadline) return "provider_gate_timeout";
  if (Date.parse(permit.expiresAt) <= asOf) return "provider_permit_expired";
  if (!hasMatchingRequestBinding(permit, request)) return "provider_permit_request_mismatch";

  const authority = permit.authority;
  if (!isRecord(authority) || !isScope(authority.scope)) return "provider_scope_incomplete";
  if (
    authority.scope.providerId !== request.binding.providerId
    || authority.scope.connectorId !== request.binding.connectorId
    || authority.scope.providerId !== request.identity.providerId
    || authority.scope.connectorId !== request.identity.connectorId
  ) {
    return "provider_scope_binding_mismatch";
  }
  if (!isTelemetry(authority.telemetry)) return "provider_gate_invalid_response";
  if (!authority.telemetry.known) return "provider_telemetry_unknown";
  if (!authority.telemetry.admissionConfirmed) return "provider_admission_unconfirmed";
  if (!isPolicy(authority.policy)) return "provider_policy_invalid";

  const observedAt = Date.parse(authority.telemetry.observedAt);
  if (asOf < observedAt || asOf - observedAt > authority.policy.telemetryTtlMs) {
    return "provider_telemetry_stale";
  }
  return isAdmittedDecision(authority.decision, authority.scope)
    ? null
    : "provider_decision_invalid";
}

function hasMatchingRequestBinding(
  permit: RoomProviderBackpressureSendPermitV1,
  request: RoomProviderBackpressureSendGateRequestV1,
): boolean {
  if (!isRecord(permit.requestBinding) || !isRecord(request.requestBinding)) return false;
  try {
    const expected = createRoomProviderBackpressureSendRequestBinding(request);
    const expectedHash = hashRoomProviderBackpressureSendRequestBinding(expected);
    return request.requestHash === expectedHash
      && hashRoomValue(request.requestBinding) === expectedHash
      && permit.requestHash === expectedHash
      && hashRoomValue(permit.requestBinding) === expectedHash;
  } catch {
    return false;
  }
}

function isAdmittedDecision(
  value: unknown,
  scope: RoomProviderBackpressureScopeV1,
): value is RoomProviderBackpressureControllerResultV1 {
  if (!isRecord(value) || value.contractVersion !== 1 || !isRecord(value.decision) || !isRecord(value.state)) {
    return false;
  }
  const scopeKey = toScopeKey(scope);
  return sameScope(value.scope, scope)
    && value.scopeKey === scopeKey
    && value.decision.contractVersion === 1
    && value.decision.action === "admit"
    && canonicalString(value.decision.reason)
    && nullableNonNegativeSafeInteger(value.decision.retryAfterMs)
    && nullableNonNegativeSafeInteger(value.decision.exponentialBackoffMs)
    && nullableNonNegativeSafeInteger(value.decision.retryDelayMs)
    && nullablePositiveSafeInteger(value.decision.effectiveConcurrencyCap)
    && value.state.contractVersion === 1
    && value.state.scopeKey === scopeKey
    && isCircuitState(value.state.circuitState)
    && nonNegativeSafeInteger(value.state.consecutiveFailures)
    && nonNegativeSafeInteger(value.state.retryAttempt)
    && (value.state.retryNotBefore === null || canonicalTimestamp(value.state.retryNotBefore))
    && (value.state.openUntil === null || canonicalTimestamp(value.state.openUntil))
    && typeof value.state.halfOpenProbeInFlight === "boolean"
    && canonicalTimestamp(value.state.lastUpdatedAt);
}

function isScope(value: unknown): value is RoomProviderBackpressureScopeV1 {
  return isRecord(value)
    && canonicalString(value.providerId)
    && canonicalString(value.accountId)
    && canonicalString(value.modelId)
    && canonicalString(value.connectorId)
    && canonicalString(value.nodeId);
}

function isTelemetry(value: unknown): value is RoomProviderBackpressureTelemetryV1 {
  return isRecord(value)
    && typeof value.known === "boolean"
    && typeof value.admissionConfirmed === "boolean"
    && nonNegativeSafeInteger(value.activeRequests)
    && canonicalTimestamp(value.observedAt);
}

function isPolicy(value: unknown): value is RoomProviderBackpressurePolicyV1 {
  return isRecord(value)
    && positiveSafeInteger(value.concurrencyCap)
    && nonNegativeSafeInteger(value.reservedVerifierSlots)
    && nonNegativeSafeInteger(value.reservedRecoverySlots)
    && value.reservedVerifierSlots + value.reservedRecoverySlots < value.concurrencyCap
    && nonNegativeSafeInteger(value.telemetryTtlMs)
    && positiveSafeInteger(value.failureThreshold)
    && positiveSafeInteger(value.maxRetryAttempts)
    && positiveSafeInteger(value.baseBackoffMs)
    && positiveSafeInteger(value.maxBackoffMs)
    && value.baseBackoffMs <= value.maxBackoffMs
    && positiveSafeInteger(value.circuitOpenMs);
}

async function settlePermit(
  permit: RoomProviderBackpressureSendPermitV1,
  completion: RoomProviderBackpressureSendCompletionV1,
): Promise<RoomProviderBackpressureSendPermitCleanupResultV1> {
  try {
    const result = await permit.complete(completion);
    if (result === undefined) return Object.freeze({ action: "released" });
    if (
      isRecord(result)
      && result.action === "released"
    ) {
      return Object.freeze({ action: "released" });
    }
    if (
      isRecord(result)
      && result.action === "cleanup_failed"
      && canonicalString(result.reason)
      && nonNegativeSafeInteger(result.retryAfterMs)
    ) {
      return Object.freeze({
        action: "cleanup_failed",
        reason: result.reason,
        retryAfterMs: result.retryAfterMs,
      });
    }
  } catch {
    // A failed compensation must not turn a pre-send refusal into a send.
  }
  return Object.freeze({
    action: "cleanup_failed",
    reason: "provider_reservation_cleanup_failed",
    retryAfterMs: 1_000,
  });
}

function reportCleanupFailure(
  report: ((failure: Extract<
    RoomProviderBackpressureSendPermitCleanupResultV1,
    { readonly action: "cleanup_failed" }
  >) => void) | undefined,
  result: RoomProviderBackpressureSendPermitCleanupResultV1,
): void {
  if (result.action !== "cleanup_failed" || report === undefined) return;
  try {
    report(result);
  } catch {
    // Observability cannot overwrite a connector result or change send control flow.
  }
}

function deferred(
  reason: string,
  retryAfterMs: number | null = null,
): RoomProviderBackpressureSendPreflightV1 {
  return Object.freeze({ action: "defer", reason, retryAfterMs });
}

function raceProviderGateAdmission(
  gate: RoomProviderBackpressureSendGateV1,
  request: RoomProviderBackpressureSendGateRequestV1,
  callbacks: RoomProviderBackpressureGateTimeoutCallbacksV1,
): Promise<RoomProviderBackpressureSendGateResultV1> {
  if (request.signal.aborted) {
    const reason = request.signal.reason ?? new RoomProviderBackpressureGateTimeoutError(request.deadline);
    if (reason instanceof RoomProviderBackpressureGateTimeoutError) {
      return runProviderGateTimeoutFence(callbacks.onTimeout, request).then(() => {
        throw reason;
      });
    }
    return Promise.reject(reason);
  }
  return new Promise<RoomProviderBackpressureSendGateResultV1>((resolve, reject) => {
    let settled = false;
    let abortGrace: ReturnType<typeof setTimeout> | null = null;
    let timeoutFence: Promise<void> | null = null;
    const cleanup = () => {
      if (abortGrace !== null) clearTimeout(abortGrace);
      request.signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (request.signal.reason instanceof RoomProviderBackpressureGateTimeoutError) {
        if (settled) return;
        settled = true;
        cleanup();
        timeoutFence = runProviderGateTimeoutFence(callbacks.onTimeout, request);
        void timeoutFence.then(
          () => reject(request.signal.reason),
          (error: unknown) => reject(error),
        );
        return;
      }
      /*
      FNXC:RoomProviderGateAbortCleanup 2026-07-19-23:16:
      A provider gate can finish an already-durable admission in the same event
      turn that caller cancellation arrives. Give its resolved permit one
      microtask turn to reach the coordinator for sender-fenced cleanup; a
      genuinely late admit is released here instead of being silently lost.
      */
      abortGrace ??= setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(request.signal.reason ?? new RoomProviderBackpressureGateTimeoutError(request.deadline));
      }, 0);
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    let operation: Promise<RoomProviderBackpressureSendGateResultV1>;
    try {
      operation = gate.admit(request);
    } catch (error) {
      cleanup();
      reject(error);
      return;
    }
    operation.then((result) => {
      if (settled) {
        resolveLateProviderGateResultAfterCallerSettles(result, request, callbacks, timeoutFence);
        return;
      }
      settled = true;
      cleanup();
      resolve(result);
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
  });
}

function runProviderGateTimeoutFence(
  onTimeout: RoomProviderBackpressureGateTimeoutHandlerV1 | undefined,
  request: RoomProviderBackpressureSendGateRequestV1,
): Promise<void> {
  if (onTimeout === undefined) return Promise.resolve();
  try {
    return Promise.resolve(onTimeout(Object.freeze({ request }))).catch((error: unknown) => {
      throw timeoutFenceError(error);
    });
  } catch (error) {
    return Promise.reject(timeoutFenceError(error));
  }
}

function requiresProviderGateTimeoutFence(
  callbacks: RoomProviderBackpressureGateTimeoutCallbacksV1,
): boolean {
  return callbacks.onLateNoPermit !== undefined
    || callbacks.onLateAdmittedPermit !== undefined
    || callbacks.onLateAdmittedPermitFailure !== undefined
    || callbacks.onLateSettlementFailure !== undefined;
}

function missingProviderGateTimeoutFenceError(): RoomProviderBackpressureGateTimeoutFenceError {
  return new RoomProviderBackpressureGateTimeoutFenceError(
    new Error("Late provider settlement callbacks require an onTimeout fence"),
  );
}

function timeoutFenceError(error: unknown): RoomProviderBackpressureGateTimeoutFenceError {
  return error instanceof RoomProviderBackpressureGateTimeoutFenceError
    ? error
    : new RoomProviderBackpressureGateTimeoutFenceError(error);
}

function resolveLateProviderGateResultAfterCallerSettles(
  result: RoomProviderBackpressureSendGateResultV1,
  request: RoomProviderBackpressureSendGateRequestV1,
  callbacks: RoomProviderBackpressureGateTimeoutCallbacksV1,
  timeoutFence: Promise<void> | null,
): void {
  const resolveLateResult = () => resolveLateProviderGateResult(
    result,
    request,
    callbacks,
    timeoutFence !== null,
  );
  if (timeoutFence === null) {
    void resolveLateResult().catch(() => undefined);
    return;
  }
  void timeoutFence.then(
    resolveLateResult,
    () => undefined,
  ).catch(() => undefined);
}

async function resolveLateProviderGateResult(
  result: RoomProviderBackpressureSendGateResultV1,
  request: RoomProviderBackpressureSendGateRequestV1,
  callbacks: RoomProviderBackpressureGateTimeoutCallbacksV1,
  timedOut: boolean,
): Promise<void> {
  const terminalNoPermit = timedOut ? validLateNoPermitOutcome(result) : null;
  if (terminalNoPermit !== null) {
    if (callbacks.onLateNoPermit !== undefined) {
      try {
        await callbacks.onLateNoPermit(Object.freeze({ request, outcome: terminalNoPermit }));
      } catch (error) {
        await reportLateSettlementFailure(callbacks.onLateSettlementFailure, Object.freeze({
          callback: "onLateNoPermit" as const,
          request,
          outcome: terminalNoPermit,
          error,
        }));
      }
    }
    return;
  }
  await releaseLateAdmittedPermit(
    result,
    request,
    callbacks.onLateAdmittedPermit,
    callbacks.onLateAdmittedPermitFailure,
    timedOut ? callbacks.onLateSettlementFailure : undefined,
  );
}

async function reportLateSettlementFailure(
  report: RoomProviderBackpressureLateSettlementFailureHandlerV1 | undefined,
  failure: RoomProviderBackpressureLateSettlementFailureV1,
): Promise<void> {
  if (report === undefined) return;
  try {
    await report(failure);
  } catch {
    // The successful timeout callback owns the still-active durable fence.
  }
}

function validLateNoPermitOutcome(
  result: unknown,
): RoomProviderBackpressureLateNoPermitOutcomeV1 | null {
  if (
    !isRecord(result)
    || result.contractVersion !== ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION
    || result.action !== "defer"
    || "permit" in result
    || !canonicalString(result.reason)
  ) {
    return null;
  }
  if (result.retryAfterMs === undefined) {
    return Object.freeze({
      contractVersion: ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION,
      action: "defer",
      reason: result.reason,
    });
  }
  if (!nullableNonNegativeSafeInteger(result.retryAfterMs)) return null;
  return Object.freeze({
    contractVersion: ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION,
    action: "defer",
    reason: result.reason,
    retryAfterMs: result.retryAfterMs,
  });
}

async function releaseLateAdmittedPermit(
  result: RoomProviderBackpressureSendGateResultV1,
  request: RoomProviderBackpressureSendGateRequestV1,
  onLateAdmittedPermit: RoomProviderBackpressureLateAdmittedPermitHandlerV1 | undefined,
  onLateAdmittedPermitFailure: RoomProviderBackpressureLateAdmittedPermitFailureHandlerV1 | undefined,
  onLateSettlementFailure: RoomProviderBackpressureLateSettlementFailureHandlerV1 | undefined,
): Promise<void> {
  if (!isRecord(result) || result.action !== "admit" || !isRecord(result.permit)) return;
  const permit = result.permit as unknown as RoomProviderBackpressureSendPermitV1;
  if (invalidPermitReason(permit, request, { allowAbortedSignal: true }) !== null) return;
  /*
  FNXC:RoomProviderLateAdmissionCleanup 2026-07-20-00:45:
  Once the caller timed out, the late permit is no longer allowed to affect the
  outbox. A canonical coordinator owns durable cleanup admission; if that
  callback cannot persist its fence, do not fall through to an untracked
  release. The Core reservation TTL is the remaining fail-closed boundary.
  */
  if (onLateAdmittedPermit !== undefined) {
    try {
      await onLateAdmittedPermit(Object.freeze({ permit, request }));
    } catch (error) {
      if (onLateAdmittedPermitFailure === undefined) {
        await reportLateSettlementFailure(onLateSettlementFailure, Object.freeze({
          callback: "onLateAdmittedPermit" as const,
          request,
          permit,
          error,
        }));
        return;
      }
      try {
        await onLateAdmittedPermitFailure(Object.freeze({ permit, request, error }));
      } catch (recoveryError) {
        await reportLateSettlementFailure(onLateSettlementFailure, Object.freeze({
          callback: "onLateAdmittedPermitFailure" as const,
          request,
          permit,
          error: recoveryError,
        }));
      }
    }
    return;
  }
  try {
    await Promise.resolve(permit.complete(Object.freeze({
      kind: "not_started" as const,
      completedAt: request.asOf,
    })));
  } catch {
    // The original admission is already fenced by the deadline; never leak a late cleanup exception.
  }
}

function sameScope(value: unknown, scope: RoomProviderBackpressureScopeV1): boolean {
  return isRecord(value)
    && value.providerId === scope.providerId
    && value.accountId === scope.accountId
    && value.modelId === scope.modelId
    && value.connectorId === scope.connectorId
    && value.nodeId === scope.nodeId;
}

function toScopeKey(scope: RoomProviderBackpressureScopeV1): string {
  return JSON.stringify([scope.providerId, scope.accountId, scope.modelId, scope.connectorId, scope.nodeId]);
}

function isCircuitState(value: unknown): boolean {
  return value === "closed" || value === "open" || value === "half_open";
}

function canonicalString(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function canonicalTimestamp(value: unknown): value is string {
  if (!canonicalString(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return typeof value === "object"
    && value !== null
    && typeof (value as AbortSignal).aborted === "boolean"
    && typeof (value as AbortSignal).addEventListener === "function"
    && typeof (value as AbortSignal).removeEventListener === "function";
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return nonNegativeSafeInteger(value) && value > 0;
}

function nullableNonNegativeSafeInteger(value: unknown): value is number | null {
  return value === null || nonNegativeSafeInteger(value);
}

function nullablePositiveSafeInteger(value: unknown): boolean {
  return value === null || positiveSafeInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

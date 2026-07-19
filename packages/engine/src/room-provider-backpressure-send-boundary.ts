import type {
  BeginRoomDeliveryAttemptInput,
  RoomBindingRecordV1,
  RoomOutboxRecordV1,
  RoomProviderBackpressureControllerResultV1,
  RoomProviderBackpressurePolicyV1,
  RoomProviderBackpressureScopeV1,
  RoomProviderBackpressureTelemetryV1,
  SessionConnectorIdentityV1,
  SessionConnectorResultV1,
  SessionConnectorSendReceiptV1,
} from "@fusion/core";

export const ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION = 1 as const;

export interface RoomProviderBackpressureSendGateRequestV1 {
  readonly contractVersion: typeof ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION;
  readonly delivery: RoomOutboxRecordV1;
  readonly binding: RoomBindingRecordV1;
  readonly identity: SessionConnectorIdentityV1;
  readonly attemptId: string;
  readonly senderFence: NonNullable<BeginRoomDeliveryAttemptInput["senderFence"]>;
  readonly asOf: string;
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

export interface RoomProviderBackpressureSendPermitV1 {
  readonly contractVersion: typeof ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION;
  /** Opaque Core reservation identity; the Engine neither creates nor rewrites it. */
  readonly reservationId: string;
  /** Stable request identity used by the durable provider-admission owner. */
  readonly requestId: string;
  readonly authority: RoomProviderBackpressureSendAuthorityV1;
  complete(input: RoomProviderBackpressureSendCompletionV1): Promise<void>;
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
    };

/**
 * The eventual Core-backed implementation owns read/decide/commit/release.
 * Engine can only ask it to admit one exact connector send and report whether
 * that send started or how it finished.
 */
export interface RoomProviderBackpressureSendGateV1 {
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
    };

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
  },
): Promise<RoomProviderBackpressureSendPreflightV1> {
  let raw: unknown;
  try {
    raw = await input.gate.admit(input.request);
  } catch {
    return deferred("provider_gate_unavailable");
  }

  if (!isRecord(raw) || raw.contractVersion !== ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION) {
    return deferred("provider_gate_invalid_response");
  }
  if (raw.action === "defer") {
    return canonicalString(raw.reason)
      ? deferred(raw.reason)
      : deferred("provider_gate_invalid_response");
  }
  if (raw.action !== "admit" || !isRecord(raw.permit)) {
    return deferred("provider_gate_invalid_response");
  }

  const permit = raw.permit as unknown as RoomProviderBackpressureSendPermitV1;
  const invalidReason = invalidPermitReason(permit, input.request);
  if (invalidReason !== null) {
    await settleIfPresent(permit, {
      kind: "not_started",
      completedAt: input.request.asOf,
    });
    return deferred(invalidReason);
  }
  return Object.freeze({ action: "admit", permit });
}

export async function sendWithAdmittedRoomProviderBackpressure(
  input: {
    readonly permit: RoomProviderBackpressureSendPermitV1;
    readonly completedAt: () => string;
    readonly send: () => Promise<SessionConnectorResultV1<SessionConnectorSendReceiptV1>>;
  },
): Promise<SessionConnectorResultV1<SessionConnectorSendReceiptV1>> {
  let result: SessionConnectorResultV1<SessionConnectorSendReceiptV1>;
  try {
    result = await input.send();
  } catch (error) {
    await settleIfPresent(input.permit, {
      kind: "connector_exception",
      completedAt: input.completedAt(),
    });
    throw error;
  }

  await input.permit.complete(Object.freeze({
    kind: "connector_result",
    completedAt: input.completedAt(),
    outcome: result.ok ? result.value.outcome : "error",
    connectorErrorCode: result.ok ? null : result.error.code,
    retryAfterMs: result.ok ? null : result.error.retryAfterMs ?? null,
  }));
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
): string | null {
  if (
    permit.contractVersion !== ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION
    || !canonicalString(permit.reservationId)
    || !canonicalString(permit.requestId)
    || typeof permit.complete !== "function"
    || !canonicalTimestamp(request.asOf)
  ) {
    return "provider_gate_invalid_response";
  }

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
  const asOf = Date.parse(request.asOf);
  if (asOf < observedAt || asOf - observedAt > authority.policy.telemetryTtlMs) {
    return "provider_telemetry_stale";
  }
  return isAdmittedDecision(authority.decision, authority.scope)
    ? null
    : "provider_decision_invalid";
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

async function settleIfPresent(
  permit: unknown,
  completion: RoomProviderBackpressureSendCompletionV1,
): Promise<void> {
  if (!isRecord(permit) || typeof permit.complete !== "function") return;
  try {
    await (permit.complete as (input: RoomProviderBackpressureSendCompletionV1) => Promise<void>)(completion);
  } catch {
    // A failed compensation must not turn a pre-send refusal into a send.
  }
}

function deferred(reason: string): RoomProviderBackpressureSendPreflightV1 {
  return Object.freeze({ action: "defer", reason });
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

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value: unknown): value is number {
  return nonNegativeSafeInteger(value) && value > 0;
}

function nullableNonNegativeSafeInteger(value: unknown): boolean {
  return value === null || nonNegativeSafeInteger(value);
}

function nullablePositiveSafeInteger(value: unknown): boolean {
  return value === null || positiveSafeInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

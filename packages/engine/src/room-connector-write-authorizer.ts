import {
  hashRoomValue,
  type AsyncRoomLeaseStore,
  type RoomBindingRecordV1,
  type RoomOutboxRecordV1,
  type SessionConnectorDeliveryAuthorizationV1,
  type SessionConnectorWriteAuthorizationDecisionV1,
  type SessionConnectorWriteAuthorizationRequestV1,
  type SessionConnectorWriteAuthorizerV1,
} from "@fusion/core";

export interface RoomConnectorWriteAuthorizationStoreV1 {
  getDelivery(outboxId: string): Promise<RoomOutboxRecordV1 | null>;
  getBinding(bindingId: string): Promise<RoomBindingRecordV1 | null>;
}

export interface CreateRoomOutboxSessionConnectorWriteAuthorizerInputV1 {
  readonly store: RoomConnectorWriteAuthorizationStoreV1;
  readonly senderLeaseStore: Pick<AsyncRoomLeaseStore, "assertFence">;
  readonly now?: () => string;
}

const denied = (): SessionConnectorWriteAuthorizationDecisionV1 => Object.freeze({ authorized: false });

/**
 * FNXC:RoomOutboxWriteAuthorizer 2026-07-20-11:46:
 * A Session Connector has no standing mutation permission. The only accepted
 * send is the exact payload of a currently-dispatching durable outbox item,
 * bound to its exact Session identity and current sender lease fence. This
 * deliberately denies interrupt until it has an equivalent durable control
 * command; a plugin setting, dashboard payload, or stale worker cannot mint a
 * provider write by calling this seam directly.
 */
export function createRoomOutboxSessionConnectorWriteAuthorizer(
  input: CreateRoomOutboxSessionConnectorWriteAuthorizerInputV1,
): SessionConnectorWriteAuthorizerV1 {
  const now = input.now ?? (() => new Date().toISOString());
  return Object.freeze({
    authorize: async (request: SessionConnectorWriteAuthorizationRequestV1): Promise<SessionConnectorWriteAuthorizationDecisionV1> => {
      try {
        if (!isAuthorizedSendShape(request)) return denied();
        const authorization = request.deliveryAuthorization;
        const delivery = await input.store.getDelivery(authorization.outboxId);
        if (!delivery || !matchesDelivery(delivery, request, authorization)) return denied();
        const binding = await input.store.getBinding(delivery.bindingId);
        if (!binding || !matchesBinding(binding, request, authorization)) return denied();
        if (!matchesScopeFingerprint(request, authorization)) return denied();
        await input.senderLeaseStore.assertFence({
          ...authorization.senderFence,
          now: now(),
        });
        return Object.freeze({
          authorized: true,
          authorizationId: `room-outbox-write:${hashRoomValue({
            outboxId: delivery.id,
            attemptCount: delivery.attemptCount,
            bindingId: delivery.bindingId,
            idempotencyKey: delivery.idempotencyKey,
            payloadHash: delivery.payloadHash,
            senderFence: authorization.senderFence,
          })}`,
          scopeFingerprint: request.scopeFingerprint,
        });
      } catch {
        return denied();
      }
    },
  });
}

function isAuthorizedSendShape(
  request: SessionConnectorWriteAuthorizationRequestV1,
): request is SessionConnectorWriteAuthorizationRequestV1 & {
  readonly operation: "send";
  readonly bindingId: string;
  readonly logicalMessageId: string;
  readonly localMessageId: string;
  readonly contentHash: string;
  readonly deliveryAuthorization: SessionConnectorDeliveryAuthorizationV1;
  readonly canonicalSessionUri: string;
  readonly scopeFingerprint: string;
} {
  return request.contractVersion === 1
    && request.operation === "send"
    && nonEmpty(request.connectorId)
    && nonEmpty(request.identity.connectorId)
    && request.identity.connectorId === request.connectorId
    && nonEmpty(request.identity.providerId)
    && nonEmpty(request.identity.nativeSessionId)
    && nonEmpty(request.identity.hostId)
    && nonEmpty(request.canonicalSessionUri)
    && nonEmpty(request.bindingId)
    && nonEmpty(request.logicalMessageId)
    && nonEmpty(request.localMessageId)
    && nonEmpty(request.idempotencyKey)
    && nonEmpty(request.contentHash)
    && nonEmpty(request.scopeFingerprint)
    && request.reason === null
    && isDeliveryAuthorization(request.deliveryAuthorization);
}

function isDeliveryAuthorization(value: unknown): value is SessionConnectorDeliveryAuthorizationV1 {
  if (!isRecord(value) || !nonEmpty(value.outboxId) || !isRecord(value.senderFence)) return false;
  const fence = value.senderFence;
  const expectedEpoch = fence.expectedEpoch;
  return nonEmpty(fence.leaseId)
    && nonEmpty(fence.roomId)
    && fence.kind === "sender"
    && nonEmpty(fence.resourceId)
    && nonEmpty(fence.holderId)
    && nonEmpty(fence.hostId)
    && typeof expectedEpoch === "number"
    && Number.isSafeInteger(expectedEpoch)
    && expectedEpoch > 0;
}

function matchesDelivery(
  delivery: RoomOutboxRecordV1,
  request: SessionConnectorWriteAuthorizationRequestV1 & {
    readonly bindingId: string;
    readonly logicalMessageId: string;
    readonly localMessageId: string;
    readonly contentHash: string;
  },
  authorization: SessionConnectorDeliveryAuthorizationV1,
): boolean {
  return delivery.id === authorization.outboxId
    && delivery.state === "dispatching"
    && delivery.roomId === authorization.senderFence.roomId
    && delivery.bindingId === request.bindingId
    && delivery.bindingId === authorization.senderFence.resourceId
    && delivery.logicalMessageId === request.logicalMessageId
    && delivery.localMessageId === request.localMessageId
    && delivery.idempotencyKey === request.idempotencyKey
    && delivery.payloadHash === request.contentHash;
}

function matchesBinding(
  binding: RoomBindingRecordV1,
  request: SessionConnectorWriteAuthorizationRequestV1 & { readonly bindingId: string },
  authorization: SessionConnectorDeliveryAuthorizationV1,
): boolean {
  return binding.id === request.bindingId
    && binding.roomId === authorization.senderFence.roomId
    && binding.hostId === authorization.senderFence.hostId
    && binding.connectorId === request.connectorId
    && binding.connectorId === request.identity.connectorId
    && binding.providerId === request.identity.providerId
    && binding.nativeSessionId === request.identity.nativeSessionId
    && binding.happierSessionId === request.identity.happierSessionId
    && binding.serverProfileId === request.identity.serverProfileId
    && binding.machineId === request.identity.machineId
    && binding.hostId === request.identity.hostId;
}

/**
 * FNXC:RoomOutboxWriteScope 2026-07-20-22:05:
 * A provider grant is valid only for the canonical Session, durable outbox
 * payload, binding, and fenced sender that produced it. Derive the expected
 * value from the already-validated request instead of echoing an untrusted
 * connector string, so a grant cannot be replayed into another Session before
 * that connector opens MCP/provider I/O.
 */
function matchesScopeFingerprint(
  request: SessionConnectorWriteAuthorizationRequestV1 & {
    readonly operation: "send";
    readonly bindingId: string;
    readonly logicalMessageId: string;
    readonly localMessageId: string;
    readonly contentHash: string;
    readonly deliveryAuthorization: SessionConnectorDeliveryAuthorizationV1;
    readonly canonicalSessionUri: string;
    readonly scopeFingerprint: string;
  },
  authorization: SessionConnectorDeliveryAuthorizationV1,
): boolean {
  const expected = `${request.connectorId}-write-scope:${hashRoomValue({
    canonicalSessionUri: request.canonicalSessionUri,
    providerId: request.identity.providerId,
    nativeSessionId: request.identity.nativeSessionId,
    happierSessionId: request.identity.happierSessionId,
    serverProfileId: request.identity.serverProfileId,
    machineId: request.identity.machineId,
    hostId: request.identity.hostId,
    bindingId: request.bindingId,
    operation: request.operation,
    logicalMessageId: request.logicalMessageId,
    localMessageId: request.localMessageId,
    idempotencyKey: request.idempotencyKey,
    contentHash: request.contentHash,
    reason: request.reason,
    outboxId: authorization.outboxId,
    senderFence: authorization.senderFence,
  })}`;
  return request.scopeFingerprint === expected;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

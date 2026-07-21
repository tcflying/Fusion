import { hashRoomValue } from "@fusion/core";
import type {
  AsyncRoomLeaseStore,
  RoomBindingRecordV1,
  RoomOutboxRecordV1,
  SessionConnectorWriteAuthorizationRequestV1,
} from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import { createRoomOutboxSessionConnectorWriteAuthorizer } from "../room-connector-write-authorizer.js";

const FENCE = {
  leaseId: "sender-lease-1",
  roomId: "room-1",
  kind: "sender" as const,
  resourceId: "binding-1",
  holderId: "room-worker-1",
  hostId: "windows-host-1",
  expectedEpoch: 2,
};

const DELIVERY: RoomOutboxRecordV1 = {
  contractVersion: 1,
  id: "outbox-1",
  roomId: "room-1",
  logicalMessageId: "message-1",
  localMessageId: "local-message-1",
  bindingId: "binding-1",
  idempotencyKey: "delivery-idempotency-1",
  payloadHash: "sha256:payload-1",
  state: "dispatching",
  attemptCount: 1,
  connectorAcknowledgementId: null,
  nativeMessageId: null,
  nativeCursor: null,
  reconciliationFromCursor: null,
  reconciliationEvidenceRef: null,
  lastErrorCode: null,
  nextAttemptAt: null,
  updatedAt: "2026-07-20T03:46:00.000Z",
};

const BINDING: RoomBindingRecordV1 = {
  contractVersion: 1,
  id: "binding-1",
  roomId: "room-1",
  seatId: "seat-1",
  generation: 1,
  connectorId: "happier",
  providerId: "codex",
  nativeSessionId: "native-session-1",
  happierSessionId: "happier-session-1",
  serverProfileId: "profile-1",
  machineId: "machine-1",
  hostId: "windows-host-1",
  state: "attached",
  attachedAt: "2026-07-20T03:40:00.000Z",
  detachedAt: null,
  replacedByBindingId: null,
};

const CANONICAL_SESSION_URI = "codex://threads/native-session-1";

function request(overrides: Partial<SessionConnectorWriteAuthorizationRequestV1> = {}): SessionConnectorWriteAuthorizationRequestV1 {
  const value = {
    contractVersion: 1,
    connectorId: "happier",
    operation: "send",
    identity: {
      connectorId: "happier",
      providerId: "codex",
      nativeSessionId: "native-session-1",
      happierSessionId: "happier-session-1",
      serverProfileId: "profile-1",
      machineId: "machine-1",
      hostId: "windows-host-1",
    },
    canonicalSessionUri: CANONICAL_SESSION_URI,
    bindingId: "binding-1",
    logicalMessageId: "message-1",
    localMessageId: "local-message-1",
    idempotencyKey: "delivery-idempotency-1",
    contentHash: "sha256:payload-1",
    reason: null,
    deliveryAuthorization: { outboxId: "outbox-1", senderFence: FENCE },
    ...overrides,
  };
  const certifiedScopeFingerprint = overrides.scopeFingerprint
    ?? (value.deliveryAuthorization && value.canonicalSessionUri
      ? scopeFingerprint(value)
      : undefined);
  return {
    ...value,
    ...(certifiedScopeFingerprint ? { scopeFingerprint: certifiedScopeFingerprint } : {}),
  };
}

function scopeFingerprint(value: SessionConnectorWriteAuthorizationRequestV1): string {
  const authorization = value.deliveryAuthorization;
  if (!authorization || !value.canonicalSessionUri) throw new Error("test_scope_requires_delivery_and_uri");
  return `happier-write-scope:${hashRoomValue({
    canonicalSessionUri: value.canonicalSessionUri,
    providerId: value.identity.providerId,
    nativeSessionId: value.identity.nativeSessionId,
    happierSessionId: value.identity.happierSessionId,
    serverProfileId: value.identity.serverProfileId,
    machineId: value.identity.machineId,
    hostId: value.identity.hostId,
    bindingId: value.bindingId,
    operation: value.operation,
    logicalMessageId: value.logicalMessageId,
    localMessageId: value.localMessageId,
    idempotencyKey: value.idempotencyKey,
    contentHash: value.contentHash,
    reason: value.reason,
    outboxId: authorization.outboxId,
    senderFence: authorization.senderFence,
  })}`;
}

describe("Room outbox Session Connector write authorizer", () => {
  it("authorizes only the exact dispatching outbox payload under its active sender fence", async () => {
    const assertFence = vi.fn(async () => ({ id: FENCE.leaseId }));
    const authorizer = createRoomOutboxSessionConnectorWriteAuthorizer({
      store: {
        getDelivery: vi.fn(async () => DELIVERY),
        getBinding: vi.fn(async () => BINDING),
      },
      senderLeaseStore: { assertFence } as unknown as Pick<AsyncRoomLeaseStore, "assertFence">,
      now: () => "2026-07-20T03:46:10.000Z",
    });

    const authorizedRequest = request();
    await expect(authorizer.authorize(authorizedRequest)).resolves.toMatchObject({
      authorized: true,
      authorizationId: expect.stringContaining("room-outbox-write:sha256:"),
      scopeFingerprint: authorizedRequest.scopeFingerprint,
    });
    expect(assertFence).toHaveBeenCalledWith({ ...FENCE, now: "2026-07-20T03:46:10.000Z" });
  });

  it("fails closed before the lease check when any durable payload field drifts", async () => {
    const assertFence = vi.fn(async () => ({ id: FENCE.leaseId }));
    const authorizer = createRoomOutboxSessionConnectorWriteAuthorizer({
      store: {
        getDelivery: vi.fn(async () => DELIVERY),
        getBinding: vi.fn(async () => BINDING),
      },
      senderLeaseStore: { assertFence } as unknown as Pick<AsyncRoomLeaseStore, "assertFence">,
    });

    await expect(authorizer.authorize(request({ contentHash: "sha256:other" }))).resolves.toEqual({ authorized: false });
    await expect(authorizer.authorize(request({ reason: "unexpected send reason" }))).resolves.toEqual({ authorized: false });
    expect(assertFence).not.toHaveBeenCalled();
  });

  it("fails closed before the lease check when the immutable scope fingerprint is missing or replayed", async () => {
    const assertFence = vi.fn(async () => ({ id: FENCE.leaseId }));
    const authorizer = createRoomOutboxSessionConnectorWriteAuthorizer({
      store: {
        getDelivery: vi.fn(async () => DELIVERY),
        getBinding: vi.fn(async () => BINDING),
      },
      senderLeaseStore: { assertFence } as unknown as Pick<AsyncRoomLeaseStore, "assertFence">,
    });
    const valid = request();
    const { scopeFingerprint: _scopeFingerprint, ...withoutScope } = valid;
    const { canonicalSessionUri: _canonicalSessionUri, ...withoutCanonicalSessionUri } = valid;

    await expect(authorizer.authorize(withoutScope)).resolves.toEqual({ authorized: false });
    await expect(authorizer.authorize(withoutCanonicalSessionUri)).resolves.toEqual({ authorized: false });
    await expect(authorizer.authorize({
      ...valid,
      scopeFingerprint: `happier-write-scope:${hashRoomValue({ replayedBindingId: "binding-2" })}`,
    })).resolves.toEqual({ authorized: false });
    expect(assertFence).not.toHaveBeenCalled();
  });

  it("certifies every immutable target, delivery, and message field inside the scope fingerprint", async () => {
    const assertFence = vi.fn(async () => ({ id: FENCE.leaseId }));
    const authorizer = createRoomOutboxSessionConnectorWriteAuthorizer({
      store: {
        getDelivery: vi.fn(async () => DELIVERY),
        getBinding: vi.fn(async () => BINDING),
      },
      senderLeaseStore: { assertFence } as unknown as Pick<AsyncRoomLeaseStore, "assertFence">,
    });
    const valid = request();
    const authorization = valid.deliveryAuthorization;
    if (!authorization) throw new Error("test_scope_requires_delivery");
    const replayedScopes: readonly [string, SessionConnectorWriteAuthorizationRequestV1][] = [
      ["canonical URI", { ...valid, canonicalSessionUri: "codex://threads/native-session-2" }],
      ["provider", { ...valid, identity: { ...valid.identity, providerId: "claude" } }],
      ["native Session", { ...valid, identity: { ...valid.identity, nativeSessionId: "native-session-2" } }],
      ["Happier Session", { ...valid, identity: { ...valid.identity, happierSessionId: "happier-session-2" } }],
      ["server profile", { ...valid, identity: { ...valid.identity, serverProfileId: "profile-2" } }],
      ["machine", { ...valid, identity: { ...valid.identity, machineId: "machine-2" } }],
      ["host", { ...valid, identity: { ...valid.identity, hostId: "windows-host-2" } }],
      ["binding", { ...valid, bindingId: "binding-2" }],
      ["logical message", { ...valid, logicalMessageId: "message-2" }],
      ["local message", { ...valid, localMessageId: "local-message-2" }],
      ["idempotency key", { ...valid, idempotencyKey: "delivery-idempotency-2" }],
      ["content hash", { ...valid, contentHash: "sha256:payload-2" }],
      ["outbox", { ...valid, deliveryAuthorization: { ...authorization, outboxId: "outbox-2" } }],
      ["sender fence", {
        ...valid,
        deliveryAuthorization: {
          ...authorization,
          senderFence: { ...authorization.senderFence, expectedEpoch: authorization.senderFence.expectedEpoch + 1 },
        },
      }],
    ];

    for (const [field, replayedScope] of replayedScopes) {
      await expect(authorizer.authorize({
        ...valid,
        scopeFingerprint: scopeFingerprint(replayedScope),
      }), field).resolves.toEqual({ authorized: false });
    }
    expect(assertFence).not.toHaveBeenCalled();
  });

  it("fails closed when the sender fence is stale even if the outbox is still dispatching", async () => {
    const authorizer = createRoomOutboxSessionConnectorWriteAuthorizer({
      store: {
        getDelivery: vi.fn(async () => DELIVERY),
        getBinding: vi.fn(async () => BINDING),
      },
      senderLeaseStore: {
        assertFence: vi.fn(async () => {
          throw new Error("stale_lease_fence");
        }),
      } as unknown as Pick<AsyncRoomLeaseStore, "assertFence">,
    });

    await expect(authorizer.authorize(request())).resolves.toEqual({ authorized: false });
  });

  it("does not authorize an interrupt until a durable control command provides an equivalent proof", async () => {
    const authorizer = createRoomOutboxSessionConnectorWriteAuthorizer({
      store: {
        getDelivery: vi.fn(),
        getBinding: vi.fn(),
      },
      senderLeaseStore: { assertFence: vi.fn() } as unknown as Pick<AsyncRoomLeaseStore, "assertFence">,
    });

    await expect(authorizer.authorize(request({
      operation: "interrupt",
      bindingId: null,
      logicalMessageId: null,
      localMessageId: null,
      contentHash: null,
      deliveryAuthorization: null,
    }))).resolves.toEqual({ authorized: false });
  });
});

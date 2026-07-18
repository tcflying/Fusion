import { describe, expect, it } from "vitest";
import {
  SESSION_CONNECTOR_CAPABILITIES,
  buildRoomConnectorLocalMessageId,
  hashRoomValue,
  type BeginRoomDeliveryAttemptInput,
  type RoomBindingRecordV1,
  type RoomOutboxRecordV1,
  type SessionConnectorCapabilitiesV1,
  type SessionConnectorHistoryPageV1,
  type SessionConnectorIdentityV1,
  type SessionConnectorResultV1,
  type SessionConnectorSendReceiptV1,
  type SessionConnectorV1,
} from "@fusion/core";
import { SessionConnectorRegistry } from "../session-connector-registry.js";
import {
  dispatchRoomDelivery,
  reconcileAmbiguousRoomDelivery,
  type RoomDeliveryCoordinatorStore,
} from "../room-delivery-coordinator.js";

const NOW = "2026-07-17T12:00:00.000Z";
const IDENTITY: SessionConnectorIdentityV1 = {
  connectorId: "happier",
  providerId: "codex",
  nativeSessionId: "codex-session-1",
  happierSessionId: "happier-session-1",
  serverProfileId: "server-profile-1",
  machineId: "machine-1",
  hostId: "fusion-host-1",
};
const SENDER_FENCE: NonNullable<BeginRoomDeliveryAttemptInput["senderFence"]> = {
  leaseId: "sender-lease-1",
  roomId: "room-1",
  kind: "sender",
  resourceId: "binding-1",
  holderId: "sender-worker-1",
  hostId: "fusion-host-1",
  expectedEpoch: 1,
};

function delivery(state: RoomOutboxRecordV1["state"] = "pending"): RoomOutboxRecordV1 {
  const identity = {
    logicalMessageId: "message-1",
    bindingId: "binding-1",
    idempotencyKey: "room-message-1:binding-1",
    payloadHash: hashRoomValue("Only this payload may be delivered."),
  };
  return {
    contractVersion: 1,
    id: "outbox-1",
    roomId: "room-1",
    ...identity,
    localMessageId: buildRoomConnectorLocalMessageId(identity),
    state,
    attemptCount: state === "pending" ? 0 : 1,
    connectorAcknowledgementId: null,
    nativeMessageId: null,
    nativeCursor: null,
    reconciliationFromCursor: state === "pending" ? null : "cursor-before-send",
    reconciliationEvidenceRef: null,
    lastErrorCode: state === "delivery_uncertain" ? "connector_delivery_uncertain" : null,
    nextAttemptAt: null,
    updatedAt: NOW,
  };
}

class MemoryDeliveryStore implements RoomDeliveryCoordinatorStore {
  current: RoomOutboxRecordV1;
  readonly binding: RoomBindingRecordV1;
  crashOnComplete = false;
  readonly beginCalls: BeginRoomDeliveryAttemptInput[] = [];
  readonly completeCalls: unknown[] = [];
  readonly reconciliationCalls: unknown[] = [];

  constructor(
    initial: RoomOutboxRecordV1 = delivery(),
    bindingMachineId: string | null = "machine-1",
  ) {
    this.current = initial;
    this.binding = {
      contractVersion: 1,
      id: "binding-1",
      roomId: "room-1",
      seatId: "seat-1",
      generation: 1,
      connectorId: "happier",
      providerId: "codex",
      nativeSessionId: "codex-session-1",
      happierSessionId: "happier-session-1",
      serverProfileId: "server-profile-1",
      machineId: bindingMachineId,
      hostId: "fusion-host-1",
      state: "attached",
      attachedAt: NOW,
      detachedAt: null,
      replacedByBindingId: null,
    };
  }

  async getDelivery(outboxId: string): Promise<RoomOutboxRecordV1 | null> {
    return outboxId === this.current.id ? this.current : null;
  }

  async getBinding(bindingId: string): Promise<RoomBindingRecordV1 | null> {
    return bindingId === this.binding.id ? this.binding : null;
  }

  async beginDeliveryAttempt(input: Parameters<RoomDeliveryCoordinatorStore["beginDeliveryAttempt"]>[0]): Promise<RoomOutboxRecordV1> {
    this.beginCalls.push(input);
    this.current = {
      ...this.current,
      state: "dispatching",
      attemptCount: this.current.attemptCount + 1,
      reconciliationFromCursor: input.reconciliationFromCursor,
      updatedAt: input.now,
    };
    return this.current;
  }

  async completeDeliveryAttempt(input: Parameters<RoomDeliveryCoordinatorStore["completeDeliveryAttempt"]>[0]): Promise<RoomOutboxRecordV1> {
    this.completeCalls.push(input);
    if (this.crashOnComplete) throw new Error("simulated crash before acknowledgement persistence");
    this.current = {
      ...this.current,
      state: input.outcome === "confirmed" ? "confirmed" : "delivery_uncertain",
      connectorAcknowledgementId: input.connectorAcknowledgementId,
      nativeMessageId: input.nativeMessageId,
      nativeCursor: input.nativeCursor,
      lastErrorCode: input.errorCode,
      updatedAt: input.now,
    };
    return this.current;
  }

  async reconcileDelivery(input: Parameters<RoomDeliveryCoordinatorStore["reconcileDelivery"]>[0]): Promise<RoomOutboxRecordV1> {
    this.reconciliationCalls.push(input);
    if (input.expectedAttemptCount !== this.current.attemptCount) {
      throw new Error("stale reconciliation attempt");
    }
    this.current = {
      ...this.current,
      state: input.outcome,
      connectorAcknowledgementId: input.connectorAcknowledgementId,
      nativeMessageId: input.nativeMessageId,
      nativeCursor: input.nativeCursor,
      reconciliationEvidenceRef: input.evidenceRef,
      lastErrorCode: input.errorCode,
      updatedAt: input.now,
    };
    return this.current;
  }
}

function capabilities(): SessionConnectorCapabilitiesV1 {
  const verified = {
    state: "verified" as const,
    evidenceRef: "test-certification",
    reasonCode: null,
    lastVerifiedAt: NOW,
  };
  return {
    contractVersion: 1,
    connectorId: "happier",
    connectorVersion: "test",
    sourceRevision: "test",
    verifiedAt: NOW,
    capabilities: {
      ensureExisting: verified,
      create: verified,
      status: verified,
      history: verified,
      events: verified,
      send: verified,
      interrupt: verified,
      resume: verified,
      takeover: verified,
      health: verified,
      deepLinks: verified,
    },
  };
}

function connectorFixture(options: {
  sendResult?: SessionConnectorResultV1<SessionConnectorSendReceiptV1>;
  send?: SessionConnectorV1["send"];
  history?: (afterCursor: string | null) => SessionConnectorResultV1<SessionConnectorHistoryPageV1>;
  capabilities?: () => unknown;
}) {
  let sendCalls = 0;
  const historyCursors: Array<string | null> = [];
  const connector = {
    contractVersion: 1,
    id: "happier",
    version: "test",
    getCapabilities: async () => options.capabilities?.() ?? capabilities(),
    ensureExisting: async () => ({ ok: false, error: { code: "unavailable", message: "not used", retryable: false } }),
    create: async () => ({ ok: false, error: { code: "unavailable", message: "not used", retryable: false } }),
    getStatus: async () => ({ ok: false, error: { code: "unavailable", message: "not used", retryable: false } }),
    send: async (input) => {
      sendCalls += 1;
      if (options.send) return options.send(input);
      return options.sendResult ?? {
        ok: true,
        value: {
          outcome: "accepted",
          connectorAcknowledgementId: "ack-local-1",
          nativeMessageId: null,
          cursor: null,
          acceptedAt: NOW,
        },
      };
    },
    readHistory: async (input: { afterCursor: string | null }) => {
      historyCursors.push(input.afterCursor);
      return options.history?.(input.afterCursor) ?? {
        ok: true,
        value: { items: [], nextCursor: input.afterCursor, completeThroughCursor: input.afterCursor },
      };
    },
    subscribeEvents: async () => ({ ok: false, error: { code: "unavailable", message: "not used", retryable: false } }),
    interrupt: async () => ({ ok: false, error: { code: "unavailable", message: "not used", retryable: false } }),
    resume: async () => ({ ok: false, error: { code: "unavailable", message: "not used", retryable: false } }),
    takeover: async () => ({ ok: false, error: { code: "unavailable", message: "not used", retryable: false } }),
    getHealth: async () => ({
      connectorId: "happier",
      hostId: IDENTITY.hostId,
      state: "healthy",
      checkedAt: NOW,
      authentication: "authenticated",
      daemon: "running",
      server: "reachable",
      backend: "ready",
      rateLimit: "clear",
      host: "reachable",
      capabilities: Object.fromEntries(
        SESSION_CONNECTOR_CAPABILITIES.map((name) => [name, "verified"]),
      ),
      reasonCodes: [],
      retryAfterMs: null,
    }),
    getDeepLinks: async () => ({ ok: false, error: { code: "unavailable", message: "not used", retryable: false } }),
  } as unknown as SessionConnectorV1;
  const registry = new SessionConnectorRegistry({ now: () => Date.parse(NOW) });
  registry.register(connector);
  return {
    connector,
    registry,
    get sendCalls() { return sendCalls; },
    historyCursors,
  };
}

describe("Room connector delivery reconciliation", () => {
  it("does not start connector.send after Room authority is revoked at the durable claim boundary", async () => {
    const store = new MemoryDeliveryStore();
    const originalBegin = store.beginDeliveryAttempt.bind(store);
    let authorityRevoked = false;
    store.beginDeliveryAttempt = async (input) => {
      const claimed = await originalBegin(input);
      authorityRevoked = true;
      return claimed;
    };
    const fixture = connectorFixture({});

    await expect(dispatchRoomDelivery({
      store,
      registry: fixture.registry,
      identity: IDENTITY,
      outboxId: "outbox-1",
      attemptId: "attempt-authority-revoked-before-send",
      senderFence: SENDER_FENCE,
      content: "Only this payload may be delivered.",
      reconciliationFromCursor: null,
      now: NOW,
      currentTime: () => NOW,
      assertAuthority: async () => {
        if (authorityRevoked) throw new Error("room_authority_revoked");
      },
      audit: { runId: "run-authority-revoked-before-send", agentId: "worker-1" },
    })).rejects.toThrow("room_authority_revoked");

    expect(store.current).toMatchObject({ state: "dispatching", attemptCount: 1 });
    expect(fixture.sendCalls).toBe(0);
  });

  it("preserves a late send acknowledgement after controller abort once the external effect has started", async () => {
    const abortController = new AbortController();
    let resolveSend: ((value: SessionConnectorResultV1<SessionConnectorSendReceiptV1>) => void) | null = null;
    let notifySendStarted: (() => void) | null = null;
    const sendStarted = new Promise<void>((resolve) => {
      notifySendStarted = resolve;
    });
    const fixture = connectorFixture({
      send: () => new Promise((resolve) => {
        resolveSend = resolve;
        notifySendStarted?.();
      }),
    });
    const store = new MemoryDeliveryStore();

    const delivery = dispatchRoomDelivery({
      store,
      registry: fixture.registry,
      identity: IDENTITY,
      outboxId: "outbox-1",
      attemptId: "attempt-controller-abort-during-send",
      senderFence: SENDER_FENCE,
      content: "Only this payload may be delivered.",
      reconciliationFromCursor: null,
      now: NOW,
      currentTime: () => NOW,
      signal: abortController.signal,
      assertAuthority: async () => undefined,
      audit: { runId: "run-controller-abort-during-send", agentId: "worker-1" },
    });
    await sendStarted;
    abortController.abort();
    const stateBeforeReceipt = await Promise.race([
      delivery.then(() => "settled", () => "settled"),
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 5)),
    ]);
    expect(stateBeforeReceipt).toBe("waiting");
    expect(store.current).toMatchObject({ state: "dispatching", attemptCount: 1 });
    resolveSend?.({
      ok: true,
      value: {
        outcome: "accepted",
        connectorAcknowledgementId: "late-ack",
        nativeMessageId: "late-native-message",
        cursor: "late-cursor",
        acceptedAt: NOW,
      },
    });
    await expect(delivery).resolves.toMatchObject({
      state: "confirmed",
      connectorAcknowledgementId: "late-ack",
      nativeMessageId: "late-native-message",
      nativeCursor: "late-cursor",
    });
  });

  it("confirms accepted-before-crash from history without sending twice", async () => {
    const store = new MemoryDeliveryStore();
    store.crashOnComplete = true;
    const fixture = connectorFixture({
      history: () => ({
        ok: true,
        value: {
          items: [{
            nativeMessageId: "native-user-message-1",
            logicalMessageId: store.current.localMessageId,
            role: "user",
            contentHash: "sha256:opaque-provider-record",
            occurredAt: NOW,
            cursor: "cursor-accepted",
          }],
          nextCursor: "cursor-accepted",
          completeThroughCursor: "cursor-accepted",
          truncated: false,
        },
      }),
    });

    await expect(dispatchRoomDelivery({
      store,
      registry: fixture.registry,
      identity: IDENTITY,
      outboxId: "outbox-1",
      attemptId: "attempt-1",
      senderFence: SENDER_FENCE,
      content: "Only this payload may be delivered.",
      reconciliationFromCursor: "cursor-before-send",
      now: NOW,
      audit: { runId: "run-1", agentId: "worker-1" },
    })).rejects.toThrow("simulated crash");
    expect(fixture.sendCalls).toBe(1);
    expect(store.current.state).toBe("dispatching");
    expect(store.beginCalls).toHaveLength(1);
    expect(store.beginCalls[0]?.senderFence).toBe(SENDER_FENCE);

    store.crashOnComplete = false;
    const recovered = await reconcileAmbiguousRoomDelivery({
      store,
      registry: fixture.registry,
      identity: IDENTITY,
      outboxId: "outbox-1",
      historyPageSize: 50,
      maxHistoryPages: 2,
      now: "2026-07-17T12:01:00.000Z",
      audit: { runId: "run-recovery-1", agentId: "recovery-worker-1" },
    });

    expect(recovered).toMatchObject({ state: "confirmed", nativeMessageId: "native-user-message-1" });
    expect(fixture.sendCalls).toBe(1);
    expect(fixture.historyCursors).toEqual(["cursor-before-send"]);
    expect(store.reconciliationCalls).toHaveLength(1);
  });

  it("keeps delivery uncertain when provider history is unavailable and never sends", async () => {
    const store = new MemoryDeliveryStore(delivery("delivery_uncertain"));
    const fixture = connectorFixture({
      history: () => ({
        ok: false,
        error: {
          code: "host_unavailable",
          message: "Provider history is unavailable",
          retryable: true,
        },
      }),
    });

    const reconciled = await reconcileAmbiguousRoomDelivery({
      store,
      registry: fixture.registry,
      identity: IDENTITY,
      outboxId: "outbox-1",
      historyPageSize: 50,
      maxHistoryPages: 2,
      now: NOW,
      audit: { runId: "run-recovery-2", agentId: "recovery-worker-1" },
    });

    expect(reconciled).toMatchObject({ state: "delivery_uncertain" });
    expect(fixture.sendCalls).toBe(0);
    expect(store.reconciliationCalls).toHaveLength(1);
  });

  it("treats a connector transport failure as uncertain instead of rejection or retry", async () => {
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture({
      sendResult: {
        ok: false,
        error: {
          code: "transport",
          message: "Acknowledgement channel closed",
          retryable: true,
        },
      },
    });

    const result = await dispatchRoomDelivery({
      store,
      registry: fixture.registry,
      identity: IDENTITY,
      outboxId: "outbox-1",
      attemptId: "attempt-transport-1",
      senderFence: SENDER_FENCE,
      content: "Only this payload may be delivered.",
      reconciliationFromCursor: "cursor-before-send",
      now: NOW,
      audit: { runId: "run-transport-1", agentId: "worker-1" },
    });

    expect(result).toMatchObject({
      state: "delivery_uncertain",
      lastErrorCode: "connector_transport",
      nextAttemptAt: null,
    });
    expect(fixture.sendCalls).toBe(1);
    expect(store.beginCalls).toHaveLength(1);
    expect(store.beginCalls[0]?.senderFence).toBe(SENDER_FENCE);
    expect(store.completeCalls).toHaveLength(1);
  });

  it("keeps delivery uncertain when history contains multiple matching local ids", async () => {
    const store = new MemoryDeliveryStore(delivery("delivery_uncertain"));
    const matching = (nativeMessageId: string, cursor: string) => ({
      nativeMessageId,
      logicalMessageId: store.current.localMessageId,
      role: "user" as const,
      contentHash: `sha256:${nativeMessageId}`,
      occurredAt: NOW,
      cursor,
    });
    const fixture = connectorFixture({
      history: () => ({
        ok: true,
        value: {
          items: [matching("native-1", "cursor-1"), matching("native-2", "cursor-2")],
          nextCursor: "cursor-2",
          completeThroughCursor: "cursor-2",
          truncated: false,
        },
      }),
    });

    const reconciled = await reconcileAmbiguousRoomDelivery({
      store,
      registry: fixture.registry,
      identity: IDENTITY,
      outboxId: "outbox-1",
      historyPageSize: 50,
      maxHistoryPages: 2,
      now: NOW,
      audit: { runId: "run-recovery-3", agentId: "recovery-worker-1" },
    });

    expect(reconciled).toMatchObject({ state: "delivery_uncertain", lastErrorCode: "ambiguous_history_match" });
    expect(fixture.sendCalls).toBe(0);
  });

  it("does not accept the shared logical message id as binding-scoped delivery proof", async () => {
    const store = new MemoryDeliveryStore(delivery("delivery_uncertain"));
    const fixture = connectorFixture({
      history: () => ({
        ok: true,
        value: {
          items: [{
            nativeMessageId: "native-other-binding",
            logicalMessageId: store.current.logicalMessageId,
            role: "user",
            contentHash: "sha256:other-binding-payload",
            occurredAt: NOW,
            cursor: "cursor-other-binding",
          }],
          nextCursor: "cursor-other-binding",
          completeThroughCursor: "cursor-other-binding",
          truncated: false,
        },
      }),
    });

    const reconciled = await reconcileAmbiguousRoomDelivery({
      store,
      registry: fixture.registry,
      identity: IDENTITY,
      outboxId: "outbox-1",
      historyPageSize: 50,
      maxHistoryPages: 2,
      now: NOW,
      audit: { runId: "run-cross-binding", agentId: "recovery-worker-1" },
    });

    expect(reconciled).toMatchObject({
      state: "delivery_uncertain",
      lastErrorCode: "history_match_not_found",
    });
    expect(fixture.sendCalls).toBe(0);
  });

  it("rejects a different native Session identity before claiming or sending", async () => {
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture({});

    await expect(dispatchRoomDelivery({
      store,
      registry: fixture.registry,
      identity: {
        ...IDENTITY,
        nativeSessionId: "codex-session-2",
        happierSessionId: "happier-session-2",
      },
      outboxId: "outbox-1",
      attemptId: "attempt-wrong-session",
      senderFence: SENDER_FENCE,
      content: "Only this payload may be delivered.",
      reconciliationFromCursor: "cursor-before-send",
      now: NOW,
      audit: { runId: "run-wrong-session", agentId: "worker-1" },
    })).rejects.toMatchObject({ code: "delivery_identity_conflict" });
    expect(fixture.sendCalls).toBe(0);
    expect(store.beginCalls).toHaveLength(0);
  });

  it("rejects a different Happier machine identity before claiming or sending", async () => {
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture({});

    await expect(dispatchRoomDelivery({
      store,
      registry: fixture.registry,
      identity: {
        ...IDENTITY,
        machineId: "machine-2",
      },
      outboxId: "outbox-1",
      attemptId: "attempt-wrong-machine",
      senderFence: SENDER_FENCE,
      content: "Only this payload may be delivered.",
      reconciliationFromCursor: "cursor-before-send",
      now: NOW,
      audit: { runId: "run-wrong-machine", agentId: "worker-1" },
    })).rejects.toMatchObject({ code: "delivery_identity_conflict" });
    expect(fixture.sendCalls).toBe(0);
    expect(store.beginCalls).toHaveLength(0);
  });

  it("fails closed when an upgraded Happier binding has no persisted machine identity", async () => {
    const store = new MemoryDeliveryStore(delivery(), null);
    const fixture = connectorFixture({});

    await expect(dispatchRoomDelivery({
      store,
      registry: fixture.registry,
      identity: {
        ...IDENTITY,
        machineId: null,
      },
      outboxId: "outbox-1",
      attemptId: "attempt-missing-machine",
      senderFence: SENDER_FENCE,
      content: "Only this payload may be delivered.",
      reconciliationFromCursor: "cursor-before-send",
      now: NOW,
      audit: { runId: "run-missing-machine", agentId: "worker-1" },
    })).rejects.toMatchObject({ code: "delivery_identity_conflict" });
    expect(fixture.sendCalls).toBe(0);
    expect(store.beginCalls).toHaveLength(0);
  });

  it("rejects malformed capability certification before claiming or sending", async () => {
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture({
      capabilities: () => ({
        connectorId: "happier",
        capabilities: { send: { state: "verified" } },
      }),
    });

    await expect(dispatchRoomDelivery({
      store,
      registry: fixture.registry,
      identity: IDENTITY,
      outboxId: "outbox-1",
      attemptId: "attempt-malformed-certification",
      senderFence: SENDER_FENCE,
      content: "Only this payload may be delivered.",
      reconciliationFromCursor: "cursor-before-send",
      now: NOW,
      audit: { runId: "run-malformed-certification", agentId: "worker-1" },
    })).rejects.toThrow(/capabilit|contractVersion|connectorVersion/i);
    expect(fixture.sendCalls).toBe(0);
    expect(store.beginCalls).toHaveLength(0);
  });

  it("rejects history pages above the connector contract maximum before reading", async () => {
    const store = new MemoryDeliveryStore(delivery("delivery_uncertain"));
    const fixture = connectorFixture({});

    await expect(reconcileAmbiguousRoomDelivery({
      store,
      registry: fixture.registry,
      identity: IDENTITY,
      outboxId: "outbox-1",
      historyPageSize: 251,
      maxHistoryPages: 2,
      now: NOW,
      audit: { runId: "run-oversized-page", agentId: "worker-1" },
    })).rejects.toMatchObject({ code: "invalid_reconciliation_bound" });
    expect(fixture.historyCursors).toHaveLength(0);
    expect(store.reconciliationCalls).toHaveLength(0);
  });
});

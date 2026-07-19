import { describe, expect, it } from "vitest";

import {
  SESSION_CONNECTOR_CAPABILITIES,
  buildRoomConnectorLocalMessageId,
  hashRoomValue,
  type BeginRoomDeliveryAttemptInput,
  type CompleteRoomDeliveryAttemptInput,
  type ReconcileRoomDeliveryInput,
  type RoomBindingRecordV1,
  type RoomOutboxRecordV1,
  type RoomProviderBackpressurePolicyV1,
  type RoomProviderBackpressureScopeV1,
  type RoomProviderBackpressureTelemetryV1,
  type SessionConnectorIdentityV1,
  type SessionConnectorV1,
} from "@fusion/core";

import { SessionConnectorRegistry } from "../session-connector-registry.js";
import {
  dispatchRoomDelivery,
  type RoomDeliveryCoordinatorStore,
} from "../room-delivery-coordinator.js";

const NOW = "2026-07-19T10:00:00.000Z";

const IDENTITY: SessionConnectorIdentityV1 = {
  connectorId: "happier",
  providerId: "codex",
  nativeSessionId: "codex-session-1",
  happierSessionId: "happier-session-1",
  serverProfileId: "server-profile-1",
  machineId: "machine-1",
  hostId: "host-1",
};

const SENDER_FENCE: NonNullable<BeginRoomDeliveryAttemptInput["senderFence"]> = {
  leaseId: "sender-lease-1",
  roomId: "room-1",
  kind: "sender",
  resourceId: "binding-1",
  holderId: "worker-1",
  hostId: "host-1",
  expectedEpoch: 1,
};

class MemoryDeliveryStore implements RoomDeliveryCoordinatorStore {
  current = createDelivery();
  readonly binding: RoomBindingRecordV1 = {
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
    machineId: "machine-1",
    hostId: "host-1",
    state: "attached",
    attachedAt: NOW,
    detachedAt: null,
    replacedByBindingId: null,
  };
  readonly beginCalls: BeginRoomDeliveryAttemptInput[] = [];

  async getDelivery(outboxId: string): Promise<RoomOutboxRecordV1 | null> {
    return outboxId === this.current.id ? this.current : null;
  }

  async getBinding(bindingId: string): Promise<RoomBindingRecordV1 | null> {
    return bindingId === this.binding.id ? this.binding : null;
  }

  async beginDeliveryAttempt(input: BeginRoomDeliveryAttemptInput): Promise<RoomOutboxRecordV1> {
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

  async completeDeliveryAttempt(input: CompleteRoomDeliveryAttemptInput): Promise<RoomOutboxRecordV1> {
    this.current = {
      ...this.current,
      state: input.outcome === "confirmed" ? "confirmed" : "delivery_uncertain",
      updatedAt: input.now,
    };
    return this.current;
  }

  async reconcileDelivery(_input: ReconcileRoomDeliveryInput): Promise<RoomOutboxRecordV1> {
    return this.current;
  }
}

function createDelivery(): RoomOutboxRecordV1 {
  const deliveryIdentity = {
    logicalMessageId: "message-1",
    bindingId: "binding-1",
    idempotencyKey: "room-message-1:binding-1",
    payloadHash: hashRoomValue("provider backpressure send boundary"),
  };
  return {
    contractVersion: 1,
    id: "outbox-1",
    roomId: "room-1",
    ...deliveryIdentity,
    localMessageId: buildRoomConnectorLocalMessageId(deliveryIdentity),
    state: "pending",
    attemptCount: 0,
    connectorAcknowledgementId: null,
    nativeMessageId: null,
    nativeCursor: null,
    reconciliationFromCursor: null,
    reconciliationEvidenceRef: null,
    lastErrorCode: null,
    nextAttemptAt: null,
    updatedAt: NOW,
  };
}

function connectorFixture(): { readonly registry: SessionConnectorRegistry; readonly sendCalls: () => number } {
  let sends = 0;
  const verified = {
    state: "verified" as const,
    evidenceRef: "test-certification",
    reasonCode: null,
    lastVerifiedAt: NOW,
  };
  const connector = {
    contractVersion: 1,
    id: "happier",
    version: "test",
    getCapabilities: async () => ({
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
    }),
    ensureExisting: async () => unavailable(),
    create: async () => unavailable(),
    getStatus: async () => unavailable(),
    readHistory: async () => unavailable(),
    subscribeEvents: async () => unavailable(),
    send: async () => {
      sends += 1;
      return {
        ok: true,
        value: {
          outcome: "accepted" as const,
          connectorAcknowledgementId: "ack-1",
          nativeMessageId: "native-1",
          cursor: "cursor-1",
          acceptedAt: NOW,
        },
      };
    },
    interrupt: async () => unavailable(),
    resume: async () => unavailable(),
    takeover: async () => unavailable(),
    getHealth: async () => ({
      connectorId: "happier",
      hostId: "host-1",
      state: "healthy" as const,
      checkedAt: NOW,
      authentication: "authenticated" as const,
      daemon: "running" as const,
      server: "reachable" as const,
      backend: "ready" as const,
      rateLimit: "clear" as const,
      host: "reachable" as const,
      capabilities: Object.fromEntries(
        SESSION_CONNECTOR_CAPABILITIES.map((capability) => [capability, "verified"]),
      ),
      reasonCodes: [],
      retryAfterMs: null,
    }),
    getDeepLinks: async () => unavailable(),
  } as unknown as SessionConnectorV1;
  const registry = new SessionConnectorRegistry({ now: () => Date.parse(NOW) });
  registry.register(connector);
  return { registry, sendCalls: () => sends };
}

function unavailable() {
  return { ok: false as const, error: { code: "unavailable" as const, message: "not used", retryable: false } };
}

function authority(overrides: {
  readonly scope?: Partial<RoomProviderBackpressureScopeV1>;
  readonly telemetry?: Partial<RoomProviderBackpressureTelemetryV1>;
} = {}): unknown {
  const scope: RoomProviderBackpressureScopeV1 = {
    providerId: "codex",
    accountId: "account-1",
    modelId: "gpt-5",
    connectorId: "happier",
    nodeId: "node-1",
    ...overrides.scope,
  };
  const telemetry: RoomProviderBackpressureTelemetryV1 = {
    known: true,
    observedAt: NOW,
    admissionConfirmed: true,
    activeRequests: 0,
    ...overrides.telemetry,
  };
  const policy: RoomProviderBackpressurePolicyV1 = {
    concurrencyCap: 4,
    reservedVerifierSlots: 1,
    reservedRecoverySlots: 1,
    telemetryTtlMs: 30_000,
    failureThreshold: 2,
    maxRetryAttempts: 3,
    baseBackoffMs: 1_000,
    maxBackoffMs: 4_000,
    circuitOpenMs: 5_000,
  };
  const scopeKey = JSON.stringify([
    scope.providerId,
    scope.accountId,
    scope.modelId,
    scope.connectorId,
    scope.nodeId,
  ]);
  return {
    scope,
    telemetry,
    policy,
    decision: {
      contractVersion: 1,
      scope,
      scopeKey,
      decision: {
        contractVersion: 1,
        action: "admit",
        reason: "capacity_confirmed",
        retryAfterMs: null,
        exponentialBackoffMs: null,
        retryDelayMs: null,
        effectiveConcurrencyCap: 2,
      },
      state: {
        contractVersion: 1,
        scopeKey,
        circuitState: "closed",
        consecutiveFailures: 0,
        retryAttempt: 0,
        retryNotBefore: null,
        openUntil: null,
        halfOpenProbeInFlight: false,
        lastUpdatedAt: NOW,
      },
    },
  };
}

function gate(admittedAuthority: unknown): {
  readonly admitCalls: () => number;
  readonly completionKinds: () => readonly string[];
  readonly admit: () => Promise<unknown>;
} {
  let calls = 0;
  const completions: string[] = [];
  return {
    admitCalls: () => calls,
    completionKinds: () => completions,
    admit: async () => {
      calls += 1;
      return {
        contractVersion: 1,
        action: "admit",
        permit: {
          contractVersion: 1,
          reservationId: "reservation-1",
          requestId: "room-provider-capacity:claim-1",
          authority: admittedAuthority,
          complete: async (completion: { readonly kind: string }) => {
            completions.push(completion.kind);
          },
        },
      };
    },
  };
}

function dispatchInput(
  store: MemoryDeliveryStore,
  registry: SessionConnectorRegistry,
  providerBackpressure: unknown,
): Parameters<typeof dispatchRoomDelivery>[0] {
  return {
    store,
    registry,
    identity: IDENTITY,
    outboxId: "outbox-1",
    attemptId: "attempt-1",
    senderFence: SENDER_FENCE,
    content: "provider backpressure send boundary",
    reconciliationFromCursor: null,
    now: NOW,
    audit: { runId: "run-1", agentId: "worker-1" },
    providerBackpressure,
  } as unknown as Parameters<typeof dispatchRoomDelivery>[0];
}

describe("Room provider-backpressure send boundary", () => {
  it("starts connector.send only after a valid durable provider admission and completes its permit", async () => {
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture();
    const providerBackpressure = gate(authority());

    await expect(dispatchRoomDelivery(dispatchInput(store, fixture.registry, providerBackpressure)))
      .resolves.toMatchObject({ state: "confirmed" });

    expect(providerBackpressure.admitCalls()).toBe(1);
    expect(store.beginCalls).toHaveLength(1);
    expect(fixture.sendCalls()).toBe(1);
    expect(providerBackpressure.completionKinds()).toEqual(["connector_result"]);
  });

  it("does not start connector.send when a gate presents unknown provider telemetry", async () => {
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture();
    const providerBackpressure = gate(authority({ telemetry: { known: false } }));

    await expect(dispatchRoomDelivery(dispatchInput(store, fixture.registry, providerBackpressure)))
      .resolves.toMatchObject({ state: "pending" });

    expect(providerBackpressure.admitCalls()).toBe(1);
    expect(store.beginCalls).toHaveLength(0);
    expect(fixture.sendCalls()).toBe(0);
  });

  it("does not start connector.send when a gate presents an incomplete exact provider scope", async () => {
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture();
    const providerBackpressure = gate(authority({ scope: { accountId: "" } }));

    await expect(dispatchRoomDelivery(dispatchInput(store, fixture.registry, providerBackpressure)))
      .resolves.toMatchObject({ state: "pending" });

    expect(providerBackpressure.admitCalls()).toBe(1);
    expect(store.beginCalls).toHaveLength(0);
    expect(fixture.sendCalls()).toBe(0);
  });
});

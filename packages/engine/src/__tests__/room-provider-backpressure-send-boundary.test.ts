import { describe, expect, it, vi } from "vitest";

import {
  SESSION_CONNECTOR_CAPABILITIES,
  buildRoomConnectorLocalMessageId,
  hashRoomValue,
  type BeginRoomDeliveryAttemptInput,
  type CompleteRoomDeliveryAttemptInput,
  type DeferPendingRoomDeliveryInput,
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
  admitRoomProviderBackpressureConnectorSend,
  createRoomProviderBackpressureSendRequestBinding,
  hashRoomProviderBackpressureSendRequestBinding,
  RoomProviderBackpressureGateTimeoutFenceError,
  RoomProviderBackpressureGateTimeoutError,
  type RoomProviderBackpressureSendGateRequestV1,
  type RoomProviderBackpressureSendGateResultV1,
  type RoomProviderBackpressureSendGateV1,
} from "../room-provider-backpressure-send-boundary.js";
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
  failNextDeferBeforePersist = false;
  /*
  FNXC:RoomProviderPreClaimFence 2026-07-20-22:15:
  A Core pre-claim fence returns the committed outbox snapshot atomically.
  This one-shot failure proves Engine must not re-read that generation before
  returning it, because a post-commit read outage cannot make it safe to retry.
  */
  failNextGetDelivery = false;
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
  readonly deferCalls: DeferPendingRoomDeliveryInput[] = [];
  readonly completeCalls: CompleteRoomDeliveryAttemptInput[] = [];

  async getDelivery(outboxId: string): Promise<RoomOutboxRecordV1 | null> {
    if (this.failNextGetDelivery) {
      this.failNextGetDelivery = false;
      throw new Error("simulated post-fence outbox reload");
    }
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

  async deferPendingDelivery(input: DeferPendingRoomDeliveryInput): Promise<RoomOutboxRecordV1> {
    if (this.failNextDeferBeforePersist) {
      this.failNextDeferBeforePersist = false;
      throw new Error("simulated deferred persistence response loss");
    }
    this.deferCalls.push(input);
    this.current = {
      ...this.current,
      state: "pending",
      lastErrorCode: input.reasonCode,
      nextAttemptAt: input.nextAttemptAt,
      updatedAt: input.now,
    };
    return this.current;
  }

  async completeDeliveryAttempt(input: CompleteRoomDeliveryAttemptInput): Promise<RoomOutboxRecordV1> {
    this.completeCalls.push(input);
    this.current = {
      ...this.current,
      state: input.outcome === "confirmed"
        ? "confirmed"
        : input.outcome === "retryable_failure"
          ? "pending"
          : input.outcome === "rejected"
            ? "rejected"
            : "delivery_uncertain",
      connectorAcknowledgementId: input.connectorAcknowledgementId,
      nativeMessageId: input.nativeMessageId,
      nativeCursor: input.nativeCursor,
      lastErrorCode: input.errorCode,
      nextAttemptAt: input.nextAttemptAt,
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

function connectorFixture(options: { readonly onSend?: () => void } = {}): {
  readonly registry: SessionConnectorRegistry;
  readonly sendCalls: () => number;
} {
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
      options.onSend?.();
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

function permitFor(
  request: Record<string, unknown>,
  admittedAuthority: unknown,
  overrides: Record<string, unknown> = {},
): unknown {
  return {
    contractVersion: 1,
    reservationId: "reservation-1",
    requestId: "room-provider-capacity:claim-1",
    requestHash: request.requestHash,
    requestBinding: request.requestBinding,
    expiresAt: "2026-07-19T10:01:00.000Z",
    authority: admittedAuthority,
    ...overrides,
  };
}

function gate(
  admittedAuthority: unknown,
  options: {
    readonly onAdmit?: (request: Record<string, unknown>) => void;
    readonly permitOverrides?: Record<string, unknown>;
    readonly omitRenew?: boolean;
    readonly onComplete?: (completion: { readonly kind: string }) => Promise<void>;
  } = {},
): {
  readonly admitCalls: () => number;
  readonly completionKinds: () => readonly string[];
  readonly admit: () => Promise<unknown>;
} {
  let calls = 0;
  const completions: string[] = [];
  return {
    admitCalls: () => calls,
    completionKinds: () => completions,
    admit: async (request: Record<string, unknown>) => {
      calls += 1;
      options.onAdmit?.(request);
      return {
        contractVersion: 1,
        action: "admit",
        permit: {
          ...permitFor(request, admittedAuthority, options.permitOverrides),
          ...(options.omitRenew ? {} : {
            renew: options.permitOverrides?.renew ?? (async () => ({
              action: "renewed" as const,
              expiresAt: "2026-07-19T10:01:00.000Z",
              replayed: false,
            })),
          }),
          complete: async (completion: { readonly kind: string }) => {
            completions.push(completion.kind);
            await options.onComplete?.(completion);
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
  overrides: Readonly<Record<string, unknown>> = {},
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
    ...overrides,
  } as unknown as Parameters<typeof dispatchRoomDelivery>[0];
}

function directProviderGateRequest(
  abortController: AbortController,
): RoomProviderBackpressureSendGateRequestV1 {
  const delivery = createDelivery();
  const binding = new MemoryDeliveryStore().binding;
  const deadline = "2026-07-19T10:00:00.001Z";
  const requestBinding = createRoomProviderBackpressureSendRequestBinding({
    delivery,
    binding,
    identity: IDENTITY,
    attemptId: "attempt-1",
    senderFence: SENDER_FENCE,
    deadline,
  });
  return Object.freeze({
    contractVersion: 1,
    delivery,
    binding,
    identity: IDENTITY,
    attemptId: "attempt-1",
    senderFence: SENDER_FENCE,
    asOf: NOW,
    deadline,
    signal: abortController.signal,
    requestBinding,
    requestHash: hashRoomProviderBackpressureSendRequestBinding(requestBinding),
  });
}

function pendingProviderGate(): {
  readonly gate: RoomProviderBackpressureSendGateV1;
  readonly receivedRequest: () => RoomProviderBackpressureSendGateRequestV1 | null;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
} {
  let receivedRequest: RoomProviderBackpressureSendGateRequestV1 | null = null;
  let resolveOperation: (result: RoomProviderBackpressureSendGateResultV1) => void = () => undefined;
  let rejectOperation: (error: unknown) => void = () => undefined;
  const operation = new Promise<RoomProviderBackpressureSendGateResultV1>((resolve, reject) => {
    resolveOperation = resolve;
    rejectOperation = reject;
  });
  return {
    gate: {
      admit: (request) => {
        receivedRequest = request;
        return operation;
      },
    },
    receivedRequest: () => receivedRequest,
    resolve: (result) => resolveOperation(result as RoomProviderBackpressureSendGateResultV1),
    reject: rejectOperation,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function timeoutTombstoneActions(
  store: MemoryDeliveryStore,
  callOrder: string[] = [],
  options: {
    readonly beforeBind?: (input: Record<string, unknown>) => Promise<void> | void;
  } = {},
) {
  return {
    fencePendingAdmissionTimeout: vi.fn(async (input: Record<string, unknown>) => {
      callOrder.push("timeout_fence");
      store.current = {
        ...store.current,
        state: "delivery_uncertain",
        lastErrorCode: "provider_gate_timeout",
        nextAttemptAt: null,
      };
      return {
        status: "created" as const,
        tombstone: {
          gateAttemptId: input.gateAttemptId,
          requestHash: input.requestHash,
          outboxId: input.outboxId,
          outboxBindingId: input.outboxBindingId,
          outboxAttemptCount: input.outboxAttemptCount,
          state: "pending",
          cleanupActionId: null,
          reservationId: null,
          terminalGateOutcomeId: null,
          resolvedAt: null,
        },
        outbox: store.current,
      };
    }),
    bindAdmissionTimeoutReservation: vi.fn(async (input: Record<string, unknown>) => {
      callOrder.push("reservation_bound");
      await options.beforeBind?.(input);
      const cleanupAction = input.cleanupAction as Record<string, unknown>;
      return {
        status: "bound" as const,
        tombstone: {
          gateAttemptId: input.gateAttemptId,
          requestHash: input.requestHash,
          outboxId: cleanupAction.outboxId,
          outboxBindingId: cleanupAction.outboxBindingId,
          outboxAttemptCount: cleanupAction.outboxAttemptCount,
          state: "reservation_bound",
          cleanupActionId: cleanupAction.actionId,
          reservationId: cleanupAction.reservationId,
          terminalGateOutcomeId: null,
          resolvedAt: NOW,
        },
        outbox: store.current,
      };
    }),
    recordAdmissionTimeoutTerminalOutcome: vi.fn(async (input: Record<string, unknown>) => {
      callOrder.push("terminal_no_permit");
      const terminalGateOutcome = input.terminalGateOutcome as Record<string, unknown>;
      return {
        status: "recorded" as const,
        tombstone: {
          gateAttemptId: input.gateAttemptId,
          requestHash: input.requestHash,
          outboxId: input.outboxId,
          outboxBindingId: input.outboxBindingId,
          outboxAttemptCount: input.outboxAttemptCount,
          state: "terminal_outcome_recorded",
          cleanupActionId: null,
          reservationId: null,
          terminalGateOutcomeId: terminalGateOutcome.outcomeId,
          terminalGateOutcome: terminalGateOutcome.outcome,
          terminalAt: terminalGateOutcome.occurredAt,
          resolvedAt: null,
          nextAttemptAt: null,
        },
        outbox: store.current,
      };
    }),
    fencePendingOutbox: vi.fn(async () => {
      throw new Error("unexpected legacy late-admission fence");
    }),
  };
}

describe("Room provider-backpressure send boundary", () => {
  it("uses a fresh provider admission identity for each deferred retry before an outbox attempt exists", async () => {
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture();
    const admissionAttemptIds: string[] = [];
    const providerBackpressure = {
      admit: async (request: { readonly attemptId: string }) => {
        admissionAttemptIds.push(request.attemptId);
        return {
          contractVersion: 1,
          action: "defer" as const,
          reason: "provider_capacity_deferred",
          retryAfterMs: 1_000,
        };
      },
    };
    const input = dispatchInput(store, fixture.registry, providerBackpressure);

    await expect(dispatchRoomDelivery(input)).resolves.toMatchObject({ state: "pending" });
    await expect(dispatchRoomDelivery(input)).resolves.toMatchObject({ state: "pending" });

    expect(admissionAttemptIds).toHaveLength(2);
    expect(new Set(admissionAttemptIds).size).toBe(2);
    expect(store.beginCalls).toHaveLength(0);
    expect(fixture.sendCalls()).toBe(0);
  });

  it("replays the same durable provider admission identity after a deferred persistence response loss", async () => {
    const store = new MemoryDeliveryStore();
    store.failNextDeferBeforePersist = true;
    const fixture = connectorFixture();
    const admissionAttemptIds: string[] = [];
    const providerBackpressure = {
      admit: async (request: { readonly attemptId: string }) => {
        admissionAttemptIds.push(request.attemptId);
        return {
          contractVersion: 1,
          action: "defer" as const,
          reason: "provider_capacity_deferred",
          retryAfterMs: 1_000,
        };
      },
    };
    const input = dispatchInput(store, fixture.registry, providerBackpressure);

    await expect(dispatchRoomDelivery(input)).rejects.toThrow("simulated deferred persistence response loss");
    await expect(dispatchRoomDelivery(input)).resolves.toMatchObject({ state: "pending" });

    expect(admissionAttemptIds).toHaveLength(2);
    expect(admissionAttemptIds[1]).toBe(admissionAttemptIds[0]);
    expect(store.beginCalls).toHaveLength(0);
    expect(fixture.sendCalls()).toBe(0);
  });

  it("keeps durable admission identity stable across a later-time restart metadata refresh", async () => {
    const store = new MemoryDeliveryStore();
    store.failNextDeferBeforePersist = true;
    const fixture = connectorFixture();
    const admissions: Array<{ readonly attemptId: string; readonly asOf: string; readonly deadline: string }> = [];
    const providerBackpressure = {
      admit: async (request: { readonly attemptId: string; readonly asOf: string; readonly deadline: string }) => {
        admissions.push(request);
        return {
          contractVersion: 1,
          action: "defer" as const,
          reason: "provider_capacity_deferred",
          retryAfterMs: 1_000,
        };
      },
    };

    await expect(dispatchRoomDelivery(dispatchInput(store, fixture.registry, providerBackpressure, {
      currentTime: () => NOW,
    }))).rejects.toThrow("simulated deferred persistence response loss");

    // A later worker can hydrate bookkeeping at a new wall-clock instant without
    // creating a new outbox delivery generation.
    store.current = { ...store.current, updatedAt: "2026-07-19T10:05:00.000Z" };
    await expect(dispatchRoomDelivery(dispatchInput(store, fixture.registry, providerBackpressure, {
      currentTime: () => "2026-07-19T10:05:00.000Z",
    }))).resolves.toMatchObject({ state: "pending" });

    expect(admissions).toHaveLength(2);
    expect(admissions[1]?.asOf).not.toBe(admissions[0]?.asOf);
    expect(admissions[1]?.deadline).not.toBe(admissions[0]?.deadline);
    expect(admissions[1]?.attemptId).toBe(admissions[0]?.attemptId);
    expect(store.beginCalls).toHaveLength(0);
    expect(fixture.sendCalls()).toBe(0);
  });

  it("releases an admitted permit when cancellation wins before the pre-send authority check", async () => {
    const abortController = new AbortController();
    let authorityChecks = 0;
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture();
    const providerBackpressure = gate(authority());

    await expect(dispatchRoomDelivery(dispatchInput(store, fixture.registry, providerBackpressure, {
      signal: abortController.signal,
      assertAuthority: async () => {
        authorityChecks += 1;
        if (authorityChecks === 2) {
          abortController.abort();
        }
      },
      providerBackpressureDeadlineMs: 1,
    }))).rejects.toMatchObject({ name: "AbortError" });

    expect(providerBackpressure.completionKinds()).toEqual(["not_started"]);
    expect(store.beginCalls).toHaveLength(0);
    expect(fixture.sendCalls()).toBe(0);
  });

  it("releases a same-turn admitted permit when cancellation arrives inside the provider gate", async () => {
    const abortController = new AbortController();
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture();
    const providerBackpressure = gate(authority(), {
      onAdmit: () => {
        abortController.abort();
      },
    });

    await expect(dispatchRoomDelivery(dispatchInput(store, fixture.registry, providerBackpressure, {
      signal: abortController.signal,
      providerBackpressureDeadlineMs: 10,
    }))).rejects.toMatchObject({ name: "AbortError" });

    expect(providerBackpressure.completionKinds()).toEqual(["not_started"]);
    expect(store.beginCalls).toHaveLength(0);
    expect(fixture.sendCalls()).toBe(0);
  });

  it.each(["created", "replayed"] as const)("uses the atomic %s pre-claim fence snapshot without a post-commit outbox read", async (fenceStatus) => {
    vi.useFakeTimers();
    let authorityChecks = 0;
    let markCleanupStarted: (() => void) | null = null;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture();
    const cleanupActions = {
      fencePendingOutbox: vi.fn(async (input: Record<string, unknown>) => {
        expect(input).toMatchObject({
          action: {
            projectId: "project-1",
            roomId: "room-1",
            outboxId: "outbox-1",
            outboxBindingId: "binding-1",
            outboxAttemptId: null,
            outboxAttemptCount: 0,
            completionKind: "pre_claim_not_started",
          },
          errorCode: "provider_reservation_cleanup_timed_out",
        });
        store.current = {
          ...store.current,
          state: "delivery_uncertain",
          lastErrorCode: "provider_reservation_cleanup_timed_out",
          nextAttemptAt: null,
        };
        store.failNextGetDelivery = true;
        return { status: fenceStatus, action: {}, outbox: store.current };
      }),
    };
    const providerBackpressure = gate(authority(), {
      permitOverrides: {
        cleanupDescriptor: {
          claimId: "outbox-1:attempt-1",
          originalWorkerFence: {
            leaseId: "room-worker-lease-1",
            holderId: "room-worker-1",
            hostId: "host-1",
            epoch: 3,
          },
          expectedAggregateVersion: 17,
          reservationExpiresAt: "2026-07-19T10:01:00.000Z",
        },
      },
      onComplete: async (completion) => {
        if (completion.kind === "not_started") {
          markCleanupStarted?.();
          await new Promise<never>(() => undefined);
        }
      },
    });
    const input = dispatchInput(store, fixture.registry, providerBackpressure, {
      assertAuthority: async () => {
        authorityChecks += 1;
        if (authorityChecks === 2) throw new Error("authority lost before claim");
      },
      providerBackpressureDeadlineMs: 1,
      providerBackpressureCleanupActions: cleanupActions as never,
      providerBackpressureCleanupContext: { projectId: "project-1" },
    });
    const delivery = dispatchRoomDelivery(input);

    try {
      await cleanupStarted;
      await vi.advanceTimersByTimeAsync(1);
      await expect(delivery).resolves.toMatchObject({
        state: "delivery_uncertain",
        lastErrorCode: "provider_reservation_cleanup_timed_out",
        nextAttemptAt: null,
      });
      expect(cleanupActions.fencePendingOutbox).toHaveBeenCalledTimes(1);
      expect(store.beginCalls).toHaveLength(0);
      expect(fixture.sendCalls()).toBe(0);
      store.failNextGetDelivery = false;
      await expect(dispatchRoomDelivery(input)).rejects.toMatchObject({ code: "delivery_state_conflict" });
      expect(providerBackpressure.admitCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when a pre-claim fence result is not an atomic create or replay", async () => {
    vi.useFakeTimers();
    let authorityChecks = 0;
    let markCleanupStarted: (() => void) | null = null;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture();
    const cleanupActions = {
      fencePendingOutbox: vi.fn(async () => {
        /*
        FNXC:RoomProviderPreClaimFence 2026-07-20-22:26:
        A shape-compatible outbox is not proof when Core did not attest the
        transaction as an immutable create or replay. Engine must withhold the
        send boundary rather than treating arbitrary adapter output as durable.
        */
        return {
          status: "withheld",
          action: {},
          outbox: {
            ...store.current,
            state: "delivery_uncertain",
            lastErrorCode: "provider_reservation_cleanup_timed_out",
            nextAttemptAt: null,
          },
        };
      }),
    };
    const providerBackpressure = gate(authority(), {
      permitOverrides: {
        cleanupDescriptor: {
          claimId: "outbox-1:attempt-1",
          originalWorkerFence: {
            leaseId: "room-worker-lease-1",
            holderId: "room-worker-1",
            hostId: "host-1",
            epoch: 3,
          },
          expectedAggregateVersion: 17,
          reservationExpiresAt: "2026-07-19T10:01:00.000Z",
        },
      },
      onComplete: async (completion) => {
        if (completion.kind === "not_started") {
          markCleanupStarted?.();
          await new Promise<never>(() => undefined);
        }
      },
    });
    const delivery = dispatchRoomDelivery(dispatchInput(store, fixture.registry, providerBackpressure, {
      assertAuthority: async () => {
        authorityChecks += 1;
        if (authorityChecks === 2) throw new Error("authority lost before claim");
      },
      providerBackpressureDeadlineMs: 1,
      providerBackpressureCleanupActions: cleanupActions as never,
      providerBackpressureCleanupContext: { projectId: "project-1" },
    }));
    const rejected = expect(delivery).rejects.toMatchObject({ code: "delivery_state_conflict" });

    try {
      await cleanupStarted;
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(cleanupActions.fencePendingOutbox).toHaveBeenCalledTimes(1);
      expect(store.beginCalls).toHaveLength(0);
      expect(fixture.sendCalls()).toBe(0);
      expect(providerBackpressure.admitCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases an admitted permit when authority is lost after the durable claim", async () => {
    let authorityChecks = 0;
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture();
    const providerBackpressure = gate(authority());

    await expect(dispatchRoomDelivery(dispatchInput(store, fixture.registry, providerBackpressure, {
      assertAuthority: async () => {
        authorityChecks += 1;
        if (authorityChecks === 4) throw new Error("authority lost after claim");
      },
    }))).rejects.toThrow("authority lost after claim");

    expect(providerBackpressure.completionKinds()).toEqual(["not_started"]);
    expect(store.beginCalls).toHaveLength(1);
    expect(fixture.sendCalls()).toBe(0);
  });

  it("replays an admitted reservation identity after its pre-send defer persistence response loss", async () => {
    const store = new MemoryDeliveryStore();
    store.failNextDeferBeforePersist = true;
    const fixture = connectorFixture();
    const admissionAttemptIds: string[] = [];
    let staleAfterAdmission = false;
    const providerBackpressure = gate(authority(), {
      onAdmit: (request) => {
        admissionAttemptIds.push(request.attemptId as string);
        staleAfterAdmission = true;
      },
    });
    const run = () => {
      staleAfterAdmission = false;
      return dispatchRoomDelivery(dispatchInput(store, fixture.registry, providerBackpressure, {
        currentTime: () => staleAfterAdmission ? "2026-07-19T10:00:31.000Z" : NOW,
        providerBackpressureDeadlineMs: 60_000,
      }));
    };

    await expect(run()).rejects.toThrow("simulated deferred persistence response loss");
    await expect(run()).resolves.toMatchObject({
      state: "pending",
      lastErrorCode: "provider_telemetry_stale",
    });

    expect(admissionAttemptIds).toHaveLength(2);
    expect(admissionAttemptIds[1]).toBe(admissionAttemptIds[0]);
    expect(providerBackpressure.completionKinds()).toEqual(["not_started", "not_started"]);
    expect(store.beginCalls).toHaveLength(0);
    expect(fixture.sendCalls()).toBe(0);
  });

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

  it("waits for the timeout fence before returning a retryable timeout or forwarding a late permit", async () => {
    const abortController = new AbortController();
    const request = directProviderGateRequest(abortController);
    const providerGate = pendingProviderGate();
    let resolveTimeoutFence: (() => void) | null = null;
    const timeoutFence = new Promise<void>((resolve) => {
      resolveTimeoutFence = resolve;
    });
    const callOrder: string[] = [];
    let preflightSettled = false;
    let gateResolved = false;
    const preflight = admitRoomProviderBackpressureConnectorSend({
      gate: providerGate.gate,
      request,
      onTimeout: async () => {
        callOrder.push("timeout_fence_started");
        await timeoutFence;
        callOrder.push("timeout_fence_completed");
      },
      onLateAdmittedPermit: async () => {
        callOrder.push("late_permit");
      },
    });
    void preflight.then(() => {
      preflightSettled = true;
    });

    try {
      await flushMicrotasks();
      expect(providerGate.receivedRequest()).toBe(request);
      abortController.abort(new RoomProviderBackpressureGateTimeoutError(request.deadline));
      await flushMicrotasks();
      expect(callOrder).toEqual(["timeout_fence_started"]);
      expect(preflightSettled).toBe(false);

      providerGate.resolve({
        contractVersion: 1,
        action: "admit",
        permit: {
          ...permitFor(request as unknown as Record<string, unknown>, authority()),
          complete: async () => undefined,
        },
      });
      gateResolved = true;
      await flushMicrotasks();
      expect(callOrder).toEqual(["timeout_fence_started"]);

      resolveTimeoutFence?.();
      await expect(preflight).resolves.toEqual({
        action: "defer",
        reason: "provider_gate_timeout",
        retryAfterMs: null,
      });
      await flushMicrotasks();
      expect(callOrder).toEqual([
        "timeout_fence_started",
        "timeout_fence_completed",
        "late_permit",
      ]);
    } finally {
      resolveTimeoutFence?.();
      if (!gateResolved) {
        providerGate.resolve({
          contractVersion: 1,
          action: "defer",
          reason: "test_cleanup",
        });
      }
      await preflight;
      await flushMicrotasks();
    }
  });

  it("fails closed instead of returning a retryable defer when the timeout fence throws synchronously", async () => {
    const abortController = new AbortController();
    const request = directProviderGateRequest(abortController);
    const providerGate = pendingProviderGate();
    const timeoutFenceFailure = new Error("synchronous timeout fence failure");
    let latePermitCalls = 0;
    let permitCompletionCalls = 0;
    const preflight = admitRoomProviderBackpressureConnectorSend({
      gate: providerGate.gate,
      request,
      onTimeout: () => {
        throw timeoutFenceFailure;
      },
      onLateAdmittedPermit: async () => {
        latePermitCalls += 1;
      },
    });

    try {
      await flushMicrotasks();
      abortController.abort(new RoomProviderBackpressureGateTimeoutError(request.deadline));
      await expect(preflight).rejects.toBeInstanceOf(RoomProviderBackpressureGateTimeoutFenceError);
      await expect(preflight).rejects.toMatchObject({
        name: "RoomProviderBackpressureGateTimeoutFenceError",
        code: "provider_gate_timeout_fence_failed",
      });
      providerGate.resolve({
        contractVersion: 1,
        action: "admit",
        permit: {
          ...permitFor(request as unknown as Record<string, unknown>, authority()),
          complete: async () => {
            permitCompletionCalls += 1;
          },
        },
      });
      await flushMicrotasks();
      expect(latePermitCalls).toBe(0);
      expect(permitCompletionCalls).toBe(0);
    } finally {
      await preflight.catch(() => undefined);
      await flushMicrotasks();
    }
  });

  it("fails closed instead of returning a retryable defer when the timeout fence rejects asynchronously", async () => {
    const abortController = new AbortController();
    const request = directProviderGateRequest(abortController);
    const providerGate = pendingProviderGate();
    const timeoutFenceFailure = new Error("asynchronous timeout fence failure");
    let latePermitCalls = 0;
    const preflight = admitRoomProviderBackpressureConnectorSend({
      gate: providerGate.gate,
      request,
      onTimeout: () => Promise.reject(timeoutFenceFailure),
      onLateAdmittedPermit: async () => {
        latePermitCalls += 1;
      },
    });

    try {
      await flushMicrotasks();
      abortController.abort(new RoomProviderBackpressureGateTimeoutError(request.deadline));
      await expect(preflight).rejects.toBeInstanceOf(RoomProviderBackpressureGateTimeoutFenceError);
      await expect(preflight).rejects.toMatchObject({
        name: "RoomProviderBackpressureGateTimeoutFenceError",
        code: "provider_gate_timeout_fence_failed",
      });
      providerGate.resolve({
        contractVersion: 1,
        action: "admit",
        permit: {
          ...permitFor(request as unknown as Record<string, unknown>, authority()),
          complete: async () => undefined,
        },
      });
      await flushMicrotasks();
      expect(latePermitCalls).toBe(0);
    } finally {
      await preflight.catch(() => undefined);
      await flushMicrotasks();
    }
  });

  it.each([
    ["late admitted-permit handler", { onLateAdmittedPermit: async () => undefined }],
    ["late admitted-permit recovery handler", { onLateAdmittedPermitFailure: async () => undefined }],
    ["late no-permit handler", { onLateNoPermit: async () => undefined }],
    ["late-settlement failure reporter", { onLateSettlementFailure: async () => undefined }],
  ] as const)("rejects an unfenced timeout when a %s is configured", async (_label, callbacks) => {
    const abortController = new AbortController();
    const request = directProviderGateRequest(abortController);
    const providerGate = pendingProviderGate();
    const preflight = admitRoomProviderBackpressureConnectorSend({
      gate: providerGate.gate,
      request,
      ...callbacks,
    });
    const outcome = preflight.then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );

    await flushMicrotasks();
    abortController.abort(new RoomProviderBackpressureGateTimeoutError(request.deadline));
    const settled = await outcome;

    if (settled.kind !== "rejected") {
      throw new Error("expected an unfenced timeout to reject");
    }
    expect(settled.error).toBeInstanceOf(RoomProviderBackpressureGateTimeoutFenceError);
    expect(settled.error).toMatchObject({ code: "provider_gate_timeout_fence_failed" });
    expect(providerGate.receivedRequest()).toBeNull();
  });

  it("fails closed for a directly aborted unsafe timeout while preserving a callback-free legacy timeout", async () => {
    const legacyAbort = new AbortController();
    const legacyRequest = directProviderGateRequest(legacyAbort);
    legacyAbort.abort(new RoomProviderBackpressureGateTimeoutError(legacyRequest.deadline));
    const legacyGate = pendingProviderGate();

    await expect(admitRoomProviderBackpressureConnectorSend({
      gate: legacyGate.gate,
      request: legacyRequest,
    })).resolves.toEqual({
      action: "defer",
      reason: "provider_gate_timeout",
      retryAfterMs: null,
    });
    expect(legacyGate.receivedRequest()).toBeNull();

    const unsafeAbort = new AbortController();
    const unsafeRequest = directProviderGateRequest(unsafeAbort);
    unsafeAbort.abort(new RoomProviderBackpressureGateTimeoutError(unsafeRequest.deadline));
    const unsafeGate = pendingProviderGate();

    await expect(admitRoomProviderBackpressureConnectorSend({
      gate: unsafeGate.gate,
      request: unsafeRequest,
      onLateNoPermit: async () => undefined,
    })).rejects.toBeInstanceOf(RoomProviderBackpressureGateTimeoutFenceError);
    expect(unsafeGate.receivedRequest()).toBeNull();
  });

  it("reports a late no-permit callback failure without resolving the timeout fence", async () => {
    const abortController = new AbortController();
    const request = directProviderGateRequest(abortController);
    const providerGate = pendingProviderGate();
    const timeoutFence = { active: false, resolved: false };
    const lateFailures: Array<Record<string, unknown>> = [];
    let timeoutReturned = false;
    let callbackObservedReturnedTimeout = false;
    const preflight = admitRoomProviderBackpressureConnectorSend({
      gate: providerGate.gate,
      request,
      onTimeout: async () => {
        timeoutFence.active = true;
      },
      onLateNoPermit: async () => {
        callbackObservedReturnedTimeout = timeoutReturned;
        throw new Error("late no-permit callback failure");
      },
      onLateSettlementFailure: async (failure) => {
        lateFailures.push(failure as unknown as Record<string, unknown>);
      },
    });

    await flushMicrotasks();
    abortController.abort(new RoomProviderBackpressureGateTimeoutError(request.deadline));
    await expect(preflight).resolves.toMatchObject({ action: "defer", reason: "provider_gate_timeout" });
    timeoutReturned = true;
    providerGate.resolve({
      contractVersion: 1,
      action: "defer",
      reason: "provider_capacity_deferred",
      retryAfterMs: 250,
    });
    await flushMicrotasks();

    expect(callbackObservedReturnedTimeout).toBe(true);
    expect(timeoutFence).toEqual({ active: true, resolved: false });
    expect(lateFailures).toEqual([
      expect.objectContaining({
        callback: "onLateNoPermit",
        request,
        outcome: expect.objectContaining({ action: "defer", reason: "provider_capacity_deferred" }),
      }),
    ]);
  });

  it("reports a late admitted-permit callback failure without releasing the permit or timeout fence", async () => {
    const abortController = new AbortController();
    const request = directProviderGateRequest(abortController);
    const providerGate = pendingProviderGate();
    const timeoutFence = { active: false, resolved: false };
    const lateFailures: Array<Record<string, unknown>> = [];
    const completionKinds: string[] = [];
    let timeoutReturned = false;
    let callbackObservedReturnedTimeout = false;
    const preflight = admitRoomProviderBackpressureConnectorSend({
      gate: providerGate.gate,
      request,
      onTimeout: async () => {
        timeoutFence.active = true;
      },
      onLateAdmittedPermit: async () => {
        callbackObservedReturnedTimeout = timeoutReturned;
        throw new Error("late admitted-permit callback failure");
      },
      onLateSettlementFailure: async (failure) => {
        lateFailures.push(failure as unknown as Record<string, unknown>);
      },
    });

    await flushMicrotasks();
    abortController.abort(new RoomProviderBackpressureGateTimeoutError(request.deadline));
    await expect(preflight).resolves.toMatchObject({ action: "defer", reason: "provider_gate_timeout" });
    timeoutReturned = true;
    providerGate.resolve({
      contractVersion: 1,
      action: "admit",
      permit: {
        ...permitFor(request as unknown as Record<string, unknown>, authority()),
        complete: async (completion) => {
          completionKinds.push(completion.kind);
        },
      },
    });
    await flushMicrotasks();

    expect(callbackObservedReturnedTimeout).toBe(true);
    expect(timeoutFence).toEqual({ active: true, resolved: false });
    expect(completionKinds).toEqual([]);
    expect(lateFailures).toEqual([
      expect.objectContaining({
        callback: "onLateAdmittedPermit",
        request,
        permit: expect.objectContaining({ reservationId: "reservation-1" }),
      }),
    ]);
  });

  it("reports a failed late-admit recovery callback while retaining the timeout fence", async () => {
    const abortController = new AbortController();
    const request = directProviderGateRequest(abortController);
    const providerGate = pendingProviderGate();
    const lateFailures: Array<Record<string, unknown>> = [];
    const preflight = admitRoomProviderBackpressureConnectorSend({
      gate: providerGate.gate,
      request,
      onTimeout: async () => undefined,
      onLateAdmittedPermit: async () => {
        throw new Error("late admitted-permit callback failure");
      },
      onLateAdmittedPermitFailure: async () => {
        throw new Error("late admitted-permit recovery callback failure");
      },
      onLateSettlementFailure: async (failure) => {
        lateFailures.push(failure as unknown as Record<string, unknown>);
      },
    });

    await flushMicrotasks();
    abortController.abort(new RoomProviderBackpressureGateTimeoutError(request.deadline));
    await expect(preflight).resolves.toMatchObject({ action: "defer", reason: "provider_gate_timeout" });
    providerGate.resolve({
      contractVersion: 1,
      action: "admit",
      permit: {
        ...permitFor(request as unknown as Record<string, unknown>, authority()),
        complete: async () => undefined,
      },
    });
    await flushMicrotasks();

    expect(lateFailures).toEqual([
      expect.objectContaining({
        callback: "onLateAdmittedPermitFailure",
        request,
        permit: expect.objectContaining({ reservationId: "reservation-1" }),
      }),
    ]);
  });

  it("retains the timeout fence when the late-settlement failure reporter rejects", async () => {
    const abortController = new AbortController();
    const request = directProviderGateRequest(abortController);
    const providerGate = pendingProviderGate();
    const timeoutFence = { active: false, resolved: false };
    let failureReporterCalls = 0;
    const preflight = admitRoomProviderBackpressureConnectorSend({
      gate: providerGate.gate,
      request,
      onTimeout: async () => {
        timeoutFence.active = true;
      },
      onLateNoPermit: async () => {
        throw new Error("late no-permit callback failure");
      },
      onLateSettlementFailure: async () => {
        failureReporterCalls += 1;
        throw new Error("late settlement failure reporter rejection");
      },
    });

    await flushMicrotasks();
    abortController.abort(new RoomProviderBackpressureGateTimeoutError(request.deadline));
    await expect(preflight).resolves.toMatchObject({ action: "defer", reason: "provider_gate_timeout" });
    providerGate.resolve({
      contractVersion: 1,
      action: "defer",
      reason: "provider_capacity_deferred",
    });
    await flushMicrotasks();

    expect(failureReporterCalls).toBe(1);
    expect(timeoutFence).toEqual({ active: true, resolved: false });
  });

  it("reports a valid late terminal defer without confusing it with a late admit", async () => {
    const noPermitOutcomes: Array<Record<string, unknown>> = [];
    const latePermits: RoomProviderBackpressureSendGateRequestV1[] = [];
    const deferAbort = new AbortController();
    const deferRequest = directProviderGateRequest(deferAbort);
    const deferGate = pendingProviderGate();
    const deferredPreflight = admitRoomProviderBackpressureConnectorSend({
      gate: deferGate.gate,
      request: deferRequest,
      onTimeout: async () => undefined,
      onLateNoPermit: async (input) => {
        noPermitOutcomes.push(input.outcome as unknown as Record<string, unknown>);
      },
      onLateAdmittedPermit: async ({ request: lateRequest }) => {
        latePermits.push(lateRequest);
      },
    });

    await flushMicrotasks();
    deferAbort.abort(new RoomProviderBackpressureGateTimeoutError(deferRequest.deadline));
    await expect(deferredPreflight).resolves.toMatchObject({
      action: "defer",
      reason: "provider_gate_timeout",
    });
    deferGate.resolve({
      contractVersion: 1,
      action: "defer",
      reason: "provider_capacity_deferred",
      retryAfterMs: 250,
    });
    await flushMicrotasks();
    expect(noPermitOutcomes).toEqual([{
      contractVersion: 1,
      action: "defer",
      reason: "provider_capacity_deferred",
      retryAfterMs: 250,
    }]);
    expect(latePermits).toEqual([]);

    const admitAbort = new AbortController();
    const admitRequest = directProviderGateRequest(admitAbort);
    const admitGate = pendingProviderGate();
    const admittedPreflight = admitRoomProviderBackpressureConnectorSend({
      gate: admitGate.gate,
      request: admitRequest,
      onTimeout: async () => undefined,
      onLateNoPermit: async (input) => {
        noPermitOutcomes.push(input.outcome as unknown as Record<string, unknown>);
      },
      onLateAdmittedPermit: async ({ request: lateRequest }) => {
        latePermits.push(lateRequest);
      },
    });

    await flushMicrotasks();
    admitAbort.abort(new RoomProviderBackpressureGateTimeoutError(admitRequest.deadline));
    await expect(admittedPreflight).resolves.toMatchObject({
      action: "defer",
      reason: "provider_gate_timeout",
    });
    admitGate.resolve({
      contractVersion: 1,
      action: "admit",
      permit: {
        ...permitFor(admitRequest as unknown as Record<string, unknown>, authority()),
        complete: async () => undefined,
      },
    });
    await flushMicrotasks();
    expect(noPermitOutcomes).toHaveLength(1);
    expect(latePermits).toEqual([admitRequest]);
  });

  it("keeps the timeout tombstone when a late gate result is rejected or malformed", async () => {
    const lateNoPermitCalls: unknown[] = [];
    const malformedAbort = new AbortController();
    const malformedRequest = directProviderGateRequest(malformedAbort);
    const malformedGate = pendingProviderGate();
    const malformedPreflight = admitRoomProviderBackpressureConnectorSend({
      gate: malformedGate.gate,
      request: malformedRequest,
      onTimeout: async () => undefined,
      onLateNoPermit: async (input) => {
        lateNoPermitCalls.push(input);
      },
    });

    await flushMicrotasks();
    malformedAbort.abort(new RoomProviderBackpressureGateTimeoutError(malformedRequest.deadline));
    await expect(malformedPreflight).resolves.toMatchObject({ action: "defer", reason: "provider_gate_timeout" });
    malformedGate.resolve({
      contractVersion: 1,
      action: "defer",
      reason: "",
    });
    await flushMicrotasks();

    const rejectedAbort = new AbortController();
    const rejectedRequest = directProviderGateRequest(rejectedAbort);
    const rejectedGate = pendingProviderGate();
    const rejectedPreflight = admitRoomProviderBackpressureConnectorSend({
      gate: rejectedGate.gate,
      request: rejectedRequest,
      onTimeout: async () => undefined,
      onLateNoPermit: async (input) => {
        lateNoPermitCalls.push(input);
      },
    });

    await flushMicrotasks();
    rejectedAbort.abort(new RoomProviderBackpressureGateTimeoutError(rejectedRequest.deadline));
    await expect(rejectedPreflight).resolves.toMatchObject({ action: "defer", reason: "provider_gate_timeout" });
    rejectedGate.reject(new Error("late provider gate rejection"));
    await flushMicrotasks();
    expect(lateNoPermitCalls).toEqual([]);
  });

  it("preserves late-admit cleanup when timeout callbacks are absent", async () => {
    const abortController = new AbortController();
    const request = directProviderGateRequest(abortController);
    const providerGate = pendingProviderGate();
    const completionKinds: string[] = [];
    const preflight = admitRoomProviderBackpressureConnectorSend({
      gate: providerGate.gate,
      request,
    });

    await flushMicrotasks();
    abortController.abort(new RoomProviderBackpressureGateTimeoutError(request.deadline));
    await expect(preflight).resolves.toEqual({
      action: "defer",
      reason: "provider_gate_timeout",
      retryAfterMs: null,
    });
    providerGate.resolve({
      contractVersion: 1,
      action: "admit",
      permit: {
        ...permitFor(request as unknown as Record<string, unknown>, authority()),
        complete: async (completion) => {
          completionKinds.push(completion.kind);
        },
      },
    });
    await flushMicrotasks();
    expect(completionKinds).toEqual(["not_started"]);
  });

  it("fails closed with a typed fence error when a timed-out provider gate has no timeout tombstone API", async () => {
    vi.useFakeTimers();
    let resolveGate: ((value: unknown) => void) | null = null;
    let observedRequest: Record<string, unknown> | null = null;
    const providerBackpressure = {
      admit: async (request: Record<string, unknown>) => {
        observedRequest = request;
        return new Promise<unknown>((resolve) => {
          resolveGate = resolve;
        });
      },
    };
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture();
    const delivery = dispatchRoomDelivery(dispatchInput(store, fixture.registry, providerBackpressure, {
      providerBackpressureDeadlineMs: 1,
    }));
    let settled = false;
    void delivery.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    const rejected = expect(delivery).rejects.toBeInstanceOf(RoomProviderBackpressureGateTimeoutFenceError);

    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      await rejected;
      expect(observedRequest).toMatchObject({
        deadline: "2026-07-19T10:00:00.001Z",
        signal: expect.any(AbortSignal),
      });
      expect((observedRequest?.signal as AbortSignal | undefined)?.aborted).toBe(true);
      expect(store.beginCalls).toHaveLength(0);
      expect(fixture.sendCalls()).toBe(0);
    } finally {
      resolveGate?.({
        contractVersion: 1,
        action: "admit",
        permit: observedRequest ? permitFor(observedRequest, authority()) : {},
      });
      await delivery.catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it("atomically fences a late admitted permit before calling its original completion endpoint", async () => {
    vi.useFakeTimers();
    let resolveGate: ((value: unknown) => void) | null = null;
    let observedRequest: Record<string, unknown> | null = null;
    let resolveLateCompletion: (() => void) | null = null;
    const lateCompletion = new Promise<void>((resolve) => {
      resolveLateCompletion = resolve;
    });
    const callOrder: string[] = [];
    const store = new MemoryDeliveryStore();
    const cleanupActions = timeoutTombstoneActions(store, callOrder);
    let admissions = 0;
    const providerBackpressure = {
      admit: async (request: Record<string, unknown>) => {
        admissions += 1;
        observedRequest = request;
        return new Promise<unknown>((resolve) => {
          resolveGate = resolve;
        });
      },
    };
    const fixture = connectorFixture();
    const input = dispatchInput(store, fixture.registry, providerBackpressure, {
      providerBackpressureDeadlineMs: 1,
      providerBackpressureCleanupActions: cleanupActions,
      providerBackpressureCleanupContext: { projectId: "project-1" },
    });
    const delivery = dispatchRoomDelivery(input);

    try {
      await vi.advanceTimersByTimeAsync(1);
      await expect(delivery).resolves.toMatchObject({
        state: "delivery_uncertain",
        lastErrorCode: "provider_gate_timeout",
      });
      resolveGate?.({
        contractVersion: 1,
        action: "admit",
        permit: {
          ...permitFor(observedRequest ?? {}, authority(), {
            cleanupDescriptor: {
              claimId: "outbox-1:attempt-1",
              originalWorkerFence: {
                leaseId: "room-worker-lease-1",
                holderId: "room-worker-1",
                hostId: "host-1",
                epoch: 3,
              },
              expectedAggregateVersion: 17,
              reservationExpiresAt: "2026-07-19T10:01:00.000Z",
            },
          }),
          complete: async () => {
            callOrder.push("permit_complete");
            resolveLateCompletion?.();
          },
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(cleanupActions.fencePendingAdmissionTimeout).toHaveBeenCalledTimes(1);
      expect(cleanupActions.bindAdmissionTimeoutReservation).toHaveBeenCalledTimes(1);
      expect(cleanupActions.fencePendingOutbox).not.toHaveBeenCalled();
      await lateCompletion;
      expect(callOrder).toEqual(["timeout_fence", "reservation_bound", "permit_complete"]);
      expect(store.current).toMatchObject({
        state: "delivery_uncertain",
        lastErrorCode: "provider_gate_timeout",
        nextAttemptAt: null,
      });
      expect(store.beginCalls).toHaveLength(0);
      expect(fixture.sendCalls()).toBe(0);
      await expect(dispatchRoomDelivery(input)).rejects.toMatchObject({ code: "delivery_state_conflict" });
      expect(admissions).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries the same atomic late-admission fence after its first persistence response is lost", async () => {
    vi.useFakeTimers();
    let resolveGate: ((value: unknown) => void) | null = null;
    let observedRequest: Record<string, unknown> | null = null;
    let resolveLateCompletion: (() => void) | null = null;
    const lateCompletion = new Promise<void>((resolve) => {
      resolveLateCompletion = resolve;
    });
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture();
    let admissions = 0;
    let bindCalls = 0;
    const cleanupActions = timeoutTombstoneActions(store, [], {
      beforeBind: async () => {
        bindCalls += 1;
        if (bindCalls === 1) {
          throw new Error("simulated late fence persistence response loss");
        }
      },
    });
    const providerBackpressure = {
      admit: async (request: Record<string, unknown>) => {
        admissions += 1;
        observedRequest = request;
        return new Promise<unknown>((resolve) => {
          resolveGate = resolve;
        });
      },
    };
    const input = dispatchInput(store, fixture.registry, providerBackpressure, {
      providerBackpressureDeadlineMs: 1,
      providerBackpressureCleanupActions: cleanupActions,
      providerBackpressureCleanupContext: { projectId: "project-1" },
    });
    const delivery = dispatchRoomDelivery(input);

    try {
      await vi.advanceTimersByTimeAsync(1);
      await expect(delivery).resolves.toMatchObject({
        state: "delivery_uncertain",
        lastErrorCode: "provider_gate_timeout",
      });
      if (resolveGate === null || observedRequest === null) {
        throw new Error("late provider gate did not receive its admission request");
      }
      resolveGate({
        contractVersion: 1,
        action: "admit",
        permit: {
          ...permitFor(observedRequest, authority(), {
            cleanupDescriptor: {
              claimId: "outbox-1:attempt-1",
              originalWorkerFence: {
                leaseId: "room-worker-lease-1",
                holderId: "room-worker-1",
                hostId: "host-1",
                epoch: 3,
              },
              expectedAggregateVersion: 17,
              reservationExpiresAt: "2026-07-19T10:01:00.000Z",
            },
          }),
          complete: async () => {
            resolveLateCompletion?.();
          },
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(cleanupActions.fencePendingAdmissionTimeout).toHaveBeenCalledTimes(1);
      expect(cleanupActions.bindAdmissionTimeoutReservation).toHaveBeenCalledTimes(2);
      expect(cleanupActions.fencePendingOutbox).not.toHaveBeenCalled();
      const idempotencyKeys = cleanupActions.bindAdmissionTimeoutReservation.mock.calls.map(([call]) => (
        (call as { readonly cleanupAction?: { readonly idempotencyKey?: unknown } }).cleanupAction?.idempotencyKey
      ));
      expect(new Set(idempotencyKeys).size).toBe(1);
      await lateCompletion;
      expect(store.current).toMatchObject({
        state: "delivery_uncertain",
        lastErrorCode: "provider_gate_timeout",
      });
      expect(store.beginCalls).toHaveLength(0);
      expect(fixture.sendCalls()).toBe(0);
      await expect(dispatchRoomDelivery(input)).rejects.toMatchObject({ code: "delivery_state_conflict" });
      expect(admissions).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fences a late admitted permit before its cleanup can stall", async () => {
    vi.useFakeTimers();
    let resolveGate: ((value: unknown) => void) | null = null;
    let observedRequest: Record<string, unknown> | null = null;
    let markCompleteStarted: (() => void) | null = null;
    const completeStarted = new Promise<void>((resolve) => {
      markCompleteStarted = resolve;
    });
    const callOrder: string[] = [];
    const store = new MemoryDeliveryStore();
    const cleanupActions = timeoutTombstoneActions(store, callOrder);
    let admissions = 0;
    const providerBackpressure = {
      admit: async (request: Record<string, unknown>) => {
        admissions += 1;
        observedRequest = request;
        return new Promise<unknown>((resolve) => {
          resolveGate = resolve;
        });
      },
    };
    const fixture = connectorFixture();
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const input = dispatchInput(store, fixture.registry, providerBackpressure, {
      providerBackpressureDeadlineMs: 1,
      providerBackpressureCleanupActions: cleanupActions,
      providerBackpressureCleanupContext: { projectId: "project-1" },
    });
    const delivery = dispatchRoomDelivery(input);

    try {
      await vi.advanceTimersByTimeAsync(1);
      await expect(delivery).resolves.toMatchObject({
        state: "delivery_uncertain",
        lastErrorCode: "provider_gate_timeout",
      });
      timeoutSpy.mockClear();
      if (resolveGate === null || observedRequest === null) {
        throw new Error("late provider gate did not receive its admission request");
      }
      resolveGate({
        contractVersion: 1,
        action: "admit",
        permit: {
          ...permitFor(observedRequest, authority(), {
            cleanupDescriptor: {
              claimId: "outbox-1:attempt-1",
              originalWorkerFence: {
                leaseId: "room-worker-lease-1",
                holderId: "room-worker-1",
                hostId: "host-1",
                epoch: 3,
              },
              expectedAggregateVersion: 17,
              reservationExpiresAt: "2026-07-19T10:01:00.000Z",
            },
          }),
          complete: async () => {
            callOrder.push("permit_complete");
            markCompleteStarted?.();
            return new Promise<never>(() => undefined);
          },
        },
      });
      await completeStarted;
      expect(callOrder).toEqual(["timeout_fence", "reservation_bound", "permit_complete"]);
      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(vi.getTimerCount()).toBe(0);
      expect(cleanupActions.fencePendingAdmissionTimeout).toHaveBeenCalledTimes(1);
      expect(cleanupActions.bindAdmissionTimeoutReservation).toHaveBeenCalledTimes(1);
      expect(cleanupActions.fencePendingOutbox).not.toHaveBeenCalled();
      expect(store.current).toMatchObject({
        state: "delivery_uncertain",
        lastErrorCode: "provider_gate_timeout",
        nextAttemptAt: null,
      });
      expect(store.beginCalls).toHaveLength(0);
      expect(fixture.sendCalls()).toBe(0);
      await expect(dispatchRoomDelivery(input)).rejects.toMatchObject({ code: "delivery_state_conflict" });
      expect(admissions).toBe(1);
    } finally {
      timeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("returns a claimed delivery to fenced pending when telemetry becomes stale immediately before connector.send", async () => {
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture();
    const originalBegin = store.beginDeliveryAttempt.bind(store);
    let postClaim = false;
    store.beginDeliveryAttempt = async (input) => {
      const claimed = await originalBegin(input);
      postClaim = true;
      return claimed;
    };
    const providerBackpressure = gate(authority());

    await expect(dispatchRoomDelivery(dispatchInput(store, fixture.registry, providerBackpressure, {
      currentTime: () => postClaim ? "2026-07-19T10:00:31.000Z" : NOW,
      providerBackpressureDeadlineMs: 60_000,
    }))).resolves.toMatchObject({
      state: "pending",
      lastErrorCode: "provider_telemetry_stale",
      nextAttemptAt: "2026-07-19T10:00:32.000Z",
    });

    expect(store.beginCalls).toHaveLength(1);
    expect(fixture.sendCalls()).toBe(0);
    expect(store.completeCalls).toEqual([
      expect.objectContaining({
        errorCode: "provider_telemetry_stale",
        nextAttemptAt: "2026-07-19T10:00:32.000Z",
        outcome: "retryable_failure",
        senderFence: SENDER_FENCE,
      }),
    ]);
  });

  it("does not start connector.send when the final provider renewal is deferred", async () => {
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture();
    const providerBackpressure = gate(authority(), {
      permitOverrides: {
        renew: async () => ({
          action: "defer" as const,
          reason: "provider_reservation_renewal_deferred",
          retryAfterMs: 2_500,
        }),
      },
    });

    await expect(dispatchRoomDelivery(dispatchInput(store, fixture.registry, providerBackpressure)))
      .resolves.toMatchObject({
        state: "pending",
        lastErrorCode: "provider_reservation_renewal_deferred",
        nextAttemptAt: "2026-07-19T10:00:02.500Z",
      });

    expect(store.beginCalls).toHaveLength(1);
    expect(fixture.sendCalls()).toBe(0);
    expect(store.completeCalls).toEqual([
      expect.objectContaining({
        errorCode: "provider_reservation_renewal_deferred",
        nextAttemptAt: "2026-07-19T10:00:02.500Z",
        outcome: "retryable_failure",
        senderFence: SENDER_FENCE,
      }),
    ]);
    expect(providerBackpressure.completionKinds()).toEqual(["not_started"]);
  });

  it("fences a claimed delivery to pending when the final provider renewal never settles", async () => {
    vi.useFakeTimers();
    let markRenewStarted: (() => void) | null = null;
    const renewStarted = new Promise<void>((resolve) => {
      markRenewStarted = resolve;
    });
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture();
    const providerBackpressure = gate(authority(), {
      permitOverrides: {
        renew: async () => {
          markRenewStarted?.();
          return new Promise<never>(() => undefined);
        },
      },
    });
    const delivery = dispatchRoomDelivery(dispatchInput(store, fixture.registry, providerBackpressure, {
      providerBackpressureDeadlineMs: 1,
    }));
    let settled = false;
    void delivery.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });

    try {
      await renewStarted;
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      await expect(delivery).resolves.toMatchObject({
        state: "pending",
        lastErrorCode: "provider_reservation_renewal_timed_out",
        nextAttemptAt: "2026-07-19T10:00:01.000Z",
      });
      expect(store.beginCalls).toHaveLength(1);
      expect(fixture.sendCalls()).toBe(0);
      expect(store.completeCalls).toEqual([
        expect.objectContaining({
          errorCode: "provider_reservation_renewal_timed_out",
          outcome: "retryable_failure",
        }),
      ]);
      expect(providerBackpressure.completionKinds()).toEqual(["not_started"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a claimed delivery uncertain when pre-send permit cleanup never settles", async () => {
    vi.useFakeTimers();
    let markCleanupStarted: (() => void) | null = null;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture();
    const providerBackpressure = gate(authority(), {
      permitOverrides: {
        renew: async () => ({
          action: "defer" as const,
          reason: "provider_reservation_renewal_deferred",
          retryAfterMs: 2_500,
        }),
      },
      onComplete: async (completion) => {
        if (completion.kind === "not_started") {
          markCleanupStarted?.();
          await new Promise<never>(() => undefined);
        }
      },
    });
    const input = dispatchInput(store, fixture.registry, providerBackpressure, {
      providerBackpressureDeadlineMs: 1,
    });
    const delivery = dispatchRoomDelivery(input);
    let settled = false;
    void delivery.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });

    try {
      await cleanupStarted;
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      await expect(delivery).resolves.toMatchObject({
        state: "delivery_uncertain",
        lastErrorCode: "provider_reservation_cleanup_timed_out",
        nextAttemptAt: null,
      });
      expect(store.beginCalls).toHaveLength(1);
      expect(fixture.sendCalls()).toBe(0);
      expect(store.completeCalls).toEqual([
        expect.objectContaining({
          errorCode: "provider_reservation_cleanup_timed_out",
          nextAttemptAt: null,
          outcome: "delivery_uncertain",
          senderFence: SENDER_FENCE,
        }),
      ]);
      expect(providerBackpressure.completionKinds()).toEqual(["not_started"]);
      expect(providerBackpressure.admitCalls()).toBe(1);
      await expect(dispatchRoomDelivery(input)).rejects.toMatchObject({ code: "delivery_state_conflict" });
      expect(providerBackpressure.admitCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a claimed delivery uncertain when authority-loss cleanup never settles", async () => {
    vi.useFakeTimers();
    let authorityChecks = 0;
    let markCleanupStarted: (() => void) | null = null;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture();
    const providerBackpressure = gate(authority(), {
      onComplete: async (completion) => {
        if (completion.kind === "not_started") {
          markCleanupStarted?.();
          await new Promise<never>(() => undefined);
        }
      },
    });
    const input = dispatchInput(store, fixture.registry, providerBackpressure, {
      assertAuthority: async () => {
        authorityChecks += 1;
        if (authorityChecks === 4) throw new Error("sender authority lost after claim");
      },
      providerBackpressureDeadlineMs: 1,
    });
    const delivery = dispatchRoomDelivery(input);

    try {
      await cleanupStarted;
      await vi.advanceTimersByTimeAsync(1);
      await expect(delivery).resolves.toMatchObject({
        state: "delivery_uncertain",
        lastErrorCode: "provider_reservation_cleanup_timed_out",
        nextAttemptAt: null,
      });
      expect(store.beginCalls).toHaveLength(1);
      expect(fixture.sendCalls()).toBe(0);
      expect(store.completeCalls).toEqual([
        expect.objectContaining({
          errorCode: "provider_reservation_cleanup_timed_out",
          nextAttemptAt: null,
          outcome: "delivery_uncertain",
          senderFence: SENDER_FENCE,
        }),
      ]);
      expect(providerBackpressure.completionKinds()).toEqual(["not_started"]);
      await expect(dispatchRoomDelivery(input)).rejects.toMatchObject({ code: "delivery_state_conflict" });
      expect(providerBackpressure.admitCalls()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("durably records the immutable cleanup action then blocks fresh provider admission after a pre-send cleanup timeout", async () => {
    vi.useFakeTimers();
    let markCleanupStarted: (() => void) | null = null;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture();
    const callOrder: string[] = [];
    const completeDeliveryAttempt = store.completeDeliveryAttempt.bind(store);
    vi.spyOn(store, "completeDeliveryAttempt").mockImplementation(async (input) => {
      callOrder.push("outbox_uncertain");
      expect(callOrder).toEqual(["cleanup_action", "outbox_uncertain"]);
      return completeDeliveryAttempt(input);
    });
    const cleanupActions = {
      enqueue: vi.fn(async (input: Record<string, unknown>) => {
        callOrder.push("cleanup_action");
        expect(input).toMatchObject({
          projectId: "project-1",
          roomId: "room-1",
          outboxId: "outbox-1",
          reservationId: "reservation-1",
          requestId: "room-provider-capacity:claim-1",
          claimId: "outbox-1:attempt-1",
          completionKind: "pre_send_not_started",
          originalWorkerFence: {
            leaseId: "room-worker-lease-1",
            holderId: "room-worker-1",
            hostId: "host-1",
            epoch: 3,
          },
          expectedAggregateVersion: 17,
          reservationExpiresAt: "2026-07-19T10:01:00.000Z",
        });
        return { status: "created" as const, action: {} };
      }),
    };
    const providerBackpressure = gate(authority(), {
      permitOverrides: {
        cleanupDescriptor: {
          claimId: "outbox-1:attempt-1",
          originalWorkerFence: {
            leaseId: "room-worker-lease-1",
            holderId: "room-worker-1",
            hostId: "host-1",
            epoch: 3,
          },
          expectedAggregateVersion: 17,
          reservationExpiresAt: "2026-07-19T10:01:00.000Z",
        },
        renew: async () => ({
          action: "defer" as const,
          reason: "provider_reservation_renewal_deferred",
          retryAfterMs: 2_500,
        }),
      },
      onComplete: async (completion) => {
        if (completion.kind === "not_started") {
          markCleanupStarted?.();
          await new Promise<never>(() => undefined);
        }
      },
    });
    const input = dispatchInput(store, fixture.registry, providerBackpressure, {
      providerBackpressureDeadlineMs: 1,
      providerBackpressureCleanupActions: cleanupActions,
      providerBackpressureCleanupContext: { projectId: "project-1" },
    });
    const delivery = dispatchRoomDelivery(input);

    try {
      await cleanupStarted;
      await vi.advanceTimersByTimeAsync(1);
      await expect(delivery).resolves.toMatchObject({
        state: "delivery_uncertain",
        lastErrorCode: "provider_reservation_cleanup_timed_out",
        nextAttemptAt: null,
      });
      expect(cleanupActions.enqueue).toHaveBeenCalledTimes(1);
      expect(callOrder).toEqual(["cleanup_action", "outbox_uncertain"]);
      expect(store.completeCalls).toEqual([
        expect.objectContaining({
          errorCode: "provider_reservation_cleanup_timed_out",
          nextAttemptAt: null,
          outcome: "delivery_uncertain",
          senderFence: SENDER_FENCE,
        }),
      ]);
      await expect(dispatchRoomDelivery(input)).rejects.toMatchObject({ code: "delivery_state_conflict" });
      expect(providerBackpressure.admitCalls()).toBe(1);
      expect(fixture.sendCalls()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when a provider permit cannot renew at the final send boundary", async () => {
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture();
    const providerBackpressure = gate(authority(), { omitRenew: true });

    await expect(dispatchRoomDelivery(dispatchInput(store, fixture.registry, providerBackpressure)))
      .resolves.toMatchObject({
        state: "pending",
        lastErrorCode: "provider_reservation_renewal_unavailable",
        nextAttemptAt: "2026-07-19T10:00:01.000Z",
      });

    expect(store.beginCalls).toHaveLength(1);
    expect(fixture.sendCalls()).toBe(0);
    expect(store.completeCalls).toEqual([
      expect.objectContaining({
        errorCode: "provider_reservation_renewal_unavailable",
        nextAttemptAt: "2026-07-19T10:00:01.000Z",
        outcome: "retryable_failure",
        senderFence: SENDER_FENCE,
      }),
    ]);
    expect(providerBackpressure.completionKinds()).toEqual(["not_started"]);
  });

  it("renews an admitted permit immediately before connector.send", async () => {
    const store = new MemoryDeliveryStore();
    const callOrder: string[] = [];
    const fixture = connectorFixture({ onSend: () => callOrder.push("send") });
    const providerBackpressure = gate(authority(), {
      permitOverrides: {
        renew: async () => {
          callOrder.push("renew");
          return {
            action: "renewed" as const,
            expiresAt: "2026-07-19T10:01:00.000Z",
            replayed: false,
          };
        },
      },
    });

    await expect(dispatchRoomDelivery(dispatchInput(store, fixture.registry, providerBackpressure)))
      .resolves.toMatchObject({ state: "confirmed" });

    expect(callOrder).toEqual(["renew", "send"]);
  });

  it("rechecks sender authority after provider renewal before connector.send", async () => {
    let senderAuthorityRevoked = false;
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture();
    const providerBackpressure = gate(authority(), {
      permitOverrides: {
        renew: async () => {
          senderAuthorityRevoked = true;
          return {
            action: "renewed" as const,
            expiresAt: "2026-07-19T10:01:00.000Z",
            replayed: false,
          };
        },
      },
    });

    await expect(dispatchRoomDelivery(dispatchInput(store, fixture.registry, providerBackpressure, {
      assertAuthority: async () => {
        if (senderAuthorityRevoked) throw new Error("sender authority lost during provider renewal");
      },
    }))).rejects.toThrow("sender authority lost during provider renewal");

    expect(providerBackpressure.completionKinds()).toEqual(["not_started"]);
    expect(store.beginCalls).toHaveLength(1);
    expect(fixture.sendCalls()).toBe(0);
  });

  it("rejects a replayed permit whose immutable request binding does not match the delivery", async () => {
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture();
    const providerBackpressure = gate(authority(), {
      permitOverrides: { requestHash: "replayed-request-hash" },
    });

    await expect(dispatchRoomDelivery(dispatchInput(store, fixture.registry, providerBackpressure)))
      .resolves.toMatchObject({ state: "pending" });

    expect(store.beginCalls).toHaveLength(0);
    expect(fixture.sendCalls()).toBe(0);
  });

  it("rejects an expired permit before beginning an external send", async () => {
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture();
    const providerBackpressure = gate(authority(), {
      permitOverrides: { expiresAt: "2026-07-19T09:59:59.999Z" },
    });

    await expect(dispatchRoomDelivery(dispatchInput(store, fixture.registry, providerBackpressure)))
      .resolves.toMatchObject({ state: "pending" });

    expect(store.beginCalls).toHaveLength(0);
    expect(fixture.sendCalls()).toBe(0);
  });

  it("confirms a known accepted connector receipt despite provider cleanup failure", async () => {
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture();
    const providerBackpressure = gate(authority(), {
      onComplete: async (completion) => {
        if (completion.kind === "connector_result") {
          throw new Error("provider completion write failed");
        }
      },
    });
    const input = dispatchInput(store, fixture.registry, providerBackpressure);

    await expect(dispatchRoomDelivery(input)).resolves.toMatchObject({
      state: "confirmed",
      connectorAcknowledgementId: "ack-1",
      nativeMessageId: "native-1",
      nativeCursor: "cursor-1",
      lastErrorCode: "provider_reservation_cleanup_failed",
    });
    await expect(dispatchRoomDelivery(input)).rejects.toMatchObject({ code: "delivery_state_conflict" });

    expect(fixture.sendCalls()).toBe(1);
    expect(store.completeCalls).toEqual([
      expect.objectContaining({
        connectorAcknowledgementId: "ack-1",
        errorCode: "provider_reservation_cleanup_failed",
        nativeCursor: "cursor-1",
        nativeMessageId: "native-1",
        outcome: "confirmed",
      }),
    ]);
  });

  it("persists a confirmed connector receipt when post-send permit cleanup never settles", async () => {
    vi.useFakeTimers();
    let markCleanupStarted: (() => void) | null = null;
    const cleanupStarted = new Promise<void>((resolve) => {
      markCleanupStarted = resolve;
    });
    const store = new MemoryDeliveryStore();
    const fixture = connectorFixture();
    const providerBackpressure = gate(authority(), {
      onComplete: async (completion) => {
        if (completion.kind === "connector_result") {
          markCleanupStarted?.();
          await new Promise<never>(() => undefined);
        }
      },
    });
    const delivery = dispatchRoomDelivery(dispatchInput(store, fixture.registry, providerBackpressure, {
      providerBackpressureDeadlineMs: 1,
    }));
    let settled = false;
    void delivery.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });

    try {
      await cleanupStarted;
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      await expect(delivery).resolves.toMatchObject({
        state: "confirmed",
        connectorAcknowledgementId: "ack-1",
        nativeMessageId: "native-1",
        nativeCursor: "cursor-1",
        lastErrorCode: "provider_reservation_cleanup_timed_out",
      });
      expect(fixture.sendCalls()).toBe(1);
      expect(store.completeCalls).toEqual([
        expect.objectContaining({
          connectorAcknowledgementId: "ack-1",
          errorCode: "provider_reservation_cleanup_timed_out",
          nativeCursor: "cursor-1",
          nativeMessageId: "native-1",
          outcome: "confirmed",
        }),
      ]);
      expect(providerBackpressure.completionKinds()).toEqual(["connector_result"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

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

import {
  dispatchRoomDelivery,
  type RoomDeliveryCoordinatorStore,
} from "../room-delivery-coordinator.js";
import { SessionConnectorRegistry } from "../session-connector-registry.js";

const NOW = "2026-07-20T14:00:00.000Z";
const AFTER_ORIGINAL_RETRY_AT = "2026-07-20T14:00:01.001Z";

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

  async getDelivery(outboxId: string): Promise<RoomOutboxRecordV1 | null> {
    return outboxId === this.current.id ? this.current : null;
  }

  async getBinding(bindingId: string): Promise<RoomBindingRecordV1 | null> {
    return bindingId === this.binding.id ? this.binding : null;
  }

  async beginDeliveryAttempt(input: BeginRoomDeliveryAttemptInput): Promise<RoomOutboxRecordV1> {
    if (this.current.state !== "pending") throw new Error(`cannot claim ${this.current.state}`);
    this.current = {
      ...this.current,
      state: "dispatching",
      attemptCount: this.current.attemptCount + 1,
      reconciliationFromCursor: input.reconciliationFromCursor,
      nextAttemptAt: null,
      updatedAt: input.now,
    };
    return this.current;
  }

  async deferPendingDelivery(input: DeferPendingRoomDeliveryInput): Promise<RoomOutboxRecordV1> {
    if (this.current.state !== "pending" || this.current.attemptCount !== input.expectedAttemptCount) {
      throw new Error("stale pending delivery generation");
    }
    this.current = {
      ...this.current,
      lastErrorCode: input.reasonCode,
      nextAttemptAt: input.nextAttemptAt,
      updatedAt: input.now,
    };
    return this.current;
  }

  async completeDeliveryAttempt(input: CompleteRoomDeliveryAttemptInput): Promise<RoomOutboxRecordV1> {
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
  const identity = {
    logicalMessageId: "message-1",
    bindingId: "binding-1",
    idempotencyKey: "room-message-1:binding-1",
    payloadHash: hashRoomValue("late provider admission timeout"),
  };
  return {
    contractVersion: 1,
    id: "outbox-1",
    roomId: "room-1",
    ...identity,
    localMessageId: buildRoomConnectorLocalMessageId(identity),
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

function connectorFixture(): {
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
  const unavailable = () => ({
    ok: false as const,
    error: { code: "unavailable" as const, message: "not used", retryable: false },
  });
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
      capabilities: Object.fromEntries(
        SESSION_CONNECTOR_CAPABILITIES.map((capability) => [capability, verified]),
      ),
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

function admittedAuthority(): {
  readonly scope: RoomProviderBackpressureScopeV1;
  readonly telemetry: RoomProviderBackpressureTelemetryV1;
  readonly policy: RoomProviderBackpressurePolicyV1;
  readonly decision: unknown;
} {
  const scope: RoomProviderBackpressureScopeV1 = {
    providerId: "codex",
    accountId: "account-1",
    modelId: "gpt-5",
    connectorId: "happier",
    nodeId: "node-1",
  };
  const telemetry: RoomProviderBackpressureTelemetryV1 = {
    known: true,
    observedAt: NOW,
    admissionConfirmed: true,
    activeRequests: 0,
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
  return {
    scope,
    telemetry,
    policy,
    decision: {
      contractVersion: 1,
      scope,
      scopeKey: JSON.stringify(["codex", "account-1", "gpt-5", "happier", "node-1"]),
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
        scopeKey: JSON.stringify(["codex", "account-1", "gpt-5", "happier", "node-1"]),
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

describe("Room delivery coordinator late provider admission timeout", () => {
  /*
  FNXC:RoomProviderLateAdmissionTombstone 2026-07-20-23:00:
  A timed-out provider admission remains an unresolved external operation. Even
  after the formerly persisted nextAttemptAt passes, a second dispatcher must
  encounter a durable Core fence before it can request another admission or
  call connector.send. Only the exact late result may resolve that tombstone;
  an admitted result additionally carries the immutable reservation evidence
  needed by the existing cleanup workflow.
  */
  it("blocks a second dispatch after the timeout retry instant until the first late permit resolves", async () => {
    vi.useFakeTimers();
    const store = new MemoryDeliveryStore();
    const connector = connectorFixture();
    let now = NOW;
    let admissionCalls = 0;
    let firstRequest: Record<string, unknown> | null = null;
    let resolveFirstAdmission: ((result: unknown) => void) | null = null;
    let resolveLateCompletion: (() => void) | null = null;
    const lateCompletion = new Promise<void>((resolve) => {
      resolveLateCompletion = resolve;
    });
    const timeoutTombstone = {
      contractVersion: 1 as const,
      id: "provider-admission-timeout:tombstone-1",
      projectId: "project-1",
      roomId: "room-1",
      gateAttemptId: "",
      requestHash: "",
      outboxId: "outbox-1",
      outboxBindingId: "binding-1",
      outboxAttemptCount: 0,
      senderFence: {
        leaseId: SENDER_FENCE.leaseId,
        holderId: SENDER_FENCE.holderId,
        hostId: SENDER_FENCE.hostId,
        epoch: SENDER_FENCE.expectedEpoch,
      },
      timeoutErrorCode: "provider_gate_timeout",
      recoveryProtocol: "opaque" as const,
      state: "pending" as const,
      cleanupActionId: null,
      reservationId: null,
      terminalGateOutcomeId: null,
      terminalGateOutcome: null,
      terminalAt: null,
      nextAttemptAt: null,
      resolvedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const cleanupActions = {
      enqueue: vi.fn(async () => ({ status: "created" as const, action: {} })),
      fencePendingAdmissionTimeout: vi.fn(async (input: {
        readonly gateAttemptId: string;
        readonly requestHash: string;
        readonly recoveryProtocol: "opaque";
        readonly errorCode: string;
      }) => {
        store.current = {
          ...store.current,
          state: "delivery_uncertain",
          lastErrorCode: input.errorCode,
          nextAttemptAt: null,
        };
        return {
          status: "created" as const,
          tombstone: {
            ...timeoutTombstone,
            gateAttemptId: input.gateAttemptId,
            requestHash: input.requestHash,
            recoveryProtocol: input.recoveryProtocol,
          },
          outbox: store.current,
        };
      }),
      bindAdmissionTimeoutReservation: vi.fn(async (input: {
        readonly gateAttemptId: string;
        readonly requestHash: string;
        readonly cleanupAction: { readonly actionId: string; readonly reservationId: string };
      }) => ({
        status: "bound" as const,
        tombstone: {
          ...timeoutTombstone,
          gateAttemptId: input.gateAttemptId,
          requestHash: input.requestHash,
          state: "reservation_bound" as const,
          cleanupActionId: input.cleanupAction.actionId,
          reservationId: input.cleanupAction.reservationId,
          resolvedAt: now,
          updatedAt: now,
        },
        action: {},
        outbox: store.current,
      })),
      recordAdmissionTimeoutTerminalOutcome: vi.fn(async () => {
        throw new Error("terminal no-permit proof is not exercised by this late-permit regression");
      }),
      resolveAdmissionTimeoutWithoutPermit: vi.fn(async () => {
        throw new Error("no-permit resolution is not exercised by this late-permit regression");
      }),
      fencePendingOutbox: vi.fn(async () => {
        store.current = {
          ...store.current,
          state: "delivery_uncertain",
          lastErrorCode: "provider_late_admission_unsettled",
          nextAttemptAt: null,
        };
        return { status: "created" as const, action: {}, outbox: store.current };
      }),
    };
    const providerBackpressure = {
      timeoutRecoveryProtocol: { contractVersion: 1 as const, kind: "core_sender_fenced_v1" as const },
      admit: async (request: Record<string, unknown>) => {
        admissionCalls += 1;
        if (admissionCalls === 1) {
          firstRequest = request;
          return new Promise<unknown>((resolve) => {
            resolveFirstAdmission = resolve;
          });
        }
        return {
          contractVersion: 1,
          action: "defer" as const,
          reason: "provider_capacity_deferred",
          retryAfterMs: 1_000,
        };
      },
    };
    const dispatch = (attemptId: string) => dispatchRoomDelivery({
      store,
      registry: connector.registry,
      identity: IDENTITY,
      outboxId: "outbox-1",
      attemptId,
      senderFence: SENDER_FENCE,
      content: "late provider admission timeout",
      reconciliationFromCursor: null,
      now: NOW,
      currentTime: () => now,
      audit: { runId: `run-${attemptId}`, agentId: "worker-1" },
      providerBackpressure,
      providerBackpressureDeadlineMs: 1,
      providerBackpressureCleanupActions: cleanupActions as never,
      providerBackpressureCleanupContext: { projectId: "project-1" },
    });

    try {
      const firstDispatch = dispatch("attempt-timeout-1");
      await vi.advanceTimersByTimeAsync(1);
      await firstDispatch;

      now = AFTER_ORIGINAL_RETRY_AT;
      const secondOutcome = await dispatch("attempt-after-timeout-2").then(
        (delivery) => ({ status: "resolved" as const, delivery }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );

      if (resolveFirstAdmission === null || firstRequest === null) {
        throw new Error("first provider admission did not remain pending through its deadline");
      }
      resolveFirstAdmission({
        contractVersion: 1,
        action: "admit",
        permit: {
          contractVersion: 1,
          reservationId: "reservation-late-1",
          requestId: "room-provider-capacity:late-1",
          requestHash: firstRequest.requestHash,
          requestBinding: firstRequest.requestBinding,
          expiresAt: "2026-07-20T14:10:00.000Z",
          authority: admittedAuthority(),
          cleanupDescriptor: {
            claimId: "claim-late-1",
            originalWorkerFence: {
              leaseId: "room-worker-lease-1",
              holderId: "room-worker-1",
              hostId: "host-1",
              epoch: 3,
            },
            expectedAggregateVersion: 17,
            reservationExpiresAt: "2026-07-20T14:10:00.000Z",
          },
          complete: async () => {
            resolveLateCompletion?.();
            return { action: "released" as const };
          },
        },
      });
      await lateCompletion;
      await vi.advanceTimersByTimeAsync(0);

      expect(secondOutcome).not.toMatchObject({
        status: "resolved",
        delivery: { state: "confirmed" },
      });
      expect(cleanupActions.fencePendingAdmissionTimeout).toHaveBeenCalledTimes(1);
      expect(cleanupActions.fencePendingAdmissionTimeout).toHaveBeenCalledWith(expect.objectContaining({
        recoveryProtocol: "opaque",
      }));
      expect(cleanupActions.bindAdmissionTimeoutReservation).toHaveBeenCalledTimes(1);
      expect(admissionCalls).toBe(1);
      expect(connector.sendCalls()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /*
  FNXC:RoomProviderAdmissionTimeoutNoPermit 2026-07-20-23:27:
  A late no-permit result must be recorded as immutable terminal proof even if
  the original Room-worker lease has expired. DispatchRoomDelivery owns no
  cleanup-worker lease, so it must leave the tombstone delivery_uncertain for a
  real recovery worker instead of fabricating authority or reopening delivery.
  */
  it("records late no-permit proof but never reopens without a real cleanup-worker lease", async () => {
    vi.useFakeTimers();
    const store = new MemoryDeliveryStore();
    const connector = connectorFixture();
    let now = NOW;
    let admissionCalls = 0;
    let resolveFirstAdmission: ((result: unknown) => void) | null = null;
    let fencedGateAttemptId = "";
    let fencedRequestHash = "";
    let historicalSenderAuthorityActive = true;
    let authorityChecks = 0;
    const cleanupActions = {
      enqueue: vi.fn(async () => ({ status: "created" as const, action: {} })),
      fencePendingAdmissionTimeout: vi.fn(async (input: {
        readonly gateAttemptId: string;
        readonly requestHash: string;
        readonly recoveryProtocol: "opaque";
        readonly errorCode: string;
      }) => {
        fencedGateAttemptId = input.gateAttemptId;
        fencedRequestHash = input.requestHash;
        store.current = {
          ...store.current,
          state: "delivery_uncertain",
          lastErrorCode: input.errorCode,
          nextAttemptAt: null,
        };
        return {
          status: "created" as const,
          tombstone: {
            contractVersion: 1,
            id: "provider-admission-timeout:no-permit",
            projectId: "project-1",
            roomId: "room-1",
            gateAttemptId: input.gateAttemptId,
            requestHash: input.requestHash,
            outboxId: "outbox-1",
            outboxBindingId: "binding-1",
            outboxAttemptCount: 0,
            senderFence: {
              leaseId: SENDER_FENCE.leaseId,
              holderId: SENDER_FENCE.holderId,
              hostId: SENDER_FENCE.hostId,
              epoch: SENDER_FENCE.expectedEpoch,
            },
            timeoutErrorCode: "provider_gate_timeout",
            recoveryProtocol: input.recoveryProtocol,
            state: "pending" as const,
            cleanupActionId: null,
            reservationId: null,
            terminalGateOutcomeId: null,
            terminalGateOutcome: null,
            terminalAt: null,
            nextAttemptAt: null,
            resolvedAt: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
          outbox: store.current,
        };
      }),
      recordAdmissionTimeoutTerminalOutcome: vi.fn(async (input: {
        readonly gateAttemptId: string;
        readonly requestHash: string;
        readonly terminalGateOutcome: {
          readonly outcomeId: string;
          readonly outcome: string;
          readonly occurredAt: string;
        };
      }) => ({
        status: "recorded" as const,
        tombstone: {
          contractVersion: 1,
          id: "provider-admission-timeout:no-permit",
          projectId: "project-1",
          roomId: "room-1",
          gateAttemptId: input.gateAttemptId,
          requestHash: input.requestHash,
          outboxId: "outbox-1",
          outboxBindingId: "binding-1",
          outboxAttemptCount: 0,
          senderFence: {
            leaseId: SENDER_FENCE.leaseId,
            holderId: SENDER_FENCE.holderId,
            hostId: SENDER_FENCE.hostId,
            epoch: SENDER_FENCE.expectedEpoch,
          },
          timeoutErrorCode: "provider_gate_timeout",
          recoveryProtocol: "opaque" as const,
          state: "terminal_outcome_recorded" as const,
          cleanupActionId: null,
          reservationId: null,
          terminalGateOutcomeId: input.terminalGateOutcome.outcomeId,
          terminalGateOutcome: input.terminalGateOutcome.outcome,
          terminalAt: input.terminalGateOutcome.occurredAt,
          nextAttemptAt: null,
          resolvedAt: null,
          createdAt: NOW,
          updatedAt: now,
        },
        outbox: store.current,
      })),
      bindAdmissionTimeoutReservation: vi.fn(async () => {
        throw new Error("a no-permit outcome must not bind a reservation");
      }),
      resolveAdmissionTimeoutWithoutPermit: vi.fn(async () => {
        throw new Error("the coordinator must not fabricate a cleanup-worker lease");
      }),
      fencePendingOutbox: vi.fn(async () => {
        throw new Error("the timeout tombstone already owns the outbox fence");
      }),
    };
    const providerBackpressure = {
      admit: async () => {
        admissionCalls += 1;
        return new Promise<unknown>((resolve) => {
          resolveFirstAdmission = resolve;
        });
      },
    };
    const dispatch = (attemptId: string) => dispatchRoomDelivery({
      store,
      registry: connector.registry,
      identity: IDENTITY,
      outboxId: "outbox-1",
      attemptId,
      senderFence: SENDER_FENCE,
      content: "late provider admission timeout",
      reconciliationFromCursor: null,
      now: NOW,
      currentTime: () => now,
      assertAuthority: async () => {
        authorityChecks += 1;
        if (!historicalSenderAuthorityActive) {
          throw new Error("historical sender lease expired");
        }
      },
      audit: { runId: `run-${attemptId}`, agentId: "worker-1" },
      providerBackpressure,
      providerBackpressureDeadlineMs: 1,
      providerBackpressureCleanupActions: cleanupActions as never,
      providerBackpressureCleanupContext: { projectId: "project-1" },
    });

    try {
      const firstDispatch = dispatch("attempt-timeout-no-permit-1");
      await vi.advanceTimersByTimeAsync(1);
      await expect(firstDispatch).resolves.toMatchObject({
        state: "delivery_uncertain",
        lastErrorCode: "provider_gate_timeout",
        nextAttemptAt: null,
      });

      if (resolveFirstAdmission === null) {
        throw new Error("first provider admission did not remain pending through its deadline");
      }
      const authorityChecksBeforeLateCallback = authorityChecks;
      historicalSenderAuthorityActive = false;
      resolveFirstAdmission({
        contractVersion: 1,
        action: "defer",
        reason: "provider_capacity_deferred",
        retryAfterMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(authorityChecks).toBe(authorityChecksBeforeLateCallback);

      const expectedOutcomeId = `room-provider-admission-terminal:${hashRoomValue({
        contractVersion: 1,
        gateAttemptId: fencedGateAttemptId,
        requestHash: fencedRequestHash,
        action: "defer",
        reason: "provider_capacity_deferred",
        retryAfterMs: 1_000,
      })}`;
      expect(cleanupActions.recordAdmissionTimeoutTerminalOutcome).toHaveBeenCalledOnce();
      expect(cleanupActions.recordAdmissionTimeoutTerminalOutcome).toHaveBeenCalledWith(expect.objectContaining({
        projectId: "project-1",
        roomId: "room-1",
        gateAttemptId: fencedGateAttemptId,
        requestHash: fencedRequestHash,
        outboxId: "outbox-1",
        outboxBindingId: "binding-1",
        outboxAttemptCount: 0,
        senderFence: SENDER_FENCE,
        terminalGateOutcome: {
          outcomeId: expectedOutcomeId,
          outcome: "deferred_without_permit",
          occurredAt: NOW,
        },
      }));
      historicalSenderAuthorityActive = true;
      now = AFTER_ORIGINAL_RETRY_AT;
      await expect(dispatch("attempt-after-no-permit-2"))
        .rejects.toMatchObject({ code: "delivery_state_conflict" });
      expect(store.current).toMatchObject({
        state: "delivery_uncertain",
        lastErrorCode: "provider_gate_timeout",
        nextAttemptAt: null,
      });
      expect(cleanupActions.resolveAdmissionTimeoutWithoutPermit).not.toHaveBeenCalled();
      expect(cleanupActions.bindAdmissionTimeoutReservation).not.toHaveBeenCalled();
      expect(admissionCalls).toBe(1);
      expect(connector.sendCalls()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

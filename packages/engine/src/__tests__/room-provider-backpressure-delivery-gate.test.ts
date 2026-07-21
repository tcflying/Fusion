import { describe, expect, it } from "vitest";

import {
  hashRoomValue,
  type RoomBindingRecordV1,
  type RoomOutboxRecordV1,
  type SessionConnectorIdentityV1,
  type StoredRoomLeaseV1,
} from "@fusion/core";

import {
  createRoomProviderBackpressureSendRequestBinding,
  hashRoomProviderBackpressureSendRequestBinding,
  type RoomProviderBackpressureSendGateRequestV1,
} from "../room-provider-backpressure-send-boundary.js";
import {
  createRoomProviderBackpressureDeliveryGate,
  isCoreSenderFencedRecoveryGate,
} from "../room-provider-backpressure-delivery-gate.js";

const NOW = "2026-07-19T10:00:00.000Z";
const EXPIRES_AT = "2026-07-19T10:01:00.000Z";

const IDENTITY: SessionConnectorIdentityV1 = {
  connectorId: "happier",
  providerId: "codex",
  nativeSessionId: "native-session-1",
  happierSessionId: "happier-session-1",
  serverProfileId: "server-profile-1",
  machineId: "machine-1",
  hostId: "host-1",
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
  serverProfileId: "server-profile-1",
  machineId: "machine-1",
  hostId: "host-1",
  state: "attached",
  attachedAt: NOW,
  detachedAt: null,
  replacedByBindingId: null,
};

const DELIVERY: RoomOutboxRecordV1 = {
  contractVersion: 1,
  id: "outbox-1",
  roomId: "room-1",
  logicalMessageId: "message-1",
  localMessageId: "local-message-1",
  bindingId: "binding-1",
  idempotencyKey: "room-message-1:binding-1",
  payloadHash: hashRoomValue("provider delivery gate"),
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

const ROOM_WORKER_LEASE: StoredRoomLeaseV1 = {
  contractVersion: 1,
  id: "room-worker-lease-1",
  roomId: "room-1",
  kind: "room_worker",
  resourceId: "room-1",
  holderId: "worker-1",
  hostId: "host-1",
  epoch: 1,
  acquiredAt: NOW,
  heartbeatAt: NOW,
  expiresAt: EXPIRES_AT,
  releasedAt: null,
};

function request(options: { readonly asOf?: string; readonly deadline?: string } = {}): RoomProviderBackpressureSendGateRequestV1 {
  const controller = new AbortController();
  const base = {
    contractVersion: 1 as const,
    delivery: DELIVERY,
    binding: BINDING,
    identity: IDENTITY,
    attemptId: "attempt-1",
    senderFence: {
      leaseId: "sender-lease-1",
      roomId: "room-1",
      kind: "sender" as const,
      resourceId: "binding-1",
      holderId: "worker-1",
      hostId: "host-1",
      expectedEpoch: 1,
    },
    asOf: options.asOf ?? NOW,
    deadline: options.deadline ?? EXPIRES_AT,
    signal: controller.signal,
  };
  const requestBinding = createRoomProviderBackpressureSendRequestBinding(base);
  return { ...base, requestBinding, requestHash: hashRoomProviderBackpressureSendRequestBinding(requestBinding) };
}

function trustedSnapshot() {
  const scope = {
    providerId: "codex",
    accountId: "account-1",
    modelId: "gpt-5",
    connectorId: "happier",
    nodeId: "provider-node-1",
  } as const;
  const telemetry = {
    known: true,
    observedAt: NOW,
    admissionConfirmed: true,
    activeRequests: 0,
  } as const;
  const policy = {
    concurrencyCap: 4,
    reservedVerifierSlots: 1,
    reservedRecoverySlots: 1,
    telemetryTtlMs: 30_000,
    failureThreshold: 2,
    maxRetryAttempts: 3,
    baseBackoffMs: 1_000,
    maxBackoffMs: 4_000,
    circuitOpenMs: 5_000,
  } as const;
  return {
    contractVersion: 1 as const,
    registryId: "registry-1",
    registryRevision: 7,
    registryObservedAt: NOW,
    capturedAt: NOW,
    expiresAt: EXPIRES_AT,
    scope,
    telemetry,
    policy,
    capability: {
      contractVersion: 1 as const,
      snapshotId: "capability-1",
      revision: 3,
      lineage: {
        bindingId: "binding-1",
        bindingGeneration: 1,
        providerId: "codex",
        accountId: "account-1",
        modelId: "gpt-5",
        connectorId: "happier",
        nativeSessionId: "native-session-1",
        hostId: "host-1",
      },
      freshness: { capturedAt: NOW, expiresAt: EXPIRES_AT, sourceRevision: "connector-revision-1" },
      tools: [],
      context: { contextVersion: "context-1", maximumTokens: 100_000, availableTokens: 90_000, observedAt: NOW },
      health: { connectorState: "healthy" as const, hostState: "healthy" as const, observedAt: NOW },
      latency: { p50Ms: 10, p95Ms: 20, sampleCount: 1, observedAt: NOW },
      rateLimit: { state: "clear" as const, retryAfterMs: null, observedAt: NOW },
      domainQuality: [],
      calibration: [],
      integrityHash: "trusted-capability-integrity",
    },
  };
}

function createGateFixture(options: {
  readonly snapshot?: ReturnType<typeof trustedSnapshot>;
  readonly durableSnapshot?: unknown;
  readonly commitResult?: unknown;
  readonly renewResult?: unknown;
  readonly authorityResult?: unknown;
  readonly snapshotResult?: unknown;
  readonly releaseError?: boolean;
  readonly releaseFailures?: number;
  readonly onAuthorityResolve?: (input: { readonly phase: "admit" | "renew" | "release" }) => unknown;
} = {}) {
  const snapshot = options.snapshot ?? trustedSnapshot();
  const reads: unknown[] = [];
  const commits: unknown[] = [];
  const renews: unknown[] = [];
  const releases: unknown[] = [];
  let remainingReleaseFailures = options.releaseFailures ?? (options.releaseError ? Number.MAX_SAFE_INTEGER : 0);
  const gate = createRoomProviderBackpressureDeliveryGate({
    corePorts: {
      read: async (input) => {
        reads.push(input);
        return (options.durableSnapshot ?? {
          scope: snapshot.scope,
          telemetry: snapshot.telemetry,
          policy: snapshot.policy,
        }) as never;
      },
      commit: async (input) => {
        commits.push(input);
        return (options.commitResult ?? { status: "reserved", reservationId: "reservation-1" }) as never;
      },
      renew: async (input) => {
        renews.push(input);
        return (options.renewResult ?? { status: "held", reason: "not_used" }) as never;
      },
      release: async (input) => {
        releases.push(input);
        if (remainingReleaseFailures > 0) {
          remainingReleaseFailures -= 1;
          throw new Error("durable release failed");
        }
      },
    },
    trustedAdmissionSnapshot: {
      read: async () => (options.snapshotResult ?? { action: "ready", snapshot }) as never,
    },
    roomWorkerAuthority: {
      resolve: async (input) => (options.onAuthorityResolve?.(input) ?? options.authorityResult ?? {
        action: "ready",
        authority: {
          projectId: "project-1",
          roomId: "room-1",
          lease: ROOM_WORKER_LEASE,
          expectedAggregateVersion: 12,
        },
      }) as never,
    },
  });
  return { gate, reads, commits, renews, releases };
}

describe("Room provider backpressure delivery gate", () => {
  it("reserves the exact outbox attempt after trusted read, decision, and durable commit", async () => {
    const fixture = createGateFixture();

    const result = await fixture.gate.admit(request());

    expect(result).toMatchObject({
      action: "admit",
      permit: { reservationId: "reservation-1", requestId: "room-provider-capacity:outbox-1:attempt-1" },
    });
    expect(fixture.reads).toHaveLength(1);
    expect(fixture.commits).toHaveLength(1);
  });

  it("recognizes only the factory-created Core sender-fenced gate and commits the exact sender fence", async () => {
    const fixture = createGateFixture();
    const gateRequest = request();

    await fixture.gate.admit(gateRequest);

    expect(isCoreSenderFencedRecoveryGate(fixture.gate)).toBe(true);
    expect(isCoreSenderFencedRecoveryGate({
      timeoutRecoveryProtocol: { contractVersion: 1, kind: "core_sender_fenced_v1" },
      admit: fixture.gate.admit,
    })).toBe(false);
    expect(fixture.gate.timeoutRecoveryProtocol).toEqual({
      contractVersion: 1,
      kind: "core_sender_fenced_v1",
    });
    expect(fixture.commits).toEqual([
      expect.objectContaining({ senderFence: gateRequest.senderFence }),
    ]);
  });

  it("exposes the immutable reservation cleanup descriptor without asking a later worker to recreate the old fence", async () => {
    const fixture = createGateFixture();

    const result = await fixture.gate.admit(request());

    expect(result.action).toBe("admit");
    if (result.action !== "admit") throw new Error("Expected an admitted provider permit");
    expect(result.permit.cleanupDescriptor).toEqual({
      claimId: "outbox-1:attempt-1",
      originalWorkerFence: {
        leaseId: ROOM_WORKER_LEASE.id,
        holderId: ROOM_WORKER_LEASE.holderId,
        hostId: ROOM_WORKER_LEASE.hostId,
        epoch: ROOM_WORKER_LEASE.epoch,
      },
      expectedAggregateVersion: 12,
      reservationExpiresAt: EXPIRES_AT,
    });
  });

  it("fails closed when trusted authority omits an explicit provider node instead of deriving one from host", async () => {
    const base = trustedSnapshot();
    const fixture = createGateFixture({
      snapshot: {
        ...base,
        scope: { ...base.scope, nodeId: "" },
      } as never,
    });

    await expect(fixture.gate.admit(request())).resolves.toMatchObject({
      action: "defer",
      reason: "provider_node_unavailable",
    });

    expect(fixture.reads).toHaveLength(0);
    expect(fixture.commits).toHaveLength(0);
  });

  it("defers when Core read returns a provider/account/model/connector/node scope other than the trusted binding snapshot", async () => {
    const snapshot = trustedSnapshot();
    const fixture = createGateFixture({
      durableSnapshot: {
        scope: { ...snapshot.scope, accountId: "account-2" },
        telemetry: snapshot.telemetry,
        policy: snapshot.policy,
      },
    });

    await expect(fixture.gate.admit(request())).resolves.toMatchObject({
      action: "defer",
      reason: "provider_scope_snapshot_mismatch",
    });

    expect(fixture.reads).toHaveLength(1);
    expect(fixture.commits).toHaveLength(0);
  });

  it("fails closed before snapshot or Core access when Room-worker authority is stale", async () => {
    const fixture = createGateFixture({
      authorityResult: {
        action: "ready",
        authority: {
          projectId: "project-1",
          roomId: "room-1",
          lease: { ...ROOM_WORKER_LEASE, expiresAt: NOW },
          expectedAggregateVersion: 12,
        },
      },
    });

    await expect(fixture.gate.admit(request())).resolves.toMatchObject({
      action: "defer",
      reason: "room_worker_authority_stale",
    });

    expect(fixture.reads).toHaveLength(0);
    expect(fixture.commits).toHaveLength(0);
  });

  it("rejects a trusted-registry capability snapshot whose immutable binding lineage does not match the send", async () => {
    const base = trustedSnapshot();
    const fixture = createGateFixture({
      snapshot: {
        ...base,
        capability: {
          ...base.capability,
          lineage: { ...base.capability.lineage, accountId: "account-foreign" },
        },
      } as never,
    });

    await expect(fixture.gate.admit(request())).resolves.toMatchObject({
      action: "defer",
      reason: "provider_capability_identity_mismatch",
    });

    expect(fixture.reads).toHaveLength(0);
    expect(fixture.commits).toHaveLength(0);
  });

  it("fails closed before Core when the trusted capability freshness window has expired", async () => {
    const base = trustedSnapshot();
    const fixture = createGateFixture({
      snapshot: {
        ...base,
        capability: {
          ...base.capability,
          freshness: { ...base.capability.freshness, expiresAt: NOW },
        },
      } as never,
    });

    await expect(fixture.gate.admit(request())).resolves.toMatchObject({
      action: "defer",
      reason: "provider_capability_registry_stale",
      retryAfterMs: 1_000,
    });

    expect(fixture.reads).toHaveLength(0);
    expect(fixture.commits).toHaveLength(0);
  });

  it("fails closed without invoking Core when the trusted telemetry snapshot cannot confirm admission", async () => {
    const base = trustedSnapshot();
    const fixture = createGateFixture({
      snapshot: {
        ...base,
        telemetry: { ...base.telemetry, known: false },
      } as never,
    });

    await expect(fixture.gate.admit(request())).resolves.toMatchObject({
      action: "defer",
      reason: "provider_telemetry_unknown",
    });

    expect(fixture.reads).toHaveLength(0);
    expect(fixture.commits).toHaveLength(0);
  });

  it("maps an unavailable authority to a deterministic nonsecret defer before a permit can exist", async () => {
    const fixture = createGateFixture({
      authorityResult: {
        action: "defer",
        reason: "upstream-token=secret",
        retryAfterMs: null,
      },
    });

    await expect(fixture.gate.admit(request())).resolves.toEqual(expect.objectContaining({
      action: "defer",
      reason: "room_worker_authority_unavailable",
      retryAfterMs: 1_000,
    }));

    expect(fixture.reads).toHaveLength(0);
    expect(fixture.commits).toHaveLength(0);
  });

  it("maps an untrusted registry defer to a canonical reason without exposing its error text", async () => {
    const fixture = createGateFixture({
      snapshotResult: {
        action: "defer",
        reason: "connector credential expired: secret",
        retryAfterMs: 2_500,
      },
    });

    await expect(fixture.gate.admit(request())).resolves.toEqual(expect.objectContaining({
      action: "defer",
      reason: "provider_capability_registry_unavailable",
      retryAfterMs: 2_500,
    }));

    expect(fixture.reads).toHaveLength(0);
    expect(fixture.commits).toHaveLength(0);
  });

  it("maps a durable hold to a canonical retryable defer rather than returning the provider reason", async () => {
    const fixture = createGateFixture({
      commitResult: { status: "held", reason: "opaque-provider-state: secret" },
    });

    await expect(fixture.gate.admit(request())).resolves.toEqual(expect.objectContaining({
      action: "defer",
      reason: "provider_capacity_deferred",
      retryAfterMs: 1_000,
    }));

    expect(fixture.reads).toHaveLength(1);
    expect(fixture.commits).toHaveLength(1);
  });

  it("replays the same durable request identity when a crashed outbox attempt resumes under a later clock", async () => {
    const fixture = createGateFixture();

    const first = await fixture.gate.admit(request());
    const replay = await fixture.gate.admit(request({
      asOf: "2026-07-19T10:00:01.000Z",
      deadline: "2026-07-19T10:01:01.000Z",
    }));

    expect(first).toMatchObject({ action: "admit", permit: { requestId: "room-provider-capacity:outbox-1:attempt-1" } });
    expect(replay).toMatchObject({ action: "admit", permit: { requestId: "room-provider-capacity:outbox-1:attempt-1" } });
    expect(fixture.commits).toEqual([
      expect.objectContaining({ requestId: "room-provider-capacity:outbox-1:attempt-1" }),
      expect.objectContaining({ requestId: "room-provider-capacity:outbox-1:attempt-1" }),
    ]);
    const [initialCommit, replayCommit] = fixture.commits as Array<{ readonly idempotencyBindingHash?: string }>;
    expect(initialCommit?.idempotencyBindingHash).toMatch(/^sha256:/);
    expect(replayCommit?.idempotencyBindingHash).toBe(initialCommit?.idempotencyBindingHash);
  });

  it("renews a durable reservation only through refreshed Room-worker authority", async () => {
    const renewedExpiresAt = "2026-07-19T10:02:00.000Z";
    const fixture = createGateFixture({
      renewResult: {
        status: "renewed",
        reservationId: "reservation-1",
        expiresAt: renewedExpiresAt,
        replayed: false,
      },
      onAuthorityResolve: (input) => ({
        action: "ready",
        authority: {
          projectId: "project-1",
          roomId: "room-1",
          lease: input.phase === "renew"
            ? { ...ROOM_WORKER_LEASE, expiresAt: renewedExpiresAt }
            : ROOM_WORKER_LEASE,
          expectedAggregateVersion: 12,
        },
      }),
    });
    const admitted = await fixture.gate.admit(request());

    expect(admitted.action).toBe("admit");
    if (admitted.action !== "admit") throw new Error("expected permit");
    expect(admitted.permit.renew).toBeTypeOf("function");

    await expect(admitted.permit.renew?.({
      asOf: "2026-07-19T10:00:30.000Z",
      operationId: "renewal-1",
    })).resolves.toEqual(expect.objectContaining({
      action: "renewed",
      expiresAt: renewedExpiresAt,
      replayed: false,
    }));

    expect(admitted.permit.expiresAt).toBe(renewedExpiresAt);
    expect(fixture.renews).toEqual([
      expect.objectContaining({
        claimId: "outbox-1:attempt-1",
        reservationId: "reservation-1",
        operationId: "renewal-1",
      }),
    ]);
  });

  it("surfaces a cleanup failure from permit completion without throwing away a known connector receipt", async () => {
    const fixture = createGateFixture({ releaseError: true });
    const admitted = await fixture.gate.admit(request());

    expect(admitted.action).toBe("admit");
    if (admitted.action !== "admit") throw new Error("expected permit");

    await expect(admitted.permit.complete({
      kind: "connector_result",
      completedAt: "2026-07-19T10:00:10.000Z",
      outcome: "accepted",
      connectorErrorCode: null,
      retryAfterMs: null,
    })).resolves.toEqual(expect.objectContaining({
      action: "cleanup_failed",
      reason: "provider_reservation_cleanup_failed",
      retryAfterMs: 1_000,
    }));

    expect(fixture.releases).toHaveLength(1);
  });

  it("allows the same known receipt to retry durable cleanup after a transient accounting failure", async () => {
    const fixture = createGateFixture({ releaseFailures: 1 });
    const admitted = await fixture.gate.admit(request());
    const completion = {
      kind: "connector_result" as const,
      completedAt: "2026-07-19T10:00:10.000Z",
      outcome: "accepted" as const,
      connectorErrorCode: null,
      retryAfterMs: null,
    };

    expect(admitted.action).toBe("admit");
    if (admitted.action !== "admit") throw new Error("expected permit");

    await expect(admitted.permit.complete(completion)).resolves.toMatchObject({ action: "cleanup_failed" });
    await expect(admitted.permit.release?.(completion)).resolves.toEqual({ action: "released" });

    expect(fixture.releases).toHaveLength(2);
    expect(fixture.releases).toEqual([
      expect.objectContaining({ outcome: "worker_completed" }),
      expect.objectContaining({ outcome: "worker_completed" }),
    ]);
  });
});

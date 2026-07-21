import type {
  RoomCapabilityRegistry,
  RoomProviderBackpressurePostgresPortsV1,
  RoomProviderBackpressurePostgresStateV1,
  RoomProviderBackpressurePolicyV1,
  RoomProviderBackpressureReleaseOutcomeV1,
  RoomProviderBackpressureScopeV1,
  RoomProviderBackpressureTelemetryV1,
  StoredRoomLeaseV1,
} from "@fusion/core";

import {
  ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
  decideRoomProviderBackpressure,
} from "./room-provider-backpressure-controller.js";
import {
  ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION,
  createRoomProviderBackpressureAdmissionReplayBinding,
  createRoomProviderBackpressureSendRequestBinding,
  hashRoomProviderBackpressureAdmissionReplayBinding,
  hashRoomProviderBackpressureSendRequestBinding,
  type RoomProviderBackpressureSendCompletionV1,
  type RoomProviderBackpressureSendGateRequestV1,
  type RoomProviderBackpressureSendGateResultV1,
  type RoomProviderBackpressureSendGateV1,
  type RoomProviderBackpressureSendPermitCleanupResultV1,
  type RoomProviderBackpressureSendPermitRenewInputV1,
  type RoomProviderBackpressureSendPermitRenewResultV1,
  type RoomProviderBackpressureSendPermitV1,
} from "./room-provider-backpressure-send-boundary.js";

export const ROOM_PROVIDER_BACKPRESSURE_DELIVERY_GATE_CONTRACT_VERSION = 1 as const;
export const ROOM_PROVIDER_BACKPRESSURE_DELIVERY_GATE_DEFAULT_RETRY_AFTER_MS = 1_000;

/**
 * Public, durable-defer-safe vocabulary. Upstream port messages are never
 * exposed because callers can persist these values into the Room outbox.
 */
export type RoomProviderBackpressureDeliveryGateDeferReasonV1 =
  | "provider_admission_request_invalid"
  | "provider_admission_deadline_expired"
  | "room_worker_authority_unavailable"
  | "room_worker_authority_invalid"
  | "room_worker_authority_stale"
  | "provider_capability_registry_unavailable"
  | "provider_capability_registry_stale"
  | "provider_capability_identity_mismatch"
  | "provider_node_unavailable"
  | "provider_telemetry_unknown"
  | "provider_admission_unconfirmed"
  | "provider_telemetry_stale"
  | "provider_policy_unavailable"
  | "provider_durable_read_unavailable"
  | "provider_durable_snapshot_invalid"
  | "provider_scope_snapshot_mismatch"
  | "provider_telemetry_snapshot_mismatch"
  | "provider_policy_snapshot_mismatch"
  | "provider_capacity_deferred"
  | "provider_durable_commit_unavailable"
  | "provider_durable_reservation_invalid"
  | "provider_reservation_renewal_unavailable"
  | "provider_reservation_renewal_deferred"
  | "provider_reservation_cleanup_failed";

export interface RoomProviderBackpressureDeliveryGateDeferV1 {
  readonly contractVersion: typeof ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION;
  readonly action: "defer";
  readonly reason: RoomProviderBackpressureDeliveryGateDeferReasonV1;
  readonly retryAfterMs: number;
}

export interface RoomProviderBackpressureTrustedAdmissionSnapshotV1 {
  readonly contractVersion: typeof ROOM_PROVIDER_BACKPRESSURE_DELIVERY_GATE_CONTRACT_VERSION;
  readonly registryId: string;
  readonly registryRevision: number;
  readonly registryObservedAt: string;
  readonly capturedAt: string;
  readonly expiresAt: string;
  /** Must contain provider/account/model/connector and an explicit provider node. */
  readonly scope: RoomProviderBackpressureScopeV1;
  readonly telemetry: RoomProviderBackpressureTelemetryV1;
  readonly policy: RoomProviderBackpressurePolicyV1;
  readonly capability: RoomCapabilityRegistry.RoomBindingCapabilitySnapshotV1;
}

export type RoomProviderBackpressureTrustedAdmissionSnapshotResultV1 =
  | {
      readonly action: "ready";
      readonly snapshot: RoomProviderBackpressureTrustedAdmissionSnapshotV1;
    }
  | {
      readonly action: "defer";
      /** Internal only; the concrete gate maps this to its public vocabulary. */
      readonly reason: string;
      readonly retryAfterMs: number | null;
    };

/**
 * Injection boundary for a trusted capability/telemetry registry. It must
 * provide account, model, and provider-node directly; the gate never derives
 * any of them from a connector host or Room binding.
 */
export interface RoomProviderBackpressureTrustedAdmissionSnapshotPortV1 {
  read(input: {
    readonly contractVersion: typeof ROOM_PROVIDER_BACKPRESSURE_DELIVERY_GATE_CONTRACT_VERSION;
    readonly projectId: string;
    readonly roomId: string;
    readonly request: RoomProviderBackpressureSendGateRequestV1;
  }): Promise<RoomProviderBackpressureTrustedAdmissionSnapshotResultV1>;
}

export interface RoomProviderBackpressureRoomWorkerAuthorityV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly lease: StoredRoomLeaseV1;
  readonly expectedAggregateVersion: number;
}

export type RoomProviderBackpressureRoomWorkerAuthorityResultV1 =
  | {
      readonly action: "ready";
      readonly authority: RoomProviderBackpressureRoomWorkerAuthorityV1;
    }
  | {
      readonly action: "defer";
      /** Internal only; the concrete gate maps this to its public vocabulary. */
      readonly reason: string;
      readonly retryAfterMs: number | null;
    };

/** The only source for the fenced worker lease and Room aggregate version. */
export interface RoomProviderBackpressureRoomWorkerAuthorityResolverV1 {
  resolve(input: {
    readonly contractVersion: typeof ROOM_PROVIDER_BACKPRESSURE_DELIVERY_GATE_CONTRACT_VERSION;
    readonly phase: "admit" | "renew" | "release";
    readonly request: RoomProviderBackpressureSendGateRequestV1;
    readonly asOf: string;
    readonly reservationId?: string;
  }): Promise<RoomProviderBackpressureRoomWorkerAuthorityResultV1>;
}

export interface CreateRoomProviderBackpressureDeliveryGateInputV1 {
  readonly corePorts: Pick<RoomProviderBackpressurePostgresPortsV1, "read" | "commit" | "renew" | "release">;
  readonly trustedAdmissionSnapshot: RoomProviderBackpressureTrustedAdmissionSnapshotPortV1;
  readonly roomWorkerAuthority: RoomProviderBackpressureRoomWorkerAuthorityResolverV1;
}

/*
FNXC:CoreSenderFencedRecoveryIdentity 2026-07-21-01:16:
Only a gate created by this module can request the certified crash-recovery
path. A structural marker is diagnostic only: custom gates may expose the same
shape, but cannot acquire this module-private object identity.
*/
const coreSenderFencedRecoveryGates = new WeakSet<RoomProviderBackpressureSendGateV1>();

export function isCoreSenderFencedRecoveryGate(
  gate: RoomProviderBackpressureSendGateV1 | undefined,
): boolean {
  return gate !== undefined && coreSenderFencedRecoveryGates.has(gate);
}

/*
FNXC:RoomProviderBackpressureDeliveryGate 2026-07-19-20:42:
The Engine may authorize a Room connector send only after a trusted capability/
telemetry snapshot, an authoritative room-worker lease plus aggregate version,
and Core's durable reservation agree on one exact provider/account/model/
connector/provider-node scope. Provider-node is always an explicit trusted
scope value; it is never inferred from the connector host.
*/
export function createRoomProviderBackpressureDeliveryGate(
  input: CreateRoomProviderBackpressureDeliveryGateInputV1,
): RoomProviderBackpressureSendGateV1 {
  const gate: RoomProviderBackpressureSendGateV1 = Object.freeze({
    timeoutRecoveryProtocol: Object.freeze({
      contractVersion: ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION,
      kind: "core_sender_fenced_v1" as const,
    }),
    admit: async (request: RoomProviderBackpressureSendGateRequestV1) => {
      try {
        return await admit(input, request);
      } catch {
        return defer("provider_durable_read_unavailable");
      }
    },
  });
  coreSenderFencedRecoveryGates.add(gate);
  return gate;
}

async function admit(
  input: CreateRoomProviderBackpressureDeliveryGateInputV1,
  request: RoomProviderBackpressureSendGateRequestV1,
): Promise<RoomProviderBackpressureSendGateResultV1> {
  const requestFailure = admissionRequestFailure(request);
  if (requestFailure !== null) return defer(requestFailure);

  const authorityResult = await resolveAuthority(input, request, "admit", request.asOf);
  if (authorityResult === null) return defer("room_worker_authority_unavailable");
  if (authorityResult.action === "defer") {
    return defer("room_worker_authority_unavailable", authorityResult.retryAfterMs);
  }
  const authority = authorityResult.authority;
  const authorityFailure = roomWorkerAuthorityFailure(authority, request, request.asOf);
  if (authorityFailure !== null) return defer(authorityFailure);

  const snapshotResult = await readTrustedSnapshot(input, authority, request);
  if (snapshotResult === null) return defer("provider_capability_registry_unavailable");
  if (snapshotResult.action === "defer") {
    return defer("provider_capability_registry_unavailable", snapshotResult.retryAfterMs);
  }
  const snapshot = snapshotResult.snapshot;
  const snapshotFailure = trustedSnapshotFailure(snapshot, request, request.asOf);
  if (snapshotFailure !== null) return defer(snapshotFailure);

  const requestId = `room-provider-capacity:${request.delivery.id}:${request.attemptId}`;
  const durableSnapshot = await readDurableSnapshot(input, authority, requestId, request);
  if (durableSnapshot === null) return defer("provider_durable_read_unavailable");
  const durableFailure = durableSnapshotFailure(durableSnapshot, snapshot);
  if (durableFailure !== null) return defer(durableFailure);

  const decisionInput = {
    contractVersion: ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
    asOf: request.asOf,
    scope: durableSnapshot.scope,
    work: { requestId, class: "normal" as const, allowHalfOpenProbe: false },
    operation: { kind: "dispatch" as const },
    telemetry: durableSnapshot.telemetry,
    policy: durableSnapshot.policy,
    ...(durableSnapshot.state === undefined ? {} : { state: durableSnapshot.state }),
  };
  let decision;
  try {
    decision = decideRoomProviderBackpressure(decisionInput);
  } catch {
    return defer("provider_durable_snapshot_invalid");
  }

  const committed = await commitDurableReservation(input, authority, request, requestId, decisionInput, decision);
  if (committed === null) return defer("provider_durable_commit_unavailable");
  if (committed.status === "held") return defer("provider_capacity_deferred");
  if (committed.status !== "reserved" || !canonicalString(committed.reservationId)) {
    return defer("provider_durable_reservation_invalid");
  }

  return Object.freeze({
    contractVersion: ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION,
    action: "admit" as const,
    permit: createPermit(input, request, authority, snapshot, decision, requestId, committed.reservationId),
  });
}

function createPermit(
  input: CreateRoomProviderBackpressureDeliveryGateInputV1,
  request: RoomProviderBackpressureSendGateRequestV1,
  admittedWorkerAuthority: RoomProviderBackpressureRoomWorkerAuthorityV1,
  admittedSnapshot: RoomProviderBackpressureTrustedAdmissionSnapshotV1,
  decision: ReturnType<typeof decideRoomProviderBackpressure>,
  requestId: string,
  reservationId: string,
): RoomProviderBackpressureSendPermitV1 {
  const claimId = `${request.delivery.id}:${request.attemptId}`;
  let workerAuthority = admittedWorkerAuthority;
  let expiresAt = admittedWorkerAuthority.lease.expiresAt;
  let permitAuthority = createSendAuthority(admittedSnapshot, decision);
  let completion: RoomProviderBackpressureSendCompletionV1 | null = null;
  let releasePromise: Promise<RoomProviderBackpressureSendPermitCleanupResultV1> | null = null;

  const renew = async (
    renewal: RoomProviderBackpressureSendPermitRenewInputV1,
  ): Promise<RoomProviderBackpressureSendPermitRenewResultV1> => {
    if (completion !== null) return renewDeferred("provider_reservation_renewal_deferred");
    if (!renewalInputIsValid(renewal)) return renewDeferred("provider_reservation_renewal_deferred");

    const authorityResult = await resolveAuthority(input, request, "renew", renewal.asOf, reservationId);
    if (authorityResult === null || authorityResult.action === "defer") {
      return renewDeferred("room_worker_authority_unavailable", authorityResult?.retryAfterMs ?? null);
    }
    const renewedWorkerAuthority = authorityResult.authority;
    const authorityFailure = roomWorkerAuthorityFailure(renewedWorkerAuthority, request, renewal.asOf);
    if (authorityFailure !== null || !sameRoomWorkerFence(workerAuthority, renewedWorkerAuthority)) {
      return renewDeferred(authorityFailure ?? "room_worker_authority_stale");
    }

    const snapshotResult = await readTrustedSnapshot(input, renewedWorkerAuthority, request);
    if (snapshotResult === null || snapshotResult.action === "defer") {
      return renewDeferred("provider_capability_registry_unavailable", snapshotResult?.retryAfterMs ?? null);
    }
    const refreshedSnapshot = snapshotResult.snapshot;
    const snapshotFailure = trustedSnapshotFailure(refreshedSnapshot, request, renewal.asOf);
    if (snapshotFailure !== null || !sameProviderScope(refreshedSnapshot.scope, admittedSnapshot.scope)) {
      return renewDeferred(snapshotFailure ?? "provider_scope_snapshot_mismatch");
    }

    const renewed = await renewDurableReservation(input, renewedWorkerAuthority, {
      reservationId,
      claimId,
      operationId: renewal.operationId,
      asOf: renewal.asOf,
      expiresAt: renewedWorkerAuthority.lease.expiresAt,
    });
    if (renewed === null) return renewDeferred("provider_reservation_renewal_unavailable");
    if (renewed.status === "held") return renewDeferred("provider_reservation_renewal_deferred");
    if (
      renewed.status !== "renewed"
      || renewed.reservationId !== reservationId
      || !canonicalTimestamp(renewed.expiresAt)
      || renewed.expiresAt !== renewedWorkerAuthority.lease.expiresAt
    ) {
      return renewDeferred("provider_reservation_renewal_unavailable");
    }

    workerAuthority = renewedWorkerAuthority;
    expiresAt = renewed.expiresAt;
    permitAuthority = createSendAuthority(refreshedSnapshot, decision);
    return Object.freeze({ action: "renewed" as const, expiresAt, replayed: renewed.replayed });
  };

  const release = (
    nextCompletion: RoomProviderBackpressureSendCompletionV1,
  ): Promise<RoomProviderBackpressureSendPermitCleanupResultV1> => {
    completion ??= nextCompletion;
    if (releasePromise !== null) return releasePromise;
    const pending = releaseDurableReservation(
      input,
      request,
      workerAuthority,
      requestId,
      reservationId,
      claimId,
      completion,
    );
    const inFlight = pending.then(
      (result) => {
        if (result.action === "cleanup_failed" && releasePromise === inFlight) releasePromise = null;
        return result;
      },
      () => {
        if (releasePromise === inFlight) releasePromise = null;
        return cleanupFailed("provider_reservation_cleanup_failed");
      },
    );
    releasePromise = inFlight;
    return inFlight;
  };

  return Object.freeze({
    contractVersion: ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION,
    reservationId,
    requestId,
    requestBinding: request.requestBinding,
    requestHash: request.requestHash,
    get expiresAt() {
      return expiresAt;
    },
    get authority() {
      return permitAuthority;
    },
    get cleanupDescriptor() {
      return Object.freeze({
        claimId,
        originalWorkerFence: Object.freeze({
          leaseId: workerAuthority.lease.id,
          holderId: workerAuthority.lease.holderId,
          hostId: workerAuthority.lease.hostId,
          epoch: workerAuthority.lease.epoch,
        }),
        expectedAggregateVersion: workerAuthority.expectedAggregateVersion,
        reservationExpiresAt: expiresAt,
      });
    },
    renew,
    release,
    complete: release,
  });
}

async function releaseDurableReservation(
  input: CreateRoomProviderBackpressureDeliveryGateInputV1,
  request: RoomProviderBackpressureSendGateRequestV1,
  previousAuthority: RoomProviderBackpressureRoomWorkerAuthorityV1,
  requestId: string,
  reservationId: string,
  claimId: string,
  completion: RoomProviderBackpressureSendCompletionV1,
): Promise<RoomProviderBackpressureSendPermitCleanupResultV1> {
  if (!completionIsValid(completion)) return cleanupFailed("provider_reservation_cleanup_failed");

  const authorityResult = await resolveAuthority(
    input,
    request,
    "release",
    completion.completedAt,
    reservationId,
  );
  if (authorityResult === null || authorityResult.action === "defer") {
    return cleanupFailed("room_worker_authority_unavailable", authorityResult?.retryAfterMs ?? null);
  }
  const authority = authorityResult.authority;
  const authorityFailure = roomWorkerAuthorityFailure(authority, request, completion.completedAt);
  if (authorityFailure !== null || !sameRoomWorkerFence(previousAuthority, authority)) {
    return cleanupFailed(authorityFailure ?? "room_worker_authority_stale");
  }

  const outcome = completionToReleaseOutcome(completion);
  const released = await invokePort<void>(input as unknown, "corePorts", "release", {
    projectId: authority.projectId,
    roomId: authority.roomId,
    lease: authority.lease,
    expectedAggregateVersion: authority.expectedAggregateVersion,
    requestId,
    reservationId,
    claimId,
    outcome,
    releasedAt: completion.completedAt,
  });
  return released.ok ? Object.freeze({ action: "released" as const }) : cleanupFailed("provider_reservation_cleanup_failed");
}

function createSendAuthority(
  snapshot: RoomProviderBackpressureTrustedAdmissionSnapshotV1,
  decision: ReturnType<typeof decideRoomProviderBackpressure>,
) {
  return Object.freeze({
    scope: snapshot.scope,
    telemetry: snapshot.telemetry,
    policy: snapshot.policy,
    decision,
  });
}

async function resolveAuthority(
  input: CreateRoomProviderBackpressureDeliveryGateInputV1,
  request: RoomProviderBackpressureSendGateRequestV1,
  phase: "admit" | "renew" | "release",
  asOf: string,
  reservationId?: string,
): Promise<RoomProviderBackpressureRoomWorkerAuthorityResultV1 | null> {
  const result = await invokePort<RoomProviderBackpressureRoomWorkerAuthorityResultV1>(
    input as unknown,
    "roomWorkerAuthority",
    "resolve",
    {
      contractVersion: ROOM_PROVIDER_BACKPRESSURE_DELIVERY_GATE_CONTRACT_VERSION,
      phase,
      request,
      asOf,
      ...(reservationId === undefined ? {} : { reservationId }),
    },
  );
  if (!result.ok || !isRecord(result.value)) return null;
  if (result.value.action === "defer") {
    return Object.freeze({
      action: "defer" as const,
      reason: "internal",
      retryAfterMs: canonicalRetryAfterMs(result.value.retryAfterMs),
    });
  }
  if (result.value.action !== "ready" || !isRecord(result.value.authority)) return null;
  return Object.freeze({
    action: "ready" as const,
    authority: result.value.authority as RoomProviderBackpressureRoomWorkerAuthorityV1,
  });
}

async function readTrustedSnapshot(
  input: CreateRoomProviderBackpressureDeliveryGateInputV1,
  authority: RoomProviderBackpressureRoomWorkerAuthorityV1,
  request: RoomProviderBackpressureSendGateRequestV1,
): Promise<RoomProviderBackpressureTrustedAdmissionSnapshotResultV1 | null> {
  const result = await invokePort<RoomProviderBackpressureTrustedAdmissionSnapshotResultV1>(
    input as unknown,
    "trustedAdmissionSnapshot",
    "read",
    {
      contractVersion: ROOM_PROVIDER_BACKPRESSURE_DELIVERY_GATE_CONTRACT_VERSION,
      projectId: authority.projectId,
      roomId: authority.roomId,
      request,
    },
  );
  if (!result.ok || !isRecord(result.value)) return null;
  if (result.value.action === "defer") {
    return Object.freeze({
      action: "defer" as const,
      reason: "internal",
      retryAfterMs: canonicalRetryAfterMs(result.value.retryAfterMs),
    });
  }
  if (result.value.action !== "ready" || !isRecord(result.value.snapshot)) return null;
  return Object.freeze({
    action: "ready" as const,
    snapshot: result.value.snapshot as RoomProviderBackpressureTrustedAdmissionSnapshotV1,
  });
}

async function readDurableSnapshot(
  input: CreateRoomProviderBackpressureDeliveryGateInputV1,
  authority: RoomProviderBackpressureRoomWorkerAuthorityV1,
  requestId: string,
  request: RoomProviderBackpressureSendGateRequestV1,
): Promise<{ readonly scope: RoomProviderBackpressureScopeV1; readonly telemetry: RoomProviderBackpressureTelemetryV1; readonly policy: RoomProviderBackpressurePolicyV1; readonly state?: RoomProviderBackpressurePostgresStateV1 } | null> {
  const result = await invokePort<{
    readonly scope: RoomProviderBackpressureScopeV1;
    readonly telemetry: RoomProviderBackpressureTelemetryV1;
    readonly policy: RoomProviderBackpressurePolicyV1;
    readonly state?: RoomProviderBackpressurePostgresStateV1;
  }>(input as unknown, "corePorts", "read", {
    projectId: authority.projectId,
    roomId: authority.roomId,
    lease: authority.lease,
    expectedAggregateVersion: authority.expectedAggregateVersion,
    requestId,
    workClass: "normal",
    allowHalfOpenProbe: false,
    asOf: request.asOf,
  });
  return result.ok ? result.value : null;
}

async function commitDurableReservation(
  input: CreateRoomProviderBackpressureDeliveryGateInputV1,
  authority: RoomProviderBackpressureRoomWorkerAuthorityV1,
  request: RoomProviderBackpressureSendGateRequestV1,
  requestId: string,
  decisionInput: Parameters<typeof decideRoomProviderBackpressure>[0],
  decision: ReturnType<typeof decideRoomProviderBackpressure>,
): Promise<{ readonly status: "reserved"; readonly reservationId: string } | { readonly status: "held"; readonly reason: string } | null> {
  const result = await invokePort<{
    readonly status: "reserved";
    readonly reservationId: string;
  } | {
    readonly status: "held";
    readonly reason: string;
  }>(input as unknown, "corePorts", "commit", {
    projectId: authority.projectId,
    roomId: authority.roomId,
    lease: authority.lease,
    expectedAggregateVersion: authority.expectedAggregateVersion,
    senderFence: request.senderFence,
    requestId,
    idempotencyBindingHash: hashRoomProviderBackpressureAdmissionReplayBinding(
      createRoomProviderBackpressureAdmissionReplayBinding(request),
    ),
    decisionInput,
    decision,
  });
  return result.ok ? result.value : null;
}

async function renewDurableReservation(
  input: CreateRoomProviderBackpressureDeliveryGateInputV1,
  authority: RoomProviderBackpressureRoomWorkerAuthorityV1,
  renewal: {
    readonly reservationId: string;
    readonly claimId: string;
    readonly operationId: string;
    readonly asOf: string;
    readonly expiresAt: string;
  },
): Promise<{ readonly status: "renewed"; readonly reservationId: string; readonly expiresAt: string; readonly replayed: boolean } | { readonly status: "held"; readonly reason: string } | null> {
  const result = await invokePort<{
    readonly status: "renewed";
    readonly reservationId: string;
    readonly expiresAt: string;
    readonly replayed: boolean;
  } | {
    readonly status: "held";
    readonly reason: string;
  }>(input as unknown, "corePorts", "renew", {
    projectId: authority.projectId,
    roomId: authority.roomId,
    lease: authority.lease,
    expectedAggregateVersion: authority.expectedAggregateVersion,
    ...renewal,
  });
  return result.ok ? result.value : null;
}

async function invokePort<T>(
  root: unknown,
  ownerKey: string,
  method: string,
  argument: unknown,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false }> {
  if (!isRecord(root) || !isRecord(root[ownerKey]) || typeof root[ownerKey][method] !== "function") {
    return Object.freeze({ ok: false as const });
  }
  try {
    const owner = root[ownerKey];
    const value = await (owner[method] as (this: unknown, input: unknown) => Promise<T>).call(owner, argument);
    return Object.freeze({ ok: true as const, value });
  } catch {
    return Object.freeze({ ok: false as const });
  }
}

function defer(
  reason: RoomProviderBackpressureDeliveryGateDeferReasonV1,
  retryAfterMs: unknown = null,
): RoomProviderBackpressureDeliveryGateDeferV1 {
  return Object.freeze({
    contractVersion: ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION,
    action: "defer" as const,
    reason,
    retryAfterMs: canonicalRetryAfterMs(retryAfterMs),
  });
}

function renewDeferred(
  reason: Extract<
    RoomProviderBackpressureDeliveryGateDeferReasonV1,
    | "room_worker_authority_unavailable"
    | "room_worker_authority_invalid"
    | "room_worker_authority_stale"
    | "provider_capability_registry_unavailable"
    | "provider_capability_registry_stale"
    | "provider_capability_identity_mismatch"
    | "provider_node_unavailable"
    | "provider_telemetry_unknown"
    | "provider_admission_unconfirmed"
    | "provider_telemetry_stale"
    | "provider_policy_unavailable"
    | "provider_scope_snapshot_mismatch"
    | "provider_reservation_renewal_unavailable"
    | "provider_reservation_renewal_deferred"
  >,
  retryAfterMs: unknown = null,
): RoomProviderBackpressureSendPermitRenewResultV1 {
  return Object.freeze({ action: "defer" as const, reason, retryAfterMs: canonicalRetryAfterMs(retryAfterMs) });
}

function cleanupFailed(
  reason: Extract<
    RoomProviderBackpressureDeliveryGateDeferReasonV1,
    | "room_worker_authority_unavailable"
    | "room_worker_authority_invalid"
    | "room_worker_authority_stale"
    | "provider_reservation_cleanup_failed"
  >,
  retryAfterMs: unknown = null,
): RoomProviderBackpressureSendPermitCleanupResultV1 {
  return Object.freeze({ action: "cleanup_failed" as const, reason, retryAfterMs: canonicalRetryAfterMs(retryAfterMs) });
}

function canonicalRetryAfterMs(value: unknown): number {
  return nonNegativeSafeInteger(value)
    ? value
    : ROOM_PROVIDER_BACKPRESSURE_DELIVERY_GATE_DEFAULT_RETRY_AFTER_MS;
}

function admissionRequestFailure(
  request: RoomProviderBackpressureSendGateRequestV1,
): Extract<
  RoomProviderBackpressureDeliveryGateDeferReasonV1,
  "provider_admission_request_invalid" | "provider_admission_deadline_expired"
> | null {
  if (!isRecord(request)) return "provider_admission_request_invalid";
  if (
    request.contractVersion !== ROOM_PROVIDER_BACKPRESSURE_SEND_BOUNDARY_CONTRACT_VERSION
    || !isRecord(request.delivery)
    || !isRecord(request.binding)
    || !isRecord(request.identity)
    || !canonicalString(request.delivery.id)
    || !canonicalString(request.delivery.roomId)
    || !canonicalString(request.delivery.bindingId)
    || !canonicalString(request.binding.id)
    || !canonicalString(request.binding.roomId)
    || !canonicalString(request.binding.providerId)
    || !canonicalString(request.binding.connectorId)
    || !canonicalString(request.binding.nativeSessionId)
    || !canonicalString(request.binding.hostId)
    || !canonicalString(request.identity.providerId)
    || !canonicalString(request.identity.connectorId)
    || !canonicalString(request.identity.nativeSessionId)
    || !canonicalString(request.identity.hostId)
    || !canonicalString(request.attemptId)
    || !canonicalString(request.requestHash)
    || !canonicalTimestamp(request.asOf)
    || !canonicalTimestamp(request.deadline)
    || !isRecord(request.requestBinding)
    || !isAbortSignal(request.signal)
    || request.delivery.roomId !== request.binding.roomId
    || request.delivery.bindingId !== request.binding.id
    || request.binding.providerId !== request.identity.providerId
    || request.binding.connectorId !== request.identity.connectorId
    || request.binding.nativeSessionId !== request.identity.nativeSessionId
    || request.binding.hostId !== request.identity.hostId
  ) {
    return "provider_admission_request_invalid";
  }
  if (Date.parse(request.asOf) >= Date.parse(request.deadline) || request.signal.aborted) {
    return "provider_admission_deadline_expired";
  }
  try {
    const binding = createRoomProviderBackpressureSendRequestBinding(request);
    const requestHash = hashRoomProviderBackpressureSendRequestBinding(binding);
    if (request.requestHash !== requestHash || hashRoomProviderBackpressureSendRequestBinding(request.requestBinding) !== requestHash) {
      return "provider_admission_request_invalid";
    }
  } catch {
    return "provider_admission_request_invalid";
  }
  return null;
}

function roomWorkerAuthorityFailure(
  authority: RoomProviderBackpressureRoomWorkerAuthorityV1,
  request: RoomProviderBackpressureSendGateRequestV1,
  asOf: string,
): Extract<
  RoomProviderBackpressureDeliveryGateDeferReasonV1,
  "room_worker_authority_invalid" | "room_worker_authority_stale"
> | null {
  if (!isRecord(authority) || !isRecord(authority.lease)) return "room_worker_authority_invalid";
  const { lease } = authority;
  if (
    !canonicalString(authority.projectId)
    || authority.roomId !== request.delivery.roomId
    || authority.roomId !== request.binding.roomId
    || !nonNegativeSafeInteger(authority.expectedAggregateVersion)
    || lease.kind !== "room_worker"
    || !canonicalString(lease.id)
    || !canonicalString(lease.holderId)
    || !canonicalString(lease.hostId)
    || !positiveSafeInteger(lease.epoch)
    || lease.roomId !== authority.roomId
    || lease.resourceId !== authority.roomId
    || !canonicalTimestamp(lease.expiresAt)
    || (lease.releasedAt !== null && !canonicalTimestamp(lease.releasedAt))
  ) {
    return "room_worker_authority_invalid";
  }
  if (lease.releasedAt !== null || Date.parse(lease.expiresAt) <= Date.parse(asOf)) {
    return "room_worker_authority_stale";
  }
  return null;
}

function sameRoomWorkerFence(
  left: RoomProviderBackpressureRoomWorkerAuthorityV1,
  right: RoomProviderBackpressureRoomWorkerAuthorityV1,
): boolean {
  return left.projectId === right.projectId
    && left.roomId === right.roomId
    && left.expectedAggregateVersion === right.expectedAggregateVersion
    && left.lease.id === right.lease.id
    && left.lease.epoch === right.lease.epoch;
}

function trustedSnapshotFailure(
  snapshot: RoomProviderBackpressureTrustedAdmissionSnapshotV1,
  request: RoomProviderBackpressureSendGateRequestV1,
  asOf: string,
): Extract<
  RoomProviderBackpressureDeliveryGateDeferReasonV1,
  | "provider_capability_registry_unavailable"
  | "provider_capability_registry_stale"
  | "provider_capability_identity_mismatch"
  | "provider_node_unavailable"
  | "provider_telemetry_unknown"
  | "provider_admission_unconfirmed"
  | "provider_telemetry_stale"
  | "provider_policy_unavailable"
> | null {
  if (
    !isRecord(snapshot)
    || snapshot.contractVersion !== ROOM_PROVIDER_BACKPRESSURE_DELIVERY_GATE_CONTRACT_VERSION
    || !canonicalString(snapshot.registryId)
    || !nonNegativeSafeInteger(snapshot.registryRevision)
    || !canonicalTimestamp(snapshot.registryObservedAt)
    || !canonicalTimestamp(snapshot.capturedAt)
    || !canonicalTimestamp(snapshot.expiresAt)
    || !isProviderScopeWithoutNode(snapshot.scope)
  ) {
    return "provider_capability_registry_unavailable";
  }
  if (!canonicalString(snapshot.scope.nodeId)) return "provider_node_unavailable";
  if (
    Date.parse(snapshot.registryObservedAt) > Date.parse(asOf)
    || Date.parse(snapshot.capturedAt) > Date.parse(asOf)
    || Date.parse(snapshot.expiresAt) <= Date.parse(asOf)
  ) {
    return "provider_capability_registry_stale";
  }

  const capability = snapshot.capability;
  const lineage = capability?.lineage;
  if (
    !isRecord(capability)
    || capability.contractVersion !== 1
    || !canonicalString(capability.snapshotId)
    || !nonNegativeSafeInteger(capability.revision)
    || !canonicalString(capability.integrityHash)
    || !isRecord(lineage)
    || lineage.bindingId !== request.binding.id
    || lineage.bindingGeneration !== request.binding.generation
    || lineage.providerId !== request.binding.providerId
    || lineage.providerId !== request.identity.providerId
    || lineage.providerId !== snapshot.scope.providerId
    || lineage.accountId !== snapshot.scope.accountId
    || lineage.modelId !== snapshot.scope.modelId
    || lineage.connectorId !== request.binding.connectorId
    || lineage.connectorId !== request.identity.connectorId
    || lineage.connectorId !== snapshot.scope.connectorId
    || lineage.nativeSessionId !== request.binding.nativeSessionId
    || lineage.nativeSessionId !== request.identity.nativeSessionId
    || lineage.hostId !== request.binding.hostId
    || lineage.hostId !== request.identity.hostId
  ) {
    return "provider_capability_identity_mismatch";
  }
  if (
    !isRecord(capability.freshness)
    || !canonicalString(capability.freshness.sourceRevision)
    || !canonicalTimestamp(capability.freshness.capturedAt)
    || !canonicalTimestamp(capability.freshness.expiresAt)
    || Date.parse(capability.freshness.capturedAt) > Date.parse(asOf)
    || Date.parse(capability.freshness.expiresAt) <= Date.parse(asOf)
  ) {
    return "provider_capability_registry_stale";
  }
  if (!isProviderPolicy(snapshot.policy)) return "provider_policy_unavailable";
  if (!isProviderTelemetry(snapshot.telemetry) || !snapshot.telemetry.known) return "provider_telemetry_unknown";
  if (!snapshot.telemetry.admissionConfirmed) return "provider_admission_unconfirmed";
  if (
    Date.parse(snapshot.telemetry.observedAt) > Date.parse(asOf)
    || Date.parse(asOf) - Date.parse(snapshot.telemetry.observedAt) > snapshot.policy.telemetryTtlMs
  ) {
    return "provider_telemetry_stale";
  }
  return null;
}

function durableSnapshotFailure(
  durableSnapshot: { readonly scope: RoomProviderBackpressureScopeV1; readonly telemetry: RoomProviderBackpressureTelemetryV1; readonly policy: RoomProviderBackpressurePolicyV1; readonly state?: RoomProviderBackpressurePostgresStateV1 },
  trustedSnapshot: RoomProviderBackpressureTrustedAdmissionSnapshotV1,
): Extract<
  RoomProviderBackpressureDeliveryGateDeferReasonV1,
  | "provider_durable_snapshot_invalid"
  | "provider_scope_snapshot_mismatch"
  | "provider_telemetry_snapshot_mismatch"
  | "provider_policy_snapshot_mismatch"
> | null {
  if (
    !isRecord(durableSnapshot)
    || !isProviderScope(durableSnapshot.scope)
    || !isProviderTelemetry(durableSnapshot.telemetry)
    || !isProviderPolicy(durableSnapshot.policy)
  ) {
    return "provider_durable_snapshot_invalid";
  }
  if (!sameProviderScope(durableSnapshot.scope, trustedSnapshot.scope)) return "provider_scope_snapshot_mismatch";
  if (!sameProviderTelemetry(durableSnapshot.telemetry, trustedSnapshot.telemetry)) {
    return "provider_telemetry_snapshot_mismatch";
  }
  if (!sameProviderPolicy(durableSnapshot.policy, trustedSnapshot.policy)) {
    return "provider_policy_snapshot_mismatch";
  }
  return null;
}

function completionIsValid(completion: RoomProviderBackpressureSendCompletionV1): boolean {
  if (!isRecord(completion) || !canonicalTimestamp(completion.completedAt)) return false;
  if (completion.kind === "not_started" || completion.kind === "connector_exception") return true;
  return completion.kind === "connector_result"
    && (completion.outcome === "accepted" || completion.outcome === "confirmed" || completion.outcome === "delivery_uncertain" || completion.outcome === "rejected" || completion.outcome === "error")
    && (completion.connectorErrorCode === null || canonicalString(completion.connectorErrorCode))
    && (completion.retryAfterMs === null || nonNegativeSafeInteger(completion.retryAfterMs));
}

function completionToReleaseOutcome(
  completion: RoomProviderBackpressureSendCompletionV1,
): RoomProviderBackpressureReleaseOutcomeV1 {
  if (completion.kind === "not_started") return "pre_start_authority_lost";
  if (completion.kind === "connector_exception") return "worker_failed";
  if (completion.outcome === "accepted" || completion.outcome === "confirmed") return "worker_completed";
  if (completion.outcome === "error" && completion.retryAfterMs !== null) return "provider_backpressure";
  return "unknown";
}

function renewalInputIsValid(input: RoomProviderBackpressureSendPermitRenewInputV1): boolean {
  return isRecord(input) && canonicalTimestamp(input.asOf) && canonicalString(input.operationId);
}

function sameProviderScope(left: RoomProviderBackpressureScopeV1, right: RoomProviderBackpressureScopeV1): boolean {
  return left.providerId === right.providerId
    && left.accountId === right.accountId
    && left.modelId === right.modelId
    && left.connectorId === right.connectorId
    && left.nodeId === right.nodeId;
}

function sameProviderTelemetry(
  left: RoomProviderBackpressureTelemetryV1,
  right: RoomProviderBackpressureTelemetryV1,
): boolean {
  return left.known === right.known
    && left.observedAt === right.observedAt
    && left.admissionConfirmed === right.admissionConfirmed
    && left.activeRequests === right.activeRequests;
}

function sameProviderPolicy(
  left: RoomProviderBackpressurePolicyV1,
  right: RoomProviderBackpressurePolicyV1,
): boolean {
  return left.concurrencyCap === right.concurrencyCap
    && left.reservedVerifierSlots === right.reservedVerifierSlots
    && left.reservedRecoverySlots === right.reservedRecoverySlots
    && left.telemetryTtlMs === right.telemetryTtlMs
    && left.failureThreshold === right.failureThreshold
    && left.maxRetryAttempts === right.maxRetryAttempts
    && left.baseBackoffMs === right.baseBackoffMs
    && left.maxBackoffMs === right.maxBackoffMs
    && left.circuitOpenMs === right.circuitOpenMs;
}

function isProviderScope(value: unknown): value is RoomProviderBackpressureScopeV1 {
  return isRecord(value)
    && canonicalString(value.providerId)
    && canonicalString(value.accountId)
    && canonicalString(value.modelId)
    && canonicalString(value.connectorId)
    && canonicalString(value.nodeId);
}

function isProviderScopeWithoutNode(value: unknown): value is RoomProviderBackpressureScopeV1 {
  return isRecord(value)
    && canonicalString(value.providerId)
    && canonicalString(value.accountId)
    && canonicalString(value.modelId)
    && canonicalString(value.connectorId);
}

function isProviderTelemetry(value: unknown): value is RoomProviderBackpressureTelemetryV1 {
  return isRecord(value)
    && typeof value.known === "boolean"
    && typeof value.admissionConfirmed === "boolean"
    && nonNegativeSafeInteger(value.activeRequests)
    && canonicalTimestamp(value.observedAt);
}

function isProviderPolicy(value: unknown): value is RoomProviderBackpressurePolicyV1 {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return isRecord(value)
    && typeof value.aborted === "boolean"
    && typeof value.addEventListener === "function"
    && typeof value.removeEventListener === "function";
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

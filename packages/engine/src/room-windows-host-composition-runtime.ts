import {
  AsyncRoomLeaseStore,
  RoomCapabilityRegistry,
  createRoomProviderBackpressurePostgresPorts,
  type AsyncDataLayer,
  type AsyncRoomStore,
  type RoomAggregateV1,
  type RoomCapabilityRegistryProjectionV1,
  type RoomHostCompositionOperatorPolicyAuthorityRecordV1,
  type RoomProviderBackpressurePostgresSnapshotSourceV1,
} from "@fusion/core";

import {
  ROOM_PROVIDER_BACKPRESSURE_DELIVERY_GATE_CONTRACT_VERSION,
  type CreateRoomProviderBackpressureDeliveryGateInputV1,
  type RoomProviderBackpressureRoomWorkerAuthorityResolverV1,
  type RoomProviderBackpressureTrustedAdmissionSnapshotPortV1,
  type RoomProviderBackpressureTrustedAdmissionSnapshotV1,
} from "./room-provider-backpressure-delivery-gate.js";
import type {
  RoomProviderBackpressureSendGateRequestV1,
} from "./room-provider-backpressure-send-boundary.js";
import {
  governRoomCapacity,
  type RoomCapacityGovernorInputV1,
} from "./room-capacity-governor.js";
import type {
  RoomCapabilityRegistryRefreshVerifiedFactoryContext,
  RoomProviderBackpressureVerifiedFactoryContext,
  RoomTaskDispatchCapacityAdmissionVerifiedFactoryContext,
} from "./project-engine.js";
import type {
  RoomHostCompositionOperatorAdapterDependenciesV1,
} from "./room-host-composition-operator-policy-provider.js";
import type { RoomHostCompositionContextV1 } from "./room-host-composition.js";
import type {
  RoomTaskDispatchCapabilityRoutingPolicySource,
  RoomTaskDispatchCapacityAdmissionSource,
  RoomTaskDispatchCapacitySourceFailureCode,
  RoomTaskDispatchCapacitySourceFailureStage,
  RoomTaskDispatchCapacitySourceFailureV1,
} from "./room-dependency-dispatch-coordinator.js";

const WINDOWS_HOST_TELEMETRY_TTL_MS = 30_000;
const WINDOWS_HOST_MAX_FUTURE_SKEW_MS = 5_000;
const WINDOWS_HOST_PROVIDER_NODE_ID = "windows-happier-local-provider-node-v1";
const WINDOWS_HOST_SNAPSHOT_CACHE_LIMIT = 1_024;

type LeaseAuthorityStore = Pick<
  AsyncRoomLeaseStore,
  "getActiveLease" | "assertFence"
>;

export interface CreateWindowsNativeRoomHostCompositionDependenciesInputV1 {
  readonly authorityRecord: RoomHostCompositionOperatorPolicyAuthorityRecordV1;
  readonly roomContext: RoomHostCompositionContextV1;
  /**
   * Internal unit-test seam. The public Windows registry never exposes this
   * option and production always creates AsyncRoomLeaseStore over Core.
   */
  readonly createLeaseStore?: (
    layer: AsyncDataLayer,
    projectId: string,
  ) => LeaseAuthorityStore;
}

interface CachedAdmissionSnapshotV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly requestAsOf: string;
  readonly snapshot: RoomProviderBackpressureTrustedAdmissionSnapshotV1;
}

type TrustedAdmissionReadInput = Parameters<
  RoomProviderBackpressureTrustedAdmissionSnapshotPortV1["read"]
>[0];
type WorkerAuthorityResolveInput = Parameters<
  RoomProviderBackpressureRoomWorkerAuthorityResolverV1["resolve"]
>[0];
type ProviderSnapshotReadInput = Parameters<
  RoomProviderBackpressurePostgresSnapshotSourceV1["read"]
>[0];
type CapabilityRoutingPolicyRequest = Parameters<
  RoomTaskDispatchCapabilityRoutingPolicySource["getCapabilityRoutingPolicy"]
>[0];
type CapacityAdmissionRequest = Parameters<
  RoomTaskDispatchCapacityAdmissionSource["getCapacityGovernorInput"]
>[0];

function isCanonicalText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function deferReason(
  reasonCode: RoomTaskDispatchCapacitySourceFailureCode,
  stage: RoomTaskDispatchCapacitySourceFailureStage,
): RoomTaskDispatchCapacitySourceFailureV1 {
  return Object.freeze({
    state: "withheld" as const,
    reasonCode,
    stage,
  });
}

function createLeaseStore(
  input: CreateWindowsNativeRoomHostCompositionDependenciesInputV1,
  layer: AsyncDataLayer,
  projectId: string,
): LeaseAuthorityStore {
  return input.createLeaseStore?.(layer, projectId)
    ?? new AsyncRoomLeaseStore(layer, { projectId });
}

function assertFactoryContext(
  context:
    | RoomProviderBackpressureVerifiedFactoryContext
    | RoomCapabilityRegistryRefreshVerifiedFactoryContext
    | RoomTaskDispatchCapacityAdmissionVerifiedFactoryContext,
  expected: RoomHostCompositionContextV1,
): void {
  if (
    context.projectId !== expected.projectId
    || context.hostId !== expected.hostId
    || context.asyncLayer !== expected.asyncLayer
    || context.roomStore !== expected.roomStore
    || !isCanonicalText(context.workerId)
  ) {
    throw new Error("Windows Room host composition factory context does not match its verified runtime");
  }
}

function exactRoomBinding(
  room: RoomAggregateV1,
  request: RoomProviderBackpressureSendGateRequestV1,
): boolean {
  const binding = room.bindings.find((candidate) => candidate.id === request.binding.id);
  return binding !== undefined
    && binding.roomId === request.binding.roomId
    && binding.generation === request.binding.generation
    && binding.providerId === request.binding.providerId
    && binding.connectorId === request.binding.connectorId
    && binding.nativeSessionId === request.binding.nativeSessionId
    && binding.hostId === request.binding.hostId
    && binding.state === "attached";
}

function exactCapabilityProjection(
  projection: RoomCapabilityRegistryProjectionV1 | null,
  room: RoomAggregateV1,
): projection is RoomCapabilityRegistryProjectionV1 {
  if (
    projection === null
    || projection.projectId !== room.room.projectId
    || projection.roomId !== room.room.id
    || projection.aggregateVersion > room.room.aggregateVersion
  ) {
    return false;
  }
  const validated = RoomCapabilityRegistry.mergeRoomCapabilityRegistry({
    registryId: projection.registry.registryId,
    current: projection.registry,
    samples: [],
    asOf: projection.registry.observedAt,
    freshness: {
      maxSnapshotAgeMs: Number.MAX_SAFE_INTEGER,
      maxSignalAgeMs: Number.MAX_SAFE_INTEGER,
      maxFutureSkewMs: 0,
    },
  });
  return validated.ok
    && validated.value.registryId === projection.registry.registryId
    && validated.value.revision === projection.registry.revision
    && validated.value.integrityHash === projection.registry.integrityHash;
}

function capabilityForRequest(
  projection: RoomCapabilityRegistryProjectionV1,
  request: RoomProviderBackpressureSendGateRequestV1,
) {
  const candidates = projection.registry.bindings.filter((candidate) =>
    candidate.lineage.bindingId === request.binding.id
    && candidate.lineage.bindingGeneration === request.binding.generation
    && candidate.lineage.providerId === request.binding.providerId
    && candidate.lineage.connectorId === request.binding.connectorId
    && candidate.lineage.nativeSessionId === request.binding.nativeSessionId
    && candidate.lineage.hostId === request.binding.hostId
  );
  if (candidates.length !== 1) return null;
  const validated = RoomCapabilityRegistry.validateRoomBindingCapabilitySnapshot(
    candidates[0],
  );
  return validated.ok ? validated.value : null;
}

function minimumTimestamp(values: readonly string[]): string | null {
  if (!values.every(isCanonicalTimestamp)) return null;
  return values.reduce((minimum, candidate) =>
    Date.parse(candidate) < Date.parse(minimum) ? candidate : minimum
  );
}

function providerPolicy(slots: number) {
  return Object.freeze({
    concurrencyCap: slots,
    reservedVerifierSlots: 0,
    reservedRecoverySlots: 0,
    telemetryTtlMs: WINDOWS_HOST_TELEMETRY_TTL_MS,
    failureThreshold: 3,
    maxRetryAttempts: 5,
    baseBackoffMs: 1_000,
    maxBackoffMs: 30_000,
    circuitOpenMs: 60_000,
  });
}

function admissionRequestId(request: RoomProviderBackpressureSendGateRequestV1): string {
  return `room-provider-capacity:${request.delivery.id}:${request.attemptId}`;
}

function retainSnapshot(
  cache: Map<string, CachedAdmissionSnapshotV1>,
  requestId: string,
  value: CachedAdmissionSnapshotV1,
): void {
  cache.delete(requestId);
  cache.set(requestId, value);
  if (cache.size <= WINDOWS_HOST_SNAPSHOT_CACHE_LIMIT) return;
  const oldest = cache.keys().next().value;
  if (typeof oldest === "string") cache.delete(oldest);
}

function createTrustedAdmissionSnapshotPort(input: {
  readonly authorityRecord: RoomHostCompositionOperatorPolicyAuthorityRecordV1;
  readonly roomStore: AsyncRoomStore;
  readonly leaseStore: LeaseAuthorityStore;
  readonly cache: Map<string, CachedAdmissionSnapshotV1>;
}): RoomProviderBackpressureTrustedAdmissionSnapshotPortV1 {
  return Object.freeze({
    async read(requestInput: TrustedAdmissionReadInput) {
      const request = requestInput.request;
      const room = await input.roomStore.getRoom(requestInput.roomId);
      if (
        room === undefined
        || room.room.projectId !== requestInput.projectId
        || room.room.id !== requestInput.roomId
        || !exactRoomBinding(room, request)
      ) {
        return Object.freeze({
          action: "defer" as const,
          reason: "room_binding_unavailable",
          retryAfterMs: null,
        });
      }
      const projection = await input.roomStore.getRoomCapabilityRegistry(
        requestInput.roomId,
      );
      if (!exactCapabilityProjection(projection, room)) {
        return Object.freeze({
          action: "defer" as const,
          reason: "durable_capability_registry_unavailable",
          retryAfterMs: null,
        });
      }
      /*
       * FNXC:WindowsCapabilityRegistryFence 2026-07-27-06:57:
       * A replay-valid capability projection is not current authority by
       * itself. Require its recorded writer fence to match the active durable
       * Room-worker lease before provider lineage can enter admission.
       */
      const activeLease = await input.leaseStore.getActiveLease(
        "room_worker",
        requestInput.roomId,
      );
      if (
        activeLease === null
        || activeLease.kind !== "room_worker"
        || activeLease.roomId !== requestInput.roomId
        || activeLease.resourceId !== requestInput.roomId
        || projection.workerFence.leaseId !== activeLease.id
        || projection.workerFence.holderId !== activeLease.holderId
        || projection.workerFence.hostId !== activeLease.hostId
        || projection.workerFence.expectedEpoch !== activeLease.epoch
      ) {
        return Object.freeze({
          action: "defer" as const,
          reason: "durable_capability_registry_fence_mismatch",
          retryAfterMs: null,
        });
      }
      const capability = capabilityForRequest(projection, request);
      if (capability === null) {
        return Object.freeze({
          action: "defer" as const,
          reason: "durable_capability_identity_unavailable",
          retryAfterMs: null,
        });
      }
      if (
        capability.health.connectorState !== "healthy"
        || capability.health.hostState !== "healthy"
        || capability.rateLimit.state !== "clear"
      ) {
        return Object.freeze({
          action: "defer" as const,
          reason: "durable_capability_not_admissible",
          retryAfterMs: capability.rateLimit.retryAfterMs,
        });
      }
      /*
       * FNXC:WindowsProviderAdmissionFreshness 2026-07-27-06:53:
       * A fresh registry timestamp cannot renew an older health or rate-limit
       * signal. Bind the admission window to the oldest required durable
       * signal and reject it once the host telemetry TTL is exceeded.
       */
      const observedAt = minimumTimestamp([
        projection.registry.observedAt,
        capability.health.observedAt,
        capability.rateLimit.observedAt,
      ]);
      const localExpiry = isCanonicalTimestamp(request.asOf)
        ? new Date(Date.parse(request.asOf) + WINDOWS_HOST_TELEMETRY_TTL_MS).toISOString()
        : null;
      const expiresAt = localExpiry === null
        ? null
        : minimumTimestamp([
          input.authorityRecord.expiresAt,
          projection.registry.bindings
            .find((entry) => entry.lineage.bindingId === request.binding.id)!
            .freshness.expiresAt,
          localExpiry,
        ]);
      if (
        observedAt === null
        || expiresAt === null
        || Date.parse(observedAt) > Date.parse(request.asOf)
        || Date.parse(request.asOf) - Date.parse(observedAt)
          > WINDOWS_HOST_TELEMETRY_TTL_MS
        || Date.parse(expiresAt) <= Date.parse(request.asOf)
      ) {
        return Object.freeze({
          action: "defer" as const,
          reason: "durable_capability_registry_stale",
          retryAfterMs: null,
        });
      }

      /*
       * FNXC:WindowsHostLocalProviderAdmission 2026-07-27-06:30:
       * This scope is the fixed Windows/Happier adapter node, not the provider
       * fleet. The signed controller slots cap only sends traversing this
       * local node. Core merges telemetry.activeRequests with its durable
       * reservation count, so zero means no additional out-of-ledger local
       * requests are reported; it never claims a provider-global quota.
       */
      const snapshot: RoomProviderBackpressureTrustedAdmissionSnapshotV1 =
        Object.freeze({
          contractVersion:
            ROOM_PROVIDER_BACKPRESSURE_DELIVERY_GATE_CONTRACT_VERSION,
          registryId: projection.registry.registryId,
          registryRevision: projection.registry.revision,
          registryObservedAt: projection.registry.observedAt,
          capturedAt: request.asOf,
          expiresAt,
          scope: Object.freeze({
            providerId: capability.lineage.providerId,
            accountId: capability.lineage.accountId,
            modelId: capability.lineage.modelId,
            connectorId: capability.lineage.connectorId,
            nodeId: WINDOWS_HOST_PROVIDER_NODE_ID,
          }),
          telemetry: Object.freeze({
            known: true,
            observedAt,
            admissionConfirmed: true,
            activeRequests: 0,
          }),
          policy: providerPolicy(
            input.authorityRecord.policy.controllerAdmission.slots,
          ),
          capability,
        });
      retainSnapshot(input.cache, admissionRequestId(request), {
        projectId: requestInput.projectId,
        roomId: requestInput.roomId,
        requestAsOf: request.asOf,
        snapshot,
      });
      return Object.freeze({ action: "ready" as const, snapshot });
    },
  });
}

function createWorkerAuthorityResolver(input: {
  readonly projectId: string;
  readonly workerId: string;
  readonly hostId: string;
  readonly roomStore: AsyncRoomStore;
  readonly leaseStore: LeaseAuthorityStore;
}): RoomProviderBackpressureRoomWorkerAuthorityResolverV1 {
  return Object.freeze({
    async resolve(requestInput: WorkerAuthorityResolveInput) {
      try {
        const roomId = requestInput.request.delivery.roomId;
        const active = await input.leaseStore.getActiveLease(
          "room_worker",
          roomId,
        );
        if (
          active === null
          || active.holderId !== input.workerId
          || active.hostId !== input.hostId
          || active.roomId !== roomId
          || active.resourceId !== roomId
        ) {
          return Object.freeze({
            action: "defer" as const,
            reason: "room_worker_lease_unavailable",
            retryAfterMs: null,
          });
        }
        const lease = await input.leaseStore.assertFence({
          leaseId: active.id,
          roomId,
          kind: "room_worker",
          resourceId: roomId,
          holderId: input.workerId,
          hostId: input.hostId,
          expectedEpoch: active.epoch,
          now: requestInput.asOf,
        });
        const room = await input.roomStore.getRoom(roomId);
        if (
          room === undefined
          || room.room.projectId !== input.projectId
          || !exactRoomBinding(room, requestInput.request)
          || (requestInput.phase === "admit" && room.room.state !== "running")
        ) {
          return Object.freeze({
            action: "defer" as const,
            reason: "room_worker_room_snapshot_unavailable",
            retryAfterMs: null,
          });
        }
        /*
         * FNXC:WindowsRoomWorkerAuthority 2026-07-27-06:48:
         * The active-lease lookup and standalone fence check are discovery
         * evidence only. Revalidate that exact lease together with the Room
         * recovery posture and aggregate version in Core's transaction before
         * exposing worker authority to provider admission.
         */
        const durableAuthority = await input.roomStore.assertWorkerAuthority({
          roomId,
          lease,
          expectedAggregateVersion: room.room.aggregateVersion,
          now: requestInput.asOf,
        });
        return Object.freeze({
          action: "ready" as const,
          authority: Object.freeze({
            projectId: input.projectId,
            roomId,
            lease: durableAuthority.lease,
            expectedAggregateVersion:
              durableAuthority.posture.aggregateVersion,
          }),
        });
      } catch {
        return Object.freeze({
          action: "defer" as const,
          reason: "room_worker_authority_read_failed",
          retryAfterMs: null,
        });
      }
    },
  });
}

function createProviderBackpressureFactory(
  input: CreateWindowsNativeRoomHostCompositionDependenciesInputV1,
) {
  return (
    context: RoomProviderBackpressureVerifiedFactoryContext,
  ): CreateRoomProviderBackpressureDeliveryGateInputV1 => {
    assertFactoryContext(context, input.roomContext);
    const cache = new Map<string, CachedAdmissionSnapshotV1>();
    const leaseStore = createLeaseStore(
      input,
      context.asyncLayer,
      context.projectId,
    );
    const trustedAdmissionSnapshot = createTrustedAdmissionSnapshotPort({
      authorityRecord: input.authorityRecord,
      roomStore: context.roomStore,
      leaseStore,
      cache,
    });
    const snapshotSource: RoomProviderBackpressurePostgresSnapshotSourceV1 =
      Object.freeze({
        async read(readInput: ProviderSnapshotReadInput) {
          const cached = cache.get(readInput.requestId);
          if (
            cached === undefined
            || cached.projectId !== readInput.projectId
            || cached.roomId !== readInput.roomId
            || cached.requestAsOf !== readInput.asOf
          ) {
            throw new Error(
              "Windows Room provider admission snapshot is unavailable",
            );
          }
          return Object.freeze({
            scope: cached.snapshot.scope,
            telemetry: cached.snapshot.telemetry,
            policy: cached.snapshot.policy,
          });
        },
      });
    return Object.freeze({
      corePorts: createRoomProviderBackpressurePostgresPorts({
        layer: context.asyncLayer,
        snapshotSource,
        projectId: context.projectId,
      }),
      trustedAdmissionSnapshot,
      roomWorkerAuthority: createWorkerAuthorityResolver({
        projectId: context.projectId,
        workerId: context.workerId,
        hostId: context.hostId,
        roomStore: context.roomStore,
        leaseStore,
      }),
    });
  };
}

function runningNodeCount(
  graph: Parameters<
    RoomTaskDispatchCapabilityRoutingPolicySource["getCapabilityRoutingPolicy"]
  >[0]["graph"],
): number {
  return graph.nodes.filter((node) => node.state === "running").length;
}

function commonQualityDomain(
  projection: RoomCapabilityRegistryProjectionV1,
): string | null {
  const domains = projection.registry.bindings.map((binding) => {
    const calibrated = new Set(binding.calibration.map((entry) => entry.domain));
    return new Set(
      binding.domainQuality
        .map((entry) => entry.domain)
        .filter((domain) => calibrated.has(domain)),
    );
  });
  if (domains.length === 0) return null;
  const common = [...domains[0]].filter((domain) =>
    domains.every((candidate) => candidate.has(domain))
  ).sort();
  return common[0] ?? null;
}

function createCapabilityRoutingPolicySource(
  input: CreateWindowsNativeRoomHostCompositionDependenciesInputV1,
): RoomTaskDispatchCapabilityRoutingPolicySource {
  return Object.freeze({
    async getCapabilityRoutingPolicy(request: CapabilityRoutingPolicyRequest) {
      if (
        request.room.room.projectId !== input.roomContext.projectId
        || request.capabilityRegistry.projectId !== input.roomContext.projectId
        || request.capabilityRegistry.roomId !== request.room.room.id
        || !isCanonicalTimestamp(request.asOf)
      ) {
        return null;
      }
      const validated = RoomCapabilityRegistry.mergeRoomCapabilityRegistry({
        registryId: request.capabilityRegistry.registry.registryId,
        current: request.capabilityRegistry.registry,
        samples: [],
        asOf: request.capabilityRegistry.registry.observedAt,
        freshness: {
          maxSnapshotAgeMs: Number.MAX_SAFE_INTEGER,
          maxSignalAgeMs: Number.MAX_SAFE_INTEGER,
          maxFutureSkewMs: 0,
        },
      });
      const domain = commonQualityDomain(request.capabilityRegistry);
      if (!validated.ok || domain === null) return null;
      const activeDispatches = runningNodeCount(request.graph);
      const limits = new Map<string, {
        providerId: string;
        accountId: string;
        maxActiveDispatches: number;
        activeDispatches: number;
        retryAfterMs: null;
        checkedAt: string;
      }>();
      for (const binding of validated.value.bindings) {
        const activeBinding = request.room.bindings.find((candidate) =>
          candidate.id === binding.lineage.bindingId
          && candidate.generation === binding.lineage.bindingGeneration
          && candidate.state === "attached"
        );
        if (activeBinding === undefined) continue;
        const key = `${binding.lineage.providerId}\u0000${binding.lineage.accountId}`;
        limits.set(key, {
          providerId: binding.lineage.providerId,
          accountId: binding.lineage.accountId,
          maxActiveDispatches:
            input.authorityRecord.policy.controllerAdmission.slots,
          /*
           * This is a conservative host-wide durable running count, not a
           * provider-account global usage report. Counting it against every
           * local lineage can only withhold early; the governor performs the
           * exact local slot decision immediately afterwards.
           */
          activeDispatches,
          retryAfterMs: null,
          checkedAt: request.asOf,
        });
      }
      if (limits.size === 0) return null;
      return Object.freeze({
        freshness: Object.freeze({
          maxSnapshotAgeMs: WINDOWS_HOST_TELEMETRY_TTL_MS,
          maxSignalAgeMs: WINDOWS_HOST_TELEMETRY_TTL_MS,
          maxFutureSkewMs: WINDOWS_HOST_MAX_FUTURE_SKEW_MS,
        }),
        requirements: Object.freeze({
          requiredTools: Object.freeze([]),
          minimumAvailableContextTokens: 1,
          domain,
          minimumIndependentEvidence: 1,
          minimumCalibrationOutcomeCount: 1,
          minimumQualityScore: 0,
        }),
        providerLimits: Object.freeze(
          [...limits.values()].sort((left, right) => {
            const provider = left.providerId.localeCompare(right.providerId);
            return provider !== 0
              ? provider
              : left.accountId.localeCompare(right.accountId);
          }),
        ),
      });
    },
  });
}

function safeDecisionTimestamp(room: RoomAggregateV1, asOf: string): string {
  return isCanonicalTimestamp(room.room.updatedAt)
    && Date.parse(room.room.updatedAt) <= Date.parse(asOf)
    ? room.room.updatedAt
    : asOf;
}

function workKind(
  value: RoomHostCompositionOperatorPolicyAuthorityRecordV1["policy"]["controllerAdmission"]["workClass"],
): "producer" | "verifier" | "recovery" {
  if (value === "verifier") return "verifier";
  if (value === "recovery") return "recovery";
  return "producer";
}

function createCapacityAdmissionSource(
  input: CreateWindowsNativeRoomHostCompositionDependenciesInputV1,
): RoomTaskDispatchCapacityAdmissionSource {
  return Object.freeze({
    async getCapacityGovernorInput(request: CapacityAdmissionRequest) {
      try {
        if (
          request.room.room.projectId !== input.roomContext.projectId
          || request.capabilityRegistry.projectId !== input.roomContext.projectId
          || request.capabilityRegistry.roomId !== request.room.room.id
          || request.graph.roomId !== request.room.room.id
          || !isCanonicalTimestamp(request.asOf)
        ) {
          return deferReason(
            "capacity_request_invalid",
            "request_validation",
          );
        }
        if (
          request.capabilityRegistryProof.registryId
            !== request.capabilityRegistry.registry.registryId
          || request.capabilityRegistryProof.revision
            !== request.capabilityRegistry.registry.revision
          || request.capabilityRegistryProof.integrityHash
            !== request.capabilityRegistry.registry.integrityHash
        ) {
          return deferReason(
            "capacity_snapshot_invalid",
            "snapshot_validation",
          );
        }
        const nodeById = new Map(
          request.graph.nodes.map((node) => [node.id, node] as const),
        );
        const observedAt = safeDecisionTimestamp(request.room, request.asOf);
        const kind = workKind(
          input.authorityRecord.policy.controllerAdmission.workClass,
        );
        const queued = request.readyNodeIds.map((nodeId) => {
          const node = nodeById.get(nodeId);
          const qualityScore =
            request.capabilityQualityByReadyNodeId[nodeId];
          if (
            node === undefined
            || node.state !== "ready"
            || typeof qualityScore !== "number"
            || !Number.isFinite(qualityScore)
            || qualityScore < 0
            || qualityScore > 1
          ) {
            throw new Error("ready task telemetry is incomplete");
          }
          return Object.freeze({
            workId: nodeId,
            projectId: request.room.room.projectId,
            roomId: request.room.room.id,
            kind,
            qualityScore,
            criticalPathDistance: 0,
            projectPriority: 1,
            roomPriority: 1,
            enqueuedAt: observedAt,
            requiredSlots: 1,
          });
        });
        const active = request.graph.nodes
          .filter((node) => node.state === "running")
          .map((node) => Object.freeze({
            workId: node.id,
            projectId: request.room.room.projectId,
            roomId: request.room.room.id,
            kind,
            qualityScore: 0,
            criticalPathDistance: 0,
            projectPriority: 1,
            roomPriority: 1,
            enqueuedAt: observedAt,
            requiredSlots: 1,
            startedAt: observedAt,
            atTurnBoundary: false,
          }));
        const slots =
          input.authorityRecord.policy.controllerAdmission.slots;
        const failureCount = request.graph.nodes.filter(
          (node) => node.state === "failed",
        ).length;
        const governorInput: RoomCapacityGovernorInputV1 = Object.freeze({
          contractVersion: 1,
          asOf: request.asOf,
          policy: Object.freeze({
            telemetryTtlMs: WINDOWS_HOST_TELEMETRY_TTL_MS,
            maximumFailureRate: 1,
            maximumP95LatencyMs: 300_000,
            decreaseStepSlots: 1,
          }),
          scheduling: Object.freeze({
            asOf: request.asOf,
            capacity: Object.freeze({
              totalSlots: slots,
              reservedVerifierSlots: 0,
              reservedRecoverySlots: 0,
            }),
            policy: Object.freeze({
              minimumProjectReservations: Object.freeze([]),
              minimumRoomReservations: Object.freeze([]),
              fairnessAgingQuantumMs: 1_000,
              preemptionEnabled: false,
            }),
            queued: Object.freeze(queued),
            active: Object.freeze(active),
          }),
          telemetry: Object.freeze({
            sampledAt: request.asOf,
            queue: Object.freeze({
              source: "controller_observation" as const,
              queuedWorkCount: queued.length,
            }),
            running: Object.freeze({
              source: "controller_observation" as const,
              activeWorkCount: active.length,
              activeSlots: active.length,
            }),
            failures: Object.freeze({
              source: "controller_observation" as const,
              attemptCount: Math.max(1, request.graph.nodes.length),
              failureCount,
            }),
            latency: Object.freeze({
              source: "controller_observation" as const,
              sampleCount: 1,
              p95Ms: request.capabilityMinimumP95LatencyMs,
            }),
            /*
             * FNXC:WindowsHostLocalCapacityTelemetry 2026-07-27-06:30:
             * The hard limit is the signed local host ceiling. Connector
             * health comes from the exact durable capability-registry proof.
             * Neither field is labeled as provider-global quota telemetry.
             */
            quota: Object.freeze({
              source: "host_capacity_policy" as const,
              state: "clear" as const,
              hardConcurrencyLimit: slots,
              retryAfterMs: null,
            }),
            connector: Object.freeze({
              source: "durable_capability_registry" as const,
              state: "healthy" as const,
            }),
          }),
          capabilityRegistry: request.capabilityRegistryProof,
        });
        const validation = governRoomCapacity(governorInput);
        if (
          validation.issues.length > 0
          || validation.telemetry.state !== "fresh"
        ) {
          return deferReason(
            "capacity_governor_input_invalid",
            "governor_validation",
          );
        }
        return governorInput;
      } catch {
        return deferReason(
          "capacity_source_internal_error",
          "source_internal",
        );
      }
    },
  });
}

/*
FNXC:WindowsNativeRoomHostCompositionRuntime 2026-07-27-06:30:
The signed operator record selects only fixed host adapters and a local slot
ceiling. Live provider/account/model lineage comes exclusively from the
replay-checked Room capability registry; worker authority comes from the
active durable Room lease; Core owns reservations. No provider-global quota,
account identity, or node identity is inferred from labels or settings.
*/
export function createWindowsNativeRoomHostCompositionDependencies(
  input: CreateWindowsNativeRoomHostCompositionDependenciesInputV1,
): RoomHostCompositionOperatorAdapterDependenciesV1 {
  const providerBackpressureVerifiedFactory =
    createProviderBackpressureFactory(input);
  const capabilityRegistryRefreshVerifiedFactory = (
    context: RoomCapabilityRegistryRefreshVerifiedFactoryContext,
  ) => {
    assertFactoryContext(context, input.roomContext);
    return Object.freeze({
      reportFreshness: Object.freeze({
        maxObservationAgeMs: WINDOWS_HOST_TELEMETRY_TTL_MS,
        maxFutureSkewMs: WINDOWS_HOST_MAX_FUTURE_SKEW_MS,
      }),
      registryFreshness: Object.freeze({
        maxSnapshotAgeMs: WINDOWS_HOST_TELEMETRY_TTL_MS,
        maxSignalAgeMs: WINDOWS_HOST_TELEMETRY_TTL_MS,
        maxFutureSkewMs: WINDOWS_HOST_MAX_FUTURE_SKEW_MS,
      }),
    });
  };
  const taskDispatchCapacityAdmissionVerifiedFactory = (
    context: RoomTaskDispatchCapacityAdmissionVerifiedFactoryContext,
  ) => {
    assertFactoryContext(context, input.roomContext);
    return Object.freeze({
      capacityAdmissionSource: createCapacityAdmissionSource(input),
      capabilityRoutingPolicySource:
        createCapabilityRoutingPolicySource(input),
    });
  };
  return Object.freeze({
    providerBackpressureVerifiedFactory,
    capabilityRegistryRefreshVerifiedFactory,
    taskDispatchCapacityAdmissionVerifiedFactory,
  });
}

export const WINDOWS_NATIVE_ROOM_HOST_LOCAL_PROVIDER_NODE_ID =
  WINDOWS_HOST_PROVIDER_NODE_ID;

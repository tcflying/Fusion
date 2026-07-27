import {
  RoomCapabilityRegistry,
  hashRoomValue,
  type RoomAdaptiveSchedulingActiveWorkItemV1,
  type RoomAdaptiveSchedulingCapacityV1,
  type RoomAdaptiveSchedulingPolicyV1,
  type RoomAdaptiveSchedulingWorkItemV1,
  type RoomAggregateV1,
  type RoomCapabilityRegistryProjectionV1,
  type RoomTaskGraphProjectionV1,
  type RoomTaskNodeProjectionV1,
} from "@fusion/core";

import {
  ROOM_CAPACITY_GOVERNOR_CONTRACT_VERSION,
  governRoomCapacity,
  type RoomCapacityGovernorCapabilityRegistryProofV1,
  type RoomCapacityGovernorInputV1,
  type RoomCapacityGovernorPolicyV1,
  type RoomCapacityGovernorTelemetryV1,
} from "./room-capacity-governor.js";
import type {
  RoomTaskDispatchCapacityAdmissionSource,
  RoomTaskDispatchCapacitySourceFailureCode,
  RoomTaskDispatchCapacitySourceFailureStage,
  RoomTaskDispatchCapacitySourceFailureV1,
} from "./room-dependency-dispatch-coordinator.js";

export const ROOM_TASK_DISPATCH_CAPACITY_ADMISSION_POLICY_CONTRACT_VERSION = 1 as const;

export interface RoomTaskDispatchCapacityAdmissionPolicyProofPayloadV1 {
  readonly source: "verified_room_capacity_policy";
  readonly policyId: string;
  readonly revision: number;
  readonly observedAt: string;
  readonly expiresAt: string;
}

export interface RoomTaskDispatchCapacityAdmissionPolicyProofV1
  extends RoomTaskDispatchCapacityAdmissionPolicyProofPayloadV1 {
  readonly integrityHash: string;
}

/**
 * Policy arrives from an already-authorized configuration path. Its hash is
 * rechecked here so mutable DI cannot silently substitute a quota, scheduler,
 * or capability-routing policy between verification and admission.
 */
export interface VerifiedRoomTaskDispatchCapacityAdmissionPolicyV1 {
  readonly contractVersion: typeof ROOM_TASK_DISPATCH_CAPACITY_ADMISSION_POLICY_CONTRACT_VERSION;
  readonly proof: RoomTaskDispatchCapacityAdmissionPolicyProofV1;
  readonly governor: RoomCapacityGovernorPolicyV1;
  readonly scheduling: RoomAdaptiveSchedulingPolicyV1;
  readonly capabilityRouting: RoomCapabilityRegistry.RoomCapabilityRoutingPolicyV1;
}

export interface RoomTaskDispatchCapacityTelemetrySelectionV1 {
  readonly bindingId: string;
  readonly providerId: string;
  readonly modelId: string;
}

export interface RoomTaskDispatchCapacityTelemetryProofPayloadV1 {
  readonly source: "verified_session_connector_capacity_telemetry";
  readonly observationId: string;
  readonly bindingId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly sampledAt: string;
  readonly expiresAt: string;
}

export interface RoomTaskDispatchCapacityTelemetryProofV1
  extends RoomTaskDispatchCapacityTelemetryProofPayloadV1 {
  readonly integrityHash: string;
}

export interface RoomTaskDispatchCapacitySchedulingObservationV1 {
  readonly capacity: RoomAdaptiveSchedulingCapacityV1;
  readonly queued: readonly RoomAdaptiveSchedulingWorkItemV1[];
  readonly active: readonly RoomAdaptiveSchedulingActiveWorkItemV1[];
}

/**
 * The port owns collection and authentication of mutable controller/connector
 * observations. This source only accepts the integrity-bound result; it never
 * manufactures a provider quota, connector state, or capacity limit.
 */
export interface RoomTaskDispatchVerifiedCapacityTelemetryObservationV1 {
  readonly proof: RoomTaskDispatchCapacityTelemetryProofV1;
  readonly scheduling: RoomTaskDispatchCapacitySchedulingObservationV1;
  readonly telemetry: RoomCapacityGovernorTelemetryV1;
}

export interface RoomTaskDispatchCapacityTelemetryObservationRequestV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly asOf: string;
  readonly capabilityRegistryProof: RoomCapacityGovernorCapabilityRegistryProofV1;
  readonly selectedBinding: RoomTaskDispatchCapacityTelemetrySelectionV1;
}

export interface RoomTaskDispatchCapacityTelemetryObservationPort {
  observeVerifiedCapacityTelemetry(
    input: RoomTaskDispatchCapacityTelemetryObservationRequestV1
  ): Promise<RoomTaskDispatchVerifiedCapacityTelemetryObservationV1 | null>;
}

export interface CreateRoomTaskDispatchCapacityAdmissionSourceOptions {
  readonly policy: VerifiedRoomTaskDispatchCapacityAdmissionPolicyV1;
  readonly telemetryObservation: RoomTaskDispatchCapacityTelemetryObservationPort;
}

type CapacityAdmissionInputV1 = Parameters<
  RoomTaskDispatchCapacityAdmissionSource["getCapacityGovernorInput"]
>[0];

function capacitySourceFailure(
  reasonCode: RoomTaskDispatchCapacitySourceFailureCode,
  stage: RoomTaskDispatchCapacitySourceFailureStage
): RoomTaskDispatchCapacitySourceFailureV1 {
  return Object.freeze({
    state: "withheld",
    reasonCode,
    stage,
  });
}

interface SelectedCapabilityV1 {
  readonly recommendation: RoomCapabilityRegistry.RoomCapabilityRecommendationV1;
  readonly snapshot: RoomCapabilityRegistry.RoomBindingCapabilitySnapshotV1;
  readonly readyNodes: readonly RoomTaskNodeProjectionV1[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isUnitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function timestampsCover(asOf: string, observedAt: string, expiresAt: string): boolean {
  if (!isCanonicalTimestamp(asOf) || !isCanonicalTimestamp(observedAt) || !isCanonicalTimestamp(expiresAt)) {
    return false;
  }
  const asOfMs = Date.parse(asOf);
  return Date.parse(observedAt) <= asOfMs && asOfMs <= Date.parse(expiresAt);
}

function timestampsPrecede(asOf: string, createdAt: string, updatedAt: string): boolean {
  if (!isCanonicalTimestamp(asOf) || !isCanonicalTimestamp(createdAt) || !isCanonicalTimestamp(updatedAt)) {
    return false;
  }
  const createdAtMs = Date.parse(createdAt);
  const updatedAtMs = Date.parse(updatedAt);
  return createdAtMs <= updatedAtMs && updatedAtMs <= Date.parse(asOf);
}

function exactTextArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const values: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isCanonicalText(entry) || seen.has(entry)) return null;
    seen.add(entry);
    values.push(entry);
  }
  return values;
}

function cloneAndFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneAndFreeze(entry))) as T;
  }
  if (isRecord(value)) {
    const copy: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      copy[key] = cloneAndFreeze(entry);
    }
    return Object.freeze(copy) as T;
  }
  return value;
}

/**
 * Produces the deterministic policy payload hash that a verified-policy
 * producer must attach before this source will use it.
 */
export function hashRoomTaskDispatchCapacityAdmissionPolicy(input: {
  readonly contractVersion: typeof ROOM_TASK_DISPATCH_CAPACITY_ADMISSION_POLICY_CONTRACT_VERSION;
  readonly proof: RoomTaskDispatchCapacityAdmissionPolicyProofPayloadV1;
  readonly governor: RoomCapacityGovernorPolicyV1;
  readonly scheduling: RoomAdaptiveSchedulingPolicyV1;
  readonly capabilityRouting: RoomCapabilityRegistry.RoomCapabilityRoutingPolicyV1;
}): string {
  return hashRoomValue({
    contractVersion: input.contractVersion,
    proof: input.proof,
    governor: input.governor,
    scheduling: input.scheduling,
    capabilityRouting: input.capabilityRouting,
  });
}

/**
 * Produces the deterministic telemetry payload hash that the observation port
 * must have verified. The proof itself is included except for its hash.
 */
export function hashRoomTaskDispatchVerifiedTelemetryObservation(input: {
  readonly proof: RoomTaskDispatchCapacityTelemetryProofPayloadV1;
  readonly scheduling: RoomTaskDispatchCapacitySchedulingObservationV1;
  readonly telemetry: RoomCapacityGovernorTelemetryV1;
}): string {
  return hashRoomValue({
    proof: input.proof,
    scheduling: input.scheduling,
    telemetry: input.telemetry,
  });
}

function verifiedPolicy(
  value: unknown,
  asOf: string
): VerifiedRoomTaskDispatchCapacityAdmissionPolicyV1 | null {
  if (!isRecord(value) || value.contractVersion !== ROOM_TASK_DISPATCH_CAPACITY_ADMISSION_POLICY_CONTRACT_VERSION) {
    return null;
  }
  if (!isRecord(value.proof) || !isRecord(value.governor) || !isRecord(value.scheduling) || !isRecord(value.capabilityRouting)) {
    return null;
  }
  const proof = value.proof;
  if (
    proof.source !== "verified_room_capacity_policy" ||
    !isCanonicalText(proof.policyId) ||
    !isPositiveSafeInteger(proof.revision) ||
    !isCanonicalText(proof.integrityHash) ||
    !timestampsCover(asOf, proof.observedAt as string, proof.expiresAt as string)
  ) {
    return null;
  }
  const policy = value as unknown as VerifiedRoomTaskDispatchCapacityAdmissionPolicyV1;
  const expectedHash = hashRoomTaskDispatchCapacityAdmissionPolicy({
    contractVersion: policy.contractVersion,
    proof: {
      source: policy.proof.source,
      policyId: policy.proof.policyId,
      revision: policy.proof.revision,
      observedAt: policy.proof.observedAt,
      expiresAt: policy.proof.expiresAt,
    },
    governor: policy.governor,
    scheduling: policy.scheduling,
    capabilityRouting: policy.capabilityRouting,
  });
  return policy.proof.integrityHash === expectedHash ? policy : null;
}

function validRoomAndGraph(input: CapacityAdmissionInputV1): {
  readonly roomId: string;
  readonly projectId: string;
  readonly readyNodeIds: readonly string[];
  readonly readyNodes: readonly RoomTaskNodeProjectionV1[];
} | null {
  const room = input.room as unknown;
  const graph = input.graph as unknown;
  if (!isRecord(room) || !isRecord(room.room) || !isRecord(graph)) return null;
  const roomId = room.room.id;
  const projectId = room.room.projectId;
  if (!isCanonicalText(roomId) || !isCanonicalText(projectId) || graph.roomId !== roomId) return null;

  const readyNodeIds = exactTextArray(input.readyNodeIds);
  const graphReadyNodeIds = exactTextArray(graph.readyNodeIds);
  if (!readyNodeIds || readyNodeIds.length === 0 || !graphReadyNodeIds || !Array.isArray(graph.nodes)) return null;
  const graphReadySet = new Set(graphReadyNodeIds);
  const nodeById = new Map<string, RoomTaskNodeProjectionV1>();
  for (const node of graph.nodes) {
    if (!isRecord(node) || !isCanonicalText(node.id) || nodeById.has(node.id)) return null;
    nodeById.set(node.id, node as unknown as RoomTaskNodeProjectionV1);
  }
  const readyNodes: RoomTaskNodeProjectionV1[] = [];
  for (const nodeId of readyNodeIds) {
    const node = nodeById.get(nodeId);
    if (!node || node.state !== "ready" || !graphReadySet.has(nodeId)) return null;
    if (!exactTextArray(node.capabilityRequirements)) return null;
    readyNodes.push(node);
  }
  return { roomId, projectId, readyNodeIds, readyNodes };
}

function projectionMatchesRoom(
  value: unknown,
  room: RoomAggregateV1,
  asOf: string
): value is RoomCapabilityRegistryProjectionV1 {
  if (!isRecord(value) || !isRecord(room) || !isRecord(room.room)) return false;
  if (
    !isCanonicalText(value.id) ||
    value.projectId !== room.room.projectId ||
    value.roomId !== room.room.id ||
    !isNonNegativeSafeInteger(value.aggregateVersion) ||
    !isCanonicalText(value.sourceEventId) ||
    !timestampsPrecede(asOf, value.createdAt as string, value.updatedAt as string) ||
    !isRecord(value.workerFence) ||
    !isCanonicalText(value.workerFence.leaseId) ||
    !isCanonicalText(value.workerFence.holderId) ||
    !isCanonicalText(value.workerFence.hostId) ||
    !isPositiveSafeInteger(value.workerFence.expectedEpoch) ||
    !isRecord(value.registry)
  ) {
    return false;
  }
  return true;
}

function proofMatchesRegistry(
  proof: unknown,
  projection: RoomCapabilityRegistryProjectionV1,
  asOf: string
): proof is RoomCapacityGovernorCapabilityRegistryProofV1 {
  if (!isRecord(proof)) return false;
  return (
    proof.source === "durable_room_ledger" &&
    proof.registryId === projection.registry.registryId &&
    proof.revision === projection.registry.revision &&
    proof.integrityHash === projection.registry.integrityHash &&
    proof.observedAt === projection.registry.observedAt &&
    isCanonicalText(proof.registryId) &&
    isNonNegativeSafeInteger(proof.revision) &&
    isCanonicalText(proof.integrityHash) &&
    timestampsCover(asOf, proof.observedAt as string, proof.expiresAt as string)
  );
}

function activeRoomBindingMatchesSnapshot(
  room: RoomAggregateV1,
  snapshot: RoomCapabilityRegistry.RoomBindingCapabilitySnapshotV1
): boolean {
  const bindings = (room as unknown as { readonly bindings?: unknown }).bindings;
  if (!Array.isArray(bindings)) return false;
  const binding = bindings.find(
    (candidate) => isRecord(candidate) && candidate.id === snapshot.lineage.bindingId
  );
  return (
    isRecord(binding) &&
    binding.generation === snapshot.lineage.bindingGeneration &&
    binding.providerId === snapshot.lineage.providerId &&
    binding.connectorId === snapshot.lineage.connectorId &&
    binding.nativeSessionId === snapshot.lineage.nativeSessionId &&
    binding.hostId === snapshot.lineage.hostId
  );
}

function selectedCapability(
  input: CapacityAdmissionInputV1,
  policy: VerifiedRoomTaskDispatchCapacityAdmissionPolicyV1,
  roomAndGraph: NonNullable<ReturnType<typeof validRoomAndGraph>>
): SelectedCapabilityV1 | null {
  const projection = input.capabilityRegistry;
  if (!projectionMatchesRoom(projection, input.room, input.asOf)) return null;
  if (!proofMatchesRegistry(input.capabilityRegistryProof, projection, input.asOf)) return null;

  const registryValidation = RoomCapabilityRegistry.mergeRoomCapabilityRegistry({
    registryId: projection.registry.registryId,
    current: projection.registry,
    samples: [],
    asOf: input.asOf,
    freshness: policy.capabilityRouting.freshness,
  });
  if (!registryValidation.ok) return null;

  if (!Array.isArray(input.capabilityRecommendations) || input.capabilityRecommendations.length !== 1) {
    return null;
  }
  const recommendation = input.capabilityRecommendations[0] as unknown;
  if (
    !isRecord(recommendation) ||
    !isCanonicalText(recommendation.bindingId) ||
    !isCanonicalText(recommendation.providerId) ||
    !isCanonicalText(recommendation.modelId) ||
    !isUnitInterval(recommendation.qualityScore) ||
    !isNonNegativeFinite(recommendation.latencyP95Ms) ||
    !isNonNegativeSafeInteger(recommendation.availableContextTokens)
  ) {
    return null;
  }
  const typedRecommendation = recommendation as unknown as RoomCapabilityRegistry.RoomCapabilityRecommendationV1;
  const snapshots = projection.registry.bindings.filter(
    (snapshot) => snapshot.lineage.bindingId === typedRecommendation.bindingId
  );
  if (snapshots.length !== 1) return null;
  const snapshot = snapshots[0];
  if (
    snapshot.lineage.providerId !== typedRecommendation.providerId ||
    snapshot.lineage.modelId !== typedRecommendation.modelId ||
    snapshot.latency.p95Ms !== typedRecommendation.latencyP95Ms ||
    snapshot.context.availableTokens !== typedRecommendation.availableContextTokens ||
    input.capabilityRegistryProof.expiresAt !== snapshot.freshness.expiresAt ||
    !activeRoomBindingMatchesSnapshot(input.room, snapshot) ||
    input.capabilityMinimumP95LatencyMs !== typedRecommendation.latencyP95Ms ||
    !isNonNegativeFinite(input.capabilityMinimumP95LatencyMs)
  ) {
    return null;
  }

  const qualityByReadyNodeId = input.capabilityQualityByReadyNodeId as unknown;
  if (!isRecord(qualityByReadyNodeId)) return null;
  const qualityNodeIds = Object.keys(qualityByReadyNodeId).sort();
  const expectedNodeIds = [...roomAndGraph.readyNodeIds].sort();
  if (qualityNodeIds.length !== expectedNodeIds.length || qualityNodeIds.some((nodeId, index) => nodeId !== expectedNodeIds[index])) {
    return null;
  }
  for (const nodeId of expectedNodeIds) {
    if (qualityByReadyNodeId[nodeId] !== typedRecommendation.qualityScore) return null;
  }

  const requiredTools = [
    ...new Set([
      ...policy.capabilityRouting.requirements.requiredTools,
      ...roomAndGraph.readyNodes.flatMap((node) => node.capabilityRequirements),
    ]),
  ].sort();
  const eligibility = RoomCapabilityRegistry.evaluateRoomBindingCapability({
    snapshot,
    asOf: input.asOf,
    policy: {
      ...policy.capabilityRouting,
      requirements: {
        ...policy.capabilityRouting.requirements,
        requiredTools,
      },
    },
  });
  if (
    !eligibility.ok ||
    !eligibility.value.eligible ||
    eligibility.value.qualityScore === null ||
    eligibility.value.qualityScore !== typedRecommendation.qualityScore
  ) {
    return null;
  }
  return {
    recommendation: typedRecommendation,
    snapshot,
    readyNodes: roomAndGraph.readyNodes,
  };
}

function observationHasExactReadyQueue(
  scheduling: RoomTaskDispatchCapacitySchedulingObservationV1,
  roomAndGraph: NonNullable<ReturnType<typeof validRoomAndGraph>>,
  qualityScore: number,
  asOf: string
): boolean {
  if (!isRecord(scheduling) || !Array.isArray(scheduling.queued) || !Array.isArray(scheduling.active)) return false;
  const queuedById = new Map<string, RoomAdaptiveSchedulingWorkItemV1>();
  for (const work of scheduling.queued) {
    if (!isRecord(work) || !isCanonicalText(work.workId) || queuedById.has(work.workId)) return false;
    if (
      work.projectId !== roomAndGraph.projectId ||
      work.roomId !== roomAndGraph.roomId ||
      work.qualityScore !== qualityScore ||
      !isCanonicalTimestamp(work.enqueuedAt) ||
      Date.parse(work.enqueuedAt) > Date.parse(asOf)
    ) {
      return false;
    }
    queuedById.set(work.workId, work as unknown as RoomAdaptiveSchedulingWorkItemV1);
  }
  if (queuedById.size !== roomAndGraph.readyNodeIds.length) return false;
  return roomAndGraph.readyNodeIds.every((nodeId) => queuedById.has(nodeId));
}

function observationHasConsistentTelemetry(
  observation: RoomTaskDispatchVerifiedCapacityTelemetryObservationV1,
  selection: SelectedCapabilityV1,
  roomAndGraph: NonNullable<ReturnType<typeof validRoomAndGraph>>,
  policy: VerifiedRoomTaskDispatchCapacityAdmissionPolicyV1,
  asOf: string
): boolean {
  const raw = observation as unknown;
  if (!isRecord(raw) || !isRecord(raw.proof) || !isRecord(raw.scheduling) || !isRecord(raw.telemetry)) return false;
  const proof = raw.proof;
  if (
    proof.source !== "verified_session_connector_capacity_telemetry" ||
    !isCanonicalText(proof.observationId) ||
    !isCanonicalText(proof.integrityHash) ||
    proof.bindingId !== selection.recommendation.bindingId ||
    proof.providerId !== selection.recommendation.providerId ||
    proof.modelId !== selection.recommendation.modelId ||
    !timestampsCover(asOf, proof.sampledAt as string, proof.expiresAt as string)
  ) {
    return false;
  }
  const sampleAgeMs = Date.parse(asOf) - Date.parse(proof.sampledAt as string);
  if (sampleAgeMs < 0 || sampleAgeMs > policy.governor.telemetryTtlMs) return false;

  const typed = observation as RoomTaskDispatchVerifiedCapacityTelemetryObservationV1;
  const expectedHash = hashRoomTaskDispatchVerifiedTelemetryObservation({
    proof: {
      source: typed.proof.source,
      observationId: typed.proof.observationId,
      bindingId: typed.proof.bindingId,
      providerId: typed.proof.providerId,
      modelId: typed.proof.modelId,
      sampledAt: typed.proof.sampledAt,
      expiresAt: typed.proof.expiresAt,
    },
    scheduling: typed.scheduling,
    telemetry: typed.telemetry,
  });
  if (typed.proof.integrityHash !== expectedHash || typed.telemetry.sampledAt !== typed.proof.sampledAt) return false;
  if (!observationHasExactReadyQueue(typed.scheduling, roomAndGraph, selection.recommendation.qualityScore, asOf)) return false;

  const telemetry = typed.telemetry as unknown;
  if (!isRecord(telemetry) || !isRecord(telemetry.queue) || !isRecord(telemetry.running) || !isRecord(telemetry.latency) || !isRecord(telemetry.quota)) {
    return false;
  }
  const activeSlots = typed.scheduling.active.reduce((total, work) => total + work.requiredSlots, 0);
  if (
    telemetry.queue.queuedWorkCount !== typed.scheduling.queued.length ||
    telemetry.running.activeWorkCount !== typed.scheduling.active.length ||
    telemetry.running.activeSlots !== activeSlots ||
    typed.telemetry.latency.p95Ms < selection.recommendation.latencyP95Ms ||
    typed.telemetry.quota.state === "unknown"
  ) {
    return false;
  }
  const providerLimits = policy.capabilityRouting.providerLimits as unknown;
  if (!Array.isArray(providerLimits)) return false;
  const providerLimit = providerLimits.filter(
    (limit) =>
      isRecord(limit) &&
      limit.providerId === selection.snapshot.lineage.providerId &&
      limit.accountId === selection.snapshot.lineage.accountId &&
      isPositiveSafeInteger(limit.maxActiveDispatches)
  );
  return providerLimit.length === 1 && telemetry.quota.hardConcurrencyLimit === providerLimit[0].maxActiveDispatches;
}

/**
 * FNXC:SessionRoomCapacityAdmission 2026-07-19-23:45:
 * The coordinator already computes durable binding recommendations, per-node
 * quality, and a conservative p95 floor. This source may package those values
 * for the governor only after one current binding can be proven against the
 * Room ledger and an integrity-bound async observation. The current dispatch
 * contract has no ready-node-to-multiple-binding map, so mixed groups fail
 * closed instead of guessing a provider quota or connector health aggregate.
 */
export class VerifiedRoomTaskDispatchCapacityAdmissionSource
  implements RoomTaskDispatchCapacityAdmissionSource {
  private readonly policy: VerifiedRoomTaskDispatchCapacityAdmissionPolicyV1;
  private readonly telemetryObservation: RoomTaskDispatchCapacityTelemetryObservationPort;

  constructor(options: CreateRoomTaskDispatchCapacityAdmissionSourceOptions) {
    this.policy = options.policy;
    this.telemetryObservation = options.telemetryObservation;
  }

  async getCapacityGovernorInput(
    input: CapacityAdmissionInputV1
  ): Promise<
    RoomCapacityGovernorInputV1
    | RoomTaskDispatchCapacitySourceFailureV1
    | null
  > {
    try {
      return await this.getCapacityGovernorInputUnchecked(input);
    } catch {
      return capacitySourceFailure(
        "capacity_source_internal_error",
        "source_internal"
      );
    }
  }

  private async getCapacityGovernorInputUnchecked(
    input: CapacityAdmissionInputV1
  ): Promise<
    RoomCapacityGovernorInputV1
    | RoomTaskDispatchCapacitySourceFailureV1
  > {
    if (!isCanonicalTimestamp(input.asOf)) {
      return capacitySourceFailure(
        "capacity_request_invalid",
        "request_validation"
      );
    }
    const policy = verifiedPolicy(this.policy, input.asOf);
    if (!policy) {
      return capacitySourceFailure(
        "capacity_policy_unverified",
        "policy_validation"
      );
    }
    const roomAndGraph = validRoomAndGraph(input);
    if (!roomAndGraph) {
      return capacitySourceFailure(
        "capacity_snapshot_invalid",
        "snapshot_validation"
      );
    }
    const selection = selectedCapability(input, policy, roomAndGraph);
    if (!selection) {
      return capacitySourceFailure(
        "capacity_binding_selection_unavailable",
        "binding_selection"
      );
    }

    let observation: RoomTaskDispatchVerifiedCapacityTelemetryObservationV1 | null;
    try {
      observation = await this.telemetryObservation.observeVerifiedCapacityTelemetry({
        projectId: roomAndGraph.projectId,
        roomId: roomAndGraph.roomId,
        asOf: input.asOf,
        capabilityRegistryProof: input.capabilityRegistryProof,
        selectedBinding: {
          bindingId: selection.recommendation.bindingId,
          providerId: selection.recommendation.providerId,
          modelId: selection.recommendation.modelId,
        },
      });
    } catch {
      return capacitySourceFailure(
        "capacity_telemetry_observer_failed",
        "telemetry_observation"
      );
    }
    if (!observation) {
      return capacitySourceFailure(
        "capacity_telemetry_missing",
        "telemetry_observation"
      );
    }
    if (!observationHasConsistentTelemetry(observation, selection, roomAndGraph, policy, input.asOf)) {
      return capacitySourceFailure(
        "capacity_telemetry_invalid",
        "telemetry_validation"
      );
    }

    const governorInput: RoomCapacityGovernorInputV1 = {
      contractVersion: ROOM_CAPACITY_GOVERNOR_CONTRACT_VERSION,
      asOf: input.asOf,
      policy: policy.governor,
      scheduling: {
        asOf: input.asOf,
        capacity: observation.scheduling.capacity,
        policy: policy.scheduling,
        queued: observation.scheduling.queued,
        active: observation.scheduling.active,
      },
      telemetry: observation.telemetry,
      capabilityRegistry: input.capabilityRegistryProof,
    };
    const validation = governRoomCapacity(governorInput);
    if (validation.issues.length > 0 || validation.telemetry.state !== "fresh") {
      return capacitySourceFailure(
        "capacity_governor_input_invalid",
        "governor_validation"
      );
    }
    return cloneAndFreeze(governorInput);
  }
}

export function createRoomTaskDispatchCapacityAdmissionSource(
  options: CreateRoomTaskDispatchCapacityAdmissionSourceOptions
): RoomTaskDispatchCapacityAdmissionSource {
  return new VerifiedRoomTaskDispatchCapacityAdmissionSource(options);
}

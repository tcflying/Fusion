import {
  RoomCapabilityRegistry,
  hashRoomValue,
  type ClaimReadyRoomTaskDispatchInputV1,
  type ClaimReadyRoomTaskDispatchResultV1,
  type RoomAggregateV1,
  type RoomCapabilityRegistryProjectionV1,
  type RoomRoleAssignmentProjectionV1,
  type RoomTaskGraphProjectionV1,
  type RoomTaskNodeProjectionV1,
  type StoredRoomLeaseV1,
  resolveRoomTaskRoleAssignment,
} from "@fusion/core";

import {
  governRoomCapacity,
  type RoomCapacityGovernorCapabilityRegistryProofV1,
  type RoomCapacityGovernorDecisionV1,
  type RoomCapacityGovernorInputV1,
  type RoomCapacityGovernorReasonCode,
} from "./room-capacity-governor.js";
import { planRoomDependencyDispatch } from "./room-dependency-dispatch.js";

const MAX_SNAPSHOT_CONFLICT_RETRIES = 16;

export interface RoomTaskDispatchStore {
  getRoom(roomId: string): Promise<RoomAggregateV1 | undefined>;
  getTaskGraph(roomId: string): Promise<RoomTaskGraphProjectionV1 | null>;
  getActiveRoomRoleAssignment(
    roomId: string
  ): Promise<RoomRoleAssignmentProjectionV1 | null>;
  /**
   * Present on the canonical durable AsyncRoomStore. Legacy test-only stores
   * without a Room capability ledger retain their established direct-dispatch
   * semantics until they opt into durable Room capacity control.
   */
  getRoomCapabilityRegistry?(
    roomId: string
  ): Promise<RoomCapabilityRegistryProjectionV1 | null>;
  claimReadyTaskDispatch(
    input: ClaimReadyRoomTaskDispatchInputV1
  ): Promise<ClaimReadyRoomTaskDispatchResultV1>;
}

export interface RoomTaskDispatchCapacityAdmissionSource {
  /**
   * Supplies one complete, certified scheduling and telemetry snapshot. The
   * coordinator deliberately cannot infer quota or connector health from task
   * state, so `null` is a visible fail-closed result rather than a fallback.
   */
  getCapacityGovernorInput(input: {
    readonly room: RoomAggregateV1;
    readonly graph: RoomTaskGraphProjectionV1;
    readonly readyNodeIds: readonly string[];
    readonly asOf: string;
    /** Immutable, replay-checked current report; never synthesize from provider labels. */
    readonly capabilityRegistry: RoomCapabilityRegistryProjectionV1;
    /** Exact proof the governor input must echo before a durable claim may start. */
    readonly capabilityRegistryProof: RoomCapacityGovernorCapabilityRegistryProofV1;
    /** Quality-first, per-binding results computed from the durable registry. */
    readonly capabilityRecommendations: readonly RoomCapabilityRegistry.RoomCapabilityRecommendationV1[];
    /** Exact dynamic quality score each admitted-ready node must carry into Core scheduling. */
    readonly capabilityQualityByReadyNodeId: Readonly<Record<string, number>>;
    /**
     * Conservative p95 floor from the selected durable binding reports. The
     * controller telemetry sent to the governor must never claim a lower p95.
     */
    readonly capabilityMinimumP95LatencyMs: number;
  }): Promise<
    RoomCapacityGovernorInputV1
    | RoomTaskDispatchCapacitySourceFailureV1
    | null
  >;
}

/*
FNXC:WindowsHostLocalCapacityPolicy 2026-07-27-06:30:
A signed Windows host ceiling is not a provider-global quota. Production may
therefore resolve a routing policy only after reading the exact durable
capability-registry revision and task graph used by this dispatch decision.
The source may publish conservative host-local limits for those concrete
provider/account lineages; absence, ambiguity, or failure remains withheld.
*/
export interface RoomTaskDispatchCapabilityRoutingPolicySource {
  getCapabilityRoutingPolicy(input: {
    readonly room: RoomAggregateV1;
    readonly graph: RoomTaskGraphProjectionV1;
    readonly capabilityRegistry: RoomCapabilityRegistryProjectionV1;
    readonly asOf: string;
  }): Promise<RoomCapabilityRegistry.RoomCapabilityRoutingPolicyV1 | null>;
}

export type RoomTaskDispatchCapacitySourceFailureCode =
  | "capacity_binding_selection_unavailable"
  | "capacity_governor_input_invalid"
  | "capacity_policy_unverified"
  | "capacity_request_invalid"
  | "capacity_snapshot_invalid"
  | "capacity_source_internal_error"
  | "capacity_telemetry_invalid"
  | "capacity_telemetry_missing"
  | "capacity_telemetry_observer_failed";

export type RoomTaskDispatchCapacitySourceFailureStage =
  | "binding_selection"
  | "governor_validation"
  | "policy_validation"
  | "request_validation"
  | "snapshot_validation"
  | "source_internal"
  | "telemetry_observation"
  | "telemetry_validation";

export interface RoomTaskDispatchCapacitySourceFailureV1 {
  readonly state: "withheld";
  readonly reasonCode: RoomTaskDispatchCapacitySourceFailureCode;
  readonly stage: RoomTaskDispatchCapacitySourceFailureStage;
}

export type RoomTaskDispatchCapacityReasonCode =
  | RoomCapacityGovernorReasonCode
  | RoomTaskDispatchCapacitySourceFailureCode
  | "capacity_admission_unconfigured"
  | "capacity_binding_ineligible"
  | "capacity_capability_policy_unconfigured"
  | "capacity_capability_registry_mismatch"
  | "capacity_capability_registry_unavailable"
  | "capacity_ready_tasks_not_admitted"
  | "capacity_ready_tasks_capability_mismatch"
  | "capacity_ready_tasks_latency_mismatch"
  | "capacity_ready_tasks_snapshot_incomplete"
  | "capacity_telemetry_unavailable";

export interface RoomTaskDispatchCapacityAdmissionV1 {
  readonly state: "admitted" | "withheld";
  readonly requestedNodeIds: readonly string[];
  readonly admittedNodeIds: readonly string[];
  /**
   * Preserves both the governor's refusal code and dispatch-specific snapshot
   * mismatch codes so observability never turns a capacity hold into silence.
   */
  readonly reasonCodes: readonly RoomTaskDispatchCapacityReasonCode[];
  readonly decision: RoomCapacityGovernorDecisionV1 | null;
  /** Typed and message-free source detail suitable for audit/metric projection. */
  readonly diagnostic?: RoomTaskDispatchCapacitySourceFailureV1;
}

const CAPACITY_SOURCE_FAILURE_CODES =
  new Set<RoomTaskDispatchCapacitySourceFailureCode>([
    "capacity_binding_selection_unavailable",
    "capacity_governor_input_invalid",
    "capacity_policy_unverified",
    "capacity_request_invalid",
    "capacity_snapshot_invalid",
    "capacity_source_internal_error",
    "capacity_telemetry_invalid",
    "capacity_telemetry_missing",
    "capacity_telemetry_observer_failed",
  ]);

const CAPACITY_SOURCE_FAILURE_STAGES =
  new Set<RoomTaskDispatchCapacitySourceFailureStage>([
    "binding_selection",
    "governor_validation",
    "policy_validation",
    "request_validation",
    "snapshot_validation",
    "source_internal",
    "telemetry_observation",
    "telemetry_validation",
  ]);

function isCapacitySourceFailure(
  value: unknown
): value is RoomTaskDispatchCapacitySourceFailureV1 {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RoomTaskDispatchCapacitySourceFailureV1>;
  return candidate.state === "withheld"
    && typeof candidate.reasonCode === "string"
    && CAPACITY_SOURCE_FAILURE_CODES.has(candidate.reasonCode as RoomTaskDispatchCapacitySourceFailureCode)
    && typeof candidate.stage === "string"
    && CAPACITY_SOURCE_FAILURE_STAGES.has(candidate.stage as RoomTaskDispatchCapacitySourceFailureStage);
}

export interface RoomDependencyDispatchCoordinatorOptions {
  readonly projectId: string;
  readonly workerId: string;
  readonly hostId: string;
  readonly store: RoomTaskDispatchStore;
  /**
   * FNXC:SessionRoomCapacityAdmission 2026-07-19-22:01:
   * OpenSpec 6.1-6.6 forbids ready work from silently bypassing capacity policy
   * when the host has not supplied a certified admission source. Keep the seam
   * optional for construction compatibility, but treat its absence as a durable,
   * visible dispatch hold rather than a fallback to unbounded local scheduling.
   */
  readonly capacityAdmissionSource?: RoomTaskDispatchCapacityAdmissionSource;
  /**
   * OpenSpec 6.1/6.3 routing policy used to evaluate immutable capability
   * reports before their scores can enter Core's quality-first scheduler.
   */
  readonly capabilityRoutingPolicy?: RoomCapabilityRegistry.RoomCapabilityRoutingPolicyV1;
  /**
   * Durable-snapshot-aware alternative to a static routing policy. Supplying
   * both authorities is ambiguous and fails closed.
   */
  readonly capabilityRoutingPolicySource?: RoomTaskDispatchCapabilityRoutingPolicySource;
  readonly now?: () => string;
}

export interface DispatchReadyRoomTasksInput {
  readonly room: RoomAggregateV1;
  readonly lease: StoredRoomLeaseV1;
  /**
   * Every durable claim renews its Room-worker fence immediately before the
   * mutation. The controller owns the actual store call, so the coordinator
   * cannot accidentally extend an unrelated lease.
   */
  readonly renewLease: (lease: StoredRoomLeaseV1) => Promise<StoredRoomLeaseV1>;
  /**
   * Controller lifecycle guard. It is checked before every durable mutation so
   * a stopping controller does not continue filling the outbox after its
   * current Room operation has been cancelled.
   */
  readonly canContinue?: () => boolean;
}

export interface DispatchReadyRoomTasksResult {
  readonly room: RoomAggregateV1;
  /** The last fence returned by `renewLease`, safe for the worker handoff. */
  readonly lease: StoredRoomLeaseV1;
  readonly claimedNodeIds: readonly string[];
  readonly skippedNodeIds: readonly string[];
  /** Every configured capacity decision, including explicit fail-closed holds. */
  readonly capacityAdmissions: readonly RoomTaskDispatchCapacityAdmissionV1[];
}

export class RoomDependencyDispatchCoordinatorError extends Error {
  readonly code:
    | "room_task_dispatch_replan_exhausted"
    | "room_task_dispatch_invalid_worker_lease";

  constructor(
    code: RoomDependencyDispatchCoordinatorError["code"],
    message: string
  ) {
    super(message);
    this.name = "RoomDependencyDispatchCoordinatorError";
    this.code = code;
  }
}

/**
 * FNXC:SessionRoomDependencyDispatch 2026-07-19-00:18:
 * The controller claims all presently independent work before it starts its
 * fixed-version recovery worker. Each claim is still individually fenced and
 * CAS-protected, but every fresh graph read marks the owning bindings busy so
 * one native Session receives at most one newly-started node per controller
 * pass. An ambiguous multi-seat assignment is deliberately not resolved by an
 * arbitrary choice; Task 5.5 owns that capability-aware policy. The durable
 * recovery worker remains the only sender of outbox rows.
 *
 * FNXC:SessionRoomCapacityAdmission 2026-07-19-12:02:
 * Task 6.3 requires ready-task claims to stop when trusted telemetry, quota,
 * or connector availability is missing. The DI source supplies the complete
 * certified snapshot; this coordinator calls the existing governor policy and
 * records its reason rather than deriving capacity from local task state. For
 * the canonical durable store, a missing source is an explicit fail-closed
 * hold; legacy test-only stores without a capability ledger keep their existing
 * direct-dispatch compatibility behavior.
 */
export class RoomDependencyDispatchCoordinator {
  private readonly now: () => string;

  constructor(
    private readonly options: RoomDependencyDispatchCoordinatorOptions
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async dispatchReadyTasks(
    input: DispatchReadyRoomTasksInput
  ): Promise<DispatchReadyRoomTasksResult> {
    this.assertWorkerLease(input.room.room.id, input.lease);

    let latestRoom = input.room;
    let activeLease = input.lease;
    let snapshotConflictRetries = 0;
    const claimedNodeIds: string[] = [];
    const skippedNodeIds = new Set<string>();
    const capacityAdmissions: RoomTaskDispatchCapacityAdmissionV1[] = [];

    while (input.canContinue?.() ?? true) {
      const [room, graph, activeRoleAssignment] = await Promise.all([
        this.options.store.getRoom(input.room.room.id),
        this.options.store.getTaskGraph(input.room.room.id),
        this.options.store.getActiveRoomRoleAssignment(input.room.room.id),
      ]);
      if (!room) {
        throw new RoomDependencyDispatchCoordinatorError(
          "room_task_dispatch_replan_exhausted",
          `Room ${input.room.room.id} disappeared while planning task dispatch`
        );
      }
      latestRoom = room;
      if (
        room.room.state !== "running" ||
        !graph ||
        !(input.canContinue?.() ?? true)
      ) {
        break;
      }
      if (
        graph.roomId !== room.room.id ||
        graph.aggregateVersion !== room.room.aggregateVersion
      ) {
        snapshotConflictRetries = this.advanceSnapshotConflictRetries(
          snapshotConflictRetries,
          room.room.id
        );
        continue;
      }

      const plan = planRoomDependencyDispatch(graph);
      const nodeById = new Map(
        graph.nodes.map((node) => [node.id, node] as const)
      );
      const readyNodeIds = plan.readyCandidates.map(
        (candidate) => candidate.nodeId
      );
      if (readyNodeIds.length === 0) break;
      const occupiedSeatIds = occupiedSeats(room, graph, activeRoleAssignment);
      const capacityAdmission = await this.resolveCapacityAdmission({
        room,
        graph,
        readyNodeIds,
        activeRoleAssignment,
        occupiedSeatIds,
      });
      if (capacityAdmission) {
        capacityAdmissions.push(capacityAdmission);
        if (capacityAdmission.admittedNodeIds.length === 0) {
          for (const nodeId of readyNodeIds) skippedNodeIds.add(nodeId);
          break;
        }
      }
      const admittedNodeIds = capacityAdmission
        ? new Set(capacityAdmission.admittedNodeIds)
        : null;
      const candidate = plan.readyCandidates
        .map((readyCandidate) => nodeById.get(readyCandidate.nodeId))
        .find((node): node is RoomTaskNodeProjectionV1 => {
          if (!node) return false;
          if (admittedNodeIds && !admittedNodeIds.has(node.id)) {
            skippedNodeIds.add(node.id);
            return false;
          }
          const owner = selectDispatchOwner(
            room,
            node,
            occupiedSeatIds,
            activeRoleAssignment
          );
          if (owner) return true;
          skippedNodeIds.add(node.id);
          return false;
        });

      if (!candidate) break;
      const owner = selectDispatchOwner(
        room,
        candidate,
        occupiedSeatIds,
        activeRoleAssignment
      );
      if (!owner) {
        skippedNodeIds.add(candidate.id);
        continue;
      }
      if (!(input.canContinue?.() ?? true)) break;

      activeLease = await input.renewLease(activeLease);
      this.assertWorkerLease(room.room.id, activeLease);
      if (!(input.canContinue?.() ?? true)) break;

      try {
        await this.options.store.claimReadyTaskDispatch(
          this.toClaimInput({
            room,
            graph,
            node: candidate,
            owner,
            lease: activeLease,
          })
        );
        claimedNodeIds.push(candidate.id);
        skippedNodeIds.delete(candidate.id);
        snapshotConflictRetries = 0;
      } catch (error) {
        if (!isDispatchReplanConflict(error)) throw error;
        snapshotConflictRetries = this.advanceSnapshotConflictRetries(
          snapshotConflictRetries,
          room.room.id
        );
      }
    }

    return {
      room: latestRoom,
      lease: activeLease,
      claimedNodeIds: Object.freeze([...claimedNodeIds]),
      skippedNodeIds: Object.freeze([...skippedNodeIds].sort(compareText)),
      capacityAdmissions: Object.freeze([...capacityAdmissions]),
    };
  }

  private async resolveCapacityAdmission(input: {
    readonly room: RoomAggregateV1;
    readonly graph: RoomTaskGraphProjectionV1;
    readonly readyNodeIds: readonly string[];
    readonly activeRoleAssignment: RoomRoleAssignmentProjectionV1 | null;
    readonly occupiedSeatIds: ReadonlySet<string>;
  }): Promise<RoomTaskDispatchCapacityAdmissionV1 | null> {
    const source = this.options.capacityAdmissionSource;
    if (!source) {
      if (typeof this.options.store.getRoomCapabilityRegistry !== "function")
        return null;
      return {
        state: "withheld",
        requestedNodeIds: Object.freeze(
          [...input.readyNodeIds].sort(compareText)
        ),
        admittedNodeIds: Object.freeze([]),
        reasonCodes: Object.freeze(["capacity_admission_unconfigured"]),
        decision: null,
      };
    }

    const asOf = this.now();
    if (!isCanonicalUtcIsoTimestamp(asOf)) {
      throw new RoomDependencyDispatchCoordinatorError(
        "room_task_dispatch_replan_exhausted",
        "Room dependency dispatcher now() must return a canonical UTC ISO timestamp"
      );
    }
    const requestedNodeIds = Object.freeze(
      [...input.readyNodeIds].sort(compareText)
    );
    const capability = await this.resolveDurableCapabilityAdmission({
      ...input,
      asOf,
    });
    if (!capability.ok) {
      return {
        state: "withheld",
        requestedNodeIds,
        admittedNodeIds: Object.freeze([]),
        reasonCodes: Object.freeze([capability.reasonCode]),
        decision: null,
      };
    }
    if (capability.readyNodeIds.length === 0) {
      return {
        state: "withheld",
        requestedNodeIds,
        admittedNodeIds: Object.freeze([]),
        reasonCodes: Object.freeze(["capacity_binding_ineligible"]),
        decision: null,
      };
    }
    if (!capability.proof) {
      return {
        state: "withheld",
        requestedNodeIds,
        admittedNodeIds: Object.freeze([]),
        reasonCodes: Object.freeze([
          "capacity_capability_registry_unavailable",
        ]),
        decision: null,
      };
    }

    let capacityInput:
      | RoomCapacityGovernorInputV1
      | RoomTaskDispatchCapacitySourceFailureV1
      | null;
    try {
      capacityInput = await source.getCapacityGovernorInput({
        room: input.room,
        graph: input.graph,
        readyNodeIds: capability.readyNodeIds,
        asOf,
        capabilityRegistry: capability.registry,
        capabilityRegistryProof: capability.proof,
        capabilityRecommendations: capability.recommendations,
        capabilityQualityByReadyNodeId: capability.qualityByReadyNodeId,
        capabilityMinimumP95LatencyMs: capability.minimumP95LatencyMs,
      });
    } catch {
      return {
        state: "withheld",
        requestedNodeIds,
        admittedNodeIds: Object.freeze([]),
        reasonCodes: Object.freeze(["capacity_telemetry_unavailable"]),
        decision: null,
      };
    }
    if (capacityInput === null) {
      return {
        state: "withheld",
        requestedNodeIds,
        admittedNodeIds: Object.freeze([]),
        reasonCodes: Object.freeze(["capacity_telemetry_unavailable"]),
        decision: null,
      };
    }
    if (isCapacitySourceFailure(capacityInput)) {
      /*
      FNXC:CapacityTelemetryDiagnostics 2026-07-27-03:03:
      Preserve one allowlisted, message-free source failure through the
      coordinator result. This keeps admission fail-closed while allowing the
      durable audit/metric projection to distinguish observer failure, stale
      telemetry, bad policy, and malformed snapshots.
      */
      return {
        state: "withheld",
        requestedNodeIds,
        admittedNodeIds: Object.freeze([]),
        reasonCodes: Object.freeze([capacityInput.reasonCode]),
        decision: null,
        diagnostic: Object.freeze({ ...capacityInput }),
      };
    }

    if (!hasMatchingCapabilityRegistryProof(capacityInput, capability.proof)) {
      return {
        state: "withheld",
        requestedNodeIds,
        admittedNodeIds: Object.freeze([]),
        reasonCodes: Object.freeze(["capacity_capability_registry_mismatch"]),
        decision: null,
      };
    }

    const decision = governRoomCapacity(capacityInput);
    const hasReadyTaskSnapshot = hasCompleteReadyTaskSnapshot(
      capacityInput,
      input.room,
      capability.readyNodeIds,
      asOf,
      capability.qualityByReadyNodeId
    );
    const hasCapabilityLatencyFloor = telemetryMeetsCapabilityLatencyFloor(
      capacityInput,
      capability.minimumP95LatencyMs
    );
    if (!hasReadyTaskSnapshot || !hasCapabilityLatencyFloor) {
      const admissionReasons: RoomTaskDispatchCapacityReasonCode[] = [
        ...decision.reasonCodes,
      ];
      if (!hasReadyTaskSnapshot) {
        admissionReasons.push(
          "capacity_ready_tasks_snapshot_incomplete",
          "capacity_ready_tasks_capability_mismatch"
        );
      }
      if (!hasCapabilityLatencyFloor)
        admissionReasons.push("capacity_ready_tasks_latency_mismatch");
      return {
        state: "withheld",
        requestedNodeIds,
        admittedNodeIds: Object.freeze([]),
        reasonCodes: Object.freeze(sortCapacityReasons(admissionReasons)),
        decision,
      };
    }

    const readyNodeIdSet = new Set(requestedNodeIds);
    const admittedNodeIds = Object.freeze(
      decision.admission.scheduledWorkIds
        .filter((workId) => readyNodeIdSet.has(workId))
        .sort(compareText)
    );
    const reasonCodes: RoomTaskDispatchCapacityReasonCode[] = [
      ...decision.reasonCodes,
    ];
    if (capability.ineligibleNodeIds.length > 0)
      reasonCodes.push("capacity_binding_ineligible");
    if (
      admittedNodeIds.length === 0 &&
      capability.readyNodeIds.length > 0 &&
      decision.reasonCodes.includes("capacity_available")
    ) {
      reasonCodes.push("capacity_ready_tasks_not_admitted");
    }
    return {
      state: admittedNodeIds.length > 0 ? "admitted" : "withheld",
      requestedNodeIds,
      admittedNodeIds,
      reasonCodes: Object.freeze(sortCapacityReasons(reasonCodes)),
      decision,
    };
  }

  /**
   * FNXC:SessionRoomDurableCapabilityAdmission 2026-07-19-22:24:
   * The durable registry is replay-checked by AsyncRoomStore before it reaches
   * this seam. We still bind it to the live Room/role assignment, run Core's
   * independent quality + health + rate-limit evaluation, and provide the
   * exact quality evidence to the admission source. A source cannot use a
   * provider-label default or revive a stale/replaced binding through DI.
   */
  private async resolveDurableCapabilityAdmission(input: {
    readonly room: RoomAggregateV1;
    readonly graph: RoomTaskGraphProjectionV1;
    readonly readyNodeIds: readonly string[];
    readonly activeRoleAssignment: RoomRoleAssignmentProjectionV1 | null;
    readonly occupiedSeatIds: ReadonlySet<string>;
    readonly asOf: string;
  }): Promise<DurableCapabilityAdmissionResultV1> {
    const readRegistry = this.options.store.getRoomCapabilityRegistry;
    if (typeof readRegistry !== "function") {
      return {
        ok: false,
        reasonCode: "capacity_capability_registry_unavailable",
      };
    }
    let registry: RoomCapabilityRegistryProjectionV1 | null;
    try {
      registry = await readRegistry(input.room.room.id);
    } catch {
      return {
        ok: false,
        reasonCode: "capacity_capability_registry_unavailable",
      };
    }
    if (!isRoomCapabilityRegistryProjectionForRoom(registry, input.room)) {
      return {
        ok: false,
        reasonCode: "capacity_capability_registry_unavailable",
      };
    }

    const staticRoutingPolicy = this.options.capabilityRoutingPolicy;
    const routingPolicySource = this.options.capabilityRoutingPolicySource;
    if (
      (staticRoutingPolicy === undefined && routingPolicySource === undefined)
      || (staticRoutingPolicy !== undefined && routingPolicySource !== undefined)
    ) {
      return {
        ok: false,
        reasonCode: "capacity_capability_policy_unconfigured",
      };
    }
    let routingPolicy: RoomCapabilityRegistry.RoomCapabilityRoutingPolicyV1 | null =
      staticRoutingPolicy ?? null;
    if (routingPolicySource !== undefined) {
      try {
        routingPolicy = await routingPolicySource.getCapabilityRoutingPolicy({
          room: input.room,
          graph: input.graph,
          capabilityRegistry: registry,
          asOf: input.asOf,
        });
      } catch {
        routingPolicy = null;
      }
    }
    if (routingPolicy === null) {
      return {
        ok: false,
        reasonCode: "capacity_capability_policy_unconfigured",
      };
    }

    const evaluated = RoomCapabilityRegistry.recommendRoomCapabilityBindings({
      registry: registry.registry,
      asOf: input.asOf,
      policy: routingPolicy,
    });
    if (!evaluated.ok) {
      return {
        ok: false,
        reasonCode: "capacity_capability_registry_unavailable",
      };
    }

    const snapshotByBindingId = new Map(
      registry.registry.bindings.map(
        (entry) => [entry.lineage.bindingId, entry] as const
      )
    );
    const selectedRecommendationsByBindingId = new Map<
      string,
      RoomCapabilityRegistry.RoomCapabilityRecommendationV1
    >();
    const eligibleNodeIds: string[] = [];
    const ineligibleNodeIds: string[] = [];
    const eligibleBindingIds = new Set<string>();
    const qualityByReadyNodeId: Record<string, number> = {};
    let minimumP95LatencyMs = 0;
    const nodeById = new Map(
      input.graph.nodes.map((node) => [node.id, node] as const)
    );
    for (const nodeId of input.readyNodeIds) {
      const node = nodeById.get(nodeId);
      if (!node) {
        ineligibleNodeIds.push(nodeId);
        continue;
      }
      const owner = selectDispatchOwner(
        input.room,
        node,
        input.occupiedSeatIds,
        input.activeRoleAssignment
      );
      if (!owner) {
        ineligibleNodeIds.push(nodeId);
        continue;
      }
      const binding = input.room.bindings.find(
        (candidate) => candidate.id === owner.bindingId
      );
      const snapshot = snapshotByBindingId.get(owner.bindingId);
      if (
        !binding ||
        !snapshot ||
        !registrySnapshotMatchesRoomBinding(snapshot, binding)
      ) {
        ineligibleNodeIds.push(nodeId);
        continue;
      }
      const eligibility = RoomCapabilityRegistry.evaluateRoomBindingCapability({
        snapshot,
        asOf: input.asOf,
        policy: routingPolicyForNode(
          routingPolicy,
          node.capabilityRequirements
        ),
      });
      if (
        !eligibility.ok ||
        !eligibility.value.eligible ||
        eligibility.value.qualityScore === null
      ) {
        ineligibleNodeIds.push(nodeId);
        continue;
      }
      const recommendation: RoomCapabilityRegistry.RoomCapabilityRecommendationV1 =
        {
          bindingId: owner.bindingId,
          providerId: snapshot.lineage.providerId,
          modelId: snapshot.lineage.modelId,
          qualityScore: eligibility.value.qualityScore,
          latencyP95Ms: snapshot.latency.p95Ms,
          availableContextTokens: snapshot.context.availableTokens,
        };
      eligibleNodeIds.push(nodeId);
      eligibleBindingIds.add(owner.bindingId);
      qualityByReadyNodeId[nodeId] = recommendation.qualityScore;
      minimumP95LatencyMs = Math.max(
        minimumP95LatencyMs,
        recommendation.latencyP95Ms
      );
      selectedRecommendationsByBindingId.set(owner.bindingId, recommendation);
    }

    const sortedEligibleNodeIds = Object.freeze(
      [...new Set(eligibleNodeIds)].sort(compareText)
    );
    const sortedIneligibleNodeIds = Object.freeze(
      [...new Set(ineligibleNodeIds)].sort(compareText)
    );
    if (sortedEligibleNodeIds.length === 0) {
      return {
        ok: true,
        registry,
        proof: null,
        recommendations: Object.freeze([]),
        readyNodeIds: sortedEligibleNodeIds,
        ineligibleNodeIds: sortedIneligibleNodeIds,
        qualityByReadyNodeId: Object.freeze({}),
        minimumP95LatencyMs: 0,
      };
    }
    const proof = capabilityRegistryProofForBindings(
      registry,
      eligibleBindingIds
    );
    if (!proof) {
      return {
        ok: false,
        reasonCode: "capacity_capability_registry_unavailable",
      };
    }
    return {
      ok: true,
      registry,
      proof,
      recommendations: Object.freeze(
        sortCapabilityRecommendations([
          ...selectedRecommendationsByBindingId.values(),
        ])
      ),
      readyNodeIds: sortedEligibleNodeIds,
      ineligibleNodeIds: sortedIneligibleNodeIds,
      qualityByReadyNodeId: Object.freeze({ ...qualityByReadyNodeId }),
      minimumP95LatencyMs,
    };
  }

  private toClaimInput(input: {
    readonly room: RoomAggregateV1;
    readonly graph: RoomTaskGraphProjectionV1;
    readonly node: RoomTaskNodeProjectionV1;
    readonly owner: SelectedDispatchOwner;
    readonly lease: StoredRoomLeaseV1;
  }): ClaimReadyRoomTaskDispatchInputV1 {
    const issuedAt = this.now();
    if (!isCanonicalUtcIsoTimestamp(issuedAt)) {
      throw new RoomDependencyDispatchCoordinatorError(
        "room_task_dispatch_replan_exhausted",
        "Room dependency dispatcher now() must return a canonical UTC ISO timestamp"
      );
    }
    const commandId = [
      "room-task-dispatch",
      input.room.room.id,
      input.node.id,
      `a${input.room.room.aggregateVersion}`,
      `d${input.graph.dagVersion}`,
      `n${input.node.nodeVersion}`,
      input.owner.seatId,
      input.owner.bindingId,
      `ra${input.owner.roleAssignment.revision}:${input.owner.roleAssignment.assignmentId}`,
    ].join(":");
    const content = dispatchInstruction(input.node);
    return {
      roomId: input.room.room.id,
      nodeId: input.node.id,
      expectedAggregateVersion: input.room.room.aggregateVersion,
      expectedDagVersion: input.graph.dagVersion,
      expectedNodeVersion: input.node.nodeVersion,
      owner: input.owner,
      roleAssignment: input.owner.roleAssignment,
      roomWorkerFence: {
        leaseId: input.lease.id,
        holderId: input.lease.holderId,
        hostId: input.lease.hostId,
        expectedEpoch: input.lease.epoch,
      },
      idempotencyKey: commandId,
      commandId,
      correlationId: `room-task-dispatch:${input.room.room.id}:${input.node.id}`,
      issuedAt,
      authority: {
        actorType: "controller",
        actorId: this.options.workerId,
        deviceId: this.options.hostId,
        role: "room-controller",
        allowedActions: ["room:task:dispatch"],
        projectId: this.options.projectId,
        roomId: input.room.room.id,
        nodeIds: [input.node.id],
        seatIds: [input.owner.seatId],
        evidenceRefs: [
          `room-worker-lease:${input.lease.id}:epoch:${input.lease.epoch}`,
        ],
      },
      message: {
        intent: "instruction",
        content,
        contentHash: hashRoomValue(content),
      },
    };
  }

  private assertWorkerLease(roomId: string, lease: StoredRoomLeaseV1): void {
    if (
      lease.kind !== "room_worker" ||
      lease.roomId !== roomId ||
      lease.resourceId !== roomId ||
      lease.holderId !== this.options.workerId ||
      lease.hostId !== this.options.hostId ||
      lease.releasedAt !== null
    ) {
      throw new RoomDependencyDispatchCoordinatorError(
        "room_task_dispatch_invalid_worker_lease",
        `Room task dispatch requires the current room-worker lease for ${roomId}`
      );
    }
  }

  private advanceSnapshotConflictRetries(
    retries: number,
    roomId: string
  ): number {
    const next = retries + 1;
    if (next <= MAX_SNAPSHOT_CONFLICT_RETRIES) return next;
    throw new RoomDependencyDispatchCoordinatorError(
      "room_task_dispatch_replan_exhausted",
      `Room ${roomId} changed while planning task dispatch ${MAX_SNAPSHOT_CONFLICT_RETRIES} times`
    );
  }
}

type DurableCapabilityAdmissionFailureReasonCode =
  | "capacity_capability_policy_unconfigured"
  | "capacity_capability_registry_unavailable";

interface DurableCapabilityAdmissionContextV1 {
  readonly ok: true;
  readonly registry: RoomCapabilityRegistryProjectionV1;
  readonly proof: RoomCapacityGovernorCapabilityRegistryProofV1 | null;
  readonly recommendations: readonly RoomCapabilityRegistry.RoomCapabilityRecommendationV1[];
  readonly readyNodeIds: readonly string[];
  readonly ineligibleNodeIds: readonly string[];
  readonly qualityByReadyNodeId: Readonly<Record<string, number>>;
  readonly minimumP95LatencyMs: number;
}

type DurableCapabilityAdmissionResultV1 =
  | DurableCapabilityAdmissionContextV1
  | {
      readonly ok: false;
      readonly reasonCode: DurableCapabilityAdmissionFailureReasonCode;
    };

interface SelectedDispatchOwner {
  readonly seatId: string;
  readonly bindingId: string;
  readonly roleAssignment: {
    readonly assignmentId: string;
    readonly revision: number;
    readonly phaseId: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalText(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.trim() === value
  );
}

function isRoomCapabilityRegistryProjectionForRoom(
  value: unknown,
  room: RoomAggregateV1
): value is RoomCapabilityRegistryProjectionV1 {
  if (
    !isRecord(value) ||
    value.projectId !== room.room.projectId ||
    value.roomId !== room.room.id
  )
    return false;
  const registry = value.registry;
  return (
    isRecord(registry) &&
    isCanonicalText(registry.registryId) &&
    Number.isSafeInteger(registry.revision) &&
    (registry.revision as number) >= 0 &&
    isCanonicalText(registry.integrityHash) &&
    isCanonicalUtcIsoTimestamp(registry.observedAt as string) &&
    Array.isArray(registry.bindings)
  );
}

function registrySnapshotMatchesRoomBinding(
  snapshot: RoomCapabilityRegistry.RoomBindingCapabilitySnapshotV1,
  binding: RoomAggregateV1["bindings"][number]
): boolean {
  return (
    snapshot.lineage.bindingId === binding.id &&
    snapshot.lineage.bindingGeneration === binding.generation &&
    snapshot.lineage.providerId === binding.providerId &&
    snapshot.lineage.connectorId === binding.connectorId &&
    snapshot.lineage.nativeSessionId === binding.nativeSessionId &&
    snapshot.lineage.hostId === binding.hostId
  );
}

function capabilityRegistryProofForBindings(
  projection: RoomCapabilityRegistryProjectionV1,
  bindingIds: ReadonlySet<string>
): RoomCapacityGovernorCapabilityRegistryProofV1 | null {
  if (
    bindingIds.size === 0 ||
    !isCanonicalText(projection.registry.registryId) ||
    !Number.isSafeInteger(projection.registry.revision) ||
    projection.registry.revision < 0 ||
    !isCanonicalText(projection.registry.integrityHash) ||
    !isCanonicalUtcIsoTimestamp(projection.registry.observedAt)
  ) {
    return null;
  }
  const snapshots = projection.registry.bindings.filter((snapshot) =>
    bindingIds.has(snapshot.lineage.bindingId)
  );
  if (snapshots.length !== bindingIds.size) return null;
  const expiresAt = snapshots
    .map((snapshot) => snapshot.freshness.expiresAt)
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  if (!expiresAt || !isCanonicalUtcIsoTimestamp(expiresAt)) return null;
  return Object.freeze({
    source: "durable_room_ledger" as const,
    registryId: projection.registry.registryId,
    revision: projection.registry.revision,
    integrityHash: projection.registry.integrityHash,
    observedAt: projection.registry.observedAt,
    expiresAt,
  });
}

function routingPolicyForNode(
  policy: RoomCapabilityRegistry.RoomCapabilityRoutingPolicyV1,
  requiredTools: readonly string[]
): RoomCapabilityRegistry.RoomCapabilityRoutingPolicyV1 {
  return {
    ...policy,
    requirements: {
      ...policy.requirements,
      requiredTools: [
        ...new Set([...policy.requirements.requiredTools, ...requiredTools]),
      ].sort(compareText),
    },
  };
}

function sortCapabilityRecommendations(
  recommendations: readonly RoomCapabilityRegistry.RoomCapabilityRecommendationV1[]
): readonly RoomCapabilityRegistry.RoomCapabilityRecommendationV1[] {
  return [...recommendations].sort((left, right) => {
    if (left.qualityScore !== right.qualityScore)
      return right.qualityScore - left.qualityScore;
    if (left.latencyP95Ms !== right.latencyP95Ms)
      return left.latencyP95Ms - right.latencyP95Ms;
    if (left.availableContextTokens !== right.availableContextTokens) {
      return right.availableContextTokens - left.availableContextTokens;
    }
    return compareText(left.bindingId, right.bindingId);
  });
}

function hasMatchingCapabilityRegistryProof(
  input: RoomCapacityGovernorInputV1,
  expected: RoomCapacityGovernorCapabilityRegistryProofV1
): boolean {
  const proof = (input as unknown as { readonly capabilityRegistry?: unknown })
    .capabilityRegistry;
  if (!isRecord(proof)) return false;
  return (
    proof.source === expected.source &&
    proof.registryId === expected.registryId &&
    proof.revision === expected.revision &&
    proof.integrityHash === expected.integrityHash &&
    proof.observedAt === expected.observedAt &&
    proof.expiresAt === expected.expiresAt
  );
}

function hasCompleteReadyTaskSnapshot(
  input: RoomCapacityGovernorInputV1,
  room: RoomAggregateV1,
  readyNodeIds: readonly string[],
  asOf: string,
  qualityByReadyNodeId: Readonly<Record<string, number>>
): boolean {
  const raw = input as unknown;
  if (!raw || typeof raw !== "object") return false;
  const inputAsOf = "asOf" in raw ? raw.asOf : undefined;
  const scheduling = "scheduling" in raw ? raw.scheduling : undefined;
  if (
    typeof inputAsOf !== "string" ||
    inputAsOf !== asOf ||
    !scheduling ||
    typeof scheduling !== "object" ||
    !("asOf" in scheduling) ||
    scheduling.asOf !== inputAsOf ||
    !("queued" in scheduling) ||
    !Array.isArray(scheduling.queued)
  ) {
    return false;
  }
  const expectedNodeIds = new Set(readyNodeIds);
  if (expectedNodeIds.size !== readyNodeIds.length) return false;
  const queuedNodeIds = new Set<string>();
  for (const work of scheduling.queued) {
    if (!work || typeof work !== "object") return false;
    const workId = "workId" in work ? work.workId : undefined;
    const projectId = "projectId" in work ? work.projectId : undefined;
    const roomId = "roomId" in work ? work.roomId : undefined;
    if (projectId !== room.room.projectId || roomId !== room.room.id) continue;
    if (typeof workId !== "string" || queuedNodeIds.has(workId)) return false;
    const expectedQuality = qualityByReadyNodeId[workId];
    if (expectedQuality === undefined || work.qualityScore !== expectedQuality)
      return false;
    queuedNodeIds.add(workId);
  }
  if (queuedNodeIds.size !== expectedNodeIds.size) return false;
  return [...expectedNodeIds].every((nodeId) => queuedNodeIds.has(nodeId));
}

function telemetryMeetsCapabilityLatencyFloor(
  input: RoomCapacityGovernorInputV1,
  minimumP95LatencyMs: number
): boolean {
  if (!Number.isFinite(minimumP95LatencyMs) || minimumP95LatencyMs < 0)
    return false;
  const raw = input as unknown;
  if (
    !isRecord(raw) ||
    !isRecord(raw.telemetry) ||
    !isRecord(raw.telemetry.latency)
  )
    return false;
  const p95Ms = raw.telemetry.latency.p95Ms;
  return (
    typeof p95Ms === "number" &&
    Number.isFinite(p95Ms) &&
    p95Ms >= minimumP95LatencyMs
  );
}

function sortCapacityReasons(
  reasons: readonly RoomTaskDispatchCapacityReasonCode[]
): readonly RoomTaskDispatchCapacityReasonCode[] {
  return [...new Set(reasons)].sort(compareText);
}

function occupiedSeats(
  room: RoomAggregateV1,
  graph: RoomTaskGraphProjectionV1,
  activeRoleAssignment: RoomRoleAssignmentProjectionV1 | null
): ReadonlySet<string> {
  const occupied = new Set<string>();
  for (const node of graph.nodes.filter(
    (candidate) => candidate.state === "running"
  )) {
    const owner = selectDispatchOwner(
      room,
      node,
      new Set(),
      activeRoleAssignment
    );
    if (owner) occupied.add(owner.seatId);
  }
  return occupied;
}

function selectDispatchOwner(
  room: RoomAggregateV1,
  node: RoomTaskNodeProjectionV1,
  occupiedSeatIds: ReadonlySet<string>,
  activeRoleAssignment: RoomRoleAssignmentProjectionV1 | null
): SelectedDispatchOwner | null {
  // Task dispatch is capability-aware only after an immutable role assignment
  // is active. Falling back to unverified node seat hints would bypass locks,
  // forbids, and producer/verifier separation during a partial rollout.
  if (!activeRoleAssignment) return null;
  const resolved = resolveRoomTaskRoleAssignment(
    node,
    activeRoleAssignment.assignment,
    activeRoleAssignment.capabilitySnapshot
  );
  if (!resolved.ok || resolved.bindingIds.length !== 1) return null;
  const binding = room.bindings.find(
    (candidate) => candidate.id === resolved.bindingIds[0]
  );
  const seat = binding
    ? room.seats.find((candidate) => candidate.id === binding.seatId)
    : null;
  if (
    !binding ||
    binding.state !== "attached" ||
    !seat ||
    seat.state !== "active" ||
    seat.activeBindingId !== binding.id ||
    occupiedSeatIds.has(seat.id)
  ) {
    return null;
  }
  return {
    seatId: seat.id,
    bindingId: binding.id,
    roleAssignment: {
      assignmentId: activeRoleAssignment.id,
      revision: activeRoleAssignment.revision,
      phaseId: activeRoleAssignment.phaseId,
    },
  };
}

function dispatchInstruction(node: RoomTaskNodeProjectionV1): string {
  const authorityScopeHash = hashRoomValue(node.authorityScope);
  const lines = [
    "[Fusion Room task dispatch]",
    `Task node: ${node.id}`,
    `Objective: ${node.objective}`,
    `Input references: ${node.inputRefs.join(", ") || "(none)"}`,
    `Output references: ${node.outputRefs.join(", ") || "(none)"}`,
    `Acceptance gates: ${node.acceptanceGateIds.join(", ") || "(none)"}`,
    `Authority allowed actions: ${
      node.authorityScope.allowedActions.join(", ") || "(none)"
    }`,
    `Authority read paths: ${
      node.authorityScope.readPaths.join(", ") || "(none)"
    }`,
    `Authority write paths: ${
      node.authorityScope.writePaths.join(", ") || "(none)"
    }`,
    `Authority scope hash: ${authorityScopeHash}`,
    "Work only within the declared task authority. Report evidence; do not self-accept.",
  ];
  return lines.join("\n");
}

function isDispatchReplanConflict(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { readonly code?: unknown }).code;
  return (
    code === "aggregate_version_conflict" ||
    code === "dag_version_conflict" ||
    code === "task_node_version_conflict" ||
    code === "task_dispatch_dependency_blocked" ||
    code === "task_dispatch_owner_conflict" ||
    code === "role_assignment_missing" ||
    code === "role_assignment_conflict"
  );
}

function isCanonicalUtcIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

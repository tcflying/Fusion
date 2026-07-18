import type { IsoTimestamp, RoomBindingId } from "./ids.js";
import type { RoomProtocolDefinitionV1 } from "./protocol.js";
import type { SessionConnectorCapabilityState } from "./session-connector.js";

export type RoomBindingAssignmentAvailability = "eligible" | "degraded" | "unavailable";

export interface RoomBindingCapabilityCertificationInputV1 {
  readonly name: string;
  readonly state: SessionConnectorCapabilityState;
}

export interface RoomBindingCapabilitySnapshotInputV1 {
  readonly bindingId: RoomBindingId;
  readonly availability: RoomBindingAssignmentAvailability;
  readonly capabilityRevision: string;
  readonly capabilities: readonly RoomBindingCapabilityCertificationInputV1[];
}

export interface RoomCapabilitySnapshotInputV1 {
  readonly contractVersion: 1;
  readonly snapshotId: string;
  readonly revision: number;
  readonly capturedAt: IsoTimestamp;
  readonly bindings: readonly RoomBindingCapabilitySnapshotInputV1[];
}

export interface RoomBindingCapabilityCertificationV1 {
  readonly name: string;
  readonly state: SessionConnectorCapabilityState;
}

export interface RoomBindingCapabilitySnapshotV1 {
  readonly bindingId: RoomBindingId;
  readonly availability: RoomBindingAssignmentAvailability;
  readonly capabilityRevision: string;
  readonly capabilities: readonly RoomBindingCapabilityCertificationV1[];
}

export interface RoomCapabilitySnapshotV1 {
  readonly contractVersion: 1;
  readonly snapshotId: string;
  readonly revision: number;
  readonly capturedAt: IsoTimestamp;
  readonly bindings: readonly RoomBindingCapabilitySnapshotV1[];
}

export interface RoomRoleBindingConstraintV1 {
  readonly roleId: string;
  readonly bindingId: RoomBindingId;
}

export interface RoomRoleAssignmentConstraintsV1 {
  readonly locks: readonly RoomRoleBindingConstraintV1[];
  readonly forbids: readonly RoomRoleBindingConstraintV1[];
}

export interface RoomRoleBindingAssignmentV1 {
  readonly roleId: string;
  readonly bindingIds: readonly RoomBindingId[];
  readonly requiredCapabilities: readonly string[];
}

export interface RoomRoleAssignmentV1 {
  readonly contractVersion: 1;
  readonly protocolId: string;
  readonly protocolVersion: number;
  readonly phaseId: string;
  readonly capabilitySnapshotId: string;
  readonly capabilitySnapshotRevision: number;
  readonly capabilitySnapshotFingerprint: string;
  readonly assignments: readonly RoomRoleBindingAssignmentV1[];
  readonly producerBindingIds: readonly RoomBindingId[];
}

export interface AssignRoomRolesInputV1 {
  readonly protocol: RoomProtocolDefinitionV1;
  readonly phaseId: string;
  readonly capabilitySnapshot: RoomCapabilitySnapshotV1;
  readonly constraints: RoomRoleAssignmentConstraintsV1;
  readonly producerBindingIds: readonly RoomBindingId[];
}

export interface ValidateRoomRoleAssignmentInputV1 {
  readonly protocol: RoomProtocolDefinitionV1;
  readonly assignment: RoomRoleAssignmentV1;
  readonly capabilitySnapshot: RoomCapabilitySnapshotV1;
  /**
   * Producer lineage loaded from the authoritative Room event/projection, not
   * copied from the untrusted assignment being validated. Required whenever
   * the active phase verifies or accepts work produced in an earlier phase.
   */
  readonly authoritativeProducerBindingIds?: readonly RoomBindingId[];
}

export interface TransitionRoomRoleAssignmentInputV1 {
  readonly protocol: RoomProtocolDefinitionV1;
  readonly currentAssignment: RoomRoleAssignmentV1;
  readonly targetPhaseId: string;
  readonly satisfiedGateIds: readonly string[];
  readonly atTurnBoundary: boolean;
  readonly capabilitySnapshot: RoomCapabilitySnapshotV1;
  readonly constraints: RoomRoleAssignmentConstraintsV1;
  /** Required when currentAssignment is already a downstream phase. */
  readonly authoritativeProducerBindingIds?: readonly RoomBindingId[];
}

export type RoomRoleAssignmentFailureCode =
  | "invalid_capability_snapshot"
  | "duplicate_binding"
  | "duplicate_capability"
  | "phase_not_found"
  | "role_not_in_phase"
  | "lock_forbid_conflict"
  | "locked_binding_missing"
  | "locked_binding_ineligible"
  | "missing_capability"
  | "no_eligible_binding"
  | "minimum_distinct_producer_bindings_unsatisfied"
  | "independent_verifier_required"
  | "independent_accepter_required"
  | "capability_snapshot_changed"
  | "assignment_contract_mismatch"
  | "assignment_binding_missing"
  | "assignment_binding_ineligible"
  | "direct_phase_assignment_forbidden"
  | "turn_boundary_required"
  | "transition_not_declared"
  | "transition_gate_unsatisfied";

export interface RoomRoleAssignmentFailureV1 {
  readonly code: RoomRoleAssignmentFailureCode;
  readonly path: string;
  readonly message: string;
  readonly roleId?: string;
  readonly bindingId?: RoomBindingId;
  readonly capability?: string;
}

export type RoomRoleAssignmentPolicyResultV1<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly unsatisfied: readonly RoomRoleAssignmentFailureV1[] };

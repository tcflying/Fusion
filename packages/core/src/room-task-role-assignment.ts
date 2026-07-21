import type {
  RoomCapabilitySnapshotV1,
  RoomRoleAssignmentV1,
} from "./room-contracts/assignment.js";

export interface RoomTaskRoleAssignmentRequirementsV1 {
  readonly roleRequirements: readonly string[];
  readonly capabilityRequirements: readonly string[];
}

export type RoomTaskRoleAssignmentResolutionV1 =
  | {
      readonly ok: true;
      /** Sorted eligible binding identities; callers must fail closed if not exactly one. */
      readonly bindingIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code:
        | "task_role_requirements_missing"
        | "task_role_requirements_invalid"
        | "task_role_not_assigned"
        | "task_capability_requirements_invalid"
        | "task_binding_not_eligible";
    };

/**
 * FNXC:SessionRoomRoleAssignment 2026-07-19-02:48:
 * Task ownership is derived from the durable phase assignment rather than a
 * coordinator's seat preference. This pure resolver returns every matching
 * binding; the caller deliberately refuses an ambiguous result instead of
 * picking an arbitrary Session and weakening producer/verifier separation.
 */
export function resolveRoomTaskRoleAssignment(
  node: RoomTaskRoleAssignmentRequirementsV1,
  assignment: RoomRoleAssignmentV1,
  capabilitySnapshot: RoomCapabilitySnapshotV1,
): RoomTaskRoleAssignmentResolutionV1 {
  if (!isUniqueNonBlankStringArray(node.roleRequirements) || node.roleRequirements.length === 0) {
    return { ok: false, code: "task_role_requirements_missing" };
  }
  if (!isUniqueNonBlankStringArray(node.capabilityRequirements)) {
    return { ok: false, code: "task_capability_requirements_invalid" };
  }
  const assignmentsByRole = new Map(
    assignment.assignments.map((roleAssignment) => [roleAssignment.roleId, roleAssignment] as const),
  );
  let candidateBindingIds: Set<string> | null = null;
  for (const roleId of node.roleRequirements) {
    const roleAssignment = assignmentsByRole.get(roleId);
    if (!roleAssignment) return { ok: false, code: "task_role_not_assigned" };
    const assignedBindingIds = new Set<string>(roleAssignment.bindingIds);
    if (candidateBindingIds === null) {
      candidateBindingIds = assignedBindingIds;
    } else {
      const intersection = new Set<string>();
      for (const bindingId of candidateBindingIds) {
        if (assignedBindingIds.has(bindingId)) intersection.add(bindingId);
      }
      candidateBindingIds = intersection;
    }
  }
  if (!candidateBindingIds || candidateBindingIds.size === 0) {
    return { ok: false, code: "task_role_not_assigned" };
  }
  const requiredCapabilities = new Set(node.capabilityRequirements);
  const bindingIds = [...candidateBindingIds]
    .filter((bindingId) => {
      const binding = capabilitySnapshot.bindings.find((candidate) => candidate.bindingId === bindingId);
      if (!binding || binding.availability !== "eligible") return false;
      const verifiedCapabilities = new Set(
        binding.capabilities
          .filter((capability) => capability.state === "verified")
          .map((capability) => capability.name),
      );
      return [...requiredCapabilities].every((capability) => verifiedCapabilities.has(capability));
    })
    .sort(compareText);
  return bindingIds.length > 0
    ? { ok: true, bindingIds }
    : { ok: false, code: "task_binding_not_eligible" };
}

function isUniqueNonBlankStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
    && new Set(value).size === value.length;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

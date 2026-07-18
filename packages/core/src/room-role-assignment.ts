import type {
  AssignRoomRolesInputV1,
  RoomBindingCapabilityCertificationInputV1,
  RoomBindingCapabilityCertificationV1,
  RoomBindingCapabilitySnapshotInputV1,
  RoomBindingCapabilitySnapshotV1,
  RoomCapabilitySnapshotInputV1,
  RoomCapabilitySnapshotV1,
  RoomRoleAssignmentFailureV1,
  RoomRoleAssignmentPolicyResultV1,
  RoomRoleAssignmentV1,
  TransitionRoomRoleAssignmentInputV1,
  ValidateRoomRoleAssignmentInputV1,
} from "./room-contracts/assignment.js";
import { hashRoomValue } from "./room-integrity.js";
import type { RoomProtocolDefinitionV1 } from "./room-contracts/protocol.js";

const CAPABILITY_STATES = new Set(["verified", "degraded", "unavailable", "unverified"]);
const BINDING_AVAILABILITY_STATES = new Set(["eligible", "degraded", "unavailable"]);
const PROTOCOL_FAMILIES = new Set([
  "analysis_decision",
  "implementation",
  "diagnosis",
  "creative_review",
  "bounded_discussion",
]);
const PROTOCOL_GATE_KINDS = new Set([
  "deterministic",
  "evidence",
  "model_review",
  "operator_approval",
]);
const PROVENANCE_KINDS = new Set(["candidate", "hypothesis"]);

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null) return value;
  const objectValue = value as object;
  if (seen.has(objectValue)) return value;
  seen.add(objectValue);
  for (const key of Reflect.ownKeys(objectValue)) {
    const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  Object.freeze(objectValue);
  return value;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRuntimeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUniqueNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every(nonEmptyString)
    && new Set(value).size === value.length;
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function capabilitySnapshotFingerprint(snapshot: RoomCapabilitySnapshotV1): string {
  return hashRoomValue({
    contractVersion: snapshot.contractVersion,
    snapshotId: snapshot.snapshotId,
    revision: snapshot.revision,
    capturedAt: snapshot.capturedAt,
    bindings: snapshot.bindings,
  });
}

function cloneAssignment(assignment: RoomRoleAssignmentV1): RoomRoleAssignmentV1 {
  return {
    ...assignment,
    assignments: assignment.assignments.map((entry) => ({
      ...entry,
      bindingIds: [...entry.bindingIds],
      requiredCapabilities: [...entry.requiredCapabilities],
    })),
    producerBindingIds: [...assignment.producerBindingIds],
  };
}

function normalizeAssignmentProtocol(
  value: unknown,
): RoomRoleAssignmentPolicyResultV1<RoomProtocolDefinitionV1> {
  if (!isRuntimeRecord(value)) {
    return deepFreeze({
      ok: false,
      unsatisfied: [invalid("assignment_contract_mismatch", "$.protocol", "Assignment protocol must be an inspectable object")],
    });
  }
  const requiredArrays = ["phases", "roles", "gates", "transitions", "channels", "contextPacks", "recoveryActions", "exitConditions"] as const;
  if (
    value.contractVersion !== 1
    || !nonEmptyString(value.id)
    || !Number.isSafeInteger(value.version)
    || (value.version as number) <= 0
    || !PROTOCOL_FAMILIES.has(value.family as string)
    || !nonEmptyString(value.name)
    || requiredArrays.some((key) => !Array.isArray(value[key]))
  ) {
    return deepFreeze({
      ok: false,
      unsatisfied: [invalid("assignment_contract_mismatch", "$.protocol", "Assignment protocol identity, version, and arrays are malformed")],
    });
  }
  const phases = value.phases as unknown[];
  const roles = value.roles as unknown[];
  const gates = value.gates as unknown[];
  const transitions = value.transitions as unknown[];
  if (phases.length === 0 || roles.length === 0) {
    return deepFreeze({
      ok: false,
      unsatisfied: [invalid("assignment_contract_mismatch", "$.protocol", "Assignment protocol requires phases and roles")],
    });
  }
  const phaseIds = new Set<string>();
  for (let index = 0; index < phases.length; index += 1) {
    const phase = phases[index];
    if (
      !isRuntimeRecord(phase)
      || !nonEmptyString(phase.id)
      || phaseIds.has(phase.id)
      || !isUniqueNonEmptyStringArray(phase.roleIds)
      || !isUniqueNonEmptyStringArray(phase.entryGateIds)
      || !isUniqueNonEmptyStringArray(phase.exitGateIds)
      || (phase.channelIds !== undefined && !isUniqueNonEmptyStringArray(phase.channelIds))
      || (phase.contextPackIds !== undefined && !isUniqueNonEmptyStringArray(phase.contextPackIds))
      || !Number.isSafeInteger(phase.timeoutMs)
      || (phase.timeoutMs as number) <= 0
    ) {
      return deepFreeze({
        ok: false,
        unsatisfied: [invalid("assignment_contract_mismatch", `$.protocol.phases[${index}]`, "Protocol phase is malformed or duplicated")],
      });
    }
    phaseIds.add(phase.id);
  }
  const roleIds = new Set<string>();
  for (let index = 0; index < roles.length; index += 1) {
    const role = roles[index];
    if (
      !isRuntimeRecord(role)
      || !nonEmptyString(role.id)
      || roleIds.has(role.id)
      || !isUniqueNonEmptyStringArray(role.requiredCapabilities)
      || typeof role.mayProduce !== "boolean"
      || typeof role.mayVerify !== "boolean"
      || typeof role.mayAccept !== "boolean"
    ) {
      return deepFreeze({
        ok: false,
        unsatisfied: [invalid("assignment_contract_mismatch", `$.protocol.roles[${index}]`, "Protocol role is malformed or duplicated")],
      });
    }
    roleIds.add(role.id);
  }
  for (const phase of phases as Record<string, unknown>[]) {
    if ((phase.roleIds as string[]).some((roleId) => !roleIds.has(roleId))) {
      return deepFreeze({
        ok: false,
        unsatisfied: [invalid("assignment_contract_mismatch", "$.protocol.phases", "A phase references an undeclared role")],
      });
    }
  }
  const gateIds = new Set<string>();
  for (let index = 0; index < gates.length; index += 1) {
    const gate = gates[index];
    if (
      !isRuntimeRecord(gate)
      || !nonEmptyString(gate.id)
      || gateIds.has(gate.id)
      || !PROTOCOL_GATE_KINDS.has(gate.kind as string)
      || typeof gate.hard !== "boolean"
      || (gate.evaluatorRoleIds !== undefined && !isUniqueNonEmptyStringArray(gate.evaluatorRoleIds))
      || (gate.evidenceRequirements !== undefined && !isUniqueNonEmptyStringArray(gate.evidenceRequirements))
      || (gate.provenanceKind !== undefined && !PROVENANCE_KINDS.has(gate.provenanceKind as string))
      || (
        gate.minimumDistinctProducerBindings !== undefined
        && (!Number.isSafeInteger(gate.minimumDistinctProducerBindings) || (gate.minimumDistinctProducerBindings as number) < 0)
      )
    ) {
      return deepFreeze({
        ok: false,
        unsatisfied: [invalid("assignment_contract_mismatch", `$.protocol.gates[${index}]`, "Protocol gate is malformed or duplicated")],
      });
    }
    gateIds.add(gate.id);
  }
  for (let index = 0; index < phases.length; index += 1) {
    const phase = phases[index] as Record<string, unknown>;
    const referencedGateIds = [
      ...(phase.entryGateIds as string[]),
      ...(phase.exitGateIds as string[]),
    ];
    if (referencedGateIds.some((gateId) => !gateIds.has(gateId))) {
      return deepFreeze({
        ok: false,
        unsatisfied: [invalid("assignment_contract_mismatch", `$.protocol.phases[${index}]`, "Protocol phase references an undeclared gate")],
      });
    }
  }
  for (let index = 0; index < gates.length; index += 1) {
    const gate = gates[index] as Record<string, unknown>;
    if (
      gate.evaluatorRoleIds !== undefined
      && (gate.evaluatorRoleIds as string[]).some((roleId) => !roleIds.has(roleId))
    ) {
      return deepFreeze({
        ok: false,
        unsatisfied: [invalid("assignment_contract_mismatch", `$.protocol.gates[${index}].evaluatorRoleIds`, "Protocol gate references an undeclared evaluator role")],
      });
    }
  }
  for (let index = 0; index < transitions.length; index += 1) {
    const transition = transitions[index];
    if (
      !isRuntimeRecord(transition)
      || !nonEmptyString(transition.fromPhaseId)
      || !nonEmptyString(transition.toPhaseId)
      || !nonEmptyString(transition.whenGateId)
      || !phaseIds.has(transition.fromPhaseId)
      || !phaseIds.has(transition.toPhaseId)
      || !gateIds.has(transition.whenGateId)
    ) {
      return deepFreeze({
        ok: false,
        unsatisfied: [invalid("assignment_contract_mismatch", `$.protocol.transitions[${index}]`, "Protocol transition is malformed or references missing objects")],
      });
    }
  }
  return deepFreeze({ ok: true, value: structuredClone(value) as unknown as RoomProtocolDefinitionV1 });
}

function invalid(
  code: RoomRoleAssignmentFailureV1["code"],
  path: string,
  message: string,
  details: Pick<
    RoomRoleAssignmentFailureV1,
    "roleId" | "bindingId" | "capability"
  > = {},
): RoomRoleAssignmentFailureV1 {
  return { code, path, message, ...details };
}

function hasVerifiedCapabilities(
  binding: RoomBindingCapabilitySnapshotV1,
  requiredCapabilities: readonly string[],
): boolean {
  if (binding.availability !== "eligible") return false;
  const verified = new Set(
    binding.capabilities
      .filter((capability) => capability.state === "verified")
      .map((capability) => capability.name),
  );
  return requiredCapabilities.every((capability) => verified.has(capability));
}

/*
FNXC:SessionRoomRoleAssignment 2026-07-18-12:21:
Role assignment consumes an immutable, canonical snapshot of concrete binding capabilities. The caller supplies snapshot identity and time; this pure policy never reads clocks, provider labels, or mutable connector state while replaying a decision.
*/
export function createRoomCapabilitySnapshot(
  input: RoomCapabilitySnapshotInputV1,
): RoomRoleAssignmentPolicyResultV1<RoomCapabilitySnapshotV1> {
  const unsatisfied: RoomRoleAssignmentFailureV1[] = [];
  if (!isRuntimeRecord(input as unknown)) {
    return deepFreeze({
      ok: false,
      unsatisfied: [invalid("invalid_capability_snapshot", "$", "Capability snapshot must be an inspectable object")],
    });
  }
  if (input.contractVersion !== 1) {
    unsatisfied.push(invalid("invalid_capability_snapshot", "$.contractVersion", "Only capability snapshot contract version 1 is supported"));
  }
  if (!nonEmptyString(input.snapshotId)) {
    unsatisfied.push(invalid("invalid_capability_snapshot", "$.snapshotId", "Snapshot identity must be a non-empty string"));
  }
  if (!Number.isSafeInteger(input.revision) || input.revision <= 0) {
    unsatisfied.push(invalid("invalid_capability_snapshot", "$.revision", "Snapshot revision must be a positive safe integer"));
  }
  if (!isCanonicalUtcTimestamp(input.capturedAt)) {
    unsatisfied.push(invalid("invalid_capability_snapshot", "$.capturedAt", "Snapshot capture time must be a canonical UTC ISO timestamp"));
  }
  if (!Array.isArray(input.bindings)) {
    unsatisfied.push(invalid("invalid_capability_snapshot", "$.bindings", "Snapshot bindings must be an array"));
    return deepFreeze({ ok: false, unsatisfied });
  }

  const seenBindings = new Set<string>();
  const bindings: RoomBindingCapabilitySnapshotV1[] = [];
  input.bindings.forEach((
    binding: RoomBindingCapabilitySnapshotInputV1,
    bindingIndex: number,
  ) => {
    const bindingPath = `$.bindings[${bindingIndex}]`;
    if (!isRuntimeRecord(binding as unknown)) {
      unsatisfied.push(invalid("invalid_capability_snapshot", bindingPath, "Binding capability entry must be an inspectable object"));
      return;
    }
    if (!nonEmptyString(binding.bindingId)) {
      unsatisfied.push(invalid("invalid_capability_snapshot", `${bindingPath}.bindingId`, "Binding identity must be a non-empty string"));
      return;
    }
    if (seenBindings.has(binding.bindingId)) {
      unsatisfied.push(invalid("duplicate_binding", `${bindingPath}.bindingId`, "A capability snapshot cannot contain the same binding twice", { bindingId: binding.bindingId }));
    }
    seenBindings.add(binding.bindingId);
    if (!BINDING_AVAILABILITY_STATES.has(binding.availability)) {
      unsatisfied.push(invalid("invalid_capability_snapshot", `${bindingPath}.availability`, "Binding availability is unsupported", { bindingId: binding.bindingId }));
    }
    if (!nonEmptyString(binding.capabilityRevision)) {
      unsatisfied.push(invalid("invalid_capability_snapshot", `${bindingPath}.capabilityRevision`, "Binding capability revision must be explicit", { bindingId: binding.bindingId }));
    }
    if (!Array.isArray(binding.capabilities)) {
      unsatisfied.push(invalid("invalid_capability_snapshot", `${bindingPath}.capabilities`, "Binding capabilities must be an array", { bindingId: binding.bindingId }));
      return;
    }
    const seenCapabilities = new Set<string>();
    const capabilities: RoomBindingCapabilityCertificationV1[] = [];
    binding.capabilities.forEach((
      capability: RoomBindingCapabilityCertificationInputV1,
      capabilityIndex: number,
    ) => {
      const capabilityPath = `${bindingPath}.capabilities[${capabilityIndex}]`;
      if (!isRuntimeRecord(capability as unknown)) {
        unsatisfied.push(invalid("invalid_capability_snapshot", capabilityPath, "Capability certification must be an inspectable object", { bindingId: binding.bindingId }));
        return;
      }
      if (!nonEmptyString(capability.name)) {
        unsatisfied.push(invalid("invalid_capability_snapshot", `${capabilityPath}.name`, "Capability name must be a non-empty string", { bindingId: binding.bindingId }));
        return;
      }
      if (seenCapabilities.has(capability.name)) {
        unsatisfied.push(invalid("duplicate_capability", `${capabilityPath}.name`, "A binding capability may be certified only once per snapshot", { bindingId: binding.bindingId, capability: capability.name }));
      }
      seenCapabilities.add(capability.name);
      if (!CAPABILITY_STATES.has(capability.state)) {
        unsatisfied.push(invalid("invalid_capability_snapshot", `${capabilityPath}.state`, "Capability state is unsupported", { bindingId: binding.bindingId, capability: capability.name }));
      }
      capabilities.push({ name: capability.name, state: capability.state });
    });
    capabilities.sort((left, right) => compareText(left.name, right.name));
    bindings.push({
      bindingId: binding.bindingId,
      availability: binding.availability,
      capabilityRevision: binding.capabilityRevision,
      capabilities,
    });
  });

  if (unsatisfied.length > 0) return deepFreeze({ ok: false, unsatisfied });
  bindings.sort((left, right) => compareText(left.bindingId, right.bindingId));
  return deepFreeze({
    ok: true,
    value: {
      contractVersion: 1,
      snapshotId: input.snapshotId,
      revision: input.revision,
      capturedAt: input.capturedAt,
      bindings,
    },
  });
}

export function assignRoomRoles(
  input: AssignRoomRolesInputV1,
): RoomRoleAssignmentPolicyResultV1<RoomRoleAssignmentV1> {
  return assignRoomRolesChecked(input, false);
}

function assignRoomRolesChecked(
  input: AssignRoomRolesInputV1,
  allowTransitionPhase: boolean,
): RoomRoleAssignmentPolicyResultV1<RoomRoleAssignmentV1> {
  const normalized = normalizeAssignRoomRolesInput(input, allowTransitionPhase);
  if (!normalized.ok) return normalized;
  return assignRoomRolesCanonical(normalized.value);
}

function normalizeAssignRoomRolesInput(
  input: AssignRoomRolesInputV1,
  allowTransitionPhase: boolean,
): RoomRoleAssignmentPolicyResultV1<AssignRoomRolesInputV1> {
  const candidate = input as unknown;
  if (!isRuntimeRecord(candidate)) {
    return deepFreeze({
      ok: false,
      unsatisfied: [invalid("assignment_contract_mismatch", "$", "Role assignment input must be an inspectable object")],
    });
  }
  const protocolResult = normalizeAssignmentProtocol(candidate.protocol);
  if (!protocolResult.ok) {
    return deepFreeze({
      ok: false,
      unsatisfied: [invalid("assignment_contract_mismatch", "$.protocol", "Role assignment requires a valid protocol definition")],
    });
  }
  if (!nonEmptyString(candidate.phaseId)) {
    return deepFreeze({
      ok: false,
      unsatisfied: [invalid("phase_not_found", "$.phaseId", "Role assignment phase must be explicit")],
    });
  }
  const entryPhaseId = protocolResult.value.phases[0]?.id;
  if (!allowTransitionPhase && candidate.phaseId !== entryPhaseId) {
    return deepFreeze({
      ok: false,
      unsatisfied: [invalid(
        "direct_phase_assignment_forbidden",
        "$.phaseId",
        `Phase '${candidate.phaseId}' must be entered through a declared turn-boundary transition`,
      )],
    });
  }
  const snapshotResult = createRoomCapabilitySnapshot(
    candidate.capabilitySnapshot as RoomCapabilitySnapshotInputV1,
  );
  if (!snapshotResult.ok) return snapshotResult;
  if (!isRuntimeRecord(candidate.constraints)) {
    return deepFreeze({
      ok: false,
      unsatisfied: [invalid("assignment_contract_mismatch", "$.constraints", "Role assignment constraints must be an object")],
    });
  }
  const normalizedConstraints: { locks: { roleId: string; bindingId: string }[]; forbids: { roleId: string; bindingId: string }[] } = {
    locks: [],
    forbids: [],
  };
  for (const kind of ["locks", "forbids"] as const) {
    const entries = candidate.constraints[kind];
    if (!Array.isArray(entries)) {
      return deepFreeze({
        ok: false,
        unsatisfied: [invalid("assignment_contract_mismatch", `$.constraints.${kind}`, "Role assignment constraints must be arrays")],
      });
    }
    const seen = new Set<string>();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (
        !isRuntimeRecord(entry)
        || !nonEmptyString(entry.roleId)
        || !nonEmptyString(entry.bindingId)
      ) {
        return deepFreeze({
          ok: false,
          unsatisfied: [invalid("assignment_contract_mismatch", `$.constraints.${kind}[${index}]`, "Each role constraint requires a role and binding identity")],
        });
      }
      const identity = `${entry.roleId}\u0000${entry.bindingId}`;
      if (seen.has(identity)) {
        return deepFreeze({
          ok: false,
          unsatisfied: [invalid("assignment_contract_mismatch", `$.constraints.${kind}[${index}]`, "Duplicate role constraints are not canonical", { roleId: entry.roleId, bindingId: entry.bindingId })],
        });
      }
      seen.add(identity);
      normalizedConstraints[kind].push({ roleId: entry.roleId, bindingId: entry.bindingId });
    }
  }
  if (!isUniqueNonEmptyStringArray(candidate.producerBindingIds)) {
    return deepFreeze({
      ok: false,
      unsatisfied: [invalid("assignment_contract_mismatch", "$.producerBindingIds", "Producer binding identities must be a unique string array")],
    });
  }
  return deepFreeze({
    ok: true,
    value: {
      protocol: protocolResult.value,
      phaseId: candidate.phaseId,
      capabilitySnapshot: snapshotResult.value,
      constraints: normalizedConstraints,
      producerBindingIds: [...candidate.producerBindingIds].sort(compareText),
    },
  });
}

function assignRoomRolesCanonical(
  input: AssignRoomRolesInputV1,
): RoomRoleAssignmentPolicyResultV1<RoomRoleAssignmentV1> {
  const phase = input.protocol.phases.find((candidate) => candidate.id === input.phaseId);
  if (!phase) {
    return deepFreeze({
      ok: false,
      unsatisfied: [
        invalid("phase_not_found", "$.phaseId", `Protocol phase '${input.phaseId}' does not exist`),
      ],
    });
  }

  const forbiddenPairs = new Set(
    input.constraints.forbids.map(({ roleId, bindingId }) => `${roleId}\u0000${bindingId}`),
  );
  const constraintConflicts = input.constraints.locks
    .filter(({ roleId, bindingId }) => forbiddenPairs.has(`${roleId}\u0000${bindingId}`))
    .map(({ roleId, bindingId }, index) =>
      invalid(
        "lock_forbid_conflict",
        `$.constraints.locks[${index}]`,
        `Binding '${bindingId}' is both locked and forbidden for role '${roleId}'`,
        { roleId, bindingId },
      ),
    );
  if (constraintConflicts.length > 0) {
    return deepFreeze({ ok: false, unsatisfied: constraintConflicts });
  }

  const rolesById = new Map(input.protocol.roles.map((role) => [role.id, role]));
  const unsatisfied: RoomRoleAssignmentFailureV1[] = [];
  const phaseRoleIds = new Set(phase.roleIds);
  for (const [kind, constraints] of Object.entries(input.constraints) as readonly [
    "locks" | "forbids",
    AssignRoomRolesInputV1["constraints"]["locks"],
  ][]) {
    constraints.forEach(({ roleId, bindingId }, index) => {
      if (!phaseRoleIds.has(roleId)) {
        unsatisfied.push(invalid("role_not_in_phase", `$.constraints.${kind}[${index}].roleId`, `Constraint role '${roleId}' is not active in phase '${phase.id}'`, { roleId, bindingId }));
      }
    });
  }
  if (unsatisfied.length > 0) return deepFreeze({ ok: false, unsatisfied });

  const producerBindingsDuringSelection = new Set(input.producerBindingIds);
  const roleSelectionOrder = phase.roleIds
    .map((roleId, phaseRoleIndex) => ({ roleId, phaseRoleIndex }))
    .sort((left, right) => {
      const leftProduces = rolesById.get(left.roleId)?.mayProduce === true;
      const rightProduces = rolesById.get(right.roleId)?.mayProduce === true;
      if (leftProduces !== rightProduces) return leftProduces ? -1 : 1;
      return left.phaseRoleIndex - right.phaseRoleIndex;
    });
  const assignmentsInSelectionOrder = roleSelectionOrder.flatMap(({
    roleId,
    phaseRoleIndex,
  }) => {
    const role = rolesById.get(roleId);
    if (!role) {
      unsatisfied.push(invalid("role_not_in_phase", `$.protocol.phases.${phase.id}.roleIds[${phaseRoleIndex}]`, `Phase role '${roleId}' is not declared`, { roleId }));
      return [];
    }
    const lockedBindingIds = [...new Set(
      input.constraints.locks
        .filter((constraint) => constraint.roleId === roleId)
        .map((constraint) => constraint.bindingId),
    )].sort(compareText);
    const forbiddenBindingIds = new Set(
      input.constraints.forbids
        .filter((constraint) => constraint.roleId === roleId)
        .map((constraint) => constraint.bindingId),
    );
    const lockedBindings = lockedBindingIds.flatMap((bindingId) => {
      const binding = input.capabilitySnapshot.bindings.find(
        (candidate) => candidate.bindingId === bindingId,
      );
      if (!binding) {
        unsatisfied.push(invalid("locked_binding_missing", `$.constraints.locks.${roleId}`, `Locked binding '${bindingId}' is absent from the current capability snapshot`, { roleId, bindingId }));
        return [];
      }
      if (binding.availability !== "eligible") {
        unsatisfied.push(invalid("locked_binding_ineligible", `$.constraints.locks.${roleId}`, `Locked binding '${bindingId}' is not currently eligible`, { roleId, bindingId }));
        return [];
      }
      const verified = new Set(
        binding.capabilities
          .filter((capability) => capability.state === "verified")
          .map((capability) => capability.name),
      );
      const missing = role.requiredCapabilities.filter((capability) => !verified.has(capability));
      for (const capability of missing) {
        unsatisfied.push(invalid("missing_capability", `$.constraints.locks.${roleId}`, `Locked binding '${bindingId}' lacks verified capability '${capability}'`, { roleId, bindingId, capability }));
      }
      return missing.length === 0 ? [binding] : [];
    });
    if (lockedBindingIds.length > 0 && lockedBindings.length !== lockedBindingIds.length) return [];

    const eligibleBindings = lockedBindingIds.length > 0
      ? lockedBindings
      : input.capabilitySnapshot.bindings.filter(
          (binding) =>
            !forbiddenBindingIds.has(binding.bindingId) &&
            hasVerifiedCapabilities(binding, role.requiredCapabilities),
        );
    if (eligibleBindings.length === 0) {
      const verifiedAcrossEligibleBindings = new Set(
        input.capabilitySnapshot.bindings
          .filter((binding) => binding.availability === "eligible")
          .flatMap((binding) =>
            binding.capabilities
              .filter((capability) => capability.state === "verified")
              .map((capability) => capability.name),
          ),
      );
      const missingCapabilities = role.requiredCapabilities.filter(
        (capability) => !verifiedAcrossEligibleBindings.has(capability),
      );
      if (missingCapabilities.length > 0) {
        for (const capability of missingCapabilities) {
          unsatisfied.push(invalid("missing_capability", `$.protocol.roles.${roleId}.requiredCapabilities`, `No eligible binding has verified capability '${capability}'`, { roleId, capability }));
        }
      } else {
        unsatisfied.push(invalid("no_eligible_binding", `$.protocol.roles.${roleId}`, `No single eligible binding satisfies role '${roleId}'`, { roleId }));
      }
      return [];
    }
    const requiresIndependentTieBreak = role.mayVerify || role.mayAccept;
    const selected = [...eligibleBindings].sort((left, right) => {
      if (requiresIndependentTieBreak) {
        const leftWasProducer = producerBindingsDuringSelection.has(left.bindingId);
        const rightWasProducer = producerBindingsDuringSelection.has(right.bindingId);
        if (leftWasProducer !== rightWasProducer) return leftWasProducer ? 1 : -1;
      }
      return compareText(left.bindingId, right.bindingId);
    });
    const selectedBindingIds = lockedBindingIds.length > 0
      ? selected.map((binding) => binding.bindingId)
      : [selected[0]!.bindingId];
    if (role.mayProduce) {
      for (const bindingId of selectedBindingIds) {
        producerBindingsDuringSelection.add(bindingId);
      }
    }
    return [{
      roleId,
      bindingIds: selectedBindingIds,
      requiredCapabilities: [...role.requiredCapabilities].sort(compareText),
    }];
  });

  if (unsatisfied.length > 0) return deepFreeze({ ok: false, unsatisfied });
  const assignmentsByRole = new Map(
    assignmentsInSelectionOrder.map((assignment) => [assignment.roleId, assignment]),
  );
  const assignments = phase.roleIds.flatMap((roleId) => {
    const assignment = assignmentsByRole.get(roleId);
    return assignment ? [assignment] : [];
  });
  const producerRoleIds = new Set(
    input.protocol.roles.filter((role) => role.mayProduce).map((role) => role.id),
  );
  const minimumDistinctProducerBindings = Math.max(
    0,
    ...input.protocol.gates
      .filter(
        (gate) =>
          phase.exitGateIds.includes(gate.id) &&
          gate.minimumDistinctProducerBindings !== undefined,
      )
      .map((gate) => gate.minimumDistinctProducerBindings ?? 0),
  );
  const currentProducerBindings = new Set(
    assignments
      .filter((assignment) => producerRoleIds.has(assignment.roleId))
      .flatMap((assignment) => assignment.bindingIds),
  );
  if (currentProducerBindings.size < minimumDistinctProducerBindings) {
    for (const assignment of assignments) {
      if (currentProducerBindings.size >= minimumDistinctProducerBindings) break;
      if (!producerRoleIds.has(assignment.roleId)) continue;
      const role = rolesById.get(assignment.roleId)!;
      const roleIsLocked = input.constraints.locks.some(
        (constraint) => constraint.roleId === assignment.roleId,
      );
      if (roleIsLocked) continue;
      const forbidden = new Set(
        input.constraints.forbids
          .filter((constraint) => constraint.roleId === assignment.roleId)
          .map((constraint) => constraint.bindingId),
      );
      for (const binding of input.capabilitySnapshot.bindings) {
        if (currentProducerBindings.size >= minimumDistinctProducerBindings) break;
        if (
          currentProducerBindings.has(binding.bindingId) ||
          forbidden.has(binding.bindingId) ||
          !hasVerifiedCapabilities(binding, role.requiredCapabilities)
        ) {
          continue;
        }
        assignment.bindingIds.push(binding.bindingId);
        assignment.bindingIds.sort(compareText);
        currentProducerBindings.add(binding.bindingId);
      }
    }
  }
  if (currentProducerBindings.size < minimumDistinctProducerBindings) {
    return deepFreeze({
      ok: false,
      unsatisfied: [
        invalid(
          "minimum_distinct_producer_bindings_unsatisfied",
          "$.protocol.gates",
          `Phase '${phase.id}' requires ${minimumDistinctProducerBindings} distinct producer bindings but only ${currentProducerBindings.size} are eligible`,
        ),
      ],
    });
  }
  const producerBindingIds = new Set(input.producerBindingIds);
  for (const assignment of assignments) {
    if (!producerRoleIds.has(assignment.roleId)) continue;
    for (const bindingId of assignment.bindingIds) producerBindingIds.add(bindingId);
  }
  const separationIssues: RoomRoleAssignmentFailureV1[] = [];
  for (const [permission, code] of [
    ["mayVerify", "independent_verifier_required"],
    ["mayAccept", "independent_accepter_required"],
  ] as const) {
    const permissionAssignments = assignments.filter((assignment) =>
      rolesById.get(assignment.roleId)?.[permission] === true,
    );
    const permissionBindingIds = permissionAssignments.flatMap(
      (assignment) => assignment.bindingIds,
    );
    const overlappingBindingId = permissionBindingIds.find((bindingId) => producerBindingIds.has(bindingId));
    if (!overlappingBindingId) continue;
    const firstAssignment = permissionAssignments[0]!;
    separationIssues.push(invalid(
      code,
      `$.assignments.${firstAssignment.roleId}`,
      permission === "mayVerify"
        ? "A producing binding cannot verify its own candidate, even in a mixed panel"
        : "A producing binding cannot accept its own candidate, even in a mixed panel",
      { roleId: firstAssignment.roleId, bindingId: overlappingBindingId },
    ));
  }
  if (separationIssues.length > 0) {
    return deepFreeze({ ok: false, unsatisfied: separationIssues });
  }
  return deepFreeze({
    ok: true,
    value: {
      contractVersion: 1,
      protocolId: input.protocol.id,
      protocolVersion: input.protocol.version,
      phaseId: input.phaseId,
      capabilitySnapshotId: input.capabilitySnapshot.snapshotId,
      capabilitySnapshotRevision: input.capabilitySnapshot.revision,
      capabilitySnapshotFingerprint: capabilitySnapshotFingerprint(input.capabilitySnapshot),
      assignments,
      producerBindingIds: [...producerBindingIds].sort(compareText),
    },
  });
}

export function validateRoomRoleAssignment(
  input: ValidateRoomRoleAssignmentInputV1,
): RoomRoleAssignmentPolicyResultV1<RoomRoleAssignmentV1> {
  const unsatisfied: RoomRoleAssignmentFailureV1[] = [];
  const candidate = input as unknown;
  if (!isRuntimeRecord(candidate) || !isRuntimeRecord(candidate.assignment)) {
    return deepFreeze({
      ok: false,
      unsatisfied: [invalid("assignment_contract_mismatch", "$", "Role assignment validation input must be an inspectable object")],
    });
  }
  const protocolResult = normalizeAssignmentProtocol(candidate.protocol);
  if (!protocolResult.ok) {
    return deepFreeze({
      ok: false,
      unsatisfied: [invalid("assignment_contract_mismatch", "$.protocol", "Role assignment requires a valid protocol definition")],
    });
  }
  const snapshotResult = createRoomCapabilitySnapshot(
    candidate.capabilitySnapshot as RoomCapabilitySnapshotInputV1,
  );
  if (!snapshotResult.ok) return snapshotResult;
  const protocol = protocolResult.value;
  const capabilitySnapshot = snapshotResult.value;
  const assignment = candidate.assignment;
  if (
    assignment.contractVersion !== 1
    || assignment.protocolId !== protocol.id
    || assignment.protocolVersion !== protocol.version
  ) {
    unsatisfied.push(invalid("assignment_contract_mismatch", "$.assignment.protocolId", "Assignment protocol identity/version does not match the active protocol"));
  }
  if (
    assignment.capabilitySnapshotId !== capabilitySnapshot.snapshotId
    || assignment.capabilitySnapshotRevision !== capabilitySnapshot.revision
    || assignment.capabilitySnapshotFingerprint !== capabilitySnapshotFingerprint(capabilitySnapshot)
  ) {
    unsatisfied.push(invalid("capability_snapshot_changed", "$.capabilitySnapshot", "Assignment must be recomputed after the capability snapshot changes"));
  }

  const phase = protocol.phases.find((entry) => entry.id === assignment.phaseId);
  if (!phase) {
    unsatisfied.push(invalid("phase_not_found", "$.assignment.phaseId", `Assignment phase '${String(assignment.phaseId)}' does not exist`));
  }
  if (!Array.isArray(assignment.assignments)) {
    unsatisfied.push(invalid("assignment_contract_mismatch", "$.assignment.assignments", "Assignment entries must be an array"));
  }
  if (!isUniqueNonEmptyStringArray(assignment.producerBindingIds)) {
    unsatisfied.push(invalid("assignment_contract_mismatch", "$.assignment.producerBindingIds", "Producer binding identities must be a unique string array"));
  }

  const rolesById = new Map(protocol.roles.map((role) => [role.id, role]));
  const producerBindingIds = isUniqueNonEmptyStringArray(assignment.producerBindingIds)
    ? new Set(assignment.producerBindingIds)
    : new Set<string>();
  const phaseRequiresIndependentProducerLineage = Boolean(
    phase
    && phase.roleIds.some((roleId) => {
      const role = rolesById.get(roleId);
      return role?.mayVerify === true || role?.mayAccept === true;
    })
    && protocol.transitions.some((transition) => transition.toPhaseId === phase.id)
    && protocol.roles.some((role) => role.mayProduce),
  );
  const authoritativeProducerBindingIds = isUniqueNonEmptyStringArray(
    candidate.authoritativeProducerBindingIds,
  )
    ? new Set(candidate.authoritativeProducerBindingIds)
    : new Set<string>();
  if (phaseRequiresIndependentProducerLineage) {
    if (authoritativeProducerBindingIds.size === 0) {
      unsatisfied.push(invalid(
        "assignment_contract_mismatch",
        "$.authoritativeProducerBindingIds",
        "A downstream verifier or accepter assignment requires producer lineage from the authoritative Room projection",
      ));
    } else {
      const claimed = [...producerBindingIds].sort(compareText);
      const authoritative = [...authoritativeProducerBindingIds].sort(compareText);
      if (
        claimed.length !== authoritative.length
        || claimed.some((bindingId, index) => bindingId !== authoritative[index])
      ) {
        unsatisfied.push(invalid(
          "assignment_contract_mismatch",
          "$.assignment.producerBindingIds",
          "Assignment producer lineage does not match the authoritative Room projection",
        ));
      }
    }
  }
  const separationProducerBindingIds = phaseRequiresIndependentProducerLineage
    ? authoritativeProducerBindingIds
    : producerBindingIds;
  const seenRoleIds = new Set<string>();
  const currentProducerBindingIds = new Set<string>();
  const normalizedAssignments: RoomRoleAssignmentV1["assignments"][number][] = [];
  const assignmentEntries = Array.isArray(assignment.assignments) ? assignment.assignments : [];
  for (let index = 0; index < assignmentEntries.length; index += 1) {
    const assigned = assignmentEntries[index];
    if (
      !isRuntimeRecord(assigned)
      || !nonEmptyString(assigned.roleId)
      || !isUniqueNonEmptyStringArray(assigned.bindingIds)
      || !isUniqueNonEmptyStringArray(assigned.requiredCapabilities)
    ) {
      unsatisfied.push(invalid("assignment_contract_mismatch", `$.assignment.assignments[${index}]`, "Each assignment requires one role, unique bindings, and unique required capabilities"));
      continue;
    }
    if (seenRoleIds.has(assigned.roleId)) {
      unsatisfied.push(invalid("assignment_contract_mismatch", `$.assignment.assignments[${index}].roleId`, "A phase role may be assigned only once", { roleId: assigned.roleId }));
      continue;
    }
    seenRoleIds.add(assigned.roleId);
    const role = rolesById.get(assigned.roleId);
    if (!role || !phase?.roleIds.includes(assigned.roleId)) {
      unsatisfied.push(invalid("role_not_in_phase", `$.assignment.assignments.${assigned.roleId}`, `Assigned role '${assigned.roleId}' is not active in this phase`, { roleId: assigned.roleId }));
      continue;
    }
    const expectedCapabilities = [...role.requiredCapabilities].sort(compareText);
    const actualCapabilities = [...assigned.requiredCapabilities].sort(compareText);
    if (
      expectedCapabilities.length !== actualCapabilities.length
      || expectedCapabilities.some((capability, capabilityIndex) => capability !== actualCapabilities[capabilityIndex])
    ) {
      unsatisfied.push(invalid("assignment_contract_mismatch", `$.assignment.assignments.${assigned.roleId}.requiredCapabilities`, "Assigned capability requirements do not match the protocol role", { roleId: assigned.roleId }));
    }
    for (const bindingId of assigned.bindingIds) {
      const binding = capabilitySnapshot.bindings.find((entry) => entry.bindingId === bindingId);
      if (!binding) {
        unsatisfied.push(invalid("assignment_binding_missing", `$.assignment.assignments.${assigned.roleId}`, `Assigned binding '${bindingId}' is absent from the current capability snapshot`, { roleId: assigned.roleId, bindingId }));
        continue;
      }
      if (binding.availability !== "eligible") {
        unsatisfied.push(invalid("assignment_binding_ineligible", `$.assignment.assignments.${assigned.roleId}`, `Assigned binding '${bindingId}' is no longer eligible`, { roleId: assigned.roleId, bindingId }));
      }
      const verified = new Set(
        binding.capabilities
          .filter((capability) => capability.state === "verified")
          .map((capability) => capability.name),
      );
      for (const capability of role.requiredCapabilities) {
        if (verified.has(capability)) continue;
        unsatisfied.push(invalid("missing_capability", `$.assignment.assignments.${assigned.roleId}`, `Assigned binding '${bindingId}' no longer has verified capability '${capability}'`, { roleId: assigned.roleId, bindingId, capability }));
      }
      if (role.mayProduce) currentProducerBindingIds.add(bindingId);
      if ((role.mayVerify || role.mayAccept) && separationProducerBindingIds.has(bindingId)) {
        unsatisfied.push(invalid(
          role.mayVerify ? "independent_verifier_required" : "independent_accepter_required",
          `$.assignment.assignments.${assigned.roleId}`,
          "A producer binding cannot verify or accept its own work",
          { roleId: assigned.roleId, bindingId },
        ));
      }
    }
    normalizedAssignments.push({
      roleId: assigned.roleId,
      bindingIds: [...assigned.bindingIds],
      requiredCapabilities: [...assigned.requiredCapabilities],
    });
  }
  for (const roleId of phase?.roleIds ?? []) {
    if (!seenRoleIds.has(roleId)) {
      unsatisfied.push(invalid("assignment_contract_mismatch", `$.assignment.assignments.${roleId}`, `Active phase role '${roleId}' has no assignment`, { roleId }));
    }
  }
  for (const bindingId of producerBindingIds) {
    if (!capabilitySnapshot.bindings.some((binding) => binding.bindingId === bindingId)) {
      unsatisfied.push(invalid("assignment_binding_missing", "$.assignment.producerBindingIds", `Producer binding '${bindingId}' is absent from the current capability snapshot`, { bindingId }));
    }
  }
  for (const bindingId of currentProducerBindingIds) {
    if (!producerBindingIds.has(bindingId)) {
      unsatisfied.push(invalid("assignment_contract_mismatch", "$.assignment.producerBindingIds", `Current producer binding '${bindingId}' is missing from producer lineage`, { bindingId }));
    }
  }
  const minimumDistinctProducerBindings = Math.max(
    0,
    ...protocol.gates
      .filter((gate) => phase?.exitGateIds.includes(gate.id) && gate.minimumDistinctProducerBindings !== undefined)
      .map((gate) => gate.minimumDistinctProducerBindings ?? 0),
  );
  if (currentProducerBindingIds.size < minimumDistinctProducerBindings) {
    unsatisfied.push(invalid(
      "minimum_distinct_producer_bindings_unsatisfied",
      "$.assignment.assignments",
      `Phase '${String(assignment.phaseId)}' requires ${minimumDistinctProducerBindings} distinct producer bindings but assignment has ${currentProducerBindingIds.size}`,
    ));
  }

  if (unsatisfied.length > 0) return deepFreeze({ ok: false, unsatisfied });
  return deepFreeze({
    ok: true,
    value: cloneAssignment({
      contractVersion: 1,
      protocolId: protocol.id,
      protocolVersion: protocol.version,
      phaseId: assignment.phaseId as string,
      capabilitySnapshotId: capabilitySnapshot.snapshotId,
      capabilitySnapshotRevision: capabilitySnapshot.revision,
      capabilitySnapshotFingerprint: capabilitySnapshotFingerprint(capabilitySnapshot),
      assignments: normalizedAssignments,
      producerBindingIds: [...producerBindingIds].sort(compareText),
    }),
  });
}

/*
FNXC:SessionRoomRoleAssignment 2026-07-18-12:27:
Phase reassignment is legal only at a recorded turn boundary through the exact declarative transition gate. Producer binding provenance crosses the boundary so a later verifier or accepter cannot erase separation-of-duty history by changing roles.
*/
export function transitionRoomRoleAssignment(
  input: TransitionRoomRoleAssignmentInputV1,
): RoomRoleAssignmentPolicyResultV1<RoomRoleAssignmentV1> {
  const candidate = input as unknown;
  if (
    !isRuntimeRecord(candidate)
    || !nonEmptyString(candidate.targetPhaseId)
    || !isUniqueNonEmptyStringArray(candidate.satisfiedGateIds)
    || typeof candidate.atTurnBoundary !== "boolean"
  ) {
    return deepFreeze({
      ok: false,
      unsatisfied: [invalid("assignment_contract_mismatch", "$", "Role transition input is malformed")],
    });
  }
  const protocolResult = normalizeAssignmentProtocol(candidate.protocol);
  if (!protocolResult.ok) {
    return deepFreeze({
      ok: false,
      unsatisfied: [invalid("assignment_contract_mismatch", "$.protocol", "Role transition requires a valid protocol definition")],
    });
  }
  const currentValidation = validateRoomRoleAssignment({
    protocol: protocolResult.value,
    assignment: candidate.currentAssignment as RoomRoleAssignmentV1,
    capabilitySnapshot: candidate.capabilitySnapshot as RoomCapabilitySnapshotV1,
    authoritativeProducerBindingIds: candidate.authoritativeProducerBindingIds as string[] | undefined,
  });
  if (!currentValidation.ok) return currentValidation;
  if (!input.atTurnBoundary) {
    return deepFreeze({
      ok: false,
      unsatisfied: [
        invalid("turn_boundary_required", "$.atTurnBoundary", "Role assignment phase changes require a recorded turn boundary"),
      ],
    });
  }
  const transition = protocolResult.value.transitions.find(
    (entry) =>
      entry.fromPhaseId === currentValidation.value.phaseId
      && entry.toPhaseId === input.targetPhaseId,
  );
  if (!transition) {
    return deepFreeze({
      ok: false,
      unsatisfied: [
        invalid("transition_not_declared", "$.targetPhaseId", `No protocol transition is declared from '${currentValidation.value.phaseId}' to '${input.targetPhaseId}'`),
      ],
    });
  }
  if (!input.satisfiedGateIds.includes(transition.whenGateId)) {
    return deepFreeze({
      ok: false,
      unsatisfied: [
        invalid("transition_gate_unsatisfied", "$.satisfiedGateIds", `Transition gate '${transition.whenGateId}' has not passed`),
      ],
    });
  }

  return assignRoomRolesChecked({
    protocol: protocolResult.value,
    phaseId: input.targetPhaseId,
    capabilitySnapshot: input.capabilitySnapshot,
    constraints: input.constraints,
    producerBindingIds: currentValidation.value.producerBindingIds,
  }, true);
}

import {
  ROOM_PROTOCOL_FAMILIES,
  type RoomProtocolDefinitionV1,
} from "./room-contracts/protocol.js";

export interface ProtocolValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type ProtocolValidationResult =
  | { readonly ok: true; readonly value: RoomProtocolDefinitionV1 }
  | { readonly ok: false; readonly issues: readonly ProtocolValidationIssue[] };

export interface RoomProtocolMigrationPlanV1 {
  readonly contractVersion: 1;
  readonly protocolId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly activateAt: "next_turn_boundary";
  readonly currentPhaseId: string;
  readonly phaseIdMap: Readonly<Record<string, string>>;
  readonly roleIdMap: Readonly<Record<string, string>>;
}

export type ProtocolMigrationValidationResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly protocolId: string;
        readonly fromVersion: number;
        readonly toVersion: number;
        readonly nextPhaseId: string;
      };
    }
  | { readonly ok: false; readonly issues: readonly ProtocolValidationIssue[] };

const PROTOCOL_KEYS = [
  "contractVersion",
  "id",
  "version",
  "family",
  "name",
  "phases",
  "roles",
  "channels",
  "contextPacks",
  "transitions",
  "gates",
  "recoveryActions",
  "exitConditions",
] as const;

const PHASE_KEYS = [
  "id",
  "roleIds",
  "entryGateIds",
  "exitGateIds",
  "timeoutMs",
  "channelIds",
  "contextPackIds",
] as const;
const ROLE_KEYS = [
  "id",
  "requiredCapabilities",
  "mayProduce",
  "mayVerify",
  "mayAccept",
] as const;
const CHANNEL_KEYS = [
  "id",
  "allowedIntents",
  "responderRoleIds",
  "broadcastRequiresResponse",
] as const;
const CONTEXT_PACK_KEYS = ["id", "includeKinds", "excludeKinds", "maxItems"] as const;
const TRANSITION_KEYS = ["fromPhaseId", "toPhaseId", "whenGateId"] as const;
const GATE_KEYS = [
  "id",
  "kind",
  "hard",
  "evaluatorRoleIds",
  "evidenceRequirements",
] as const;
const RECOVERY_KEYS = ["id", "trigger", "action", "maxAttempts"] as const;
const EXIT_KEYS = [
  "outcome",
  "requiredGateIds",
  "requireIndependentVerifier",
  "allowUnresolvedRiskSeverities",
] as const;
const MIGRATION_ENVELOPE_KEYS = ["fromProtocol", "toProtocol", "migration"] as const;
const MIGRATION_KEYS = [
  "contractVersion",
  "protocolId",
  "fromVersion",
  "toVersion",
  "activateAt",
  "currentPhaseId",
  "phaseIdMap",
  "roleIdMap",
] as const;

const MESSAGE_INTENTS = new Set([
  "instruction",
  "proposal",
  "question",
  "critique",
  "challenge",
  "verdict",
  "handoff",
  "help_request",
]);
const GATE_KINDS = new Set(["deterministic", "evidence", "model_review", "operator_approval"]);
const RECOVERY_TRIGGERS = new Set([
  "timeout",
  "no_progress",
  "hard_gate_failed",
  "participant_lost",
  "rate_limited",
  "conflicting_evidence",
]);
const RECOVERY_ACTIONS = new Set([
  "retry",
  "redecompose",
  "replace_participant",
  "add_challenger",
  "shrink_scope",
  "change_model",
  "request_operator",
]);
const EXIT_OUTCOMES = new Set([
  "completed",
  "completed_with_risks",
  "partial",
  "blocked",
  "cancelled",
  "failed",
]);
const RISK_SEVERITIES = new Set(["low", "medium"]);

type JsonObject = Record<string, unknown>;

function issue(
  issues: ProtocolValidationIssue[],
  code: string,
  path: string,
  message: string,
): void {
  issues.push({ code, path, message });
}

function isObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function objectAt(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[],
  issues: ProtocolValidationIssue[],
): JsonObject | null {
  if (!isObject(value)) {
    issue(issues, "invalid_type", path, "Expected an object");
    return null;
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!allowed.has(key)) {
      issue(issues, "unknown_field", `${path}.${key}`, `Unknown field '${key}'`);
    }
  }
  for (const key of Object.getOwnPropertySymbols(value)) {
    issue(issues, "unknown_field", `${path}[${String(key)}]`, "Symbol-keyed fields are not supported");
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      issue(issues, "missing_field", `${path}.${key}`, `Missing required field '${key}'`);
    }
  }
  return value;
}

function nonEmptyString(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[],
): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    issue(issues, "invalid_string", path, "Expected a non-empty string");
    return false;
  }
  return true;
}

function booleanAt(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[],
): value is boolean {
  if (typeof value !== "boolean") {
    issue(issues, "invalid_type", path, "Expected a boolean");
    return false;
  }
  return true;
}

function positiveInteger(
  value: unknown,
  path: string,
  code: string,
  issues: ProtocolValidationIssue[],
): value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    issue(issues, code, path, "Expected a positive safe integer");
    return false;
  }
  return true;
}

function enumString(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
  code: string,
  issues: ProtocolValidationIssue[],
): value is string {
  if (typeof value !== "string" || !allowed.has(value)) {
    issue(issues, code, path, "Value is not in the supported declarative vocabulary");
    return false;
  }
  return true;
}

function arrayAt(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[],
): readonly unknown[] | null {
  if (!Array.isArray(value)) {
    issue(issues, "invalid_type", path, "Expected an array");
    return null;
  }
  let populatedIndexes = 0;
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key === "symbol") {
      issue(issues, "unknown_field", `${path}[${String(key)}]`, "Symbol-keyed array fields are not supported");
      continue;
    }
    const index = Number(key);
    const isElementIndex =
      Number.isInteger(index) && index >= 0 && index < value.length && String(index) === key;
    if (!isElementIndex) {
      issue(issues, "unknown_field", `${path}.${key}`, `Unknown array field '${key}'`);
      continue;
    }
    populatedIndexes += 1;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      issue(
        issues,
        "invalid_array_element",
        `${path}[${index}]`,
        "Array elements must be enumerable data properties",
      );
    }
  }
  if (populatedIndexes !== value.length) {
    issue(issues, "sparse_array", path, "Sparse arrays are not valid declarative protocol data");
  }
  return value;
}

function stringArray(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[],
  allowed?: ReadonlySet<string>,
): readonly string[] | null {
  const values = arrayAt(value, path, issues);
  if (!values) return null;
  const result: string[] = [];
  const seen = new Set<string>();
  values.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!nonEmptyString(entry, entryPath, issues)) return;
    if (allowed && !allowed.has(entry)) {
      issue(issues, "unsupported_value", entryPath, `Unsupported value '${entry}'`);
      return;
    }
    if (seen.has(entry)) {
      issue(issues, "duplicate_reference", entryPath, `Duplicate value '${entry}'`);
    }
    seen.add(entry);
    result.push(entry);
  });
  return result;
}

function validateNamedObjects(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[],
  validateItem: (value: unknown, path: string, issues: ProtocolValidationIssue[]) => JsonObject | null,
): readonly JsonObject[] {
  const values = arrayAt(value, path, issues);
  if (!values) return [];
  const result: JsonObject[] = [];
  const ids = new Set<string>();
  values.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    const object = validateItem(entry, entryPath, issues);
    if (!object) return;
    result.push(object);
    if (!nonEmptyString(object.id, `${entryPath}.id`, issues)) return;
    if (ids.has(object.id)) {
      issue(issues, "duplicate_id", `${entryPath}.id`, `Duplicate identifier '${object.id}'`);
    }
    ids.add(object.id);
  });
  return result;
}

function validatePhase(value: unknown, path: string, issues: ProtocolValidationIssue[]): JsonObject | null {
  const object = objectAt(
    value,
    path,
    PHASE_KEYS,
    ["id", "roleIds", "entryGateIds", "exitGateIds", "timeoutMs"],
    issues,
  );
  if (!object) return null;
  stringArray(object.roleIds, `${path}.roleIds`, issues);
  stringArray(object.entryGateIds, `${path}.entryGateIds`, issues);
  stringArray(object.exitGateIds, `${path}.exitGateIds`, issues);
  positiveInteger(object.timeoutMs, `${path}.timeoutMs`, "invalid_timeout", issues);
  if ("channelIds" in object) stringArray(object.channelIds, `${path}.channelIds`, issues);
  if ("contextPackIds" in object) stringArray(object.contextPackIds, `${path}.contextPackIds`, issues);
  return object;
}

function validateRole(value: unknown, path: string, issues: ProtocolValidationIssue[]): JsonObject | null {
  const object = objectAt(
    value,
    path,
    ROLE_KEYS,
    ["id", "requiredCapabilities", "mayProduce", "mayVerify", "mayAccept"],
    issues,
  );
  if (!object) return null;
  stringArray(object.requiredCapabilities, `${path}.requiredCapabilities`, issues);
  booleanAt(object.mayProduce, `${path}.mayProduce`, issues);
  booleanAt(object.mayVerify, `${path}.mayVerify`, issues);
  booleanAt(object.mayAccept, `${path}.mayAccept`, issues);
  return object;
}

function validateChannel(value: unknown, path: string, issues: ProtocolValidationIssue[]): JsonObject | null {
  const object = objectAt(
    value,
    path,
    CHANNEL_KEYS,
    ["id", "allowedIntents", "responderRoleIds"],
    issues,
  );
  if (!object) return null;
  stringArray(object.allowedIntents, `${path}.allowedIntents`, issues, MESSAGE_INTENTS);
  stringArray(object.responderRoleIds, `${path}.responderRoleIds`, issues);
  if ("broadcastRequiresResponse" in object) {
    booleanAt(object.broadcastRequiresResponse, `${path}.broadcastRequiresResponse`, issues);
  }
  return object;
}

function validateContextPack(value: unknown, path: string, issues: ProtocolValidationIssue[]): JsonObject | null {
  const object = objectAt(
    value,
    path,
    CONTEXT_PACK_KEYS,
    ["id", "includeKinds", "excludeKinds"],
    issues,
  );
  if (!object) return null;
  stringArray(object.includeKinds, `${path}.includeKinds`, issues);
  stringArray(object.excludeKinds, `${path}.excludeKinds`, issues);
  if ("maxItems" in object) {
    positiveInteger(object.maxItems, `${path}.maxItems`, "invalid_max_items", issues);
  }
  return object;
}

function validateTransition(value: unknown, path: string, issues: ProtocolValidationIssue[]): JsonObject | null {
  const object = objectAt(
    value,
    path,
    TRANSITION_KEYS,
    ["fromPhaseId", "toPhaseId", "whenGateId"],
    issues,
  );
  if (!object) return null;
  nonEmptyString(object.fromPhaseId, `${path}.fromPhaseId`, issues);
  nonEmptyString(object.toPhaseId, `${path}.toPhaseId`, issues);
  nonEmptyString(object.whenGateId, `${path}.whenGateId`, issues);
  return object;
}

function validateGate(value: unknown, path: string, issues: ProtocolValidationIssue[]): JsonObject | null {
  const object = objectAt(value, path, GATE_KEYS, ["id", "kind", "hard"], issues);
  if (!object) return null;
  enumString(object.kind, GATE_KINDS, `${path}.kind`, "unsupported_gate_kind", issues);
  booleanAt(object.hard, `${path}.hard`, issues);
  if ("evaluatorRoleIds" in object) {
    stringArray(object.evaluatorRoleIds, `${path}.evaluatorRoleIds`, issues);
  }
  if ("evidenceRequirements" in object) {
    stringArray(object.evidenceRequirements, `${path}.evidenceRequirements`, issues);
  }
  return object;
}

function validateRecovery(value: unknown, path: string, issues: ProtocolValidationIssue[]): JsonObject | null {
  const object = objectAt(
    value,
    path,
    RECOVERY_KEYS,
    ["id", "trigger", "action", "maxAttempts"],
    issues,
  );
  if (!object) return null;
  enumString(object.trigger, RECOVERY_TRIGGERS, `${path}.trigger`, "unsupported_recovery_trigger", issues);
  enumString(object.action, RECOVERY_ACTIONS, `${path}.action`, "unsupported_recovery_action", issues);
  positiveInteger(object.maxAttempts, `${path}.maxAttempts`, "invalid_recovery_attempts", issues);
  return object;
}

function validateExit(value: unknown, path: string, issues: ProtocolValidationIssue[]): JsonObject | null {
  const object = objectAt(
    value,
    path,
    EXIT_KEYS,
    ["outcome", "requiredGateIds", "requireIndependentVerifier"],
    issues,
  );
  if (!object) return null;
  enumString(object.outcome, EXIT_OUTCOMES, `${path}.outcome`, "unsupported_exit_outcome", issues);
  stringArray(object.requiredGateIds, `${path}.requiredGateIds`, issues);
  booleanAt(object.requireIndependentVerifier, `${path}.requireIndependentVerifier`, issues);
  if ("allowUnresolvedRiskSeverities" in object) {
    stringArray(
      object.allowUnresolvedRiskSeverities,
      `${path}.allowUnresolvedRiskSeverities`,
      issues,
      RISK_SEVERITIES,
    );
  }
  return object;
}

function idsOf(values: readonly JsonObject[]): Set<string> {
  return new Set(
    values
      .map((value) => value.id)
      .filter((value): value is string => typeof value === "string" && value.length > 0),
  );
}

function checkReferences(
  values: unknown,
  allowed: ReadonlySet<string>,
  path: string,
  issues: ProtocolValidationIssue[],
): void {
  if (!Array.isArray(values)) return;
  values.forEach((value, index) => {
    if (typeof value === "string" && !allowed.has(value)) {
      issue(issues, "invalid_reference", `${path}[${index}]`, `Unknown reference '${value}'`);
    }
  });
}

function reachableFrom(start: string, adjacency: ReadonlyMap<string, readonly string[]>): Set<string> {
  const reachable = new Set<string>();
  const pending = [start];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (reachable.has(current)) continue;
    reachable.add(current);
    for (const next of adjacency.get(current) ?? []) pending.push(next);
  }
  return reachable;
}

function containsCycle(nodes: ReadonlySet<string>, adjacency: ReadonlyMap<string, readonly string[]>): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const next of adjacency.get(node) ?? []) {
      if (nodes.has(next) && visit(next)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  for (const node of nodes) {
    if (visit(node)) return true;
  }
  return false;
}

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

function validateRoomProtocolDefinitionUnchecked(
  input: unknown,
  normalize = true,
): ProtocolValidationResult {
  const issues: ProtocolValidationIssue[] = [];
  const protocol = objectAt(input, "$", PROTOCOL_KEYS, PROTOCOL_KEYS, issues);
  if (!protocol) return { ok: false, issues };

  if (protocol.contractVersion !== 1) {
    issue(
      issues,
      "unsupported_contract_version",
      "$.contractVersion",
      "Only Room protocol contract version 1 is supported",
    );
  }
  nonEmptyString(protocol.id, "$.id", issues);
  positiveInteger(protocol.version, "$.version", "invalid_protocol_version", issues);
  enumString(
    protocol.family,
    new Set<string>(ROOM_PROTOCOL_FAMILIES),
    "$.family",
    "unsupported_protocol_family",
    issues,
  );
  nonEmptyString(protocol.name, "$.name", issues);

  const phases = validateNamedObjects(protocol.phases, "$.phases", issues, validatePhase);
  const roles = validateNamedObjects(protocol.roles, "$.roles", issues, validateRole);
  const channels = validateNamedObjects(protocol.channels, "$.channels", issues, validateChannel);
  const contextPacks = validateNamedObjects(
    protocol.contextPacks,
    "$.contextPacks",
    issues,
    validateContextPack,
  );
  const gates = validateNamedObjects(protocol.gates, "$.gates", issues, validateGate);
  const recoveryActions = validateNamedObjects(
    protocol.recoveryActions,
    "$.recoveryActions",
    issues,
    validateRecovery,
  );
  void recoveryActions;

  const transitionValues = arrayAt(protocol.transitions, "$.transitions", issues) ?? [];
  const transitions = transitionValues
    .map((value, index) => validateTransition(value, `$.transitions[${index}]`, issues))
    .filter((value): value is JsonObject => value !== null);
  const exitValues = arrayAt(protocol.exitConditions, "$.exitConditions", issues) ?? [];
  const exits = exitValues
    .map((value, index) => validateExit(value, `$.exitConditions[${index}]`, issues))
    .filter((value): value is JsonObject => value !== null);

  if (phases.length === 0) issue(issues, "missing_phase", "$.phases", "At least one phase is required");
  if (roles.length === 0) issue(issues, "missing_role", "$.roles", "At least one role is required");
  if (gates.length === 0) issue(issues, "missing_gate", "$.gates", "At least one gate is required");

  const phaseIds = idsOf(phases);
  const roleIds = idsOf(roles);
  const channelIds = idsOf(channels);
  const contextPackIds = idsOf(contextPacks);
  const gateIds = idsOf(gates);
  const phasesById = new Map(
    phases
      .filter((phase): phase is JsonObject & { id: string } => typeof phase.id === "string")
      .map((phase) => [phase.id, phase]),
  );

  phases.forEach((phase, index) => {
    checkReferences(phase.roleIds, roleIds, `$.phases[${index}].roleIds`, issues);
    checkReferences(phase.entryGateIds, gateIds, `$.phases[${index}].entryGateIds`, issues);
    checkReferences(phase.exitGateIds, gateIds, `$.phases[${index}].exitGateIds`, issues);
    checkReferences(phase.channelIds, channelIds, `$.phases[${index}].channelIds`, issues);
    checkReferences(
      phase.contextPackIds,
      contextPackIds,
      `$.phases[${index}].contextPackIds`,
      issues,
    );
  });
  const transitionTargets = new Map<string, string>();
  transitions.forEach((transition, index) => {
    checkReferences([transition.fromPhaseId], phaseIds, `$.transitions[${index}].fromPhaseId`, issues);
    checkReferences([transition.toPhaseId], phaseIds, `$.transitions[${index}].toPhaseId`, issues);
    checkReferences([transition.whenGateId], gateIds, `$.transitions[${index}].whenGateId`, issues);
    if (
      typeof transition.fromPhaseId !== "string" ||
      typeof transition.toPhaseId !== "string" ||
      typeof transition.whenGateId !== "string"
    ) {
      return;
    }
    const sourcePhase = phasesById.get(transition.fromPhaseId);
    const targetPhase = phasesById.get(transition.toPhaseId);
    const transitionKey = JSON.stringify([transition.fromPhaseId, transition.whenGateId]);
    const existingTarget = transitionTargets.get(transitionKey);
    if (existingTarget !== undefined && existingTarget !== transition.toPhaseId) {
      issue(
        issues,
        "ambiguous_transition",
        `$.transitions[${index}]`,
        "A source phase and gate pair must resolve to exactly one target phase",
      );
    } else {
      transitionTargets.set(transitionKey, transition.toPhaseId);
    }
    if (
      sourcePhase &&
      Array.isArray(sourcePhase.exitGateIds) &&
      !sourcePhase.exitGateIds.includes(transition.whenGateId)
    ) {
      issue(
        issues,
        "transition_gate_not_source_exit",
        `$.transitions[${index}].whenGateId`,
        "A transition gate must be declared by the source phase as an exit gate",
      );
    }
    if (
      targetPhase &&
      Array.isArray(targetPhase.entryGateIds) &&
      !targetPhase.entryGateIds.includes(transition.whenGateId)
    ) {
      issue(
        issues,
        "transition_gate_not_target_entry",
        `$.transitions[${index}].whenGateId`,
        "A transition gate must be declared by the target phase as an entry gate",
      );
    }
  });
  channels.forEach((channel, index) => {
    checkReferences(channel.responderRoleIds, roleIds, `$.channels[${index}].responderRoleIds`, issues);
  });
  gates.forEach((gate, index) => {
    checkReferences(gate.evaluatorRoleIds, roleIds, `$.gates[${index}].evaluatorRoleIds`, issues);
  });
  exits.forEach((exit, index) => {
    checkReferences(exit.requiredGateIds, gateIds, `$.exitConditions[${index}].requiredGateIds`, issues);
  });

  const adjacency = new Map<string, string[]>();
  const reverseAdjacency = new Map<string, string[]>();
  for (const phaseId of phaseIds) {
    adjacency.set(phaseId, []);
    reverseAdjacency.set(phaseId, []);
  }
  for (const transition of transitions) {
    const from = transition.fromPhaseId;
    const to = transition.toPhaseId;
    if (typeof from !== "string" || typeof to !== "string" || !phaseIds.has(from) || !phaseIds.has(to)) {
      continue;
    }
    adjacency.get(from)!.push(to);
    reverseAdjacency.get(to)!.push(from);
  }

  const firstPhaseId = phases[0]?.id;
  const reachable = typeof firstPhaseId === "string" ? reachableFrom(firstPhaseId, adjacency) : new Set<string>();
  phases.forEach((phase, index) => {
    if (typeof phase.id === "string" && !reachable.has(phase.id)) {
      issue(issues, "unreachable_phase", `$.phases[${index}].id`, `Phase '${phase.id}' is unreachable`);
    }
  });

  const exitGateIds = new Set<string>();
  for (const exit of exits) {
    if (!Array.isArray(exit.requiredGateIds)) continue;
    for (const gateId of exit.requiredGateIds) {
      if (typeof gateId === "string" && gateIds.has(gateId)) exitGateIds.add(gateId);
    }
  }
  const exitPhaseIds = new Set<string>();
  for (const phase of phases) {
    if (typeof phase.id !== "string" || !Array.isArray(phase.exitGateIds)) continue;
    if (phase.exitGateIds.some((gateId) => typeof gateId === "string" && exitGateIds.has(gateId))) {
      exitPhaseIds.add(phase.id);
    }
  }
  if (exits.length === 0 || exitPhaseIds.size === 0) {
    issue(
      issues,
      "missing_exit_condition",
      "$.exitConditions",
      "A reachable gate-backed exit condition is required",
    );
  }

  const canReachExit = new Set<string>();
  const reversePending = [...exitPhaseIds];
  while (reversePending.length > 0) {
    const current = reversePending.pop()!;
    if (canReachExit.has(current)) continue;
    canReachExit.add(current);
    for (const previous of reverseAdjacency.get(current) ?? []) reversePending.push(previous);
  }
  const noExitPath = new Set([...reachable].filter((phaseId) => !canReachExit.has(phaseId)));
  for (const phaseId of noExitPath) {
    issue(issues, "no_exit_path", "$.transitions", `Reachable phase '${phaseId}' has no path to an exit`);
  }
  if (containsCycle(noExitPath, adjacency)) {
    issue(issues, "cycle_without_exit", "$.transitions", "A reachable cycle has no path to an exit");
  }

  const independentVerifierIds = new Set(
    roles
      .filter((role) => role.mayVerify === true && role.mayProduce === false)
      .map((role) => role.id)
      .filter((id): id is string => typeof id === "string"),
  );
  const gatesById = new Map(
    gates
      .filter((gate): gate is JsonObject & { id: string } => typeof gate.id === "string")
      .map((gate) => [gate.id, gate]),
  );
  exits.forEach((exit, index) => {
    if (exit.requireIndependentVerifier !== true) return;
    const requiredGates = Array.isArray(exit.requiredGateIds) ? exit.requiredGateIds : [];
    const hasIndependentEvaluator = requiredGates.some((gateId) => {
      if (typeof gateId !== "string") return false;
      const evaluatorIds = gatesById.get(gateId)?.evaluatorRoleIds;
      return (
        Array.isArray(evaluatorIds) &&
        evaluatorIds.some(
          (id) =>
            typeof id === "string" &&
            independentVerifierIds.has(id) &&
            phases.some(
              (phase) =>
                Array.isArray(phase.exitGateIds) &&
                phase.exitGateIds.includes(gateId) &&
                Array.isArray(phase.roleIds) &&
                phase.roleIds.includes(id),
            ),
        )
      );
    });
    if (!hasIndependentEvaluator) {
      issue(
        issues,
        "independent_verifier_required",
        `$.exitConditions[${index}]`,
        "This exit requires a non-producing verifier bound to a required gate",
      );
    }
  });

  if (issues.length > 0) return { ok: false, issues };
  if (!normalize) return { ok: true, value: input as RoomProtocolDefinitionV1 };

  const normalized = structuredClone(input);
  const normalizedResult = validateRoomProtocolDefinitionUnchecked(normalized, false);
  if (!normalizedResult.ok) return normalizedResult;
  return { ok: true, value: deepFreeze(normalizedResult.value) };
}

export function validateRoomProtocolDefinition(input: unknown): ProtocolValidationResult {
  try {
    return validateRoomProtocolDefinitionUnchecked(input);
  } catch {
    return {
      ok: false,
      issues: [
        {
          code: "invalid_runtime_value",
          path: "$",
          message: "Protocol validation rejected a value that could not be inspected safely",
        },
      ],
    };
  }
}

function stringMap(
  value: unknown,
  path: string,
  issues: ProtocolValidationIssue[],
): Readonly<Record<string, string>> | null {
  const object = objectAt(value, path, Object.keys(isObject(value) ? value : {}), [], issues);
  if (!object) return null;
  for (const [key, entry] of Object.entries(object)) {
    if (key.trim().length === 0) issue(issues, "invalid_string", `${path}.${key}`, "Map keys cannot be empty");
    nonEmptyString(entry, `${path}.${key}`, issues);
  }
  return object as Readonly<Record<string, string>>;
}

function prefixIssues(
  target: ProtocolValidationIssue[],
  prefix: string,
  source: readonly ProtocolValidationIssue[],
): void {
  for (const entry of source) {
    target.push({ ...entry, path: `${prefix}${entry.path.slice(1)}` });
  }
}

function validateRoomProtocolMigrationUnchecked(input: unknown): ProtocolMigrationValidationResult {
  const issues: ProtocolValidationIssue[] = [];
  const envelope = objectAt(input, "$", MIGRATION_ENVELOPE_KEYS, MIGRATION_ENVELOPE_KEYS, issues);
  if (!envelope) return { ok: false, issues };

  const fromResult = validateRoomProtocolDefinition(envelope.fromProtocol);
  const toResult = validateRoomProtocolDefinition(envelope.toProtocol);
  if (!fromResult.ok) prefixIssues(issues, "$.fromProtocol", fromResult.issues);
  if (!toResult.ok) prefixIssues(issues, "$.toProtocol", toResult.issues);

  const migration = objectAt(
    envelope.migration,
    "$.migration",
    MIGRATION_KEYS,
    MIGRATION_KEYS,
    issues,
  );
  if (!migration) return { ok: false, issues };

  if (migration.contractVersion !== 1) {
    issue(
      issues,
      "unsupported_contract_version",
      "$.migration.contractVersion",
      "Only migration contract version 1 is supported",
    );
  }
  nonEmptyString(migration.protocolId, "$.migration.protocolId", issues);
  positiveInteger(migration.fromVersion, "$.migration.fromVersion", "invalid_protocol_version", issues);
  positiveInteger(migration.toVersion, "$.migration.toVersion", "invalid_protocol_version", issues);
  nonEmptyString(migration.currentPhaseId, "$.migration.currentPhaseId", issues);
  if (migration.activateAt !== "next_turn_boundary") {
    issue(
      issues,
      "mid_turn_migration_forbidden",
      "$.migration.activateAt",
      "Protocol migration may activate only at the next turn boundary",
    );
  }
  const phaseIdMap = stringMap(migration.phaseIdMap, "$.migration.phaseIdMap", issues);
  const roleIdMap = stringMap(migration.roleIdMap, "$.migration.roleIdMap", issues);

  if (!fromResult.ok || !toResult.ok || !phaseIdMap || !roleIdMap) {
    return { ok: false, issues };
  }
  const fromProtocol = fromResult.value;
  const toProtocol = toResult.value;

  if (
    fromProtocol.id !== toProtocol.id ||
    migration.protocolId !== fromProtocol.id ||
    migration.protocolId !== toProtocol.id
  ) {
    issue(
      issues,
      "protocol_identity_mismatch",
      "$.migration.protocolId",
      "Both protocol definitions and the migration plan must share one protocol identity",
    );
  }
  if (
    migration.fromVersion !== fromProtocol.version ||
    migration.toVersion !== toProtocol.version
  ) {
    issue(
      issues,
      "migration_version_mismatch",
      "$.migration",
      "Migration versions must exactly match the source and target definitions",
    );
  }
  if (
    toProtocol.version <= fromProtocol.version ||
    (typeof migration.toVersion === "number" &&
      typeof migration.fromVersion === "number" &&
      migration.toVersion <= migration.fromVersion)
  ) {
    issue(
      issues,
      "non_forward_version",
      "$.migration.toVersion",
      "Protocol migration must move to a strictly newer version",
    );
  }

  const sourcePhaseIds = new Set(fromProtocol.phases.map((phase) => phase.id));
  const targetPhaseIds = new Set(toProtocol.phases.map((phase) => phase.id));
  const sourceRoleIds = new Set(fromProtocol.roles.map((role) => role.id));
  const targetRoleIds = new Set(toProtocol.roles.map((role) => role.id));
  const currentPhaseId = typeof migration.currentPhaseId === "string"
    ? migration.currentPhaseId
    : "";

  for (const sourceId of sourcePhaseIds) {
    if (!Object.prototype.hasOwnProperty.call(phaseIdMap, sourceId)) {
      issue(
        issues,
        sourceId === currentPhaseId ? "unmapped_active_phase" : "incomplete_phase_mapping",
        `$.migration.phaseIdMap.${sourceId}`,
        `Source phase '${sourceId}' is not mapped`,
      );
    }
  }
  for (const [sourceId, targetId] of Object.entries(phaseIdMap)) {
    if (!sourcePhaseIds.has(sourceId) || !targetPhaseIds.has(targetId)) {
      issue(
        issues,
        "invalid_migration_reference",
        `$.migration.phaseIdMap.${sourceId}`,
        `Phase mapping '${sourceId}' -> '${targetId}' is not valid in the source and target protocols`,
      );
    }
  }
  if (!sourcePhaseIds.has(currentPhaseId)) {
    issue(
      issues,
      "invalid_migration_reference",
      "$.migration.currentPhaseId",
      "The active phase does not exist in the source protocol",
    );
  } else if (!Object.prototype.hasOwnProperty.call(phaseIdMap, currentPhaseId)) {
    issue(
      issues,
      "unmapped_active_phase",
      "$.migration.currentPhaseId",
      "The active phase must have an explicit target mapping",
    );
  }

  for (const sourceId of sourceRoleIds) {
    if (!Object.prototype.hasOwnProperty.call(roleIdMap, sourceId)) {
      issue(
        issues,
        "incomplete_role_mapping",
        `$.migration.roleIdMap.${sourceId}`,
        `Source role '${sourceId}' is not mapped`,
      );
    }
  }
  for (const [sourceId, targetId] of Object.entries(roleIdMap)) {
    if (!sourceRoleIds.has(sourceId) || !targetRoleIds.has(targetId)) {
      issue(
        issues,
        "invalid_migration_reference",
        `$.migration.roleIdMap.${sourceId}`,
        `Role mapping '${sourceId}' -> '${targetId}' is not valid in the source and target protocols`,
      );
    }
  }

  if (new Set(Object.values(phaseIdMap)).size !== Object.values(phaseIdMap).length) {
    issue(issues, "non_injective_phase_mapping", "$.migration.phaseIdMap", "Phase mappings must not merge runtime phases");
  }
  if (new Set(Object.values(roleIdMap)).size !== Object.values(roleIdMap).length) {
    issue(issues, "non_injective_role_mapping", "$.migration.roleIdMap", "Role mappings must not merge authority roles");
  }

  const sourcePhasesById = new Map(fromProtocol.phases.map((phase) => [phase.id, phase]));
  const targetPhasesById = new Map(toProtocol.phases.map((phase) => [phase.id, phase]));
  for (const [sourcePhaseId, targetPhaseId] of Object.entries(phaseIdMap)) {
    const sourcePhase = sourcePhasesById.get(sourcePhaseId);
    const targetPhase = targetPhasesById.get(targetPhaseId);
    if (!sourcePhase || !targetPhase) continue;
    for (const sourceRoleId of sourcePhase.roleIds) {
      const targetRoleId = roleIdMap[sourceRoleId];
      if (targetRoleId !== undefined && !targetPhase.roleIds.includes(targetRoleId)) {
        issue(
          issues,
          "phase_role_mapping_mismatch",
          `$.migration.phaseIdMap.${sourcePhaseId}`,
          `Mapped role '${targetRoleId}' is not a member of target phase '${targetPhaseId}'`,
        );
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      protocolId: fromProtocol.id,
      fromVersion: fromProtocol.version,
      toVersion: toProtocol.version,
      nextPhaseId: phaseIdMap[currentPhaseId]!,
    },
  };
}

export function validateRoomProtocolMigration(input: unknown): ProtocolMigrationValidationResult {
  try {
    return validateRoomProtocolMigrationUnchecked(input);
  } catch {
    return {
      ok: false,
      issues: [
        {
          code: "invalid_runtime_value",
          path: "$",
          message: "Protocol migration validation rejected a value that could not be inspected safely",
        },
      ],
    };
  }
}

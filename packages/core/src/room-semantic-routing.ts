import { types as utilTypes } from "node:util";

import type { RoomMessageIntent } from "./room-contracts/controller.js";
import type { RoomProtocolDefinitionV1 } from "./room-contracts/protocol.js";
import type { RoomProtocolMessageV1 } from "./room-contracts/protocol-message.js";
import { validateRoomProtocolMessage } from "./room-contracts/protocol-message.js";
import { hashRoomValue } from "./room-integrity.js";
import { validateRoomProtocolDefinition } from "./room-protocol-schema.js";

export interface RoomSemanticRoutingSeatV1 {
  readonly seatId: string;
  readonly bindingId: string;
  readonly roleId: string;
  readonly groupIds: readonly string[];
}

export interface RoomSemanticHistoryEntryV1 {
  readonly messageId: string;
  readonly sequence: number;
  readonly nodeId: string;
  readonly intent: RoomMessageIntent;
  readonly semanticHash: string;
  readonly evidenceStateHash: string;
  readonly decisionStateHash: string;
}

export interface RouteRoomSemanticMessageInputV1 {
  readonly message: unknown;
  readonly protocol: unknown;
  readonly seats: readonly RoomSemanticRoutingSeatV1[];
  readonly history: readonly RoomSemanticHistoryEntryV1[];
  /** Controller/evaluator-owned state; peer message hashes are checked against it. */
  readonly authoritativeState: {
    readonly semanticHash: string;
    readonly evidenceStateHash: string;
    readonly decisionStateHash: string;
  };
  readonly semanticRepeatLimit?: number;
}

export interface RoomSemanticRoutingIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface RoomSemanticRoutingAuditV1 {
  readonly outcome: "route" | "loop_break";
  readonly messageFingerprint: string;
  readonly targetFingerprint: string;
  readonly semanticHash: string;
  readonly evidenceStateHash: string;
  readonly decisionStateHash: string;
  readonly repeatedSemanticCount: number;
  readonly recipientCount: number;
  readonly requiredResponderCount: number;
}

export interface RoomSemanticRouteV1 {
  readonly outcome: "route";
  readonly messageId: string;
  readonly issuedAt: string;
  readonly roomId: string;
  readonly turnId: string;
  readonly nodeId: string;
  readonly intent: RoomMessageIntent;
  readonly recipientController: boolean;
  readonly recipientSeatIds: readonly string[];
  readonly requiredControllerResponse: boolean;
  readonly requiredResponderSeatIds: readonly string[];
  readonly audit: RoomSemanticRoutingAuditV1;
}

export interface RoomSemanticLoopBreakV1 {
  readonly outcome: "loop_break";
  readonly messageId: string;
  readonly roomId: string;
  readonly turnId: string;
  readonly nodeId: string;
  readonly escalation: {
    readonly intent: "help_request";
    readonly target: { readonly kind: "controller" };
    readonly parentMessageId: string;
    readonly reasonCode: "semantic_loop";
    readonly semanticStateFingerprint: string;
  };
  readonly audit: RoomSemanticRoutingAuditV1;
}

export type RoomSemanticRoutingResult =
  | { readonly ok: true; readonly value: RoomSemanticRouteV1 | RoomSemanticLoopBreakV1 }
  | { readonly ok: false; readonly issues: readonly RoomSemanticRoutingIssue[] };

function reject(code: string, path: string, message: string): RoomSemanticRoutingResult {
  return { ok: false, issues: Object.freeze([Object.freeze({ code, path, message })]) };
}

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MESSAGE_INTENTS = new Set<RoomMessageIntent>([
  "instruction",
  "proposal",
  "question",
  "critique",
  "challenge",
  "verdict",
  "handoff",
  "help_request",
]);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value, seen);
  }
  return Object.freeze(value);
}

function parseRecord(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[] = allowedKeys,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain data object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
    throw new TypeError(`${path} contains a symbol key`);
  }
  const keys = Object.keys(descriptors);
  if (
    keys.some((key) => !allowedKeys.includes(key))
    || requiredKeys.some((key) => !Object.hasOwn(descriptors, key))
    || keys.some((key) => !descriptors[key]?.enumerable || !("value" in descriptors[key]!))
  ) {
    throw new TypeError(`${path} has an invalid shape`);
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]!.value]));
}

function parseArray(value: unknown, path: string, limit: number): readonly unknown[] {
  if (
    !Array.isArray(value)
    || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > limit
  ) throw new TypeError(`${path} must be a bounded plain array`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(`${path} must not be sparse or accessor-backed`);
    }
  }
  const allowedKeys = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowedKeys.has(key))) {
    throw new TypeError(`${path} has extra keys`);
  }
  return Array.from({ length: value.length }, (_, index) => descriptors[String(index)]!.value);
}

function parseIdentifier(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.trim() !== value) {
    throw new TypeError(`${path} must be a bounded nonblank identifier`);
  }
  return value;
}

function parseHash(value: unknown, path: string): string {
  const result = parseIdentifier(value, path);
  if (!HASH_PATTERN.test(result)) throw new TypeError(`${path} must be a canonical hash`);
  return result;
}

function normalizeRoutingInputs(input: unknown): {
  readonly message: unknown;
  readonly protocol: unknown;
  readonly seats: readonly RoomSemanticRoutingSeatV1[];
  readonly history: readonly RoomSemanticHistoryEntryV1[];
  readonly authoritativeState: RouteRoomSemanticMessageInputV1["authoritativeState"];
  readonly semanticRepeatLimit: number;
} {
  const record = parseRecord(
    input,
    "$",
    ["message", "protocol", "seats", "history", "authoritativeState", "semanticRepeatLimit"],
    ["message", "protocol", "seats", "history", "authoritativeState"],
  );
  const seats = parseArray(record.seats, "$.seats", 256).map((rawSeat, index) => {
    const seat = parseRecord(rawSeat, `$.seats[${index}]`, ["seatId", "bindingId", "roleId", "groupIds"]);
    const groupIds = parseArray(seat.groupIds, `$.seats[${index}].groupIds`, 64)
      .map((groupId, groupIndex) => parseIdentifier(groupId, `$.seats[${index}].groupIds[${groupIndex}]`))
      .sort(compareText);
    if (new Set(groupIds).size !== groupIds.length) throw new TypeError("Seat groups must be unique");
    return {
      seatId: parseIdentifier(seat.seatId, `$.seats[${index}].seatId`),
      bindingId: parseIdentifier(seat.bindingId, `$.seats[${index}].bindingId`),
      roleId: parseIdentifier(seat.roleId, `$.seats[${index}].roleId`),
      groupIds,
    };
  });
  seats.sort((left, right) => compareText(left.seatId, right.seatId));
  if (
    new Set(seats.map((seat) => seat.seatId)).size !== seats.length
    || new Set(seats.map((seat) => seat.bindingId)).size !== seats.length
  ) {
    throw new TypeError("Routing seats and bindings must be unique");
  }
  const history = parseArray(record.history, "$.history", 256).map((rawEntry, index) => {
    const entry = parseRecord(rawEntry, `$.history[${index}]`, [
      "messageId",
      "sequence",
      "nodeId",
      "intent",
      "semanticHash",
      "evidenceStateHash",
      "decisionStateHash",
    ]);
    if (typeof entry.intent !== "string" || !MESSAGE_INTENTS.has(entry.intent as RoomMessageIntent)) {
      throw new TypeError(`$.history[${index}].intent is invalid`);
    }
    if (!Number.isSafeInteger(entry.sequence) || (entry.sequence as number) <= 0) {
      throw new TypeError(`$.history[${index}].sequence is invalid`);
    }
    return {
      messageId: parseIdentifier(entry.messageId, `$.history[${index}].messageId`),
      sequence: entry.sequence as number,
      nodeId: parseIdentifier(entry.nodeId, `$.history[${index}].nodeId`),
      intent: entry.intent as RoomMessageIntent,
      semanticHash: parseHash(entry.semanticHash, `$.history[${index}].semanticHash`),
      evidenceStateHash: parseHash(entry.evidenceStateHash, `$.history[${index}].evidenceStateHash`),
      decisionStateHash: parseHash(entry.decisionStateHash, `$.history[${index}].decisionStateHash`),
    };
  }).sort((left, right) => left.sequence - right.sequence || compareText(left.messageId, right.messageId));
  if (
    new Set(history.map((entry) => entry.messageId)).size !== history.length
    || new Set(history.map((entry) => entry.sequence)).size !== history.length
  ) {
    throw new TypeError("History message identities and sequences must be unique");
  }
  const rawAuthoritativeState = parseRecord(record.authoritativeState, "$.authoritativeState", [
    "semanticHash",
    "evidenceStateHash",
    "decisionStateHash",
  ]);
  const authoritativeState = {
    semanticHash: parseHash(rawAuthoritativeState.semanticHash, "$.authoritativeState.semanticHash"),
    evidenceStateHash: parseHash(rawAuthoritativeState.evidenceStateHash, "$.authoritativeState.evidenceStateHash"),
    decisionStateHash: parseHash(rawAuthoritativeState.decisionStateHash, "$.authoritativeState.decisionStateHash"),
  };
  const semanticRepeatLimit = record.semanticRepeatLimit === undefined ? 2 : record.semanticRepeatLimit;
  if (!Number.isSafeInteger(semanticRepeatLimit) || (semanticRepeatLimit as number) < 2 || (semanticRepeatLimit as number) > 16) {
    throw new TypeError("semanticRepeatLimit must be an integer between 2 and 16");
  }
  return deepFreeze({
    message: record.message,
    protocol: record.protocol,
    seats,
    history,
    authoritativeState,
    semanticRepeatLimit: semanticRepeatLimit as number,
  });
}

function appendUnique(target: string[], values: readonly string[], excludedSeatId: string): void {
  for (const value of values) {
    if (value !== excludedSeatId && !target.includes(value)) target.push(value);
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function bindMessageAuthority(message: RoomProtocolMessageV1): RoomSemanticRoutingResult | null {
  const authority = message.authority;
  if (
    authority.actorType !== "seat"
    || authority.actorId !== message.origin.seatId
    || authority.role !== message.origin.roleId
    || authority.projectId !== message.projectId
    || authority.roomId !== message.roomId
    || !authority.allowedActions.includes("room:message:route")
    || !authority.nodeIds.includes(message.nodeId)
    || !authority.seatIds.includes(message.origin.seatId)
    || !sameStrings(authority.evidenceRefs, message.references.evidenceRefs)
  ) {
    return reject(
      "authority_binding_mismatch",
      "$.message.authority",
      "Message authority does not bind the exact origin and Room context",
    );
  }
  return null;
}

function findProtocolContext(
  message: RoomProtocolMessageV1,
  protocol: RoomProtocolDefinitionV1,
):
  | {
      readonly phase: RoomProtocolDefinitionV1["phases"][number];
      readonly channel: RoomProtocolDefinitionV1["channels"][number];
    }
  | RoomSemanticRoutingResult {
  if (message.protocolId !== protocol.id || message.protocolVersion !== protocol.version) {
    return reject(
      "protocol_binding_mismatch",
      "$.message.protocolVersion",
      "Message protocol identity does not match the supplied versioned protocol",
    );
  }
  const phase = protocol.phases.find((candidate) => candidate.id === message.phaseId);
  if (!phase) return reject("unknown_phase", "$.message.phaseId", "Message phase is not in the protocol");
  const channel = protocol.channels.find((candidate) => candidate.id === message.channelId);
  if (!channel || !phase.channelIds?.includes(channel.id)) {
    return reject(
      "channel_phase_mismatch",
      "$.message.channelId",
      "Message channel is not enabled in the bound phase",
    );
  }
  if (!phase.roleIds.includes(message.origin.roleId)) {
    return reject(
      "origin_role_phase_mismatch",
      "$.message.origin.roleId",
      "Origin role is not active in the bound phase",
    );
  }
  if (!channel.allowedIntents.includes(message.intent)) {
    return reject(
      "intent_not_allowed",
      "$.message.intent",
      "Message intent is not allowed by the bound channel",
    );
  }
  return { phase, channel };
}

/*
FNXC:SessionRoomSemanticRouting 2026-07-18-13:25:
Semantic routing is a provider-neutral pure policy. It binds the validated
message to one protocol version, phase, channel, active origin binding, exact
targets, and authority snapshot before returning detached hash-only routing
metadata; it does not persist, send, or advance a controller.
*/
export function routeRoomSemanticMessage(
  input: RouteRoomSemanticMessageInputV1,
): RoomSemanticRoutingResult {
  let runtimeInput: ReturnType<typeof normalizeRoutingInputs>;
  try {
    runtimeInput = normalizeRoutingInputs(input as unknown);
  } catch {
    return reject("invalid_routing_input", "$", "Semantic routing input failed bounded runtime validation");
  }
  const messageResult = validateRoomProtocolMessage(runtimeInput.message);
  if (!messageResult.ok) return { ok: false, issues: messageResult.issues };
  const message = messageResult.value;
  if (
    message.semanticHash !== runtimeInput.authoritativeState.semanticHash
    || message.evidenceStateHash !== runtimeInput.authoritativeState.evidenceStateHash
    || message.decisionStateHash !== runtimeInput.authoritativeState.decisionStateHash
  ) {
    return reject(
      "semantic_state_authority_mismatch",
      "$.authoritativeState",
      "Peer semantic/evidence/decision state does not match controller-owned state",
    );
  }

  const protocolResult = validateRoomProtocolDefinition(runtimeInput.protocol);
  if (!protocolResult.ok) {
    return reject("invalid_protocol", "$.protocol", "Supplied protocol failed runtime validation");
  }
  const context = findProtocolContext(message, protocolResult.value);
  if ("ok" in context) return context;
  const authorityFailure = bindMessageAuthority(message);
  if (authorityFailure) return authorityFailure;

  const origin = runtimeInput.seats.find((seat) => seat.seatId === message.origin.seatId);
  if (
    !origin
    || origin.bindingId !== message.origin.bindingId
    || origin.roleId !== message.origin.roleId
  ) {
    return reject(
      "origin_binding_mismatch",
      "$.message.origin",
      "Origin seat, binding, and role must match one active routing seat",
    );
  }

  let recipientController = false;
  let selectedSeatIds: readonly string[] = [];
  switch (message.target.kind) {
    case "controller":
      recipientController = true;
      break;
    case "all":
      selectedSeatIds = runtimeInput.seats.map((seat) => seat.seatId);
      break;
    case "group":
      selectedSeatIds = runtimeInput.seats
        .filter((seat) => seat.groupIds.includes(message.target.kind === "group" ? message.target.groupId : ""))
        .map((seat) => seat.seatId);
      if (selectedSeatIds.length === 0) {
        return reject("unknown_target_group", "$.message.target", "Target group has no active seats");
      }
      break;
    case "seats":
      selectedSeatIds = [...message.target.seatIds].sort(compareText);
      if (selectedSeatIds.some((seatId) => !runtimeInput.seats.some((seat) => seat.seatId === seatId))) {
        return reject("unknown_target_seat", "$.message.target", "Target contains an unknown seat");
      }
      break;
  }
  const outOfScopeTarget = selectedSeatIds.find((seatId) =>
    seatId !== message.origin.seatId && !message.authority.seatIds.includes(seatId));
  if (outOfScopeTarget) {
    return reject(
      "target_authority_scope_mismatch",
      "$.message.target",
      "Message target exceeds the authority envelope seat scope",
    );
  }
  if (message.intent === "challenge" && !["group", "seats"].includes(message.target.kind)) {
    return reject(
      "challenge_target_required",
      "$.message.target",
      "A challenge requires explicit seats or a bounded group target",
    );
  }

  const responderSeatIds = runtimeInput.seats
    .filter((seat) => context.channel.responderRoleIds.includes(seat.roleId))
    .map((seat) => seat.seatId);
  const recipientSeatIds: string[] = [];
  appendUnique(recipientSeatIds, selectedSeatIds, message.origin.seatId);
  if (message.intent === "challenge") {
    appendUnique(recipientSeatIds, responderSeatIds, message.origin.seatId);
  }
  const requiredResponderSeatIds = message.intent === "challenge"
    || (message.target.kind === "all" && context.channel.broadcastRequiresResponse === true)
    ? [...recipientSeatIds]
    : recipientSeatIds.filter((seatId) => responderSeatIds.includes(seatId));

  let repeatedSemanticCount = 1;
  for (let index = runtimeInput.history.length - 1; index >= 0; index -= 1) {
    const entry = runtimeInput.history[index]!;
    if (
      entry.nodeId !== message.nodeId
      || entry.intent !== message.intent
      || entry.semanticHash !== runtimeInput.authoritativeState.semanticHash
      || entry.evidenceStateHash !== runtimeInput.authoritativeState.evidenceStateHash
      || entry.decisionStateHash !== runtimeInput.authoritativeState.decisionStateHash
    ) break;
    repeatedSemanticCount += 1;
  }
  const loopBreak = repeatedSemanticCount >= runtimeInput.semanticRepeatLimit;

  const canonicalTarget = message.target.kind === "seats"
    ? { kind: "seats" as const, seatIds: [...message.target.seatIds].sort(compareText) }
    : message.target;

  const safeFingerprintInput = {
    contractVersion: message.contractVersion,
    messageId: message.messageId,
    issuedAt: message.issuedAt,
    protocolId: message.protocolId,
    protocolVersion: message.protocolVersion,
    phaseId: message.phaseId,
    channelId: message.channelId,
    projectId: message.projectId,
    roomId: message.roomId,
    turnId: message.turnId,
    nodeId: message.nodeId,
    origin: message.origin,
    target: canonicalTarget,
    intent: message.intent,
    contentHash: message.contentHash,
    semanticHash: message.semanticHash,
    evidenceStateHash: message.evidenceStateHash,
    decisionStateHash: message.decisionStateHash,
    references: message.references,
    authority: message.authority,
  };
  const audit: RoomSemanticRoutingAuditV1 = Object.freeze({
    outcome: loopBreak ? "loop_break" : "route",
    messageFingerprint: hashRoomValue(safeFingerprintInput),
    targetFingerprint: hashRoomValue(canonicalTarget),
    semanticHash: message.semanticHash,
    evidenceStateHash: message.evidenceStateHash,
    decisionStateHash: message.decisionStateHash,
    repeatedSemanticCount,
    recipientCount: loopBreak ? 1 : recipientSeatIds.length + (recipientController ? 1 : 0),
    requiredResponderCount: loopBreak ? 1 : requiredResponderSeatIds.length + (recipientController ? 1 : 0),
  });
  if (loopBreak) {
    return {
      ok: true,
      value: deepFreeze({
        outcome: "loop_break",
        messageId: message.messageId,
        roomId: message.roomId,
        turnId: message.turnId,
        nodeId: message.nodeId,
        escalation: {
          intent: "help_request",
          target: { kind: "controller" },
          parentMessageId: message.messageId,
          reasonCode: "semantic_loop",
          semanticStateFingerprint: hashRoomValue({
            nodeId: message.nodeId,
            intent: message.intent,
            semanticHash: message.semanticHash,
            evidenceStateHash: message.evidenceStateHash,
            decisionStateHash: message.decisionStateHash,
          }),
        },
        audit,
      }),
    };
  }
  return {
    ok: true,
    value: deepFreeze({
      outcome: "route",
      messageId: message.messageId,
      issuedAt: message.issuedAt,
      roomId: message.roomId,
      turnId: message.turnId,
      nodeId: message.nodeId,
      intent: message.intent,
      recipientController,
      recipientSeatIds: Object.freeze(recipientSeatIds),
      requiredControllerResponse: recipientController
        && ["question", "help_request"].includes(message.intent),
      requiredResponderSeatIds,
      audit,
    }),
  };
}

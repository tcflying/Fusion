import { types as utilTypes } from "node:util";

import type {
  RoomAuthorityEnvelopeV1,
  RoomMessageIntent,
  RoomMessageTargetV1,
} from "./controller.js";
import type {
  ContentHash,
  IsoTimestamp,
  ProjectId,
  RoomBindingId,
  RoomId,
  RoomProtocolId,
  RoomSeatId,
  RoomTaskNodeId,
  RoomTurnId,
} from "./ids.js";
import { hashRoomValue } from "../room-integrity.js";

export const ROOM_PROTOCOL_MESSAGE_VERSION = "room-protocol-message/v1" as const;

/** Parser budgets use JavaScript UTF-16 code units. */
export const ROOM_PROTOCOL_MESSAGE_BOUNDS = Object.freeze({
  maxObjectFields: 32,
  maxArrayItems: 256,
  maxReferenceItems: 64,
  maxIdentifierLength: 256,
  maxReferenceLength: 512,
  maxContentLength: 65_536,
} as const);

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
const ACTOR_TYPES = new Set(["human", "controller", "seat", "system", "evolution"]);
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export interface RoomProtocolMessageOriginV1 {
  readonly seatId: RoomSeatId;
  readonly bindingId: RoomBindingId;
  readonly roleId: string;
}

export interface RoomProtocolMessageReferencesV1 {
  readonly evidenceRefs: readonly string[];
  readonly parentMessageIds: readonly string[];
  readonly resolutionRefs: readonly string[];
}

export interface RoomProtocolMessageV1 {
  readonly contractVersion: typeof ROOM_PROTOCOL_MESSAGE_VERSION;
  readonly messageId: string;
  readonly issuedAt: IsoTimestamp;
  readonly protocolId: RoomProtocolId;
  readonly protocolVersion: number;
  readonly phaseId: string;
  readonly channelId: string;
  readonly projectId: ProjectId;
  readonly roomId: RoomId;
  readonly turnId: RoomTurnId;
  readonly nodeId: RoomTaskNodeId;
  readonly origin: RoomProtocolMessageOriginV1;
  readonly target: RoomMessageTargetV1;
  readonly intent: RoomMessageIntent;
  readonly content: string;
  readonly contentHash: ContentHash;
  readonly semanticHash: ContentHash;
  readonly evidenceStateHash: ContentHash;
  readonly decisionStateHash: ContentHash;
  readonly authority: RoomAuthorityEnvelopeV1;
  readonly references: RoomProtocolMessageReferencesV1;
}

export interface RoomProtocolMessageValidationIssue {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export type RoomProtocolMessageValidationResult =
  | { readonly ok: true; readonly value: RoomProtocolMessageV1 }
  | { readonly ok: false; readonly issues: readonly RoomProtocolMessageValidationIssue[] };

type DataFields = ReadonlyMap<string, PropertyDescriptor>;

class MessageParseError extends Error {
  public constructor(
    public readonly code: string,
    public readonly path: string,
    message: string,
  ) {
    super(message);
  }
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

function inspectObject(
  value: unknown,
  path: string,
  required: readonly string[],
): DataFields {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new MessageParseError("invalid_runtime_value", path, "Expected a plain data object");
  }
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    keys = Reflect.ownKeys(value);
  } catch {
    throw new MessageParseError("invalid_runtime_value", path, "Runtime value cannot be inspected safely");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new MessageParseError("invalid_runtime_value", path, "Expected a plain data object");
  }
  if (keys.length > ROOM_PROTOCOL_MESSAGE_BOUNDS.maxObjectFields) {
    throw new MessageParseError("bounded_input_exceeded", path, "Object field limit exceeded");
  }
  const allowed = new Set(required);
  const fields = new Map<string, PropertyDescriptor>();
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new MessageParseError("unknown_field", path, "Unknown or symbol-keyed field");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new MessageParseError(
        "invalid_runtime_value",
        `${path}.${key}`,
        "Fields must be enumerable data properties",
      );
    }
    fields.set(key, descriptor);
  }
  for (const key of required) {
    if (!fields.has(key)) {
      throw new MessageParseError("missing_field", `${path}.${key}`, "Missing required field");
    }
  }
  return fields;
}

function field(fields: DataFields, key: string, path: string): unknown {
  const descriptor = fields.get(key);
  if (!descriptor || !("value" in descriptor)) {
    throw new MessageParseError("missing_field", `${path}.${key}`, "Missing required field");
  }
  return descriptor.value;
}

function parseString(value: unknown, path: string, maxLength: number, allowEmpty = false): string {
  if (
    typeof value !== "string"
    || value.length > maxLength
    || (!allowEmpty && value.trim().length === 0)
  ) {
    throw new MessageParseError("invalid_string", path, "Expected a bounded string");
  }
  return value;
}

function parseIdentifier(value: unknown, path: string): string {
  return parseString(value, path, ROOM_PROTOCOL_MESSAGE_BOUNDS.maxIdentifierLength);
}

function parseHash(value: unknown, path: string): string {
  const hash = parseIdentifier(value, path);
  if (!HASH_PATTERN.test(hash)) {
    throw new MessageParseError("invalid_hash", path, "Expected a canonical SHA-256 digest");
  }
  return hash;
}

function parseTimestamp(value: unknown, path: string): string {
  const timestamp = parseIdentifier(value, path);
  const epoch = Date.parse(timestamp);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== timestamp) {
    throw new MessageParseError(
      "invalid_timestamp",
      path,
      "Expected a canonical UTC ISO timestamp",
    );
  }
  return timestamp;
}

function inspectArray(value: unknown, path: string, limit: number): readonly unknown[] {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || !Array.isArray(value)) {
    throw new MessageParseError("invalid_runtime_value", path, "Expected a dense plain array");
  }
  let prototype: object | null;
  let lengthDescriptor: PropertyDescriptor | undefined;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    keys = Reflect.ownKeys(value);
  } catch {
    throw new MessageParseError("invalid_runtime_value", path, "Array cannot be inspected safely");
  }
  if (
    prototype !== Array.prototype
    || !lengthDescriptor
    || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
  ) {
    throw new MessageParseError("invalid_runtime_value", path, "Expected a plain array");
  }
  const length = lengthDescriptor.value as number;
  if (length < 0 || length > limit) {
    throw new MessageParseError("bounded_input_exceeded", path, "Array item limit exceeded");
  }
  if (keys.length !== length + 1 || keys.some((key) => typeof key !== "string")) {
    throw new MessageParseError("sparse_array", path, "Array must be dense and contain no extra fields");
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new MessageParseError("sparse_array", path, "Array must contain data entries");
    }
    result.push(descriptor.value);
  }
  return result;
}

function parseStringArray(
  value: unknown,
  path: string,
  limit: number = ROOM_PROTOCOL_MESSAGE_BOUNDS.maxReferenceItems,
): readonly string[] {
  const entries = inspectArray(value, path, limit).map((entry, index) =>
    parseString(entry, `${path}[${index}]`, ROOM_PROTOCOL_MESSAGE_BOUNDS.maxReferenceLength));
  if (new Set(entries).size !== entries.length) {
    throw new MessageParseError("duplicate_reference", path, "Array entries must be unique");
  }
  return Object.freeze(entries);
}

function parseOrigin(value: unknown): RoomProtocolMessageOriginV1 {
  const fields = inspectObject(value, "$.origin", ["seatId", "bindingId", "roleId"]);
  return Object.freeze({
    seatId: parseIdentifier(field(fields, "seatId", "$.origin"), "$.origin.seatId"),
    bindingId: parseIdentifier(field(fields, "bindingId", "$.origin"), "$.origin.bindingId"),
    roleId: parseIdentifier(field(fields, "roleId", "$.origin"), "$.origin.roleId"),
  });
}

function parseTarget(value: unknown): RoomMessageTargetV1 {
  const baseFields = inspectObjectWithAlternatives(value, "$.target", ["kind"]);
  const kind = parseIdentifier(field(baseFields, "kind", "$.target"), "$.target.kind");
  switch (kind) {
    case "controller":
    case "all":
      assertKeys(baseFields, ["kind"], "$.target");
      return Object.freeze({ kind });
    case "group": {
      assertKeys(baseFields, ["kind", "groupId"], "$.target");
      return Object.freeze({
        kind,
        groupId: parseIdentifier(field(baseFields, "groupId", "$.target"), "$.target.groupId"),
      });
    }
    case "seats": {
      assertKeys(baseFields, ["kind", "seatIds"], "$.target");
      const seatIds = parseStringArray(
        field(baseFields, "seatIds", "$.target"),
        "$.target.seatIds",
        ROOM_PROTOCOL_MESSAGE_BOUNDS.maxArrayItems,
      );
      if (seatIds.length === 0) {
        throw new MessageParseError("invalid_target", "$.target.seatIds", "Seat target cannot be empty");
      }
      return Object.freeze({ kind, seatIds });
    }
    default:
      throw new MessageParseError("invalid_target", "$.target.kind", "Unsupported target kind");
  }
}

function inspectObjectWithAlternatives(value: unknown, path: string, minimum: readonly string[]): DataFields {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new MessageParseError("invalid_runtime_value", path, "Expected a plain data object");
  }
  let keys: readonly PropertyKey[];
  let prototype: object | null;
  try {
    keys = Reflect.ownKeys(value);
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch {
    throw new MessageParseError("invalid_runtime_value", path, "Runtime value cannot be inspected safely");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new MessageParseError("invalid_runtime_value", path, "Expected a plain data object");
  }
  if (keys.length > ROOM_PROTOCOL_MESSAGE_BOUNDS.maxObjectFields) {
    throw new MessageParseError("bounded_input_exceeded", path, "Object field limit exceeded");
  }
  const fields = new Map<string, PropertyDescriptor>();
  for (const key of keys) {
    if (typeof key !== "string") {
      throw new MessageParseError("unknown_field", path, "Symbol-keyed fields are not supported");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new MessageParseError("invalid_runtime_value", `${path}.${key}`, "Expected a data field");
    }
    fields.set(key, descriptor);
  }
  for (const key of minimum) {
    if (!fields.has(key)) throw new MessageParseError("missing_field", `${path}.${key}`, "Missing field");
  }
  return fields;
}

function assertKeys(fields: DataFields, expected: readonly string[], path: string): void {
  const allowed = new Set(expected);
  if (fields.size !== expected.length || [...fields.keys()].some((key) => !allowed.has(key))) {
    throw new MessageParseError("unknown_field", path, "Object fields do not match the target variant");
  }
}

function parseAuthority(value: unknown): RoomAuthorityEnvelopeV1 {
  const path = "$.authority";
  const fields = inspectObject(value, path, [
    "actorType",
    "actorId",
    "deviceId",
    "role",
    "allowedActions",
    "projectId",
    "roomId",
    "nodeIds",
    "seatIds",
    "evidenceRefs",
  ]);
  const actorType = parseIdentifier(field(fields, "actorType", path), `${path}.actorType`);
  if (!ACTOR_TYPES.has(actorType)) {
    throw new MessageParseError("unsupported_actor_type", `${path}.actorType`, "Unsupported actor type");
  }
  const deviceValue = field(fields, "deviceId", path);
  return Object.freeze({
    actorType: actorType as RoomAuthorityEnvelopeV1["actorType"],
    actorId: parseIdentifier(field(fields, "actorId", path), `${path}.actorId`),
    deviceId: deviceValue === null ? null : parseIdentifier(deviceValue, `${path}.deviceId`),
    role: parseIdentifier(field(fields, "role", path), `${path}.role`),
    allowedActions: parseStringArray(field(fields, "allowedActions", path), `${path}.allowedActions`),
    projectId: parseIdentifier(field(fields, "projectId", path), `${path}.projectId`),
    roomId: parseIdentifier(field(fields, "roomId", path), `${path}.roomId`),
    nodeIds: parseStringArray(field(fields, "nodeIds", path), `${path}.nodeIds`),
    seatIds: parseStringArray(
      field(fields, "seatIds", path),
      `${path}.seatIds`,
      ROOM_PROTOCOL_MESSAGE_BOUNDS.maxArrayItems,
    ),
    evidenceRefs: parseStringArray(field(fields, "evidenceRefs", path), `${path}.evidenceRefs`),
  });
}

function parseReferences(value: unknown): RoomProtocolMessageReferencesV1 {
  const path = "$.references";
  const fields = inspectObject(value, path, ["evidenceRefs", "parentMessageIds", "resolutionRefs"]);
  return Object.freeze({
    evidenceRefs: parseStringArray(field(fields, "evidenceRefs", path), `${path}.evidenceRefs`),
    parentMessageIds: parseStringArray(field(fields, "parentMessageIds", path), `${path}.parentMessageIds`),
    resolutionRefs: parseStringArray(field(fields, "resolutionRefs", path), `${path}.resolutionRefs`),
  });
}

function parseMessage(input: unknown): RoomProtocolMessageV1 {
  const path = "$";
  const fields = inspectObject(input, path, [
    "contractVersion",
    "messageId",
    "issuedAt",
    "protocolId",
    "protocolVersion",
    "phaseId",
    "channelId",
    "projectId",
    "roomId",
    "turnId",
    "nodeId",
    "origin",
    "target",
    "intent",
    "content",
    "contentHash",
    "semanticHash",
    "evidenceStateHash",
    "decisionStateHash",
    "authority",
    "references",
  ]);
  const contractVersion = parseIdentifier(
    field(fields, "contractVersion", path),
    "$.contractVersion",
  );
  if (contractVersion !== ROOM_PROTOCOL_MESSAGE_VERSION) {
    throw new MessageParseError("unsupported_contract_version", "$.contractVersion", "Unsupported version");
  }
  const protocolVersionValue = field(fields, "protocolVersion", path);
  if (
    typeof protocolVersionValue !== "number"
    || !Number.isSafeInteger(protocolVersionValue)
    || protocolVersionValue <= 0
  ) {
    throw new MessageParseError("invalid_protocol_version", "$.protocolVersion", "Expected a positive version");
  }
  const intentValue = parseIdentifier(field(fields, "intent", path), "$.intent");
  if (!MESSAGE_INTENTS.has(intentValue as RoomMessageIntent)) {
    throw new MessageParseError("unsupported_intent", "$.intent", "Unsupported message intent");
  }
  const content = parseString(
    field(fields, "content", path),
    "$.content",
    ROOM_PROTOCOL_MESSAGE_BOUNDS.maxContentLength,
  );
  const contentHash = parseHash(field(fields, "contentHash", path), "$.contentHash");
  const computedHash = hashRoomValue(content);
  if (contentHash !== computedHash) {
    throw new MessageParseError("content_hash_mismatch", "$.contentHash", "Content hash does not match content");
  }
  return deepFreeze({
    contractVersion,
    messageId: parseIdentifier(field(fields, "messageId", path), "$.messageId"),
    issuedAt: parseTimestamp(field(fields, "issuedAt", path), "$.issuedAt"),
    protocolId: parseIdentifier(field(fields, "protocolId", path), "$.protocolId"),
    protocolVersion: protocolVersionValue,
    phaseId: parseIdentifier(field(fields, "phaseId", path), "$.phaseId"),
    channelId: parseIdentifier(field(fields, "channelId", path), "$.channelId"),
    projectId: parseIdentifier(field(fields, "projectId", path), "$.projectId"),
    roomId: parseIdentifier(field(fields, "roomId", path), "$.roomId"),
    turnId: parseIdentifier(field(fields, "turnId", path), "$.turnId"),
    nodeId: parseIdentifier(field(fields, "nodeId", path), "$.nodeId"),
    origin: parseOrigin(field(fields, "origin", path)),
    target: parseTarget(field(fields, "target", path)),
    intent: intentValue as RoomMessageIntent,
    content,
    contentHash,
    semanticHash: parseHash(field(fields, "semanticHash", path), "$.semanticHash"),
    evidenceStateHash: parseHash(field(fields, "evidenceStateHash", path), "$.evidenceStateHash"),
    decisionStateHash: parseHash(field(fields, "decisionStateHash", path), "$.decisionStateHash"),
    authority: parseAuthority(field(fields, "authority", path)),
    references: parseReferences(field(fields, "references", path)),
  });
}

/*
FNXC:SessionRoomSemanticRouting 2026-07-18-13:20:
Accepted protocol messages are detached from caller-owned runtime JSON and
deeply frozen before policy evaluation, preserving their causal and authority
metadata even when an API or connector later mutates its source payload.
*/
export function validateRoomProtocolMessage(input: unknown): RoomProtocolMessageValidationResult {
  try {
    return { ok: true, value: parseMessage(input) };
  } catch (error) {
    if (error instanceof MessageParseError) {
      return {
        ok: false,
        issues: [{ code: error.code, path: error.path, message: error.message }],
      };
    }
    return {
      ok: false,
      issues: [{ code: "invalid_runtime_value", path: "$", message: "Unsafe Room protocol message" }],
    };
  }
}

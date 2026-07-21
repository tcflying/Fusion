import { types as utilTypes } from "node:util";

import type { RoomMessageIntent, RoomMessageTargetV1 } from "./room-contracts/controller.js";
import type { ContentHash, IsoTimestamp, ProjectId, RoomId, RoomTaskNodeId, RoomTurnId } from "./room-contracts/ids.js";
import { hashRoomValue, stableSerializeRoomValue } from "./room-integrity.js";

export const ROOM_MESSAGE_AUTHORITY_ENVELOPE_VERSION = "room-message-authority-envelope/v1" as const;
export const ROOM_MESSAGE_AUTHORITY_SAFE_SCOPES = [
  "room:message:route",
  "room:message:read",
  "room:task:read",
  "room:task:comment",
  "room:review:request",
  "room:review:respond",
  "room:evidence:reference",
] as const;

export type RoomMessageAuthorityActorTypeV1 = "human" | "controller" | "seat" | "system" | "evolution";
export type RoomMessageAuthorityOriginSourceV1 =
  | "fusion_control_plane"
  | "happier_connector"
  | "operator_gateway";
export type RoomMessageAuthorityScopeV1 = (typeof ROOM_MESSAGE_AUTHORITY_SAFE_SCOPES)[number];
export type RoomMessageAuthorityReplayOutcomeV1 = "accepted" | "replay" | "sequence_out_of_order";

export interface RoomMessageAuthorityOriginV1 {
  readonly source: RoomMessageAuthorityOriginSourceV1;
  readonly issuerId: string;
}

export interface RoomMessageAuthorityActorV1 {
  readonly type: RoomMessageAuthorityActorTypeV1;
  readonly id: string;
}

export interface RoomMessageAuthoritySignatureV1 {
  readonly algorithm: "Ed25519";
  readonly keyId: string;
  readonly value: string;
}

export interface RoomMessageAuthorityEnvelopeV1 {
  readonly version: typeof ROOM_MESSAGE_AUTHORITY_ENVELOPE_VERSION;
  readonly origin: RoomMessageAuthorityOriginV1;
  readonly actor: RoomMessageAuthorityActorV1;
  readonly projectId: ProjectId;
  readonly roomId: RoomId;
  readonly turnId: RoomTurnId;
  readonly nodeId: RoomTaskNodeId;
  readonly target: RoomMessageTargetV1;
  readonly role: string;
  readonly allowedScopes: readonly RoomMessageAuthorityScopeV1[];
  readonly evidenceRefs: readonly string[];
  readonly intent: RoomMessageIntent;
  readonly contentHash: ContentHash;
  readonly issuedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly nonce: string;
  readonly sequence: number;
  readonly signature: RoomMessageAuthoritySignatureV1;
}

export interface RoomMessageAuthorityRequestV1 {
  readonly authenticatedOrigin: RoomMessageAuthorityOriginV1;
  readonly authenticatedActor: RoomMessageAuthorityActorV1;
  readonly authenticatedRole: string;
  readonly projectId: ProjectId;
  readonly roomId: RoomId;
  readonly turnId: RoomTurnId;
  readonly nodeId: RoomTaskNodeId;
  readonly target: RoomMessageTargetV1;
  readonly intent: RoomMessageIntent;
  readonly evidenceRefs: readonly string[];
  readonly content: string;
  readonly requestedScope: string;
}

export interface RoomMessageAuthorityTrustedOriginV1 {
  readonly issuerId: string;
  readonly sources: readonly RoomMessageAuthorityOriginSourceV1[];
  readonly actorTypes: readonly RoomMessageAuthorityActorTypeV1[];
}

export interface RoomMessageAuthorityRoleScopeGrantV1 {
  readonly actorType: RoomMessageAuthorityActorTypeV1;
  readonly role: string;
  readonly scopes: readonly RoomMessageAuthorityScopeV1[];
}

export interface RoomMessageAuthoritySignatureVerificationInputV1 {
  readonly origin: RoomMessageAuthorityOriginV1;
  readonly actor: RoomMessageAuthorityActorV1;
  readonly algorithm: RoomMessageAuthoritySignatureV1["algorithm"];
  readonly keyId: string;
  readonly signature: string;
  readonly signingPayload: string;
  readonly signingPayloadHash: string;
}

export type RoomMessageAuthorityVerifiedSignatureV1 =
  | {
      readonly verified: true;
      readonly issuerId: string;
      readonly keyId: string;
    }
  | {
      readonly verified: false;
    };

export interface RoomMessageAuthoritySignatureVerifierV1 {
  verify(input: RoomMessageAuthoritySignatureVerificationInputV1): Promise<RoomMessageAuthorityVerifiedSignatureV1>;
}

export interface RoomMessageAuthorityReplayClaimV1 {
  readonly sequenceScope: string;
  readonly nonce: string;
  readonly sequence: number;
  readonly envelopeHash: string;
  readonly expiresAtMs: number;
  readonly consumedAtMs: number;
}

export interface RoomMessageAuthorityReplayStoreV1 {
  readonly durability: "durable-atomic";
  consumeOnce(input: RoomMessageAuthorityReplayClaimV1): Promise<RoomMessageAuthorityReplayOutcomeV1>;
}

export interface RoomMessageAuthorityPolicyV1 {
  readonly trustedOrigins: readonly RoomMessageAuthorityTrustedOriginV1[];
  readonly roleScopeGrants: readonly RoomMessageAuthorityRoleScopeGrantV1[];
  readonly maxLifetimeMs: number;
  readonly maxClockSkewMs: number;
  readonly now: () => number;
  readonly signatureVerifier: RoomMessageAuthoritySignatureVerifierV1;
  readonly replayStore: RoomMessageAuthorityReplayStoreV1;
}

export interface RoomMessageAuthorityDecisionV1 {
  readonly kind: "message_only";
  readonly externalAuthority: "none";
  readonly grantedScope: RoomMessageAuthorityScopeV1;
  readonly origin: RoomMessageAuthorityOriginV1;
  readonly actor: RoomMessageAuthorityActorV1;
  readonly projectId: ProjectId;
  readonly roomId: RoomId;
  readonly turnId: RoomTurnId;
  readonly nodeId: RoomTaskNodeId;
  readonly target: RoomMessageTargetV1;
  readonly role: string;
  readonly evidenceRefs: readonly string[];
  readonly envelopeHash: string;
}

export type RoomMessageAuthorityEnvelopeErrorCode =
  | "invalid-envelope"
  | "invalid-context"
  | "invalid-policy"
  | "unsigned"
  | "signature-unverified"
  | "signature-verifier-failed"
  | "origin-untrusted"
  | "origin-mismatch"
  | "actor-mismatch"
  | "role-mismatch"
  | "expired"
  | "future-issued"
  | "lifetime-exceeded"
  | "project-room-mismatch"
  | "turn-mismatch"
  | "node-mismatch"
  | "target-mismatch"
  | "intent-mismatch"
  | "evidence-mismatch"
  | "content-tamper"
  | "scope-missing"
  | "scope-escalation"
  | "external-authority-forbidden"
  | "replay"
  | "sequence-out-of-order"
  | "replay-store-failed";

export type RoomMessageAuthorityAuthorizationResultV1 =
  | {
      readonly ok: true;
      readonly decision: RoomMessageAuthorityDecisionV1;
    }
  | {
      readonly ok: false;
      readonly code: RoomMessageAuthorityEnvelopeErrorCode;
    };

export class RoomMessageAuthorityEnvelopeError extends Error {
  readonly code: RoomMessageAuthorityEnvelopeErrorCode;

  constructor(code: RoomMessageAuthorityEnvelopeErrorCode) {
    super(code);
    this.name = "RoomMessageAuthorityEnvelopeError";
    this.code = code;
  }
}

const ACTOR_TYPES = new Set<RoomMessageAuthorityActorTypeV1>([
  "human",
  "controller",
  "seat",
  "system",
  "evolution",
]);
const ORIGIN_SOURCES = new Set<RoomMessageAuthorityOriginSourceV1>([
  "fusion_control_plane",
  "happier_connector",
  "operator_gateway",
]);
const SAFE_SCOPES = new Set<RoomMessageAuthorityScopeV1>(ROOM_MESSAGE_AUTHORITY_SAFE_SCOPES);
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
const EXTERNAL_AUTHORITY_NAMESPACES = new Set(["tool", "workspace", "credential", "network", "publication"]);
const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ROLE_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const DataObjectPrototype = Object.prototype;
const MAX_OBJECT_FIELDS = 32;
const MAX_ARRAY_ITEMS = 128;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_EVIDENCE_REF_LENGTH = 512;
const MAX_CONTENT_LENGTH = 65_536;
const MAX_SIGNATURE_LENGTH = 8_192;

type DataFields = ReadonlyMap<string, PropertyDescriptor>;

interface ParsedPolicyV1 {
  readonly trustedOrigins: ReadonlyMap<string, {
    readonly sources: ReadonlySet<RoomMessageAuthorityOriginSourceV1>;
    readonly actorTypes: ReadonlySet<RoomMessageAuthorityActorTypeV1>;
  }>;
  readonly roleScopes: ReadonlyMap<string, ReadonlySet<RoomMessageAuthorityScopeV1>>;
  readonly maxLifetimeMs: number;
  readonly maxClockSkewMs: number;
  readonly now: () => number;
  readonly signatureVerifier: {
    readonly target: object;
    readonly verify: RoomMessageAuthoritySignatureVerifierV1["verify"];
  };
  readonly replayStore: {
    readonly target: object;
    readonly consumeOnce: RoomMessageAuthorityReplayStoreV1["consumeOnce"];
  };
}

interface ParsedRequestV1 extends Omit<RoomMessageAuthorityRequestV1, "requestedScope"> {
  readonly requestedScope: RoomMessageAuthorityScopeV1;
}

export function digestRoomMessageAuthoritySigningPayloadV1(envelope: RoomMessageAuthorityEnvelopeV1): string {
  return hashRoomValue(toSigningPayload(parseEnvelope(envelope)));
}

export async function authorizeRoomMessageAuthorityEnvelopeV1(
  envelopeInput: RoomMessageAuthorityEnvelopeV1,
  requestInput: RoomMessageAuthorityRequestV1,
  policyInput: RoomMessageAuthorityPolicyV1,
): Promise<RoomMessageAuthorityAuthorizationResultV1> {
  try {
    const envelope = parseEnvelope(envelopeInput);
    const request = parseRequest(requestInput);
    const policy = parsePolicy(policyInput);
    if (envelope.signature.value.length === 0) throw new RoomMessageAuthorityEnvelopeError("unsigned");
    assertBinding(envelope, request);
    const nowMs = readNow(policy.now);
    const issuedAtMs = parseTimestamp(envelope.issuedAt, "invalid-envelope");
    const expiresAtMs = parseTimestamp(envelope.expiresAt, "invalid-envelope");
    if (expiresAtMs <= issuedAtMs) throw new RoomMessageAuthorityEnvelopeError("invalid-envelope");
    if (expiresAtMs - issuedAtMs > policy.maxLifetimeMs) throw new RoomMessageAuthorityEnvelopeError("lifetime-exceeded");
    if (issuedAtMs > nowMs + policy.maxClockSkewMs) throw new RoomMessageAuthorityEnvelopeError("future-issued");
    if (expiresAtMs <= nowMs) throw new RoomMessageAuthorityEnvelopeError("expired");
    assertTrustedOrigin(envelope, policy);
    assertRoleScopes(envelope, request.requestedScope, policy);
    const signingPayload = stableSerializeRoomValue(toSigningPayload(envelope));
    const signingPayloadHash = hashRoomValue(toSigningPayload(envelope));
    const verification = await verifySignature(envelope, signingPayload, signingPayloadHash, policy.signatureVerifier);
    if (!verification.verified) throw new RoomMessageAuthorityEnvelopeError("signature-unverified");
    if (verification.issuerId !== envelope.origin.issuerId || verification.keyId !== envelope.signature.keyId) {
      throw new RoomMessageAuthorityEnvelopeError("signature-unverified");
    }
    const replayOutcome = await consumeReplay(envelope, signingPayloadHash, expiresAtMs, nowMs, policy.replayStore);
    if (replayOutcome === "replay") throw new RoomMessageAuthorityEnvelopeError("replay");
    if (replayOutcome === "sequence_out_of_order") {
      throw new RoomMessageAuthorityEnvelopeError("sequence-out-of-order");
    }
    if (replayOutcome !== "accepted") throw new RoomMessageAuthorityEnvelopeError("replay-store-failed");
    return Object.freeze({
      ok: true,
      decision: Object.freeze({
        kind: "message_only",
        externalAuthority: "none",
        grantedScope: request.requestedScope,
        origin: envelope.origin,
        actor: envelope.actor,
        projectId: envelope.projectId,
        roomId: envelope.roomId,
        turnId: envelope.turnId,
        nodeId: envelope.nodeId,
        target: envelope.target,
        role: envelope.role,
        evidenceRefs: envelope.evidenceRefs,
        envelopeHash: signingPayloadHash,
      }),
    });
  } catch (error) {
    if (error instanceof RoomMessageAuthorityEnvelopeError) {
      return Object.freeze({ ok: false, code: error.code });
    }
    return Object.freeze({ ok: false, code: "invalid-envelope" });
  }
}

function parseEnvelope(value: unknown): RoomMessageAuthorityEnvelopeV1 {
  const fields = inspectDataObject(
    value,
    [
      "version",
      "origin",
      "actor",
      "projectId",
      "roomId",
      "turnId",
      "nodeId",
      "target",
      "role",
      "allowedScopes",
      "evidenceRefs",
      "intent",
      "contentHash",
      "issuedAt",
      "expiresAt",
      "nonce",
      "sequence",
      "signature",
    ],
    "invalid-envelope",
  );
  const version = parseString(valueOf(fields, "version", "invalid-envelope"), MAX_IDENTIFIER_LENGTH, "invalid-envelope");
  if (version !== ROOM_MESSAGE_AUTHORITY_ENVELOPE_VERSION) throw new RoomMessageAuthorityEnvelopeError("invalid-envelope");
  const contentHash = parseString(valueOf(fields, "contentHash", "invalid-envelope"), MAX_IDENTIFIER_LENGTH, "invalid-envelope");
  if (!CONTENT_HASH_PATTERN.test(contentHash)) throw new RoomMessageAuthorityEnvelopeError("invalid-envelope");
  const issuedAt = parseTimestampString(valueOf(fields, "issuedAt", "invalid-envelope"), "invalid-envelope");
  const expiresAt = parseTimestampString(valueOf(fields, "expiresAt", "invalid-envelope"), "invalid-envelope");
  return freezeEnvelope({
    version,
    origin: parseOrigin(valueOf(fields, "origin", "invalid-envelope"), "invalid-envelope"),
    actor: parseActor(valueOf(fields, "actor", "invalid-envelope"), "invalid-envelope"),
    projectId: parseIdentifier(valueOf(fields, "projectId", "invalid-envelope"), "invalid-envelope"),
    roomId: parseIdentifier(valueOf(fields, "roomId", "invalid-envelope"), "invalid-envelope"),
    turnId: parseIdentifier(valueOf(fields, "turnId", "invalid-envelope"), "invalid-envelope"),
    nodeId: parseIdentifier(valueOf(fields, "nodeId", "invalid-envelope"), "invalid-envelope"),
    target: parseTarget(valueOf(fields, "target", "invalid-envelope"), "invalid-envelope"),
    role: parseRole(valueOf(fields, "role", "invalid-envelope"), "invalid-envelope"),
    allowedScopes: parseScopeArray(valueOf(fields, "allowedScopes", "invalid-envelope"), "invalid-envelope"),
    evidenceRefs: parseEvidenceRefs(valueOf(fields, "evidenceRefs", "invalid-envelope"), "invalid-envelope"),
    intent: parseIntent(valueOf(fields, "intent", "invalid-envelope"), "invalid-envelope"),
    contentHash,
    issuedAt,
    expiresAt,
    nonce: parseIdentifier(valueOf(fields, "nonce", "invalid-envelope"), "invalid-envelope"),
    sequence: parsePositiveSafeInteger(valueOf(fields, "sequence", "invalid-envelope"), "invalid-envelope"),
    signature: parseSignature(valueOf(fields, "signature", "invalid-envelope"), "invalid-envelope"),
  });
}

function parseRequest(value: unknown): ParsedRequestV1 {
  const fields = inspectDataObject(
    value,
    [
      "authenticatedOrigin",
      "authenticatedActor",
      "authenticatedRole",
      "projectId",
      "roomId",
      "turnId",
      "nodeId",
      "target",
      "intent",
      "evidenceRefs",
      "content",
      "requestedScope",
    ],
    "invalid-context",
  );
  return Object.freeze({
    authenticatedOrigin: parseOrigin(valueOf(fields, "authenticatedOrigin", "invalid-context"), "invalid-context"),
    authenticatedActor: parseActor(valueOf(fields, "authenticatedActor", "invalid-context"), "invalid-context"),
    authenticatedRole: parseRole(valueOf(fields, "authenticatedRole", "invalid-context"), "invalid-context"),
    projectId: parseIdentifier(valueOf(fields, "projectId", "invalid-context"), "invalid-context"),
    roomId: parseIdentifier(valueOf(fields, "roomId", "invalid-context"), "invalid-context"),
    turnId: parseIdentifier(valueOf(fields, "turnId", "invalid-context"), "invalid-context"),
    nodeId: parseIdentifier(valueOf(fields, "nodeId", "invalid-context"), "invalid-context"),
    target: parseTarget(valueOf(fields, "target", "invalid-context"), "invalid-context"),
    intent: parseIntent(valueOf(fields, "intent", "invalid-context"), "invalid-context"),
    evidenceRefs: parseEvidenceRefs(valueOf(fields, "evidenceRefs", "invalid-context"), "invalid-context"),
    content: parseString(valueOf(fields, "content", "invalid-context"), MAX_CONTENT_LENGTH, "invalid-context", true),
    requestedScope: parseScope(valueOf(fields, "requestedScope", "invalid-context"), "invalid-context"),
  });
}

function parsePolicy(value: unknown): ParsedPolicyV1 {
  const fields = inspectDataObject(
    value,
    [
      "trustedOrigins",
      "roleScopeGrants",
      "maxLifetimeMs",
      "maxClockSkewMs",
      "now",
      "signatureVerifier",
      "replayStore",
    ],
    "invalid-policy",
  );
  const trustedOrigins = new Map<string, {
    readonly sources: ReadonlySet<RoomMessageAuthorityOriginSourceV1>;
    readonly actorTypes: ReadonlySet<RoomMessageAuthorityActorTypeV1>;
  }>();
  for (const item of inspectArray(valueOf(fields, "trustedOrigins", "invalid-policy"), "invalid-policy")) {
    const originFields = inspectDataObject(item, ["issuerId", "sources", "actorTypes"], "invalid-policy");
    const issuerId = parseIdentifier(valueOf(originFields, "issuerId", "invalid-policy"), "invalid-policy");
    if (trustedOrigins.has(issuerId)) throw new RoomMessageAuthorityEnvelopeError("invalid-policy");
    const sources = new Set<RoomMessageAuthorityOriginSourceV1>();
    for (const source of inspectArray(valueOf(originFields, "sources", "invalid-policy"), "invalid-policy")) {
      sources.add(parseOriginSource(source, "invalid-policy"));
    }
    const actorTypes = new Set<RoomMessageAuthorityActorTypeV1>();
    for (const actorType of inspectArray(valueOf(originFields, "actorTypes", "invalid-policy"), "invalid-policy")) {
      actorTypes.add(parseActorType(actorType, "invalid-policy"));
    }
    if (sources.size === 0 || actorTypes.size === 0) throw new RoomMessageAuthorityEnvelopeError("invalid-policy");
    trustedOrigins.set(issuerId, Object.freeze({ sources, actorTypes }));
  }
  if (trustedOrigins.size === 0) throw new RoomMessageAuthorityEnvelopeError("invalid-policy");

  const roleScopes = new Map<string, ReadonlySet<RoomMessageAuthorityScopeV1>>();
  for (const item of inspectArray(valueOf(fields, "roleScopeGrants", "invalid-policy"), "invalid-policy")) {
    const grantFields = inspectDataObject(item, ["actorType", "role", "scopes"], "invalid-policy");
    const actorType = parseActorType(valueOf(grantFields, "actorType", "invalid-policy"), "invalid-policy");
    const role = parseRole(valueOf(grantFields, "role", "invalid-policy"), "invalid-policy");
    const key = roleScopeKey(actorType, role);
    if (roleScopes.has(key)) throw new RoomMessageAuthorityEnvelopeError("invalid-policy");
    const scopes = new Set<RoomMessageAuthorityScopeV1>();
    for (const scope of inspectArray(valueOf(grantFields, "scopes", "invalid-policy"), "invalid-policy")) {
      scopes.add(parseScope(scope, "invalid-policy"));
    }
    if (scopes.size === 0) throw new RoomMessageAuthorityEnvelopeError("invalid-policy");
    roleScopes.set(key, scopes);
  }
  if (roleScopes.size === 0) throw new RoomMessageAuthorityEnvelopeError("invalid-policy");

  const maxLifetimeMs = parsePositiveSafeInteger(valueOf(fields, "maxLifetimeMs", "invalid-policy"), "invalid-policy");
  const maxClockSkewMs = parseNonNegativeSafeInteger(valueOf(fields, "maxClockSkewMs", "invalid-policy"), "invalid-policy");
  const now = valueOf(fields, "now", "invalid-policy");
  if (typeof now !== "function") throw new RoomMessageAuthorityEnvelopeError("invalid-policy");
  const signatureVerifier = parseSignatureVerifier(valueOf(fields, "signatureVerifier", "invalid-policy"));
  const replayStore = parseReplayStore(valueOf(fields, "replayStore", "invalid-policy"));
  return Object.freeze({
    trustedOrigins,
    roleScopes,
    maxLifetimeMs,
    maxClockSkewMs,
    now: now as () => number,
    signatureVerifier,
    replayStore,
  });
}

function parseOrigin(value: unknown, code: RoomMessageAuthorityEnvelopeErrorCode): RoomMessageAuthorityOriginV1 {
  const fields = inspectDataObject(value, ["source", "issuerId"], code);
  return Object.freeze({
    source: parseOriginSource(valueOf(fields, "source", code), code),
    issuerId: parseIdentifier(valueOf(fields, "issuerId", code), code),
  });
}

function parseActor(value: unknown, code: RoomMessageAuthorityEnvelopeErrorCode): RoomMessageAuthorityActorV1 {
  const fields = inspectDataObject(value, ["type", "id"], code);
  return Object.freeze({
    type: parseActorType(valueOf(fields, "type", code), code),
    id: parseIdentifier(valueOf(fields, "id", code), code),
  });
}

function parseSignature(value: unknown, code: RoomMessageAuthorityEnvelopeErrorCode): RoomMessageAuthoritySignatureV1 {
  const fields = inspectDataObject(value, ["algorithm", "keyId", "value"], code);
  const algorithm = parseString(valueOf(fields, "algorithm", code), MAX_IDENTIFIER_LENGTH, code);
  if (algorithm !== "Ed25519") throw new RoomMessageAuthorityEnvelopeError(code);
  const keyId = parseString(valueOf(fields, "keyId", code), MAX_IDENTIFIER_LENGTH, code);
  if (!KEY_ID_PATTERN.test(keyId)) throw new RoomMessageAuthorityEnvelopeError(code);
  const signatureValue = parseString(valueOf(fields, "value", code), MAX_SIGNATURE_LENGTH, code, true);
  return Object.freeze({ algorithm, keyId, value: signatureValue });
}

function parseTarget(value: unknown, code: RoomMessageAuthorityEnvelopeErrorCode): RoomMessageTargetV1 {
  const fields = inspectDataObjectWithAlternatives(value, ["kind"], code);
  const kind = parseString(valueOf(fields, "kind", code), MAX_IDENTIFIER_LENGTH, code);
  if (kind === "controller" || kind === "all") {
    assertExactFieldNames(fields, ["kind"], code);
    return Object.freeze({ kind });
  }
  if (kind === "group") {
    assertExactFieldNames(fields, ["kind", "groupId"], code);
    return Object.freeze({
      kind,
      groupId: parseIdentifier(valueOf(fields, "groupId", code), code),
    });
  }
  if (kind === "seats") {
    assertExactFieldNames(fields, ["kind", "seatIds"], code);
    const seatIds = parseStringArray(valueOf(fields, "seatIds", code), MAX_ARRAY_ITEMS, MAX_IDENTIFIER_LENGTH, code);
    if (seatIds.length === 0) throw new RoomMessageAuthorityEnvelopeError(code);
    return Object.freeze({ kind, seatIds });
  }
  throw new RoomMessageAuthorityEnvelopeError(code);
}

function parseScopeArray(value: unknown, code: RoomMessageAuthorityEnvelopeErrorCode): readonly RoomMessageAuthorityScopeV1[] {
  const scopes = inspectArray(value, code).map((scope) => parseScope(scope, code));
  if (scopes.length === 0 || new Set(scopes).size !== scopes.length) throw new RoomMessageAuthorityEnvelopeError(code);
  return Object.freeze(scopes);
}

function parseEvidenceRefs(value: unknown, code: RoomMessageAuthorityEnvelopeErrorCode): readonly string[] {
  const refs = parseStringArray(value, MAX_ARRAY_ITEMS, MAX_EVIDENCE_REF_LENGTH, code);
  return Object.freeze(refs);
}

function parseScope(value: unknown, code: RoomMessageAuthorityEnvelopeErrorCode): RoomMessageAuthorityScopeV1 {
  const scope = parseString(value, MAX_IDENTIFIER_LENGTH, code);
  const namespace = scope.split(":", 1)[0] ?? "";
  if (EXTERNAL_AUTHORITY_NAMESPACES.has(namespace)) {
    throw new RoomMessageAuthorityEnvelopeError("external-authority-forbidden");
  }
  if (!SAFE_SCOPES.has(scope as RoomMessageAuthorityScopeV1)) {
    throw new RoomMessageAuthorityEnvelopeError("scope-escalation");
  }
  return scope as RoomMessageAuthorityScopeV1;
}

function parseOriginSource(value: unknown, code: RoomMessageAuthorityEnvelopeErrorCode): RoomMessageAuthorityOriginSourceV1 {
  const source = parseString(value, MAX_IDENTIFIER_LENGTH, code);
  if (!ORIGIN_SOURCES.has(source as RoomMessageAuthorityOriginSourceV1)) {
    throw new RoomMessageAuthorityEnvelopeError(code);
  }
  return source as RoomMessageAuthorityOriginSourceV1;
}

function parseActorType(value: unknown, code: RoomMessageAuthorityEnvelopeErrorCode): RoomMessageAuthorityActorTypeV1 {
  const actorType = parseString(value, MAX_IDENTIFIER_LENGTH, code);
  if (!ACTOR_TYPES.has(actorType as RoomMessageAuthorityActorTypeV1)) {
    throw new RoomMessageAuthorityEnvelopeError(code);
  }
  return actorType as RoomMessageAuthorityActorTypeV1;
}

function parseRole(value: unknown, code: RoomMessageAuthorityEnvelopeErrorCode): string {
  const role = parseString(value, 64, code);
  if (!ROLE_PATTERN.test(role)) throw new RoomMessageAuthorityEnvelopeError(code);
  return role;
}

function parseIntent(value: unknown, code: RoomMessageAuthorityEnvelopeErrorCode): RoomMessageIntent {
  const intent = parseString(value, MAX_IDENTIFIER_LENGTH, code);
  if (!MESSAGE_INTENTS.has(intent as RoomMessageIntent)) throw new RoomMessageAuthorityEnvelopeError(code);
  return intent as RoomMessageIntent;
}

function parseIdentifier(value: unknown, code: RoomMessageAuthorityEnvelopeErrorCode): string {
  return parseString(value, MAX_IDENTIFIER_LENGTH, code);
}

function parseTimestampString(value: unknown, code: RoomMessageAuthorityEnvelopeErrorCode): string {
  const timestamp = parseString(value, MAX_IDENTIFIER_LENGTH, code);
  parseTimestamp(timestamp, code);
  return timestamp;
}

function parseTimestamp(value: string, code: RoomMessageAuthorityEnvelopeErrorCode): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new RoomMessageAuthorityEnvelopeError(code);
  }
  return timestamp;
}

function parseString(
  value: unknown,
  maxLength: number,
  code: RoomMessageAuthorityEnvelopeErrorCode,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || value.length > maxLength || (!allowEmpty && (value.length === 0 || value.trim() !== value))) {
    throw new RoomMessageAuthorityEnvelopeError(code);
  }
  return value;
}

function parsePositiveSafeInteger(value: unknown, code: RoomMessageAuthorityEnvelopeErrorCode): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new RoomMessageAuthorityEnvelopeError(code);
  return value as number;
}

function parseNonNegativeSafeInteger(value: unknown, code: RoomMessageAuthorityEnvelopeErrorCode): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new RoomMessageAuthorityEnvelopeError(code);
  return value as number;
}

function parseStringArray(
  value: unknown,
  limit: number,
  itemMaxLength: number,
  code: RoomMessageAuthorityEnvelopeErrorCode,
): readonly string[] {
  const entries = inspectArray(value, code).map((entry) => parseString(entry, itemMaxLength, code));
  if (entries.length > limit || new Set(entries).size !== entries.length) throw new RoomMessageAuthorityEnvelopeError(code);
  return Object.freeze(entries);
}

function inspectDataObject(value: unknown, required: readonly string[], code: RoomMessageAuthorityEnvelopeErrorCode): DataFields {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new RoomMessageAuthorityEnvelopeError(code);
  }
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    keys = Reflect.ownKeys(value);
  } catch {
    throw new RoomMessageAuthorityEnvelopeError(code);
  }
  if (prototype !== DataObjectPrototype && prototype !== null || keys.length > MAX_OBJECT_FIELDS) {
    throw new RoomMessageAuthorityEnvelopeError(code);
  }
  const requiredKeys = new Set(required);
  const fields = new Map<string, PropertyDescriptor>();
  for (const key of keys) {
    if (typeof key !== "string" || !requiredKeys.has(key)) throw new RoomMessageAuthorityEnvelopeError(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new RoomMessageAuthorityEnvelopeError(code);
    fields.set(key, descriptor);
  }
  for (const requiredKey of required) {
    if (!fields.has(requiredKey)) throw new RoomMessageAuthorityEnvelopeError(code);
  }
  return fields;
}

function inspectDataObjectWithAlternatives(
  value: unknown,
  minimum: readonly string[],
  code: RoomMessageAuthorityEnvelopeErrorCode,
): DataFields {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new RoomMessageAuthorityEnvelopeError(code);
  }
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    keys = Reflect.ownKeys(value);
  } catch {
    throw new RoomMessageAuthorityEnvelopeError(code);
  }
  if (prototype !== DataObjectPrototype && prototype !== null || keys.length > MAX_OBJECT_FIELDS) {
    throw new RoomMessageAuthorityEnvelopeError(code);
  }
  const fields = new Map<string, PropertyDescriptor>();
  for (const key of keys) {
    if (typeof key !== "string") throw new RoomMessageAuthorityEnvelopeError(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new RoomMessageAuthorityEnvelopeError(code);
    fields.set(key, descriptor);
  }
  for (const requiredKey of minimum) {
    if (!fields.has(requiredKey)) throw new RoomMessageAuthorityEnvelopeError(code);
  }
  return fields;
}

function inspectArray(value: unknown, code: RoomMessageAuthorityEnvelopeErrorCode): readonly unknown[] {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || !Array.isArray(value)) {
    throw new RoomMessageAuthorityEnvelopeError(code);
  }
  let prototype: object | null;
  let keys: readonly PropertyKey[];
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    keys = Reflect.ownKeys(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    throw new RoomMessageAuthorityEnvelopeError(code);
  }
  if (
    prototype !== Array.prototype
    || !lengthDescriptor
    || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
  ) {
    throw new RoomMessageAuthorityEnvelopeError(code);
  }
  const length = lengthDescriptor.value as number;
  if (length < 0 || length > MAX_ARRAY_ITEMS || keys.length !== length + 1) {
    throw new RoomMessageAuthorityEnvelopeError(code);
  }
  const entries: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw new RoomMessageAuthorityEnvelopeError(code);
    entries.push(descriptor.value);
  }
  return entries;
}

function assertExactFieldNames(fields: DataFields, required: readonly string[], code: RoomMessageAuthorityEnvelopeErrorCode): void {
  if (fields.size !== required.length) throw new RoomMessageAuthorityEnvelopeError(code);
  for (const key of required) {
    if (!fields.has(key)) throw new RoomMessageAuthorityEnvelopeError(code);
  }
}

function valueOf(fields: DataFields, key: string, code: RoomMessageAuthorityEnvelopeErrorCode): unknown {
  const descriptor = fields.get(key);
  if (!descriptor || !("value" in descriptor)) throw new RoomMessageAuthorityEnvelopeError(code);
  return descriptor.value;
}

function parseSignatureVerifier(value: unknown): ParsedPolicyV1["signatureVerifier"] {
  const target = parsePortObject(value);
  const verify = readDataMethod(target, "verify");
  return Object.freeze({ target, verify: verify as RoomMessageAuthoritySignatureVerifierV1["verify"] });
}

function parseReplayStore(value: unknown): ParsedPolicyV1["replayStore"] {
  const target = parsePortObject(value);
  const durability = readDataProperty(target, "durability");
  if (durability !== "durable-atomic") throw new RoomMessageAuthorityEnvelopeError("invalid-policy");
  const consumeOnce = readDataMethod(target, "consumeOnce");
  return Object.freeze({ target, consumeOnce: consumeOnce as RoomMessageAuthorityReplayStoreV1["consumeOnce"] });
}

function parsePortObject(value: unknown): object {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new RoomMessageAuthorityEnvelopeError("invalid-policy");
  }
  return value;
}

function readDataProperty(target: object, key: string): unknown {
  let current: object | null = target;
  while (current !== null && current !== DataObjectPrototype) {
    if (utilTypes.isProxy(current)) throw new RoomMessageAuthorityEnvelopeError("invalid-policy");
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, key);
      current = Object.getPrototypeOf(current) as object | null;
    } catch {
      throw new RoomMessageAuthorityEnvelopeError("invalid-policy");
    }
    if (descriptor) {
      if (!("value" in descriptor)) throw new RoomMessageAuthorityEnvelopeError("invalid-policy");
      return descriptor.value;
    }
  }
  throw new RoomMessageAuthorityEnvelopeError("invalid-policy");
}

function readDataMethod(target: object, key: string): (...args: readonly unknown[]) => unknown {
  const method = readDataProperty(target, key);
  if (typeof method !== "function") throw new RoomMessageAuthorityEnvelopeError("invalid-policy");
  return method as (...args: readonly unknown[]) => unknown;
}

function assertBinding(envelope: RoomMessageAuthorityEnvelopeV1, request: ParsedRequestV1): void {
  if (!sameValue(envelope.origin, request.authenticatedOrigin)) throw new RoomMessageAuthorityEnvelopeError("origin-mismatch");
  if (!sameValue(envelope.actor, request.authenticatedActor)) throw new RoomMessageAuthorityEnvelopeError("actor-mismatch");
  if (envelope.role !== request.authenticatedRole) throw new RoomMessageAuthorityEnvelopeError("role-mismatch");
  if (envelope.projectId !== request.projectId || envelope.roomId !== request.roomId) {
    throw new RoomMessageAuthorityEnvelopeError("project-room-mismatch");
  }
  if (envelope.turnId !== request.turnId) throw new RoomMessageAuthorityEnvelopeError("turn-mismatch");
  if (envelope.nodeId !== request.nodeId) throw new RoomMessageAuthorityEnvelopeError("node-mismatch");
  if (!sameValue(envelope.target, request.target)) throw new RoomMessageAuthorityEnvelopeError("target-mismatch");
  if (envelope.intent !== request.intent) throw new RoomMessageAuthorityEnvelopeError("intent-mismatch");
  if (!sameValue(envelope.evidenceRefs, request.evidenceRefs)) {
    throw new RoomMessageAuthorityEnvelopeError("evidence-mismatch");
  }
  if (envelope.contentHash !== hashRoomValue(request.content)) {
    throw new RoomMessageAuthorityEnvelopeError("content-tamper");
  }
}

function assertTrustedOrigin(envelope: RoomMessageAuthorityEnvelopeV1, policy: ParsedPolicyV1): void {
  const trusted = policy.trustedOrigins.get(envelope.origin.issuerId);
  if (!trusted || !trusted.sources.has(envelope.origin.source) || !trusted.actorTypes.has(envelope.actor.type)) {
    throw new RoomMessageAuthorityEnvelopeError("origin-untrusted");
  }
}

function assertRoleScopes(
  envelope: RoomMessageAuthorityEnvelopeV1,
  requestedScope: RoomMessageAuthorityScopeV1,
  policy: ParsedPolicyV1,
): void {
  const allowedByRole = policy.roleScopes.get(roleScopeKey(envelope.actor.type, envelope.role));
  if (!allowedByRole) throw new RoomMessageAuthorityEnvelopeError("scope-escalation");
  const claimedScopes = new Set(envelope.allowedScopes);
  if (!claimedScopes.has(requestedScope)) throw new RoomMessageAuthorityEnvelopeError("scope-missing");
  for (const scope of envelope.allowedScopes) {
    if (!allowedByRole.has(scope)) throw new RoomMessageAuthorityEnvelopeError("scope-escalation");
  }
  if (!allowedByRole.has(requestedScope)) throw new RoomMessageAuthorityEnvelopeError("scope-escalation");
}

async function verifySignature(
  envelope: RoomMessageAuthorityEnvelopeV1,
  signingPayload: string,
  signingPayloadHash: string,
  verifier: ParsedPolicyV1["signatureVerifier"],
): Promise<RoomMessageAuthorityVerifiedSignatureV1> {
  let result: unknown;
  try {
    result = await verifier.verify.call(verifier.target, {
      origin: envelope.origin,
      actor: envelope.actor,
      algorithm: envelope.signature.algorithm,
      keyId: envelope.signature.keyId,
      signature: envelope.signature.value,
      signingPayload,
      signingPayloadHash,
    });
  } catch {
    throw new RoomMessageAuthorityEnvelopeError("signature-verifier-failed");
  }
  if (result === null || typeof result !== "object" || utilTypes.isProxy(result)) {
    throw new RoomMessageAuthorityEnvelopeError("signature-unverified");
  }
  const fields = inspectDataObjectWithAlternatives(result, ["verified"], "signature-unverified");
  const verified = valueOf(fields, "verified", "signature-unverified");
  if (verified === false) {
    assertExactFieldNames(fields, ["verified"], "signature-unverified");
    return Object.freeze({ verified: false });
  }
  if (verified !== true) throw new RoomMessageAuthorityEnvelopeError("signature-unverified");
  assertExactFieldNames(fields, ["verified", "issuerId", "keyId"], "signature-unverified");
  return Object.freeze({
    verified: true,
    issuerId: parseIdentifier(valueOf(fields, "issuerId", "signature-unverified"), "signature-unverified"),
    keyId: parseString(valueOf(fields, "keyId", "signature-unverified"), MAX_IDENTIFIER_LENGTH, "signature-unverified"),
  });
}

async function consumeReplay(
  envelope: RoomMessageAuthorityEnvelopeV1,
  envelopeHash: string,
  expiresAtMs: number,
  consumedAtMs: number,
  replayStore: ParsedPolicyV1["replayStore"],
): Promise<RoomMessageAuthorityReplayOutcomeV1> {
  const sequenceScope = hashRoomValue({
    issuerId: envelope.origin.issuerId,
    source: envelope.origin.source,
    actorType: envelope.actor.type,
    actorId: envelope.actor.id,
    projectId: envelope.projectId,
    roomId: envelope.roomId,
  });
  let outcome: unknown;
  try {
    outcome = await replayStore.consumeOnce.call(replayStore.target, {
      sequenceScope,
      nonce: envelope.nonce,
      sequence: envelope.sequence,
      envelopeHash,
      expiresAtMs,
      consumedAtMs,
    });
  } catch {
    throw new RoomMessageAuthorityEnvelopeError("replay-store-failed");
  }
  if (outcome !== "accepted" && outcome !== "replay" && outcome !== "sequence_out_of_order") {
    throw new RoomMessageAuthorityEnvelopeError("replay-store-failed");
  }
  return outcome;
}

function readNow(now: () => number): number {
  let value: unknown;
  try {
    value = now();
  } catch {
    throw new RoomMessageAuthorityEnvelopeError("invalid-policy");
  }
  if (!Number.isFinite(value)) throw new RoomMessageAuthorityEnvelopeError("invalid-policy");
  return value as number;
}

function freezeEnvelope(envelope: RoomMessageAuthorityEnvelopeV1): RoomMessageAuthorityEnvelopeV1 {
  return Object.freeze({
    ...envelope,
    origin: Object.freeze({ ...envelope.origin }),
    actor: Object.freeze({ ...envelope.actor }),
    target: freezeTarget(envelope.target),
    allowedScopes: Object.freeze([...envelope.allowedScopes]),
    evidenceRefs: Object.freeze([...envelope.evidenceRefs]),
    signature: Object.freeze({ ...envelope.signature }),
  });
}

function freezeTarget(target: RoomMessageTargetV1): RoomMessageTargetV1 {
  if (target.kind === "seats") return Object.freeze({ kind: target.kind, seatIds: Object.freeze([...target.seatIds]) });
  if (target.kind === "group") return Object.freeze({ kind: target.kind, groupId: target.groupId });
  return Object.freeze({ kind: target.kind });
}

function toSigningPayload(envelope: RoomMessageAuthorityEnvelopeV1): Readonly<Record<string, unknown>> {
  return Object.freeze({
    version: envelope.version,
    origin: envelope.origin,
    actor: envelope.actor,
    projectId: envelope.projectId,
    roomId: envelope.roomId,
    turnId: envelope.turnId,
    nodeId: envelope.nodeId,
    target: envelope.target,
    role: envelope.role,
    allowedScopes: envelope.allowedScopes,
    evidenceRefs: envelope.evidenceRefs,
    intent: envelope.intent,
    contentHash: envelope.contentHash,
    issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
    nonce: envelope.nonce,
    sequence: envelope.sequence,
    signatureAlgorithm: envelope.signature.algorithm,
    signatureKeyId: envelope.signature.keyId,
  });
}

function roleScopeKey(actorType: RoomMessageAuthorityActorTypeV1, role: string): string {
  return `${actorType}\u0000${role}`;
}

function sameValue(left: unknown, right: unknown): boolean {
  return stableSerializeRoomValue(left) === stableSerializeRoomValue(right);
}

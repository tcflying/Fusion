import {
  KeyObject,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { types as utilTypes } from "node:util";

import {
  ROOM_AUTHORITY_ACTOR_TYPES,
  ROOM_AUTHORITY_CLAIM_VERSION,
  type RoomAuthorityActorTypeV1,
  type RoomAuthorityClaimsV1,
  type RoomAuthorityProofAlgorithmV1,
  type RoomAuthorityVerificationContextV1,
  type RoomMessageIntent,
  type RoomMessageTargetV1,
  type SignedRoomAuthorityEnvelopeV1,
} from "./room-contracts/controller.js";
import { hashRoomValue, stableSerializeRoomValue } from "./room-integrity.js";

export type RoomAuthorityKeyLike = KeyObject | string | Buffer;

export interface RoomAuthorityTrustedKeyV1 {
  readonly issuer: string;
  readonly publicKey: RoomAuthorityKeyLike;
  readonly algorithm?: RoomAuthorityProofAlgorithmV1;
}

export interface RoomAuthorityNonceConsumptionV1 {
  readonly issuer: string;
  readonly keyId: string;
  readonly nonce: string;
  readonly authorityDigest: string;
  readonly expiresAt: RoomAuthorityClaimsV1["expiresAt"];
  readonly expiresAtMs: number;
  readonly replayRetainUntilMs: number;
  readonly consumedAtMs: number;
}

/**
 * Production implementations must perform the check-and-insert as one durable
 * transaction or equivalent unique-key operation shared by every verifier.
 */
export interface DurableAtomicRoomAuthorityNonceStoreV1 {
  readonly durability: "durable-atomic";
  consumeOnce(input: RoomAuthorityNonceConsumptionV1): Promise<boolean>;
}

export interface TestOnlyRoomAuthorityNonceStoreV1 {
  readonly durability: "test-only-memory";
  consumeOnce(input: RoomAuthorityNonceConsumptionV1): Promise<boolean>;
}

interface RoomAuthorityVerificationPolicyBaseV1 {
  readonly trustedIssuers: readonly string[];
  readonly trustedKeys: Readonly<Record<string, RoomAuthorityTrustedKeyV1>>;
  readonly allowedScopesByActorType: Readonly<Partial<Record<RoomAuthorityActorTypeV1, readonly string[]>>>;
  readonly maxLifetimeMs: number;
  readonly maxClockSkewMs: number;
  readonly now?: () => number;
}

export interface RoomAuthorityVerificationPolicyV1 extends RoomAuthorityVerificationPolicyBaseV1 {
  readonly nonceStore: DurableAtomicRoomAuthorityNonceStoreV1;
}

export interface RoomAuthorityTestVerificationPolicyV1 extends RoomAuthorityVerificationPolicyBaseV1 {
  readonly nonceStore: DurableAtomicRoomAuthorityNonceStoreV1 | TestOnlyRoomAuthorityNonceStoreV1;
}

export interface IssueRoomAuthorityEnvelopeInputV1 {
  readonly claims: RoomAuthorityClaimsV1;
  readonly keyId: string;
  readonly privateKey: RoomAuthorityKeyLike;
}

export type RoomAuthorityErrorCode =
  | "invalid-envelope"
  | "invalid-policy"
  | "unsigned"
  | "unknown-key"
  | "signature-invalid"
  | "invalid-signature-encoding"
  | "signing-failed"
  | "verification-failed"
  | "issuer-untrusted"
  | "expired"
  | "future-issued"
  | "lifetime-exceeded"
  | "algorithm-confusion"
  | "replay-nonce"
  | "nonce-store-not-durable"
  | "nonce-store-failed"
  | "outer-mismatch"
  | "command-mismatch"
  | "project-room-mismatch"
  | "turn-mismatch"
  | "node-mismatch"
  | "target-mismatch"
  | "expected-version-mismatch"
  | "intent-mismatch"
  | "content-tamper"
  | "scope-missing"
  | "scope-escalation"
  | "forbidden-peer-grant";

export class RoomAuthorityError extends Error {
  readonly code: RoomAuthorityErrorCode;

  constructor(code: RoomAuthorityErrorCode, message: string) {
    super(message);
    this.name = "RoomAuthorityError";
    this.code = code;
  }
}

const ROOM_AUTHORITY_ALGORITHM = "Ed25519" as const;
const ED25519_SIGNATURE_BYTES = 64;
const ROOM_MESSAGE_INTENTS = [
  "instruction",
  "proposal",
  "question",
  "critique",
  "challenge",
  "verdict",
  "handoff",
  "help_request",
] as const satisfies readonly RoomMessageIntent[];
const ROOM_AUTHORITY_SCOPE_NAMESPACES = [
  "room",
  "tool",
  "workspace",
  "credential",
  "network",
  "publication",
] as const;
const HIGH_RISK_PEER_SCOPE_NAMESPACES = new Set([
  "tool",
  "workspace",
  "credential",
  "network",
  "publication",
]);
const SCOPE_SEGMENT_PATTERN = /^[a-z][a-z0-9_-]*$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Public parser budgets; string limits use JavaScript UTF-16 code units. */
export const ROOM_AUTHORITY_CONTRACT_BOUNDS = Object.freeze({
  maxObjectFields: 32,
  maxArrayItems: 64,
  maxStringLength: 256,
  maxScopeLength: 128,
  maxSignatureLength: 128,
  maxContentLength: 65_536,
} as const);

interface ParsedRoomAuthorityProofV1 {
  readonly algorithm: string;
  readonly keyId: string;
  readonly signature: string;
}

interface ParsedSignedRoomAuthorityEnvelopeV1 {
  readonly version: string;
  readonly issuer: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly claims: RoomAuthorityClaimsV1;
  readonly proof: ParsedRoomAuthorityProofV1;
}

interface ParsedTrustedKeyV1 {
  readonly issuer: string;
  readonly publicKey: KeyObject;
  readonly algorithm: string | undefined;
}

interface ParsedNonceStoreV1 {
  readonly target: object;
  readonly consumeOnce: (input: RoomAuthorityNonceConsumptionV1) => Promise<boolean>;
}

interface ParsedVerificationPolicyV1 {
  readonly trustedIssuers: ReadonlySet<string>;
  readonly trustedKeys: ReadonlyMap<string, ParsedTrustedKeyV1>;
  readonly allowedScopesByActorType: ReadonlyMap<RoomAuthorityActorTypeV1, ReadonlySet<string>>;
  readonly maxLifetimeMs: number;
  readonly maxClockSkewMs: number;
  readonly now: () => number;
  readonly nonceStore: ParsedNonceStoreV1;
}

type DataFieldMap = ReadonlyMap<string, PropertyDescriptor>;

/*
FNXC:SessionRoomAuthority 2026-07-18-09:20:
Authority input is parsed through data-property descriptors into detached,
deep-frozen values before policy or crypto checks. Production replay defense
requires an awaitable durable atomic consume-once transaction bound to the
authority digest and expiry; plaintext content and key material never enter
errors, replay records, signatures, or diagnostics. Contract bounds reject
oversized objects, strings, and arrays before descriptor expansion or indexed
iteration, including O(1) length rejection for oversized sparse arrays.
*/
export function canonicalizeRoomAuthorityClaimsV1(claims: RoomAuthorityClaimsV1): string {
  return serializeParsedClaims(parseClaimsStrict(claims));
}

export function digestRoomAuthorityEnvelopeV1(envelope: SignedRoomAuthorityEnvelopeV1): string {
  return digestParsedEnvelope(parseEnvelopeStrict(envelope));
}

export function issueRoomAuthorityEnvelopeV1(
  input: IssueRoomAuthorityEnvelopeInputV1,
): SignedRoomAuthorityEnvelopeV1 {
  const inputFields = inspectDataObject(input, "issuance input", "invalid-envelope");
  assertExactFields(inputFields, ["claims", "keyId", "privateKey"], [], "issuance input", "invalid-envelope");

  const claims = parseClaimsStrict(fieldValue(inputFields, "claims"));
  const keyId = parseKeyId(fieldValue(inputFields, "keyId"), "keyId", "invalid-envelope");
  const privateKey = parsePrivateKey(fieldValue(inputFields, "privateKey"));
  const canonicalClaims = serializeParsedClaims(claims);

  let signature: string;
  try {
    signature = cryptoSign(null, Buffer.from(canonicalClaims, "utf8"), privateKey).toString("base64url");
  } catch {
    throw new RoomAuthorityError("signing-failed", "Room authority signing failed");
  }

  const proof = Object.freeze({
    algorithm: ROOM_AUTHORITY_ALGORITHM,
    keyId,
    signature,
  });
  return Object.freeze({
    version: claims.version,
    issuer: claims.issuer,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
    claims,
    proof,
  });
}

export async function verifyRoomAuthorityEnvelopeV1(
  envelope: SignedRoomAuthorityEnvelopeV1,
  context: RoomAuthorityVerificationContextV1,
  policy: RoomAuthorityVerificationPolicyV1,
): Promise<RoomAuthorityClaimsV1> {
  return verifyRoomAuthorityEnvelopeInternal(envelope, context, policy, false);
}

/** Test seam only: explicitly permits process-local replay state. */
export async function verifyRoomAuthorityEnvelopeV1ForTest(
  envelope: SignedRoomAuthorityEnvelopeV1,
  context: RoomAuthorityVerificationContextV1,
  policy: RoomAuthorityTestVerificationPolicyV1,
): Promise<RoomAuthorityClaimsV1> {
  return verifyRoomAuthorityEnvelopeInternal(envelope, context, policy, true);
}

/**
 * Process-local replay protection for deterministic tests only. Separate
 * instances intentionally do not share replay state and production rejects it.
 */
export class TestOnlyInMemoryRoomAuthorityNonceStore implements TestOnlyRoomAuthorityNonceStoreV1 {
  readonly durability = "test-only-memory" as const;
  private readonly entries = new Map<string, number>();

  async consumeOnce(input: RoomAuthorityNonceConsumptionV1): Promise<boolean> {
    for (const [cacheKey, expiresAtMs] of this.entries) {
      if (expiresAtMs < input.consumedAtMs) {
        this.entries.delete(cacheKey);
      }
    }
    const cacheKey = stableSerializeRoomValue({
      issuer: input.issuer,
      keyId: input.keyId,
      nonce: input.nonce,
    });
    const existingExpiry = this.entries.get(cacheKey);
    if (existingExpiry !== undefined && existingExpiry >= input.consumedAtMs) {
      return false;
    }
    this.entries.set(cacheKey, input.replayRetainUntilMs);
    return true;
  }
}

async function verifyRoomAuthorityEnvelopeInternal(
  envelopeInput: SignedRoomAuthorityEnvelopeV1,
  contextInput: RoomAuthorityVerificationContextV1,
  policyInput: RoomAuthorityVerificationPolicyV1 | RoomAuthorityTestVerificationPolicyV1,
  allowTestOnlyNonceStore: boolean,
): Promise<RoomAuthorityClaimsV1> {
  const envelope = parseEnvelopeStrict(envelopeInput);
  const context = parseVerificationContextStrict(contextInput);
  const policy = parseVerificationPolicyStrict(policyInput, allowTestOnlyNonceStore);
  const { claims, proof } = envelope;

  assertOuterMatchesClaims(envelope);
  if (proof.algorithm !== ROOM_AUTHORITY_ALGORITHM) {
    throw new RoomAuthorityError("algorithm-confusion", "Room authority proof algorithm is not trusted");
  }
  if (proof.signature.length === 0) {
    throw new RoomAuthorityError("unsigned", "Room authority envelope is unsigned");
  }
  const signature = parseEd25519Signature(proof.signature);

  const trustedKey = policy.trustedKeys.get(proof.keyId);
  if (!trustedKey) {
    throw new RoomAuthorityError("unknown-key", "Room authority key is not trusted");
  }
  if (!policy.trustedIssuers.has(claims.issuer) || trustedKey.issuer !== claims.issuer) {
    throw new RoomAuthorityError("issuer-untrusted", "Room authority issuer is not trusted");
  }
  if (trustedKey.algorithm !== undefined && trustedKey.algorithm !== ROOM_AUTHORITY_ALGORITHM) {
    throw new RoomAuthorityError("algorithm-confusion", "Room authority key algorithm does not match Ed25519");
  }

  const nowMs = readNow(policy.now);
  const issuedAtMs = parseTimestamp(claims.issuedAt, "issuedAt", "invalid-envelope");
  const expiresAtMs = parseTimestamp(claims.expiresAt, "expiresAt", "invalid-envelope");
  if (expiresAtMs <= issuedAtMs) {
    throw new RoomAuthorityError("invalid-envelope", "Room authority expiry must be after issuance");
  }
  if (expiresAtMs - issuedAtMs > policy.maxLifetimeMs) {
    throw new RoomAuthorityError("lifetime-exceeded", "Room authority lifetime exceeds policy");
  }
  if (issuedAtMs > nowMs + policy.maxClockSkewMs) {
    throw new RoomAuthorityError("future-issued", "Room authority was issued in the future");
  }
  if (expiresAtMs < nowMs - policy.maxClockSkewMs) {
    throw new RoomAuthorityError("expired", "Room authority has expired");
  }

  assertContextMatches(claims, context);
  assertScopePolicy(claims, context.requiredScopes, policy.allowedScopesByActorType);

  let isValidSignature: boolean;
  try {
    isValidSignature = cryptoVerify(
      null,
      Buffer.from(serializeParsedClaims(claims), "utf8"),
      trustedKey.publicKey,
      signature,
    );
  } catch {
    throw new RoomAuthorityError("verification-failed", "Room authority cryptographic verification failed");
  }
  if (!isValidSignature) {
    throw new RoomAuthorityError("signature-invalid", "Room authority signature is invalid");
  }

  const consumption = Object.freeze({
    issuer: claims.issuer,
    keyId: proof.keyId,
    nonce: claims.nonce,
    authorityDigest: digestParsedEnvelope(envelope),
    expiresAt: claims.expiresAt,
    expiresAtMs,
    replayRetainUntilMs: expiresAtMs + policy.maxClockSkewMs,
    consumedAtMs: nowMs,
  });
  let consumed: boolean;
  try {
    consumed = await policy.nonceStore.consumeOnce.call(policy.nonceStore.target, consumption);
  } catch {
    throw new RoomAuthorityError("nonce-store-failed", "Room authority replay transaction failed");
  }
  if (typeof consumed !== "boolean") {
    throw new RoomAuthorityError("nonce-store-failed", "Room authority replay transaction returned an invalid result");
  }
  if (!consumed) {
    throw new RoomAuthorityError("replay-nonce", "Room authority nonce has already been used");
  }

  return claims;
}

function parseEnvelopeStrict(value: unknown): ParsedSignedRoomAuthorityEnvelopeV1 {
  const fields = inspectDataObject(value, "envelope", "invalid-envelope");
  assertExactFields(
    fields,
    ["version", "issuer", "issuedAt", "expiresAt", "claims", "proof"],
    [],
    "envelope",
    "invalid-envelope",
  );
  const version = parseNonEmptyString(fieldValue(fields, "version"), "version", "invalid-envelope");
  if (version !== ROOM_AUTHORITY_CLAIM_VERSION) {
    throw new RoomAuthorityError("invalid-envelope", "Room authority version is unsupported");
  }
  const envelope = {
    version,
    issuer: parseNonEmptyString(fieldValue(fields, "issuer"), "issuer", "invalid-envelope"),
    issuedAt: parseTimestampString(fieldValue(fields, "issuedAt"), "issuedAt", "invalid-envelope"),
    expiresAt: parseTimestampString(fieldValue(fields, "expiresAt"), "expiresAt", "invalid-envelope"),
    claims: parseClaimsStrict(fieldValue(fields, "claims")),
    proof: parseProofStrict(fieldValue(fields, "proof")),
  };
  return Object.freeze(envelope);
}

function parseProofStrict(value: unknown): ParsedRoomAuthorityProofV1 {
  const fields = inspectDataObject(value, "proof", "invalid-envelope");
  assertExactFields(fields, ["algorithm", "keyId", "signature"], [], "proof", "invalid-envelope");
  return Object.freeze({
    algorithm: parseNonEmptyString(fieldValue(fields, "algorithm"), "proof.algorithm", "invalid-envelope"),
    keyId: parseKeyId(fieldValue(fields, "keyId"), "proof.keyId", "invalid-envelope"),
    signature: parseString(
      fieldValue(fields, "signature"),
      "proof.signature",
      "invalid-signature-encoding",
      ROOM_AUTHORITY_CONTRACT_BOUNDS.maxSignatureLength,
    ),
  });
}

function parseClaimsStrict(value: unknown): RoomAuthorityClaimsV1 {
  const fields = inspectDataObject(value, "claims", "invalid-envelope");
  assertExactFields(
    fields,
    [
      "version",
      "issuer",
      "actorType",
      "actorId",
      "issuedAt",
      "expiresAt",
      "nonce",
      "commandId",
      "projectId",
      "roomId",
      "turnId",
      "nodeId",
      "target",
      "expectedAggregateVersion",
      "expectedMembershipVersion",
      "intent",
      "contentHash",
      "scopes",
    ],
    [],
    "claims",
    "invalid-envelope",
  );

  const version = parseNonEmptyString(fieldValue(fields, "version"), "version", "invalid-envelope");
  if (version !== ROOM_AUTHORITY_CLAIM_VERSION) {
    throw new RoomAuthorityError("invalid-envelope", "Room authority version is unsupported");
  }
  const actorType = parseActorType(fieldValue(fields, "actorType"));
  const intent = parseIntent(fieldValue(fields, "intent"));
  const contentHash = parseContentHash(fieldValue(fields, "contentHash"), "contentHash");
  const claims: RoomAuthorityClaimsV1 = {
    version,
    issuer: parseNonEmptyString(fieldValue(fields, "issuer"), "issuer", "invalid-envelope"),
    actorType,
    actorId: parseNonEmptyString(fieldValue(fields, "actorId"), "actorId", "invalid-envelope"),
    issuedAt: parseTimestampString(fieldValue(fields, "issuedAt"), "issuedAt", "invalid-envelope"),
    expiresAt: parseTimestampString(fieldValue(fields, "expiresAt"), "expiresAt", "invalid-envelope"),
    nonce: parseNonEmptyString(fieldValue(fields, "nonce"), "nonce", "invalid-envelope"),
    commandId: parseNonEmptyString(fieldValue(fields, "commandId"), "commandId", "invalid-envelope"),
    projectId: parseNonEmptyString(fieldValue(fields, "projectId"), "projectId", "invalid-envelope"),
    roomId: parseNonEmptyString(fieldValue(fields, "roomId"), "roomId", "invalid-envelope"),
    turnId: parseNullableIdentifier(fieldValue(fields, "turnId"), "turnId", "invalid-envelope"),
    nodeId: parseNullableIdentifier(fieldValue(fields, "nodeId"), "nodeId", "invalid-envelope"),
    target: parseTargetStrict(fieldValue(fields, "target"), "invalid-envelope"),
    expectedAggregateVersion: parseNonNegativeSafeInteger(
      fieldValue(fields, "expectedAggregateVersion"),
      "expectedAggregateVersion",
      "invalid-envelope",
    ),
    expectedMembershipVersion: parseNonNegativeSafeInteger(
      fieldValue(fields, "expectedMembershipVersion"),
      "expectedMembershipVersion",
      "invalid-envelope",
    ),
    intent,
    contentHash,
    scopes: parseScopesStrict(fieldValue(fields, "scopes"), "scopes", "invalid-envelope"),
  };
  return Object.freeze(claims);
}

function parseVerificationContextStrict(value: unknown): RoomAuthorityVerificationContextV1 {
  const fields = inspectDataObject(value, "verification context", "invalid-envelope");
  assertExactFields(
    fields,
    [
      "commandId",
      "projectId",
      "roomId",
      "turnId",
      "nodeId",
      "target",
      "expectedAggregateVersion",
      "expectedMembershipVersion",
      "intent",
      "contentHash",
      "requiredScopes",
    ],
    ["content"],
    "verification context",
    "invalid-envelope",
  );
  const context: RoomAuthorityVerificationContextV1 = {
    commandId: parseNonEmptyString(fieldValue(fields, "commandId"), "commandId", "invalid-envelope"),
    projectId: parseNonEmptyString(fieldValue(fields, "projectId"), "projectId", "invalid-envelope"),
    roomId: parseNonEmptyString(fieldValue(fields, "roomId"), "roomId", "invalid-envelope"),
    turnId: parseNullableIdentifier(fieldValue(fields, "turnId"), "turnId", "invalid-envelope"),
    nodeId: parseNullableIdentifier(fieldValue(fields, "nodeId"), "nodeId", "invalid-envelope"),
    target: parseTargetStrict(fieldValue(fields, "target"), "invalid-envelope"),
    expectedAggregateVersion: parseNonNegativeSafeInteger(
      fieldValue(fields, "expectedAggregateVersion"),
      "expectedAggregateVersion",
      "invalid-envelope",
    ),
    expectedMembershipVersion: parseNonNegativeSafeInteger(
      fieldValue(fields, "expectedMembershipVersion"),
      "expectedMembershipVersion",
      "invalid-envelope",
    ),
    intent: parseIntent(fieldValue(fields, "intent")),
    contentHash: parseContentHash(fieldValue(fields, "contentHash"), "contentHash"),
    requiredScopes: parseScopesStrict(fieldValue(fields, "requiredScopes"), "requiredScopes", "invalid-envelope"),
    ...(fields.has("content")
      ? {
          content: parseString(
            fieldValue(fields, "content"),
            "content",
            "invalid-envelope",
            ROOM_AUTHORITY_CONTRACT_BOUNDS.maxContentLength,
          ),
        }
      : {}),
  };
  return Object.freeze(context);
}

function parseVerificationPolicyStrict(
  value: unknown,
  allowTestOnlyNonceStore: boolean,
): ParsedVerificationPolicyV1 {
  const fields = inspectDataObject(value, "policy", "invalid-policy");
  if (!fields.has("nonceStore")) {
    throw new RoomAuthorityError("nonce-store-not-durable", "Production Room authority requires a durable atomic nonce store");
  }
  assertExactFields(
    fields,
    ["trustedIssuers", "trustedKeys", "allowedScopesByActorType", "maxLifetimeMs", "maxClockSkewMs", "nonceStore"],
    ["now"],
    "policy",
    "invalid-policy",
  );

  const trustedIssuers = parseStringArrayStrict(
    fieldValue(fields, "trustedIssuers"),
    "trustedIssuers",
    "invalid-policy",
    parsePolicyIdentifier,
  );
  if (trustedIssuers.length === 0) {
    throw new RoomAuthorityError("invalid-policy", "Room authority policy must trust at least one issuer");
  }
  if (new Set(trustedIssuers).size !== trustedIssuers.length) {
    throw new RoomAuthorityError("invalid-policy", "Room authority trusted issuers must not contain duplicates");
  }

  const maxLifetimeMs = parsePositiveSafeInteger(fieldValue(fields, "maxLifetimeMs"), "maxLifetimeMs", "invalid-policy");
  const maxClockSkewMs = parseNonNegativeSafeInteger(
    fieldValue(fields, "maxClockSkewMs"),
    "maxClockSkewMs",
    "invalid-policy",
  );
  const nowValue = fields.has("now") ? fieldValue(fields, "now") : Date.now;
  if (typeof nowValue !== "function") {
    throw new RoomAuthorityError("invalid-policy", "Room authority policy now must be a function");
  }

  return Object.freeze({
    trustedIssuers: new Set(trustedIssuers),
    trustedKeys: parseTrustedKeys(fieldValue(fields, "trustedKeys")),
    allowedScopesByActorType: parseAllowedScopes(fieldValue(fields, "allowedScopesByActorType")),
    maxLifetimeMs,
    maxClockSkewMs,
    now: nowValue as () => number,
    nonceStore: parseNonceStore(fieldValue(fields, "nonceStore"), allowTestOnlyNonceStore),
  });
}

function parseTrustedKeys(value: unknown): ReadonlyMap<string, ParsedTrustedKeyV1> {
  const fields = inspectDataObject(value, "trustedKeys", "invalid-policy");
  const keys = new Map<string, ParsedTrustedKeyV1>();
  for (const [keyId, descriptor] of fields) {
    parseKeyId(keyId, "trustedKeys keyId", "invalid-policy");
    const keyFields = inspectDataObject(descriptor.value, `trustedKeys.${keyId}`, "invalid-policy");
    assertExactFields(
      keyFields,
      ["issuer", "publicKey"],
      ["algorithm"],
      `trustedKeys.${keyId}`,
      "invalid-policy",
    );
    const algorithm = keyFields.has("algorithm")
      ? parseNonEmptyString(fieldValue(keyFields, "algorithm"), "trusted key algorithm", "invalid-policy")
      : undefined;
    keys.set(keyId, Object.freeze({
      issuer: parsePolicyIdentifier(fieldValue(keyFields, "issuer"), "trusted key issuer", "invalid-policy"),
      publicKey: parsePublicKey(fieldValue(keyFields, "publicKey")),
      algorithm,
    }));
  }
  return keys;
}

function parseAllowedScopes(
  value: unknown,
): ReadonlyMap<RoomAuthorityActorTypeV1, ReadonlySet<string>> {
  const fields = inspectDataObject(value, "allowedScopesByActorType", "invalid-policy");
  const allowedActorTypes = new Set<string>(ROOM_AUTHORITY_ACTOR_TYPES);
  const result = new Map<RoomAuthorityActorTypeV1, ReadonlySet<string>>();
  for (const [actorType, descriptor] of fields) {
    if (!allowedActorTypes.has(actorType)) {
      throw new RoomAuthorityError("invalid-policy", "Room authority policy contains an unknown actor type");
    }
    const scopes = parseScopesStrict(
      descriptor.value,
      `allowedScopesByActorType.${actorType}`,
      "invalid-policy",
      true,
    );
    result.set(actorType as RoomAuthorityActorTypeV1, new Set(scopes));
  }
  return result;
}

function parseNonceStore(value: unknown, allowTestOnly: boolean): ParsedNonceStoreV1 {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new RoomAuthorityError("nonce-store-not-durable", "Production Room authority requires a durable atomic nonce store");
  }
  const durability = findDataProperty(value, "durability", "nonce store", "nonce-store-not-durable");
  if (durability !== "durable-atomic" && !(allowTestOnly && durability === "test-only-memory")) {
    throw new RoomAuthorityError("nonce-store-not-durable", "Production Room authority requires a durable atomic nonce store");
  }
  const consumeOnce = findDataProperty(value, "consumeOnce", "nonce store", "nonce-store-not-durable");
  if (typeof consumeOnce !== "function") {
    throw new RoomAuthorityError("nonce-store-not-durable", "Room authority nonce store must provide consumeOnce");
  }
  return Object.freeze({
    target: value,
    consumeOnce: consumeOnce as (input: RoomAuthorityNonceConsumptionV1) => Promise<boolean>,
  });
}

function parsePrivateKey(value: unknown): KeyObject {
  try {
    if (!(value instanceof KeyObject) && typeof value !== "string" && !Buffer.isBuffer(value)) {
      throw new Error("unsupported key input");
    }
    const key = value instanceof KeyObject ? value : createPrivateKey(Buffer.isBuffer(value) ? Buffer.from(value) : value);
    if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
      throw new RoomAuthorityError("algorithm-confusion", "Room authority signing key must be an Ed25519 private key");
    }
    return key;
  } catch (error) {
    if (error instanceof RoomAuthorityError) throw error;
    throw new RoomAuthorityError("signing-failed", "Room authority signing key is invalid");
  }
}

function parsePublicKey(value: unknown): KeyObject {
  try {
    if (!(value instanceof KeyObject) && typeof value !== "string" && !Buffer.isBuffer(value)) {
      throw new Error("unsupported key input");
    }
    const key = value instanceof KeyObject ? value : createPublicKey(Buffer.isBuffer(value) ? Buffer.from(value) : value);
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
      throw new RoomAuthorityError("algorithm-confusion", "Room authority verification key must be an Ed25519 public key");
    }
    return key;
  } catch (error) {
    if (error instanceof RoomAuthorityError) throw error;
    throw new RoomAuthorityError("verification-failed", "Room authority verification key is invalid");
  }
}

function parseEd25519Signature(value: string): Buffer {
  if (!BASE64URL_PATTERN.test(value)) {
    throw new RoomAuthorityError("invalid-signature-encoding", "Room authority signature is not strict base64url");
  }
  const signature = Buffer.from(value, "base64url");
  if (signature.length !== ED25519_SIGNATURE_BYTES || signature.toString("base64url") !== value) {
    throw new RoomAuthorityError("invalid-signature-encoding", "Room authority signature has invalid Ed25519 encoding");
  }
  return signature;
}

function parseTargetStrict(value: unknown, code: RoomAuthorityErrorCode): RoomMessageTargetV1 {
  const fields = inspectDataObject(value, "target", code);
  const kind = parseNonEmptyString(fieldValue(fields, "kind"), "target.kind", code);
  switch (kind) {
    case "controller":
    case "all":
      assertExactFields(fields, ["kind"], [], "target", code);
      return Object.freeze({ kind });
    case "group":
      assertExactFields(fields, ["kind", "groupId"], [], "target", code);
      return Object.freeze({
        kind,
        groupId: parseNonEmptyString(fieldValue(fields, "groupId"), "target.groupId", code),
      });
    case "seats": {
      assertExactFields(fields, ["kind", "seatIds"], [], "target", code);
      const seatIds = parseStringArrayStrict(
        fieldValue(fields, "seatIds"),
        "target.seatIds",
        code,
        parsePolicyIdentifier,
      );
      if (seatIds.length === 0) {
        throw new RoomAuthorityError(code, "Room authority seat target must contain at least one seat");
      }
      if (new Set(seatIds).size !== seatIds.length) {
        throw new RoomAuthorityError(code, "Room authority seat target must not contain duplicates");
      }
      return Object.freeze({ kind, seatIds });
    }
    default:
      throw new RoomAuthorityError(code, "Room authority target kind is unsupported");
  }
}

function parseScopesStrict(
  value: unknown,
  label: string,
  code: RoomAuthorityErrorCode,
  allowEmpty = false,
): readonly string[] {
  const scopes = parseStringArrayStrict(value, label, code, parseScope);
  if (!allowEmpty && scopes.length === 0) {
    throw new RoomAuthorityError(code, `Room authority ${label} is required`);
  }
  if (new Set(scopes).size !== scopes.length) {
    throw new RoomAuthorityError(code, `Room authority ${label} must not contain duplicates`);
  }
  return scopes;
}

function parseStringArrayStrict(
  value: unknown,
  label: string,
  code: RoomAuthorityErrorCode,
  parseEntry: (value: unknown, label: string, code: RoomAuthorityErrorCode) => string,
): readonly string[] {
  const entries = inspectDenseArray(value, label, code);
  return Object.freeze(entries.map((entry, index) => parseEntry(entry, `${label}[${index}]`, code)));
}

function inspectDataObject(value: unknown, label: string, code: RoomAuthorityErrorCode): DataFieldMap {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value)) {
    throw new RoomAuthorityError(code, `Room authority ${label} must be a plain data object`);
  }
  let prototype: object | null;
  let ownKeys: readonly PropertyKey[];
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    ownKeys = Reflect.ownKeys(value);
  } catch {
    throw new RoomAuthorityError(code, `Room authority ${label} cannot be inspected safely`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new RoomAuthorityError(code, `Room authority ${label} must be a plain data object`);
  }
  if (ownKeys.length > ROOM_AUTHORITY_CONTRACT_BOUNDS.maxObjectFields) {
    throw new RoomAuthorityError(code, `Room authority ${label} exceeds the object field limit`);
  }

  const result = new Map<string, PropertyDescriptor>();
  for (const key of ownKeys) {
    if (typeof key !== "string") {
      throw new RoomAuthorityError(code, `Room authority ${label} must not contain symbol fields`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new RoomAuthorityError(code, `Room authority ${label}.${key} must be an enumerable data field`);
    }
    result.set(key, descriptor);
  }
  return result;
}

function inspectDenseArray(value: unknown, label: string, code: RoomAuthorityErrorCode): readonly unknown[] {
  if (value === null || typeof value !== "object" || utilTypes.isProxy(value) || !Array.isArray(value)) {
    throw new RoomAuthorityError(code, `Room authority ${label} must be a dense array`);
  }
  let prototype: object | null;
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch {
    throw new RoomAuthorityError(code, `Room authority ${label} cannot be inspected safely`);
  }
  if (prototype !== Array.prototype) {
    throw new RoomAuthorityError(code, `Room authority ${label} must be a plain array`);
  }
  if (
    !lengthDescriptor
    || lengthDescriptor.enumerable !== false
    || !("value" in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value)
    || (lengthDescriptor.value as number) < 0
  ) {
    throw new RoomAuthorityError(code, `Room authority ${label} has an invalid length`);
  }
  const length = lengthDescriptor.value as number;
  if (length > ROOM_AUTHORITY_CONTRACT_BOUNDS.maxArrayItems) {
    throw new RoomAuthorityError(code, `Room authority ${label} exceeds the array item limit`);
  }

  let ownKeys: readonly PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    throw new RoomAuthorityError(code, `Room authority ${label} cannot be inspected safely`);
  }
  if (ownKeys.length !== length + 1) {
    throw new RoomAuthorityError(code, `Room authority ${label} must be dense and contain no extra fields`);
  }
  for (const key of ownKeys) {
    if (typeof key !== "string") {
      throw new RoomAuthorityError(code, `Room authority ${label} must not contain symbol fields`);
    }
  }

  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) {
      throw new RoomAuthorityError(code, `Room authority ${label} must contain enumerable data entries`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function assertExactFields(
  fields: DataFieldMap,
  required: readonly string[],
  optional: readonly string[],
  label: string,
  code: RoomAuthorityErrorCode,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of fields.keys()) {
    if (!allowed.has(key)) {
      throw new RoomAuthorityError(code, `Room authority ${label} contains an unknown field`);
    }
  }
  for (const key of required) {
    if (!fields.has(key)) {
      throw new RoomAuthorityError(code, `Room authority ${label} is missing a required field`);
    }
  }
}

function fieldValue(fields: DataFieldMap, key: string): unknown {
  const descriptor = fields.get(key);
  if (!descriptor || !("value" in descriptor)) {
    throw new RoomAuthorityError("invalid-envelope", "Room authority input is missing a required data field");
  }
  return descriptor.value;
}

function findDataProperty(
  value: object,
  key: string,
  label: string,
  code: RoomAuthorityErrorCode,
): unknown {
  let current: object | null = value;
  while (current !== null && current !== Object.prototype) {
    if (utilTypes.isProxy(current)) {
      throw new RoomAuthorityError(code, `Room authority ${label} cannot be a proxy`);
    }
    let descriptor: PropertyDescriptor | undefined;
    let prototype: object | null;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, key);
      prototype = Object.getPrototypeOf(current) as object | null;
    } catch {
      throw new RoomAuthorityError(code, `Room authority ${label} cannot be inspected safely`);
    }
    if (descriptor) {
      if (!("value" in descriptor)) {
        throw new RoomAuthorityError(code, `Room authority ${label}.${key} must be a data property`);
      }
      return descriptor.value;
    }
    current = prototype;
  }
  throw new RoomAuthorityError(code, `Room authority ${label} is missing ${key}`);
}

function serializeParsedClaims(claims: RoomAuthorityClaimsV1): string {
  return stableSerializeRoomValue({
    version: claims.version,
    issuer: claims.issuer,
    actorType: claims.actorType,
    actorId: claims.actorId,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
    nonce: claims.nonce,
    commandId: claims.commandId,
    projectId: claims.projectId,
    roomId: claims.roomId,
    turnId: claims.turnId,
    nodeId: claims.nodeId,
    target: claims.target,
    expectedAggregateVersion: claims.expectedAggregateVersion,
    expectedMembershipVersion: claims.expectedMembershipVersion,
    intent: claims.intent,
    contentHash: claims.contentHash,
    scopes: claims.scopes,
  });
}

function digestParsedEnvelope(envelope: ParsedSignedRoomAuthorityEnvelopeV1): string {
  return hashRoomValue({
    version: envelope.version,
    issuer: envelope.issuer,
    issuedAt: envelope.issuedAt,
    expiresAt: envelope.expiresAt,
    claims: envelope.claims,
    proof: envelope.proof,
  });
}

function assertOuterMatchesClaims(envelope: ParsedSignedRoomAuthorityEnvelopeV1): void {
  if (
    envelope.version !== envelope.claims.version
    || envelope.issuer !== envelope.claims.issuer
    || envelope.issuedAt !== envelope.claims.issuedAt
    || envelope.expiresAt !== envelope.claims.expiresAt
  ) {
    throw new RoomAuthorityError("outer-mismatch", "Room authority envelope outer metadata does not match claims");
  }
}

function assertContextMatches(
  claims: RoomAuthorityClaimsV1,
  context: RoomAuthorityVerificationContextV1,
): void {
  if (claims.commandId !== context.commandId) {
    throw new RoomAuthorityError("command-mismatch", "Room authority command does not match the routed command");
  }
  if (claims.projectId !== context.projectId || claims.roomId !== context.roomId) {
    throw new RoomAuthorityError("project-room-mismatch", "Room authority project or Room does not match the routed command");
  }
  if (claims.turnId !== context.turnId) {
    throw new RoomAuthorityError("turn-mismatch", "Room authority turn does not match the routed command");
  }
  if (claims.nodeId !== context.nodeId) {
    throw new RoomAuthorityError("node-mismatch", "Room authority node does not match the routed command");
  }
  if (stableSerializeRoomValue(claims.target) !== stableSerializeRoomValue(context.target)) {
    throw new RoomAuthorityError("target-mismatch", "Room authority target does not match the routed command");
  }
  if (
    claims.expectedAggregateVersion !== context.expectedAggregateVersion
    || claims.expectedMembershipVersion !== context.expectedMembershipVersion
  ) {
    throw new RoomAuthorityError("expected-version-mismatch", "Room authority expected versions do not match the routed command");
  }
  if (claims.intent !== context.intent) {
    throw new RoomAuthorityError("intent-mismatch", "Room authority intent does not match the routed command");
  }
  if (claims.contentHash !== context.contentHash) {
    throw new RoomAuthorityError("content-tamper", "Room authority content hash does not match the routed command");
  }
  if (context.content !== undefined && hashRoomValue(context.content) !== claims.contentHash) {
    throw new RoomAuthorityError("content-tamper", "Room authority content hash does not match the message content");
  }
}

function assertScopePolicy(
  claims: RoomAuthorityClaimsV1,
  requiredScopes: readonly string[],
  allowedScopesByActorType: ReadonlyMap<RoomAuthorityActorTypeV1, ReadonlySet<string>>,
): void {
  const claimScopeSet = new Set(claims.scopes);
  for (const requiredScope of requiredScopes) {
    if (!claimScopeSet.has(requiredScope)) {
      throw new RoomAuthorityError("scope-missing", "Room authority does not include the required scope");
    }
  }

  const allowedScopes = allowedScopesByActorType.get(claims.actorType) ?? new Set<string>();
  for (const scope of claims.scopes) {
    if (!allowedScopes.has(scope)) {
      throw new RoomAuthorityError("scope-escalation", "Room authority scope exceeds actor policy");
    }
  }

  if (claims.actorType === "seat" && claims.scopes.some(isPeerSelfGrantScope)) {
    throw new RoomAuthorityError("forbidden-peer-grant", "Peer-issued Room authority cannot self-grant high-risk scopes");
  }
}

function parseActorType(value: unknown): RoomAuthorityActorTypeV1 {
  const actorType = parseNonEmptyString(value, "actorType", "invalid-envelope");
  if (!(ROOM_AUTHORITY_ACTOR_TYPES as readonly string[]).includes(actorType)) {
    throw new RoomAuthorityError("invalid-envelope", "Room authority actorType is unsupported");
  }
  return actorType as RoomAuthorityActorTypeV1;
}

function parseIntent(value: unknown): RoomMessageIntent {
  const intent = parseNonEmptyString(value, "intent", "invalid-envelope");
  if (!(ROOM_MESSAGE_INTENTS as readonly string[]).includes(intent)) {
    throw new RoomAuthorityError("invalid-envelope", "Room authority intent is unsupported");
  }
  return intent as RoomMessageIntent;
}

function parseScope(value: unknown, label: string, code: RoomAuthorityErrorCode): string {
  const scope = parseNonEmptyString(value, label, code, ROOM_AUTHORITY_CONTRACT_BOUNDS.maxScopeLength);
  const segments = scope.split(":");
  if (
    segments.length < 2
    || !(ROOM_AUTHORITY_SCOPE_NAMESPACES as readonly string[]).includes(segments[0] ?? "")
    || segments.some((segment) => !SCOPE_SEGMENT_PATTERN.test(segment))
  ) {
    throw new RoomAuthorityError(code, `Room authority ${label} is outside the scope vocabulary`);
  }
  return scope;
}

function parseContentHash(value: unknown, label: string): string {
  const contentHash = parseNonEmptyString(value, label, "invalid-envelope");
  if (!CONTENT_HASH_PATTERN.test(contentHash)) {
    throw new RoomAuthorityError("invalid-envelope", `Room authority ${label} must be a canonical SHA-256 digest`);
  }
  return contentHash;
}

function parseKeyId(value: unknown, label: string, code: RoomAuthorityErrorCode): string {
  const keyId = parseNonEmptyString(value, label, code);
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new RoomAuthorityError(code, `Room authority ${label} is invalid`);
  }
  return keyId;
}

function parseNullableIdentifier(value: unknown, label: string, code: RoomAuthorityErrorCode): string | null {
  return value === null ? null : parseNonEmptyString(value, label, code);
}

function parsePolicyIdentifier(value: unknown, label: string, code: RoomAuthorityErrorCode): string {
  return parseNonEmptyString(value, label, code);
}

function parseTimestampString(value: unknown, label: string, code: RoomAuthorityErrorCode): string {
  const timestamp = parseNonEmptyString(value, label, code);
  parseTimestamp(timestamp, label, code);
  return timestamp;
}

function parseTimestamp(value: string, label: string, code: RoomAuthorityErrorCode): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new RoomAuthorityError(code, `Room authority ${label} is not a canonical timestamp`);
  }
  return parsed;
}

function parseString(
  value: unknown,
  label: string,
  code: RoomAuthorityErrorCode,
  maxLength: number = ROOM_AUTHORITY_CONTRACT_BOUNDS.maxStringLength,
): string {
  if (typeof value !== "string") {
    throw new RoomAuthorityError(code, `Room authority ${label} must be a string`);
  }
  if (value.length > maxLength) {
    throw new RoomAuthorityError(code, `Room authority ${label} exceeds the string length limit`);
  }
  return value;
}

function parseNonEmptyString(
  value: unknown,
  label: string,
  code: RoomAuthorityErrorCode,
  maxLength: number = ROOM_AUTHORITY_CONTRACT_BOUNDS.maxStringLength,
): string {
  const parsed = parseString(value, label, code, maxLength);
  if (parsed.length === 0 || parsed.trim() !== parsed) {
    throw new RoomAuthorityError(code, `Room authority ${label} is required`);
  }
  return parsed;
}

function parseNonNegativeSafeInteger(value: unknown, label: string, code: RoomAuthorityErrorCode): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RoomAuthorityError(code, `Room authority ${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function parsePositiveSafeInteger(value: unknown, label: string, code: RoomAuthorityErrorCode): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new RoomAuthorityError(code, `Room authority ${label} must be a positive safe integer`);
  }
  return value as number;
}

function readNow(now: () => number): number {
  let value: number;
  try {
    value = now();
  } catch {
    throw new RoomAuthorityError("invalid-policy", "Room authority policy clock failed");
  }
  if (!Number.isFinite(value)) {
    throw new RoomAuthorityError("invalid-policy", "Room authority policy clock returned an invalid time");
  }
  return value;
}

function isPeerSelfGrantScope(scope: string): boolean {
  return HIGH_RISK_PEER_SCOPE_NAMESPACES.has(scope.split(":", 1)[0] ?? "");
}

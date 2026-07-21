import { createHash, randomBytes } from "node:crypto";

import type {
  DecideRoomRbacAuthorizationInputV1,
  RoomHumanTakeoverLeaseV1,
  RoomRbacAuthorizationSnapshotV1,
  RoomRbacGrantV1,
  RoomRbacRequestV1,
  RoomRbacRoleV1,
  TrustedRoomDeviceSessionV1,
} from "./room-rbac-policy.js";

export const ROOM_RBAC_REGISTRY_CONTRACT_VERSION = 1 as const;

const ROOM_RBAC_ROLES = ["owner", "admin", "operator", "observer", "auditor"] as const;
const ROOM_RBAC_OPERATION_KINDS = ["issue_trusted_device_session", "revoke_trusted_device_session", "grant_role", "revoke_role_grant"] as const;
const ROOM_RBAC_PROJECT_ACTIONS = ["list_rooms", "create_room"] as const;
const ROOM_RBAC_ROLE_RANK = new Map<RoomRbacRoleV1, number>(ROOM_RBAC_ROLES.map((role, index) => [role, index]));
const ROOM_RBAC_PROJECT_ROLE_ACTIONS: Readonly<Record<RoomRbacRoleV1, ReadonlySet<RoomRbacProjectActionV1>>> = {
  owner: new Set(ROOM_RBAC_PROJECT_ACTIONS),
  admin: new Set(ROOM_RBAC_PROJECT_ACTIONS),
  operator: new Set(ROOM_RBAC_PROJECT_ACTIONS),
  observer: new Set(["list_rooms"]),
  auditor: new Set(["list_rooms"]),
};

export type RoomRbacRegistryOperationKindV1 = (typeof ROOM_RBAC_OPERATION_KINDS)[number];
export type RoomRbacRegistryIssueCodeV1 =
  | "invalid_input"
  | "invalid_credential"
  | "trusted_device_session_not_found"
  | "trusted_device_session_project_scope_denied"
  | "trusted_device_session_not_yet_valid"
  | "trusted_device_session_expired"
  | "trusted_device_session_revoked"
  | "trusted_device_session_already_exists"
  | "trusted_device_credential_already_issued"
  | "trusted_device_session_version_conflict"
  | "trusted_device_session_already_revoked"
  | "grant_not_found"
  | "grant_already_exists"
  | "grant_already_revoked"
  | "authorization_version_conflict"
  | "idempotency_key_conflict"
  | "no_effective_project_or_room_grant"
  | "snapshot_scope_mismatch"
  | "registry_unavailable";

export class RoomRbacRegistryError extends Error {
  readonly code: RoomRbacRegistryIssueCodeV1;

  constructor(code: RoomRbacRegistryIssueCodeV1, message: string) {
    super(message);
    this.name = "RoomRbacRegistryError";
    this.code = code;
  }
}

export interface StoredRoomTrustedDeviceSessionV1 extends TrustedRoomDeviceSessionV1 {
  readonly projectId: string;
  readonly credentialDigest: string;
}

export interface RoomRbacAuthorizationStateV1 {
  readonly projectId: string;
  readonly authorizationVersion: number;
  readonly updatedAt: string;
}

export interface RoomRbacRegistryOperationRecordV1 {
  readonly projectId: string;
  readonly commandKind: RoomRbacRegistryOperationKindV1;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly entityType: "trusted_device_session" | "role_grant";
  readonly entityId: string;
  readonly authorizationVersion: number | null;
  readonly sessionVersion: number | null;
  readonly occurredAt: string;
}

export interface RoomRbacRegistryTransactionV1 {
  getTrustedDeviceSession(projectId: string, sessionId: string): Promise<StoredRoomTrustedDeviceSessionV1 | null>;
  getTrustedDeviceSessionByCredentialDigest(projectId: string, credentialDigest: string): Promise<StoredRoomTrustedDeviceSessionV1 | null>;
  hasTrustedDeviceSessionOutsideProject(projectId: string, credentialDigest: string): Promise<boolean>;
  insertTrustedDeviceSession(session: StoredRoomTrustedDeviceSessionV1): Promise<void>;
  replaceTrustedDeviceSession(
    session: StoredRoomTrustedDeviceSessionV1,
    expectedSessionVersion: number,
  ): Promise<boolean>;
  getAuthorizationState(projectId: string): Promise<RoomRbacAuthorizationStateV1 | null>;
  compareAndSetAuthorizationState(
    state: RoomRbacAuthorizationStateV1,
    expectedAuthorizationVersion: number,
  ): Promise<boolean>;
  getGrant(projectId: string, grantId: string): Promise<RoomRbacGrantV1 | null>;
  insertGrant(grant: RoomRbacGrantV1): Promise<void>;
  revokeGrant(projectId: string, grantId: string, revokedAt: string): Promise<boolean>;
  listSnapshotGrants(input: {
    readonly projectId: string;
    readonly principalId: string;
    readonly roomId: string | null;
    readonly requestedAt: string;
  }): Promise<readonly RoomRbacGrantV1[]>;
  getOperation(input: {
    readonly projectId: string;
    readonly commandKind: RoomRbacRegistryOperationKindV1;
    readonly idempotencyKey: string;
  }): Promise<RoomRbacRegistryOperationRecordV1 | null>;
  insertOperation(operation: RoomRbacRegistryOperationRecordV1): Promise<void>;
}

export interface RoomRbacRegistryPersistenceV1 {
  transaction<T>(operation: (transaction: RoomRbacRegistryTransactionV1) => Promise<T>): Promise<T>;
}

export interface IssueTrustedRoomDeviceSessionInputV1 {
  readonly contractVersion: 1;
  readonly projectId: string;
  readonly sessionId: string;
  readonly principalId: string;
  readonly deviceId: string;
  readonly credential: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly idempotencyKey: string;
}

export interface RevokeTrustedRoomDeviceSessionInputV1 {
  readonly contractVersion: 1;
  readonly projectId: string;
  readonly sessionId: string;
  readonly expectedSessionVersion: number;
  readonly revokedAt: string;
  readonly idempotencyKey: string;
}

export interface GrantRoomRbacRoleInputV1 {
  readonly contractVersion: 1;
  readonly projectId: string;
  readonly grantId: string;
  readonly principalId: string;
  readonly role: RoomRbacRoleV1;
  readonly roomId: string | null;
  readonly grantedAt: string;
  readonly expectedAuthorizationVersion: number;
  readonly idempotencyKey: string;
}

export interface RevokeRoomRbacGrantInputV1 {
  readonly contractVersion: 1;
  readonly projectId: string;
  readonly grantId: string;
  readonly revokedAt: string;
  readonly expectedAuthorizationVersion: number;
  readonly idempotencyKey: string;
}

export interface ReadAuthorizedRoomRbacSnapshotInputV1 {
  readonly contractVersion: 1;
  readonly projectId: string;
  readonly roomId: string;
  readonly credential: string;
  readonly requestedAt: string;
}

export interface ReadAuthorizedProjectRbacSnapshotInputV1 {
  readonly contractVersion: 1;
  readonly projectId: string;
  readonly credential: string;
  readonly requestedAt: string;
}

export type RoomRbacProjectActionV1 = (typeof ROOM_RBAC_PROJECT_ACTIONS)[number];

export interface RoomRbacProjectRequestV1 {
  readonly projectId: string;
  readonly action: RoomRbacProjectActionV1;
  readonly expectedAuthorizationVersion: number;
  readonly requestedAt: string;
}

export interface RoomRbacRegistrySessionMutationResultV1 {
  readonly session: TrustedRoomDeviceSessionV1;
  readonly idempotentReplay: boolean;
}

export interface RoomRbacRegistryGrantMutationResultV1 {
  readonly grant: RoomRbacGrantV1;
  readonly authorizationVersion: number;
  readonly idempotentReplay: boolean;
}

export interface ValidatedRoomRbacAuthorizationSnapshotV1 {
  readonly source: "durable_room_rbac_registry";
  readonly projectId: string;
  readonly roomId: string;
  readonly trustedDeviceSession: TrustedRoomDeviceSessionV1;
  readonly authorizationSnapshot: RoomRbacAuthorizationSnapshotV1;
}

export interface ValidatedProjectRbacAuthorizationSnapshotV1 {
  readonly source: "durable_room_rbac_registry";
  readonly projectId: string;
  readonly trustedDeviceSession: TrustedRoomDeviceSessionV1;
  readonly authorizationSnapshot: RoomRbacAuthorizationSnapshotV1;
}

export interface RoomRbacRegistryReadIssueV1 {
  readonly code: RoomRbacRegistryIssueCodeV1;
}

export interface RoomRbacRegistryReadFailureV1 {
  readonly ok: false;
  readonly issue: RoomRbacRegistryReadIssueV1;
}

export type ReadAuthorizedRoomRbacSnapshotResultV1 =
  | { readonly ok: true; readonly snapshot: ValidatedRoomRbacAuthorizationSnapshotV1 }
  | RoomRbacRegistryReadFailureV1;

export type ReadAuthorizedProjectRbacSnapshotResultV1 =
  | { readonly ok: true; readonly snapshot: ValidatedProjectRbacAuthorizationSnapshotV1 }
  | RoomRbacRegistryReadFailureV1;

export interface ToRoomRbacDecisionInputV1 {
  readonly snapshot: ValidatedRoomRbacAuthorizationSnapshotV1;
  readonly request: RoomRbacRequestV1;
  readonly activeTakeoverLeases: readonly RoomHumanTakeoverLeaseV1[];
}

export interface ToRoomRbacProjectDecisionInputV1 {
  readonly snapshot: ValidatedProjectRbacAuthorizationSnapshotV1;
  readonly request: RoomRbacProjectRequestV1;
}

export interface DecideRoomRbacProjectAuthorizationInputV1 {
  readonly contractVersion: 1;
  readonly trustedDeviceSession: TrustedRoomDeviceSessionV1;
  readonly authorizationSnapshot: RoomRbacAuthorizationSnapshotV1;
  readonly request: RoomRbacProjectRequestV1;
}

export type RoomRbacProjectAuthorizationReasonCodeV1 =
  | "invalid_input"
  | "unexpected_input_property"
  | "unexpected_request_property"
  | "trusted_session_not_yet_valid"
  | "trusted_session_revoked"
  | "trusted_session_expired"
  | "authorization_version_conflict"
  | "no_project_grant"
  | "role_action_forbidden";

export interface RoomRbacProjectAuthorizationDecisionV1 {
  readonly ok: boolean;
  readonly authorized: boolean;
  readonly authorizationVersion: number | null;
  readonly effectiveRoles: readonly RoomRbacRoleV1[];
  readonly reasonCodes: readonly RoomRbacProjectAuthorizationReasonCodeV1[];
}

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) Object.freeze(value);
  return value;
}

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return freeze([...items]);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const received = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return received.length === sortedExpected.length && received.every((key, index) => key === sortedExpected[index]);
}

function canonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRoomRbacRole(value: unknown): value is RoomRbacRoleV1 {
  return typeof value === "string" && (ROOM_RBAC_ROLES as readonly string[]).includes(value);
}

function isRoomRbacProjectAction(value: unknown): value is RoomRbacProjectActionV1 {
  return typeof value === "string" && (ROOM_RBAC_PROJECT_ACTIONS as readonly string[]).includes(value);
}

function earlierThan(left: string, right: string): boolean {
  return Date.parse(left) < Date.parse(right);
}

function atOrBefore(left: string, right: string): boolean {
  return Date.parse(left) <= Date.parse(right);
}

function opaqueCredential(value: unknown): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43,}$/.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.length >= 32 && bytes.toString("base64url") === value;
  } catch {
    return false;
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}

export function digestTrustedRoomDeviceCredential(credential: string): string {
  if (!opaqueCredential(credential)) {
    throw new RoomRbacRegistryError("invalid_credential", "Trusted device credentials must be opaque base64url values with at least 256 bits of entropy");
  }
  return `sha256:${createHash("sha256").update(credential, "utf8").digest("hex")}`;
}

export function createTrustedRoomDeviceCredential(): string {
  return randomBytes(32).toString("base64url");
}

function toTrustedSession(session: StoredRoomTrustedDeviceSessionV1): TrustedRoomDeviceSessionV1 {
  return freeze({
    source: "trusted_device_session_registry",
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    principalId: session.principalId,
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
    revokedAt: session.revokedAt,
    sessionVersion: session.sessionVersion,
  });
}

function toGrant(grant: RoomRbacGrantV1): RoomRbacGrantV1 {
  return freeze({ ...grant });
}

function fail(code: RoomRbacRegistryIssueCodeV1): RoomRbacRegistryReadFailureV1 {
  return freeze({ ok: false, issue: freeze({ code }) });
}

function assertContractVersion(value: unknown): asserts value is 1 {
  if (value !== ROOM_RBAC_REGISTRY_CONTRACT_VERSION) {
    throw new RoomRbacRegistryError("invalid_input", "Unsupported Room RBAC registry contract version");
  }
}

function assertIssueInput(input: IssueTrustedRoomDeviceSessionInputV1): void {
  assertContractVersion(input.contractVersion);
  if (!nonEmptyString(input.projectId) || !nonEmptyString(input.sessionId) || !nonEmptyString(input.principalId) || !nonEmptyString(input.deviceId) || !nonEmptyString(input.idempotencyKey)) {
    throw new RoomRbacRegistryError("invalid_input", "Trusted device session issuance requires non-empty project, session, principal, device, and idempotency identifiers");
  }
  if (!opaqueCredential(input.credential)) {
    throw new RoomRbacRegistryError("invalid_credential", "Trusted device credentials must be opaque base64url values with at least 256 bits of entropy");
  }
  if (!canonicalTimestamp(input.issuedAt) || !canonicalTimestamp(input.expiresAt) || !earlierThan(input.issuedAt, input.expiresAt)) {
    throw new RoomRbacRegistryError("invalid_input", "Trusted device session expiry must be a canonical timestamp after issuance");
  }
}

function assertRevokeSessionInput(input: RevokeTrustedRoomDeviceSessionInputV1): void {
  assertContractVersion(input.contractVersion);
  if (!nonEmptyString(input.projectId) || !nonEmptyString(input.sessionId) || !nonEmptyString(input.idempotencyKey) || !positiveInteger(input.expectedSessionVersion) || !canonicalTimestamp(input.revokedAt)) {
    throw new RoomRbacRegistryError("invalid_input", "Trusted device session revocation requires a project, session, idempotency key, positive session version, and canonical timestamp");
  }
}

function assertGrantInput(input: GrantRoomRbacRoleInputV1): void {
  assertContractVersion(input.contractVersion);
  if (!nonEmptyString(input.projectId) || !nonEmptyString(input.grantId) || !nonEmptyString(input.principalId) || !nonEmptyString(input.idempotencyKey) || !isRoomRbacRole(input.role) || (input.roomId !== null && !nonEmptyString(input.roomId)) || !canonicalTimestamp(input.grantedAt) || !nonNegativeInteger(input.expectedAuthorizationVersion)) {
    throw new RoomRbacRegistryError("invalid_input", "Room role grants require a valid project scope, role, timestamp, idempotency key, and expected authorization version");
  }
}

function assertRevokeGrantInput(input: RevokeRoomRbacGrantInputV1): void {
  assertContractVersion(input.contractVersion);
  if (!nonEmptyString(input.projectId) || !nonEmptyString(input.grantId) || !nonEmptyString(input.idempotencyKey) || !canonicalTimestamp(input.revokedAt) || !nonNegativeInteger(input.expectedAuthorizationVersion)) {
    throw new RoomRbacRegistryError("invalid_input", "Room role revocation requires a project, grant, idempotency key, canonical timestamp, and expected authorization version");
  }
}

function isValidReadInput(input: ReadAuthorizedRoomRbacSnapshotInputV1): boolean {
  return input.contractVersion === ROOM_RBAC_REGISTRY_CONTRACT_VERSION
    && nonEmptyString(input.projectId)
    && nonEmptyString(input.roomId)
    && opaqueCredential(input.credential)
    && canonicalTimestamp(input.requestedAt);
}

function isValidProjectReadInput(input: ReadAuthorizedProjectRbacSnapshotInputV1): boolean {
  return isRecord(input)
    && exactKeys(input, ["contractVersion", "projectId", "credential", "requestedAt"])
    && input.contractVersion === ROOM_RBAC_REGISTRY_CONTRACT_VERSION
    && nonEmptyString(input.projectId)
    && opaqueCredential(input.credential)
    && canonicalTimestamp(input.requestedAt);
}

function validTrustedDeviceSession(value: unknown): value is TrustedRoomDeviceSessionV1 {
  if (!isRecord(value) || !exactKeys(value, ["source", "sessionId", "deviceId", "principalId", "issuedAt", "expiresAt", "revokedAt", "sessionVersion"])) return false;
  return value.source === "trusted_device_session_registry"
    && nonEmptyString(value.sessionId) && nonEmptyString(value.deviceId) && nonEmptyString(value.principalId)
    && canonicalTimestamp(value.issuedAt) && canonicalTimestamp(value.expiresAt) && atOrBefore(value.issuedAt, value.expiresAt)
    && (value.revokedAt === null || canonicalTimestamp(value.revokedAt)) && positiveInteger(value.sessionVersion);
}

function validRoomRbacGrant(value: unknown): value is RoomRbacGrantV1 {
  if (!isRecord(value) || !exactKeys(value, ["grantId", "principalId", "role", "projectId", "roomId", "grantedAt", "revokedAt"])) return false;
  return nonEmptyString(value.grantId) && nonEmptyString(value.principalId) && isRoomRbacRole(value.role)
    && nonEmptyString(value.projectId) && (value.roomId === null || nonEmptyString(value.roomId)) && canonicalTimestamp(value.grantedAt)
    && (value.revokedAt === null || canonicalTimestamp(value.revokedAt));
}

function validAuthorizationSnapshot(value: unknown): value is RoomRbacAuthorizationSnapshotV1 {
  return isRecord(value) && exactKeys(value, ["source", "authorizationVersion", "grants"])
    && value.source === "durable_room_rbac_registry" && positiveInteger(value.authorizationVersion)
    && Array.isArray(value.grants) && value.grants.every(validRoomRbacGrant)
    && new Set(value.grants.map((grant) => grant.grantId)).size === value.grants.length;
}

function validProjectRequest(value: unknown): value is RoomRbacProjectRequestV1 {
  return isRecord(value) && exactKeys(value, ["projectId", "action", "expectedAuthorizationVersion", "requestedAt"])
    && nonEmptyString(value.projectId) && isRoomRbacProjectAction(value.action)
    && positiveInteger(value.expectedAuthorizationVersion) && canonicalTimestamp(value.requestedAt);
}

function buildIssueRequestHash(input: IssueTrustedRoomDeviceSessionInputV1, credentialDigest: string): string {
  return requestHash({
    projectId: input.projectId,
    sessionId: input.sessionId,
    principalId: input.principalId,
    deviceId: input.deviceId,
    credentialDigest,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
  });
}

function buildRevokeSessionRequestHash(input: RevokeTrustedRoomDeviceSessionInputV1): string {
  return requestHash({
    projectId: input.projectId,
    sessionId: input.sessionId,
    expectedSessionVersion: input.expectedSessionVersion,
    revokedAt: input.revokedAt,
  });
}

function buildGrantRequestHash(input: GrantRoomRbacRoleInputV1): string {
  return requestHash({
    projectId: input.projectId,
    grantId: input.grantId,
    principalId: input.principalId,
    role: input.role,
    roomId: input.roomId,
    grantedAt: input.grantedAt,
    expectedAuthorizationVersion: input.expectedAuthorizationVersion,
  });
}

function buildRevokeGrantRequestHash(input: RevokeRoomRbacGrantInputV1): string {
  return requestHash({
    projectId: input.projectId,
    grantId: input.grantId,
    revokedAt: input.revokedAt,
    expectedAuthorizationVersion: input.expectedAuthorizationVersion,
  });
}

async function requireMatchingOperation(
  transaction: RoomRbacRegistryTransactionV1,
  input: {
    readonly projectId: string;
    readonly commandKind: RoomRbacRegistryOperationKindV1;
    readonly idempotencyKey: string;
    readonly requestHash: string;
  },
): Promise<RoomRbacRegistryOperationRecordV1 | null> {
  const operation = await transaction.getOperation(input);
  if (operation && operation.requestHash !== input.requestHash) {
    throw new RoomRbacRegistryError("idempotency_key_conflict", "Room RBAC idempotency key was already used with a different request");
  }
  return operation;
}

function currentAuthorizationVersion(state: RoomRbacAuthorizationStateV1 | null): number {
  return state?.authorizationVersion ?? 0;
}

interface AuthorizedRbacScopeReadInputV1 {
  readonly projectId: string;
  readonly roomId: string | null;
  readonly credential: string;
  readonly requestedAt: string;
}

interface AuthorizedRbacScopeReadSuccessV1 {
  readonly ok: true;
  readonly trustedDeviceSession: TrustedRoomDeviceSessionV1;
  readonly authorizationSnapshot: RoomRbacAuthorizationSnapshotV1;
}

type AuthorizedRbacScopeReadResultV1 =
  | AuthorizedRbacScopeReadSuccessV1
  | RoomRbacRegistryReadFailureV1;

export class RoomRbacRegistry {
  constructor(private readonly persistence: RoomRbacRegistryPersistenceV1) {}

  async issueTrustedDeviceSession(input: IssueTrustedRoomDeviceSessionInputV1): Promise<RoomRbacRegistrySessionMutationResultV1> {
    assertIssueInput(input);
    const credentialDigest = digestTrustedRoomDeviceCredential(input.credential);
    const hash = buildIssueRequestHash(input, credentialDigest);
    return this.persistence.transaction(async (transaction) => {
      const replay = await requireMatchingOperation(transaction, {
        projectId: input.projectId,
        commandKind: "issue_trusted_device_session",
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      });
      if (replay) {
        const session = await transaction.getTrustedDeviceSession(input.projectId, replay.entityId);
        if (!session) throw new RoomRbacRegistryError("registry_unavailable", "Room RBAC issuance replay is missing its trusted device session");
        return freeze({ session: toTrustedSession(session), idempotentReplay: true });
      }
      if (await transaction.getTrustedDeviceSession(input.projectId, input.sessionId)) {
        throw new RoomRbacRegistryError("trusted_device_session_already_exists", "Trusted device session already exists in this project");
      }
      if (await transaction.hasTrustedDeviceSessionOutsideProject(input.projectId, credentialDigest) || await transaction.getTrustedDeviceSessionByCredentialDigest(input.projectId, credentialDigest)) {
        throw new RoomRbacRegistryError("trusted_device_credential_already_issued", "Trusted device credential is already registered");
      }
      const session: StoredRoomTrustedDeviceSessionV1 = freeze({
        source: "trusted_device_session_registry",
        projectId: input.projectId,
        sessionId: input.sessionId,
        principalId: input.principalId,
        deviceId: input.deviceId,
        credentialDigest,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        revokedAt: null,
        sessionVersion: 1,
      });
      await transaction.insertTrustedDeviceSession(session);
      await transaction.insertOperation(freeze({
        projectId: input.projectId,
        commandKind: "issue_trusted_device_session",
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
        entityType: "trusted_device_session",
        entityId: session.sessionId,
        authorizationVersion: null,
        sessionVersion: session.sessionVersion,
        occurredAt: input.issuedAt,
      }));
      return freeze({ session: toTrustedSession(session), idempotentReplay: false });
    });
  }

  async revokeTrustedDeviceSession(input: RevokeTrustedRoomDeviceSessionInputV1): Promise<RoomRbacRegistrySessionMutationResultV1> {
    assertRevokeSessionInput(input);
    const hash = buildRevokeSessionRequestHash(input);
    return this.persistence.transaction(async (transaction) => {
      const replay = await requireMatchingOperation(transaction, {
        projectId: input.projectId,
        commandKind: "revoke_trusted_device_session",
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      });
      if (replay) {
        const session = await transaction.getTrustedDeviceSession(input.projectId, replay.entityId);
        if (!session) throw new RoomRbacRegistryError("registry_unavailable", "Room RBAC revocation replay is missing its trusted device session");
        return freeze({ session: toTrustedSession(session), idempotentReplay: true });
      }
      const current = await transaction.getTrustedDeviceSession(input.projectId, input.sessionId);
      if (!current) throw new RoomRbacRegistryError("trusted_device_session_not_found", "Trusted device session does not exist in this project");
      if (current.sessionVersion !== input.expectedSessionVersion) {
        throw new RoomRbacRegistryError("trusted_device_session_version_conflict", "Trusted device session version does not match the requested revocation");
      }
      if (current.revokedAt !== null) {
        throw new RoomRbacRegistryError("trusted_device_session_already_revoked", "Trusted device session is already revoked");
      }
      if (earlierThan(input.revokedAt, current.issuedAt)) {
        throw new RoomRbacRegistryError("invalid_input", "Trusted device session cannot be revoked before it was issued");
      }
      const next: StoredRoomTrustedDeviceSessionV1 = freeze({
        ...current,
        revokedAt: input.revokedAt,
        sessionVersion: current.sessionVersion + 1,
      });
      if (!await transaction.replaceTrustedDeviceSession(next, current.sessionVersion)) {
        throw new RoomRbacRegistryError("trusted_device_session_version_conflict", "Trusted device session changed before revocation could commit");
      }
      await transaction.insertOperation(freeze({
        projectId: input.projectId,
        commandKind: "revoke_trusted_device_session",
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
        entityType: "trusted_device_session",
        entityId: next.sessionId,
        authorizationVersion: null,
        sessionVersion: next.sessionVersion,
        occurredAt: input.revokedAt,
      }));
      return freeze({ session: toTrustedSession(next), idempotentReplay: false });
    });
  }

  async grantRole(input: GrantRoomRbacRoleInputV1): Promise<RoomRbacRegistryGrantMutationResultV1> {
    assertGrantInput(input);
    const hash = buildGrantRequestHash(input);
    return this.persistence.transaction(async (transaction) => {
      const replay = await requireMatchingOperation(transaction, {
        projectId: input.projectId,
        commandKind: "grant_role",
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      });
      if (replay) {
        const grant = await transaction.getGrant(input.projectId, replay.entityId);
        if (!grant || replay.authorizationVersion === null) throw new RoomRbacRegistryError("registry_unavailable", "Room RBAC grant replay is missing durable state");
        return freeze({ grant: toGrant(grant), authorizationVersion: replay.authorizationVersion, idempotentReplay: true });
      }
      const state = await transaction.getAuthorizationState(input.projectId);
      const currentVersion = currentAuthorizationVersion(state);
      if (currentVersion !== input.expectedAuthorizationVersion) {
        throw new RoomRbacRegistryError("authorization_version_conflict", "Room RBAC authorization version does not match this grant request");
      }
      if (await transaction.getGrant(input.projectId, input.grantId)) {
        throw new RoomRbacRegistryError("grant_already_exists", "Room RBAC grant already exists in this project");
      }
      const grant: RoomRbacGrantV1 = freeze({
        grantId: input.grantId,
        principalId: input.principalId,
        role: input.role,
        projectId: input.projectId,
        roomId: input.roomId,
        grantedAt: input.grantedAt,
        revokedAt: null,
      });
      const nextVersion = currentVersion + 1;
      if (!await transaction.compareAndSetAuthorizationState(freeze({
        projectId: input.projectId,
        authorizationVersion: nextVersion,
        updatedAt: input.grantedAt,
      }), currentVersion)) {
        throw new RoomRbacRegistryError("authorization_version_conflict", "Room RBAC authorization state changed before this grant could commit");
      }
      await transaction.insertGrant(grant);
      await transaction.insertOperation(freeze({
        projectId: input.projectId,
        commandKind: "grant_role",
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
        entityType: "role_grant",
        entityId: grant.grantId,
        authorizationVersion: nextVersion,
        sessionVersion: null,
        occurredAt: input.grantedAt,
      }));
      return freeze({ grant: toGrant(grant), authorizationVersion: nextVersion, idempotentReplay: false });
    });
  }

  async revokeGrant(input: RevokeRoomRbacGrantInputV1): Promise<RoomRbacRegistryGrantMutationResultV1> {
    assertRevokeGrantInput(input);
    const hash = buildRevokeGrantRequestHash(input);
    return this.persistence.transaction(async (transaction) => {
      const replay = await requireMatchingOperation(transaction, {
        projectId: input.projectId,
        commandKind: "revoke_role_grant",
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
      });
      if (replay) {
        const grant = await transaction.getGrant(input.projectId, replay.entityId);
        if (!grant || replay.authorizationVersion === null) throw new RoomRbacRegistryError("registry_unavailable", "Room RBAC revocation replay is missing durable state");
        return freeze({ grant: toGrant(grant), authorizationVersion: replay.authorizationVersion, idempotentReplay: true });
      }
      const current = await transaction.getGrant(input.projectId, input.grantId);
      if (!current) throw new RoomRbacRegistryError("grant_not_found", "Room RBAC grant does not exist in this project");
      if (current.revokedAt !== null) throw new RoomRbacRegistryError("grant_already_revoked", "Room RBAC grant is already revoked");
      if (earlierThan(input.revokedAt, current.grantedAt)) throw new RoomRbacRegistryError("invalid_input", "Room RBAC grant cannot be revoked before it was granted");
      const state = await transaction.getAuthorizationState(input.projectId);
      const currentVersion = currentAuthorizationVersion(state);
      if (currentVersion !== input.expectedAuthorizationVersion) {
        throw new RoomRbacRegistryError("authorization_version_conflict", "Room RBAC authorization version does not match this revocation request");
      }
      const nextVersion = currentVersion + 1;
      if (!await transaction.compareAndSetAuthorizationState(freeze({
        projectId: input.projectId,
        authorizationVersion: nextVersion,
        updatedAt: input.revokedAt,
      }), currentVersion)) {
        throw new RoomRbacRegistryError("authorization_version_conflict", "Room RBAC authorization state changed before this revocation could commit");
      }
      if (!await transaction.revokeGrant(input.projectId, input.grantId, input.revokedAt)) {
        throw new RoomRbacRegistryError("grant_already_revoked", "Room RBAC grant changed before revocation could commit");
      }
      const grant: RoomRbacGrantV1 = freeze({ ...current, revokedAt: input.revokedAt });
      await transaction.insertOperation(freeze({
        projectId: input.projectId,
        commandKind: "revoke_role_grant",
        idempotencyKey: input.idempotencyKey,
        requestHash: hash,
        entityType: "role_grant",
        entityId: grant.grantId,
        authorizationVersion: nextVersion,
        sessionVersion: null,
        occurredAt: input.revokedAt,
      }));
      return freeze({ grant: toGrant(grant), authorizationVersion: nextVersion, idempotentReplay: false });
    });
  }

  private async readAuthorizedScope(input: AuthorizedRbacScopeReadInputV1): Promise<AuthorizedRbacScopeReadResultV1> {
    let credentialDigest: string;
    try {
      credentialDigest = digestTrustedRoomDeviceCredential(input.credential);
    } catch (error) {
      if (error instanceof RoomRbacRegistryError) return fail(error.code);
      return fail("invalid_credential");
    }
    try {
      return await this.persistence.transaction(async (transaction) => {
        const session = await transaction.getTrustedDeviceSessionByCredentialDigest(input.projectId, credentialDigest);
        if (!session) {
          if (await transaction.hasTrustedDeviceSessionOutsideProject(input.projectId, credentialDigest)) {
            return fail("trusted_device_session_project_scope_denied");
          }
          return fail("trusted_device_session_not_found");
        }
        if (earlierThan(input.requestedAt, session.issuedAt)) return fail("trusted_device_session_not_yet_valid");
        if (!earlierThan(input.requestedAt, session.expiresAt)) return fail("trusted_device_session_expired");
        if (session.revokedAt !== null && atOrBefore(session.revokedAt, input.requestedAt)) return fail("trusted_device_session_revoked");
        const state = await transaction.getAuthorizationState(input.projectId);
        if (!state || state.authorizationVersion < 1) return fail("no_effective_project_or_room_grant");
        const grants = await transaction.listSnapshotGrants({
          projectId: input.projectId,
          principalId: session.principalId,
          roomId: input.roomId,
          requestedAt: input.requestedAt,
        });
        if (grants.length === 0) return fail("no_effective_project_or_room_grant");
        const authorizationSnapshot: RoomRbacAuthorizationSnapshotV1 = freeze({
          source: "durable_room_rbac_registry",
          authorizationVersion: state.authorizationVersion,
          grants: freezeArray(grants.map(toGrant)),
        });
        return freeze({ ok: true, trustedDeviceSession: toTrustedSession(session), authorizationSnapshot });
      });
    } catch (error) {
      if (error instanceof RoomRbacRegistryError) throw error;
      return fail("registry_unavailable");
    }
  }

  async readAuthorizedSnapshot(input: ReadAuthorizedRoomRbacSnapshotInputV1): Promise<ReadAuthorizedRoomRbacSnapshotResultV1> {
    if (!isValidReadInput(input)) return fail("invalid_input");
    const read = await this.readAuthorizedScope({
      projectId: input.projectId,
      roomId: input.roomId,
      credential: input.credential,
      requestedAt: input.requestedAt,
    });
    if (!read.ok) return read;
    return freeze({
      ok: true,
      snapshot: freeze({
        source: "durable_room_rbac_registry",
        projectId: input.projectId,
        roomId: input.roomId,
        trustedDeviceSession: read.trustedDeviceSession,
        authorizationSnapshot: read.authorizationSnapshot,
      }),
    });
  }

  async readAuthorizedProjectSnapshot(input: ReadAuthorizedProjectRbacSnapshotInputV1): Promise<ReadAuthorizedProjectRbacSnapshotResultV1> {
    if (!isValidProjectReadInput(input)) return fail("invalid_input");
    const read = await this.readAuthorizedScope({
      projectId: input.projectId,
      roomId: null,
      credential: input.credential,
      requestedAt: input.requestedAt,
    });
    if (!read.ok) return read;
    return freeze({
      ok: true,
      snapshot: freeze({
        source: "durable_room_rbac_registry",
        projectId: input.projectId,
        trustedDeviceSession: read.trustedDeviceSession,
        authorizationSnapshot: read.authorizationSnapshot,
      }),
    });
  }
}

export function toRoomRbacDecisionInput(input: ToRoomRbacDecisionInputV1): DecideRoomRbacAuthorizationInputV1 {
  if (input.snapshot.projectId !== input.request.projectId || input.snapshot.roomId !== input.request.roomId) {
    throw new RoomRbacRegistryError("snapshot_scope_mismatch", "Room RBAC snapshot scope does not match the authorization request");
  }
  return freeze({
    contractVersion: 1,
    trustedDeviceSession: input.snapshot.trustedDeviceSession,
    authorizationSnapshot: input.snapshot.authorizationSnapshot,
    request: input.request,
    activeTakeoverLeases: freezeArray(input.activeTakeoverLeases),
  });
}

function denyProjectAuthorization(
  reason: RoomRbacProjectAuthorizationReasonCodeV1,
  authorizationVersion: number | null = null,
  effectiveRoles: readonly RoomRbacRoleV1[] = [],
): RoomRbacProjectAuthorizationDecisionV1 {
  return freeze({
    ok: false,
    authorized: false,
    authorizationVersion,
    effectiveRoles: freezeArray(effectiveRoles),
    reasonCodes: freezeArray([reason]),
  });
}

export function decideRoomRbacProjectAuthorization(input: unknown): RoomRbacProjectAuthorizationDecisionV1 {
  if (!isRecord(input) || !exactKeys(input, ["contractVersion", "trustedDeviceSession", "authorizationSnapshot", "request"])) {
    return denyProjectAuthorization("unexpected_input_property");
  }
  if (isRecord(input.request) && !exactKeys(input.request, ["projectId", "action", "expectedAuthorizationVersion", "requestedAt"])) {
    return denyProjectAuthorization("unexpected_request_property");
  }
  if (input.contractVersion !== ROOM_RBAC_REGISTRY_CONTRACT_VERSION
    || !validTrustedDeviceSession(input.trustedDeviceSession)
    || !validAuthorizationSnapshot(input.authorizationSnapshot)
    || !validProjectRequest(input.request)) {
    return denyProjectAuthorization("invalid_input");
  }

  const session = input.trustedDeviceSession;
  const authorizationSnapshot = input.authorizationSnapshot;
  const request = input.request;
  if (earlierThan(request.requestedAt, session.issuedAt)) return denyProjectAuthorization("trusted_session_not_yet_valid", authorizationSnapshot.authorizationVersion);
  if (session.revokedAt !== null && atOrBefore(session.revokedAt, request.requestedAt)) return denyProjectAuthorization("trusted_session_revoked", authorizationSnapshot.authorizationVersion);
  if (!earlierThan(request.requestedAt, session.expiresAt)) return denyProjectAuthorization("trusted_session_expired", authorizationSnapshot.authorizationVersion);
  if (request.expectedAuthorizationVersion !== authorizationSnapshot.authorizationVersion) return denyProjectAuthorization("authorization_version_conflict", authorizationSnapshot.authorizationVersion);

  const effectiveRoles = [...new Set(authorizationSnapshot.grants
    .filter((grant) => grant.principalId === session.principalId
      && grant.projectId === request.projectId
      && grant.roomId === null
      && grant.revokedAt === null
      && !earlierThan(request.requestedAt, grant.grantedAt))
    .map((grant) => grant.role))]
    .sort((left, right) => (ROOM_RBAC_ROLE_RANK.get(left) ?? 99) - (ROOM_RBAC_ROLE_RANK.get(right) ?? 99));
  if (effectiveRoles.length === 0) return denyProjectAuthorization("no_project_grant", authorizationSnapshot.authorizationVersion);
  if (!effectiveRoles.some((role) => ROOM_RBAC_PROJECT_ROLE_ACTIONS[role].has(request.action))) {
    return denyProjectAuthorization("role_action_forbidden", authorizationSnapshot.authorizationVersion, effectiveRoles);
  }
  return freeze({
    ok: true,
    authorized: true,
    authorizationVersion: authorizationSnapshot.authorizationVersion,
    effectiveRoles: freezeArray(effectiveRoles),
    reasonCodes: freezeArray([]),
  });
}

export function toRoomRbacProjectDecisionInput(input: ToRoomRbacProjectDecisionInputV1): DecideRoomRbacProjectAuthorizationInputV1 {
  if (input.snapshot.projectId !== input.request.projectId) {
    throw new RoomRbacRegistryError("snapshot_scope_mismatch", "Project RBAC snapshot scope does not match the authorization request");
  }
  if (input.snapshot.authorizationSnapshot.grants.some((grant) => grant.roomId !== null)) {
    throw new RoomRbacRegistryError("snapshot_scope_mismatch", "Project RBAC snapshots cannot contain Room-scoped grants");
  }
  return freeze({
    contractVersion: 1,
    trustedDeviceSession: input.snapshot.trustedDeviceSession,
    authorizationSnapshot: input.snapshot.authorizationSnapshot,
    request: input.request,
  });
}

class InMemoryRoomRbacRegistryTransaction implements RoomRbacRegistryTransactionV1 {
  constructor(private readonly state: InMemoryRoomRbacRegistryPersistence) {}

  async getTrustedDeviceSession(projectId: string, sessionId: string): Promise<StoredRoomTrustedDeviceSessionV1 | null> {
    return this.state.sessionById(projectId, sessionId);
  }

  async getTrustedDeviceSessionByCredentialDigest(projectId: string, credentialDigest: string): Promise<StoredRoomTrustedDeviceSessionV1 | null> {
    const session = this.state.sessionByCredentialDigest(credentialDigest);
    return session?.projectId === projectId ? session : null;
  }

  async hasTrustedDeviceSessionOutsideProject(projectId: string, credentialDigest: string): Promise<boolean> {
    const session = this.state.sessionByCredentialDigest(credentialDigest);
    return session !== null && session.projectId !== projectId;
  }

  async insertTrustedDeviceSession(session: StoredRoomTrustedDeviceSessionV1): Promise<void> {
    this.state.insertSession(session);
  }

  async replaceTrustedDeviceSession(session: StoredRoomTrustedDeviceSessionV1, expectedSessionVersion: number): Promise<boolean> {
    return this.state.replaceSession(session, expectedSessionVersion);
  }

  async getAuthorizationState(projectId: string): Promise<RoomRbacAuthorizationStateV1 | null> {
    return this.state.authorizationState(projectId);
  }

  async compareAndSetAuthorizationState(state: RoomRbacAuthorizationStateV1, expectedAuthorizationVersion: number): Promise<boolean> {
    return this.state.compareAndSetAuthorizationState(state, expectedAuthorizationVersion);
  }

  async getGrant(projectId: string, grantId: string): Promise<RoomRbacGrantV1 | null> {
    return this.state.grantById(projectId, grantId);
  }

  async insertGrant(grant: RoomRbacGrantV1): Promise<void> {
    this.state.insertGrant(grant);
  }

  async revokeGrant(projectId: string, grantId: string, revokedAt: string): Promise<boolean> {
    return this.state.revokeGrant(projectId, grantId, revokedAt);
  }

  async listSnapshotGrants(input: {
    readonly projectId: string;
    readonly principalId: string;
    readonly roomId: string | null;
    readonly requestedAt: string;
  }): Promise<readonly RoomRbacGrantV1[]> {
    return this.state.snapshotGrants(input);
  }

  async getOperation(input: {
    readonly projectId: string;
    readonly commandKind: RoomRbacRegistryOperationKindV1;
    readonly idempotencyKey: string;
  }): Promise<RoomRbacRegistryOperationRecordV1 | null> {
    return this.state.operation(input.projectId, input.commandKind, input.idempotencyKey);
  }

  async insertOperation(operation: RoomRbacRegistryOperationRecordV1): Promise<void> {
    this.state.insertOperation(operation);
  }
}

class InMemoryRoomRbacRegistryPersistence implements RoomRbacRegistryPersistenceV1 {
  private readonly sessionsById = new Map<string, StoredRoomTrustedDeviceSessionV1>();
  private readonly sessionsByCredentialDigest = new Map<string, StoredRoomTrustedDeviceSessionV1>();
  private readonly authorizationStates = new Map<string, RoomRbacAuthorizationStateV1>();
  private readonly grantsById = new Map<string, RoomRbacGrantV1>();
  private readonly operations = new Map<string, RoomRbacRegistryOperationRecordV1>();

  async transaction<T>(operation: (transaction: RoomRbacRegistryTransactionV1) => Promise<T>): Promise<T> {
    return operation(new InMemoryRoomRbacRegistryTransaction(this));
  }

  sessionById(projectId: string, sessionId: string): StoredRoomTrustedDeviceSessionV1 | null {
    const session = this.sessionsById.get(`${projectId}\u0000${sessionId}`);
    return session ? freeze({ ...session }) : null;
  }

  sessionByCredentialDigest(credentialDigest: string): StoredRoomTrustedDeviceSessionV1 | null {
    const session = this.sessionsByCredentialDigest.get(credentialDigest);
    return session ? freeze({ ...session }) : null;
  }

  insertSession(session: StoredRoomTrustedDeviceSessionV1): void {
    const idKey = `${session.projectId}\u0000${session.sessionId}`;
    if (this.sessionsById.has(idKey) || this.sessionsByCredentialDigest.has(session.credentialDigest)) {
      throw new RoomRbacRegistryError("trusted_device_session_already_exists", "Trusted device session storage already contains this identity or credential digest");
    }
    const stored = freeze({ ...session });
    this.sessionsById.set(idKey, stored);
    this.sessionsByCredentialDigest.set(stored.credentialDigest, stored);
  }

  replaceSession(session: StoredRoomTrustedDeviceSessionV1, expectedSessionVersion: number): boolean {
    const idKey = `${session.projectId}\u0000${session.sessionId}`;
    const current = this.sessionsById.get(idKey);
    if (!current || current.sessionVersion !== expectedSessionVersion) return false;
    const stored = freeze({ ...session });
    this.sessionsById.set(idKey, stored);
    this.sessionsByCredentialDigest.set(stored.credentialDigest, stored);
    return true;
  }

  authorizationState(projectId: string): RoomRbacAuthorizationStateV1 | null {
    const state = this.authorizationStates.get(projectId);
    return state ? freeze({ ...state }) : null;
  }

  compareAndSetAuthorizationState(state: RoomRbacAuthorizationStateV1, expectedAuthorizationVersion: number): boolean {
    const current = this.authorizationStates.get(state.projectId);
    if ((current?.authorizationVersion ?? 0) !== expectedAuthorizationVersion) return false;
    this.authorizationStates.set(state.projectId, freeze({ ...state }));
    return true;
  }

  grantById(projectId: string, grantId: string): RoomRbacGrantV1 | null {
    const grant = this.grantsById.get(`${projectId}\u0000${grantId}`);
    return grant ? freeze({ ...grant }) : null;
  }

  insertGrant(grant: RoomRbacGrantV1): void {
    const key = `${grant.projectId}\u0000${grant.grantId}`;
    if (this.grantsById.has(key)) throw new RoomRbacRegistryError("grant_already_exists", "Room RBAC grant storage already contains this grant identity");
    this.grantsById.set(key, freeze({ ...grant }));
  }

  revokeGrant(projectId: string, grantId: string, revokedAt: string): boolean {
    const key = `${projectId}\u0000${grantId}`;
    const current = this.grantsById.get(key);
    if (!current || current.revokedAt !== null) return false;
    this.grantsById.set(key, freeze({ ...current, revokedAt }));
    return true;
  }

  snapshotGrants(input: {
    readonly projectId: string;
    readonly principalId: string;
    readonly roomId: string | null;
    readonly requestedAt: string;
  }): readonly RoomRbacGrantV1[] {
    return freezeArray([...this.grantsById.values()]
      .filter((grant) => grant.projectId === input.projectId
        && grant.principalId === input.principalId
        && grant.revokedAt === null
        && !earlierThan(input.requestedAt, grant.grantedAt)
        && (input.roomId === null
          ? grant.roomId === null
          : grant.roomId === null || grant.roomId === input.roomId))
      .sort((left, right) => left.grantId.localeCompare(right.grantId))
      .map(toGrant));
  }

  operation(projectId: string, commandKind: RoomRbacRegistryOperationKindV1, idempotencyKey: string): RoomRbacRegistryOperationRecordV1 | null {
    const operation = this.operations.get(`${projectId}\u0000${commandKind}\u0000${idempotencyKey}`);
    return operation ? freeze({ ...operation }) : null;
  }

  insertOperation(operation: RoomRbacRegistryOperationRecordV1): void {
    const key = `${operation.projectId}\u0000${operation.commandKind}\u0000${operation.idempotencyKey}`;
    if (this.operations.has(key)) throw new RoomRbacRegistryError("idempotency_key_conflict", "Room RBAC operation storage already contains this idempotency key");
    this.operations.set(key, freeze({ ...operation }));
  }
}

export function createInMemoryRoomRbacRegistry(): RoomRbacRegistry {
  return new RoomRbacRegistry(new InMemoryRoomRbacRegistryPersistence());
}

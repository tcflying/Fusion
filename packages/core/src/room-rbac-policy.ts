export const ROOM_RBAC_POLICY_CONTRACT_VERSION = 1 as const;

export type RoomRbacRoleV1 = "owner" | "admin" | "operator" | "observer" | "auditor";
export type RoomRbacActionV1 =
  | "manage_project_access"
  | "manage_room"
  | "operate_room"
  | "view_room"
  | "audit_room"
  | "human_takeover";

export interface TrustedRoomDeviceSessionV1 {
  readonly source: "trusted_device_session_registry";
  readonly sessionId: string;
  readonly deviceId: string;
  readonly principalId: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly sessionVersion: number;
}

export interface RoomRbacGrantV1 {
  readonly grantId: string;
  readonly principalId: string;
  readonly role: RoomRbacRoleV1;
  readonly projectId: string;
  readonly roomId: string | null;
  readonly grantedAt: string;
  readonly revokedAt: string | null;
}

export interface RoomRbacAuthorizationSnapshotV1 {
  readonly source: "durable_room_rbac_registry";
  readonly authorizationVersion: number;
  readonly grants: readonly RoomRbacGrantV1[];
}

export interface RoomHumanTakeoverRequestV1 {
  readonly leaseId: string;
  readonly idempotencyKey: string;
  readonly expiresAt: string;
}

export interface RoomHumanTakeoverLeaseV1 extends RoomHumanTakeoverRequestV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly principalId: string;
  readonly deviceId: string;
  readonly issuedAt: string;
  readonly revokedAt: string | null;
}

export interface RoomRbacRequestV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly action: RoomRbacActionV1;
  readonly expectedAuthorizationVersion: number;
  readonly requestedAt: string;
  readonly takeover: RoomHumanTakeoverRequestV1 | null;
}

export interface DecideRoomRbacAuthorizationInputV1 {
  readonly contractVersion: 1;
  readonly trustedDeviceSession: TrustedRoomDeviceSessionV1;
  readonly authorizationSnapshot: RoomRbacAuthorizationSnapshotV1;
  readonly request: RoomRbacRequestV1;
  readonly activeTakeoverLeases: readonly RoomHumanTakeoverLeaseV1[];
}

export type RoomRbacReasonCodeV1 =
  | "invalid_input"
  | "unexpected_input_property"
  | "unexpected_request_property"
  | "trusted_session_revoked"
  | "trusted_session_expired"
  | "authorization_version_conflict"
  | "no_project_or_room_grant"
  | "role_action_forbidden"
  | "human_takeover_required"
  | "human_takeover_not_allowed"
  | "human_takeover_already_held"
  | "multiple_active_human_takeover_leases";

export type RoomHumanTakeoverDecisionV1 =
  | { readonly kind: "not_requested" }
  | { readonly kind: "grant"; readonly lease: RoomHumanTakeoverLeaseV1 }
  | { readonly kind: "deny" };

export interface RoomRbacAuthorizationDecisionV1 {
  readonly ok: boolean;
  readonly authorized: boolean;
  readonly authorizationVersion: number | null;
  readonly effectiveRoles: readonly RoomRbacRoleV1[];
  readonly reasonCodes: readonly RoomRbacReasonCodeV1[];
  readonly takeover: RoomHumanTakeoverDecisionV1;
}

const ROLES = ["owner", "admin", "operator", "observer", "auditor"] as const;
const ACTIONS = ["manage_project_access", "manage_room", "operate_room", "view_room", "audit_room", "human_takeover"] as const;
const ROLE_RANK = new Map<RoomRbacRoleV1, number>(ROLES.map((role, index) => [role, index]));
const ROLE_ACTIONS: Readonly<Record<RoomRbacRoleV1, ReadonlySet<RoomRbacActionV1>>> = {
  owner: new Set(ACTIONS),
  admin: new Set(["manage_project_access", "manage_room", "operate_room", "view_room", "audit_room", "human_takeover"]),
  operator: new Set(["manage_room", "operate_room", "view_room", "human_takeover"]),
  observer: new Set(["view_room"]),
  auditor: new Set(["view_room", "audit_room"]),
};

/*
FNXC:RoomRbacPolicy 2026-07-19:
This policy consumes only a pre-authenticated device session and a durable RBAC
snapshot. Request payloads never carry an actor/principal identity, so a caller
cannot upgrade itself by declaring an owner ID. Persistence, session issuance,
revocation, CAS, and lease writes remain outside this pure decision boundary.
*/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function canonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const received = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return received.length === sortedExpected.length && received.every((key, index) => key === sortedExpected[index]);
}

function atOrBefore(left: string, right: string): boolean {
  return Date.parse(left) <= Date.parse(right);
}

function before(left: string, right: string): boolean {
  return Date.parse(left) < Date.parse(right);
}

function freeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) Object.freeze(value);
  return value;
}

function deny(
  reason: RoomRbacReasonCodeV1,
  authorizationVersion: number | null = null,
  effectiveRoles: readonly RoomRbacRoleV1[] = [],
  takeover: RoomHumanTakeoverDecisionV1 = { kind: "not_requested" },
): RoomRbacAuthorizationDecisionV1 {
  return freeze({
    ok: false,
    authorized: false,
    authorizationVersion,
    effectiveRoles: freeze([...effectiveRoles]),
    reasonCodes: freeze([reason]),
    takeover: freeze(takeover),
  });
}

function validSession(value: unknown): value is TrustedRoomDeviceSessionV1 {
  if (!isRecord(value) || !exactKeys(value, ["source", "sessionId", "deviceId", "principalId", "issuedAt", "expiresAt", "revokedAt", "sessionVersion"])) return false;
  return value.source === "trusted_device_session_registry"
    && nonEmptyString(value.sessionId) && nonEmptyString(value.deviceId) && nonEmptyString(value.principalId)
    && canonicalTimestamp(value.issuedAt) && canonicalTimestamp(value.expiresAt) && atOrBefore(value.issuedAt, value.expiresAt)
    && (value.revokedAt === null || canonicalTimestamp(value.revokedAt)) && positiveInteger(value.sessionVersion);
}

function validGrant(value: unknown): value is RoomRbacGrantV1 {
  if (!isRecord(value) || !exactKeys(value, ["grantId", "principalId", "role", "projectId", "roomId", "grantedAt", "revokedAt"])) return false;
  return nonEmptyString(value.grantId) && nonEmptyString(value.principalId) && ROLES.includes(value.role as RoomRbacRoleV1)
    && nonEmptyString(value.projectId) && (value.roomId === null || nonEmptyString(value.roomId)) && canonicalTimestamp(value.grantedAt)
    && (value.revokedAt === null || canonicalTimestamp(value.revokedAt));
}

function validSnapshot(value: unknown): value is RoomRbacAuthorizationSnapshotV1 {
  return isRecord(value) && exactKeys(value, ["source", "authorizationVersion", "grants"])
    && value.source === "durable_room_rbac_registry" && positiveInteger(value.authorizationVersion)
    && Array.isArray(value.grants) && value.grants.every(validGrant)
    && new Set(value.grants.map((grant) => grant.grantId)).size === value.grants.length;
}

function validTakeoverRequest(value: unknown): value is RoomHumanTakeoverRequestV1 {
  return isRecord(value) && exactKeys(value, ["leaseId", "idempotencyKey", "expiresAt"])
    && nonEmptyString(value.leaseId) && nonEmptyString(value.idempotencyKey) && canonicalTimestamp(value.expiresAt);
}

function validRequest(value: unknown): value is RoomRbacRequestV1 {
  return isRecord(value) && exactKeys(value, ["projectId", "roomId", "action", "expectedAuthorizationVersion", "requestedAt", "takeover"])
    && nonEmptyString(value.projectId) && nonEmptyString(value.roomId) && ACTIONS.includes(value.action as RoomRbacActionV1)
    && positiveInteger(value.expectedAuthorizationVersion) && canonicalTimestamp(value.requestedAt)
    && (value.takeover === null || validTakeoverRequest(value.takeover));
}

function validLease(value: unknown): value is RoomHumanTakeoverLeaseV1 {
  return isRecord(value) && exactKeys(value, ["leaseId", "idempotencyKey", "expiresAt", "projectId", "roomId", "principalId", "deviceId", "issuedAt", "revokedAt"])
    && nonEmptyString(value.leaseId) && nonEmptyString(value.idempotencyKey) && canonicalTimestamp(value.expiresAt)
    && nonEmptyString(value.projectId) && nonEmptyString(value.roomId)
    && nonEmptyString(value.principalId) && nonEmptyString(value.deviceId) && canonicalTimestamp(value.issuedAt)
    && atOrBefore(value.issuedAt, value.expiresAt) && (value.revokedAt === null || canonicalTimestamp(value.revokedAt));
}

function activeLease(lease: RoomHumanTakeoverLeaseV1, request: RoomRbacRequestV1): boolean {
  return lease.projectId === request.projectId && lease.roomId === request.roomId && lease.revokedAt === null && before(request.requestedAt, lease.expiresAt);
}

export function decideRoomRbacAuthorization(input: unknown): RoomRbacAuthorizationDecisionV1 {
  if (!isRecord(input) || !exactKeys(input, ["contractVersion", "trustedDeviceSession", "authorizationSnapshot", "request", "activeTakeoverLeases"])) {
    return deny("unexpected_input_property");
  }
  if (isRecord(input.request) && !exactKeys(input.request, ["projectId", "roomId", "action", "expectedAuthorizationVersion", "requestedAt", "takeover"])) {
    return deny("unexpected_request_property");
  }
  if (input.contractVersion !== ROOM_RBAC_POLICY_CONTRACT_VERSION || !validSession(input.trustedDeviceSession) || !validSnapshot(input.authorizationSnapshot) || !validRequest(input.request) || !Array.isArray(input.activeTakeoverLeases) || !input.activeTakeoverLeases.every(validLease)) {
    return deny("invalid_input");
  }

  const session = input.trustedDeviceSession;
  const snapshot = input.authorizationSnapshot;
  const request = input.request;
  if (session.revokedAt !== null && atOrBefore(session.revokedAt, request.requestedAt)) return deny("trusted_session_revoked", snapshot.authorizationVersion);
  if (!before(request.requestedAt, session.expiresAt)) return deny("trusted_session_expired", snapshot.authorizationVersion);
  if (request.expectedAuthorizationVersion !== snapshot.authorizationVersion) return deny("authorization_version_conflict", snapshot.authorizationVersion);

  const effectiveRoles = [...new Set(snapshot.grants
    .filter((grant) => grant.principalId === session.principalId && grant.projectId === request.projectId && grant.revokedAt === null && (grant.roomId === null || grant.roomId === request.roomId))
    .map((grant) => grant.role))]
    .sort((left, right) => (ROLE_RANK.get(left) ?? 99) - (ROLE_RANK.get(right) ?? 99));
  if (effectiveRoles.length === 0) return deny("no_project_or_room_grant", snapshot.authorizationVersion);
  if (!effectiveRoles.some((role) => ROLE_ACTIONS[role].has(request.action))) return deny("role_action_forbidden", snapshot.authorizationVersion, effectiveRoles);

  if (request.action !== "human_takeover") {
    if (request.takeover !== null) return deny("human_takeover_not_allowed", snapshot.authorizationVersion, effectiveRoles);
    return freeze({ ok: true, authorized: true, authorizationVersion: snapshot.authorizationVersion, effectiveRoles: freeze(effectiveRoles), reasonCodes: freeze([]), takeover: freeze({ kind: "not_requested" }) });
  }
  if (request.takeover === null) return deny("human_takeover_required", snapshot.authorizationVersion, effectiveRoles, { kind: "deny" });
  if (!before(request.requestedAt, request.takeover.expiresAt)) return deny("human_takeover_not_allowed", snapshot.authorizationVersion, effectiveRoles, { kind: "deny" });

  const active = input.activeTakeoverLeases.filter((lease) => activeLease(lease, request));
  if (active.length > 1) return deny("multiple_active_human_takeover_leases", snapshot.authorizationVersion, effectiveRoles, { kind: "deny" });
  const existing = active[0];
  if (existing !== undefined) {
    const exactReplay = existing.leaseId === request.takeover.leaseId && existing.idempotencyKey === request.takeover.idempotencyKey && existing.principalId === session.principalId && existing.deviceId === session.deviceId;
    if (!exactReplay) return deny("human_takeover_already_held", snapshot.authorizationVersion, effectiveRoles, { kind: "deny" });
    return freeze({ ok: true, authorized: true, authorizationVersion: snapshot.authorizationVersion, effectiveRoles: freeze(effectiveRoles), reasonCodes: freeze([]), takeover: freeze({ kind: "grant", lease: freeze({ ...existing }) }) });
  }

  const lease: RoomHumanTakeoverLeaseV1 = {
    ...request.takeover,
    projectId: request.projectId,
    roomId: request.roomId,
    principalId: session.principalId,
    deviceId: session.deviceId,
    issuedAt: request.requestedAt,
    revokedAt: null,
  };
  return freeze({ ok: true, authorized: true, authorizationVersion: snapshot.authorizationVersion, effectiveRoles: freeze(effectiveRoles), reasonCodes: freeze([]), takeover: freeze({ kind: "grant", lease: freeze(lease) }) });
}

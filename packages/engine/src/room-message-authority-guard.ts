import {
  authorizeRoomMessageAuthorityEnvelopeV1,
  hashRoomValue,
  type RoomMessageAuthorityActorV1,
  type RoomMessageAuthorityDecisionV1,
  type RoomMessageAuthorityEnvelopeErrorCode,
  type RoomMessageAuthorityEnvelopeV1,
  type RoomMessageAuthorityOriginV1,
  type RoomMessageAuthorityPolicyV1,
  type RoomMessageAuthorityRequestV1,
  type RoomMessageAuthorityScopeV1,
  type RoomMessageIntent,
  type RoomMessageTargetV1,
} from "@fusion/core";

export interface RoomMessageAuthorityGuardAuthenticatedContextV1 {
  readonly origin: RoomMessageAuthorityOriginV1;
  readonly actor: RoomMessageAuthorityActorV1;
  readonly role: string;
}

export interface RoomMessageAuthorityGuardDispatchInputV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly turnId: string;
  readonly nodeId: string;
  readonly target: RoomMessageTargetV1;
  readonly intent: RoomMessageIntent;
  readonly evidenceRefs: readonly string[];
  readonly content: string;
  readonly requestedScope: string;
}

export interface RoomMessageAuthorityGuardInputV1 {
  readonly envelope: RoomMessageAuthorityEnvelopeV1;
  readonly authenticated: RoomMessageAuthorityGuardAuthenticatedContextV1;
  readonly dispatch: RoomMessageAuthorityGuardDispatchInputV1;
  readonly policy: RoomMessageAuthorityPolicyV1;
}

export interface AuthorizedRoomMessageDispatchAuthorityV1 {
  readonly kind: "message_only";
  readonly externalAuthority: "none";
  readonly origin: RoomMessageAuthorityOriginV1;
  readonly actor: RoomMessageAuthorityActorV1;
  readonly role: string;
  readonly grantedScope: RoomMessageAuthorityScopeV1;
  readonly envelopeHash: string;
}

export interface AuthorizedRoomMessageDispatchV1 {
  readonly contractVersion: "room-message-authority-guard/v1";
  readonly projectId: string;
  readonly roomId: string;
  readonly turnId: string;
  readonly nodeId: string;
  readonly target: RoomMessageTargetV1;
  readonly intent: RoomMessageIntent;
  readonly evidenceRefs: readonly string[];
  readonly content: string;
  readonly contentHash: string;
  readonly requestedScope: RoomMessageAuthorityScopeV1;
  readonly authority: AuthorizedRoomMessageDispatchAuthorityV1;
}

export type RoomMessageAuthorityGuardRefusalCodeV1 =
  | RoomMessageAuthorityEnvelopeErrorCode
  | "invalid-dispatch";

export type RoomMessageAuthorityGuardResultV1 =
  | {
      readonly ok: true;
      readonly dispatch: AuthorizedRoomMessageDispatchV1;
    }
  | {
      readonly ok: false;
      readonly code: RoomMessageAuthorityGuardRefusalCodeV1;
    };

/**
 * FNXC:RoomMessageAuthorityGuard 2026-07-19-15:51:
 * Engine adapters may route only a Core-validated message-only dispatch. The body remains untrusted data, so it cannot mint tool, workspace, credential, network, or publication authority.
 */
export async function guardRoomMessageAuthorityDispatchV1(
  input: RoomMessageAuthorityGuardInputV1,
): Promise<RoomMessageAuthorityGuardResultV1> {
  try {
    const request = snapshotRequest(input);
    const authorization = await authorizeRoomMessageAuthorityEnvelopeV1(
      input.envelope,
      request,
      input.policy,
    );
    if (!authorization.ok) return freezeRefusal(authorization.code);
    return Object.freeze({
      ok: true,
      dispatch: freezeAuthorizedDispatch(request, authorization.decision),
    });
  } catch {
    return freezeRefusal("invalid-dispatch");
  }
}

function snapshotRequest(input: RoomMessageAuthorityGuardInputV1): RoomMessageAuthorityRequestV1 {
  const authenticated = input.authenticated;
  const dispatch = input.dispatch;
  return Object.freeze({
    authenticatedOrigin: freezeOrigin(authenticated.origin),
    authenticatedActor: freezeActor(authenticated.actor),
    authenticatedRole: authenticated.role,
    projectId: dispatch.projectId,
    roomId: dispatch.roomId,
    turnId: dispatch.turnId,
    nodeId: dispatch.nodeId,
    target: freezeTarget(dispatch.target),
    intent: dispatch.intent,
    evidenceRefs: Object.freeze([...dispatch.evidenceRefs]),
    content: dispatch.content,
    requestedScope: dispatch.requestedScope,
  });
}

function freezeAuthorizedDispatch(
  request: RoomMessageAuthorityRequestV1,
  decision: RoomMessageAuthorityDecisionV1,
): AuthorizedRoomMessageDispatchV1 {
  return Object.freeze({
    contractVersion: "room-message-authority-guard/v1",
    projectId: decision.projectId,
    roomId: decision.roomId,
    turnId: decision.turnId,
    nodeId: decision.nodeId,
    target: freezeTarget(decision.target),
    intent: request.intent,
    evidenceRefs: Object.freeze([...decision.evidenceRefs]),
    content: request.content,
    contentHash: hashRoomValue(request.content),
    requestedScope: decision.grantedScope,
    authority: Object.freeze({
      kind: decision.kind,
      externalAuthority: decision.externalAuthority,
      origin: freezeOrigin(decision.origin),
      actor: freezeActor(decision.actor),
      role: decision.role,
      grantedScope: decision.grantedScope,
      envelopeHash: decision.envelopeHash,
    }),
  });
}

function freezeRefusal(code: RoomMessageAuthorityGuardRefusalCodeV1): RoomMessageAuthorityGuardResultV1 {
  return Object.freeze({ ok: false, code });
}

function freezeOrigin(origin: RoomMessageAuthorityOriginV1): RoomMessageAuthorityOriginV1 {
  return Object.freeze({ source: origin.source, issuerId: origin.issuerId });
}

function freezeActor(actor: RoomMessageAuthorityActorV1): RoomMessageAuthorityActorV1 {
  return Object.freeze({ type: actor.type, id: actor.id });
}

function freezeTarget(target: RoomMessageTargetV1): RoomMessageTargetV1 {
  const candidate = target as { readonly kind?: unknown; readonly groupId?: unknown; readonly seatIds?: unknown };
  if (candidate.kind === "controller" || candidate.kind === "all") return Object.freeze({ kind: candidate.kind });
  if (candidate.kind === "group") return Object.freeze({ kind: "group", groupId: candidate.groupId as string });
  if (candidate.kind === "seats") {
    return Object.freeze({
      kind: "seats",
      seatIds: Object.freeze([...(candidate.seatIds as readonly string[])]),
    });
  }
  return Object.freeze({ kind: candidate.kind }) as RoomMessageTargetV1;
}

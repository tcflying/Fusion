import { randomUUID } from "node:crypto";
import type { Request } from "express";
import {
  ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
  RoomRbacPolicy,
  createTrustedRoomDeviceCredential,
  decideRoomRbacProjectAuthorization,
  toRoomRbacDecisionInput,
  toRoomRbacProjectDecisionInput,
  type RoomRbacProjectActionV1,
  type RoomRbacRegistry,
} from "@fusion/core";
import type {
  RoomControlPlaneAuthorizationDecision,
  RoomControlPlaneAuthorizationInput,
  RoomControlPlaneResource,
  RoomControlPlaneRouteDependencies,
  RoomControlPlaneTrustedDeviceSessionIssuer,
} from "./routes/register-room-control-plane-routes.js";

export const DEFAULT_ROOM_CONTROL_PLANE_TRUSTED_DEVICE_COOKIE_NAME = "__Host-fusion-room-device";

export interface RoomControlPlaneRbacRegistryResolverInput {
  readonly request: Request;
  readonly projectId: string;
}

/**
 * Pre-context authorization seam. Implementations must resolve the durable RBAC
 * registry without calling getProjectContext(), creating a store, or starting an Engine.
 */
export type RoomControlPlaneRbacRegistryResolver = (
  input: RoomControlPlaneRbacRegistryResolverInput,
) => RoomRbacRegistry | null | undefined | Promise<RoomRbacRegistry | null | undefined>;

export interface RoomControlPlaneRbacAuthorizerOptions {
  /** Resolves the durable project registry anew for each Room request. */
  readonly resolveRegistry: RoomControlPlaneRbacRegistryResolver;
  /** Exact browser origin allowed to present the controlled trusted-device Cookie. */
  readonly publicOrigin: string;
  /** Explicit development-only escape hatch for an HTTP origin on the local loopback interface. */
  readonly allowLoopbackHttp?: boolean;
}

type RoomRbacAction = RoomRbacPolicy.RoomRbacActionV1;
type ResolvedRbacRequest =
  | Readonly<{ readonly scope: "project"; readonly action: RoomRbacProjectActionV1 }>
  | Readonly<{ readonly scope: "room"; readonly action: RoomRbacAction }>;

const OPAQUE_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43,}$/u;
const COOKIE_PAIR_PATTERN = /^[\t ]*([!#$%&'*+\-.^_`|~0-9A-Za-z]+)=([^;\t ]*)[\t ]*$/u;
const AUDIT_RESOURCES = new Set<RoomControlPlaneResource>(["evidence", "alerts", "replay"]);
const TRUSTED_DEVICE_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

/*
FNXC:RoomControlPlaneRbac 2026-07-19-19:43:
Room HTTP authorization must derive its actor only from a durable trusted-device session.
The opaque credential is accepted solely from the fixed __Host-fusion-room-device Cookie after
an explicit same-origin browser proof against the configured public origin; bearer,
EventSource query, header, and body values are transport or payload data and never identities.
Read the durable registry on every request so expiry, revocation, project scope, and grants fail closed.
Core's broader operator project grant is intentionally narrowed here: only owner/admin may manage
or create Rooms, while an operator may perform the exact routed send_to_seat action.
The registry resolver receives only request and project scope, so authorization can complete before
getProjectContext() starts a store, watcher, or lazy Engine for an untrusted project.
*/

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function readSingleHeader(request: Request, headerName: string): string | null | undefined {
  let resolved: string | undefined;
  for (const [name, rawValue] of Object.entries(request.headers)) {
    if (name.toLowerCase() !== headerName) continue;
    if (resolved !== undefined || typeof rawValue !== "string") return null;
    resolved = rawValue;
  }
  return resolved;
}

function requestProtocol(request: Request): "http:" | "https:" {
  const socket = request.socket as typeof request.socket & { readonly encrypted?: boolean };
  if (request.protocol === "https" || socket.encrypted === true) return "https:";
  return "http:";
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function resolveConfiguredPublicOrigin(value: unknown, allowLoopbackHttp: boolean): URL {
  if (!isNonEmptyString(value)) {
    throw new TypeError("Room control-plane trusted-device public origin is required.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("Room control-plane trusted-device public origin is invalid.");
  }
  if (parsed.origin === "null" || parsed.origin !== value || parsed.username || parsed.password) {
    throw new TypeError("Room control-plane trusted-device public origin must be a canonical origin.");
  }
  if (parsed.protocol === "https:") return parsed;
  if (parsed.protocol === "http:" && allowLoopbackHttp && isLoopbackHostname(parsed.hostname)) return parsed;
  throw new TypeError("Room control-plane trusted-device public origin must use HTTPS unless explicit loopback HTTP development is enabled.");
}

function hasExpectedTargetOrigin(request: Request, publicOrigin: URL): boolean {
  const host = readSingleHeader(request, "host");
  return isNonEmptyString(host)
    && host.toLowerCase() === publicOrigin.host.toLowerCase()
    && requestProtocol(request) === publicOrigin.protocol;
}

function hasMutationSameOriginProof(request: Request, publicOrigin: URL): boolean {
  const origin = readSingleHeader(request, "origin");
  const fetchSite = readSingleHeader(request, "sec-fetch-site");
  return isNonEmptyString(origin)
    && origin === publicOrigin.origin
    && fetchSite === "same-origin"
    && hasExpectedTargetOrigin(request, publicOrigin);
}

function readTrustedDeviceCookie(
  request: Request,
  publicOrigin: URL,
  requireMutationSameOriginProof: boolean,
): string | null {
  if (!hasExpectedTargetOrigin(request, publicOrigin)) return null;
  if (requireMutationSameOriginProof && !hasMutationSameOriginProof(request, publicOrigin)) return null;
  const origin = readSingleHeader(request, "origin");
  if (origin !== undefined && origin !== publicOrigin.origin) return null;
  const fetchSite = readSingleHeader(request, "sec-fetch-site");
  if (fetchSite !== undefined && fetchSite !== "same-origin") return null;
  const rawCookie = readSingleHeader(request, "cookie");
  if (typeof rawCookie !== "string" || rawCookie.length === 0 || rawCookie.length > 4_096) return null;
  let credential: string | null = null;
  for (const pair of rawCookie.split(";")) {
    const match = COOKIE_PAIR_PATTERN.exec(pair);
    if (!match) return null;
    const [, name, value] = match;
    if (name !== DEFAULT_ROOM_CONTROL_PLANE_TRUSTED_DEVICE_COOKIE_NAME) continue;
    if (credential !== null || !OPAQUE_CREDENTIAL_PATTERN.test(value)) return null;
    credential = value;
  }
  return credential;
}

/**
 * FNXC:RoomControlPlaneRbac 2026-07-19-19:43:
 * Only the controlled issuer may serialize the durable trusted-device credential. Keep the
 * __Host- prefix contract intact: no Domain attribute, Path=/, Secure, HttpOnly, and strict
 * same-site handling. This helper deliberately has no logging path because the credential is secret.
 */
export function serializeRoomControlPlaneTrustedDeviceSetCookie(credential: string): string {
  if (!OPAQUE_CREDENTIAL_PATTERN.test(credential)) {
    throw new TypeError("Room control-plane trusted-device credential is invalid.");
  }
  return `${DEFAULT_ROOM_CONTROL_PLANE_TRUSTED_DEVICE_COOKIE_NAME}=${credential}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

function resolveRbacRequest(input: RoomControlPlaneAuthorizationInput): ResolvedRbacRequest | null {
  const { access, action, operation, resource, roomId } = input;
  if (roomId === null) {
    if (resource !== "room") return null;
    if (access === "read" && operation === "list") return { scope: "project", action: "list_rooms" };
    if (access === "write" && operation === "create") return { scope: "project", action: "create_room" };
    return null;
  }
  if (!isNonEmptyString(roomId)) return null;
  if (access === "read" && operation === "read") {
    return {
      scope: "room",
      action: resource !== "room" && AUDIT_RESOURCES.has(resource) ? "audit_room" : "view_room",
    };
  }
  if (access !== "write") return null;
  if (operation === "operator_action") {
    if (resource !== "room" || action !== "send_to_seat") return null;
    return { scope: "room", action: "operate_room" };
  }
  if (operation === "update" || operation === "delete" || operation === "command") {
    return { scope: "room", action: "manage_room" };
  }
  return null;
}

function denied(reason: string): RoomControlPlaneAuthorizationDecision {
  return { allowed: false, reason };
}

function allowed(principalId: string, roles: readonly string[]): RoomControlPlaneAuthorizationDecision {
  return { allowed: true, actorId: principalId, roles };
}

function mayManageRooms(roles: readonly string[]): boolean {
  return roles.includes("owner") || roles.includes("admin");
}

function hasRegistryReadMethods(value: unknown): value is RoomRbacRegistry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Pick<RoomRbacRegistry, "readAuthorizedProjectSnapshot" | "readAuthorizedSnapshot">;
  return typeof candidate.readAuthorizedProjectSnapshot === "function"
    && typeof candidate.readAuthorizedSnapshot === "function";
}

function hasRegistryPairingMethods(value: unknown): value is RoomRbacRegistry {
  if (!hasRegistryReadMethods(value)) return false;
  return typeof value.issueTrustedDeviceSession === "function"
    && typeof value.revokeTrustedDeviceSession === "function";
}

async function resolveRegistry(
  resolver: RoomControlPlaneRbacRegistryResolver,
  input: RoomControlPlaneRbacRegistryResolverInput,
): Promise<RoomRbacRegistry | null> {
  try {
    const registry = await resolver({ request: input.request, projectId: input.projectId });
    return hasRegistryReadMethods(registry) ? registry : null;
  } catch {
    return null;
  }
}

export function createRoomControlPlaneRbacAuthorizer(
  options: RoomControlPlaneRbacAuthorizerOptions,
): RoomControlPlaneRouteDependencies["authorizeProject"] {
  if (!options || typeof options.resolveRegistry !== "function") {
    throw new TypeError("Room control-plane RBAC authorizer requires a durable registry resolver.");
  }
  if (Object.prototype.hasOwnProperty.call(options, "trustedDeviceCookieName")) {
    throw new TypeError("Room control-plane trusted-device Cookie name is fixed and cannot be configured.");
  }
  if (options.allowLoopbackHttp !== undefined && typeof options.allowLoopbackHttp !== "boolean") {
    throw new TypeError("Room control-plane loopback HTTP setting must be a boolean.");
  }
  const publicOrigin = resolveConfiguredPublicOrigin(options.publicOrigin, options.allowLoopbackHttp === true);

  const issueTrustedDeviceSession: RoomControlPlaneTrustedDeviceSessionIssuer["issueTrustedDeviceSession"] = async (input) => {
    const registry = await resolveRegistry(options.resolveRegistry, input);
    if (!hasRegistryPairingMethods(registry)) throw new Error("Room control-plane trusted-device registry is unavailable.");
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + TRUSTED_DEVICE_SESSION_TTL_MS);
    const credential = createTrustedRoomDeviceCredential();
    const result = await registry.issueTrustedDeviceSession({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: input.projectId,
      sessionId: randomUUID(),
      principalId: input.principalId,
      deviceId: input.deviceId,
      credential,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      idempotencyKey: randomUUID(),
    });
    return {
      credential,
      sessionId: result.session.sessionId,
      principalId: result.session.principalId,
      deviceId: result.session.deviceId,
      expiresAt: result.session.expiresAt,
    };
  };
  const revokeTrustedDeviceSession: RoomControlPlaneTrustedDeviceSessionIssuer["revokeTrustedDeviceSession"] = async (input) => {
    const registry = await resolveRegistry(options.resolveRegistry, input);
    if (!hasRegistryPairingMethods(registry)) throw new Error("Room control-plane trusted-device registry is unavailable.");
    const result = await registry.revokeTrustedDeviceSession({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: input.projectId,
      sessionId: input.sessionId,
      expectedSessionVersion: input.expectedSessionVersion,
      revokedAt: new Date().toISOString(),
      idempotencyKey: randomUUID(),
    });
    return {
      sessionId: result.session.sessionId,
      revokedAt: result.session.revokedAt,
      sessionVersion: result.session.sessionVersion,
    };
  };
  const authorizeProject: RoomControlPlaneRouteDependencies["authorizeProject"] = async (input): Promise<RoomControlPlaneAuthorizationDecision> => {
    const credential = readTrustedDeviceCookie(input.request, publicOrigin, input.access === "write");
    if (credential === null) return denied("trusted-device-cookie-required");
    const request = resolveRbacRequest(input);
    if (request === null) {
      return denied(input.operation === "operator_action" ? "rbac-room-action-unrecognized" : "rbac-request-unrecognized");
    }
    const registry = await resolveRegistry(options.resolveRegistry, { request: input.request, projectId: input.projectId });
    if (registry === null) return denied("rbac-registry-unavailable");
    const requestedAt = new Date().toISOString();

    try {
      if (request.scope === "project") {
        const snapshotResult = await registry.readAuthorizedProjectSnapshot({
          contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
          projectId: input.projectId,
          credential,
          requestedAt,
        });
        if (!snapshotResult.ok) return denied("rbac-project-snapshot-denied");
        const decision = decideRoomRbacProjectAuthorization(toRoomRbacProjectDecisionInput({
          snapshot: snapshotResult.snapshot,
          request: {
            projectId: input.projectId,
            action: request.action,
            expectedAuthorizationVersion: snapshotResult.snapshot.authorizationSnapshot.authorizationVersion,
            requestedAt,
          },
        }));
        if (!decision.ok || !decision.authorized) return denied("rbac-project-action-denied");
        if (request.action === "create_room" && !mayManageRooms(decision.effectiveRoles)) {
          return denied("rbac-project-action-denied");
        }
        return allowed(snapshotResult.snapshot.trustedDeviceSession.principalId, decision.effectiveRoles);
      }

      const snapshotResult = await registry.readAuthorizedSnapshot({
        contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
        projectId: input.projectId,
        roomId: input.roomId!,
        credential,
        requestedAt,
      });
      if (!snapshotResult.ok) return denied("rbac-room-snapshot-denied");
      const decision = RoomRbacPolicy.decideRoomRbacAuthorization(toRoomRbacDecisionInput({
        snapshot: snapshotResult.snapshot,
        request: {
          projectId: input.projectId,
          roomId: input.roomId!,
          action: request.action,
          expectedAuthorizationVersion: snapshotResult.snapshot.authorizationSnapshot.authorizationVersion,
          requestedAt,
          takeover: null,
        },
        activeTakeoverLeases: [],
      }));
      if (!decision.ok || !decision.authorized) return denied("rbac-room-action-denied");
      if (request.action === "manage_room" && !mayManageRooms(decision.effectiveRoles)) {
        return denied("rbac-room-action-denied");
      }
      return allowed(snapshotResult.snapshot.trustedDeviceSession.principalId, decision.effectiveRoles);
    } catch {
      return denied("rbac-registry-unavailable");
    }
  };
  authorizeProject.issueTrustedDeviceSession = issueTrustedDeviceSession;
  authorizeProject.revokeTrustedDeviceSession = revokeTrustedDeviceSession;
  return authorizeProject;
}

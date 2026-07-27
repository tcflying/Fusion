import type { Request } from "express";
import { authenticateUpgradeRequest } from "./auth-middleware.js";
import { ApiError } from "./api-error.js";
import {
  createRoomControlPlaneRbacAuthorizer,
  type RoomControlPlaneRbacAuthorizerOptions,
} from "./room-control-plane-rbac-authorizer.js";
import type { RoomControlPlaneProjectAuthorizerWithPairing } from "./routes/register-room-control-plane-routes.js";

export type RoomControlPlaneServerRbacOptions =
  | RoomControlPlaneRbacAuthorizerOptions
  | (
    Omit<RoomControlPlaneRbacAuthorizerOptions, "publicOrigin">
    & {
      /** Resolves the exact host-owned origin after an OS-assigned loopback port accepts a request. */
      readonly resolvePublicOrigin: (request: Request) => string;
    }
  );

/*
FNXC:DesktopRoomRbacComposition 2026-07-27-15:23:
Packaged desktop resolves its OS-assigned loopback origin per request. The durable trusted-device
authorizer remains the identity boundary; bearer or explicit host transport proves transport only.
*/
export function createServerRoomControlPlaneRbacAuthorizer(
  roomRbac: RoomControlPlaneServerRbacOptions,
  daemonToken: string | undefined,
): RoomControlPlaneProjectAuthorizerWithPairing | undefined {
  const authorizeDaemonTransport = daemonToken
    ? async (request: Request) => authenticateUpgradeRequest(daemonToken, request)
    : roomRbac.authorizeDaemonTransport;
  if (typeof authorizeDaemonTransport !== "function") return undefined;

  const authorizers = new Map<string, RoomControlPlaneProjectAuthorizerWithPairing>();
  const resolveAuthorizer = (request: Request): RoomControlPlaneProjectAuthorizerWithPairing => {
    const publicOrigin = "publicOrigin" in roomRbac
      ? roomRbac.publicOrigin
      : roomRbac.resolvePublicOrigin(request);
    const cached = authorizers.get(publicOrigin);
    if (cached) return cached;

    const authorizer = createRoomControlPlaneRbacAuthorizer({
      resolveRegistry: roomRbac.resolveRegistry,
      publicOrigin,
      ...(roomRbac.allowLoopbackHttp === undefined
        ? {}
        : { allowLoopbackHttp: roomRbac.allowLoopbackHttp }),
      authorizeDaemonTransport,
    });
    authorizers.set(publicOrigin, authorizer);
    return authorizer;
  };

  const authorizeProject: RoomControlPlaneProjectAuthorizerWithPairing = async (input) => {
    try {
      return await resolveAuthorizer(input.request)(input);
    } catch {
      return { allowed: false, reason: "rbac-authorizer-unavailable" };
    }
  };
  authorizeProject.issueTrustedDeviceSession = async (input) => {
    try {
      const issue = resolveAuthorizer(input.request).issueTrustedDeviceSession;
      if (typeof issue !== "function") throw new Error("Room trusted-device session issuer is unavailable.");
      return await issue(input);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(403, "Room device session access denied", {
        code: "ROOM_DEVICE_SESSION_ACCESS_DENIED",
      });
    }
  };
  authorizeProject.revokeTrustedDeviceSession = async (input) => {
    try {
      const revoke = resolveAuthorizer(input.request).revokeTrustedDeviceSession;
      if (typeof revoke !== "function") throw new Error("Room trusted-device session revoker is unavailable.");
      return await revoke(input);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(403, "Room device session access denied", {
        code: "ROOM_DEVICE_SESSION_ACCESS_DENIED",
      });
    }
  };
  return authorizeProject;
}

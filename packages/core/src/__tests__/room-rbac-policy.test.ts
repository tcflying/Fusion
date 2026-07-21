import { describe, expect, it } from "vitest";

import { decideRoomRbacAuthorization } from "../room-rbac-policy.js";

const NOW = "2026-07-19T08:00:00.000Z";

function baseInput() {
  return {
    contractVersion: 1,
    trustedDeviceSession: {
      source: "trusted_device_session_registry",
      sessionId: "session-operator-1",
      deviceId: "device-operator-1",
      principalId: "principal-operator-1",
      issuedAt: "2026-07-19T07:00:00.000Z",
      expiresAt: "2026-07-19T09:00:00.000Z",
      revokedAt: null,
      sessionVersion: 4,
    },
    authorizationSnapshot: {
      source: "durable_room_rbac_registry",
      authorizationVersion: 12,
      grants: [
        {
          grantId: "grant-project-operator",
          principalId: "principal-operator-1",
          role: "operator",
          projectId: "project-1",
          roomId: null,
          grantedAt: "2026-07-19T07:30:00.000Z",
          revokedAt: null,
        },
      ],
    },
    request: {
      projectId: "project-1",
      roomId: "room-1",
      action: "operate_room",
      expectedAuthorizationVersion: 12,
      requestedAt: NOW,
      takeover: null,
    },
    activeTakeoverLeases: [],
  };
}

describe("decideRoomRbacAuthorization", () => {
  it("authorizes a trusted operator from a project-scoped durable grant", () => {
    const decision = decideRoomRbacAuthorization(baseInput());

    expect(decision).toMatchObject({
      ok: true,
      authorized: true,
      authorizationVersion: 12,
      effectiveRoles: ["operator"],
      takeover: { kind: "not_requested" },
    });
  });

  it("rejects an authorization version conflict before granting a room action", () => {
    const input = baseInput();
    input.request.expectedAuthorizationVersion = 11;

    const decision = decideRoomRbacAuthorization(input);

    expect(decision).toMatchObject({
      ok: false,
      authorized: false,
      reasonCodes: ["authorization_version_conflict"],
    });
  });

  it("rejects revoked and expired trusted device sessions", () => {
    const revoked = baseInput();
    revoked.trustedDeviceSession.revokedAt = "2026-07-19T07:59:00.000Z";
    const expired = baseInput();
    expired.trustedDeviceSession.expiresAt = "2026-07-19T07:59:00.000Z";

    expect(decideRoomRbacAuthorization(revoked)).toMatchObject({ authorized: false, reasonCodes: ["trusted_session_revoked"] });
    expect(decideRoomRbacAuthorization(expired)).toMatchObject({ authorized: false, reasonCodes: ["trusted_session_expired"] });
  });

  it("never authorizes an actor identity self-declared in the request payload", () => {
    const spoofed = baseInput() as Record<string, unknown>;
    spoofed.request = {
      ...(spoofed.request as Record<string, unknown>),
      actorId: "principal-owner-1",
    };

    const decision = decideRoomRbacAuthorization(spoofed);

    expect(decision).toMatchObject({
      ok: false,
      authorized: false,
      reasonCodes: ["unexpected_request_property"],
    });
  });

  it("honors room scope and role boundaries", () => {
    const observer = baseInput();
    observer.authorizationSnapshot.grants[0] = {
      ...observer.authorizationSnapshot.grants[0],
      role: "observer",
      roomId: "room-1",
    };

    expect(decideRoomRbacAuthorization(observer)).toMatchObject({ authorized: false, reasonCodes: ["role_action_forbidden"] });
    observer.request.action = "view_room";
    expect(decideRoomRbacAuthorization(observer)).toMatchObject({ authorized: true, effectiveRoles: ["observer"] });
  });

  it("makes exactly one deterministic human-takeover lease decision", () => {
    const input = baseInput();
    input.request.action = "human_takeover";
    input.request.takeover = {
      leaseId: "takeover-room-1",
      idempotencyKey: "takeover-request-1",
      expiresAt: "2026-07-19T08:15:00.000Z",
    };

    expect(decideRoomRbacAuthorization(input)).toMatchObject({
      authorized: true,
      takeover: {
        kind: "grant",
        lease: {
          leaseId: "takeover-room-1",
          principalId: "principal-operator-1",
          deviceId: "device-operator-1",
        },
      },
    });

    input.activeTakeoverLeases = [
      {
        leaseId: "existing-takeover",
        projectId: "project-1",
        roomId: "room-1",
        principalId: "principal-admin-1",
        deviceId: "device-admin-1",
        idempotencyKey: "existing-request",
        issuedAt: "2026-07-19T07:55:00.000Z",
        expiresAt: "2026-07-19T08:10:00.000Z",
        revokedAt: null,
      },
    ];

    expect(decideRoomRbacAuthorization(input)).toMatchObject({
      authorized: false,
      reasonCodes: ["human_takeover_already_held"],
      takeover: { kind: "deny" },
    });
  });
});

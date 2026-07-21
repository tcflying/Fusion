import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { decideRoomRbacAuthorization } from "../room-rbac-policy.js";
import {
  ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
  RoomRbacRegistryError,
  createTrustedRoomDeviceCredential,
  createInMemoryRoomRbacRegistry,
  decideRoomRbacProjectAuthorization,
  type ReadAuthorizedProjectRbacSnapshotInputV1,
  toRoomRbacProjectDecisionInput,
  toRoomRbacDecisionInput,
} from "../room-rbac-registry.js";

const PROJECT_A = "project-rbac-a";
const PROJECT_B = "project-rbac-b";
const ROOM_A = "room-rbac-a";
const ROOM_B = "room-rbac-b";
const ISSUED_AT = "2026-07-19T08:00:00.000Z";
const EXPIRES_AT = "2026-07-19T10:00:00.000Z";
const REQUESTED_AT = "2026-07-19T09:00:00.000Z";

function newCredential(): string {
  return randomBytes(32).toString("base64url");
}

async function issueOperatorSession(
  registry: ReturnType<typeof createInMemoryRoomRbacRegistry>,
  input: {
    readonly credential?: string;
    readonly projectId?: string;
    readonly sessionId?: string;
    readonly principalId?: string;
    readonly deviceId?: string;
    readonly idempotencyKey?: string;
    readonly expiresAt?: string;
  } = {},
) {
  const credential = input.credential ?? newCredential();
  const result = await registry.issueTrustedDeviceSession({
    contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
    projectId: input.projectId ?? PROJECT_A,
    sessionId: input.sessionId ?? "session-operator-a",
    principalId: input.principalId ?? "principal-operator-a",
    deviceId: input.deviceId ?? "device-operator-a",
    credential,
    issuedAt: ISSUED_AT,
    expiresAt: input.expiresAt ?? EXPIRES_AT,
    idempotencyKey: input.idempotencyKey ?? "issue-session-operator-a",
  });
  return { credential, result };
}

async function grant(
  registry: ReturnType<typeof createInMemoryRoomRbacRegistry>,
  input: {
    readonly grantId: string;
    readonly principalId?: string;
    readonly role: "owner" | "admin" | "operator" | "observer" | "auditor";
    readonly roomId: string | null;
    readonly expectedAuthorizationVersion: number;
    readonly idempotencyKey: string;
  },
) {
  return registry.grantRole({
    contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
    projectId: PROJECT_A,
    grantId: input.grantId,
    principalId: input.principalId ?? "principal-operator-a",
    role: input.role,
    roomId: input.roomId,
    grantedAt: REQUESTED_AT,
    expectedAuthorizationVersion: input.expectedAuthorizationVersion,
    idempotencyKey: input.idempotencyKey,
  });
}

describe("RoomRbacRegistry", () => {
  it("generates a 256-bit opaque credential while keeping the original value out of durable results", async () => {
    const registry = createInMemoryRoomRbacRegistry();
    const credential = createTrustedRoomDeviceCredential();

    expect(credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const { result } = await issueOperatorSession(registry, { credential });

    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it("stores only a credential digest and returns an authenticated snapshot that pure policy can decide", async () => {
    const registry = createInMemoryRoomRbacRegistry();
    const { credential, result: issued } = await issueOperatorSession(registry);
    const granted = await grant(registry, {
      grantId: "grant-project-operator-a",
      role: "operator",
      roomId: null,
      expectedAuthorizationVersion: 0,
      idempotencyKey: "grant-project-operator-a",
    });

    expect(issued.idempotentReplay).toBe(false);
    expect(issued.session).toMatchObject({
      source: "trusted_device_session_registry",
      sessionId: "session-operator-a",
      principalId: "principal-operator-a",
      deviceId: "device-operator-a",
      sessionVersion: 1,
    });
    expect(JSON.stringify(issued)).not.toContain(credential);
    expect(JSON.stringify(granted)).not.toContain(credential);

    const read = await registry.readAuthorizedSnapshot({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      roomId: ROOM_A,
      credential,
      requestedAt: REQUESTED_AT,
    });

    expect(read).toMatchObject({
      ok: true,
      snapshot: {
        source: "durable_room_rbac_registry",
        projectId: PROJECT_A,
        roomId: ROOM_A,
        authorizationSnapshot: {
          authorizationVersion: 1,
          grants: [{ grantId: "grant-project-operator-a", role: "operator", roomId: null }],
        },
      },
    });
    expect(JSON.stringify(read)).not.toContain(credential);

    if (!read.ok) throw new Error(`Expected authorized snapshot, got ${read.issue.code}`);
    const decision = decideRoomRbacAuthorization(toRoomRbacDecisionInput({
      snapshot: read.snapshot,
      request: {
        projectId: PROJECT_A,
        roomId: ROOM_A,
        action: "operate_room",
        expectedAuthorizationVersion: 1,
        requestedAt: REQUESTED_AT,
        takeover: null,
      },
      activeTakeoverLeases: [],
    }));
    expect(decision).toMatchObject({ authorized: true, effectiveRoles: ["operator"] });
  });

  it("fails closed for absent, expired, revoked, and cross-project credentials", async () => {
    const registry = createInMemoryRoomRbacRegistry();
    const { credential } = await issueOperatorSession(registry);
    await expect(registry.readAuthorizedSnapshot({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      roomId: ROOM_A,
      credential,
      requestedAt: REQUESTED_AT,
    })).resolves.toMatchObject({ ok: false, issue: { code: "no_effective_project_or_room_grant" } });
    await grant(registry, {
      grantId: "grant-project-observer-a",
      role: "observer",
      roomId: null,
      expectedAuthorizationVersion: 0,
      idempotencyKey: "grant-project-observer-a",
    });

    await expect(registry.readAuthorizedSnapshot({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      roomId: ROOM_A,
      credential: newCredential(),
      requestedAt: REQUESTED_AT,
    })).resolves.toMatchObject({ ok: false, issue: { code: "trusted_device_session_not_found" } });

    await expect(registry.readAuthorizedSnapshot({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_B,
      roomId: ROOM_A,
      credential,
      requestedAt: REQUESTED_AT,
    })).resolves.toMatchObject({ ok: false, issue: { code: "trusted_device_session_project_scope_denied" } });

    await expect(registry.readAuthorizedProjectSnapshot({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_B,
      credential,
      requestedAt: REQUESTED_AT,
    })).resolves.toMatchObject({ ok: false, issue: { code: "trusted_device_session_project_scope_denied" } });

    await expect(registry.readAuthorizedSnapshot({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      roomId: ROOM_A,
      credential,
      requestedAt: EXPIRES_AT,
    })).resolves.toMatchObject({ ok: false, issue: { code: "trusted_device_session_expired" } });

    await registry.revokeTrustedDeviceSession({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      sessionId: "session-operator-a",
      expectedSessionVersion: 1,
      revokedAt: REQUESTED_AT,
      idempotencyKey: "revoke-session-operator-a",
    });
    await expect(registry.readAuthorizedSnapshot({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      roomId: ROOM_A,
      credential,
      requestedAt: REQUESTED_AT,
    })).resolves.toMatchObject({ ok: false, issue: { code: "trusted_device_session_revoked" } });
  });

  it("combines project and exact Room grants without leaking a Room grant into another Room", async () => {
    const registry = createInMemoryRoomRbacRegistry();
    const { credential } = await issueOperatorSession(registry);
    await grant(registry, {
      grantId: "grant-project-observer-a",
      role: "observer",
      roomId: null,
      expectedAuthorizationVersion: 0,
      idempotencyKey: "grant-project-observer-a",
    });
    await grant(registry, {
      grantId: "grant-room-operator-a",
      role: "operator",
      roomId: ROOM_A,
      expectedAuthorizationVersion: 1,
      idempotencyKey: "grant-room-operator-a",
    });

    const roomA = await registry.readAuthorizedSnapshot({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      roomId: ROOM_A,
      credential,
      requestedAt: REQUESTED_AT,
    });
    const roomB = await registry.readAuthorizedSnapshot({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      roomId: ROOM_B,
      credential,
      requestedAt: REQUESTED_AT,
    });
    if (!roomA.ok || !roomB.ok) throw new Error("Expected scoped snapshots");

    const permitRoomA = decideRoomRbacAuthorization(toRoomRbacDecisionInput({
      snapshot: roomA.snapshot,
      request: {
        projectId: PROJECT_A,
        roomId: ROOM_A,
        action: "operate_room",
        expectedAuthorizationVersion: 2,
        requestedAt: REQUESTED_AT,
        takeover: null,
      },
      activeTakeoverLeases: [],
    }));
    const denyRoomB = decideRoomRbacAuthorization(toRoomRbacDecisionInput({
      snapshot: roomB.snapshot,
      request: {
        projectId: PROJECT_A,
        roomId: ROOM_B,
        action: "operate_room",
        expectedAuthorizationVersion: 2,
        requestedAt: REQUESTED_AT,
        takeover: null,
      },
      activeTakeoverLeases: [],
    }));

    expect(permitRoomA).toMatchObject({ authorized: true, effectiveRoles: ["operator", "observer"] });
    expect(denyRoomB).toMatchObject({ authorized: false, reasonCodes: ["role_action_forbidden"] });
  });

  it("returns a real project-scope snapshot for list/create without a fake Room ID and excludes room-only grants", async () => {
    const registry = createInMemoryRoomRbacRegistry();
    const { credential } = await issueOperatorSession(registry);
    await grant(registry, {
      grantId: "grant-project-operator-a",
      role: "operator",
      roomId: null,
      expectedAuthorizationVersion: 0,
      idempotencyKey: "grant-project-operator-a",
    });
    await grant(registry, {
      grantId: "grant-room-observer-a",
      role: "observer",
      roomId: ROOM_A,
      expectedAuthorizationVersion: 1,
      idempotencyKey: "grant-room-observer-a",
    });

    const projectRead = await registry.readAuthorizedProjectSnapshot({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      credential,
      requestedAt: REQUESTED_AT,
    });
    expect(projectRead).toMatchObject({
      ok: true,
      snapshot: {
        projectId: PROJECT_A,
        authorizationSnapshot: {
          authorizationVersion: 2,
          grants: [{ grantId: "grant-project-operator-a", roomId: null, role: "operator" }],
        },
      },
    });
    expect(JSON.stringify(projectRead)).not.toContain(credential);
    if (!projectRead.ok) throw new Error("Expected a project-scope snapshot");
    expect(decideRoomRbacProjectAuthorization(toRoomRbacProjectDecisionInput({
      snapshot: projectRead.snapshot,
      request: {
        projectId: PROJECT_A,
        action: "list_rooms",
        expectedAuthorizationVersion: 2,
        requestedAt: REQUESTED_AT,
      },
    }))).toMatchObject({ authorized: true, effectiveRoles: ["operator"] });
    expect(decideRoomRbacProjectAuthorization(toRoomRbacProjectDecisionInput({
      snapshot: projectRead.snapshot,
      request: {
        projectId: PROJECT_A,
        action: "create_room",
        expectedAuthorizationVersion: 2,
        requestedAt: REQUESTED_AT,
      },
    }))).toMatchObject({ authorized: true, effectiveRoles: ["operator"] });
    const fakeRoomScope = {
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      roomId: ROOM_A,
      credential,
      requestedAt: REQUESTED_AT,
    };
    await expect(registry.readAuthorizedProjectSnapshot(fakeRoomScope as ReadAuthorizedProjectRbacSnapshotInputV1))
      .resolves.toMatchObject({ ok: false, issue: { code: "invalid_input" } });

    const observerRegistry = createInMemoryRoomRbacRegistry();
    const { credential: observerCredential } = await issueOperatorSession(observerRegistry, {
      sessionId: "session-project-observer-a",
      principalId: "principal-project-observer-a",
      deviceId: "device-project-observer-a",
      idempotencyKey: "issue-session-project-observer-a",
    });
    await grant(observerRegistry, {
      grantId: "grant-project-observer-a",
      principalId: "principal-project-observer-a",
      role: "observer",
      roomId: null,
      expectedAuthorizationVersion: 0,
      idempotencyKey: "grant-project-observer-a",
    });
    const observerRead = await observerRegistry.readAuthorizedProjectSnapshot({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      credential: observerCredential,
      requestedAt: REQUESTED_AT,
    });
    if (!observerRead.ok) throw new Error("Expected a project-scoped observer snapshot");
    expect(decideRoomRbacProjectAuthorization(toRoomRbacProjectDecisionInput({
      snapshot: observerRead.snapshot,
      request: {
        projectId: PROJECT_A,
        action: "list_rooms",
        expectedAuthorizationVersion: 1,
        requestedAt: REQUESTED_AT,
      },
    }))).toMatchObject({ authorized: true, effectiveRoles: ["observer"] });
    expect(decideRoomRbacProjectAuthorization(toRoomRbacProjectDecisionInput({
      snapshot: observerRead.snapshot,
      request: {
        projectId: PROJECT_A,
        action: "create_room",
        expectedAuthorizationVersion: 1,
        requestedAt: REQUESTED_AT,
      },
    }))).toMatchObject({ authorized: false, reasonCodes: ["role_action_forbidden"] });

    const roomOnlyRegistry = createInMemoryRoomRbacRegistry();
    const { credential: roomOnlyCredential } = await issueOperatorSession(roomOnlyRegistry, { sessionId: "session-room-only-a" });
    await grant(roomOnlyRegistry, {
      grantId: "grant-room-only-operator-a",
      role: "operator",
      roomId: ROOM_A,
      expectedAuthorizationVersion: 0,
      idempotencyKey: "grant-room-only-operator-a",
    });
    await expect(roomOnlyRegistry.readAuthorizedProjectSnapshot({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      credential: roomOnlyCredential,
      requestedAt: REQUESTED_AT,
    })).resolves.toMatchObject({ ok: false, issue: { code: "no_effective_project_or_room_grant" } });
    const roomOnlyRead = await roomOnlyRegistry.readAuthorizedSnapshot({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      roomId: ROOM_A,
      credential: roomOnlyCredential,
      requestedAt: REQUESTED_AT,
    });
    if (!roomOnlyRead.ok) throw new Error("Expected the Room-scoped grant to remain valid for its Room");
    expect(decideRoomRbacProjectAuthorization({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      trustedDeviceSession: roomOnlyRead.snapshot.trustedDeviceSession,
      authorizationSnapshot: roomOnlyRead.snapshot.authorizationSnapshot,
      request: {
        projectId: PROJECT_A,
        action: "list_rooms",
        expectedAuthorizationVersion: 1,
        requestedAt: REQUESTED_AT,
      },
    })).toMatchObject({ authorized: false, reasonCodes: ["no_project_grant"] });
  });

  it("makes issuance and grants idempotent while rejecting payload and optimistic-version conflicts", async () => {
    const registry = createInMemoryRoomRbacRegistry();
    const credential = newCredential();
    const first = await issueOperatorSession(registry, { credential });
    const replay = await issueOperatorSession(registry, { credential });

    expect(first.result.idempotentReplay).toBe(false);
    expect(replay.result).toMatchObject({ idempotentReplay: true, session: first.result.session });
    await expect(issueOperatorSession(registry, {
      credential,
      expiresAt: "2026-07-19T11:00:00.000Z",
    })).rejects.toMatchObject({ code: "idempotency_key_conflict" } satisfies Partial<RoomRbacRegistryError>);

    await grant(registry, {
      grantId: "grant-project-operator-a",
      role: "operator",
      roomId: null,
      expectedAuthorizationVersion: 0,
      idempotencyKey: "grant-project-operator-a",
    });
    await expect(grant(registry, {
      grantId: "grant-project-auditor-a",
      role: "auditor",
      roomId: null,
      expectedAuthorizationVersion: 0,
      idempotencyKey: "grant-project-auditor-a",
    })).rejects.toMatchObject({ code: "authorization_version_conflict" } satisfies Partial<RoomRbacRegistryError>);

    await registry.revokeTrustedDeviceSession({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      sessionId: "session-operator-a",
      expectedSessionVersion: 1,
      revokedAt: REQUESTED_AT,
      idempotencyKey: "revoke-session-operator-a",
    });
    await expect(registry.revokeTrustedDeviceSession({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      sessionId: "session-operator-a",
      expectedSessionVersion: 1,
      revokedAt: "2026-07-19T09:01:00.000Z",
      idempotencyKey: "revoke-session-operator-a-conflict",
    })).rejects.toMatchObject({ code: "trusted_device_session_version_conflict" } satisfies Partial<RoomRbacRegistryError>);
  });
});

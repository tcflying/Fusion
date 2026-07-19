// @vitest-environment node

import type { Request } from "express";
import {
  ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
  createInMemoryRoomRbacRegistry,
  createTrustedRoomDeviceCredential,
  type RoomRbacRegistry,
} from "@fusion/core";
import { describe, expect, it } from "vitest";
import * as roomRbacAuthorizerModule from "../room-control-plane-rbac-authorizer.js";
import {
  DEFAULT_ROOM_CONTROL_PLANE_TRUSTED_DEVICE_COOKIE_NAME,
  createRoomControlPlaneRbacAuthorizer,
} from "../room-control-plane-rbac-authorizer.js";
import type { RoomControlPlaneAuthorizationInput } from "../routes/register-room-control-plane-routes.js";

const PROJECT_A = "project-rbac-dashboard-a";
const PROJECT_B = "project-rbac-dashboard-b";
const ROOM_A = "room-rbac-dashboard-a";
const ROOM_B = "room-rbac-dashboard-b";
const PUBLIC_ORIGIN = "https://dashboard.example";

function timestamp(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function issueSession(
  registry: RoomRbacRegistry,
  input: Readonly<{
    projectId?: string;
    principalId?: string;
    sessionId?: string;
    credential?: string;
    expiresAt?: string;
  }> = {},
): Promise<Readonly<{ credential: string; principalId: string }>> {
  const credential = input.credential ?? createTrustedRoomDeviceCredential();
  const principalId = input.principalId ?? "trusted-dashboard-principal";
  await registry.issueTrustedDeviceSession({
    contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
    projectId: input.projectId ?? PROJECT_A,
    sessionId: input.sessionId ?? "trusted-dashboard-session",
    principalId,
    deviceId: "trusted-dashboard-device",
    credential,
    issuedAt: timestamp(-60_000),
    expiresAt: input.expiresAt ?? timestamp(60 * 60_000),
    idempotencyKey: `issue-${input.sessionId ?? "trusted-dashboard-session"}`,
  });
  return { credential, principalId };
}

async function grant(
  registry: RoomRbacRegistry,
  input: Readonly<{
    role: "owner" | "admin" | "operator" | "observer" | "auditor";
    roomId: string | null;
    expectedAuthorizationVersion?: number;
    principalId?: string;
    grantId: string;
  }>,
): Promise<void> {
  await registry.grantRole({
    contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
    projectId: PROJECT_A,
    grantId: input.grantId,
    principalId: input.principalId ?? "trusted-dashboard-principal",
    role: input.role,
    roomId: input.roomId,
    grantedAt: timestamp(-1_000),
    expectedAuthorizationVersion: input.expectedAuthorizationVersion ?? 0,
    idempotencyKey: `grant-${input.grantId}`,
  });
}

function authorizationInput(input: Readonly<{
  projectId?: string;
  roomId?: string | null;
  resource?: RoomControlPlaneAuthorizationInput["resource"];
  operation?: RoomControlPlaneAuthorizationInput["operation"];
  action?: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
  protocol?: "http" | "https";
}> = {}): RoomControlPlaneAuthorizationInput {
  return {
    request: {
      headers: input.headers ?? {},
      query: input.query ?? {},
      body: input.body ?? {},
      protocol: input.protocol ?? "https",
      socket: { encrypted: (input.protocol ?? "https") === "https" },
    } as Request,
    projectId: input.projectId ?? PROJECT_A,
    store: {} as RoomControlPlaneAuthorizationInput["store"],
    access: input.operation === "list" || input.operation === "read" ? "read" : "write",
    resource: input.resource ?? "room",
    roomId: input.roomId === undefined ? ROOM_A : input.roomId,
    operation: input.operation ?? "read",
    ...(input.action === undefined ? {} : { action: input.action }),
  };
}

function cookie(credential: string): Record<string, string> {
  return {
    cookie: `${DEFAULT_ROOM_CONTROL_PLANE_TRUSTED_DEVICE_COOKIE_NAME}=${credential}`,
    host: "dashboard.example",
    origin: PUBLIC_ORIGIN,
    "sec-fetch-site": "same-origin",
  };
}

function authorizerFor(registry: RoomRbacRegistry) {
  return createRoomControlPlaneRbacAuthorizer({
    resolveRegistry: async () => registry,
    publicOrigin: PUBLIC_ORIGIN,
  });
}

describe("Room control-plane RBAC authorizer", () => {
  it("requires an exact configured public origin and never permits a caller-selected Cookie name", () => {
    const registry = createInMemoryRoomRbacRegistry();

    expect(() => createRoomControlPlaneRbacAuthorizer({
      resolveRegistry: async () => registry,
    } as unknown as Parameters<typeof createRoomControlPlaneRbacAuthorizer>[0])).toThrow(/public origin/i);
    expect(() => createRoomControlPlaneRbacAuthorizer({
      resolveRegistry: async () => registry,
      publicOrigin: PUBLIC_ORIGIN,
      trustedDeviceCookieName: "operator-selected-cookie",
    } as unknown as Parameters<typeof createRoomControlPlaneRbacAuthorizer>[0])).toThrow(/cookie name/i);
  });

  it("serializes the only trusted-device credential Cookie with the __Host- security contract", () => {
    const credential = createTrustedRoomDeviceCredential();
    const serializer = (roomRbacAuthorizerModule as {
      readonly serializeRoomControlPlaneTrustedDeviceSetCookie?: (value: string) => string;
    }).serializeRoomControlPlaneTrustedDeviceSetCookie;

    expect(serializer).toBeTypeOf("function");
    expect(serializer?.(credential)).toBe(
      `${DEFAULT_ROOM_CONTROL_PLANE_TRUSTED_DEVICE_COOKIE_NAME}=${credential}; Path=/; HttpOnly; Secure; SameSite=Strict`,
    );
  });

  it("requires explicit same-origin fetch metadata and allows HTTP only through the explicit loopback switch", async () => {
    const registry = createInMemoryRoomRbacRegistry();
    const { credential } = await issueSession(registry);
    await grant(registry, { grantId: "same-origin-operator", role: "operator", roomId: null });
    const authorize = authorizerFor(registry);

    await expect(authorize(authorizationInput({
      roomId: null,
      operation: "list",
      headers: {
        cookie: `${DEFAULT_ROOM_CONTROL_PLANE_TRUSTED_DEVICE_COOKIE_NAME}=${credential}`,
        host: "dashboard.example",
        "sec-fetch-site": "same-origin",
      },
    }))).resolves.toEqual({ allowed: false, reason: "trusted-device-cookie-required" });
    await expect(authorize(authorizationInput({
      roomId: null,
      operation: "list",
      headers: {
        cookie: `${DEFAULT_ROOM_CONTROL_PLANE_TRUSTED_DEVICE_COOKIE_NAME}=${credential}`,
        host: "dashboard.example",
        origin: PUBLIC_ORIGIN,
      },
    }))).resolves.toEqual({ allowed: false, reason: "trusted-device-cookie-required" });
    expect(() => createRoomControlPlaneRbacAuthorizer({
      resolveRegistry: async () => registry,
      publicOrigin: "http://127.0.0.1:4545",
    })).toThrow(/HTTPS/i);
    expect(() => createRoomControlPlaneRbacAuthorizer({
      resolveRegistry: async () => registry,
      publicOrigin: "http://dashboard.example",
      allowLoopbackHttp: true,
    })).toThrow(/HTTPS/i);

    const allowLoopbackHttp = createRoomControlPlaneRbacAuthorizer({
      resolveRegistry: async () => registry,
      publicOrigin: "http://127.0.0.1:4545",
      allowLoopbackHttp: true,
    });
    await expect(allowLoopbackHttp(authorizationInput({
      roomId: null,
      operation: "list",
      protocol: "http",
      headers: {
        cookie: `${DEFAULT_ROOM_CONTROL_PLANE_TRUSTED_DEVICE_COOKIE_NAME}=${credential}`,
        host: "127.0.0.1:4545",
        origin: "http://127.0.0.1:4545",
        "sec-fetch-site": "same-origin",
      },
    }))).resolves.toMatchObject({ allowed: true });
  });

  it("accepts an opaque trusted-device Cookie and derives the actor only from the durable principal", async () => {
    const registry = createInMemoryRoomRbacRegistry();
    const { credential, principalId } = await issueSession(registry);
    await grant(registry, { grantId: "project-operator", role: "operator", roomId: null });

    const decision = await authorizerFor(registry)(authorizationInput({
      roomId: null,
      operation: "list",
      headers: cookie(credential),
    }));

    expect(decision).toMatchObject({ allowed: true, actorId: principalId, roles: ["operator"] });
  });

  it("does not treat a daemon bearer, EventSource query token, header, or body claim as a principal", async () => {
    const registry = createInMemoryRoomRbacRegistry();
    const { credential } = await issueSession(registry);
    await grant(registry, { grantId: "project-owner", role: "owner", roomId: null });
    let resolverCalls = 0;
    const authorize = createRoomControlPlaneRbacAuthorizer({
      resolveRegistry: async () => {
        resolverCalls += 1;
        return registry;
      },
      publicOrigin: PUBLIC_ORIGIN,
    });

    const decision = await authorize(authorizationInput({
      roomId: null,
      operation: "list",
      headers: { authorization: `Bearer ${credential}`, "x-room-principal-id": "forged-owner" },
      query: { fn_token: credential, principalId: "forged-owner" },
      body: { credential, principalId: "forged-owner" },
    }));

    expect(decision).toEqual({ allowed: false, reason: "trusted-device-cookie-required" });
    expect(resolverCalls).toBe(0);
  });

  it("fails closed for cross-project credentials and room-only grants on project list/create", async () => {
    const registry = createInMemoryRoomRbacRegistry();
    const { credential } = await issueSession(registry);
    await grant(registry, { grantId: "room-only-operator", role: "operator", roomId: ROOM_A });
    const authorize = authorizerFor(registry);

    await expect(authorize(authorizationInput({ roomId: null, operation: "list", headers: cookie(credential) })))
      .resolves.toEqual({ allowed: false, reason: "rbac-project-snapshot-denied" });
    await expect(authorize(authorizationInput({ roomId: null, operation: "create", headers: cookie(credential) })))
      .resolves.toEqual({ allowed: false, reason: "rbac-project-snapshot-denied" });
    await expect(authorize(authorizationInput({
      projectId: PROJECT_B,
      roomId: ROOM_B,
      operation: "read",
      headers: cookie(credential),
    }))).resolves.toEqual({ allowed: false, reason: "rbac-room-snapshot-denied" });
  });

  it("re-reads the durable registry so revoked and expired trusted-device sessions fail closed", async () => {
    const registry = createInMemoryRoomRbacRegistry();
    const active = await issueSession(registry, { sessionId: "durable-session" });
    await grant(registry, { grantId: "durable-owner", role: "owner", roomId: null });
    let resolverCalls = 0;
    const authorize = createRoomControlPlaneRbacAuthorizer({
      resolveRegistry: async () => {
        resolverCalls += 1;
        return registry;
      },
      publicOrigin: PUBLIC_ORIGIN,
    });

    await expect(authorize(authorizationInput({
      roomId: null,
      operation: "list",
      headers: cookie(active.credential),
    }))).resolves.toMatchObject({ allowed: true, actorId: active.principalId });

    await registry.revokeTrustedDeviceSession({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      sessionId: "durable-session",
      expectedSessionVersion: 1,
      revokedAt: timestamp(0),
      idempotencyKey: "revoke-durable-session",
    });

    await expect(authorize(authorizationInput({
      roomId: null,
      operation: "list",
      headers: cookie(active.credential),
    }))).resolves.toEqual({ allowed: false, reason: "rbac-project-snapshot-denied" });
    expect(resolverCalls).toBe(2);

    const expiredRegistry = createInMemoryRoomRbacRegistry();
    const expired = await issueSession(expiredRegistry, {
      sessionId: "expired-session",
      expiresAt: timestamp(-1),
    });
    await grant(expiredRegistry, { grantId: "expired-owner", role: "owner", roomId: null });
    await expect(authorizerFor(expiredRegistry)(authorizationInput({
      roomId: null,
      operation: "list",
      headers: cookie(expired.credential),
    }))).resolves.toEqual({ allowed: false, reason: "rbac-project-snapshot-denied" });
  });

  it("keeps observer writes denied and permits an operator only for the exact send_to_seat action", async () => {
    const observerRegistry = createInMemoryRoomRbacRegistry();
    const observer = await issueSession(observerRegistry, { principalId: "observer-principal" });
    await grant(observerRegistry, {
      grantId: "project-observer",
      role: "observer",
      roomId: null,
      principalId: observer.principalId,
    });
    const observerAuthorize = authorizerFor(observerRegistry);
    await expect(observerAuthorize(authorizationInput({
      operation: "operator_action",
      action: "send_to_seat",
      headers: cookie(observer.credential),
    }))).resolves.toEqual({ allowed: false, reason: "rbac-room-action-denied" });

    const operatorRegistry = createInMemoryRoomRbacRegistry();
    const operator = await issueSession(operatorRegistry);
    await grant(operatorRegistry, { grantId: "project-operator", role: "operator", roomId: null });
    const operatorAuthorize = authorizerFor(operatorRegistry);

    await expect(operatorAuthorize(authorizationInput({
      operation: "operator_action",
      action: "send_to_seat",
      headers: cookie(operator.credential),
    }))).resolves.toMatchObject({ allowed: true, actorId: operator.principalId });
    await expect(operatorAuthorize(authorizationInput({ operation: "create", roomId: null, headers: cookie(operator.credential) })))
      .resolves.toEqual({ allowed: false, reason: "rbac-project-action-denied" });
    await expect(operatorAuthorize(authorizationInput({ operation: "update", headers: cookie(operator.credential) })))
      .resolves.toEqual({ allowed: false, reason: "rbac-room-action-denied" });
    await expect(operatorAuthorize(authorizationInput({ operation: "delete", headers: cookie(operator.credential) })))
      .resolves.toEqual({ allowed: false, reason: "rbac-room-action-denied" });
    await expect(operatorAuthorize(authorizationInput({
      operation: "operator_action",
      action: "pause",
      headers: cookie(operator.credential),
    }))).resolves.toEqual({ allowed: false, reason: "rbac-room-action-unrecognized" });
  });

  it("uses audit_room only for audit resources and rejects duplicate, encoded, or cross-origin device cookies", async () => {
    const registry = createInMemoryRoomRbacRegistry();
    const auditor = await issueSession(registry, { principalId: "auditor-principal" });
    await grant(registry, {
      grantId: "project-auditor",
      role: "auditor",
      roomId: null,
      principalId: auditor.principalId,
    });
    const authorize = authorizerFor(registry);

    await expect(authorize(authorizationInput({
      resource: "evidence",
      operation: "read",
      headers: cookie(auditor.credential),
    }))).resolves.toMatchObject({ allowed: true, actorId: auditor.principalId });
    await expect(authorize(authorizationInput({
      resource: "participants",
      operation: "read",
      headers: cookie(auditor.credential),
    }))).resolves.toMatchObject({ allowed: true, actorId: auditor.principalId });
    await expect(authorize(authorizationInput({
      operation: "read",
      headers: {
        cookie: `${DEFAULT_ROOM_CONTROL_PLANE_TRUSTED_DEVICE_COOKIE_NAME}=${auditor.credential}; ${DEFAULT_ROOM_CONTROL_PLANE_TRUSTED_DEVICE_COOKIE_NAME}=${auditor.credential}`,
      },
    }))).resolves.toEqual({ allowed: false, reason: "trusted-device-cookie-required" });
    await expect(authorize(authorizationInput({
      operation: "read",
      headers: { cookie: `${DEFAULT_ROOM_CONTROL_PLANE_TRUSTED_DEVICE_COOKIE_NAME}=%${auditor.credential}` },
    }))).resolves.toEqual({ allowed: false, reason: "trusted-device-cookie-required" });
    await expect(authorize(authorizationInput({
      operation: "read",
      headers: {
        ...cookie(auditor.credential),
        host: "dashboard.example",
        origin: "https://attacker.example",
      },
    }))).resolves.toEqual({ allowed: false, reason: "trusted-device-cookie-required" });
    await expect(authorize(authorizationInput({
      operation: "read",
      headers: {
        ...cookie(auditor.credential),
        "sec-fetch-site": "cross-site",
      },
    }))).resolves.toEqual({ allowed: false, reason: "trusted-device-cookie-required" });
  });
});

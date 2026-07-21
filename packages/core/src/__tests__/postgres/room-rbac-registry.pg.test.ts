import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { decideRoomRbacAuthorization } from "../../room-rbac-policy.js";
import {
  ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
  decideRoomRbacProjectAuthorization,
  digestTrustedRoomDeviceCredential,
  toRoomRbacProjectDecisionInput,
  toRoomRbacDecisionInput,
} from "../../room-rbac-registry.js";
import { createPostgresRoomRbacRegistry } from "../../room-rbac-registry-postgres.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import { operationalRooms, roomTrustedDeviceSessions } from "../../postgres/schema/room.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const PROJECT_A = "project-rbac-pg-a";
const PROJECT_B = "project-rbac-pg-b";
const ROOM_A = "room-rbac-pg-a";
const ROOM_B = "room-rbac-pg-b";
const ISSUED_AT = "2026-07-19T08:00:00.000Z";
const REQUESTED_AT = "2026-07-19T09:00:00.000Z";
const EXPIRES_AT = "2026-07-19T10:00:00.000Z";
const CREDENTIAL = "0EwRHmcuR_-dgDjoaOAoaFBg2M6S0NnnijwnuEZuH7c";

let context: EmbeddedTestContext | null = null;
let layer: AsyncDataLayer | null = null;

function requireLayer(): AsyncDataLayer {
  if (!layer) throw new Error("Room RBAC registry PostgreSQL fixture was not started");
  return layer;
}

function registry(projectId: string) {
  if (!context?.connections) throw new Error("Room RBAC registry PostgreSQL fixture has no connections");
  return createPostgresRoomRbacRegistry(createAsyncDataLayer(context.connections, { projectId }));
}

async function createRoom(projectId: string, roomId: string): Promise<void> {
  await requireLayer().db.insert(operationalRooms).values({
    id: roomId,
    projectId,
    objective: `RBAC durable scope for ${roomId}`,
    protocolId: "implementation",
    protocolVersion: 1,
    protocolPhaseId: null,
    lifecycleState: "ready",
    aggregateVersion: 0,
    taskGraphVersion: 0,
    membershipVersion: 0,
    activeTurnId: null,
    completionContract: {},
    createdAt: ISSUED_AT,
    updatedAt: ISSUED_AT,
  });
}

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-rbac-registry-"));
  const lifecycle = new EmbeddedPostgresLifecycle({
    dataDir,
    database: "fusion",
    user: "postgres",
    password: "password",
  });
  const backend = await lifecycle.start();
  context = {
    dataDir,
    lifecycle,
    connections: await createConnectionSetFromUrl(backend, { poolMax: 4 }),
  };
  await applySchemaBaseline(context.connections.migration, { pluginHooks: [] });
  layer = createAsyncDataLayer(context.connections, {});
}, 60_000);

beforeEach(async () => {
  await requireLayer().db.execute(sql.raw("TRUNCATE TABLE project.room_rbac_authorization_states RESTART IDENTITY CASCADE"));
  await requireLayer().db.execute(sql.raw("TRUNCATE TABLE project.operational_rooms RESTART IDENTITY CASCADE"));
  await createRoom(PROJECT_A, ROOM_A);
  await createRoom(PROJECT_A, ROOM_B);
});

afterAll(async () => {
  const shared = context;
  context = null;
  layer = null;
  if (!shared) return;
  if (shared.connections) {
    await shared.connections.close();
    shared.connections = null;
  }
  await shared.lifecycle.stop();
  rmSync(shared.dataDir, { recursive: true, force: true });
});

describe("Room RBAC registry PostgreSQL adapter", () => {
  it("persists credential digests only and produces a project/Room scoped pure-policy snapshot", async () => {
    const rbac = registry(PROJECT_A);
    await rbac.issueTrustedDeviceSession({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      sessionId: "session-rbac-pg-a",
      principalId: "principal-rbac-pg-a",
      deviceId: "device-rbac-pg-a",
      credential: CREDENTIAL,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      idempotencyKey: "issue-rbac-pg-a",
    });
    await rbac.grantRole({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      grantId: "grant-rbac-project-observer-a",
      principalId: "principal-rbac-pg-a",
      role: "observer",
      roomId: null,
      grantedAt: REQUESTED_AT,
      expectedAuthorizationVersion: 0,
      idempotencyKey: "grant-rbac-project-observer-a",
    });
    await rbac.grantRole({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      grantId: "grant-rbac-room-operator-a",
      principalId: "principal-rbac-pg-a",
      role: "operator",
      roomId: ROOM_A,
      grantedAt: REQUESTED_AT,
      expectedAuthorizationVersion: 1,
      idempotencyKey: "grant-rbac-room-operator-a",
    });

    const stored = await requireLayer().db.select().from(roomTrustedDeviceSessions)
      .where(eq(roomTrustedDeviceSessions.sessionId, "session-rbac-pg-a"));
    expect(stored).toHaveLength(1);
    expect(stored[0]?.credentialDigest).toBe(digestTrustedRoomDeviceCredential(CREDENTIAL));
    expect(JSON.stringify(stored[0])).not.toContain(CREDENTIAL);

    const roomA = await rbac.readAuthorizedSnapshot({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      roomId: ROOM_A,
      credential: CREDENTIAL,
      requestedAt: REQUESTED_AT,
    });
    const roomB = await rbac.readAuthorizedSnapshot({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      roomId: ROOM_B,
      credential: CREDENTIAL,
      requestedAt: REQUESTED_AT,
    });
    if (!roomA.ok || !roomB.ok) throw new Error("Expected durable project/Room snapshots");

    expect(decideRoomRbacAuthorization(toRoomRbacDecisionInput({
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
    }))).toMatchObject({ authorized: true, effectiveRoles: ["operator", "observer"] });
    expect(decideRoomRbacAuthorization(toRoomRbacDecisionInput({
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
    }))).toMatchObject({ authorized: false, reasonCodes: ["role_action_forbidden"] });

    const project = await rbac.readAuthorizedProjectSnapshot({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      credential: CREDENTIAL,
      requestedAt: REQUESTED_AT,
    });
    if (!project.ok) throw new Error("Expected durable project-scoped snapshot");
    expect(project.snapshot.authorizationSnapshot.grants).toMatchObject([
      { grantId: "grant-rbac-project-observer-a", roomId: null, role: "observer" },
    ]);
    expect(decideRoomRbacProjectAuthorization(toRoomRbacProjectDecisionInput({
      snapshot: project.snapshot,
      request: {
        projectId: PROJECT_A,
        action: "list_rooms",
        expectedAuthorizationVersion: 2,
        requestedAt: REQUESTED_AT,
      },
    }))).toMatchObject({ authorized: true, effectiveRoles: ["observer"] });
    expect(decideRoomRbacProjectAuthorization(toRoomRbacProjectDecisionInput({
      snapshot: project.snapshot,
      request: {
        projectId: PROJECT_A,
        action: "create_room",
        expectedAuthorizationVersion: 2,
        requestedAt: REQUESTED_AT,
      },
    }))).toMatchObject({ authorized: false, reasonCodes: ["role_action_forbidden"] });
  });

  it("fails closed across projects and persists revocation/version conflicts", async () => {
    const rbac = registry(PROJECT_A);
    await rbac.issueTrustedDeviceSession({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      sessionId: "session-rbac-pg-a",
      principalId: "principal-rbac-pg-a",
      deviceId: "device-rbac-pg-a",
      credential: CREDENTIAL,
      issuedAt: ISSUED_AT,
      expiresAt: EXPIRES_AT,
      idempotencyKey: "issue-rbac-pg-a",
    });
    await rbac.grantRole({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      grantId: "grant-rbac-project-operator-a",
      principalId: "principal-rbac-pg-a",
      role: "operator",
      roomId: null,
      grantedAt: REQUESTED_AT,
      expectedAuthorizationVersion: 0,
      idempotencyKey: "grant-rbac-project-operator-a",
    });

    await expect(registry(PROJECT_B).readAuthorizedSnapshot({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_B,
      roomId: "room-rbac-pg-b",
      credential: CREDENTIAL,
      requestedAt: REQUESTED_AT,
    })).resolves.toMatchObject({ ok: false, issue: { code: "trusted_device_session_project_scope_denied" } });

    const revoked = await rbac.revokeTrustedDeviceSession({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      sessionId: "session-rbac-pg-a",
      expectedSessionVersion: 1,
      revokedAt: REQUESTED_AT,
      idempotencyKey: "revoke-rbac-pg-a",
    });
    expect(revoked.session).toMatchObject({ revokedAt: REQUESTED_AT, sessionVersion: 2 });
    await expect(rbac.revokeTrustedDeviceSession({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      sessionId: "session-rbac-pg-a",
      expectedSessionVersion: 1,
      revokedAt: "2026-07-19T09:01:00.000Z",
      idempotencyKey: "revoke-rbac-pg-a-conflict",
    })).rejects.toMatchObject({ code: "trusted_device_session_version_conflict" });
    await expect(rbac.readAuthorizedSnapshot({
      contractVersion: ROOM_RBAC_REGISTRY_CONTRACT_VERSION,
      projectId: PROJECT_A,
      roomId: ROOM_A,
      credential: CREDENTIAL,
      requestedAt: REQUESTED_AT,
    })).resolves.toMatchObject({ ok: false, issue: { code: "trusted_device_session_revoked" } });
  });
});

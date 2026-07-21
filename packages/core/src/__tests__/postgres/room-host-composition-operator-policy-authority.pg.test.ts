import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createRoomHostCompositionOperatorPolicyAuthorityStore,
  type RoomHostCompositionOperatorPolicyV1,
} from "../../room-host-composition-operator-policy-authority.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import { projects } from "../../postgres/schema/central.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

const PROJECT_ID = "project-room-composition-authority";
const HOST_ID = "windows-host-room-authority";
const AS_OF = "2026-07-20T00:00:00.000Z";
const EXPIRES_AT = "2026-07-20T00:15:00.000Z";

const POLICY = {
  connectorIds: ["happier-runtime"],
  controllerAdmission: {
    workClass: "normal",
    slots: 1,
  },
  adapterBindings: {
    capabilityObservationAdapterId: "connector-runtime-observation-v1",
    providerAdmissionSnapshotAdapterId: "provider-admission-snapshot-v1",
    capacityTelemetryAdapterId: "capacity-telemetry-v1",
    roomWorkerAuthorityAdapterId: "room-worker-authority-v1",
  },
} as const satisfies RoomHostCompositionOperatorPolicyV1;

let sharedContext: EmbeddedTestContext | null = null;
let sharedLayer: AsyncDataLayer | null = null;
let trustedNow = AS_OF;

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-host-composition-authority-"));
  const lifecycle = new EmbeddedPostgresLifecycle({
    dataDir,
    database: "fusion",
    user: "postgres",
    password: "password",
  });
  const backend = await lifecycle.start();
  const context = {
    dataDir,
    lifecycle,
    connections: await createConnectionSetFromUrl(backend, { poolMax: 4 }),
  } satisfies EmbeddedTestContext;
  await applySchemaBaseline(context.connections.migration, { pluginHooks: [] });
  return context;
}

function requireLayer(): AsyncDataLayer {
  if (!sharedLayer) throw new Error("Room host composition authority PostgreSQL fixture was not started");
  return sharedLayer;
}

function createStore() {
  return createRoomHostCompositionOperatorPolicyAuthorityStore({
    layer: requireLayer(),
    now: () => trustedNow,
  });
}

function installInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    expectedRevision: 0,
    projectId: PROJECT_ID,
    hostId: HOST_ID,
    bundleId: "room-host-composition-bundle-v1",
    issuer: "local-host-operator",
    expiresAt: EXPIRES_AT,
    policy: POLICY,
    ...overrides,
  } as const;
}

beforeAll(async () => {
  sharedContext = await startEmbeddedDatabase();
  sharedLayer = createAsyncDataLayer(sharedContext.connections!, {});
}, 60_000);

beforeEach(async () => {
  trustedNow = AS_OF;
  await requireLayer().db.execute(sql.raw([
    "TRUNCATE TABLE central.room_host_composition_operator_policy_authority RESTART IDENTITY CASCADE",
    "TRUNCATE TABLE central.projects RESTART IDENTITY CASCADE",
  ].join("; ")));
  await requireLayer().db.insert(projects).values({
    id: PROJECT_ID,
    name: "Room composition authority test",
    path: "G:/fusion-test/room-composition-authority",
    createdAt: AS_OF,
    updatedAt: AS_OF,
  });
});

afterAll(async () => {
  const context = sharedContext;
  sharedContext = null;
  sharedLayer = null;
  if (!context) return;
  if (context.connections) {
    await context.connections.close();
    context.connections = null;
  }
  await context.lifecycle.stop();
  rmSync(context.dataDir, { recursive: true, force: true });
});

describe("room host composition operator policy authority", () => {
  it("fails closed until a registered project host explicitly installs one finite policy", async () => {
    await expect(createStore().read({ projectId: PROJECT_ID, hostId: HOST_ID }))
      .rejects.toThrow("not installed");
  });

  it("persists one immutable, scope-bound policy with a hash that covers its authority envelope", async () => {
    const installed = await createStore().install(installInput());
    const loaded = await createStore().read({ projectId: PROJECT_ID, hostId: HOST_ID });

    expect(installed).toMatchObject({
      contractVersion: 1,
      projectId: PROJECT_ID,
      hostId: HOST_ID,
      bundleId: "room-host-composition-bundle-v1",
      issuer: "local-host-operator",
      revision: 1,
      issuedAt: AS_OF,
      updatedAt: AS_OF,
      expiresAt: EXPIRES_AT,
      revokedAt: null,
      revokedReason: null,
      policy: POLICY,
    });
    expect(installed.policyHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(loaded).toEqual(installed);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.policy)).toBe(true);
    expect(Object.isFrozen(loaded.policy.connectorIds)).toBe(true);
    expect(Object.isFrozen(loaded.policy.controllerAdmission)).toBe(true);
    expect(Object.isFrozen(loaded.policy.adapterBindings)).toBe(true);

    await expect(createStore().read({ projectId: PROJECT_ID, hostId: "other-host" }))
      .rejects.toThrow("not installed");
  });

  it("rejects dynamic provider facts and uncanonical connector/adaptor policy before it reaches persistence", async () => {
    await expect(createStore().install(installInput({
      policy: {
        ...POLICY,
        accountId: "must-not-be-policy",
      },
    }))).rejects.toThrow("policy is invalid");
    await expect(createStore().install(installInput({
      policy: {
        ...POLICY,
        connectorIds: ["happier-runtime", "happier-runtime"],
      },
    }))).rejects.toThrow("policy is invalid");
    await expect(createStore().install(installInput({
      policy: {
        ...POLICY,
        adapterBindings: {
          ...POLICY.adapterBindings,
          capacityTelemetryAdapterId: "contains a space",
        },
      },
    }))).rejects.toThrow("policy is invalid");
  });

  it("rejects expired policy at read time without silently extending its authority", async () => {
    await createStore().install(installInput({ expiresAt: "2026-07-20T00:01:00.000Z" }));
    trustedNow = "2026-07-20T00:01:00.000Z";

    await expect(createStore().read({ projectId: PROJECT_ID, hostId: HOST_ID }))
      .rejects.toThrow("expired");
  });

  it("uses compare-and-swap revocation and permits a new bundle only after explicit revocation", async () => {
    await createStore().install(installInput());
    const revoked = await createStore().revoke({
      projectId: PROJECT_ID,
      hostId: HOST_ID,
      expectedRevision: 1,
      reason: "operator_cutover",
    });

    expect(revoked).toMatchObject({
      revision: 2,
      revokedAt: AS_OF,
      revokedReason: "operator_cutover",
    });
    await expect(createStore().read({ projectId: PROJECT_ID, hostId: HOST_ID }))
      .rejects.toThrow("revoked");
    await expect(createStore().install(installInput({ expectedRevision: 1 })))
      .rejects.toThrow("revision is stale");

    const replacement = await createStore().install(installInput({
      expectedRevision: 2,
      bundleId: "room-host-composition-bundle-v2",
      expiresAt: "2026-07-20T01:00:00.000Z",
    }));
    expect(replacement).toMatchObject({
      revision: 3,
      bundleId: "room-host-composition-bundle-v2",
      revokedAt: null,
      revokedReason: null,
    });
    await expect(createStore().read({ projectId: PROJECT_ID, hostId: HOST_ID }))
      .resolves.toEqual(replacement);
  });
});

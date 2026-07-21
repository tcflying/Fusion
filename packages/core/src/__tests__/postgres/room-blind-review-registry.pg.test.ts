import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";

import {
  createPostgresRoomBlindReviewRegistry,
  type ReadRoomBlindReviewPackInputV1,
  type SealRoomBlindReviewMappingInputV1,
} from "../../room-blind-review-registry.js";
import type {
  CreateRoomBlindReviewPackInputV1,
  RoomBlindReviewPackHashV1,
} from "../../room-blind-review-pack.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import {
  operationalRooms,
  roomBlindReviewRegistries,
} from "../../postgres/schema/room.js";
import { hashRoomValue } from "../../room-integrity.js";

const PROJECT_ID = "project-blind-review-registry-pg";
const ROOM_ID = "room-blind-review-registry-pg";
const REVIEW_ID = "review-round-registry-pg-1";
const SEALED_AT = "2026-07-18T12:00:00.000Z";
const EXPIRES_AT = "2026-07-18T12:30:00.000Z";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

interface MutableSealedMapping {
  candidates: Array<{ producerBindingIds: string[] }>;
}

let sharedContext: EmbeddedTestContext | null = null;
let sharedLayer: AsyncDataLayer | null = null;

const hash = (value: string): RoomBlindReviewPackHashV1 => hashRoomValue({ value }) as RoomBlindReviewPackHashV1;

function packInput(): CreateRoomBlindReviewPackInputV1 {
  return {
    contractVersion: 1,
    reviewRoundId: REVIEW_ID,
    sourceSetHash: hash("source-set"),
    createdAt: SEALED_AT,
    reviewers: [{ bindingId: "binding-reviewer" }],
    candidateLineage: [{
      candidateId: "candidate-alpha",
      candidateHash: hash("candidate-alpha"),
      sourceRecordId: "source-alpha",
      sourceHash: hash("source-alpha"),
      artifactHash: hash("artifact-alpha"),
      producerBindingIds: ["binding-producer-alpha"],
    }],
    opaqueBindings: [{
      candidateId: "candidate-alpha",
      opaqueCandidateId: "opaque_candidate_alpha_0001",
    }],
  };
}

function sealInput(
  overrides: Partial<SealRoomBlindReviewMappingInputV1> = {},
): SealRoomBlindReviewMappingInputV1 {
  return {
    contractVersion: 1,
    scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
    idempotencyKey: "seal-blind-review-registry-pg-v1",
    now: SEALED_AT,
    expiresAt: EXPIRES_AT,
    packInput: packInput(),
    ...overrides,
  };
}

function readInput(
  overrides: Partial<ReadRoomBlindReviewPackInputV1> = {},
): ReadRoomBlindReviewPackInputV1 {
  return {
    contractVersion: 1,
    scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
    reviewRoundId: REVIEW_ID,
    reviewerBindingId: "binding-reviewer",
    now: "2026-07-18T12:10:00.000Z",
    ...overrides,
  };
}

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-blind-review-registry-"));
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
  if (!sharedLayer) throw new Error("Blind-review registry PostgreSQL fixture was not started");
  return sharedLayer;
}

function createRegistry() {
  return createPostgresRoomBlindReviewRegistry(requireLayer());
}

async function createRoom(): Promise<void> {
  await requireLayer().db.insert(operationalRooms).values({
    id: ROOM_ID,
    projectId: PROJECT_ID,
    objective: "Persist a sealed blind-review registry",
    protocolId: "creative-review",
    protocolVersion: 1,
    protocolPhaseId: null,
    lifecycleState: "ready",
    aggregateVersion: 0,
    taskGraphVersion: 0,
    membershipVersion: 0,
    activeTurnId: null,
    completionContract: {},
    createdAt: SEALED_AT,
    updatedAt: SEALED_AT,
  });
}

beforeAll(async () => {
  sharedContext = await startEmbeddedDatabase();
  sharedLayer = createAsyncDataLayer(sharedContext.connections!, { projectId: PROJECT_ID });
}, 60_000);

beforeEach(async () => {
  await requireLayer().db.execute(sql.raw("TRUNCATE TABLE project.operational_rooms RESTART IDENTITY CASCADE"));
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
}, 60_000);

describe.sequential("Room blind-review registry PostgreSQL persistence", () => {
  it("persists the sealed mapping while a fresh reader receives only the redacted review pack", async () => {
    await createRoom();
    const writer = createRegistry();
    const sealed = await writer.seal(sealInput());

    const safeRead = await createRegistry().getPackForReviewer(readInput());
    expect(safeRead).toMatchObject({
      reviewRoundId: REVIEW_ID,
      mappingIntegrityHash: sealed.mappingIntegrityHash,
      pack: sealed.pack,
    });
    expect(JSON.stringify(safeRead)).not.toContain("candidate-alpha");
    expect(JSON.stringify(safeRead)).not.toContain("binding-producer-alpha");

    const layer = requireLayer();
    const registryRows = await layer.db
      .select()
      .from(roomBlindReviewRegistries)
      .where(and(
        eq(roomBlindReviewRegistries.projectId, PROJECT_ID),
        eq(roomBlindReviewRegistries.roomId, ROOM_ID),
      ));
    expect(registryRows).toHaveLength(1);
    expect(registryRows[0]).toMatchObject({
      reviewRoundId: REVIEW_ID,
      mappingIntegrityHash: sealed.mappingIntegrityHash,
    });
    expect(JSON.stringify(registryRows[0]?.reviewPack)).not.toContain("candidate-alpha");
    expect(JSON.stringify(registryRows[0]?.sealedMapping)).toContain("candidate-alpha");
    expect(JSON.stringify(registryRows[0]?.sealedMapping)).toContain("binding-producer-alpha");

    await expect(createRegistry().seal(sealInput())).resolves.toMatchObject({ replayed: true });
    await expect(createRegistry().seal(sealInput({ expiresAt: "2026-07-18T12:31:00.000Z" })))
      .rejects.toMatchObject({ code: "idempotency_mismatch" });
  });

  it("detects direct durable-mapping drift before a reviewer pack is released", async () => {
    await createRoom();
    await createRegistry().seal(sealInput());
    const [row] = await requireLayer().db.select().from(roomBlindReviewRegistries);
    if (!row) throw new Error("Blind-review registry fixture was not persisted");
    const tampered = JSON.parse(JSON.stringify(row.sealedMapping)) as MutableSealedMapping;
    const candidate = tampered.candidates[0];
    if (!candidate) throw new Error("Blind-review mapping fixture was missing a candidate");
    candidate.producerBindingIds = ["binding-tampered"];
    await requireLayer().db
      .update(roomBlindReviewRegistries)
      .set({ sealedMapping: tampered })
      .where(eq(roomBlindReviewRegistries.id, row.id));

    await expect(createRegistry().getPackForReviewer(readInput()))
      .rejects.toMatchObject({ code: "mapping_integrity_mismatch" });
  });
});

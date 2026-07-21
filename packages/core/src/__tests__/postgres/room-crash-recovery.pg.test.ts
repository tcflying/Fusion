import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";

import {
  dispatchRoomDelivery,
  reconcileAmbiguousRoomDelivery,
  type RoomDeliveryCoordinatorStore,
} from "../../../../engine/src/room-delivery-coordinator.js";
import { DurableRoomRecoveryWorker } from "../../../../engine/src/room-durable-recovery-worker.js";
import { SessionConnectorRegistry } from "../../../../engine/src/session-connector-registry.js";
import { AsyncRoomCheckpointStore } from "../../async-room-checkpoint-store.js";
import {
  AsyncRoomLeaseStore,
  type StoredRoomLeaseV1,
} from "../../async-room-lease-store.js";
import {
  AsyncRoomStore,
  type EnqueueRoomMessageInput,
} from "../../async-room-store.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import type { ResolvedBackend } from "../../postgres/backend-resolver.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import {
  operationalRooms,
  roomBindings,
  roomOutbox,
  roomSeats,
  roomTurns,
} from "../../postgres/schema/room.js";
import {
  SESSION_CONNECTOR_CAPABILITIES,
  type SessionConnectorCapabilitiesV1,
  type SessionConnectorCapabilityState,
  type SessionConnectorDeepLinksV1,
  type SessionConnectorHealthV1,
  type SessionConnectorHistoryItemV1,
  type SessionConnectorIdentityV1,
  type SessionConnectorResultV1,
  type SessionConnectorSendReceiptV1,
  type SessionConnectorV1,
} from "../../room-contracts/index.js";
import {
  acquireRoomRecoverySenderLease,
  recoverRoomAfterCrash,
  type RecoverRoomAfterCrashInput,
  type ReconcileNativeTakeoverAfterCrashInput,
} from "../../room-delivery-coordinator.js";
import {
  createFileBackedRoomConnectorDouble,
  readFileBackedRoomConnectorState,
} from "./fixtures/file-backed-room-connector.js";

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  readonly backend: ResolvedBackend;
  connections: PostgresConnections | null;
}

interface CrashRoomFixture {
  readonly layer: AsyncDataLayer;
  readonly roomStore: AsyncRoomStore;
  readonly leaseStore: AsyncRoomLeaseStore;
  readonly checkpointStore: AsyncRoomCheckpointStore;
  readonly roomId: string;
  readonly seatId: string;
  readonly bindingId: string;
  readonly messageId: string;
  readonly outboxId: string;
  readonly aggregateVersion: number;
}

interface DeterministicConnectorDouble {
  readonly connector: SessionConnectorV1;
  readonly sendRequests: readonly Parameters<SessionConnectorV1["send"]>[0][];
  readonly historyRequests: readonly Parameters<SessionConnectorV1["readHistory"]>[0][];
  readonly sideEffectCount: number;
  setHistoryUnavailable(unavailable: boolean): void;
}

const PROJECT_ID = "project-room-crash-recovery";
const HOST_ID = "windows-host-crash-recovery";
const CONNECTOR_ID = "deterministic-crash-connector";
const BASE_TIME = "2026-07-17T13:00:00.000Z";
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
let sharedContext: EmbeddedTestContext | null = null;

/*
FNXC:SessionRoomCrashRecovery 2026-07-17-21:19:
Task 4.7 requires deterministic process-crash seams after command commit, after external send but before acknowledgement persistence, after acknowledgement but before projection/checkpoint persistence, and during native takeover reconciliation. Restart must recover from PostgreSQL ledger/outbox/cursors or retain a typed visible uncertain/blocked state; it must never silently lose a committed command, blindly resend an ambiguous delivery, duplicate one idempotency-key side effect, or accept writes from an old lease epoch.

FNXC:SessionRoomCrashRecovery 2026-07-17-21:19:
This suite uses embedded PostgreSQL and an in-process deterministic SessionConnector double. It proves control-plane recovery semantics only and is not live Happier/provider evidence.
*/

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-crash-recovery-"));
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
    backend,
    connections: await createConnectionSetFromUrl(backend, { poolMax: 8 }),
  } satisfies EmbeddedTestContext;
  await applySchemaBaseline(context.connections.migration, { pluginHooks: [] });
  return context;
}

beforeAll(async () => {
  sharedContext = await startEmbeddedDatabase();
});

afterAll(async () => {
  const context = sharedContext;
  sharedContext = null;
  if (!context) return;
  if (context.connections) {
    await context.connections.close();
    context.connections = null;
  }
  await context.lifecycle.stop();
  rmSync(context.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function requireSharedContext(): EmbeddedTestContext & { connections: PostgresConnections } {
  const context = sharedContext;
  if (!context?.connections) throw new Error("embedded PostgreSQL fixture is not running");
  return context as EmbeddedTestContext & { connections: PostgresConnections };
}

function requireBackendRuntimeUrl(backend: ResolvedBackend): string {
  if (!backend.runtimeUrl?.trim()) {
    throw new Error("EmbeddedPostgresLifecycle.start() did not provide a runtimeUrl for cross-process recovery");
  }
  return backend.runtimeUrl;
}

function commandContext(eventId: string, occurredAt: string) {
  return {
    eventId,
    actorType: "controller" as const,
    actorId: "room-controller-crash-test",
    correlationId: `correlation-${eventId}`,
    causationId: null,
    occurredAt,
  };
}

async function createCrashRoomFixture(suffix: string): Promise<CrashRoomFixture> {
  const context = requireSharedContext();
  const layer = createAsyncDataLayer(context.connections, { projectId: PROJECT_ID });
  const roomStore = new AsyncRoomStore(layer);
  const leaseStore = new AsyncRoomLeaseStore(layer);
  const checkpointStore = new AsyncRoomCheckpointStore(layer);
  const roomId = `room-crash-${suffix}`;
  const seatId = `seat-crash-${suffix}`;
  const bindingId = `binding-crash-${suffix}`;
  const messageId = `message-crash-${suffix}`;
  const outboxId = `outbox-crash-${suffix}`;

  const created = await roomStore.createRoom(
    {
      id: roomId,
      projectId: PROJECT_ID,
      objective: `Recover ${suffix} without loss or duplicate side effects`,
      protocolId: "implementation",
      protocolVersion: 1,
      now: BASE_TIME,
    },
    commandContext(`event-created-${suffix}`, BASE_TIME),
  );
  const ready = await roomStore.transitionLifecycle(
    roomId,
    {
      to: "ready",
      expectedAggregateVersion: created.room.aggregateVersion,
      now: "2026-07-17T13:00:01.000Z",
    },
    commandContext(`event-ready-${suffix}`, "2026-07-17T13:00:01.000Z"),
  );
  const running = await roomStore.transitionLifecycle(
    roomId,
    {
      to: "running",
      expectedAggregateVersion: ready.room.aggregateVersion,
      now: "2026-07-17T13:00:02.000Z",
    },
    commandContext(`event-running-${suffix}`, "2026-07-17T13:00:02.000Z"),
  );
  await layer.db.insert(roomSeats).values({
    id: seatId,
    projectId: PROJECT_ID,
    roomId,
    role: "producer",
    roleVersion: 1,
    roleHistory: [],
    permissionScope: ["session:send"],
    state: "active",
    activeBindingId: bindingId,
    createdAt: BASE_TIME,
    updatedAt: BASE_TIME,
  });
  await layer.db.insert(roomBindings).values({
    id: bindingId,
    projectId: PROJECT_ID,
    roomId,
    seatId,
    generation: 1,
    connectorId: CONNECTOR_ID,
    providerId: "codex",
    nativeSessionId: `codex-thread-${suffix}`,
    happierSessionId: `happier-session-${suffix}`,
    serverProfileId: "server-profile-crash-recovery",
    machineId: "machine-crash-recovery",
    hostId: HOST_ID,
    state: "attached",
    attachedAt: BASE_TIME,
  });

  return {
    layer,
    roomStore,
    leaseStore,
    checkpointStore,
    roomId,
    seatId,
    bindingId,
    messageId,
    outboxId,
    aggregateVersion: running.room.aggregateVersion,
  };
}

async function createTurnCheckpoint(
  fixture: CrashRoomFixture,
  suffix: string,
  options: {
    readonly aggregateVersion?: number;
    readonly bindingCursors?: Readonly<Record<string, string | null>>;
    readonly now?: string;
  } = {},
) {
  const turnId = `turn-crash-${suffix}`;
  const checkpointId = `checkpoint-before-crash-${suffix}`;
  const checkpointNow = options.now ?? "2026-07-17T13:20:01.000Z";
  await fixture.layer.db.insert(roomTurns).values({
    id: turnId,
    projectId: PROJECT_ID,
    roomId: fixture.roomId,
    sequence: 1,
    protocolPhaseId: "implementation.dispatch",
    membershipVersion: 0,
    state: "waiting",
    startedAt: "2026-07-17T13:20:00.000Z",
    endedAt: null,
  });
  await fixture.layer.db
    .update(operationalRooms)
    .set({ activeTurnId: turnId })
    .where(and(
      eq(operationalRooms.projectId, PROJECT_ID),
      eq(operationalRooms.id, fixture.roomId),
    ));
  return fixture.checkpointStore.createCheckpoint({
    id: checkpointId,
    roomId: fixture.roomId,
    turnId,
    expectedAggregateVersion: options.aggregateVersion ?? fixture.aggregateVersion,
    protocolState: { phaseId: "implementation.dispatch" },
    dagVersion: 0,
    bindingCursors: options.bindingCursors ?? { [fixture.bindingId]: null },
    artifactRefs: [],
    now: checkpointNow,
  });
}

function connectorCapabilities(): SessionConnectorCapabilitiesV1 {
  const capabilities = Object.fromEntries(
    SESSION_CONNECTOR_CAPABILITIES.map((name) => {
      const state: SessionConnectorCapabilityState = "verified";
      return [name, {
        state,
        evidenceRef: `deterministic-crash-connector://${name}`,
        reasonCode: null,
        lastVerifiedAt: BASE_TIME,
      }];
    }),
  ) as SessionConnectorCapabilitiesV1["capabilities"];
  return {
    contractVersion: 1,
    connectorId: CONNECTOR_ID,
    connectorVersion: "deterministic-crash-double-v1",
    sourceRevision: "test-double-not-live-provider",
    verifiedAt: BASE_TIME,
    capabilities,
  };
}

function connectorHealthCapabilities(): SessionConnectorHealthV1["capabilities"] {
  return Object.fromEntries(
    SESSION_CONNECTOR_CAPABILITIES.map((name) => [name, "verified"]),
  ) as SessionConnectorHealthV1["capabilities"];
}

function ok<T>(value: T): SessionConnectorResultV1<T> {
  return { ok: true, value };
}

function unavailable(message: string): SessionConnectorResultV1<never> {
  return {
    ok: false,
    error: { code: "unavailable", message, retryable: false },
  };
}

function createDeterministicConnectorDouble(): DeterministicConnectorDouble {
  const sendRequests: Parameters<SessionConnectorV1["send"]>[0][] = [];
  const historyRequests: Parameters<SessionConnectorV1["readHistory"]>[0][] = [];
  const acceptedByLocalMessageId = new Map<string, SessionConnectorHistoryItemV1>();
  let sideEffectCount = 0;
  let historyUnavailable = false;

  const connector: SessionConnectorV1 = {
    contractVersion: 1,
    id: CONNECTOR_ID,
    version: "deterministic-crash-double-v1",
    getCapabilities: vi.fn(async () => connectorCapabilities()),
    ensureExisting: vi.fn(async () => unavailable("not used by crash recovery")),
    create: vi.fn(async () => unavailable("not used by crash recovery")),
    getStatus: vi.fn(async (identity) => ok({
      identity,
      state: "idle",
      lastActivityAt: BASE_TIME,
      connectorCursor: null,
      nativeWriterDetected: false,
    })),
    readHistory: vi.fn(async (input) => {
      historyRequests.push(input);
      if (historyUnavailable) {
        return {
          ok: false,
          error: {
            code: "host_unavailable",
            message: "deterministic native history outage",
            retryable: true,
          },
        };
      }
      const items = [...acceptedByLocalMessageId.values()].filter((item) =>
        input.afterCursor === null || item.cursor !== input.afterCursor
      );
      const nextCursor = items.at(-1)?.cursor ?? input.afterCursor;
      return ok({
        items,
        nextCursor,
        completeThroughCursor: nextCursor,
        truncated: false,
      });
    }),
    subscribeEvents: vi.fn(async () => unavailable("not used by crash recovery")),
    send: vi.fn(async (input) => {
      sendRequests.push(input);
      let accepted = acceptedByLocalMessageId.get(input.localMessageId);
      if (!accepted) {
        sideEffectCount += 1;
        accepted = {
          nativeMessageId: `native-${input.localMessageId}`,
          logicalMessageId: input.localMessageId,
          role: "user",
          contentHash: input.contentHash,
          occurredAt: BASE_TIME,
          cursor: `cursor-${input.localMessageId}`,
        };
        acceptedByLocalMessageId.set(input.localMessageId, accepted);
      }
      return ok<SessionConnectorSendReceiptV1>({
        outcome: "confirmed",
        connectorAcknowledgementId: `ack-${input.localMessageId}`,
        nativeMessageId: accepted.nativeMessageId,
        cursor: accepted.cursor,
        acceptedAt: BASE_TIME,
      });
    }),
    interrupt: vi.fn(async () => unavailable("not used by crash recovery")),
    resume: vi.fn(async () => unavailable("not used by crash recovery")),
    takeover: vi.fn(async () => unavailable("not used by crash recovery")),
    getHealth: vi.fn(async (hostId) => ({
      connectorId: CONNECTOR_ID,
      hostId,
      state: "healthy",
      checkedAt: BASE_TIME,
      authentication: "authenticated",
      daemon: "running",
      server: "reachable",
      backend: "ready",
      rateLimit: "clear",
      host: "reachable",
      capabilities: connectorHealthCapabilities(),
      reasonCodes: [],
      retryAfterMs: null,
    })),
    getDeepLinks: vi.fn(async (input) => ok<SessionConnectorDeepLinksV1>({
      contractVersion: 1,
      bindingId: input.bindingId,
      ...input.identity,
      happierUrl: null,
      nativeSessionUrl: null,
    })),
  };

  return {
    connector,
    sendRequests,
    historyRequests,
    get sideEffectCount() {
      return sideEffectCount;
    },
    setHistoryUnavailable(unavailable: boolean) {
      historyUnavailable = unavailable;
    },
  };
}

function createRegistry(connector: SessionConnectorV1): SessionConnectorRegistry {
  const registry = new SessionConnectorRegistry({ now: () => Date.parse(BASE_TIME) });
  registry.register(connector);
  return registry;
}

function createFileBackedRegistry(stateFilePath: string, checkedAt = BASE_TIME): SessionConnectorRegistry {
  const registry = new SessionConnectorRegistry({ now: () => Date.parse(checkedAt) });
  registry.register(createFileBackedRoomConnectorDouble({
    connectorId: CONNECTOR_ID,
    stateFilePath,
    checkedAt,
  }));
  return registry;
}

async function acquireWorkerAndSenderLeases(input: {
  readonly fixture: CrashRoomFixture;
  readonly holderSuffix: string;
  readonly expectedEpoch: number | null;
  readonly now: string;
  readonly expiresAt: string;
}) {
  const roomWorker = await input.fixture.leaseStore.acquireLease({
    leaseId: `lease-room-worker-${input.holderSuffix}`,
    roomId: input.fixture.roomId,
    kind: "room_worker",
    resourceId: input.fixture.roomId,
    holderId: `room-worker-${input.holderSuffix}`,
    hostId: HOST_ID,
    expectedEpoch: input.expectedEpoch,
    now: input.now,
    expiresAt: input.expiresAt,
  });
  const sender = await input.fixture.leaseStore.acquireLease({
    leaseId: `lease-sender-${input.holderSuffix}`,
    roomId: input.fixture.roomId,
    kind: "sender",
    resourceId: input.fixture.bindingId,
    holderId: `room-worker-${input.holderSuffix}`,
    hostId: HOST_ID,
    expectedEpoch: input.expectedEpoch,
    now: input.now,
    expiresAt: input.expiresAt,
  });
  expect(roomWorker).toMatchObject({ ok: true });
  expect(sender).toMatchObject({ ok: true });
  if (!roomWorker.ok || !sender.ok) throw new Error("crash recovery leases were not acquired");
  return { roomWorker: roomWorker.lease, sender: sender.lease };
}

async function acquireRecoveryRoomWorkerLease(input: {
  readonly fixture: CrashRoomFixture;
  readonly holderSuffix: string;
  readonly expectedEpoch: number | null;
  readonly now: string;
  readonly expiresAt: string;
}): Promise<StoredRoomLeaseV1> {
  const roomWorker = await input.fixture.leaseStore.acquireLease({
    leaseId: `lease-room-worker-${input.holderSuffix}`,
    roomId: input.fixture.roomId,
    kind: "room_worker",
    resourceId: input.fixture.roomId,
    holderId: `room-worker-${input.holderSuffix}`,
    hostId: HOST_ID,
    expectedEpoch: input.expectedEpoch,
    now: input.now,
    expiresAt: input.expiresAt,
  });
  expect(roomWorker).toMatchObject({ ok: true });
  if (!roomWorker.ok) throw new Error("crash recovery Room-worker lease was not acquired");
  return roomWorker.lease;
}

function enqueueInput(
  fixture: CrashRoomFixture,
  createdAt = "2026-07-17T13:00:10.000Z",
): EnqueueRoomMessageInput {
  return {
    roomId: fixture.roomId,
    expectedAggregateVersion: fixture.aggregateVersion,
    idempotencyKey: `crash-recovery:${fixture.messageId}`,
    message: {
      id: fixture.messageId,
      turnId: null,
      nodeId: null,
      originType: "controller",
      originId: "room-controller-crash-test",
      targetSeatIds: [fixture.seatId],
      intent: "instruction",
      content: `Deliver ${fixture.messageId} exactly once across restart.`,
      authorityEnvelope: { allowedActions: ["session:send"] },
      createdAt,
    },
    deliveries: [{ id: fixture.outboxId, bindingId: fixture.bindingId }],
  };
}

function connectorIdentity(fixture: CrashRoomFixture): SessionConnectorIdentityV1 {
  return {
    connectorId: CONNECTOR_ID,
    providerId: "codex",
    nativeSessionId: `codex-thread-${fixture.roomId.replace("room-crash-", "")}`,
    happierSessionId: `happier-session-${fixture.roomId.replace("room-crash-", "")}`,
    serverProfileId: "server-profile-crash-recovery",
    machineId: "machine-crash-recovery",
    hostId: HOST_ID,
  };
}

function senderFence(lease: StoredRoomLeaseV1) {
  if (lease.kind !== "sender") throw new Error(`Lease ${lease.id} is not a sender lease`);
  return {
    leaseId: lease.id,
    roomId: lease.roomId,
    kind: "sender" as const,
    resourceId: lease.resourceId,
    holderId: lease.holderId,
    hostId: lease.hostId,
    expectedEpoch: lease.epoch,
  };
}

function crashBeforeDeliveryCompletion(
  store: AsyncRoomStore,
  point: "after_external_send_before_ack",
): RoomDeliveryCoordinatorStore {
  return {
    getDelivery: (outboxId) => store.getDelivery(outboxId),
    getBinding: (bindingId) => store.getBinding(bindingId),
    beginDeliveryAttempt: (input) => store.beginDeliveryAttempt(input),
    completeDeliveryAttempt: async () => {
      throw new Error(`injected_process_crash:${point}`);
    },
    reconcileDelivery: (input) => store.reconcileDelivery(input),
  };
}

function recoveryInput(
  fixture: CrashRoomFixture,
  connectorRegistry: SessionConnectorRegistry,
  roomWorkerLease: StoredRoomLeaseV1,
  senderLease: StoredRoomLeaseV1 | null,
  now: string,
  nativeTakeover?: ReconcileNativeTakeoverAfterCrashInput,
): RecoverRoomAfterCrashInput {
  return {
    projectId: PROJECT_ID,
    roomId: fixture.roomId,
    workerId: roomWorkerLease.holderId,
    hostId: HOST_ID,
    layer: fixture.layer,
    roomStore: fixture.roomStore,
    leaseStore: fixture.leaseStore,
    checkpointStore: fixture.checkpointStore,
    deliveryCoordinator: {
      dispatch: (input) => dispatchRoomDelivery({ ...input, registry: connectorRegistry }),
      reconcile: (input) => reconcileAmbiguousRoomDelivery({
        ...input,
        registry: connectorRegistry,
      }),
    },
    roomWorkerLease,
    senderLease,
    historyPageSize: 50,
    maxHistoryPages: 2,
    now,
    audit: {
      runId: `recovery:${fixture.roomId}:${roomWorkerLease.epoch}`,
      agentId: roomWorkerLease.holderId,
    },
    nativeTakeover,
  };
}

async function waitForFile(filePath: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for file ${filePath}`);
}

function killWindowsProcess(child: ChildProcessWithoutNullStreams): void {
  if (!child.pid) throw new Error("child process never exposed a PID");
  const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
    windowsHide: true,
    encoding: "utf8",
  });
  if (result.status !== 0 && child.exitCode === null) {
    throw new Error(result.stderr || `taskkill exited ${result.status}`);
  }
}

function spawnExternalSendCrashChild(input: {
  readonly backendUrl: string;
  readonly roomId: string;
  readonly bindingId: string;
  readonly outboxId: string;
  readonly content: string;
  readonly stateFilePath: string;
  readonly markerFilePath: string;
}): ChildProcessWithoutNullStreams {
  /*
  FNXC:SessionRoomCrashRecovery 2026-07-18-09:05:
  The Windows crash child must launch from whichever checkout owns this test;
  derive the repository root from the module URL so drive letters, users, and
  worktree names remain portable.
  */
  const scriptPath = join(
    REPOSITORY_ROOT,
    "packages",
    "engine",
    "src",
    "__tests__",
    "fixtures",
    "room-crash-external-send-child.ts",
  );
  return spawn(
    process.execPath,
    ["--import", "tsx", scriptPath],
    {
      cwd: REPOSITORY_ROOT,
      stdio: "pipe",
      windowsHide: true,
      env: {
        ...process.env,
        FUSION_ROOM_CRASH_DB_URL: input.backendUrl,
        FUSION_ROOM_CRASH_PROJECT_ID: PROJECT_ID,
        FUSION_ROOM_CRASH_ROOM_ID: input.roomId,
        FUSION_ROOM_CRASH_BINDING_ID: input.bindingId,
        FUSION_ROOM_CRASH_OUTBOX_ID: input.outboxId,
        FUSION_ROOM_CRASH_CONTENT: input.content,
        FUSION_ROOM_CRASH_CONNECTOR_ID: CONNECTOR_ID,
        FUSION_ROOM_CRASH_STATE_FILE: input.stateFilePath,
        FUSION_ROOM_CRASH_MARKER_FILE: input.markerFilePath,
        FUSION_ROOM_CRASH_HOST_ID: HOST_ID,
        FUSION_ROOM_CRASH_NOW: "2026-07-17T14:12:00.000Z",
        FUSION_ROOM_CRASH_EXPIRES_AT: "2026-07-17T14:13:00.000Z",
      },
    },
  );
}

describe("Session Room PostgreSQL crash recovery", () => {
  it("serializes production recovery sender ownership without stealing an active epoch", async () => {
    const fixture = await createCrashRoomFixture("production-sender-acquisition");
    const first = await acquireRoomRecoverySenderLease({
      projectId: PROJECT_ID,
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      workerId: "room-worker-production-first",
      hostId: HOST_ID,
      leaseId: "lease-sender-production-first",
      layer: fixture.layer,
      leaseStore: fixture.leaseStore,
      now: "2026-07-17T12:50:00.000Z",
      expiresAt: "2026-07-17T12:51:00.000Z",
    });
    expect(first).toMatchObject({ id: "lease-sender-production-first", epoch: 1 });

    const sameOwner = await acquireRoomRecoverySenderLease({
      projectId: PROJECT_ID,
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      workerId: "room-worker-production-first",
      hostId: HOST_ID,
      leaseId: "lease-sender-production-first-duplicate",
      layer: fixture.layer,
      leaseStore: fixture.leaseStore,
      now: "2026-07-17T12:50:01.000Z",
      expiresAt: "2026-07-17T12:51:01.000Z",
    });
    expect(sameOwner).toEqual(first);

    const competingOwner = await acquireRoomRecoverySenderLease({
      projectId: PROJECT_ID,
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      workerId: "room-worker-production-competing",
      hostId: HOST_ID,
      leaseId: "lease-sender-production-competing",
      layer: fixture.layer,
      leaseStore: fixture.leaseStore,
      now: "2026-07-17T12:50:02.000Z",
      expiresAt: "2026-07-17T12:51:02.000Z",
    });
    expect(competingOwner).toBeNull();

    if (!first) throw new Error("production sender lease was not acquired");
    await fixture.leaseStore.releaseLease({
      leaseId: first.id,
      roomId: first.roomId,
      kind: "sender",
      resourceId: first.resourceId,
      holderId: first.holderId,
      hostId: first.hostId,
      expectedEpoch: first.epoch,
      now: "2026-07-17T12:50:03.000Z",
    });
    const successor = await acquireRoomRecoverySenderLease({
      projectId: PROJECT_ID,
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      workerId: "room-worker-production-successor",
      hostId: HOST_ID,
      leaseId: "lease-sender-production-successor",
      layer: fixture.layer,
      leaseStore: fixture.leaseStore,
      now: "2026-07-17T12:50:04.000Z",
      expiresAt: "2026-07-17T12:51:04.000Z",
    });
    expect(successor).toMatchObject({
      id: "lease-sender-production-successor",
      epoch: 2,
    });
  });

  it("runs the production durable worker through PostgreSQL pending delivery recovery", async () => {
    const fixture = await createCrashRoomFixture("production-worker");
    const queued = await fixture.roomStore.enqueueMessage(
      enqueueInput(fixture, "2026-07-17T13:35:01.000Z"),
      commandContext("event-production-worker-queued", "2026-07-17T13:35:01.000Z"),
    );
    const roomWorker = await fixture.leaseStore.acquireLease({
      leaseId: "lease-room-worker-production",
      roomId: fixture.roomId,
      kind: "room_worker",
      resourceId: fixture.roomId,
      holderId: "room-worker-production",
      hostId: HOST_ID,
      expectedEpoch: null,
      now: "2026-07-17T13:35:02.000Z",
      expiresAt: "2026-07-17T13:36:00.000Z",
    });
    expect(roomWorker).toMatchObject({ ok: true });
    if (!roomWorker.ok) throw new Error("production Room worker lease was not acquired");

    const abortController = new AbortController();
    const connector = createDeterministicConnectorDouble();
    const connectorWithAbort: SessionConnectorV1 = {
      ...connector.connector,
      send: async (input) => {
        const receipt = await connector.connector.send(input);
        abortController.abort();
        return receipt;
      },
    };
    const worker = new DurableRoomRecoveryWorker({
      projectId: PROJECT_ID,
      workerId: roomWorker.lease.holderId,
      hostId: HOST_ID,
      layer: fixture.layer,
      roomStore: fixture.roomStore,
      leaseStore: fixture.leaseStore,
      checkpointStore: fixture.checkpointStore,
      registry: createRegistry(connectorWithAbort),
      now: () => "2026-07-17T13:35:03.000Z",
      createSenderLeaseId: () => "lease-sender-production-worker",
    });
    const aggregate = await fixture.roomStore.getRoom(fixture.roomId);
    if (!aggregate) throw new Error("production worker Room projection is missing");

    await worker.runRoom({
      room: aggregate,
      lease: roomWorker.lease,
      signal: abortController.signal,
      assertAuthority: () => fixture.roomStore.assertWorkerAuthority({
        roomId: fixture.roomId,
        lease: roomWorker.lease,
        expectedAggregateVersion: aggregate.room.aggregateVersion,
        now: "2026-07-17T13:35:03.000Z",
      }),
      assertLeaseAuthority: async () => roomWorker.lease,
    });

    expect(await fixture.roomStore.getDelivery(fixture.outboxId)).toMatchObject({
      id: queued.deliveries[0]?.id,
      state: "confirmed",
      attemptCount: 1,
    });
    expect(connector.sendRequests).toHaveLength(1);
    expect(connector.sideEffectCount).toBe(1);
    const successor = await fixture.leaseStore.acquireLease({
      leaseId: "lease-sender-production-worker-successor",
      roomId: fixture.roomId,
      kind: "sender",
      resourceId: fixture.bindingId,
      holderId: "room-worker-production-successor",
      hostId: HOST_ID,
      expectedEpoch: 1,
      now: "2026-07-17T13:35:04.000Z",
      expiresAt: "2026-07-17T13:36:04.000Z",
    });
    expect(successor).toMatchObject({ ok: true, lease: { epoch: 2 } });
  });

  it("keeps a future retry pending without failing recovery and dispatches it once the durable window opens", async () => {
    const fixture = await createCrashRoomFixture("future-retry-window");
    const connector = createDeterministicConnectorDouble();
    const leases = await acquireWorkerAndSenderLeases({
      fixture,
      holderSuffix: "future-retry-window",
      expectedEpoch: null,
      now: "2026-07-17T13:50:00.000Z",
      expiresAt: "2026-07-17T13:55:00.000Z",
    });
    const queued = await fixture.roomStore.enqueueMessage(
      enqueueInput(fixture, "2026-07-17T13:50:01.000Z"),
      commandContext("event-future-retry-window", "2026-07-17T13:50:01.000Z"),
    );
    await fixture.roomStore.beginDeliveryAttempt({
      outboxId: fixture.outboxId,
      attemptId: "attempt-future-retry-window-1",
      senderFence: senderFence(leases.sender),
      reconciliationFromCursor: null,
      now: "2026-07-17T13:50:02.000Z",
    });
    await fixture.roomStore.completeDeliveryAttempt({
      outboxId: fixture.outboxId,
      attemptId: "attempt-future-retry-window-1",
      senderFence: senderFence(leases.sender),
      outcome: "retryable_failure",
      connectorAcknowledgementId: null,
      nativeMessageId: null,
      nativeCursor: null,
      errorCode: "connector_temporarily_unavailable",
      nextAttemptAt: "2026-07-17T13:50:30.000Z",
      now: "2026-07-17T13:50:03.000Z",
      audit: { runId: "run-future-retry-window-1", agentId: leases.roomWorker.holderId },
    });
    const registry = createRegistry(connector.connector);

    const beforeDue = await recoverRoomAfterCrash(recoveryInput(
      fixture,
      registry,
      leases.roomWorker,
      leases.sender,
      "2026-07-17T13:50:10.000Z",
    ));
    expect(beforeDue.deliveries).toEqual([
      expect.objectContaining({
        id: queued.deliveries[0]?.id,
        state: "pending",
        attemptCount: 1,
        nextAttemptAt: "2026-07-17T13:50:30.000Z",
      }),
    ]);
    expect(connector.sendRequests).toHaveLength(0);

    const afterDue = await recoverRoomAfterCrash(recoveryInput(
      fixture,
      registry,
      leases.roomWorker,
      leases.sender,
      "2026-07-17T13:50:31.000Z",
    ));
    expect(afterDue.deliveries).toEqual([
      expect.objectContaining({
        id: queued.deliveries[0]?.id,
        state: "confirmed",
        attemptCount: 2,
      }),
    ]);
    expect(connector.sendRequests).toHaveLength(1);
    expect(connector.sideEffectCount).toBe(1);
  });

  it("keeps later pending deliveries visible without failing while an earlier sibling remains uncertain", async () => {
    const fixture = await createCrashRoomFixture("uncertain-sibling-block");
    const connector = createDeterministicConnectorDouble();
    connector.setHistoryUnavailable(true);
    const leases = await acquireWorkerAndSenderLeases({
      fixture,
      holderSuffix: "uncertain-sibling-block",
      expectedEpoch: null,
      now: "2026-07-17T13:56:00.000Z",
      expiresAt: "2026-07-17T14:01:00.000Z",
    });
    await fixture.roomStore.enqueueMessage(
      enqueueInput(fixture, "2026-07-17T13:56:01.000Z"),
      commandContext("event-uncertain-sibling-block-1", "2026-07-17T13:56:01.000Z"),
    );
    await fixture.roomStore.beginDeliveryAttempt({
      outboxId: fixture.outboxId,
      attemptId: "attempt-uncertain-sibling-block-1",
      senderFence: senderFence(leases.sender),
      reconciliationFromCursor: "cursor-before-uncertain-sibling",
      now: "2026-07-17T13:56:02.000Z",
    });
    await fixture.roomStore.completeDeliveryAttempt({
      outboxId: fixture.outboxId,
      attemptId: "attempt-uncertain-sibling-block-1",
      senderFence: senderFence(leases.sender),
      outcome: "delivery_uncertain",
      connectorAcknowledgementId: null,
      nativeMessageId: null,
      nativeCursor: null,
      errorCode: "ack_timeout",
      nextAttemptAt: null,
      now: "2026-07-17T13:56:03.000Z",
      audit: { runId: "run-uncertain-sibling-block-1", agentId: leases.roomWorker.holderId },
    });
    const current = await fixture.roomStore.getRoom(fixture.roomId);
    if (!current) throw new Error("uncertain sibling Room projection is missing");
    const secondOutboxId = `${fixture.outboxId}-2`;
    await fixture.roomStore.enqueueMessage(
      {
        roomId: fixture.roomId,
        expectedAggregateVersion: current.room.aggregateVersion,
        idempotencyKey: `${fixture.messageId}:uncertain-sibling-2`,
        message: {
          id: `${fixture.messageId}-2`,
          turnId: null,
          nodeId: null,
          originType: "controller",
          originId: "room-controller-crash-test",
          targetSeatIds: [fixture.seatId],
          intent: "instruction",
          content: "Remain pending until the earlier uncertain sibling is reconciled.",
          authorityEnvelope: { allowedActions: ["session:send"] },
          createdAt: "2026-07-17T13:56:04.000Z",
        },
        deliveries: [{ id: secondOutboxId, bindingId: fixture.bindingId }],
      },
      commandContext("event-uncertain-sibling-block-2", "2026-07-17T13:56:04.000Z"),
    );
    const registry = createRegistry(connector.connector);
    const input = recoveryInput(
      fixture,
      registry,
      leases.roomWorker,
      leases.sender,
      "2026-07-17T13:56:05.000Z",
    );

    for (const suffix of ["first", "second"] as const) {
      const recovered = await recoverRoomAfterCrash({
        ...input,
        audit: { ...input.audit, runId: `${input.audit.runId}:${suffix}` },
      });
      expect(recovered.deliveries).toEqual([
        expect.objectContaining({ id: fixture.outboxId, state: "delivery_uncertain" }),
        expect.objectContaining({ id: secondOutboxId, state: "pending", attemptCount: 0 }),
      ]);
    }
    expect(connector.sendRequests).toHaveLength(0);
    expect(await fixture.roomStore.getDelivery(secondOutboxId)).toMatchObject({
      state: "pending",
      attemptCount: 0,
    });
  });

  it("stops the same recovery pass after a newly dispatched sibling becomes uncertain", async () => {
    const fixture = await createCrashRoomFixture("new-uncertain-sibling-block");
    const connector = createDeterministicConnectorDouble();
    const leases = await acquireWorkerAndSenderLeases({
      fixture,
      holderSuffix: "new-uncertain-sibling-block",
      expectedEpoch: null,
      now: "2026-07-17T13:57:00.000Z",
      expiresAt: "2026-07-17T14:02:00.000Z",
    });
    await fixture.roomStore.enqueueMessage(
      enqueueInput(fixture, "2026-07-17T13:57:01.000Z"),
      commandContext("event-new-uncertain-sibling-block-1", "2026-07-17T13:57:01.000Z"),
    );
    const current = await fixture.roomStore.getRoom(fixture.roomId);
    if (!current) throw new Error("new uncertain sibling Room projection is missing");
    const secondOutboxId = `${fixture.outboxId}-2`;
    await fixture.roomStore.enqueueMessage(
      {
        roomId: fixture.roomId,
        expectedAggregateVersion: current.room.aggregateVersion,
        idempotencyKey: `${fixture.messageId}:new-uncertain-sibling-2`,
        message: {
          id: `${fixture.messageId}-2`,
          turnId: null,
          nodeId: null,
          originType: "controller",
          originId: "room-controller-crash-test",
          targetSeatIds: [fixture.seatId],
          intent: "instruction",
          content: "Do not dispatch after the earlier sibling becomes uncertain in this pass.",
          authorityEnvelope: { allowedActions: ["session:send"] },
          createdAt: "2026-07-17T13:57:02.000Z",
        },
        deliveries: [{ id: secondOutboxId, bindingId: fixture.bindingId }],
      },
      commandContext("event-new-uncertain-sibling-block-2", "2026-07-17T13:57:02.000Z"),
    );
    vi.mocked(connector.connector.send).mockResolvedValueOnce(
      unavailable("provider acknowledgement was lost after send started"),
    );
    const recovered = await recoverRoomAfterCrash(recoveryInput(
      fixture,
      createRegistry(connector.connector),
      leases.roomWorker,
      leases.sender,
      "2026-07-17T13:57:03.000Z",
    ));

    expect(recovered.deliveries).toEqual([
      expect.objectContaining({ id: fixture.outboxId, state: "delivery_uncertain" }),
      expect.objectContaining({ id: secondOutboxId, state: "pending", attemptCount: 0 }),
    ]);
    expect(connector.connector.send).toHaveBeenCalledTimes(1);
    expect(await fixture.roomStore.getDelivery(secondOutboxId)).toMatchObject({
      state: "pending",
      attemptCount: 0,
    });
  });

  it("recovers a committed command after a crash before connector dispatch without duplicate side effects", async () => {
    const fixture = await createCrashRoomFixture("after-command-commit");
    const connector = createDeterministicConnectorDouble();
    const firstLeases = await acquireWorkerAndSenderLeases({
      fixture,
      holderSuffix: "command-first",
      expectedEpoch: null,
      now: "2026-07-17T13:00:05.000Z",
      expiresAt: "2026-07-17T13:01:00.000Z",
    });
    const command = enqueueInput(fixture);
    await fixture.roomStore.enqueueMessage(
      command,
      commandContext("event-after-command-commit", command.message.createdAt),
    );
    expect(await fixture.roomStore.getDelivery(fixture.outboxId)).toMatchObject({
      state: "pending",
      attemptCount: 0,
    });
    expect(connector.sendRequests).toHaveLength(0);
    expect(connector.sideEffectCount).toBe(0);

    const restartedRoomStore = new AsyncRoomStore(fixture.layer);
    const restartedLeaseStore = new AsyncRoomLeaseStore(fixture.layer);
    const restartedCheckpointStore = new AsyncRoomCheckpointStore(fixture.layer);
    const restartedFixture = {
      ...fixture,
      roomStore: restartedRoomStore,
      leaseStore: restartedLeaseStore,
      checkpointStore: restartedCheckpointStore,
    };
    const takeoverLeases = await acquireWorkerAndSenderLeases({
      fixture: restartedFixture,
      holderSuffix: "command-restart",
      expectedEpoch: 1,
      now: "2026-07-17T13:02:00.000Z",
      expiresAt: "2026-07-17T13:04:00.000Z",
    });
    expect(takeoverLeases.roomWorker.epoch).toBe(2);
    expect(takeoverLeases.sender.epoch).toBe(2);
    const registry = createRegistry(connector.connector);
    const recovered = await recoverRoomAfterCrash(recoveryInput(
      restartedFixture,
      registry,
      takeoverLeases.roomWorker,
      takeoverLeases.sender,
      "2026-07-17T13:02:01.000Z",
    ));
    expect(recovered.deliveries).toEqual([
      expect.objectContaining({ id: fixture.outboxId, state: "confirmed", attemptCount: 1 }),
    ]);
    expect(await restartedRoomStore.getDelivery(fixture.outboxId)).toMatchObject({
      state: "confirmed",
      attemptCount: 1,
    });
    expect(connector.sendRequests).toHaveLength(1);
    expect(connector.sideEffectCount).toBe(1);

    const replayed = await restartedRoomStore.enqueueMessage(
      command,
      commandContext("event-after-command-commit-replay", "2026-07-17T13:02:02.000Z"),
    );
    expect(replayed).toMatchObject({
      replayed: true,
      deliveries: [expect.objectContaining({
        id: fixture.outboxId,
        state: "confirmed",
        attemptCount: 1,
      })],
    });
    expect(connector.sendRequests).toHaveLength(1);
    expect(connector.sideEffectCount).toBe(1);

    await expect(recoverRoomAfterCrash(recoveryInput(
      fixture,
      registry,
      firstLeases.roomWorker,
      firstLeases.sender,
      "2026-07-17T13:02:03.000Z",
    ))).rejects.toMatchObject({ code: "stale_lease_fence" });
  });

  it("rejects an old sender epoch that loses authority after recovery precheck before claim or send", async () => {
    const fixture = await createCrashRoomFixture("sender-fence-after-precheck");
    const connector = createDeterministicConnectorDouble();
    const leases = await acquireWorkerAndSenderLeases({
      fixture,
      holderSuffix: "sender-fence-old",
      expectedEpoch: null,
      now: "2026-07-17T13:40:05.000Z",
      expiresAt: "2026-07-17T13:45:00.000Z",
    });
    const command = enqueueInput(fixture, "2026-07-17T13:40:06.000Z");
    await fixture.roomStore.enqueueMessage(
      command,
      commandContext("event-sender-fence-after-precheck", command.message.createdAt),
    );
    const registry = createRegistry(connector.connector);
    const recovery = recoveryInput(
      fixture,
      registry,
      leases.roomWorker,
      leases.sender,
      "2026-07-17T13:40:10.000Z",
    );

    let observedError: unknown = null;
    try {
      await recoverRoomAfterCrash({
        ...recovery,
        deliveryCoordinator: {
          dispatch: async (input) => {
            const released = await fixture.leaseStore.releaseLease({
              leaseId: leases.sender.id,
              roomId: fixture.roomId,
              kind: "sender",
              resourceId: fixture.bindingId,
              holderId: leases.sender.holderId,
              hostId: HOST_ID,
              expectedEpoch: leases.sender.epoch,
              now: "2026-07-17T13:40:11.000Z",
            });
            expect(released).toMatchObject({ ok: true });
            const replacement = await fixture.leaseStore.acquireLease({
              leaseId: "lease-sender-fence-replacement",
              roomId: fixture.roomId,
              kind: "sender",
              resourceId: fixture.bindingId,
              holderId: "room-worker-sender-fence-replacement",
              hostId: HOST_ID,
              expectedEpoch: leases.sender.epoch,
              now: "2026-07-17T13:40:12.000Z",
              expiresAt: "2026-07-17T13:46:00.000Z",
            });
            expect(replacement).toMatchObject({ ok: true, lease: { epoch: 2 } });
            return dispatchRoomDelivery({ ...input, registry });
          },
          reconcile: (input) => reconcileAmbiguousRoomDelivery({ ...input, registry }),
        },
      });
    } catch (error) {
      observedError = error;
    }

    expect.soft(observedError).toMatchObject({ code: "stale_lease_fence" });
    expect.soft(await fixture.roomStore.getDelivery(fixture.outboxId)).toMatchObject({
      state: "pending",
      attemptCount: 0,
    });
    expect.soft(connector.sendRequests).toHaveLength(0);
    expect.soft(connector.sideEffectCount).toBe(0);
  });

  it("reconciles an external send after a crash before acknowledgement persistence without blind resend", async () => {
    const fixture = await createCrashRoomFixture("after-external-send");
    const connector = createDeterministicConnectorDouble();
    const firstLeases = await acquireWorkerAndSenderLeases({
      fixture,
      holderSuffix: "external-first",
      expectedEpoch: null,
      now: "2026-07-17T13:10:05.000Z",
      expiresAt: "2026-07-17T13:11:00.000Z",
    });
    const command = enqueueInput(fixture, "2026-07-17T13:10:10.000Z");
    await fixture.roomStore.enqueueMessage(
      command,
      commandContext("event-after-external-send", command.message.createdAt),
    );
    const registry = createRegistry(connector.connector);
    await expect(dispatchRoomDelivery({
      store: crashBeforeDeliveryCompletion(
        fixture.roomStore,
        "after_external_send_before_ack",
      ),
      registry,
      identity: connectorIdentity(fixture),
      outboxId: fixture.outboxId,
      attemptId: "attempt-after-external-send",
      senderFence: senderFence(firstLeases.sender),
      content: command.message.content,
      reconciliationFromCursor: "cursor-before-external-send",
      now: "2026-07-17T13:10:11.000Z",
      audit: {
        runId: "run-after-external-send",
        agentId: firstLeases.roomWorker.holderId,
      },
    })).rejects.toThrow(
      "injected_process_crash:after_external_send_before_ack",
    );
    const stranded = await fixture.roomStore.getDelivery(fixture.outboxId);
    expect(stranded).toMatchObject({
      state: "dispatching",
      attemptCount: 1,
      connectorAcknowledgementId: null,
      nativeMessageId: null,
      nativeCursor: null,
    });
    expect(connector.sendRequests).toHaveLength(1);
    expect(connector.sideEffectCount).toBe(1);

    const restartedRoomStore = new AsyncRoomStore(fixture.layer);
    const restartedLeaseStore = new AsyncRoomLeaseStore(fixture.layer);
    const restartedCheckpointStore = new AsyncRoomCheckpointStore(fixture.layer);
    const restartedFixture = {
      ...fixture,
      roomStore: restartedRoomStore,
      leaseStore: restartedLeaseStore,
      checkpointStore: restartedCheckpointStore,
    };
    const takeoverRoomWorker = await acquireRecoveryRoomWorkerLease({
      fixture: restartedFixture,
      holderSuffix: "external-restart",
      expectedEpoch: 1,
      now: "2026-07-17T13:12:00.000Z",
      expiresAt: "2026-07-17T13:14:00.000Z",
    });
    const recover = recoveryInput(
      restartedFixture,
      registry,
      takeoverRoomWorker,
      null,
      "2026-07-17T13:12:01.000Z",
    );
    const recovered = await recoverRoomAfterCrash(recover);
    const localMessageId = stranded?.localMessageId;
    expect(recovered.deliveries).toEqual([
      expect.objectContaining({
        id: fixture.outboxId,
        state: "confirmed",
        attemptCount: 1,
        nativeMessageId: `native-${localMessageId}`,
        nativeCursor: `cursor-${localMessageId}`,
      }),
    ]);
    expect(connector.historyRequests).toHaveLength(1);
    expect(connector.historyRequests[0]?.afterCursor).toBe(stranded?.reconciliationFromCursor);
    expect(connector.sendRequests).toHaveLength(1);
    expect(connector.sideEffectCount).toBe(1);

    await recoverRoomAfterCrash({
      ...recover,
      now: "2026-07-17T13:12:02.000Z",
      audit: { ...recover.audit, runId: `${recover.audit.runId}:replay` },
    });
    expect(connector.sendRequests).toHaveLength(1);
    expect(connector.sideEffectCount).toBe(1);
  });

  it("rebuilds delivery projection and checkpoint after a crash following connector acknowledgement", async () => {
    const fixture = await createCrashRoomFixture("after-ack");
    const baselineCheckpoint = await createTurnCheckpoint(fixture, "after-ack");
    const connector = createDeterministicConnectorDouble();
    const firstLeases = await acquireWorkerAndSenderLeases({
      fixture,
      holderSuffix: "ack-first",
      expectedEpoch: null,
      now: "2026-07-17T13:20:05.000Z",
      expiresAt: "2026-07-17T13:21:00.000Z",
    });
    const command = enqueueInput(fixture, "2026-07-17T13:20:10.000Z");
    await fixture.roomStore.enqueueMessage(
      command,
      commandContext("event-after-ack", command.message.createdAt),
    );
    const registry = createRegistry(connector.connector);
    const acknowledged = await dispatchRoomDelivery({
      store: fixture.roomStore,
      registry,
      identity: connectorIdentity(fixture),
      outboxId: fixture.outboxId,
      attemptId: "attempt-after-ack",
      senderFence: senderFence(firstLeases.sender),
      content: command.message.content,
      reconciliationFromCursor: "cursor-before-ack",
      now: "2026-07-17T13:20:11.000Z",
      audit: {
        runId: "run-after-ack",
        agentId: firstLeases.roomWorker.holderId,
      },
    });
    expect(acknowledged).toMatchObject({
      state: "confirmed",
      attemptCount: 1,
      connectorAcknowledgementId: `ack-${acknowledged.localMessageId}`,
      nativeMessageId: `native-${acknowledged.localMessageId}`,
      nativeCursor: `cursor-${acknowledged.localMessageId}`,
    });
    // The process terminates after the acknowledgement transaction but before
    // advancing the turn checkpoint. Recovery must not downgrade or resend it.
    expect(await fixture.checkpointStore.getLatestCheckpoint(fixture.roomId)).toEqual(
      baselineCheckpoint,
    );
    expect(connector.sendRequests).toHaveLength(1);
    expect(connector.sideEffectCount).toBe(1);

    const restartedRoomStore = new AsyncRoomStore(fixture.layer);
    const restartedLeaseStore = new AsyncRoomLeaseStore(fixture.layer);
    const restartedCheckpointStore = new AsyncRoomCheckpointStore(fixture.layer);
    const restartedFixture = {
      ...fixture,
      roomStore: restartedRoomStore,
      leaseStore: restartedLeaseStore,
      checkpointStore: restartedCheckpointStore,
    };
    const takeoverLeases = await acquireWorkerAndSenderLeases({
      fixture: restartedFixture,
      holderSuffix: "ack-restart",
      expectedEpoch: 1,
      now: "2026-07-17T13:22:00.000Z",
      expiresAt: "2026-07-17T13:24:00.000Z",
    });
    const recovery = recoveryInput(
      restartedFixture,
      registry,
      takeoverLeases.roomWorker,
      takeoverLeases.sender,
      "2026-07-17T13:22:01.000Z",
    );
    const recovered = await recoverRoomAfterCrash(recovery);
    expect(recovered.deliveries).toEqual([
      expect.objectContaining({
        id: fixture.outboxId,
        state: "confirmed",
        attemptCount: 1,
        connectorAcknowledgementId: acknowledged.connectorAcknowledgementId,
        nativeMessageId: acknowledged.nativeMessageId,
        nativeCursor: acknowledged.nativeCursor,
      }),
    ]);
    const recoveredCheckpoint = await restartedCheckpointStore.getLatestCheckpoint(
      fixture.roomId,
    );
    expect(recovered.checkpointId).not.toBe(baselineCheckpoint.id);
    expect(recoveredCheckpoint).toMatchObject({
      id: recovered.checkpointId,
      aggregateVersion: fixture.aggregateVersion + 1,
      bindingCursors: {
        [fixture.bindingId]: acknowledged.nativeCursor,
      },
      pendingOutboxIds: [],
    });
    expect(connector.historyRequests).toHaveLength(0);
    expect(connector.sendRequests).toHaveLength(1);
    expect(connector.sideEffectCount).toBe(1);

    const eventsAfterRecovery = await restartedRoomStore.listEvents(fixture.roomId);
    const replayed = await restartedCheckpointStore.replayProjection(fixture.roomId);
    expect(replayed.checkpointId).toBe(recovered.checkpointId);

    const replayRecovery = await recoverRoomAfterCrash({
      ...recovery,
      now: "2026-07-17T13:22:02.000Z",
      audit: { ...recovery.audit, runId: `${recovery.audit.runId}:replay` },
    });
    expect(replayRecovery.checkpointId).toBe(recovered.checkpointId);
    expect(await restartedRoomStore.listEvents(fixture.roomId)).toEqual(eventsAfterRecovery);
    expect(connector.historyRequests).toHaveLength(0);
    expect(connector.sendRequests).toHaveLength(1);
    expect(connector.sideEffectCount).toBe(1);
  });

  /*
  FNXC:SessionRoomCrashRecovery 2026-07-18-09:03:
  Same-aggregate recovery may advance a binding cursor only when its confirmed
  database row proves an opaque cursor transition. A cursor equal to the prior
  checkpoint, or a replacement cursor that does not exactly match the confirmed
  row, must leave the checkpoint unchanged. A valid acknowledgement-only
  confirmation is covered separately and removes work without changing cursor.
  */
  it.each([
    {
      name: "a confirmed native cursor equal to the prior checkpoint cursor",
      confirmedCursor: "opaque:before:same",
      replacementCursor: "opaque:before:same",
    },
    {
      name: "a replacement cursor that does not equal the confirmed database cursor",
      confirmedCursor: "opaque:confirmed:exact",
      replacementCursor: "opaque:fallback:not-confirmed",
    },
  ])("rejects checkpoint recovery replacement with $name", async ({
    name,
    confirmedCursor,
    replacementCursor,
  }) => {
    const suffix = name.replace(/[^a-z]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
    const fixture = await createCrashRoomFixture(`cursor-monotonicity-${suffix}`);
    const queued = await fixture.roomStore.enqueueMessage(
      enqueueInput(fixture, "2026-07-17T13:23:00.000Z"),
      commandContext(
        `event-cursor-monotonicity-${suffix}`,
        "2026-07-17T13:23:00.000Z",
      ),
    );
    const priorCursor = "opaque:before:same";
    const baselineCheckpoint = await createTurnCheckpoint(
      fixture,
      `cursor-monotonicity-${suffix}`,
      {
        aggregateVersion: queued.event.aggregateVersion,
        bindingCursors: { [fixture.bindingId]: priorCursor },
        now: "2026-07-17T13:23:01.000Z",
      },
    );
    await fixture.layer.db
      .update(roomOutbox)
      .set({
        deliveryState: "confirmed",
        nativeCursor: confirmedCursor,
        deliveredAt: "2026-07-17T13:23:02.000Z",
        updatedAt: "2026-07-17T13:23:02.000Z",
      })
      .where(and(
        eq(roomOutbox.projectId, PROJECT_ID),
        eq(roomOutbox.roomId, fixture.roomId),
        eq(roomOutbox.id, fixture.outboxId),
      ));

    await expect(fixture.checkpointStore.replaceCheckpointAfterDeliveryRecovery({
      previousCheckpointId: baselineCheckpoint.id,
      id: `${baselineCheckpoint.id}-recovered`,
      roomId: fixture.roomId,
      turnId: baselineCheckpoint.turnId,
      expectedAggregateVersion: baselineCheckpoint.aggregateVersion,
      protocolState: baselineCheckpoint.protocolState,
      dagVersion: baselineCheckpoint.dagVersion,
      bindingCursors: { [fixture.bindingId]: replacementCursor },
      artifactRefs: baselineCheckpoint.artifactRefs,
      now: "2026-07-17T13:23:03.000Z",
    })).rejects.toMatchObject({ code: "checkpoint_version_conflict" });
    expect(await fixture.checkpointStore.getLatestCheckpoint(fixture.roomId)).toEqual(
      baselineCheckpoint,
    );
  });

  it("accepts an opaque confirmed cursor that changes and exactly matches the database result", async () => {
    const fixture = await createCrashRoomFixture("cursor-opaque-database-result");
    const queued = await fixture.roomStore.enqueueMessage(
      enqueueInput(fixture, "2026-07-17T13:23:10.000Z"),
      commandContext(
        "event-cursor-opaque-database-result",
        "2026-07-17T13:23:10.000Z",
      ),
    );
    const baselineCheckpoint = await createTurnCheckpoint(
      fixture,
      "cursor-opaque-database-result",
      {
        aggregateVersion: queued.event.aggregateVersion,
        bindingCursors: { [fixture.bindingId]: "opaque:z:prior" },
        now: "2026-07-17T13:23:11.000Z",
      },
    );
    await fixture.layer.db
      .update(roomOutbox)
      .set({
        deliveryState: "confirmed",
        nativeCursor: "opaque:a:confirmed",
        deliveredAt: "2026-07-17T13:23:12.000Z",
        updatedAt: "2026-07-17T13:23:12.000Z",
      })
      .where(and(
        eq(roomOutbox.projectId, PROJECT_ID),
        eq(roomOutbox.roomId, fixture.roomId),
        eq(roomOutbox.id, fixture.outboxId),
      ));

    const transactionSpy = vi.spyOn(fixture.layer, "transactionImmediate");
    transactionSpy.mockClear();
    let recovered;
    try {
      recovered = await fixture.checkpointStore.replaceCheckpointAfterDeliveryRecovery({
        previousCheckpointId: baselineCheckpoint.id,
        id: `${baselineCheckpoint.id}-recovered`,
        roomId: fixture.roomId,
        turnId: baselineCheckpoint.turnId,
        expectedAggregateVersion: baselineCheckpoint.aggregateVersion,
        protocolState: baselineCheckpoint.protocolState,
        dagVersion: baselineCheckpoint.dagVersion,
        bindingCursors: { [fixture.bindingId]: "opaque:a:confirmed" },
        artifactRefs: baselineCheckpoint.artifactRefs,
        now: "2026-07-17T13:23:13.000Z",
      });
      expect(transactionSpy).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ isolationLevel: "repeatable read" }),
      );
    } finally {
      transactionSpy.mockRestore();
    }

    expect(recovered).toMatchObject({
      id: `${baselineCheckpoint.id}-recovered`,
      aggregateVersion: baselineCheckpoint.aggregateVersion,
      bindingCursors: { [fixture.bindingId]: "opaque:a:confirmed" },
      pendingOutboxIds: [],
    });
  });

  it("removes acknowledgement-confirmed delivery without inventing a native cursor", async () => {
    const fixture = await createCrashRoomFixture("checkpoint-ack-only-confirmed");
    const queued = await fixture.roomStore.enqueueMessage(
      enqueueInput(fixture, "2026-07-17T13:23:20.000Z"),
      commandContext("event-checkpoint-ack-only-confirmed", "2026-07-17T13:23:20.000Z"),
    );
    const priorCursor = "opaque:checkpoint:ack-only:prior";
    const baselineCheckpoint = await createTurnCheckpoint(
      fixture,
      "checkpoint-ack-only-confirmed",
      {
        aggregateVersion: queued.event.aggregateVersion,
        bindingCursors: { [fixture.bindingId]: priorCursor },
        now: "2026-07-17T13:23:21.000Z",
      },
    );
    await fixture.roomStore.beginDeliveryAttempt({
      outboxId: fixture.outboxId,
      attemptId: "attempt-checkpoint-ack-only-confirmed",
      senderFence: null,
      reconciliationFromCursor: priorCursor,
      now: "2026-07-17T13:23:22.000Z",
    });
    await fixture.roomStore.completeDeliveryAttempt({
      outboxId: fixture.outboxId,
      attemptId: "attempt-checkpoint-ack-only-confirmed",
      outcome: "confirmed",
      connectorAcknowledgementId: "ack-checkpoint-ack-only-confirmed",
      nativeMessageId: null,
      nativeCursor: null,
      errorCode: null,
      nextAttemptAt: null,
      now: "2026-07-17T13:23:23.000Z",
      audit: { runId: "run-checkpoint-ack-only-confirmed", agentId: "agent-checkpoint" },
    });

    const recovered = await fixture.checkpointStore.replaceCheckpointAfterDeliveryRecovery({
      previousCheckpointId: baselineCheckpoint.id,
      id: `${baselineCheckpoint.id}-recovered`,
      roomId: fixture.roomId,
      turnId: baselineCheckpoint.turnId,
      expectedAggregateVersion: baselineCheckpoint.aggregateVersion,
      protocolState: baselineCheckpoint.protocolState,
      dagVersion: baselineCheckpoint.dagVersion,
      bindingCursors: { [fixture.bindingId]: priorCursor },
      artifactRefs: baselineCheckpoint.artifactRefs,
      now: "2026-07-17T13:23:24.000Z",
    });

    expect(recovered).toMatchObject({
      bindingCursors: { [fixture.bindingId]: priorCursor },
      pendingOutboxIds: [],
    });
  });

  it("rejects a non-adjacent opaque cursor replay across confirmed deliveries", async () => {
    const fixture = await createCrashRoomFixture("checkpoint-non-adjacent-cursor-replay");
    const outboxIds = [fixture.outboxId];
    let aggregate = await fixture.roomStore.enqueueMessage(
      enqueueInput(fixture, "2026-07-17T13:23:30.000Z"),
      commandContext(
        "event-checkpoint-non-adjacent-cursor-replay-1",
        "2026-07-17T13:23:30.000Z",
      ),
    );
    for (const index of [2, 3] as const) {
      const outboxId = `${fixture.outboxId}-${index}`;
      const messageId = `${fixture.messageId}-${index}`;
      const createdAt = `2026-07-17T13:23:3${index}.000Z`;
      aggregate = await fixture.roomStore.enqueueMessage(
        {
          roomId: fixture.roomId,
          expectedAggregateVersion: aggregate.event.aggregateVersion,
          idempotencyKey: `${messageId}:route`,
          message: {
            id: messageId,
            turnId: null,
            nodeId: null,
            originType: "controller",
            originId: "room-controller-crash-test",
            targetSeatIds: [fixture.seatId],
            intent: "instruction",
            content: `Opaque cursor replay probe ${index}`,
            authorityEnvelope: { allowedActions: ["session:send"] },
            createdAt,
          },
          deliveries: [{ id: outboxId, bindingId: fixture.bindingId }],
        },
        commandContext(`event-checkpoint-non-adjacent-cursor-replay-${index}`, createdAt),
      );
      outboxIds.push(outboxId);
    }
    const baselineCheckpoint = await createTurnCheckpoint(
      fixture,
      "checkpoint-non-adjacent-cursor-replay",
      {
        aggregateVersion: aggregate.event.aggregateVersion,
        bindingCursors: { [fixture.bindingId]: "opaque:A" },
        now: "2026-07-17T13:23:34.000Z",
      },
    );
    const cursorSequence = ["opaque:B", "opaque:C", "opaque:B"];
    for (const [index, outboxId] of outboxIds.entries()) {
      await fixture.layer.db
        .update(roomOutbox)
        .set({
          deliveryState: "confirmed",
          nativeCursor: cursorSequence[index],
          deliveredAt: `2026-07-17T13:23:4${index}.000Z`,
          updatedAt: `2026-07-17T13:23:4${index}.000Z`,
        })
        .where(and(
          eq(roomOutbox.projectId, PROJECT_ID),
          eq(roomOutbox.roomId, fixture.roomId),
          eq(roomOutbox.id, outboxId),
        ));
    }

    await expect(fixture.checkpointStore.replaceCheckpointAfterDeliveryRecovery({
      previousCheckpointId: baselineCheckpoint.id,
      id: `${baselineCheckpoint.id}-recovered`,
      roomId: fixture.roomId,
      turnId: baselineCheckpoint.turnId,
      expectedAggregateVersion: baselineCheckpoint.aggregateVersion,
      protocolState: baselineCheckpoint.protocolState,
      dagVersion: baselineCheckpoint.dagVersion,
      bindingCursors: { [fixture.bindingId]: "opaque:B" },
      artifactRefs: baselineCheckpoint.artifactRefs,
      now: "2026-07-17T13:23:50.000Z",
    })).rejects.toMatchObject({ code: "checkpoint_version_conflict" });
    expect(await fixture.checkpointStore.getLatestCheckpoint(fixture.roomId)).toEqual(
      baselineCheckpoint,
    );
  });

  /*
  FNXC:SessionRoomCrashRecovery 2026-07-17-23:59:
  Task 4.7 RED requires recovery to refresh the latest checkpoint even when the
  Room aggregateVersion did not change. Delivery uncertainty can resolve to
  confirmed on the same durable event version, so pendingOutboxIds and binding
  cursors must advance from recovery evidence rather than staying on the stale
  checkpoint snapshot.
  */
  it("refreshes the checkpoint when delivery_uncertain becomes confirmed at the same aggregate version", async () => {
    const fixture = await createCrashRoomFixture("uncertain-same-version");
    const initialLeases = await acquireWorkerAndSenderLeases({
      fixture,
      holderSuffix: "uncertain-same-version-first",
      expectedEpoch: null,
      now: "2026-07-17T13:24:00.000Z",
      expiresAt: "2026-07-17T13:25:00.000Z",
    });
    const queued = await fixture.roomStore.enqueueMessage(
      enqueueInput(fixture, "2026-07-17T13:24:01.000Z"),
      commandContext("event-uncertain-same-version-queued", "2026-07-17T13:24:01.000Z"),
    );
    const queuedAggregateVersion = queued.event.aggregateVersion;
    const baselineCheckpoint = await createTurnCheckpoint(
      fixture,
      "uncertain-same-version",
      {
        aggregateVersion: queuedAggregateVersion,
        now: "2026-07-17T13:24:01.500Z",
      },
    );
    await fixture.roomStore.beginDeliveryAttempt({
      outboxId: fixture.outboxId,
      attemptId: "attempt-uncertain-same-version-1",
      senderFence: senderFence(initialLeases.sender),
      reconciliationFromCursor: "cursor-before-uncertain-same-version",
      now: "2026-07-17T13:24:02.000Z",
    });
    const uncertain = await fixture.roomStore.completeDeliveryAttempt({
      outboxId: fixture.outboxId,
      attemptId: "attempt-uncertain-same-version-1",
      senderFence: senderFence(initialLeases.sender),
      outcome: "delivery_uncertain",
      connectorAcknowledgementId: null,
      nativeMessageId: null,
      nativeCursor: null,
      errorCode: "ack_timeout",
      nextAttemptAt: null,
      now: "2026-07-17T13:24:03.000Z",
      audit: {
        runId: "room-run-uncertain-same-version",
        agentId: initialLeases.roomWorker.holderId,
      },
    });
    const fileStatePath = join(
      tmpdir(),
      `fusion-room-crash-uncertain-same-version-${Date.now()}.json`,
    );
    writeFileSync(fileStatePath, JSON.stringify({
      acceptedByLocalMessageId: {
        [uncertain.localMessageId]: {
          nativeMessageId: `native-${uncertain.localMessageId}`,
          logicalMessageId: uncertain.localMessageId,
          role: "user",
          contentHash: queued.message.contentHash,
          occurredAt: BASE_TIME,
          cursor: `cursor-${uncertain.localMessageId}`,
        },
      },
      sendCalls: 1,
      sideEffectCount: 1,
    }, null, 2), "utf8");

    const restartedRoomStore = new AsyncRoomStore(fixture.layer);
    const restartedLeaseStore = new AsyncRoomLeaseStore(fixture.layer);
    const restartedCheckpointStore = new AsyncRoomCheckpointStore(fixture.layer);
    const restartedFixture = {
      ...fixture,
      roomStore: restartedRoomStore,
      leaseStore: restartedLeaseStore,
      checkpointStore: restartedCheckpointStore,
    };
    const takeoverRoomWorker = await acquireRecoveryRoomWorkerLease({
      fixture: restartedFixture,
      holderSuffix: "uncertain-same-version-restart",
      expectedEpoch: 1,
      now: "2026-07-17T13:26:00.000Z",
      expiresAt: "2026-07-17T13:27:00.000Z",
    });
    const recovery = recoveryInput(
      restartedFixture,
      createFileBackedRegistry(fileStatePath, "2026-07-17T13:26:01.000Z"),
      takeoverRoomWorker,
      null,
      "2026-07-17T13:26:01.000Z",
    );
    const recovered = await recoverRoomAfterCrash(recovery);
    const recoveredCheckpoint = await restartedCheckpointStore.getLatestCheckpoint(
      fixture.roomId,
    );

    expect(recovered.deliveries).toEqual([
      expect.objectContaining({
        id: fixture.outboxId,
        state: "confirmed",
        attemptCount: 1,
        nativeCursor: `cursor-${uncertain.localMessageId}`,
      }),
    ]);
    expect(
      recovered.checkpointId,
      "delivery uncertainty resolved at the same aggregateVersion must not leave the stale checkpoint in place",
    ).not.toBe(baselineCheckpoint.id);
    expect(recoveredCheckpoint).toMatchObject({
      id: recovered.checkpointId,
      aggregateVersion: queuedAggregateVersion,
      pendingOutboxIds: [],
      bindingCursors: {
        [fixture.bindingId]: `cursor-${uncertain.localMessageId}`,
      },
    });
  });

  /*
  FNXC:SessionRoomCrashRecovery 2026-07-17-23:05:
  Task 4.7 RED also requires at least one real Windows child-process crash.
  The child is killed after the external side effect but before acknowledgement
  persistence, and recovery must read the same PostgreSQL room plus a
  cross-process side-effect ledger file instead of relying on an in-memory Map.
  */
  it("recovers an external-send child-process crash from the same PostgreSQL room without duplicating the persisted side effect", async () => {
    const fixture = await createCrashRoomFixture("child-process-external-send");
    const queued = await fixture.roomStore.enqueueMessage(
      enqueueInput(fixture, "2026-07-17T14:11:00.000Z"),
      commandContext("event-child-process-external-send-queued", "2026-07-17T14:11:00.000Z"),
    );
    const queuedAggregateVersion = queued.event.aggregateVersion;
    const baselineCheckpoint = await createTurnCheckpoint(
      fixture,
      "child-process-external-send",
      {
        aggregateVersion: queuedAggregateVersion,
        now: "2026-07-17T14:11:00.500Z",
      },
    );
    const stateDir = mkdtempSync(join(tmpdir(), "fusion-room-crash-child-process-"));
    const stateFilePath = join(stateDir, "connector-state.json");
    const markerFilePath = join(stateDir, "external-send.marker");
    const child = spawnExternalSendCrashChild({
      backendUrl: requireBackendRuntimeUrl(requireSharedContext().backend),
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      outboxId: fixture.outboxId,
      content: queued.message.content,
      stateFilePath,
      markerFilePath,
    });
    let childStdout = "";
    let childStderr = "";
    child.stdout.on("data", (chunk) => {
      childStdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      childStderr += chunk.toString();
    });

    try {
      try {
        await waitForFile(markerFilePath);
      } catch (error) {
        throw new Error([
          error instanceof Error ? error.message : String(error),
          childStdout.trim() ? `stdout=${childStdout.trim()}` : null,
          childStderr.trim() ? `stderr=${childStderr.trim()}` : null,
        ].filter(Boolean).join("\n"));
      }
      killWindowsProcess(child);
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    } finally {
      if (child.exitCode === null) killWindowsProcess(child);
    }

    const afterCrash = await fixture.roomStore.getDelivery(fixture.outboxId);
    expect(afterCrash).toMatchObject({
      state: "dispatching",
      attemptCount: 1,
      connectorAcknowledgementId: null,
      nativeMessageId: null,
      nativeCursor: null,
    });
    expect(readFileBackedRoomConnectorState(stateFilePath)).toMatchObject({
      sendCalls: 1,
      sideEffectCount: 1,
    });

    const restartedRoomStore = new AsyncRoomStore(fixture.layer);
    const restartedLeaseStore = new AsyncRoomLeaseStore(fixture.layer);
    const restartedCheckpointStore = new AsyncRoomCheckpointStore(fixture.layer);
    const restartedFixture = {
      ...fixture,
      roomStore: restartedRoomStore,
      leaseStore: restartedLeaseStore,
      checkpointStore: restartedCheckpointStore,
    };
    const takeoverRoomWorker = await acquireRecoveryRoomWorkerLease({
      fixture: restartedFixture,
      holderSuffix: "child-process-external-send-restart",
      expectedEpoch: 1,
      now: "2026-07-17T14:14:00.000Z",
      expiresAt: "2026-07-17T14:16:00.000Z",
    });
    const recovered = await recoverRoomAfterCrash(recoveryInput(
      restartedFixture,
      createFileBackedRegistry(stateFilePath, "2026-07-17T14:14:01.000Z"),
      takeoverRoomWorker,
      null,
      "2026-07-17T14:14:01.000Z",
    ));
    const recoveredCheckpoint = await restartedCheckpointStore.getLatestCheckpoint(
      fixture.roomId,
    );

    expect(recovered.deliveries).toEqual([
      expect.objectContaining({
        id: fixture.outboxId,
        state: "confirmed",
        attemptCount: 1,
      }),
    ]);
    expect(readFileBackedRoomConnectorState(stateFilePath)).toMatchObject({
      sendCalls: 1,
      sideEffectCount: 1,
    });
    expect(
      recovered.checkpointId,
      "a real child-process crash must still refresh the stale checkpoint after recovery",
    ).not.toBe(baselineCheckpoint.id);
    expect(recoveredCheckpoint).toMatchObject({
      id: recovered.checkpointId,
      aggregateVersion: queuedAggregateVersion,
      pendingOutboxIds: [],
    });
  }, 60_000);

  it("keeps native takeover visibly blocked after a reconciliation crash and fences the old sender epoch", async () => {
    const fixture = await createCrashRoomFixture("native-takeover");
    const connector = createDeterministicConnectorDouble();
    connector.setHistoryUnavailable(true);
    const firstLeases = await acquireWorkerAndSenderLeases({
      fixture,
      holderSuffix: "takeover-first",
      expectedEpoch: null,
      now: "2026-07-17T13:30:05.000Z",
      expiresAt: "2026-07-17T13:31:00.000Z",
    });
    const command = enqueueInput(fixture, "2026-07-17T13:30:06.000Z");
    await fixture.roomStore.enqueueMessage(
      command,
      commandContext(
        "event-native-takeover-message",
        "2026-07-17T13:30:06.000Z",
      ),
    );
    await fixture.roomStore.beginDeliveryAttempt({
      outboxId: fixture.outboxId,
      attemptId: "attempt-native-takeover-uncertain",
      senderFence: senderFence(firstLeases.sender),
      reconciliationFromCursor: "cursor-before-native-takeover",
      now: "2026-07-17T13:30:07.000Z",
    });
    await fixture.roomStore.completeDeliveryAttempt({
      outboxId: fixture.outboxId,
      attemptId: "attempt-native-takeover-uncertain",
      senderFence: senderFence(firstLeases.sender),
      outcome: "delivery_uncertain",
      connectorAcknowledgementId: null,
      nativeMessageId: null,
      nativeCursor: null,
      errorCode: "ack_timeout",
      nextAttemptAt: null,
      now: "2026-07-17T13:30:08.000Z",
      audit: {
        runId: "run-native-takeover-uncertain",
        agentId: firstLeases.roomWorker.holderId,
      },
    });

    await fixture.roomStore.recordConnectorStatus({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      state: "running",
      statusCursor: "status-native-takeover",
      nativeWriterDetected: true,
      occurredAt: "2026-07-17T13:30:10.000Z",
    });
    await fixture.roomStore.recordConnectorIngestionMode({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      mode: "reconciling",
      occurredAt: "2026-07-17T13:30:10.000Z",
    });
    const takeoverInput: ReconcileNativeTakeoverAfterCrashInput = {
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
      takeoverId: "native-writer:status-native-takeover",
      idempotencyKey: "native-takeover:status-native-takeover",
      statusCursor: "status-native-takeover",
      roomWorkerLease: firstLeases.roomWorker,
      automaticSenderLease: firstLeases.sender,
      humanHolderId: "native-ide-human-takeover",
      hostId: HOST_ID,
      now: "2026-07-17T13:30:10.000Z",
      expiresAt: "2026-07-17T13:35:00.000Z",
    };

    // The process terminates after durable native-writer detection and before
    // history reconciliation or sender-lease transfer.
    expect(await fixture.roomStore.getConnectorIngestionState({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
    })).toMatchObject({
      mode: "reconciling",
      nativeWriterDetected: true,
      statusCursor: "status-native-takeover",
    });
    expect(await fixture.roomStore.getDelivery(fixture.outboxId)).toMatchObject({
      state: "delivery_uncertain",
      attemptCount: 1,
      reconciliationFromCursor: "cursor-before-native-takeover",
    });
    expect(connector.sendRequests).toHaveLength(0);
    expect(connector.sideEffectCount).toBe(0);

    const restartedRoomStore = new AsyncRoomStore(fixture.layer);
    const restartedLeaseStore = new AsyncRoomLeaseStore(fixture.layer);
    const restartedCheckpointStore = new AsyncRoomCheckpointStore(fixture.layer);
    const roomWorkerTakeover = await restartedLeaseStore.acquireLease({
      leaseId: "lease-room-worker-takeover-restart",
      roomId: fixture.roomId,
      kind: "room_worker",
      resourceId: fixture.roomId,
      holderId: "room-worker-takeover-restart",
      hostId: HOST_ID,
      expectedEpoch: 1,
      now: "2026-07-17T13:32:00.000Z",
      expiresAt: "2026-07-17T13:34:00.000Z",
    });
    expect(roomWorkerTakeover).toMatchObject({ ok: true, lease: { epoch: 2 } });
    if (!roomWorkerTakeover.ok) throw new Error("restart Room worker lease was not acquired");
    const restartedFixture = {
      ...fixture,
      roomStore: restartedRoomStore,
      leaseStore: restartedLeaseStore,
      checkpointStore: restartedCheckpointStore,
    };
    const registry = createRegistry(connector.connector);
    const eventsBeforeRecovery = await restartedRoomStore.listEvents(fixture.roomId);

    const recovered = await recoverRoomAfterCrash(recoveryInput(
      restartedFixture,
      registry,
      roomWorkerTakeover.lease,
      null,
      "2026-07-17T13:32:01.000Z",
      {
        ...takeoverInput,
        roomWorkerLease: roomWorkerTakeover.lease,
        now: "2026-07-17T13:32:01.000Z",
      },
    ));
    const blocked = recovered.nativeTakeover;
    expect(blocked).toMatchObject({
      state: "blocked_delivery_uncertain",
      automaticSender: "paused",
      takeoverEpoch: 1,
      confirmedCursor: null,
      blockedOutboxIds: [fixture.outboxId],
      senderLease: null,
    });
    expect(await restartedRoomStore.getDelivery(fixture.outboxId)).toMatchObject({
      state: "delivery_uncertain",
      attemptCount: 1,
    });
    expect(await restartedRoomStore.getConnectorIngestionState({
      roomId: fixture.roomId,
      bindingId: fixture.bindingId,
    })).toMatchObject({
      mode: "reconciling",
      nativeWriterDetected: true,
    });
    expect(await restartedRoomStore.listEvents(fixture.roomId)).toEqual(eventsBeforeRecovery);
    expect(connector.historyRequests).toHaveLength(1);
    expect(connector.sendRequests).toHaveLength(0);
    expect(connector.sideEffectCount).toBe(0);

    await expect(recoverRoomAfterCrash(recoveryInput(
      fixture,
      registry,
      firstLeases.roomWorker,
      firstLeases.sender,
      "2026-07-17T13:32:02.000Z",
    ))).rejects.toMatchObject({ code: "stale_lease_fence" });
    expect(connector.sendRequests).toHaveLength(0);
    expect(connector.sideEffectCount).toBe(0);
  });
});

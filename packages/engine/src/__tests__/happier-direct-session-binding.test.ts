import {
  isSessionRoomControlPlaneEnabled,
  SESSION_ROOM_CONTROL_PLANE_FLAG,
  type TaskStore,
} from "@fusion/core";
import { describe, expect, it } from "vitest";
import { createTaskStoreNativeSessionBinding } from "../agent-runtime.js";
import {
  bindTaskHappierDirectSession,
  readTaskHappierDirectSessionBinding,
  resolveTaskHappierCliSessionId,
  TaskHappierDirectSessionConflictError,
  TaskHappierDirectSessionIntegrityError,
  type HappierDirectSessionEnsureMetadata,
} from "../happier-direct-session-binding.js";

interface StoredCliSession {
  id: string;
  taskId: string | null;
  chatSessionId: string | null;
  purpose: string;
  projectId: string;
  adapterId: string;
  agentState: string;
  terminationReason: string | null;
  nativeSessionId: string | null;
  resumeAttempts: number;
  autonomyPosture: string | null;
  worktreePath: string | null;
  createdAt: string;
  updatedAt: string;
}

type Backend = "async" | "sync";

const ensuredA: HappierDirectSessionEnsureMetadata = {
  sessionId: "hp-session-a",
  providerId: "codex",
  remoteSessionId: "remote-a",
  machineId: "machine-a",
  serverId: "server-a",
  openUrl: "https://happier.invalid/session-a",
};

function createHarness(backend: Backend) {
  const rows = new Map<string, StoredCliSession>();
  const operations: string[] = [];
  let createCount = 0;
  let failClaim = false;

  const asyncDb = {
    select: () => ({
      from: () => ({
        where: async () => [...rows.values()],
      }),
    }),
    insert: () => ({
      values: (row: StoredCliSession) => ({
        onConflictDoNothing: async () => {
          if (!rows.has(row.id)) {
            rows.set(row.id, { ...row });
            createCount += 1;
          }
        },
      }),
    }),
    update: () => ({
      set: (updates: Partial<StoredCliSession>) => ({
        where: () => ({
          returning: async () => {
            const row = [...rows.values()][0];
            if (!row) return [];
            if (updates.nativeSessionId !== undefined) {
              operations.push("claim");
              if (failClaim) throw new Error("claim failed");
              if (row.nativeSessionId !== null) return [];
            }
            if (updates.autonomyPosture !== undefined) operations.push("metadata");
            Object.assign(row, updates);
            return [{ id: row.id }];
          },
        }),
      }),
    }),
  };

  const syncDb = {
    getProjectIdentity: () => ({ id: "project-sqlite" }),
    bumpLastModified: () => undefined,
    transactionImmediate: <T>(operation: () => T): T => operation(),
    prepare: (sql: string) => ({
      get: (id: string) => rows.get(id),
      run: (...params: unknown[]) => {
        if (/^\s*INSERT/i.test(sql)) {
          const columns = /\(([^)]+)\)\s*VALUES/i.exec(sql)?.[1]
            ?.split(",")
            .map((column) => column.trim());
          if (!columns) throw new Error(`Unsupported insert: ${sql}`);
          const row = Object.fromEntries(columns.map((column, index) => [column, params[index]])) as unknown as StoredCliSession;
          if (!rows.has(row.id)) {
            rows.set(row.id, row);
            createCount += 1;
          }
          return { changes: 1 };
        }

        if (/^\s*UPDATE/i.test(sql)) {
          const id = String(params.at(-1));
          const row = rows.get(id);
          if (!row) return { changes: 0 };
          const assignments = /SET\s+(.+)\s+WHERE/is.exec(sql)?.[1]
            ?.split(",")
            .map((assignment) => assignment.trim().split("=")[0].trim());
          if (!assignments) throw new Error(`Unsupported update: ${sql}`);
          const isClaim = /nativeSessionId IS NULL/i.test(sql);
          if (isClaim) {
            operations.push("claim");
            if (failClaim) throw new Error("claim failed");
            if (row.nativeSessionId !== null) return { changes: 0 };
          }
          if (assignments.includes("autonomyPosture")) operations.push("metadata");
          assignments.forEach((column, index) => {
            (row as unknown as Record<string, unknown>)[column] = params[index];
          });
          return { changes: 1 };
        }

        throw new Error(`Unsupported SQL: ${sql}`);
      },
    }),
  };

  const asyncLayer = {
    db: asyncDb,
    projectId: "project-pg",
    transaction: <T>(operation: (tx: typeof asyncDb) => Promise<T>): Promise<T> => operation(asyncDb),
    transactionImmediate: <T>(operation: (tx: typeof asyncDb) => Promise<T>): Promise<T> => operation(asyncDb),
  };

  const store = {
    getFusionDir: () => "G:\\fusion-test-project\\.fusion",
    getAsyncLayer: () => backend === "async" ? asyncLayer : null,
    getDatabase: () => {
      if (backend === "async") throw new Error("SQLite path must not be touched");
      return syncDb;
    },
  } as unknown as TaskStore;

  return {
    store,
    rows,
    operations,
    get createCount() {
      return createCount;
    },
    failNextClaim() {
      failClaim = true;
    },
    readPosture(taskId: string) {
      const row = rows.get(resolveTaskHappierCliSessionId({ taskId, purpose: "execute" }));
      return row?.autonomyPosture ? JSON.parse(row.autonomyPosture) as Record<string, unknown> : null;
    },
    patchSession(taskId: string, patch: Partial<StoredCliSession>) {
      const id = resolveTaskHappierCliSessionId({ taskId, purpose: "execute" });
      const row = rows.get(id);
      if (!row) throw new Error(`Missing test session ${id}`);
      Object.assign(row, patch);
    },
  };
}

function createConcurrentAsyncStores() {
  const rows = new Map<string, StoredCliSession>();
  let transactionTail = Promise.resolve();
  let serializationFailurePending = true;
  let waitingForClaimedSnapshot = 0;
  let releaseClaimedSnapshots!: () => void;
  const claimedSnapshotsReady = new Promise<void>((resolve) => {
    releaseClaimedSnapshots = resolve;
  });

  function createAdapter() {
    let claimAttempted = false;
    let claimResultReadPending = false;
    let insideSerializedTransaction = false;
    const db = {
      select: () => ({
        from: () => ({
          where: async () => {
            const snapshot = [...rows.values()].map((row) => ({ ...row }));
            if (claimResultReadPending) {
              claimResultReadPending = false;
              return snapshot;
            }
            const posture = snapshot[0]?.autonomyPosture
              ? JSON.parse(snapshot[0].autonomyPosture) as Record<string, unknown>
              : null;
            if (
              !insideSerializedTransaction
              && claimAttempted
              && snapshot[0]?.nativeSessionId
              && !posture?.happierDirectSession
            ) {
              waitingForClaimedSnapshot += 1;
              if (waitingForClaimedSnapshot === 2) releaseClaimedSnapshots();
              await claimedSnapshotsReady;
            }
            return snapshot;
          },
        }),
      }),
      insert: () => ({
        values: (row: StoredCliSession) => ({
          onConflictDoNothing: async () => {
            if (!rows.has(row.id)) rows.set(row.id, { ...row });
          },
        }),
      }),
      update: () => ({
        set: (updates: Partial<StoredCliSession>) => ({
          where: () => ({
            returning: async () => {
              const row = [...rows.values()][0];
              if (!row) return [];
              if (updates.nativeSessionId !== undefined) {
                claimAttempted = true;
                claimResultReadPending = true;
                if (row.nativeSessionId !== null) return [];
              }
              Object.assign(row, updates);
              return [{ id: row.id }];
            },
          }),
        }),
      }),
    };
    return {
      db,
      async transactionImmediate<T>(operation: (tx: typeof db) => Promise<T>): Promise<T> {
        const previous = transactionTail;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        transactionTail = previous.then(() => gate);
        await previous;
        insideSerializedTransaction = true;
        try {
          if (serializationFailurePending) {
            serializationFailurePending = false;
            throw Object.assign(new Error("serialization failure"), { code: "40001" });
          }
          return await operation(db);
        } finally {
          insideSerializedTransaction = false;
          release();
        }
      },
    };
  }

  function createStore(adapter: ReturnType<typeof createAdapter>): TaskStore {
    return {
      getFusionDir: () => "G:\\fusion-test-project\\.fusion",
      getAsyncLayer: () => ({
        db: adapter.db,
        projectId: "project-pg",
        transaction: adapter.transactionImmediate,
        transactionImmediate: adapter.transactionImmediate,
      }),
      getDatabase: () => {
        throw new Error("SQLite path must not be touched");
      },
    } as unknown as TaskStore;
  }

  return {
    rows,
    storeA: createStore(createAdapter()),
    storeB: createStore(createAdapter()),
  };
}

async function createCanonicalSession(store: TaskStore, taskId: string) {
  const binding = await createTaskStoreNativeSessionBinding({
    runtimeHint: "happier",
    taskStore: store,
    sessionKey: `executor:${taskId}:primary`,
    taskId,
    purpose: "execute",
  });
  if (!binding) throw new Error("Expected Happier native-session binding");
  return binding;
}

it("keeps the existing deterministic Happier executor CLI session id", async () => {
  const taskId = "FN-HAPPIER-BIND-ID";
  const harness = createHarness("async");
  const nativeBinding = await createCanonicalSession(harness.store, taskId);

  expect(nativeBinding.key.endsWith(`:${resolveTaskHappierCliSessionId({ taskId, purpose: "execute" })}`)).toBe(true);
});

it("keeps the legacy executor primary binding available while the Room gate is off", async () => {
  const settings = {
    experimentalFeatures: { [SESSION_ROOM_CONTROL_PLANE_FLAG]: false },
  };
  expect(isSessionRoomControlPlaneEnabled(settings)).toBe(false);

  const taskId = "FN-HAPPIER-ROOM-GATE-OFF";
  const harness = createHarness("async");
  const nativeBinding = await createCanonicalSession(harness.store, taskId);

  expect(nativeBinding.key.endsWith(`:${resolveTaskHappierCliSessionId({ taskId, purpose: "execute" })}`)).toBe(true);
});

it("serializes connected metadata across distinct stores sharing one database", async () => {
  const taskId = "FN-HAPPIER-CROSS-STORE";
  const harness = createConcurrentAsyncStores();
  await createCanonicalSession(harness.storeA, taskId);
  const row = harness.rows.get(resolveTaskHappierCliSessionId({ taskId, purpose: "execute" }));
  if (!row) throw new Error("Expected canonical CLI session");
  row.autonomyPosture = JSON.stringify({ unrelated: { keep: "yes" } });

  const [first, second] = await Promise.all([
    bindTaskHappierDirectSession({ store: harness.storeA, taskId, ensured: ensuredA }),
    bindTaskHappierDirectSession({
      store: harness.storeB,
      taskId,
      ensured: { ...ensuredA, remoteSessionId: "remote-from-second-store" },
    }),
  ]);

  expect(second).toEqual(first);
  await expect(readTaskHappierDirectSessionBinding({ store: harness.storeA, taskId })).resolves.toEqual(first);
  expect(JSON.parse(row.autonomyPosture ?? "null")).toMatchObject({ unrelated: { keep: "yes" } });
});

// Fusion 0.73's official cutover removes the synchronous SQLite runtime;
// Happier ownership is PostgreSQL AsyncDataLayer-only from this boundary.
describe.each<Backend>(["async"])("%s store", (backend) => {
  it("claims before persisting connected metadata and preserves unrelated posture", async () => {
    const taskId = `FN-HAPPIER-FIRST-${backend}`;
    const harness = createHarness(backend);
    await createCanonicalSession(harness.store, taskId);
    harness.patchSession(taskId, {
      autonomyPosture: JSON.stringify({ autoApprove: true, unrelated: { keep: "yes" } }),
    });

    const result = await bindTaskHappierDirectSession({
      store: harness.store,
      taskId,
      worktreePath: "G:\\fusion-test-project",
      ensured: ensuredA,
    });

    expect(result).toMatchObject({
      cliSessionId: resolveTaskHappierCliSessionId({ taskId, purpose: "execute" }),
      providerId: "codex",
      nativeSessionId: "remote-a",
      happierSessionId: ensuredA.sessionId,
      machineId: "machine-a",
      serverProfileId: "server-a",
    });
    expect(Date.parse(result.linkedAt)).not.toBeNaN();
    expect(harness.operations).toEqual(["claim", "metadata"]);
    expect(harness.readPosture(taskId)).toEqual({
      autoApprove: true,
      unrelated: { keep: "yes" },
      happierDirectSession: { schemaVersion: 2, ...result },
    });
    expect(harness.readPosture(taskId)?.happierDirectSession).not.toHaveProperty("openUrl");
  });

  it("is idempotent for the same Happier Session without duplicating or relinking", async () => {
    const taskId = `FN-HAPPIER-IDEMPOTENT-${backend}`;
    const harness = createHarness(backend);

    const first = await bindTaskHappierDirectSession({ store: harness.store, taskId, ensured: ensuredA });
    const second = await bindTaskHappierDirectSession({ store: harness.store, taskId, ensured: ensuredA });

    expect(second).toEqual(first);
    expect(harness.rows).toHaveLength(1);
    expect(harness.createCount).toBe(1);
    expect(harness.operations).toEqual(["claim", "metadata"]);
  });

  it("raises a typed conflict when another Happier Session already owns the task", async () => {
    const taskId = `FN-HAPPIER-CONFLICT-${backend}`;
    const harness = createHarness(backend);
    await bindTaskHappierDirectSession({ store: harness.store, taskId, ensured: ensuredA });

    await expect(bindTaskHappierDirectSession({
      store: harness.store,
      taskId,
      ensured: { ...ensuredA, sessionId: "hp-session-b" },
    })).rejects.toBeInstanceOf(TaskHappierDirectSessionConflictError);
    expect((harness.readPosture(taskId)?.happierDirectSession as { happierSessionId: string }).happierSessionId).toBe("hp-session-a");
  });

  it("does not write connected metadata when claiming fails", async () => {
    const taskId = `FN-HAPPIER-CLAIM-FAIL-${backend}`;
    const harness = createHarness(backend);
    harness.failNextClaim();

    await expect(bindTaskHappierDirectSession({ store: harness.store, taskId, ensured: ensuredA }))
      .rejects.toThrow("claim failed");
    expect(harness.readPosture(taskId)?.happierDirectSession).toBeUndefined();
    expect(harness.operations).toEqual(["claim"]);
  });

  it("ignores malformed or stale metadata", async () => {
    const taskId = `FN-HAPPIER-STALE-${backend}`;
    const harness = createHarness(backend);
    await createCanonicalSession(harness.store, taskId);
    harness.patchSession(taskId, {
      nativeSessionId: "hp-session-a",
      autonomyPosture: JSON.stringify({ happierDirectSession: { providerId: "codex" } }),
    });
    await expect(readTaskHappierDirectSessionBinding({ store: harness.store, taskId })).resolves.toBeNull();

    harness.patchSession(taskId, {
      autonomyPosture: JSON.stringify({
        happierDirectSession: {
          schemaVersion: 2,
          cliSessionId: resolveTaskHappierCliSessionId({ taskId, purpose: "execute" }),
          nativeSessionId: "hp-session-a",
          providerId: "codex",
          remoteSessionId: "remote-a",
          machineId: "machine-a",
          serverId: "server-a",
          linkedAt: new Date().toISOString(),
        },
      }),
    });
    await expect(readTaskHappierDirectSessionBinding({ store: harness.store, taskId })).resolves.toBeNull();

    harness.patchSession(taskId, {
      nativeSessionId: null,
      autonomyPosture: JSON.stringify({
        happierDirectSession: {
          cliSessionId: resolveTaskHappierCliSessionId({ taskId, purpose: "execute" }),
          nativeSessionId: "hp-session-a",
          providerId: "codex",
          remoteSessionId: "remote-a",
          machineId: "machine-a",
          serverId: "server-a",
          linkedAt: new Date().toISOString(),
        },
      }),
    });
    await expect(readTaskHappierDirectSessionBinding({ store: harness.store, taskId })).resolves.toBeNull();
  });

  it("reads legacy reversed metadata through the corrected semantic field names", async () => {
    const taskId = `FN-HAPPIER-LEGACY-${backend}`;
    const harness = createHarness(backend);
    await createCanonicalSession(harness.store, taskId);
    harness.patchSession(taskId, {
      nativeSessionId: "hp-session-a",
      autonomyPosture: JSON.stringify({
        happierDirectSession: {
          cliSessionId: resolveTaskHappierCliSessionId({ taskId, purpose: "execute" }),
          nativeSessionId: "hp-session-a",
          providerId: "codex",
          remoteSessionId: "remote-a",
          machineId: "machine-a",
          serverId: "server-a",
          linkedAt: "2026-07-15T00:00:00.000Z",
        },
      }),
    });

    await expect(readTaskHappierDirectSessionBinding({ store: harness.store, taskId })).resolves.toEqual({
      cliSessionId: resolveTaskHappierCliSessionId({ taskId, purpose: "execute" }),
      providerId: "codex",
      nativeSessionId: "remote-a",
      happierSessionId: "hp-session-a",
      machineId: "machine-a",
      serverProfileId: "server-a",
      linkedAt: "2026-07-15T00:00:00.000Z",
    });
  });

  it("raises a typed integrity error when native identity and metadata disagree", async () => {
    const taskId = `FN-HAPPIER-INTEGRITY-${backend}`;
    const harness = createHarness(backend);
    const binding = await bindTaskHappierDirectSession({ store: harness.store, taskId, ensured: ensuredA });
    harness.patchSession(taskId, { nativeSessionId: "hp-different-native" });

    await expect(readTaskHappierDirectSessionBinding({ store: harness.store, taskId }))
      .rejects.toBeInstanceOf(TaskHappierDirectSessionIntegrityError);
    expect(binding).toMatchObject({ nativeSessionId: "remote-a", happierSessionId: "hp-session-a" });
  });
});

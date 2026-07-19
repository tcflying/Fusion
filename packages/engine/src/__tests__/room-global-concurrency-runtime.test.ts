import {
  ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION,
  type AsyncDataLayer,
} from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import type { RoomLegacyTaskTriageSnapshotTaskStoreV1 } from "../room-legacy-task-triage-snapshot-reader.js";
import { ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION } from "../room-global-concurrency-accounting.js";
import {
  createRoomGlobalConcurrencyRuntime,
  RoomGlobalConcurrencyRuntimeError,
  type CreateRoomGlobalConcurrencyRuntimeInputV1,
  type RoomGlobalConcurrencyVerifiedPolicyV1,
} from "../room-global-concurrency-runtime.js";

const PROJECT_ID = "project-room-global-runtime";
const AS_OF = "2026-07-19T16:00:00.000Z";

function verifiedPolicy(): RoomGlobalConcurrencyVerifiedPolicyV1 {
  return {
    policy: {
      totalSlots: 12,
      reservations: {
        verifierSlots: 2,
        recoverySlots: 1,
        legacyTaskTriageSlots: 3,
      },
      snapshotTtlMs: 60_000,
    },
    controllerAdmission: {
      workClass: "normal",
      slots: 1,
      createClaimId: () => "capacity-claim-from-verified-policy",
    },
    verifiedAt: AS_OF,
    verificationId: "operator-capacity-policy-20260719",
  };
}

function dataLayer(projectId = PROJECT_ID): {
  readonly layer: AsyncDataLayer;
  readonly transactionImmediate: ReturnType<typeof vi.fn>;
} {
  const transactionImmediate = vi.fn(async () => {
    throw new Error("fixture PostgreSQL is intentionally unavailable");
  });
  return {
    layer: {
      projectId,
      transactionImmediate,
    } as unknown as AsyncDataLayer,
    transactionImmediate,
  };
}

function taskStore(projectId = PROJECT_ID): {
  readonly store: RoomLegacyTaskTriageSnapshotTaskStoreV1;
  readonly listTasks: ReturnType<typeof vi.fn>;
} {
  const listTasks = vi.fn(async () => []);
  return {
    store: {
      getAsyncLayer: () => ({ projectId }),
      listTasks,
    },
    listTasks,
  };
}

function configuration(
  overrides: Partial<CreateRoomGlobalConcurrencyRuntimeInputV1> = {},
): CreateRoomGlobalConcurrencyRuntimeInputV1 {
  const layer = dataLayer();
  const store = taskStore();
  return {
    projectId: PROJECT_ID,
    layer: layer.layer,
    taskStore: store.store,
    verifiedPolicy: verifiedPolicy(),
    ...overrides,
  };
}

function expectRuntimeError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(RoomGlobalConcurrencyRuntimeError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected runtime construction to fail with ${code}`);
}

describe("Room global concurrency runtime", () => {
  it("composes Core PostgreSQL ports with the same-project legacy snapshot reader", async () => {
    const layer = dataLayer();
    const store = taskStore();
    const runtime = createRoomGlobalConcurrencyRuntime(configuration({
      layer: layer.layer,
      taskStore: store.store,
    }));

    expect(runtime.projectId).toBe(PROJECT_ID);
    expect(runtime.ports.snapshotPort).toBe(runtime.postgresPorts.snapshotPort);
    expect(runtime.ports.claimStore).toBe(runtime.postgresPorts.claimStore);
    expect(runtime.capacityAdmission).toMatchObject({
      globalAccounting: runtime.accounting,
      workClass: "normal",
      slots: 1,
    });
    expect(runtime.capacityAdmission.createClaimId).toBe(runtime.verifiedPolicy.controllerAdmission.createClaimId);
    expect(Object.isFrozen(runtime.verifiedPolicy)).toBe(true);

    await expect(runtime.legacySnapshotReader.readSnapshot({
      contractVersion: 1,
      projectId: PROJECT_ID,
      asOf: AS_OF,
      transaction: {} as never,
    })).resolves.toEqual({
      activeTaskSlots: 0,
      activeTriageSlots: 0,
      queuedTaskSlots: 0,
      queuedTriageSlots: 0,
    });

    await expect(runtime.ports.snapshotPort.readSnapshot({
      contractVersion: ROOM_GLOBAL_CONCURRENCY_POSTGRES_CONTRACT_VERSION,
      projectId: PROJECT_ID,
      asOf: AS_OF,
    })).rejects.toThrow("fixture PostgreSQL is intentionally unavailable");
    expect(layer.transactionImmediate).toHaveBeenCalledTimes(1);

    await expect(runtime.recovery.recoverDanglingClaims({
      contractVersion: ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
      projectId: PROJECT_ID,
      recoveryOperationId: "recover-runtime-capacity",
      recovererId: "room-worker-runtime",
      asOf: AS_OF,
    })).resolves.toEqual({
      action: "held",
      recoveredClaimIds: [],
      replayedClaimIds: [],
      rejected: [],
    });
    expect(layer.transactionImmediate).toHaveBeenCalledTimes(2);
  });

  it("does not infer legacy occupancy or capacity while composing the runtime", () => {
    const store = taskStore();

    createRoomGlobalConcurrencyRuntime(configuration({ taskStore: store.store }));

    expect(store.listTasks).not.toHaveBeenCalled();
  });

  it("fails closed when the AsyncDataLayer project differs from the requested project", () => {
    expectRuntimeError(() => createRoomGlobalConcurrencyRuntime(configuration({
      layer: dataLayer("project-other").layer,
    })), "project_layer_mismatch");
  });

  it("fails closed when the TaskStore project differs from the requested project", () => {
    expectRuntimeError(() => createRoomGlobalConcurrencyRuntime(configuration({
      taskStore: taskStore("project-other").store,
    })), "project_store_mismatch");
  });

  it("requires a verified policy instead of defaulting capacity or reservations", () => {
    const missing = configuration();
    delete (missing as { verifiedPolicy?: unknown }).verifiedPolicy;

    expectRuntimeError(() => createRoomGlobalConcurrencyRuntime(missing), "policy_missing");
    expectRuntimeError(() => createRoomGlobalConcurrencyRuntime(configuration({
      verifiedPolicy: {
        ...verifiedPolicy(),
        policy: {
          ...verifiedPolicy().policy,
          totalSlots: null,
        },
      } as unknown as RoomGlobalConcurrencyVerifiedPolicyV1,
    })), "policy_invalid");

    const missingAdmission = verifiedPolicy();
    delete (missingAdmission as { controllerAdmission?: unknown }).controllerAdmission;
    expectRuntimeError(() => createRoomGlobalConcurrencyRuntime(configuration({
      verifiedPolicy: missingAdmission,
    })), "policy_missing");
  });
});

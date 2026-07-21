import {
  RoomHostCompositionOperatorPolicyAuthorityError,
  type RoomHostCompositionOperatorPolicyAuthorityRecordV1,
} from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import {
  createRoomHostCompositionOperatorPolicyProvider,
  type RoomHostCompositionOperatorAdapterRegistryV1,
} from "../room-host-composition-operator-policy-provider.js";
import type { RoomHostCompositionContextV1 } from "../room-host-composition.js";

const TEST_NOW_MS = Date.parse("2026-07-20T00:10:00.000Z");

function createAuthorityRecord(
  overrides: Partial<RoomHostCompositionOperatorPolicyAuthorityRecordV1> = {},
): RoomHostCompositionOperatorPolicyAuthorityRecordV1 {
  return {
    contractVersion: 1,
    projectId: "project-1",
    hostId: "windows-host-1",
    bundleId: "room-policy-bundle-1",
    issuer: "fusion-operator",
    policy: {
      connectorIds: ["claude", "happier"],
      controllerAdmission: {
        workClass: "normal",
        slots: 2,
      },
      adapterBindings: {
        capabilityObservationAdapterId: "capability-adapter-1",
        providerAdmissionSnapshotAdapterId: "provider-adapter-1",
        capacityTelemetryAdapterId: "capacity-adapter-1",
        roomWorkerAuthorityAdapterId: "worker-authority-adapter-1",
      },
    },
    policyHash: "policy-hash-1",
    revision: 3,
    issuedAt: "2026-07-20T00:00:00.000Z",
    updatedAt: "2026-07-20T00:01:00.000Z",
    expiresAt: "2026-07-20T01:00:00.000Z",
    revokedAt: null,
    revokedReason: null,
    ...overrides,
  };
}

function createContext(
  overrides: Partial<RoomHostCompositionContextV1> = {},
): RoomHostCompositionContextV1 {
  const connectorRegistry = overrides.connectorRegistry ?? {
    ids: () => ["claude", "happier"],
  } as never;
  return {
    projectId: "project-1",
    taskStore: {} as never,
    asyncLayer: {} as never,
    roomStore: {} as never,
    connectorRegistry,
    connectorIds: Object.freeze(["claude", "happier"]),
    hostId: "windows-host-1",
    ...overrides,
  };
}

function createAdapterRegistry(
  overrides: Partial<RoomHostCompositionOperatorAdapterRegistryV1> = {},
): RoomHostCompositionOperatorAdapterRegistryV1 {
  return {
    resolve: vi.fn(async () => ({
      state: "ready",
      dependencies: {
        providerBackpressureVerifiedFactory: vi.fn(),
        capabilityRegistryRefreshVerifiedFactory: vi.fn(),
        taskDispatchCapacityAdmissionVerifiedFactory: vi.fn(),
      },
    })),
    ...overrides,
  };
}

describe("createRoomHostCompositionOperatorPolicyProvider", () => {
  it("binds one current central operator record to the exact host and connector inventory before exposing every verified Room seam", async () => {
    const record = createAuthorityRecord();
    const authorityReader = {
      readRoomHostCompositionOperatorPolicyAuthorityV1: vi.fn(async () => record),
    };
    const adapterRegistry = createAdapterRegistry();
    const provider = createRoomHostCompositionOperatorPolicyProvider({
      authorityReader,
      adapterRegistry,
      nowMs: () => TEST_NOW_MS,
    });
    const context = createContext();

    const result = await provider.resolve(context);

    expect(authorityReader.readRoomHostCompositionOperatorPolicyAuthorityV1).toHaveBeenCalledWith({
      projectId: "project-1",
      hostId: "windows-host-1",
    });
    expect(adapterRegistry.resolve).toHaveBeenCalledWith({
      authorityRecord: record,
      roomContext: context,
    });
    expect(result).toMatchObject({
      state: "ready",
      composition: {
        globalConcurrencyVerifiedPolicy: {
          controllerAdmission: { workClass: "normal", slots: 2 },
          verifiedAt: "2026-07-20T00:01:00.000Z",
          verificationId: "policy-hash-1",
        },
        authority: {
          bundleId: "room-policy-bundle-1",
          issuer: "fusion-operator",
          revision: 3,
          projectId: "project-1",
          hostId: "windows-host-1",
          connectorIds: ["claude", "happier"],
          issuedAt: "2026-07-20T00:00:00.000Z",
          expiresAt: "2026-07-20T01:00:00.000Z",
        },
      },
    });
  });

  it("rechecks the central record for an already-started bundle and fences revocation, replacement, or connector-inventory drift", async () => {
    const initial = createAuthorityRecord();
    let current = initial;
    const authorityReader = {
      readRoomHostCompositionOperatorPolicyAuthorityV1: vi.fn(async () => current),
    };
    const provider = createRoomHostCompositionOperatorPolicyProvider({
      authorityReader,
      adapterRegistry: createAdapterRegistry(),
      nowMs: () => TEST_NOW_MS,
    });
    const connectorIds = vi.fn(() => ["claude", "happier"]);
    const connectorRegistry = {
      ids: connectorIds,
    } as never;
    const resolution = await provider.resolve(createContext({ connectorRegistry }));
    if (resolution.state !== "ready") throw new Error("expected a ready central operator policy");
    const guard = resolution.composition.authority.guard;
    if (!guard) throw new Error("expected a live authority guard");

    await expect(guard.assertCurrent()).resolves.toEqual({ state: "current" });

    current = createAuthorityRecord({
      revision: 4,
      policyHash: "policy-hash-2",
      updatedAt: "2026-07-20T00:02:00.000Z",
    });
    await expect(guard.assertCurrent()).resolves.toEqual({
      state: "withheld",
      reason: "operator_policy_changed",
    });

    current = initial;
    connectorIds.mockReturnValueOnce(["happier"]);
    await expect(guard.assertCurrent()).resolves.toEqual({
      state: "withheld",
      reason: "operator_policy_connector_set_mismatch",
    });

    connectorIds.mockImplementationOnce(() => {
      throw new Error("connector inventory transport unavailable");
    });
    await expect(guard.assertCurrent()).resolves.toEqual({
      state: "withheld",
      reason: "operator_policy_connector_inventory_unavailable",
    });
  });

  it("withholds before adapter resolution when the central record does not exactly match the live connector set", async () => {
    const authorityReader = {
      readRoomHostCompositionOperatorPolicyAuthorityV1: vi.fn(async () => createAuthorityRecord({
        policy: {
          ...createAuthorityRecord().policy,
          connectorIds: ["happier"],
        },
      })),
    };
    const adapterRegistry = createAdapterRegistry();
    const provider = createRoomHostCompositionOperatorPolicyProvider({
      authorityReader,
      adapterRegistry,
      nowMs: () => TEST_NOW_MS,
    });

    await expect(provider.resolve(createContext())).resolves.toEqual({
      state: "withheld",
      reason: "operator_policy_connector_set_mismatch",
    });
    expect(adapterRegistry.resolve).not.toHaveBeenCalled();
  });

  it("turns known authority lifecycle failures into safe operational reasons without exposing arbitrary read failures", async () => {
    const adapterRegistry = createAdapterRegistry();
    const notInstalled = createRoomHostCompositionOperatorPolicyProvider({
      authorityReader: {
        readRoomHostCompositionOperatorPolicyAuthorityV1: vi.fn(async () => {
          throw new RoomHostCompositionOperatorPolicyAuthorityError(
            "Room host composition authority is not installed",
          );
        }),
      },
      adapterRegistry,
      nowMs: () => TEST_NOW_MS,
    });
    const opaqueFailure = createRoomHostCompositionOperatorPolicyProvider({
      authorityReader: {
        readRoomHostCompositionOperatorPolicyAuthorityV1: vi.fn(async () => {
          throw new Error("connection string=do-not-leak");
        }),
      },
      adapterRegistry,
      nowMs: () => TEST_NOW_MS,
    });

    await expect(notInstalled.resolve(createContext())).resolves.toEqual({
      state: "withheld",
      reason: "operator_policy_not_installed",
    });
    await expect(opaqueFailure.resolve(createContext())).resolves.toEqual({
      state: "withheld",
      reason: "operator_policy_read_failed",
    });
    expect(adapterRegistry.resolve).not.toHaveBeenCalled();
  });

  it("keeps an incomplete, throwing, or secret-bearing adapter result fail-closed", async () => {
    const record = createAuthorityRecord();
    const authorityReader = {
      readRoomHostCompositionOperatorPolicyAuthorityV1: vi.fn(async () => record),
    };
    const withheld = createRoomHostCompositionOperatorPolicyProvider({
      authorityReader,
      adapterRegistry: createAdapterRegistry({
        resolve: vi.fn(async () => ({ state: "withheld", reason: "oauth token=not-for-logs" })),
      }),
      nowMs: () => TEST_NOW_MS,
    });
    const throwing = createRoomHostCompositionOperatorPolicyProvider({
      authorityReader,
      adapterRegistry: createAdapterRegistry({
        resolve: vi.fn(async () => { throw new Error("adapter bearer=not-for-logs"); }),
      }),
      nowMs: () => TEST_NOW_MS,
    });
    const incomplete = createRoomHostCompositionOperatorPolicyProvider({
      authorityReader,
      adapterRegistry: createAdapterRegistry({
        resolve: vi.fn(async () => ({ state: "ready", dependencies: {} } as never)),
      }),
      nowMs: () => TEST_NOW_MS,
    });

    await expect(withheld.resolve(createContext())).resolves.toEqual({
      state: "withheld",
      reason: "operator_adapter_withheld",
    });
    await expect(throwing.resolve(createContext())).resolves.toEqual({
      state: "withheld",
      reason: "operator_adapter_resolution_failed",
    });
    await expect(incomplete.resolve(createContext())).resolves.toEqual({
      state: "withheld",
      reason: "operator_adapter_dependencies_invalid",
    });
  });
});

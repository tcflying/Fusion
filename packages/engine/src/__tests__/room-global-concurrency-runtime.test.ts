import {
  GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
  type GlobalCapacityLedgerPostgresPortsV1,
  type GlobalCapacityPolicyAuthorityV1,
} from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import {
  ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
  type RoomGlobalConcurrencyAcquireInputV1,
} from "../room-global-concurrency-accounting.js";
import {
  createRoomGlobalConcurrencyRuntime,
  RoomGlobalConcurrencyRuntimeError,
  type CreateRoomGlobalConcurrencyRuntimeInputV1,
  type RoomGlobalConcurrencyVerifiedPolicyV1,
} from "../room-global-concurrency-runtime.js";

const PROJECT_ID = "project-room-global-runtime";
const AS_OF = "2026-07-20T00:00:00.000Z";
const EXPIRES_AT = "2026-07-20T00:05:00.000Z";

function verifiedPolicy(): RoomGlobalConcurrencyVerifiedPolicyV1 {
  return {
    controllerAdmission: {
      workClass: "normal",
      slots: 1,
      createClaimId: () => "capacity-claim-from-verified-policy",
    },
    verifiedAt: AS_OF,
    verificationId: "host-room-controller-admission-20260720",
  };
}

function createPorts(): {
  readonly ports: GlobalCapacityLedgerPostgresPortsV1;
  readonly acquire: ReturnType<typeof vi.fn>;
  readonly renew: ReturnType<typeof vi.fn>;
  readonly release: ReturnType<typeof vi.fn>;
  readonly readSnapshot: ReturnType<typeof vi.fn>;
} {
  const acquire = vi.fn(async () => ({
    action: "acquired" as const,
    reason: "capacity_admitted" as const,
    replayed: false,
    claimId: "room-claim-a",
    fence: 4,
  }));
  const renew = vi.fn(async () => ({
    action: "renewed" as const,
    reason: "capacity_renewed" as const,
    replayed: false,
    claimId: "room-claim-a",
    fence: 4,
  }));
  const release = vi.fn(async () => ({
    action: "released" as const,
    reason: "capacity_released" as const,
    replayed: false,
    claimId: "room-claim-a",
    fence: 4,
  }));
  const readSnapshot = vi.fn(async () => ({ totalSlots: 4 }));
  return {
    ports: { acquire, renew, release, readSnapshot } as unknown as GlobalCapacityLedgerPostgresPortsV1,
    acquire,
    renew,
    release,
    readSnapshot,
  };
}

function authority(ports: GlobalCapacityLedgerPostgresPortsV1): {
  readonly authority: GlobalCapacityPolicyAuthorityV1;
  readonly createProjectPorts: ReturnType<typeof vi.fn>;
} {
  const createProjectPorts = vi.fn(() => ports);
  return {
    authority: {
      contractVersion: 1,
      policy: {
        reservations: { verifierSlots: 1, recoverySlots: 1, legacyTaskTriageSlots: 1 },
        snapshotTtlMs: 60_000,
        leaseTtlMs: 300_000,
      },
      policyHash: `sha256:${"a".repeat(64)}`,
      revision: 1,
      updatedAt: AS_OF,
      createProjectPorts,
    },
    createProjectPorts,
  };
}

function configuration(
  overrides: Partial<CreateRoomGlobalConcurrencyRuntimeInputV1> = {},
): CreateRoomGlobalConcurrencyRuntimeInputV1 {
  const fixture = createPorts();
  return {
    projectId: PROJECT_ID,
    globalCapacityAuthority: authority(fixture.ports).authority,
    verifiedPolicy: verifiedPolicy(),
    ...overrides,
  };
}

function acquireInput(overrides: Partial<RoomGlobalConcurrencyAcquireInputV1> = {}): RoomGlobalConcurrencyAcquireInputV1 {
  return {
    contractVersion: ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
    projectId: PROJECT_ID,
    roomId: "room-a",
    claimId: "room-claim-a",
    operationId: "room-acquire-a",
    workClass: "normal",
    slots: 1,
    holderId: "room-worker-a",
    leaseId: "room-lease-a",
    fence: 4,
    asOf: AS_OF,
    expiresAt: EXPIRES_AT,
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
  it("translates the Room controller fence into exactly one CentralCore room_worker claim", async () => {
    const fixture = createPorts();
    const trusted = authority(fixture.ports);
    const policy = verifiedPolicy();
    const runtime = createRoomGlobalConcurrencyRuntime(configuration({
      globalCapacityAuthority: trusted.authority,
      verifiedPolicy: policy,
    }));

    expect(trusted.createProjectPorts).toHaveBeenCalledWith(PROJECT_ID);
    expect(runtime.capacityAdmission).toMatchObject({
      workClass: "normal",
      slots: 1,
      leaseTtlMs: 300_000,
      renewalIntervalMs: 100_000,
    });
    expect(runtime.capacityAdmission.createClaimId).toBe(policy.controllerAdmission.createClaimId);

    await expect(runtime.capacityAdmission.globalAccounting.acquire(acquireInput())).resolves.toEqual({
      action: "acquired",
      reason: "capacity_admitted",
      replayed: false,
      claimId: "room-claim-a",
      fence: 4,
    });
    expect(fixture.acquire).toHaveBeenCalledWith({
      contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
      projectId: PROJECT_ID,
      resourceKind: "room_worker",
      resourceId: "room-a",
      claimId: "room-claim-a",
      operationId: "room-acquire-a",
      workClass: "normal",
      slots: 1,
      holderId: "room-worker-a",
      leaseId: "room-lease-a",
      fence: 4,
      asOf: AS_OF,
      expiresAt: EXPIRES_AT,
    });
  });

  it("preserves fenced renew and release while translating central completion reasons", async () => {
    const fixture = createPorts();
    const runtime = createRoomGlobalConcurrencyRuntime(configuration({
      globalCapacityAuthority: authority(fixture.ports).authority,
    }));
    const accounting = runtime.capacityAdmission.globalAccounting;

    await expect(accounting.renew({
      ...acquireInput(),
      operationId: "room-renew-a",
    })).resolves.toMatchObject({ action: "renewed", reason: "capacity_admitted", claimId: "room-claim-a", fence: 4 });
    await expect(accounting.release({
      ...acquireInput(),
      operationId: "room-release-a",
    })).resolves.toMatchObject({ action: "released", reason: "capacity_admitted", claimId: "room-claim-a", fence: 4 });

    expect(fixture.renew).toHaveBeenCalledWith(expect.objectContaining({
      resourceKind: "room_worker",
      resourceId: "room-a",
      operationId: "room-renew-a",
    }));
    expect(fixture.release).toHaveBeenCalledWith(expect.objectContaining({
      resourceKind: "room_worker",
      resourceId: "room-a",
      operationId: "room-release-a",
    }));
  });

  it("surfaces the explicit legacy-ledger cutover hold instead of guessing free capacity", async () => {
    const fixture = createPorts();
    fixture.acquire.mockResolvedValueOnce({
      action: "held",
      reason: "legacy_room_migration_pending",
      replayed: false,
      claimId: null,
      fence: null,
    });
    const runtime = createRoomGlobalConcurrencyRuntime(configuration({
      globalCapacityAuthority: authority(fixture.ports).authority,
    }));

    await expect(runtime.capacityAdmission.globalAccounting.acquire(acquireInput())).resolves.toMatchObject({
      action: "held",
      reason: "legacy_room_migration_pending",
    });
  });

  it("refreshes only a pre-side-effect policy-mismatch acquire and reuses the exact fenced request", async () => {
    const stale = createPorts();
    stale.acquire.mockResolvedValueOnce({
      action: "held",
      reason: "policy_mismatch",
      replayed: false,
      claimId: null,
      fence: null,
    });
    const fresh = createPorts();
    const staleAuthority = authority(stale.ports);
    const freshAuthority = authority(fresh.ports);
    const refreshedAuthority = {
      ...freshAuthority.authority,
      policyHash: `sha256:${"b".repeat(64)}`,
      revision: 2,
    } as GlobalCapacityPolicyAuthorityV1;
    const refreshGlobalCapacityAuthority = vi.fn(async () => refreshedAuthority);
    const runtime = createRoomGlobalConcurrencyRuntime(configuration({
      globalCapacityAuthority: staleAuthority.authority,
      refreshGlobalCapacityAuthority,
    }));

    await expect(runtime.capacityAdmission.globalAccounting.acquire(acquireInput())).resolves.toMatchObject({
      action: "acquired",
      reason: "capacity_admitted",
      claimId: "room-claim-a",
    });
    expect(refreshGlobalCapacityAuthority).toHaveBeenCalledTimes(1);
    expect(freshAuthority.createProjectPorts).toHaveBeenCalledWith(PROJECT_ID);
    expect(fresh.acquire).toHaveBeenCalledWith(expect.objectContaining({
      operationId: "room-acquire-a",
      resourceKind: "room_worker",
      resourceId: "room-a",
      fence: 4,
    }));
  });

  it("uses the central snapshot only to fail closed recovery and never reruns a Room worker", async () => {
    const fixture = createPorts();
    const runtime = createRoomGlobalConcurrencyRuntime(configuration({
      globalCapacityAuthority: authority(fixture.ports).authority,
    }));
    const recoveryInput = {
      contractVersion: ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
      projectId: PROJECT_ID,
      recoveryOperationId: "recover-room-capacity",
      recovererId: "room-worker-runtime",
      asOf: AS_OF,
    } as const;

    await expect(runtime.recovery.recoverDanglingClaims(recoveryInput)).resolves.toMatchObject({ action: "recovered" });
    expect(fixture.readSnapshot).toHaveBeenCalledWith({
      contractVersion: GLOBAL_CAPACITY_LEDGER_POSTGRES_CONTRACT_VERSION,
      projectId: PROJECT_ID,
      asOf: AS_OF,
    });

    fixture.readSnapshot.mockResolvedValueOnce({ totalSlots: null });
    await expect(runtime.recovery.recoverDanglingClaims(recoveryInput)).resolves.toMatchObject({ action: "held" });
  });

  it("rejects a fabricated central authority, invalid controller slots, or a second capacity policy", () => {
    expectRuntimeError(() => createRoomGlobalConcurrencyRuntime(configuration({
      globalCapacityAuthority: {} as GlobalCapacityPolicyAuthorityV1,
    })), "central_authority_invalid");

    expectRuntimeError(() => createRoomGlobalConcurrencyRuntime(configuration({
      verifiedPolicy: {
        ...verifiedPolicy(),
        controllerAdmission: { workClass: "normal", slots: 0 },
      },
    })), "policy_invalid");

    expectRuntimeError(() => createRoomGlobalConcurrencyRuntime(configuration({
      verifiedPolicy: {
        ...verifiedPolicy(),
        policy: { totalSlots: 99 },
      } as never,
    })), "policy_invalid");

    const fixture = createPorts();
    const shortAuthority = authority(fixture.ports).authority;
    expectRuntimeError(() => createRoomGlobalConcurrencyRuntime(configuration({
      globalCapacityAuthority: {
        ...shortAuthority,
        policy: { ...shortAuthority.policy, leaseTtlMs: 1 },
      },
    })), "central_authority_invalid");
  });
});

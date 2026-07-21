import { describe, expect, it } from "vitest";

import {
  ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
  RoomGlobalConcurrencyAccounting,
  type RoomGlobalConcurrencyAcquireInputV1,
  type RoomGlobalConcurrencyClaimStoreCommandV1,
  type RoomGlobalConcurrencyClaimStorePortV1,
  type RoomGlobalConcurrencyClaimStoreResultV1,
  type RoomGlobalConcurrencyClaimV1,
  type RoomGlobalConcurrencyRenewInputV1,
  type RoomGlobalConcurrencyReleaseInputV1,
  type RoomGlobalConcurrencySnapshotPortV1,
  type RoomGlobalConcurrencySnapshotV1,
} from "../room-global-concurrency-accounting.js";

const AS_OF = "2026-07-19T14:00:00.000Z";
const EXPIRES_AT = "2026-07-19T14:05:00.000Z";
const PROJECT_A = "project-concurrency-a";
const PROJECT_B = "project-concurrency-b";
const ROOM_A = "room-concurrency-a";

function claim(overrides: Partial<RoomGlobalConcurrencyClaimV1> = {}): RoomGlobalConcurrencyClaimV1 {
  return {
    claimId: "room-claim-existing",
    projectId: PROJECT_A,
    roomId: ROOM_A,
    workClass: "normal",
    slots: 3,
    holderId: "room-worker-a",
    leaseId: "room-lease-a",
    fence: 2,
    acquiredAt: "2026-07-19T13:59:00.000Z",
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

function snapshot(overrides: Partial<RoomGlobalConcurrencySnapshotV1> = {}): RoomGlobalConcurrencySnapshotV1 {
  return {
    contractVersion: ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
    snapshotId: "central-concurrency-snapshot-1",
    observedAt: AS_OF,
    expiresAt: EXPIRES_AT,
    totalSlots: 10,
    reservations: {
      verifierSlots: 2,
      recoverySlots: 1,
      legacyTaskTriageSlots: 4,
    },
    legacy: {
      activeTaskSlots: 2,
      activeTriageSlots: 1,
      queuedTaskSlots: 2,
      queuedTriageSlots: 1,
    },
    roomClaims: [],
    ...overrides,
  };
}

function acquire(overrides: Partial<RoomGlobalConcurrencyAcquireInputV1> = {}): RoomGlobalConcurrencyAcquireInputV1 {
  return {
    contractVersion: ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
    projectId: PROJECT_A,
    roomId: ROOM_A,
    claimId: "room-claim-new",
    operationId: "room-acquire-operation-1",
    workClass: "normal",
    slots: 3,
    holderId: "room-worker-a",
    leaseId: "room-lease-new",
    fence: 1,
    asOf: AS_OF,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

function release(overrides: Partial<RoomGlobalConcurrencyReleaseInputV1> = {}): RoomGlobalConcurrencyReleaseInputV1 {
  return {
    contractVersion: ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
    projectId: PROJECT_A,
    roomId: ROOM_A,
    claimId: "room-claim-existing",
    operationId: "room-release-operation-1",
    holderId: "room-worker-a",
    leaseId: "room-lease-a",
    fence: 2,
    asOf: AS_OF,
    ...overrides,
  };
}

function renew(overrides: Partial<RoomGlobalConcurrencyRenewInputV1> = {}): RoomGlobalConcurrencyRenewInputV1 {
  return {
    contractVersion: ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
    projectId: PROJECT_A,
    roomId: ROOM_A,
    claimId: "room-claim-existing",
    operationId: "room-renew-operation-1",
    holderId: "room-worker-a",
    leaseId: "room-lease-a",
    fence: 2,
    asOf: AS_OF,
    expiresAt: "2026-07-19T14:10:00.000Z",
    ...overrides,
  };
}

function successFor(command: RoomGlobalConcurrencyClaimStoreCommandV1, replayed = false): RoomGlobalConcurrencyClaimStoreResultV1 {
  return {
    ok: true,
    action: command.kind === "acquire"
      ? "acquired"
      : command.kind === "renew"
        ? "renewed"
        : command.kind === "release"
          ? "released"
          : "recovered",
    replayed,
    claimId: command.claimId,
    fence: command.fence,
  };
}

function ports(
  current: RoomGlobalConcurrencySnapshotV1,
  respond: (command: RoomGlobalConcurrencyClaimStoreCommandV1) => RoomGlobalConcurrencyClaimStoreResultV1 = successFor,
): {
  readonly snapshotPort: RoomGlobalConcurrencySnapshotPortV1;
  readonly claimStore: RoomGlobalConcurrencyClaimStorePortV1;
  readonly commands: RoomGlobalConcurrencyClaimStoreCommandV1[];
} {
  const commands: RoomGlobalConcurrencyClaimStoreCommandV1[] = [];
  return {
    snapshotPort: {
      readSnapshot: async () => current,
    },
    claimStore: {
      apply: async (command) => {
        commands.push(command);
        return respond(command);
      },
    },
    commands,
  };
}

describe("Room global concurrency accounting", () => {
  it("uses one global budget while preserving the configured legacy task/triage reserve", async () => {
    const fixture = ports(snapshot());
    const accounting = new RoomGlobalConcurrencyAccounting(fixture);

    const result = await accounting.acquire(acquire());

    expect(result).toMatchObject({
      action: "acquired",
      replayed: false,
      reason: "capacity_admitted",
      claimId: "room-claim-new",
      fence: 1,
    });
    expect(fixture.commands).toHaveLength(1);
    expect(fixture.commands[0]).toMatchObject({
      kind: "acquire",
      expectedSnapshotId: "central-concurrency-snapshot-1",
      budget: {
        totalSlots: 10,
        occupiedSlots: 3,
        normalLimitSlots: 6,
        protectedLegacyTaskTriageSlots: 1,
      },
    });
  });

  it("holds normal Room work rather than consuming slots reserved for legacy task/triage work", async () => {
    const fixture = ports(snapshot({ roomClaims: [claim()] }));
    const accounting = new RoomGlobalConcurrencyAccounting(fixture);

    const result = await accounting.acquire(acquire({ slots: 1 }));

    expect(result).toMatchObject({ action: "held", reason: "legacy_task_triage_reserve_protected" });
    expect(fixture.commands).toEqual([]);
  });

  it("keeps verifier and recovery reservations unavailable to normal Room work", async () => {
    const current = snapshot({
      totalSlots: 8,
      reservations: {
        verifierSlots: 2,
        recoverySlots: 1,
        legacyTaskTriageSlots: 0,
      },
      legacy: {
        activeTaskSlots: 0,
        activeTriageSlots: 0,
        queuedTaskSlots: 0,
        queuedTriageSlots: 0,
      },
      roomClaims: [claim({ slots: 5 })],
    });
    const normal = ports(current);
    const verifier = ports(current);

    const normalResult = await new RoomGlobalConcurrencyAccounting(normal).acquire(acquire({ slots: 1 }));
    const verifierResult = await new RoomGlobalConcurrencyAccounting(verifier).acquire(acquire({
      claimId: "room-claim-verifier",
      operationId: "room-acquire-verifier",
      workClass: "verifier",
      slots: 1,
    }));

    expect(normalResult).toMatchObject({ action: "held", reason: "reserved_capacity_protected" });
    expect(normal.commands).toEqual([]);
    expect(verifierResult).toMatchObject({ action: "acquired", reason: "capacity_admitted" });
    expect(verifier.commands).toHaveLength(1);
  });

  it("fails closed when the capacity source is unknown or stale", async () => {
    const unknown = ports(snapshot({ totalSlots: null }));
    const stale = ports(snapshot({
      observedAt: "2026-07-19T13:58:00.000Z",
      expiresAt: "2026-07-19T13:59:59.999Z",
    }));

    const unknownResult = await new RoomGlobalConcurrencyAccounting(unknown).acquire(acquire());
    const staleResult = await new RoomGlobalConcurrencyAccounting(stale).acquire(acquire());

    expect(unknownResult).toMatchObject({ action: "held", reason: "capacity_unknown" });
    expect(staleResult).toMatchObject({ action: "held", reason: "capacity_stale" });
    expect(unknown.commands).toEqual([]);
    expect(stale.commands).toEqual([]);
  });

  it("replays an identical acquire through the durable store rather than creating a second claim", async () => {
    const existing = claim({
      claimId: "room-claim-new",
      leaseId: "room-lease-new",
      fence: 1,
      slots: 3,
    });
    const fixture = ports(snapshot({ roomClaims: [existing] }), (command) => successFor(command, true));
    const accounting = new RoomGlobalConcurrencyAccounting(fixture);

    const result = await accounting.acquire(acquire());

    expect(result).toMatchObject({ action: "acquired", replayed: true, claimId: "room-claim-new" });
    expect(fixture.commands).toHaveLength(1);
  });

  it("rejects a durable-store success that changes the fenced claim identity", async () => {
    const fixture = ports(snapshot(), (command) => ({
      ok: true,
      action: "acquired",
      replayed: false,
      claimId: `${command.claimId}-altered`,
      fence: command.fence + 1,
    }));
    const accounting = new RoomGlobalConcurrencyAccounting(fixture);

    const result = await accounting.acquire(acquire());

    expect(result).toMatchObject({ action: "held", reason: "store_rejected", claimId: null, fence: null });
    expect(fixture.commands).toHaveLength(1);
  });

  it("refuses cross-project release and stale fences before the durable store is called", async () => {
    const fixture = ports(snapshot({ roomClaims: [claim()] }));
    const accounting = new RoomGlobalConcurrencyAccounting(fixture);

    const crossProject = await accounting.release(release({ projectId: PROJECT_B }));
    const staleFence = await accounting.release(release({ fence: 1 }));

    expect(crossProject).toMatchObject({ action: "rejected", reason: "project_isolation" });
    expect(staleFence).toMatchObject({ action: "rejected", reason: "stale_fence" });
    expect(fixture.commands).toEqual([]);
  });

  it("makes matching release idempotent through the fenced durable store", async () => {
    const fixture = ports(snapshot({ roomClaims: [claim()] }), (command) => successFor(command, true));
    const accounting = new RoomGlobalConcurrencyAccounting(fixture);

    const result = await accounting.release(release());

    expect(result).toMatchObject({ action: "released", replayed: true, claimId: "room-claim-existing", fence: 2 });
    expect(fixture.commands).toHaveLength(1);
    expect(fixture.commands[0]).toMatchObject({ kind: "release", expectedSnapshotId: "central-concurrency-snapshot-1" });
  });

  it("renews the matching fenced claim and treats an older target expiry as an idempotent replay without shortening it", async () => {
    const fixture = ports(snapshot({ roomClaims: [claim()] }), (command) => successFor(command, true));
    const accounting = new RoomGlobalConcurrencyAccounting(fixture);

    const extended = await accounting.renew(renew());
    const olderReplay = await accounting.renew(renew({
      operationId: "room-renew-operation-stale",
      expiresAt: "2026-07-19T14:01:00.000Z",
    }));

    expect(extended).toMatchObject({
      action: "renewed",
      replayed: true,
      claimId: "room-claim-existing",
      fence: 2,
    });
    expect(olderReplay).toMatchObject({
      action: "renewed",
      replayed: true,
      claimId: "room-claim-existing",
      fence: 2,
    });
    expect(fixture.commands).toHaveLength(1);
    expect(fixture.commands[0]).toMatchObject({
      kind: "renew",
      expectedSnapshotId: "central-concurrency-snapshot-1",
      request: renew(),
    });
  });

  it("fails closed before the durable store when a renewal uses a stale claim fence", async () => {
    const fixture = ports(snapshot({ roomClaims: [claim()] }));
    const accounting = new RoomGlobalConcurrencyAccounting(fixture);

    const result = await accounting.renew(renew({ fence: 1 }));

    expect(result).toMatchObject({ action: "rejected", reason: "stale_fence" });
    expect(fixture.commands).toEqual([]);
  });

  it("preserves a durable renewal expiry failure instead of collapsing it into an unrelated store error", async () => {
    const fixture = ports(snapshot({ roomClaims: [claim()] }), () => ({
      ok: false,
      reason: "renewal_regression",
    }));
    const accounting = new RoomGlobalConcurrencyAccounting(fixture);

    const result = await accounting.renew(renew());

    expect(result).toMatchObject({ action: "held", reason: "renewal_regression" });
    expect(fixture.commands).toHaveLength(1);
  });

  it("recovers only expired claims within the requested project and carries their fence to the store", async () => {
    const expired = claim({ claimId: "room-claim-expired", slots: 1, expiresAt: AS_OF });
    const fresh = claim({ claimId: "room-claim-fresh", slots: 1, expiresAt: EXPIRES_AT });
    const otherProject = claim({ claimId: "room-claim-other-project", projectId: PROJECT_B, roomId: "room-concurrency-b", slots: 1, expiresAt: AS_OF });
    const fixture = ports(snapshot({ roomClaims: [expired, fresh, otherProject] }));
    const accounting = new RoomGlobalConcurrencyAccounting(fixture);

    const result = await accounting.recoverDanglingClaims({
      contractVersion: ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
      projectId: PROJECT_A,
      recoveryOperationId: "room-recover-operation-1",
      recovererId: "room-recovery-worker-a",
      asOf: AS_OF,
    });

    expect(result).toEqual({
      action: "recovered",
      recoveredClaimIds: ["room-claim-expired"],
      replayedClaimIds: [],
      rejected: [],
    });
    expect(fixture.commands).toHaveLength(1);
    expect(fixture.commands[0]).toMatchObject({
      kind: "recover_dangling",
      claimId: "room-claim-expired",
      fence: 2,
      recoveryOperationId: "room-recover-operation-1",
    });
  });
});

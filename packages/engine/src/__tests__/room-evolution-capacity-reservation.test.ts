import { describe, expect, it } from "vitest";

import {
  ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
  RoomGlobalConcurrencyAccounting,
  type RoomGlobalConcurrencyClaimStoreCommandV1,
  type RoomGlobalConcurrencyClaimStorePortV1,
  type RoomGlobalConcurrencyClaimStoreResultV1,
  type RoomGlobalConcurrencySnapshotPortV1,
  type RoomGlobalConcurrencySnapshotV1,
} from "../room-global-concurrency-accounting.js";
import {
  decideRoomProviderBackpressure,
  type RoomProviderBackpressureControllerInputV1,
  type RoomProviderBackpressureScopeV1,
} from "../room-provider-backpressure-controller.js";
import {
  ROOM_EVOLUTION_CAPACITY_RESERVATION_CONTRACT_VERSION,
  RoomEvolutionCapacityReservation,
  type RoomEvolutionCapacityReservationInputV1,
} from "../room-evolution-capacity-reservation.js";

const AS_OF = "2026-07-19T14:00:00.000Z";
const EXPIRES_AT = "2026-07-19T14:05:00.000Z";
const RELEASE_AT = "2026-07-19T14:01:00.000Z";
const PROJECT_ID = "project-evolution-capacity";
const ROOM_ID = "room-evolution-capacity";

function snapshot(overrides: Partial<RoomGlobalConcurrencySnapshotV1> = {}): RoomGlobalConcurrencySnapshotV1 {
  return {
    contractVersion: ROOM_GLOBAL_CONCURRENCY_ACCOUNTING_CONTRACT_VERSION,
    snapshotId: "evolution-capacity-snapshot-1",
    observedAt: AS_OF,
    expiresAt: EXPIRES_AT,
    totalSlots: 3,
    reservations: {
      verifierSlots: 0,
      recoverySlots: 1,
      legacyTaskTriageSlots: 0,
    },
    legacy: {
      activeTaskSlots: 0,
      activeTriageSlots: 0,
      queuedTaskSlots: 0,
      queuedTriageSlots: 0,
    },
    roomClaims: [],
    ...overrides,
  };
}

function successFor(command: RoomGlobalConcurrencyClaimStoreCommandV1): RoomGlobalConcurrencyClaimStoreResultV1 {
  return {
    ok: true,
    action: command.kind === "acquire" ? "acquired" : command.kind === "release" ? "released" : "recovered",
    replayed: false,
    claimId: command.claimId,
    fence: command.fence,
  };
}

function createFixture(current: RoomGlobalConcurrencySnapshotV1 = snapshot()): {
  readonly reservation: RoomEvolutionCapacityReservation;
  readonly commands: RoomGlobalConcurrencyClaimStoreCommandV1[];
  readonly providerInputs: RoomProviderBackpressureControllerInputV1[];
} {
  const commands: RoomGlobalConcurrencyClaimStoreCommandV1[] = [];
  const providerInputs: RoomProviderBackpressureControllerInputV1[] = [];
  const snapshotPort: RoomGlobalConcurrencySnapshotPortV1 = {
    readSnapshot: async () => current,
  };
  const claimStore: RoomGlobalConcurrencyClaimStorePortV1 = {
    apply: async (command) => {
      commands.push(command);
      return successFor(command);
    },
  };
  return {
    reservation: new RoomEvolutionCapacityReservation({
      globalCapacity: new RoomGlobalConcurrencyAccounting({ snapshotPort, claimStore }),
      providerBackpressure: {
        decide: (input) => {
          providerInputs.push(input);
          return decideRoomProviderBackpressure(input);
        },
      },
    }),
    commands,
    providerInputs,
  };
}

function request(
  overrides: {
    readonly priority?: RoomEvolutionCapacityReservationInputV1["priority"];
    readonly reservation?: Partial<RoomEvolutionCapacityReservationInputV1["reservation"]>;
    readonly provider?: Partial<RoomEvolutionCapacityReservationInputV1["provider"]>;
  } = {},
): RoomEvolutionCapacityReservationInputV1 {
  const scope: RoomProviderBackpressureScopeV1 = {
    providerId: "openai",
    accountId: "account-primary",
    modelId: "gpt-5",
    connectorId: "happier-codex",
    nodeId: "node-a",
  };
  return {
    contractVersion: ROOM_EVOLUTION_CAPACITY_RESERVATION_CONTRACT_VERSION,
    requestId: "evolution-capacity-request-1",
    priority: overrides.priority ?? "evolution_experiment",
    reservation: {
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      claimId: "evolution-capacity-claim-1",
      acquireOperationId: "evolution-capacity-acquire-1",
      releaseOperationId: "evolution-capacity-release-1",
      slots: 1,
      holderId: "evolution-worker-a",
      leaseId: "evolution-lease-a",
      fence: 1,
      asOf: AS_OF,
      expiresAt: EXPIRES_AT,
      ...overrides.reservation,
    },
    provider: {
      scope,
      telemetry: {
        known: true,
        observedAt: AS_OF,
        admissionConfirmed: true,
        activeRequests: 0,
      },
      policy: {
        concurrencyCap: 3,
        reservedVerifierSlots: 0,
        reservedRecoverySlots: 1,
        telemetryTtlMs: 30_000,
        failureThreshold: 2,
        maxRetryAttempts: 3,
        baseBackoffMs: 1_000,
        maxBackoffMs: 4_000,
        circuitOpenMs: 5_000,
      },
      allowHalfOpenProbe: false,
      ...overrides.provider,
    },
  };
}

describe("Room evolution capacity reservation", () => {
  it("queues an evolution experiment before it can consume the live recovery reserve", async () => {
    const fixture = createFixture(snapshot({
      roomClaims: [
        {
          claimId: "normal-claim-1",
          projectId: PROJECT_ID,
          roomId: ROOM_ID,
          workClass: "normal",
          slots: 2,
          holderId: "normal-worker-a",
          leaseId: "normal-lease-a",
          fence: 1,
          acquiredAt: "2026-07-19T13:59:00.000Z",
          expiresAt: EXPIRES_AT,
        },
      ],
    }));

    const result = await fixture.reservation.reserve(request());

    expect(result).toMatchObject({
      action: "queued",
      reason: "evolution_recovery_reserve_protected",
      receipt: null,
      global: { action: "held", reason: "reserved_capacity_protected" },
    });
    expect(fixture.commands).toEqual([]);
  });

  it("maps live recovery and critical control work to the protected recovery tier", async () => {
    const fixture = createFixture(snapshot({
      roomClaims: [
        {
          claimId: "normal-claim-1",
          projectId: PROJECT_ID,
          roomId: ROOM_ID,
          workClass: "normal",
          slots: 2,
          holderId: "normal-worker-a",
          leaseId: "normal-lease-a",
          fence: 1,
          acquiredAt: "2026-07-19T13:59:00.000Z",
          expiresAt: EXPIRES_AT,
        },
      ],
    }));

    const recovery = await fixture.reservation.reserve(request({
      priority: "live_recovery",
      reservation: { claimId: "recovery-claim-1", acquireOperationId: "recovery-acquire-1" },
      provider: {
        telemetry: { known: true, observedAt: AS_OF, admissionConfirmed: true, activeRequests: 2 },
      },
    }));
    const control = await fixture.reservation.reserve(request({
      priority: "critical_control",
      reservation: { claimId: "control-claim-1", acquireOperationId: "control-acquire-1" },
      provider: {
        telemetry: { known: true, observedAt: AS_OF, admissionConfirmed: true, activeRequests: 2 },
      },
    }));

    expect(recovery).toMatchObject({ action: "reserved", reason: "capacity_reserved" });
    expect(control).toMatchObject({ action: "reserved", reason: "capacity_reserved" });
    expect(fixture.providerInputs.map((input) => input.work.class)).toEqual(["recovery", "recovery"]);
    expect(fixture.commands.map((command) => command.kind === "acquire" && command.request.workClass)).toEqual([
      "recovery",
      "recovery",
    ]);
  });

  it("returns a release receipt that calls the durable release boundary only once", async () => {
    const fixture = createFixture();
    const reserved = await fixture.reservation.reserve(request());

    expect(reserved.action).toBe("reserved");
    if (reserved.receipt === null) throw new Error("expected a capacity release receipt");

    const first = await reserved.receipt.release(RELEASE_AT);
    const second = await reserved.receipt.release(RELEASE_AT);

    expect(first).toMatchObject({ action: "released", reason: "release_confirmed", replayed: false });
    expect(second).toMatchObject({ action: "released", reason: "release_confirmed", replayed: true });
    expect(fixture.commands.filter((command) => command.kind === "release")).toHaveLength(1);
  });

  it("rejects an invalid provider scope before it can issue a global capacity claim", async () => {
    const fixture = createFixture();
    const result = await fixture.reservation.reserve(request({
      provider: {
        scope: {
          providerId: " ",
          accountId: "account-primary",
          modelId: "gpt-5",
          connectorId: "happier-codex",
          nodeId: "node-a",
        },
      },
    }));

    expect(result).toMatchObject({
      action: "rejected",
      reason: "invalid_provider_scope",
      receipt: null,
    });
    expect(fixture.providerInputs).toEqual([]);
    expect(fixture.commands).toEqual([]);
  });
});

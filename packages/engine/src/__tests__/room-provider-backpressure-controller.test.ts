import { describe, expect, it } from "vitest";

import {
  ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
  decideRoomProviderBackpressure,
  type RoomProviderBackpressureControllerInputV1,
} from "../room-provider-backpressure-controller.js";

const AS_OF = "2026-07-19T10:00:00.000Z";

function fixture(
  overrides: Partial<RoomProviderBackpressureControllerInputV1> = {},
): RoomProviderBackpressureControllerInputV1 {
  return {
    contractVersion: ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
    asOf: AS_OF,
    scope: {
      providerId: "openai",
      accountId: "account-primary",
      modelId: "gpt-5",
      connectorId: "happier-codex",
      nodeId: "node-a",
    },
    work: {
      requestId: "request-1",
      class: "normal",
      allowHalfOpenProbe: false,
    },
    operation: { kind: "dispatch" },
    telemetry: {
      known: true,
      observedAt: AS_OF,
      admissionConfirmed: true,
      activeRequests: 0,
    },
    policy: {
      concurrencyCap: 8,
      reservedVerifierSlots: 2,
      reservedRecoverySlots: 1,
      telemetryTtlMs: 30_000,
      failureThreshold: 2,
      maxRetryAttempts: 4,
      baseBackoffMs: 1_000,
      maxBackoffMs: 4_000,
      circuitOpenMs: 5_000,
    },
    ...overrides,
  };
}

describe("decideRoomProviderBackpressure", () => {
  it("fails closed when telemetry is unknown and never infers admission from spare capacity", () => {
    const unknown = decideRoomProviderBackpressure(
      fixture({
        telemetry: {
          known: false,
          observedAt: AS_OF,
          admissionConfirmed: true,
          activeRequests: 0,
        },
      }),
    );
    const unconfirmed = decideRoomProviderBackpressure(
      fixture({
        telemetry: {
          known: true,
          observedAt: AS_OF,
          admissionConfirmed: false,
          activeRequests: 0,
        },
      }),
    );

    expect(unknown.decision).toMatchObject({ action: "hold", reason: "telemetry_unknown" });
    expect(unconfirmed.decision).toMatchObject({ action: "hold", reason: "admission_unconfirmed" });
  });

  it("uses only the supplied timestamps and fails closed on stale telemetry", () => {
    const result = decideRoomProviderBackpressure(
      fixture({
        asOf: "2026-07-19T10:00:30.001Z",
        telemetry: {
          known: true,
          observedAt: AS_OF,
          admissionConfirmed: true,
          activeRequests: 0,
        },
      }),
    );

    expect(result.decision).toMatchObject({ action: "hold", reason: "telemetry_stale" });
    expect(result.state.lastUpdatedAt).toBe("2026-07-19T10:00:30.001Z");
  });

  it("holds normal work for verifier and recovery slots while allowing the protected classes", () => {
    const normal = decideRoomProviderBackpressure(
      fixture({
        telemetry: { known: true, observedAt: AS_OF, admissionConfirmed: true, activeRequests: 5 },
      }),
    );
    const verifier = decideRoomProviderBackpressure(
      fixture({
        work: { requestId: "verify-1", class: "verifier", allowHalfOpenProbe: false },
        telemetry: { known: true, observedAt: AS_OF, admissionConfirmed: true, activeRequests: 5 },
      }),
    );
    const recovery = decideRoomProviderBackpressure(
      fixture({
        work: { requestId: "recover-1", class: "recovery", allowHalfOpenProbe: false },
        telemetry: { known: true, observedAt: AS_OF, admissionConfirmed: true, activeRequests: 7 },
      }),
    );

    expect(normal.decision).toMatchObject({ action: "hold", reason: "reserved_capacity" });
    expect(verifier.decision).toMatchObject({ action: "admit", reason: "capacity_confirmed" });
    expect(recovery.decision).toMatchObject({ action: "admit", reason: "capacity_confirmed" });
  });

  it("records retry-after plus bounded exponential backoff and opens after the threshold", () => {
    const first = decideRoomProviderBackpressure(
      fixture({
        operation: { kind: "failure", failureKind: "transient", retryAfterMs: 2_500 },
      }),
    );
    const second = decideRoomProviderBackpressure(
      fixture({
        state: first.state,
        operation: { kind: "failure", failureKind: "rate_limited", retryAfterMs: 500 },
      }),
    );

    expect(first.decision).toMatchObject({
      action: "recorded",
      reason: "failure_backoff",
      exponentialBackoffMs: 1_000,
      retryAfterMs: 2_500,
      retryDelayMs: 2_500,
    });
    expect(first.state).toMatchObject({ circuitState: "closed", retryAttempt: 1, consecutiveFailures: 1 });
    expect(second.decision).toMatchObject({
      action: "recorded",
      reason: "circuit_opened",
      exponentialBackoffMs: 2_000,
      retryDelayMs: 2_000,
    });
    expect(second.state).toMatchObject({ circuitState: "open", retryAttempt: 2, consecutiveFailures: 2 });
    expect(second.state.openUntil).toBe("2026-07-19T10:00:05.000Z");
  });

  it("enforces a one-at-a-time half-open probe and resets deterministically after success", () => {
    const opened = decideRoomProviderBackpressure(
      fixture({
        operation: { kind: "failure", failureKind: "rate_limited", retryAfterMs: 1_000 },
        state: {
          contractVersion: ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
          scopeKey: "[\"openai\",\"account-primary\",\"gpt-5\",\"happier-codex\",\"node-a\"]",
          circuitState: "closed",
          consecutiveFailures: 1,
          retryAttempt: 1,
          retryNotBefore: "2026-07-19T09:59:59.000Z",
          openUntil: null,
          halfOpenProbeInFlight: false,
          lastUpdatedAt: "2026-07-19T09:59:59.000Z",
        },
      }),
    );
    const stillOpen = decideRoomProviderBackpressure(
      fixture({ asOf: "2026-07-19T10:00:04.999Z", state: opened.state }),
    );
    const probe = decideRoomProviderBackpressure(
      fixture({
        asOf: "2026-07-19T10:00:05.000Z",
        state: opened.state,
        work: { requestId: "probe-1", class: "recovery", allowHalfOpenProbe: true },
      }),
    );
    const secondProbe = decideRoomProviderBackpressure(
      fixture({
        asOf: "2026-07-19T10:00:05.001Z",
        state: probe.state,
        work: { requestId: "probe-2", class: "recovery", allowHalfOpenProbe: true },
      }),
    );
    const recovered = decideRoomProviderBackpressure(
      fixture({
        asOf: "2026-07-19T10:00:05.002Z",
        state: probe.state,
        operation: { kind: "success" },
      }),
    );

    expect(stillOpen.decision).toMatchObject({ action: "hold", reason: "circuit_open" });
    expect(probe.decision).toMatchObject({ action: "admit", reason: "half_open_probe_admitted" });
    expect(probe.state).toMatchObject({ circuitState: "half_open", halfOpenProbeInFlight: true });
    expect(secondProbe.decision).toMatchObject({ action: "hold", reason: "half_open_probe_in_flight" });
    expect(recovered.decision).toMatchObject({ action: "recorded", reason: "success_recovered" });
    expect(recovered.state).toMatchObject({
      circuitState: "closed",
      consecutiveFailures: 0,
      retryAttempt: 0,
      retryNotBefore: null,
      openUntil: null,
      halfOpenProbeInFlight: false,
    });
  });

  it("rejects a state from any other exact provider/account/model/connector/node scope and freezes decisions", () => {
    const result = decideRoomProviderBackpressure(
      fixture({
        state: {
          contractVersion: ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
          scopeKey: "[\"openai\",\"account-secondary\",\"gpt-5\",\"happier-codex\",\"node-a\"]",
          circuitState: "closed",
          consecutiveFailures: 0,
          retryAttempt: 0,
          retryNotBefore: null,
          openUntil: null,
          halfOpenProbeInFlight: false,
          lastUpdatedAt: AS_OF,
        },
      }),
    );

    expect(result.decision).toMatchObject({ action: "hold", reason: "scope_state_mismatch" });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.decision)).toBe(true);
    expect(Object.isFrozen(result.state)).toBe(true);
  });
});

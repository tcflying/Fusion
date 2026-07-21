import {
  SESSION_CONNECTOR_CAPABILITIES,
  type SessionConnectorCapabilitiesV1,
  type SessionConnectorHealthV1,
  type SessionConnectorIdentityV1,
  type SessionConnectorPreflightExistingResultV1,
  type SessionConnectorResultV1,
  type SessionConnectorV1,
} from "@fusion/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RoomExistingSessionPreflightService,
  type RoomExistingSessionPreflightRequestV1,
} from "../room-existing-session-preflight.js";

const CONNECTOR_ID = "existing-session-preflight-connector";
const SESSION_URI = "codex://threads/existing-session-preflight";
const HOST_ID = "host-existing-session-preflight";
const MACHINE_ID = "machine-existing-session-preflight";
const CHECKED_AT = "2026-07-20T08:00:00.000Z";

type ProviderTelemetryReported = {
  readonly contractVersion: 1;
  readonly state: "reported";
  readonly identity: SessionConnectorIdentityV1;
  readonly providerId: "codex";
  readonly source: "happier_persisted_in_band_provider_snapshot";
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly freshness: "fresh";
  readonly limitations: {
    readonly providerAvailability: "not_inferred";
    readonly capacity: "not_reported";
    readonly onDemandProviderRefresh: "not_attempted";
    readonly accountIdentity: "not_reported";
    readonly rawSnapshot: "not_reported";
  };
};

type ProviderTelemetrySourceDouble = {
  getProviderTelemetry(
    identityValue: SessionConnectorIdentityV1,
  ): Promise<SessionConnectorResultV1<unknown>>;
};

const REQUEST: RoomExistingSessionPreflightRequestV1 = {
  connectorId: CONNECTOR_ID,
  canonicalSessionUri: SESSION_URI,
  requiredHostId: HOST_ID,
  requiredMachineId: MACHINE_ID,
};

function identity(overrides: Partial<SessionConnectorIdentityV1> = {}): SessionConnectorIdentityV1 {
  return {
    connectorId: CONNECTOR_ID,
    providerId: "codex",
    nativeSessionId: "existing-session-preflight",
    happierSessionId: "happier-existing-session-preflight",
    serverProfileId: "profile-existing-session-preflight",
    machineId: MACHINE_ID,
    hostId: HOST_ID,
    ...overrides,
  };
}

function capabilities(connectorId = CONNECTOR_ID): SessionConnectorCapabilitiesV1 {
  return {
    contractVersion: 1,
    connectorId,
    connectorVersion: "test-v1",
    sourceRevision: "test-source",
    verifiedAt: CHECKED_AT,
    capabilities: Object.fromEntries(
      SESSION_CONNECTOR_CAPABILITIES.map((name) => [name, {
        state: "verified",
        evidenceRef: `test://${name}`,
        reasonCode: null,
        lastVerifiedAt: CHECKED_AT,
      }]),
    ) as SessionConnectorCapabilitiesV1["capabilities"],
  };
}

function preflightResult(
  identityValue: SessionConnectorIdentityV1 = identity(),
): SessionConnectorResultV1<SessionConnectorPreflightExistingResultV1> {
  return {
    ok: true,
    value: {
      identity: identityValue,
      providerTurnStarted: false,
      checkedAt: CHECKED_AT,
      capabilities: capabilities(),
    },
  };
}

function healthy(hostId = HOST_ID): SessionConnectorHealthV1 {
  return {
    connectorId: CONNECTOR_ID,
    hostId,
    state: "healthy",
    checkedAt: CHECKED_AT,
    authentication: "authenticated",
    daemon: "running",
    server: "reachable",
    backend: "ready",
    rateLimit: "clear",
    host: "reachable",
    capabilities: Object.fromEntries(
      SESSION_CONNECTOR_CAPABILITIES.map((name) => [name, "verified"]),
    ) as SessionConnectorHealthV1["capabilities"],
    reasonCodes: [],
    retryAfterMs: null,
  };
}

function providerTelemetryReported(
  overrides: Partial<ProviderTelemetryReported> = {},
): ProviderTelemetryReported {
  return {
    contractVersion: 1,
    state: "reported",
    identity: identity(),
    providerId: "codex",
    source: "happier_persisted_in_band_provider_snapshot",
    observedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    freshness: "fresh",
    limitations: {
      providerAvailability: "not_inferred",
      capacity: "not_reported",
      onDemandProviderRefresh: "not_attempted",
      accountIdentity: "not_reported",
      rawSnapshot: "not_reported",
    },
    ...overrides,
  };
}

function connectorDouble(
  overrides: Partial<SessionConnectorV1 & ProviderTelemetrySourceDouble> = {},
) {
  const preflightExisting = vi.fn<NonNullable<SessionConnectorV1["preflightExisting"]>>(async () => preflightResult());
  const ensureExisting = vi.fn<SessionConnectorV1["ensureExisting"]>(async () => {
    throw new Error("ensureExisting must never run during preflight");
  });
  const getHealth = vi.fn<SessionConnectorV1["getHealth"]>(async (hostId) => healthy(hostId));
  const connector = {
    id: CONNECTOR_ID,
    preflightExisting,
    ensureExisting,
    getHealth,
    ...overrides,
  } as SessionConnectorV1 & Partial<ProviderTelemetrySourceDouble>;
  return { connector, preflightExisting, ensureExisting, getHealth };
}

function createService(
  connector: SessionConnectorV1,
  timeoutMs = 25,
  now?: () => number,
) {
  const tryGet = vi.fn(() => connector);
  return {
    service: new RoomExistingSessionPreflightService({
      connectorRegistry: { tryGet },
      timeoutMs,
      ...(now === undefined ? {} : { now }),
    }),
    tryGet,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RoomExistingSessionPreflightService", () => {
  it("uses only read-only preflight and safely withholds telemetry when the optional mixin is absent", async () => {
    const { connector, preflightExisting, ensureExisting, getHealth } = connectorDouble();
    const { service, tryGet } = createService(connector);

    const result = await service.preflight(REQUEST);

    expect(result).toMatchObject({
      state: "identity_verified",
      identity: identity(),
      providerTurnStarted: false,
      health: { state: "healthy" },
      providerTelemetry: {
        contractVersion: 1,
        state: "withheld",
        identity: identity(),
        reason: "connector_telemetry_unsupported",
      },
    });
    expect(result.state === "identity_verified" && result.health).toMatchObject({ state: "healthy" });
    expect(tryGet).toHaveBeenCalledWith(CONNECTOR_ID);
    expect(preflightExisting).toHaveBeenCalledWith({
      contractVersion: 1,
      canonicalSessionUri: SESSION_URI,
      requiredHostId: HOST_ID,
      requiredMachineId: MACHINE_ID,
    });
    expect(getHealth).toHaveBeenCalledWith(HOST_ID);
    expect(ensureExisting).not.toHaveBeenCalled();
  });

  it("projects a valid reported provider telemetry payload after primary identity verification", async () => {
    const telemetry = providerTelemetryReported();
    const getProviderTelemetry = vi.fn<ProviderTelemetrySourceDouble["getProviderTelemetry"]>(
      async () => ({ ok: true, value: telemetry }),
    );
    const { connector, getHealth } = connectorDouble({ getProviderTelemetry });
    const { service } = createService(connector);

    const result = await service.preflight(REQUEST);

    expect(result).toMatchObject({
      state: "identity_verified",
      identity: identity(),
      health: { state: "healthy" },
      providerTelemetry: telemetry,
    });
    expect(getHealth).toHaveBeenCalledWith(HOST_ID);
    expect(getProviderTelemetry).toHaveBeenCalledWith(identity());
  });

  it("keeps primary identity verification when provider telemetry returns a mismatched identity", async () => {
    const { connector } = connectorDouble({
      getProviderTelemetry: vi.fn(async () => ({
        ok: true,
        value: providerTelemetryReported({ identity: identity({ nativeSessionId: "other-session" }) }),
      })),
    });
    const { service } = createService(connector);

    await expect(service.preflight(REQUEST)).resolves.toMatchObject({
      state: "identity_verified",
      identity: identity(),
      providerTelemetry: {
        state: "withheld",
        reason: "telemetry_contract_invalid",
      },
    });
  });

  it("withholds an extra sensitive provider telemetry payload without exposing it", async () => {
    const sensitiveMarker = "provider-secret-must-not-leak";
    const malformed = {
      ...providerTelemetryReported(),
      accountEmail: sensitiveMarker,
      quotaRemaining: 42,
      rawSnapshot: { accessToken: sensitiveMarker },
    };
    const { connector } = connectorDouble({
      getProviderTelemetry: vi.fn(async () => ({ ok: true, value: malformed })),
    });
    const { service } = createService(connector);

    const result = await service.preflight(REQUEST);

    expect(result).toMatchObject({
      state: "identity_verified",
      providerTelemetry: {
        contractVersion: 1,
        state: "withheld",
        identity: identity(),
        reason: "telemetry_contract_invalid",
      },
    });
    expect(JSON.stringify(result)).not.toContain(sensitiveMarker);
  });

  it("keeps primary identity verification and marks expired provider telemetry stale", async () => {
    const { connector } = connectorDouble({
      getProviderTelemetry: vi.fn(async () => ({
        ok: true,
        value: providerTelemetryReported({
          observedAt: new Date(Date.now() - 2_000).toISOString(),
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
        }),
      })),
    });
    const { service } = createService(connector);

    await expect(service.preflight(REQUEST)).resolves.toMatchObject({
      state: "identity_verified",
      providerTelemetry: {
        state: "withheld",
        reason: "telemetry_stale",
      },
    });
  });

  it("rejects zero-lifetime telemetry and treats an injected exact expiry as stale", async () => {
    const expiresAt = "2099-07-21T00:00:00.000Z";
    const beforeExpiry = Date.parse("2099-07-20T23:59:59.999Z");
    const atExpiry = Date.parse(expiresAt);
    const zeroLifetimeConnector = connectorDouble({
      getProviderTelemetry: vi.fn(async () => ({
        ok: true,
        value: providerTelemetryReported({ observedAt: expiresAt, expiresAt }),
      })),
    });
    const exactExpiryConnector = connectorDouble({
      getProviderTelemetry: vi.fn(async () => ({
        ok: true,
        value: providerTelemetryReported({
          observedAt: "2099-07-20T23:59:59.999Z",
          expiresAt,
        }),
      })),
    });

    const zeroLifetime = await createService(
      zeroLifetimeConnector.connector,
      25,
      () => beforeExpiry,
    ).service.preflight(REQUEST);
    const exactExpiry = await createService(
      exactExpiryConnector.connector,
      25,
      () => atExpiry,
    ).service.preflight(REQUEST);

    expect(zeroLifetime).toMatchObject({
      state: "identity_verified",
      providerTelemetry: { state: "withheld", reason: "telemetry_contract_invalid" },
    });
    expect(exactExpiry).toMatchObject({
      state: "identity_verified",
      providerTelemetry: { state: "withheld", reason: "telemetry_stale" },
    });
  });

  it("keeps primary identity verification when provider telemetry never settles", async () => {
    vi.useFakeTimers();
    const { connector } = connectorDouble({
      getProviderTelemetry: vi.fn(() => new Promise<SessionConnectorResultV1<unknown>>(() => {})),
    });
    const { service } = createService(connector, 10);

    const pending = service.preflight(REQUEST);
    await vi.advanceTimersByTimeAsync(10);

    await expect(pending).resolves.toMatchObject({
      state: "identity_verified",
      providerTelemetry: {
        state: "withheld",
        reason: "telemetry_timeout",
      },
    });
  });

  it("keeps primary identity verification when the connector reports telemetry failure", async () => {
    const sensitiveMarker = "connector-failure-must-not-leak";
    const { connector } = connectorDouble({
      getProviderTelemetry: vi.fn(async () => ({
        ok: false,
        error: {
          code: "internal",
          message: sensitiveMarker,
          retryable: false,
          safeDetails: { token: sensitiveMarker },
        },
      })),
    });
    const { service } = createService(connector);

    const result = await service.preflight(REQUEST);

    expect(result).toMatchObject({
      state: "identity_verified",
      providerTelemetry: {
        state: "withheld",
        reason: "telemetry_unavailable",
      },
    });
    expect(JSON.stringify(result)).not.toContain(sensitiveMarker);
  });

  it.each([
    ["connector", identity({ connectorId: "other-connector" })],
    ["host", identity({ hostId: "other-host" })],
    ["machine", identity({ machineId: "other-machine" })],
  ])("withholds a %s identity mismatch before querying health", async (_field, returnedIdentity) => {
    const { connector, getHealth } = connectorDouble({
      preflightExisting: vi.fn(async () => preflightResult(returnedIdentity)),
    });
    const { service } = createService(connector);

    await expect(service.preflight(REQUEST)).resolves.toMatchObject({
      state: "withheld",
      reason: "preflight_contract_invalid",
    });
    expect(getHealth).not.toHaveBeenCalled();
  });

  it("withholds malformed connector output without falling back to an execution path", async () => {
    const malformed = {
      ...preflightResult().value,
      capabilities: { ...capabilities(), capabilities: {} },
    } as unknown as SessionConnectorPreflightExistingResultV1;
    const { connector, ensureExisting, getHealth } = connectorDouble({
      preflightExisting: vi.fn(async () => ({ ok: true, value: malformed })),
    });
    const { service } = createService(connector);

    await expect(service.preflight(REQUEST)).resolves.toMatchObject({
      state: "withheld",
      reason: "preflight_contract_invalid",
    });
    expect(ensureExisting).not.toHaveBeenCalled();
    expect(getHealth).not.toHaveBeenCalled();
  });

  it("contains synchronous connector exceptions without falling back to ensure", async () => {
    const { connector, ensureExisting, getHealth } = connectorDouble({
      preflightExisting: vi.fn(() => {
        throw new Error("connector preflight failed synchronously");
      }),
    });
    const { service } = createService(connector);

    await expect(service.preflight(REQUEST)).resolves.toMatchObject({
      state: "withheld",
      reason: "preflight_unavailable",
    });
    expect(ensureExisting).not.toHaveBeenCalled();
    expect(getHealth).not.toHaveBeenCalled();
  });

  it.each([
    ["authentication_required", "authentication_required", null],
    ["not_found", "session_not_found", null],
    ["ambiguous", "session_ambiguous", null],
    ["host_unavailable", "host_unavailable", null],
    ["rate_limited", "rate_limited", 5_000],
    ["conflict", "identity_mismatch", null],
    ["transport", "preflight_unavailable", null],
  ] as const)("maps typed %s preflight failures safely", async (code, reason, retryAfterMs) => {
    const { connector } = connectorDouble({
      preflightExisting: vi.fn(async () => ({
        ok: false as const,
        error: { code, message: "typed connector failure", retryable: code === "rate_limited", ...(retryAfterMs === null ? {} : { retryAfterMs }) },
      })),
    });
    const { service } = createService(connector);

    await expect(service.preflight(REQUEST)).resolves.toMatchObject({
      state: "withheld",
      reason,
      retryAfterMs,
    });
  });

  it("keeps identity verified but marks health unknown when the health probe times out", async () => {
    vi.useFakeTimers();
    const { connector } = connectorDouble({
      getHealth: vi.fn(() => new Promise<SessionConnectorHealthV1>(() => {})),
    });
    const { service } = createService(connector, 10);

    const pending = service.preflight(REQUEST);
    await vi.advanceTimersByTimeAsync(10);

    await expect(pending).resolves.toMatchObject({
      state: "identity_verified",
      health: {
        state: "unknown",
        checkedAt: null,
        authentication: "unknown",
        rateLimit: "unknown",
        reasonCodes: [],
        retryAfterMs: null,
      },
    });
  });

  it("keeps identity verified but marks health unknown when the health probe throws synchronously", async () => {
    const { connector } = connectorDouble({
      getHealth: vi.fn(() => {
        throw new Error("connector health failed synchronously");
      }),
    });
    const { service } = createService(connector);

    await expect(service.preflight(REQUEST)).resolves.toMatchObject({
      state: "identity_verified",
      health: { state: "unknown" },
    });
  });

  it("withholds the whole preflight when the read-only connector probe times out", async () => {
    vi.useFakeTimers();
    const { connector, ensureExisting, getHealth } = connectorDouble({
      preflightExisting: vi.fn(() => new Promise<SessionConnectorResultV1<SessionConnectorPreflightExistingResultV1>>(() => {})),
    });
    const { service } = createService(connector, 10);

    const pending = service.preflight(REQUEST);
    await vi.advanceTimersByTimeAsync(10);

    await expect(pending).resolves.toMatchObject({
      state: "withheld",
      reason: "read_only_preflight_timeout",
      retryAfterMs: null,
    });
    expect(ensureExisting).not.toHaveBeenCalled();
    expect(getHealth).not.toHaveBeenCalled();
  });
});

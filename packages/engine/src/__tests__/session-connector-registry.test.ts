import { describe, expect, it, vi } from "vitest";

import {
  SESSION_CONNECTOR_CAPABILITIES,
  type SessionConnectorCapabilitiesV1,
  type SessionConnectorCapabilityName,
  type SessionConnectorCapabilityState,
  type SessionConnectorControlResultV1,
  type SessionConnectorDeepLinksV1,
  type SessionConnectorEventV1,
  type SessionConnectorHealthV1,
  type SessionConnectorHistoryPageV1,
  type SessionConnectorIdentityV1,
  type SessionConnectorResultV1,
  type SessionConnectorSendReceiptV1,
  type SessionConnectorStatusV1,
  type SessionConnectorV1,
} from "@fusion/core";
import { SessionConnectorRegistry } from "../session-connector-registry.js";

const NOW = "2026-07-17T10:00:00.000Z";
const IDENTITY = {
  connectorId: "happier",
  providerId: "codex",
  nativeSessionId: "codex-thread-1",
  happierSessionId: "happier-session-1",
  serverProfileId: "happier-server-1",
  machineId: "happier-machine-1",
  hostId: "windows-host-1",
} satisfies SessionConnectorIdentityV1;

function ok<T>(value: T): SessionConnectorResultV1<T> {
  return { ok: true, value };
}

function capabilityMatrix(
  overrides: Partial<Record<SessionConnectorCapabilityName, SessionConnectorCapabilityState>> = {},
): SessionConnectorCapabilitiesV1 {
  const capabilities = Object.fromEntries(
    SESSION_CONNECTOR_CAPABILITIES.map((name) => {
      const state = overrides[name] ?? "verified";
      return [name, {
        state,
        evidenceRef: state === "verified" ? `evidence://happier/${name}` : null,
        reasonCode: state === "verified" ? null : "runtime_degraded",
        lastVerifiedAt: state === "verified" ? NOW : null,
      }];
    }),
  ) as unknown as SessionConnectorCapabilitiesV1["capabilities"];
  return {
    contractVersion: 1,
    connectorId: "happier",
    connectorVersion: "0.2.73",
    sourceRevision: "happier-source-revision",
    verifiedAt: NOW,
    capabilities,
  };
}

function healthCapabilities(
  overrides: Partial<Record<SessionConnectorCapabilityName, SessionConnectorCapabilityState>> = {},
): SessionConnectorHealthV1["capabilities"] {
  return Object.fromEntries(
    SESSION_CONNECTOR_CAPABILITIES.map((name) => [name, overrides[name] ?? "verified"]),
  ) as SessionConnectorHealthV1["capabilities"];
}

function healthyHealth(
  overrides: Partial<SessionConnectorHealthV1> = {},
): SessionConnectorHealthV1 {
  return {
    connectorId: "happier",
    hostId: IDENTITY.hostId,
    state: "healthy",
    checkedAt: NOW,
    authentication: "authenticated",
    daemon: "running",
    server: "reachable",
    backend: "ready",
    rateLimit: "clear",
    host: "reachable",
    capabilities: healthCapabilities(),
    reasonCodes: [],
    retryAfterMs: null,
    ...overrides,
  };
}

async function* eventStream(): AsyncIterable<SessionConnectorEventV1> {
  yield {
    connectorEventId: "connector-event-8",
    identity: IDENTITY,
    eventType: "message",
    cursor: "8",
    occurredAt: NOW,
    payload: { nativeMessageId: "native-message-8" },
  };
  yield {
    connectorEventId: "connector-event-9",
    identity: IDENTITY,
    eventType: "status",
    cursor: "9",
    occurredAt: NOW,
    payload: { state: "idle" },
  };
}

function makeConnector(input: {
  readonly capabilities?: () => SessionConnectorCapabilitiesV1;
  readonly health?: () => SessionConnectorHealthV1;
} = {}): SessionConnectorV1 {
  return {
    contractVersion: 1,
    id: "happier",
    version: "0.2.73",
    getCapabilities: vi.fn(async () => (
      input.capabilities?.() ?? capabilityMatrix()
    )),
    ensureExisting: vi.fn(async () => ok({
      identity: IDENTITY,
      createdLink: true,
      providerTurnStarted: false,
      attachedAt: NOW,
      capabilities: capabilityMatrix(),
    })),
    create: vi.fn(async () => ok({
      ...IDENTITY,
      providerId: "opencode",
      nativeSessionId: "opencode-session-created",
      happierSessionId: "happier-session-created",
    })),
    getStatus: vi.fn(async () => ok<SessionConnectorStatusV1>({
      identity: IDENTITY,
      state: "idle",
      lastActivityAt: NOW,
      connectorCursor: "7",
      nativeWriterDetected: false,
    })),
    readHistory: vi.fn(async () => ok<SessionConnectorHistoryPageV1>({
      items: [{
        nativeMessageId: "native-message-8",
        logicalMessageId: "room-message-8",
        role: "assistant",
        contentHash: "sha256:history-message-8",
        occurredAt: NOW,
        cursor: "8",
      }],
      nextCursor: "8",
      completeThroughCursor: "8",
    })),
    subscribeEvents: vi.fn(async () => ok(eventStream())),
    send: vi.fn(async () => ok<SessionConnectorSendReceiptV1>({
      outcome: "confirmed",
      connectorAcknowledgementId: "happier-ack-10",
      nativeMessageId: "native-message-10",
      cursor: "10",
      acceptedAt: NOW,
    })),
    interrupt: vi.fn(async () => ok<SessionConnectorControlResultV1>({
      state: "completed",
      connectorAcknowledgementId: "interrupt-ack-1",
    })),
    resume: vi.fn(async () => ok<SessionConnectorControlResultV1>({
      state: "completed",
      connectorAcknowledgementId: "resume-ack-1",
    })),
    takeover: vi.fn(async () => ok<SessionConnectorControlResultV1>({
      state: "accepted",
      connectorAcknowledgementId: "takeover-ack-1",
    })),
    getHealth: vi.fn(async () => input.health?.() ?? healthyHealth()),
    getDeepLinks: vi.fn(async () => ok<SessionConnectorDeepLinksV1>({
      contractVersion: 1,
      bindingId: "binding-1",
      ...IDENTITY,
      happierUrl: "http://127.0.0.1:18287/session/happier-session-1?serverId=happier-server-1",
      nativeSessionUrl: "codex://threads/codex-thread-1",
    })),
  };
}

function makeRegistry(): SessionConnectorRegistry {
  return new SessionConnectorRegistry({ now: () => Date.parse(NOW) });
}

async function requireVerified(
  registry: SessionConnectorRegistry,
  capability: SessionConnectorCapabilityName,
): Promise<SessionConnectorV1> {
  return registry.requireVerified({
    connectorId: "happier",
    capability,
    identity: IDENTITY,
    requiredHostId: IDENTITY.hostId,
  });
}

describe("provider-neutral Session Connector registry contract", () => {
  it("registers by connector identity and rejects duplicate or unknown connectors", () => {
    const registry = makeRegistry();
    const connector = makeConnector();
    registry.register(connector);

    expect(registry.get("happier")).toBe(connector);
    expect(registry.all()).toEqual([connector]);
    expect(() => registry.register(makeConnector())).toThrow(expect.objectContaining({
      code: "SESSION_CONNECTOR_DUPLICATE",
      connectorId: "happier",
    }));
    expect(() => registry.get("missing")).toThrow(expect.objectContaining({
      code: "SESSION_CONNECTOR_UNKNOWN",
      connectorId: "missing",
    }));
  });

  it("fails closed for degraded, unavailable, or unverified operations and enforces host affinity", async () => {
    let overrides: Partial<Record<SessionConnectorCapabilityName, SessionConnectorCapabilityState>> = {};
    const connector = makeConnector({ capabilities: () => capabilityMatrix(overrides) });
    const registry = makeRegistry();
    registry.register(connector);

    await expect(requireVerified(registry, "send")).resolves.toBe(connector);
    for (const state of ["degraded", "unavailable", "unverified"] as const) {
      overrides = { send: state };
      await expect(requireVerified(registry, "send")).rejects.toMatchObject({
        code: "SESSION_CONNECTOR_CAPABILITY_NOT_VERIFIED",
        connectorId: "happier",
        capability: "send",
        state,
        reasonCode: "runtime_degraded",
      });
    }

    overrides = {};
    await expect(registry.requireVerified({
      connectorId: "happier",
      capability: "history",
      identity: IDENTITY,
      requiredHostId: "another-windows-host",
    })).rejects.toMatchObject({
      code: "SESSION_CONNECTOR_HOST_AFFINITY",
      connectorId: "happier",
      expectedHostId: "another-windows-host",
      actualHostId: IDENTITY.hostId,
    });
    await expect(registry.requireVerified({
      connectorId: "happier",
      capability: "status",
      identity: { ...IDENTITY, connectorId: "different-connector" },
      requiredHostId: IDENTITY.hostId,
    })).rejects.toMatchObject({
      code: "SESSION_CONNECTOR_IDENTITY_CONFLICT",
    });
  });

  it("fails closed for every unhealthy runtime dimension while degraded reads remain available", async () => {
    const cases: Array<[string, Partial<SessionConnectorHealthV1>]> = [
      ["authentication", {
        state: "authentication_required",
        authentication: "required",
        reasonCodes: ["authentication_required"],
      }],
      ["daemon", {
        state: "degraded",
        daemon: "stopped",
        reasonCodes: ["daemon_stopped"],
      }],
      ["server", {
        state: "unavailable",
        server: "unreachable",
        reasonCodes: ["server_unreachable"],
      }],
      ["backend", {
        state: "degraded",
        backend: "unavailable",
        reasonCodes: ["backend_unavailable"],
      }],
      ["rate-limit", {
        state: "rate_limited",
        rateLimit: "limited",
        reasonCodes: ["rate_limited"],
        retryAfterMs: 60_000,
      }],
      ["host", {
        state: "host_unavailable",
        host: "unavailable",
        reasonCodes: ["host_unavailable"],
      }],
    ];

    for (const [dimension, healthPatch] of cases) {
      const connector = makeConnector({ health: () => healthyHealth(healthPatch) });
      const registry = makeRegistry();
      registry.register(connector);

      await expect(requireVerified(registry, "send"), dimension).rejects.toMatchObject({
        code: "SESSION_CONNECTOR_HEALTH_NOT_READY",
        connectorId: "happier",
        capability: "send",
      });
      expect(connector.getHealth, dimension).toHaveBeenCalledWith(IDENTITY.hostId);
      await expect(requireVerified(registry, "history"), dimension).resolves.toBe(connector);
      expect(connector.getHealth, dimension).toHaveBeenCalledTimes(1);
    }
  });

  it("allows unknown quota only for explicitly read-only existing-session attachment", async () => {
    const connector = makeConnector({ health: () => healthyHealth({ rateLimit: "unknown" }) });
    const registry = makeRegistry();
    registry.register(connector);

    await expect(registry.requireVerified({
      connectorId: "happier",
      capability: "ensureExisting",
      identity: IDENTITY,
      requiredHostId: IDENTITY.hostId,
      allowUnknownRateLimitForReadOnlyAttachment: true,
    })).resolves.toBe(connector);
    await expect(requireVerified(registry, "send")).rejects.toMatchObject({
      code: "SESSION_CONNECTOR_HEALTH_NOT_READY",
      capability: "send",
    });
  });

  it("uses identity-bound capability certification instead of an identityless health capability matrix", async () => {
    const connector = makeConnector({
      health: () => healthyHealth({
        capabilities: healthCapabilities({ send: "unavailable" }),
      }),
    });
    const registry = makeRegistry();
    registry.register(connector);

    await expect(requireVerified(registry, "send")).resolves.toBe(connector);
    expect(connector.getCapabilities).toHaveBeenCalledWith(IDENTITY);
    expect(connector.getHealth).toHaveBeenCalledWith(IDENTITY.hostId);
  });

  it("rejects stale, future, contradictory, or untimed rate-limit health", async () => {
    const invalidHealth: Array<[string, Partial<SessionConnectorHealthV1>]> = [
      ["stale", { checkedAt: "2026-07-17T09:59:29.999Z" }],
      ["future", { checkedAt: "2026-07-17T10:00:05.001Z" }],
      ["noncanonical-time", { checkedAt: "July 17, 2026 10:00:00 UTC" }],
      ["contradictory-reason", { reasonCodes: ["rate_limited"] }],
      ["untimed-rate-limit", {
        state: "rate_limited",
        rateLimit: "limited",
        reasonCodes: ["rate_limited"],
        retryAfterMs: null,
      }],
    ];

    for (const [name, patch] of invalidHealth) {
      const connector = makeConnector({ health: () => healthyHealth(patch) });
      const registry = makeRegistry();
      registry.register(connector);
      await expect(requireVerified(registry, "send"), name).rejects.toMatchObject({
        code: "SESSION_CONNECTOR_HEALTH_CONTRACT_CONFLICT",
      });
      await expect(requireVerified(registry, "history"), name).resolves.toBe(connector);
    }
  });

  it("converts thrown or malformed health into secret-free typed contract failures", async () => {
    const thrownConnector = makeConnector({
      health: () => {
        throw new Error("Bearer top-secret-health-token");
      },
    });
    const thrownRegistry = makeRegistry();
    thrownRegistry.register(thrownConnector);
    const thrown = await requireVerified(thrownRegistry, "send").catch((error: unknown) => error);
    expect(thrown).toMatchObject({ code: "SESSION_CONNECTOR_HEALTH_NOT_READY" });
    expect(JSON.stringify(thrown)).not.toContain("top-secret-health-token");

    const malformedConnector = makeConnector({
      health: () => ({
        ...healthyHealth(),
        reasonCodes: ["accessToken=top-secret-health-token"],
      } as unknown as SessionConnectorHealthV1),
    });
    const malformedRegistry = makeRegistry();
    malformedRegistry.register(malformedConnector);
    const malformed = await requireVerified(malformedRegistry, "send").catch((error: unknown) => error);
    expect(malformed).toMatchObject({ code: "SESSION_CONNECTOR_HEALTH_CONTRACT_CONFLICT" });
    expect(JSON.stringify(malformed)).not.toContain("top-secret-health-token");
  });

  it("rejects malformed dynamic connector and capability registrations with typed contract errors", async () => {
    const registry = makeRegistry();
    expect(() => registry.register({
      ...makeConnector(),
      send: undefined,
    } as unknown as SessionConnectorV1)).toThrow(expect.objectContaining({
      code: "SESSION_CONNECTOR_CONTRACT_CONFLICT",
      connectorId: "happier",
    }));

    const connector = makeConnector({
      capabilities: () => ({
        ...capabilityMatrix(),
        connectorId: "another-connector",
      }),
    });
    registry.register(connector);
    await expect(requireVerified(registry, "status")).rejects.toMatchObject({
      code: "SESSION_CONNECTOR_CONTRACT_CONFLICT",
      connectorId: "happier",
    });
  });

  it("redacts thrown and token-shaped capability discovery payloads", async () => {
    const thrownConnector = makeConnector({
      capabilities: () => {
        throw new Error("Bearer top-secret-capability-token");
      },
    });
    const thrownRegistry = makeRegistry();
    thrownRegistry.register(thrownConnector);
    const thrown = await requireVerified(thrownRegistry, "send").catch((error: unknown) => error);
    expect(thrown).toMatchObject({ code: "SESSION_CONNECTOR_CONTRACT_CONFLICT" });
    expect(JSON.stringify(thrown)).not.toContain("top-secret-capability-token");

    const malformedConnector = makeConnector({
      capabilities: () => ({
        ...capabilityMatrix(),
        connectorId: "accessTokenSecret123",
      }),
    });
    const malformedRegistry = makeRegistry();
    malformedRegistry.register(malformedConnector);
    const malformed = await requireVerified(malformedRegistry, "send").catch((error: unknown) => error);
    expect(malformed).toMatchObject({ code: "SESSION_CONNECTOR_CONTRACT_CONFLICT" });
    expect(JSON.stringify(malformed)).not.toContain("accessTokenSecret123");
  });

  it("preserves exact existing-session ensure and explicit new-session creation requests", async () => {
    const connector = makeConnector();
    const registry = makeRegistry();
    registry.register(connector);
    const ensureRequest = {
      contractVersion: 1 as const,
      canonicalSessionUri: "codex://threads/codex-thread-1",
      requiredHostId: IDENTITY.hostId,
      requiredMachineId: IDENTITY.machineId!,
      idempotencyKey: "ensure:codex-thread-1",
    };
    const ensured = await (await requireVerified(registry, "ensureExisting"))
      .ensureExisting(ensureRequest);
    expect(connector.ensureExisting).toHaveBeenCalledWith(ensureRequest);
    expect(ensured).toMatchObject({
      ok: true,
      value: {
        identity: IDENTITY,
        createdLink: true,
        providerTurnStarted: false,
      },
    });

    const createRequest = {
      contractVersion: 1 as const,
      providerId: "opencode",
      modelId: "provider-default",
      accountId: "account-profile-1",
      hostId: IDENTITY.hostId,
      workingDirectory: "G:\\codex-project\\new-room-worker",
      idempotencyKey: "create:room-1:seat-2",
    };
    const created = await (await requireVerified(registry, "create")).create(createRequest);
    expect(connector.create).toHaveBeenCalledWith(createRequest);
    expect(created).toMatchObject({
      ok: true,
      value: {
        providerId: "opencode",
        nativeSessionId: "opencode-session-created",
        hostId: IDENTITY.hostId,
      },
    });
  });

  it("routes status, bounded history cursors, and ordered events without provider branching", async () => {
    const connector = makeConnector();
    const registry = makeRegistry();
    registry.register(connector);

    const status = await (await requireVerified(registry, "status")).getStatus(IDENTITY);
    expect(connector.getStatus).toHaveBeenCalledWith(IDENTITY);
    expect(status).toMatchObject({ ok: true, value: { connectorCursor: "7", state: "idle" } });

    const historyRequest = {
      contractVersion: 1 as const,
      identity: IDENTITY,
      afterCursor: "7",
      limit: 50,
    };
    const history = await (await requireVerified(registry, "history")).readHistory(historyRequest);
    expect(connector.readHistory).toHaveBeenCalledWith(historyRequest);
    expect(history).toMatchObject({
      ok: true,
      value: {
        nextCursor: "8",
        completeThroughCursor: "8",
        items: [{ cursor: "8", logicalMessageId: "room-message-8" }],
      },
    });

    const subscription = await (await requireVerified(registry, "events"))
      .subscribeEvents(IDENTITY);
    expect(connector.subscribeEvents).toHaveBeenCalledWith(IDENTITY);
    if (!subscription.ok) throw new Error(subscription.error.message);
    const events: SessionConnectorEventV1[] = [];
    for await (const event of subscription.value) events.push(event);
    expect(events.map((event) => [event.cursor, event.eventType])).toEqual([
      ["8", "message"],
      ["9", "status"],
    ]);
  });

  it("carries stable logical/local send identity and returns native acknowledgement evidence", async () => {
    const connector = makeConnector();
    const registry = makeRegistry();
    registry.register(connector);
    const sendRequest = {
      contractVersion: 1 as const,
      bindingId: "binding-1",
      identity: IDENTITY,
      logicalMessageId: "room-message-10",
      localMessageId: "fusion-room-local-10",
      idempotencyKey: "room-message-10:binding-1",
      content: "Continue the exact native Session.",
      contentHash: "sha256:room-message-10",
    };

    const receipt = await (await requireVerified(registry, "send")).send(sendRequest);
    expect(connector.send).toHaveBeenCalledWith(sendRequest);
    expect(receipt).toEqual(ok({
      outcome: "confirmed",
      connectorAcknowledgementId: "happier-ack-10",
      nativeMessageId: "native-message-10",
      cursor: "10",
      acceptedAt: NOW,
    }));
  });

  it("routes certified interrupt, resume, and takeover controls with exact identity", async () => {
    const connector = makeConnector();
    const registry = makeRegistry();
    registry.register(connector);
    const controlRequest = {
      contractVersion: 1 as const,
      identity: IDENTITY,
      idempotencyKey: "control:binding-1:turn-1",
      reason: "Operator requested a safe turn boundary",
    };

    expect(await (await requireVerified(registry, "interrupt")).interrupt(controlRequest))
      .toMatchObject({ ok: true, value: { connectorAcknowledgementId: "interrupt-ack-1" } });
    expect(await (await requireVerified(registry, "resume")).resume(controlRequest))
      .toMatchObject({ ok: true, value: { connectorAcknowledgementId: "resume-ack-1" } });
    expect(await (await requireVerified(registry, "takeover")).takeover(controlRequest))
      .toMatchObject({ ok: true, value: { connectorAcknowledgementId: "takeover-ack-1" } });
    expect(connector.interrupt).toHaveBeenCalledWith(controlRequest);
    expect(connector.resume).toHaveBeenCalledWith(controlRequest);
    expect(connector.takeover).toHaveBeenCalledWith(controlRequest);
  });

  it("returns host-scoped health and rebuildable Happier/native deep links", async () => {
    const connector = makeConnector();
    const registry = makeRegistry();
    registry.register(connector);

    const health = await (await requireVerified(registry, "health")).getHealth(IDENTITY.hostId);
    expect(health).toEqual({
      connectorId: "happier",
      hostId: IDENTITY.hostId,
      state: "healthy",
      checkedAt: NOW,
      authentication: "authenticated",
      daemon: "running",
      server: "reachable",
      backend: "ready",
      rateLimit: "clear",
      host: "reachable",
      capabilities: healthCapabilities(),
      reasonCodes: [],
      retryAfterMs: null,
    });
    const request = { contractVersion: 1 as const, bindingId: "binding-1", identity: IDENTITY };
    const links = await (await requireVerified(registry, "deepLinks")).getDeepLinks(request);
    expect(links).toEqual(ok({
      contractVersion: 1,
      bindingId: "binding-1",
      ...IDENTITY,
      happierUrl: "http://127.0.0.1:18287/session/happier-session-1?serverId=happier-server-1",
      nativeSessionUrl: "codex://threads/codex-thread-1",
    }));
    expect(connector.getHealth).toHaveBeenCalledWith(IDENTITY.hostId);
    expect(connector.getDeepLinks).toHaveBeenCalledWith(request);
  });
});

import {
  buildRoomConnectorLocalMessageId,
  hashRoomValue,
  type SessionConnectorIdentityV1,
  type SessionConnectorSendRequestV1,
} from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import {
  HAPPIER_DIRECT_SESSION_CAPABILITY_FINGERPRINT,
  HAPPIER_DIRECT_SESSION_RUNTIME_MANIFEST,
  HAPPIER_DIRECT_SESSION_SOURCE_REVISION,
  HappierSessionConnector,
  type HappierSessionConnectorDependencies,
} from "../session-connector.js";
import { HappierCliError, type HappierCliSettings } from "../types.js";

const NOW = "2026-07-17T05:10:00.000Z";

const IDENTITY: SessionConnectorIdentityV1 = {
  connectorId: "happier",
  providerId: "codex",
  nativeSessionId: "codex-thread-1",
  happierSessionId: "happier-session-1",
  serverProfileId: "server-1",
  machineId: "machine-1",
  hostId: "fusion-host-1",
};

function setup(
  overrides: Partial<HappierSessionConnectorDependencies> = {},
  now: () => string = () => NOW,
  settings: Partial<HappierCliSettings> = {},
) {
  const dependencies: HappierSessionConnectorDependencies = {
    ensureDirectSession: vi.fn(async () => ({
      providerId: "codex" as const,
      remoteSessionId: "codex-thread-1",
      machineId: "machine-1",
      serverId: "server-1",
      sessionId: "happier-session-1",
      created: true,
      openUrl: "https://app.happier.dev/session/happier-session-1?serverId=server-1",
    })),
    getSessionStatus: vi.fn(async () => ({
      sessionId: "happier-session-1",
      session: {
        id: "happier-session-1",
        active: true,
        lastActivityAt: 1_752_729_000_000,
      },
      agentState: { status: "waitingOnInput", controlledByUser: true },
    })),
    readDirectTranscript: vi.fn(async (input) => input.afterCursor === null ? ({
      machineId: "machine-1",
      providerId: "codex" as const,
      remoteSessionId: "codex-thread-1",
      sessionId: "happier-session-1",
      source: { kind: "codexHome" as const, home: "user" as const },
      fromCursor: null,
      nextCursor: "provider-cursor-2",
      truncated: false,
      items: [
        { id: "native-message-1", localId: "logical-1", createdAtMs: 1_752_729_000_000, raw: { role: "user", text: "first" } },
        { id: "native-message-2", createdAtMs: 1_752_729_001_000, raw: { role: "assistant", text: "second" } },
      ],
    }) : ({
      machineId: "machine-1",
      providerId: "codex" as const,
      remoteSessionId: "codex-thread-1",
      sessionId: "happier-session-1",
      source: { kind: "codexHome" as const, home: "user" as const },
      fromCursor: input.afterCursor,
      nextCursor: "provider-cursor-3",
      truncated: false,
      items: [
        { id: "native-message-3", createdAtMs: 1_752_729_002_000, raw: { role: "assistant", text: "third" } },
      ],
    })),
    followDirectTranscriptEvents: vi.fn(() => (async function* () {
      yield {
        machineId: "machine-1",
        providerId: "codex" as const,
        remoteSessionId: "codex-thread-1",
        sessionId: "happier-session-1",
        source: { kind: "codexHome" as const, home: "user" as const },
        fromCursor: "provider-cursor-2",
        nextCursor: "provider-cursor-3",
        truncated: false,
        items: [
          { id: "native-message-3", createdAtMs: 1_752_729_002_000, raw: { role: "assistant", text: "third" } },
        ],
      };
      yield {
        eventType: "status" as const,
        machineId: "machine-1",
        providerId: "codex" as const,
        remoteSessionId: "codex-thread-1",
        sessionId: "happier-session-1",
        source: { kind: "codexHome" as const, home: "user" as const },
        isRunning: true,
        lastActivityAtMs: 1_752_729_002_000,
        observedAtMs: 1_752_729_002_500,
      };
    })()),
    getDirectSessionCapabilities: vi.fn(async () => ({
      ...HAPPIER_DIRECT_SESSION_RUNTIME_MANIFEST,
      fingerprint: HAPPIER_DIRECT_SESSION_CAPABILITY_FINGERPRINT,
      cliVersion: "0.2.10",
    })),
    sendMessage: vi.fn(async (input) => ({
      sessionId: input.sessionId,
      localId: input.localId,
      waited: true,
    })),
    probeRuntime: vi.fn(async () => ({
      discovered: true,
      executable: true,
      server: true,
      serverState: "reachable" as const,
      authenticated: true,
      daemon: true,
      backend: true,
      ready: true,
      backendId: "codex" as const,
      details: [],
    })),
    ...overrides,
  };
  return {
    dependencies,
    connector: new HappierSessionConnector({
      settings: {
        executable: "happier",
        activeServerId: "server-1",
        webappUrl: "https://app.happier.dev",
        ...settings,
      },
      now,
      dependencies,
    }),
  };
}

function sendRequest(): SessionConnectorSendRequestV1 {
  const content = "Continue the exact native Session";
  const contentHash = hashRoomValue(content);
  return {
    contractVersion: 1,
    bindingId: "binding-1",
    identity: IDENTITY,
    logicalMessageId: "room-message-1",
    idempotencyKey: "dispatch-1",
    localMessageId: buildRoomConnectorLocalMessageId({
      logicalMessageId: "room-message-1",
      bindingId: "binding-1",
      idempotencyKey: "dispatch-1",
      payloadHash: contentHash,
    }),
    content,
    contentHash,
  };
}

describe("HappierSessionConnector", () => {
  it("normalizes official Direct Session identity fields without starting a provider turn", async () => {
    const { connector, dependencies } = setup();

    const result = await connector.ensureExisting({
      contractVersion: 1,
      canonicalSessionUri: "codex://threads/codex-thread-1",
      requiredHostId: "fusion-host-1",
      requiredMachineId: "machine-1",
      idempotencyKey: "attach-1",
    });

    expect(dependencies.ensureDirectSession).toHaveBeenCalledWith({
      uri: "codex://threads/codex-thread-1",
      machineId: "machine-1",
      settings: expect.objectContaining({ executable: "happier" }),
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        identity: IDENTITY,
        createdLink: true,
        providerTurnStarted: false,
        attachedAt: NOW,
      },
    });
  });

  it("refuses to invent a Fusion host identity from Happier's machine identity", async () => {
    const { connector, dependencies } = setup();

    const result = await connector.ensureExisting({
      contractVersion: 1,
      canonicalSessionUri: "codex://threads/codex-thread-1",
      requiredMachineId: "machine-1",
      idempotencyKey: "attach-without-host",
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid_request" },
    });
    expect(dependencies.ensureDirectSession).not.toHaveBeenCalled();
  });

  it("targets Happier's linked Session for status while retaining provider-native identity", async () => {
    const { connector, dependencies } = setup();

    await expect(connector.getStatus(IDENTITY)).resolves.toEqual({
      ok: true,
      value: {
        identity: IDENTITY,
        state: "waiting_input",
        lastActivityAt: "2025-07-17T05:10:00.000Z",
        connectorCursor: null,
        nativeWriterDetected: true,
      },
    });
    expect(dependencies.getSessionStatus).toHaveBeenCalledWith(
      "happier-session-1",
      expect.objectContaining({ executable: "happier" }),
      undefined,
    );
  });

  it("maps official bounded Direct history to content-free durable cursor records", async () => {
    const { connector, dependencies } = setup();
    const first = await connector.readHistory({
      contractVersion: 1,
      identity: IDENTITY,
      afterCursor: null,
      limit: 2,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value.items).toEqual([
      expect.objectContaining({
        nativeMessageId: "native-message-1",
        logicalMessageId: "logical-1",
        role: "user",
        contentHash: hashRoomValue({ role: "user", text: "first" }),
        occurredAt: "2025-07-17T05:10:00.000Z",
      }),
      expect.objectContaining({
        nativeMessageId: "native-message-2",
        logicalMessageId: null,
        role: "assistant",
        contentHash: hashRoomValue({ role: "assistant", text: "second" }),
        occurredAt: "2025-07-17T05:10:01.000Z",
      }),
    ]);
    expect(first.value.items[0]?.cursor).toMatch(/^happier-direct-message-v1:/u);
    expect(first.value.items[1]?.cursor).toBe("provider-cursor-2");
    expect(first.value.nextCursor).toBe("provider-cursor-2");
    expect(first.value.completeThroughCursor).toBe("provider-cursor-2");
    expect(first.value.truncated).toBe(false);
    expect(JSON.stringify(first.value)).not.toContain("first");
    expect(dependencies.readDirectTranscript).toHaveBeenCalledWith(
      {
        providerId: "codex",
        remoteSessionId: "codex-thread-1",
        sessionId: "happier-session-1",
        machineId: "machine-1",
        afterCursor: null,
        limit: 2,
      },
      expect.objectContaining({ executable: "happier" }),
      undefined,
    );

    const after = await connector.readHistory({
      contractVersion: 1,
      identity: IDENTITY,
      afterCursor: "provider-cursor-2",
      limit: 1,
    });
    expect(after).toMatchObject({
      ok: true,
      value: {
        items: [{ nativeMessageId: "native-message-3", cursor: "provider-cursor-3" }],
        nextCursor: "provider-cursor-3",
      },
    });
    expect(dependencies.readDirectTranscript).toHaveBeenLastCalledWith(
      {
        providerId: "codex",
        remoteSessionId: "codex-thread-1",
        sessionId: "happier-session-1",
        machineId: "machine-1",
        afterCursor: "provider-cursor-2",
        limit: 1,
      },
      expect.objectContaining({ executable: "happier" }),
      undefined,
    );
  });

  it("maps the official Direct transcript stream to content-free message events", async () => {
    const { connector, dependencies } = setup();
    const subscription = await connector.subscribeEvents(IDENTITY);
    expect(subscription.ok).toBe(true);
    if (!subscription.ok) throw new Error(subscription.error.message);

    const iterator = subscription.value[Symbol.asyncIterator]();
    const event = await iterator.next();
    expect(event).toMatchObject({
      done: false,
      value: {
        identity: IDENTITY,
        eventType: "message",
        cursor: "provider-cursor-3",
        occurredAt: "2025-07-17T05:10:02.000Z",
        payload: {
          type: "transcript_delta",
          fromCursor: "provider-cursor-2",
          nextCursor: "provider-cursor-3",
          completeThroughCursor: "provider-cursor-3",
          truncated: false,
          items: [{ nativeMessageId: "native-message-3", cursor: "provider-cursor-3" }],
        },
      },
    });
    expect(JSON.stringify(event)).not.toContain("third");
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: {
        eventType: "status",
        occurredAt: "2025-07-17T05:10:02.500Z",
        payload: {
          type: "status",
          state: "running",
          lastActivityAt: "2025-07-17T05:10:02.000Z",
          connectorCursor: null,
          nativeWriterDetected: false,
        },
      },
    });
    expect(dependencies.followDirectTranscriptEvents).toHaveBeenCalledWith(
      {
        providerId: "codex",
        remoteSessionId: "codex-thread-1",
        sessionId: "happier-session-1",
        machineId: "machine-1",
        afterCursor: null,
        limit: 250,
      },
      expect.objectContaining({ executable: "happier" }),
      undefined,
    );
  });

  it("keeps recent provider activity idle when the provider is not running", async () => {
    const { connector } = setup({
      followDirectTranscriptEvents: vi.fn(() => (async function* events() {
        yield {
          eventType: "status" as const,
          machineId: "machine-1",
          providerId: "codex" as const,
          remoteSessionId: "codex-thread-1",
          sessionId: "happier-session-1",
          source: { kind: "codexHome" as const, home: "user" as const },
          isRunning: false,
          lastActivityAtMs: 1_752_729_002_000,
          observedAtMs: 1_752_729_002_500,
        };
      })()),
    });
    const subscription = await connector.subscribeEvents(IDENTITY);
    if (!subscription.ok) throw new Error(subscription.error.message);

    await expect(subscription.value[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: {
        eventType: "status",
        payload: { state: "idle", nativeWriterDetected: false },
      },
    });
  });

  it("fails closed when the immutable binding points at another Happier server profile", async () => {
    const { connector, dependencies } = setup();
    const driftedIdentity = { ...IDENTITY, serverProfileId: "server-2" };

    await expect(connector.readHistory({
      contractVersion: 1,
      identity: driftedIdentity,
      afterCursor: null,
      limit: 2,
    })).resolves.toMatchObject({ ok: false, error: { code: "conflict", retryable: false } });
    expect(dependencies.readDirectTranscript).not.toHaveBeenCalled();
    await expect(connector.getStatus(driftedIdentity)).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict", retryable: false },
    });
    expect(dependencies.getSessionStatus).not.toHaveBeenCalled();
    await expect(connector.subscribeEvents(driftedIdentity)).resolves.toMatchObject({
      ok: false,
      error: { code: "conflict", retryable: false },
    });
    expect(dependencies.followDirectTranscriptEvents).not.toHaveBeenCalled();
    await expect(connector.getCapabilities(driftedIdentity)).resolves.toMatchObject({
      capabilities: {
        history: { state: "unverified" },
        events: { state: "unverified" },
      },
    });
  });

  it("fails closed before send when the immutable Happier machine identity is missing", async () => {
    const { connector, dependencies } = setup();
    const request = sendRequest();

    await expect(connector.send({
      ...request,
      identity: { ...request.identity, machineId: null },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_request", retryable: false },
    });
    expect(dependencies.sendMessage).not.toHaveBeenCalled();
  });

  it("uses the persisted local id and returns the official send acknowledgement", async () => {
    const { connector, dependencies } = setup();
    const request = sendRequest();

    const first = await connector.send(request);
    const second = await connector.send(request);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      value: {
        outcome: "accepted",
        nativeMessageId: null,
        cursor: null,
        acceptedAt: NOW,
      },
    });
    const localId = (dependencies.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].localId;
    expect(localId).toBe(request.localMessageId);
    expect((dependencies.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1]?.[0].localId).toBe(localId);
    expect(first.ok && first.value.connectorAcknowledgementId).toBe(localId);
    expect(dependencies.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "happier-session-1",
        message: request.content,
        localId,
      }),
      expect.objectContaining({ executable: "happier" }),
      undefined,
    );
  });

  it("keeps ambiguous send failures visible and redacts connector errors", async () => {
    const { connector } = setup({
      sendMessage: vi.fn(async () => {
        throw new HappierCliError("timeout", "Bearer secret-token may have been accepted");
      }),
      getSessionStatus: vi.fn(async () => {
        throw new HappierCliError("authentication", "accessToken=secret-token");
      }),
    });

    await expect(connector.send(sendRequest())).resolves.toEqual({
      ok: true,
      value: {
        outcome: "delivery_uncertain",
        connectorAcknowledgementId: null,
        nativeMessageId: null,
        cursor: null,
        acceptedAt: null,
      },
    });
    const status = await connector.getStatus(IDENTITY);
    expect(status).toMatchObject({
      ok: false,
      error: { code: "authentication_required", retryable: false },
    });
    expect(JSON.stringify(status)).not.toContain("secret-token");
  });

  it("remembers official rate limits as a typed cooldown and expires them", async () => {
    let currentNow = NOW;
    const { connector } = setup({
      sendMessage: vi.fn(async () => {
        throw new HappierCliError(
          "server",
          "429 Bearer secret-rate-limit-token",
          undefined,
          "rate_limited",
        );
      }),
    }, () => currentNow);

    const failed = await connector.send(sendRequest());
    expect(failed).toMatchObject({
      ok: false,
      error: {
        code: "rate_limited",
        retryable: true,
        safeDetails: { officialCode: "rate_limited" },
      },
    });

    const limited = await connector.getHealth("fusion-host-1");
    expect(limited).toMatchObject({
      state: "rate_limited",
      rateLimit: "limited",
      reasonCodes: ["rate_limited"],
      retryAfterMs: 60_000,
    });
    expect(JSON.stringify(limited)).not.toContain("secret-rate-limit-token");

    currentNow = "2026-07-17T05:11:00.001Z";
    await expect(connector.getHealth("fusion-host-1")).resolves.toMatchObject({
      state: "healthy",
      rateLimit: "clear",
      reasonCodes: [],
      retryAfterMs: null,
    });
  });

  it("never echoes unknown token-shaped official error codes", async () => {
    const { connector } = setup({
      getSessionStatus: vi.fn(async () => {
        throw new HappierCliError(
          "server",
          "provider rejected accessTokenSecret123",
          undefined,
          "accessTokenSecret123",
        );
      }),
    });

    const status = await connector.getStatus(IDENTITY);
    expect(status).toMatchObject({
      ok: false,
      error: {
        code: "transport",
        safeDetails: {
          source: "happier_cli",
          category: "server",
        },
      },
    });
    expect(JSON.stringify(status)).not.toContain("accessTokenSecret123");
    expect(status.ok || status.error.safeDetails).not.toHaveProperty("officialCode");
  });

  it("reports typed runtime health and strips untrusted probe details", async () => {
    const healthy = await setup().connector.getHealth("fusion-host-1");
    expect(healthy).toMatchObject({
      connectorId: "happier",
      hostId: "fusion-host-1",
      state: "healthy",
      authentication: "authenticated",
      daemon: "running",
      server: "reachable",
      backend: "ready",
      rateLimit: "clear",
      host: "reachable",
      capabilities: {
        history: "unverified",
        events: "unverified",
        send: "unverified",
      },
      reasonCodes: [],
      retryAfterMs: null,
    });

    const { connector } = setup({
      probeRuntime: vi.fn(async () => ({
        discovered: true,
        executable: true,
        server: true,
        serverState: "reachable" as const,
        authenticated: false,
        daemon: true,
        backend: true,
        ready: false,
        backendId: "codex" as const,
        details: ["authentication-required", "Bearer top-secret-health-token"],
      })),
    });
    const blocked = await connector.getHealth("fusion-host-1");
    expect(blocked).toMatchObject({
      state: "authentication_required",
      authentication: "required",
      reasonCodes: ["authentication_required"],
    });
    expect(JSON.stringify(blocked)).not.toContain("top-secret-health-token");

    const rateLimitedProbe = await setup({
      probeRuntime: vi.fn(async () => {
        throw new HappierCliError(
          "server",
          "Bearer top-secret-probe-token",
          undefined,
          "too_many_requests",
        );
      }),
    }).connector.getHealth("fusion-host-1");
    expect(rateLimitedProbe).toMatchObject({
      state: "rate_limited",
      rateLimit: "limited",
      reasonCodes: ["probe_failed", "rate_limited"],
      retryAfterMs: 60_000,
    });
    expect(JSON.stringify(rateLimitedProbe)).not.toContain("top-secret-probe-token");

    const declaredRateLimit = await setup({
      probeRuntime: vi.fn(async () => ({
        discovered: true,
        executable: true,
        server: true,
        serverState: "reachable" as const,
        authenticated: true,
        daemon: true,
        backend: true,
        ready: false,
        backendId: "codex" as const,
        details: ["rate-limited"],
      })),
    }).connector.getHealth("fusion-host-1");
    expect(declaredRateLimit).toMatchObject({
      state: "rate_limited",
      rateLimit: "limited",
      reasonCodes: ["rate_limited"],
      retryAfterMs: 60_000,
    });
  });

  it("fails health closed when the runtime probe reports another configured backend", async () => {
    const { connector } = setup({
      probeRuntime: vi.fn(async () => ({
        discovered: true,
        executable: true,
        server: true,
        serverState: "reachable" as const,
        authenticated: true,
        daemon: true,
        backend: true,
        ready: true,
        backendId: "claude" as const,
        details: [],
      })),
    }, () => NOW, { backend: "codex" });

    await expect(connector.getHealth("fusion-host-1")).resolves.toMatchObject({
      state: "degraded",
      backend: "unavailable",
      reasonCodes: ["backend_unavailable"],
    });
  });

  it("demotes executable-backed certification when the attestation is missing or drifted", async () => {
    const unavailable = setup({
      getDirectSessionCapabilities: vi.fn(async () => {
        throw new HappierCliError("process", "capability command unavailable");
      }),
    });
    const drifted = setup({
      getDirectSessionCapabilities: vi.fn(async () => ({
        ...HAPPIER_DIRECT_SESSION_RUNTIME_MANIFEST,
        fingerprint: "sha256:drifted",
        cliVersion: "0.2.10",
      })),
    });

    for (const current of [unavailable, drifted]) {
      await expect(current.connector.getCapabilities(IDENTITY)).resolves.toMatchObject({
        capabilities: {
          deepLinks: {
            state: "unverified",
            evidenceRef: null,
            reasonCode: "source_unverified",
            lastVerifiedAt: null,
          },
        },
      });
      expect(current.dependencies.getDirectSessionCapabilities).toHaveBeenCalledOnce();
    }
  });

  it("reports uncertified and unavailable surfaces instead of fabricating parity", async () => {
    const { connector } = setup();
    const capabilities = await connector.getCapabilities(IDENTITY);
    expect(capabilities).toMatchObject({
      contractVersion: 1,
      connectorId: "happier",
      connectorVersion: connector.version,
      capabilities: {
        ensureExisting: { state: "unverified" },
        status: { state: "unverified" },
        history: { state: "unverified" },
        send: { state: "unverified" },
        create: { state: "unavailable" },
        events: { state: "unverified" },
        interrupt: { state: "unavailable" },
        resume: { state: "unavailable" },
        takeover: { state: "unavailable" },
        health: { state: "unverified" },
        deepLinks: {
          state: "verified",
          evidenceRef: `happier-runtime:${HAPPIER_DIRECT_SESSION_CAPABILITY_FINGERPRINT}:reviewed-source=${HAPPIER_DIRECT_SESSION_SOURCE_REVISION}:provider=codex:direct-session-open-url-codex`,
        },
      },
    });

    await expect(connector.create({
      contractVersion: 1,
      providerId: "codex",
      hostId: "fusion-host-1",
      workingDirectory: "G:\\repo",
      idempotencyKey: "create-1",
    })).resolves.toMatchObject({ ok: false, error: { code: "unavailable" } });
    await expect(connector.interrupt({
      contractVersion: 1,
      identity: IDENTITY,
      idempotencyKey: "interrupt-1",
      reason: "operator request",
    })).resolves.toMatchObject({ ok: false, error: { code: "unavailable" } });
  });

  it("rebuilds certified links from current configuration without changing separate binding identities", async () => {
    const request = {
      contractVersion: 1 as const,
      bindingId: "binding-1",
      identity: IDENTITY,
    };
    const original = await setup().connector.getDeepLinks(request);
    const moved = await setup({}, () => NOW, {
      webappUrl: "https://new.happier.example/root/",
    }).connector.getDeepLinks(request);
    const identities = {
      contractVersion: 1,
      bindingId: "binding-1",
      connectorId: "happier",
      providerId: "codex",
      nativeSessionId: "codex-thread-1",
      happierSessionId: "happier-session-1",
      serverProfileId: "server-1",
      machineId: "machine-1",
      hostId: "fusion-host-1",
    };

    expect(original).toEqual({
      ok: true,
      value: {
        ...identities,
        happierUrl: "https://app.happier.dev/session/happier-session-1?serverId=server-1",
        nativeSessionUrl: null,
      },
    });
    expect(moved).toEqual({
      ok: true,
      value: {
        ...identities,
        happierUrl: "https://new.happier.example/root/session/happier-session-1?serverId=server-1",
        nativeSessionUrl: null,
      },
    });

    await expect(setup().connector.getDeepLinks({
      ...request,
      identity: {
        ...IDENTITY,
        providerId: "claude",
        nativeSessionId: "claude-session-1",
      },
    })).resolves.toMatchObject({
      ok: true,
      value: {
        bindingId: "binding-1",
        providerId: "claude",
        nativeSessionId: "claude-session-1",
        happierSessionId: "happier-session-1",
        nativeSessionUrl: null,
      },
    });

    await expect(setup().connector.getDeepLinks({
      ...request,
      identity: { ...IDENTITY, serverProfileId: "server-2" },
    })).resolves.toMatchObject({ ok: false, error: { code: "conflict" } });

    const unsafe = setup({}, () => NOW, { webappUrl: "javascript:alert(1)" }).connector;
    await expect(unsafe.getCapabilities(IDENTITY)).resolves.toMatchObject({
      capabilities: { deepLinks: { state: "degraded", evidenceRef: null } },
    });
    await expect(unsafe.getDeepLinks(request)).resolves.toMatchObject({
      ok: false,
      error: { code: "degraded" },
    });
  });
});

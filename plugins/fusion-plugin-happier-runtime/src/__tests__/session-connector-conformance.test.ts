import {
  SESSION_CONNECTOR_CAPABILITIES,
  type SessionConnectorCapabilityName,
  type SessionConnectorIdentityV1,
} from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import {
  HAPPIER_DIRECT_SESSION_CAPABILITY_MATRIX,
  HAPPIER_DIRECT_SESSION_CAPABILITY_FINGERPRINT,
  HAPPIER_DIRECT_SESSION_PROVIDER_IDS,
  HAPPIER_DIRECT_SESSION_RUNTIME_MANIFEST,
  HAPPIER_DIRECT_SESSION_SOURCE_BLOBS,
  HAPPIER_DIRECT_SESSION_SOURCE_REVISION,
  HappierSessionConnector,
  type HappierDirectSessionProviderId,
  type HappierSessionConnectorDependencies,
} from "../session-connector.js";

const NOW = "2026-07-17T08:30:00.000Z";
const SERVER_ID = "server-1";
const MACHINE_ID = "machine-1";
const HOST_ID = "fusion-host-1";

const EXPECTED_CONNECTOR_STATES = {
  ensureExisting: "unverified",
  create: "unavailable",
  status: "unverified",
  history: "unverified",
  events: "unverified",
  send: "unverified",
  interrupt: "unavailable",
  resume: "unavailable",
  takeover: "unavailable",
  health: "unverified",
  deepLinks: "verified",
} as const satisfies Readonly<Record<SessionConnectorCapabilityName, string>>;

const PROVIDER_FIXTURES = {
  codex: {
    nativeSessionId: "codex-thread-1",
    canonicalUri: "codex://threads/codex-thread-1",
    source: { kind: "codexHome", home: "user" },
    nativeSessionUrl: null,
  },
  claude: {
    nativeSessionId: "claude-session-1",
    canonicalUri: "claude://sessions/claude-session-1",
    source: { kind: "claudeConfig" },
    nativeSessionUrl: null,
  },
  opencode: {
    nativeSessionId: "opencode-session-1",
    canonicalUri: "opencode://sessions/opencode-session-1",
    source: { kind: "opencodeServer" },
    nativeSessionUrl: null,
  },
} as const;

function identityFor(providerId: HappierDirectSessionProviderId): SessionConnectorIdentityV1 {
  return {
    connectorId: "happier",
    providerId,
    nativeSessionId: PROVIDER_FIXTURES[providerId].nativeSessionId,
    happierSessionId: `happier-${providerId}-session-1`,
    serverProfileId: SERVER_ID,
    machineId: MACHINE_ID,
    hostId: HOST_ID,
  };
}

function connectorFor(providerId: HappierDirectSessionProviderId): HappierSessionConnector {
  const fixture = PROVIDER_FIXTURES[providerId];
  const identity = identityFor(providerId);
  const dependencies: HappierSessionConnectorDependencies = {
    ensureDirectSession: vi.fn(async () => ({
      providerId,
      remoteSessionId: fixture.nativeSessionId,
      machineId: MACHINE_ID,
      serverId: SERVER_ID,
      sessionId: identity.happierSessionId!,
      created: false,
      openUrl: `https://app.happier.dev/session/${identity.happierSessionId}?serverId=${SERVER_ID}`,
    })),
    getSessionStatus: vi.fn(async () => ({
      sessionId: identity.happierSessionId!,
      session: { id: identity.happierSessionId!, active: true, lastActivityAt: 1_752_729_000_000 },
      agentState: { status: "waitingOnInput" },
    })),
    readDirectTranscript: vi.fn(async (input) => ({
      machineId: MACHINE_ID,
      providerId,
      remoteSessionId: fixture.nativeSessionId,
      sessionId: identity.happierSessionId!,
      source: fixture.source,
      fromCursor: input.afterCursor,
      nextCursor: "cursor-1",
      truncated: false,
      items: [],
    })),
    followDirectTranscriptEvents: vi.fn(() => (async function* events() {
      yield {
        machineId: MACHINE_ID,
        providerId,
        remoteSessionId: fixture.nativeSessionId,
        sessionId: identity.happierSessionId!,
        source: fixture.source,
        fromCursor: null,
        nextCursor: "cursor-1",
        truncated: false,
        items: [],
      };
    })()),
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
      backendId: providerId,
      details: [],
    })),
    getDirectSessionCapabilities: vi.fn(async () => ({
      ...HAPPIER_DIRECT_SESSION_RUNTIME_MANIFEST,
      fingerprint: HAPPIER_DIRECT_SESSION_CAPABILITY_FINGERPRINT,
      cliVersion: "0.2.10",
    })),
  };
  return new HappierSessionConnector({
    settings: {
      executable: "happier",
      activeServerId: SERVER_ID,
      webappUrl: "https://app.happier.dev",
      backend: providerId,
    },
    now: () => NOW,
    dependencies,
  });
}

async function exerciseVerifiedCapability(
  connector: HappierSessionConnector,
  identity: SessionConnectorIdentityV1,
  capability: SessionConnectorCapabilityName,
): Promise<void> {
  switch (capability) {
    case "history": {
      await expect(connector.readHistory({
        contractVersion: 1,
        identity,
        afterCursor: null,
        limit: 10,
      })).resolves.toMatchObject({ ok: true, value: { nextCursor: "cursor-1" } });
      return;
    }
    case "events": {
      const subscription = await connector.subscribeEvents(identity);
      if (!subscription.ok) throw new Error(subscription.error.message);
      await expect(subscription.value[Symbol.asyncIterator]().next()).resolves.toMatchObject({
        done: false,
        value: { eventType: "message", cursor: "cursor-1", identity },
      });
      return;
    }
    case "deepLinks": {
      await expect(connector.getDeepLinks({
        contractVersion: 1,
        bindingId: `binding-${identity.providerId}`,
        identity,
      })).resolves.toMatchObject({
        ok: true,
        value: {
          providerId: identity.providerId,
          nativeSessionId: identity.nativeSessionId,
          happierSessionId: identity.happierSessionId,
          serverProfileId: SERVER_ID,
          nativeSessionUrl: PROVIDER_FIXTURES[identity.providerId as HappierDirectSessionProviderId].nativeSessionUrl,
        },
      });
      return;
    }
    default:
      throw new Error(`Verified capability ${capability} has no connector conformance exercise`);
  }
}

describe("Happier source-backed provider capability matrix", () => {
  it("is exhaustive, pinned, and separates upstream surfaces from connector certification", () => {
    expect(HAPPIER_DIRECT_SESSION_PROVIDER_IDS).toEqual(["codex", "claude", "opencode"]);
    expect(Object.keys(HAPPIER_DIRECT_SESSION_CAPABILITY_MATRIX)).toEqual(HAPPIER_DIRECT_SESSION_PROVIDER_IDS);

    for (const providerId of HAPPIER_DIRECT_SESSION_PROVIDER_IDS) {
      const row = HAPPIER_DIRECT_SESSION_CAPABILITY_MATRIX[providerId];
      expect(row.providerId).toBe(providerId);
      expect(row.sourceRevision).toBe(HAPPIER_DIRECT_SESSION_SOURCE_REVISION);
      expect(Object.keys(row.capabilities)).toEqual(SESSION_CONNECTOR_CAPABILITIES);
      expect(row.nativeDeepLink).toBe(providerId === "codex" ? "canonical_uri_only" : "unavailable");

      for (const capability of SESSION_CONNECTOR_CAPABILITIES) {
        const source = row.capabilities[capability];
        expect(source.connectorState).toBe(EXPECTED_CONNECTOR_STATES[capability]);
        expect(source.sourceRefs.length).toBeGreaterThan(0);
        expect(source.sourceRefs.every((reference) => reference.startsWith("happier:") || reference.startsWith("fusion:"))).toBe(true);
        if (source.connectorState === "verified") {
          expect(source.upstreamSurface).toBe("public_direct_session_cli");
          expect(source.evidenceKey).toMatch(/^[a-z0-9][a-z0-9._-]+$/u);
          expect(source.reasonCode).toBeNull();
        } else {
          expect(source.evidenceKey).toBeNull();
          expect(source.reasonCode).not.toBeNull();
        }
      }
    }
  });

  it("pins every Happier source reference to an exact blob at the reviewed revision", () => {
    const referencedPaths = new Set<string>();
    for (const providerId of HAPPIER_DIRECT_SESSION_PROVIDER_IDS) {
      for (const capability of SESSION_CONNECTOR_CAPABILITIES) {
        for (const reference of HAPPIER_DIRECT_SESSION_CAPABILITY_MATRIX[providerId].capabilities[capability].sourceRefs) {
          if (reference.startsWith("happier:")) referencedPaths.add(reference.slice("happier:".length));
        }
      }
    }

    expect([...referencedPaths].sort()).toEqual(Object.keys(HAPPIER_DIRECT_SESSION_SOURCE_BLOBS).sort());
    for (const path of referencedPaths) {
      expect(HAPPIER_DIRECT_SESSION_SOURCE_BLOBS[path]).toMatch(/^[0-9a-f]{40}$/u);
    }
  });

  for (const providerId of HAPPIER_DIRECT_SESSION_PROVIDER_IDS) {
    describe(providerId, () => {
      it("publishes the exact source matrix through connector discovery", async () => {
        const discovered = await connectorFor(providerId).getCapabilities(identityFor(providerId));
        expect(discovered.sourceRevision).toBe(HAPPIER_DIRECT_SESSION_SOURCE_REVISION);
        for (const capability of SESSION_CONNECTOR_CAPABILITIES) {
          const source = HAPPIER_DIRECT_SESSION_CAPABILITY_MATRIX[providerId].capabilities[capability];
          expect(discovered.capabilities[capability]).toMatchObject({
            state: source.connectorState,
            reasonCode: source.reasonCode,
          });
        }
      });

      for (const capability of SESSION_CONNECTOR_CAPABILITIES) {
        const source = HAPPIER_DIRECT_SESSION_CAPABILITY_MATRIX[providerId].capabilities[capability];
        const conformance = source.connectorState === "verified" ? it : it.skip;
        conformance(
          `${capability} connector exercise requires verified; current=${source.connectorState} reason=${source.reasonCode}`,
          async () => {
            const connector = connectorFor(providerId);
            const identity = identityFor(providerId);
            const discovered = await connector.getCapabilities(identity);
            expect(discovered.sourceRevision).toBe(HAPPIER_DIRECT_SESSION_SOURCE_REVISION);
            expect(discovered.capabilities[capability]).toMatchObject({
              state: "verified",
              reasonCode: null,
            });
            await exerciseVerifiedCapability(connector, identity, capability);
          },
        );
      }

      it("returns typed unavailable results for every unimplemented control surface", async () => {
        const connector = connectorFor(providerId);
        const identity = identityFor(providerId);
        await expect(connector.create({
          contractVersion: 1,
          providerId,
          hostId: HOST_ID,
          workingDirectory: "G:\\repo",
          idempotencyKey: `create-${providerId}`,
        })).resolves.toMatchObject({ ok: false, error: { code: "unavailable" } });
        for (const [operation, invoke] of [
          ["interrupt", connector.interrupt.bind(connector)],
          ["resume", connector.resume.bind(connector)],
          ["takeover", connector.takeover.bind(connector)],
        ] as const) {
          await expect(invoke({
            contractVersion: 1,
            identity,
            idempotencyKey: `${operation}-${providerId}`,
            reason: "conformance check",
          })).resolves.toMatchObject({ ok: false, error: { code: "unavailable" } });
        }
      });
    });
  }

  it("demotes every source-certified surface when the pinned Happier revision drifts", async () => {
    const connector = new HappierSessionConnector({
      settings: { activeServerId: SERVER_ID, webappUrl: "https://app.happier.dev" },
      sourceRevision: "unreviewed-revision",
      now: () => NOW,
    });
    const capabilities = await connector.getCapabilities(identityFor("codex"));

    for (const capability of SESSION_CONNECTOR_CAPABILITIES) {
      const expected = EXPECTED_CONNECTOR_STATES[capability] === "verified" ? "unverified" : EXPECTED_CONNECTOR_STATES[capability];
      expect(capabilities.capabilities[capability].state).toBe(expected);
      if (EXPECTED_CONNECTOR_STATES[capability] === "verified") {
        expect(capabilities.capabilities[capability]).toMatchObject({
          evidenceRef: null,
          reasonCode: "source_unverified",
          lastVerifiedAt: null,
        });
      }
    }
  });

  it("publishes only capabilities shared by every audited provider when no identity is available", async () => {
    const connector = connectorFor("codex");
    const capabilities = await connector.getCapabilities();
    for (const capability of SESSION_CONNECTOR_CAPABILITIES) {
      expect(capabilities.capabilities[capability].state).toBe(EXPECTED_CONNECTOR_STATES[capability]);
    }
    expect(capabilities.capabilities.deepLinks.evidenceRef).toBe(
      `happier-runtime:${HAPPIER_DIRECT_SESSION_CAPABILITY_FINGERPRINT}:reviewed-source=${HAPPIER_DIRECT_SESSION_SOURCE_REVISION}:provider=all:provider-matrix-deepLinks`,
    );

    const health = await connector.getHealth(HOST_ID);
    expect(health.capabilities).toEqual(EXPECTED_CONNECTOR_STATES);
  });

  it("fails closed for provider identities outside the audited matrix", async () => {
    const connector = connectorFor("codex");
    const capabilities = await connector.getCapabilities({
      ...identityFor("codex"),
      providerId: "unsupported-provider",
    });

    expect(capabilities.capabilities.history).toMatchObject({
      state: "unverified",
      evidenceRef: null,
      reasonCode: "source_unverified",
    });
    expect(capabilities.capabilities.events).toMatchObject({
      state: "unverified",
      evidenceRef: null,
      reasonCode: "source_unverified",
    });
    expect(capabilities.capabilities.deepLinks).toMatchObject({
      state: "unverified",
      evidenceRef: null,
      reasonCode: "source_unverified",
    });
  });
});

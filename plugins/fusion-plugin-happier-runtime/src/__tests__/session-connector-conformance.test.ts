import { SESSION_CONNECTOR_CAPABILITIES, type SessionConnectorIdentityV1 } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import {
  HAPPIER_LOCAL_DIRECT_SESSION_EXTENSION_STATE,
  HAPPIER_OFFICIAL_MCP_SOURCE_REVISION,
  createHappierSessionConnectorWithHostWriteAuthorization,
  HappierSessionConnector,
} from "../session-connector.js";
import { HAPPIER_OFFICIAL_MCP_TOOLS, type HappierMcpClientFactoryInput } from "../happier-mcp-client.js";

const NOW = "2026-07-19T19:29:00.000Z";
const URI = "claude://sessions/claude-session-1";
const IDENTITY: SessionConnectorIdentityV1 = {
  connectorId: "happier",
  providerId: "claude",
  nativeSessionId: "claude-session-1",
  happierSessionId: "happier-session-1",
  serverProfileId: "server-1",
  machineId: "machine-1",
  hostId: "fusion-host-1",
};

function connectorFor(options: { binding?: boolean; takeover?: boolean; hostAuthorization?: boolean; tools?: string[] } = {}) {
  const tools = options.tools ?? Object.values(HAPPIER_OFFICIAL_MCP_TOOLS);
  const client = {
    listTools: vi.fn(async () => tools.map((name) => ({ name }))),
    callTool: vi.fn(async () => ({ structuredContent: { sessionId: IDENTITY.happierSessionId } })),
    close: vi.fn(async () => undefined),
  };
  const connectorOptions = {
    settings: {
      activeServerId: "server-1",
      ...(options.binding === false ? {} : {
        happierSessionBindings: [{
          canonicalSessionUri: URI,
          happierSessionId: IDENTITY.happierSessionId!,
          serverProfileId: IDENTITY.serverProfileId!,
          machineId: IDENTITY.machineId!,
          ...(options.takeover ? { takeoverConfirmedAt: NOW } : {}),
        }],
      }),
    },
    now: () => NOW,
    dependencies: {
      openMcpClient: vi.fn(async () => client),
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
    },
  };
  const verifier = options.hostAuthorization
    ? vi.fn(async (request) => ({
      authorized: true as const,
      authorizationId: "host-grant-1",
      scopeFingerprint: request.scopeFingerprint,
    }))
    : undefined;
  return verifier
    ? createHappierSessionConnectorWithHostWriteAuthorization(connectorOptions, verifier)
    : new HappierSessionConnector(connectorOptions);
}

describe("Happier official MCP capability conformance", () => {
  it("uses the documented external MCP Session tool names", () => {
    expect(HAPPIER_OFFICIAL_MCP_TOOLS).toEqual({
      list: "session_list",
      status: "session_status_get",
      send: "session_message_send",
      wait: "session_wait_idle",
      stop: "session_stop",
    });
  });

  it("certifies an MCP send only when a host-owned request authorization verifier is installed", async () => {
    const withoutHostVerifier = await connectorFor({ takeover: true }).getCapabilities(IDENTITY);
    const capabilities = await connectorFor({ takeover: true, hostAuthorization: true }).getCapabilities(IDENTITY);

    expect(capabilities.sourceRevision).toBe(HAPPIER_OFFICIAL_MCP_SOURCE_REVISION);
    expect(withoutHostVerifier.capabilities).toMatchObject({
      send: { state: "unavailable", reasonCode: "operation_unavailable" },
      interrupt: { state: "unavailable", reasonCode: "operation_unavailable" },
    });
    expect(capabilities.capabilities).toMatchObject({
      ensureExisting: { state: "verified", evidenceRef: "happier-mcp:tool-discovery:session_list+session_status_get" },
      status: { state: "verified", evidenceRef: "happier-mcp:tool-discovery:session_status_get" },
      send: { state: "verified", evidenceRef: "happier-mcp:tool-discovery:session_message_send+session_wait_idle" },
      interrupt: { state: "unavailable", reasonCode: "operation_unavailable" },
      create: { state: "unavailable", reasonCode: "operation_unavailable" },
      history: { state: "unavailable", reasonCode: "operation_unavailable" },
      events: { state: "unavailable", reasonCode: "operation_unavailable" },
      resume: { state: "unavailable", reasonCode: "operation_unavailable" },
      takeover: { state: "unavailable", reasonCode: "operation_unavailable" },
      health: { state: "unverified", reasonCode: "source_unverified" },
      deepLinks: { state: "unverified", reasonCode: "source_unverified" },
    });
    expect(Object.keys(capabilities.capabilities)).toEqual(SESSION_CONNECTOR_CAPABILITIES);
  });

  it("does not certify attachment without a persisted binding or an official MCP status tool", async () => {
    const withoutBinding = await connectorFor({ binding: false }).getCapabilities();
    const withoutStatusTool = await connectorFor({ tools: ["session_list"] }).getCapabilities(IDENTITY);

    expect(withoutBinding.capabilities.ensureExisting).toMatchObject({
      state: "unavailable",
      reasonCode: "operation_unavailable",
    });
    expect(withoutStatusTool.capabilities.ensureExisting).toMatchObject({
      state: "unavailable",
      reasonCode: "operation_unavailable",
    });
  });

  it("uses the intersection of every persisted binding when Room creation asks globally", async () => {
    const firstSessionId = "happier-session-global-1";
    const secondSessionId = "happier-session-global-2";
    const openMcpClient = vi.fn(async ({ sessionId }: HappierMcpClientFactoryInput) => ({
      listTools: vi.fn(async () => (sessionId === firstSessionId
        ? [HAPPIER_OFFICIAL_MCP_TOOLS.list, HAPPIER_OFFICIAL_MCP_TOOLS.status].map((name) => ({ name }))
        : [HAPPIER_OFFICIAL_MCP_TOOLS.list].map((name) => ({ name })))),
      callTool: vi.fn(async () => ({ structuredContent: {} })),
      close: vi.fn(async () => undefined),
    }));
    const connector = new HappierSessionConnector({
      settings: {
        activeServerId: "server-1",
        happierSessionBindings: [
          {
            canonicalSessionUri: "codex://threads/global-1",
            happierSessionId: firstSessionId,
            serverProfileId: "server-1",
            machineId: "machine-1",
          },
          {
            canonicalSessionUri: "codex://threads/global-2",
            happierSessionId: secondSessionId,
            serverProfileId: "server-1",
            machineId: "machine-1",
          },
        ],
      },
      now: () => NOW,
      dependencies: { openMcpClient },
    });

    const capabilities = await connector.getCapabilities();

    expect(openMcpClient).toHaveBeenCalledTimes(2);
    expect(capabilities.capabilities.ensureExisting).toMatchObject({
      state: "unavailable",
      reasonCode: "operation_unavailable",
    });
  });

  it("timestamps health after an asynchronous runtime probe completes", async () => {
    const timestamps = ["2026-07-19T19:29:00.000Z", "2026-07-19T19:29:45.000Z"];
    const connector = new HappierSessionConnector({
      settings: {
        activeServerId: "server-1",
        happierSessionBindings: [{
          canonicalSessionUri: URI,
          happierSessionId: IDENTITY.happierSessionId!,
          serverProfileId: IDENTITY.serverProfileId!,
          machineId: IDENTITY.machineId!,
        }],
      },
      now: () => timestamps.shift() ?? "2026-07-19T19:29:45.000Z",
      dependencies: {
        openMcpClient: vi.fn(async () => ({
          listTools: vi.fn(async () => Object.values(HAPPIER_OFFICIAL_MCP_TOOLS).map((name) => ({ name }))),
          callTool: vi.fn(async () => ({ structuredContent: {} })),
          close: vi.fn(async () => undefined),
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
      },
    });

    const health = await connector.getHealth(IDENTITY.hostId);

    expect(health.checkedAt).toBe("2026-07-19T19:29:45.000Z");
  });

  it("labels the retired direct argv bridge as unattested rather than a production capability", () => {
    expect(HAPPIER_LOCAL_DIRECT_SESSION_EXTENSION_STATE).toBe("local_extension_unattested");
  });
});

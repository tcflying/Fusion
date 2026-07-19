import { SESSION_CONNECTOR_CAPABILITIES, type SessionConnectorIdentityV1 } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import {
  HAPPIER_LOCAL_DIRECT_SESSION_EXTENSION_STATE,
  HAPPIER_OFFICIAL_MCP_SOURCE_REVISION,
  HappierSessionConnector,
} from "../session-connector.js";
import { HAPPIER_OFFICIAL_MCP_TOOLS } from "../happier-mcp-client.js";

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

function connectorFor(options: { binding?: boolean; takeover?: boolean; tools?: string[] } = {}) {
  const tools = options.tools ?? Object.values(HAPPIER_OFFICIAL_MCP_TOOLS);
  const client = {
    listTools: vi.fn(async () => tools.map((name) => ({ name }))),
    callTool: vi.fn(async () => ({ structuredContent: { sessionId: IDENTITY.happierSessionId } })),
    close: vi.fn(async () => undefined),
  };
  return new HappierSessionConnector({
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
  });
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

  it("certifies only manually bound MCP controls and leaves native-only surfaces unavailable", async () => {
    const connector = connectorFor({ takeover: true });
    const capabilities = await connector.getCapabilities(IDENTITY);

    expect(capabilities.sourceRevision).toBe(HAPPIER_OFFICIAL_MCP_SOURCE_REVISION);
    expect(capabilities.capabilities).toMatchObject({
      ensureExisting: { state: "verified", evidenceRef: "happier-mcp:tool-discovery:session_list+session_status_get" },
      status: { state: "verified", evidenceRef: "happier-mcp:tool-discovery:session_status_get" },
      send: { state: "verified", evidenceRef: "happier-mcp:tool-discovery:session_message_send+session_wait_idle" },
      interrupt: { state: "verified", evidenceRef: "happier-mcp:tool-discovery:session_stop" },
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

  it("labels the retired direct argv bridge as unattested rather than a production capability", () => {
    expect(HAPPIER_LOCAL_DIRECT_SESSION_EXTENSION_STATE).toBe("local_extension_unattested");
  });
});

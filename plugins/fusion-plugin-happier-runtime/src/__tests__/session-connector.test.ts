import {
  buildRoomConnectorLocalMessageId,
  hashRoomValue,
  type SessionConnectorIdentityV1,
  type SessionConnectorSendRequestV1,
} from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import { HappierSessionConnector } from "../session-connector.js";

const NOW = "2026-07-19T19:29:00.000Z";
const URI = "codex://threads/codex-thread-1";
const IDENTITY: SessionConnectorIdentityV1 = {
  connectorId: "happier",
  providerId: "codex",
  nativeSessionId: "codex-thread-1",
  happierSessionId: "happier-session-1",
  serverProfileId: "server-1",
  machineId: "machine-1",
  hostId: "fusion-host-1",
};

function clientWithTools(
  tools = ["session_list", "session_status_get", "session_message_send", "session_wait_idle", "session_stop"],
) {
  const callTool = vi.fn(async (input: { name: string; arguments?: Record<string, unknown> }) => {
    switch (input.name) {
      case "session_list":
        return { structuredContent: { sessions: [{ id: IDENTITY.happierSessionId }] } };
      case "session_status_get":
        return {
          structuredContent: {
            session: { id: IDENTITY.happierSessionId, active: true, updatedAt: NOW },
            agentState: { status: "waitingOnInput" },
          },
        };
      case "session_message_send":
      case "session_wait_idle":
      case "session_stop":
        return { structuredContent: { sessionId: IDENTITY.happierSessionId, ok: true } };
      default:
        throw new Error(`unexpected tool ${input.name}`);
    }
  });
  return {
    listTools: vi.fn(async () => tools.map((name) => ({ name }))),
    callTool,
    close: vi.fn(async () => undefined),
  };
}

function setup(options: { takeover?: boolean; tools?: string[] } = {}) {
  const client = clientWithTools(options.tools);
  const openMcpClient = vi.fn(async () => client);
  const connector = new HappierSessionConnector({
    settings: {
      executable: "happier",
      activeServerId: "server-1",
      webappUrl: "https://app.happier.dev",
      happierSessionBindings: [{
        canonicalSessionUri: URI,
        happierSessionId: IDENTITY.happierSessionId!,
        serverProfileId: IDENTITY.serverProfileId!,
        machineId: IDENTITY.machineId!,
        ...(options.takeover ? { takeoverConfirmedAt: NOW } : {}),
      }],
    },
    now: () => NOW,
    dependencies: {
      openMcpClient,
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
  return { connector, client, openMcpClient };
}

function sendRequest(): SessionConnectorSendRequestV1 {
  const content = "Continue the explicit Happier Session";
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

describe("HappierSessionConnector official MCP operations", () => {
  it("maps an explicit bound session status without asserting a native writer", async () => {
    const { connector, client } = setup();

    await expect(connector.getStatus(IDENTITY)).resolves.toEqual({
      ok: true,
      value: {
        identity: IDENTITY,
        state: "waiting_input",
        lastActivityAt: NOW,
        connectorCursor: null,
        nativeWriterDetected: false,
      },
    });
    expect(client.callTool).toHaveBeenCalledWith({
      name: "session_status_get",
      arguments: { sessionId: IDENTITY.happierSessionId },
    });
  });

  it("sends, waits, and stops only after persisted Direct UI takeover evidence", async () => {
    const { connector, client, openMcpClient } = setup({ takeover: true });
    const request = sendRequest();

    await expect(connector.send(request)).resolves.toMatchObject({
      ok: true,
      value: {
        outcome: "confirmed",
        connectorAcknowledgementId: request.localMessageId,
        acceptedAt: NOW,
      },
    });
    await expect(connector.interrupt({
      contractVersion: 1,
      identity: IDENTITY,
      idempotencyKey: "stop-1",
      reason: "operator requested stop",
    })).resolves.toEqual({
      ok: true,
      value: { state: "accepted", connectorAcknowledgementId: "stop-1" },
    });

    expect(openMcpClient).toHaveBeenCalledWith(expect.objectContaining({ sessionId: IDENTITY.happierSessionId }));
    expect(client.callTool).toHaveBeenCalledWith({
      name: "session_message_send",
      arguments: {
        sessionId: IDENTITY.happierSessionId,
        message: request.content,
        wait: false,
        timeoutSeconds: 300,
      },
    });
    expect(client.callTool).toHaveBeenCalledWith({
      name: "session_wait_idle",
      arguments: { sessionId: IDENTITY.happierSessionId, timeoutSeconds: 300 },
    });
    expect(client.callTool).toHaveBeenCalledWith({
      name: "session_stop",
      arguments: { sessionId: IDENTITY.happierSessionId },
    });
  });

  it("fails closed before a write when Direct UI takeover is not persisted", async () => {
    const { connector, client } = setup();

    await expect(connector.send(sendRequest())).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unavailable",
        safeDetails: { bindingState: "happier_direct_ui_takeover_required" },
      },
    });
    expect(client.listTools).not.toHaveBeenCalled();
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("fails closed when the official MCP session-status capability is unavailable", async () => {
    const { connector, client } = setup({ tools: ["session_list"] });

    await expect(connector.getStatus(IDENTITY)).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unavailable",
        safeDetails: {
          bindingState: "official_mcp_capability_required",
          missingTools: ["session_status_get"],
        },
      },
    });
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("leaves provider-native history and event subscription unavailable", async () => {
    const { connector } = setup();

    await expect(connector.readHistory({
      contractVersion: 1,
      identity: IDENTITY,
      afterCursor: null,
      limit: 1,
    })).resolves.toMatchObject({ ok: false, error: { code: "unavailable" } });
    await expect(connector.subscribeEvents(IDENTITY)).resolves.toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  });
});

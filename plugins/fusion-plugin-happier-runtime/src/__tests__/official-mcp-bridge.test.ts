import type { SessionConnectorIdentityV1 } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import {
  HappierSessionConnector,
  type HappierSessionConnectorDependencies,
} from "../session-connector.js";
import type { HappierCliSettings } from "../types.js";

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

type LegacyExtensionSpies = Readonly<{
  ensureDirectSession: ReturnType<typeof vi.fn>;
  getDirectSessionCapabilities: ReturnType<typeof vi.fn>;
}>;

function legacyExtensionDependencies(): LegacyExtensionSpies {
  const ensureDirectSession = vi.fn(async () => ({
    providerId: "codex" as const,
    remoteSessionId: IDENTITY.nativeSessionId,
    machineId: IDENTITY.machineId!,
    serverId: IDENTITY.serverProfileId!,
    sessionId: IDENTITY.happierSessionId!,
    created: true,
    openUrl: "https://app.happier.dev/session/happier-session-1?serverId=server-1",
  }));
  return {
    ensureDirectSession,
    getDirectSessionCapabilities: vi.fn(async () => {
      throw new Error("legacy direct-session extension should not be discovered");
    }),
  };
}

function officialMcpClient() {
  const callTool = vi.fn(async (input: { name: string; arguments?: Record<string, unknown> }) => {
    if (input.name === "session_list") {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            result: { sessions: [{ id: IDENTITY.happierSessionId }] },
          }),
        }],
      };
    }
    if (input.name === "session_status_get") {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            result: {
              ok: true,
              session: { id: IDENTITY.happierSessionId, active: true, updatedAt: "2026-07-19T19:29:00.000Z" },
              agentState: { status: "waitingOnInput" },
            },
          }),
        }],
      };
    }
    throw new Error(`unexpected MCP tool ${input.name}`);
  });
  return {
    listTools: vi.fn(async () => [
      { name: "session_list" },
      { name: "session_status_get" },
      { name: "session_message_send" },
      { name: "session_wait_idle" },
      { name: "session_stop" },
    ]),
    callTool,
    close: vi.fn(async () => undefined),
  };
}

describe("Happier official MCP bridge", () => {
  it("fails closed with an actionable binding-required result by default", async () => {
    const legacy = legacyExtensionDependencies();
    const openMcpClient = vi.fn(async () => officialMcpClient());
    const connector = new HappierSessionConnector({
      settings: { executable: "happier", activeServerId: "server-1" },
      dependencies: {
        ...legacy,
        openMcpClient,
      } as unknown as Partial<HappierSessionConnectorDependencies>,
    });

    await expect(connector.ensureExisting({
      contractVersion: 1,
      canonicalSessionUri: URI,
      requiredHostId: IDENTITY.hostId,
      requiredMachineId: IDENTITY.machineId!,
      idempotencyKey: "attach-1",
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unavailable",
        retryable: false,
        safeDetails: {
          bindingState: "happier_session_binding_required",
          localExtensionState: "local_extension_unattested",
        },
      },
    });
    expect(legacy.ensureDirectSession).not.toHaveBeenCalled();
    await connector.getCapabilities();
    expect(openMcpClient).not.toHaveBeenCalled();
  });

  it("validates an explicit persisted Happier binding through the official MCP tool contract", async () => {
    const legacy = legacyExtensionDependencies();
    const client = officialMcpClient();
    const openMcpClient = vi.fn(async () => client);
    const settings = {
      executable: "happier",
      activeServerId: "server-1",
      happierSessionBindings: [{
        canonicalSessionUri: URI,
        happierSessionId: IDENTITY.happierSessionId,
        serverProfileId: IDENTITY.serverProfileId,
        machineId: IDENTITY.machineId,
        takeoverConfirmedAt: "2026-07-19T19:29:00.000Z",
      }],
    } as unknown as HappierCliSettings;
    const connector = new HappierSessionConnector({
      settings,
      dependencies: {
        ...legacy,
        openMcpClient,
      } as unknown as Partial<HappierSessionConnectorDependencies>,
      now: () => "2026-07-19T19:29:00.000Z",
    });

    await expect(connector.ensureExisting({
      contractVersion: 1,
      canonicalSessionUri: URI,
      requiredHostId: IDENTITY.hostId,
      requiredMachineId: IDENTITY.machineId!,
      idempotencyKey: "attach-2",
    })).resolves.toMatchObject({
      ok: true,
      value: {
        identity: IDENTITY,
        createdLink: false,
        providerTurnStarted: false,
      },
    });
    expect(openMcpClient).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({ executable: "happier" }),
      sessionId: IDENTITY.happierSessionId,
    }));
    expect(client.listTools).toHaveBeenCalledOnce();
    expect(client.callTool).toHaveBeenNthCalledWith(1, {
      name: "session_list",
      arguments: {},
    });
    expect(client.callTool).toHaveBeenNthCalledWith(2, {
      name: "session_status_get",
      arguments: { sessionId: IDENTITY.happierSessionId },
    });
    expect(client.close).toHaveBeenCalledOnce();
    expect(legacy.ensureDirectSession).not.toHaveBeenCalled();
  });

  it("rejects an unpersisted identity before opening official MCP status", async () => {
    const openMcpClient = vi.fn(async () => officialMcpClient());
    const connector = new HappierSessionConnector({
      settings: { executable: "happier", activeServerId: "server-1" },
      dependencies: { openMcpClient },
    });

    await expect(connector.getStatus(IDENTITY)).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unavailable",
        safeDetails: { bindingState: "happier_session_binding_required" },
      },
    });
    expect(openMcpClient).not.toHaveBeenCalled();
  });

  it("never uses the unattested local extension for normal capability routing", async () => {
    const legacy = legacyExtensionDependencies();
    const client = officialMcpClient();
    const connector = new HappierSessionConnector({
      settings: { executable: "happier", activeServerId: "server-1" },
      dependencies: {
        ...legacy,
        openMcpClient: vi.fn(async () => client),
      } as unknown as Partial<HappierSessionConnectorDependencies>,
    });

    await connector.getCapabilities(IDENTITY);

    expect(legacy.getDirectSessionCapabilities).not.toHaveBeenCalled();
  });
});

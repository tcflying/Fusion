import {
  SESSION_CONNECTOR_PROVIDER_TELEMETRY_CONTRACT_VERSION,
  type SessionConnectorIdentityV1,
  type SessionConnectorProviderTelemetrySourceV1,
} from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import {
  HAPPIER_LOCAL_MCP_EXTENSION_TOOLS,
  type HappierMcpClient,
} from "../happier-mcp-client.js";
import { HappierSessionConnector } from "../session-connector-facade.js";

const NOW = "2026-07-21T03:00:00.000Z";
const IDENTITY: SessionConnectorIdentityV1 = {
  connectorId: "happier",
  providerId: "codex",
  nativeSessionId: "codex-thread-1",
  happierSessionId: "happier-session-1",
  serverProfileId: "server-1",
  machineId: "machine-1",
  hostId: "fusion-host-1",
};

describe("Happier provider telemetry facade", () => {
  it("implements and forwards the Core telemetry source without loading a real Happier process", async () => {
    const client: HappierMcpClient = {
      listTools: vi.fn(async () => [{ name: HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.providerTelemetry }]),
      callTool: vi.fn(async () => ({
        structuredContent: {
          ok: true,
          kind: "fusion_provider_telemetry",
          contractVersion: 1,
          state: "reported",
          provider: "codex",
          source: "happier_persisted_in_band_provider_snapshot",
          freshness: "fresh",
          observedAt: NOW,
          expiresAt: "2026-07-21T03:01:00.000Z",
          limitations: {
            providerAvailability: "not_inferred",
            capacity: "not_reported",
            onDemandProviderRefresh: "not_attempted",
            accountIdentity: "not_reported",
            rawSnapshot: "not_reported",
          },
        },
      })),
      close: vi.fn(async () => undefined),
    };
    const openMcpClient = vi.fn(async () => client);
    const connector = new HappierSessionConnector({
      settings: {
        activeServerId: "server-1",
        enableLocalProviderTelemetry: true,
        happierSessionBindings: [{
          canonicalSessionUri: "codex://threads/codex-thread-1",
          happierSessionId: IDENTITY.happierSessionId!,
          serverProfileId: IDENTITY.serverProfileId!,
          machineId: IDENTITY.machineId!,
        }],
      },
      now: () => NOW,
      dependencies: { openMcpClient },
    });
    const source: SessionConnectorProviderTelemetrySourceV1 = connector;

    await expect(source.getProviderTelemetry(IDENTITY)).resolves.toEqual({
      ok: true,
      value: {
        contractVersion: SESSION_CONNECTOR_PROVIDER_TELEMETRY_CONTRACT_VERSION,
        state: "reported",
        identity: IDENTITY,
        providerId: "codex",
        source: "happier_persisted_in_band_provider_snapshot",
        observedAt: NOW,
        expiresAt: "2026-07-21T03:01:00.000Z",
        freshness: "fresh",
        limitations: {
          providerAvailability: "not_inferred",
          capacity: "not_reported",
          onDemandProviderRefresh: "not_attempted",
          accountIdentity: "not_reported",
          rawSnapshot: "not_reported",
        },
      },
    });
    expect(openMcpClient).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: IDENTITY.happierSessionId,
    }));
  });
});

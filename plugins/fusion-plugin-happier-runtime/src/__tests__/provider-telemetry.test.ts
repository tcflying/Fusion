import {
  SESSION_CONNECTOR_PROVIDER_TELEMETRY_CONTRACT_VERSION,
  type SessionConnectorIdentityV1,
  type SessionConnectorProviderTelemetryV1,
  type SessionConnectorProviderTelemetryWithheldReasonV1,
  type SessionConnectorResultV1,
} from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import { buildHappierProcessEnv } from "../cli-spawn.js";
import {
  HAPPIER_LOCAL_MCP_EXTENSION_TOOLS,
  type HappierMcpClient,
  type HappierMcpToolResult,
} from "../happier-mcp-client.js";
import { HappierSessionConnector } from "../session-connector.js";
import { HappierCliError } from "../types.js";

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

const LIMITATIONS = {
  providerAvailability: "not_inferred",
  capacity: "not_reported",
  onDemandProviderRefresh: "not_attempted",
  accountIdentity: "not_reported",
  rawSnapshot: "not_reported",
} as const;

function reportedTelemetry(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    ok: true,
    kind: "fusion_provider_telemetry",
    contractVersion: 1,
    state: "reported",
    provider: "codex",
    source: "happier_persisted_in_band_provider_snapshot",
    freshness: "fresh",
    observedAt: NOW,
    expiresAt: "2026-07-21T03:01:00.000Z",
    limitations: LIMITATIONS,
    ...overrides,
  };
}

function withheldTelemetry(reason: string): Record<string, unknown> {
  return {
    ok: true,
    kind: "fusion_provider_telemetry",
    contractVersion: 1,
    state: "withheld",
    reason,
  };
}

function coreReported(): SessionConnectorResultV1<SessionConnectorProviderTelemetryV1> {
  return {
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
      limitations: LIMITATIONS,
    },
  };
}

function coreWithheld(
  reason: SessionConnectorProviderTelemetryWithheldReasonV1,
): SessionConnectorResultV1<SessionConnectorProviderTelemetryV1> {
  return {
    ok: true,
    value: {
      contractVersion: SESSION_CONNECTOR_PROVIDER_TELEMETRY_CONTRACT_VERSION,
      state: "withheld",
      identity: IDENTITY,
      reason,
    },
  };
}

function setup(options: {
  enabled?: boolean;
  tools?: readonly string[];
  toolResult?: HappierMcpToolResult;
  callToolError?: unknown;
  now?: string;
} = {}) {
  const toolResult = options.toolResult ?? {
    structuredContent: reportedTelemetry(),
  } as HappierMcpToolResult;
  const callTool = vi.fn(async () => {
    if (options.callToolError !== undefined) throw options.callToolError;
    return toolResult;
  });
  const listTools = vi.fn(async () => (options.tools ?? [
    HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.providerTelemetry,
  ]).map((name) => ({ name })));
  const client: HappierMcpClient = {
    listTools,
    callTool,
    close: vi.fn(async () => undefined),
  };
  const openMcpClient = vi.fn(async () => client);
  const connector = new HappierSessionConnector({
    settings: {
      executable: "happier",
      activeServerId: "server-1",
      enableLocalProviderTelemetry: options.enabled ?? true,
      happierSessionBindings: [{
        canonicalSessionUri: "codex://threads/codex-thread-1",
        happierSessionId: IDENTITY.happierSessionId!,
        serverProfileId: IDENTITY.serverProfileId!,
        machineId: IDENTITY.machineId!,
      }],
    },
    now: () => options.now ?? NOW,
    dependencies: { openMcpClient },
  });
  return { connector, callTool, listTools, openMcpClient };
}

describe("Happier local provider telemetry", () => {
  it("discovers and projects only the fresh persisted Codex snapshot into the Core contract", async () => {
    const { connector, callTool, listTools, openMcpClient } = setup();

    await expect(connector.getProviderTelemetry(IDENTITY)).resolves.toEqual(coreReported());
    expect(listTools).toHaveBeenCalledTimes(1);
    expect(openMcpClient).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: IDENTITY.happierSessionId,
    }));
    expect(callTool).toHaveBeenCalledWith({
      name: HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.providerTelemetry,
      arguments: { sessionId: IDENTITY.happierSessionId },
    });
  });

  it("requires the explicit local opt-in before it opens an MCP client", async () => {
    const { connector, callTool, openMcpClient } = setup({ enabled: false });

    await expect(connector.getProviderTelemetry(IDENTITY))
      .resolves.toEqual(coreWithheld("connector_telemetry_unsupported"));
    expect(openMcpClient).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("withholds when the local telemetry tool is not discovered", async () => {
    const { connector, callTool } = setup({ tools: [] });

    await expect(connector.getProviderTelemetry(IDENTITY))
      .resolves.toEqual(coreWithheld("telemetry_unavailable"));
    expect(callTool).not.toHaveBeenCalled();
  });

  it("does not report tool errors, exceptions, or extra sensitive response fields", async () => {
    const errored = setup({
      toolResult: {
        isError: true,
        structuredContent: {
          ok: false,
          errorCode: "provider_quota_exhausted",
          quotaRemaining: 7,
        },
      },
    });
    await expect(errored.connector.getProviderTelemetry(IDENTITY))
      .resolves.toEqual(coreWithheld("telemetry_unavailable"));

    const timedOut = setup({
      callToolError: new HappierCliError("timeout", "provider quota must not leak"),
    });
    await expect(timedOut.connector.getProviderTelemetry(IDENTITY))
      .resolves.toEqual(coreWithheld("telemetry_timeout"));

    const sensitive = setup({
      toolResult: {
        structuredContent: reportedTelemetry({
          accountId: "account-private",
          providerError: "quota exceeded",
          quotaRemaining: 7,
          rawSnapshot: { secret: "must-not-surface" },
        }),
      },
    });
    const result = await sensitive.connector.getProviderTelemetry(IDENTITY);
    expect(result).toEqual(coreWithheld("telemetry_contract_invalid"));
    expect(JSON.stringify(result)).not.toContain("account-private");
    expect(JSON.stringify(result)).not.toContain("must-not-surface");
  });

  it("rejects non-canonical, future, and expired snapshot times", async () => {
    const nonCanonical = setup({
      toolResult: {
        structuredContent: reportedTelemetry({ observedAt: "2026-07-21T03:00:00Z" }),
      },
    });
    await expect(nonCanonical.connector.getProviderTelemetry(IDENTITY))
      .resolves.toEqual(coreWithheld("telemetry_contract_invalid"));

    const future = setup({
      toolResult: {
        structuredContent: reportedTelemetry({
          observedAt: "2026-07-21T03:00:01.000Z",
          expiresAt: "2026-07-21T03:01:00.000Z",
        }),
      },
    });
    await expect(future.connector.getProviderTelemetry(IDENTITY))
      .resolves.toEqual(coreWithheld("telemetry_contract_invalid"));

    const expired = setup({
      toolResult: {
        structuredContent: reportedTelemetry({
          observedAt: "2026-07-21T02:58:00.000Z",
          expiresAt: "2026-07-21T02:59:00.000Z",
        }),
      },
    });
    await expect(expired.connector.getProviderTelemetry(IDENTITY))
      .resolves.toEqual(coreWithheld("telemetry_stale"));
  });

  it("maps exact upstream withheld envelopes without declaring a provider", async () => {
    const cases: readonly [
      string,
      SessionConnectorProviderTelemetryWithheldReasonV1,
    ][] = [
      ["snapshot_stale", "telemetry_stale"],
      ["snapshot_unavailable", "telemetry_unavailable"],
      ["source_unavailable", "telemetry_unavailable"],
      ["invalid_request", "telemetry_unavailable"],
      ["session_unresolved", "telemetry_unavailable"],
      ["binding_unavailable", "telemetry_unavailable"],
    ];
    for (const [upstreamReason, expectedReason] of cases) {
      const { connector } = setup({
        toolResult: { structuredContent: withheldTelemetry(upstreamReason) },
      });
      await expect(connector.getProviderTelemetry(IDENTITY))
        .resolves.toEqual(coreWithheld(expectedReason));
    }
  });

  it("rejects non-exact withheld envelopes", async () => {
    const { connector } = setup({
      toolResult: {
        structuredContent: {
          ...withheldTelemetry("snapshot_stale"),
          provider: "codex",
        },
      },
    });

    await expect(connector.getProviderTelemetry(IDENTITY))
      .resolves.toEqual(coreWithheld("telemetry_contract_invalid"));
  });

  it("withholds identities that do not match the bound Codex and Happier sessions", async () => {
    const { connector, callTool, openMcpClient } = setup();
    const wrongProvider: SessionConnectorIdentityV1 = { ...IDENTITY, providerId: "claude" };
    const wrongSession: SessionConnectorIdentityV1 = { ...IDENTITY, happierSessionId: "other-happier-session" };

    await expect(connector.getProviderTelemetry(wrongProvider)).resolves.toMatchObject({
      ok: true,
      value: {
        state: "withheld",
        reason: "telemetry_contract_invalid",
      },
    });
    await expect(connector.getProviderTelemetry(wrongSession)).resolves.toMatchObject({
      ok: true,
      value: {
        state: "withheld",
        reason: "telemetry_contract_invalid",
      },
    });
    expect(openMcpClient).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it("passes the provider telemetry opt-in only to the spawned local MCP process", () => {
    expect(buildHappierProcessEnv({ enableLocalProviderTelemetry: true }, {}))
      .toMatchObject({ HAPPIER_ENABLE_FUSION_PROVIDER_TELEMETRY_V1: "1" });
    expect(buildHappierProcessEnv({ enableLocalProviderTelemetry: false }, {
      HAPPIER_ENABLE_FUSION_PROVIDER_TELEMETRY_V1: "1",
    })).toMatchObject({ HAPPIER_ENABLE_FUSION_PROVIDER_TELEMETRY_V1: "0" });
  });
});

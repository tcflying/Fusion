import {
  buildRoomConnectorLocalMessageId,
  hashRoomValue,
  type SessionConnectorIdentityV1,
  type SessionConnectorSendRequestV1,
} from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import {
  correlateRawHappierHistoryLocalId,
  createHappierSessionConnectorWithHostWriteAuthorization,
  HappierSessionConnector,
} from "../session-connector.js";

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
  toolResults: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {},
) {
  const callTool = vi.fn(async (input: { name: string; arguments?: Record<string, unknown> }) => {
    const overridden = toolResults[input.name];
    if (overridden) return overridden;
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

function setup(options: {
  takeover?: boolean;
  hostAuthorization?: boolean;
  tools?: string[];
  toolResults?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  bindingFields?: Readonly<Record<string, unknown>>;
} = {}) {
  const client = clientWithTools(options.tools, options.toolResults);
  const openMcpClient = vi.fn(async () => client);
  const verifyHostWriteAuthorization = options.hostAuthorization
    ? vi.fn(async (request) => ({
      authorized: true as const,
      authorizationId: "host-grant-1",
      scopeFingerprint: request.scopeFingerprint,
    }))
    : undefined;
  const connectorOptions = {
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
        ...options.bindingFields,
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
  };
  const connector = verifyHostWriteAuthorization
    ? createHappierSessionConnectorWithHostWriteAuthorization(connectorOptions, verifyHostWriteAuthorization)
    : new HappierSessionConnector(connectorOptions);
  return { connector, client, openMcpClient, verifyHostWriteAuthorization };
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
    deliveryAuthorization: {
      outboxId: "outbox-1",
      senderFence: {
        leaseId: "sender-lease-1",
        roomId: "room-1",
        kind: "sender",
        resourceId: "binding-1",
        holderId: "room-worker-1",
        hostId: IDENTITY.hostId,
        expectedEpoch: 1,
      },
    },
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

  it("reads the opt-in local runtime snapshot as an accountless observation rather than provider admission proof", async () => {
    const { connector, client } = setup({
      tools: [
        "session_list",
        "session_status_get",
        "session_message_send",
        "session_wait_idle",
        "session_stop",
        "fusion_runtime_snapshot_get",
      ],
      toolResults: {
        fusion_runtime_snapshot_get: {
          structuredContent: {
            ok: true,
            kind: "fusion_local_runtime_snapshot",
            contractVersion: 1,
            snapshot: {
              id: "happier-local-snapshot-1",
              revision: 3,
              capturedAt: NOW,
              expiresAt: "2026-07-19T19:29:30.000Z",
            },
            session: { id: IDENTITY.happierSessionId },
            runtime: {
              modelState: "known",
              providerId: "codex",
              currentModelId: "gpt-5.5",
              modelObservedAt: NOW,
              modelReason: null,
            },
            limitations: {
              providerAccount: "not_reported",
              providerQuota: "not_reported",
              latency: "not_reported",
              context: "not_reported",
              tools: "not_reported",
              quality: "not_reported",
            },
            provenance: {
              source: "happier_local_acp_metadata",
              transport: "local_mcp_stdio",
              sourceContractVersion: 1,
            },
          },
        },
      },
    });

    await expect(connector.getRuntimeSnapshot(IDENTITY)).resolves.toEqual({
      ok: true,
      value: {
        contractVersion: 1,
        source: "connector_local_extension",
        identity: IDENTITY,
        snapshotId: "happier-local-snapshot-1",
        revision: 3,
        capturedAt: NOW,
        expiresAt: "2026-07-19T19:29:30.000Z",
        providerId: "codex",
        modelId: "gpt-5.5",
        modelObservedAt: NOW,
        accountId: null,
        coverage: {
          providerModel: "observed",
          providerAccount: "not_reported",
          providerQuota: "not_reported",
          latency: "not_reported",
          context: "not_reported",
          tools: "not_reported",
          quality: "not_reported",
        },
      },
    });
    expect(client.callTool).toHaveBeenCalledWith({
      name: "fusion_runtime_snapshot_get",
      arguments: { sessionId: IDENTITY.happierSessionId },
    });
  });

  it("keeps the local runtime snapshot withheld when the extension is unavailable", async () => {
    const { connector, client } = setup();

    await expect(connector.getRuntimeSnapshot(IDENTITY)).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unavailable",
        retryable: false,
        safeDetails: {
          bridge: "local_happier_mcp_extension",
          state: "happier_local_runtime_snapshot_extension_required",
        },
      },
    });
    expect(client.callTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "fusion_runtime_snapshot_get" }));
  });

  it("sends and waits only after host/runtime write authorization while interrupt remains unavailable", async () => {
    const { connector, client, openMcpClient, verifyHostWriteAuthorization } = setup({ takeover: true, hostAuthorization: true });
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
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "unavailable", retryable: false },
    });

    expect(openMcpClient).toHaveBeenCalledWith(expect.objectContaining({ sessionId: IDENTITY.happierSessionId }));
    expect(verifyHostWriteAuthorization).toHaveBeenCalledWith(expect.objectContaining({
      operation: "send",
      canonicalSessionUri: URI,
      happierSessionId: IDENTITY.happierSessionId,
      contentHash: request.contentHash,
    }));
    expect(client.callTool).toHaveBeenCalledWith({
      name: "session_message_send",
      arguments: {
          sessionId: IDENTITY.happierSessionId,
          message: request.content,
          localId: request.localMessageId,
          wait: false,
        timeoutSeconds: 300,
      },
    });
    expect(client.callTool).toHaveBeenCalledWith({
      name: "session_wait_idle",
      arguments: { sessionId: IDENTITY.happierSessionId, timeoutSeconds: 300 },
    });
    expect(client.callTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "session_stop" }));
  });

  it("rejects a write decision replayed across immutable Happier bindings", async () => {
    const secondIdentity: SessionConnectorIdentityV1 = {
      connectorId: "happier",
      providerId: "codex",
      nativeSessionId: "codex-thread-2",
      happierSessionId: "happier-session-2",
      serverProfileId: "server-2",
      machineId: "machine-2",
      hostId: "fusion-host-2",
    };
    const secondUri = "codex://threads/codex-thread-2";
    let firstDecision: Readonly<{
      authorized: true;
      authorizationId: string;
      scopeFingerprint: string;
    }> | undefined;
    const replayedVerifier = vi.fn(async (request: { readonly scopeFingerprint: string }) => {
      if (!firstDecision) {
        firstDecision = Object.freeze({
          authorized: true as const,
          authorizationId: "host-grant-1",
          scopeFingerprint: request.scopeFingerprint,
        });
      }
      return firstDecision;
    });
    const firstClient = clientWithTools();
    const secondClient = clientWithTools();
    const firstOpenMcpClient = vi.fn(async () => firstClient);
    const secondOpenMcpClient = vi.fn(async () => secondClient);
    const firstConnector = createHappierSessionConnectorWithHostWriteAuthorization({
      settings: {
        executable: "happier",
        activeServerId: IDENTITY.serverProfileId!,
        webappUrl: "https://app.happier.dev",
        happierSessionBindings: [{
          canonicalSessionUri: URI,
          happierSessionId: IDENTITY.happierSessionId!,
          serverProfileId: IDENTITY.serverProfileId!,
          machineId: IDENTITY.machineId!,
        }],
      },
      now: () => NOW,
      dependencies: {
        openMcpClient: firstOpenMcpClient,
        probeRuntime: vi.fn(),
      },
    }, replayedVerifier);
    const secondConnector = createHappierSessionConnectorWithHostWriteAuthorization({
      settings: {
        executable: "happier",
        activeServerId: secondIdentity.serverProfileId!,
        webappUrl: "https://app.happier.dev",
        happierSessionBindings: [{
          canonicalSessionUri: secondUri,
          happierSessionId: secondIdentity.happierSessionId!,
          serverProfileId: secondIdentity.serverProfileId!,
          machineId: secondIdentity.machineId!,
        }],
      },
      now: () => NOW,
      dependencies: {
        openMcpClient: secondOpenMcpClient,
        probeRuntime: vi.fn(),
      },
    }, replayedVerifier);
    const firstRequest = sendRequest();
    const secondRequest: SessionConnectorSendRequestV1 = {
      ...firstRequest,
      bindingId: "binding-2",
      identity: secondIdentity,
      logicalMessageId: "room-message-2",
      idempotencyKey: "dispatch-2",
      localMessageId: buildRoomConnectorLocalMessageId({
        logicalMessageId: "room-message-2",
        bindingId: "binding-2",
        idempotencyKey: "dispatch-2",
        payloadHash: firstRequest.contentHash,
      }),
      deliveryAuthorization: {
        outboxId: "outbox-2",
        senderFence: {
          leaseId: "sender-lease-2",
          roomId: "room-2",
          kind: "sender",
          resourceId: "binding-2",
          holderId: "room-worker-2",
          hostId: secondIdentity.hostId,
          expectedEpoch: 2,
        },
      },
    };

    await expect(firstConnector.send(firstRequest)).resolves.toMatchObject({ ok: true });
    await expect(secondConnector.send(secondRequest)).resolves.toMatchObject({
      ok: false,
      error: { code: "unavailable", retryable: false },
    });

    expect(replayedVerifier).toHaveBeenCalledTimes(2);
    expect(secondOpenMcpClient).not.toHaveBeenCalled();
    expect(secondClient.callTool).not.toHaveBeenCalled();
  });

  it("does not accept a forged connector dependency as host write authority", async () => {
    const client = clientWithTools();
    const openMcpClient = vi.fn(async () => client);
    const forgedVerifier = vi.fn(async () => ({
      authorized: true as const,
      authorizationId: "forged-host-grant",
    }));
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
          takeoverConfirmedAt: NOW,
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
        verifyHostWriteAuthorization: forgedVerifier,
      } as never,
    });

    await expect(connector.getCapabilities(IDENTITY)).resolves.toMatchObject({
      capabilities: {
        send: { state: "unavailable", reasonCode: "operation_unavailable" },
        interrupt: { state: "unavailable", reasonCode: "operation_unavailable" },
      },
    });
    openMcpClient.mockClear();
    client.callTool.mockClear();

    await expect(connector.send(sendRequest())).resolves.toMatchObject({
      ok: false,
      error: { code: "unavailable", retryable: false },
    });
    await expect(connector.interrupt({
      contractVersion: 1,
      identity: IDENTITY,
      idempotencyKey: "forged-stop-1",
      reason: "forged stop",
    })).resolves.toMatchObject({
      ok: false,
      error: { code: "unavailable", retryable: false },
    });
    expect(forgedVerifier).not.toHaveBeenCalled();
    expect(openMcpClient).not.toHaveBeenCalled();
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("does not confirm a send when official MCP creates an approval request instead of sending", async () => {
    const { connector, client } = setup({
      takeover: true,
      hostAuthorization: true,
      toolResults: {
        session_message_send: {
          content: [{
            type: "text",
            text: JSON.stringify({
              kind: "approval_request_created",
              artifactId: "approval-artifact-1",
            }),
          }],
          isError: false,
        },
      },
    });

    await expect(connector.send(sendRequest())).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unavailable",
        retryable: false,
        safeDetails: { actionState: "approval_request_created" },
      },
    });
    expect(client.callTool).not.toHaveBeenCalledWith(expect.objectContaining({
      name: "session_wait_idle",
    }));
  });

  it("does not confirm a send when a conflicting official MCP content envelope requires approval", async () => {
    const { connector, client } = setup({
      takeover: true,
      hostAuthorization: true,
      toolResults: {
        session_message_send: {
          structuredContent: { sessionId: IDENTITY.happierSessionId, ok: true },
          content: [{
            type: "text",
            text: JSON.stringify({
              kind: "approval_request_created",
              artifactId: "approval-conflict-send-1",
            }),
          }],
        },
      },
    });

    await expect(connector.send(sendRequest())).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unavailable",
        retryable: false,
        safeDetails: { actionState: "approval_request_created" },
      },
    });
    expect(client.callTool).not.toHaveBeenCalledWith(expect.objectContaining({
      name: "session_wait_idle",
    }));
  });

  it("preserves the primary official MCP action error when a secondary content envelope disagrees", async () => {
    const { connector, client } = setup({
      takeover: true,
      hostAuthorization: true,
      toolResults: {
        session_message_send: {
          isError: true,
          structuredContent: { errorCode: "not_authenticated" },
          content: [{
            type: "text",
            text: JSON.stringify({ ok: false, code: "timeout" }),
          }],
        },
      },
    });

    await expect(connector.send(sendRequest())).resolves.toMatchObject({
      ok: false,
      error: {
        code: "authentication_required",
        retryable: false,
      },
    });
  });

  it("preserves the primary official MCP error when a secondary envelope reports approval creation", async () => {
    const { connector } = setup({
      takeover: true,
      hostAuthorization: true,
      toolResults: {
        session_message_send: {
          isError: true,
          structuredContent: { errorCode: "not_authenticated" },
          content: [{
            type: "text",
            text: JSON.stringify({
              kind: "approval_request_created",
              artifactId: "approval-secondary-error-1",
            }),
          }],
        },
      },
    });

    await expect(connector.send(sendRequest())).resolves.toMatchObject({
      ok: false,
      error: {
        code: "authentication_required",
        retryable: false,
      },
    });
  });

  it("does not confirm a send when a deeply wrapped official MCP action requires approval", async () => {
    const { connector, client } = setup({
      takeover: true,
      hostAuthorization: true,
      toolResults: {
        session_message_send: {
          structuredContent: {
            ok: true,
            result: {
              ok: true,
              result: {
                ok: true,
                result: {
                  kind: "approval_request_created",
                  artifactId: "approval-deep-send-1",
                },
              },
            },
          },
        },
      },
    });

    await expect(connector.send(sendRequest())).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unavailable",
        retryable: false,
        safeDetails: { actionState: "approval_request_created" },
      },
    });
    expect(client.callTool.mock.calls.some(([call]) => call.name === "session_message_send")).toBe(true);
    expect(client.callTool).not.toHaveBeenCalledWith(expect.objectContaining({
      name: "session_wait_idle",
    }));
  });

  it("does not allow one localId to overwrite a different immutable content hash", async () => {
    const { connector, client } = setup({ hostAuthorization: true });
    const request = sendRequest();
    const changedContent = "A different body must not reuse this local id";

    await expect(connector.send(request)).resolves.toMatchObject({ ok: true });
    await expect(connector.send({
      ...request,
      content: changedContent,
      contentHash: hashRoomValue(changedContent),
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "conflict",
        safeDetails: { bindingState: "happier_local_id_content_hash_conflict" },
      },
    });
    expect(client.callTool.mock.calls.filter(([call]) => call.name === "session_message_send")).toHaveLength(1);
  });

  it("never sends session_stop even if a direct result would require approval", async () => {
    const { connector, client } = setup({
      takeover: true,
      hostAuthorization: true,
      toolResults: {
        session_stop: {
          content: [{
            type: "text",
            text: JSON.stringify({
              kind: "approval_request_created",
              artifactId: "approval-artifact-2",
            }),
          }],
          isError: false,
        },
      },
    });

    await expect(connector.interrupt({
      contractVersion: 1,
      identity: IDENTITY,
      idempotencyKey: "stop-approval-1",
      reason: "operator requested stop",
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unavailable",
        retryable: false,
        safeDetails: { localExtensionState: "local_extension_unattested" },
      },
    });
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("never sends session_stop even if a conflicting result would require approval", async () => {
    const { connector, client } = setup({
      takeover: true,
      hostAuthorization: true,
      toolResults: {
        session_stop: {
          structuredContent: { sessionId: IDENTITY.happierSessionId, ok: true },
          content: [{
            type: "text",
            text: JSON.stringify({
              kind: "approval_request_created",
              artifactId: "approval-conflict-stop-1",
            }),
          }],
        },
      },
    });

    await expect(connector.interrupt({
      contractVersion: 1,
      identity: IDENTITY,
      idempotencyKey: "stop-approval-conflict-1",
      reason: "operator requested stop",
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unavailable",
        retryable: false,
        safeDetails: { localExtensionState: "local_extension_unattested" },
      },
    });
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("never sends session_stop even if a deeply wrapped result would require approval", async () => {
    const { connector, client } = setup({
      takeover: true,
      hostAuthorization: true,
      toolResults: {
        session_stop: {
          structuredContent: {
            ok: true,
            result: {
              ok: true,
              result: {
                ok: true,
                result: {
                  kind: "approval_request_created",
                  artifactId: "approval-deep-stop-1",
                },
              },
            },
          },
        },
      },
    });

    await expect(connector.interrupt({
      contractVersion: 1,
      identity: IDENTITY,
      idempotencyKey: "stop-approval-deep-1",
      reason: "operator requested stop",
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unavailable",
        retryable: false,
        safeDetails: { localExtensionState: "local_extension_unattested" },
      },
    });
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("fails closed before a write when a settings-controlled takeover timestamp is forged", async () => {
    const { connector, client } = setup({ takeover: true });

    await expect(connector.send(sendRequest())).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unavailable",
        safeDetails: { bindingState: "happier_host_write_authorization_required" },
      },
    });
    expect(client.listTools).not.toHaveBeenCalled();
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("fails closed when bypassed settings add a secret-bearing field to a binding", async () => {
    const { connector, client } = setup({
      takeover: true,
      bindingFields: { token: "must-not-be-accepted" },
    });

    await expect(connector.getStatus(IDENTITY)).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unavailable",
        safeDetails: { bindingState: "happier_session_binding_required" },
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

  it("reads cursor-complete local reconciliation history and preserves the exact Happier localId as the recovery key", async () => {
    const request = sendRequest();
    const { connector, client } = setup({
      tools: [
        "session_list",
        "session_status_get",
        "session_message_send",
        "session_wait_idle",
        "session_stop",
        "fusion_reconciliation_history_get",
      ],
      toolResults: {
        fusion_reconciliation_history_get: {
          structuredContent: {
            ok: true,
            kind: "fusion_reconciliation_history",
            contractVersion: 1,
            session: { id: IDENTITY.happierSessionId },
            page: {
              afterCursor: null,
              completeThroughCursor: "7",
              nextCursor: null,
              truncated: false,
            },
            items: [{
              nativeMessageId: "native-message-7",
              localMessageId: request.localMessageId,
              content: request.content,
              occurredAtMs: Date.parse(NOW),
              cursor: "7",
            }],
            provenance: {
              source: "happier_local_encrypted_transcript",
              transport: "local_mcp_stdio",
              sourceContractVersion: 1,
            },
          },
        },
      },
    });

    await expect(connector.readHistory({
      contractVersion: 1,
      identity: IDENTITY,
      afterCursor: null,
      limit: 1,
    })).resolves.toEqual({
      ok: true,
      value: {
        items: [{
          nativeMessageId: "native-message-7",
          logicalMessageId: request.localMessageId,
          role: "user",
          contentHash: request.contentHash,
          occurredAt: NOW,
          cursor: "7",
        }],
        // FNXC:HappierReconciliationHistoryCursor 2026-07-20-12:02: exhausted native pages still advance durable ingestion.
        nextCursor: "7",
        completeThroughCursor: "7",
        truncated: false,
      },
    });
    await expect(connector.getCapabilities(IDENTITY)).resolves.toMatchObject({
      capabilities: {
        history: { state: "verified", reasonCode: null },
      },
    });
    expect(client.callTool).toHaveBeenCalledWith({
      name: "fusion_reconciliation_history_get",
      arguments: { sessionId: IDENTITY.happierSessionId, afterCursor: null, limit: 1 },
    });
  });

  it("withholds reconciliation history when the extension violates its durable cursor contract", async () => {
    const { connector } = setup({
      tools: [
        "session_list",
        "session_status_get",
        "session_message_send",
        "session_wait_idle",
        "session_stop",
        "fusion_reconciliation_history_get",
      ],
      toolResults: {
        fusion_reconciliation_history_get: {
          structuredContent: {
            ok: true,
            kind: "fusion_reconciliation_history",
            contractVersion: 1,
            session: { id: IDENTITY.happierSessionId },
            page: {
              afterCursor: null,
              completeThroughCursor: "7",
              nextCursor: null,
              truncated: true,
            },
            items: [],
            provenance: {
              source: "happier_local_encrypted_transcript",
              transport: "local_mcp_stdio",
              sourceContractVersion: 1,
            },
          },
        },
      },
    });

    await expect(connector.readHistory({
      contractVersion: 1,
      identity: IDENTITY,
      afterCursor: null,
      limit: 1,
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unverified",
        retryable: false,
        safeDetails: { reason: "invalid_reconciliation_history" },
      },
    });
  });

  it("keeps reconciliation history withheld without the explicit local extension and leaves event subscription unavailable", async () => {
    const { connector } = setup();

    await expect(connector.readHistory({
      contractVersion: 1,
      identity: IDENTITY,
      afterCursor: null,
      limit: 1,
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: "unavailable",
        safeDetails: { state: "happier_local_reconciliation_history_extension_required" },
      },
    });
    await expect(connector.subscribeEvents(IDENTITY)).resolves.toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  });

  it("correlates raw Happier history only by localId plus an immutable content hash", () => {
    const request = sendRequest();

    expect(correlateRawHappierHistoryLocalId({
      format: "raw",
      messages: [{
        id: "native-message-1",
        localId: request.localMessageId,
        createdAt: 1,
        role: "user",
        raw: { content: { type: "text", text: request.content } },
      }],
    }, {
      localMessageId: request.localMessageId,
      contentHash: request.contentHash,
    })).toEqual({
      outcome: "matched",
      nativeMessageId: "native-message-1",
    });

    expect(correlateRawHappierHistoryLocalId({
      format: "raw",
      messages: [{
        id: "native-message-1",
        localId: request.localMessageId,
        createdAt: 2,
        role: "user",
        raw: { content: { type: "text", text: "different body" } },
      }],
    }, {
      localMessageId: request.localMessageId,
      contentHash: request.contentHash,
    })).toEqual({
      outcome: "uncertain",
      reason: "content_hash_mismatch",
    });

    expect(correlateRawHappierHistoryLocalId({
      format: "raw",
      messages: [{
        id: "native-message-1",
        localId: "another-local-id",
        createdAt: 3,
        role: "user",
        raw: { content: { type: "text", text: request.content } },
      }],
    }, {
      localMessageId: request.localMessageId,
      contentHash: request.contentHash,
    })).toEqual({
      outcome: "uncertain",
      reason: "local_id_not_found",
    });
  });
});

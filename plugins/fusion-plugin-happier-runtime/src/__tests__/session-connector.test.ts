import {
  buildRoomConnectorLocalMessageId,
  hashRoomValue,
  type SessionConnectorIdentityV1,
  type SessionConnectorSendRequestV1,
} from "@fusion/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deliveryFences = vi.hoisted(() => {
  const persistentStores = new Map<string, ReturnType<typeof createStore>>();
  function createStore() {
    const records = new Map<string, Record<string, unknown>>();
    const keyFor = (input: Record<string, unknown>) => JSON.stringify({
      canonicalSessionUri: input.canonicalSessionUri,
      providerId: input.providerId,
      nativeSessionId: input.nativeSessionId,
      happierSessionId: input.happierSessionId,
      serverProfileId: input.serverProfileId,
      machineId: input.machineId,
      localMessageId: input.localMessageId,
    });
    return {
      reserve: async (input: Record<string, unknown>) => {
        const key = keyFor(input);
        const existing = records.get(key);
        if (existing) {
          return existing.contentHash === input.contentHash
            ? { state: existing.state, record: existing }
            : { state: "conflict", record: existing };
        }
        const record = {
          contractVersion: 1,
          keyHash: "a".repeat(64),
          state: "pending",
          ...input,
          receipt: null,
          createdAt: NOW,
          updatedAt: NOW,
        };
        records.set(key, record);
        return { state: "created", record };
      },
      confirm: async (input: Record<string, unknown>, receipt: Record<string, unknown>) => {
        const key = keyFor(input);
        const prior = records.get(key);
        const record = { ...prior, state: "confirmed", receipt, updatedAt: NOW };
        records.set(key, record);
        return { state: "confirmed", record };
      },
    };
  }
  return {
    clear: () => persistentStores.clear(),
    create: (options?: { directory?: string }) => {
      if (!options?.directory) return createStore();
      const existing = persistentStores.get(options.directory);
      if (existing) return existing;
      const created = createStore();
      persistentStores.set(options.directory, created);
      return created;
    },
  };
});

const approvalStates = vi.hoisted(() => {
  const stores = new Map<string, Map<string, Record<string, unknown>>>();
  const keyFor = (input: Record<string, unknown>) => JSON.stringify({
    operation: input.operation,
    identity: input.identity,
    bindingId: input.bindingId,
    logicalMessageId: input.logicalMessageId,
    localMessageId: input.localMessageId,
    idempotencyKey: input.idempotencyKey,
    contentHash: input.contentHash,
  });
  return {
    clear: () => stores.clear(),
    create: (options?: { directory?: string }) => {
      const directory = options?.directory ?? Symbol("ephemeral").toString();
      let records = stores.get(directory);
      if (!records) {
        records = new Map();
        stores.set(directory, records);
      }
      return {
        recordWaiting: async (input: Record<string, unknown>) => {
          const key = keyFor(input);
          const existing = records.get(key);
          if (existing) return existing;
          const record = {
            contractVersion: 1,
            keyHash: "b".repeat(64),
            state: "waiting_approval",
            ...input,
            receipt: null,
            createdAt: NOW,
            updatedAt: NOW,
          };
          records.set(key, record);
          return record;
        },
        find: async (input: Record<string, unknown>) => records.get(keyFor(input)) ?? null,
        read: async (input: Record<string, unknown>) => records.get(keyFor(input)) ?? null,
        markReconciled: async (input: Record<string, unknown>, receipt: Record<string, unknown>) => {
          const key = keyFor(input);
          const existing = records.get(key);
          if (!existing) throw new Error("approval state missing");
          const record = {
            ...existing,
            state: "reconciled",
            receipt,
            updatedAt: NOW,
          };
          records.set(key, record);
          return record;
        },
      };
    },
  };
});

vi.mock("../delivery-fence-store.js", () => ({
  createHappierDeliveryFenceStore: deliveryFences.create,
}));

vi.mock("../cli-attestation.js", () => ({
  verifyHappierCliAttestation: vi.fn(async () => ({
    ok: true,
    trustLevel: "local_custom_pinned_source_build",
    sourceRoot: "G:\\codex-project\\happier",
    entrypointPath: "G:\\codex-project\\happier\\apps\\cli\\package-dist\\index.mjs",
    cliVersion: "0.2.10",
    sourceCommit: "6e059c41d865343c1efc9c98676e5af3882d85ff",
    entrypointSha256: "sha256:8ad722284c12ca87c946f3a94b66b14f5640bf768e719c8791b1cb0234312786",
    verifiedAt: "2026-07-27T04:40:00.000Z",
    evidence: {
      version: "cli_--version",
      package: "package_json",
      source: "git_head",
      artifact: "sha256_file_bytes",
    },
  })),
}));

import {
  correlateRawHappierHistoryLocalId,
  createHappierSessionConnectorWithHostWriteAuthorization,
  HappierSessionConnector,
} from "../session-connector.js";
import type { HappierCliAttestation } from "../cli-attestation.js";

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
const PROBE_ATTESTATION: HappierCliAttestation = {
  ok: true,
  trustLevel: "local_custom_pinned_source_build",
  sourceRoot: "G:\\codex-project\\happier",
  entrypointPath: "G:\\codex-project\\happier\\apps\\cli\\package-dist\\index.mjs",
  cliVersion: "0.2.10",
  sourceCommit: "6e059c41d865343c1efc9c98676e5af3882d85ff",
  entrypointSha256: "sha256:8ad722284c12ca87c946f3a94b66b14f5640bf768e719c8791b1cb0234312786",
  verifiedAt: NOW,
  evidence: {
    version: "cli_--version",
    package: "package_json",
    source: "git_head",
    artifact: "sha256_file_bytes",
  },
};

function clientWithTools(
  tools = ["session_list", "session_status_get", "session_message_send", "session_wait_idle", "session_history_get", "session_stop"],
  toolResults: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {},
) {
  let lastSend: Readonly<{ sessionId: string; localId: string; message: string }> | null = null;
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
      case "session_message_send": {
        lastSend = {
          sessionId: String(input.arguments?.sessionId),
          localId: String(input.arguments?.localId),
          message: String(input.arguments?.message),
        };
        return {
          structuredContent: {
            sessionId: lastSend.sessionId,
            localId: lastSend.localId,
            waited: false,
          },
        };
      }
      case "session_wait_idle":
        return {
          structuredContent: {
            sessionId: IDENTITY.happierSessionId,
            idle: true,
            observedAt: Date.parse(NOW),
          },
        };
      case "session_history_get":
        return {
          structuredContent: {
            sessionId: IDENTITY.happierSessionId,
            format: "raw",
            messages: lastSend
              ? [{
                  id: "native-message-1",
                  localId: lastSend.localId,
                  createdAt: Date.parse(NOW),
                  role: "user",
                  raw: { content: { type: "text", text: lastSend.message } },
                }]
              : [],
          },
        };
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
  deliveryFenceDirectory?: string;
  approvalStateDirectory?: string;
  attestCli?: () => Promise<HappierCliAttestation>;
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
      ...(options.deliveryFenceDirectory ? { deliveryFenceDirectory: options.deliveryFenceDirectory } : {}),
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
    ...(options.approvalStateDirectory
      ? { approvalStateDirectory: options.approvalStateDirectory }
      : {}),
    dependencies: {
      openMcpClient,
      createApprovalStateStore: approvalStates.create as never,
      ...(options.attestCli ? { attestCli: options.attestCli } : {}),
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
        modelId: null,
        modelState: "not_reported" as const,
        attestation: PROBE_ATTESTATION,
        details: [],
      })),
    },
  };
  const connector = verifyHostWriteAuthorization
    ? createHappierSessionConnectorWithHostWriteAuthorization(connectorOptions, verifyHostWriteAuthorization)
    : new HappierSessionConnector(connectorOptions);
  return { connector, client, openMcpClient, verifyHostWriteAuthorization };
}

beforeEach(() => {
  deliveryFences.clear();
  approvalStates.clear();
});

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
  it("rejects an inverted MCP wait hierarchy before any connector send can start", () => {
    expect(() => new HappierSessionConnector({
      settings: {
        executable: "happier",
        waitTimeoutMs: 304_999,
        waitTimeoutGraceMs: 5_000,
      },
      sendTimeoutSeconds: 300,
    })).toThrow("Happier wait timeout hierarchy is invalid");
  });

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

  it("sends and waits only after host/runtime write authorization", async () => {
    const { connector, client, openMcpClient, verifyHostWriteAuthorization } = setup({ takeover: true, hostAuthorization: true });
    const request = sendRequest();

    await expect(connector.send(request)).resolves.toMatchObject({
      ok: true,
      value: {
        outcome: "confirmed",
        connectorAcknowledgementId: expect.stringMatching(/^happier-receipt:/u),
        nativeMessageId: "native-message-1",
        acceptedAt: NOW,
      },
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
    expect(client.callTool).toHaveBeenCalledWith({
      name: "session_history_get",
      arguments: {
        sessionId: IDENTITY.happierSessionId,
        limit: 1000,
        format: "raw",
        includeMeta: false,
        includeStructuredPayload: false,
      },
    });
  });

  it("fails closed before transport when CLI attestation drifts", async () => {
    const { connector, client, openMcpClient } = setup({
      hostAuthorization: true,
      attestCli: async () => ({ ok: false, reasonCode: "cli_artifact_hash_mismatch" }),
    });

    await expect(connector.send(sendRequest())).resolves.toMatchObject({
      ok: false,
      error: {
        code: "degraded",
        retryable: false,
        safeDetails: {
          category: "cli_attestation",
          reasonCode: "cli_artifact_hash_mismatch",
        },
      },
    });
    expect(openMcpClient).not.toHaveBeenCalled();
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it("never confirms or waits when the send receipt localId is for another message", async () => {
    const { connector, client } = setup({
      hostAuthorization: true,
      toolResults: {
        session_message_send: {
          structuredContent: {
            sessionId: IDENTITY.happierSessionId,
            localId: "different-local-id",
            waited: false,
          },
        },
      },
    });

    await expect(connector.send(sendRequest())).resolves.toEqual({
      ok: false,
      error: {
        code: "delivery_uncertain",
        message: "Happier send evidence could not be bound to the exact Session and localId",
        retryable: false,
        safeDetails: {
          state: "happier_receipt_reconciliation_required",
          reason: "send_local_id_mismatch",
        },
      },
    });
    expect(client.callTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "session_wait_idle" }));
    expect(client.callTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "session_history_get" }));
  });

  it("never confirms a send when wait does not prove exact-session idle with a valid observation", async () => {
    const { connector, client } = setup({
      hostAuthorization: true,
      toolResults: {
        session_wait_idle: {
          structuredContent: {
            sessionId: IDENTITY.happierSessionId,
            idle: false,
            observedAt: Date.parse(NOW),
          },
        },
      },
    });

    await expect(connector.send(sendRequest())).resolves.toMatchObject({
      ok: false,
      error: {
        code: "delivery_uncertain",
        retryable: false,
        safeDetails: {
          state: "happier_receipt_reconciliation_required",
          reason: "wait_not_idle",
        },
      },
    });
    expect(client.callTool).not.toHaveBeenCalledWith(expect.objectContaining({ name: "session_history_get" }));
  });

  it("completes interrupt only after the official remote stop proves the exact session stopped", async () => {
    const { connector, client, verifyHostWriteAuthorization } = setup({
      hostAuthorization: true,
      toolResults: {
        session_stop: {
          structuredContent: {
            sessionId: IDENTITY.happierSessionId,
            stopped: true,
          },
        },
      },
    });

    await expect(connector.interrupt({
      contractVersion: 1,
      identity: IDENTITY,
      idempotencyKey: "stop-1",
      reason: "operator requested stop",
    })).resolves.toMatchObject({
      ok: true,
      value: {
        state: "completed",
        connectorAcknowledgementId: expect.stringMatching(/^happier-stop:/u),
      },
    });
    expect(verifyHostWriteAuthorization).toHaveBeenCalledWith(expect.objectContaining({
      operation: "interrupt",
      canonicalSessionUri: URI,
      happierSessionId: IDENTITY.happierSessionId,
      bindingId: null,
      deliveryAuthorization: null,
      idempotencyKey: "stop-1",
      reason: "operator requested stop",
    }));
    expect(client.callTool).toHaveBeenCalledWith({
      name: "session_stop",
      arguments: { sessionId: IDENTITY.happierSessionId },
    });
  });

  it("fails closed when the official remote stop cannot confirm stopped true", async () => {
    const { connector } = setup({
      hostAuthorization: true,
      toolResults: {
        session_stop: {
          structuredContent: {
            sessionId: IDENTITY.happierSessionId,
            stopped: false,
          },
        },
      },
    });

    await expect(connector.interrupt({
      contractVersion: 1,
      identity: IDENTITY,
      idempotencyKey: "stop-unconfirmed-1",
      reason: "operator requested stop",
    })).resolves.toEqual({
      ok: false,
      error: {
        code: "delivery_uncertain",
        message: "Happier did not confirm that the exact remote session stopped",
        retryable: true,
        safeDetails: {
          state: "happier_stop_unconfirmed",
        },
      },
    });
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
        safeDetails: {
          bridge: "official_mcp_stdio",
          actionState: "approval_request_created",
          artifactId: "approval-artifact-1",
          operation: "session_message_send",
          happierSessionId: IDENTITY.happierSessionId,
          runtimeState: "waitingOnInput",
          reconciliationRequired: true,
        },
      },
    });
    expect(client.callTool).not.toHaveBeenCalledWith(expect.objectContaining({
      name: "session_wait_idle",
    }));
  });

  it("restores a pending approval and confirms it only through explicit reconciliation", async () => {
    const request = sendRequest();
    const deliveryFenceDirectory = "G:\\fusion-test\\approval-restart-fence";
    const approvalStateDirectory = "G:\\fusion-test\\approval-restart-state";
    const first = setup({
      takeover: true,
      hostAuthorization: true,
      deliveryFenceDirectory,
      approvalStateDirectory,
      toolResults: {
        session_message_send: {
          structuredContent: {
            kind: "approval_request_created",
            artifactId: "approval-restart-send-1",
          },
        },
      },
    });

    await expect(first.connector.send(request)).resolves.toMatchObject({
      ok: false,
      error: {
        safeDetails: {
          actionState: "approval_request_created",
          artifactId: "approval-restart-send-1",
          operation: "session_message_send",
          approvalStateRef: "b".repeat(64),
        },
      },
    });

    const restarted = setup({
      takeover: true,
      hostAuthorization: true,
      deliveryFenceDirectory,
      approvalStateDirectory,
      toolResults: {
        session_history_get: {
          structuredContent: {
            sessionId: IDENTITY.happierSessionId,
            format: "raw",
            messages: [{
              id: "native-approved-message-1",
              localId: request.localMessageId,
              createdAt: Date.parse(NOW),
              role: "user",
              raw: { content: { type: "text", text: request.content } },
            }],
          },
        },
      },
    });

    await expect(restarted.connector.send(request)).resolves.toMatchObject({
      ok: false,
      error: {
        safeDetails: {
          actionState: "approval_request_created",
          artifactId: "approval-restart-send-1",
        },
      },
    });
    expect(restarted.client.callTool).not.toHaveBeenCalled();

    await expect(restarted.connector.reconcileApproval({
      contractVersion: 1,
      artifactId: "approval-restart-send-1",
      request,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        outcome: "confirmed",
        nativeMessageId: "native-approved-message-1",
      },
    });
    expect(restarted.client.callTool).toHaveBeenCalledWith({
      name: "session_history_get",
      arguments: expect.objectContaining({ sessionId: IDENTITY.happierSessionId }),
    });
    expect(restarted.client.callTool).not.toHaveBeenCalledWith(expect.objectContaining({
      name: "session_message_send",
    }));
    expect(restarted.client.callTool).not.toHaveBeenCalledWith(expect.objectContaining({
      name: "session_wait_idle",
    }));

    const twiceRestarted = setup({
      takeover: true,
      hostAuthorization: true,
      deliveryFenceDirectory,
      approvalStateDirectory,
    });
    await expect(twiceRestarted.connector.reconcileApproval({
      contractVersion: 1,
      artifactId: "approval-restart-send-1",
      request,
    })).resolves.toMatchObject({
      ok: true,
      value: {
        outcome: "confirmed",
        nativeMessageId: "native-approved-message-1",
      },
    });
    expect(twiceRestarted.client.callTool).not.toHaveBeenCalled();
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

  it("never resends an unresolved localId after a connector restart", async () => {
    const deliveryFenceDirectory = "G:\\fusion-test\\happier-restart-fence";
    const first = setup({
      hostAuthorization: true,
      deliveryFenceDirectory,
      toolResults: {
        session_wait_idle: {
          structuredContent: {
            sessionId: IDENTITY.happierSessionId,
            idle: false,
            observedAt: Date.parse(NOW),
          },
        },
      },
    });
    const request = sendRequest();

    await expect(first.connector.send(request)).resolves.toMatchObject({
      ok: false,
      error: {
        code: "delivery_uncertain",
        safeDetails: { reason: "wait_not_idle" },
      },
    });
    expect(first.client.callTool.mock.calls.filter(([call]) =>
      call.name === "session_message_send")).toHaveLength(1);

    const restarted = setup({ hostAuthorization: true, deliveryFenceDirectory });
    await expect(restarted.connector.send(request)).resolves.toMatchObject({
      ok: false,
      error: {
        code: "delivery_uncertain",
        safeDetails: { reason: "local_id_not_found" },
      },
    });
    expect(restarted.client.callTool).toHaveBeenCalledWith({
      name: "session_history_get",
      arguments: expect.objectContaining({ sessionId: IDENTITY.happierSessionId }),
    });
    expect(restarted.client.callTool.mock.calls.some(([call]) =>
      call.name === "session_message_send")).toBe(false);
    expect(restarted.client.callTool.mock.calls.some(([call]) =>
      call.name === "session_wait_idle")).toBe(false);
  });

  it("never completes session_stop when the direct result requires approval", async () => {
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
        safeDetails: {
          actionState: "approval_request_created",
          artifactId: "approval-artifact-2",
          operation: "session_stop",
          happierSessionId: IDENTITY.happierSessionId,
        },
      },
    });
    expect(client.callTool).toHaveBeenCalledWith({
      name: "session_stop",
      arguments: { sessionId: IDENTITY.happierSessionId },
    });
  });

  it("never completes session_stop when a conflicting result requires approval", async () => {
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
        safeDetails: {
          actionState: "approval_request_created",
          artifactId: "approval-conflict-stop-1",
          operation: "session_stop",
          happierSessionId: IDENTITY.happierSessionId,
        },
      },
    });
    expect(client.callTool).toHaveBeenCalledWith({
      name: "session_stop",
      arguments: { sessionId: IDENTITY.happierSessionId },
    });
  });

  it("never completes session_stop when a deeply wrapped result requires approval", async () => {
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
        safeDetails: {
          actionState: "approval_request_created",
          artifactId: "approval-deep-stop-1",
          operation: "session_stop",
          happierSessionId: IDENTITY.happierSessionId,
        },
      },
    });
    expect(client.callTool).toHaveBeenCalledWith({
      name: "session_stop",
      arguments: { sessionId: IDENTITY.happierSessionId },
    });
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

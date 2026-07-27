import { readFileSync } from "node:fs";
import {
  buildRoomConnectorLocalMessageId,
  hashRoomValue,
  type SessionConnectorIdentityV1,
  type SessionConnectorSendRequestV1,
  type SessionConnectorWriteAuthorizationRequestV1,
} from "@fusion/core";
import { describe, expect, it, vi } from "vitest";
import plugin, {
  HAPPIER_RUNTIME_COMPATIBILITY,
  HAPPIER_RUNTIME_ID,
  HAPPIER_RUNTIME_PROVENANCE,
  HAPPIER_RUNTIME_SETTINGS_SCHEMA,
  createHappierHostWriteAuthorizationDependency,
  happierSessionConnectorFactory,
  happierSessionConnectorMetadata,
  happierRuntimeFactory,
  happierRuntimeMetadata,
} from "../index.js";
import { createHappierSessionConnectorWithHostWriteAuthorization } from "../session-connector.js";

const NOW = "2026-07-20T22:30:00.000Z";
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

function sendRequest(identity = IDENTITY, bindingId = "binding-1"): SessionConnectorSendRequestV1 {
  const content = "Forward this durable message only after the Engine certifies its scope.";
  const contentHash = hashRoomValue(content);
  return {
    contractVersion: 1,
    bindingId,
    identity,
    logicalMessageId: `room-message-${bindingId}`,
    localMessageId: buildRoomConnectorLocalMessageId({
      logicalMessageId: `room-message-${bindingId}`,
      bindingId,
      idempotencyKey: `dispatch-${bindingId}`,
      payloadHash: contentHash,
    }),
    idempotencyKey: `dispatch-${bindingId}`,
    content,
    contentHash,
    deliveryAuthorization: {
      outboxId: `outbox-${bindingId}`,
      senderFence: {
        leaseId: `sender-lease-${bindingId}`,
        roomId: `room-${bindingId}`,
        kind: "sender",
        resourceId: bindingId,
        holderId: "room-worker-1",
        hostId: identity.hostId,
        expectedEpoch: 1,
      },
    },
  };
}

function engineScopeFingerprint(request: SessionConnectorWriteAuthorizationRequestV1): string {
  if (!request.canonicalSessionUri || !request.deliveryAuthorization) {
    throw new Error("engine_scope_requires_canonical_session_and_delivery_authorization");
  }
  return `${request.connectorId}-write-scope:${hashRoomValue({
    canonicalSessionUri: request.canonicalSessionUri,
    providerId: request.identity.providerId,
    nativeSessionId: request.identity.nativeSessionId,
    happierSessionId: request.identity.happierSessionId,
    serverProfileId: request.identity.serverProfileId,
    machineId: request.identity.machineId,
    hostId: request.identity.hostId,
    bindingId: request.bindingId,
    operation: request.operation,
    logicalMessageId: request.logicalMessageId,
    localMessageId: request.localMessageId,
    idempotencyKey: request.idempotencyKey,
    contentHash: request.contentHash,
    reason: request.reason,
    outboxId: request.deliveryAuthorization.outboxId,
    senderFence: request.deliveryAuthorization.senderFence,
  })}`;
}

function adapterConnector(
  sessionConnectorWriteAuthorizer: { authorize(request: SessionConnectorWriteAuthorizationRequestV1): Promise<unknown> },
  identity = IDENTITY,
  canonicalSessionUri = URI,
) {
  const fenceRecords = new Map<string, Record<string, unknown>>();
  let lastSend: Readonly<{ localId: string; message: string }> | null = null;
  const client = {
    listTools: vi.fn(async () => [
      { name: "session_message_send" },
      { name: "session_wait_idle" },
      { name: "session_history_get" },
    ]),
    callTool: vi.fn(async (input: { name: string; arguments?: Record<string, unknown> }) => {
      if (input.name === "session_message_send") {
        lastSend = {
          localId: String(input.arguments?.localId),
          message: String(input.arguments?.message),
        };
        return {
          structuredContent: {
            sessionId: identity.happierSessionId,
            localId: lastSend.localId,
            waited: false,
          },
        };
      }
      if (input.name === "session_wait_idle") {
        return {
          structuredContent: {
            sessionId: identity.happierSessionId,
            idle: true,
            observedAt: Date.parse(NOW),
          },
        };
      }
      if (input.name === "session_history_get") {
        return {
          structuredContent: {
            sessionId: identity.happierSessionId,
            format: "raw",
            messages: lastSend
              ? [{
                  id: "native-message-1",
                  localId: lastSend.localId,
                  raw: { content: { type: "text", text: lastSend.message } },
                }]
              : [],
          },
        };
      }
      throw new Error(`unexpected tool ${input.name}`);
    }),
    close: vi.fn(async () => undefined),
  };
  const openMcpClient = vi.fn(async () => client);
  const verifier = createHappierHostWriteAuthorizationDependency({
    settings: { hostWriteAuthorization: "user-editable-and-ignored" },
    sessionConnectorWriteAuthorizer,
  } as never);
  if (!verifier) throw new Error("test_requires_host_write_authorizer");
  const connector = createHappierSessionConnectorWithHostWriteAuthorization({
    settings: {
      executable: "happier",
      activeServerId: identity.serverProfileId!,
      webappUrl: "https://app.happier.dev",
      happierSessionBindings: [{
        canonicalSessionUri,
        happierSessionId: identity.happierSessionId!,
        serverProfileId: identity.serverProfileId!,
        machineId: identity.machineId!,
        takeoverConfirmedAt: NOW,
      }],
    },
    now: () => NOW,
    dependencies: {
      openMcpClient,
      probeRuntime: vi.fn(),
      attestCli: vi.fn(async () => ({
        ok: true as const,
        trustLevel: "local_custom_pinned_source_build" as const,
        sourceRoot: "G:\\codex-project\\happier",
        entrypointPath: "G:\\codex-project\\happier\\apps\\cli\\package-dist\\index.mjs",
        cliVersion: "0.2.10",
        sourceCommit: "6e059c41d865343c1efc9c98676e5af3882d85ff",
        entrypointSha256: "sha256:8ad722284c12ca87c946f3a94b66b14f5640bf768e719c8791b1cb0234312786" as const,
        verifiedAt: NOW,
        evidence: {
          version: "cli_--version" as const,
          package: "package_json" as const,
          source: "git_head" as const,
          artifact: "sha256_file_bytes" as const,
        },
      })),
      createDeliveryFenceStore: () => ({
        reserve: async (input) => {
          const key = JSON.stringify({
            canonicalSessionUri: input.canonicalSessionUri,
            happierSessionId: input.happierSessionId,
            localMessageId: input.localMessageId,
          });
          const existing = fenceRecords.get(key);
          if (existing) {
            return existing.contentHash === input.contentHash
              ? { state: existing.state as "pending" | "confirmed", record: existing as never }
              : { state: "conflict" as const, record: existing as never };
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
          fenceRecords.set(key, record);
          return { state: "created" as const, record: record as never };
        },
        confirm: async (input, receipt) => {
          const key = JSON.stringify({
            canonicalSessionUri: input.canonicalSessionUri,
            happierSessionId: input.happierSessionId,
            localMessageId: input.localMessageId,
          });
          const record = {
            ...fenceRecords.get(key),
            state: "confirmed",
            receipt,
            updatedAt: NOW,
          };
          fenceRecords.set(key, record);
          return { state: "confirmed" as const, record: record as never };
        },
      }),
    },
  }, verifier);
  return { connector, client, openMcpClient };
}

describe("Happier runtime plugin registration", () => {
  it("uses the real SDK helper and one package/manifest/runtime version", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    const manifestJson = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8")) as {
      version: string;
      author?: string;
      homepage?: string;
      description?: string;
      fusionVersion?: string;
      provenance?: Record<string, unknown>;
      compatibility?: Record<string, unknown>;
      settingsSchema?: Record<string, unknown>;
      runtime?: { version?: string };
      sessionConnector?: { version?: string };
    };

    expect(source).toMatch(/import\s*\{\s*definePlugin\s*\}\s*from\s*["']@fusion\/plugin-sdk["']/);
    expect(plugin.manifest.version).toBe(packageJson.version);
    expect(happierRuntimeMetadata.version).toBe(packageJson.version);
    expect(manifestJson.version).toBe(packageJson.version);
    expect(manifestJson.runtime?.version).toBe(packageJson.version);
    expect(manifestJson.sessionConnector?.version).toBe(packageJson.version);
    expect(packageJson.version).toBe("0.3.1");
    expect(plugin.manifest.fusionVersion).toBe(HAPPIER_RUNTIME_COMPATIBILITY.fusionSemver);
    expect(plugin.manifest.settingsSchema).toBe(HAPPIER_RUNTIME_SETTINGS_SCHEMA);
    expect(Object.keys(manifestJson.settingsSchema ?? {}).sort()).toEqual(
      Object.keys(HAPPIER_RUNTIME_SETTINGS_SCHEMA).sort(),
    );
    expect(manifestJson.compatibility).toEqual(HAPPIER_RUNTIME_COMPATIBILITY);
    expect(manifestJson.provenance).toMatchObject(HAPPIER_RUNTIME_PROVENANCE);
    expect(manifestJson.author).toBe(HAPPIER_RUNTIME_PROVENANCE.maintainer);
    expect(manifestJson.homepage).toBe(HAPPIER_RUNTIME_PROVENANCE.repository);
    expect(manifestJson.description).toContain("Local/custom");
    expect(manifestJson.description).not.toContain("Official Happier");
  });

  it("registers metadata and creates the runtime without provider credentials", async () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-happier-runtime");
    expect(plugin.runtime?.metadata).toEqual(happierRuntimeMetadata);
    expect(happierRuntimeMetadata.runtimeId).toBe(HAPPIER_RUNTIME_ID);

    const runtime = await happierRuntimeFactory({
      settings: { backend: "codex", providerApiKey: "do-not-forward" },
    } as never);

    expect(runtime).toMatchObject({ id: "happier", name: "Happier Runtime" });
    expect(JSON.stringify(runtime)).not.toContain("do-not-forward");
  });

  it("keeps the legacy AgentRuntime available while the Room gate is off", async () => {
    const runtime = await happierRuntimeFactory({
      settings: {
        backend: "codex",
        experimentalFeatures: { sessionRoomControlPlane: false },
      },
    } as never);

    expect(plugin.runtime?.metadata).toEqual(happierRuntimeMetadata);
    expect(runtime).toMatchObject({ id: HAPPIER_RUNTIME_ID, name: "Happier Runtime" });
  });

  it("registers a separate Session Connector without replacing AgentRuntime", async () => {
    expect(plugin.runtime?.metadata).toEqual(happierRuntimeMetadata);
    expect(plugin.sessionConnector?.metadata).toEqual(happierSessionConnectorMetadata);

    const connector = await happierSessionConnectorFactory({
      settings: {
        executable: "happier",
        backend: "codex",
        providerApiKey: "must-not-be-exposed",
      },
    } as never);

    expect(connector).toMatchObject({ contractVersion: 1, id: "happier" });
    expect(JSON.stringify(connector)).not.toContain("must-not-be-exposed");
    expect(await happierRuntimeFactory({ settings: {} } as never)).toMatchObject({
      id: HAPPIER_RUNTIME_ID,
      name: "Happier Runtime",
    });
  });

  it("maps the Engine-owned durable outbox authorization into the Happier connector without reading plugin settings", async () => {
    const authorize = vi.fn(async (request: SessionConnectorWriteAuthorizationRequestV1) => {
      if (!request.canonicalSessionUri || !request.scopeFingerprint) return { authorized: false as const };
      return {
        authorized: true as const,
        authorizationId: "room-outbox-write-1",
        scopeFingerprint: request.scopeFingerprint,
      };
    });
    const verifyHostWriteAuthorization = createHappierHostWriteAuthorizationDependency({
      settings: { hostWriteAuthorization: "user-editable-and-ignored" },
      sessionConnectorWriteAuthorizer: { authorize },
    } as never);

    expect(verifyHostWriteAuthorization).toBeTypeOf("function");
    await expect(verifyHostWriteAuthorization!({
      connectorId: "happier",
      operation: "send",
      scopeFingerprint: "happier-write-scope:scope-1",
      canonicalSessionUri: "codex://threads/thread-1",
      providerId: "codex",
      nativeSessionId: "thread-1",
      happierSessionId: "happier-session-1",
      serverProfileId: "profile-1",
      machineId: "machine-1",
      hostId: "windows-host-1",
      bindingId: "binding-1",
      logicalMessageId: "message-1",
      localMessageId: "local-message-1",
      idempotencyKey: "delivery-1",
      contentHash: "sha256:payload-1",
      reason: null,
      deliveryAuthorization: {
        outboxId: "outbox-1",
        senderFence: {
          leaseId: "sender-lease-1",
          roomId: "room-1",
          kind: "sender",
          resourceId: "binding-1",
          holderId: "room-worker-1",
          hostId: "windows-host-1",
          expectedEpoch: 1,
        },
      },
    })).resolves.toEqual({
      authorized: true,
      authorizationId: "room-outbox-write-1",
      scopeFingerprint: "happier-write-scope:scope-1",
    });
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      contractVersion: 1,
      connectorId: "happier",
      operation: "send",
      canonicalSessionUri: "codex://threads/thread-1",
      scopeFingerprint: "happier-write-scope:scope-1",
      bindingId: "binding-1",
      deliveryAuthorization: expect.objectContaining({ outboxId: "outbox-1" }),
    }));
  });

  it("uses the Engine-certified scope through the real adapter and fences missing, mismatched, and replayed grants before MCP", async () => {
    const acceptingAuthorizer = {
      authorize: vi.fn(async (request: SessionConnectorWriteAuthorizationRequestV1) => {
        const certifiedScope = engineScopeFingerprint(request);
        return request.scopeFingerprint === certifiedScope
          ? {
            authorized: true as const,
            authorizationId: "room-outbox-write-accepted",
            scopeFingerprint: certifiedScope,
          }
          : { authorized: false as const };
      }),
    };
    const accepted = adapterConnector(acceptingAuthorizer);
    const acceptedRequest = sendRequest();

    await expect(accepted.connector.send(acceptedRequest)).resolves.toMatchObject({
      ok: true,
      value: { outcome: "confirmed" },
    });
    const acceptedAuthorizerRequest = acceptingAuthorizer.authorize.mock.calls[0]?.[0];
    expect(acceptedAuthorizerRequest).toMatchObject({
      canonicalSessionUri: URI,
      bindingId: acceptedRequest.bindingId,
      scopeFingerprint: engineScopeFingerprint(acceptedAuthorizerRequest!),
    });
    expect(accepted.client.callTool).toHaveBeenCalledWith(expect.objectContaining({ name: "session_message_send" }));

    const missing = adapterConnector({
      authorize: vi.fn(async () => ({ authorized: true as const, authorizationId: "missing-scope" } as never)),
    });
    await expect(missing.connector.send(sendRequest())).resolves.toMatchObject({
      ok: false,
      error: { code: "unavailable", retryable: false },
    });
    expect(missing.openMcpClient).not.toHaveBeenCalled();
    expect(missing.client.callTool).not.toHaveBeenCalled();

    const mismatched = adapterConnector({
      authorize: vi.fn(async () => ({
        authorized: true as const,
        authorizationId: "mismatched-scope",
        scopeFingerprint: "happier-write-scope:wrong-binding",
      })),
    });
    await expect(mismatched.connector.send(sendRequest())).resolves.toMatchObject({
      ok: false,
      error: { code: "unavailable", retryable: false },
    });
    expect(mismatched.openMcpClient).not.toHaveBeenCalled();
    expect(mismatched.client.callTool).not.toHaveBeenCalled();

    let firstCertifiedScope: string | undefined;
    const replayedAuthorizer = {
      authorize: vi.fn(async (request: SessionConnectorWriteAuthorizationRequestV1) => {
        firstCertifiedScope ??= request.scopeFingerprint;
        return {
          authorized: true as const,
          authorizationId: "replayed-scope",
          scopeFingerprint: firstCertifiedScope,
        } as never;
      }),
    };
    const first = adapterConnector(replayedAuthorizer);
    const secondIdentity: SessionConnectorIdentityV1 = {
      ...IDENTITY,
      nativeSessionId: "codex-thread-2",
      happierSessionId: "happier-session-2",
      serverProfileId: "server-2",
      machineId: "machine-2",
      hostId: "fusion-host-2",
    };
    const second = adapterConnector(
      replayedAuthorizer,
      secondIdentity,
      "codex://threads/codex-thread-2",
    );
    await expect(first.connector.send(sendRequest())).resolves.toMatchObject({ ok: true });
    await expect(second.connector.send(sendRequest(secondIdentity, "binding-2"))).resolves.toMatchObject({
      ok: false,
      error: { code: "unavailable", retryable: false },
    });
    expect(second.openMcpClient).not.toHaveBeenCalled();
    expect(second.client.callTool).not.toHaveBeenCalled();
  });

  it("emits a non-sensitive loaded event and never logs settings secrets", () => {
    const info = vi.fn();
    const emitEvent = vi.fn();

    plugin.hooks?.onLoad?.({
      pluginId: "fusion-plugin-happier-runtime",
      settings: {
        executable: "happier",
        backend: "codex",
        providerApiKey: "secret-provider-key",
      },
      logger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      emitEvent,
    } as never);

    expect(emitEvent).toHaveBeenCalledWith("happier-runtime:loaded", {
      runtimeId: "happier",
      version: expect.any(String),
    });
    expect(info.mock.calls.flat().join(" ")).not.toContain("secret-provider-key");
  });
});

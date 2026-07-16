import {
  hashRoomValue,
  type SessionConnectorIdentityV1,
  type SessionConnectorSendRequestV1,
} from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import {
  HappierSessionConnector,
  type HappierSessionConnectorDependencies,
} from "../session-connector.js";
import { HappierCliError } from "../types.js";

const NOW = "2026-07-17T05:10:00.000Z";

const IDENTITY: SessionConnectorIdentityV1 = {
  connectorId: "happier",
  providerId: "codex",
  nativeSessionId: "codex-thread-1",
  happierSessionId: "happier-session-1",
  serverProfileId: "server-1",
  machineId: "machine-1",
  hostId: "fusion-host-1",
};

function setup(overrides: Partial<HappierSessionConnectorDependencies> = {}) {
  const dependencies: HappierSessionConnectorDependencies = {
    ensureDirectSession: vi.fn(async () => ({
      providerId: "codex" as const,
      remoteSessionId: "codex-thread-1",
      machineId: "machine-1",
      serverId: "server-1",
      sessionId: "happier-session-1",
      created: true,
      openUrl: "https://app.happier.dev/session/happier-session-1?serverId=server-1",
    })),
    getSessionStatus: vi.fn(async () => ({
      sessionId: "happier-session-1",
      session: {
        id: "happier-session-1",
        active: true,
        lastActivityAt: 1_752_729_000_000,
      },
      agentState: { status: "waitingOnInput", controlledByUser: true },
    })),
    getSessionHistory: vi.fn(async () => ({
      sessionId: "happier-session-1",
      format: "raw",
      messages: [
        { id: "native-message-1", localId: "logical-1", createdAt: 1_752_729_000_000, role: "user", raw: { text: "first" } },
        { id: "native-message-2", createdAt: 1_752_729_001_000, role: "agent", raw: { text: "second" } },
      ],
    })),
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
      backendId: "codex" as const,
      details: [],
    })),
    ...overrides,
  };
  return {
    dependencies,
    connector: new HappierSessionConnector({
      settings: {
        executable: "happier",
        webappUrl: "https://app.happier.dev",
      },
      now: () => NOW,
      dependencies,
    }),
  };
}

function sendRequest(): SessionConnectorSendRequestV1 {
  const content = "Continue the exact native Session";
  return {
    contractVersion: 1,
    bindingId: "binding-1",
    identity: IDENTITY,
    logicalMessageId: "room-message-1",
    idempotencyKey: "dispatch-1",
    content,
    contentHash: hashRoomValue(content),
  };
}

describe("HappierSessionConnector", () => {
  it("normalizes official Direct Session identity fields without starting a provider turn", async () => {
    const { connector, dependencies } = setup();

    const result = await connector.ensureExisting({
      contractVersion: 1,
      canonicalSessionUri: "codex://threads/codex-thread-1",
      requiredHostId: "fusion-host-1",
      requiredMachineId: "machine-1",
      idempotencyKey: "attach-1",
    });

    expect(dependencies.ensureDirectSession).toHaveBeenCalledWith({
      uri: "codex://threads/codex-thread-1",
      machineId: "machine-1",
      settings: expect.objectContaining({ executable: "happier" }),
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        identity: IDENTITY,
        createdLink: true,
        providerTurnStarted: false,
        attachedAt: NOW,
      },
    });
  });

  it("targets Happier's linked Session for status while retaining provider-native identity", async () => {
    const { connector, dependencies } = setup();

    await expect(connector.getStatus(IDENTITY)).resolves.toEqual({
      ok: true,
      value: {
        identity: IDENTITY,
        state: "waiting_input",
        lastActivityAt: "2025-07-17T05:10:00.000Z",
        connectorCursor: null,
        nativeWriterDetected: true,
      },
    });
    expect(dependencies.getSessionStatus).toHaveBeenCalledWith(
      "happier-session-1",
      expect.objectContaining({ executable: "happier" }),
      undefined,
    );
  });

  it("maps bounded raw history to content-free durable cursor records", async () => {
    const { connector, dependencies } = setup();
    const first = await connector.readHistory({
      contractVersion: 1,
      identity: IDENTITY,
      afterCursor: null,
      limit: 2,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.error.message);
    expect(first.value.items).toEqual([
      expect.objectContaining({
        nativeMessageId: "native-message-1",
        logicalMessageId: "logical-1",
        role: "user",
        contentHash: hashRoomValue({ text: "first" }),
        occurredAt: "2025-07-17T05:10:00.000Z",
      }),
      expect.objectContaining({
        nativeMessageId: "native-message-2",
        logicalMessageId: null,
        role: "assistant",
        contentHash: hashRoomValue({ text: "second" }),
        occurredAt: "2025-07-17T05:10:01.000Z",
      }),
    ]);
    expect(first.value.items[0]?.cursor).toMatch(/^happier-history-v1:/u);
    expect(first.value.nextCursor).toBe(first.value.items[1]?.cursor);
    expect(JSON.stringify(first.value)).not.toContain("first");
    expect(dependencies.getSessionHistory).toHaveBeenCalledWith(
      "happier-session-1",
      2,
      expect.objectContaining({ executable: "happier" }),
      undefined,
    );

    const after = await connector.readHistory({
      contractVersion: 1,
      identity: IDENTITY,
      afterCursor: first.value.items[0]!.cursor,
      limit: 1,
    });
    expect(after).toMatchObject({
      ok: true,
      value: { items: [{ nativeMessageId: "native-message-2" }] },
    });
    expect(dependencies.getSessionHistory).toHaveBeenLastCalledWith(
      "happier-session-1",
      250,
      expect.objectContaining({ executable: "happier" }),
      undefined,
    );
  });

  it("uses a deterministic safe local id and returns the official send acknowledgement", async () => {
    const { connector, dependencies } = setup();
    const request = sendRequest();

    const first = await connector.send(request);
    const second = await connector.send(request);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      ok: true,
      value: {
        outcome: "accepted",
        nativeMessageId: null,
        cursor: null,
        acceptedAt: NOW,
      },
    });
    const localId = (dependencies.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].localId;
    expect(localId).toMatch(/^fusion-room-[a-f0-9]{64}$/u);
    expect((dependencies.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1]?.[0].localId).toBe(localId);
    expect(first.ok && first.value.connectorAcknowledgementId).toBe(localId);
    expect(dependencies.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "happier-session-1",
        message: request.content,
        localId,
      }),
      expect.objectContaining({ executable: "happier" }),
      undefined,
    );
  });

  it("keeps ambiguous send failures visible and redacts connector errors", async () => {
    const { connector } = setup({
      sendMessage: vi.fn(async () => {
        throw new HappierCliError("timeout", "Bearer secret-token may have been accepted");
      }),
      getSessionStatus: vi.fn(async () => {
        throw new HappierCliError("authentication", "accessToken=secret-token");
      }),
    });

    await expect(connector.send(sendRequest())).resolves.toEqual({
      ok: true,
      value: {
        outcome: "delivery_uncertain",
        connectorAcknowledgementId: null,
        nativeMessageId: null,
        cursor: null,
        acceptedAt: null,
      },
    });
    const status = await connector.getStatus(IDENTITY);
    expect(status).toMatchObject({
      ok: false,
      error: { code: "authentication_required", retryable: false },
    });
    expect(JSON.stringify(status)).not.toContain("secret-token");
  });

  it("reports uncertified and unavailable surfaces instead of fabricating parity", async () => {
    const { connector } = setup();
    const capabilities = await connector.getCapabilities(IDENTITY);
    expect(capabilities).toMatchObject({
      contractVersion: 1,
      connectorId: "happier",
      connectorVersion: connector.version,
      capabilities: {
        ensureExisting: { state: "unverified" },
        status: { state: "unverified" },
        history: { state: "unverified" },
        send: { state: "unverified" },
        create: { state: "unavailable" },
        events: { state: "unavailable" },
        interrupt: { state: "unavailable" },
        resume: { state: "unavailable" },
        takeover: { state: "unavailable" },
        health: { state: "unverified" },
        deepLinks: { state: "unavailable" },
      },
    });

    await expect(connector.create({
      contractVersion: 1,
      providerId: "codex",
      hostId: "fusion-host-1",
      workingDirectory: "G:\\repo",
      idempotencyKey: "create-1",
    })).resolves.toMatchObject({ ok: false, error: { code: "unavailable" } });
    await expect(connector.interrupt({
      contractVersion: 1,
      identity: IDENTITY,
      idempotencyKey: "interrupt-1",
      reason: "operator request",
    })).resolves.toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
});

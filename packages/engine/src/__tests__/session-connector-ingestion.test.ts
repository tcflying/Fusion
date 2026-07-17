import { describe, expect, it } from "vitest";

import {
  SESSION_CONNECTOR_CAPABILITIES,
  type EventCursor,
  type SessionConnectorCapabilitiesV1,
  type SessionConnectorCapabilityName,
  type SessionConnectorCapabilityState,
  type SessionConnectorControlResultV1,
  type SessionConnectorDeepLinksV1,
  type SessionConnectorEventV1,
  type SessionConnectorHealthV1,
  type SessionConnectorHistoryItemV1,
  type SessionConnectorHistoryPageV1,
  type SessionConnectorIdentityV1,
  type SessionConnectorResultV1,
  type SessionConnectorSendReceiptV1,
  type SessionConnectorStatusV1,
  type SessionConnectorV1,
} from "@fusion/core";
import {
  runSessionConnectorIngestion,
  type SessionConnectorIngestionModeState,
  type SessionConnectorIngestionPersistencePort,
  type SessionConnectorStatusUpdate,
  type SessionConnectorTranscriptBatch,
  type SessionConnectorTranscriptPersistResult,
} from "../session-connector-ingestion.js";

const NOW = "2026-07-17T10:00:00.000Z";
const IDENTITY = {
  connectorId: "happier",
  providerId: "codex",
  nativeSessionId: "codex-thread-1",
  happierSessionId: "happier-session-1",
  serverProfileId: "happier-server-1",
  machineId: "happier-machine-1",
  hostId: "windows-host-1",
} satisfies SessionConnectorIdentityV1;

function ok<T>(value: T): SessionConnectorResultV1<T> {
  return { ok: true, value };
}

function capabilityMatrix(
  overrides: Partial<Record<SessionConnectorCapabilityName, SessionConnectorCapabilityState>> = {},
): SessionConnectorCapabilitiesV1 {
  const capabilities = Object.fromEntries(
    SESSION_CONNECTOR_CAPABILITIES.map((name) => {
      const state = overrides[name] ?? "verified";
      return [name, {
        state,
        evidenceRef: state === "verified" ? `evidence://happier/${name}` : null,
        reasonCode: state === "verified"
          ? null
          : state === "unavailable"
            ? "operation_unavailable"
            : state === "unverified"
              ? "pending_provider_certification"
              : "runtime_degraded",
        lastVerifiedAt: state === "verified" ? NOW : null,
      }];
    }),
  ) as unknown as SessionConnectorCapabilitiesV1["capabilities"];
  return {
    contractVersion: 1,
    connectorId: IDENTITY.connectorId,
    connectorVersion: "0.2.73",
    sourceRevision: "happier-source-revision",
    verifiedAt: NOW,
    capabilities,
  };
}

function historyItem(cursor: string): SessionConnectorHistoryItemV1 {
  return {
    nativeMessageId: `native-${cursor}`,
    logicalMessageId: null,
    role: "assistant",
    contentHash: `sha256:${cursor}`,
    occurredAt: NOW,
    cursor,
  };
}

function transcriptEvent(input: {
  readonly fromCursor: EventCursor | null;
  readonly nextCursor: EventCursor | null;
  readonly completeThroughCursor: EventCursor | null;
  readonly truncated?: boolean;
  readonly items: readonly SessionConnectorHistoryItemV1[];
}): SessionConnectorEventV1 {
  return {
    connectorEventId: `event-${input.nextCursor ?? "none"}`,
    identity: IDENTITY,
    eventType: "message",
    cursor: input.nextCursor ?? "event-without-next-cursor",
    occurredAt: NOW,
    payload: {
      type: "transcript_delta",
      fromCursor: input.fromCursor,
      nextCursor: input.nextCursor,
      completeThroughCursor: input.completeThroughCursor,
      truncated: input.truncated ?? false,
      items: input.items,
    },
  };
}

function statusEvent(
  cursor: EventCursor,
  state: SessionConnectorStatusV1["state"],
): SessionConnectorEventV1 {
  return {
    connectorEventId: `status-event-${cursor}`,
    identity: IDENTITY,
    eventType: "status",
    cursor,
    occurredAt: NOW,
    payload: {
      type: "status",
      state,
      lastActivityAt: NOW,
      connectorCursor: "5",
      nativeWriterDetected: true,
    },
  };
}

class InMemoryIngestionPersistence implements SessionConnectorIngestionPersistencePort {
  transcriptCursor: EventCursor | null;
  statusCursor: EventCursor | null = null;
  readonly batches: SessionConnectorTranscriptBatch[] = [];
  readonly statuses: SessionConnectorStatusUpdate[] = [];
  readonly modes: SessionConnectorIngestionModeState[] = [];
  readonly nativeMessageIds = new Set<string>();
  readonly contentHashes = new Set<string>();

  constructor(
    transcriptCursor: EventCursor | null = null,
    private readonly modeHook?: (state: SessionConnectorIngestionModeState) => Promise<void>,
  ) {
    this.transcriptCursor = transcriptCursor;
  }

  async loadCheckpoint(): Promise<{ transcriptCursor: EventCursor | null; statusCursor: EventCursor | null }> {
    return {
      transcriptCursor: this.transcriptCursor,
      statusCursor: this.statusCursor,
    };
  }

  async persistTranscriptBatch(
    input: SessionConnectorTranscriptBatch,
  ): Promise<SessionConnectorTranscriptPersistResult> {
    this.batches.push(input);
    let insertedCount = 0;
    let duplicateNativeMessageIdCount = 0;
    let duplicateContentHashCount = 0;
    for (const item of input.items) {
      if (this.nativeMessageIds.has(item.nativeMessageId)) {
        duplicateNativeMessageIdCount += 1;
        continue;
      }
      if (this.contentHashes.has(item.contentHash)) {
        duplicateContentHashCount += 1;
        continue;
      }
      this.nativeMessageIds.add(item.nativeMessageId);
      this.contentHashes.add(item.contentHash);
      insertedCount += 1;
    }
    this.transcriptCursor = input.completeThroughCursor;
    return {
      committedCursor: this.transcriptCursor,
      insertedCount,
      duplicateNativeMessageIdCount,
      duplicateContentHashCount,
    };
  }

  async persistStatus(input: SessionConnectorStatusUpdate): Promise<void> {
    this.statuses.push(input);
    this.statusCursor = input.statusCursor;
  }

  async persistMode(input: SessionConnectorIngestionModeState): Promise<void> {
    this.modes.push(input);
    await this.modeHook?.(input);
  }
}

interface ConnectorFixtureOptions {
  readonly historyPages: readonly SessionConnectorHistoryPageV1[];
  readonly events?: AsyncIterable<SessionConnectorEventV1>;
  readonly eventStreams?: readonly AsyncIterable<SessionConnectorEventV1>[];
  readonly capabilityOverrides?: Partial<Record<SessionConnectorCapabilityName, SessionConnectorCapabilityState>>;
  readonly calls?: string[];
}

function connectorFixture(options: ConnectorFixtureOptions): SessionConnectorV1 {
  let historyIndex = 0;
  let eventStreamIndex = 0;
  return {
    contractVersion: 1,
    id: IDENTITY.connectorId,
    version: "0.2.73",
    getCapabilities: async () => capabilityMatrix(options.capabilityOverrides),
    ensureExisting: async () => { throw new Error("not used"); },
    create: async () => { throw new Error("not used"); },
    getStatus: async () => { throw new Error("not used"); },
    readHistory: async (input) => {
      options.calls?.push(`history:${input.afterCursor ?? "null"}`);
      const page = options.historyPages[Math.min(historyIndex, options.historyPages.length - 1)];
      historyIndex += 1;
      if (!page) throw new Error("history fixture exhausted");
      return ok(page);
    },
    subscribeEvents: async () => {
      options.calls?.push("subscribe");
      const streams = options.eventStreams;
      const stream = streams?.[Math.min(eventStreamIndex, streams.length - 1)]
        ?? options.events
        ?? (async function* emptyEvents() {})();
      eventStreamIndex += 1;
      return ok(stream);
    },
    send: async () => { throw new Error("not used"); },
    interrupt: async () => { throw new Error("not used"); },
    resume: async () => { throw new Error("not used"); },
    takeover: async () => { throw new Error("not used"); },
    getHealth: async () => ({
      connectorId: IDENTITY.connectorId,
      hostId: IDENTITY.hostId,
      state: "healthy",
      checkedAt: NOW,
      authentication: "authenticated",
      daemon: "running",
      server: "reachable",
      backend: "ready",
      rateLimit: "clear",
      host: "reachable",
      capabilities: Object.fromEntries(
        SESSION_CONNECTOR_CAPABILITIES.map((name) => [name, "verified"]),
      ) as SessionConnectorHealthV1["capabilities"],
      reasonCodes: [],
      retryAfterMs: null,
    } satisfies SessionConnectorHealthV1),
    getDeepLinks: async () => ok<SessionConnectorDeepLinksV1>({
      happierUrl: null,
      nativeSessionUrl: null,
    }),
  };
}

describe("Session Connector event-first ingestion", () => {
  it("reconciles bounded history from the persisted cursor before subscribing", async () => {
    const calls: string[] = [];
    const persistence = new InMemoryIngestionPersistence("5");
    const connector = connectorFixture({
      calls,
      historyPages: [
        { items: [historyItem("6")], nextCursor: "6", completeThroughCursor: "6" },
        { items: [], nextCursor: "6", completeThroughCursor: "6" },
      ],
    });

    const result = await runSessionConnectorIngestion({
      connector,
      identity: IDENTITY,
      persistence,
      limits: {
        historyPageSize: 50,
        maxHistoryPagesPerReconciliation: 2,
        maxEvents: 10,
        maxStreamReconnects: 0,
        maxDegradedPolls: 1,
      },
    });

    expect(calls.slice(0, 2)).toEqual(["history:5", "subscribe"]);
    expect(persistence.batches[0]).toMatchObject({
      source: "history",
      fromCursor: "5",
      completeThroughCursor: "6",
      items: [{ nativeMessageId: "native-6" }],
    });
    expect(result).toMatchObject({
      mode: "stopped",
      outcome: "degraded_limit",
      transcriptCursor: "6",
    });
  });

  it("continues bounded history when the official provider reports byte truncation", async () => {
    const calls: string[] = [];
    const persistence = new InMemoryIngestionPersistence("5");
    const connector = connectorFixture({
      calls,
      historyPages: [
        {
          items: [historyItem("6")],
          nextCursor: "6",
          completeThroughCursor: "6",
          truncated: true,
        },
        { items: [], nextCursor: "6", completeThroughCursor: "6", truncated: false },
        { items: [], nextCursor: "6", completeThroughCursor: "6", truncated: false },
      ],
    });

    const result = await runSessionConnectorIngestion({
      connector,
      identity: IDENTITY,
      persistence,
      limits: {
        historyPageSize: 50,
        maxHistoryPagesPerReconciliation: 3,
        maxEvents: 10,
        maxStreamReconnects: 0,
        maxDegradedPolls: 1,
      },
    });

    expect(calls.slice(0, 3)).toEqual(["history:5", "history:6", "subscribe"]);
    expect(result).toMatchObject({ outcome: "degraded_limit", transcriptCursor: "6" });
  });

  it("fails closed when a truncated history page cannot advance its cursor", async () => {
    const calls: string[] = [];
    const persistence = new InMemoryIngestionPersistence("5");
    const connector = connectorFixture({
      calls,
      historyPages: [{
        items: [],
        nextCursor: "5",
        completeThroughCursor: "5",
        truncated: true,
      }],
    });

    const result = await runSessionConnectorIngestion({
      connector,
      identity: IDENTITY,
      persistence,
      limits: {
        historyPageSize: 50,
        maxHistoryPagesPerReconciliation: 2,
        maxEvents: 10,
        maxStreamReconnects: 0,
        maxDegradedPolls: 1,
      },
    });

    expect(calls).toEqual(["history:5"]);
    expect(result).toMatchObject({
      outcome: "history_limit",
      transcriptCursor: "5",
      error: { code: "limit", retryable: true },
    });
  });

  it("commits a contiguous typed transcript delta from a certified event stream", async () => {
    const persistence = new InMemoryIngestionPersistence("5");
    const connector = connectorFixture({
      historyPages: [
        { items: [historyItem("6")], nextCursor: "6", completeThroughCursor: "6" },
        { items: [], nextCursor: "7", completeThroughCursor: "7" },
      ],
      events: (async function* events() {
        yield transcriptEvent({
          fromCursor: "6",
          nextCursor: "7",
          completeThroughCursor: "7",
          items: [historyItem("7")],
        });
      })(),
    });

    const result = await runSessionConnectorIngestion({
      connector,
      identity: IDENTITY,
      persistence,
      limits: {
        historyPageSize: 50,
        maxHistoryPagesPerReconciliation: 2,
        maxEvents: 10,
        maxStreamReconnects: 0,
        maxDegradedPolls: 1,
      },
    });

    expect(persistence.batches).toHaveLength(4);
    expect(persistence.batches[1]).toMatchObject({
      source: "event",
      fromCursor: "6",
      nextCursor: "7",
      completeThroughCursor: "7",
      items: [{ nativeMessageId: "native-7", contentHash: "sha256:7" }],
    });
    expect(result).toMatchObject({
      outcome: "degraded_limit",
      transcriptCursor: "7",
    });
  });

  it("rejects a certified event whose immutable Session identity drifted", async () => {
    const persistence = new InMemoryIngestionPersistence("5");
    const driftedEvent = {
      ...transcriptEvent({
        fromCursor: "5",
        nextCursor: "6",
        completeThroughCursor: "6",
        items: [historyItem("6")],
      }),
      identity: { ...IDENTITY, nativeSessionId: "another-codex-thread" },
    } satisfies SessionConnectorEventV1;
    const connector = connectorFixture({
      historyPages: [{ items: [], nextCursor: "5", completeThroughCursor: "5" }],
      events: (async function* events() { yield driftedEvent; })(),
    });

    const result = await runSessionConnectorIngestion({
      connector,
      identity: IDENTITY,
      persistence,
      limits: {
        historyPageSize: 50,
        maxHistoryPagesPerReconciliation: 2,
        maxEvents: 10,
        maxStreamReconnects: 0,
        maxDegradedPolls: 1,
      },
    });

    expect(persistence.batches).toHaveLength(1);
    expect(result).toMatchObject({
      outcome: "contract_failure",
      transcriptCursor: "5",
      error: { code: "invalid_event_payload", retryable: false },
    });
  });

  it("catches up from the last committed cursor when a stream ends", async () => {
    const calls: string[] = [];
    const persistence = new InMemoryIngestionPersistence("5");
    const connector = connectorFixture({
      calls,
      historyPages: [
        { items: [historyItem("6")], nextCursor: "6", completeThroughCursor: "6" },
        { items: [historyItem("8")], nextCursor: "8", completeThroughCursor: "8" },
      ],
      events: (async function* events() {
        yield transcriptEvent({
          fromCursor: "6",
          nextCursor: "7",
          completeThroughCursor: "7",
          items: [historyItem("7")],
        });
      })(),
    });

    const result = await runSessionConnectorIngestion({
      connector,
      identity: IDENTITY,
      persistence,
      limits: {
        historyPageSize: 50,
        maxHistoryPagesPerReconciliation: 2,
        maxEvents: 10,
        maxStreamReconnects: 0,
        maxDegradedPolls: 1,
      },
    });

    expect(calls.slice(0, 3)).toEqual(["history:5", "subscribe", "history:7"]);
    expect(persistence.batches.map((batch) => batch.source)).toEqual([
      "history",
      "event",
      "history",
      "history",
    ]);
    expect(result).toMatchObject({
      outcome: "degraded_limit",
      transcriptCursor: "8",
    });
  });

  it("repairs a cursor gap from the last committed cursor before accepting more stream data", async () => {
    const calls: string[] = [];
    const persistence = new InMemoryIngestionPersistence("5");
    const connector = connectorFixture({
      calls,
      historyPages: [
        { items: [historyItem("6")], nextCursor: "6", completeThroughCursor: "6" },
        {
          items: [historyItem("7"), historyItem("8"), historyItem("9")],
          nextCursor: "9",
          completeThroughCursor: "9",
        },
      ],
      events: (async function* events() {
        yield transcriptEvent({
          fromCursor: "8",
          nextCursor: "9",
          completeThroughCursor: "9",
          items: [historyItem("9")],
        });
      })(),
    });

    const result = await runSessionConnectorIngestion({
      connector,
      identity: IDENTITY,
      persistence,
      limits: {
        historyPageSize: 50,
        maxHistoryPagesPerReconciliation: 2,
        maxEvents: 10,
        maxStreamReconnects: 0,
        maxDegradedPolls: 1,
      },
    });

    expect(calls.slice(0, 3)).toEqual(["history:5", "subscribe", "history:6"]);
    expect(persistence.batches[1]).toMatchObject({
      source: "history",
      fromCursor: "6",
      completeThroughCursor: "9",
    });
    expect(persistence.batches.some((batch) => batch.source === "event")).toBe(false);
    expect(result.transcriptCursor).toBe("9");
  });

  it("repairs a truncated transcript event without committing it as complete", async () => {
    const calls: string[] = [];
    const persistence = new InMemoryIngestionPersistence("5");
    const connector = connectorFixture({
      calls,
      historyPages: [
        { items: [historyItem("6")], nextCursor: "6", completeThroughCursor: "6" },
        {
          items: [historyItem("7"), historyItem("8")],
          nextCursor: "8",
          completeThroughCursor: "8",
        },
      ],
      events: (async function* events() {
        yield transcriptEvent({
          fromCursor: "6",
          nextCursor: "8",
          completeThroughCursor: "8",
          truncated: true,
          items: [historyItem("7"), historyItem("8")],
        });
      })(),
    });

    const result = await runSessionConnectorIngestion({
      connector,
      identity: IDENTITY,
      persistence,
      limits: {
        historyPageSize: 50,
        maxHistoryPagesPerReconciliation: 2,
        maxEvents: 10,
        maxStreamReconnects: 0,
        maxDegradedPolls: 1,
      },
    });

    expect(calls.slice(0, 3)).toEqual(["history:5", "subscribe", "history:6"]);
    expect(persistence.batches[1]).toMatchObject({
      source: "history",
      fromCursor: "6",
      completeThroughCursor: "8",
    });
    expect(persistence.batches.some((batch) => batch.source === "event")).toBe(false);
    expect(result.transcriptCursor).toBe("8");
  });

  it("polls history in explicit degraded mode when events are not verified", async () => {
    const calls: string[] = [];
    const waits: number[] = [];
    const modes: string[] = [];
    const persistence = new InMemoryIngestionPersistence("5");
    const connector = connectorFixture({
      calls,
      capabilityOverrides: { events: "unavailable" },
      historyPages: [
        { items: [historyItem("6")], nextCursor: "6", completeThroughCursor: "6" },
        { items: [historyItem("7")], nextCursor: "7", completeThroughCursor: "7" },
        { items: [], nextCursor: "7", completeThroughCursor: "7" },
      ],
    });

    const result = await runSessionConnectorIngestion({
      connector,
      identity: IDENTITY,
      persistence,
      limits: {
        historyPageSize: 50,
        maxHistoryPagesPerReconciliation: 2,
        maxEvents: 10,
        maxStreamReconnects: 0,
        maxDegradedPolls: 2,
      },
      degradedPollIntervalMs: 250,
      wait: async (delayMs) => { waits.push(delayMs); },
      onModeChange: (state) => { modes.push(state.mode); },
    });

    expect(calls).toEqual(["history:5", "history:6", "history:7"]);
    expect(calls).not.toContain("subscribe");
    expect(waits).toEqual([250, 250]);
    expect(modes[0]).toBe("reconciling");
    expect(modes).toContain("degraded");
    expect(modes).not.toContain("streaming");
    expect(modes.at(-1)).toBe("stopped");
    expect(result).toMatchObject({
      outcome: "degraded_limit",
      transcriptCursor: "7",
    });
  });

  it("falls back to bounded degraded polling after a certified stream ends", async () => {
    const calls: string[] = [];
    const waits: number[] = [];
    const modes: string[] = [];
    const persistence = new InMemoryIngestionPersistence("5");
    const connector = connectorFixture({
      calls,
      historyPages: [{ items: [], nextCursor: "5", completeThroughCursor: "5" }],
      events: (async function* emptyStream() {})(),
    });

    const result = await runSessionConnectorIngestion({
      connector,
      identity: IDENTITY,
      persistence,
      degradedPollIntervalMs: 100,
      wait: async (delayMs) => { waits.push(delayMs); },
      onModeChange: (state) => { modes.push(state.mode); },
      limits: {
        historyPageSize: 50,
        maxHistoryPagesPerReconciliation: 2,
        maxEvents: 10,
        maxStreamReconnects: 0,
        maxDegradedPolls: 2,
      },
    });

    expect(calls).toEqual([
      "history:5",
      "subscribe",
      "history:5",
      "history:5",
      "history:5",
    ]);
    expect(waits).toEqual([100, 100]);
    expect(modes).toContain("degraded");
    expect(result).toMatchObject({ outcome: "degraded_limit", transcriptCursor: "5" });
  });

  it("persists typed status events with an independent status cursor", async () => {
    const persistence = new InMemoryIngestionPersistence("5");
    const connector = connectorFixture({
      historyPages: [
        { items: [], nextCursor: "5", completeThroughCursor: "5" },
        { items: [], nextCursor: "5", completeThroughCursor: "5" },
      ],
      events: (async function* events() {
        yield statusEvent("status-1", "running");
      })(),
    });

    const result = await runSessionConnectorIngestion({
      connector,
      identity: IDENTITY,
      persistence,
      limits: {
        historyPageSize: 50,
        maxHistoryPagesPerReconciliation: 2,
        maxEvents: 10,
        maxStreamReconnects: 0,
        maxDegradedPolls: 1,
      },
    });

    expect(persistence.statuses).toEqual([{
      identity: IDENTITY,
      statusCursor: "status-1",
      occurredAt: NOW,
      status: {
        identity: IDENTITY,
        state: "running",
        lastActivityAt: NOW,
        connectorCursor: "5",
        nativeWriterDetected: true,
      },
    }]);
    expect(result).toMatchObject({
      transcriptCursor: "5",
      statusCursor: "status-1",
    });
  });

  it("aborts a blocked event iterator and runs iterator cleanup", async () => {
    const controller = new AbortController();
    let returnCalls = 0;
    let releaseNext: ((result: IteratorResult<SessionConnectorEventV1>) => void) | undefined;
    const iterator: AsyncIterator<SessionConnectorEventV1> & AsyncIterable<SessionConnectorEventV1> = {
      next: () => new Promise((resolve) => { releaseNext = resolve; }),
      return: async () => {
        returnCalls += 1;
        releaseNext?.({ done: true, value: undefined });
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() { return this; },
    };
    const persistence = new InMemoryIngestionPersistence("5");
    const connector = connectorFixture({
      historyPages: [
        { items: [], nextCursor: "5", completeThroughCursor: "5" },
      ],
      events: iterator,
    });

    const run = runSessionConnectorIngestion({
      connector,
      identity: IDENTITY,
      persistence,
      signal: controller.signal,
      limits: {
        historyPageSize: 50,
        maxHistoryPagesPerReconciliation: 2,
        maxEvents: 10,
        maxStreamReconnects: 0,
        maxDegradedPolls: 1,
      },
      onModeChange: (state) => {
        if (state.mode === "streaming") controller.abort();
      },
    });
    const observed = await Promise.race([
      run,
      new Promise<"timeout">((resolve) => { setTimeout(() => resolve("timeout"), 50); }),
    ]);

    expect(observed).not.toBe("timeout");
    expect(observed).toMatchObject({
      mode: "stopped",
      outcome: "aborted",
      transcriptCursor: "5",
    });
    expect(returnCalls).toBe(1);
  });

  it("closes the event iterator when durable status persistence fails", async () => {
    let returnCalls = 0;
    let delivered = false;
    const iterator: AsyncIterator<SessionConnectorEventV1> & AsyncIterable<SessionConnectorEventV1> = {
      next: async () => {
        if (delivered) return { done: true, value: undefined };
        delivered = true;
        return { done: false, value: statusEvent("status-failure", "running") };
      },
      return: async () => {
        returnCalls += 1;
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() { return this; },
    };
    const persistence = new InMemoryIngestionPersistence("5");
    persistence.persistStatus = async () => {
      throw new Error("database credential and transcript plaintext");
    };
    const connector = connectorFixture({
      historyPages: [{ items: [], nextCursor: "5", completeThroughCursor: "5" }],
      events: iterator,
    });

    const result = await runSessionConnectorIngestion({
      connector,
      identity: IDENTITY,
      persistence,
      limits: {
        historyPageSize: 50,
        maxHistoryPagesPerReconciliation: 2,
        maxEvents: 10,
        maxStreamReconnects: 0,
        maxDegradedPolls: 1,
      },
    });

    expect(result).toMatchObject({ outcome: "persistence_failure" });
    expect(returnCalls).toBe(1);
    expect(JSON.stringify(result)).not.toContain("transcript plaintext");
  });

  it("awaits durable mode transitions before consuming certified events", async () => {
    const calls: string[] = [];
    let releaseStreamingMode: (() => void) | undefined;
    let markStreamingModeStarted: (() => void) | undefined;
    const streamingModeStarted = new Promise<void>((resolve) => {
      markStreamingModeStarted = resolve;
    });
    const streamingModeGate = new Promise<void>((resolve) => {
      releaseStreamingMode = resolve;
    });
    const persistence = new InMemoryIngestionPersistence("5", async (state) => {
      if (state.mode !== "streaming") return;
      markStreamingModeStarted?.();
      await streamingModeGate;
    });
    const connector = connectorFixture({
      calls,
      historyPages: [
        { items: [], nextCursor: "5", completeThroughCursor: "5" },
        { items: [], nextCursor: "5", completeThroughCursor: "5" },
      ],
      events: (async function* events() {
        calls.push("stream-next");
      })(),
    });

    const run = runSessionConnectorIngestion({
      connector,
      identity: IDENTITY,
      persistence,
      limits: {
        historyPageSize: 50,
        maxHistoryPagesPerReconciliation: 2,
        maxEvents: 10,
        maxStreamReconnects: 0,
        maxDegradedPolls: 1,
      },
    });
    const observed = await Promise.race([
      streamingModeStarted.then(() => "started" as const),
      new Promise<"timeout">((resolve) => { setTimeout(() => resolve("timeout"), 50); }),
    ]);
    const consumedBeforeDurableStreaming = calls.includes("stream-next");
    releaseStreamingMode?.();
    await run;

    expect(observed).toBe("started");
    expect(consumedBeforeDurableStreaming).toBe(false);
    expect(persistence.modes.map((state) => [state.mode, state.reason])).toEqual([
      ["reconciling", "startup"],
      ["streaming", "certified_events"],
      ["reconciling", "stream_catch_up"],
      ["degraded", "stream_unavailable"],
      ["reconciling", "degraded_poll"],
      ["degraded", "stream_unavailable"],
      ["stopped", "finished"],
    ]);
  });

  it("bounds event consumption, closes the iterator, and reports event_limit", async () => {
    let iteratorCleanupCalls = 0;
    const persistence = new InMemoryIngestionPersistence("5");
    const connector = connectorFixture({
      historyPages: [
        { items: [], nextCursor: "5", completeThroughCursor: "5" },
        { items: [], nextCursor: "5", completeThroughCursor: "5" },
      ],
      events: (async function* events() {
        try {
          yield statusEvent("status-1", "running");
          yield statusEvent("status-2", "waiting_input");
          yield statusEvent("status-3", "idle");
        } finally {
          iteratorCleanupCalls += 1;
        }
      })(),
    });

    const result = await runSessionConnectorIngestion({
      connector,
      identity: IDENTITY,
      persistence,
      limits: {
        historyPageSize: 50,
        maxHistoryPagesPerReconciliation: 2,
        maxEvents: 2,
        maxStreamReconnects: 0,
        maxDegradedPolls: 1,
      },
    });

    expect(persistence.statuses.map((status) => status.statusCursor)).toEqual([
      "status-1",
      "status-2",
    ]);
    expect(iteratorCleanupCalls).toBe(1);
    expect(result).toMatchObject({
      mode: "stopped",
      outcome: "event_limit",
      statusCursor: "status-2",
    });
  });

  it("catches up after a stream failure and returns a typed redacted connector error", async () => {
    const calls: string[] = [];
    const persistence = new InMemoryIngestionPersistence("5");
    const connector = connectorFixture({
      calls,
      historyPages: [
        { items: [historyItem("6")], nextCursor: "6", completeThroughCursor: "6" },
        { items: [historyItem("8")], nextCursor: "8", completeThroughCursor: "8" },
      ],
      events: (async function* events() {
        yield transcriptEvent({
          fromCursor: "6",
          nextCursor: "7",
          completeThroughCursor: "7",
          items: [historyItem("7")],
        });
        throw new Error("secret transcript and bearer credential");
      })(),
    });

    const result = await runSessionConnectorIngestion({
      connector,
      identity: IDENTITY,
      persistence,
      limits: {
        historyPageSize: 50,
        maxHistoryPagesPerReconciliation: 2,
        maxEvents: 10,
        maxStreamReconnects: 0,
        maxDegradedPolls: 1,
      },
    });

    expect(calls.slice(0, 3)).toEqual(["history:5", "subscribe", "history:7"]);
    expect(result).toEqual({
      mode: "stopped",
      outcome: "degraded_limit",
      transcriptCursor: "8",
      statusCursor: null,
      error: {
        code: "transport",
        message: "Session connector event stream failed",
        retryable: true,
        safeDetails: { phase: "events" },
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret transcript");
    expect(persistence.modes.at(-1)).toMatchObject({ mode: "stopped" });
  });

  it("waits, reconnects within its bound, and catches up after each stream end", async () => {
    const calls: string[] = [];
    const waits: number[] = [];
    const persistence = new InMemoryIngestionPersistence("5");
    const connector = connectorFixture({
      calls,
      historyPages: [
        { items: [historyItem("6")], nextCursor: "6", completeThroughCursor: "6" },
        { items: [historyItem("8")], nextCursor: "8", completeThroughCursor: "8" },
        { items: [], nextCursor: "9", completeThroughCursor: "9" },
      ],
      eventStreams: [
        (async function* firstStream() {
          yield transcriptEvent({
            fromCursor: "6",
            nextCursor: "7",
            completeThroughCursor: "7",
            items: [historyItem("7")],
          });
        })(),
        (async function* secondStream() {
          yield transcriptEvent({
            fromCursor: "8",
            nextCursor: "9",
            completeThroughCursor: "9",
            items: [historyItem("9")],
          });
        })(),
      ],
    });

    const result = await runSessionConnectorIngestion({
      connector,
      identity: IDENTITY,
      persistence,
      reconnectDelayMs: 25,
      wait: async (delayMs) => { waits.push(delayMs); },
      limits: {
        historyPageSize: 50,
        maxHistoryPagesPerReconciliation: 2,
        maxEvents: 10,
        maxStreamReconnects: 1,
        maxDegradedPolls: 1,
      },
    });

    expect(calls).toEqual([
      "history:5",
      "subscribe",
      "history:7",
      "subscribe",
      "history:9",
      "history:9",
    ]);
    expect(waits).toEqual([25, 1_000]);
    expect(persistence.batches.map((batch) => batch.source)).toEqual([
      "history",
      "event",
      "history",
      "event",
      "history",
      "history",
    ]);
    expect(persistence.modes.filter((state) => state.mode === "streaming")).toHaveLength(2);
    expect(result).toMatchObject({
      outcome: "degraded_limit",
      transcriptCursor: "9",
    });
  });

  it("returns a typed redacted result when durable ingestion persistence rejects", async () => {
    const persistence = new InMemoryIngestionPersistence("5");
    persistence.loadCheckpoint = async () => {
      throw new Error("postgres password and transcript plaintext");
    };
    const connector = connectorFixture({
      historyPages: [{ items: [], nextCursor: "5", completeThroughCursor: "5" }],
    });

    const result = await runSessionConnectorIngestion({
      connector,
      identity: IDENTITY,
      persistence,
      limits: {
        historyPageSize: 50,
        maxHistoryPagesPerReconciliation: 2,
        maxEvents: 10,
        maxStreamReconnects: 0,
        maxDegradedPolls: 1,
      },
    });

    expect(result).toEqual({
      mode: "stopped",
      outcome: "persistence_failure",
      transcriptCursor: null,
      statusCursor: null,
      error: {
        code: "persistence",
        message: "Session connector ingestion persistence failed",
        retryable: true,
      },
    });
    expect(JSON.stringify(result)).not.toContain("postgres password");
  });
});

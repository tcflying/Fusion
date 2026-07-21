import type {
  EventCursor,
  IsoTimestamp,
  SessionConnectorErrorV1,
  SessionConnectorEventV1,
  SessionConnectorHistoryItemV1,
  SessionConnectorIdentityV1,
  SessionConnectorStatusV1,
  SessionConnectorV1,
} from "@fusion/core";

export type SessionConnectorIngestionMode =
  | "streaming"
  | "reconciling"
  | "degraded"
  | "stopped";

export type SessionConnectorIngestionOutcome =
  | "stream_ended"
  | "degraded_limit"
  | "event_limit"
  | "history_limit"
  | "aborted"
  | "connector_failure"
  | "contract_failure"
  | "persistence_failure";

export interface SessionConnectorIngestionCheckpoint {
  readonly transcriptCursor: EventCursor | null;
  readonly statusCursor: EventCursor | null;
}

export interface SessionConnectorTranscriptBatch {
  readonly source: "history" | "event";
  readonly identity: SessionConnectorIdentityV1;
  readonly fromCursor: EventCursor | null;
  readonly nextCursor: EventCursor | null;
  readonly completeThroughCursor: EventCursor | null;
  readonly items: readonly SessionConnectorHistoryItemV1[];
}

export interface SessionConnectorTranscriptPersistResult {
  readonly committedCursor: EventCursor | null;
  readonly insertedCount: number;
  readonly duplicateNativeMessageIdCount: number;
  readonly duplicateContentHashCount: number;
}

export interface SessionConnectorStatusUpdate {
  readonly identity: SessionConnectorIdentityV1;
  readonly status: SessionConnectorStatusV1;
  readonly statusCursor: EventCursor;
  readonly occurredAt: IsoTimestamp;
}

export interface SessionConnectorTranscriptDeltaPayload {
  readonly type: "transcript_delta";
  readonly fromCursor: EventCursor | null;
  readonly nextCursor: EventCursor | null;
  readonly completeThroughCursor: EventCursor | null;
  readonly truncated: boolean;
  readonly items: readonly SessionConnectorHistoryItemV1[];
}

export interface SessionConnectorStatusEventPayload {
  readonly type: "status";
  readonly state: SessionConnectorStatusV1["state"];
  readonly lastActivityAt: string | null;
  readonly connectorCursor: EventCursor | null;
  readonly nativeWriterDetected: boolean;
}

export interface SessionConnectorIngestionPersistencePort {
  loadCheckpoint(input: {
    readonly identity: SessionConnectorIdentityV1;
  }): Promise<SessionConnectorIngestionCheckpoint>;
  persistTranscriptBatch(
    input: SessionConnectorTranscriptBatch,
  ): Promise<SessionConnectorTranscriptPersistResult>;
  persistStatus(input: SessionConnectorStatusUpdate): Promise<void>;
  persistMode(input: SessionConnectorIngestionModeState): Promise<void>;
}

export interface SessionConnectorIngestionLimits {
  readonly historyPageSize: number;
  readonly maxHistoryPagesPerReconciliation: number;
  readonly maxEvents: number;
  readonly maxStreamReconnects: number;
  readonly maxDegradedPolls: number;
}

export interface SessionConnectorIngestionModeState {
  readonly mode: SessionConnectorIngestionMode;
  readonly reason:
    | "startup"
    | "certified_events"
    | "events_not_verified"
    | "stream_unavailable"
    | "degraded_poll"
    | "history_repair"
    | "stream_catch_up"
    | "finished";
  readonly transcriptCursor: EventCursor | null;
  readonly statusCursor: EventCursor | null;
}

export interface SessionConnectorIngestionError {
  readonly code: "invalid_event_payload" | "persistence" | "limit";
  readonly message: string;
  readonly retryable: boolean;
}

export interface SessionConnectorIngestionResult {
  readonly mode: "stopped";
  readonly outcome: SessionConnectorIngestionOutcome;
  readonly transcriptCursor: EventCursor | null;
  readonly statusCursor: EventCursor | null;
  readonly error: SessionConnectorErrorV1 | SessionConnectorIngestionError | null;
}

export interface SessionConnectorIngestionOptions {
  readonly connector: SessionConnectorV1;
  readonly identity: SessionConnectorIdentityV1;
  readonly persistence: SessionConnectorIngestionPersistencePort;
  readonly limits: SessionConnectorIngestionLimits;
  readonly signal?: AbortSignal;
  readonly degradedPollIntervalMs?: number;
  readonly reconnectDelayMs?: number;
  readonly wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  readonly onModeChange?: (state: SessionConnectorIngestionModeState) => void;
}

type HistoryReconciliationResult =
  | {
      readonly ok: true;
      readonly transcriptCursor: EventCursor | null;
      readonly limitReached: boolean;
    }
  | {
      readonly ok: false;
      readonly transcriptCursor: EventCursor | null;
      readonly error: SessionConnectorErrorV1;
    };

class SessionConnectorPersistenceFailure extends Error {
  constructor(
    readonly transcriptCursor: EventCursor | null,
    readonly statusCursor: EventCursor | null,
  ) {
    super("Session connector ingestion persistence failed");
    this.name = "SessionConnectorPersistenceFailure";
  }
}

async function awaitPersistence<T>(
  operation: () => Promise<T>,
  transcriptCursor: EventCursor | null,
  statusCursor: EventCursor | null,
): Promise<T> {
  try {
    return await operation();
  } catch {
    // Persistence errors may contain credentials, SQL text, or transcript data.
    // Only a typed redacted failure crosses the engine boundary.
    throw new SessionConnectorPersistenceFailure(transcriptCursor, statusCursor);
  }
}

function capabilityError(
  state: "degraded" | "unavailable" | "unverified",
  capability: "history" | "events",
): SessionConnectorErrorV1 {
  return {
    code: state,
    message: `${capability} capability is ${state}`,
    retryable: state !== "unavailable",
    safeDetails: { capability, state },
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCursor(value: unknown): value is EventCursor | null {
  return value === null || (typeof value === "string" && value.length > 0);
}

function sameSessionConnectorIdentity(
  left: SessionConnectorIdentityV1,
  right: SessionConnectorIdentityV1,
): boolean {
  return left.connectorId === right.connectorId
    && left.providerId === right.providerId
    && left.nativeSessionId === right.nativeSessionId
    && left.happierSessionId === right.happierSessionId
    && left.serverProfileId === right.serverProfileId
    && left.machineId === right.machineId
    && left.hostId === right.hostId;
}

function isHistoryItem(value: unknown): value is SessionConnectorHistoryItemV1 {
  if (!isRecord(value)) return false;
  return typeof value.nativeMessageId === "string"
    && value.nativeMessageId.length > 0
    && (value.logicalMessageId === null || typeof value.logicalMessageId === "string")
    && ["user", "assistant", "tool", "system", "unknown"].includes(String(value.role))
    && typeof value.contentHash === "string"
    && value.contentHash.length > 0
    && typeof value.occurredAt === "string"
    && typeof value.cursor === "string"
    && value.cursor.length > 0;
}

export function parseSessionConnectorTranscriptDelta(
  payload: Readonly<Record<string, unknown>>,
): SessionConnectorTranscriptDeltaPayload | null {
  if (
    payload.type !== "transcript_delta"
    || !isCursor(payload.fromCursor)
    || !isCursor(payload.nextCursor)
    || !isCursor(payload.completeThroughCursor)
    || typeof payload.truncated !== "boolean"
    || !Array.isArray(payload.items)
    || !payload.items.every(isHistoryItem)
  ) {
    return null;
  }
  return {
    type: "transcript_delta",
    fromCursor: payload.fromCursor,
    nextCursor: payload.nextCursor,
    completeThroughCursor: payload.completeThroughCursor,
    truncated: payload.truncated,
    items: payload.items,
  };
}

const STATUS_STATES = new Set<SessionConnectorStatusV1["state"]>([
  "idle",
  "running",
  "waiting_input",
  "paused",
  "lost",
  "unknown",
]);

export function parseSessionConnectorStatusEvent(
  payload: Readonly<Record<string, unknown>>,
): SessionConnectorStatusEventPayload | null {
  if (
    payload.type !== "status"
    || !STATUS_STATES.has(payload.state as SessionConnectorStatusV1["state"])
    || !isCursor(payload.connectorCursor)
    || typeof payload.nativeWriterDetected !== "boolean"
    || !(
      payload.lastActivityAt === null
      || (
        typeof payload.lastActivityAt === "string"
        && Number.isFinite(Date.parse(payload.lastActivityAt))
      )
    )
  ) {
    return null;
  }
  return {
    type: "status",
    state: payload.state as SessionConnectorStatusV1["state"],
    lastActivityAt: payload.lastActivityAt,
    connectorCursor: payload.connectorCursor,
    nativeWriterDetected: payload.nativeWriterDetected,
  };
}

async function reconcileHistory(
  options: SessionConnectorIngestionOptions,
  initialCursor: EventCursor | null,
): Promise<HistoryReconciliationResult> {
  let transcriptCursor = initialCursor;
  let pagesRead = 0;
  let mayHaveMore = false;
  while (pagesRead < options.limits.maxHistoryPagesPerReconciliation) {
    const fromCursor = transcriptCursor;
    const history = await options.connector.readHistory({
      contractVersion: 1,
      identity: options.identity,
      afterCursor: fromCursor,
      limit: options.limits.historyPageSize,
    });
    if (!history.ok) {
      return { ok: false, transcriptCursor, error: history.error };
    }
    pagesRead += 1;
    const hasMoreSignal = history.value.truncated === true
      || history.value.items.length >= options.limits.historyPageSize;
    const cursorAdvanced = history.value.nextCursor !== null
      && history.value.nextCursor !== fromCursor;
    if (hasMoreSignal && !cursorAdvanced) {
      return { ok: true, transcriptCursor, limitReached: true };
    }
    const persisted = await awaitPersistence(
      () => options.persistence.persistTranscriptBatch({
        source: "history",
        identity: options.identity,
        fromCursor,
        nextCursor: history.value.nextCursor,
        completeThroughCursor: history.value.completeThroughCursor,
        items: history.value.items,
      }),
      transcriptCursor,
      null,
    );
    transcriptCursor = persisted.committedCursor;
    mayHaveMore = hasMoreSignal && cursorAdvanced;
    if (!mayHaveMore) break;
  }
  return { ok: true, transcriptCursor, limitReached: mayHaveMore };
}

async function transitionMode(
  options: SessionConnectorIngestionOptions,
  state: SessionConnectorIngestionModeState,
): Promise<void> {
  await awaitPersistence(
    () => options.persistence.persistMode(state),
    state.transcriptCursor,
    state.statusCursor,
  );
  try {
    options.onModeChange?.(state);
  } catch {
    // Observability consumers cannot alter ingestion correctness.
  }
}

async function defaultWait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(finish, delayMs);
    function finish(): void {
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      resolve();
    }
    function onAbort(): void {
      finish();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function runDegradedHistoryPolling(
  options: SessionConnectorIngestionOptions,
  initialTranscriptCursor: EventCursor | null,
  statusCursor: EventCursor | null,
  reason: "events_not_verified" | "stream_unavailable",
  terminalError: SessionConnectorErrorV1 | null = null,
): Promise<SessionConnectorIngestionResult> {
  const pollIntervalMs = options.degradedPollIntervalMs ?? 1_000;
  if (options.limits.maxDegradedPolls > 0 && pollIntervalMs <= 0) {
    return {
      mode: "stopped",
      outcome: "contract_failure",
      transcriptCursor: initialTranscriptCursor,
      statusCursor,
      error: {
        code: "invalid_event_payload",
        message: "Degraded polling interval must be greater than zero",
        retryable: false,
      },
    };
  }

  let transcriptCursor = initialTranscriptCursor;
  await transitionMode(options, {
    mode: "degraded",
    reason,
    transcriptCursor,
    statusCursor,
  });
  const wait = options.wait ?? defaultWait;
  for (let poll = 0; poll < options.limits.maxDegradedPolls; poll += 1) {
    await wait(pollIntervalMs, options.signal);
    if (options.signal?.aborted) {
      await transitionMode(options, {
        mode: "stopped",
        reason: "finished",
        transcriptCursor,
        statusCursor,
      });
      return {
        mode: "stopped",
        outcome: "aborted",
        transcriptCursor,
        statusCursor,
        error: null,
      };
    }
    await transitionMode(options, {
      mode: "reconciling",
      reason: "degraded_poll",
      transcriptCursor,
      statusCursor,
    });
    const pollResult = await reconcileHistory(options, transcriptCursor);
    if (!pollResult.ok) {
      return {
        mode: "stopped",
        outcome: "connector_failure",
        transcriptCursor: pollResult.transcriptCursor,
        statusCursor,
        error: pollResult.error,
      };
    }
    transcriptCursor = pollResult.transcriptCursor;
    if (pollResult.limitReached) {
      return {
        mode: "stopped",
        outcome: "history_limit",
        transcriptCursor,
        statusCursor,
        error: {
          code: "limit",
          message: "Degraded history polling reached its page limit",
          retryable: true,
        },
      };
    }
    await transitionMode(options, {
      mode: "degraded",
      reason,
      transcriptCursor,
      statusCursor,
    });
  }
  await transitionMode(options, {
    mode: "stopped",
    reason: "finished",
    transcriptCursor,
    statusCursor,
  });
  return {
    mode: "stopped",
    outcome: "degraded_limit",
    transcriptCursor,
    statusCursor,
    error: terminalError,
  };
}

type AbortableIteratorResult =
  | { readonly aborted: true }
  | { readonly aborted: false; readonly result: IteratorResult<SessionConnectorEventV1> };

async function nextConnectorEvent(
  iterator: AsyncIterator<SessionConnectorEventV1>,
  signal?: AbortSignal,
): Promise<AbortableIteratorResult> {
  if (signal?.aborted) {
    return { aborted: true };
  }
  if (!signal) {
    return { aborted: false, result: await iterator.next() };
  }
  return new Promise<AbortableIteratorResult>((resolve, reject) => {
    let settled = false;
    const finish = (result: AbortableIteratorResult): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => {
      if (settled) return;
      finish({ aborted: true });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void iterator.next().then(
      (result) => finish({ aborted: false, result }),
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/*
FNXC:SessionConnectorIngestion 2026-07-17-06:00:
Connector events are never authoritative until persisted history has reconciled
from the last committed cursor. The coordinator carries IDs, hashes, typed state,
and cursors only; transcript plaintext and credentials never enter this module.
*/
export async function runSessionConnectorIngestion(
  options: SessionConnectorIngestionOptions,
): Promise<SessionConnectorIngestionResult> {
  try {
    return await runSessionConnectorIngestionInternal(options);
  } catch (error) {
    if (!(error instanceof SessionConnectorPersistenceFailure)) throw error;
    return {
      mode: "stopped",
      outcome: "persistence_failure",
      transcriptCursor: error.transcriptCursor,
      statusCursor: error.statusCursor,
      error: {
        code: "persistence",
        message: "Session connector ingestion persistence failed",
        retryable: true,
      },
    };
  }
}

async function runSessionConnectorIngestionInternal(
  options: SessionConnectorIngestionOptions,
): Promise<SessionConnectorIngestionResult> {
  const capabilities = await options.connector.getCapabilities(options.identity);
  const historyCapability = capabilities.capabilities.history;
  if (historyCapability.state !== "verified") {
    return {
      mode: "stopped",
      outcome: "connector_failure",
      transcriptCursor: null,
      statusCursor: null,
      error: capabilityError(historyCapability.state, "history"),
    };
  }

  const checkpoint = await awaitPersistence(
    () => options.persistence.loadCheckpoint({ identity: options.identity }),
    null,
    null,
  );
  let statusCursor = checkpoint.statusCursor;
  await transitionMode(options, {
    mode: "reconciling",
    reason: "startup",
    transcriptCursor: checkpoint.transcriptCursor,
    statusCursor: checkpoint.statusCursor,
  });
  const startupReconciliation = await reconcileHistory(options, checkpoint.transcriptCursor);
  if (!startupReconciliation.ok) {
    return {
      mode: "stopped",
      outcome: "connector_failure",
      transcriptCursor: startupReconciliation.transcriptCursor,
      statusCursor: checkpoint.statusCursor,
      error: startupReconciliation.error,
    };
  }
  let transcriptCursor = startupReconciliation.transcriptCursor;
  if (startupReconciliation.limitReached) {
    return {
      mode: "stopped",
      outcome: "history_limit",
      transcriptCursor,
      statusCursor: checkpoint.statusCursor,
      error: {
        code: "limit",
        message: "History reconciliation reached its page limit",
        retryable: true,
      },
    };
  }

  const eventsCapability = capabilities.capabilities.events;
  if (eventsCapability.state !== "verified") {
    return runDegradedHistoryPolling(
      options,
      transcriptCursor,
      checkpoint.statusCursor,
      "events_not_verified",
    );
  }

  const reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
  if (options.limits.maxStreamReconnects > 0 && reconnectDelayMs <= 0) {
    await transitionMode(options, {
      mode: "stopped",
      reason: "finished",
      transcriptCursor,
      statusCursor,
    });
    return {
      mode: "stopped",
      outcome: "contract_failure",
      transcriptCursor,
      statusCursor,
      error: {
        code: "invalid_event_payload",
        message: "Stream reconnect delay must be greater than zero",
        retryable: false,
      },
    };
  }
  const initialSubscription = await options.connector.subscribeEvents(options.identity);
  if (!initialSubscription.ok) {
    return runDegradedHistoryPolling(
      options,
      transcriptCursor,
      checkpoint.statusCursor,
      "stream_unavailable",
      initialSubscription.error,
    );
  }
  const reconnectWait = options.wait ?? defaultWait;
  let eventStream = initialSubscription.value;
  let eventsProcessed = 0;
  let reconnectsUsed = 0;
  while (true) {
    const eventIterator = eventStream[Symbol.asyncIterator]();
    let terminalStreamError: SessionConnectorErrorV1 | null = null;
    try {
      await transitionMode(options, {
        mode: "streaming",
        reason: "certified_events",
        transcriptCursor,
        statusCursor,
      });
      while (true) {
    if (eventsProcessed >= options.limits.maxEvents) {
      await transitionMode(options, {
        mode: "reconciling",
        reason: "stream_catch_up",
        transcriptCursor,
        statusCursor,
      });
      const limitCatchUp = await reconcileHistory(options, transcriptCursor);
      if (!limitCatchUp.ok) {
        return {
          mode: "stopped",
          outcome: "connector_failure",
          transcriptCursor: limitCatchUp.transcriptCursor,
          statusCursor,
          error: limitCatchUp.error,
        };
      }
      transcriptCursor = limitCatchUp.transcriptCursor;
      if (limitCatchUp.limitReached) {
        return {
          mode: "stopped",
          outcome: "history_limit",
          transcriptCursor,
          statusCursor,
          error: {
            code: "limit",
            message: "Event-limit catch-up reached its page limit",
            retryable: true,
          },
        };
      }
      await transitionMode(options, {
        mode: "stopped",
        reason: "finished",
        transcriptCursor,
        statusCursor,
      });
      return {
        mode: "stopped",
        outcome: "event_limit",
        transcriptCursor,
        statusCursor,
        error: {
          code: "limit",
          message: "Session connector event limit reached",
          retryable: true,
        },
      };
    }
    let nextEvent: AbortableIteratorResult;
    try {
      nextEvent = await nextConnectorEvent(eventIterator, options.signal);
    } catch {
      terminalStreamError = {
        code: "transport",
        message: "Session connector event stream failed",
        retryable: true,
        safeDetails: { phase: "events" },
      };
      break;
    }
    if (nextEvent.aborted) {
      await transitionMode(options, {
        mode: "stopped",
        reason: "finished",
        transcriptCursor,
        statusCursor,
      });
      return {
        mode: "stopped",
        outcome: "aborted",
        transcriptCursor,
        statusCursor,
        error: null,
      };
    }
    if (nextEvent.result.done) break;
    const event = nextEvent.result.value;
    if (!sameSessionConnectorIdentity(event.identity, options.identity)) {
      return {
        mode: "stopped",
        outcome: "contract_failure",
        transcriptCursor,
        statusCursor,
        error: {
          code: "invalid_event_payload",
          message: "Session connector event identity does not match the immutable binding",
          retryable: false,
        },
      };
    }
    eventsProcessed += 1;
    if (event.eventType === "status") {
      const statusPayload = parseSessionConnectorStatusEvent(event.payload);
      if (!statusPayload) {
        return {
          mode: "stopped",
          outcome: "contract_failure",
          transcriptCursor,
          statusCursor,
          error: {
            code: "invalid_event_payload",
            message: "Session connector status event payload is invalid",
            retryable: false,
          },
        };
      }
      await awaitPersistence(
        () => options.persistence.persistStatus({
          identity: event.identity,
          statusCursor: event.cursor,
          occurredAt: event.occurredAt,
          status: {
            identity: event.identity,
            state: statusPayload.state,
            lastActivityAt: statusPayload.lastActivityAt,
            connectorCursor: statusPayload.connectorCursor,
            nativeWriterDetected: statusPayload.nativeWriterDetected,
          },
        }),
        transcriptCursor,
        statusCursor,
      );
      statusCursor = event.cursor;
      continue;
    }
    if (event.eventType !== "message") continue;
    const delta = parseSessionConnectorTranscriptDelta(event.payload);
    if (!delta) {
      return {
        mode: "stopped",
        outcome: "contract_failure",
        transcriptCursor,
        statusCursor,
        error: {
          code: "invalid_event_payload",
          message: "Session connector message event payload is invalid",
          retryable: false,
        },
      };
    }
    if (
      delta.fromCursor !== transcriptCursor
      || delta.truncated
      || delta.completeThroughCursor === null
    ) {
      const repair = await reconcileHistory(options, transcriptCursor);
      if (!repair.ok) {
        return {
          mode: "stopped",
          outcome: "connector_failure",
          transcriptCursor: repair.transcriptCursor,
          statusCursor,
          error: repair.error,
        };
      }
      transcriptCursor = repair.transcriptCursor;
      if (repair.limitReached) {
        return {
          mode: "stopped",
          outcome: "history_limit",
          transcriptCursor,
          statusCursor,
          error: {
            code: "limit",
            message: "History repair reached its page limit",
            retryable: true,
          },
        };
      }
      continue;
    }
    const persisted = await awaitPersistence(
      () => options.persistence.persistTranscriptBatch({
        source: "event",
        identity: event.identity,
        fromCursor: delta.fromCursor,
        nextCursor: delta.nextCursor,
        completeThroughCursor: delta.completeThroughCursor,
        items: delta.items,
      }),
      transcriptCursor,
      statusCursor,
    );
    transcriptCursor = persisted.committedCursor;
      }
    } finally {
      await Promise.resolve(eventIterator.return?.()).catch(() => undefined);
    }
    await transitionMode(options, {
      mode: "reconciling",
      reason: "stream_catch_up",
      transcriptCursor,
      statusCursor,
    });
    const endCatchUp = await reconcileHistory(options, transcriptCursor);
    if (!endCatchUp.ok) {
      return {
        mode: "stopped",
        outcome: "connector_failure",
        transcriptCursor: endCatchUp.transcriptCursor,
        statusCursor,
        error: endCatchUp.error,
      };
    }
    transcriptCursor = endCatchUp.transcriptCursor;
    if (endCatchUp.limitReached) {
      return {
        mode: "stopped",
        outcome: "history_limit",
        transcriptCursor,
        statusCursor,
        error: {
          code: "limit",
          message: "Stream-end catch-up reached its page limit",
          retryable: true,
        },
      };
    }
    if (reconnectsUsed < options.limits.maxStreamReconnects) {
      reconnectsUsed += 1;
      await reconnectWait(reconnectDelayMs, options.signal);
      if (options.signal?.aborted) {
        await transitionMode(options, {
          mode: "stopped",
          reason: "finished",
          transcriptCursor,
          statusCursor,
        });
        return {
          mode: "stopped",
          outcome: "aborted",
          transcriptCursor,
          statusCursor,
          error: null,
        };
      }
      const reconnect = await options.connector.subscribeEvents(options.identity);
      if (!reconnect.ok) {
        return runDegradedHistoryPolling(
          options,
          transcriptCursor,
          statusCursor,
          "stream_unavailable",
          reconnect.error,
        );
      }
      eventStream = reconnect.value;
      continue;
    }
    return runDegradedHistoryPolling(
      options,
      transcriptCursor,
      statusCursor,
      "stream_unavailable",
      terminalStreamError,
    );
  }
}

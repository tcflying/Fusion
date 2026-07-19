import { appendTokenQuery } from "../auth";

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export interface RoomCockpitLiveEventScopeV1 {
  readonly projectId: string;
  readonly roomId: string;
}

export interface RoomCockpitLiveEventV1 {
  readonly scope: RoomCockpitLiveEventScopeV1;
  readonly cursor: string;
  readonly reconciliationRequired: boolean;
}

export type RoomCockpitLiveConnectionStateV1 = "connected" | "degraded" | "disconnected" | "unknown";

export interface RoomCockpitLiveAlertV1 {
  readonly code: string;
  readonly severity: "warning" | "critical";
  readonly scope: RoomCockpitLiveEventScopeV1;
  readonly cursor: string | null;
  readonly expectedStreamSequence: number | null;
  readonly observedStreamSequence: number | null;
}

export interface RoomCockpitLiveConnectionEventV1 {
  readonly scope: RoomCockpitLiveEventScopeV1;
  readonly cursor: string | null;
  readonly connection: Readonly<{
    readonly state: RoomCockpitLiveConnectionStateV1;
    readonly reason: string | null;
    readonly changedAt: string | null;
  }>;
  readonly alerts: readonly RoomCockpitLiveAlertV1[];
}

export interface RoomCockpitLiveAlertEventV1 {
  readonly scope: RoomCockpitLiveEventScopeV1;
  readonly alerts: readonly RoomCockpitLiveAlertV1[];
}

interface RoomCockpitReplayContinuationV1 {
  readonly scope: RoomCockpitLiveEventScopeV1;
  readonly cursor: string;
}

export interface RoomCockpitEventSourceV1 {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}

export type RoomCockpitEventSourceFactory = (url: string) => RoomCockpitEventSourceV1;

export interface RoomCockpitLiveEventConnectionV1 {
  close(): void;
}

export interface ConnectRoomCockpitLiveEventsOptionsV1 {
  readonly scope: RoomCockpitLiveEventScopeV1;
  readonly eventSourceFactory: RoomCockpitEventSourceFactory;
  readonly initialCursor?: string | null;
  readonly onOpen?: (input: { readonly reconnected: boolean; readonly cursor: string | null }) => void;
  readonly onReconnecting?: (input: {
    readonly attempt: number;
    readonly cursor: string | null;
    readonly reason: "transport_error" | "event_source_error";
  }) => void;
  readonly onConnection?: (event: RoomCockpitLiveConnectionEventV1) => void;
  readonly onAlert?: (event: RoomCockpitLiveAlertEventV1) => void;
  readonly onEvent: (event: RoomCockpitLiveEventV1) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCursor(value: unknown, allowZero = false): string | null {
  if (
    typeof value !== "string"
    || !(allowZero ? /^(?:0|[1-9][0-9]*)$/u : /^[1-9][0-9]*$/u).test(value)
  ) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? value : null;
}

function parseScope(value: unknown): RoomCockpitLiveEventScopeV1 | null {
  if (!isRecord(value) || typeof value.projectId !== "string" || typeof value.roomId !== "string") return null;
  if (
    !value.projectId.trim()
    || !value.roomId.trim()
    || value.projectId !== value.projectId.trim()
    || value.roomId !== value.roomId.trim()
  ) return null;
  return { projectId: value.projectId, roomId: value.roomId };
}

function sameScope(left: RoomCockpitLiveEventScopeV1, right: RoomCockpitLiveEventScopeV1): boolean {
  return left.projectId === right.projectId && left.roomId === right.roomId;
}

function parseNullableCursor(value: unknown): string | null | undefined {
  if (value === null) return null;
  return parseCursor(value, true) ?? undefined;
}

function parseOptionalCanonicalText(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 256) return undefined;
  return value;
}

function isPositiveSafeIntegerOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 1);
}

function isIsoTimestampOrNull(value: unknown): value is string | null {
  return value === null || (
    typeof value === "string"
    && value.trim() === value
    && value.length <= 64
    && Number.isFinite(Date.parse(value))
  );
}

function parseLiveAlert(value: unknown): RoomCockpitLiveAlertV1 | null {
  if (!isRecord(value)
    || typeof value.code !== "string"
    || !value.code.trim()
    || value.code !== value.code.trim()
    || value.code.length > 256
    || (value.severity !== "warning" && value.severity !== "critical")) {
    return null;
  }
  const scope = parseScope(value.scope);
  const cursor = parseNullableCursor(value.cursor);
  if (!scope
    || cursor === undefined
    || !isPositiveSafeIntegerOrNull(value.expectedStreamSequence)
    || !isPositiveSafeIntegerOrNull(value.observedStreamSequence)) {
    return null;
  }
  return {
    code: value.code,
    severity: value.severity,
    scope,
    cursor,
    expectedStreamSequence: value.expectedStreamSequence,
    observedStreamSequence: value.observedStreamSequence,
  };
}

function parseScopedAlerts(
  value: unknown,
  scope: RoomCockpitLiveEventScopeV1,
  requireAlert: boolean,
): readonly RoomCockpitLiveAlertV1[] | null {
  if (!Array.isArray(value) || (requireAlert && value.length === 0)) return null;
  const alerts: RoomCockpitLiveAlertV1[] = [];
  for (const rawAlert of value) {
    const alert = parseLiveAlert(rawAlert);
    if (!alert || !sameScope(alert.scope, scope)) return null;
    alerts.push(alert);
  }
  return alerts;
}

function parseLiveConnection(value: unknown): RoomCockpitLiveConnectionEventV1["connection"] | null {
  const reason = isRecord(value) ? parseOptionalCanonicalText(value.reason) : undefined;
  if (!isRecord(value)
    || (value.state !== "connected"
      && value.state !== "degraded"
      && value.state !== "disconnected"
      && value.state !== "unknown")
    || reason === undefined
    || !isIsoTimestampOrNull(value.changedAt)) {
    return null;
  }
  return {
    state: value.state,
    reason,
    changedAt: value.changedAt,
  };
}

/**
 * FNXC:RoomCockpitLiveHealth 2026-07-19-19:36:
 * EventSource opening proves only transport availability. Named Room health
 * frames are authoritative only after their versioned scope and cursor fields
 * validate, so a malformed or cross-Room frame cannot change Cockpit state.
 * The replay boundary uses canonical cursor `0`; only committed room events
 * require a strictly positive cursor. Regular server connection frames omit
 * `reason`; only terminal health receipts may include it.
 */
function parseConnectionEvent(value: unknown): RoomCockpitLiveConnectionEventV1 | null {
  if (!isRecord(value) || value.contractVersion !== 1 || value.type !== "room_connection") return null;
  const scope = parseScope(value.scope);
  const cursor = parseNullableCursor(value.cursor);
  const connection = parseLiveConnection(value.connection);
  if (!scope || cursor === undefined || !connection) return null;
  const alerts = parseScopedAlerts(value.alerts, scope, false);
  if (!alerts) return null;
  return { scope, cursor, connection, alerts };
}

function parseAlertEvent(value: unknown): RoomCockpitLiveAlertEventV1 | null {
  if (!isRecord(value) || value.contractVersion !== 1 || value.type !== "room_alert") return null;
  const scope = parseScope(value.scope);
  if (!scope) return null;
  const alerts = parseScopedAlerts(value.alerts, scope, true);
  return alerts ? { scope, alerts } : null;
}

function isReconciliationRequired(payload: Record<string, unknown>): boolean {
  if (isRecord(payload.connection) && payload.connection.state !== "connected") return true;
  if (!Array.isArray(payload.alerts)) return false;
  return payload.alerts.some((alert) => isRecord(alert)
    && typeof alert.code === "string"
    && [
      "canonical_replay_failed",
      "canonical_replay_invalid",
      "replay_cursor_ahead",
      "replay_window_overflow",
      "source_sequence_gap",
      "stream_disconnected",
    ].includes(alert.code));
}

export function parseRoomCockpitLiveEvent(value: unknown): RoomCockpitLiveEventV1 | null {
  if (!isRecord(value)) return null;
  if (
    value.type !== undefined
    && value.type !== "canonical_room_event"
    && value.type !== "room_event"
  ) return null;

  const scope = parseScope(value.scope);
  const envelope = isRecord(value.envelope) ? value.envelope : value;
  const cursor = parseCursor(envelope.cursor);
  if (!scope || !cursor) return null;

  return {
    scope,
    cursor,
    reconciliationRequired: isReconciliationRequired(value),
  };
}

function parseMessagePayload<T>(event: MessageEvent, parse: (value: unknown) => T | null): T | null {
  if (typeof event.data !== "string") return null;
  try {
    return parse(JSON.parse(event.data));
  } catch {
    return null;
  }
}

function parseMessageEvent(event: MessageEvent): RoomCockpitLiveEventV1 | null {
  return parseMessagePayload(event, parseRoomCockpitLiveEvent);
}

function parseConnectionMessageEvent(event: MessageEvent): RoomCockpitLiveConnectionEventV1 | null {
  return parseMessagePayload(event, parseConnectionEvent);
}

function parseAlertMessageEvent(event: MessageEvent): RoomCockpitLiveAlertEventV1 | null {
  return parseMessagePayload(event, parseAlertEvent);
}

function parseReplayContinuationEvent(event: MessageEvent): RoomCockpitReplayContinuationV1 | null {
  if (typeof event.data !== "string") return null;
  try {
    const payload: unknown = JSON.parse(event.data);
    if (!isRecord(payload) || payload.contractVersion !== 1 || payload.type !== "room_replay_continue") return null;
    const scope = parseScope(payload.scope);
    const cursor = parseCursor(payload.cursor, true);
    return scope && cursor ? { scope, cursor } : null;
  } catch {
    return null;
  }
}

function cursorIsAfter(candidate: string, current: string | null): boolean {
  if (current === null) return true;
  return Number(candidate) > Number(current);
}

function appendCursor(url: string, cursor: string | null): string {
  if (cursor === null) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}cursor=${encodeURIComponent(cursor)}`;
}

export function createRoomCockpitLiveEventsUrl(scope: RoomCockpitLiveEventScopeV1, cursor: string | null = null): string {
  const query = new URLSearchParams({ projectId: scope.projectId });
  return appendCursor(`/api/rooms/${encodeURIComponent(scope.roomId)}/events?${query.toString()}`, cursor);
}

export function getRoomCockpitBrowserEventSourceFactory(): RoomCockpitEventSourceFactory | null {
  const BrowserEventSource = globalThis.EventSource;
  if (typeof BrowserEventSource !== "function") return null;
  return (url) => new BrowserEventSource(appendTokenQuery(url)) as unknown as RoomCockpitEventSourceV1;
}

function reconnectDelay(attempt: number): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 5);
  return Math.min(INITIAL_RECONNECT_DELAY_MS * (2 ** exponent), MAX_RECONNECT_DELAY_MS);
}

export function connectRoomCockpitLiveEvents(options: ConnectRoomCockpitLiveEventsOptionsV1): RoomCockpitLiveEventConnectionV1 {
  let disposed = false;
  let eventSource: RoomCockpitEventSourceV1 | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let lastCursor = parseCursor(options.initialCursor, true) ?? null;

  const scheduleReconnect = (reason: "transport_error" | "event_source_error"): void => {
    if (disposed || reconnectTimer !== null) return;
    reconnectAttempts += 1;
    options.onReconnecting?.({ attempt: reconnectAttempts, cursor: lastCursor, reason });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay(reconnectAttempts));
  };

  const consume = (rawEvent: Event): void => {
    if (disposed) return;
    const event = parseMessageEvent(rawEvent as MessageEvent);
    if (!event
      || event.scope.projectId !== options.scope.projectId
      || event.scope.roomId !== options.scope.roomId
      || !cursorIsAfter(event.cursor, lastCursor)) {
      return;
    }
    lastCursor = event.cursor;
    options.onEvent(event);
  };

  const connect = (): void => {
    if (disposed) return;
    const url = createRoomCockpitLiveEventsUrl(options.scope, lastCursor);
    let source: RoomCockpitEventSourceV1;
    try {
      source = options.eventSourceFactory(url);
    } catch {
      scheduleReconnect("event_source_error");
      return;
    }
    eventSource = source;
    source.onopen = () => {
      if (disposed || eventSource !== source) return;
      const reconnected = reconnectAttempts > 0;
      reconnectAttempts = 0;
      options.onOpen?.({ reconnected, cursor: lastCursor });
    };
    source.onerror = () => {
      if (disposed || eventSource !== source) return;
      eventSource = null;
      try {
        source.close();
      } catch {
        // The browser may already have closed this source after its transport error.
      }
      scheduleReconnect("transport_error");
    };
    source.onmessage = consume;
    source.addEventListener("room.event", consume);
    source.addEventListener("canonical_room_event", consume);
    source.addEventListener("room.connection", (rawEvent) => {
      if (disposed || eventSource !== source) return;
      const event = parseConnectionMessageEvent(rawEvent as MessageEvent);
      if (!event || !sameScope(event.scope, options.scope)) return;
      options.onConnection?.(event);
    });
    source.addEventListener("room.alert", (rawEvent) => {
      if (disposed || eventSource !== source) return;
      const event = parseAlertMessageEvent(rawEvent as MessageEvent);
      if (!event || !sameScope(event.scope, options.scope)) return;
      options.onAlert?.(event);
    });
    source.addEventListener("room.replay.continue", (rawEvent) => {
      if (disposed || eventSource !== source) return;
      const continuation = parseReplayContinuationEvent(rawEvent as MessageEvent);
      if (!continuation
        || continuation.scope.projectId !== options.scope.projectId
        || continuation.scope.roomId !== options.scope.roomId
        || continuation.cursor !== lastCursor) {
        return;
      }

      /*
      FNXC:RoomCockpitReplay 2026-07-19-18:22:
      A bounded canonical replay ends deliberately. Only an exact continuation
      cursor for this Room may replace the source; clearing its identity before
      close keeps the intentional boundary out of transport-error recovery.
      */
      eventSource = null;
      try {
        source.close();
      } catch {
        // Replacing a bounded replay source is best-effort after its terminal frame.
      }
      connect();
    });
  };

  connect();

  const close = (): void => {
    if (disposed) return;
    disposed = true;
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", close);
    }
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    try {
      eventSource?.close();
    } catch {
      // Page teardown must still clear the local reference when browser close throws.
    }
    eventSource = null;
  };

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", close);
  }

  return { close };
}

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
  readonly onEvent: (event: RoomCockpitLiveEventV1) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCursor(value: unknown): string | null {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? value : null;
}

function parseScope(value: unknown): RoomCockpitLiveEventScopeV1 | null {
  if (!isRecord(value) || typeof value.projectId !== "string" || typeof value.roomId !== "string") return null;
  if (!value.projectId.trim() || !value.roomId.trim()) return null;
  return { projectId: value.projectId, roomId: value.roomId };
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

function parseMessageEvent(event: MessageEvent): RoomCockpitLiveEventV1 | null {
  if (typeof event.data !== "string") return null;
  try {
    return parseRoomCockpitLiveEvent(JSON.parse(event.data));
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
  let lastCursor = parseCursor(options.initialCursor) ?? null;

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
      } catch {}
      scheduleReconnect("transport_error");
    };
    source.onmessage = consume;
    source.addEventListener("room.event", consume);
    source.addEventListener("canonical_room_event", consume);
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
    } catch {}
    eventSource = null;
  };

  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", close);
  }

  return { close };
}

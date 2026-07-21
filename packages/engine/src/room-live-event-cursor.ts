import type { RoomEventRecordV1 } from "@fusion/core";

export const ROOM_LIVE_EVENT_CURSOR_CONTRACT_VERSION = 1 as const;

const MAX_ALERTS_PER_SCOPE = 32;

export interface RoomLiveEventScopeV1 {
  readonly projectId: string;
  readonly roomId: string;
}

export interface RoomLiveEventEnvelopeV1 {
  readonly contractVersion: typeof ROOM_LIVE_EVENT_CURSOR_CONTRACT_VERSION;
  readonly scope: RoomLiveEventScopeV1;
  readonly cursor: string;
  readonly sequence: number;
  readonly streamSequence: number | null;
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateVersion: number;
  readonly occurredAt: string;
  readonly actor: Readonly<{
    readonly type: RoomEventRecordV1["actorType"];
    readonly id: string;
  }>;
  readonly event: RoomEventRecordV1;
}

export type RoomLiveEventAlertCodeV1 =
  | "canonical_replay_failed"
  | "canonical_replay_invalid"
  | "replay_cursor_ahead"
  | "replay_window_overflow"
  | "source_sequence_gap"
  | "stream_disconnected";

export interface RoomLiveEventAlertV1 {
  readonly code: RoomLiveEventAlertCodeV1;
  readonly severity: "warning" | "critical";
  readonly message: string;
  readonly scope: RoomLiveEventScopeV1;
  readonly cursor: string | null;
  readonly expectedStreamSequence: number | null;
  readonly observedStreamSequence: number | null;
}

export interface RoomLiveEventConnectionV1 {
  readonly state: "connected" | "degraded" | "disconnected" | "unknown";
  readonly reason: string | null;
  readonly changedAt: string | null;
}

export interface RoomLiveEventPublishInputV1 {
  readonly contractVersion: typeof ROOM_LIVE_EVENT_CURSOR_CONTRACT_VERSION;
  readonly source: "canonical_room_event";
  readonly scope: RoomLiveEventScopeV1;
  readonly event: RoomEventRecordV1;
  readonly streamSequence: number | null;
}

export interface RoomLiveEventDisconnectInputV1 {
  readonly contractVersion: typeof ROOM_LIVE_EVENT_CURSOR_CONTRACT_VERSION;
  readonly source: "canonical_event_source";
  readonly authorizedProjectId: string;
  readonly scope: RoomLiveEventScopeV1;
  readonly occurredAt: string;
  readonly reason: string;
}

export interface RoomLiveEventReconnectInputV1 {
  readonly contractVersion: typeof ROOM_LIVE_EVENT_CURSOR_CONTRACT_VERSION;
  readonly authorizedProjectId: string;
  readonly scope: RoomLiveEventScopeV1;
  readonly afterCursor: string | null;
  readonly limit?: number;
}

export interface RoomLiveEventCanonicalReplayPortInputV1 {
  readonly contractVersion: typeof ROOM_LIVE_EVENT_CURSOR_CONTRACT_VERSION;
  readonly scope: RoomLiveEventScopeV1;
  readonly afterCursor: string | null;
  readonly limit: number;
}

/*
FNXC:RoomLiveEventReplayContract 2026-07-19-21:31:
Canonical Room replay is an explicit bounded page. `hasMore` comes from the
authoritative store and must not be guessed from an event count, otherwise an
SSE reconnect can silently stop before its durable replay is complete.
*/
export interface RoomLiveEventCanonicalReplayPageV1 {
  readonly events: readonly RoomEventRecordV1[];
  readonly hasMore: boolean;
}

export interface RoomLiveEventCanonicalReplayPortV1 {
  listEventPage(input: RoomLiveEventCanonicalReplayPortInputV1): Promise<RoomLiveEventCanonicalReplayPageV1>;
}

export interface RoomLiveEventCursorCoordinatorOptionsV1 {
  readonly canonicalReplayPort?: RoomLiveEventCanonicalReplayPortV1;
  readonly maxBufferedEvents?: number;
  readonly maxReplayEvents?: number;
}

export type RoomLiveEventRejectionCodeV1 =
  | "canonical_replay_invalid"
  | "cross_project_forbidden"
  | "cursor_conflict"
  | "event_scope_mismatch"
  | "invalid_input"
  | "source_sequence_gap"
  | "stale_cursor"
  | "untrusted_source";

export interface RoomLiveEventRejectionV1 {
  readonly code: RoomLiveEventRejectionCodeV1;
  readonly message: string;
}

export type RoomLiveEventPublishResultV1 =
  | Readonly<{
    readonly ok: true;
    readonly outcome: "published" | "duplicate";
    readonly event: RoomLiveEventEnvelopeV1;
    readonly connection: RoomLiveEventConnectionV1;
    readonly alerts: readonly RoomLiveEventAlertV1[];
  }>
  | Readonly<{
    readonly ok: false;
    readonly outcome: "rejected";
    readonly reason: RoomLiveEventRejectionV1;
    readonly alerts: readonly RoomLiveEventAlertV1[];
  }>;

export type RoomLiveEventDisconnectResultV1 =
  | Readonly<{
    readonly ok: true;
    readonly outcome: "disconnected";
    readonly scope: RoomLiveEventScopeV1;
    readonly connection: RoomLiveEventConnectionV1;
    readonly alerts: readonly RoomLiveEventAlertV1[];
  }>
  | Readonly<{
    readonly ok: false;
    readonly outcome: "rejected";
    readonly reason: RoomLiveEventRejectionV1;
    readonly alerts: readonly RoomLiveEventAlertV1[];
  }>;

export type RoomLiveEventReconnectResultV1 =
  | Readonly<{
    readonly ok: true;
    readonly outcome: "replayed" | "up_to_date" | "reconciliation_required";
    readonly scope: RoomLiveEventScopeV1;
    readonly replaySource: "memory" | "canonical_port" | null;
    readonly events: readonly RoomLiveEventEnvelopeV1[];
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
    readonly connection: RoomLiveEventConnectionV1;
    readonly alerts: readonly RoomLiveEventAlertV1[];
  }>
  | Readonly<{
    readonly ok: false;
    readonly outcome: "rejected";
    readonly reason: RoomLiveEventRejectionV1;
    readonly alerts: readonly RoomLiveEventAlertV1[];
  }>;

interface NormalizedPublishInput {
  readonly scope: RoomLiveEventScopeV1;
  readonly event: RoomEventRecordV1;
  readonly cursorNumber: number;
  readonly streamSequence: number | null;
  readonly fingerprint: string;
}

interface NormalizedDisconnectInput {
  readonly scope: RoomLiveEventScopeV1;
  readonly occurredAt: string;
  readonly reason: string;
}

interface NormalizedReconnectInput {
  readonly scope: RoomLiveEventScopeV1;
  readonly afterCursor: string | null;
  readonly afterCursorNumber: number | null;
  readonly limit: number;
}

interface PendingSourceSequenceGap {
  readonly expectedStreamSequence: number;
  readonly observedStreamSequence: number;
  readonly observedCursor: string;
}

interface ScopeState {
  readonly events: RoomLiveEventEnvelopeV1[];
  readonly byEventId: Map<string, RoomLiveEventEnvelopeV1>;
  readonly fingerprintsByEventId: Map<string, string>;
  readonly byCursor: Map<string, RoomLiveEventEnvelopeV1>;
  readonly alerts: RoomLiveEventAlertV1[];
  latestCursor: number | null;
  latestCursorText: string | null;
  droppedThroughCursor: number | null;
  lastStreamSequence: number | null;
  pendingGap: PendingSourceSequenceGap | null;
  connection: RoomLiveEventConnectionV1;
}

class LiveEventValidationError extends Error {
  constructor(
    readonly code: RoomLiveEventRejectionCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "LiveEventValidationError";
  }
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}

function cloneScope(scope: RoomLiveEventScopeV1): RoomLiveEventScopeV1 {
  return freeze({ projectId: scope.projectId, roomId: scope.roomId });
}

function cloneEvent(event: RoomEventRecordV1): RoomEventRecordV1 {
  return freeze({
    ...event,
    payload: freeze(structuredClone(event.payload)),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireCanonicalText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new LiveEventValidationError("invalid_input", `${label} must be a non-empty canonical string`);
  }
  return value;
}

function parseCursor(value: unknown, label: string, allowZero: boolean): number {
  const cursor = requireCanonicalText(value, label);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(cursor)) {
    throw new LiveEventValidationError("invalid_input", `${label} must be a base-10 integer cursor`);
  }
  const number = Number(cursor);
  if (!Number.isSafeInteger(number) || number < 0 || (!allowZero && number === 0)) {
    throw new LiveEventValidationError("invalid_input", `${label} must be a safe positive cursor`);
  }
  return number;
}

function parseStreamSequence(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new LiveEventValidationError("invalid_input", "streamSequence must be null or a safe positive integer");
  }
  return value as number;
}

function normalizeScope(value: unknown, label: string): RoomLiveEventScopeV1 {
  if (!isRecord(value)) {
    throw new LiveEventValidationError("invalid_input", `${label} must be an inspectable scope object`);
  }
  return cloneScope({
    projectId: requireCanonicalText(value.projectId, `${label}.projectId`),
    roomId: requireCanonicalText(value.roomId, `${label}.roomId`),
  });
}

function scopeKey(scope: RoomLiveEventScopeV1): string {
  return `${scope.projectId}\u0000${scope.roomId}`;
}

function cloneConnection(connection: RoomLiveEventConnectionV1): RoomLiveEventConnectionV1 {
  return freeze({ ...connection });
}

function cloneAlert(alert: RoomLiveEventAlertV1): RoomLiveEventAlertV1 {
  return freeze({
    ...alert,
    scope: cloneScope(alert.scope),
  });
}

function alertSnapshot(state: ScopeState): readonly RoomLiveEventAlertV1[] {
  return freeze(state.alerts.map(cloneAlert));
}

function eventFingerprint(event: RoomEventRecordV1): string {
  try {
    return JSON.stringify([
      event.contractVersion,
      event.id,
      event.projectId,
      event.roomId,
      event.aggregateVersion,
      event.eventType,
      event.actorType,
      event.actorId,
      event.correlationId,
      event.causationId,
      event.payload,
      event.occurredAt,
      event.cursor,
    ]);
  } catch {
    throw new LiveEventValidationError("invalid_input", "canonical Room event must be serializable for duplicate protection");
  }
}

function toEnvelope(
  scope: RoomLiveEventScopeV1,
  event: RoomEventRecordV1,
  cursorNumber: number,
  streamSequence: number | null,
): RoomLiveEventEnvelopeV1 {
  return freeze({
    contractVersion: ROOM_LIVE_EVENT_CURSOR_CONTRACT_VERSION,
    scope: cloneScope(scope),
    cursor: event.cursor,
    sequence: cursorNumber,
    streamSequence,
    eventId: event.id,
    eventType: event.eventType,
    aggregateVersion: event.aggregateVersion,
    occurredAt: event.occurredAt,
    actor: freeze({ type: event.actorType, id: event.actorId }),
    event: cloneEvent(event),
  });
}

function createState(): ScopeState {
  return {
    events: [],
    byEventId: new Map(),
    fingerprintsByEventId: new Map(),
    byCursor: new Map(),
    alerts: [],
    latestCursor: null,
    latestCursorText: null,
    droppedThroughCursor: null,
    lastStreamSequence: null,
    pendingGap: null,
    connection: freeze({ state: "unknown", reason: null, changedAt: null }),
  };
}

/**
 * FNXC:RoomLiveEvents 2026-07-19-15:18:
 * The Room cockpit needs a project-and-Room-scoped, reconnectable event surface,
 * but process-local notifications are only latency hints. This coordinator accepts
 * only committed canonical Room events, never turns worker self-reports into
 * authority, bounds retained replay, and makes stream gaps or cache overflow
 * explicit so an SSE/dashboard route can request durable canonical replay.
 */
export class RoomLiveEventCursorCoordinator {
  private readonly canonicalReplayPort: RoomLiveEventCanonicalReplayPortV1 | null;
  private readonly maxBufferedEvents: number;
  private readonly maxReplayEvents: number;
  private readonly states = new Map<string, ScopeState>();

  constructor(options: RoomLiveEventCursorCoordinatorOptionsV1 = {}) {
    this.maxBufferedEvents = normalizePositiveLimit(options.maxBufferedEvents, 256, "maxBufferedEvents");
    this.maxReplayEvents = normalizePositiveLimit(options.maxReplayEvents, 128, "maxReplayEvents");
    if (this.maxReplayEvents > this.maxBufferedEvents) {
      throw new Error("maxReplayEvents cannot exceed maxBufferedEvents");
    }
    if (
      options.canonicalReplayPort !== undefined
      && (options.canonicalReplayPort === null || typeof options.canonicalReplayPort.listEventPage !== "function")
    ) {
      throw new Error("canonicalReplayPort must implement listEventPage");
    }
    this.canonicalReplayPort = options.canonicalReplayPort ?? null;
  }

  publish(rawInput: RoomLiveEventPublishInputV1): RoomLiveEventPublishResultV1 {
    let input: NormalizedPublishInput;
    try {
      input = normalizePublishInput(rawInput);
    } catch (error) {
      return this.rejected(error);
    }
    const state = this.stateFor(input.scope);
    const duplicate = state.byEventId.get(input.event.id);
    if (duplicate) {
      if (state.fingerprintsByEventId.get(input.event.id) !== input.fingerprint) {
        return this.rejected(new LiveEventValidationError(
          "cursor_conflict",
          `Canonical event ${input.event.id} was replayed with different immutable contents`,
        ), state);
      }
      return freeze({
        ok: true as const,
        outcome: "duplicate" as const,
        event: duplicate,
        connection: cloneConnection(state.connection),
        alerts: alertSnapshot(state),
      });
    }
    const sameCursor = state.byCursor.get(input.event.cursor);
    if (sameCursor) {
      return this.rejected(new LiveEventValidationError(
        "cursor_conflict",
        `Canonical cursor ${input.event.cursor} already belongs to event ${sameCursor.eventId}`,
      ), state);
    }
    if (state.latestCursor !== null && input.cursorNumber <= state.latestCursor) {
      return this.rejected(new LiveEventValidationError(
        "stale_cursor",
        `Canonical cursor ${input.event.cursor} cannot overwrite live cursor ${state.latestCursorText}`,
      ), state);
    }
    if (input.streamSequence !== null && state.lastStreamSequence !== null) {
      if (input.streamSequence <= state.lastStreamSequence) {
        return this.rejected(new LiveEventValidationError(
          "stale_cursor",
          `Source stream sequence ${input.streamSequence} cannot replace ${state.lastStreamSequence}`,
        ), state);
      }
      if (input.streamSequence > state.lastStreamSequence + 1) {
        this.recordSourceSequenceGap(state, input.scope, input.event, state.lastStreamSequence + 1, input.streamSequence);
        return this.rejected(new LiveEventValidationError(
          "source_sequence_gap",
          `Source stream skipped sequence ${state.lastStreamSequence + 1} before ${input.streamSequence}`,
        ), state);
      }
    }
    const envelope = toEnvelope(input.scope, input.event, input.cursorNumber, input.streamSequence);
    this.append(state, envelope, input.fingerprint);
    if (input.streamSequence !== null) state.lastStreamSequence = input.streamSequence;
    if (state.pendingGap !== null && input.streamSequence !== null) {
      if (input.streamSequence >= state.pendingGap.observedStreamSequence) {
        state.pendingGap = null;
      } else {
        state.pendingGap = freeze({
          ...state.pendingGap,
          expectedStreamSequence: input.streamSequence + 1,
        });
      }
    }
    state.connection = freeze({
      state: state.pendingGap === null ? "connected" : "degraded",
      reason: state.pendingGap === null ? null : "Canonical stream replay has not yet filled every observed sequence gap",
      changedAt: input.event.occurredAt,
    });
    this.trimBuffer(state, input.scope);
    return freeze({
      ok: true as const,
      outcome: "published" as const,
      event: envelope,
      connection: cloneConnection(state.connection),
      alerts: alertSnapshot(state),
    });
  }

  disconnect(rawInput: RoomLiveEventDisconnectInputV1): RoomLiveEventDisconnectResultV1 {
    let input: NormalizedDisconnectInput;
    try {
      input = normalizeDisconnectInput(rawInput);
    } catch (error) {
      return this.rejected(error);
    }
    const state = this.stateFor(input.scope);
    state.connection = freeze({
      state: "disconnected",
      reason: input.reason,
      changedAt: input.occurredAt,
    });
    this.addAlert(state, createAlert(
      "stream_disconnected",
      "warning",
      input.scope,
      null,
      null,
      null,
      `Canonical event stream disconnected: ${input.reason}`,
    ));
    return freeze({
      ok: true as const,
      outcome: "disconnected" as const,
      scope: cloneScope(input.scope),
      connection: cloneConnection(state.connection),
      alerts: alertSnapshot(state),
    });
  }

  async reconnect(rawInput: RoomLiveEventReconnectInputV1): Promise<RoomLiveEventReconnectResultV1> {
    let input: NormalizedReconnectInput;
    try {
      input = normalizeReconnectInput(rawInput, this.maxReplayEvents);
    } catch (error) {
      return this.rejected(error);
    }
    const state = this.states.get(scopeKey(input.scope));
    if (!state) {
      if (this.canonicalReplayPort !== null) {
        // A fresh process has no retained notification cache. Durable replay is
        // still authoritative for this scope and must decide whether it is current.
        return this.replayFromCanonicalPort(input, this.stateFor(input.scope));
      }
      return freeze({
        ok: true as const,
        outcome: "up_to_date" as const,
        scope: cloneScope(input.scope),
        replaySource: "memory" as const,
        events: freeze([]),
        nextCursor: input.afterCursor,
        hasMore: false,
        connection: freeze({ state: "unknown", reason: null, changedAt: null }),
        alerts: freeze([]),
      });
    }
    if (this.canonicalReplayPort !== null) {
      // The bounded cache is a latency hint, not proof that it contains every
      // committed event after a reconnect cursor. Ask the durable ledger whenever
      // a canonical port is available so a partial notification history cannot hide data.
      return this.replayFromCanonicalPort(input, state);
    }
    if (input.afterCursorNumber !== null && state.latestCursor !== null && input.afterCursorNumber > state.latestCursor) {
      this.addAlert(state, createAlert(
        "replay_cursor_ahead",
        "warning",
        input.scope,
        input.afterCursor,
        null,
        null,
        `Requested cursor ${input.afterCursor} is ahead of the latest retained canonical cursor ${state.latestCursorText}`,
      ));
      return this.reconciliationRequired(input, state);
    }
    const needsCanonicalReplay = this.needsCanonicalReplay(state, input.afterCursorNumber);
    if (needsCanonicalReplay) {
      return this.reconciliationRequired(input, state);
    }
    const matching = state.events.filter((event) => input.afterCursorNumber === null || event.sequence > input.afterCursorNumber);
    const events = freeze(matching.slice(0, input.limit));
    const nextCursor = events.at(-1)?.cursor ?? input.afterCursor;
    return freeze({
      ok: true as const,
      outcome: events.length === 0 ? "up_to_date" as const : "replayed" as const,
      scope: cloneScope(input.scope),
      replaySource: "memory" as const,
      events,
      nextCursor,
      hasMore: matching.length > events.length,
      connection: cloneConnection(state.connection),
      alerts: alertSnapshot(state),
    });
  }

  private stateFor(scope: RoomLiveEventScopeV1): ScopeState {
    const key = scopeKey(scope);
    const existing = this.states.get(key);
    if (existing) return existing;
    const state = createState();
    this.states.set(key, state);
    return state;
  }

  private append(state: ScopeState, event: RoomLiveEventEnvelopeV1, fingerprint: string): void {
    state.events.push(event);
    state.byEventId.set(event.eventId, event);
    state.fingerprintsByEventId.set(event.eventId, fingerprint);
    state.byCursor.set(event.cursor, event);
    state.latestCursor = event.sequence;
    state.latestCursorText = event.cursor;
  }

  private trimBuffer(state: ScopeState, scope: RoomLiveEventScopeV1): void {
    let dropped: RoomLiveEventEnvelopeV1 | null = null;
    while (state.events.length > this.maxBufferedEvents) {
      const removed = state.events.shift();
      if (!removed) break;
      state.byEventId.delete(removed.eventId);
      state.fingerprintsByEventId.delete(removed.eventId);
      state.byCursor.delete(removed.cursor);
      state.droppedThroughCursor = removed.sequence;
      dropped = removed;
    }
    if (dropped) {
      this.addAlert(state, createAlert(
        "replay_window_overflow",
        "warning",
        scope,
        dropped.cursor,
        null,
        null,
        `The bounded live replay cache discarded canonical events through cursor ${dropped.cursor}; older reconnects require durable replay`,
      ));
    }
  }

  private recordSourceSequenceGap(
    state: ScopeState,
    scope: RoomLiveEventScopeV1,
    event: RoomEventRecordV1,
    expectedStreamSequence: number,
    observedStreamSequence: number,
  ): void {
    state.pendingGap = freeze({
      expectedStreamSequence,
      observedStreamSequence,
      observedCursor: event.cursor,
    });
    state.connection = freeze({
      state: "degraded",
      reason: "Canonical stream sequence gap requires durable reconciliation",
      changedAt: event.occurredAt,
    });
    this.addAlert(state, createAlert(
      "source_sequence_gap",
      "critical",
      scope,
      event.cursor,
      expectedStreamSequence,
      observedStreamSequence,
      `Canonical stream skipped sequence ${expectedStreamSequence} before ${observedStreamSequence}; later events are withheld until reconciliation`,
    ));
  }

  private addAlert(state: ScopeState, alert: RoomLiveEventAlertV1): void {
    state.alerts.push(alert);
    if (state.alerts.length > MAX_ALERTS_PER_SCOPE) state.alerts.splice(0, state.alerts.length - MAX_ALERTS_PER_SCOPE);
  }

  private needsCanonicalReplay(state: ScopeState, afterCursor: number | null): boolean {
    if (state.pendingGap !== null) return true;
    if (state.droppedThroughCursor === null) return false;
    return afterCursor === null || afterCursor < state.droppedThroughCursor;
  }

  private reconciliationRequired(
    input: NormalizedReconnectInput,
    state: ScopeState,
  ): RoomLiveEventReconnectResultV1 {
    return freeze({
      ok: true as const,
      outcome: "reconciliation_required" as const,
      scope: cloneScope(input.scope),
      replaySource: null,
      events: freeze([]),
      nextCursor: input.afterCursor,
      hasMore: false,
      connection: cloneConnection(state.connection),
      alerts: alertSnapshot(state),
    });
  }

  private async replayFromCanonicalPort(
    input: NormalizedReconnectInput,
    state: ScopeState,
  ): Promise<RoomLiveEventReconnectResultV1> {
    let records: readonly RoomEventRecordV1[];
    let hasMore: boolean;
    try {
      const page = await this.canonicalReplayPort!.listEventPage({
        contractVersion: ROOM_LIVE_EVENT_CURSOR_CONTRACT_VERSION,
        scope: cloneScope(input.scope),
        afterCursor: input.afterCursor,
        limit: input.limit,
      });
      if (
        !page
        || typeof page !== "object"
        || !Array.isArray(page.events)
        || typeof page.hasMore !== "boolean"
      ) {
        throw new LiveEventValidationError(
          "canonical_replay_invalid",
          "Canonical replay port returned an invalid event page",
        );
      }
      records = page.events;
      hasMore = page.hasMore;
      validateCanonicalReplay(records, input.scope, input.afterCursorNumber, input.limit);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Canonical replay port failed without an inspectable error";
      this.addAlert(state, createAlert(
        error instanceof LiveEventValidationError ? "canonical_replay_invalid" : "canonical_replay_failed",
        "critical",
        input.scope,
        input.afterCursor,
        null,
        null,
        message,
      ));
      return this.reconciliationRequired(input, state);
    }
    const events = freeze(records.map((record) => toEnvelope(
      input.scope,
      record,
      parseCursor(record.cursor, "Canonical replay event cursor", false),
      null,
    )));
    const latestReplayed = events.at(-1);
    if (
      state.pendingGap !== null
      && latestReplayed !== undefined
      && latestReplayed.sequence >= parseCursor(state.pendingGap.observedCursor, "Pending gap cursor", false)
    ) {
      state.lastStreamSequence = state.pendingGap.observedStreamSequence;
      state.pendingGap = null;
      state.connection = freeze({
        state: "connected",
        reason: null,
        changedAt: latestReplayed.occurredAt,
      });
    }
    return freeze({
      ok: true as const,
      outcome: events.length === 0 ? "up_to_date" as const : "replayed" as const,
      scope: cloneScope(input.scope),
      replaySource: "canonical_port" as const,
      events,
      nextCursor: latestReplayed?.cursor ?? input.afterCursor,
      hasMore,
      connection: cloneConnection(state.connection),
      alerts: alertSnapshot(state),
    });
  }

  private rejected(error: unknown, state?: ScopeState): RoomLiveEventPublishResultV1 & RoomLiveEventDisconnectResultV1 & RoomLiveEventReconnectResultV1 {
    const reason = error instanceof LiveEventValidationError
      ? freeze({ code: error.code, message: error.message })
      : freeze({ code: "invalid_input" as const, message: "Room live-event input could not be validated" });
    return freeze({
      ok: false as const,
      outcome: "rejected" as const,
      reason,
      alerts: state ? alertSnapshot(state) : freeze([]),
    }) as RoomLiveEventPublishResultV1 & RoomLiveEventDisconnectResultV1 & RoomLiveEventReconnectResultV1;
  }
}

function normalizePositiveLimit(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a safe positive integer`);
  }
  return value as number;
}

function normalizePublishInput(rawInput: RoomLiveEventPublishInputV1): NormalizedPublishInput {
  if (!isRecord(rawInput)) {
    throw new LiveEventValidationError("invalid_input", "Room live-event publish input must be an object");
  }
  if (rawInput.contractVersion !== ROOM_LIVE_EVENT_CURSOR_CONTRACT_VERSION) {
    throw new LiveEventValidationError("invalid_input", "Room live-event publish contract version is unsupported");
  }
  if (rawInput.source !== "canonical_room_event") {
    throw new LiveEventValidationError("untrusted_source", "Only a committed canonical Room event may enter the live cursor");
  }
  const scope = normalizeScope(rawInput.scope, "Room live-event publish scope");
  if (!isRecord(rawInput.event)) {
    throw new LiveEventValidationError("invalid_input", "Room live-event publish event must be inspectable");
  }
  const event = rawInput.event as RoomEventRecordV1;
  if (event.contractVersion !== 1) {
    throw new LiveEventValidationError("invalid_input", "Canonical Room event contract version is unsupported");
  }
  if (event.projectId !== scope.projectId || event.roomId !== scope.roomId) {
    throw new LiveEventValidationError("event_scope_mismatch", "Canonical Room event cannot cross the requested project or Room scope");
  }
  requireCanonicalText(event.id, "Canonical Room event id");
  requireCanonicalText(event.eventType, "Canonical Room event type");
  requireCanonicalText(event.actorId, "Canonical Room event actorId");
  requireCanonicalText(event.correlationId, "Canonical Room event correlationId");
  requireCanonicalText(event.occurredAt, "Canonical Room event occurredAt");
  if (!Number.isSafeInteger(event.aggregateVersion) || event.aggregateVersion < 0) {
    throw new LiveEventValidationError("invalid_input", "Canonical Room event aggregateVersion must be a safe non-negative integer");
  }
  const cursorNumber = parseCursor(event.cursor, "Canonical Room event cursor", false);
  return freeze({
    scope,
    event: cloneEvent(event),
    cursorNumber,
    streamSequence: parseStreamSequence(rawInput.streamSequence),
    fingerprint: eventFingerprint(event),
  });
}

function normalizeDisconnectInput(rawInput: RoomLiveEventDisconnectInputV1): NormalizedDisconnectInput {
  if (!isRecord(rawInput)) {
    throw new LiveEventValidationError("invalid_input", "Room live-event disconnect input must be an object");
  }
  if (rawInput.contractVersion !== ROOM_LIVE_EVENT_CURSOR_CONTRACT_VERSION) {
    throw new LiveEventValidationError("invalid_input", "Room live-event disconnect contract version is unsupported");
  }
  if (rawInput.source !== "canonical_event_source") {
    throw new LiveEventValidationError("untrusted_source", "Only the canonical event source may mark a Room stream disconnected");
  }
  const scope = normalizeScope(rawInput.scope, "Room live-event disconnect scope");
  if (requireCanonicalText(rawInput.authorizedProjectId, "Room live-event disconnect authorizedProjectId") !== scope.projectId) {
    throw new LiveEventValidationError("cross_project_forbidden", "Cross-project Room stream state changes are forbidden");
  }
  return freeze({
    scope,
    occurredAt: requireCanonicalText(rawInput.occurredAt, "Room live-event disconnect occurredAt"),
    reason: requireCanonicalText(rawInput.reason, "Room live-event disconnect reason"),
  });
}

function normalizeReconnectInput(
  rawInput: RoomLiveEventReconnectInputV1,
  maxReplayEvents: number,
): NormalizedReconnectInput {
  if (!isRecord(rawInput)) {
    throw new LiveEventValidationError("invalid_input", "Room live-event reconnect input must be an object");
  }
  if (rawInput.contractVersion !== ROOM_LIVE_EVENT_CURSOR_CONTRACT_VERSION) {
    throw new LiveEventValidationError("invalid_input", "Room live-event reconnect contract version is unsupported");
  }
  const scope = normalizeScope(rawInput.scope, "Room live-event reconnect scope");
  if (requireCanonicalText(rawInput.authorizedProjectId, "Room live-event reconnect authorizedProjectId") !== scope.projectId) {
    throw new LiveEventValidationError("cross_project_forbidden", "Cross-project Room event replay is forbidden");
  }
  const afterCursor = rawInput.afterCursor === null
    ? null
    : requireCanonicalText(rawInput.afterCursor, "Room live-event reconnect afterCursor");
  const afterCursorNumber = afterCursor === null ? null : parseCursor(afterCursor, "Room live-event reconnect afterCursor", true);
  const requestedLimit = rawInput.limit === undefined
    ? maxReplayEvents
    : normalizePositiveLimit(rawInput.limit, maxReplayEvents, "Room live-event reconnect limit");
  return freeze({
    scope,
    afterCursor,
    afterCursorNumber,
    limit: Math.min(requestedLimit, maxReplayEvents),
  });
}

function createAlert(
  code: RoomLiveEventAlertCodeV1,
  severity: RoomLiveEventAlertV1["severity"],
  scope: RoomLiveEventScopeV1,
  cursor: string | null,
  expectedStreamSequence: number | null,
  observedStreamSequence: number | null,
  message: string,
): RoomLiveEventAlertV1 {
  return freeze({
    code,
    severity,
    message,
    scope: cloneScope(scope),
    cursor,
    expectedStreamSequence,
    observedStreamSequence,
  });
}

function validateCanonicalReplay(
  records: readonly RoomEventRecordV1[],
  scope: RoomLiveEventScopeV1,
  afterCursor: number | null,
  limit: number,
): void {
  if (!Array.isArray(records) || records.length > limit) {
    throw new LiveEventValidationError("canonical_replay_invalid", "Canonical replay must return an array no larger than the requested limit");
  }
  const eventIds = new Set<string>();
  let previousCursor = afterCursor;
  for (const record of records) {
    const normalized = normalizePublishInput({
      contractVersion: ROOM_LIVE_EVENT_CURSOR_CONTRACT_VERSION,
      source: "canonical_room_event",
      scope,
      event: record,
      streamSequence: null,
    });
    if (eventIds.has(normalized.event.id)) {
      throw new LiveEventValidationError("canonical_replay_invalid", `Canonical replay duplicated event ${normalized.event.id}`);
    }
    if (previousCursor !== null && normalized.cursorNumber <= previousCursor) {
      throw new LiveEventValidationError("canonical_replay_invalid", "Canonical replay must be strictly ordered after the requested cursor");
    }
    eventIds.add(normalized.event.id);
    previousCursor = normalized.cursorNumber;
  }
}

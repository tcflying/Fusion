import {
  MAX_ROOM_EVENT_LIST_LIMIT,
  type AsyncRoomStore,
  type RoomEventRecordV1,
} from "@fusion/core";

import {
  ROOM_LIVE_EVENT_CURSOR_CONTRACT_VERSION,
  RoomLiveEventCursorCoordinator,
  type RoomLiveEventAlertV1,
  type RoomLiveEventCanonicalReplayPortV1,
  type RoomLiveEventConnectionV1,
  type RoomLiveEventEnvelopeV1,
  type RoomLiveEventReconnectResultV1,
  type RoomLiveEventScopeV1,
} from "./room-live-event-cursor.js";

export const ROOM_CONTROL_PLANE_LIVE_EVENT_SERVICE_CONTRACT_VERSION = 1 as const;

const MAX_IDENTIFIER_LENGTH = 256;
const DEFAULT_DURABLE_POLL_INTERVAL_MS = 5_000;
const MIN_DURABLE_POLL_INTERVAL_MS = 250;
const DEFAULT_DURABLE_POLL_BATCH_SIZE = 128;

export type RoomControlPlaneLiveEventServiceErrorCode =
  | "room_control_plane_live_event_invalid_listener"
  | "room_control_plane_live_event_invalid_project_id"
  | "room_control_plane_live_event_invalid_room_id"
  | "room_control_plane_live_event_project_scope_mismatch";

export class RoomControlPlaneLiveEventServiceError extends Error {
  constructor(
    readonly code: RoomControlPlaneLiveEventServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RoomControlPlaneLiveEventServiceError";
  }
}

export interface RoomControlPlaneLiveEventServiceOptionsV1 {
  readonly projectId: string;
  readonly roomStore: AsyncRoomStore;
  readonly maxBufferedEvents?: number;
  readonly maxReplayEvents?: number;
  /** Period between bounded durable reconciliation reads while at least one scope is subscribed. */
  readonly durablePollIntervalMs?: number;
  readonly onListenerError?: (
    error: unknown,
    notification: RoomControlPlaneLiveEventNotificationV1,
  ) => void;
}

export interface RoomControlPlaneLiveEventSubscriptionInputV1 {
  readonly projectId: string;
  readonly roomId: string;
}

export interface RoomControlPlaneLiveEventReconnectInputV1 extends RoomControlPlaneLiveEventSubscriptionInputV1 {
  readonly afterCursor: string | null;
  readonly limit?: number;
}

export interface RoomControlPlaneLiveEventNotificationV1 {
  readonly contractVersion: typeof ROOM_CONTROL_PLANE_LIVE_EVENT_SERVICE_CONTRACT_VERSION;
  readonly type: "canonical_room_event";
  readonly scope: RoomLiveEventScopeV1;
  readonly envelope: RoomLiveEventEnvelopeV1;
  readonly connection: RoomLiveEventConnectionV1;
  readonly alerts: readonly RoomLiveEventAlertV1[];
}

/** A lifecycle-only signal; it intentionally carries no Room data, scope, or error details. */
export interface RoomControlPlaneLiveEventServiceClosedSignalV1 {
  readonly contractVersion: typeof ROOM_CONTROL_PLANE_LIVE_EVENT_SERVICE_CONTRACT_VERSION;
  readonly type: "service_closed";
  readonly reason: "service_closed";
}

/**
 * A callable unsubscribe remains source-compatible with existing callers.
 * New callers can observe `closed` to proactively close and reconnect a route.
 */
export interface RoomControlPlaneLiveEventSubscriptionV1 {
  (): void;
  readonly closed: Promise<RoomControlPlaneLiveEventServiceClosedSignalV1>;
}

export type RoomControlPlaneLiveEventListenerV1 = (
  notification: RoomControlPlaneLiveEventNotificationV1,
) => void | Promise<void>;

interface Subscription {
  readonly scope: RoomLiveEventScopeV1;
  readonly listener: RoomControlPlaneLiveEventListenerV1;
  readonly resolveClosed: (signal: RoomControlPlaneLiveEventServiceClosedSignalV1) => void;
}

interface DurablePollState {
  readonly scope: RoomLiveEventScopeV1;
  cursor: string | null;
  inFlight: boolean;
  requested: boolean;
  scheduled: boolean;
}

function isCanonicalIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH
    && value === value.trim();
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return Object.freeze(value);
}

function immutableSnapshot<T>(value: T): T {
  return freezeDeep(structuredClone(value));
}

function normalizeDurablePollIntervalMs(value: unknown): number {
  if (value === undefined) return DEFAULT_DURABLE_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(value) || (value as number) < MIN_DURABLE_POLL_INTERVAL_MS) {
    throw new Error(`durablePollIntervalMs must be a safe integer of at least ${MIN_DURABLE_POLL_INTERVAL_MS}`);
  }
  return value as number;
}

function scopeKey(scope: RoomLiveEventScopeV1): string {
  return `${scope.projectId}\u0000${scope.roomId}`;
}

/**
 * FNXC:RoomControlPlaneLiveEventService 2026-07-19-17:25:
 * `AsyncRoomStore.subscribe()` is a post-commit, process-local latency hint;
 * it can be absent across a restart and must never be treated as the durable
 * Room ledger. Every reconnect is backed by the coordinator's canonical replay
 * port, which reads `AsyncRoomStore.listEventPage(roomId, afterCursor, { limit })` and makes
 * replay failure or disorder visible as reconciliation alerts instead of
 * turning a notification cache into authority.
 *
 * FNXC:RoomControlPlaneLiveEventService 2026-07-19-18:56:
 * Cross-process commits cannot reach this process-local listener directly.
 * Each subscribed scope therefore keeps only a durable cursor and reconciles
 * one bounded canonical page per poll; a local hint wakes that same read
 * immediately, while the 5-second default avoids a high-frequency idle poll.
 * On stop, subscription handles receive only a `service_closed` lifecycle
 * signal, then are cleared so future route code can reconnect safely.
 */
export class RoomControlPlaneLiveEventService {
  private readonly projectId: string;
  private readonly roomStore: AsyncRoomStore;
  private readonly maxBufferedEvents: number | undefined;
  private readonly maxReplayEvents: number | undefined;
  private readonly durablePollIntervalMs: number;
  private readonly durablePollBatchSize: number;
  private coordinator: RoomLiveEventCursorCoordinator;
  private readonly onListenerError: RoomControlPlaneLiveEventServiceOptionsV1["onListenerError"];
  private readonly subscriptions = new Set<Subscription>();
  private readonly durablePollStates = new Map<string, DurablePollState>();
  private unsubscribeStore: (() => void) | null = null;
  private durablePollTimer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(options: RoomControlPlaneLiveEventServiceOptionsV1) {
    if (!isCanonicalIdentifier(options.projectId)) {
      throw new RoomControlPlaneLiveEventServiceError(
        "room_control_plane_live_event_invalid_project_id",
        "Room live events require a bounded project identifier",
      );
    }
    this.projectId = options.projectId;
    this.roomStore = options.roomStore;
    this.maxBufferedEvents = options.maxBufferedEvents;
    this.maxReplayEvents = options.maxReplayEvents;
    this.durablePollIntervalMs = normalizeDurablePollIntervalMs(options.durablePollIntervalMs);
    this.durablePollBatchSize = options.maxReplayEvents ?? DEFAULT_DURABLE_POLL_BATCH_SIZE;
    this.onListenerError = options.onListenerError;
    if (
      Number.isSafeInteger(options.maxReplayEvents)
      && options.maxReplayEvents! > MAX_ROOM_EVENT_LIST_LIMIT
    ) {
      throw new Error(`maxReplayEvents cannot exceed ${MAX_ROOM_EVENT_LIST_LIMIT}`);
    }
    this.coordinator = this.createCoordinator();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    try {
      this.unsubscribeStore = this.roomStore.subscribe((event) => this.handleCommittedEvent(event));
      if (this.subscriptions.size > 0) {
        this.startDurablePoller();
        this.requestAllDurablePolls();
      }
    } catch (error) {
      this.started = false;
      const unsubscribe = this.unsubscribeStore;
      this.unsubscribeStore = null;
      this.stopDurablePoller();
      try {
        unsubscribe?.();
      } catch {
        // Preserve the original start failure; no subscriber was attached by this failed start.
      }
      throw error;
    }
  }

  stop(): void {
    if (
      !this.started
      && this.unsubscribeStore === null
      && this.durablePollTimer === null
      && this.subscriptions.size === 0
    ) return;
    this.started = false;
    const unsubscribe = this.unsubscribeStore;
    this.unsubscribeStore = null;
    this.stopDurablePoller();
    const subscriptions = [...this.subscriptions];
    this.subscriptions.clear();
    this.durablePollStates.clear();
    this.coordinator = this.createCoordinator();
    const closedSignal = immutableSnapshot<RoomControlPlaneLiveEventServiceClosedSignalV1>({
      contractVersion: ROOM_CONTROL_PLANE_LIVE_EVENT_SERVICE_CONTRACT_VERSION,
      type: "service_closed",
      reason: "service_closed",
    });
    try {
      unsubscribe?.();
    } finally {
      for (const subscription of subscriptions) subscription.resolveClosed(closedSignal);
    }
  }

  subscribe(
    input: RoomControlPlaneLiveEventSubscriptionInputV1,
    listener: RoomControlPlaneLiveEventListenerV1,
  ): RoomControlPlaneLiveEventSubscriptionV1 {
    const scope = this.normalizeScope(input);
    if (typeof listener !== "function") {
      throw new RoomControlPlaneLiveEventServiceError(
        "room_control_plane_live_event_invalid_listener",
        "Room live-event subscriptions require a listener function",
      );
    }
    let resolveClosed: (signal: RoomControlPlaneLiveEventServiceClosedSignalV1) => void;
    const closed = new Promise<RoomControlPlaneLiveEventServiceClosedSignalV1>((resolve) => {
      resolveClosed = resolve;
    });
    const subscription: Subscription = freezeDeep({ scope, listener, resolveClosed: resolveClosed! });
    this.subscriptions.add(subscription);
    if (this.started) {
      this.startDurablePoller();
      this.requestDurablePoll(scope);
    }
    let active = true;
    const unsubscribe = (() => {
      if (!active) return;
      active = false;
      this.subscriptions.delete(subscription);
      if (this.subscriptions.size === 0) this.stopDurablePoller();
    }) as RoomControlPlaneLiveEventSubscriptionV1;
    Object.defineProperty(unsubscribe, "closed", { value: closed });
    return unsubscribe;
  }

  async reconnect(
    input: RoomControlPlaneLiveEventReconnectInputV1,
  ): Promise<RoomLiveEventReconnectResultV1> {
    const scope = this.normalizeScope(input);
    const result = await this.coordinator.reconnect({
      contractVersion: ROOM_LIVE_EVENT_CURSOR_CONTRACT_VERSION,
      authorizedProjectId: this.projectId,
      scope,
      afterCursor: input.afterCursor,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    return immutableSnapshot(result);
  }

  private async listCanonicalEventPage(
    input: Parameters<RoomLiveEventCanonicalReplayPortV1["listEventPage"]>[0],
  ): Promise<{ readonly events: readonly RoomEventRecordV1[]; readonly hasMore: boolean }> {
    if (input.contractVersion !== ROOM_LIVE_EVENT_CURSOR_CONTRACT_VERSION) {
      throw new Error("Room canonical replay port received an unsupported contract version");
    }
    const scope = this.normalizeScope(input.scope);
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new Error("Room canonical replay port requires a safe positive limit");
    }
    return this.roomStore.listEventPage(scope.roomId, input.afterCursor ?? undefined, {
      limit: input.limit,
    });
  }

  private handleCommittedEvent(event: RoomEventRecordV1): void {
    if (!this.started) return;
    if (
      !isCanonicalIdentifier(event.projectId)
      || !isCanonicalIdentifier(event.roomId)
      || event.projectId !== this.projectId
    ) {
      return;
    }
    this.requestDurablePoll({ projectId: this.projectId, roomId: event.roomId });
  }

  private createCoordinator(): RoomLiveEventCursorCoordinator {
    const canonicalReplayPort: RoomLiveEventCanonicalReplayPortV1 = {
      listEventPage: async (input) => this.listCanonicalEventPage(input),
    };
    return new RoomLiveEventCursorCoordinator({
      canonicalReplayPort,
      maxBufferedEvents: this.maxBufferedEvents,
      maxReplayEvents: this.maxReplayEvents,
    });
  }

  private startDurablePoller(): void {
    if (this.durablePollTimer !== null) return;
    this.durablePollTimer = setInterval(() => this.requestAllDurablePolls(), this.durablePollIntervalMs);
  }

  private stopDurablePoller(): void {
    if (this.durablePollTimer === null) return;
    clearInterval(this.durablePollTimer);
    this.durablePollTimer = null;
  }

  private requestAllDurablePolls(): void {
    if (!this.started) return;
    for (const subscription of this.subscriptions) this.requestDurablePoll(subscription.scope);
  }

  private requestDurablePoll(scope: RoomLiveEventScopeV1): void {
    if (!this.started || !this.hasSubscribersForScope(scope)) return;
    const state = this.durablePollStateFor(scope);
    state.requested = true;
    if (state.inFlight || state.scheduled) return;
    state.scheduled = true;
    queueMicrotask(() => {
      state.scheduled = false;
      void this.pollDurableScope(state);
    });
  }

  private async pollDurableScope(state: DurablePollState): Promise<void> {
    if (!this.started || !this.hasSubscribersForScope(state.scope)) return;
    if (state.inFlight) {
      state.requested = true;
      return;
    }
    state.inFlight = true;
    state.requested = false;
    try {
      const page = await this.listCanonicalEventPage({
        contractVersion: ROOM_LIVE_EVENT_CURSOR_CONTRACT_VERSION,
        scope: state.scope,
        afterCursor: state.cursor,
        limit: this.durablePollBatchSize,
      });
      if (
        !Array.isArray(page.events)
        || typeof page.hasMore !== "boolean"
        || page.events.length > this.durablePollBatchSize
      ) {
        return;
      }
      for (const event of page.events) {
        if (!this.started || !this.hasSubscribersForScope(state.scope)) return;
        if (!this.publishCanonicalEvent(event, state.scope)) return;
        state.cursor = event.cursor;
      }
    } catch {
      // Leave the cursor untouched: the next bounded sweep can retry a transient durable read failure.
    } finally {
      state.inFlight = false;
      if (state.requested && this.started && this.hasSubscribersForScope(state.scope)) {
        this.requestDurablePoll(state.scope);
      }
    }
  }

  private durablePollStateFor(scope: RoomLiveEventScopeV1): DurablePollState {
    const key = scopeKey(scope);
    const existing = this.durablePollStates.get(key);
    if (existing) return existing;
    const state: DurablePollState = {
      scope: immutableSnapshot(scope),
      cursor: null,
      inFlight: false,
      requested: false,
      scheduled: false,
    };
    this.durablePollStates.set(key, state);
    return state;
  }

  private hasSubscribersForScope(scope: RoomLiveEventScopeV1): boolean {
    for (const subscription of this.subscriptions) {
      if (
        subscription.scope.projectId === scope.projectId
        && subscription.scope.roomId === scope.roomId
      ) return true;
    }
    return false;
  }

  private publishCanonicalEvent(event: RoomEventRecordV1, scope: RoomLiveEventScopeV1): boolean {
    const published = this.coordinator.publish({
      contractVersion: ROOM_LIVE_EVENT_CURSOR_CONTRACT_VERSION,
      source: "canonical_room_event",
      scope,
      event,
      // Canonical durable replay is ordered by its cursor; store callbacks only wake it early.
      streamSequence: null,
    });
    if (!published.ok) return false;
    if (published.outcome !== "published") return true;
    const notification = immutableSnapshot<RoomControlPlaneLiveEventNotificationV1>({
      contractVersion: ROOM_CONTROL_PLANE_LIVE_EVENT_SERVICE_CONTRACT_VERSION,
      type: "canonical_room_event",
      scope: published.event.scope,
      envelope: published.event,
      connection: published.connection,
      alerts: published.alerts,
    });
    this.notifySubscribers(notification);
    return true;
  }

  private normalizeScope(input: RoomControlPlaneLiveEventSubscriptionInputV1): RoomLiveEventScopeV1 {
    if (!isCanonicalIdentifier(input.projectId)) {
      throw new RoomControlPlaneLiveEventServiceError(
        "room_control_plane_live_event_invalid_project_id",
        "Room live-event scope requires a bounded project identifier",
      );
    }
    if (input.projectId !== this.projectId) {
      throw new RoomControlPlaneLiveEventServiceError(
        "room_control_plane_live_event_project_scope_mismatch",
        "Room live events cannot cross project scope",
      );
    }
    if (!isCanonicalIdentifier(input.roomId)) {
      throw new RoomControlPlaneLiveEventServiceError(
        "room_control_plane_live_event_invalid_room_id",
        "Room live-event scope requires a bounded Room identifier",
      );
    }
    return immutableSnapshot({ projectId: input.projectId, roomId: input.roomId });
  }

  private notifySubscribers(notification: RoomControlPlaneLiveEventNotificationV1): void {
    for (const subscription of this.subscriptions) {
      if (
        subscription.scope.projectId !== notification.scope.projectId
        || subscription.scope.roomId !== notification.scope.roomId
      ) {
        continue;
      }
      queueMicrotask(() => {
        if (!this.started || !this.subscriptions.has(subscription)) return;
        this.invokeListener(subscription.listener, notification);
      });
    }
  }

  private invokeListener(
    listener: RoomControlPlaneLiveEventListenerV1,
    notification: RoomControlPlaneLiveEventNotificationV1,
  ): void {
    try {
      Promise.resolve(listener(notification)).catch((error) => this.reportListenerError(error, notification));
    } catch (error) {
      this.reportListenerError(error, notification);
    }
  }

  private reportListenerError(error: unknown, notification: RoomControlPlaneLiveEventNotificationV1): void {
    try {
      this.onListenerError?.(error, notification);
    } catch {
      // Diagnostics are intentionally isolated from durable Room transactions and peers.
    }
  }
}

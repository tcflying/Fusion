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
const DEFAULT_MAX_CONCURRENT_DURABLE_POLLS = 8;
const MAX_CONCURRENT_DURABLE_POLLS = 32;
const DEFAULT_MAX_IMMEDIATE_PAGES_PER_SCOPE = 4;
const DEFAULT_MAX_LIVE_EVENT_SUBSCRIPTIONS = 256;
const MAX_LIVE_EVENT_SUBSCRIPTIONS = 4_096;
const DEFAULT_MAX_LIVE_EVENT_SUBSCRIPTIONS_PER_SCOPE = 64;
const MAX_LIVE_EVENT_SUBSCRIPTIONS_PER_SCOPE = 1_024;
const DEFAULT_MAX_LIVE_EVENT_SUBSCRIPTIONS_PER_ACTOR = 32;
const MAX_LIVE_EVENT_SUBSCRIPTIONS_PER_ACTOR = 256;
const LIVE_EVENT_SUBSCRIPTION_RETRY_AFTER_MS = 1_000;
const INTERNAL_LIVE_EVENT_ACTOR_ID = "room_live_event_internal";

export type RoomControlPlaneLiveEventServiceErrorCode =
  | "room_control_plane_live_event_invalid_listener"
  | "room_control_plane_live_event_invalid_project_id"
  | "room_control_plane_live_event_invalid_room_id"
  | "room_control_plane_live_event_invalid_actor_id"
  | "room_control_plane_live_event_invalid_cursor"
  | "room_control_plane_live_event_project_scope_mismatch"
  | "room_control_plane_live_event_service_stopped"
  | "room_control_plane_live_event_subscription_limit_reached"
  | "room_control_plane_live_event_scope_subscription_limit_reached"
  | "room_control_plane_live_event_actor_subscription_limit_reached"
  | "room_control_plane_live_event_termination_listener_limit_reached"
  | "room_control_plane_live_event_scope_termination_listener_limit_reached";

export class RoomControlPlaneLiveEventServiceError extends Error {
  constructor(
    readonly code: RoomControlPlaneLiveEventServiceErrorCode,
    message: string,
    readonly retryAfterMs: number | null = null,
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
  /** Global cap for simultaneous durable reads across active Room scopes. */
  readonly maxConcurrentDurablePolls?: number;
  /** Fair bounded burst before a backlogged scope yields to the next scheduler turn. */
  readonly maxImmediatePagesPerScope?: number;
  /** Bounded live event listeners for this project Engine. */
  readonly maxLiveEventSubscriptions?: number;
  /** Bounded live event listeners for one project-and-Room scope. */
  readonly maxLiveEventSubscriptionsPerScope?: number;
  /** Bounded live event listeners for one authenticated actor. */
  readonly maxLiveEventSubscriptionsPerActor?: number;
  readonly onListenerError?: (
    error: unknown,
    notification: RoomControlPlaneLiveEventNotificationV1,
  ) => void;
}

export interface RoomControlPlaneLiveEventSubscriptionInputV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly actorId?: string;
  /**
   * A route can register first, replay durably, then activate this subscription
   * at the returned cursor without treating replay history as a live event.
   */
  readonly holdUntilReplayWatermark?: boolean;
  readonly afterCursor?: string | null;
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
  readonly reason: "service_closed" | "durable_poll_failed" | "canonical_page_invalid";
}

/**
 * A callable unsubscribe remains source-compatible with existing callers.
 * `closed` remains a compatibility teardown signal; SSE routes must use the
 * explicit scope-level `subscribeTermination` health boundary.
 */
export interface RoomControlPlaneLiveEventSubscriptionV1 {
  (): void;
  readonly closed: Promise<RoomControlPlaneLiveEventServiceClosedSignalV1>;
  readonly activate: (afterCursor: string | null) => boolean;
}

export interface RoomControlPlaneLiveEventTerminationSignalV1 {
  readonly contractVersion: typeof ROOM_CONTROL_PLANE_LIVE_EVENT_SERVICE_CONTRACT_VERSION;
  readonly type: "room_live_event_terminated";
  readonly reason: "service_stopped" | "durable_poll_failed" | "canonical_page_invalid";
  readonly scope: RoomLiveEventScopeV1;
  readonly connection: RoomLiveEventConnectionV1;
  readonly alerts: readonly RoomLiveEventAlertV1[];
}

export type RoomControlPlaneLiveEventTerminationListenerV1 = (
  signal: RoomControlPlaneLiveEventTerminationSignalV1,
) => void | Promise<void>;

export type RoomControlPlaneLiveEventListenerV1 = (
  notification: RoomControlPlaneLiveEventNotificationV1,
) => void | Promise<void>;

interface Subscription {
  readonly scope: RoomLiveEventScopeV1;
  readonly actorId: string;
  readonly listener: RoomControlPlaneLiveEventListenerV1;
  readonly resolveClosed: (signal: RoomControlPlaneLiveEventServiceClosedSignalV1) => void;
  awaitingReplayWatermark: boolean;
  initialSequence: number | null;
  deliveredSequence: number | null;
  pendingNotifications: RoomControlPlaneLiveEventNotificationV1[];
  pendingOverflowed: boolean;
}

interface DurablePollState {
  readonly scope: RoomLiveEventScopeV1;
  cursor: string | null;
  inFlight: boolean;
  requested: boolean;
  scheduled: boolean;
  failed: boolean;
  immediatePages: number;
  continuationTimer: ReturnType<typeof setTimeout> | null;
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

function normalizeBoundedPositiveInteger(value: unknown, fallback: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new Error(`${label} must be a safe integer from 1 through ${maximum}`);
  }
  return value as number;
}

function normalizeOptionalCursor(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== "string"
    || !/^(?:0|[1-9][0-9]*)$/u.test(value)
    || !Number.isSafeInteger(Number(value))
  ) {
    throw new RoomControlPlaneLiveEventServiceError(
      "room_control_plane_live_event_invalid_cursor",
      "Room live-event cursors must be canonical safe decimal integers",
    );
  }
  return Number(value);
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
 * FNXC:RoomControlPlaneLiveEventService 2026-07-19-19:45:
 * Cross-process commits cannot reach this process-local listener directly.
 * Each subscribed scope therefore keeps only a durable cursor and reconciles
 * bounded canonical pages per poll turn. `hasMore` schedules bounded immediate
 * catch-up before yielding to the event loop rather than waiting for the idle
 * cadence. A typed scope termination is the authoritative liveness boundary
 * for SSE routes; a dashboard heartbeat cannot substitute for it.
 *
 * FNXC:RoomControlPlaneLiveEventCapacity 2026-07-19-21:31:
 * Live SSE listeners and their termination observers are resource-bearing
 * backend objects. Bound total and per-Room registrations, expose retryable
 * capacity errors, and release every permit on unsubscribe or termination so
 * one client cannot exhaust polling, listener, or heartbeat resources.
 */
export class RoomControlPlaneLiveEventService {
  private readonly projectId: string;
  private readonly roomStore: AsyncRoomStore;
  private readonly maxBufferedEvents: number | undefined;
  private readonly maxReplayEvents: number | undefined;
  private readonly durablePollIntervalMs: number;
  private readonly durablePollBatchSize: number;
  private readonly maxConcurrentDurablePolls: number;
  private readonly maxImmediatePagesPerScope: number;
  private readonly maxLiveEventSubscriptions: number;
  private readonly maxLiveEventSubscriptionsPerScope: number;
  private readonly maxLiveEventSubscriptionsPerActor: number;
  private readonly maxPendingHandshakeEvents: number;
  private readonly coordinators = new Map<string, RoomLiveEventCursorCoordinator>();
  private readonly onListenerError: RoomControlPlaneLiveEventServiceOptionsV1["onListenerError"];
  private readonly subscriptions = new Set<Subscription>();
  private readonly subscriptionsByScope = new Map<string, Set<Subscription>>();
  private readonly subscriptionsByActor = new Map<string, Set<Subscription>>();
  private readonly terminationListenersByScope = new Map<string, Set<RoomControlPlaneLiveEventTerminationListenerV1>>();
  private readonly terminationScopesByKey = new Map<string, RoomLiveEventScopeV1>();
  private terminationListenerCount = 0;
  private readonly durablePollStates = new Map<string, DurablePollState>();
  private readonly durablePollQueue: DurablePollState[] = [];
  private unsubscribeStore: (() => void) | null = null;
  private durablePollTimer: ReturnType<typeof setInterval> | null = null;
  private durablePollDrainScheduled = false;
  private activeDurablePolls = 0;
  private started = false;
  private stopped = false;

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
    this.maxConcurrentDurablePolls = normalizeBoundedPositiveInteger(
      options.maxConcurrentDurablePolls,
      DEFAULT_MAX_CONCURRENT_DURABLE_POLLS,
      MAX_CONCURRENT_DURABLE_POLLS,
      "maxConcurrentDurablePolls",
    );
    this.maxImmediatePagesPerScope = normalizeBoundedPositiveInteger(
      options.maxImmediatePagesPerScope,
      DEFAULT_MAX_IMMEDIATE_PAGES_PER_SCOPE,
      MAX_ROOM_EVENT_LIST_LIMIT,
      "maxImmediatePagesPerScope",
    );
    this.maxLiveEventSubscriptions = normalizeBoundedPositiveInteger(
      options.maxLiveEventSubscriptions,
      DEFAULT_MAX_LIVE_EVENT_SUBSCRIPTIONS,
      MAX_LIVE_EVENT_SUBSCRIPTIONS,
      "maxLiveEventSubscriptions",
    );
    this.maxLiveEventSubscriptionsPerScope = normalizeBoundedPositiveInteger(
      options.maxLiveEventSubscriptionsPerScope,
      Math.min(DEFAULT_MAX_LIVE_EVENT_SUBSCRIPTIONS_PER_SCOPE, this.maxLiveEventSubscriptions),
      MAX_LIVE_EVENT_SUBSCRIPTIONS_PER_SCOPE,
      "maxLiveEventSubscriptionsPerScope",
    );
    if (this.maxLiveEventSubscriptionsPerScope > this.maxLiveEventSubscriptions) {
      throw new Error("maxLiveEventSubscriptionsPerScope cannot exceed maxLiveEventSubscriptions");
    }
    this.maxLiveEventSubscriptionsPerActor = normalizeBoundedPositiveInteger(
      options.maxLiveEventSubscriptionsPerActor,
      Math.min(DEFAULT_MAX_LIVE_EVENT_SUBSCRIPTIONS_PER_ACTOR, this.maxLiveEventSubscriptions),
      MAX_LIVE_EVENT_SUBSCRIPTIONS_PER_ACTOR,
      "maxLiveEventSubscriptionsPerActor",
    );
    if (this.maxLiveEventSubscriptionsPerActor > this.maxLiveEventSubscriptions) {
      throw new Error("maxLiveEventSubscriptionsPerActor cannot exceed maxLiveEventSubscriptions");
    }
    this.maxPendingHandshakeEvents = options.maxBufferedEvents ?? 256;
    this.onListenerError = options.onListenerError;
    if (
      Number.isSafeInteger(options.maxReplayEvents)
      && options.maxReplayEvents! > MAX_ROOM_EVENT_LIST_LIMIT
    ) {
      throw new Error(`maxReplayEvents cannot exceed ${MAX_ROOM_EVENT_LIST_LIMIT}`);
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    try {
      this.unsubscribeStore = this.roomStore.subscribe((event) => this.handleCommittedEvent(event));
      if (this.hasActiveSubscriptions()) {
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
      && this.terminationListenersByScope.size === 0
    ) return;
    this.stopped = true;
    this.started = false;
    const unsubscribe = this.unsubscribeStore;
    this.unsubscribeStore = null;
    this.stopDurablePoller();
    const subscriptions = [...this.subscriptions];
    const terminationScopes = [...this.terminationScopesByKey.values()];
    for (const scope of terminationScopes) this.emitTermination(scope, "service_stopped");
    this.subscriptions.clear();
    this.subscriptionsByScope.clear();
    this.subscriptionsByActor.clear();
    this.terminationListenersByScope.clear();
    this.terminationScopesByKey.clear();
    this.terminationListenerCount = 0;
    this.durablePollStates.clear();
    this.coordinators.clear();
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
    this.assertServiceAcceptingSubscriptions();
    const scope = this.normalizeScope(input);
    const actorId = this.normalizeActorId(input.actorId);
    if (typeof listener !== "function") {
      throw new RoomControlPlaneLiveEventServiceError(
        "room_control_plane_live_event_invalid_listener",
        "Room live-event subscriptions require a listener function",
      );
    }
    this.assertEventSubscriptionCapacity(scope, actorId);
    let resolveClosed: (signal: RoomControlPlaneLiveEventServiceClosedSignalV1) => void;
    const closed = new Promise<RoomControlPlaneLiveEventServiceClosedSignalV1>((resolve) => {
      resolveClosed = resolve;
    });
    const initialSequence = normalizeOptionalCursor(input.afterCursor);
    const subscription: Subscription = {
      scope,
      actorId,
      listener,
      resolveClosed: resolveClosed!,
      awaitingReplayWatermark: input.holdUntilReplayWatermark === true,
      initialSequence,
      deliveredSequence: initialSequence,
      pendingNotifications: [],
      pendingOverflowed: false,
    };
    this.addSubscription(subscription);
    if (this.started && !subscription.awaitingReplayWatermark) {
      this.startDurablePoller();
      this.requestDurablePoll(scope, input.afterCursor ?? null);
    }
    let active = true;
    const unsubscribe = (() => {
      if (!active) return;
      active = false;
      this.removeSubscription(subscription);
      if (!this.hasActiveSubscriptions()) this.stopDurablePoller();
    }) as RoomControlPlaneLiveEventSubscriptionV1;
    const activate = (afterCursor: string | null): boolean => {
      if (!active || !subscription.awaitingReplayWatermark || subscription.pendingOverflowed) return false;
      let replaySequence: number | null;
      try {
        replaySequence = normalizeOptionalCursor(afterCursor);
      } catch {
        return false;
      }
      if (
        subscription.initialSequence !== null
        && (replaySequence === null || replaySequence < subscription.initialSequence)
      ) return false;
      subscription.awaitingReplayWatermark = false;
      subscription.deliveredSequence = replaySequence;
      const pending = subscription.pendingNotifications
        .splice(0)
        .sort((left, right) => left.envelope.sequence - right.envelope.sequence);
      for (const notification of pending) this.deliverIfAfterWatermark(subscription, notification);
      if (this.started) {
        this.startDurablePoller();
        this.requestDurablePoll(scope, afterCursor);
      }
      return true;
    };
    Object.defineProperties(unsubscribe, {
      closed: { value: closed },
      activate: { value: activate },
    });
    return unsubscribe;
  }

  subscribeTermination(
    input: RoomControlPlaneLiveEventSubscriptionInputV1,
    listener: RoomControlPlaneLiveEventTerminationListenerV1,
  ): () => void {
    this.assertServiceAcceptingSubscriptions();
    const scope = this.normalizeScope(input);
    if (typeof listener !== "function") {
      throw new RoomControlPlaneLiveEventServiceError(
        "room_control_plane_live_event_invalid_listener",
        "Room live-event termination subscriptions require a listener function",
      );
    }
    this.assertTerminationListenerCapacity(scope);
    const key = scopeKey(scope);
    let listeners = this.terminationListenersByScope.get(key);
    if (!listeners) {
      listeners = new Set<RoomControlPlaneLiveEventTerminationListenerV1>();
      this.terminationListenersByScope.set(key, listeners);
      this.terminationScopesByKey.set(key, scope);
    }
    listeners.add(listener);
    this.terminationListenerCount += 1;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.terminationListenersByScope.get(key);
      if (!current) return;
      if (!current.delete(listener)) return;
      this.terminationListenerCount = Math.max(0, this.terminationListenerCount - 1);
      if (current.size === 0) {
        this.terminationListenersByScope.delete(key);
        this.terminationScopesByKey.delete(key);
      }
    };
  }

  async reconnect(
    input: RoomControlPlaneLiveEventReconnectInputV1,
  ): Promise<RoomLiveEventReconnectResultV1> {
    this.assertServiceAcceptingSubscriptions();
    const scope = this.normalizeScope(input);
    const key = scopeKey(scope);
    try {
      const result = await this.coordinatorFor(scope).reconnect({
        contractVersion: ROOM_LIVE_EVENT_CURSOR_CONTRACT_VERSION,
        authorizedProjectId: this.projectId,
        scope,
        afterCursor: input.afterCursor,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      return immutableSnapshot(result);
    } finally {
      if (!this.subscriptionsByScope.has(key) && !this.durablePollStates.has(key)) {
        this.coordinators.delete(key);
      }
    }
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

  private coordinatorFor(scope: RoomLiveEventScopeV1): RoomLiveEventCursorCoordinator {
    const key = scopeKey(scope);
    const existing = this.coordinators.get(key);
    if (existing) return existing;
    const coordinator = this.createCoordinator();
    this.coordinators.set(key, coordinator);
    return coordinator;
  }

  private addSubscription(subscription: Subscription): void {
    this.subscriptions.add(subscription);
    const key = scopeKey(subscription.scope);
    let scoped = this.subscriptionsByScope.get(key);
    if (!scoped) {
      scoped = new Set<Subscription>();
      this.subscriptionsByScope.set(key, scoped);
    }
    scoped.add(subscription);
    let actorSubscriptions = this.subscriptionsByActor.get(subscription.actorId);
    if (!actorSubscriptions) {
      actorSubscriptions = new Set<Subscription>();
      this.subscriptionsByActor.set(subscription.actorId, actorSubscriptions);
    }
    actorSubscriptions.add(subscription);
  }

  private assertEventSubscriptionCapacity(scope: RoomLiveEventScopeV1, actorId: string): void {
    const scopeCount = this.subscriptionsByScope.get(scopeKey(scope))?.size ?? 0;
    if (scopeCount >= this.maxLiveEventSubscriptionsPerScope) {
      throw new RoomControlPlaneLiveEventServiceError(
        "room_control_plane_live_event_scope_subscription_limit_reached",
        "Room live-event subscriptions are at capacity for this Room scope",
        LIVE_EVENT_SUBSCRIPTION_RETRY_AFTER_MS,
      );
    }
    if (this.subscriptions.size >= this.maxLiveEventSubscriptions) {
      throw new RoomControlPlaneLiveEventServiceError(
        "room_control_plane_live_event_subscription_limit_reached",
        "Room live-event subscriptions are at capacity for this project Engine",
        LIVE_EVENT_SUBSCRIPTION_RETRY_AFTER_MS,
      );
    }
    if ((this.subscriptionsByActor.get(actorId)?.size ?? 0) >= this.maxLiveEventSubscriptionsPerActor) {
      throw new RoomControlPlaneLiveEventServiceError(
        "room_control_plane_live_event_actor_subscription_limit_reached",
        "Room live-event subscriptions are at capacity for this actor",
        LIVE_EVENT_SUBSCRIPTION_RETRY_AFTER_MS,
      );
    }
  }

  private assertTerminationListenerCapacity(scope: RoomLiveEventScopeV1): void {
    const scopeCount = this.terminationListenersByScope.get(scopeKey(scope))?.size ?? 0;
    if (scopeCount >= this.maxLiveEventSubscriptionsPerScope) {
      throw new RoomControlPlaneLiveEventServiceError(
        "room_control_plane_live_event_scope_termination_listener_limit_reached",
        "Room live-event termination listeners are at capacity for this Room scope",
        LIVE_EVENT_SUBSCRIPTION_RETRY_AFTER_MS,
      );
    }
    if (this.terminationListenerCount >= this.maxLiveEventSubscriptions) {
      throw new RoomControlPlaneLiveEventServiceError(
        "room_control_plane_live_event_termination_listener_limit_reached",
        "Room live-event termination listeners are at capacity for this project Engine",
        LIVE_EVENT_SUBSCRIPTION_RETRY_AFTER_MS,
      );
    }
  }

  private removeSubscription(subscription: Subscription): void {
    this.subscriptions.delete(subscription);
    const actorSubscriptions = this.subscriptionsByActor.get(subscription.actorId);
    if (actorSubscriptions !== undefined) {
      actorSubscriptions.delete(subscription);
      if (actorSubscriptions.size === 0) this.subscriptionsByActor.delete(subscription.actorId);
    }
    const key = scopeKey(subscription.scope);
    const scoped = this.subscriptionsByScope.get(key);
    if (!scoped) return;
    scoped.delete(subscription);
    if (scoped.size !== 0) return;
    this.subscriptionsByScope.delete(key);
    const state = this.durablePollStates.get(key);
    if (state !== undefined && state.continuationTimer !== null) clearTimeout(state.continuationTimer);
    this.durablePollStates.delete(key);
    this.coordinators.delete(key);
  }

  private hasActiveSubscriptions(): boolean {
    for (const scoped of this.subscriptionsByScope.values()) {
      if ([...scoped].some((subscription) => !subscription.awaitingReplayWatermark)) return true;
    }
    return false;
  }

  private hasActiveSubscribersForScope(scope: RoomLiveEventScopeV1): boolean {
    const scoped = this.subscriptionsByScope.get(scopeKey(scope));
    return scoped !== undefined && [...scoped].some((subscription) => !subscription.awaitingReplayWatermark);
  }

  private deliverIfAfterWatermark(
    subscription: Subscription,
    notification: RoomControlPlaneLiveEventNotificationV1,
  ): void {
    if (
      subscription.deliveredSequence !== null
      && notification.envelope.sequence <= subscription.deliveredSequence
    ) return;
    subscription.deliveredSequence = notification.envelope.sequence;
    queueMicrotask(() => {
      if (!this.started || !this.subscriptions.has(subscription) || subscription.awaitingReplayWatermark) return;
      this.invokeListener(subscription.listener, notification);
    });
  }

  private startDurablePoller(): void {
    if (this.durablePollTimer !== null) return;
    this.durablePollTimer = setInterval(() => this.requestAllDurablePolls(), this.durablePollIntervalMs);
  }

  private stopDurablePoller(): void {
    if (this.durablePollTimer !== null) {
      clearInterval(this.durablePollTimer);
      this.durablePollTimer = null;
    }
    for (const state of this.durablePollStates.values()) {
      if (state.continuationTimer !== null) clearTimeout(state.continuationTimer);
      state.continuationTimer = null;
      state.scheduled = false;
    }
    this.durablePollQueue.length = 0;
    this.durablePollDrainScheduled = false;
  }

  private requestAllDurablePolls(): void {
    if (!this.started) return;
    for (const subscriptions of this.subscriptionsByScope.values()) {
      const scope = [...subscriptions].find((subscription) => !subscription.awaitingReplayWatermark)?.scope;
      if (scope !== undefined) this.requestDurablePoll(scope);
    }
  }

  private requestDurablePoll(scope: RoomLiveEventScopeV1, initialCursor: string | null = null): void {
    if (!this.started || !this.hasActiveSubscribersForScope(scope)) return;
    const state = this.durablePollStateFor(scope, initialCursor);
    if (state.failed) return;
    state.requested = true;
    // A bounded hasMore continuation has already yielded this scope. Preserve
    // that fairness boundary even if a local commit hint arrives meanwhile.
    if (state.continuationTimer !== null) return;
    this.enqueueDurablePoll(state);
  }

  private enqueueDurablePoll(state: DurablePollState): void {
    if (state.failed || state.inFlight || state.scheduled) return;
    state.scheduled = true;
    this.durablePollQueue.push(state);
    this.scheduleDurablePollDrain();
  }

  private scheduleDurablePollDrain(): void {
    if (this.durablePollDrainScheduled) return;
    this.durablePollDrainScheduled = true;
    queueMicrotask(() => {
      this.durablePollDrainScheduled = false;
      this.drainDurablePollQueue();
    });
  }

  private drainDurablePollQueue(): void {
    while (this.activeDurablePolls < this.maxConcurrentDurablePolls && this.durablePollQueue.length > 0) {
      const state = this.durablePollQueue.shift()!;
      state.scheduled = false;
      if (
        state.failed
        || state.inFlight
        || !this.started
        || !this.hasActiveSubscribersForScope(state.scope)
      ) continue;
      state.inFlight = true;
      state.requested = false;
      this.activeDurablePolls += 1;
      void this.pollDurableScope(state).finally(() => {
        state.inFlight = false;
        this.activeDurablePolls -= 1;
        if (state.requested && this.started && this.hasActiveSubscribersForScope(state.scope)) {
          this.enqueueDurablePoll(state);
        }
        this.scheduleDurablePollDrain();
      });
    }
  }

  private async pollDurableScope(state: DurablePollState): Promise<void> {
    if (!this.started || state.failed || !this.hasActiveSubscribersForScope(state.scope)) return;
    try {
      const page = await this.listCanonicalEventPage({
        contractVersion: ROOM_LIVE_EVENT_CURSOR_CONTRACT_VERSION,
        scope: state.scope,
        afterCursor: state.cursor,
        limit: this.durablePollBatchSize,
      });
      const events = this.validateDurablePage(page, state);
      if (events === null) {
        this.failDurableScope(state, "canonical_page_invalid");
        return;
      }
      for (const event of events) {
        if (!this.started || !this.hasActiveSubscribersForScope(state.scope)) return;
        if (!this.publishCanonicalEvent(event, state.scope)) {
          this.failDurableScope(state, "canonical_page_invalid");
          return;
        }
      }
      if (events.length > 0) state.cursor = events.at(-1)!.cursor;
      if (
        !this.started
        || state.failed
        || this.durablePollStates.get(scopeKey(state.scope)) !== state
        || !this.hasActiveSubscribersForScope(state.scope)
      ) return;
      if (page.hasMore) {
        state.immediatePages += 1;
        if (state.immediatePages < this.maxImmediatePagesPerScope) {
          state.requested = true;
        } else if (state.continuationTimer === null) {
          state.continuationTimer = setTimeout(() => {
            state.continuationTimer = null;
            state.immediatePages = 0;
            this.requestDurablePoll(state.scope);
          }, 0);
        }
      } else {
        state.immediatePages = 0;
      }
    } catch {
      this.failDurableScope(state, "durable_poll_failed");
    }
  }

  private durablePollStateFor(scope: RoomLiveEventScopeV1, initialCursor: string | null): DurablePollState {
    const key = scopeKey(scope);
    const existing = this.durablePollStates.get(key);
    if (existing) return existing;
    const initialSequence = normalizeOptionalCursor(initialCursor);
    const state: DurablePollState = {
      scope: immutableSnapshot(scope),
      cursor: initialSequence === null ? null : String(initialSequence),
      inFlight: false,
      requested: false,
      scheduled: false,
      failed: false,
      immediatePages: 0,
      continuationTimer: null,
    };
    this.durablePollStates.set(key, state);
    return state;
  }

  private validateDurablePage(
    page: { readonly events: readonly RoomEventRecordV1[]; readonly hasMore: boolean },
    state: DurablePollState,
  ): readonly RoomEventRecordV1[] | null {
    if (
      !page
      || typeof page !== "object"
      || !Array.isArray(page.events)
      || typeof page.hasMore !== "boolean"
      || page.events.length > this.durablePollBatchSize
      || (page.hasMore && page.events.length === 0)
    ) return null;
    let previous = state.cursor === null ? null : Number(state.cursor);
    const seenCursors = new Set<string>();
    const seenEventIds = new Set<string>();
    const pageValidator = this.createCoordinator();
    for (const event of page.events) {
      if (
        !event
        || event.projectId !== state.scope.projectId
        || event.roomId !== state.scope.roomId
        || !isCanonicalIdentifier(event.id)
      ) return null;
      let sequence: number | null;
      try {
        sequence = normalizeOptionalCursor(event.cursor);
      } catch {
        return null;
      }
      if (
        sequence === null
        || sequence <= 0
        || (previous !== null && sequence <= previous)
        || seenCursors.has(event.cursor)
        || seenEventIds.has(event.id)
      ) return null;
      previous = sequence;
      seenCursors.add(event.cursor);
      seenEventIds.add(event.id);
      const validation = pageValidator.publish({
        contractVersion: ROOM_LIVE_EVENT_CURSOR_CONTRACT_VERSION,
        source: "canonical_room_event",
        scope: state.scope,
        event,
        streamSequence: null,
      });
      if (!validation.ok || validation.outcome !== "published") return null;
    }
    return page.events;
  }

  private failDurableScope(
    state: DurablePollState,
    reason: "durable_poll_failed" | "canonical_page_invalid",
  ): void {
    if (state.failed) return;
    state.failed = true;
    state.requested = false;
    if (state.continuationTimer !== null) clearTimeout(state.continuationTimer);
    state.continuationTimer = null;
    const subscriptions = [...(this.subscriptionsByScope.get(scopeKey(state.scope)) ?? [])];
    this.emitTermination(state.scope, reason);
    const closedSignal = immutableSnapshot<RoomControlPlaneLiveEventServiceClosedSignalV1>({
      contractVersion: ROOM_CONTROL_PLANE_LIVE_EVENT_SERVICE_CONTRACT_VERSION,
      type: "service_closed",
      reason,
    });
    for (const subscription of subscriptions) {
      this.removeSubscription(subscription);
      subscription.resolveClosed(closedSignal);
    }
    if (!this.hasActiveSubscriptions()) this.stopDurablePoller();
  }

  private emitTermination(
    scope: RoomLiveEventScopeV1,
    reason: "service_stopped" | "durable_poll_failed" | "canonical_page_invalid",
  ): void {
    const signal = immutableSnapshot<RoomControlPlaneLiveEventTerminationSignalV1>({
      contractVersion: ROOM_CONTROL_PLANE_LIVE_EVENT_SERVICE_CONTRACT_VERSION,
      type: "room_live_event_terminated",
      reason,
      scope,
      connection: {
        state: reason === "service_stopped" ? "disconnected" : "degraded",
        reason: reason === "service_stopped"
          ? "engine_live_service_stopped"
          : reason === "durable_poll_failed"
            ? "canonical_durable_poll_failed"
            : "canonical_durable_page_invalid",
        changedAt: null,
      },
      alerts: [{
        code: reason === "service_stopped"
          ? "stream_disconnected"
          : reason === "durable_poll_failed"
            ? "canonical_replay_failed"
            : "canonical_replay_invalid",
        severity: "critical",
        message: "Canonical Room live-event delivery requires reconnect.",
        scope,
        cursor: null,
        expectedStreamSequence: null,
        observedStreamSequence: null,
      }],
    });
    const key = scopeKey(scope);
    const listeners = [...(this.terminationListenersByScope.get(key) ?? [])];
    this.terminationListenersByScope.delete(key);
    this.terminationScopesByKey.delete(key);
    this.terminationListenerCount = Math.max(0, this.terminationListenerCount - listeners.length);
    for (const listener of listeners) {
      try {
        Promise.resolve(listener(signal)).catch(() => undefined);
      } catch {
        // A lifecycle observer cannot interrupt termination of its scope.
      }
    }
  }

  private publishCanonicalEvent(event: RoomEventRecordV1, scope: RoomLiveEventScopeV1): boolean {
    const published = this.coordinatorFor(scope).publish({
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

  private assertServiceAcceptingSubscriptions(): void {
    if (!this.stopped) return;
    throw new RoomControlPlaneLiveEventServiceError(
      "room_control_plane_live_event_service_stopped",
      "Room live-event service has stopped and requires a fresh project Engine boundary",
    );
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

  private normalizeActorId(value: unknown): string {
    if (value === undefined) return INTERNAL_LIVE_EVENT_ACTOR_ID;
    if (!isCanonicalIdentifier(value)) {
      throw new RoomControlPlaneLiveEventServiceError(
        "room_control_plane_live_event_invalid_actor_id",
        "Room live-event subscriptions require a bounded actor identifier",
      );
    }
    return value;
  }

  private notifySubscribers(notification: RoomControlPlaneLiveEventNotificationV1): void {
    const subscriptions = this.subscriptionsByScope.get(scopeKey(notification.scope));
    if (!subscriptions) return;
    for (const subscription of subscriptions) {
      if (subscription.awaitingReplayWatermark) {
        if (
          subscription.initialSequence !== null
          && notification.envelope.sequence <= subscription.initialSequence
        ) continue;
        if (subscription.pendingNotifications.length >= this.maxPendingHandshakeEvents) {
          subscription.pendingOverflowed = true;
          continue;
        }
        subscription.pendingNotifications.push(notification);
        continue;
      }
      this.deliverIfAfterWatermark(subscription, notification);
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

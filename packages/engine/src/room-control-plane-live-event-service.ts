import type { AsyncRoomStore, RoomEventRecordV1 } from "@fusion/core";

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

export type RoomControlPlaneLiveEventListenerV1 = (
  notification: RoomControlPlaneLiveEventNotificationV1,
) => void | Promise<void>;

interface Subscription {
  readonly scope: RoomLiveEventScopeV1;
  readonly listener: RoomControlPlaneLiveEventListenerV1;
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

/**
 * FNXC:RoomControlPlaneLiveEventService 2026-07-19-17:25:
 * `AsyncRoomStore.subscribe()` is a post-commit, process-local latency hint;
 * it can be absent across a restart and must never be treated as the durable
 * Room ledger. Every reconnect is backed by the coordinator's canonical replay
 * port, which reads `AsyncRoomStore.listEvents(roomId, afterCursor, { limit })` and makes
 * replay failure or disorder visible as reconciliation alerts instead of
 * turning a notification cache into authority.
 */
export class RoomControlPlaneLiveEventService {
  private readonly projectId: string;
  private readonly roomStore: AsyncRoomStore;
  private readonly coordinator: RoomLiveEventCursorCoordinator;
  private readonly onListenerError: RoomControlPlaneLiveEventServiceOptionsV1["onListenerError"];
  private readonly subscriptions = new Set<Subscription>();
  private unsubscribeStore: (() => void) | null = null;
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
    this.onListenerError = options.onListenerError;
    const canonicalReplayPort: RoomLiveEventCanonicalReplayPortV1 = {
      listEvents: async (input) => this.listCanonicalEvents(input),
    };
    this.coordinator = new RoomLiveEventCursorCoordinator({
      canonicalReplayPort,
      maxBufferedEvents: options.maxBufferedEvents,
      maxReplayEvents: options.maxReplayEvents,
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    try {
      this.unsubscribeStore = this.roomStore.subscribe((event) => this.handleCommittedEvent(event));
    } catch (error) {
      this.started = false;
      this.unsubscribeStore = null;
      throw error;
    }
  }

  stop(): void {
    if (!this.started && this.unsubscribeStore === null) return;
    this.started = false;
    const unsubscribe = this.unsubscribeStore;
    this.unsubscribeStore = null;
    unsubscribe?.();
  }

  subscribe(
    input: RoomControlPlaneLiveEventSubscriptionInputV1,
    listener: RoomControlPlaneLiveEventListenerV1,
  ): () => void {
    const scope = this.normalizeScope(input);
    if (typeof listener !== "function") {
      throw new RoomControlPlaneLiveEventServiceError(
        "room_control_plane_live_event_invalid_listener",
        "Room live-event subscriptions require a listener function",
      );
    }
    const subscription: Subscription = freezeDeep({ scope, listener });
    this.subscriptions.add(subscription);
    return () => this.subscriptions.delete(subscription);
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

  private async listCanonicalEvents(
    input: Parameters<RoomLiveEventCanonicalReplayPortV1["listEvents"]>[0],
  ): Promise<readonly RoomEventRecordV1[]> {
    if (input.contractVersion !== ROOM_LIVE_EVENT_CURSOR_CONTRACT_VERSION) {
      throw new Error("Room canonical replay port received an unsupported contract version");
    }
    const scope = this.normalizeScope(input.scope);
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
      throw new Error("Room canonical replay port requires a safe positive limit");
    }
    return this.roomStore.listEvents(scope.roomId, input.afterCursor ?? undefined, {
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
    const published = this.coordinator.publish({
      contractVersion: ROOM_LIVE_EVENT_CURSOR_CONTRACT_VERSION,
      source: "canonical_room_event",
      scope: { projectId: this.projectId, roomId: event.roomId },
      event,
      // AsyncRoomStore notifications are post-commit hints, not a sequenced stream.
      streamSequence: null,
    });
    if (!published.ok || published.outcome !== "published") return;
    const notification = immutableSnapshot<RoomControlPlaneLiveEventNotificationV1>({
      contractVersion: ROOM_CONTROL_PLANE_LIVE_EVENT_SERVICE_CONTRACT_VERSION,
      type: "canonical_room_event",
      scope: published.event.scope,
      envelope: published.event,
      connection: published.connection,
      alerts: published.alerts,
    });
    this.notifySubscribers(notification);
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

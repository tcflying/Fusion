import {
  MAX_ROOM_EVENT_LIST_LIMIT,
  type AsyncRoomStore,
  type RoomEventRecordV1,
} from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import {
  RoomControlPlaneLiveEventService,
  RoomControlPlaneLiveEventServiceError,
} from "../room-control-plane-live-event-service.js";

const PROJECT_ID = "project-control-plane-live";
const OTHER_PROJECT_ID = "project-control-plane-other";
const ROOM_ID = "room-control-plane-live";

type StoreListener = (event: RoomEventRecordV1) => void | Promise<void>;

function roomEvent(
  cursor: string,
  overrides: Partial<RoomEventRecordV1> = {},
): RoomEventRecordV1 {
  return {
    contractVersion: 1,
    id: `event-${cursor}`,
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    aggregateVersion: Number(cursor),
    eventType: "room_projection_changed",
    actorType: "controller",
    actorId: "room-controller",
    correlationId: `correlation-${cursor}`,
    causationId: null,
    payload: { cursor },
    occurredAt: `2026-07-19T17:24:${cursor.padStart(2, "0")}.000Z`,
    cursor,
    ...overrides,
  };
}

function createStore(
  replay: (
    roomId: string,
    afterCursor?: string,
    options?: { readonly limit?: number },
  ) => Promise<readonly RoomEventRecordV1[]> = async () => [],
) {
  const listeners = new Set<StoreListener>();
  const subscribe = vi.fn((listener: StoreListener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const listEventPage = vi.fn(async (roomId: string, afterCursor?: string, options?: { readonly limit?: number }) => {
    const events = await replay(roomId, afterCursor, options);
    const visibleEvents = options?.limit === undefined ? events : events.slice(0, options.limit);
    return {
      events: visibleEvents,
      hasMore: options?.limit !== undefined && events.length > visibleEvents.length,
    };
  });

  return {
    store: { subscribe, listEventPage } as unknown as AsyncRoomStore,
    calls: { subscribe, listEventPage },
    async emit(event: RoomEventRecordV1): Promise<void> {
      for (const listener of [...listeners]) await listener(event);
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void;
  let reject: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve: resolve!, reject: reject! };
}

function createPersistentStore() {
  const durableEvents: RoomEventRecordV1[] = [];
  const fixture = createStore(async (roomId, afterCursor) => {
    if (roomId !== ROOM_ID) return [];
    const after = afterCursor === undefined ? 0 : Number(afterCursor);
    return [...durableEvents]
      .filter((event) => Number(event.cursor) > after)
      .sort((left, right) => Number(left.cursor) - Number(right.cursor));
  });

  return {
    ...fixture,
    persist(event: RoomEventRecordV1): void {
      durableEvents.push(event);
    },
  };
}

function reconnect(afterCursor: string | null, limit?: number) {
  return {
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    afterCursor,
    ...(limit === undefined ? {} : { limit }),
  };
}

describe("RoomControlPlaneLiveEventService", () => {
  it("replays a cold Room from the durable project-bound store with bounded immutable snapshots", async () => {
    const durableEvent = roomEvent("1", { payload: { nested: { value: "durable" } } });
    const fixture = createStore(async () => [durableEvent, roomEvent("2"), roomEvent("3")]);
    const service = new RoomControlPlaneLiveEventService({
      projectId: PROJECT_ID,
      roomStore: fixture.store,
      maxBufferedEvents: 2,
      maxReplayEvents: 2,
    });

    const result = await service.reconnect(reconnect(null, 9));

    expect(fixture.calls.listEventPage).toHaveBeenCalledWith(ROOM_ID, undefined, { limit: 2 });
    expect(result).toMatchObject({
      ok: true,
      outcome: "replayed",
      replaySource: "canonical_port",
      nextCursor: "2",
      hasMore: true,
    });
    if (!result.ok) throw new Error("Expected a durable cold replay");
    expect(result.events.map((event) => event.cursor)).toEqual(["1", "2"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.events)).toBe(true);
    expect(Object.isFrozen(result.events[0])).toBe(true);
    expect(Object.isFrozen(result.events[0]?.event.payload)).toBe(true);

    (durableEvent.payload as { nested: { value: string } }).nested.value = "mutated";
    expect((result.events[0]?.event.payload as { nested: { value: string } }).nested.value).toBe("durable");
  });

  it("uses post-commit notifications only as low-latency hints and never fabricates a stream sequence", async () => {
    const fixture = createPersistentStore();
    const service = new RoomControlPlaneLiveEventService({ projectId: PROJECT_ID, roomStore: fixture.store });
    const received: string[] = [];
    service.subscribe({ projectId: PROJECT_ID, roomId: ROOM_ID }, (notification) => {
      received.push(notification.envelope.eventId);
      expect(notification.envelope.streamSequence).toBeNull();
    });

    service.start();
    const event = roomEvent("1");
    fixture.persist(event);
    await fixture.emit(event);
    await flushMicrotasks();

    expect(fixture.calls.subscribe).toHaveBeenCalledTimes(1);
    expect(received).toEqual(["event-1"]);
    service.stop();
  });

  it("discovers a cross-process durable commit through a bounded poll, catches every available page immediately, keeps local hints low-latency, and does not duplicate", async () => {
    vi.useFakeTimers();
    const fixture = createPersistentStore();
    const service = new RoomControlPlaneLiveEventService({
      projectId: PROJECT_ID,
      roomStore: fixture.store,
      durablePollIntervalMs: 1_000,
      maxReplayEvents: 1,
    });
    const received: string[] = [];
    service.subscribe({ projectId: PROJECT_ID, roomId: ROOM_ID }, (notification) => {
      received.push(notification.envelope.eventId);
    });

    try {
      service.start();
      await flushMicrotasks();

      fixture.persist(roomEvent("1"));
      fixture.persist(roomEvent("2"));
      await vi.advanceTimersByTimeAsync(999);
      expect(received).toEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(received).toEqual(["event-1", "event-2"]);
      expect(fixture.calls.listEventPage).toHaveBeenLastCalledWith(ROOM_ID, "1", { limit: 1 });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(received).toEqual(["event-1", "event-2"]);
      expect(fixture.calls.listEventPage).toHaveBeenLastCalledWith(ROOM_ID, "2", { limit: 1 });

      const third = roomEvent("3");
      fixture.persist(third);
      await fixture.emit(third);
      await flushMicrotasks();
      expect(received).toEqual(["event-1", "event-2", "event-3"]);

      await fixture.emit(third);
      await flushMicrotasks();
      expect(received).toEqual(["event-1", "event-2", "event-3"]);
    } finally {
      service.stop();
      vi.useRealTimers();
    }
  });

  it("suppresses canonical history at or before each subscription cursor while sharing one durable scope", async () => {
    const fixture = createPersistentStore();
    fixture.persist(roomEvent("1"));
    fixture.persist(roomEvent("2"));
    fixture.persist(roomEvent("3"));
    const service = new RoomControlPlaneLiveEventService({ projectId: PROJECT_ID, roomStore: fixture.store });
    const afterOne: string[] = [];
    const afterTwo: string[] = [];

    service.subscribe({ projectId: PROJECT_ID, roomId: ROOM_ID, afterCursor: "1" }, (notification) => {
      afterOne.push(notification.envelope.eventId);
    });
    service.subscribe({ projectId: PROJECT_ID, roomId: ROOM_ID, afterCursor: "2" }, (notification) => {
      afterTwo.push(notification.envelope.eventId);
    });
    service.start();
    await flushMicrotasks();

    expect(afterOne).toEqual(["event-2", "event-3"]);
    expect(afterTwo).toEqual(["event-3"]);
    expect(fixture.calls.listEventPage).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it("keeps a replay-watermark subscription out of durable polling until canonical replay activates it", async () => {
    const fixture = createPersistentStore();
    for (const cursor of ["1", "2", "3", "4", "5"]) fixture.persist(roomEvent(cursor));
    const service = new RoomControlPlaneLiveEventService({ projectId: PROJECT_ID, roomStore: fixture.store });
    const received: string[] = [];

    service.start();
    const subscription = service.subscribe({
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      afterCursor: "4",
      holdUntilReplayWatermark: true,
    }, (notification) => {
      received.push(notification.envelope.eventId);
    });
    await flushMicrotasks();

    expect(fixture.calls.listEventPage).not.toHaveBeenCalled();
    const canonicalReplay = await service.reconnect(reconnect("4"));
    if (!canonicalReplay.ok) throw new Error("Expected a canonical replay page");
    expect(canonicalReplay.events.map((event) => event.cursor)).toEqual(["5"]);
    expect(received).toEqual([]);

    expect(subscription.activate(canonicalReplay.nextCursor)).toBe(true);
    await flushMicrotasks();
    expect(received).toEqual([]);

    const sixth = roomEvent("6");
    fixture.persist(sixth);
    await fixture.emit(sixth);
    await flushMicrotasks();
    expect(received).toEqual(["event-6"]);
    service.stop();
  });

  it("validates each durable page atomically before any event or cursor can advance", async () => {
    const malformedSecondEvent = roomEvent("2", { eventType: " " });
    const listEventPage = vi.fn(async () => ({
      events: [roomEvent("1"), malformedSecondEvent],
      hasMore: false,
    }));
    const store = {
      subscribe: vi.fn(() => () => undefined),
      listEventPage,
    } as unknown as AsyncRoomStore;
    const service = new RoomControlPlaneLiveEventService({ projectId: PROJECT_ID, roomStore: store });
    const received = vi.fn();
    const terminated = vi.fn();
    const subscription = service.subscribe({ projectId: PROJECT_ID, roomId: ROOM_ID }, received);
    service.subscribeTermination({ projectId: PROJECT_ID, roomId: ROOM_ID }, terminated);

    service.start();
    await flushMicrotasks();

    expect(received).not.toHaveBeenCalled();
    expect(listEventPage).toHaveBeenCalledTimes(1);
    expect(listEventPage).toHaveBeenCalledWith(ROOM_ID, undefined, { limit: 128 });
    expect(terminated).toHaveBeenCalledWith(expect.objectContaining({
      reason: "canonical_page_invalid",
      scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
    }));
    await expect(subscription.closed).resolves.toEqual({
      contractVersion: 1,
      type: "service_closed",
      reason: "canonical_page_invalid",
    });
    service.stop();
  });

  it("fails an out-of-order durable page before it can emit its first record", async () => {
    const listEventPage = vi.fn(async () => ({
      events: [roomEvent("2"), roomEvent("1")],
      hasMore: false,
    }));
    const store = {
      subscribe: vi.fn(() => () => undefined),
      listEventPage,
    } as unknown as AsyncRoomStore;
    const service = new RoomControlPlaneLiveEventService({ projectId: PROJECT_ID, roomStore: store });
    const received = vi.fn();
    const subscription = service.subscribe({ projectId: PROJECT_ID, roomId: ROOM_ID }, received);

    service.start();
    await flushMicrotasks();

    expect(received).not.toHaveBeenCalled();
    expect(listEventPage).toHaveBeenCalledWith(ROOM_ID, undefined, { limit: 128 });
    await expect(subscription.closed).resolves.toEqual({
      contractVersion: 1,
      type: "service_closed",
      reason: "canonical_page_invalid",
    });
    service.stop();
  });

  it("uses bounded fair durable polling across scopes and releases a scope after its last unsubscribe", async () => {
    const roomA = ROOM_ID;
    const roomB = "room-control-plane-live-b";
    const roomC = "room-control-plane-live-c";
    const pending = new Map<string, ReturnType<typeof deferred<{ readonly events: readonly RoomEventRecordV1[]; readonly hasMore: boolean }>>>();
    let inFlight = 0;
    let peakInFlight = 0;
    const listEventPage = vi.fn((roomId: string) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      const page = deferred<{ readonly events: readonly RoomEventRecordV1[]; readonly hasMore: boolean }>();
      pending.set(roomId, page);
      return page.promise.finally(() => {
        inFlight -= 1;
      });
    });
    const store = {
      subscribe: vi.fn(() => () => undefined),
      listEventPage,
    } as unknown as AsyncRoomStore;
    const service = new RoomControlPlaneLiveEventService({
      projectId: PROJECT_ID,
      roomStore: store,
      maxConcurrentDurablePolls: 2,
    });
    const unsubscribeA = service.subscribe({ projectId: PROJECT_ID, roomId: roomA }, () => undefined);
    service.subscribe({ projectId: PROJECT_ID, roomId: roomB }, () => undefined);
    service.subscribe({ projectId: PROJECT_ID, roomId: roomC }, () => undefined);

    service.start();
    await flushMicrotasks();
    expect(listEventPage).toHaveBeenCalledTimes(2);
    expect(peakInFlight).toBe(2);

    pending.get(roomA)?.resolve({ events: [], hasMore: false });
    pending.get(roomB)?.resolve({ events: [], hasMore: false });
    await flushMicrotasks();
    expect(listEventPage).toHaveBeenCalledTimes(3);
    expect(peakInFlight).toBe(2);

    pending.get(roomC)?.resolve({ events: [], hasMore: false });
    await flushMicrotasks();
    unsubscribeA();
    service.stop();
  });

  it("bounds total and per-scope subscriptions while allowing a released permit to reconnect", () => {
    const fixture = createPersistentStore();
    const service = new RoomControlPlaneLiveEventService({
      projectId: PROJECT_ID,
      roomStore: fixture.store,
      maxLiveEventSubscriptions: 2,
      maxLiveEventSubscriptionsPerScope: 1,
    });
    const first = service.subscribe({ projectId: PROJECT_ID, roomId: ROOM_ID }, () => undefined);

    try {
      expect(() => service.subscribe({ projectId: PROJECT_ID, roomId: ROOM_ID }, () => undefined)).toThrowError(
        expect.objectContaining({
          code: "room_control_plane_live_event_scope_subscription_limit_reached",
          retryAfterMs: 1_000,
        }),
      );
      const second = service.subscribe({ projectId: PROJECT_ID, roomId: "room-control-plane-live-b" }, () => undefined);
      try {
        expect(() => service.subscribe({ projectId: PROJECT_ID, roomId: "room-control-plane-live-c" }, () => undefined)).toThrowError(
          expect.objectContaining({
            code: "room_control_plane_live_event_subscription_limit_reached",
            retryAfterMs: 1_000,
          }),
        );
      } finally {
        second();
      }
    } finally {
      first();
    }

    expect(() => service.subscribe({ projectId: PROJECT_ID, roomId: "room-control-plane-live-c" }, () => undefined)).not.toThrow();
    service.stop();
  });

  it("bounds subscriptions per actor across Room scopes and releases that actor lease on cancellation", () => {
    const fixture = createPersistentStore();
    const service = new RoomControlPlaneLiveEventService({
      projectId: PROJECT_ID,
      roomStore: fixture.store,
      maxLiveEventSubscriptions: 3,
      maxLiveEventSubscriptionsPerScope: 3,
      maxLiveEventSubscriptionsPerActor: 1,
    });
    const first = service.subscribe({
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      actorId: "operator-a",
    }, () => undefined);

    try {
      expect(() => service.subscribe({
        projectId: PROJECT_ID,
        roomId: "room-control-plane-live-b",
        actorId: "operator-a",
      }, () => undefined)).toThrowError(expect.objectContaining({
        code: "room_control_plane_live_event_actor_subscription_limit_reached",
        retryAfterMs: 1_000,
      }));
      expect(() => service.subscribe({
        projectId: PROJECT_ID,
        roomId: "room-control-plane-live-b",
        actorId: "operator-b",
      }, () => undefined)).not.toThrow();
    } finally {
      first();
    }

    expect(() => service.subscribe({
      projectId: PROJECT_ID,
      roomId: "room-control-plane-live-c",
      actorId: "operator-a",
    }, () => undefined)).not.toThrow();
    service.stop();
  });

  it("releases a total subscription permit after a scoped durable termination", async () => {
    const fixture = createStore(async () => {
      throw new Error("database unavailable");
    });
    const service = new RoomControlPlaneLiveEventService({
      projectId: PROJECT_ID,
      roomStore: fixture.store,
      maxLiveEventSubscriptions: 1,
      maxLiveEventSubscriptionsPerScope: 1,
    });
    const initial = service.subscribe({ projectId: PROJECT_ID, roomId: ROOM_ID }, () => undefined);
    const termination = vi.fn();
    service.subscribeTermination({ projectId: PROJECT_ID, roomId: ROOM_ID }, termination);

    try {
      expect(() => service.subscribe({ projectId: PROJECT_ID, roomId: "room-control-plane-live-b" }, () => undefined)).toThrowError(
        expect.objectContaining({ code: "room_control_plane_live_event_subscription_limit_reached" }),
      );
      service.start();
      await flushMicrotasks();

      await expect(initial.closed).resolves.toMatchObject({ reason: "durable_poll_failed" });
      expect(termination).toHaveBeenCalledWith(expect.objectContaining({ reason: "durable_poll_failed" }));
      expect(() => service.subscribe({ projectId: PROJECT_ID, roomId: "room-control-plane-live-b" }, () => undefined)).not.toThrow();
    } finally {
      service.stop();
    }
  });

  it("fails closed when a captured live service was stopped before a route can subscribe or replay", async () => {
    const fixture = createPersistentStore();
    const service = new RoomControlPlaneLiveEventService({ projectId: PROJECT_ID, roomStore: fixture.store });
    service.start();
    service.stop();

    expect(() => service.subscribe({ projectId: PROJECT_ID, roomId: ROOM_ID }, () => undefined))
      .toThrowError(expect.objectContaining({ code: "room_control_plane_live_event_service_stopped" }));
    await expect(service.reconnect(reconnect(null))).rejects.toMatchObject({
      code: "room_control_plane_live_event_service_stopped",
    });
  });

  it("resolves a subscription close signal even when the typed termination listener immediately cleans up", async () => {
    const fixture = createStore(async () => {
      throw new Error("database unavailable");
    });
    const service = new RoomControlPlaneLiveEventService({ projectId: PROJECT_ID, roomStore: fixture.store });
    const subscription = service.subscribe({ projectId: PROJECT_ID, roomId: ROOM_ID }, () => undefined);
    let unsubscribeTermination: (() => void) | undefined;
    unsubscribeTermination = service.subscribeTermination({ projectId: PROJECT_ID, roomId: ROOM_ID }, () => {
      subscription();
      unsubscribeTermination?.();
    });

    service.start();
    await flushMicrotasks();

    await expect(subscription.closed).resolves.toMatchObject({ reason: "durable_poll_failed" });
    service.stop();
  });

  it("forgets an unsubscribed scope so a later subscription starts from its own durable cursor", async () => {
    const fixture = createPersistentStore();
    fixture.persist(roomEvent("1"));
    fixture.persist(roomEvent("2"));
    const service = new RoomControlPlaneLiveEventService({ projectId: PROJECT_ID, roomStore: fixture.store });
    const afterOne: string[] = [];
    const first = service.subscribe({ projectId: PROJECT_ID, roomId: ROOM_ID, afterCursor: "1" }, (notification) => {
      afterOne.push(notification.envelope.eventId);
    });

    service.start();
    await flushMicrotasks();
    expect(afterOne).toEqual(["event-2"]);
    first();

    const coldReconnect: string[] = [];
    service.subscribe({ projectId: PROJECT_ID, roomId: ROOM_ID, afterCursor: null }, (notification) => {
      coldReconnect.push(notification.envelope.eventId);
    });
    await flushMicrotasks();

    expect(coldReconnect).toEqual(["event-1", "event-2"]);
    expect(fixture.calls.listEventPage).toHaveBeenLastCalledWith(ROOM_ID, undefined, { limit: 128 });
    service.stop();
  });

  it("resolves a non-sensitive service-closed signal for every active subscription before clearing delivery", async () => {
    const fixture = createPersistentStore();
    const service = new RoomControlPlaneLiveEventService({ projectId: PROJECT_ID, roomStore: fixture.store });
    const received: string[] = [];
    const first = service.subscribe({ projectId: PROJECT_ID, roomId: ROOM_ID }, (notification) => {
      received.push(notification.envelope.eventId);
    });
    const second = service.subscribe({ projectId: PROJECT_ID, roomId: ROOM_ID }, () => undefined);
    const firstTermination = vi.fn();
    const secondTermination = vi.fn();
    service.subscribeTermination({ projectId: PROJECT_ID, roomId: ROOM_ID }, firstTermination);
    service.subscribeTermination({ projectId: PROJECT_ID, roomId: ROOM_ID }, secondTermination);

    expect(first).toHaveProperty("closed");
    expect(second).toHaveProperty("closed");
    service.start();
    const event = roomEvent("1");
    fixture.persist(event);
    await fixture.emit(event);
    service.stop();

    await expect(first.closed).resolves.toEqual({
      contractVersion: 1,
      type: "service_closed",
      reason: "service_closed",
    });
    await expect(second.closed).resolves.toEqual({
      contractVersion: 1,
      type: "service_closed",
      reason: "service_closed",
    });
    expect(firstTermination).toHaveBeenCalledWith(expect.objectContaining({
      contractVersion: 1,
      type: "room_live_event_terminated",
      reason: "service_stopped",
      scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
      connection: { state: "disconnected", reason: "engine_live_service_stopped", changedAt: null },
      alerts: [expect.objectContaining({ code: "stream_disconnected", severity: "critical" })],
    }));
    expect(secondTermination).toHaveBeenCalledWith(expect.objectContaining({
      type: "room_live_event_terminated",
      reason: "service_stopped",
      scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
    }));
    await flushMicrotasks();
    expect(received).toEqual([]);

    fixture.persist(roomEvent("2"));
    await fixture.emit(roomEvent("2"));
    await flushMicrotasks();
    expect(received).toEqual([]);
  });

  it("signals a scoped lifecycle observer on stop even when no event listener remains", () => {
    const fixture = createPersistentStore();
    const service = new RoomControlPlaneLiveEventService({ projectId: PROJECT_ID, roomStore: fixture.store });
    const termination = vi.fn();
    service.subscribeTermination({ projectId: PROJECT_ID, roomId: ROOM_ID }, termination);

    service.stop();

    expect(termination).toHaveBeenCalledWith(expect.objectContaining({
      contractVersion: 1,
      type: "room_live_event_terminated",
      reason: "service_stopped",
      scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
      connection: { state: "disconnected", reason: "engine_live_service_stopped", changedAt: null },
    }));
  });

  it("signals a scoped typed termination and closes event delivery when durable polling fails", async () => {
    const fixture = createStore(async () => {
      throw new Error("database unavailable");
    });
    const service = new RoomControlPlaneLiveEventService({ projectId: PROJECT_ID, roomStore: fixture.store });
    const listener = vi.fn();
    const subscription = service.subscribe({ projectId: PROJECT_ID, roomId: ROOM_ID, afterCursor: null }, listener);
    const termination = vi.fn();
    service.subscribeTermination({ projectId: PROJECT_ID, roomId: ROOM_ID }, termination);

    service.start();
    await flushMicrotasks();

    expect(termination).toHaveBeenCalledWith(expect.objectContaining({
      contractVersion: 1,
      type: "room_live_event_terminated",
      reason: "durable_poll_failed",
      scope: { projectId: PROJECT_ID, roomId: ROOM_ID },
      connection: { state: "degraded", reason: "canonical_durable_poll_failed", changedAt: null },
      alerts: [expect.objectContaining({ code: "canonical_replay_failed", severity: "critical" })],
    }));
    await expect(subscription.closed).resolves.toEqual({
      contractVersion: 1,
      type: "service_closed",
      reason: "durable_poll_failed",
    });
    expect(listener).not.toHaveBeenCalled();
    service.stop();
  });

  it("does not let a partial notification cache hide earlier durable events during reconnect", async () => {
    const fixture = createStore(async () => [roomEvent("1"), roomEvent("2")]);
    const service = new RoomControlPlaneLiveEventService({ projectId: PROJECT_ID, roomStore: fixture.store });

    service.start();
    await fixture.emit(roomEvent("2"));

    const result = await service.reconnect(reconnect(null));

    expect(fixture.calls.listEventPage).toHaveBeenCalledWith(ROOM_ID, undefined, { limit: 128 });
    expect(result).toMatchObject({ ok: true, outcome: "replayed", replaySource: "canonical_port" });
    if (!result.ok) throw new Error("Expected durable replay after a notification hint");
    expect(result.events.map((event) => event.cursor)).toEqual(["1", "2"]);
    service.stop();
  });

  it("passes a capped old cursor replay limit into the durable store instead of slicing a full history", async () => {
    const fixture = createStore(async (roomId, afterCursor, options) => {
      expect(roomId).toBe(ROOM_ID);
      expect(afterCursor).toBe("7");
      expect(options).toEqual({ limit: 2 });
      return [roomEvent("8"), roomEvent("9")];
    });
    const service = new RoomControlPlaneLiveEventService({
      projectId: PROJECT_ID,
      roomStore: fixture.store,
      maxBufferedEvents: 2,
      maxReplayEvents: 2,
    });

    const result = await service.reconnect(reconnect("7", 99));

    expect(fixture.calls.listEventPage).toHaveBeenCalledTimes(1);
    expect(fixture.calls.listEventPage).toHaveBeenCalledWith(ROOM_ID, "7", { limit: 2 });
    expect(result).toMatchObject({ ok: true, outcome: "replayed", nextCursor: "9", hasMore: false });
  });

  it("rejects a replay configuration that Core cannot serve", () => {
    const fixture = createStore();

    expect(() => new RoomControlPlaneLiveEventService({
      projectId: PROJECT_ID,
      roomStore: fixture.store,
      maxBufferedEvents: MAX_ROOM_EVENT_LIST_LIMIT + 1,
      maxReplayEvents: MAX_ROOM_EVENT_LIST_LIMIT + 1,
    })).toThrow(`maxReplayEvents cannot exceed ${MAX_ROOM_EVENT_LIST_LIMIT}`);
  });

  it("keeps listener failures isolated, allows listener unsubscription, and stops delivery idempotently", async () => {
    const fixture = createPersistentStore();
    const listenerErrors = vi.fn();
    const service = new RoomControlPlaneLiveEventService({
      projectId: PROJECT_ID,
      roomStore: fixture.store,
      onListenerError: listenerErrors,
    });
    const received: string[] = [];
    service.subscribe({ projectId: PROJECT_ID, roomId: ROOM_ID }, () => {
      throw new Error("dashboard listener failed");
    });
    const unsubscribe = service.subscribe({ projectId: PROJECT_ID, roomId: ROOM_ID }, (notification) => {
      received.push(notification.envelope.eventId);
    });

    service.start();
    const firstEvent = roomEvent("1");
    fixture.persist(firstEvent);
    await expect(fixture.emit(firstEvent)).resolves.toBeUndefined();
    await flushMicrotasks();
    expect(received).toEqual(["event-1"]);
    expect(listenerErrors).toHaveBeenCalledTimes(1);

    unsubscribe();
    const secondEvent = roomEvent("2");
    fixture.persist(secondEvent);
    await fixture.emit(secondEvent);
    await flushMicrotasks();
    expect(received).toEqual(["event-1"]);

    const thirdEvent = roomEvent("3");
    fixture.persist(thirdEvent);
    await fixture.emit(thirdEvent);
    service.stop();
    service.stop();
    await flushMicrotasks();
    const fourthEvent = roomEvent("4");
    fixture.persist(fourthEvent);
    await fixture.emit(fourthEvent);
    await flushMicrotasks();

    expect(fixture.calls.subscribe).toHaveBeenCalledTimes(1);
    expect(received).toEqual(["event-1"]);
  });

  it("fails closed before subscription or durable replay for invalid or foreign Room scope", async () => {
    const fixture = createStore();
    const service = new RoomControlPlaneLiveEventService({ projectId: PROJECT_ID, roomStore: fixture.store });
    const listener = vi.fn();

    expect(() => service.subscribe({ projectId: OTHER_PROJECT_ID, roomId: ROOM_ID }, listener))
      .toThrowError(RoomControlPlaneLiveEventServiceError);
    expect(fixture.calls.subscribe).not.toHaveBeenCalled();

    await expect(service.reconnect({ ...reconnect(null), projectId: OTHER_PROJECT_ID }))
      .rejects.toMatchObject<Partial<RoomControlPlaneLiveEventServiceError>>({
        code: "room_control_plane_live_event_project_scope_mismatch",
      });
    await expect(service.reconnect({ ...reconnect(null), roomId: " " }))
      .rejects.toMatchObject<Partial<RoomControlPlaneLiveEventServiceError>>({
        code: "room_control_plane_live_event_invalid_room_id",
      });
    expect(fixture.calls.listEventPage).not.toHaveBeenCalled();

    service.subscribe({ projectId: PROJECT_ID, roomId: ROOM_ID }, listener);
    service.start();
    await fixture.emit(roomEvent("2", { projectId: OTHER_PROJECT_ID }));
    await flushMicrotasks();
    expect(listener).not.toHaveBeenCalled();
    service.stop();
  });

  it("returns reconciliation and a coordinator alert when durable replay fails or is not canonically ordered", async () => {
    const unavailable = createStore(async () => {
      throw new Error("database unavailable");
    });
    const unavailableService = new RoomControlPlaneLiveEventService({
      projectId: PROJECT_ID,
      roomStore: unavailable.store,
    });

    await expect(unavailableService.reconnect(reconnect(null))).resolves.toMatchObject({
      ok: true,
      outcome: "reconciliation_required",
      alerts: [expect.objectContaining({ code: "canonical_replay_failed" })],
    });

    const unordered = createStore(async () => [roomEvent("2"), roomEvent("1")]);
    const unorderedService = new RoomControlPlaneLiveEventService({
      projectId: PROJECT_ID,
      roomStore: unordered.store,
    });

    await expect(unorderedService.reconnect(reconnect(null))).resolves.toMatchObject({
      ok: true,
      outcome: "reconciliation_required",
      alerts: [expect.objectContaining({ code: "canonical_replay_invalid" })],
    });
  });
});

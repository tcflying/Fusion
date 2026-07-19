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

  it("discovers a cross-process durable commit through a bounded poll, keeps local hints low-latency, and does not duplicate", async () => {
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
      expect(received).toEqual(["event-1"]);
      expect(fixture.calls.listEventPage).toHaveBeenLastCalledWith(ROOM_ID, undefined, { limit: 1 });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(received).toEqual(["event-1", "event-2"]);
      expect(fixture.calls.listEventPage).toHaveBeenLastCalledWith(ROOM_ID, "1", { limit: 1 });

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

  it("resolves a non-sensitive service-closed signal for every active subscription before clearing delivery", async () => {
    const fixture = createPersistentStore();
    const service = new RoomControlPlaneLiveEventService({ projectId: PROJECT_ID, roomStore: fixture.store });
    const received: string[] = [];
    const first = service.subscribe({ projectId: PROJECT_ID, roomId: ROOM_ID }, (notification) => {
      received.push(notification.envelope.eventId);
    });
    const second = service.subscribe({ projectId: PROJECT_ID, roomId: ROOM_ID }, () => undefined);

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
    await flushMicrotasks();
    expect(received).toEqual([]);

    fixture.persist(roomEvent("2"));
    await fixture.emit(roomEvent("2"));
    await flushMicrotasks();
    expect(received).toEqual([]);
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

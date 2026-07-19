import type { AsyncRoomStore, RoomEventRecordV1 } from "@fusion/core";
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
  replay: (roomId: string, afterCursor?: string) => Promise<readonly RoomEventRecordV1[]> = async () => [],
) {
  const listeners = new Set<StoreListener>();
  const subscribe = vi.fn((listener: StoreListener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  const listEvents = vi.fn(replay);

  return {
    store: { subscribe, listEvents } as unknown as AsyncRoomStore,
    calls: { subscribe, listEvents },
    async emit(event: RoomEventRecordV1): Promise<void> {
      for (const listener of [...listeners]) await listener(event);
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
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

    expect(fixture.calls.listEvents).toHaveBeenCalledWith(ROOM_ID, undefined);
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
    const fixture = createStore();
    const service = new RoomControlPlaneLiveEventService({ projectId: PROJECT_ID, roomStore: fixture.store });
    const received: string[] = [];
    service.subscribe({ projectId: PROJECT_ID, roomId: ROOM_ID }, (notification) => {
      received.push(notification.envelope.eventId);
      expect(notification.envelope.streamSequence).toBeNull();
    });

    service.start();
    await fixture.emit(roomEvent("1"));
    await flushMicrotasks();

    expect(fixture.calls.subscribe).toHaveBeenCalledTimes(1);
    expect(received).toEqual(["event-1"]);
  });

  it("does not let a partial notification cache hide earlier durable events during reconnect", async () => {
    const fixture = createStore(async () => [roomEvent("1"), roomEvent("2")]);
    const service = new RoomControlPlaneLiveEventService({ projectId: PROJECT_ID, roomStore: fixture.store });

    service.start();
    await fixture.emit(roomEvent("2"));

    const result = await service.reconnect(reconnect(null));

    expect(fixture.calls.listEvents).toHaveBeenCalledWith(ROOM_ID, undefined);
    expect(result).toMatchObject({ ok: true, outcome: "replayed", replaySource: "canonical_port" });
    if (!result.ok) throw new Error("Expected durable replay after a notification hint");
    expect(result.events.map((event) => event.cursor)).toEqual(["1", "2"]);
  });

  it("keeps listener failures isolated, allows listener unsubscription, and stops delivery idempotently", async () => {
    const fixture = createStore();
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
    await expect(fixture.emit(roomEvent("1"))).resolves.toBeUndefined();
    await flushMicrotasks();
    expect(received).toEqual(["event-1"]);
    expect(listenerErrors).toHaveBeenCalledTimes(1);

    unsubscribe();
    await fixture.emit(roomEvent("2"));
    await flushMicrotasks();
    expect(received).toEqual(["event-1"]);

    await fixture.emit(roomEvent("3"));
    service.stop();
    service.stop();
    await flushMicrotasks();
    await fixture.emit(roomEvent("4"));
    await flushMicrotasks();

    expect(fixture.calls.subscribe).toHaveBeenCalledTimes(1);
    expect(received).toEqual(["event-1"]);
  });

  it("fails closed before subscription or durable replay for invalid or foreign Room scope", async () => {
    const fixture = createStore(async () => [roomEvent("1")]);
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
    expect(fixture.calls.listEvents).not.toHaveBeenCalled();

    service.subscribe({ projectId: PROJECT_ID, roomId: ROOM_ID }, listener);
    service.start();
    await fixture.emit(roomEvent("2", { projectId: OTHER_PROJECT_ID }));
    await flushMicrotasks();
    expect(listener).not.toHaveBeenCalled();
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

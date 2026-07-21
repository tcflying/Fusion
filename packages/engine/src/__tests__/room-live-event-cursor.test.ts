import { describe, expect, it, vi } from "vitest";

import type { RoomEventRecordV1 } from "@fusion/core";

import {
  RoomLiveEventCursorCoordinator,
  type RoomLiveEventCanonicalReplayPortV1,
  type RoomLiveEventPublishInputV1,
} from "../room-live-event-cursor.js";

const SCOPE = { projectId: "project-live-events", roomId: "room-live-events" } as const;
const OTHER_SCOPE = { projectId: "project-other", roomId: "room-live-events" } as const;

function roomEvent(
  cursor: string,
  overrides: Partial<RoomEventRecordV1> = {},
): RoomEventRecordV1 {
  return {
    contractVersion: 1,
    id: `event-${cursor}`,
    projectId: SCOPE.projectId,
    roomId: SCOPE.roomId,
    aggregateVersion: Number(cursor),
    eventType: "room_projection_changed",
    actorType: "controller",
    actorId: "controller-live-events",
    correlationId: `correlation-${cursor}`,
    causationId: null,
    payload: { cursor },
    occurredAt: `2026-07-19T15:18:${cursor.padStart(2, "0")}.000Z`,
    cursor,
    ...overrides,
  };
}

function publishInput(
  event: RoomEventRecordV1,
  streamSequence: number | null = Number(event.cursor),
): RoomLiveEventPublishInputV1 {
  return {
    contractVersion: 1,
    source: "canonical_room_event",
    scope: SCOPE,
    event,
    streamSequence,
  };
}

function reconnect(afterCursor: string | null, limit?: number) {
  return {
    contractVersion: 1 as const,
    authorizedProjectId: SCOPE.projectId,
    scope: SCOPE,
    afterCursor,
    ...(limit === undefined ? {} : { limit }),
  };
}

describe("RoomLiveEventCursorCoordinator", () => {
  it("publishes immutable canonical events and serves a project-room-scoped bounded reconnect replay", async () => {
    const coordinator = new RoomLiveEventCursorCoordinator({
      maxBufferedEvents: 4,
      maxReplayEvents: 2,
    });

    expect(coordinator.publish(publishInput(roomEvent("1")))).toMatchObject({
      ok: true,
      outcome: "published",
      event: { cursor: "1", sequence: 1, scope: SCOPE },
    });
    expect(coordinator.publish(publishInput(roomEvent("2")))).toMatchObject({
      ok: true,
      outcome: "published",
      event: { cursor: "2", sequence: 2, scope: SCOPE },
    });
    expect(coordinator.publish(publishInput(roomEvent("3")))).toMatchObject({
      ok: true,
      outcome: "published",
      event: { cursor: "3", sequence: 3, scope: SCOPE },
    });

    const result = await coordinator.reconnect(reconnect("1", 1));

    expect(result).toMatchObject({
      ok: true,
      outcome: "replayed",
      replaySource: "memory",
      nextCursor: "2",
      hasMore: true,
    });
    if (!result.ok) throw new Error("Expected a reconnect replay");
    expect(result.events.map((event) => event.cursor)).toEqual(["2"]);
    expect(Object.isFrozen(result.events[0])).toBe(true);
  });

  it("keeps a disconnect visible and refuses to advance a stream across a detected source sequence gap", async () => {
    const coordinator = new RoomLiveEventCursorCoordinator();
    coordinator.publish(publishInput(roomEvent("1"), 1));

    const disconnected = coordinator.disconnect({
      contractVersion: 1,
      source: "canonical_event_source",
      authorizedProjectId: SCOPE.projectId,
      scope: SCOPE,
      occurredAt: "2026-07-19T15:19:00.000Z",
      reason: "connector stream closed before the next committed event",
    });
    expect(disconnected).toMatchObject({
      ok: true,
      connection: { state: "disconnected" },
      alerts: [expect.objectContaining({ code: "stream_disconnected" })],
    });

    const gap = coordinator.publish(publishInput(roomEvent("3"), 3));
    expect(gap).toMatchObject({
      ok: false,
      outcome: "rejected",
      reason: { code: "source_sequence_gap" },
    });
    expect(gap.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "source_sequence_gap" }),
    ]));

    const reconnectResult = await coordinator.reconnect(reconnect("1"));
    expect(reconnectResult).toMatchObject({
      ok: true,
      outcome: "reconciliation_required",
      connection: { state: "degraded" },
    });
    if (!reconnectResult.ok) throw new Error("Expected a reconciliation requirement");
    expect(reconnectResult.alerts).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "source_sequence_gap" }),
    ]));
  });

  it("rejects cross-project reads and malformed ingress instead of treating a worker self-report as canonical", async () => {
    const coordinator = new RoomLiveEventCursorCoordinator();
    const crossScopeIngress = coordinator.publish({
      ...publishInput(roomEvent("1")),
      scope: OTHER_SCOPE,
    });
    expect(crossScopeIngress).toMatchObject({
      ok: false,
      outcome: "rejected",
      reason: { code: "event_scope_mismatch" },
    });

    const workerSelfReport = coordinator.publish({
      ...publishInput(roomEvent("1")),
      source: "worker_self_report" as never,
    });
    expect(workerSelfReport).toMatchObject({
      ok: false,
      outcome: "rejected",
      reason: { code: "untrusted_source" },
    });

    const crossProjectReplay = await coordinator.reconnect({
      ...reconnect(null),
      authorizedProjectId: OTHER_SCOPE.projectId,
    });
    expect(crossProjectReplay).toMatchObject({
      ok: false,
      outcome: "rejected",
      reason: { code: "cross_project_forbidden" },
    });
  });

  it("deduplicates an identical canonical record and refuses stale or conflicting records without overwriting the replay window", async () => {
    const coordinator = new RoomLiveEventCursorCoordinator();
    const original = roomEvent("4");
    expect(coordinator.publish(publishInput(original, 4))).toMatchObject({ ok: true, outcome: "published" });

    expect(coordinator.publish(publishInput(original, 4))).toMatchObject({
      ok: true,
      outcome: "duplicate",
    });
    expect(coordinator.publish(publishInput(roomEvent("3"), 3))).toMatchObject({
      ok: false,
      reason: { code: "stale_cursor" },
    });
    expect(coordinator.publish(publishInput(roomEvent("4", { id: "event-conflicting-cursor" }), 5))).toMatchObject({
      ok: false,
      reason: { code: "cursor_conflict" },
    });

    const result = await coordinator.reconnect(reconnect(null));
    if (!result.ok) throw new Error("Expected replay after rejected duplicates");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({ eventId: original.id, cursor: "4" });
  });

  it("uses durable canonical replay for a Room the process has not observed in memory", async () => {
    const canonicalReplay = vi.fn(async () => ({ events: [roomEvent("7")], hasMore: false }));
    const coordinator = new RoomLiveEventCursorCoordinator({
      canonicalReplayPort: { listEventPage: canonicalReplay },
      maxBufferedEvents: 2,
      maxReplayEvents: 2,
    });

    const result = await coordinator.reconnect(reconnect(null, 1));

    expect(canonicalReplay).toHaveBeenCalledWith({
      contractVersion: 1,
      scope: SCOPE,
      afterCursor: null,
      limit: 1,
    });
    expect(result).toMatchObject({
      ok: true,
      outcome: "replayed",
      replaySource: "canonical_port",
      nextCursor: "7",
    });
    if (!result.ok) throw new Error("Expected durable replay for a cold Room");
    expect(result.events.map((event) => event.eventId)).toEqual(["event-7"]);
  });

  it("keeps the canonical replay port as a paged contract instead of inferring continuation from event count", async () => {
    const canonicalReplay = vi.fn(async () => ({ events: [], hasMore: true }));
    const port = { listEventPage: canonicalReplay } satisfies RoomLiveEventCanonicalReplayPortV1;
    const coordinator = new RoomLiveEventCursorCoordinator({
      canonicalReplayPort: port,
      maxBufferedEvents: 2,
      maxReplayEvents: 2,
    });

    const result = await coordinator.reconnect(reconnect(null, 2));

    expect(canonicalReplay).toHaveBeenCalledWith({
      contractVersion: 1,
      scope: SCOPE,
      afterCursor: null,
      limit: 2,
    });
    expect(result).toMatchObject({ ok: true, replaySource: "canonical_port", hasMore: true });
  });

  it("uses the injected canonical replay port after bounded cache overflow and exposes the overflow alert to an SSE/dashboard consumer", async () => {
    const canonicalReplay = vi.fn(async () => ({ events: [roomEvent("1"), roomEvent("2")], hasMore: true }));
    const port: RoomLiveEventCanonicalReplayPortV1 = { listEventPage: canonicalReplay };
    const coordinator = new RoomLiveEventCursorCoordinator({
      canonicalReplayPort: port,
      maxBufferedEvents: 2,
      maxReplayEvents: 2,
    });
    coordinator.publish(publishInput(roomEvent("1"), 1));
    coordinator.publish(publishInput(roomEvent("2"), 2));
    coordinator.publish(publishInput(roomEvent("3"), 3));

    const result = await coordinator.reconnect(reconnect(null, 9));

    expect(canonicalReplay).toHaveBeenCalledWith({
      contractVersion: 1,
      scope: SCOPE,
      afterCursor: null,
      limit: 2,
    });
    expect(result).toMatchObject({
      ok: true,
      outcome: "replayed",
      replaySource: "canonical_port",
      hasMore: true,
      alerts: [expect.objectContaining({ code: "replay_window_overflow" })],
    });
    if (!result.ok) throw new Error("Expected canonical fallback replay");
    expect(result.events.map((event) => event.eventId)).toEqual(["event-1", "event-2"]);
  });
});

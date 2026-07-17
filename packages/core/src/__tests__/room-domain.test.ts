import { describe, expect, it } from "vitest";

import {
  RoomDomainError,
  addRoomSeat,
  applyRoomMembershipChangesAtTurnBoundary,
  attachRoomBinding,
  beginRoomTurn,
  createRoomAggregate,
  requestRoomBindingReplacement,
  settleRoomTurn,
  transitionRoomLifecycle,
} from "../room-domain.js";

const NOW = "2026-07-17T01:00:00.000Z";

function newDraftRoom() {
  return createRoomAggregate({
    id: "room-domain-1",
    projectId: "project-1",
    objective: "Coordinate existing Sessions",
    protocolId: "implementation",
    protocolVersion: 1,
    now: NOW,
  });
}

function expectDomainErrorCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(RoomDomainError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected RoomDomainError with code ${code}`);
}

function addSeatAndBinding() {
  const draft = newDraftRoom();
  const withSeat = addRoomSeat(draft, {
    id: "seat-1",
    role: "producer",
    permissionScope: ["workspace:read", "workspace:write"],
    expectedAggregateVersion: draft.room.aggregateVersion,
    now: NOW,
  });
  return attachRoomBinding(withSeat, {
    id: "binding-1",
    seatId: "seat-1",
    connectorId: "happier",
    providerId: "codex",
    nativeSessionId: "codex-thread-1",
    happierSessionId: "happier-session-1",
    serverProfileId: "server-1",
    machineId: "machine-1",
    hostId: "windows-host-1",
    expectedAggregateVersion: withSeat.room.aggregateVersion,
    now: NOW,
  });
}

describe("operational Room domain", () => {
  it("creates a project-scoped draft and advances lifecycle with optimistic aggregate versions", () => {
    const draft = newDraftRoom();

    expect(draft.room).toMatchObject({
      id: "room-domain-1",
      projectId: "project-1",
      state: "draft",
      aggregateVersion: 0,
    });
    expect(draft.membershipVersion).toBe(0);
    expect(draft.seats).toEqual([]);
    expect(draft.bindings).toEqual([]);

    const ready = transitionRoomLifecycle(draft, {
      to: "ready",
      expectedAggregateVersion: 0,
      now: "2026-07-17T01:01:00.000Z",
    });

    expect(ready.room.state).toBe("ready");
    expect(ready.room.aggregateVersion).toBe(1);
    expect(draft.room.state).toBe("draft");
    expectDomainErrorCode(
      () =>
        transitionRoomLifecycle(ready, {
          to: "running",
          expectedAggregateVersion: 0,
          now: "2026-07-17T01:02:00.000Z",
        }),
      "aggregate_version_conflict",
    );
  });

  it("rejects invalid lifecycle jumps and cannot reopen a terminal outcome", () => {
    const draft = newDraftRoom();
    expectDomainErrorCode(
      () =>
        transitionRoomLifecycle(draft, {
          to: "completed",
          expectedAggregateVersion: 0,
          now: NOW,
        }),
      "invalid_lifecycle_transition",
    );

    const ready = transitionRoomLifecycle(draft, {
      to: "ready",
      expectedAggregateVersion: 0,
      now: NOW,
    });
    const running = transitionRoomLifecycle(ready, {
      to: "running",
      expectedAggregateVersion: 1,
      now: NOW,
    });
    const completed = transitionRoomLifecycle(running, {
      to: "completed",
      expectedAggregateVersion: 2,
      now: NOW,
    });

    expectDomainErrorCode(
      () =>
        transitionRoomLifecycle(completed, {
          to: "running",
          expectedAggregateVersion: 3,
          now: NOW,
        }),
      "terminal_state_immutable",
    );
    const archived = transitionRoomLifecycle(completed, {
      to: "archived",
      expectedAggregateVersion: 3,
      now: NOW,
    });
    expect(archived.room.state).toBe("archived");
    expectDomainErrorCode(
      () =>
        transitionRoomLifecycle(archived, {
          to: "completed",
          expectedAggregateVersion: 4,
          now: NOW,
        }),
      "terminal_state_immutable",
    );
  });

  it("supports arbitrary stable participant seats without provider identity leakage", () => {
    let aggregate = newDraftRoom();
    for (const [id, role] of [
      ["seat-codex", "producer"],
      ["seat-claude", "reviewer"],
      ["seat-opencode", "arbiter"],
    ] as const) {
      aggregate = addRoomSeat(aggregate, {
        id,
        role,
        permissionScope: ["room:message"],
        expectedAggregateVersion: aggregate.room.aggregateVersion,
        now: NOW,
      });
    }

    expect(aggregate.room.id).toBe("room-domain-1");
    expect(aggregate.seats.map((seat) => seat.id)).toEqual(["seat-codex", "seat-claude", "seat-opencode"]);
    expect(aggregate.seats.every((seat) => seat.activeBindingId === null)).toBe(true);
    expect(aggregate.seats.every((seat) => seat.roomId === aggregate.room.id)).toBe(true);
    expectDomainErrorCode(
      () =>
        addRoomSeat(aggregate, {
          id: "seat-codex",
          role: "duplicate",
          permissionScope: [],
          expectedAggregateVersion: aggregate.room.aggregateVersion,
          now: NOW,
        }),
      "seat_identity_conflict",
    );
  });

  it("preserves immutable binding generations when a Session is replaced", () => {
    const attached = addSeatAndBinding();
    const ready = transitionRoomLifecycle(attached, {
      to: "ready",
      expectedAggregateVersion: attached.room.aggregateVersion,
      now: NOW,
    });
    const running = transitionRoomLifecycle(ready, {
      to: "running",
      expectedAggregateVersion: ready.room.aggregateVersion,
      now: NOW,
    });
    const turn = beginRoomTurn(running, {
      id: "turn-1",
      sequence: 1,
      protocolPhaseId: "produce",
      expectedAggregateVersion: running.room.aggregateVersion,
      now: NOW,
    });
    const requested = requestRoomBindingReplacement(turn, {
      changeId: "membership-change-1",
      seatId: "seat-1",
      replacement: {
        id: "binding-2",
        connectorId: "happier",
        providerId: "claude-code",
        nativeSessionId: "claude-session-2",
        happierSessionId: "happier-session-2",
        serverProfileId: "server-1",
        machineId: "machine-2",
        hostId: "windows-host-1",
      },
      reason: "producer process was lost",
      expectedAggregateVersion: turn.room.aggregateVersion,
      requestedAt: NOW,
    });

    expect(requested.bindings).toHaveLength(1);
    expect(requested.bindings[0]).toMatchObject({
      id: "binding-1",
      generation: 1,
      nativeSessionId: "codex-thread-1",
      state: "attached",
    });
    expect(requested.pendingMembershipChanges).toHaveLength(1);

    const settled = settleRoomTurn(requested, {
      turnId: "turn-1",
      outcome: "completed",
      expectedAggregateVersion: requested.room.aggregateVersion,
      now: NOW,
    });
    const activated = applyRoomMembershipChangesAtTurnBoundary(settled, {
      turnId: "turn-1",
      expectedAggregateVersion: settled.room.aggregateVersion,
      now: NOW,
    });

    expect(activated.membershipVersion).toBe(1);
    expect(activated.pendingMembershipChanges).toEqual([]);
    expect(activated.bindings).toHaveLength(2);
    expect(activated.bindings[0]).toMatchObject({
      id: "binding-1",
      generation: 1,
      state: "replaced",
      replacedByBindingId: "binding-2",
    });
    expect(activated.bindings[1]).toMatchObject({
      id: "binding-2",
      generation: 2,
      providerId: "claude-code",
      nativeSessionId: "claude-session-2",
      state: "attached",
    });
    expect(activated.seats[0]?.activeBindingId).toBe("binding-2");
  });

  it("cannot activate a requested membership mutation inside an active turn", () => {
    const attached = addSeatAndBinding();
    const ready = transitionRoomLifecycle(attached, {
      to: "ready",
      expectedAggregateVersion: attached.room.aggregateVersion,
      now: NOW,
    });
    const running = transitionRoomLifecycle(ready, {
      to: "running",
      expectedAggregateVersion: ready.room.aggregateVersion,
      now: NOW,
    });
    const turn = beginRoomTurn(running, {
      id: "turn-1",
      sequence: 1,
      protocolPhaseId: "produce",
      expectedAggregateVersion: running.room.aggregateVersion,
      now: NOW,
    });
    const requested = requestRoomBindingReplacement(turn, {
      changeId: "membership-change-1",
      seatId: "seat-1",
      replacement: {
        id: "binding-2",
        connectorId: "happier",
        providerId: "opencode",
        nativeSessionId: "opencode-session-2",
        happierSessionId: "happier-session-2",
        serverProfileId: "server-1",
        machineId: "machine-2",
        hostId: "windows-host-1",
      },
      reason: "replace at boundary",
      expectedAggregateVersion: turn.room.aggregateVersion,
      requestedAt: NOW,
    });

    expectDomainErrorCode(
      () =>
        applyRoomMembershipChangesAtTurnBoundary(requested, {
          turnId: "turn-1",
          expectedAggregateVersion: requested.room.aggregateVersion,
          now: NOW,
        }),
      "turn_boundary_required",
    );
    expect(requested.seats[0]?.activeBindingId).toBe("binding-1");
    expect(requested.bindings).toHaveLength(1);
  });
});

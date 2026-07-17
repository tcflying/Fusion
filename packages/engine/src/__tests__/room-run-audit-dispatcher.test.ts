import type {
  RoomRunAuditOutboxEvent,
  RoomRunAuditOutboxRecordV1,
} from "@fusion/core";
import { describe, expect, it, vi } from "vitest";
import {
  RoomRunAuditDispatcher,
  type RoomRunAuditOutboxStore,
} from "../room-run-audit-dispatcher.js";

type MutableRecord = {
  -readonly [K in keyof RoomRunAuditOutboxRecordV1]: RoomRunAuditOutboxRecordV1[K];
};

class MemoryOutboxStore implements RoomRunAuditOutboxStore {
  readonly records = new Map<string, MutableRecord>();
  failNextDeliveredMark = false;
  private nextDispatchSequence = 1;

  async enqueueRunAuditEvent(event: RoomRunAuditOutboxEvent): Promise<RoomRunAuditOutboxRecordV1> {
    const existing = this.records.get(event.id);
    if (existing) return existing;
    const record: MutableRecord = {
      id: event.id,
      dispatchSequence: this.nextDispatchSequence,
      projectId: event.projectId,
      roomId: event.target,
      event,
      state: "pending",
      attemptCount: 0,
      nextAttemptAt: null,
      claimToken: null,
      claimExpiresAt: null,
      lastErrorCode: null,
      deliveredAt: null,
      createdAt: event.timestamp,
      updatedAt: event.timestamp,
    };
    this.nextDispatchSequence += 1;
    this.records.set(event.id, record);
    return record;
  }

  async claimRunAuditEvents(input: {
    readonly claimToken: string;
    readonly now: string;
    readonly claimExpiresAt: string;
    readonly limit: number;
  }): Promise<readonly RoomRunAuditOutboxRecordV1[]> {
    const due = [...this.records.values()]
      .filter((record) => (
        record.state === "pending"
          ? !record.nextAttemptAt || record.nextAttemptAt <= input.now
          : record.state === "dispatching"
            && Boolean(record.claimExpiresAt && record.claimExpiresAt <= input.now)
      ))
      .filter((record) => ![...this.records.values()].some((earlier) => (
        earlier.roomId === record.roomId
        && earlier.dispatchSequence < record.dispatchSequence
        && earlier.state !== "delivered"
        && earlier.state !== "exhausted"
      )))
      .sort((left, right) => left.dispatchSequence - right.dispatchSequence)
      .slice(0, input.limit);
    for (const record of due) {
      record.state = "dispatching";
      record.attemptCount += 1;
      record.claimToken = input.claimToken;
      record.claimExpiresAt = input.claimExpiresAt;
      record.updatedAt = input.now;
    }
    return due;
  }

  async markRunAuditEventDelivered(input: {
    readonly id: string;
    readonly claimToken: string;
    readonly now: string;
  }): Promise<RoomRunAuditOutboxRecordV1> {
    if (this.failNextDeliveredMark) {
      this.failNextDeliveredMark = false;
      throw new Error("simulated process loss after sink commit");
    }
    const record = this.claimed(input.id, input.claimToken);
    record.state = "delivered";
    record.claimToken = null;
    record.claimExpiresAt = null;
    record.nextAttemptAt = null;
    record.deliveredAt = input.now;
    record.updatedAt = input.now;
    return record;
  }

  async markRunAuditEventFailed(input: {
    readonly id: string;
    readonly claimToken: string;
    readonly now: string;
    readonly errorCode: string;
    readonly nextAttemptAt: string | null;
    readonly exhausted: boolean;
  }): Promise<RoomRunAuditOutboxRecordV1> {
    const record = this.claimed(input.id, input.claimToken);
    record.state = input.exhausted ? "exhausted" : "pending";
    record.claimToken = null;
    record.claimExpiresAt = null;
    record.lastErrorCode = input.errorCode;
    record.nextAttemptAt = input.nextAttemptAt;
    record.updatedAt = input.now;
    return record;
  }

  private claimed(id: string, claimToken: string): MutableRecord {
    const record = this.records.get(id);
    if (!record || record.state !== "dispatching" || record.claimToken !== claimToken) {
      throw new Error("claim fence rejected");
    }
    return record;
  }
}

function auditEvent(id: string): RoomRunAuditOutboxEvent {
  return {
    id,
    projectId: "project-1",
    timestamp: "2026-07-17T15:00:00.000Z",
    agentId: "room-worker-1",
    runId: "room-controller:test",
    domain: "database",
    mutationType: "room:worker-started",
    target: "room-1",
    metadata: { roomId: "room-1", leaseEpoch: 1 },
  };
}

describe("RoomRunAuditDispatcher", () => {
  it("replays a durable event on startup and marks it delivered", async () => {
    const store = new MemoryOutboxStore();
    await store.enqueueRunAuditEvent(auditEvent("audit-startup-replay"));
    const sink = vi.fn(async () => undefined);
    const dispatcher = new RoomRunAuditDispatcher({
      store,
      sink,
      now: () => "2026-07-17T15:00:01.000Z",
      pollIntervalMs: 60_000,
    });

    await dispatcher.start();
    await dispatcher.stop();

    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ id: "audit-startup-replay" }));
    expect(store.records.get("audit-startup-replay")).toMatchObject({
      state: "delivered",
      attemptCount: 1,
      claimToken: null,
    });
  });

  it("persists before delivery and retries a failed sink only after durable backoff", async () => {
    const store = new MemoryOutboxStore();
    let now = "2026-07-17T15:00:00.000Z";
    const sink = vi.fn()
      .mockRejectedValueOnce(new Error("sink unavailable"))
      .mockResolvedValue(undefined);
    const dispatcher = new RoomRunAuditDispatcher({
      store,
      sink,
      now: () => now,
      retryBaseDelayMs: 1_000,
      pollIntervalMs: 60_000,
    });
    await dispatcher.start();

    await dispatcher.enqueue(auditEvent("audit-retry"));
    await dispatcher.drainNow();
    expect(store.records.get("audit-retry")).toMatchObject({
      state: "pending",
      attemptCount: 1,
      nextAttemptAt: "2026-07-17T15:00:01.000Z",
    });

    await dispatcher.drainNow();
    expect(sink).toHaveBeenCalledTimes(1);
    now = "2026-07-17T15:00:01.000Z";
    await dispatcher.drainNow();
    await dispatcher.stop();

    expect(sink).toHaveBeenCalledTimes(2);
    expect(store.records.get("audit-retry")).toMatchObject({
      state: "delivered",
      attemptCount: 2,
      nextAttemptAt: null,
    });
  });

  it("re-delivers the same id after a process loses the acknowledgement mark", async () => {
    const store = new MemoryOutboxStore();
    await store.enqueueRunAuditEvent(auditEvent("audit-ack-loss"));
    store.failNextDeliveredMark = true;
    let now = "2026-07-17T15:00:00.000Z";
    const sink = vi.fn(async () => undefined);
    const dispatcher = new RoomRunAuditDispatcher({
      store,
      sink,
      now: () => now,
      claimLeaseMs: 1_000,
      pollIntervalMs: 60_000,
    });

    await expect(dispatcher.start()).rejects.toThrow("simulated process loss");
    expect(store.records.get("audit-ack-loss")).toMatchObject({
      state: "dispatching",
      attemptCount: 1,
    });

    now = "2026-07-17T15:00:01.000Z";
    await dispatcher.start();
    await dispatcher.stop();

    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ id: "audit-ack-loss" }));
    expect(store.records.get("audit-ack-loss")).toMatchObject({
      state: "delivered",
      attemptCount: 2,
    });
  });

  it("coalesces concurrent drain requests so one claimant delivers an event once", async () => {
    const store = new MemoryOutboxStore();
    await store.enqueueRunAuditEvent(auditEvent("audit-concurrent-drain"));
    const sink = vi.fn(async () => undefined);
    const dispatcher = new RoomRunAuditDispatcher({
      store,
      sink,
      now: () => "2026-07-17T15:00:01.000Z",
      pollIntervalMs: 60_000,
    });

    await Promise.all([
      dispatcher.drainNow(),
      dispatcher.drainNow(),
      dispatcher.drainNow(),
    ]);

    expect(sink).toHaveBeenCalledTimes(1);
    expect(store.records.get("audit-concurrent-drain")).toMatchObject({
      state: "delivered",
      attemptCount: 1,
    });
  });

  it("makes an exhausted failure visible after the bounded attempt count", async () => {
    const store = new MemoryOutboxStore();
    let now = "2026-07-17T15:00:00.000Z";
    const dispatcher = new RoomRunAuditDispatcher({
      store,
      sink: async () => Promise.reject(new Error("sink unavailable")),
      now: () => now,
      maxAttempts: 2,
      retryBaseDelayMs: 1_000,
      pollIntervalMs: 60_000,
    });
    await dispatcher.start();
    await dispatcher.enqueue(auditEvent("audit-exhausted"));
    await dispatcher.drainNow();
    now = "2026-07-17T15:00:01.000Z";
    await dispatcher.drainNow();
    await dispatcher.stop();

    expect(store.records.get("audit-exhausted")).toMatchObject({
      state: "exhausted",
      attemptCount: 2,
      nextAttemptAt: null,
      lastErrorCode: "audit_sink_failed",
    });
  });

  it("turns a synchronous sink throw into a durable exhausted record", async () => {
    const store = new MemoryOutboxStore();
    const dispatcher = new RoomRunAuditDispatcher({
      store,
      sink: () => {
        throw new Error("synchronous sink failure");
      },
      now: () => "2026-07-17T15:00:00.000Z",
      maxAttempts: 1,
      pollIntervalMs: 60_000,
    });
    await dispatcher.start();
    await dispatcher.enqueue(auditEvent("audit-sync-throw"));
    await dispatcher.drainNow();
    await dispatcher.stop();

    expect(store.records.get("audit-sync-throw")).toMatchObject({
      state: "exhausted",
      attemptCount: 1,
      lastErrorCode: "audit_sink_failed",
    });
  });

  it("bounds a hanging sink and leaves durable retry state", async () => {
    const store = new MemoryOutboxStore();
    const dispatcher = new RoomRunAuditDispatcher({
      store,
      sink: () => new Promise(() => undefined),
      now: () => "2026-07-17T15:00:00.000Z",
      attemptTimeoutMs: 5,
      retryBaseDelayMs: 1_000,
      pollIntervalMs: 60_000,
    });
    await dispatcher.start();
    await dispatcher.enqueue(auditEvent("audit-timeout"));
    await dispatcher.drainNow();
    await dispatcher.stop();

    expect(store.records.get("audit-timeout")).toMatchObject({
      state: "pending",
      attemptCount: 1,
      nextAttemptAt: "2026-07-17T15:00:01.000Z",
      lastErrorCode: "audit_sink_failed",
    });
  });
});

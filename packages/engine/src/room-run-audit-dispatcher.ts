import type {
  RoomRunAuditOutboxEvent,
  RoomRunAuditOutboxRecordV1,
} from "@fusion/core";
import { randomUUID } from "node:crypto";

export interface RoomRunAuditOutboxStore {
  enqueueRunAuditEvent(event: RoomRunAuditOutboxEvent): Promise<RoomRunAuditOutboxRecordV1>;
  claimRunAuditEvents(input: {
    readonly claimToken: string;
    readonly now: string;
    readonly claimExpiresAt: string;
    readonly limit: number;
  }): Promise<readonly RoomRunAuditOutboxRecordV1[]>;
  markRunAuditEventDelivered(input: {
    readonly id: string;
    readonly claimToken: string;
    readonly now: string;
  }): Promise<RoomRunAuditOutboxRecordV1>;
  markRunAuditEventFailed(input: {
    readonly id: string;
    readonly claimToken: string;
    readonly now: string;
    readonly errorCode: string;
    readonly nextAttemptAt: string | null;
    readonly exhausted: boolean;
  }): Promise<RoomRunAuditOutboxRecordV1>;
}

export interface RoomRunAuditDispatcherOptions {
  readonly store: RoomRunAuditOutboxStore;
  readonly sink: (event: RoomRunAuditOutboxEvent) => Promise<unknown>;
  readonly now?: () => string;
  readonly createClaimToken?: () => string;
  readonly pollIntervalMs?: number;
  readonly claimLeaseMs?: number;
  readonly attemptTimeoutMs?: number;
  readonly retryBaseDelayMs?: number;
  readonly retryMaxDelayMs?: number;
  readonly maxAttempts?: number;
  readonly batchSize?: number;
  readonly onError?: (message: string) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_CLAIM_LEASE_MS = 30_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 10;
const DEFAULT_BATCH_SIZE = 50;

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`RoomRunAuditDispatcher ${name} must be a positive safe integer`);
  }
  return value;
}

function timestampPlus(timestamp: string, milliseconds: number): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    throw new Error("RoomRunAuditDispatcher now() must return an ISO timestamp");
  }
  return new Date(parsed + milliseconds).toISOString();
}

/**
 * Durable Room lifecycle audit delivery.
 *
 * The controller only returns after enqueueing the immutable event. Sink
 * delivery is then claimed from PostgreSQL, so process loss can at worst cause
 * an idempotent re-delivery of the same event id after the claim expires.
 */
export class RoomRunAuditDispatcher {
  private readonly now: () => string;
  private readonly createClaimToken: () => string;
  private readonly pollIntervalMs: number;
  private readonly claimLeaseMs: number;
  private readonly attemptTimeoutMs: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly maxAttempts: number;
  private readonly batchSize: number;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private drainInFlight: Promise<void> | null = null;
  private drainRequested = false;
  private started = false;

  constructor(private readonly options: RoomRunAuditDispatcherOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.createClaimToken = options.createClaimToken ?? randomUUID;
    this.pollIntervalMs = positiveSafeInteger(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "pollIntervalMs",
    );
    this.claimLeaseMs = positiveSafeInteger(
      options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS,
      "claimLeaseMs",
    );
    this.attemptTimeoutMs = positiveSafeInteger(
      options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS,
      "attemptTimeoutMs",
    );
    this.retryBaseDelayMs = positiveSafeInteger(
      options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
      "retryBaseDelayMs",
    );
    this.retryMaxDelayMs = positiveSafeInteger(
      options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS,
      "retryMaxDelayMs",
    );
    this.maxAttempts = positiveSafeInteger(
      options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      "maxAttempts",
    );
    this.batchSize = positiveSafeInteger(
      options.batchSize ?? DEFAULT_BATCH_SIZE,
      "batchSize",
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      await this.drainNow();
      this.pollTimer = setInterval(() => {
        void this.drainNow().catch((error) => this.reportError("poll", error));
      }, this.pollIntervalMs);
      this.pollTimer.unref?.();
    } catch (error) {
      this.started = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (!this.started && !this.drainInFlight) return;
    try {
      await this.drainNow();
    } finally {
      this.started = false;
    }
  }

  async enqueue(event: RoomRunAuditOutboxEvent): Promise<void> {
    await this.options.store.enqueueRunAuditEvent(event);
    if (this.started) {
      void this.drainNow().catch((error) => this.reportError("enqueue", error));
    }
  }

  async drainNow(): Promise<void> {
    this.drainRequested = true;
    if (this.drainInFlight) return this.drainInFlight;
    const operation = this.drainLoop().finally(() => {
      if (this.drainInFlight === operation) this.drainInFlight = null;
    });
    this.drainInFlight = operation;
    return operation;
  }

  private async drainLoop(): Promise<void> {
    do {
      this.drainRequested = false;
      let claimedCount: number;
      do {
        claimedCount = await this.dispatchBatch();
      } while (claimedCount === this.batchSize);
    } while (this.drainRequested);
  }

  private async dispatchBatch(): Promise<number> {
    const claimToken = this.createClaimToken();
    const claimTime = this.now();
    const records = await this.options.store.claimRunAuditEvents({
      claimToken,
      now: claimTime,
      claimExpiresAt: timestampPlus(claimTime, this.claimLeaseMs),
      limit: this.batchSize,
    });
    await Promise.all(records.map((record) => this.dispatchRecord(record, claimToken)));
    return records.length;
  }

  private async dispatchRecord(
    record: RoomRunAuditOutboxRecordV1,
    claimToken: string,
  ): Promise<void> {
    let sinkAttempt: Promise<unknown>;
    try {
      sinkAttempt = Promise.resolve(this.options.sink(record.event));
    } catch (error) {
      sinkAttempt = Promise.reject(error);
    }
    const delivered = await this.settlesWithinBudget(
      sinkAttempt,
      this.attemptTimeoutMs,
    );
    const completedAt = this.now();
    if (delivered) {
      await this.options.store.markRunAuditEventDelivered({
        id: record.id,
        claimToken,
        now: completedAt,
      });
      return;
    }

    const exhausted = record.attemptCount >= this.maxAttempts;
    const exponent = Math.max(0, Math.min(record.attemptCount - 1, 30));
    const retryDelayMs = Math.min(
      this.retryMaxDelayMs,
      this.retryBaseDelayMs * (2 ** exponent),
    );
    await this.options.store.markRunAuditEventFailed({
      id: record.id,
      claimToken,
      now: completedAt,
      errorCode: "audit_sink_failed",
      nextAttemptAt: exhausted ? null : timestampPlus(completedAt, retryDelayMs),
      exhausted,
    });
    this.options.onError?.(
      exhausted
        ? `Room run-audit delivery exhausted: id=${record.id} attempts=${record.attemptCount}`
        : `Room run-audit delivery deferred: id=${record.id} attempt=${record.attemptCount}`,
    );
  }

  private async settlesWithinBudget(promise: Promise<unknown>, budgetMs: number): Promise<boolean> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const outcome = await Promise.race([
      promise.then(() => true, () => false),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), budgetMs);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    return outcome;
  }

  private reportError(stage: string, error: unknown): void {
    const code = error instanceof Error && error.name ? error.name : "unknown_error";
    this.options.onError?.(`Room run-audit dispatcher ${stage} failed: code=${code}`);
  }
}

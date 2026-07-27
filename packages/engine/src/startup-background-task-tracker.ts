/*
 * FNXC:StartupRecoveryShutdownDrain 2026-07-27-07:10:
 * FUS-P1-009 moves bounded startup-work ownership out of the high-churn in-process runtime. Track each recovery promise until settlement, surface failures through the runtime logger, and give shutdown a bounded drain without hiding work that outlives the deadline.
 */
export interface StartupBackgroundTaskTrackerEvents {
  onFailure(label: string, error: unknown): void;
  onTimeout(timeoutMs: number, pendingCount: number): void;
}

export class StartupBackgroundTaskTracker {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly events: StartupBackgroundTaskTrackerEvents) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  track(label: string, operation: Promise<unknown>): void {
    const tracked = operation
      .then(() => undefined)
      .catch((error) => {
        this.events.onFailure(label, error);
      })
      .finally(() => {
        this.pending.delete(tracked);
      });
    this.pending.add(tracked);
  }

  async drain(timeoutMs: number): Promise<void> {
    if (this.pending.size === 0) {
      return;
    }

    const pending = Promise.allSettled([...this.pending]).then(() => "settled" as const);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timed_out">((resolve) => {
      timeout = setTimeout(() => resolve("timed_out"), timeoutMs);
    });
    const result = await Promise.race([pending, timedOut]);
    if (timeout) clearTimeout(timeout);

    if (result === "timed_out") {
      this.events.onTimeout(timeoutMs, this.pending.size);
    }
  }
}

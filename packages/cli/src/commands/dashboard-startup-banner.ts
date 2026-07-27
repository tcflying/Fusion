export interface DashboardAuthBannerInput {
  readonly baseUrl: string;
  readonly dashboardAuthToken?: string;
}

export function maskDashboardAuthToken(token: string): string {
  if (token.length < 4) return "****";
  return `****${token.slice(-4)}`;
}

/*
FNXC:DashboardAuthBanner 2026-07-27-16:43:
Authenticated non-TTY startup output is commonly redirected into durable logs.
It must never print the bearer value, an Authorization header, or a URL carrying
the token. A deterministic masked suffix lets operators distinguish configured
credentials without exposing the bearer value; the full credential remains
available only through the explicit owner-only settings/clipboard path.
*/
export function formatDashboardAuthBannerLines(
  input: DashboardAuthBannerInput,
): string[] {
  const lines = [`  → ${input.baseUrl}`];
  if (!input.dashboardAuthToken) {
    lines.push("  Auth:    disabled (--no-auth)");
    return lines;
  }

  lines.push(
    "  Auth:    bearer token required",
    `  Token:   ${maskDashboardAuthToken(input.dashboardAuthToken)} (retrieve through owner-only Fusion settings)`,
  );
  return lines;
}

export type DashboardEngineMode =
  | "active"
  | "paused"
  | "no-engine"
  | "withheld"
  | "degraded";

export interface DashboardRuntimeReadinessInput {
  readonly noEngine: boolean;
  readonly paused: boolean;
  readonly engineRunning: boolean;
  readonly startupFailed: boolean;
  readonly roomExecutionStates: readonly string[];
}

/*
FNXC:DashboardRuntimeReadiness 2026-07-27-16:43:
The startup banner is an operational assertion, not decoration. Resolve it
from the persisted pause setting plus live ProjectEngine/Room lifecycle facts;
never label an absent, failed, starting, stopped, or explicitly withheld
runtime as active.
*/
export function resolveDashboardEngineMode(
  input: DashboardRuntimeReadinessInput,
): DashboardEngineMode {
  if (input.noEngine) return "no-engine";
  if (input.paused) return "paused";
  if (input.startupFailed) return "degraded";
  if (input.roomExecutionStates.includes("read_only_withheld")) {
    return "withheld";
  }
  if (
    input.roomExecutionStates.some((state) =>
      state === "startup_failed" ||
      state === "starting" ||
      state === "stopping" ||
      state === "stopped"
    )
  ) {
    return "degraded";
  }
  return input.engineRunning ? "active" : "degraded";
}

/*
FNXC:DashboardPausedBanner 2026-07-27-02:32:
Headless operators rely on the startup banner as a health signal. A paused
engine must never advertise active planning, scheduling, or cron execution.
*/
export function formatDashboardEngineBannerLines(
  engineMode: DashboardEngineMode,
): string[] {
  if (engineMode === "no-engine") {
    return ["  AI engine:  ✗ disabled (--no-engine)"];
  }
  if (engineMode === "paused") {
    return ["  AI engine:  ‖ paused"];
  }
  if (engineMode === "withheld") {
    return ["  AI engine:  ⚠ withheld (runtime authority/readiness gate)"];
  }
  if (engineMode === "degraded") {
    return ["  AI engine:  ⚠ degraded (runtime not fully ready)"];
  }
  return [
    "  AI engine:  ✓ active",
    "    • planning: auto-planning tasks",
    "    • scheduler: dependency-aware execution",
    "    • cron: scheduled task execution",
  ];
}

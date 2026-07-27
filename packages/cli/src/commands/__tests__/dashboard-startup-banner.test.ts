import { describe, expect, it } from "vitest";
import {
  formatDashboardAuthBannerLines,
  formatDashboardEngineBannerLines,
  maskDashboardAuthToken,
  resolveDashboardEngineMode,
} from "../dashboard-startup-banner.js";

describe("formatDashboardAuthBannerLines", () => {
  it("never exposes the bearer token or a token-bearing URL in authenticated non-TTY output", () => {
    const token = "fn_super_secret_dashboard_token";
    const lines = formatDashboardAuthBannerLines({
      baseUrl: "http://127.0.0.1:4040",
      dashboardAuthToken: token,
    });
    const output = lines.join("\n");

    expect(output).toContain("bearer token required");
    expect(output).toContain("owner-only Fusion settings");
    expect(output).toContain("****oken");
    expect(output).not.toContain(token);
    expect(output).not.toContain("?token=");
    expect(output).not.toContain("fn_token=");
    expect(output).not.toContain("Authorization:");
  });

  it("masks short and long bearer values deterministically", () => {
    expect(maskDashboardAuthToken("abc")).toBe("****");
    expect(maskDashboardAuthToken("fn_12345678")).toBe("****5678");
  });

  it("reports disabled auth without inventing token guidance", () => {
    const lines = formatDashboardAuthBannerLines({
      baseUrl: "http://127.0.0.1:4040",
    });

    expect(lines).toEqual([
      "  → http://127.0.0.1:4040",
      "  Auth:    disabled (--no-auth)",
    ]);
  });
});

describe("formatDashboardEngineBannerLines", () => {
  it("reports a paused engine as paused instead of active", () => {
    expect(formatDashboardEngineBannerLines("paused")).toEqual([
      "  AI engine:  ‖ paused",
    ]);
  });

  it("keeps active and disabled modes distinct", () => {
    expect(formatDashboardEngineBannerLines("active")[0]).toContain("✓ active");
    expect(formatDashboardEngineBannerLines("no-engine")).toEqual([
      "  AI engine:  ✗ disabled (--no-engine)",
    ]);
  });

  it("reports withheld and degraded runtime states without claiming active", () => {
    expect(formatDashboardEngineBannerLines("withheld")[0]).toContain("withheld");
    expect(formatDashboardEngineBannerLines("degraded")[0]).toContain("degraded");
  });
});

describe("resolveDashboardEngineMode", () => {
  const ready = {
    noEngine: false,
    paused: false,
    engineRunning: true,
    startupFailed: false,
    roomExecutionStates: ["execution_started"],
  } as const;

  it("gives explicit disabled and paused states precedence", () => {
    expect(resolveDashboardEngineMode({ ...ready, noEngine: true })).toBe("no-engine");
    expect(resolveDashboardEngineMode({ ...ready, paused: true })).toBe("paused");
  });

  it("uses live startup and Room lifecycle facts", () => {
    expect(resolveDashboardEngineMode(ready)).toBe("active");
    expect(
      resolveDashboardEngineMode({
        ...ready,
        roomExecutionStates: ["read_only_withheld"],
      }),
    ).toBe("withheld");
    expect(
      resolveDashboardEngineMode({ ...ready, startupFailed: true }),
    ).toBe("degraded");
    expect(
      resolveDashboardEngineMode({ ...ready, engineRunning: false }),
    ).toBe("degraded");
    expect(
      resolveDashboardEngineMode({
        ...ready,
        roomExecutionStates: ["starting"],
      }),
    ).toBe("degraded");
  });
});

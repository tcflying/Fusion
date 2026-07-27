import { describe, expect, it } from "vitest";
import { createDashboardAuthContext } from "../dashboard-auth-context.js";

/*
FNXC:DashboardAuthContext 2026-07-27-03:54:
No-auth is an explicit loopback-only operator mode. Wildcard, LAN, and unknown
bind hosts must fail before server startup so a missing or misspelled auth flag
cannot expose shell-capable Dashboard APIs.
*/
describe("createDashboardAuthContext", () => {
  it("allows explicit no-auth only for loopback bind hosts", () => {
    expect(
      createDashboardAuthContext({
        host: "127.0.0.1",
        noAuth: true,
      }),
    ).toEqual({ mode: "loopback-no-auth", host: "127.0.0.1" });

    expect(() =>
      createDashboardAuthContext({
        host: "0.0.0.0",
        noAuth: true,
      }),
    ).toThrow(/only allowed for loopback/i);
  });

  it("accepts loopback aliases for no-auth and requires a bearer on LAN", () => {
    for (const host of ["localhost", "::1", "127.0.0.2"]) {
      expect(createDashboardAuthContext({ host, noAuth: true }).mode).toBe(
        "loopback-no-auth",
      );
    }

    for (const host of ["::", "192.168.1.20", "fusion.lan"]) {
      expect(() => createDashboardAuthContext({ host, noAuth: true })).toThrow(
        /requires bearer authentication/i,
      );
      expect(
        createDashboardAuthContext({ host, token: "fn_test_bearer" }),
      ).toEqual({ mode: "bearer", host, token: "fn_test_bearer" });
    }
  });
});

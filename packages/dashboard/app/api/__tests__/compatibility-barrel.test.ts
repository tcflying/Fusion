import { describe, expect, it } from "vitest";
import {
  isAgentHeartbeatEnabled,
  withAgentHeartbeatEnabled,
  type PlanningContextualComment,
} from "../../api";

/*
FNXC:DashboardApi 2026-07-27-15:50:
Dashboard components keep importing shared heartbeat behavior and planning response types from the compatibility API barrel after those implementations move into focused modules.
*/
describe("dashboard API compatibility barrel", () => {
  it("exports heartbeat helpers and the contextual planning comment contract", () => {
    const agent = { runtimeConfig: { heartbeatIntervalMs: 60_000 } };
    const comment: PlanningContextualComment = {
      quote: "Current plan text",
      suggestion: "Clarify the acceptance criterion",
    };

    expect(isAgentHeartbeatEnabled(agent)).toBe(true);
    expect(withAgentHeartbeatEnabled(agent, false)).toEqual({
      heartbeatIntervalMs: 60_000,
      enabled: false,
    });
    expect(comment).toEqual({
      quote: "Current plan text",
      suggestion: "Clarify the acceptance criterion",
    });
  });
});

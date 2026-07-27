import { describe, expect, it } from "vitest";

import {
  HAPPIER_OFFICIAL_SESSION_CONTROL_SOURCE,
  validateOfficialRawHistoryResult,
  validateOfficialSessionSendResult,
  validateOfficialSessionWaitResult,
} from "../official-session-control-contract.js";

describe("pinned official Happier Session control contract", () => {
  it("publishes the exact upstream source boundary", () => {
    expect(HAPPIER_OFFICIAL_SESSION_CONTROL_SOURCE).toEqual({
      repository: "https://github.com/happier-dev/happier",
      sourceCommit: "6e059c41d865343c1efc9c98676e5af3882d85ff",
      sourceModule: "packages/protocol/src/sessionControl/contract.ts",
      contract: "sessionControl/v1",
      package: "@happier-dev/protocol",
      packagePublication: "private_workspace_package",
    });
  });

  it("accepts passthrough fields but rejects every send and wait identity mismatch", () => {
    expect(validateOfficialSessionSendResult({
      sessionId: "session-1",
      localId: "local-1",
      waited: true,
      futureField: "preserved",
    }, {
      sessionId: "session-1",
      localId: "local-1",
      waited: true,
    })).toMatchObject({ ok: true });
    expect(validateOfficialSessionSendResult({
      sessionId: "wrong",
      localId: "local-1",
      waited: true,
    }, {
      sessionId: "session-1",
      localId: "local-1",
      waited: true,
    })).toEqual({ ok: false, reason: "send_session_mismatch" });
    expect(validateOfficialSessionWaitResult({
      sessionId: "session-1",
      idle: false,
      observedAt: 1,
    }, "session-1")).toEqual({ ok: false, reason: "wait_not_idle" });
    expect(validateOfficialSessionWaitResult({
      sessionId: "session-1",
      idle: true,
      observedAt: -1,
    }, "session-1")).toEqual({ ok: false, reason: "wait_observed_at_invalid" });
  });

  it("requires exact raw history identity and shape before receipt correlation", () => {
    expect(validateOfficialRawHistoryResult({
      sessionId: "session-1",
      format: "raw",
      messages: [],
    }, "session-1")).toMatchObject({ ok: true });
    expect(validateOfficialRawHistoryResult({
      sessionId: "session-2",
      format: "raw",
      messages: [],
    }, "session-1")).toEqual({ ok: false, reason: "history_session_mismatch" });
    expect(validateOfficialRawHistoryResult({
      sessionId: "session-1",
      format: "compact",
      messages: [],
    }, "session-1")).toEqual({ ok: false, reason: "raw_history_unavailable" });
  });
});

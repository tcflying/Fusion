import { describe, expect, it } from "vitest";

import { happierApprovalOutcomeFromActionRecord } from "../mcp-result-contract.js";

describe("Happier action approval outcome contract", () => {
  it("normalizes the same typed approval outcome from CLI data and MCP result envelopes", () => {
    const expected = {
      kind: "approval_required",
      actionState: "approval_request_created",
      artifactId: "approval-shared-1",
      operation: "session_message_send",
    } as const;

    expect(happierApprovalOutcomeFromActionRecord({
      data: {
        kind: "approval_request_created",
        artifactId: "approval-shared-1",
      },
    }, "session_message_send")).toEqual(expected);
    expect(happierApprovalOutcomeFromActionRecord({
      ok: true,
      result: {
        kind: "approval_request_created",
        artifactId: "approval-shared-1",
      },
    }, "session_message_send")).toEqual(expected);
  });
});

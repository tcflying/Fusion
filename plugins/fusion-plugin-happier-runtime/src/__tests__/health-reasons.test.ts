import { describe, expect, it } from "vitest";

import { typedHappierHealthReasonCodes } from "../health-reasons.js";

describe("Happier typed health reasons", () => {
  it("preserves fail-closed supply-chain and OpenCode machine availability reasons", () => {
    expect(typedHappierHealthReasonCodes([
      "cli-attestation-failed",
      "backend-machine-availability-unverified",
      "cli-attestation-failed",
      "untrusted-free-text",
    ])).toEqual([
      "cli_attestation_failed",
      "backend_machine_availability_unverified",
    ]);
  });
});

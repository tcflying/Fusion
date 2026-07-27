import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/*
 * FNXC:HappierSessionConnectorStructure 2026-07-27-17:57:
 * PLG-P2-006 requires the public connector to remain a small composition root
 * while transport, identity, capability, send/receipt, and lifecycle behavior
 * live in focused modules. Keep this source-level ratchet so later behavior
 * additions cannot silently rebuild the 2,000-line connector.
 */
describe("Happier Session Connector module boundaries", () => {
  it("keeps the public connector thin and delegates every named responsibility", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../session-connector.ts", import.meta.url)),
      "utf8",
    );
    const lines = source.replace(/\r\n/gu, "\n").split("\n");

    expect(lines.length).toBeLessThanOrEqual(500);
    expect(source).toContain('from "./session-connector-transport.js"');
    expect(source).toContain('from "./session-connector-identity.js"');
    expect(source).toContain('from "./session-connector-capability.js"');
    expect(source).toContain('from "./session-connector-send-receipt.js"');
    expect(source).toContain('from "./session-connector-lifecycle.js"');

    for (const helper of [
      "session-connector-transport.ts",
      "session-connector-identity.ts",
      "session-connector-capability.ts",
      "session-connector-send-receipt.ts",
      "session-connector-lifecycle.ts",
      "session-connector-observation.ts",
    ]) {
      const helperSource = readFileSync(
        fileURLToPath(new URL(`../${helper}`, import.meta.url)),
        "utf8",
      );
      const helperLines = helperSource
        .replace(/\r\n/gu, "\n")
        .split("\n");
      expect(helperLines.length, helper).toBeLessThanOrEqual(900);
    }
  });
});

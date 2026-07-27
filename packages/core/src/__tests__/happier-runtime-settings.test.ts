import { describe, expect, it } from "vitest";

import {
  normalizeHappierSessionBindings,
  validateHappierRuntimeSettings,
} from "../happier-runtime-settings.js";
import { SESSION_CONNECTOR_HEALTH_REASON_CODES } from "../room-contracts/session-connector.js";
import { validatePluginSettingsPolicy } from "../plugin-store.js";

const codex = {
  canonicalSessionUri: "codex://threads/thread-1",
  happierSessionId: "happier-1",
  serverProfileId: "server-1",
  machineId: "machine-1",
} as const;

describe("Happier runtime settings authority", () => {
  it("deduplicates only exact full identities and returns a permutation-invariant order", () => {
    const claude = {
      canonicalSessionUri: "claude://sessions/session-2",
      happierSessionId: "happier-2",
      serverProfileId: "server-1",
      machineId: "machine-1",
    };
    const forward = normalizeHappierSessionBindings([claude, codex, { ...codex }]);
    const reverse = normalizeHappierSessionBindings([{ ...codex }, codex, claude]);

    expect(forward.errors).toEqual([]);
    expect(reverse.errors).toEqual([]);
    expect(forward.bindings).toEqual(reverse.bindings);
    expect(forward.bindings).toHaveLength(2);
  });

  it("rejects canonical or Happier identities that fork across profile, machine, provider, or target", () => {
    const canonicalFork = normalizeHappierSessionBindings([
      codex,
      { ...codex, serverProfileId: "server-2" },
    ]);
    const targetFork = normalizeHappierSessionBindings([
      codex,
      {
        canonicalSessionUri: "codex://threads/thread-2",
        happierSessionId: codex.happierSessionId,
        serverProfileId: codex.serverProfileId,
        machineId: codex.machineId,
      },
    ]);
    const mappingFork = normalizeHappierSessionBindings([
      codex,
      { ...codex, happierSessionId: "happier-other" },
    ]);

    expect(canonicalFork.bindings).toEqual([]);
    expect(targetFork.bindings).toEqual([]);
    expect(mappingFork.bindings).toEqual([]);
    expect(canonicalFork.errors.join(" ")).toContain("conflict");
    expect(targetFork.errors.join(" ")).toContain("conflict");
    expect(mappingFork.errors.join(" ")).toContain("conflict");
  });

  it("blocks backend mismatch, inverted wait deadlines, and arbitrary entrypoints before persistence", () => {
    expect(validateHappierRuntimeSettings({
      backend: "claude",
      happierSessionBindings: [codex],
    })).toContain("Happier backend conflicts with persisted Session provider codex");

    expect(validateHappierRuntimeSettings({
      timeoutSeconds: 30,
      waitTimeoutMs: 34_999,
      waitTimeoutGraceMs: 5_000,
    })).toContain("Happier waitTimeoutMs must cover timeoutSeconds plus waitTimeoutGraceMs");

    expect(validateHappierRuntimeSettings({
      executable: "node",
      entrypoint: "G:\\untrusted\\index.mjs",
      allowedCliRoots: ["G:\\codex-project\\happier"],
    })).toContain("Happier executable must be the current absolute Node executable");
  });

  it("publishes typed fail-closed health reasons for attestation and machine availability", () => {
    expect(SESSION_CONNECTOR_HEALTH_REASON_CODES).toContain("cli_attestation_failed");
    expect(SESSION_CONNECTOR_HEALTH_REASON_CODES).toContain(
      "backend_machine_availability_unverified",
    );
  });

  it("routes PluginStore persistence validation through the Happier settings authority", () => {
    expect(validatePluginSettingsPolicy("fusion-plugin-happier-runtime", {
      timeoutSeconds: 30,
      waitTimeoutGraceMs: 5_000,
      waitTimeoutMs: 34_999,
    })).toContain("Happier waitTimeoutMs must cover timeoutSeconds plus waitTimeoutGraceMs");
    expect(validatePluginSettingsPolicy("another-plugin", {
      timeoutSeconds: -1,
    })).toEqual([]);
  });
});

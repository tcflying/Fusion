import { describe, expect, it } from "vitest";

import { parseHappierPersistedBindings } from "../binding-identity.js";

const binding = {
  canonicalSessionUri: "codex://threads/thread-1",
  happierSessionId: "happier-1",
  serverProfileId: "server-1",
  machineId: "machine-1",
} as const;

describe("Happier connector binding identity", () => {
  it("deduplicates only exact full identities with permutation-invariant output", () => {
    const other = {
      canonicalSessionUri: "claude://sessions/session-2",
      happierSessionId: "happier-2",
      serverProfileId: "server-1",
      machineId: "machine-1",
    } as const;

    expect(parseHappierPersistedBindings([binding, other, { ...binding }])).toEqual(
      parseHappierPersistedBindings([other, { ...binding }, binding]),
    );
    expect(parseHappierPersistedBindings([binding, other, { ...binding }])).toHaveLength(2);
  });

  it("fails closed when profile, machine, provider target, or Happier target forks", () => {
    expect(() => parseHappierPersistedBindings([
      binding,
      { ...binding, serverProfileId: "server-2" },
    ])).toThrow("identity conflict");
    expect(() => parseHappierPersistedBindings([
      binding,
      { ...binding, machineId: "machine-2" },
    ])).toThrow("identity conflict");
    expect(() => parseHappierPersistedBindings([
      binding,
      { ...binding, happierSessionId: "happier-other" },
    ])).toThrow("identity conflict");
    expect(() => parseHappierPersistedBindings([
      binding,
      {
        ...binding,
        canonicalSessionUri: "codex://threads/thread-2",
      },
    ])).toThrow("identity conflict");
  });

  it("rejects non-canonical aliases and unsupported fields", () => {
    expect(parseHappierPersistedBindings([{
      ...binding,
      canonicalSessionUri: "codex://threads/thread%2D1",
    }])).toEqual([]);
    expect(parseHappierPersistedBindings([{
      ...binding,
      accessToken: "must-not-enter-binding-state",
    }])).toEqual([]);
  });
});

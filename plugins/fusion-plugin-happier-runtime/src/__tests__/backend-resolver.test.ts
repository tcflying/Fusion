import { describe, expect, it } from "vitest";

import {
  HAPPIER_DEFAULT_BACKEND,
  resolveHappierBackendFromCanonicalSessionUri,
  resolveHappierBackend,
} from "../backend-resolver.js";

describe("resolveHappierBackend", () => {
  it("uses one Codex default when neither settings nor identity selects a backend", () => {
    expect(HAPPIER_DEFAULT_BACKEND).toBe("codex");
    expect(resolveHappierBackend({})).toBe("codex");
  });

  it("uses an explicit supported backend", () => {
    expect(resolveHappierBackend({ backend: "claude" })).toBe("claude");
    expect(resolveHappierBackend({ backend: "opencode" })).toBe("opencode");
  });

  it("uses the bound provider as the unique contextual default", () => {
    expect(resolveHappierBackend({}, "claude")).toBe("claude");
  });

  it("rejects unsupported and binding-mismatched backend settings", () => {
    expect(() => resolveHappierBackend({ backend: "unknown" })).toThrow("unsupported");
    expect(() => resolveHappierBackend({ backend: "codex" }, "claude")).toThrow("conflicts");
  });

  it("derives backend identity only from canonical provider Session URIs", () => {
    expect(resolveHappierBackendFromCanonicalSessionUri("codex://threads/thread-1")).toBe("codex");
    expect(resolveHappierBackendFromCanonicalSessionUri("claude://sessions/session-1")).toBe("claude");
    expect(resolveHappierBackendFromCanonicalSessionUri("opencode://sessions/session-1")).toBe("opencode");
    expect(resolveHappierBackendFromCanonicalSessionUri("codex://sessions/thread-1")).toBeNull();
    expect(resolveHappierBackendFromCanonicalSessionUri("codex://threads/thread-1?model=spoofed")).toBeNull();
  });
});

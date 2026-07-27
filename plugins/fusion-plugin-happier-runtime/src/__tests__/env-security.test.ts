import { describe, expect, it } from "vitest";

import {
  buildHappierProcessEnv,
  redactHappierOutput,
  resolveHappierCliSettings,
} from "../cli-spawn.js";

describe("Happier child environment security", () => {
  it("uses one provider wait default and drops secret-bearing parent variables", () => {
    const resolved = resolveHappierCliSettings({});
    const environment = buildHappierProcessEnv({}, {
      PATH: "C:\\Windows\\System32",
      refreshToken: "refresh-value-123",
      cookie: "cookie-value-456",
      sessionSecret: "session-value-789",
      key: "key-value-012",
      OPENAI_API_KEY: "provider-value-345",
      NODE_OPTIONS: "--require C:\\untrusted.js",
    });

    expect(resolved.timeoutSeconds).toBe(300);
    expect(environment.PATH).toBe("C:\\Windows\\System32");
    for (const key of [
      "refreshToken",
      "cookie",
      "sessionSecret",
      "key",
      "OPENAI_API_KEY",
      "NODE_OPTIONS",
    ]) {
      expect(environment).not.toHaveProperty(key);
    }
  });

  it("redacts refresh tokens, cookies, session secrets, and bare keys", () => {
    const secrets = {
      refreshToken: "refresh-value-123",
      cookie: "cookie-value-456",
      sessionSecret: "session-value-789",
      key: "key-value-012",
    };
    const redacted = redactHappierOutput(JSON.stringify(secrets));

    expect(redacted).toBe(JSON.stringify({
      refreshToken: "[REDACTED]",
      cookie: "[REDACTED]",
      sessionSecret: "[REDACTED]",
      key: "[REDACTED]",
    }));
    for (const secret of Object.values(secrets)) expect(redacted).not.toContain(secret);
  });
});

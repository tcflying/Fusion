import { describe, expect, it } from "vitest";
import { formatConsoleArgs } from "../log-sink.js";

describe("formatConsoleArgs printable framing", () => {
  it.each(["info", "warn", "error"] as const)(
    "preserves %s severity and prefix without embedding control characters",
    (level) => {
      const framed = `[fnlvl=${level}] [executor] task ${level}`;
      const result = formatConsoleArgs([framed], "info");

      expect(framed).not.toMatch(
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/,
      );
      expect(result).toEqual({
        prefix: "executor",
        level,
        message: `task ${level}`,
      });
    },
  );
});

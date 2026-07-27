import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLogger } from "../logger.js";

describe("core createLogger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("emits info logs to stderr with an info severity marker", () => {
    const logger = createLogger("core-test");
    logger.log("hello");

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith("[fnlvl=info] [core-test] hello");
    expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("\u0000");
  });

  it("emits warn logs with a warn severity marker", () => {
    const logger = createLogger("core-test");
    logger.warn("careful");

    expect(warnSpy).toHaveBeenCalledWith("[fnlvl=warn] [core-test] careful");
    expect(warnSpy.mock.calls.flat().join(" ")).not.toContain("\u0000");
  });

  it("emits error logs with an error severity marker", () => {
    const logger = createLogger("core-test");
    const err = new Error("boom");
    logger.error("broken", err);

    expect(errorSpy).toHaveBeenCalledWith("[fnlvl=error] [core-test] broken", err);
    expect(errorSpy.mock.calls.flat().join(" ")).not.toContain("\u0000");
  });

  it.each(["dashboard", "serve", "daemon"] as const)(
    "keeps %s non-TTY severity framing printable",
    (host) => {
      const logger = createLogger("cli-process-output-proof");
      logger.log(`${host}:info`);
      logger.warn(`${host}:warn`);
      logger.error(`${host}:error`);

      const redirectedLines = [
        errorSpy.mock.calls[0]?.[0],
        warnSpy.mock.calls[0]?.[0],
        errorSpy.mock.calls[1]?.[0],
      ];
      expect(redirectedLines).toEqual([
        `[fnlvl=info] [cli-process-output-proof] ${host}:info`,
        `[fnlvl=warn] [cli-process-output-proof] ${host}:warn`,
        `[fnlvl=error] [cli-process-output-proof] ${host}:error`,
      ]);
      for (const line of redirectedLines) {
        expect(Buffer.from(String(line), "utf8").includes(0)).toBe(false);
      }
    },
  );
});

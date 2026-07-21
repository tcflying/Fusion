import {
  hashRoomValue as hashCoreRoomValue,
  SESSION_CONNECTOR_CAPABILITIES as CORE_SESSION_CONNECTOR_CAPABILITIES,
  SESSION_CONNECTOR_HISTORY_PAGE_LIMIT as CORE_SESSION_CONNECTOR_HISTORY_PAGE_LIMIT,
} from "@fusion/core";
import { describe, expect, it } from "vitest";
import {
  hashRoomValue,
  SESSION_CONNECTOR_CAPABILITIES,
  SESSION_CONNECTOR_HISTORY_PAGE_LIMIT,
} from "../plugin-sdk-core-runtime-shim.js";

describe("plugin SDK core runtime shim", () => {
  it("preserves the Happier connector runtime values without a Core runtime dependency", () => {
    const value = {
      z: ["stable", { second: 2, first: 1 }],
      a: true,
      omitted: undefined,
    };

    expect(hashRoomValue(value)).toBe(hashCoreRoomValue(value));
    expect(SESSION_CONNECTOR_HISTORY_PAGE_LIMIT).toBe(CORE_SESSION_CONNECTOR_HISTORY_PAGE_LIMIT);
    expect(SESSION_CONNECTOR_CAPABILITIES).toEqual(CORE_SESSION_CONNECTOR_CAPABILITIES);
  });
});

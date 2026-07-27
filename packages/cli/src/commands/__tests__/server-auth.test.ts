import { describe, expect, it, vi } from "vitest";
import { resolveHostBearerToken } from "../server-auth.js";

/*
FNXC:ServerAuth 2026-07-27-03:54:
Dashboard and serve default to bearer authentication. Token resolution may be
skipped only after the caller has explicitly selected validated loopback
no-auth; LAN hosts never reach this branch because auth-context construction
fails closed first.
*/
describe("resolveHostBearerToken", () => {
  it("creates bearer auth by default and skips token work only for explicit no-auth", async () => {
    const getOrCreateToken = vi.fn(async () => "fn_generated_for_host");

    await expect(
      resolveHostBearerToken({ getOrCreateToken }),
    ).resolves.toBe("fn_generated_for_host");
    await expect(
      resolveHostBearerToken({ noAuth: true, getOrCreateToken }),
    ).resolves.toBeUndefined();
    expect(getOrCreateToken).toHaveBeenCalledTimes(1);
  });

  it("uses CLI token before environment and storage", async () => {
    const getOrCreateToken = vi.fn(async () => "fn_stored");

    await expect(
      resolveHostBearerToken({
        explicitToken: "fn_explicit",
        environmentToken: "fn_environment",
        getOrCreateToken,
      }),
    ).resolves.toBe("fn_explicit");
    await expect(
      resolveHostBearerToken({
        environmentToken: "fn_environment",
        getOrCreateToken,
      }),
    ).resolves.toBe("fn_environment");
    expect(getOrCreateToken).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { openExternalUrl } from "../open-external";

/*
FNXC:DesktopOAuth 2026-07-21-09:30:
Official Fusion v0.72.0 fixes desktop OAuth flows whose post-login await can
outlive Chromium user activation and silently block `window.open`. The
dashboard must prefer the desktop IPC bridge, then fall back safely on web.
*/
describe("openExternalUrl", () => {
  const w = window as unknown as { fusionAPI?: { openExternal?: (url: string) => Promise<boolean> } };

  afterEach(() => {
    delete w.fusionAPI;
    vi.restoreAllMocks();
  });

  it("prefers the desktop openExternal bridge over window.open", async () => {
    const openExternal = vi.fn().mockResolvedValue(true);
    w.fusionAPI = { openExternal };
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);

    openExternalUrl("https://auth.openai.com/oauth/authorize?x=1");
    await Promise.resolve();

    expect(openExternal).toHaveBeenCalledWith("https://auth.openai.com/oauth/authorize?x=1");
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it("falls back to window.open when the bridge declines the URL", async () => {
    const openExternal = vi.fn().mockResolvedValue(false);
    w.fusionAPI = { openExternal };
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);

    openExternalUrl("https://example.com/auth");
    await Promise.resolve();
    await Promise.resolve();

    expect(windowOpen).toHaveBeenCalledWith("https://example.com/auth", "_blank");
  });

  it("uses window.open when no desktop bridge exists", () => {
    const windowOpen = vi.spyOn(window, "open").mockReturnValue(null);

    openExternalUrl("https://example.com/auth");

    expect(windowOpen).toHaveBeenCalledWith("https://example.com/auth", "_blank");
  });
});

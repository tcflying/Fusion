import { describe, expect, it, vi } from "vitest";
import plugin, {
  HAPPIER_RUNTIME_ID,
  happierRuntimeFactory,
  happierRuntimeMetadata,
} from "../index.js";

describe("Happier runtime plugin registration", () => {
  it("registers metadata and creates the runtime without provider credentials", async () => {
    expect(plugin.manifest.id).toBe("fusion-plugin-happier-runtime");
    expect(plugin.runtime?.metadata).toEqual(happierRuntimeMetadata);
    expect(happierRuntimeMetadata.runtimeId).toBe(HAPPIER_RUNTIME_ID);

    const runtime = await happierRuntimeFactory({
      settings: { backend: "codex", providerApiKey: "do-not-forward" },
    } as never);

    expect(runtime).toMatchObject({ id: "happier", name: "Happier Runtime" });
    expect(JSON.stringify(runtime)).not.toContain("do-not-forward");
  });

  it("emits a non-sensitive loaded event and never logs settings secrets", () => {
    const info = vi.fn();
    const emitEvent = vi.fn();

    plugin.hooks?.onLoad?.({
      pluginId: "fusion-plugin-happier-runtime",
      settings: {
        executable: "happier",
        backend: "codex",
        providerApiKey: "secret-provider-key",
      },
      logger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      emitEvent,
    } as never);

    expect(emitEvent).toHaveBeenCalledWith("happier-runtime:loaded", {
      runtimeId: "happier",
      version: expect.any(String),
    });
    expect(info.mock.calls.flat().join(" ")).not.toContain("secret-provider-key");
  });
});

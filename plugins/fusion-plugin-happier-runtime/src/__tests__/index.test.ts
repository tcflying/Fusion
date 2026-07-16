import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import plugin, {
  HAPPIER_RUNTIME_ID,
  happierRuntimeFactory,
  happierRuntimeMetadata,
} from "../index.js";

describe("Happier runtime plugin registration", () => {
  it("uses the real SDK helper and one package/manifest/runtime version", () => {
    const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    const manifestJson = JSON.parse(readFileSync(new URL("../../manifest.json", import.meta.url), "utf8")) as {
      version: string;
      runtime?: { version?: string };
    };

    expect(source).toMatch(/import\s*\{\s*definePlugin\s*\}\s*from\s*["']@fusion\/plugin-sdk["']/);
    expect(plugin.manifest.version).toBe(packageJson.version);
    expect(happierRuntimeMetadata.version).toBe(packageJson.version);
    expect(manifestJson.version).toBe(packageJson.version);
    expect(manifestJson.runtime?.version).toBe(packageJson.version);
  });

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

  it("keeps the legacy AgentRuntime available while the Room gate is off", async () => {
    const runtime = await happierRuntimeFactory({
      settings: {
        backend: "codex",
        experimentalFeatures: { sessionRoomControlPlane: false },
      },
    } as never);

    expect(plugin.runtime?.metadata).toEqual(happierRuntimeMetadata);
    expect(runtime).toMatchObject({ id: HAPPIER_RUNTIME_ID, name: "Happier Runtime" });
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

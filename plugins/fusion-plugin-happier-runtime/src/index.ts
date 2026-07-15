/**
 * FNXC:HappierRuntime 2026-07-13-16:10:
 * Register the durable Happier adapter with Fusion without exposing provider
 * credentials. Happier owns authentication, encryption, and transcripts.
 */

import { HappierRuntimeAdapter } from "./runtime-adapter.js";
import { definePlugin } from "@fusion/plugin-sdk";
import type {
  FusionPlugin,
  PluginContext,
  PluginRuntimeFactory,
  PluginRuntimeManifestMetadata,
} from "@fusion/plugin-sdk";

export const HAPPIER_RUNTIME_ID = "happier";
export const HAPPIER_RUNTIME_VERSION = "0.2.73";

export const happierRuntimeMetadata: PluginRuntimeManifestMetadata = {
  runtimeId: HAPPIER_RUNTIME_ID,
  name: "Happier Runtime",
  description: "Drives official Happier JSON CLI sessions with durable native ids",
  version: HAPPIER_RUNTIME_VERSION,
};

export const happierRuntimeFactory: PluginRuntimeFactory = async (ctx) =>
  new HappierRuntimeAdapter(ctx.settings as Record<string, unknown>);

const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: "fusion-plugin-happier-runtime",
    name: "Happier Runtime Plugin",
    version: HAPPIER_RUNTIME_VERSION,
    description: "Drives official Happier JSON CLI sessions for Fusion agents",
    author: "Fusion Team",
    homepage: "https://github.com/Runfusion/Fusion",
    runtime: happierRuntimeMetadata,
  },
  state: "installed",
  hooks: {
    onLoad: (ctx: PluginContext) => {
      ctx.logger.info("Happier Runtime Plugin loaded — runtime=happier");
      ctx.emitEvent("happier-runtime:loaded", {
        runtimeId: HAPPIER_RUNTIME_ID,
        version: HAPPIER_RUNTIME_VERSION,
      });
    },
    onUnload: () => undefined,
  },
  runtime: {
    metadata: happierRuntimeMetadata,
    factory: happierRuntimeFactory,
  },
});

export default plugin;

export { ensureHappierDirectSession } from "./cli-spawn.js";
export type { HappierDirectSessionEnsureResult } from "./types.js";
export * from "./cli-spawn.js";
export * from "./operations.js";
export * from "./probe.js";
export * from "./types.js";
export { HappierRecoveryError, HappierRuntimeAdapter } from "./runtime-adapter.js";

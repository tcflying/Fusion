/**
 * FNXC:HappierRuntime 2026-07-13-16:10:
 * Register the durable Happier adapter with Fusion without exposing provider
 * credentials. Happier owns authentication, encryption, and transcripts.
 */

import { HappierRuntimeAdapter } from "./runtime-adapter.js";
import { resolveHappierCliSettings } from "./cli-spawn.js";
import {
  HAPPIER_SESSION_CONNECTOR_ID,
  HAPPIER_SESSION_CONNECTOR_VERSION,
} from "./session-connector-contract.js";
import { HappierSessionConnector } from "./session-connector-facade.js";
import { definePlugin } from "@fusion/plugin-sdk";
import type {
  FusionPlugin,
  PluginContext,
  PluginRuntimeFactory,
  PluginRuntimeManifestMetadata,
  PluginSessionConnectorFactory,
  PluginSessionConnectorManifestMetadata,
} from "@fusion/plugin-sdk";
import type { HappierBackend } from "./types.js";

export const HAPPIER_RUNTIME_ID = HAPPIER_SESSION_CONNECTOR_ID;
export const HAPPIER_RUNTIME_VERSION = HAPPIER_SESSION_CONNECTOR_VERSION;

export const happierRuntimeMetadata: PluginRuntimeManifestMetadata = {
  runtimeId: HAPPIER_RUNTIME_ID,
  name: "Happier Runtime",
  description: "Drives official Happier JSON CLI sessions with durable native ids",
  version: HAPPIER_RUNTIME_VERSION,
};

export const happierRuntimeFactory: PluginRuntimeFactory = async (ctx) =>
  new HappierRuntimeAdapter(ctx.settings as Record<string, unknown>);

export const happierSessionConnectorMetadata: PluginSessionConnectorManifestMetadata = {
  connectorId: HAPPIER_SESSION_CONNECTOR_ID,
  name: "Happier Session Connector",
  description: "Connects manually bound Happier Sessions through official MCP stdio",
  version: HAPPIER_SESSION_CONNECTOR_VERSION,
};

function connectorSettings(ctx: PluginContext) {
  const settings = ctx.settings as Record<string, unknown>;
  const backend = settings.backend === "codex" || settings.backend === "claude" || settings.backend === "opencode"
    ? settings.backend as HappierBackend
    : undefined;
  return {
    ...resolveHappierCliSettings(settings),
    ...(backend ? { backend } : {}),
  };
}

export const happierSessionConnectorFactory: PluginSessionConnectorFactory = async (ctx) =>
  new HappierSessionConnector({ settings: connectorSettings(ctx) });

const plugin: FusionPlugin = definePlugin({
  manifest: {
    id: "fusion-plugin-happier-runtime",
    name: "Happier Runtime Plugin",
    version: HAPPIER_RUNTIME_VERSION,
    description: "Drives official Happier JSON CLI sessions for Fusion agents",
    author: "Fusion Team",
    homepage: "https://github.com/Runfusion/Fusion",
    runtime: happierRuntimeMetadata,
    sessionConnector: happierSessionConnectorMetadata,
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
  sessionConnector: {
    metadata: happierSessionConnectorMetadata,
    factory: happierSessionConnectorFactory,
  },
});

export default plugin;

export { ensureHappierDirectSession } from "./cli-spawn.js";
export type { HappierDirectSessionEnsureResult } from "./types.js";
export * from "./cli-spawn.js";
export * from "./happier-mcp-client.js";
export * from "./operations.js";
export * from "./probe.js";
export * from "./types.js";
export { HappierRecoveryError, HappierRuntimeAdapter } from "./runtime-adapter.js";
export {
  HAPPIER_OFFICIAL_MCP_SOURCE_REVISION,
  HAPPIER_SESSION_CONNECTOR_ID,
  HAPPIER_SESSION_CONNECTOR_VERSION,
} from "./session-connector-contract.js";
export { HappierSessionConnector } from "./session-connector-facade.js";
export type {
  HappierSessionConnectorDependencies,
  HappierSessionConnectorOptions,
} from "./session-connector.js";
export { HAPPIER_LOCAL_DIRECT_SESSION_EXTENSION_STATE } from "./happier-direct-session-capabilities.js";

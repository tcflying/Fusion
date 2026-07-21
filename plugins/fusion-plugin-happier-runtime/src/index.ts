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
import {
  createHappierSessionConnectorWithHostWriteAuthorization,
  HappierSessionConnector,
} from "./session-connector-facade.js";
import type { HappierHostWriteAuthorizationRequest } from "./session-connector.js";
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

export function createHappierHostWriteAuthorizationDependency(ctx: PluginContext) {
  // FNXC:HappierDurableWriteAuthority 2026-07-20-11:46: only the Engine-owned
  // authorizer can bind an official MCP mutation to a claimed Room outbox/fence.
  // FNXC:HappierDurableWriteAuthorityScope 2026-07-20-22:20: forward the
  // canonical Session URI and binding-specific scope to the Engine, then return
  // only the matching Engine-certified scope. Missing or mismatched grants must
  // fail before the connector can open official Happier MCP/provider I/O.
  const authorizer = ctx.sessionConnectorWriteAuthorizer;
  if (!authorizer) return undefined;
  return async (request: HappierHostWriteAuthorizationRequest) => {
    if (!nonEmptyScopeField(request.canonicalSessionUri) || !nonEmptyScopeField(request.scopeFingerprint)) {
      return { authorized: false as const };
    }
    const decision = await authorizer.authorize({
      contractVersion: 1,
      connectorId: request.connectorId,
      operation: request.operation,
      identity: {
        connectorId: request.connectorId,
        providerId: request.providerId,
        nativeSessionId: request.nativeSessionId,
        happierSessionId: request.happierSessionId,
        serverProfileId: request.serverProfileId,
        machineId: request.machineId,
        hostId: request.hostId,
      },
      canonicalSessionUri: request.canonicalSessionUri,
      bindingId: request.bindingId,
      logicalMessageId: request.logicalMessageId,
      localMessageId: request.localMessageId,
      idempotencyKey: request.idempotencyKey,
      contentHash: request.contentHash ?? null,
      reason: request.reason,
      deliveryAuthorization: request.deliveryAuthorization,
      scopeFingerprint: request.scopeFingerprint,
    });
    if (!decision.authorized
      || !nonEmptyScopeField(decision.scopeFingerprint)
      || decision.scopeFingerprint !== request.scopeFingerprint) {
      return { authorized: false as const };
    }
    return {
      authorized: true as const,
      authorizationId: decision.authorizationId,
      scopeFingerprint: decision.scopeFingerprint,
    };
  };
}

function nonEmptyScopeField(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export const happierSessionConnectorFactory: PluginSessionConnectorFactory = async (ctx) => {
  const verifyHostWriteAuthorization = createHappierHostWriteAuthorizationDependency(ctx);
  const options = {
    settings: connectorSettings(ctx),
  };
  return verifyHostWriteAuthorization
    ? createHappierSessionConnectorWithHostWriteAuthorization(options, verifyHostWriteAuthorization)
    : new HappierSessionConnector(options);
};

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

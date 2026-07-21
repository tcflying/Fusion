/**
 * FNXC:HappierMcp 2026-07-19-19:52:
 * Preserve the root-package connector constructor without eagerly loading the
 * MCP implementation. No child process is opened until a connector operation runs.
 */

import type {
  SessionConnectorIdentityV1,
  SessionConnectorPreflightExistingRequestV1,
  SessionConnectorPreflightExistingResultV1,
  SessionConnectorProviderTelemetrySourceV1,
  SessionConnectorProviderTelemetryV1,
  SessionConnectorProviderTelemetryWithheldReasonV1,
  SessionConnectorResultV1,
  SessionConnectorRuntimeSnapshotSourceV1,
  SessionConnectorV1,
} from "@fusion/core";
import { SESSION_CONNECTOR_PROVIDER_TELEMETRY_CONTRACT_VERSION } from "@fusion/core";
import {
  HAPPIER_SESSION_CONNECTOR_ID,
  HAPPIER_SESSION_CONNECTOR_VERSION,
} from "./session-connector-contract.js";
import type {
  HappierPluginWriteAuthorization,
  HappierSessionConnectorOptions,
} from "./session-connector.js";

const pluginWriteAuthorizers = new WeakMap<object, HappierPluginWriteAuthorization>();

/**
 * @internal Keeps the Engine-owned write authority in the runtime-factory
 * closure while the normal facade constructor remains read-only and lazy.
 */
export function createHappierSessionConnectorWithHostWriteAuthorization(
  options: HappierSessionConnectorOptions,
  verifier: HappierPluginWriteAuthorization,
): HappierSessionConnector {
  const connector = new HappierSessionConnector(options);
  pluginWriteAuthorizers.set(connector, verifier);
  return connector;
}

function providerTelemetryIdentity(identity: SessionConnectorIdentityV1): SessionConnectorIdentityV1 {
  return Object.freeze({
    connectorId: identity.connectorId,
    providerId: identity.providerId,
    nativeSessionId: identity.nativeSessionId,
    happierSessionId: identity.happierSessionId,
    serverProfileId: identity.serverProfileId,
    machineId: identity.machineId,
    hostId: identity.hostId,
  });
}

function providerTelemetryWithheld(
  identity: SessionConnectorIdentityV1,
  reason: SessionConnectorProviderTelemetryWithheldReasonV1,
): SessionConnectorResultV1<SessionConnectorProviderTelemetryV1> {
  return {
    ok: true,
    value: Object.freeze({
      contractVersion: SESSION_CONNECTOR_PROVIDER_TELEMETRY_CONTRACT_VERSION,
      state: "withheld" as const,
      identity: providerTelemetryIdentity(identity),
      reason,
    }),
  };
}

export class HappierSessionConnector implements SessionConnectorV1, SessionConnectorRuntimeSnapshotSourceV1, SessionConnectorProviderTelemetrySourceV1 {
  readonly contractVersion = 1;
  readonly id = HAPPIER_SESSION_CONNECTOR_ID;
  readonly version: string;

  private implementationPromise: Promise<SessionConnectorV1> | null = null;

  constructor(private readonly options: HappierSessionConnectorOptions = {}) {
    this.version = options.version?.trim() || HAPPIER_SESSION_CONNECTOR_VERSION;
  }

  getCapabilities(...args: Parameters<SessionConnectorV1["getCapabilities"]>): ReturnType<SessionConnectorV1["getCapabilities"]> {
    return this.implementation().then((connector) => connector.getCapabilities(...args));
  }

  preflightExisting(
    input: SessionConnectorPreflightExistingRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorPreflightExistingResultV1>> {
    return this.implementation().then((connector) => {
      if (typeof connector.preflightExisting !== "function") {
        return {
          ok: false as const,
          error: {
            code: "unavailable" as const,
            message: "The loaded Happier connector does not support read-only existing-Session preflight",
            retryable: false,
          },
        };
      }
      return connector.preflightExisting(input);
    });
  }

  ensureExisting(...args: Parameters<SessionConnectorV1["ensureExisting"]>): ReturnType<SessionConnectorV1["ensureExisting"]> {
    return this.implementation().then((connector) => connector.ensureExisting(...args));
  }

  create(...args: Parameters<SessionConnectorV1["create"]>): ReturnType<SessionConnectorV1["create"]> {
    return this.implementation().then((connector) => connector.create(...args));
  }

  getStatus(...args: Parameters<SessionConnectorV1["getStatus"]>): ReturnType<SessionConnectorV1["getStatus"]> {
    return this.implementation().then((connector) => connector.getStatus(...args));
  }

  readHistory(...args: Parameters<SessionConnectorV1["readHistory"]>): ReturnType<SessionConnectorV1["readHistory"]> {
    return this.implementation().then((connector) => connector.readHistory(...args));
  }

  subscribeEvents(...args: Parameters<SessionConnectorV1["subscribeEvents"]>): ReturnType<SessionConnectorV1["subscribeEvents"]> {
    return this.implementation().then((connector) => connector.subscribeEvents(...args));
  }

  send(...args: Parameters<SessionConnectorV1["send"]>): ReturnType<SessionConnectorV1["send"]> {
    return this.implementation().then((connector) => connector.send(...args));
  }

  interrupt(...args: Parameters<SessionConnectorV1["interrupt"]>): ReturnType<SessionConnectorV1["interrupt"]> {
    return this.implementation().then((connector) => connector.interrupt(...args));
  }

  resume(...args: Parameters<SessionConnectorV1["resume"]>): ReturnType<SessionConnectorV1["resume"]> {
    return this.implementation().then((connector) => connector.resume(...args));
  }

  takeover(...args: Parameters<SessionConnectorV1["takeover"]>): ReturnType<SessionConnectorV1["takeover"]> {
    return this.implementation().then((connector) => connector.takeover(...args));
  }

  getHealth(...args: Parameters<SessionConnectorV1["getHealth"]>): ReturnType<SessionConnectorV1["getHealth"]> {
    return this.implementation().then((connector) => connector.getHealth(...args));
  }

  getDeepLinks(...args: Parameters<SessionConnectorV1["getDeepLinks"]>): ReturnType<SessionConnectorV1["getDeepLinks"]> {
    return this.implementation().then((connector) => connector.getDeepLinks(...args));
  }

  /*
   * FNXC:HappierRuntimeSnapshotFacade 2026-07-20-11:32:
   * The production PluginRunner registers this lazy facade, not the eagerly
   * loaded MCP connector. Forward the optional local runtime snapshot capability
   * so the Room observation port can see the explicitly accountless model
   * snapshot. A legacy implementation remains fail-closed and cannot turn the
   * absence of this extension into model, account, quota, or scheduling proof.
   */
  getRuntimeSnapshot(
    ...args: Parameters<SessionConnectorRuntimeSnapshotSourceV1["getRuntimeSnapshot"]>
  ): ReturnType<SessionConnectorRuntimeSnapshotSourceV1["getRuntimeSnapshot"]> {
    return this.implementation().then((connector) => {
      const snapshotSource = connector as Partial<SessionConnectorRuntimeSnapshotSourceV1>;
      if (typeof snapshotSource.getRuntimeSnapshot !== "function") {
        return {
          ok: false,
          error: {
            code: "unavailable",
            message: "Happier local runtime snapshot extension is unavailable",
            retryable: false,
            safeDetails: {
              bridge: "local_happier_mcp_extension",
              state: "happier_local_runtime_snapshot_extension_required",
            },
          },
        };
      }
      return snapshotSource.getRuntimeSnapshot(...args);
    });
  }

  /*
   * FNXC:HappierProviderTelemetryFacade 2026-07-21-03:00:
   * PluginRunner exposes this lazy facade, so the opt-in local telemetry read
   * must project only Core's canonical value contract. A failed import or
   * legacy connector remains safely withheld and cannot imply provider readiness.
   */
  getProviderTelemetry(
    identity: SessionConnectorIdentityV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorProviderTelemetryV1>> {
    return this.implementation().then((connector) => {
      const telemetrySource = connector as Partial<SessionConnectorProviderTelemetrySourceV1>;
      return typeof telemetrySource.getProviderTelemetry === "function"
        ? telemetrySource.getProviderTelemetry(identity)
        : providerTelemetryWithheld(identity, "connector_telemetry_unsupported");
    }).catch(() => providerTelemetryWithheld(identity, "telemetry_unavailable"));
  }

  private implementation(): Promise<SessionConnectorV1> {
    this.implementationPromise ??= import("./session-connector.js")
      .then(({ HappierSessionConnector: OfficialMcpConnector, createHappierSessionConnectorWithHostWriteAuthorization: createAuthorizedConnector }) => {
        const verifier = pluginWriteAuthorizers.get(this);
        return verifier
          ? createAuthorizedConnector(this.options, verifier)
          : new OfficialMcpConnector(this.options);
      });
    return this.implementationPromise;
  }
}

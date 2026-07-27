import type {
  SessionConnectorCapabilitiesV1,
  SessionConnectorControlRequestV1,
  SessionConnectorControlResultV1,
  SessionConnectorCreateRequestV1,
  SessionConnectorDeepLinksRequestV1,
  SessionConnectorDeepLinksV1,
  SessionConnectorEnsureExistingRequestV1,
  SessionConnectorEnsureExistingResultV1,
  SessionConnectorEventV1,
  SessionConnectorHealthV1,
  SessionConnectorHistoryPageV1,
  SessionConnectorHistoryRequestV1,
  SessionConnectorIdentityV1,
  SessionConnectorPreflightExistingRequestV1,
  SessionConnectorPreflightExistingResultV1,
  SessionConnectorProviderTelemetrySourceV1,
  SessionConnectorProviderTelemetryV1,
  SessionConnectorResultV1,
  SessionConnectorRuntimeSnapshotSourceV1,
  SessionConnectorRuntimeSnapshotV1,
  SessionConnectorSendReceiptV1,
  SessionConnectorSendRequestV1,
  SessionConnectorStatusV1,
  SessionConnectorV1,
} from "@fusion/core";

import type {
  HappierApprovalReconciliationRequest,
  HappierApprovalStateStore,
  HappierApprovalStateStoreOptions,
} from "./approval-state-store.js";
import {
  createHappierApprovalStateStore,
} from "./approval-state-store.js";
import { resolveHappierBackend } from "./backend-resolver.js";
import {
  parseHappierPersistedBindings,
} from "./binding-identity.js";
import {
  verifyHappierCliAttestation,
  type HappierCliAttestation,
} from "./cli-attestation.js";
import {
  resolveHappierCliSettings,
  resolveHappierWaitTimeoutMs,
} from "./cli-spawn.js";
import type {
  HappierCapabilityProbeSample,
} from "./capability-probe.js";
import {
  createHappierDeliveryFenceStore,
  type HappierDeliveryFenceStore,
  type HappierDeliveryFenceStoreOptions,
} from "./delivery-fence-store.js";
import {
  openHappierMcpClient,
  type HappierMcpClientFactory,
} from "./happier-mcp-client.js";
import { probeHappierRuntime } from "./probe.js";
import {
  HappierSessionCapabilityController,
} from "./session-connector-capability.js";
import {
  HAPPIER_OFFICIAL_MCP_SOURCE_REVISION,
  HAPPIER_SESSION_CONNECTOR_ID,
  HAPPIER_SESSION_CONNECTOR_VERSION,
} from "./session-connector-contract.js";
import {
  HappierSessionIdentityResolver,
  bindHappierHostWriteAuthorization,
  type HappierHostWriteAuthorizationRequest,
  type HappierPluginWriteAuthorization,
} from "./session-connector-identity.js";
import {
  HappierSessionLifecycle,
} from "./session-connector-lifecycle.js";
import {
  HappierSessionSendReceiptController,
} from "./session-connector-send-receipt.js";
import {
  HappierSessionConnectorTransport,
} from "./session-connector-transport.js";
import {
  HAPPIER_DEFAULT_PROVIDER_WAIT_TIMEOUT_SECONDS,
  type HappierCliSettings,
} from "./types.js";

export {
  HAPPIER_OFFICIAL_MCP_SOURCE_REVISION,
  HAPPIER_SESSION_CONNECTOR_ID,
  HAPPIER_SESSION_CONNECTOR_VERSION,
} from "./session-connector-contract.js";
export {
  correlateRawHappierHistoryLocalId,
} from "./send-receipt.js";
export type {
  HappierHostWriteAuthorizationDecision,
  HappierHostWriteAuthorizationRequest,
  HappierPluginWriteAuthorization,
} from "./session-connector-identity.js";

export interface HappierSessionConnectorDependencies {
  readonly openMcpClient: HappierMcpClientFactory;
  readonly probeRuntime: typeof probeHappierRuntime;
  readonly attestCli: (
    settings: HappierCliSettings,
  ) => Promise<HappierCliAttestation>;
  readonly createDeliveryFenceStore: (
    options?: HappierDeliveryFenceStoreOptions,
  ) => HappierDeliveryFenceStore;
  readonly createApprovalStateStore: (
    options?: HappierApprovalStateStoreOptions,
  ) => HappierApprovalStateStore;
}

export interface HappierSessionConnectorOptions {
  readonly settings?: HappierCliSettings;
  readonly version?: string;
  readonly sourceRevision?: string;
  readonly sendTimeoutSeconds?: number;
  readonly approvalStateDirectory?: string;
  readonly now?: () => string;
  readonly dependencies?:
    Partial<HappierSessionConnectorDependencies>;
}

const defaultDependencies: HappierSessionConnectorDependencies = {
  openMcpClient: openHappierMcpClient,
  probeRuntime: probeHappierRuntime,
  attestCli: verifyHappierCliAttestation,
  createDeliveryFenceStore: createHappierDeliveryFenceStore,
  createApprovalStateStore: createHappierApprovalStateStore,
};

/**
 * Provider-neutral composition root for already-bound Happier sessions.
 *
 * FNXC:HappierSessionConnectorModules 2026-07-27-17:57:
 * PLG-P2-006 keeps this public class as the stable API while transport,
 * identity, capability, send/receipt, and lifecycle logic live in focused
 * modules. Every controller shares the same immutable bindings, attested
 * transport, approval store, and delivery fence; none creates a second Session
 * state authority.
 */
export class HappierSessionConnector implements
  SessionConnectorV1,
  SessionConnectorRuntimeSnapshotSourceV1,
  SessionConnectorProviderTelemetrySourceV1 {
  readonly contractVersion = 1 as const;
  readonly id = HAPPIER_SESSION_CONNECTOR_ID;
  readonly version: string;

  private readonly capabilities:
    HappierSessionCapabilityController;
  private readonly lifecycle: HappierSessionLifecycle;
  private readonly sendReceipt:
    HappierSessionSendReceiptController;

  constructor(options: HappierSessionConnectorOptions = {}) {
    const settings = resolveHappierCliSettings(options.settings);
    this.version =
      options.version?.trim() || HAPPIER_SESSION_CONNECTOR_VERSION;
    const sourceRevision =
      options.sourceRevision?.trim()
      || HAPPIER_OFFICIAL_MCP_SOURCE_REVISION;
    const sendTimeoutSeconds =
      options.sendTimeoutSeconds
      ?? settings.timeoutSeconds
      ?? HAPPIER_DEFAULT_PROVIDER_WAIT_TIMEOUT_SECONDS;
    if (
      !Number.isInteger(sendTimeoutSeconds)
      || sendTimeoutSeconds < 1
      || sendTimeoutSeconds > 3_600
    ) {
      throw new Error(
        "Happier Session Connector sendTimeoutSeconds must be an integer from 1 through 3600",
      );
    }
    resolveHappierWaitTimeoutMs(sendTimeoutSeconds, settings);
    const now = options.now ?? (() => new Date().toISOString());
    const dependencies = {
      ...defaultDependencies,
      ...(options.dependencies ?? {}),
    };
    const transport = new HappierSessionConnectorTransport(
      settings,
      {
        openMcpClient: dependencies.openMcpClient,
        attestCli: dependencies.attestCli,
      },
    );
    const deliveryFenceStore =
      dependencies.createDeliveryFenceStore({
        ...(settings.deliveryFenceDirectory
          ? { directory: settings.deliveryFenceDirectory }
          : {}),
      });
    const approvalStateStore =
      dependencies.createApprovalStateStore({
        ...(options.approvalStateDirectory
          ? { directory: options.approvalStateDirectory }
          : {}),
        now,
      });
    const bindings = parseHappierPersistedBindings(
      settings.happierSessionBindings ?? [],
    );
    const providers =
      new Set(bindings.map((binding) => binding.providerId));
    if (!settings.backend && providers.size > 1) {
      throw new Error(
        "Happier backend must be explicit when Session bindings use multiple providers",
      );
    }
    for (const provider of providers) {
      resolveHappierBackend(settings, provider);
    }
    const identity = new HappierSessionIdentityResolver(
      this.id,
      settings.activeServerId,
      bindings,
    );
    this.capabilities =
      new HappierSessionCapabilityController({
        owner: this,
        connectorId: this.id,
        connectorVersion: this.version,
        sourceRevision,
        settings,
        identity,
        transport,
        probeRuntime: dependencies.probeRuntime,
        now,
    });
    this.lifecycle = new HappierSessionLifecycle({
      settings,
      identity,
      capabilities: this.capabilities,
      transport,
      now,
    });
    this.sendReceipt =
      new HappierSessionSendReceiptController({
        owner: this,
        connectorId: this.id,
        identity,
        transport,
        sendTimeoutSeconds,
        deliveryFenceStore,
        approvalStateStore,
      });
  }

  getCapabilities(
    identity?: SessionConnectorIdentityV1,
  ): Promise<SessionConnectorCapabilitiesV1> {
    return this.capabilities.getCapabilities(identity);
  }

  getCapabilityProbeEvidence():
    readonly HappierCapabilityProbeSample[] {
    return this.capabilities.getCapabilityProbeEvidence();
  }

  preflightExisting(
    input: SessionConnectorPreflightExistingRequestV1,
  ): Promise<
    SessionConnectorResultV1<
      SessionConnectorPreflightExistingResultV1
    >
  > {
    return this.lifecycle.preflightExisting(input);
  }

  ensureExisting(
    input: SessionConnectorEnsureExistingRequestV1,
  ): Promise<
    SessionConnectorResultV1<SessionConnectorEnsureExistingResultV1>
  > {
    return this.lifecycle.ensureExisting(input);
  }

  create(
    input: SessionConnectorCreateRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorIdentityV1>> {
    return this.lifecycle.create(input);
  }

  getStatus(
    identity: SessionConnectorIdentityV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorStatusV1>> {
    return this.lifecycle.getStatus(identity);
  }

  getRuntimeSnapshot(
    identity: SessionConnectorIdentityV1,
  ): Promise<
    SessionConnectorResultV1<SessionConnectorRuntimeSnapshotV1>
  > {
    return this.lifecycle.getRuntimeSnapshot(identity);
  }

  getProviderTelemetry(
    identity: SessionConnectorIdentityV1,
  ): Promise<
    SessionConnectorResultV1<SessionConnectorProviderTelemetryV1>
  > {
    return this.lifecycle.getProviderTelemetry(identity);
  }

  readHistory(
    input: SessionConnectorHistoryRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorHistoryPageV1>> {
    return this.lifecycle.readHistory(input);
  }

  subscribeEvents(
    identity: SessionConnectorIdentityV1,
  ): Promise<
    SessionConnectorResultV1<AsyncIterable<SessionConnectorEventV1>>
  > {
    return this.lifecycle.subscribeEvents(identity);
  }

  send(
    input: SessionConnectorSendRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorSendReceiptV1>> {
    return this.sendReceipt.send(input);
  }

  reconcileApproval(
    input: HappierApprovalReconciliationRequest,
  ): Promise<SessionConnectorResultV1<SessionConnectorSendReceiptV1>> {
    return this.sendReceipt.reconcileApproval(input);
  }

  interrupt(
    input: SessionConnectorControlRequestV1,
  ): Promise<
    SessionConnectorResultV1<SessionConnectorControlResultV1>
  > {
    return this.sendReceipt.interrupt(input);
  }

  resume(
    input: SessionConnectorControlRequestV1,
  ): Promise<
    SessionConnectorResultV1<SessionConnectorControlResultV1>
  > {
    return this.lifecycle.resume(input);
  }

  takeover(
    input: SessionConnectorControlRequestV1,
  ): Promise<
    SessionConnectorResultV1<SessionConnectorControlResultV1>
  > {
    return this.lifecycle.takeover(input);
  }

  getHealth(hostId: string): Promise<SessionConnectorHealthV1> {
    return this.capabilities.getHealth(hostId);
  }

  getDeepLinks(
    input: SessionConnectorDeepLinksRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorDeepLinksV1>> {
    return this.lifecycle.getDeepLinks(input);
  }
}

/**
 * @internal The plugin runtime is the only supported path that may attach an
 * Engine-owned durable write authorizer to an otherwise read-only connector.
 */
export function createHappierSessionConnectorWithHostWriteAuthorization(
  options: HappierSessionConnectorOptions,
  verifier: HappierPluginWriteAuthorization,
): HappierSessionConnector {
  const connector = new HappierSessionConnector(options);
  bindHappierHostWriteAuthorization(connector, verifier);
  return connector;
}

export {
  HAPPIER_LOCAL_DIRECT_SESSION_EXTENSION_STATE,
} from "./happier-direct-session-capabilities.js";

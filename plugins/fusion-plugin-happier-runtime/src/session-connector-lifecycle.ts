import type {
  SessionConnectorControlRequestV1,
  SessionConnectorControlResultV1,
  SessionConnectorCreateRequestV1,
  SessionConnectorDeepLinksRequestV1,
  SessionConnectorDeepLinksV1,
  SessionConnectorEnsureExistingRequestV1,
  SessionConnectorEnsureExistingResultV1,
  SessionConnectorEventV1,
  SessionConnectorHistoryPageV1,
  SessionConnectorHistoryRequestV1,
  SessionConnectorIdentityV1,
  SessionConnectorPreflightExistingRequestV1,
  SessionConnectorPreflightExistingResultV1,
  SessionConnectorProviderTelemetryV1,
  SessionConnectorResultV1,
  SessionConnectorRuntimeSnapshotV1,
  SessionConnectorStatusV1,
} from "@fusion/core";

import { parseHappierCanonicalSessionUri } from "./binding-identity.js";
import { buildHappierSessionOpenUrl } from "./cli-spawn.js";
import { HAPPIER_OFFICIAL_MCP_TOOLS } from "./happier-mcp-client.js";
import { mcpResultRecord } from "./mcp-result-contract.js";
import type { HappierSessionCapabilityController } from "./session-connector-capability.js";
import {
  happierBindingRequired,
  type HappierSessionIdentityResolver,
} from "./session-connector-identity.js";
import { HappierSessionObservationController } from "./session-connector-observation.js";
import {
  happierConnectorFailure,
  nonEmptyHappierString,
  unsupportedHappierOperation,
  type HappierSessionConnectorTransport,
} from "./session-connector-transport.js";
import {
  sessionIdFromRecord,
  sessionListContains,
  statusLastActivity,
  statusState,
} from "./session-connector-status.js";
import {
  HappierCliError,
  type HappierCliSettings,
} from "./types.js";

const HAPPIER_TAKEOVER_REQUIRED =
  "happier_direct_ui_takeover_required";

interface HappierSessionLifecycleOptions {
  readonly settings: Readonly<HappierCliSettings>;
  readonly identity: HappierSessionIdentityResolver;
  readonly capabilities: HappierSessionCapabilityController;
  readonly transport: HappierSessionConnectorTransport;
  readonly now: () => string;
}

/*
 * FNXC:HappierSessionConnectorLifecycle 2026-07-27-17:57:
 * Existing-session attachment and lifecycle operations share one immutable
 * identity resolver and attested transport. Local observations are delegated
 * to their strict read projector; this module never owns delivery truth or a
 * second Session state store.
 */
export class HappierSessionLifecycle {
  private readonly settings: Readonly<HappierCliSettings>;
  private readonly identity: HappierSessionIdentityResolver;
  private readonly capabilities: HappierSessionCapabilityController;
  private readonly transport: HappierSessionConnectorTransport;
  private readonly observation:
    HappierSessionObservationController;
  private readonly now: () => string;

  constructor(options: HappierSessionLifecycleOptions) {
    this.settings = options.settings;
    this.identity = options.identity;
    this.capabilities = options.capabilities;
    this.transport = options.transport;
    this.observation =
      new HappierSessionObservationController({
        settings: options.settings,
        identity: options.identity,
        transport: options.transport,
        now: options.now,
      });
    this.now = options.now;
  }

  async ensureExisting(
    input: SessionConnectorEnsureExistingRequestV1,
  ): Promise<
    SessionConnectorResultV1<SessionConnectorEnsureExistingResultV1>
  > {
    const requiredHostId =
      nonEmptyHappierString(input.requiredHostId);
    if (
      typeof input.idempotencyKey !== "string"
      || !input.idempotencyKey.trim()
      || !requiredHostId
    ) {
      return happierConnectorFailure(
        "invalid_request",
        "A canonical Session URI, host identity, and idempotency key are required",
        false,
      );
    }
    const preflight = await this.preflightExisting({
      contractVersion: input.contractVersion,
      canonicalSessionUri: input.canonicalSessionUri,
      requiredHostId,
      ...(input.requiredMachineId === undefined
        ? {}
        : { requiredMachineId: input.requiredMachineId }),
    });
    if (!preflight.ok) return { ok: false, error: preflight.error };
    return {
      ok: true,
      value: {
        identity: preflight.value.identity,
        createdLink: false,
        providerTurnStarted: false,
        attachedAt: preflight.value.checkedAt,
        capabilities: preflight.value.capabilities,
      },
    };
  }

  /**
   * FNXC:HappierExistingSessionPreflight 2026-07-20-14:02:
   * Validate an already persisted binding with official MCP read tools only.
   * This never creates a link, sends provider input, or changes history.
   */
  async preflightExisting(
    input: SessionConnectorPreflightExistingRequestV1,
  ): Promise<
    SessionConnectorResultV1<
      SessionConnectorPreflightExistingResultV1
    >
  > {
    const requiredHostId =
      nonEmptyHappierString(input.requiredHostId);
    if (
      input.contractVersion !== 1
      || !nonEmptyHappierString(input.canonicalSessionUri)
      || !requiredHostId
    ) {
      return happierConnectorFailure(
        "invalid_request",
        "A canonical Session URI and host identity are required",
        false,
      );
    }
    const canonical =
      parseHappierCanonicalSessionUri(input.canonicalSessionUri);
    if (!canonical) {
      return happierConnectorFailure(
        "invalid_request",
        "The canonical native Session URI is invalid",
        false,
      );
    }
    const binding =
      this.identity.bindingForCanonicalSession(canonical);
    if (!binding) {
      return happierBindingRequired(
        "preflight this native Session",
      );
    }
    if (
      input.requiredMachineId
      && binding.machineId !== input.requiredMachineId
    ) {
      return happierConnectorFailure(
        "conflict",
        "The persisted Happier binding belongs to another machine",
        false,
      );
    }
    if (!this.settings.activeServerId?.trim()) {
      return happierConnectorFailure(
        "degraded",
        "The Happier active server profile is not pinned",
        false,
      );
    }
    if (binding.serverProfileId !== this.settings.activeServerId) {
      return happierConnectorFailure(
        "conflict",
        "The persisted Happier binding belongs to another server profile",
        false,
      );
    }
    const identity =
      this.identity.identityForBinding(binding, requiredHostId);
    return this.transport.withOfficialMcp(
      binding.happierSessionId,
      [
        HAPPIER_OFFICIAL_MCP_TOOLS.list,
        HAPPIER_OFFICIAL_MCP_TOOLS.status,
      ],
      async (client, available) => {
        const listed = mcpResultRecord(
          await client.callTool({
            name: HAPPIER_OFFICIAL_MCP_TOOLS.list,
            arguments: {},
          }),
          HAPPIER_OFFICIAL_MCP_TOOLS.list,
        );
        if (!sessionListContains(listed, binding.happierSessionId)) {
          throw new HappierCliError(
            "session",
            "The persisted Happier Session is absent from the official MCP session list",
          );
        }
        const status = mcpResultRecord(
          await client.callTool({
            name: HAPPIER_OFFICIAL_MCP_TOOLS.status,
            arguments: { sessionId: binding.happierSessionId },
          }),
          HAPPIER_OFFICIAL_MCP_TOOLS.status,
        );
        if (
          sessionIdFromRecord(status)
          !== binding.happierSessionId
        ) {
          throw new HappierCliError(
            "session",
            "Happier MCP status returned a different session id",
          );
        }
        const checkedAt = this.now();
        return {
          identity,
          providerTurnStarted: false,
          checkedAt,
          capabilities: this.capabilities.capabilitiesFromTools(
            available,
            identity,
            checkedAt,
          ),
        };
      },
    );
  }

  async create(
    _input: SessionConnectorCreateRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorIdentityV1>> {
    return unsupportedHappierOperation("provider-native create");
  }

  async getStatus(
    identity: SessionConnectorIdentityV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorStatusV1>> {
    const target = this.identity.validateBoundIdentity(
      identity,
      "read status",
    );
    if (!target.ok) return target;
    return this.transport.withOfficialMcp(
      target.value.happierSessionId,
      [HAPPIER_OFFICIAL_MCP_TOOLS.status],
      async (client) => {
        const status = mcpResultRecord(
          await client.callTool({
            name: HAPPIER_OFFICIAL_MCP_TOOLS.status,
            arguments: {
              sessionId: target.value.happierSessionId,
            },
          }),
          HAPPIER_OFFICIAL_MCP_TOOLS.status,
        );
        if (
          sessionIdFromRecord(status)
          !== target.value.happierSessionId
        ) {
          throw new HappierCliError(
            "session",
            "Happier MCP status returned a different session id",
          );
        }
        return {
          identity,
          state: statusState(status),
          lastActivityAt: statusLastActivity(status),
          connectorCursor:
            nonEmptyHappierString(status.cursor, 512) ?? null,
          nativeWriterDetected: false,
        };
      },
    );
  }

  getRuntimeSnapshot(
    identity: SessionConnectorIdentityV1,
  ): Promise<
    SessionConnectorResultV1<SessionConnectorRuntimeSnapshotV1>
  > {
    return this.observation.getRuntimeSnapshot(identity);
  }

  getProviderTelemetry(
    identity: SessionConnectorIdentityV1,
  ): Promise<
    SessionConnectorResultV1<SessionConnectorProviderTelemetryV1>
  > {
    return this.observation.getProviderTelemetry(identity);
  }

  readHistory(
    input: SessionConnectorHistoryRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorHistoryPageV1>> {
    return this.observation.readHistory(input);
  }

  async subscribeEvents(
    _identity: SessionConnectorIdentityV1,
  ): Promise<
    SessionConnectorResultV1<AsyncIterable<SessionConnectorEventV1>>
  > {
    return unsupportedHappierOperation("provider-native events");
  }

  async resume(
    _input: SessionConnectorControlRequestV1,
  ): Promise<
    SessionConnectorResultV1<SessionConnectorControlResultV1>
  > {
    return unsupportedHappierOperation("resume");
  }

  async takeover(
    _input: SessionConnectorControlRequestV1,
  ): Promise<
    SessionConnectorResultV1<SessionConnectorControlResultV1>
  > {
    return happierConnectorFailure(
      "unavailable",
      "Happier MCP does not provide programmatic Direct UI Take over. Take over manually in Direct UI, then have the host runtime verify and issue a write authorization before Fusion writes.",
      false,
      {
        bindingState: HAPPIER_TAKEOVER_REQUIRED,
        bridge: "official_mcp_stdio",
      },
    );
  }

  async getDeepLinks(
    input: SessionConnectorDeepLinksRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorDeepLinksV1>> {
    if (
      input.contractVersion !== 1
      || !nonEmptyHappierString(input.bindingId)
      || !nonEmptyHappierString(input.identity.hostId)
    ) {
      return happierConnectorFailure(
        "invalid_request",
        "Room binding and host identities are required for deep links",
        false,
      );
    }
    const target = this.identity.validateBoundIdentity(
      input.identity,
      "open a Happier session",
    );
    if (!target.ok) return target;
    if (!this.settings.webappUrl?.trim()) {
      return happierConnectorFailure(
        "degraded",
        "The current Happier web origin is unavailable",
        false,
      );
    }
    try {
      return {
        ok: true,
        value: {
          contractVersion: 1,
          bindingId: input.bindingId,
          connectorId: input.identity.connectorId,
          providerId: input.identity.providerId,
          nativeSessionId: input.identity.nativeSessionId,
          happierSessionId: input.identity.happierSessionId,
          serverProfileId: input.identity.serverProfileId,
          machineId: input.identity.machineId,
          hostId: input.identity.hostId,
          happierUrl: buildHappierSessionOpenUrl(
            this.settings.webappUrl,
            target.value.serverProfileId,
            target.value.happierSessionId,
          ),
          nativeSessionUrl: null,
        },
      };
    } catch {
      return happierConnectorFailure(
        "degraded",
        "The current Happier web origin cannot build a safe Session link",
        false,
      );
    }
  }
}

import {
  SESSION_CONNECTOR_CAPABILITIES,
  type SessionConnectorCapabilitiesV1,
  type SessionConnectorCapabilityCertificationV1,
  type SessionConnectorCapabilityName,
  type SessionConnectorCapabilityReasonCode,
  type SessionConnectorHealthV1,
  type SessionConnectorIdentityV1,
} from "@fusion/core";

import {
  probeHappierBindingCapabilities,
  type HappierCapabilityProbeSample,
} from "./capability-probe.js";
import {
  HAPPIER_LOCAL_MCP_EXTENSION_TOOLS,
  HAPPIER_OFFICIAL_MCP_TOOLS,
} from "./happier-mcp-client.js";
import { typedHappierHealthReasonCodes } from "./health-reasons.js";
import { probeHappierRuntime } from "./probe.js";
import {
  hasHappierHostWriteAuthorization,
  type HappierSessionIdentityResolver,
} from "./session-connector-identity.js";
import {
  missingHappierTools,
  nonEmptyHappierString,
  type HappierSessionConnectorTransport,
} from "./session-connector-transport.js";
import type { HappierCliSettings } from "./types.js";

function unavailableCertification(
  reasonCode: SessionConnectorCapabilityReasonCode,
): SessionConnectorCapabilityCertificationV1 {
  return {
    state: "unavailable",
    evidenceRef: null,
    reasonCode,
    lastVerifiedAt: null,
  };
}

function unverifiedCertification(
  reasonCode: SessionConnectorCapabilityReasonCode,
): SessionConnectorCapabilityCertificationV1 {
  return {
    state: "unverified",
    evidenceRef: null,
    reasonCode,
    lastVerifiedAt: null,
  };
}

function verifiedCertification(
  evidenceRef: string,
  verifiedAt: string,
): SessionConnectorCapabilityCertificationV1 {
  return {
    state: "verified",
    evidenceRef,
    reasonCode: null,
    lastVerifiedAt: verifiedAt,
  };
}

function toolEvidence(required: readonly string[]): string {
  return `happier-mcp:tool-discovery:${[...required].sort().join("+")}`;
}

interface HappierSessionCapabilityControllerOptions {
  readonly owner: object;
  readonly connectorId: string;
  readonly connectorVersion: string;
  readonly sourceRevision: string;
  readonly settings: Readonly<HappierCliSettings>;
  readonly identity: HappierSessionIdentityResolver;
  readonly transport: HappierSessionConnectorTransport;
  readonly probeRuntime: typeof probeHappierRuntime;
  readonly now: () => string;
}

/*
 * FNXC:HappierSessionConnectorCapability 2026-07-27-17:57:
 * Capability discovery is a read-only certification concern. It intersects
 * every applicable binding and exposes its concrete samples without owning
 * lifecycle, delivery, or identity mutation.
 */
export class HappierSessionCapabilityController {
  private readonly owner: object;
  private readonly connectorId: string;
  private readonly connectorVersion: string;
  private readonly sourceRevision: string;
  private readonly settings: Readonly<HappierCliSettings>;
  private readonly identity: HappierSessionIdentityResolver;
  private readonly transport: HappierSessionConnectorTransport;
  private readonly probeRuntime: typeof probeHappierRuntime;
  private readonly now: () => string;
  private lastCapabilityProbeSamples:
    readonly HappierCapabilityProbeSample[] = [];

  constructor(options: HappierSessionCapabilityControllerOptions) {
    this.owner = options.owner;
    this.connectorId = options.connectorId;
    this.connectorVersion = options.connectorVersion;
    this.sourceRevision = options.sourceRevision;
    this.settings = options.settings;
    this.identity = options.identity;
    this.transport = options.transport;
    this.probeRuntime = options.probeRuntime;
    this.now = options.now;
  }

  async getCapabilities(
    identity?: SessionConnectorIdentityV1,
  ): Promise<SessionConnectorCapabilitiesV1> {
    const resolvedBinding = identity
      ? this.identity.bindingForIdentity(identity)
      : null;
    const bindings = identity
      ? (resolvedBinding === null ? [] : [resolvedBinding])
      : this.identity.persistedBindings();
    if (bindings.length === 0) {
      this.lastCapabilityProbeSamples = [];
      return this.capabilitiesFromTools(
        new Set<string>(),
        identity,
        this.now(),
      );
    }
    const probe = await probeHappierBindingCapabilities(
      bindings,
      async (binding) =>
        this.transport.openClient(binding.happierSessionId),
      { concurrency: 3, now: this.now },
    );
    this.lastCapabilityProbeSamples = probe.samples;
    /*
     * FNXC:HappierGlobalCapabilityIntersection 2026-07-25-18:58:
     * Existing-Session Room creation has no native identity before
     * ensureExisting, but must verify every configured binding. Certify only
     * the intersection so one failed probe cannot borrow another Session's
     * tool surface.
     */
    return this.capabilitiesFromTools(
      probe.availableTools,
      identity,
      probe.verifiedAt,
    );
  }

  getCapabilityProbeEvidence(): readonly HappierCapabilityProbeSample[] {
    return this.lastCapabilityProbeSamples;
  }

  capabilitiesFromTools(
    available: ReadonlySet<string>,
    identity: SessionConnectorIdentityV1 | undefined,
    verifiedAt: string,
  ): SessionConnectorCapabilitiesV1 {
    const hasBinding = identity
      ? this.identity.bindingForIdentity(identity) !== null
      : this.identity.persistedBindings().length > 0;
    const canRequestHostWriteAuthorization =
      hasHappierHostWriteAuthorization(this.owner);
    const capability = (
      name: SessionConnectorCapabilityName,
    ): SessionConnectorCapabilityCertificationV1 => {
      const requirements: Partial<
        Record<SessionConnectorCapabilityName, readonly string[]>
      > = {
        ensureExisting: [
          HAPPIER_OFFICIAL_MCP_TOOLS.list,
          HAPPIER_OFFICIAL_MCP_TOOLS.status,
        ],
        status: [HAPPIER_OFFICIAL_MCP_TOOLS.status],
        history: [
          HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.reconciliationHistory,
        ],
        send: [
          HAPPIER_OFFICIAL_MCP_TOOLS.send,
          HAPPIER_OFFICIAL_MCP_TOOLS.wait,
          HAPPIER_OFFICIAL_MCP_TOOLS.history,
        ],
        interrupt: [HAPPIER_OFFICIAL_MCP_TOOLS.stop],
      };
      const required = requirements[name];
      if (!required) {
        return (
          name === "events"
          || name === "create"
          || name === "resume"
          || name === "takeover"
        )
          ? unavailableCertification("operation_unavailable")
          : unverifiedCertification("source_unverified");
      }
      if (!hasBinding) {
        return unavailableCertification("operation_unavailable");
      }
      if (name === "send" && !canRequestHostWriteAuthorization) {
        return unavailableCertification("operation_unavailable");
      }
      if (missingHappierTools(available, required).length > 0) {
        return unavailableCertification("operation_unavailable");
      }
      if (name === "interrupt") {
        return unavailableCertification("operation_unavailable");
      }
      /*
       * FNXC:HappierHostWriteCapability 2026-07-20-21:06:
       * Tool discovery plus the Engine-owned authorizer certifies a governed
       * send path, not a future write. send() still verifies the exact durable
       * authorization before opening the mutation.
       */
      return verifiedCertification(toolEvidence(required), verifiedAt);
    };
    return {
      contractVersion: 1,
      connectorId: this.connectorId,
      connectorVersion: this.connectorVersion,
      sourceRevision: this.sourceRevision,
      verifiedAt,
      capabilities: Object.fromEntries(
        SESSION_CONNECTOR_CAPABILITIES.map(
          (name) => [name, capability(name)],
        ),
      ) as SessionConnectorCapabilitiesV1["capabilities"],
    };
  }

  async getHealth(hostId: string): Promise<SessionConnectorHealthV1> {
    const capabilityMatrix = await this.getCapabilities();
    const capabilities = Object.fromEntries(
      SESSION_CONNECTOR_CAPABILITIES.map(
        (name) => [
          name,
          capabilityMatrix.capabilities[name].state,
        ],
      ),
    ) as SessionConnectorHealthV1["capabilities"];
    const host = nonEmptyHappierString(hostId)
      ? "reachable" as const
      : "unavailable" as const;
    try {
      const health = await this.probeRuntime(this.settings);
      const checkedAt = this.now();
      const reasonCodes = typedHappierHealthReasonCodes(health.details);
      const authentication = health.authenticated
        ? "authenticated" as const
        : reasonCodes.includes("authentication_required")
          ? "required" as const
          : "unknown" as const;
      const daemon = health.daemon
        ? "running" as const
        : reasonCodes.includes("daemon_stopped")
          ? "stopped" as const
          : "unknown" as const;
      const server = health.serverState === "reachable"
        ? "reachable" as const
        : health.serverState === "unreachable"
          ? "unreachable" as const
          : "unknown" as const;
      const backend = health.backend
        ? "ready" as const
        : "unavailable" as const;
      const state = host !== "reachable"
        ? "host_unavailable" as const
        : authentication === "required"
          ? "authentication_required" as const
          : health.ready
              && server === "reachable"
              && backend === "ready"
            ? "healthy" as const
            : "degraded" as const;
      return {
        connectorId: this.connectorId,
        hostId,
        state,
        checkedAt,
        authentication,
        daemon,
        server,
        backend,
        rateLimit: "unknown",
        host,
        capabilities,
        reasonCodes: host === "reachable"
          ? reasonCodes
          : [...new Set([
            ...reasonCodes,
            "host_unavailable" as const,
          ])],
        retryAfterMs: null,
      };
    } catch {
      const checkedAt = this.now();
      return {
        connectorId: this.connectorId,
        hostId,
        state: host === "reachable"
          ? "unavailable"
          : "host_unavailable",
        checkedAt,
        authentication: "unknown",
        daemon: "unknown",
        server: "unknown",
        backend: "unknown",
        rateLimit: "unknown",
        host,
        capabilities,
        reasonCodes: host === "reachable"
          ? ["probe_failed"]
          : ["probe_failed", "host_unavailable"],
        retryAfterMs: null,
      };
    }
  }
}

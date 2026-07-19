import {
  hashRoomValue,
  SESSION_CONNECTOR_CAPABILITIES,
  type SessionConnectorCapabilitiesV1,
  type SessionConnectorCapabilityCertificationV1,
  type SessionConnectorCapabilityName,
  type SessionConnectorCapabilityReasonCode,
  type SessionConnectorControlRequestV1,
  type SessionConnectorControlResultV1,
  type SessionConnectorCreateRequestV1,
  type SessionConnectorDeepLinksRequestV1,
  type SessionConnectorDeepLinksV1,
  type SessionConnectorEnsureExistingRequestV1,
  type SessionConnectorEnsureExistingResultV1,
  type SessionConnectorEventV1,
  type SessionConnectorHealthReasonCode,
  type SessionConnectorHealthV1,
  type SessionConnectorHistoryPageV1,
  type SessionConnectorHistoryRequestV1,
  type SessionConnectorIdentityV1,
  type SessionConnectorResultV1,
  type SessionConnectorSendReceiptV1,
  type SessionConnectorSendRequestV1,
  type SessionConnectorStatusV1,
  type SessionConnectorV1,
} from "@fusion/core";

import {
  buildHappierSessionOpenUrl,
  resolveHappierCliSettings,
} from "./cli-spawn.js";
import { HAPPIER_LOCAL_DIRECT_SESSION_EXTENSION_STATE } from "./happier-direct-session-capabilities.js";
import {
  HAPPIER_OFFICIAL_MCP_TOOLS,
  openHappierMcpClient,
  type HappierMcpClient,
  type HappierMcpClientFactory,
  type HappierMcpToolResult,
} from "./happier-mcp-client.js";
import { probeHappierRuntime } from "./probe.js";
import {
  HappierCliError,
  type HappierBackend,
  type HappierCliSettings,
  type HappierJsonRecord,
  type HappierSessionBinding,
} from "./types.js";
import {
  HAPPIER_OFFICIAL_MCP_SOURCE_REVISION,
  HAPPIER_SESSION_CONNECTOR_ID,
  HAPPIER_SESSION_CONNECTOR_VERSION,
} from "./session-connector-contract.js";

export {
  HAPPIER_OFFICIAL_MCP_SOURCE_REVISION,
  HAPPIER_SESSION_CONNECTOR_ID,
  HAPPIER_SESSION_CONNECTOR_VERSION,
} from "./session-connector-contract.js";

const DEFAULT_SEND_TIMEOUT_SECONDS = 300;
const HAPPIER_BINDING_REQUIRED = "happier_session_binding_required";
const HAPPIER_MCP_CAPABILITY_REQUIRED = "official_mcp_capability_required";
const HAPPIER_TAKEOVER_REQUIRED = "happier_direct_ui_takeover_required";

export interface HappierSessionConnectorDependencies {
  readonly openMcpClient: HappierMcpClientFactory;
  readonly probeRuntime: typeof probeHappierRuntime;
}

export interface HappierSessionConnectorOptions {
  readonly settings?: HappierCliSettings;
  readonly version?: string;
  readonly sourceRevision?: string;
  readonly sendTimeoutSeconds?: number;
  readonly now?: () => string;
  readonly dependencies?: Partial<HappierSessionConnectorDependencies>;
}

type CanonicalSession = Readonly<{
  canonicalSessionUri: string;
  providerId: HappierBackend;
  nativeSessionId: string;
}>;

type PersistedBinding = CanonicalSession & Readonly<{
  happierSessionId: string;
  serverProfileId: string;
  machineId: string;
  takeoverConfirmedAt: string | null;
}>;

type BoundIdentity = Readonly<{
  providerId: HappierBackend;
  nativeSessionId: string;
  happierSessionId: string;
  serverProfileId: string;
  machineId: string;
}>;

const defaultDependencies: HappierSessionConnectorDependencies = {
  openMcpClient: openHappierMcpClient,
  probeRuntime: probeHappierRuntime,
};

function isRecord(value: unknown): value is HappierJsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown, maximum = 2_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum || /[\u0000-\u001f\u007f]/u.test(trimmed)) return undefined;
  return trimmed;
}

function failure<T>(
  code: "unavailable" | "unverified" | "degraded" | "invalid_request" | "authentication_required" | "not_found" | "ambiguous" | "host_unavailable" | "rate_limited" | "conflict" | "transport" | "delivery_uncertain" | "internal",
  message: string,
  retryable: boolean,
  safeDetails?: Readonly<Record<string, unknown>>,
): SessionConnectorResultV1<T> {
  return { ok: false, error: { code, message, retryable, ...(safeDetails ? { safeDetails } : {}) } };
}

function unavailableCertification(reasonCode: SessionConnectorCapabilityReasonCode): SessionConnectorCapabilityCertificationV1 {
  return { state: "unavailable", evidenceRef: null, reasonCode, lastVerifiedAt: null };
}

function unverifiedCertification(reasonCode: SessionConnectorCapabilityReasonCode): SessionConnectorCapabilityCertificationV1 {
  return { state: "unverified", evidenceRef: null, reasonCode, lastVerifiedAt: null };
}

function verifiedCertification(evidenceRef: string, verifiedAt: string): SessionConnectorCapabilityCertificationV1 {
  return { state: "verified", evidenceRef, reasonCode: null, lastVerifiedAt: verifiedAt };
}

function unsupportedOperation<T>(operation: string): SessionConnectorResultV1<T> {
  return failure(
    "unavailable",
    `Happier MCP does not expose a certified ${operation} operation for provider-native sessions`,
    false,
    {
      bridge: "official_mcp_stdio",
      localExtensionState: HAPPIER_LOCAL_DIRECT_SESSION_EXTENSION_STATE,
    },
  );
}

function bindingRequired<T>(operation: string): SessionConnectorResultV1<T> {
  return failure(
    "unavailable",
    `A persisted Happier Session binding is required before Fusion can ${operation}. In Direct UI, bind the existing Codex, Claude, or OpenCode session to its Happier session id.`,
    false,
    {
      bindingState: HAPPIER_BINDING_REQUIRED,
      bridge: "official_mcp_stdio",
      localExtensionState: HAPPIER_LOCAL_DIRECT_SESSION_EXTENSION_STATE,
    },
  );
}

function mcpCapabilityRequired<T>(missingTools: readonly string[]): SessionConnectorResultV1<T> {
  return failure(
    "unavailable",
    "The official Happier MCP server does not expose the required Session control tool. Update or enable the Happier MCP external surface, then bind the session again in Direct UI.",
    false,
    {
      bindingState: HAPPIER_MCP_CAPABILITY_REQUIRED,
      bridge: "official_mcp_stdio",
      missingTools: [...missingTools].sort(),
      localExtensionState: HAPPIER_LOCAL_DIRECT_SESSION_EXTENSION_STATE,
    },
  );
}

function takeoverRequired<T>(): SessionConnectorResultV1<T> {
  return failure(
    "unavailable",
    "Direct UI Take over is required before Fusion can write to this Happier Session.",
    false,
    {
      bindingState: HAPPIER_TAKEOVER_REQUIRED,
      bridge: "official_mcp_stdio",
    },
  );
}

function parseCanonicalSessionUri(value: string): CanonicalSession | null {
  try {
    const uri = new URL(value);
    const providerId = uri.protocol.slice(0, -1);
    if (providerId !== "codex" && providerId !== "claude" && providerId !== "opencode") return null;
    const expectedHost = providerId === "codex" ? "threads" : "sessions";
    if (
      uri.hostname !== expectedHost
      || uri.username
      || uri.password
      || uri.port
      || uri.search
      || uri.hash
    ) return null;
    const path = uri.pathname.replace(/^\/+/u, "");
    const nativeSessionId = nonEmptyString(decodeURIComponent(path));
    if (!nativeSessionId || nativeSessionId.includes("/")) return null;
    return {
      canonicalSessionUri: `${providerId}://${expectedHost}/${encodeURIComponent(nativeSessionId)}`,
      providerId,
      nativeSessionId,
    };
  } catch {
    return null;
  }
}

function parsePersistedBinding(value: unknown): PersistedBinding | null {
  if (!isRecord(value)) return null;
  const canonical = typeof value.canonicalSessionUri === "string"
    ? parseCanonicalSessionUri(value.canonicalSessionUri)
    : null;
  const happierSessionId = nonEmptyString(value.happierSessionId, 512);
  const serverProfileId = nonEmptyString(value.serverProfileId, 512);
  const machineId = nonEmptyString(value.machineId, 512);
  if (!canonical || !happierSessionId || !serverProfileId || !machineId) return null;
  const takeoverConfirmedAt = value.takeoverConfirmedAt === undefined
    ? null
    : nonEmptyString(value.takeoverConfirmedAt, 128);
  if (takeoverConfirmedAt === undefined) return null;
  if (takeoverConfirmedAt !== null && !Number.isFinite(Date.parse(takeoverConfirmedAt))) return null;
  return { ...canonical, happierSessionId, serverProfileId, machineId, takeoverConfirmedAt };
}

function mcpResultRecord(result: HappierMcpToolResult, operation: string): HappierJsonRecord {
  const record = extractMcpResultRecord(result, operation);
  if (result.isError === true) throwMcpActionFailure(record, operation);
  return unwrapMcpActionResult(record, operation);
}

/*
FNXC:HappierOfficialMcpEnvelope 2026-07-19-20:31:
Happier's external MCP server delegates action-backed tools through its action
executor. The public `content` JSON is therefore `{ ok, result }`, and the
actual session service may itself return a `{ ok, ... }` record. Normalize
those documented envelopes here, while retaining direct structured results for
future official MCP releases. Never treat a wrapped action failure as a valid
session response.
*/
function extractMcpResultRecord(result: HappierMcpToolResult, operation: string): HappierJsonRecord {
  if (isRecord(result.structuredContent)) return result.structuredContent;
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
      try {
        const parsed: unknown = JSON.parse(item.text);
        if (isRecord(parsed)) return parsed;
      } catch {
        // Continue to the next textual content item; no transcript text is surfaced.
      }
    }
  }
  throw new HappierCliError("protocol", `Happier MCP ${operation} returned no structured result`);
}

function unwrapMcpActionResult(value: HappierJsonRecord, operation: string): HappierJsonRecord {
  let current = value;
  for (let depth = 0; depth < 2; depth += 1) {
    if (current.ok === false) throwMcpActionFailure(current, operation);
    if (current.ok !== true || !isRecord(current.result)) return current;
    current = current.result;
  }
  if (current.ok === false) throwMcpActionFailure(current, operation);
  return current;
}

function throwMcpActionFailure(value: HappierJsonRecord, operation: string): never {
  const officialCode = nonEmptyString(value.errorCode, 128)
    ?? nonEmptyString(value.code, 128)
    ?? "mcp_action_failed";
  throw new HappierCliError(
    mapMcpOfficialErrorCode(officialCode),
    `Happier MCP ${operation} failed: ${officialCode}`,
    undefined,
    officialCode,
  );
}

function mapMcpOfficialErrorCode(officialCode: string): HappierCliError["code"] {
  switch (officialCode.toLowerCase().replace(/[-\s]/g, "_")) {
    case "not_authenticated":
    case "authentication_required":
    case "auth_required":
    case "unauthorized":
    case "forbidden":
    case "invalid_token":
    case "token_expired":
      return "authentication";
    case "timeout":
    case "timed_out":
      return "timeout";
    case "server_unreachable":
    case "server_unavailable":
    case "connection_failed":
    case "network_error":
      return "server";
    case "daemon_unavailable":
    case "daemon_not_running":
      return "daemon";
    case "backend_unavailable":
    case "backend_not_found":
    case "provider_unavailable":
    case "model_unavailable":
      return "backend";
    case "session_not_found":
    case "session_id_ambiguous":
    case "session_archived":
    case "session_unavailable":
    case "invalid_session":
      return "session";
    default:
      return "protocol";
  }
}

function sessionIdFromRecord(record: HappierJsonRecord): string | undefined {
  return nonEmptyString(record.sessionId, 512)
    ?? (isRecord(record.session) ? nonEmptyString(record.session.id, 512) : undefined)
    ?? nonEmptyString(record.id, 512);
}

function statusState(record: HappierJsonRecord): SessionConnectorStatusV1["state"] {
  const session = isRecord(record.session) ? record.session : record;
  const agentState = isRecord(record.agentState) ? record.agentState : undefined;
  const raw = nonEmptyString(agentState?.status)
    ?? nonEmptyString(agentState?.state)
    ?? nonEmptyString(session.status)
    ?? nonEmptyString(session.state);
  switch (raw?.toLowerCase()) {
    case "waiting":
    case "waitingoninput":
    case "awaiting_input":
    case "waiting_input":
      return "waiting_input";
    case "running":
    case "active":
    case "busy":
    case "starting":
    case "recovering":
      return "running";
    case "paused":
    case "blocked":
      return "paused";
    case "failed":
    case "error":
    case "lost":
    case "unavailable":
      return "lost";
    default:
      return session.active === true ? "idle" : session.active === false ? "lost" : "unknown";
  }
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function statusLastActivity(record: HappierJsonRecord): string | null {
  const session = isRecord(record.session) ? record.session : record;
  const agentState = isRecord(record.agentState) ? record.agentState : undefined;
  for (const value of [
    session.lastActivityAt,
    session.updatedAt,
    agentState?.lastActivityAt,
    agentState?.updatedAt,
    record.lastActivityAt,
    record.updatedAt,
  ]) {
    const parsed = isoTimestamp(value);
    if (parsed) return parsed;
  }
  return null;
}

function sessionListContains(record: HappierJsonRecord, expectedSessionId: string): boolean {
  const sessions = Array.isArray(record.sessions)
    ? record.sessions
    : isRecord(record.data) && Array.isArray(record.data.sessions)
      ? record.data.sessions
      : [];
  return sessions.some((candidate) => isRecord(candidate) && sessionIdFromRecord(candidate) === expectedSessionId);
}

function missingTools(available: ReadonlySet<string>, required: readonly string[]): string[] {
  return required.filter((tool) => !available.has(tool));
}

function validatedToolNames(tools: readonly { name: string }[]): Set<string> {
  return new Set(tools.map((tool) => tool.name));
}

function mapMcpFailure<T>(error: unknown): SessionConnectorResultV1<T> {
  if (!(error instanceof HappierCliError)) {
    return failure("internal", "Happier MCP connector operation failed", false);
  }
  const details = { bridge: "official_mcp_stdio", category: error.code };
  if (error.code === "authentication") {
    return failure("authentication_required", "Happier authentication is required", false, details);
  }
  if (error.code === "session") {
    return failure("not_found", "The bound Happier Session was not found", false, details);
  }
  if (error.code === "timeout") {
    return failure("transport", "Happier MCP request timed out", true, details);
  }
  if (error.code === "process" || error.code === "server" || error.code === "daemon" || error.code === "backend") {
    return failure("transport", "Happier MCP transport is unavailable", true, details);
  }
  return failure("degraded", "Happier MCP returned an invalid response", false, details);
}

function toolEvidence(required: readonly string[]): string {
  return `happier-mcp:tool-discovery:${[...required].sort().join("+")}`;
}

/**
 * Provider-neutral bridge for already-bound Happier sessions.
 *
 * FNXC:HappierOfficialMcpBridge 2026-07-19-19:29:
 * Normal Fusion routing never invokes the local `direct-session ensure --uri`
 * extension. A manually persisted Happier session id is validated through
 * documented MCP tools, and writes require Direct UI Take over evidence. Tool
 * discovery proves MCP availability only; it is not same-native-session E2E.
 */
export class HappierSessionConnector implements SessionConnectorV1 {
  readonly contractVersion = 1 as const;
  readonly id = HAPPIER_SESSION_CONNECTOR_ID;
  readonly version: string;

  private readonly settings: ReturnType<typeof resolveHappierCliSettings>;
  private readonly sourceRevision: string;
  private readonly sendTimeoutSeconds: number;
  private readonly now: () => string;
  private readonly dependencies: HappierSessionConnectorDependencies;

  constructor(options: HappierSessionConnectorOptions = {}) {
    this.settings = resolveHappierCliSettings(options.settings);
    this.version = options.version?.trim() || HAPPIER_SESSION_CONNECTOR_VERSION;
    this.sourceRevision = options.sourceRevision?.trim() || HAPPIER_OFFICIAL_MCP_SOURCE_REVISION;
    this.sendTimeoutSeconds = options.sendTimeoutSeconds ?? DEFAULT_SEND_TIMEOUT_SECONDS;
    if (!Number.isInteger(this.sendTimeoutSeconds) || this.sendTimeoutSeconds < 1 || this.sendTimeoutSeconds > 3_600) {
      throw new Error("Happier Session Connector sendTimeoutSeconds must be an integer from 1 through 3600");
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.dependencies = { ...defaultDependencies, ...(options.dependencies ?? {}) };
  }

  async getCapabilities(identity?: SessionConnectorIdentityV1): Promise<SessionConnectorCapabilitiesV1> {
    const verifiedAt = this.now();
    const binding = identity ? this.bindingForIdentity(identity) : null;
    if (!binding) return this.capabilitiesFromTools(new Set<string>(), identity, verifiedAt);
    let client: HappierMcpClient | undefined;
    let available = new Set<string>();
    try {
      client = await this.dependencies.openMcpClient({ settings: this.settings, sessionId: binding.happierSessionId });
      available = validatedToolNames(await client.listTools());
    } catch {
      // The capability result below remains fail-closed with no claimed MCP tools.
    } finally {
      await client?.close().catch(() => undefined);
    }
    return this.capabilitiesFromTools(available, identity, verifiedAt);
  }

  async ensureExisting(
    input: SessionConnectorEnsureExistingRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorEnsureExistingResultV1>> {
    const requiredHostId = nonEmptyString(input.requiredHostId);
    if (
      input.contractVersion !== 1
      || !nonEmptyString(input.canonicalSessionUri)
      || !nonEmptyString(input.idempotencyKey)
      || !requiredHostId
    ) {
      return failure("invalid_request", "A canonical Session URI, host identity, and idempotency key are required", false);
    }
    const canonical = parseCanonicalSessionUri(input.canonicalSessionUri);
    if (!canonical) {
      return failure("invalid_request", "The canonical native Session URI is invalid", false);
    }
    const binding = this.bindingForCanonicalSession(canonical);
    if (!binding) return bindingRequired("attach this native Session");
    if (input.requiredMachineId && binding.machineId !== input.requiredMachineId) {
      return failure("conflict", "The persisted Happier binding belongs to another machine", false);
    }
    if (!this.settings.activeServerId?.trim()) {
      return failure("degraded", "The Happier active server profile is not pinned", false);
    }
    if (binding.serverProfileId !== this.settings.activeServerId) {
      return failure("conflict", "The persisted Happier binding belongs to another server profile", false);
    }
    const identity: SessionConnectorIdentityV1 = {
      connectorId: this.id,
      providerId: binding.providerId,
      nativeSessionId: binding.nativeSessionId,
      happierSessionId: binding.happierSessionId,
      serverProfileId: binding.serverProfileId,
      machineId: binding.machineId,
      hostId: requiredHostId,
    };
    return this.withOfficialMcp(
      binding.happierSessionId,
      [HAPPIER_OFFICIAL_MCP_TOOLS.list, HAPPIER_OFFICIAL_MCP_TOOLS.status],
      async (client, available) => {
        const listed = mcpResultRecord(
          await client.callTool({ name: HAPPIER_OFFICIAL_MCP_TOOLS.list, arguments: {} }),
          HAPPIER_OFFICIAL_MCP_TOOLS.list,
        );
        if (!sessionListContains(listed, binding.happierSessionId)) {
          throw new HappierCliError("session", "The persisted Happier Session is absent from the official MCP session list");
        }
        const status = mcpResultRecord(
          await client.callTool({
            name: HAPPIER_OFFICIAL_MCP_TOOLS.status,
            arguments: { sessionId: binding.happierSessionId },
          }),
          HAPPIER_OFFICIAL_MCP_TOOLS.status,
        );
        if (sessionIdFromRecord(status) !== binding.happierSessionId) {
          throw new HappierCliError("session", "Happier MCP status returned a different session id");
        }
        return {
          identity,
          createdLink: false,
          providerTurnStarted: false,
          attachedAt: this.now(),
          capabilities: this.capabilitiesFromTools(available, identity, this.now()),
        };
      },
    );
  }

  async create(
    _input: SessionConnectorCreateRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorIdentityV1>> {
    return unsupportedOperation("provider-native create");
  }

  async getStatus(
    identity: SessionConnectorIdentityV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorStatusV1>> {
    const target = this.validateBoundIdentity(identity, "read status");
    if (!target.ok) return target;
    return this.withOfficialMcp(
      target.value.happierSessionId,
      [HAPPIER_OFFICIAL_MCP_TOOLS.status],
      async (client) => {
        const status = mcpResultRecord(
          await client.callTool({
            name: HAPPIER_OFFICIAL_MCP_TOOLS.status,
            arguments: { sessionId: target.value.happierSessionId },
          }),
          HAPPIER_OFFICIAL_MCP_TOOLS.status,
        );
        if (sessionIdFromRecord(status) !== target.value.happierSessionId) {
          throw new HappierCliError("session", "Happier MCP status returned a different session id");
        }
        return {
          identity,
          state: statusState(status),
          lastActivityAt: statusLastActivity(status),
          connectorCursor: nonEmptyString(status.cursor, 512) ?? null,
          // MCP session status does not prove which native UI authored a turn.
          nativeWriterDetected: false,
        };
      },
    );
  }

  async readHistory(
    _input: SessionConnectorHistoryRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorHistoryPageV1>> {
    return unsupportedOperation("provider-native history");
  }

  async subscribeEvents(
    _identity: SessionConnectorIdentityV1,
  ): Promise<SessionConnectorResultV1<AsyncIterable<SessionConnectorEventV1>>> {
    return unsupportedOperation("provider-native events");
  }

  async send(
    input: SessionConnectorSendRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorSendReceiptV1>> {
    const target = this.validateBoundIdentity(input.identity, "send a message");
    if (!target.ok) return target;
    if (
      input.contractVersion !== 1
      || !nonEmptyString(input.bindingId)
      || !nonEmptyString(input.logicalMessageId)
      || !nonEmptyString(input.idempotencyKey)
      || !nonEmptyString(input.localMessageId, 128)
      || !/^[A-Za-z0-9._:-]+$/u.test(input.localMessageId)
      || !nonEmptyString(input.content, 100_000)
      || input.contentHash !== hashRoomValue(input.content)
    ) {
      return failure("invalid_request", "Happier send requires valid identity, idempotency, content, and content hash", false);
    }
    if (!this.hasManualTakeover(input.identity)) return takeoverRequired();
    return this.withOfficialMcp(
      target.value.happierSessionId,
      [HAPPIER_OFFICIAL_MCP_TOOLS.send, HAPPIER_OFFICIAL_MCP_TOOLS.wait],
      async (client) => {
        mcpResultRecord(
          await client.callTool({
            name: HAPPIER_OFFICIAL_MCP_TOOLS.send,
            arguments: {
              sessionId: target.value.happierSessionId,
              message: input.content,
              wait: false,
              timeoutSeconds: this.sendTimeoutSeconds,
            },
          }),
          HAPPIER_OFFICIAL_MCP_TOOLS.send,
        );
        mcpResultRecord(
          await client.callTool({
            name: HAPPIER_OFFICIAL_MCP_TOOLS.wait,
            arguments: {
              sessionId: target.value.happierSessionId,
              timeoutSeconds: this.sendTimeoutSeconds,
            },
          }),
          HAPPIER_OFFICIAL_MCP_TOOLS.wait,
        );
        return {
          outcome: "confirmed" as const,
          connectorAcknowledgementId: input.localMessageId,
          nativeMessageId: null,
          cursor: null,
          acceptedAt: this.now(),
        };
      },
    );
  }

  async interrupt(
    input: SessionConnectorControlRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorControlResultV1>> {
    const target = this.validateBoundIdentity(input.identity, "stop a session");
    if (!target.ok) return target;
    if (input.contractVersion !== 1 || !nonEmptyString(input.idempotencyKey) || !nonEmptyString(input.reason, 2_000)) {
      return failure("invalid_request", "Happier stop requires an identity, idempotency key, and reason", false);
    }
    if (!this.hasManualTakeover(input.identity)) return takeoverRequired();
    return this.withOfficialMcp(
      target.value.happierSessionId,
      [HAPPIER_OFFICIAL_MCP_TOOLS.stop],
      async (client) => {
        mcpResultRecord(
          await client.callTool({
            name: HAPPIER_OFFICIAL_MCP_TOOLS.stop,
            arguments: { sessionId: target.value.happierSessionId },
          }),
          HAPPIER_OFFICIAL_MCP_TOOLS.stop,
        );
        return { state: "accepted" as const, connectorAcknowledgementId: input.idempotencyKey };
      },
    );
  }

  async resume(
    _input: SessionConnectorControlRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorControlResultV1>> {
    return unsupportedOperation("resume");
  }

  async takeover(
    _input: SessionConnectorControlRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorControlResultV1>> {
    return failure(
      "unavailable",
      "Happier MCP does not provide programmatic Direct UI Take over. Take over manually in Direct UI, then persist takeover confirmation before Fusion writes.",
      false,
      { bindingState: HAPPIER_TAKEOVER_REQUIRED, bridge: "official_mcp_stdio" },
    );
  }

  async getHealth(hostId: string): Promise<SessionConnectorHealthV1> {
    const capabilityMatrix = await this.getCapabilities();
    const capabilities = Object.fromEntries(
      SESSION_CONNECTOR_CAPABILITIES.map((name) => [name, capabilityMatrix.capabilities[name].state]),
    ) as SessionConnectorHealthV1["capabilities"];
    const checkedAt = this.now();
    const host = nonEmptyString(hostId) ? "reachable" as const : "unavailable" as const;
    try {
      const health = await this.dependencies.probeRuntime(this.settings);
      const reasonCodes = typedHealthReasonCodes(health.details);
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
      const backend = health.backend ? "ready" as const : "unavailable" as const;
      const state = host !== "reachable"
        ? "host_unavailable" as const
        : authentication === "required"
          ? "authentication_required" as const
          : health.ready && server === "reachable" && backend === "ready"
            ? "healthy" as const
            : "degraded" as const;
      return {
        connectorId: this.id,
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
        reasonCodes: host === "reachable" ? reasonCodes : [...new Set([...reasonCodes, "host_unavailable" as const])],
        retryAfterMs: null,
      };
    } catch {
      return {
        connectorId: this.id,
        hostId,
        state: host === "reachable" ? "unavailable" : "host_unavailable",
        checkedAt,
        authentication: "unknown",
        daemon: "unknown",
        server: "unknown",
        backend: "unknown",
        rateLimit: "unknown",
        host,
        capabilities,
        reasonCodes: host === "reachable" ? ["probe_failed"] : ["probe_failed", "host_unavailable"],
        retryAfterMs: null,
      };
    }
  }

  async getDeepLinks(
    input: SessionConnectorDeepLinksRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorDeepLinksV1>> {
    if (input.contractVersion !== 1 || !nonEmptyString(input.bindingId) || !nonEmptyString(input.identity.hostId)) {
      return failure("invalid_request", "Room binding and host identities are required for deep links", false);
    }
    const target = this.validateBoundIdentity(input.identity, "open a Happier session");
    if (!target.ok) return target;
    if (!this.settings.webappUrl?.trim()) {
      return failure("degraded", "The current Happier web origin is unavailable", false);
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
          // The adapter deliberately does not certify provider-native deep links.
          nativeSessionUrl: null,
        },
      };
    } catch {
      return failure("degraded", "The current Happier web origin cannot build a safe Session link", false);
    }
  }

  private async withOfficialMcp<T>(
    sessionId: string,
    requiredTools: readonly string[],
    operation: (client: HappierMcpClient, available: ReadonlySet<string>) => Promise<T>,
  ): Promise<SessionConnectorResultV1<T>> {
    let client: HappierMcpClient | undefined;
    try {
      client = await this.dependencies.openMcpClient({ settings: this.settings, sessionId });
      const available = validatedToolNames(await client.listTools());
      const missing = missingTools(available, requiredTools);
      if (missing.length > 0) return mcpCapabilityRequired(missing);
      return { ok: true, value: await operation(client, available) };
    } catch (error) {
      return mapMcpFailure(error);
    } finally {
      await client?.close().catch(() => undefined);
    }
  }

  private capabilitiesFromTools(
    available: ReadonlySet<string>,
    identity: SessionConnectorIdentityV1 | undefined,
    verifiedAt: string,
  ): SessionConnectorCapabilitiesV1 {
    const hasBinding = identity
      ? this.bindingForIdentity(identity) !== null
      : this.persistedBindings().length > 0;
    const writeAuthorized = identity
      ? this.hasManualTakeover(identity)
      : this.persistedBindings().some((binding) => binding.takeoverConfirmedAt !== null);
    const capability = (name: SessionConnectorCapabilityName): SessionConnectorCapabilityCertificationV1 => {
      const requirements: Partial<Record<SessionConnectorCapabilityName, readonly string[]>> = {
        ensureExisting: [HAPPIER_OFFICIAL_MCP_TOOLS.list, HAPPIER_OFFICIAL_MCP_TOOLS.status],
        status: [HAPPIER_OFFICIAL_MCP_TOOLS.status],
        send: [HAPPIER_OFFICIAL_MCP_TOOLS.send, HAPPIER_OFFICIAL_MCP_TOOLS.wait],
        interrupt: [HAPPIER_OFFICIAL_MCP_TOOLS.stop],
      };
      const required = requirements[name];
      if (!required) {
        return name === "history" || name === "events" || name === "create" || name === "resume" || name === "takeover"
          ? unavailableCertification("operation_unavailable")
          : unverifiedCertification("source_unverified");
      }
      if (!hasBinding) return unavailableCertification("operation_unavailable");
      if ((name === "send" || name === "interrupt") && !writeAuthorized) {
        return unavailableCertification("operation_unavailable");
      }
      if (missingTools(available, required).length > 0) return unavailableCertification("operation_unavailable");
      // This is an MCP tool-advertisement proof only, never provider-native E2E.
      return verifiedCertification(toolEvidence(required), verifiedAt);
    };
    return {
      contractVersion: 1,
      connectorId: this.id,
      connectorVersion: this.version,
      sourceRevision: this.sourceRevision,
      verifiedAt,
      capabilities: Object.fromEntries(
        SESSION_CONNECTOR_CAPABILITIES.map((name) => [name, capability(name)]),
      ) as SessionConnectorCapabilitiesV1["capabilities"],
    };
  }

  private persistedBindings(): readonly PersistedBinding[] {
    const bindings = this.settings.happierSessionBindings ?? [];
    const parsed = bindings.map(parsePersistedBinding).filter((binding): binding is PersistedBinding => binding !== null);
    const seen = new Set<string>();
    return parsed.filter((binding) => {
      const key = `${binding.canonicalSessionUri}\u0000${binding.happierSessionId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private bindingForCanonicalSession(canonical: CanonicalSession): PersistedBinding | null {
    const matches = this.persistedBindings().filter((binding) => binding.canonicalSessionUri === canonical.canonicalSessionUri);
    return matches.length === 1 ? matches[0]! : null;
  }

  private bindingForIdentity(identity: SessionConnectorIdentityV1): PersistedBinding | null {
    const canonical = parseCanonicalSessionUri(
      `${identity.providerId === "codex" ? "codex://threads" : identity.providerId === "claude" ? "claude://sessions" : identity.providerId === "opencode" ? "opencode://sessions" : "invalid://invalid"}/${encodeURIComponent(identity.nativeSessionId)}`,
    );
    if (!canonical || !identity.happierSessionId || !identity.serverProfileId || !identity.machineId) return null;
    const matches = this.persistedBindings().filter((binding) =>
      binding.canonicalSessionUri === canonical.canonicalSessionUri
      && binding.happierSessionId === identity.happierSessionId
      && binding.serverProfileId === identity.serverProfileId
      && binding.machineId === identity.machineId,
    );
    return matches.length === 1 ? matches[0]! : null;
  }

  private hasManualTakeover(identity: SessionConnectorIdentityV1): boolean {
    const binding = this.bindingForIdentity(identity);
    return binding !== null && binding.takeoverConfirmedAt !== null;
  }

  private validateBoundIdentity(
    identity: SessionConnectorIdentityV1,
    operation: string,
  ): SessionConnectorResultV1<BoundIdentity> {
    if (identity.connectorId !== this.id) {
      return failure("conflict", "Session identity belongs to a different connector", false);
    }
    if (identity.providerId !== "codex" && identity.providerId !== "claude" && identity.providerId !== "opencode") {
      return failure("invalid_request", "The persisted native Session provider is unsupported", false);
    }
    const nativeSessionId = nonEmptyString(identity.nativeSessionId, 512);
    const happierSessionId = nonEmptyString(identity.happierSessionId, 512);
    const serverProfileId = nonEmptyString(identity.serverProfileId, 512);
    const machineId = nonEmptyString(identity.machineId, 512);
    if (!nativeSessionId || !happierSessionId || !serverProfileId || !machineId) {
      return bindingRequired(operation);
    }
    const binding = this.bindingForIdentity(identity);
    if (!binding) return bindingRequired(operation);
    if (!this.settings.activeServerId?.trim()) {
      return failure("degraded", "The Happier active server profile is not pinned", false);
    }
    if (binding.serverProfileId !== this.settings.activeServerId) {
      return failure("conflict", "The Happier server profile does not match the immutable Session binding", false);
    }
    return {
      ok: true,
      value: {
        providerId: binding.providerId,
        nativeSessionId: binding.nativeSessionId,
        happierSessionId: binding.happierSessionId,
        serverProfileId: binding.serverProfileId,
        machineId: binding.machineId,
      },
    };
  }
}

const HAPPIER_HEALTH_REASON_MAP: Readonly<Record<string, SessionConnectorHealthReasonCode>> = {
  "executable-unavailable": "executable_unavailable",
  "executable-timeout": "executable_timeout",
  "executable-not-found": "executable_not_found",
  "authentication-required": "authentication_required",
  "authentication-timeout": "authentication_timeout",
  "authentication-invalid": "authentication_invalid",
  "server-unreachable": "server_unreachable",
  "server-not-probed": "server_not_probed",
  "daemon-stopped": "daemon_stopped",
  "status-timeout": "status_timeout",
  "status-invalid": "status_invalid",
  "backend-unavailable": "backend_unavailable",
  "backend-timeout": "backend_timeout",
  "backend-invalid": "backend_invalid",
  "rate-limited": "rate_limited",
};

function typedHealthReasonCodes(details: readonly unknown[]): SessionConnectorHealthReasonCode[] {
  return [...new Set(details.flatMap((detail) =>
    typeof detail === "string" && HAPPIER_HEALTH_REASON_MAP[detail]
      ? [HAPPIER_HEALTH_REASON_MAP[detail]]
      : [],
  ))];
}

export { HAPPIER_LOCAL_DIRECT_SESSION_EXTENSION_STATE } from "./happier-direct-session-capabilities.js";

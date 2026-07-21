import {
  hashRoomValue,
  SESSION_CONNECTOR_HISTORY_PAGE_LIMIT,
  SESSION_CONNECTOR_CAPABILITIES,
  SESSION_CONNECTOR_PROVIDER_TELEMETRY_CONTRACT_VERSION,
  type SessionConnectorCapabilitiesV1,
  type SessionConnectorCapabilityCertificationV1,
  type SessionConnectorCapabilityName,
  type SessionConnectorCapabilityReasonCode,
  type SessionConnectorControlRequestV1,
  type SessionConnectorControlResultV1,
  type SessionConnectorCreateRequestV1,
  type SessionConnectorDeliveryAuthorizationV1,
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
  type SessionConnectorPreflightExistingRequestV1,
  type SessionConnectorPreflightExistingResultV1,
  type SessionConnectorProviderTelemetrySourceV1,
  type SessionConnectorProviderTelemetryV1,
  type SessionConnectorProviderTelemetryWithheldReasonV1,
  type SessionConnectorResultV1,
  type SessionConnectorRuntimeSnapshotSourceV1,
  type SessionConnectorRuntimeSnapshotV1,
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
  HAPPIER_LOCAL_MCP_EXTENSION_TOOLS,
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
const HAPPIER_HOST_WRITE_AUTHORIZATION_REQUIRED = "happier_host_write_authorization_required";
const HAPPIER_LOCAL_RUNTIME_SNAPSHOT_REQUIRED = "happier_local_runtime_snapshot_extension_required";
const HAPPIER_LOCAL_RECONCILIATION_HISTORY_REQUIRED = "happier_local_reconciliation_history_extension_required";
const LOCAL_RUNTIME_SNAPSHOT_MAX_FUTURE_SKEW_MS = 5_000;
// FNXC:HappierDurableWriteScope 2026-07-20-22:20: keep the connector scope
// prefix derived from its registered ID so the plugin and Engine authorize the
// same binding-specific digest instead of relying on a duplicated literal.
const HAPPIER_WRITE_SCOPE_PREFIX = `${HAPPIER_SESSION_CONNECTOR_ID}-write-scope:`;

export interface HappierHostWriteAuthorizationRequest {
  readonly connectorId: string;
  readonly operation: "send" | "interrupt";
  /** Immutable, canonical binding scope that the decision must echo verbatim. */
  readonly scopeFingerprint: string;
  readonly canonicalSessionUri: string;
  readonly providerId: HappierBackend;
  readonly nativeSessionId: string;
  readonly happierSessionId: string;
  readonly serverProfileId: string;
  readonly machineId: string;
  readonly hostId: string;
  readonly bindingId: string | null;
  readonly logicalMessageId: string | null;
  readonly localMessageId: string | null;
  readonly idempotencyKey: string;
  readonly contentHash?: string;
  readonly reason: string | null;
  readonly deliveryAuthorization: SessionConnectorDeliveryAuthorizationV1 | null;
}

export type HappierHostWriteAuthorizationDecision =
  | Readonly<{ authorized: true; authorizationId: string; scopeFingerprint: string }>
  | Readonly<{ authorized: false }>;

/** @internal Only the plugin factory may bind this to an Engine-owned authorizer. */
export type HappierPluginWriteAuthorization = (
  request: HappierHostWriteAuthorizationRequest,
) => Promise<HappierHostWriteAuthorizationDecision>;

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
}>;

type BoundIdentity = Readonly<{
  canonicalSessionUri: string;
  providerId: HappierBackend;
  nativeSessionId: string;
  happierSessionId: string;
  serverProfileId: string;
  machineId: string;
}>;

type HappierHostWriteAuthorizationScope = Readonly<{
  canonicalSessionUri: string;
  providerId: HappierBackend;
  nativeSessionId: string;
  happierSessionId: string;
  serverProfileId: string;
  machineId: string;
  hostId: string;
  bindingId: string;
  operation: "send" | "interrupt";
  logicalMessageId: string | null;
  localMessageId: string | null;
  idempotencyKey: string;
  contentHash: string | null;
  reason: string | null;
  outboxId: string;
  senderFence: SessionConnectorDeliveryAuthorizationV1["senderFence"];
  scopeFingerprint: string;
}>;

const defaultDependencies: HappierSessionConnectorDependencies = {
  openMcpClient: openHappierMcpClient,
  probeRuntime: probeHappierRuntime,
};

/*
FNXC:HappierDurableWriteAuthority 2026-07-20-21:30:
An arbitrary connector constructor dependency must never turn into an official
MCP write permit. The base connector is read-only by default; only the runtime
plugin factory can bind an Engine-owned durable authorizer through this private
instance capability. User settings and test-style dependency injection remain
incapable of opening send or interrupt mutations.
*/
const pluginWriteAuthorizers = new WeakMap<object, HappierPluginWriteAuthorization>();

function isRecord(value: unknown): value is HappierJsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown, maximum = 2_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum || /[\u0000-\u001f\u007f]/u.test(trimmed)) return undefined;
  return trimmed;
}

function isDurableDeliveryAuthorization(
  value: unknown,
): value is SessionConnectorDeliveryAuthorizationV1 {
  if (!isRecord(value) || !nonEmptyString(value.outboxId) || !isRecord(value.senderFence)) return false;
  const fence = value.senderFence;
  const expectedEpoch = fence.expectedEpoch;
  return Boolean(
    nonEmptyString(fence.leaseId)
    && nonEmptyString(fence.roomId)
    && fence.kind === "sender"
    && nonEmptyString(fence.resourceId)
    && nonEmptyString(fence.holderId)
    && nonEmptyString(fence.hostId)
    && typeof expectedEpoch === "number"
    && Number.isSafeInteger(expectedEpoch)
    && expectedEpoch > 0,
  );
}

function hostWriteAuthorizationScope(
  target: BoundIdentity,
  identity: SessionConnectorIdentityV1,
  input: Readonly<{
    operation: "send" | "interrupt";
    bindingId: string | null;
    logicalMessageId: string | null;
    localMessageId: string | null;
    idempotencyKey: string;
    contentHash?: string;
    reason: string | null;
    deliveryAuthorization: SessionConnectorDeliveryAuthorizationV1 | null;
  }>,
): HappierHostWriteAuthorizationScope | null {
  const hostId = nonEmptyString(identity.hostId, 512);
  const bindingId = nonEmptyString(input.bindingId, 512);
  const authorization = input.deliveryAuthorization;
  if (
    !hostId
    || !bindingId
    || !isDurableDeliveryAuthorization(authorization)
    || authorization.senderFence.hostId !== hostId
    || authorization.senderFence.resourceId !== bindingId
  ) {
    return null;
  }
  const scope = {
    canonicalSessionUri: target.canonicalSessionUri,
    providerId: target.providerId,
    nativeSessionId: target.nativeSessionId,
    happierSessionId: target.happierSessionId,
    serverProfileId: target.serverProfileId,
    machineId: target.machineId,
    hostId,
    bindingId,
    operation: input.operation,
    logicalMessageId: input.logicalMessageId,
    localMessageId: input.localMessageId,
    idempotencyKey: input.idempotencyKey,
    contentHash: input.contentHash ?? null,
    reason: input.reason,
    outboxId: authorization.outboxId,
    senderFence: authorization.senderFence,
  } as const;
  return Object.freeze({
    ...scope,
    scopeFingerprint: `${HAPPIER_WRITE_SCOPE_PREFIX}${hashRoomValue(scope)}`,
  });
}

function failure<T>(
  code: "unavailable" | "unverified" | "degraded" | "invalid_request" | "authentication_required" | "not_found" | "ambiguous" | "host_unavailable" | "rate_limited" | "conflict" | "transport" | "delivery_uncertain" | "internal",
  message: string,
  retryable: boolean,
  safeDetails?: Readonly<Record<string, unknown>>,
): SessionConnectorResultV1<T> {
  return { ok: false, error: { code, message, retryable, ...(safeDetails ? { safeDetails } : {}) } };
}

/**
 * FNXC:HappierMcpApprovalFence 2026-07-20-00:06:
 * Official external MCP can acknowledge only creation of an approval request.
 * That is not a provider send/stop result, so preserve the approval state and
 * fail closed before Fusion records a confirmation or accepted interruption.
 */
class HappierMcpApprovalRequestError extends Error {
  constructor(readonly actionState: "approval_request_created") {
    super("Happier MCP requires an approval before the requested action executes");
    this.name = "HappierMcpApprovalRequestError";
  }
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
    "Direct UI Take over must be followed by a host-issued write authorization before Fusion can write to this Happier Session.",
    false,
    {
      bindingState: HAPPIER_TAKEOVER_REQUIRED,
      bridge: "official_mcp_stdio",
    },
  );
}

function hostWriteAuthorizationRequired<T>(): SessionConnectorResultV1<T> {
  return failure(
    "unavailable",
    "A host/runtime-issued Happier write authorization is required before Fusion can mutate this session.",
    false,
    {
      bindingState: HAPPIER_HOST_WRITE_AUTHORIZATION_REQUIRED,
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

/*
 * FNXC:HappierSessionBindingPersistence 2026-07-20-01:20:
 * The connector accepts only the project-filtered binding identity contract.
 * If a caller bypasses PluginStore and adds a token, credential, or unknown
 * field, treat the mapping as absent so an unreviewed payload cannot authorize
 * an official MCP action. Historical `takeoverConfirmedAt` is accepted only
 * so old mappings remain readable; it has zero write-authority meaning.
 */
function parsePersistedBinding(value: unknown): PersistedBinding | null {
  if (!isRecord(value)) return null;
  const allowedFields = new Set([
    "canonicalSessionUri",
    "happierSessionId",
    "serverProfileId",
    "machineId",
    "takeoverConfirmedAt",
  ]);
  if (Object.keys(value).some((key) => !allowedFields.has(key))) return null;
  const canonical = typeof value.canonicalSessionUri === "string"
    ? parseCanonicalSessionUri(value.canonicalSessionUri)
    : null;
  const happierSessionId = nonEmptyString(value.happierSessionId, 512);
  const serverProfileId = nonEmptyString(value.serverProfileId, 512);
  const machineId = nonEmptyString(value.machineId, 512);
  if (!canonical || !happierSessionId || !serverProfileId || !machineId) return null;
  if (value.takeoverConfirmedAt !== undefined) {
    const historicalTakeover = nonEmptyString(value.takeoverConfirmedAt, 128);
    if (!historicalTakeover || !Number.isFinite(Date.parse(historicalTakeover))) return null;
  }
  return { ...canonical, happierSessionId, serverProfileId, machineId };
}

export type HappierRawHistoryLocalIdCorrelation =
  | Readonly<{ outcome: "matched"; nativeMessageId: string }>
  | Readonly<{
    outcome: "uncertain";
    reason:
      | "raw_history_unavailable"
      | "local_id_not_found"
      | "ambiguous_local_id"
      | "content_hash_unavailable"
      | "content_hash_mismatch";
  }>;

/*
 * FNXC:HappierRawLocalIdCorrelation 2026-07-20-02:45:
 * Happier HEAD abb0dee5 documents localId as the session-local idempotency
 * key for session_message_send. session_transcript_get does not return it, so
 * transcript text, timestamps, and ordering are forbidden as matching keys.
 * Only a caller-proven `session_history_get` result requested with format:raw
 * can enter here. We select exactly one matching localId first, then verify
 * its immutable content hash; absence, ambiguity, or missing raw text stays
 * explicitly uncertain.
 */
export function correlateRawHappierHistoryLocalId(
  rawHistory: unknown,
  expected: Readonly<{ localMessageId: string; contentHash: string }>,
): HappierRawHistoryLocalIdCorrelation {
  if (
    !nonEmptyString(expected.localMessageId, 128)
    || !/^[A-Za-z0-9._:-]+$/u.test(expected.localMessageId)
    || !nonEmptyString(expected.contentHash, 256)
    || !isRecord(rawHistory)
    || rawHistory.format !== "raw"
    || !Array.isArray(rawHistory.messages)
  ) {
    return { outcome: "uncertain", reason: "raw_history_unavailable" };
  }

  const candidates = rawHistory.messages.filter((message): message is HappierJsonRecord =>
    isRecord(message)
    && typeof message.localId === "string"
    && message.localId === expected.localMessageId,
  );
  if (candidates.length === 0) return { outcome: "uncertain", reason: "local_id_not_found" };
  if (candidates.length !== 1) return { outcome: "uncertain", reason: "ambiguous_local_id" };

  const candidate = candidates[0]!;
  const nativeMessageId = nonEmptyString(candidate.id, 512);
  const raw = isRecord(candidate.raw) ? candidate.raw : null;
  const content = raw && isRecord(raw.content) ? raw.content : null;
  if (!nativeMessageId || content?.type !== "text" || typeof content.text !== "string") {
    return { outcome: "uncertain", reason: "content_hash_unavailable" };
  }
  if (hashRoomValue(content.text) !== expected.contentHash) {
    return { outcome: "uncertain", reason: "content_hash_mismatch" };
  }
  return { outcome: "matched", nativeMessageId };
}

function mcpResultRecord(result: HappierMcpToolResult, operation: string): HappierJsonRecord {
  const records = extractMcpResultRecords(result, operation);
  const primary = records[0]!;
  /*
   * FNXC:HappierMcpPrimaryErrorPrecedence 2026-07-20-21:06:
   * A secondary content envelope can prevent a nominal success from being
   * accepted when it requires approval, but it cannot replace an explicit
   * primary official error. The primary error is already non-successful and
   * preserves its established authentication/session/transport classification.
   */
  if (result.isError === true) {
    assertMcpActionApprovalSafe(primary, operation);
    throwMcpActionFailure(primary, operation);
  }
  for (const record of records) assertMcpActionApprovalSafe(record, operation);
  return unwrapMcpActionResult(primary, operation);
}

/*
FNXC:HappierOfficialMcpEnvelope 2026-07-20-20:40:
Happier's external MCP server delegates action-backed tools through its action
executor. The public `content` JSON is therefore `{ ok, result }`, and the
actual session service may itself return a `{ ok, ... }` record. Normalize
those documented envelopes here, while retaining direct structured results for
future official MCP releases. A conflicting text envelope or an approval request
at any supported wrapper depth must fail closed: a provider action awaiting
approval must never be reported as confirmed or accepted.
*/
const MAX_MCP_ACTION_RESULT_WRAPPER_DEPTH = 8;

function extractMcpResultRecords(result: HappierMcpToolResult, operation: string): readonly HappierJsonRecord[] {
  const records: HappierJsonRecord[] = [];
  if (isRecord(result.structuredContent)) records.push(result.structuredContent);
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
      try {
        const parsed: unknown = JSON.parse(item.text);
        if (isRecord(parsed)) records.push(parsed);
      } catch {
        // Continue to the next textual content item; no transcript text is surfaced.
      }
    }
  }
  if (records.length === 0) {
    throw new HappierCliError("protocol", `Happier MCP ${operation} returned no structured result`);
  }
  return records;
}

function assertMcpActionApprovalSafe(value: HappierJsonRecord, operation: string): void {
  let current = value;
  for (let depth = 0; depth < MAX_MCP_ACTION_RESULT_WRAPPER_DEPTH; depth += 1) {
    if (current.kind === "approval_request_created") {
      throw new HappierMcpApprovalRequestError("approval_request_created");
    }
    if (current.ok !== true || !isRecord(current.result)) return;
    current = current.result;
  }
  throw new HappierCliError("protocol", `Happier MCP ${operation} exceeded the supported action-result wrapper depth`);
}

function unwrapMcpActionResult(value: HappierJsonRecord, operation: string): HappierJsonRecord {
  let current = value;
  for (let depth = 0; depth < MAX_MCP_ACTION_RESULT_WRAPPER_DEPTH; depth += 1) {
    if (current.kind === "approval_request_created") {
      throw new HappierMcpApprovalRequestError("approval_request_created");
    }
    if (current.ok === false) throwMcpActionFailure(current, operation);
    if (current.ok !== true || !isRecord(current.result)) return current;
    current = current.result;
  }
  throw new HappierCliError("protocol", `Happier MCP ${operation} exceeded the supported action-result wrapper depth`);
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

function canonicalIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const canonical = new Date(parsed).toISOString();
  return value === canonical ? canonical : null;
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

function hasExactOwnKeys(value: HappierJsonRecord, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function localRuntimeSnapshotRequired<T>(): SessionConnectorResultV1<T> {
  return failure(
    "unavailable",
    "The local Happier runtime snapshot extension is not enabled or not installed for this MCP process",
    false,
    {
      bridge: "local_happier_mcp_extension",
      extension: HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.runtimeSnapshot,
      state: HAPPIER_LOCAL_RUNTIME_SNAPSHOT_REQUIRED,
    },
  );
}

function localRuntimeSnapshotWithheld<T>(reason: "model_metadata_unavailable" | "invalid_snapshot"): SessionConnectorResultV1<T> {
  return failure(
    reason === "model_metadata_unavailable"
      ? "unavailable"
      : "unverified",
    reason === "model_metadata_unavailable"
      ? "Happier local runtime metadata does not currently contain a validated ACP provider/model"
      : "Happier local runtime snapshot failed strict validation",
    false,
    {
      bridge: "local_happier_mcp_extension",
      extension: HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.runtimeSnapshot,
      reason,
    },
  );
}

function localReconciliationHistoryRequired<T>(): SessionConnectorResultV1<T> {
  return failure(
    "unavailable",
    "The local Happier reconciliation-history extension is not enabled or not installed for this MCP process",
    false,
    {
      bridge: "local_happier_mcp_extension",
      extension: HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.reconciliationHistory,
      state: HAPPIER_LOCAL_RECONCILIATION_HISTORY_REQUIRED,
    },
  );
}

function localReconciliationHistoryWithheld<T>(): SessionConnectorResultV1<T> {
  return failure(
    "unverified",
    "Happier local reconciliation history failed strict identity, cursor, or message validation",
    false,
    {
      bridge: "local_happier_mcp_extension",
      extension: HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.reconciliationHistory,
      reason: "invalid_reconciliation_history",
    },
  );
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

function hasExpectedProviderTelemetryLimitations(value: unknown): boolean {
  if (!isRecord(value) || !hasExactOwnKeys(value, [
    "providerAvailability",
    "capacity",
    "onDemandProviderRefresh",
    "accountIdentity",
    "rawSnapshot",
  ])) {
    return false;
  }
  return value.providerAvailability === "not_inferred"
    && value.capacity === "not_reported"
    && value.onDemandProviderRefresh === "not_attempted"
    && value.accountIdentity === "not_reported"
    && value.rawSnapshot === "not_reported";
}

function localProviderTelemetryWithheldReason(
  value: unknown,
): SessionConnectorProviderTelemetryWithheldReasonV1 | null {
  switch (value) {
    case "snapshot_stale":
      return "telemetry_stale";
    case "snapshot_unavailable":
    case "source_unavailable":
    case "invalid_request":
    case "session_unresolved":
    case "binding_unavailable":
      return "telemetry_unavailable";
    default:
      return null;
  }
}

type LocalProviderTelemetryMcpRecord =
  | Readonly<{ state: "record"; record: HappierJsonRecord }>
  | Readonly<{ state: "unavailable" }>
  | Readonly<{ state: "invalid" }>;

function strictLocalProviderTelemetryMcpRecord(
  result: HappierMcpToolResult,
): LocalProviderTelemetryMcpRecord {
  if (result.isError === true) return { state: "unavailable" };
  if (result.isError !== undefined && result.isError !== false) return { state: "invalid" };
  if (result.structuredContent !== undefined) {
    return isRecord(result.structuredContent) && result.content === undefined
      ? { state: "record", record: result.structuredContent }
      : { state: "invalid" };
  }
  if (!Array.isArray(result.content) || result.content.length !== 1) return { state: "invalid" };
  const content = result.content[0];
  if (!isRecord(content) || content.type !== "text" || typeof content.text !== "string") {
    return { state: "invalid" };
  }
  try {
    const parsed: unknown = JSON.parse(content.text);
    return isRecord(parsed)
      ? { state: "record", record: parsed }
      : { state: "invalid" };
  } catch {
    return { state: "invalid" };
  }
}

function providerTelemetryMcpFailure(
  identity: SessionConnectorIdentityV1,
  error: unknown,
): SessionConnectorResultV1<SessionConnectorProviderTelemetryV1> {
  return providerTelemetryWithheld(
    identity,
    error instanceof HappierCliError && error.code === "timeout"
      ? "telemetry_timeout"
      : "telemetry_unavailable",
  );
}

/*
 * FNXC:HappierProviderTelemetry 2026-07-21-03:00:
 * This non-official local read strictly projects one in-band persisted Codex
 * snapshot into Core's canonical telemetry contract. It remains separate from
 * runtime snapshots and capability/admission paths: fresh telemetry cannot
 * prove provider availability, capacity, account identity, dispatch readiness,
 * or an on-demand refresh.
 */
function parseLocalProviderTelemetry(
  value: HappierJsonRecord,
  identity: SessionConnectorIdentityV1,
  now: string,
): SessionConnectorResultV1<SessionConnectorProviderTelemetryV1> {
  const baseFields = ["ok", "kind", "contractVersion", "state", "provider"] as const;
  if (value.ok !== true || value.kind !== "fusion_provider_telemetry" || value.contractVersion !== 1) {
    return providerTelemetryWithheld(identity, "telemetry_contract_invalid");
  }
  if (value.state === "withheld") {
    const reason = localProviderTelemetryWithheldReason(value.reason);
    if (
      !hasExactOwnKeys(value, ["ok", "kind", "contractVersion", "state", "reason"])
      || !reason
    ) {
      return providerTelemetryWithheld(identity, "telemetry_contract_invalid");
    }
    return providerTelemetryWithheld(identity, reason);
  }
  if (
    value.state !== "reported"
    || !hasExactOwnKeys(value, [
      ...baseFields,
      "source",
      "freshness",
      "observedAt",
      "expiresAt",
      "limitations",
    ])
    || identity.providerId !== "codex"
    || value.provider !== "codex"
    || value.source !== "happier_persisted_in_band_provider_snapshot"
    || value.freshness !== "fresh"
    || !hasExpectedProviderTelemetryLimitations(value.limitations)
  ) {
    return providerTelemetryWithheld(identity, "telemetry_contract_invalid");
  }
  const observedAt = canonicalIsoTimestamp(value.observedAt);
  const expiresAt = canonicalIsoTimestamp(value.expiresAt);
  const nowAt = canonicalIsoTimestamp(now);
  if (!observedAt || !expiresAt || !nowAt) {
    return providerTelemetryWithheld(identity, "telemetry_contract_invalid");
  }
  const observedAtMs = Date.parse(observedAt);
  const expiresAtMs = Date.parse(expiresAt);
  const nowMs = Date.parse(nowAt);
  if (observedAtMs > nowMs || expiresAtMs <= observedAtMs) {
    return providerTelemetryWithheld(identity, "telemetry_contract_invalid");
  }
  if (nowMs >= expiresAtMs) return providerTelemetryWithheld(identity, "telemetry_stale");
  return {
    ok: true,
    value: Object.freeze({
      contractVersion: SESSION_CONNECTOR_PROVIDER_TELEMETRY_CONTRACT_VERSION,
      state: "reported" as const,
      identity: providerTelemetryIdentity(identity),
      providerId: "codex" as const,
      source: "happier_persisted_in_band_provider_snapshot" as const,
      observedAt,
      expiresAt,
      freshness: "fresh" as const,
      limitations: Object.freeze({
        providerAvailability: "not_inferred" as const,
        capacity: "not_reported" as const,
        onDemandProviderRefresh: "not_attempted" as const,
        accountIdentity: "not_reported" as const,
        rawSnapshot: "not_reported" as const,
      }),
    }),
  };
}

function numericSequenceCursor(value: unknown): string | null {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,15})$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? value : null;
}

function sequenceCursorNumber(value: string | null): number | null {
  if (value === null) return 0;
  const canonical = numericSequenceCursor(value);
  return canonical === null ? null : Number(canonical);
}

function strictOpaqueIdentifier(value: unknown, maximum = 512): string | null {
  if (typeof value !== "string" || value !== value.trim()) return null;
  return nonEmptyString(value, maximum) ?? null;
}

function epochMillisecondsToIso(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
  const timestamp = new Date(value).toISOString();
  return Number.isNaN(Date.parse(timestamp)) ? null : timestamp;
}

type LocalReconciliationHistoryParse =
  | Readonly<{ state: "ready"; page: SessionConnectorHistoryPageV1 }>
  | Readonly<{ state: "withheld" }>;

/*
 * FNXC:HappierReconciliationHistory 2026-07-20-12:02:
 * This parser accepts only Fusion's opt-in local extension, whose rows retain
 * Happier's durable localId and monotonically increasing server sequence. A
 * generic official history/transcript response cannot substitute for it: one
 * omits a durable page cursor and the other omits localId. Any nonexact page,
 * identity, content, or cursor relationship stays withheld before crash
 * recovery can turn an uncertain outbox attempt into a confirmation.
 */
function parseLocalReconciliationHistory(
  value: HappierJsonRecord,
  expectedSessionId: string,
  input: SessionConnectorHistoryRequestV1,
): LocalReconciliationHistoryParse {
  const requestedAfterSequence = sequenceCursorNumber(input.afterCursor);
  if (requestedAfterSequence === null
    || value.ok !== true
    || value.kind !== "fusion_reconciliation_history"
    || value.contractVersion !== 1
    || !isRecord(value.session)
    || sessionIdFromRecord(value.session) !== expectedSessionId
    || !isRecord(value.page)
    || !Array.isArray(value.items)
    || !isRecord(value.provenance)
    || value.provenance.source !== "happier_local_encrypted_transcript"
    || value.provenance.transport !== "local_mcp_stdio"
    || value.provenance.sourceContractVersion !== 1) {
    return { state: "withheld" };
  }

  const page = value.page;
  if (page.afterCursor !== input.afterCursor || typeof page.truncated !== "boolean") {
    return { state: "withheld" };
  }
  const completeThroughCursor = page.completeThroughCursor === null
    ? null
    : numericSequenceCursor(page.completeThroughCursor);
  const completeThroughSequence = sequenceCursorNumber(completeThroughCursor);
  if (completeThroughSequence === null || completeThroughSequence < requestedAfterSequence) {
    return { state: "withheld" };
  }
  if (completeThroughCursor === null && input.afterCursor !== null) return { state: "withheld" };

  const providerNextCursor = page.nextCursor === null ? null : numericSequenceCursor(page.nextCursor);
  const providerNextSequence = sequenceCursorNumber(providerNextCursor);
  if (page.truncated) {
    if (providerNextSequence === null
      || providerNextSequence <= requestedAfterSequence
      || providerNextSequence !== completeThroughSequence) {
      return { state: "withheld" };
    }
  } else if (page.nextCursor !== null) {
    return { state: "withheld" };
  }

  const nativeMessageIds = new Set<string>();
  const localMessageIds = new Set<string>();
  let previousItemSequence = requestedAfterSequence;
  const items: Array<SessionConnectorHistoryPageV1["items"][number]> = [];
  for (const item of value.items) {
    if (!isRecord(item)) return { state: "withheld" };
    const nativeMessageId = strictOpaqueIdentifier(item.nativeMessageId);
    const localMessageId = strictOpaqueIdentifier(item.localMessageId, 128);
    const content = typeof item.content === "string" && item.content.length > 0 && item.content.length <= 100_000 && !item.content.includes("\u0000")
      ? item.content
      : null;
    const occurredAt = epochMillisecondsToIso(item.occurredAtMs);
    const cursor = numericSequenceCursor(item.cursor);
    const sequence = sequenceCursorNumber(cursor);
    if (!nativeMessageId
      || !localMessageId
      || !/^[A-Za-z0-9._:-]+$/u.test(localMessageId)
      || !content
      || !occurredAt
      || !cursor
      || sequence === null
      || sequence <= previousItemSequence
      || sequence > completeThroughSequence
      || nativeMessageIds.has(nativeMessageId)
      || localMessageIds.has(localMessageId)) {
      return { state: "withheld" };
    }
    nativeMessageIds.add(nativeMessageId);
    localMessageIds.add(localMessageId);
    previousItemSequence = sequence;
    items.push({
      nativeMessageId,
      logicalMessageId: localMessageId,
      role: "user",
      contentHash: hashRoomValue(content),
      occurredAt,
      cursor,
    });
  }

  // Persist the fully covered frontier even when the native endpoint says no additional page remains.
  const nextCursor = providerNextCursor ?? completeThroughCursor;
  return {
    state: "ready",
    page: {
      items,
      nextCursor,
      completeThroughCursor,
      truncated: page.truncated,
    },
  };
}

function hasExpectedRuntimeLimitations(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return value.providerAccount === "not_reported"
    && value.providerQuota === "not_reported"
    && value.latency === "not_reported"
    && value.context === "not_reported"
    && value.tools === "not_reported"
    && value.quality === "not_reported";
}

function parseLocalRuntimeSnapshot(
  value: HappierJsonRecord,
  identity: SessionConnectorIdentityV1,
  expectedSessionId: string,
  now: string,
):
  | Readonly<{ state: "ready"; snapshot: SessionConnectorRuntimeSnapshotV1 }>
  | Readonly<{ state: "withheld"; reason: "model_metadata_unavailable" | "invalid_snapshot" }> {
  if (value.ok !== true || value.kind !== "fusion_local_runtime_snapshot" || value.contractVersion !== 1) {
    return { state: "withheld", reason: "invalid_snapshot" };
  }
  const snapshot = isRecord(value.snapshot) ? value.snapshot : null;
  const session = isRecord(value.session) ? value.session : null;
  const runtime = isRecord(value.runtime) ? value.runtime : null;
  const provenance = isRecord(value.provenance) ? value.provenance : null;
  if (!snapshot || !session || !runtime || !provenance
    || sessionIdFromRecord(session) !== expectedSessionId
    || !hasExpectedRuntimeLimitations(value.limitations)
    || provenance.source !== "happier_local_acp_metadata"
    || provenance.transport !== "local_mcp_stdio"
    || provenance.sourceContractVersion !== 1) {
    return { state: "withheld", reason: "invalid_snapshot" };
  }
  if (runtime.modelState !== "known") {
    return { state: "withheld", reason: "model_metadata_unavailable" };
  }
  const snapshotId = nonEmptyString(snapshot.id, 512);
  const revision = snapshot.revision;
  const capturedAt = isoTimestamp(snapshot.capturedAt);
  const expiresAt = isoTimestamp(snapshot.expiresAt);
  const providerId = nonEmptyString(runtime.providerId, 512);
  const modelId = nonEmptyString(runtime.currentModelId, 512);
  const modelObservedAt = isoTimestamp(runtime.modelObservedAt);
  const nowMs = Date.parse(now);
  if (!snapshotId
    || typeof revision !== "number"
    || !Number.isSafeInteger(revision)
    || revision <= 0
    || !capturedAt
    || !expiresAt
    || !providerId
    || providerId !== identity.providerId
    || !modelId
    || !modelObservedAt
    || runtime.modelReason !== null
    || !Number.isFinite(nowMs)
    || Date.parse(capturedAt) > Date.parse(expiresAt)
    || Date.parse(modelObservedAt) > Date.parse(capturedAt)
    || Date.parse(capturedAt) > nowMs + LOCAL_RUNTIME_SNAPSHOT_MAX_FUTURE_SKEW_MS
    || nowMs > Date.parse(expiresAt)) {
    return { state: "withheld", reason: "invalid_snapshot" };
  }
  return {
    state: "ready",
    snapshot: {
      contractVersion: 1,
      source: "connector_local_extension",
      identity,
      snapshotId,
      revision,
      capturedAt,
      expiresAt,
      providerId,
      modelId,
      modelObservedAt,
      accountId: null,
      coverage: {
        providerModel: "observed",
        providerAccount: "not_reported",
        providerQuota: "not_reported",
        latency: "not_reported",
        context: "not_reported",
        tools: "not_reported",
        quality: "not_reported",
      },
    },
  };
}

function mapMcpFailure<T>(error: unknown, bridge = "official_mcp_stdio"): SessionConnectorResultV1<T> {
  if (error instanceof HappierMcpApprovalRequestError) {
    return failure(
      "unavailable",
      "Happier MCP created an approval request; the requested action has not executed",
      false,
      { bridge, actionState: error.actionState },
    );
  }
  if (!(error instanceof HappierCliError)) {
    return failure("internal", "Happier MCP connector operation failed", false);
  }
  const details = { bridge, category: error.code };
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
export class HappierSessionConnector implements SessionConnectorV1, SessionConnectorRuntimeSnapshotSourceV1, SessionConnectorProviderTelemetrySourceV1 {
  readonly contractVersion = 1 as const;
  readonly id = HAPPIER_SESSION_CONNECTOR_ID;
  readonly version: string;

  private readonly settings: ReturnType<typeof resolveHappierCliSettings>;
  private readonly sourceRevision: string;
  private readonly sendTimeoutSeconds: number;
  private readonly now: () => string;
  private readonly dependencies: HappierSessionConnectorDependencies;
  private readonly localIdContentHashes = new Map<string, string>();

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
      typeof input.idempotencyKey !== "string"
      || !input.idempotencyKey.trim()
      || !requiredHostId
    ) {
      return failure("invalid_request", "A canonical Session URI, host identity, and idempotency key are required", false);
    }
    const preflight = await this.preflightExisting({
      contractVersion: input.contractVersion,
      canonicalSessionUri: input.canonicalSessionUri,
      requiredHostId,
      ...(input.requiredMachineId === undefined ? {} : { requiredMachineId: input.requiredMachineId }),
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
   * This is intentionally narrower than `ensureExisting`: it validates an
   * already persisted binding using only official MCP read tools, and never
   * creates a Happier link, sends provider input, or changes native history.
   * A Cockpit may therefore show exactly what can be attached before any Room
   * write is requested. Provider account/quota/quality remain unreported.
   */
  async preflightExisting(
    input: SessionConnectorPreflightExistingRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorPreflightExistingResultV1>> {
    const requiredHostId = nonEmptyString(input.requiredHostId);
    if (
      input.contractVersion !== 1
      || !nonEmptyString(input.canonicalSessionUri)
      || !requiredHostId
    ) {
      return failure("invalid_request", "A canonical Session URI and host identity are required", false);
    }
    const canonical = parseCanonicalSessionUri(input.canonicalSessionUri);
    if (!canonical) {
      return failure("invalid_request", "The canonical native Session URI is invalid", false);
    }
    const binding = this.bindingForCanonicalSession(canonical);
    if (!binding) return bindingRequired("preflight this native Session");
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
        const checkedAt = this.now();
        return {
          identity,
          providerTurnStarted: false,
          checkedAt,
          capabilities: this.capabilitiesFromTools(available, identity, checkedAt),
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

  async getRuntimeSnapshot(
    identity: SessionConnectorIdentityV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorRuntimeSnapshotV1>> {
    const target = this.validateBoundIdentity(identity, "read a local runtime snapshot");
    if (!target.ok) return target;
    let client: HappierMcpClient | undefined;
    try {
      client = await this.dependencies.openMcpClient({ settings: this.settings, sessionId: target.value.happierSessionId });
      const available = validatedToolNames(await client.listTools());
      if (!available.has(HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.runtimeSnapshot)) {
        return localRuntimeSnapshotRequired();
      }
      const record = mcpResultRecord(
        await client.callTool({
          name: HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.runtimeSnapshot,
          arguments: { sessionId: target.value.happierSessionId },
        }),
        HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.runtimeSnapshot,
      );
      const parsed = parseLocalRuntimeSnapshot(record, identity, target.value.happierSessionId, this.now());
      if (parsed.state === "withheld") return localRuntimeSnapshotWithheld(parsed.reason);
      return { ok: true, value: parsed.snapshot };
    } catch (error) {
      return mapMcpFailure(error, "local_happier_mcp_extension");
    } finally {
      await client?.close().catch(() => undefined);
    }
  }

  async getProviderTelemetry(
    identity: SessionConnectorIdentityV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorProviderTelemetryV1>> {
    if (identity.providerId !== "codex") {
      return providerTelemetryWithheld(identity, "telemetry_contract_invalid");
    }
    const target = this.validateBoundIdentity(identity, "read local provider telemetry");
    if (!target.ok) return providerTelemetryWithheld(identity, "telemetry_contract_invalid");
    if (!this.settings.enableLocalProviderTelemetry) {
      return providerTelemetryWithheld(identity, "connector_telemetry_unsupported");
    }
    let client: HappierMcpClient | undefined;
    try {
      client = await this.dependencies.openMcpClient({
        settings: this.settings,
        sessionId: target.value.happierSessionId,
      });
      const available = validatedToolNames(await client.listTools());
      if (!available.has(HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.providerTelemetry)) {
        return providerTelemetryWithheld(identity, "telemetry_unavailable");
      }
      const mcpResult = strictLocalProviderTelemetryMcpRecord(
        await client.callTool({
          name: HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.providerTelemetry,
          arguments: { sessionId: target.value.happierSessionId },
        }),
      );
      if (mcpResult.state === "unavailable") {
        return providerTelemetryWithheld(identity, "telemetry_unavailable");
      }
      if (mcpResult.state === "invalid") {
        return providerTelemetryWithheld(identity, "telemetry_contract_invalid");
      }
      return parseLocalProviderTelemetry(mcpResult.record, identity, this.now());
    } catch (error) {
      return providerTelemetryMcpFailure(identity, error);
    } finally {
      await client?.close().catch(() => undefined);
    }
  }

  async readHistory(
    input: SessionConnectorHistoryRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorHistoryPageV1>> {
    const target = this.validateBoundIdentity(input.identity, "read reconciliation history");
    if (!target.ok) return target;
    if (
      input.contractVersion !== 1
      || sequenceCursorNumber(input.afterCursor) === null
      || !Number.isSafeInteger(input.limit)
      || input.limit < 1
      || input.limit > SESSION_CONNECTOR_HISTORY_PAGE_LIMIT
    ) {
      return failure("invalid_request", "Happier reconciliation history requires a bounded numeric cursor and page size", false);
    }
    let client: HappierMcpClient | undefined;
    try {
      client = await this.dependencies.openMcpClient({ settings: this.settings, sessionId: target.value.happierSessionId });
      const available = validatedToolNames(await client.listTools());
      if (!available.has(HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.reconciliationHistory)) {
        return localReconciliationHistoryRequired();
      }
      const record = mcpResultRecord(
        await client.callTool({
          name: HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.reconciliationHistory,
          arguments: {
            sessionId: target.value.happierSessionId,
            afterCursor: input.afterCursor,
            limit: input.limit,
          },
        }),
        HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.reconciliationHistory,
      );
      const parsed = parseLocalReconciliationHistory(record, target.value.happierSessionId, input);
      if (parsed.state === "withheld") return localReconciliationHistoryWithheld();
      return { ok: true, value: parsed.page };
    } catch (error) {
      return mapMcpFailure(error, "local_happier_mcp_extension");
    } finally {
      await client?.close().catch(() => undefined);
    }
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
    if (!isDurableDeliveryAuthorization(input.deliveryAuthorization)) return hostWriteAuthorizationRequired();
    const authorization = await this.authorizeHostWrite(target.value, input.identity, {
      operation: "send",
      bindingId: input.bindingId,
      logicalMessageId: input.logicalMessageId,
      localMessageId: input.localMessageId,
      idempotencyKey: input.idempotencyKey,
      contentHash: input.contentHash,
      reason: null,
      deliveryAuthorization: input.deliveryAuthorization,
    });
    if (!authorization.ok) return authorization;
    const localIdFence = this.rememberLocalIdContentHash(
      target.value.happierSessionId,
      input.localMessageId,
      input.contentHash,
    );
    if (!localIdFence.ok) return localIdFence;
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
              localId: input.localMessageId,
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
    void input;
    // No durable control-command authorizer exists yet; MCP stop must stay unavailable.
    return unsupportedOperation("interrupt");
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
      "Happier MCP does not provide programmatic Direct UI Take over. Take over manually in Direct UI, then have the host runtime verify and issue a write authorization before Fusion writes.",
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
    const canRequestHostWriteAuthorization = pluginWriteAuthorizers.has(this);
    const capability = (name: SessionConnectorCapabilityName): SessionConnectorCapabilityCertificationV1 => {
      const requirements: Partial<Record<SessionConnectorCapabilityName, readonly string[]>> = {
        ensureExisting: [HAPPIER_OFFICIAL_MCP_TOOLS.list, HAPPIER_OFFICIAL_MCP_TOOLS.status],
        status: [HAPPIER_OFFICIAL_MCP_TOOLS.status],
        history: [HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.reconciliationHistory],
        send: [HAPPIER_OFFICIAL_MCP_TOOLS.send, HAPPIER_OFFICIAL_MCP_TOOLS.wait],
        interrupt: [HAPPIER_OFFICIAL_MCP_TOOLS.stop],
      };
      const required = requirements[name];
      if (!required) {
        return name === "events" || name === "create" || name === "resume" || name === "takeover"
          ? unavailableCertification("operation_unavailable")
          : unverifiedCertification("source_unverified");
      }
      if (!hasBinding) return unavailableCertification("operation_unavailable");
      if (name === "send" && !canRequestHostWriteAuthorization) {
        return unavailableCertification("operation_unavailable");
      }
      if (missingTools(available, required).length > 0) return unavailableCertification("operation_unavailable");
      if (name === "interrupt") {
        return unavailableCertification("operation_unavailable");
      }
      if (name === "send") {
        /*
         * FNXC:HappierHostWriteCapability 2026-07-20-21:06:
         * The Room dispatcher admits only verified connector capabilities. Official
         * MCP discovery plus the Engine's durable outbox authorizer proves that a
         * governed send path exists; it does not grant a future write. send()
         * still re-checks the exact runtime authorization before opening the MCP
         * mutation. interrupt remains unavailable until it has an equivalent
         * durable control-command authorization, rather than claiming support
         * merely because a send-only verifier function exists.
         */
        return verifiedCertification(toolEvidence(required), verifiedAt);
      }
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

  /*
   * FNXC:HappierHostWriteAuthorization 2026-07-20-02:55:
   * Official Happier MCP exposes no proof that a Direct UI takeover occurred.
   * A settings timestamp is therefore only historical metadata, never a write
   * permit. The hosting runtime must verify a grant that is bound to this exact
   * connector/session/operation/idempotency payload; missing, denied, malformed,
   * or failing verification is fail-closed before any MCP client opens.
   *
   * FNXC:HappierHostWriteAuthorizationScope 2026-07-20-21:53:
   * A granted decision must echo an immutable hash of the canonical native URI,
   * Happier/session-server/machine/host identity, Room binding, outbox fence,
   * and exact payload metadata. A grant observed for one binding is therefore
   * rejected before MCP I/O when replayed through another connector or binding.
   */
  private async authorizeHostWrite(
    target: BoundIdentity,
    identity: SessionConnectorIdentityV1,
    input: Readonly<{
      operation: "send" | "interrupt";
      bindingId: string | null;
      logicalMessageId: string | null;
      localMessageId: string | null;
      idempotencyKey: string;
      contentHash?: string;
      reason: string | null;
      deliveryAuthorization: SessionConnectorDeliveryAuthorizationV1 | null;
    }>,
  ): Promise<SessionConnectorResultV1<Readonly<{ authorizationId: string }>>> {
    const verifier = pluginWriteAuthorizers.get(this);
    if (!verifier) return hostWriteAuthorizationRequired();
    const scope = hostWriteAuthorizationScope(target, identity, input);
    if (!scope) return hostWriteAuthorizationRequired();
    try {
      const decision = await verifier({
        connectorId: this.id,
        operation: input.operation,
        scopeFingerprint: scope.scopeFingerprint,
        canonicalSessionUri: target.canonicalSessionUri,
        providerId: target.providerId,
        nativeSessionId: target.nativeSessionId,
        happierSessionId: target.happierSessionId,
        serverProfileId: target.serverProfileId,
        machineId: target.machineId,
        hostId: identity.hostId,
        bindingId: input.bindingId,
        logicalMessageId: input.logicalMessageId,
        localMessageId: input.localMessageId,
        idempotencyKey: input.idempotencyKey,
        ...(input.contentHash ? { contentHash: input.contentHash } : {}),
        reason: input.reason,
        deliveryAuthorization: input.deliveryAuthorization,
      });
      const authorizationId = decision.authorized === true
        ? nonEmptyString(decision.authorizationId, 512)
        : undefined;
      const decisionScopeFingerprint = decision.authorized === true
        ? nonEmptyString(decision.scopeFingerprint, 512)
        : undefined;
      if (!authorizationId || decisionScopeFingerprint !== scope.scopeFingerprint) {
        return hostWriteAuthorizationRequired();
      }
      return { ok: true, value: { authorizationId } };
    } catch {
      return hostWriteAuthorizationRequired();
    }
  }

  private rememberLocalIdContentHash(
    happierSessionId: string,
    localMessageId: string,
    contentHash: string,
  ): SessionConnectorResultV1<undefined> {
    const key = `${happierSessionId}\u0000${localMessageId}`;
    const existing = this.localIdContentHashes.get(key);
    if (existing && existing !== contentHash) {
      return failure(
        "conflict",
        "A Happier localId is already bound to a different immutable content hash",
        false,
        { bindingState: "happier_local_id_content_hash_conflict" },
      );
    }
    this.localIdContentHashes.set(key, contentHash);
    return { ok: true, value: undefined };
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
        canonicalSessionUri: binding.canonicalSessionUri,
        providerId: binding.providerId,
        nativeSessionId: binding.nativeSessionId,
        happierSessionId: binding.happierSessionId,
        serverProfileId: binding.serverProfileId,
        machineId: binding.machineId,
      },
    };
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
  pluginWriteAuthorizers.set(connector, verifier);
  return connector;
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

import {
  hashRoomValue,
  SESSION_CONNECTOR_CAPABILITIES,
  SESSION_CONNECTOR_HISTORY_PAGE_LIMIT,
  type SessionConnectorCapabilitiesV1,
  type SessionConnectorCapabilityCertificationV1,
  type SessionConnectorCapabilityReasonCode,
  type SessionConnectorControlRequestV1,
  type SessionConnectorControlResultV1,
  type SessionConnectorCreateRequestV1,
  type SessionConnectorDeepLinksV1,
  type SessionConnectorDeepLinksRequestV1,
  type SessionConnectorEnsureExistingRequestV1,
  type SessionConnectorEnsureExistingResultV1,
  type SessionConnectorEventV1,
  type SessionConnectorHealthV1,
  type SessionConnectorHealthReasonCode,
  type SessionConnectorHistoryItemV1,
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
  ensureHappierDirectSession,
  followHappierDirectSessionTranscriptEvents,
  getHappierDirectSessionCapabilities,
  getHappierSessionStatus,
  readHappierDirectSessionTranscript,
  resolveHappierCliSettings,
  sendHappierMessage,
} from "./cli-spawn.js";
import { probeHappierRuntime } from "./probe.js";
import {
  HAPPIER_DIRECT_SESSION_CAPABILITY_MATRIX,
  HAPPIER_DIRECT_SESSION_CAPABILITY_FINGERPRINT,
  HAPPIER_DIRECT_SESSION_PROVIDER_IDS,
  HAPPIER_DIRECT_SESSION_SOURCE_REVISION,
  isCertifiedHappierDirectSessionRuntimeManifest,
  isHappierDirectSessionProviderId,
  verifyHappierDirectSessionRuntimeBuild,
} from "./happier-direct-session-capabilities.js";
import {
  HappierCliError,
  type HappierBackend,
  type HappierCliSettings,
  type HappierDirectSessionStatusDelta,
  type HappierDirectSessionTranscriptDelta,
  type HappierSessionStatusResult,
} from "./types.js";

export const HAPPIER_SESSION_CONNECTOR_ID = "happier";
export const HAPPIER_SESSION_CONNECTOR_VERSION = "0.2.73";
export * from "./happier-direct-session-capabilities.js";

const DIRECT_MESSAGE_CURSOR_PREFIX = "happier-direct-message-v1:";
const DEFAULT_SEND_TIMEOUT_SECONDS = 300;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const MAX_RATE_LIMIT_COOLDOWN_MS = 604_800_000;

export interface HappierSessionConnectorDependencies {
  readonly ensureDirectSession: typeof ensureHappierDirectSession;
  readonly getSessionStatus: typeof getHappierSessionStatus;
  readonly readDirectTranscript: typeof readHappierDirectSessionTranscript;
  readonly followDirectTranscriptEvents: typeof followHappierDirectSessionTranscriptEvents;
  readonly getDirectSessionCapabilities: typeof getHappierDirectSessionCapabilities;
  readonly verifyRuntimeBuild: typeof verifyHappierDirectSessionRuntimeBuild;
  readonly sendMessage: typeof sendHappierMessage;
  readonly probeRuntime: typeof probeHappierRuntime;
}

export interface HappierSessionConnectorOptions {
  readonly settings?: HappierCliSettings;
  readonly version?: string;
  readonly sourceRevision?: string;
  readonly sendTimeoutSeconds?: number;
  readonly rateLimitCooldownMs?: number;
  readonly now?: () => string;
  readonly dependencies?: Partial<HappierSessionConnectorDependencies>;
}

const defaultDependencies: HappierSessionConnectorDependencies = {
  ensureDirectSession: ensureHappierDirectSession,
  getSessionStatus: getHappierSessionStatus,
  readDirectTranscript: readHappierDirectSessionTranscript,
  followDirectTranscriptEvents: followHappierDirectSessionTranscriptEvents,
  getDirectSessionCapabilities: getHappierDirectSessionCapabilities,
  verifyRuntimeBuild: verifyHappierDirectSessionRuntimeBuild,
  sendMessage: sendHappierMessage,
  probeRuntime: probeHappierRuntime,
};

function unavailableCertification(reasonCode: SessionConnectorCapabilityReasonCode) {
  return {
    state: "unavailable" as const,
    evidenceRef: null,
    reasonCode,
    lastVerifiedAt: null,
  };
}

function unverifiedCertification(reasonCode: SessionConnectorCapabilityReasonCode) {
  return {
    state: "unverified" as const,
    evidenceRef: null,
    reasonCode,
    lastVerifiedAt: null,
  };
}

function verifiedCertification(evidenceRef: string, verifiedAt: string) {
  return {
    state: "verified" as const,
    evidenceRef,
    reasonCode: null,
    lastVerifiedAt: verifiedAt,
  };
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
  const codes = details.flatMap((detail) =>
    typeof detail === "string" && HAPPIER_HEALTH_REASON_MAP[detail]
      ? [HAPPIER_HEALTH_REASON_MAP[detail]]
      : [],
  );
  return [...new Set(codes)];
}

function failure<T>(
  code: Parameters<typeof connectorError>[0],
  message: string,
  retryable: boolean,
  safeDetails?: Readonly<Record<string, unknown>>,
): SessionConnectorResultV1<T> {
  return { ok: false, error: connectorError(code, message, retryable, safeDetails) };
}

function connectorError(
  code: "unavailable" | "unverified" | "degraded" | "invalid_request" | "authentication_required" | "not_found" | "ambiguous" | "host_unavailable" | "rate_limited" | "conflict" | "transport" | "delivery_uncertain" | "internal",
  message: string,
  retryable: boolean,
  safeDetails?: Readonly<Record<string, unknown>>,
) {
  return { code, message, retryable, ...(safeDetails ? { safeDetails } : {}) } as const;
}

const HAPPIER_SAFE_OFFICIAL_CODES = new Set([
  "not_authenticated",
  "authentication_required",
  "auth_required",
  "unauthorized",
  "forbidden",
  "invalid_token",
  "token_expired",
  "server_unreachable",
  "server_unavailable",
  "connection_failed",
  "network_error",
  "daemon_unavailable",
  "daemon_not_running",
  "backend_unavailable",
  "backend_not_found",
  "provider_unavailable",
  "model_unavailable",
  "session_not_found",
  "session_archived",
  "session_unavailable",
  "invalid_session",
  "session_create_failed",
  "session_send_failed",
  "candidate_not_found",
  "candidate_ambiguous",
  "machine_mismatch",
  "invalid_uri",
  "rate_limited",
  "rate_limit",
  "quota_exceeded",
  "too_many_requests",
]);

const HAPPIER_RATE_LIMIT_OFFICIAL_CODES = new Set([
  "rate_limited",
  "rate_limit",
  "quota_exceeded",
  "too_many_requests",
]);

function normalizedSafeOfficialCode(error: HappierCliError): string | undefined {
  if (typeof error.officialCode !== "string" || error.officialCode.length > 64) return undefined;
  const normalized = error.officialCode.trim().toLowerCase().replace(/[-\s]+/gu, "_");
  return HAPPIER_SAFE_OFFICIAL_CODES.has(normalized) ? normalized : undefined;
}

function safeCliDetails(error: HappierCliError): Readonly<Record<string, unknown>> {
  const officialCode = normalizedSafeOfficialCode(error);
  return {
    source: "happier_cli",
    category: error.code,
    ...(officialCode ? { officialCode } : {}),
  };
}

function mapReadFailure<T>(error: unknown): SessionConnectorResultV1<T> {
  if (!(error instanceof HappierCliError)) {
    return failure("internal", "Happier connector operation failed", false);
  }
  const details = safeCliDetails(error);
  const officialCode = normalizedSafeOfficialCode(error);
  if (error.code === "authentication") {
    return failure("authentication_required", "Happier authentication is required", false, details);
  }
  if (officialCode === "session_not_found" || officialCode === "candidate_not_found") {
    return failure("not_found", "The requested native Session was not found", false, details);
  }
  if (officialCode === "candidate_ambiguous") {
    return failure("ambiguous", "The requested native Session was ambiguous", false, details);
  }
  if (officialCode === "machine_mismatch") {
    return failure("conflict", "The requested Session belongs to another machine", false, details);
  }
  if (officialCode === "invalid_uri") {
    return failure("invalid_request", "The native Session URI is invalid", false, details);
  }
  if (officialCode && HAPPIER_RATE_LIMIT_OFFICIAL_CODES.has(officialCode)) {
    return failure("rate_limited", "Happier rate limited the connector operation", true, details);
  }
  if (error.code === "daemon" || error.code === "backend") {
    return failure("unavailable", "The Happier daemon or provider backend is unavailable", true, details);
  }
  if (error.code === "timeout" || error.code === "server" || error.code === "process") {
    return failure("transport", "Happier connector transport failed", true, details);
  }
  if (error.code === "session") {
    return failure("not_found", "The Happier Session is unavailable", false, details);
  }
  return failure("degraded", "Happier returned an invalid connector response", false, details);
}

function validateIdentity(
  identity: SessionConnectorIdentityV1,
  activeServerId: string | undefined,
): SessionConnectorResultV1<string> {
  if (identity.connectorId !== HAPPIER_SESSION_CONNECTOR_ID) {
    return failure("conflict", "Session identity belongs to a different connector", false);
  }
  if (!identity.machineId?.trim()) {
    return failure("invalid_request", "A Happier machine identity is required", false);
  }
  if (!identity.happierSessionId?.trim()) {
    return failure("invalid_request", "A Happier Session identity is required", false);
  }
  if (!activeServerId?.trim()) {
    return failure("degraded", "The Happier active server profile is not pinned", false);
  }
  if (identity.serverProfileId?.trim() !== activeServerId) {
    return failure("conflict", "The Happier server profile does not match the immutable Session binding", false);
  }
  return { ok: true, value: identity.happierSessionId };
}

function readStatusValue(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["status", "state"] as const) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function statusState(result: HappierSessionStatusResult): SessionConnectorStatusV1["state"] {
  const session = result.session;
  const agentState = asRecord(result.agentState);
  const raw = (readStatusValue(agentState) ?? readStatusValue(session))?.toLowerCase();
  if (raw === "waiting" || raw === "waitingoninput" || raw === "awaiting_input" || raw === "waiting_input") {
    return "waiting_input";
  }
  if (raw === "running" || raw === "active" || raw === "busy" || raw === "starting" || raw === "recovering") {
    return "running";
  }
  if (raw === "paused" || raw === "blocked") return "paused";
  if (raw === "failed" || raw === "error" || raw === "lost" || raw === "unavailable") return "lost";
  if (agentState?.controlledByUser === true) return "waiting_input";
  if (typeof agentState?.pendingRequestsCount === "number" && agentState.pendingRequestsCount > 0) return "running";
  if (session.active === false) return "lost";
  if (session.active === true) return "idle";
  return "unknown";
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return null;
}

function statusLastActivity(result: HappierSessionStatusResult): string | null {
  const agentState = asRecord(result.agentState);
  for (const value of [
    result.session.lastActivityAt,
    result.session.updatedAt,
    agentState?.lastActivityAt,
    agentState?.updatedAt,
    result.lastActivityAt,
    result.updatedAt,
  ]) {
    const parsed = isoTimestamp(value);
    if (parsed) return parsed;
  }
  return null;
}

function historyRole(value: unknown): SessionConnectorHistoryItemV1["role"] {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "user" || normalized === "human") return "user";
  if (normalized === "assistant" || normalized === "agent" || normalized === "ai") return "assistant";
  if (normalized === "tool" || normalized === "function") return "tool";
  if (normalized === "system") return "system";
  return "unknown";
}

function historyCursor(identity: SessionConnectorIdentityV1, nativeMessageId: string): string {
  return `${DIRECT_MESSAGE_CURSOR_PREFIX}${hashRoomValue({
    connectorId: identity.connectorId,
    providerId: identity.providerId,
    nativeSessionId: identity.nativeSessionId,
    happierSessionId: identity.happierSessionId,
    serverProfileId: identity.serverProfileId,
    machineId: identity.machineId,
    nativeMessageId,
  })}`;
}

type DirectIdentity = Readonly<{
  providerId: HappierBackend;
  remoteSessionId: string;
  sessionId: string;
  machineId: string;
}>;

function validateDirectIdentity(
  identity: SessionConnectorIdentityV1,
  activeServerId: string | undefined,
): SessionConnectorResultV1<DirectIdentity> {
  const linked = validateIdentity(identity, activeServerId);
  if (!linked.ok) return linked;
  if (
    identity.providerId !== "codex"
    && identity.providerId !== "claude"
    && identity.providerId !== "opencode"
  ) {
    return failure("invalid_request", "The Happier Direct Session provider is unsupported", false);
  }
  if (!identity.nativeSessionId.trim() || !identity.machineId?.trim()) {
    return failure("invalid_request", "Provider-native and machine identities are required", false);
  }
  return {
    ok: true,
    value: {
      providerId: identity.providerId,
      remoteSessionId: identity.nativeSessionId,
      sessionId: linked.value,
      machineId: identity.machineId,
    },
  };
}

function mapDirectTranscript(
  identity: SessionConnectorIdentityV1,
  delta: HappierDirectSessionTranscriptDelta,
): SessionConnectorResultV1<readonly SessionConnectorHistoryItemV1[]> {
  const nativeIds = new Set<string>();
  const cursors = new Set<string>();
  const items: SessionConnectorHistoryItemV1[] = [];
  for (let index = 0; index < delta.items.length; index += 1) {
    const row = delta.items[index]!;
    if (nativeIds.has(row.id)) {
      return failure("degraded", "Happier Direct history contained duplicate native messages", false);
    }
    const occurredAt = isoTimestamp(row.createdAtMs);
    if (!occurredAt) {
      return failure("degraded", "Happier Direct history contained an invalid timestamp", false);
    }
    const raw = asRecord(row.raw);
    if (!raw) {
      return failure("degraded", "Happier Direct history contained an invalid raw record", false);
    }
    const cursor = index === delta.items.length - 1 && delta.nextCursor
      ? delta.nextCursor
      : historyCursor(identity, row.id);
    if (cursors.has(cursor)) {
      return failure("degraded", "Happier Direct history contained duplicate message cursors", false);
    }
    nativeIds.add(row.id);
    cursors.add(cursor);
    items.push({
      nativeMessageId: row.id,
      logicalMessageId: typeof row.localId === "string" && row.localId.trim() ? row.localId : null,
      role: historyRole(raw.role ?? raw.type),
      contentHash: hashRoomValue(raw),
      occurredAt,
      cursor,
    });
  }
  if (items.length > 0 && delta.nextCursor === null) {
    return failure("degraded", "Happier Direct history did not provide a complete cursor", false);
  }
  return { ok: true, value: items };
}

function mapDirectStatusEvent(
  identity: SessionConnectorIdentityV1,
  delta: HappierDirectSessionStatusDelta,
): SessionConnectorEventV1 {
  const lastActivityAt = isoTimestamp(delta.lastActivityAtMs);
  const eventHash = hashRoomValue({
    identity,
    isRunning: delta.isRunning,
    lastActivityAtMs: delta.lastActivityAtMs,
    observedAtMs: delta.observedAtMs,
  });
  const cursor = `happier-direct-status-v1:${delta.observedAtMs}:${eventHash}`;
  return {
    connectorEventId: cursor,
    identity,
    eventType: "status",
    cursor,
    occurredAt: new Date(delta.observedAtMs).toISOString(),
    payload: {
      type: "status",
      state: delta.isRunning ? "running" : "idle",
      lastActivityAt,
      connectorCursor: null,
      // Activity proves provider process state, not whether a human IDE authored it.
      nativeWriterDetected: false,
    },
  };
}

function isDirectStatusDelta(
  delta: HappierDirectSessionTranscriptDelta | HappierDirectSessionStatusDelta,
): delta is HappierDirectSessionStatusDelta {
  return "eventType" in delta && delta.eventType === "status";
}

function unavailableResult<T>(operation: string): SessionConnectorResultV1<T> {
  return failure(
    "unavailable",
    `Happier connector ${operation} is not available on a reviewed public surface`,
    false,
  );
}

function certifiedNativeSessionUrl(identity: SessionConnectorIdentityV1): string | null {
  if (
    !isHappierDirectSessionProviderId(identity.providerId)
    || HAPPIER_DIRECT_SESSION_CAPABILITY_MATRIX[identity.providerId].nativeDeepLink !== "certified"
    || identity.providerId !== "codex"
  ) return null;
  return `codex://threads/${encodeURIComponent(identity.nativeSessionId)}`;
}

/**
 * Provider-neutral adapter over the reviewed, shell-free Happier JSON CLI.
 *
 * FNXC:HappierSessionConnector 2026-07-17-05:12:
 * The provider's `remoteSessionId`, Happier's linked `sessionId`, server,
 * machine, and Fusion host are distinct immutable identities. Content crosses
 * only the send boundary; history projections retain hashes and cursors, and
 * capability states remain fail-closed until provider-specific certification.
 */
export class HappierSessionConnector implements SessionConnectorV1 {
  readonly contractVersion = 1 as const;
  readonly id = HAPPIER_SESSION_CONNECTOR_ID;
  readonly version: string;

  private readonly settings: HappierCliSettings;
  private readonly sourceRevision: string;
  private readonly sendTimeoutSeconds: number;
  private readonly rateLimitCooldownMs: number;
  private readonly now: () => string;
  private readonly dependencies: HappierSessionConnectorDependencies;
  private readonly transcriptCursors = new Map<string, string | null>();
  private rateLimitedUntilMs: number | null = null;

  constructor(options: HappierSessionConnectorOptions = {}) {
    this.settings = resolveHappierCliSettings(options.settings);
    this.version = options.version?.trim() || HAPPIER_SESSION_CONNECTOR_VERSION;
    this.sourceRevision = options.sourceRevision?.trim() || HAPPIER_DIRECT_SESSION_SOURCE_REVISION;
    this.sendTimeoutSeconds = options.sendTimeoutSeconds ?? DEFAULT_SEND_TIMEOUT_SECONDS;
    if (!Number.isInteger(this.sendTimeoutSeconds) || this.sendTimeoutSeconds <= 0) {
      throw new Error("Happier Session Connector sendTimeoutSeconds must be a positive integer");
    }
    this.rateLimitCooldownMs = options.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    if (
      !Number.isSafeInteger(this.rateLimitCooldownMs)
      || this.rateLimitCooldownMs <= 0
      || this.rateLimitCooldownMs > MAX_RATE_LIMIT_COOLDOWN_MS
    ) {
      throw new Error("Happier Session Connector rateLimitCooldownMs must be an integer from 1 through 604800000");
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.dependencies = { ...defaultDependencies, ...(options.dependencies ?? {}) };
  }

  async getCapabilities(identity?: SessionConnectorIdentityV1): Promise<SessionConnectorCapabilitiesV1> {
    const verifiedAt = this.now();
    const activeServerId = this.settings.activeServerId?.trim();
    const profileMatches = Boolean(activeServerId)
      && (identity === undefined || identity.serverProfileId === activeServerId);
    let runtimeManifestCertified = false;
    let runtimeBuildEvidenceRef: string | null = null;
    try {
      const observedManifest = await this.dependencies.getDirectSessionCapabilities(this.settings, undefined);
      const manifestMatches = isCertifiedHappierDirectSessionRuntimeManifest(
        observedManifest,
        this.sourceRevision,
      );
      if (manifestMatches) {
        const runtimeBuild = await this.dependencies.verifyRuntimeBuild(
          observedManifest,
          this.settings.entrypoint,
        );
        runtimeManifestCertified = runtimeBuild.ok;
        if (runtimeBuild.ok) runtimeBuildEvidenceRef = runtimeBuild.launchDigest;
      }
    } catch {
      // Old, drifted, or unavailable executables remain source_unverified.
    }
    const providerRows = identity === undefined
      ? HAPPIER_DIRECT_SESSION_PROVIDER_IDS.map((providerId) => HAPPIER_DIRECT_SESSION_CAPABILITY_MATRIX[providerId])
      : isHappierDirectSessionProviderId(identity.providerId)
        ? [HAPPIER_DIRECT_SESSION_CAPABILITY_MATRIX[identity.providerId]]
        : [];
    const providerScope = identity === undefined ? "codex+claude+opencode" : identity.providerId;

    const certificationFor = (
      capability: (typeof SESSION_CONNECTOR_CAPABILITIES)[number],
    ): SessionConnectorCapabilityCertificationV1 => {
      const auditedEntries = providerRows.map((row) => row.capabilities[capability]);
      const universallyUnavailable = HAPPIER_DIRECT_SESSION_PROVIDER_IDS.every(
        (providerId) => HAPPIER_DIRECT_SESSION_CAPABILITY_MATRIX[providerId].capabilities[capability].connectorState === "unavailable",
      );
      if (auditedEntries.length === 0) {
        return universallyUnavailable
          ? unavailableCertification("operation_unavailable")
          : unverifiedCertification("source_unverified");
      }

      const first = auditedEntries[0]!;
      const statesMatch = auditedEntries.every((entry) => entry.connectorState === first.connectorState);
      if (!statesMatch) return unverifiedCertification("pending_provider_certification");
      if (first.connectorState === "unavailable") {
        return unavailableCertification(first.reasonCode ?? "operation_unavailable");
      }
      if (first.connectorState !== "verified") {
        return unverifiedCertification(first.reasonCode ?? "pending_provider_certification");
      }
      if (identity === undefined && capability !== "deepLinks") {
        return unverifiedCertification("pending_provider_certification");
      }
      if (!runtimeManifestCertified) return unverifiedCertification("source_unverified");
      if ((capability === "history" || capability === "events" || capability === "deepLinks") && !profileMatches) {
        return {
          state: "degraded",
          evidenceRef: null,
          reasonCode: "server_profile_mismatch",
          lastVerifiedAt: null,
        };
      }
      if (capability === "deepLinks") {
        try {
          if (!this.settings.webappUrl?.trim()) throw new Error("missing webapp origin");
          buildHappierSessionOpenUrl(this.settings.webappUrl, activeServerId!, "capability-probe");
        } catch {
          return {
            state: "degraded",
            evidenceRef: null,
            reasonCode: "runtime_degraded",
            lastVerifiedAt: null,
          };
        }
      }
      const evidenceKey = auditedEntries.length === 1
        ? first.evidenceKey
        : `provider-matrix-${capability}`;
      if (!evidenceKey) return unverifiedCertification("source_unverified");
      return verifiedCertification(
        `happier-runtime:${HAPPIER_DIRECT_SESSION_CAPABILITY_FINGERPRINT}:local-build=${runtimeBuildEvidenceRef}:reviewed-source=${this.sourceRevision}:provider=${identity === undefined ? "all" : providerScope}:${evidenceKey}`,
        verifiedAt,
      );
    };

    const capabilities = Object.fromEntries(
      SESSION_CONNECTOR_CAPABILITIES.map((capability) => [capability, certificationFor(capability)]),
    ) as SessionConnectorCapabilitiesV1["capabilities"];
    return {
      contractVersion: 1,
      connectorId: this.id,
      connectorVersion: this.version,
      sourceRevision: this.sourceRevision,
      verifiedAt,
      capabilities,
    };
  }

  async ensureExisting(
    input: SessionConnectorEnsureExistingRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorEnsureExistingResultV1>> {
    if (
      input.contractVersion !== 1
      || !input.canonicalSessionUri.trim()
      || !input.idempotencyKey.trim()
      || !input.requiredHostId?.trim()
    ) {
      return failure(
        "invalid_request",
        "A canonical Session URI, host identity, and idempotency key are required",
        false,
      );
    }
    let requestedProviderId: string;
    let requestedNativeSessionId: string;
    try {
      const uri = new URL(input.canonicalSessionUri);
      requestedProviderId = uri.protocol.slice(0, -1);
      requestedNativeSessionId = decodeURIComponent(uri.pathname.slice(1));
      if (!requestedProviderId || !requestedNativeSessionId) throw new Error("invalid URI identity");
    } catch {
      return failure("invalid_request", "The canonical native Session URI is invalid", false);
    }

    try {
      const ensured = await this.dependencies.ensureDirectSession({
        uri: input.canonicalSessionUri,
        ...(input.requiredMachineId ? { machineId: input.requiredMachineId } : {}),
        settings: this.settings,
      });
      if (
        ensured.providerId !== requestedProviderId
        || ensured.remoteSessionId !== requestedNativeSessionId
      ) {
        return failure("conflict", "Happier returned a different provider-native Session identity", false);
      }
      if (input.requiredMachineId && ensured.machineId !== input.requiredMachineId) {
        return failure("conflict", "Happier linked the Session on a different machine", false);
      }
      if (!this.settings.activeServerId) {
        return failure("degraded", "The Happier active server profile is not pinned", false);
      }
      if (ensured.serverId !== this.settings.activeServerId) {
        return failure("conflict", "Happier linked the Session on a different server profile", false);
      }
      const identity: SessionConnectorIdentityV1 = {
        connectorId: this.id,
        providerId: ensured.providerId,
        nativeSessionId: ensured.remoteSessionId,
        happierSessionId: ensured.sessionId,
        serverProfileId: ensured.serverId,
        machineId: ensured.machineId,
        hostId: input.requiredHostId.trim(),
      };
      return {
        ok: true,
        value: {
          identity,
          createdLink: ensured.created,
          providerTurnStarted: false,
          attachedAt: this.now(),
          capabilities: await this.getCapabilities(identity),
        },
      };
    } catch (error) {
      return this.mapOperationalFailure(error);
    }
  }

  async create(
    _input: SessionConnectorCreateRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorIdentityV1>> {
    return unavailableResult("create");
  }

  async getStatus(
    identity: SessionConnectorIdentityV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorStatusV1>> {
    const target = validateIdentity(identity, this.settings.activeServerId);
    if (!target.ok) return target;
    try {
      const result = await this.dependencies.getSessionStatus(target.value, this.settings, undefined);
      const agentState = asRecord(result.agentState);
      const cursor = typeof result.cursor === "string" && result.cursor.trim()
        ? result.cursor
        : typeof agentState?.cursor === "string" && agentState.cursor.trim()
          ? agentState.cursor
          : null;
      return {
        ok: true,
        value: {
          identity,
          state: statusState(result),
          lastActivityAt: statusLastActivity(result),
          connectorCursor: cursor,
          nativeWriterDetected: agentState?.controlledByUser === true,
        },
      };
    } catch (error) {
      return this.mapOperationalFailure(error);
    }
  }

  async readHistory(
    input: SessionConnectorHistoryRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorHistoryPageV1>> {
    const target = validateDirectIdentity(input.identity, this.settings.activeServerId);
    if (!target.ok) return target;
    if (input.contractVersion !== 1 || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > SESSION_CONNECTOR_HISTORY_PAGE_LIMIT) {
      return failure("invalid_request", "History limit must be an integer from 1 through 250", false);
    }
    try {
      const result = await this.dependencies.readDirectTranscript(
        {
          ...target.value,
          afterCursor: input.afterCursor,
          limit: input.limit,
        },
        this.settings,
        undefined,
      );
      const mapped = mapDirectTranscript(input.identity, result);
      if (!mapped.ok) return mapped;
      const completeThroughCursor = result.nextCursor ?? result.fromCursor;
      this.transcriptCursors.set(this.identityKey(input.identity), completeThroughCursor);
      return {
        ok: true,
        value: {
          items: mapped.value,
          nextCursor: result.nextCursor,
          completeThroughCursor,
          truncated: result.truncated,
        },
      };
    } catch (error) {
      return this.mapOperationalFailure(error);
    }
  }

  async subscribeEvents(
    identity: SessionConnectorIdentityV1,
  ): Promise<SessionConnectorResultV1<AsyncIterable<SessionConnectorEventV1>>> {
    const target = validateDirectIdentity(identity, this.settings.activeServerId);
    if (!target.ok) return target;
    try {
      const rawEvents = this.dependencies.followDirectTranscriptEvents(
        {
          ...target.value,
          afterCursor: this.transcriptCursors.get(this.identityKey(identity)) ?? null,
          limit: SESSION_CONNECTOR_HISTORY_PAGE_LIMIT,
        },
        this.settings,
        undefined,
      );
      const transcriptCursorKey = this.identityKey(identity);
      const transcriptCursors = this.transcriptCursors;
      const now = this.now;
      return {
        ok: true,
        value: {
          async *[Symbol.asyncIterator](): AsyncIterator<SessionConnectorEventV1> {
            for await (const delta of rawEvents) {
              if (isDirectStatusDelta(delta)) {
                yield mapDirectStatusEvent(identity, delta);
                continue;
              }
              const mapped = mapDirectTranscript(identity, delta);
              if (!mapped.ok) {
                throw new HappierCliError("protocol", mapped.error.message);
              }
              const completeThroughCursor = delta.nextCursor ?? delta.fromCursor;
              if (completeThroughCursor !== null) {
                transcriptCursors.set(transcriptCursorKey, completeThroughCursor);
              }
              const occurredAt = mapped.value.at(-1)?.occurredAt ?? now();
              const eventHash = hashRoomValue({
                identity,
                fromCursor: delta.fromCursor,
                nextCursor: delta.nextCursor,
                nativeMessageIds: mapped.value.map((item) => item.nativeMessageId),
              });
              yield {
                connectorEventId: `happier-direct-transcript-v1:${eventHash}`,
                identity,
                eventType: "message",
                cursor: delta.nextCursor ?? delta.fromCursor ?? `happier-direct-event-v1:${eventHash}`,
                occurredAt,
                payload: {
                  type: "transcript_delta",
                  fromCursor: delta.fromCursor,
                  nextCursor: delta.nextCursor,
                  completeThroughCursor,
                  truncated: delta.truncated,
                  items: mapped.value,
                },
              };
            }
          },
        },
      };
    } catch (error) {
      return this.mapOperationalFailure(error);
    }
  }

  async send(
    input: SessionConnectorSendRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorSendReceiptV1>> {
    const target = validateIdentity(input.identity, this.settings.activeServerId);
    if (!target.ok) return target;
    if (
      input.contractVersion !== 1
      || !input.bindingId.trim()
      || !input.logicalMessageId.trim()
      || !input.localMessageId.trim()
      || input.localMessageId.length > 128
      || !/^[A-Za-z0-9._:-]+$/u.test(input.localMessageId)
      || !input.idempotencyKey.trim()
      || !input.content.trim()
      || input.contentHash !== hashRoomValue(input.content)
    ) {
      return failure("invalid_request", "Happier send requires valid identity, idempotency, content, and content hash", false);
    }
    const localId = input.localMessageId;
    try {
      const result = await this.dependencies.sendMessage({
        sessionId: target.value,
        message: input.content,
        localId,
        timeoutSeconds: this.sendTimeoutSeconds,
      }, this.settings, undefined);
      return {
        ok: true,
        value: {
          outcome: "accepted",
          connectorAcknowledgementId: result.localId ?? localId,
          nativeMessageId: null,
          cursor: null,
          acceptedAt: this.now(),
        },
      };
    } catch (error) {
      const mapped = this.mapOperationalFailure<SessionConnectorSendReceiptV1>(error);
      if (!mapped.ok && mapped.error.code === "rate_limited") return mapped;
      if (
        error instanceof HappierCliError
        && (error.code === "timeout"
          || error.code === "server"
          || error.code === "process"
          || error.code === "protocol"
          || error.code === "invalid-json"
          || error.code === "output-limit")
      ) {
        return {
          ok: true,
          value: {
            outcome: "delivery_uncertain",
            connectorAcknowledgementId: null,
            nativeMessageId: null,
            cursor: null,
            acceptedAt: null,
          },
        };
      }
      return mapped;
    }
  }

  async interrupt(
    _input: SessionConnectorControlRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorControlResultV1>> {
    return unavailableResult("interrupt");
  }

  async resume(
    _input: SessionConnectorControlRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorControlResultV1>> {
    return unavailableResult("resume");
  }

  async takeover(
    _input: SessionConnectorControlRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorControlResultV1>> {
    return unavailableResult("takeover");
  }

  async getHealth(hostId: string): Promise<SessionConnectorHealthV1> {
    const capabilityMatrix = await this.getCapabilities();
    const capabilities = Object.fromEntries(
      SESSION_CONNECTOR_CAPABILITIES.map((name) => [name, capabilityMatrix.capabilities[name].state]),
    ) as SessionConnectorHealthV1["capabilities"];
    const host = hostId.trim() ? "reachable" as const : "unavailable" as const;
    try {
      const health = await this.dependencies.probeRuntime(this.settings);
      const checkedAt = this.now();
      let retryAfterMs = this.activeRateLimitRetryAfterMs(checkedAt);
      const configuredBackend = this.settings.backend;
      const backendMismatch = Boolean(configuredBackend)
        && health.backendId !== configuredBackend;
      const mappedReasonCodes = typedHealthReasonCodes(health.details);
      if (backendMismatch && !mappedReasonCodes.includes("backend_unavailable")) {
        mappedReasonCodes.push("backend_unavailable");
      }
      if (mappedReasonCodes.includes("rate_limited") && retryAfterMs === null) {
        this.observeRateLimit(checkedAt);
        retryAfterMs = this.activeRateLimitRetryAfterMs(checkedAt);
      }
      const rateLimitedReasonCodes = retryAfterMs === null
        ? mappedReasonCodes
        : [...new Set([...mappedReasonCodes, "rate_limited" as const])];
      const reasonCodes = host === "reachable"
        ? rateLimitedReasonCodes
        : [...new Set([...rateLimitedReasonCodes, "host_unavailable" as const])];
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
      const backend = health.backend && !backendMismatch
        ? "ready" as const
        : reasonCodes.some((code) => code.startsWith("backend_"))
          ? "unavailable" as const
          : "unknown" as const;
      const rateLimit = reasonCodes.includes("rate_limited")
        ? "limited" as const
        : health.ready
          ? "clear" as const
          : "unknown" as const;
      const state = host !== "reachable"
        ? "host_unavailable" as const
        : rateLimit === "limited"
          ? "rate_limited" as const
          : server === "unreachable" || !health.discovered || !health.executable
            ? "unavailable" as const
            : authentication === "required"
              ? "authentication_required" as const
              : health.ready && backend === "ready"
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
        rateLimit,
        host,
        capabilities,
        reasonCodes,
        retryAfterMs,
      };
    } catch (error) {
      const checkedAt = this.now();
      this.mapOperationalFailure(error);
      const failureRetryAfterMs = this.activeRateLimitRetryAfterMs(checkedAt);
      const reasonCodes: SessionConnectorHealthReasonCode[] = ["probe_failed"];
      if (failureRetryAfterMs !== null) reasonCodes.push("rate_limited");
      if (host !== "reachable") reasonCodes.push("host_unavailable");
      return {
        connectorId: this.id,
        hostId,
        state: host !== "reachable"
          ? "host_unavailable"
          : failureRetryAfterMs !== null
            ? "rate_limited"
            : "unavailable",
        checkedAt,
        authentication: "unknown",
        daemon: "unknown",
        server: "unknown",
        backend: "unknown",
        rateLimit: failureRetryAfterMs === null ? "unknown" : "limited",
        host,
        capabilities,
        reasonCodes,
        retryAfterMs: failureRetryAfterMs,
      };
    }
  }

  private mapOperationalFailure<T>(error: unknown): SessionConnectorResultV1<T> {
    const result = mapReadFailure<T>(error);
    if (!result.ok && result.error.code === "rate_limited") {
      this.observeRateLimit(this.now());
    }
    return result;
  }

  private observeRateLimit(observedAt: string): void {
    const observedAtMs = Date.parse(observedAt);
    if (!Number.isFinite(observedAtMs)) return;
    this.rateLimitedUntilMs = Math.max(
      this.rateLimitedUntilMs ?? 0,
      observedAtMs + this.rateLimitCooldownMs,
    );
  }

  private activeRateLimitRetryAfterMs(checkedAt: string): number | null {
    if (this.rateLimitedUntilMs === null) return null;
    const checkedAtMs = Date.parse(checkedAt);
    if (!Number.isFinite(checkedAtMs)) return this.rateLimitCooldownMs;
    const remainingMs = this.rateLimitedUntilMs - checkedAtMs;
    if (remainingMs <= 0) {
      this.rateLimitedUntilMs = null;
      return null;
    }
    return Math.min(remainingMs, MAX_RATE_LIMIT_COOLDOWN_MS);
  }

  private identityKey(identity: SessionConnectorIdentityV1): string {
    return hashRoomValue({
      connectorId: identity.connectorId,
      providerId: identity.providerId,
      nativeSessionId: identity.nativeSessionId,
      happierSessionId: identity.happierSessionId,
      serverProfileId: identity.serverProfileId,
      machineId: identity.machineId,
      hostId: identity.hostId,
    });
  }

  async getDeepLinks(
    input: SessionConnectorDeepLinksRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorDeepLinksV1>> {
    if (input.contractVersion !== 1 || !input.bindingId.trim() || !input.identity.hostId.trim()) {
      return failure("invalid_request", "Room binding and host identities are required for deep links", false);
    }
    const target = validateDirectIdentity(input.identity, this.settings.activeServerId);
    if (!target.ok) return target;
    if (!this.settings.webappUrl?.trim() || !input.identity.serverProfileId) {
      return failure("degraded", "The current Happier web origin or server profile is unavailable", false);
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
            input.identity.serverProfileId,
            target.value.sessionId,
          ),
          nativeSessionUrl: certifiedNativeSessionUrl(input.identity),
        },
      };
    } catch {
      return failure("degraded", "The current Happier web origin cannot build a certified link", false);
    }
  }
}

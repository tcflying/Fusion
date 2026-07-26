import {
  SESSION_CONNECTOR_CAPABILITIES,
  SESSION_CONNECTOR_CAPABILITY_REASON_CODES,
  SESSION_CONNECTOR_HEALTH_MAX_AGE_MS,
  SESSION_CONNECTOR_HEALTH_MAX_FUTURE_SKEW_MS,
  SESSION_CONNECTOR_HEALTH_MAX_RETRY_AFTER_MS,
  SESSION_CONNECTOR_HEALTH_REASON_CODES,
  SESSION_CONNECTOR_MUTATING_CAPABILITIES,
  type SessionConnectorCapabilitiesV1,
  type SessionConnectorCapabilityName,
  type SessionConnectorCapabilityReasonCode,
  type SessionConnectorCapabilityState,
  type SessionConnectorHealthReasonCode,
  type SessionConnectorHealthV1,
  type SessionConnectorIdentityV1,
  type SessionConnectorV1,
} from "@fusion/core";

export type SessionConnectorRegistryErrorCode =
  | "SESSION_CONNECTOR_DUPLICATE"
  | "SESSION_CONNECTOR_UNKNOWN"
  | "SESSION_CONNECTOR_CONTRACT_CONFLICT"
  | "SESSION_CONNECTOR_IDENTITY_CONFLICT"
  | "SESSION_CONNECTOR_HOST_AFFINITY"
  | "SESSION_CONNECTOR_CAPABILITY_NOT_VERIFIED"
  | "SESSION_CONNECTOR_HEALTH_CONTRACT_CONFLICT"
  | "SESSION_CONNECTOR_HEALTH_NOT_READY";

export class SessionConnectorRegistryError extends Error {
  constructor(
    readonly code: SessionConnectorRegistryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SessionConnectorRegistryError";
  }
}

export class DuplicateSessionConnectorError extends SessionConnectorRegistryError {
  constructor(readonly connectorId: string) {
    super(
      "SESSION_CONNECTOR_DUPLICATE",
      `A Session Connector is already registered for id ${connectorId}`,
    );
    this.name = "DuplicateSessionConnectorError";
  }
}

export class UnknownSessionConnectorError extends SessionConnectorRegistryError {
  constructor(readonly connectorId: string) {
    super(
      "SESSION_CONNECTOR_UNKNOWN",
      `No Session Connector is registered for id ${connectorId}`,
    );
    this.name = "UnknownSessionConnectorError";
  }
}

export class SessionConnectorContractError extends SessionConnectorRegistryError {
  constructor(
    readonly connectorId: string,
    readonly detail: string,
  ) {
    super(
      "SESSION_CONNECTOR_CONTRACT_CONFLICT",
      `Session Connector ${connectorId} violates the v1 contract: ${detail}`,
    );
    this.name = "SessionConnectorContractError";
  }
}

export class SessionConnectorIdentityConflictError extends SessionConnectorRegistryError {
  constructor(
    readonly connectorId: string,
    readonly identityConnectorId: string,
  ) {
    super(
      "SESSION_CONNECTOR_IDENTITY_CONFLICT",
      `Session identity belongs to connector ${identityConnectorId}, not ${connectorId}`,
    );
    this.name = "SessionConnectorIdentityConflictError";
  }
}

export class SessionConnectorHostAffinityError extends SessionConnectorRegistryError {
  constructor(
    readonly connectorId: string,
    readonly expectedHostId: string,
    readonly actualHostId: string,
  ) {
    super(
      "SESSION_CONNECTOR_HOST_AFFINITY",
      `Session Connector ${connectorId} requires host ${expectedHostId}, but the binding belongs to ${actualHostId}`,
    );
    this.name = "SessionConnectorHostAffinityError";
  }
}

export class SessionConnectorCapabilityNotVerifiedError extends SessionConnectorRegistryError {
  constructor(
    readonly connectorId: string,
    readonly capability: SessionConnectorCapabilityName,
    readonly state: SessionConnectorCapabilityState,
    readonly reasonCode: SessionConnectorCapabilityReasonCode | null,
  ) {
    super(
      "SESSION_CONNECTOR_CAPABILITY_NOT_VERIFIED",
      `Session Connector ${connectorId} capability ${capability} is ${state}${reasonCode ? ` (${reasonCode})` : ""}`,
    );
    this.name = "SessionConnectorCapabilityNotVerifiedError";
  }
}

export class SessionConnectorHealthContractError extends SessionConnectorRegistryError {
  constructor(
    readonly connectorId: string,
    readonly detail: string,
  ) {
    super(
      "SESSION_CONNECTOR_HEALTH_CONTRACT_CONFLICT",
      `Session Connector ${connectorId} returned invalid typed health: ${detail}`,
    );
    this.name = "SessionConnectorHealthContractError";
  }
}

export class SessionConnectorHealthNotReadyError extends SessionConnectorRegistryError {
  constructor(
    readonly connectorId: string,
    readonly capability: SessionConnectorCapabilityName,
    readonly healthState: SessionConnectorHealthV1["state"],
    readonly reasonCodes: readonly SessionConnectorHealthReasonCode[],
    readonly retryAfterMs: number | null,
  ) {
    super(
      "SESSION_CONNECTOR_HEALTH_NOT_READY",
      `Session Connector ${connectorId} cannot perform ${capability}: runtime is ${healthState}${reasonCodes.length > 0 ? ` (${reasonCodes.join(",")})` : ""}`,
    );
    this.name = "SessionConnectorHealthNotReadyError";
  }
}

export interface RequireVerifiedSessionConnectorInput {
  readonly connectorId: string;
  readonly capability: SessionConnectorCapabilityName;
  readonly identity?: SessionConnectorIdentityV1;
  readonly requiredHostId?: string;
  /**
   * Existing-session attachment is a provider-read-only operation when the
   * caller separately proves no provider turn started. It may proceed when a
   * connector cannot observe quota but all other runtime health is ready.
   */
  readonly allowUnknownRateLimitForReadOnlyAttachment?: boolean;
}

const CAPABILITY_STATES = new Set<SessionConnectorCapabilityState>([
  "verified",
  "degraded",
  "unavailable",
  "unverified",
]);
const CAPABILITY_REASON_CODES = new Set<SessionConnectorCapabilityReasonCode>(
  SESSION_CONNECTOR_CAPABILITY_REASON_CODES,
);
const HEALTH_REASON_CODES = new Set<SessionConnectorHealthReasonCode>(
  SESSION_CONNECTOR_HEALTH_REASON_CODES,
);
const MUTATING_CAPABILITIES = new Set<SessionConnectorCapabilityName>(
  SESSION_CONNECTOR_MUTATING_CAPABILITIES,
);
const MAX_CONFIGURABLE_HEALTH_AGE_MS = 300_000;
const MAX_CONFIGURABLE_HEALTH_FUTURE_SKEW_MS = 60_000;
const HEALTH_STATES = new Set<SessionConnectorHealthV1["state"]>([
  "healthy",
  "degraded",
  "authentication_required",
  "rate_limited",
  "host_unavailable",
  "unavailable",
]);
const AUTHENTICATION_STATES = new Set<SessionConnectorHealthV1["authentication"]>([
  "authenticated",
  "required",
  "unknown",
]);
const DAEMON_STATES = new Set<SessionConnectorHealthV1["daemon"]>([
  "running",
  "stopped",
  "not_applicable",
  "unknown",
]);
const SERVER_STATES = new Set<SessionConnectorHealthV1["server"]>([
  "reachable",
  "unreachable",
  "not_applicable",
  "unknown",
]);
const BACKEND_STATES = new Set<SessionConnectorHealthV1["backend"]>([
  "ready",
  "unavailable",
  "not_applicable",
  "unknown",
]);
const RATE_LIMIT_STATES = new Set<SessionConnectorHealthV1["rateLimit"]>([
  "clear",
  "limited",
  "unknown",
]);
const HOST_STATES = new Set<SessionConnectorHealthV1["host"]>([
  "reachable",
  "unavailable",
  "mismatch",
  "unknown",
]);

const CONNECTOR_METHODS = [
  "getCapabilities",
  "ensureExisting",
  "create",
  "getStatus",
  "readHistory",
  "subscribeEvents",
  "send",
  "interrupt",
  "resume",
  "takeover",
  "getHealth",
  "getDeepLinks",
] as const satisfies readonly (keyof SessionConnectorV1)[];

function parseCanonicalIsoTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString() === value ? parsed : null;
}

export interface SessionConnectorRegistryOptions {
  readonly now?: () => number;
  readonly healthMaxAgeMs?: number;
  readonly healthMaxFutureSkewMs?: number;
}

/**
 * Per-runtime registry for provider-neutral Session Connectors.
 *
 * FNXC:SessionConnectorRegistry 2026-07-17-04:45:
 * Room orchestration resolves only a connector id and certified capability.
 * Provider identity is opaque data, host affinity is checked before a native
 * operation, and every non-verified capability fails closed. The registry is
 * instance-scoped so project/plugin lifecycles do not leak connector settings
 * or authentication health through process-global mutable state.
 */
export class SessionConnectorRegistry {
  private readonly connectors = new Map<string, SessionConnectorV1>();
  private readonly now: () => number;
  private readonly healthMaxAgeMs: number;
  private readonly healthMaxFutureSkewMs: number;

  constructor(options: SessionConnectorRegistryOptions = {}) {
    this.now = options.now ?? Date.now;
    this.healthMaxAgeMs = options.healthMaxAgeMs ?? SESSION_CONNECTOR_HEALTH_MAX_AGE_MS;
    this.healthMaxFutureSkewMs = options.healthMaxFutureSkewMs
      ?? SESSION_CONNECTOR_HEALTH_MAX_FUTURE_SKEW_MS;
    if (
      !Number.isSafeInteger(this.healthMaxAgeMs)
      || this.healthMaxAgeMs <= 0
      || this.healthMaxAgeMs > MAX_CONFIGURABLE_HEALTH_AGE_MS
    ) {
      throw new Error("Session Connector healthMaxAgeMs must be an integer from 1 through 300000");
    }
    if (
      !Number.isSafeInteger(this.healthMaxFutureSkewMs)
      || this.healthMaxFutureSkewMs < 0
      || this.healthMaxFutureSkewMs > MAX_CONFIGURABLE_HEALTH_FUTURE_SKEW_MS
    ) {
      throw new Error("Session Connector healthMaxFutureSkewMs must be an integer from 0 through 60000");
    }
  }

  register(connector: SessionConnectorV1): void {
    assertConnectorContract(connector);
    if (this.connectors.has(connector.id)) {
      throw new DuplicateSessionConnectorError(connector.id);
    }
    this.connectors.set(connector.id, connector);
  }

  unregister(connectorId: string): boolean {
    return this.connectors.delete(connectorId);
  }

  get(connectorId: string): SessionConnectorV1 {
    const connector = this.connectors.get(connectorId);
    if (!connector) throw new UnknownSessionConnectorError(connectorId);
    return connector;
  }

  tryGet(connectorId: string): SessionConnectorV1 | undefined {
    return this.connectors.get(connectorId);
  }

  has(connectorId: string): boolean {
    return this.connectors.has(connectorId);
  }

  ids(): string[] {
    return [...this.connectors.keys()];
  }

  all(): SessionConnectorV1[] {
    return [...this.connectors.values()];
  }

  async requireVerified(
    input: RequireVerifiedSessionConnectorInput,
  ): Promise<SessionConnectorV1> {
    const connector = this.get(input.connectorId);
    if (input.identity && input.identity.connectorId !== connector.id) {
      throw new SessionConnectorIdentityConflictError(
        connector.id,
        input.identity.connectorId,
      );
    }
    if (
      input.identity
      && input.requiredHostId
      && input.identity.hostId !== input.requiredHostId
    ) {
      throw new SessionConnectorHostAffinityError(
        connector.id,
        input.requiredHostId,
        input.identity.hostId,
      );
    }

    let certification: unknown;
    try {
      certification = await connector.getCapabilities(input.identity);
    } catch {
      throw new SessionConnectorContractError(
        connector.id,
        "capability discovery failed",
      );
    }
    assertCapabilityMatrix(connector, certification);
    const capability = certification.capabilities[input.capability];
    if (capability.state !== "verified") {
      throw new SessionConnectorCapabilityNotVerifiedError(
        connector.id,
        input.capability,
        capability.state,
        capability.reasonCode,
      );
    }
    if (MUTATING_CAPABILITIES.has(input.capability)) {
      const healthHostId = input.requiredHostId ?? input.identity?.hostId;
      if (!healthHostId?.trim()) {
        throw new SessionConnectorHealthNotReadyError(
          connector.id,
          input.capability,
          "host_unavailable",
          ["host_unavailable"],
          null,
        );
      }
      let health: unknown;
      try {
        health = await connector.getHealth(healthHostId);
      } catch {
        throw new SessionConnectorHealthNotReadyError(
          connector.id,
          input.capability,
          "unavailable",
          ["probe_failed"],
          null,
        );
      }
      const nowMs = this.now();
      if (!Number.isFinite(nowMs)) {
        throw new SessionConnectorHealthContractError(connector.id, "registry clock is invalid");
      }
      assertHealthContract(
        connector,
        health,
        healthHostId,
        nowMs,
        this.healthMaxAgeMs,
        this.healthMaxFutureSkewMs,
      );
      const permitsReadOnlyAttachment = input.capability === "ensureExisting"
        && input.allowUnknownRateLimitForReadOnlyAttachment === true
        && isReadOnlyAttachmentHealthReady(health);
      if (!isMutationHealthReady(health) && !permitsReadOnlyAttachment) {
        throw new SessionConnectorHealthNotReadyError(
          connector.id,
          input.capability,
          health.state,
          health.reasonCodes,
          health.retryAfterMs,
        );
      }
    }
    return connector;
  }
}

function assertConnectorContract(connector: SessionConnectorV1): void {
  const candidate = connector as unknown as Record<string, unknown>;
  const connectorId = typeof candidate.id === "string" && candidate.id.trim()
    ? candidate.id
    : "<invalid>";
  if (candidate.contractVersion !== 1) {
    throw new SessionConnectorContractError(connectorId, "contractVersion must equal 1");
  }
  if (connectorId === "<invalid>") {
    throw new SessionConnectorContractError(connectorId, "id must be a non-empty string");
  }
  if (typeof candidate.version !== "string" || candidate.version.trim().length === 0) {
    throw new SessionConnectorContractError(connectorId, "version must be a non-empty string");
  }
  for (const method of CONNECTOR_METHODS) {
    if (typeof candidate[method] !== "function") {
      throw new SessionConnectorContractError(connectorId, `${method} must be a function`);
    }
  }
}

function assertCapabilityMatrix(
  connector: SessionConnectorV1,
  value: unknown,
): asserts value is SessionConnectorCapabilitiesV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SessionConnectorContractError(connector.id, "capability matrix must be an object");
  }
  const certification = value as Record<string, unknown>;
  if (certification.contractVersion !== 1) {
    throw new SessionConnectorContractError(
      connector.id,
      "capability contractVersion must equal 1",
    );
  }
  if (certification.connectorId !== connector.id) {
    throw new SessionConnectorContractError(
      connector.id,
      "capability connectorId does not match connector registration",
    );
  }
  if (certification.connectorVersion !== connector.version) {
    throw new SessionConnectorContractError(
      connector.id,
      "capability connectorVersion does not match connector registration",
    );
  }
  if (
    typeof certification.sourceRevision !== "string"
    || !certification.sourceRevision.trim()
  ) {
    throw new SessionConnectorContractError(connector.id, "sourceRevision is required");
  }
  if (
    parseCanonicalIsoTimestamp(certification.verifiedAt) === null
  ) {
    throw new SessionConnectorContractError(connector.id, "verifiedAt is invalid");
  }
  if (
    !certification.capabilities
    || typeof certification.capabilities !== "object"
    || Array.isArray(certification.capabilities)
  ) {
    throw new SessionConnectorContractError(connector.id, "capabilities must be an object");
  }
  const capabilities = certification.capabilities as Record<string, unknown>;
  for (const capabilityName of SESSION_CONNECTOR_CAPABILITIES) {
    const capabilityValue = capabilities[capabilityName];
    if (
      !capabilityValue
      || typeof capabilityValue !== "object"
      || Array.isArray(capabilityValue)
    ) {
      throw new SessionConnectorContractError(
        connector.id,
        `capability ${capabilityName} has no valid certification state`,
      );
    }
    const capability = capabilityValue as Record<string, unknown>;
    if (!CAPABILITY_STATES.has(capability.state as SessionConnectorCapabilityState)) {
      throw new SessionConnectorContractError(
        connector.id,
        `capability ${capabilityName} has no valid certification state`,
      );
    }
    if (
      capability.state === "verified"
      && (typeof capability.evidenceRef !== "string" || !capability.evidenceRef.trim())
    ) {
      throw new SessionConnectorContractError(
        connector.id,
        `verified capability ${capabilityName} requires an evidence reference`,
      );
    }
    if ("reason" in capability) {
      throw new SessionConnectorContractError(
        connector.id,
        `capability ${capabilityName} must use a typed reasonCode`,
      );
    }
    if (
      capability.reasonCode !== null
      && !CAPABILITY_REASON_CODES.has(capability.reasonCode as SessionConnectorCapabilityReasonCode)
    ) {
      throw new SessionConnectorContractError(
        connector.id,
        `capability ${capabilityName} has an invalid reasonCode`,
      );
    }
    if (capability.state === "verified" && capability.reasonCode !== null) {
      throw new SessionConnectorContractError(
        connector.id,
        `verified capability ${capabilityName} cannot have a reasonCode`,
      );
    }
    if (capability.state !== "verified" && capability.reasonCode === null) {
      throw new SessionConnectorContractError(
        connector.id,
        `non-verified capability ${capabilityName} requires a reasonCode`,
      );
    }
    if (
      capability.lastVerifiedAt !== null
      && parseCanonicalIsoTimestamp(capability.lastVerifiedAt) === null
    ) {
      throw new SessionConnectorContractError(
        connector.id,
        `capability ${capabilityName} has invalid lastVerifiedAt`,
      );
    }
    if (capability.state === "verified" && capability.lastVerifiedAt === null) {
      throw new SessionConnectorContractError(
        connector.id,
        `verified capability ${capabilityName} requires lastVerifiedAt`,
      );
    }
  }
}

function assertHealthContract(
  connector: SessionConnectorV1,
  value: unknown,
  expectedHostId: string,
  nowMs: number,
  maxAgeMs: number,
  maxFutureSkewMs: number,
): asserts value is SessionConnectorHealthV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SessionConnectorHealthContractError(connector.id, "health must be an object");
  }
  const health = value as Record<string, unknown>;
  if (health.connectorId !== connector.id) {
    throw new SessionConnectorHealthContractError(connector.id, "connectorId does not match");
  }
  if (health.hostId !== expectedHostId) {
    throw new SessionConnectorHealthContractError(connector.id, "hostId does not match the requested host");
  }
  if (!HEALTH_STATES.has(health.state as SessionConnectorHealthV1["state"])) {
    throw new SessionConnectorHealthContractError(connector.id, "state is invalid");
  }
  const checkedAtMs = parseCanonicalIsoTimestamp(health.checkedAt);
  if (checkedAtMs === null) {
    throw new SessionConnectorHealthContractError(connector.id, "checkedAt is invalid");
  }
  if (checkedAtMs < nowMs - maxAgeMs) {
    throw new SessionConnectorHealthContractError(connector.id, "checkedAt is stale");
  }
  if (checkedAtMs > nowMs + maxFutureSkewMs) {
    throw new SessionConnectorHealthContractError(connector.id, "checkedAt is in the future");
  }
  if (!AUTHENTICATION_STATES.has(health.authentication as SessionConnectorHealthV1["authentication"])) {
    throw new SessionConnectorHealthContractError(connector.id, "authentication state is invalid");
  }
  if (!DAEMON_STATES.has(health.daemon as SessionConnectorHealthV1["daemon"])) {
    throw new SessionConnectorHealthContractError(connector.id, "daemon state is invalid");
  }
  if (!SERVER_STATES.has(health.server as SessionConnectorHealthV1["server"])) {
    throw new SessionConnectorHealthContractError(connector.id, "server state is invalid");
  }
  if (!BACKEND_STATES.has(health.backend as SessionConnectorHealthV1["backend"])) {
    throw new SessionConnectorHealthContractError(connector.id, "backend state is invalid");
  }
  if (!RATE_LIMIT_STATES.has(health.rateLimit as SessionConnectorHealthV1["rateLimit"])) {
    throw new SessionConnectorHealthContractError(connector.id, "rate-limit state is invalid");
  }
  if (!HOST_STATES.has(health.host as SessionConnectorHealthV1["host"])) {
    throw new SessionConnectorHealthContractError(connector.id, "host state is invalid");
  }
  if (
    health.retryAfterMs !== null
    && (
      !Number.isSafeInteger(health.retryAfterMs)
      || (health.retryAfterMs as number) < 0
      || (health.retryAfterMs as number) > SESSION_CONNECTOR_HEALTH_MAX_RETRY_AFTER_MS
    )
  ) {
    throw new SessionConnectorHealthContractError(connector.id, "retryAfterMs is invalid");
  }
  const retryAfterMs = health.retryAfterMs as number | null;
  if (!health.capabilities || typeof health.capabilities !== "object" || Array.isArray(health.capabilities)) {
    throw new SessionConnectorHealthContractError(connector.id, "capabilities must be an object");
  }
  const healthCapabilities = health.capabilities as Record<string, unknown>;
  for (const capabilityName of SESSION_CONNECTOR_CAPABILITIES) {
    if (!CAPABILITY_STATES.has(healthCapabilities[capabilityName] as SessionConnectorCapabilityState)) {
      throw new SessionConnectorHealthContractError(connector.id, "capability health contains an invalid state");
    }
  }
  if (!Array.isArray(health.reasonCodes) || health.reasonCodes.length > 18) {
    throw new SessionConnectorHealthContractError(connector.id, "reasonCodes is invalid");
  }
  if (health.reasonCodes.some((reasonCode) => !HEALTH_REASON_CODES.has(reasonCode as SessionConnectorHealthReasonCode))) {
    throw new SessionConnectorHealthContractError(connector.id, "reasonCodes contains an unsupported value");
  }
  const reportsRateLimit = health.reasonCodes.includes("rate_limited");
  if (health.state === "healthy" && health.reasonCodes.length > 0) {
    throw new SessionConnectorHealthContractError(connector.id, "healthy state cannot contain failure reasonCodes");
  }
  if (health.state === "rate_limited" && health.rateLimit !== "limited") {
    throw new SessionConnectorHealthContractError(connector.id, "rate-limited state requires limited rateLimit");
  }
  if (health.rateLimit === "limited" && !reportsRateLimit) {
    throw new SessionConnectorHealthContractError(connector.id, "limited rateLimit requires rate_limited reasonCode");
  }
  if (reportsRateLimit && health.rateLimit !== "limited") {
    throw new SessionConnectorHealthContractError(connector.id, "rate_limited reasonCode requires limited rateLimit");
  }
  if (
    health.rateLimit === "limited"
    && (retryAfterMs === null || retryAfterMs <= 0)
  ) {
    throw new SessionConnectorHealthContractError(connector.id, "limited rateLimit requires positive retryAfterMs");
  }
}

/*
 * FNXC:SessionConnectorIdentityBoundCapability 2026-07-20-21:08:
 * requireVerified() already validates the requested capability against the
 * exact bound Session identity. getHealth(hostId) intentionally has no Session
 * identity, so its capability matrix is host-level diagnostics and cannot
 * overrule a freshly verified identity-bound mutation path. Health still gates
 * authentication, daemon, server, backend, rate limit, host reachability, and
 * explicit degradation before every mutable operation.
 */
function isMutationHealthReady(health: SessionConnectorHealthV1): boolean {
  return health.state === "healthy"
    && health.authentication === "authenticated"
    && (health.daemon === "running" || health.daemon === "not_applicable")
    && (health.server === "reachable" || health.server === "not_applicable")
    && (health.backend === "ready" || health.backend === "not_applicable")
    && health.rateLimit === "clear"
    && health.host === "reachable"
    && health.reasonCodes.length === 0;
}

/*
 * FNXC:ExistingSessionUnknownQuota 2026-07-25-19:02:
 * The Room spine invokes this only before ensureExisting and still rejects an
 * explicit rate limit. Some official MCPs cannot report quota for a read-only
 * identity attachment; treating unknown as a clear quota would be false, while
 * refusing attachment makes a no-provider-turn path impossible. Never reuse
 * this predicate for send/control/create operations.
 */
function isReadOnlyAttachmentHealthReady(health: SessionConnectorHealthV1): boolean {
  return health.state === "healthy"
    && health.authentication === "authenticated"
    && (health.daemon === "running" || health.daemon === "not_applicable")
    && (health.server === "reachable" || health.server === "not_applicable")
    && (health.backend === "ready" || health.backend === "not_applicable")
    && (health.rateLimit === "clear" || health.rateLimit === "unknown")
    && health.host === "reachable"
    && health.reasonCodes.length === 0;
}

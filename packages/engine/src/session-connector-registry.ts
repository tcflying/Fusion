import {
  SESSION_CONNECTOR_CAPABILITIES,
  type SessionConnectorCapabilitiesV1,
  type SessionConnectorCapabilityName,
  type SessionConnectorCapabilityState,
  type SessionConnectorIdentityV1,
  type SessionConnectorV1,
} from "@fusion/core";

export type SessionConnectorRegistryErrorCode =
  | "SESSION_CONNECTOR_DUPLICATE"
  | "SESSION_CONNECTOR_UNKNOWN"
  | "SESSION_CONNECTOR_CONTRACT_CONFLICT"
  | "SESSION_CONNECTOR_IDENTITY_CONFLICT"
  | "SESSION_CONNECTOR_HOST_AFFINITY"
  | "SESSION_CONNECTOR_CAPABILITY_NOT_VERIFIED";

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
    readonly reason: string | null,
  ) {
    super(
      "SESSION_CONNECTOR_CAPABILITY_NOT_VERIFIED",
      `Session Connector ${connectorId} capability ${capability} is ${state}${reason ? `: ${reason}` : ""}`,
    );
    this.name = "SessionConnectorCapabilityNotVerifiedError";
  }
}

export interface RequireVerifiedSessionConnectorInput {
  readonly connectorId: string;
  readonly capability: SessionConnectorCapabilityName;
  readonly identity?: SessionConnectorIdentityV1;
  readonly requiredHostId?: string;
}

const CAPABILITY_STATES = new Set<SessionConnectorCapabilityState>([
  "verified",
  "degraded",
  "unavailable",
  "unverified",
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

    const certification: unknown = await connector.getCapabilities(input.identity);
    assertCapabilityMatrix(connector, certification);
    const capability = certification.capabilities[input.capability];
    if (capability.state !== "verified") {
      throw new SessionConnectorCapabilityNotVerifiedError(
        connector.id,
        input.capability,
        capability.state,
        capability.reason ?? null,
      );
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
      `capability connectorId ${String(certification.connectorId)} does not match`,
    );
  }
  if (certification.connectorVersion !== connector.version) {
    throw new SessionConnectorContractError(
      connector.id,
      `capability connectorVersion ${String(certification.connectorVersion)} does not match ${connector.version}`,
    );
  }
  if (
    typeof certification.sourceRevision !== "string"
    || !certification.sourceRevision.trim()
  ) {
    throw new SessionConnectorContractError(connector.id, "sourceRevision is required");
  }
  if (
    typeof certification.verifiedAt !== "string"
    || !Number.isFinite(Date.parse(certification.verifiedAt))
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
  }
}

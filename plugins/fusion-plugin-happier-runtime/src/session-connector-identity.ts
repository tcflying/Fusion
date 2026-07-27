import {
  hashRoomValue,
  type SessionConnectorDeliveryAuthorizationV1,
  type SessionConnectorIdentityV1,
  type SessionConnectorResultV1,
} from "@fusion/core";

import {
  parseHappierCanonicalSessionUri,
  type HappierBoundIdentity,
  type HappierCanonicalSession,
  type HappierPersistedBinding,
} from "./binding-identity.js";
import { HAPPIER_LOCAL_DIRECT_SESSION_EXTENSION_STATE } from "./happier-direct-session-capabilities.js";
import { HAPPIER_SESSION_CONNECTOR_ID } from "./session-connector-contract.js";
import {
  happierConnectorFailure,
  isHappierJsonRecord,
  nonEmptyHappierString,
} from "./session-connector-transport.js";
import type { HappierBackend } from "./types.js";

const HAPPIER_BINDING_REQUIRED = "happier_session_binding_required";
const HAPPIER_HOST_WRITE_AUTHORIZATION_REQUIRED =
  "happier_host_write_authorization_required";
const HAPPIER_WRITE_SCOPE_PREFIX =
  `${HAPPIER_SESSION_CONNECTOR_ID}-write-scope:`;

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
  readonly deliveryAuthorization:
    | SessionConnectorDeliveryAuthorizationV1
    | null;
}

export type HappierHostWriteAuthorizationDecision =
  | Readonly<{
    authorized: true;
    authorizationId: string;
    scopeFingerprint: string;
  }>
  | Readonly<{ authorized: false }>;

/** @internal Only the plugin factory may bind this to an Engine-owned authorizer. */
export type HappierPluginWriteAuthorization = (
  request: HappierHostWriteAuthorizationRequest,
) => Promise<HappierHostWriteAuthorizationDecision>;

export type HappierHostWriteAuthorizationInput = Readonly<{
  operation: "send" | "interrupt";
  bindingId: string | null;
  logicalMessageId: string | null;
  localMessageId: string | null;
  idempotencyKey: string;
  contentHash?: string;
  reason: string | null;
  deliveryAuthorization: SessionConnectorDeliveryAuthorizationV1 | null;
}>;

type HappierHostWriteAuthorizationScope = Readonly<{
  canonicalSessionUri: string;
  providerId: HappierBackend;
  nativeSessionId: string;
  happierSessionId: string;
  serverProfileId: string;
  machineId: string;
  hostId: string;
  bindingId: string | null;
  operation: "send" | "interrupt";
  logicalMessageId: string | null;
  localMessageId: string | null;
  idempotencyKey: string;
  contentHash: string | null;
  reason: string | null;
  outboxId: string | null;
  senderFence: SessionConnectorDeliveryAuthorizationV1["senderFence"] | null;
  scopeFingerprint: string;
}>;

/*
 * FNXC:HappierDurableWriteAuthority 2026-07-20-21:30:
 * An arbitrary connector constructor dependency must never turn into an
 * official MCP write permit. The base connector is read-only by default; only
 * the runtime plugin factory can bind an Engine-owned durable authorizer.
 */
const pluginWriteAuthorizers =
  new WeakMap<object, HappierPluginWriteAuthorization>();

export function bindHappierHostWriteAuthorization(
  owner: object,
  verifier: HappierPluginWriteAuthorization,
): void {
  pluginWriteAuthorizers.set(owner, verifier);
}

export function hasHappierHostWriteAuthorization(owner: object): boolean {
  return pluginWriteAuthorizers.has(owner);
}

export function isDurableHappierDeliveryAuthorization(
  value: unknown,
): value is SessionConnectorDeliveryAuthorizationV1 {
  if (
    !isHappierJsonRecord(value)
    || !nonEmptyHappierString(value.outboxId)
    || !isHappierJsonRecord(value.senderFence)
  ) {
    return false;
  }
  const fence = value.senderFence;
  const expectedEpoch = fence.expectedEpoch;
  return Boolean(
    nonEmptyHappierString(fence.leaseId)
    && nonEmptyHappierString(fence.roomId)
    && fence.kind === "sender"
    && nonEmptyHappierString(fence.resourceId)
    && nonEmptyHappierString(fence.holderId)
    && nonEmptyHappierString(fence.hostId)
    && typeof expectedEpoch === "number"
    && Number.isSafeInteger(expectedEpoch)
    && expectedEpoch > 0,
  );
}

function hostWriteAuthorizationScope(
  target: HappierBoundIdentity,
  identity: SessionConnectorIdentityV1,
  input: HappierHostWriteAuthorizationInput,
): HappierHostWriteAuthorizationScope | null {
  const hostId = nonEmptyHappierString(identity.hostId, 512);
  const idempotencyKey = nonEmptyHappierString(input.idempotencyKey, 512);
  if (!hostId || !idempotencyKey) return null;

  /*
   * FNXC:HappierInterruptWriteScope 2026-07-27-03:14:
   * A stop has no Room outbox payload in the v1 control contract, so it cannot
   * borrow a send fence. It still requires an Engine-owned authorization bound
   * to the complete immutable Session identity, control idempotency key, and
   * reason. A send-only authorizer must deny this shape.
   */
  if (input.operation === "interrupt") {
    const reason = nonEmptyHappierString(input.reason, 2_000);
    if (
      !reason
      || input.bindingId !== null
      || input.logicalMessageId !== null
      || input.localMessageId !== null
      || input.contentHash !== undefined
      || input.deliveryAuthorization !== null
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
      bindingId: null,
      operation: input.operation,
      logicalMessageId: null,
      localMessageId: null,
      idempotencyKey,
      contentHash: null,
      reason,
      outboxId: null,
      senderFence: null,
    } as const;
    return Object.freeze({
      ...scope,
      scopeFingerprint: `${HAPPIER_WRITE_SCOPE_PREFIX}${hashRoomValue(scope)}`,
    });
  }

  const bindingId = nonEmptyHappierString(input.bindingId, 512);
  const authorization = input.deliveryAuthorization;
  if (
    !bindingId
    || !isDurableHappierDeliveryAuthorization(authorization)
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
    idempotencyKey,
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

export function happierBindingRequired<T>(
  operation: string,
): SessionConnectorResultV1<T> {
  return happierConnectorFailure(
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

export function happierHostWriteAuthorizationRequired<T>():
  SessionConnectorResultV1<T> {
  return happierConnectorFailure(
    "unavailable",
    "A host/runtime-issued Happier write authorization is required before Fusion can mutate this session.",
    false,
    {
      bindingState: HAPPIER_HOST_WRITE_AUTHORIZATION_REQUIRED,
      bridge: "official_mcp_stdio",
    },
  );
}

export class HappierSessionIdentityResolver {
  constructor(
    private readonly connectorId: string,
    private readonly activeServerId: string | undefined,
    private readonly bindings: readonly HappierPersistedBinding[],
  ) {}

  persistedBindings(): readonly HappierPersistedBinding[] {
    return this.bindings;
  }

  bindingForCanonicalSession(
    canonical: HappierCanonicalSession,
  ): HappierPersistedBinding | null {
    const matches = this.bindings.filter(
      (binding) =>
        binding.canonicalSessionUri === canonical.canonicalSessionUri,
    );
    return matches.length === 1 ? matches[0]! : null;
  }

  bindingForIdentity(
    identity: SessionConnectorIdentityV1,
  ): HappierPersistedBinding | null {
    const canonical = parseHappierCanonicalSessionUri(
      `${
        identity.providerId === "codex"
          ? "codex://threads"
          : identity.providerId === "claude"
            ? "claude://sessions"
            : identity.providerId === "opencode"
              ? "opencode://sessions"
              : "invalid://invalid"
      }/${encodeURIComponent(identity.nativeSessionId)}`,
    );
    if (
      !canonical
      || !identity.happierSessionId
      || !identity.serverProfileId
      || !identity.machineId
    ) {
      return null;
    }
    const matches = this.bindings.filter(
      (binding) =>
        binding.canonicalSessionUri === canonical.canonicalSessionUri
        && binding.happierSessionId === identity.happierSessionId
        && binding.serverProfileId === identity.serverProfileId
        && binding.machineId === identity.machineId,
    );
    return matches.length === 1 ? matches[0]! : null;
  }

  identityForBinding(
    binding: HappierPersistedBinding,
    hostId: string,
  ): SessionConnectorIdentityV1 {
    return {
      connectorId: this.connectorId,
      providerId: binding.providerId,
      nativeSessionId: binding.nativeSessionId,
      happierSessionId: binding.happierSessionId,
      serverProfileId: binding.serverProfileId,
      machineId: binding.machineId,
      hostId,
    };
  }

  validateBoundIdentity(
    identity: SessionConnectorIdentityV1,
    operation: string,
  ): SessionConnectorResultV1<HappierBoundIdentity> {
    if (identity.connectorId !== this.connectorId) {
      return happierConnectorFailure(
        "conflict",
        "Session identity belongs to a different connector",
        false,
      );
    }
    if (
      identity.providerId !== "codex"
      && identity.providerId !== "claude"
      && identity.providerId !== "opencode"
    ) {
      return happierConnectorFailure(
        "invalid_request",
        "The persisted native Session provider is unsupported",
        false,
      );
    }
    const nativeSessionId = nonEmptyHappierString(
      identity.nativeSessionId,
      512,
    );
    const happierSessionId = nonEmptyHappierString(
      identity.happierSessionId,
      512,
    );
    const serverProfileId = nonEmptyHappierString(
      identity.serverProfileId,
      512,
    );
    const machineId = nonEmptyHappierString(identity.machineId, 512);
    if (
      !nativeSessionId
      || !happierSessionId
      || !serverProfileId
      || !machineId
    ) {
      return happierBindingRequired(operation);
    }
    const binding = this.bindingForIdentity(identity);
    if (!binding) return happierBindingRequired(operation);
    if (!this.activeServerId?.trim()) {
      return happierConnectorFailure(
        "degraded",
        "The Happier active server profile is not pinned",
        false,
      );
    }
    if (binding.serverProfileId !== this.activeServerId) {
      return happierConnectorFailure(
        "conflict",
        "The Happier server profile does not match the immutable Session binding",
        false,
      );
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

/*
 * FNXC:HappierHostWriteAuthorization 2026-07-20-02:55:
 * Official Happier MCP exposes no proof that a Direct UI takeover occurred.
 * The hosting runtime must verify a grant bound to the exact connector,
 * session, operation, idempotency payload, and durable Room fence.
 */
export async function authorizeHappierHostWrite(
  owner: object,
  connectorId: string,
  target: HappierBoundIdentity,
  identity: SessionConnectorIdentityV1,
  input: HappierHostWriteAuthorizationInput,
): Promise<SessionConnectorResultV1<Readonly<{ authorizationId: string }>>> {
  const verifier = pluginWriteAuthorizers.get(owner);
  if (!verifier) return happierHostWriteAuthorizationRequired();
  const scope = hostWriteAuthorizationScope(target, identity, input);
  if (!scope) return happierHostWriteAuthorizationRequired();
  try {
    const decision = await verifier({
      connectorId,
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
      ? nonEmptyHappierString(decision.authorizationId, 512)
      : undefined;
    const decisionScopeFingerprint = decision.authorized === true
      ? nonEmptyHappierString(decision.scopeFingerprint, 512)
      : undefined;
    if (
      !authorizationId
      || decisionScopeFingerprint !== scope.scopeFingerprint
    ) {
      return happierHostWriteAuthorizationRequired();
    }
    return { ok: true, value: { authorizationId } };
  } catch {
    return happierHostWriteAuthorizationRequired();
  }
}

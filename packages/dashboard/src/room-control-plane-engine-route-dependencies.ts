import type { Request } from "express";
import {
  ROOM_AUTHORITY_CONTRACT_BOUNDS,
  type RoomAuthorityEnvelopeV1,
  type RoomMessageIntent,
} from "@fusion/core";
import type { ProjectEngine } from "@fusion/engine";
import { ApiError } from "./api-error.js";
import type {
  RoomControlPlaneAuthorizationInput,
  RoomControlPlaneAuthorizationDecision,
  RoomControlPlaneExecutionStatusV1,
  RoomControlPlaneEvolutionShadowCommandResultV1,
  RoomControlPlaneEvolutionShadowInputV1,
  RoomControlPlaneEvolutionShadowResultV1,
  RoomControlPlaneExistingSessionPreflightInputV1,
  RoomControlPlaneLiveEventPortV1,
  RoomControlPlaneLiveEventReconnectInputV1,
  RoomControlPlaneLiveEventReconnectResultV1,
  RoomControlPlaneLiveEventScopeV1,
  RoomControlPlaneLiveEventSubscriptionInputV1,
  RoomControlPlaneLiveEventSubscriptionV1,
  RoomControlPlaneListRoomsInputV1,
  RoomControlPlaneMutationInputV1,
  RoomControlPlaneMutationResultV1,
  RoomControlPlanePageV1,
  RoomControlPlaneResourceReadInputV1,
  RoomControlPlaneRoomProjectionInputV1,
  RoomControlPlaneRouteDependencies,
  RoomControlPlaneRoutePort,
} from "./routes/register-room-control-plane-routes.js";
import type { ProjectContext } from "./routes/types.js";

export type RoomControlPlaneProjectEngine = Pick<
  ProjectEngine,
  "getProjectId"
  | "getRoomControlPlaneReadService"
  | "getRoomControlPlaneLiveEventService"
  | "executeProjectRoomCommand"
> & Partial<Pick<ProjectEngine, "getRoomControlPlaneExecutionStatus">>;

type RoomControlPlaneReadService = NonNullable<
  ReturnType<RoomControlPlaneProjectEngine["getRoomControlPlaneReadService"]>
>;
type RoomControlPlaneLiveEventService = NonNullable<
  ReturnType<RoomControlPlaneProjectEngine["getRoomControlPlaneLiveEventService"]>
>;
type RoomControlPlaneOperatorMessageCommand = Extract<
  Parameters<RoomControlPlaneProjectEngine["executeProjectRoomCommand"]>[0],
  { readonly type: "room.send-to-seat.v1" }
>;
type RoomControlPlaneEvolutionShadowCommand = Extract<
  Parameters<RoomControlPlaneProjectEngine["executeProjectRoomCommand"]>[0],
  { readonly type: "room.record-evolution-shadow.v1" }
>;
type RoomControlPlaneExistingSessionPreflightCommand = Extract<
  Parameters<RoomControlPlaneProjectEngine["executeProjectRoomCommand"]>[0],
  { readonly type: "room.preflight-existing-session.v1" }
>;
type CanonicalExistingSessionPreflightEnvelope = Readonly<{
  readonly commandId: string;
  readonly result: unknown;
}>;
type RoomControlPlaneTrustedPrincipal = Parameters<
  RoomControlPlaneProjectEngine["executeProjectRoomCommand"]
>[1];

export interface RoomControlPlaneEngineResolverInput {
  readonly request: Request;
  readonly projectId: string;
  readonly store: ProjectContext["store"];
  readonly actorId: string;
}

export type RoomControlPlaneEngineResolver = (
  input: RoomControlPlaneEngineResolverInput,
) => RoomControlPlaneProjectEngine | null | undefined | Promise<RoomControlPlaneProjectEngine | null | undefined>;

export interface RoomControlPlaneEngineRouteDependenciesOptions {
  readonly authorizeProject: (
    input: RoomControlPlaneAuthorizationInput,
  ) => Promise<RoomControlPlaneAuthorizationDecision>;
  readonly resolveProjectEngine: RoomControlPlaneEngineResolver;
}

type ReadServiceLike = Pick<RoomControlPlaneReadService, "listRooms" | "getRoomProjection">;
type LiveEventServiceLike = Pick<RoomControlPlaneLiveEventService, "reconnect" | "subscribe" | "subscribeTermination">;
const ROOM_MESSAGE_INTENTS = [
  "instruction",
  "proposal",
  "question",
  "critique",
  "challenge",
  "verdict",
  "handoff",
  "help_request",
] as const satisfies readonly RoomMessageIntent[];
const OPERATOR_MESSAGE_PAYLOAD_KEYS = ["seatId", "intent", "content", "authorityEnvelope"] as const;
const EVOLUTION_SHADOW_PAYLOAD_KEYS = ["contractVersion", "hypothesisId", "candidateVersionId"] as const;
const EVOLUTION_SHADOW_WITHHELD_REASONS = new Set<Extract<
  RoomControlPlaneEvolutionShadowResultV1,
  { readonly status: "withheld" }
>["reason"]>([
  "unsupported_contract_version",
  "dashboard_operator_required",
  "project_scope_invalid",
  "existing_durable_references_required_no_safe_read_api",
  "evolution_ledger_unavailable",
  "durable_receipt_rejected",
  "durable_receipt_invalid",
]);

function isNonEmptyIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256;
}

function isProjectEngine(value: unknown): value is RoomControlPlaneProjectEngine {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    getProjectId?: unknown;
    getRoomControlPlaneReadService?: unknown;
    getRoomControlPlaneLiveEventService?: unknown;
    executeProjectRoomCommand?: unknown;
  };
  return typeof candidate.getProjectId === "function"
    && typeof candidate.getRoomControlPlaneReadService === "function"
    && typeof candidate.getRoomControlPlaneLiveEventService === "function"
    && typeof candidate.executeProjectRoomCommand === "function";
}

function isReadService(value: unknown): value is ReadServiceLike {
  if (!value || typeof value !== "object") return false;
  const candidate = value as {
    listRooms?: unknown;
    getRoomProjection?: unknown;
  };
  return typeof candidate.listRooms === "function"
    && typeof candidate.getRoomProjection === "function";
}

function isLiveEventService(value: unknown): value is LiveEventServiceLike {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { reconnect?: unknown; subscribe?: unknown; subscribeTermination?: unknown };
  return typeof candidate.reconnect === "function"
    && typeof candidate.subscribe === "function"
    && typeof candidate.subscribeTermination === "function";
}

function unavailable(code: string, message: string, projectId: string): ApiError {
  return new ApiError(503, message, { code, projectId });
}

const RETRYABLE_LIVE_EVENT_CAPACITY_CODES = new Set([
  "room_control_plane_live_event_subscription_limit_reached",
  "room_control_plane_live_event_scope_subscription_limit_reached",
  "room_control_plane_live_event_actor_subscription_limit_reached",
  "room_control_plane_live_event_termination_listener_limit_reached",
  "room_control_plane_live_event_scope_termination_listener_limit_reached",
]);

function liveEventCapacityExceeded(error: unknown, projectId: string): ApiError | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { readonly code?: unknown; readonly retryAfterMs?: unknown };
  if (
    typeof candidate.code !== "string"
    || !RETRYABLE_LIVE_EVENT_CAPACITY_CODES.has(candidate.code)
    || typeof candidate.retryAfterMs !== "number"
    || !Number.isSafeInteger(candidate.retryAfterMs)
    || candidate.retryAfterMs <= 0
  ) return null;
  return new ApiError(429, "Room live event capacity is temporarily full. Retry shortly.", {
    code: "ROOM_CONTROL_PLANE_LIVE_EVENT_SUBSCRIPTION_LIMITED",
    projectId,
    retryAfter: Math.max(1, Math.ceil(candidate.retryAfterMs / 1_000)),
    retryable: true,
    capacityCode: candidate.code,
  });
}

function assertPortProject(projectId: string, expectedProjectId: string): void {
  if (!isNonEmptyIdentifier(projectId) || projectId !== expectedProjectId) {
    throw new ApiError(403, "Room control-plane route port cannot cross project scope", {
      code: "ROOM_CONTROL_PLANE_PORT_PROJECT_SCOPE_MISMATCH",
      projectId,
    });
  }
}

function assertLiveEventScope(
  input: RoomControlPlaneLiveEventScopeV1,
  expectedProjectId: string,
): void {
  assertPortProject(input.projectId, expectedProjectId);
  if (!isNonEmptyIdentifier(input.roomId)) {
    throw new ApiError(400, "Room live event delivery requires a bounded Room identifier.", {
      code: "ROOM_EVENT_PORT_ROOM_SCOPE_INVALID",
    });
  }
}

function assertLiveEventSubscription(
  input: RoomControlPlaneLiveEventSubscriptionInputV1,
  expectedProjectId: string,
): void {
  assertLiveEventScope(input, expectedProjectId);
  if (!isNonEmptyIdentifier(input.actorId)) {
    throw new ApiError(503, "Room live event subscription actor boundary is invalid.", {
      code: "ROOM_EVENT_PORT_ACTOR_INVALID",
    });
  }
}

function assertEngineProject(engine: RoomControlPlaneProjectEngine, projectId: string): void {
  let engineProjectId: string;
  try {
    engineProjectId = engine.getProjectId();
  } catch (_error) {
    throw unavailable(
      "ROOM_PROJECT_ENGINE_UNAVAILABLE",
      "The project Engine is unavailable for Room live events.",
      projectId,
    );
  }
  if (!isNonEmptyIdentifier(engineProjectId) || engineProjectId !== projectId) {
    throw unavailable(
      "ROOM_ENGINE_PROJECT_MISMATCH",
      "The resolved Engine does not belong to the requested project.",
      projectId,
    );
  }
}

function resolveLiveEventService(
  engine: RoomControlPlaneProjectEngine,
  projectId: string,
): LiveEventServiceLike {
  assertEngineProject(engine, projectId);
  let service: unknown;
  try {
    service = engine.getRoomControlPlaneLiveEventService();
  } catch (_error) {
    throw unavailable(
      "ROOM_CONTROL_PLANE_LIVE_EVENT_SERVICE_UNAVAILABLE",
      "The project Room live event service is unavailable.",
      projectId,
    );
  }
  if (service === null || service === undefined) {
    throw unavailable(
      "ROOM_CONTROL_PLANE_LIVE_EVENT_SERVICE_UNAVAILABLE",
      "The project Room live event service is unavailable or disabled.",
      projectId,
    );
  }
  if (!isLiveEventService(service)) {
    throw unavailable(
      "ROOM_CONTROL_PLANE_LIVE_EVENT_SERVICE_INVALID",
      "The project Room live event service does not expose canonical cursor and lifecycle boundaries.",
      projectId,
    );
  }
  return service;
}

function createLiveEventPort(
  projectId: string,
  service: LiveEventServiceLike,
): RoomControlPlaneLiveEventPortV1 {
  return {
    async reconnect(input: RoomControlPlaneLiveEventReconnectInputV1): Promise<RoomControlPlaneLiveEventReconnectResultV1> {
      assertLiveEventScope(input, projectId);
      let result: unknown;
      try {
        result = await service.reconnect({
          projectId: input.projectId,
          roomId: input.roomId,
          afterCursor: input.afterCursor,
          limit: input.limit,
        });
      } catch (_error) {
        throw unavailable(
          "ROOM_CONTROL_PLANE_LIVE_EVENT_RECONNECT_UNAVAILABLE",
          "The project Room canonical event replay is unavailable.",
          projectId,
        );
      }
      return result as RoomControlPlaneLiveEventReconnectResultV1;
    },
    subscribe(input, listener): RoomControlPlaneLiveEventSubscriptionV1 {
      assertLiveEventSubscription(input, projectId);
      if (typeof listener !== "function") {
        throw new ApiError(503, "Room live event listener boundary is invalid.", {
          code: "ROOM_EVENT_PORT_LISTENER_INVALID",
        });
      }
      let subscription: unknown;
      try {
        subscription = service.subscribe(
          {
            projectId: input.projectId,
            roomId: input.roomId,
            actorId: input.actorId,
            holdUntilReplayWatermark: input.holdUntilReplayWatermark,
            afterCursor: input.afterCursor ?? null,
          },
          (notification) => listener(notification as never),
        );
      } catch (error) {
        const capacityError = liveEventCapacityExceeded(error, projectId);
        if (capacityError !== null) throw capacityError;
        throw unavailable(
          "ROOM_CONTROL_PLANE_LIVE_EVENT_SUBSCRIBE_UNAVAILABLE",
          "The project Room live event subscription is unavailable.",
          projectId,
        );
      }
      if (typeof subscription !== "function") {
        throw unavailable(
          "ROOM_CONTROL_PLANE_LIVE_EVENT_SUBSCRIBE_INVALID",
          "The project Room live event subscription is unavailable.",
          projectId,
        );
      }
      if (typeof (subscription as { readonly activate?: unknown }).activate !== "function") {
        /*
        FNXC:RoomLiveSubscription 2026-07-19-19:45:
        The replay-watermark handshake is required to preserve events arriving
        between subscription and canonical replay. Lifecycle health is carried
        separately by `subscribeTermination`, never by a synthetic heartbeat.
        */
        throw unavailable(
          "ROOM_CONTROL_PLANE_LIVE_EVENT_SUBSCRIBE_INVALID",
          "The project Room live event subscription cannot preserve the replay watermark.",
          projectId,
        );
      }
      return subscription as RoomControlPlaneLiveEventSubscriptionV1;
    },
    subscribeTermination(input, listener): () => void {
      assertLiveEventScope(input, projectId);
      if (typeof listener !== "function") {
        throw new ApiError(503, "Room live event termination listener boundary is invalid.", {
          code: "ROOM_EVENT_PORT_TERMINATION_LISTENER_INVALID",
        });
      }
      let unsubscribe: unknown;
      try {
        unsubscribe = service.subscribeTermination(
          { projectId: input.projectId, roomId: input.roomId },
          (signal) => listener(signal as never),
        );
      } catch (error) {
        const capacityError = liveEventCapacityExceeded(error, projectId);
        if (capacityError !== null) throw capacityError;
        throw unavailable(
          "ROOM_CONTROL_PLANE_LIVE_EVENT_TERMINATION_UNAVAILABLE",
          "The project Room live event termination delivery is unavailable.",
          projectId,
        );
      }
      if (typeof unsubscribe !== "function") {
        throw unavailable(
          "ROOM_CONTROL_PLANE_LIVE_EVENT_TERMINATION_INVALID",
          "The project Room live event termination delivery is unavailable.",
          projectId,
        );
      }
      return unsubscribe as () => void;
    },
  };
}

async function resolveProjectEngine(
  resolver: RoomControlPlaneEngineResolver,
  input: RoomControlPlaneEngineResolverInput,
): Promise<RoomControlPlaneProjectEngine> {
  let candidate: RoomControlPlaneProjectEngine | null | undefined;
  try {
    candidate = await resolver(input);
  } catch (_error) {
    throw unavailable(
      "ROOM_PROJECT_ENGINE_UNAVAILABLE",
      "The project Engine is unavailable for Room control-plane reads.",
      input.projectId,
    );
  }

  if (!candidate) {
    throw unavailable(
      "ROOM_PROJECT_ENGINE_UNAVAILABLE",
      "The project Engine is unavailable for Room control-plane reads.",
      input.projectId,
    );
  }
  if (!isProjectEngine(candidate)) {
    throw unavailable(
      "ROOM_PROJECT_ENGINE_INVALID",
      "The resolved project Engine does not expose the required Room control-plane boundary.",
      input.projectId,
    );
  }

  let engineProjectId: string;
  try {
    engineProjectId = candidate.getProjectId();
  } catch (_error) {
    throw unavailable(
      "ROOM_PROJECT_ENGINE_UNAVAILABLE",
      "The project Engine is unavailable for Room control-plane reads.",
      input.projectId,
    );
  }
  if (!isNonEmptyIdentifier(engineProjectId) || engineProjectId !== input.projectId) {
    throw unavailable(
      "ROOM_ENGINE_PROJECT_MISMATCH",
      "The resolved Engine does not belong to the requested project.",
      input.projectId,
    );
  }

  return candidate;
}

function resolveReadService(
  engine: RoomControlPlaneProjectEngine,
  projectId: string,
): ReadServiceLike {
  assertEngineProject(engine, projectId);
  let service: unknown;
  try {
    service = engine.getRoomControlPlaneReadService();
  } catch (_error) {
    throw unavailable(
      "ROOM_CONTROL_PLANE_READ_SERVICE_UNAVAILABLE",
      "The project Room control-plane read service is unavailable.",
      projectId,
    );
  }
  if (service === null || service === undefined) {
    throw unavailable(
      "ROOM_CONTROL_PLANE_READ_SERVICE_UNAVAILABLE",
      "The project Room control-plane read service is unavailable or disabled.",
      projectId,
    );
  }
  if (!isReadService(service)) {
    throw unavailable(
      "ROOM_CONTROL_PLANE_READ_SERVICE_INVALID",
      "The project Room control-plane read service does not expose canonical read operations.",
      projectId,
    );
  }
  return service;
}

function unsupportedResourceRead(input: RoomControlPlaneResourceReadInputV1): never {
  throw new ApiError(501, "This Room resource is not available from the Engine read service.", {
    code: "ROOM_CONTROL_PLANE_RESOURCE_READ_UNSUPPORTED",
    projectId: input.projectId,
    roomId: input.roomId,
    resource: input.resource,
  });
}

function unsupportedMutation(input: RoomControlPlaneMutationInputV1): never {
  throw new ApiError(501, "Room control-plane mutations are not available from the Engine read service.", {
    code: "ROOM_CONTROL_PLANE_MUTATION_UNSUPPORTED",
    projectId: input.projectId,
    roomId: input.roomId,
    resource: input.resource,
    operation: input.operation,
    action: input.action,
  });
}

function invalidOperatorMessageMutation(input: RoomControlPlaneMutationInputV1, message: string): never {
  throw new ApiError(400, message, {
    code: "ROOM_CONTROL_PLANE_OPERATOR_ACTION_INVALID",
    projectId: input.projectId,
    roomId: input.roomId,
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactOperatorMessagePayloadKeys(value: Readonly<Record<string, unknown>>): boolean {
  const keys = Object.keys(value);
  return keys.length === OPERATOR_MESSAGE_PAYLOAD_KEYS.length
    && OPERATOR_MESSAGE_PAYLOAD_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isRoomMessageIntent(value: unknown): value is RoomMessageIntent {
  return typeof value === "string" && (ROOM_MESSAGE_INTENTS as readonly string[]).includes(value);
}

function isBoundedOperatorMessageContent(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= ROOM_AUTHORITY_CONTRACT_BOUNDS.maxContentLength;
}

/*
FNXC:RoomControlPlaneEngineRoute 2026-07-19-17:20:
Dashboard exposes exactly one Room write: a project-scoped operator send to one seat.
The route-derived room, command, and actor identities are authoritative; payloads cannot
replace them or provide idempotency/correlation values. Keep the authority envelope opaque
and unchanged so Core/Engine remain its sole validator, signer, and scope enforcer.
Success is acknowledged only from the Engine's canonical event aggregateVersion.
*/
function createOperatorMessageCommand(input: RoomControlPlaneMutationInputV1): RoomControlPlaneOperatorMessageCommand {
  if (!isNonEmptyIdentifier(input.roomId)) {
    return invalidOperatorMessageMutation(input, "Room operator actions require a non-empty routed roomId.");
  }
  if (!isNonEmptyIdentifier(input.commandId)) {
    return invalidOperatorMessageMutation(input, "Room operator actions require a non-empty routed commandId.");
  }
  if (!isNonEmptyIdentifier(input.actorId)) {
    return invalidOperatorMessageMutation(input, "Room operator actions require an authorized operator identity.");
  }
  if (!isRecord(input.payload) || !hasExactOperatorMessagePayloadKeys(input.payload)) {
    return invalidOperatorMessageMutation(
      input,
      "Room operator message payloads may contain only seatId, intent, content, and authorityEnvelope.",
    );
  }

  const { seatId, intent, content, authorityEnvelope } = input.payload;
  if (!isNonEmptyIdentifier(seatId) || !isRoomMessageIntent(intent) || !isBoundedOperatorMessageContent(content)) {
    return invalidOperatorMessageMutation(input, "Room operator message payload is invalid.");
  }
  if (!isRecord(authorityEnvelope)) {
    return invalidOperatorMessageMutation(input, "Room operator messages require an authorityEnvelope object.");
  }

  return {
    type: "room.send-to-seat.v1",
    projectId: input.projectId,
    commandId: input.commandId,
    input: {
      roomId: input.roomId,
      seatId,
      expectedAggregateVersion: input.expectedAggregateVersion,
      commandId: input.commandId,
      idempotencyKey: input.commandId,
      correlationId: input.commandId,
      intent,
      content,
      authorityEnvelope: authorityEnvelope as unknown as RoomAuthorityEnvelopeV1,
    },
  };
}

function hasExactPayloadKeys(value: Readonly<Record<string, unknown>>, expectedKeys: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isEvolutionShadowIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isCanonicalEvolutionShadowTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function invalidEvolutionShadowMutation(input: RoomControlPlaneEvolutionShadowInputV1, message: string): never {
  throw new ApiError(400, message, {
    code: "ROOM_EVOLUTION_SHADOW_ACTION_INVALID",
    projectId: input.projectId,
    roomId: input.roomId,
  });
}

function createEvolutionShadowCommand(
  input: RoomControlPlaneEvolutionShadowInputV1,
): RoomControlPlaneEvolutionShadowCommand {
  if (!isEvolutionShadowIdentifier(input.roomId)) {
    return invalidEvolutionShadowMutation(input, "Room Evolution Shadow requires a bounded routed roomId.");
  }
  if (!isEvolutionShadowIdentifier(input.commandId)) {
    return invalidEvolutionShadowMutation(input, "Room Evolution Shadow requires a gateway-owned bounded commandId.");
  }
  if (!isNonEmptyIdentifier(input.actorId)) {
    return invalidEvolutionShadowMutation(input, "Room Evolution Shadow requires an authorized Dashboard operator identity.");
  }
  if (!isRecord(input.payload) || !hasExactPayloadKeys(input.payload, EVOLUTION_SHADOW_PAYLOAD_KEYS)) {
    return invalidEvolutionShadowMutation(
      input,
      "Room Evolution Shadow payloads may contain only contractVersion, hypothesisId, and candidateVersionId.",
    );
  }
  const { contractVersion, hypothesisId, candidateVersionId } = input.payload;
  if (
    contractVersion !== 1
    || !isEvolutionShadowIdentifier(hypothesisId)
    || !isEvolutionShadowIdentifier(candidateVersionId)
  ) {
    return invalidEvolutionShadowMutation(input, "Room Evolution Shadow payload is invalid.");
  }
  return {
    type: "room.record-evolution-shadow.v1",
    projectId: input.projectId,
    commandId: input.commandId,
    input: {
      contractVersion,
      roomId: input.roomId,
      hypothesisId,
      candidateVersionId,
    },
  };
}

function invalidEvolutionShadowResult(input: RoomControlPlaneEvolutionShadowInputV1): never {
  throw unavailable(
    "ROOM_EVOLUTION_SHADOW_RESPONSE_INVALID",
    "The project Engine returned an invalid Room Evolution Shadow result.",
    input.projectId,
  );
}

function normalizeEvolutionShadowResult(
  value: unknown,
  input: RoomControlPlaneEvolutionShadowInputV1,
): RoomControlPlaneEvolutionShadowResultV1 {
  if (!isRecord(value) || typeof value.status !== "string") return invalidEvolutionShadowResult(input);
  if (value.status === "withheld") {
    if (
      !hasExactPayloadKeys(value, ["status", "reason"])
      || typeof value.reason !== "string"
      || !EVOLUTION_SHADOW_WITHHELD_REASONS.has(value.reason as never)
    ) {
      return invalidEvolutionShadowResult(input);
    }
    return {
      status: "withheld",
      reason: value.reason as Extract<RoomControlPlaneEvolutionShadowResultV1, { readonly status: "withheld" }>["reason"],
    };
  }
  if (value.status !== "shadow_recorded" || !hasExactPayloadKeys(value, ["status", "receipt"]) || !isRecord(value.receipt)) {
    return invalidEvolutionShadowResult(input);
  }
  const receipt = value.receipt;
  if (
    !hasExactPayloadKeys(receipt, [
      "experimentId",
      "projectId",
      "roomId",
      "hypothesisId",
      "candidateVersionId",
      "state",
      "capacityPool",
      "createdAt",
    ])
    || typeof receipt.experimentId !== "string"
    || !/^evolution-shadow:[a-f0-9]{64}$/u.test(receipt.experimentId)
    || receipt.projectId !== input.projectId
    || receipt.roomId !== input.roomId
    || receipt.hypothesisId !== input.payload.hypothesisId
    || receipt.candidateVersionId !== input.payload.candidateVersionId
    || receipt.state !== "planned"
    || receipt.capacityPool !== "evolution_paused"
    || !isCanonicalEvolutionShadowTimestamp(receipt.createdAt)
  ) {
    return invalidEvolutionShadowResult(input);
  }
  return {
    status: "shadow_recorded",
    receipt: {
      experimentId: receipt.experimentId,
      projectId: receipt.projectId,
      roomId: receipt.roomId,
      hypothesisId: receipt.hypothesisId,
      candidateVersionId: receipt.candidateVersionId,
      state: "planned",
      capacityPool: "evolution_paused",
      createdAt: receipt.createdAt,
    },
  };
}

function canonicalEvolutionShadowResult(
  value: unknown,
  input: RoomControlPlaneEvolutionShadowInputV1,
): RoomControlPlaneEvolutionShadowCommandResultV1 {
  if (!isRecord(value) || value.type !== "room.record-evolution-shadow.v1") {
    return invalidEvolutionShadowResult(input);
  }
  if (
    value.projectId !== input.projectId
    || value.commandId !== input.commandId
    || !isRecord(value.actor)
    || !hasExactPayloadKeys(value.actor, ["kind", "principalId"])
    || value.actor.kind !== "dashboard_operator"
    || value.actor.principalId !== input.actorId
  ) {
    return invalidEvolutionShadowResult(input);
  }
  return { commandId: input.commandId, result: normalizeEvolutionShadowResult(value.value, input) };
}

function canonicalAggregateVersion(
  value: unknown,
  input: RoomControlPlaneMutationInputV1,
): number {
  const result = isRecord(value) ? value : null;
  const resultValue = result
    && result.type === "room.send-to-seat.v1"
    && result.projectId === input.projectId
    && result.commandId === input.commandId
    && isRecord(result.value)
    ? result.value
    : null;
  const event = resultValue && isRecord(resultValue.event) ? resultValue.event : null;
  const aggregateVersion = event?.aggregateVersion;
  if (
    typeof aggregateVersion !== "number"
    || !Number.isInteger(aggregateVersion)
    || aggregateVersion < 0
  ) {
    throw unavailable(
      "ROOM_CONTROL_PLANE_MUTATION_RESPONSE_INVALID",
      "The project Engine returned an invalid Room operator action result.",
      input.projectId,
    );
  }
  return aggregateVersion;
}

async function mutateOperatorMessage(
  engine: RoomControlPlaneProjectEngine,
  input: RoomControlPlaneMutationInputV1,
): Promise<RoomControlPlaneMutationResultV1> {
  const command = createOperatorMessageCommand(input);
  const trustedPrincipal: RoomControlPlaneTrustedPrincipal = {
    kind: "dashboard_operator",
    principalId: input.actorId,
    authenticated: true,
  };

  let result: unknown;
  try {
    result = await engine.executeProjectRoomCommand(command, trustedPrincipal);
  } catch (_error) {
    throw unavailable(
      "ROOM_PROJECT_ENGINE_UNAVAILABLE",
      "The project Engine is unavailable for Room control-plane mutations.",
      input.projectId,
    );
  }

  return { accepted: true, aggregateVersion: canonicalAggregateVersion(result, input) };
}

function invalidExistingSessionPreflightInput(
  input: RoomControlPlaneExistingSessionPreflightInputV1,
  message: string,
): never {
  throw new ApiError(400, message, {
    code: "ROOM_EXISTING_SESSION_PREFLIGHT_INPUT_INVALID",
    projectId: input.projectId,
  });
}

function isCanonicalSessionUri(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 2_048 && value.trim() === value;
}

function createExistingSessionPreflightCommand(
  input: RoomControlPlaneExistingSessionPreflightInputV1,
): RoomControlPlaneExistingSessionPreflightCommand {
  if (!isNonEmptyIdentifier(input.connectorId)) {
    return invalidExistingSessionPreflightInput(input, "Existing-Session preflight requires a bounded connectorId.");
  }
  if (!isCanonicalSessionUri(input.canonicalSessionUri)) {
    return invalidExistingSessionPreflightInput(input, "Existing-Session preflight requires a bounded canonicalSessionUri.");
  }
  if (!isNonEmptyIdentifier(input.requiredHostId)) {
    return invalidExistingSessionPreflightInput(input, "Existing-Session preflight requires a bounded requiredHostId.");
  }
  if (input.requiredMachineId !== undefined && !isNonEmptyIdentifier(input.requiredMachineId)) {
    return invalidExistingSessionPreflightInput(input, "Existing-Session preflight requiredMachineId is invalid.");
  }
  if (!isNonEmptyIdentifier(input.actorId)) {
    return invalidExistingSessionPreflightInput(input, "Existing-Session preflight requires an authorized Dashboard operator.");
  }
  if (!isNonEmptyIdentifier(input.commandId)) {
    return invalidExistingSessionPreflightInput(input, "Existing-Session preflight requires a route-owned commandId.");
  }
  return {
    type: "room.preflight-existing-session.v1",
    projectId: input.projectId,
    commandId: input.commandId,
    input: {
      connectorId: input.connectorId,
      canonicalSessionUri: input.canonicalSessionUri,
      requiredHostId: input.requiredHostId,
      ...(input.requiredMachineId === undefined ? {} : { requiredMachineId: input.requiredMachineId }),
    },
  };
}

function invalidExistingSessionPreflightResult(
  input: RoomControlPlaneExistingSessionPreflightInputV1,
): never {
  throw unavailable(
    "ROOM_EXISTING_SESSION_PREFLIGHT_RESPONSE_INVALID",
    "The project Engine returned an invalid existing-Session preflight response.",
    input.projectId,
  );
}

function canonicalExistingSessionPreflightResult(
  value: unknown,
  input: RoomControlPlaneExistingSessionPreflightInputV1,
): CanonicalExistingSessionPreflightEnvelope {
  if (
    !isRecord(value)
    || value.type !== "room.preflight-existing-session.v1"
    || value.projectId !== input.projectId
    || value.commandId !== input.commandId
    || !isRecord(value.actor)
    || value.actor.kind !== "dashboard_operator"
    || value.actor.principalId !== input.actorId
    || value.value === undefined
  ) {
    return invalidExistingSessionPreflightResult(input);
  }
  return Object.freeze({
    commandId: input.commandId,
    result: value.value,
  });
}

async function preflightExistingSession(
  engine: RoomControlPlaneProjectEngine,
  input: RoomControlPlaneExistingSessionPreflightInputV1,
): Promise<unknown> {
  assertEngineProject(engine, input.projectId);
  const command = createExistingSessionPreflightCommand(input);
  const trustedPrincipal: RoomControlPlaneTrustedPrincipal = {
    kind: "dashboard_operator",
    principalId: input.actorId,
    authenticated: true,
  };
  let result: unknown;
  try {
    result = await engine.executeProjectRoomCommand(command, trustedPrincipal);
  } catch (_error) {
    throw unavailable(
      "ROOM_EXISTING_SESSION_PREFLIGHT_ENGINE_UNAVAILABLE",
      "The project Engine is unavailable for existing-Session preflight.",
      input.projectId,
    );
  }
  return canonicalExistingSessionPreflightResult(result, input);
}

async function recordEvolutionShadowReceipt(
  engine: RoomControlPlaneProjectEngine,
  input: RoomControlPlaneEvolutionShadowInputV1,
): Promise<RoomControlPlaneEvolutionShadowCommandResultV1> {
  assertEngineProject(engine, input.projectId);
  const command = createEvolutionShadowCommand(input);
  const trustedPrincipal: RoomControlPlaneTrustedPrincipal = {
    kind: "dashboard_operator",
    principalId: input.actorId,
    authenticated: true,
  };

  let result: unknown;
  try {
    result = await engine.executeProjectRoomCommand(command, trustedPrincipal);
  } catch (_error) {
    throw unavailable(
      "ROOM_EVOLUTION_SHADOW_ENGINE_UNAVAILABLE",
      "The project Engine is unavailable for Room Evolution Shadow receipts.",
      input.projectId,
    );
  }
  return canonicalEvolutionShadowResult(result, input);
}

function createEngineBackedPort(
  projectId: string,
  engine: RoomControlPlaneProjectEngine,
): RoomControlPlaneRoutePort {
  return {
    async listRooms(input: RoomControlPlaneListRoomsInputV1): Promise<RoomControlPlanePageV1> {
      assertPortProject(input.projectId, projectId);
      return await resolveReadService(engine, projectId).listRooms(input);
    },
    async getRoomProjection(input: RoomControlPlaneRoomProjectionInputV1): Promise<unknown | null> {
      assertPortProject(input.projectId, projectId);
      return await resolveReadService(engine, projectId).getRoomProjection(input);
    },
    async getExecutionStatus(): Promise<RoomControlPlaneExecutionStatusV1> {
      assertEngineProject(engine, projectId);
      /*
       * FNXC:RoomExecutionStatusOptional 2026-07-20-10:02:
       * Execution status was added after the canonical read and live-event
       * Engine boundary. A legacy Engine may remain a valid read-only port;
       * only the status endpoint must be withheld until that Engine exposes the
       * explicit lifecycle getter.
       */
      const getExecutionStatus = engine.getRoomControlPlaneExecutionStatus;
      if (typeof getExecutionStatus !== "function") {
        throw unavailable(
          "ROOM_CONTROL_PLANE_EXECUTION_STATUS_UNAVAILABLE",
          "The project Room execution status is unavailable.",
          projectId,
        );
      }
      let status: unknown;
      try {
        status = getExecutionStatus.call(engine);
      } catch (_error) {
        throw unavailable(
          "ROOM_CONTROL_PLANE_EXECUTION_STATUS_UNAVAILABLE",
          "The project Room execution status is unavailable.",
          projectId,
        );
      }
      return status as RoomControlPlaneExecutionStatusV1;
    },
    async preflightExistingSession(
      input: RoomControlPlaneExistingSessionPreflightInputV1,
    ): Promise<unknown> {
      assertPortProject(input.projectId, projectId);
      return await preflightExistingSession(engine, input);
    },
    async listResource(input: RoomControlPlaneResourceReadInputV1): Promise<RoomControlPlanePageV1> {
      assertPortProject(input.projectId, projectId);
      return unsupportedResourceRead(input);
    },
    async openRoomEventCursor(input) {
      assertPortProject(input.projectId, projectId);
      if (!isNonEmptyIdentifier(input.roomId)) {
        throw new ApiError(400, "Room live event delivery requires a bounded Room identifier.", {
          code: "ROOM_EVENT_PORT_ROOM_SCOPE_INVALID",
        });
      }
      return createLiveEventPort(projectId, resolveLiveEventService(engine, projectId));
    },
    async mutate(input: RoomControlPlaneMutationInputV1): Promise<RoomControlPlaneMutationResultV1> {
      assertPortProject(input.projectId, projectId);
      if (input.resource === "room" && input.operation === "operator_action" && input.action === "send_to_seat") {
        return await mutateOperatorMessage(engine, input);
      }
      return unsupportedMutation(input);
    },
    async recordEvolutionShadow(
      input: RoomControlPlaneEvolutionShadowInputV1,
    ): Promise<RoomControlPlaneEvolutionShadowCommandResultV1> {
      assertPortProject(input.projectId, projectId);
      return await recordEvolutionShadowReceipt(engine, input);
    },
  };
}

export function createRoomControlPlaneEngineRouteDependencies(
  options: RoomControlPlaneEngineRouteDependenciesOptions,
): RoomControlPlaneRouteDependencies {
  if (!options || typeof options.authorizeProject !== "function") {
    throw new TypeError("Room control-plane Engine route dependencies require an explicit authorizeProject callback.");
  }
  if (typeof options.resolveProjectEngine !== "function") {
    throw new TypeError("Room control-plane Engine route dependencies require a project Engine resolver.");
  }

  return {
    authorizeProject: options.authorizeProject,
    async resolvePort(input): Promise<RoomControlPlaneRoutePort> {
      if (!isNonEmptyIdentifier(input.projectId)) {
        throw new ApiError(403, "Room control-plane routes require a bounded project scope.", {
          code: "ROOM_CONTROL_PLANE_PORT_PROJECT_SCOPE_INVALID",
        });
      }
      const engine = await resolveProjectEngine(options.resolveProjectEngine, input);
      return createEngineBackedPort(input.projectId, engine);
    },
  };
}

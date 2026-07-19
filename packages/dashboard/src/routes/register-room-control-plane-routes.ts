import type { Request, Response } from "express";
import { z } from "zod";
import { ApiError } from "../api-error.js";
import type { ApiRoutesContext, ProjectContext } from "./types.js";

export const ROOM_CONTROL_PLANE_RESOURCES = [
  "participants",
  "messages",
  "task-nodes",
  "protocol",
  "candidates",
  "evidence",
  "alerts",
  "replay",
] as const;

export type RoomControlPlaneResource = (typeof ROOM_CONTROL_PLANE_RESOURCES)[number];
export type RoomControlPlaneOperation = "create" | "update" | "delete" | "command" | "operator_action";
export type RoomControlPlaneAccess = "read" | "write";

export interface RoomControlPlaneAuthorizationInput {
  readonly request: Request;
  readonly projectId: string;
  readonly store: ProjectContext["store"];
  readonly access: RoomControlPlaneAccess;
  readonly resource: "room" | RoomControlPlaneResource;
  readonly roomId: string | null;
}

export type RoomControlPlaneAuthorizationDecision =
  | {
    readonly allowed: true;
    readonly actorId: string;
    readonly roles?: readonly string[];
  }
  | {
    readonly allowed: false;
    readonly reason?: string;
  };

export interface RoomControlPlanePageV1 {
  readonly items: readonly unknown[];
  readonly nextCursor: string | null;
}

export interface RoomControlPlaneListRoomsInputV1 {
  readonly projectId: string;
  readonly cursor: string | null;
  readonly limit: number | null;
}

export interface RoomControlPlaneRoomProjectionInputV1 {
  readonly projectId: string;
  readonly roomId: string;
}

export interface RoomControlPlaneResourceReadInputV1 extends RoomControlPlaneRoomProjectionInputV1 {
  readonly resource: RoomControlPlaneResource;
  readonly cursor: string | null;
  readonly limit: number | null;
}

export interface RoomControlPlaneMutationInputV1 {
  readonly projectId: string;
  readonly roomId: string | null;
  readonly resource: "room" | RoomControlPlaneResource;
  readonly operation: RoomControlPlaneOperation;
  readonly action: string;
  readonly expectedAggregateVersion: number;
  readonly commandId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly actorId: string;
}

export interface RoomControlPlaneLiveEventScopeV1 {
  readonly projectId: string;
  readonly roomId: string;
}

export interface RoomControlPlaneLiveEventEnvelopeV1 {
  readonly contractVersion: 1;
  readonly scope: RoomControlPlaneLiveEventScopeV1;
  readonly cursor: string;
  readonly sequence: number;
  readonly streamSequence: number | null;
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateVersion: number;
  readonly occurredAt: string;
  readonly actor: Readonly<{
    readonly type: string;
    readonly id: string;
  }>;
  readonly event: unknown;
}

export interface RoomControlPlaneLiveEventConnectionV1 {
  readonly state: "connected" | "degraded" | "disconnected" | "unknown";
  readonly reason: string | null;
  readonly changedAt: string | null;
}

export interface RoomControlPlaneLiveEventAlertV1 {
  readonly code: string;
  readonly severity: "warning" | "critical";
  readonly message: string;
  readonly scope: RoomControlPlaneLiveEventScopeV1;
  readonly cursor: string | null;
  readonly expectedStreamSequence: number | null;
  readonly observedStreamSequence: number | null;
}

export interface RoomControlPlaneLiveEventReconnectInputV1 extends RoomControlPlaneLiveEventScopeV1 {
  readonly afterCursor: string | null;
  readonly limit: number;
}

export interface RoomControlPlaneLiveEventNotificationV1 {
  readonly contractVersion: 1;
  readonly type: "canonical_room_event";
  readonly scope: RoomControlPlaneLiveEventScopeV1;
  readonly envelope: RoomControlPlaneLiveEventEnvelopeV1;
  readonly connection: RoomControlPlaneLiveEventConnectionV1;
  readonly alerts: readonly RoomControlPlaneLiveEventAlertV1[];
}

export type RoomControlPlaneLiveEventReconnectResultV1 =
  | Readonly<{
    readonly ok: true;
    readonly outcome: "replayed" | "up_to_date" | "reconciliation_required";
    readonly scope: RoomControlPlaneLiveEventScopeV1;
    readonly replaySource: "memory" | "canonical_port" | null;
    readonly events: readonly RoomControlPlaneLiveEventEnvelopeV1[];
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
    readonly connection: RoomControlPlaneLiveEventConnectionV1;
    readonly alerts: readonly RoomControlPlaneLiveEventAlertV1[];
  }>
  | Readonly<{
    readonly ok: false;
    readonly outcome: "rejected";
    readonly reason: Readonly<{ readonly code: string; readonly message: string }>;
    readonly alerts: readonly RoomControlPlaneLiveEventAlertV1[];
  }>;

export interface RoomControlPlaneLiveEventPortV1 {
  reconnect(input: RoomControlPlaneLiveEventReconnectInputV1): Promise<RoomControlPlaneLiveEventReconnectResultV1>;
  subscribe(
    input: RoomControlPlaneLiveEventScopeV1,
    listener: (notification: RoomControlPlaneLiveEventNotificationV1) => void,
  ): () => void;
}

export type RoomControlPlaneMutationResultV1 =
  | {
    readonly accepted: true;
    readonly aggregateVersion: number;
    readonly result?: unknown;
  }
  | {
    readonly accepted: false;
    readonly reason: string;
    readonly currentAggregateVersion?: number;
  };

export interface RoomControlPlaneRoutePort {
  listRooms(input: RoomControlPlaneListRoomsInputV1): Promise<RoomControlPlanePageV1>;
  getRoomProjection(input: RoomControlPlaneRoomProjectionInputV1): Promise<unknown | null>;
  listResource(input: RoomControlPlaneResourceReadInputV1): Promise<RoomControlPlanePageV1>;
  mutate(input: RoomControlPlaneMutationInputV1): Promise<RoomControlPlaneMutationResultV1>;
  openRoomEventCursor(input: RoomControlPlaneRoomProjectionInputV1): Promise<RoomControlPlaneLiveEventPortV1>;
}

export interface RoomControlPlaneRouteDependencies {
  authorizeProject(input: RoomControlPlaneAuthorizationInput): Promise<RoomControlPlaneAuthorizationDecision>;
  resolvePort(input: {
    readonly request: Request;
    readonly projectId: string;
    readonly store: ProjectContext["store"];
    readonly actorId: string;
  }): Promise<RoomControlPlaneRoutePort>;
}

const identifierSchema = z.string().trim().min(1).max(256);
const expectedAggregateVersionSchema = z.number().int().nonnegative();
const actionSchema = z.string().trim().min(1).max(128).regex(/^[a-z][a-z0-9._-]*$/u);
const payloadSchema = z.record(z.unknown());
const listQuerySchema = z.object({
  projectId: identifierSchema.optional(),
  cursor: identifierSchema.optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
}).strict();
const liveEventCursorSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/u).refine(
  (value) => Number.isSafeInteger(Number(value)),
);
const liveEventQuerySchema = z.object({
  projectId: identifierSchema.optional(),
  cursor: liveEventCursorSchema.optional(),
  limit: z.coerce.number().int().positive().max(128).optional(),
}).strict();
const roomParamsSchema = z.object({ roomId: identifierSchema }).strict();
const resourceParamsSchema = roomParamsSchema.extend({ resource: z.enum(ROOM_CONTROL_PLANE_RESOURCES) }).strict();
const mutationBodySchema = z.object({
  projectId: identifierSchema.optional(),
  expectedAggregateVersion: expectedAggregateVersionSchema,
  commandId: identifierSchema.optional(),
  payload: payloadSchema.default({}),
}).strict();
const actionBodySchema = mutationBodySchema.extend({ action: actionSchema }).strict();
const createRoomBodySchema = mutationBodySchema.extend({ expectedAggregateVersion: z.literal(0) }).strict();

type RoomRouteScope = {
  readonly projectId: string;
  readonly store: ProjectContext["store"];
  readonly actorId: string;
  readonly port: RoomControlPlaneRoutePort;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new ApiError(400, "Invalid Room control-plane request", {
    code: "ROOM_ROUTE_VALIDATION_FAILED",
    issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })),
  });
}

function withoutEventSourceTokenQuery(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const query = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(query, "fn_token")) return value;
  const { fn_token: _token, ...businessQuery } = query;
  return businessQuery;
}

function normalizePage(value: RoomControlPlanePageV1): RoomControlPlanePageV1 {
  if (!value || !Array.isArray(value.items) || (value.nextCursor !== null && !isNonEmptyString(value.nextCursor))) {
    throw new ApiError(503, "Room control-plane read port returned an invalid projection", {
      code: "ROOM_CONTROL_PLANE_PORT_INVALID_RESPONSE",
    });
  }
  return { items: value.items, nextCursor: value.nextCursor };
}

function assertMutationAccepted(value: RoomControlPlaneMutationResultV1): Extract<RoomControlPlaneMutationResultV1, { accepted: true }> {
  if (value && value.accepted === true && Number.isInteger(value.aggregateVersion) && value.aggregateVersion >= 0) {
    return value;
  }
  if (value && value.accepted === false) {
    const isVersionConflict = value.reason === "version_conflict";
    throw new ApiError(409, isVersionConflict ? "Room aggregate version conflict" : "Room mutation was rejected", {
      code: isVersionConflict ? "ROOM_AGGREGATE_VERSION_CONFLICT" : "ROOM_MUTATION_REJECTED",
      ...(value.currentAggregateVersion !== undefined ? { currentAggregateVersion: value.currentAggregateVersion } : {}),
    });
  }
  throw new ApiError(503, "Room control-plane write port returned an invalid response", {
    code: "ROOM_CONTROL_PLANE_PORT_INVALID_RESPONSE",
  });
}

const ROOM_EVENT_REPLAY_LIMIT = 128;
const ROOM_EVENT_PENDING_LIMIT = ROOM_EVENT_REPLAY_LIMIT;
const ROOM_EVENT_DELIVERY_HISTORY_LIMIT = ROOM_EVENT_REPLAY_LIMIT * 2;
const ROOM_EVENT_ALERT_CODES = new Set([
  "canonical_replay_failed",
  "canonical_replay_invalid",
  "replay_cursor_ahead",
  "replay_window_overflow",
  "source_sequence_gap",
  "stream_disconnected",
]);
const ROOM_EVENT_CONNECTION_STATES = new Set(["connected", "degraded", "disconnected", "unknown"]);

type RoomSseConnectionV1 = Readonly<{
  readonly state: RoomControlPlaneLiveEventConnectionV1["state"];
  readonly changedAt: string | null;
}>;

type RoomSseAlertV1 = Readonly<{
  readonly code: string;
  readonly severity: RoomControlPlaneLiveEventAlertV1["severity"];
  readonly scope: RoomControlPlaneLiveEventScopeV1;
  readonly cursor: string | null;
  readonly expectedStreamSequence: number | null;
  readonly observedStreamSequence: number | null;
}>;

type VerifiedRoomLiveEventV1 = Readonly<{
  readonly scope: RoomControlPlaneLiveEventScopeV1;
  readonly envelope: RoomControlPlaneLiveEventEnvelopeV1;
  readonly connection: RoomSseConnectionV1;
  readonly alerts: readonly RoomSseAlertV1[];
}>;

type VerifiedRoomReplayV1 = Readonly<{
  readonly scope: RoomControlPlaneLiveEventScopeV1;
  readonly events: readonly VerifiedRoomLiveEventV1[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  readonly connection: RoomSseConnectionV1;
  readonly alerts: readonly RoomSseAlertV1[];
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalText(value: unknown, maxLength = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && value.trim() === value;
}

function isCanonicalCursor(value: unknown, allowZero = true): value is string {
  return typeof value === "string"
    && /^(?:0|[1-9][0-9]*)$/u.test(value)
    && Number.isSafeInteger(Number(value))
    && (allowZero || Number(value) > 0);
}

function isSafeIntegerAtLeast(value: unknown, minimum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum;
}

function isIsoTimestamp(value: unknown): value is string {
  return isCanonicalText(value, 64) && Number.isFinite(Date.parse(value));
}

function cloneScope(scope: RoomControlPlaneLiveEventScopeV1): RoomControlPlaneLiveEventScopeV1 {
  return Object.freeze({ projectId: scope.projectId, roomId: scope.roomId });
}

function hasExpectedScope(value: unknown, expected: RoomControlPlaneLiveEventScopeV1): value is RoomControlPlaneLiveEventScopeV1 {
  return isRecord(value) && value.projectId === expected.projectId && value.roomId === expected.roomId;
}

function assertJsonSerializable(value: unknown): void {
  try {
    JSON.stringify(value);
  } catch {
    throw new ApiError(503, "Room event payload could not be safely serialized", {
      code: "ROOM_EVENT_ENVELOPE_INVALID",
    });
  }
}

function invalidEventPortResponse(code: string, message: string): ApiError {
  return new ApiError(503, message, { code });
}

function sanitizeConnection(value: unknown): RoomSseConnectionV1 {
  if (!isRecord(value) || typeof value.state !== "string" || !ROOM_EVENT_CONNECTION_STATES.has(value.state)) {
    throw invalidEventPortResponse("ROOM_EVENT_CONNECTION_INVALID", "Room event connection metadata is invalid.");
  }
  if (value.changedAt !== null && !isIsoTimestamp(value.changedAt)) {
    throw invalidEventPortResponse("ROOM_EVENT_CONNECTION_INVALID", "Room event connection metadata is invalid.");
  }
  return Object.freeze({
    state: value.state as RoomControlPlaneLiveEventConnectionV1["state"],
    changedAt: value.changedAt as string | null,
  });
}

function sanitizeAlerts(value: unknown, expectedScope: RoomControlPlaneLiveEventScopeV1): readonly RoomSseAlertV1[] {
  if (!Array.isArray(value)) {
    throw invalidEventPortResponse("ROOM_EVENT_ALERTS_INVALID", "Room event alert metadata is invalid.");
  }
  return Object.freeze(value.map((rawAlert) => {
    if (
      !isRecord(rawAlert)
      || typeof rawAlert.code !== "string"
      || !ROOM_EVENT_ALERT_CODES.has(rawAlert.code)
      || (rawAlert.severity !== "warning" && rawAlert.severity !== "critical")
      || !hasExpectedScope(rawAlert.scope, expectedScope)
      || (rawAlert.cursor !== null && !isCanonicalCursor(rawAlert.cursor, true))
      || (rawAlert.expectedStreamSequence !== null && !isSafeIntegerAtLeast(rawAlert.expectedStreamSequence, 1))
      || (rawAlert.observedStreamSequence !== null && !isSafeIntegerAtLeast(rawAlert.observedStreamSequence, 1))
    ) {
      throw invalidEventPortResponse("ROOM_EVENT_ALERTS_INVALID", "Room event alert metadata is invalid.");
    }
    return Object.freeze({
      code: rawAlert.code,
      severity: rawAlert.severity,
      scope: cloneScope(expectedScope),
      cursor: rawAlert.cursor as string | null,
      expectedStreamSequence: rawAlert.expectedStreamSequence as number | null,
      observedStreamSequence: rawAlert.observedStreamSequence as number | null,
    });
  }));
}

function sanitizeEnvelope(value: unknown, expectedScope: RoomControlPlaneLiveEventScopeV1): RoomControlPlaneLiveEventEnvelopeV1 {
  if (!isRecord(value) || value.contractVersion !== 1 || !hasExpectedScope(value.scope, expectedScope)) {
    throw invalidEventPortResponse("ROOM_EVENT_ENVELOPE_INVALID", "Room event envelope is invalid.");
  }
  if (
    !isCanonicalCursor(value.cursor, false)
    || !isSafeIntegerAtLeast(value.sequence, 1)
    || Number(value.cursor) !== value.sequence
    || (value.streamSequence !== null && !isSafeIntegerAtLeast(value.streamSequence, 1))
    || !isCanonicalText(value.eventId)
    || !isCanonicalText(value.eventType)
    || !isSafeIntegerAtLeast(value.aggregateVersion, 0)
    || !isIsoTimestamp(value.occurredAt)
    || !isRecord(value.actor)
    || !isCanonicalText(value.actor.type)
    || !isCanonicalText(value.actor.id)
    || !isRecord(value.event)
  ) {
    throw invalidEventPortResponse("ROOM_EVENT_ENVELOPE_INVALID", "Room event envelope is invalid.");
  }
  const event = value.event;
  if (
    event.contractVersion !== 1
    || event.id !== value.eventId
    || event.projectId !== expectedScope.projectId
    || event.roomId !== expectedScope.roomId
    || event.aggregateVersion !== value.aggregateVersion
    || event.eventType !== value.eventType
    || event.actorType !== value.actor.type
    || event.actorId !== value.actor.id
    || !isCanonicalText(event.correlationId)
    || (event.causationId !== null && !isCanonicalText(event.causationId))
    || !isRecord(event.payload)
    || event.occurredAt !== value.occurredAt
    || event.cursor !== value.cursor
  ) {
    throw invalidEventPortResponse("ROOM_EVENT_ENVELOPE_INVALID", "Room event envelope is invalid.");
  }
  assertJsonSerializable(event.payload);
  return Object.freeze({
    contractVersion: 1,
    scope: cloneScope(expectedScope),
    cursor: value.cursor,
    sequence: value.sequence,
    streamSequence: value.streamSequence as number | null,
    eventId: value.eventId,
    eventType: value.eventType,
    aggregateVersion: value.aggregateVersion,
    occurredAt: value.occurredAt,
    actor: Object.freeze({ type: value.actor.type, id: value.actor.id }),
    event: Object.freeze({
      contractVersion: 1,
      id: value.eventId,
      projectId: expectedScope.projectId,
      roomId: expectedScope.roomId,
      aggregateVersion: value.aggregateVersion,
      eventType: value.eventType,
      actorType: value.actor.type,
      actorId: value.actor.id,
      correlationId: event.correlationId,
      causationId: event.causationId,
      payload: event.payload,
      occurredAt: value.occurredAt,
      cursor: value.cursor,
    }),
  });
}

function sanitizeNotification(value: unknown, expectedScope: RoomControlPlaneLiveEventScopeV1): VerifiedRoomLiveEventV1 {
  if (!isRecord(value) || value.contractVersion !== 1 || value.type !== "canonical_room_event" || !hasExpectedScope(value.scope, expectedScope)) {
    throw invalidEventPortResponse("ROOM_EVENT_NOTIFICATION_INVALID", "Room live event notification is invalid.");
  }
  return Object.freeze({
    scope: cloneScope(expectedScope),
    envelope: sanitizeEnvelope(value.envelope, expectedScope),
    connection: sanitizeConnection(value.connection),
    alerts: sanitizeAlerts(value.alerts, expectedScope),
  });
}

function normalizeReplay(
  value: unknown,
  expectedScope: RoomControlPlaneLiveEventScopeV1,
  afterCursor: string | null,
): VerifiedRoomReplayV1 {
  if (!isRecord(value) || value.ok !== true || !hasExpectedScope(value.scope, expectedScope)) {
    throw invalidEventPortResponse("ROOM_EVENT_RECONNECT_INVALID", "Room canonical event replay is unavailable.");
  }
  if (value.outcome === "reconciliation_required") {
    throw new ApiError(409, "Room event replay requires canonical reconciliation.", {
      code: "ROOM_EVENT_RECONCILIATION_REQUIRED",
    });
  }
  if (value.outcome !== "replayed" && value.outcome !== "up_to_date") {
    throw invalidEventPortResponse("ROOM_EVENT_RECONNECT_INVALID", "Room canonical event replay is unavailable.");
  }
  if (value.replaySource !== "canonical_port") {
    throw invalidEventPortResponse("ROOM_EVENT_REPLAY_NOT_CANONICAL", "Room event replay is not backed by the canonical ledger.");
  }
  if (
    typeof value.hasMore !== "boolean"
    || !Array.isArray(value.events)
    || (value.nextCursor !== null && !isCanonicalCursor(value.nextCursor, true))
  ) {
    throw invalidEventPortResponse("ROOM_EVENT_RECONNECT_INVALID", "Room canonical event replay is unavailable.");
  }
  const connection = sanitizeConnection(value.connection);
  const alerts = sanitizeAlerts(value.alerts, expectedScope);
  let previousSequence = afterCursor === null ? null : Number(afterCursor);
  const events = value.events.map((rawEvent) => {
    const envelope = sanitizeEnvelope(rawEvent, expectedScope);
    if (previousSequence !== null && envelope.sequence <= previousSequence) {
      throw invalidEventPortResponse("ROOM_EVENT_REPLAY_ORDER_INVALID", "Room canonical replay is not strictly ordered.");
    }
    previousSequence = envelope.sequence;
    return Object.freeze({
      scope: cloneScope(expectedScope),
      envelope,
      connection,
      alerts,
    });
  });
  const expectedNextCursor = events.at(-1)?.envelope.cursor ?? afterCursor;
  if (value.nextCursor !== expectedNextCursor) {
    throw invalidEventPortResponse("ROOM_EVENT_REPLAY_CURSOR_INVALID", "Room canonical replay cursor is invalid.");
  }
  if (value.hasMore && events.length === 0) {
    throw invalidEventPortResponse("ROOM_EVENT_REPLAY_CURSOR_INVALID", "Room canonical replay cannot require another page without a cursor advance.");
  }
  return Object.freeze({
    scope: cloneScope(expectedScope),
    events: Object.freeze(events),
    nextCursor: expectedNextCursor,
    hasMore: value.hasMore,
    connection,
    alerts,
  });
}

function resolveEventCursor(request: Request, queryCursor: string | undefined): string | null {
  const rawHeader = request.headers["last-event-id"];
  if (rawHeader === undefined) return queryCursor ?? null;
  if (Array.isArray(rawHeader) || !isCanonicalCursor(rawHeader, true)) {
    throw new ApiError(400, "Last-Event-ID must be a canonical Room event cursor.", {
      code: "ROOM_EVENT_CURSOR_INVALID",
    });
  }
  if (queryCursor !== undefined && queryCursor !== rawHeader) {
    throw new ApiError(400, "Query cursor and Last-Event-ID must match.", {
      code: "ROOM_EVENT_CURSOR_CONFLICT",
    });
  }
  return rawHeader;
}

type RoomSseWriteResult = "ok" | "disconnected" | "backpressure";

function writeRoomSseFrame(response: Response, frame: string): RoomSseWriteResult {
  try {
    if (response.writableEnded || response.destroyed) return "disconnected";
    if (response.writableNeedDrain) return "backpressure";
    return response.write(frame) ? "ok" : "backpressure";
  } catch {
    return "disconnected";
  }
}

function writeRoomSse(
  response: Response,
  event: "room.connection" | "room.event" | "room.alert" | "room.replay.continue",
  payload: unknown,
  cursor?: string,
): RoomSseWriteResult {
  let data: string;
  try {
    data = JSON.stringify(payload);
  } catch {
    return "disconnected";
  }
  const id = cursor === undefined ? "" : `id: ${cursor}\n`;
  return writeRoomSseFrame(response, `${id}event: ${event}\ndata: ${data}\n\n`);
}

async function resolveScope(input: {
  readonly context: ApiRoutesContext;
  readonly dependencies: RoomControlPlaneRouteDependencies;
  readonly request: Request;
  readonly access: RoomControlPlaneAccess;
  readonly resource: "room" | RoomControlPlaneResource;
  readonly roomId: string | null;
  readonly bodyProjectId?: string;
}): Promise<RoomRouteScope> {
  const projectContext = await input.context.getProjectContext(input.request);
  const projectId = projectContext.projectId;
  if (!isNonEmptyString(projectId)) {
    throw new ApiError(403, "Operational Room routes require an authenticated project scope", {
      code: "ROOM_PROJECT_SCOPE_REQUIRED",
    });
  }

  const requestedProjectId = input.context.getProjectIdFromRequest(input.request);
  if (
    (isNonEmptyString(requestedProjectId) && requestedProjectId !== projectId)
    || (isNonEmptyString(input.bodyProjectId) && input.bodyProjectId !== projectId)
  ) {
    throw new ApiError(403, "Requested project does not match the resolved project scope", {
      code: "ROOM_PROJECT_SCOPE_MISMATCH",
    });
  }

  const authorization = await input.dependencies.authorizeProject({
    request: input.request,
    projectId,
    store: projectContext.store,
    access: input.access,
    resource: input.resource,
    roomId: input.roomId,
  });
  if (!authorization || authorization.allowed !== true || !isNonEmptyString(authorization.actorId)) {
    throw new ApiError(403, "Room project access is denied", { code: "ROOM_PROJECT_ACCESS_DENIED" });
  }

  const port = await input.dependencies.resolvePort({
    request: input.request,
    projectId,
    store: projectContext.store,
    actorId: authorization.actorId,
  });
  if (!port) {
    throw new ApiError(503, "Room control-plane storage is unavailable", {
      code: "ROOM_CONTROL_PLANE_PORT_UNAVAILABLE",
    });
  }

  return { projectId, store: projectContext.store, actorId: authorization.actorId, port };
}

function rethrowRouteError(context: ApiRoutesContext, error: unknown): never {
  if (error instanceof ApiError) throw error;
  return context.rethrowAsApiError(error, "Room control-plane route failed");
}

function mutationResponse(res: import("express").Response, mutation: Extract<RoomControlPlaneMutationResultV1, { accepted: true }>, status = 200): void {
  res.status(status).json({
    accepted: true,
    aggregateVersion: mutation.aggregateVersion,
    ...(mutation.result !== undefined ? { result: mutation.result } : {}),
  });
}

export function registerRoomControlPlaneRoutes(
  context: ApiRoutesContext,
  dependencies: RoomControlPlaneRouteDependencies,
): void {
  context.router.get("/rooms", async (req, res) => {
    try {
      const query = parseOrThrow(listQuerySchema, req.query);
      const scope = await resolveScope({
        context,
        dependencies,
        request: req,
        access: "read",
        resource: "room",
        roomId: null,
      });
      const page = normalizePage(await scope.port.listRooms({
        projectId: scope.projectId,
        cursor: query.cursor ?? null,
        limit: query.limit ?? null,
      }));
      res.json({ rooms: page.items, nextCursor: page.nextCursor });
    } catch (error) {
      rethrowRouteError(context, error);
    }
  });

  context.router.post("/rooms", async (req, res) => {
    try {
      const body = parseOrThrow(createRoomBodySchema, req.body);
      const scope = await resolveScope({
        context,
        dependencies,
        request: req,
        access: "write",
        resource: "room",
        roomId: null,
        bodyProjectId: body.projectId,
      });
      const mutation = assertMutationAccepted(await scope.port.mutate({
        projectId: scope.projectId,
        roomId: null,
        resource: "room",
        operation: "create",
        action: "create",
        expectedAggregateVersion: body.expectedAggregateVersion,
        commandId: body.commandId ?? null,
        payload: body.payload ?? {},
        actorId: scope.actorId,
      }));
      mutationResponse(res, mutation, 201);
    } catch (error) {
      rethrowRouteError(context, error);
    }
  });

  context.router.get("/rooms/:roomId", async (req, res) => {
    try {
      const params = parseOrThrow(roomParamsSchema, req.params);
      const scope = await resolveScope({
        context,
        dependencies,
        request: req,
        access: "read",
        resource: "room",
        roomId: params.roomId,
      });
      const room = await scope.port.getRoomProjection({ projectId: scope.projectId, roomId: params.roomId });
      if (room === null) {
        throw new ApiError(404, `Room ${params.roomId} not found`, { code: "ROOM_NOT_FOUND", roomId: params.roomId });
      }
      if (room === undefined) {
        throw new ApiError(503, "Room control-plane read port returned an invalid projection", {
          code: "ROOM_CONTROL_PLANE_PORT_INVALID_RESPONSE",
        });
      }
      res.json({ room });
    } catch (error) {
      rethrowRouteError(context, error);
    }
  });

  context.router.patch("/rooms/:roomId", async (req, res) => {
    try {
      const params = parseOrThrow(roomParamsSchema, req.params);
      const body = parseOrThrow(mutationBodySchema, req.body);
      const scope = await resolveScope({
        context,
        dependencies,
        request: req,
        access: "write",
        resource: "room",
        roomId: params.roomId,
        bodyProjectId: body.projectId,
      });
      const mutation = assertMutationAccepted(await scope.port.mutate({
        projectId: scope.projectId,
        roomId: params.roomId,
        resource: "room",
        operation: "update",
        action: "update",
        expectedAggregateVersion: body.expectedAggregateVersion,
        commandId: body.commandId ?? null,
        payload: body.payload ?? {},
        actorId: scope.actorId,
      }));
      mutationResponse(res, mutation);
    } catch (error) {
      rethrowRouteError(context, error);
    }
  });

  context.router.delete("/rooms/:roomId", async (req, res) => {
    try {
      const params = parseOrThrow(roomParamsSchema, req.params);
      const body = parseOrThrow(mutationBodySchema, req.body);
      const scope = await resolveScope({
        context,
        dependencies,
        request: req,
        access: "write",
        resource: "room",
        roomId: params.roomId,
        bodyProjectId: body.projectId,
      });
      const mutation = assertMutationAccepted(await scope.port.mutate({
        projectId: scope.projectId,
        roomId: params.roomId,
        resource: "room",
        operation: "delete",
        action: "delete",
        expectedAggregateVersion: body.expectedAggregateVersion,
        commandId: body.commandId ?? null,
        payload: body.payload ?? {},
        actorId: scope.actorId,
      }));
      mutationResponse(res, mutation);
    } catch (error) {
      rethrowRouteError(context, error);
    }
  });

  context.router.get("/rooms/:roomId/events", async (req, res) => {
    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    let streamScope: RoomControlPlaneLiveEventScopeV1 | null = null;

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      const closeSubscription = unsubscribe;
      unsubscribe = null;
      try {
        closeSubscription?.();
      } catch {
      }
      req.off("close", cleanup);
      req.off("aborted", cleanup);
      res.off("close", cleanup);
    };

    const terminateStream = (code: "canonical_replay_invalid" | "stream_disconnected"): void => {
      let alertWrite: RoomSseWriteResult = "ok";
      if (streamScope !== null && !res.writableEnded && !res.destroyed) {
        alertWrite = writeRoomSse(res, "room.alert", {
          contractVersion: 1,
          type: "room_alert",
          scope: cloneScope(streamScope),
          alerts: [{
            code,
            severity: "critical",
            scope: cloneScope(streamScope),
            cursor: null,
            expectedStreamSequence: null,
            observedStreamSequence: null,
          }],
        });
      }
      cleanup();
      if (alertWrite === "backpressure") {
        if (!res.destroyed) res.destroy();
        return;
      }
      if (!res.writableEnded && !res.destroyed) res.end();
    };

    const terminateBackpressuredStream = (): void => {
      cleanup();
      if (!res.destroyed) res.destroy();
    };

    try {
      const params = parseOrThrow(roomParamsSchema, req.params);
      const query = parseOrThrow(liveEventQuerySchema, withoutEventSourceTokenQuery(req.query));
      const afterCursor = resolveEventCursor(req, query.cursor);
      const scope = await resolveScope({
        context,
        dependencies,
        request: req,
        access: "read",
        resource: "room",
        roomId: params.roomId,
      });
      streamScope = Object.freeze({ projectId: scope.projectId, roomId: params.roomId });
      const liveEventPort = await scope.port.openRoomEventCursor({
        projectId: scope.projectId,
        roomId: params.roomId,
      });
      if (
        !liveEventPort
        || typeof liveEventPort.reconnect !== "function"
        || typeof liveEventPort.subscribe !== "function"
      ) {
        throw invalidEventPortResponse("ROOM_EVENT_PORT_UNAVAILABLE", "Room live event delivery is unavailable.");
      }

      const bufferedNotifications: VerifiedRoomLiveEventV1[] = [];
      const deliveredByCursor = new Map<string, string>();
      const deliveredByEventId = new Map<string, string>();
      const deliveryHistory: Array<Readonly<{ cursor: string; eventId: string }>> = [];
      let lastSequence = afterCursor === null ? null : Number(afterCursor);
      let phase: "replaying" | "live" = "replaying";

      const rememberDelivery = (event: VerifiedRoomLiveEventV1, fingerprint: string): void => {
        deliveredByCursor.set(event.envelope.cursor, fingerprint);
        deliveredByEventId.set(event.envelope.eventId, event.envelope.cursor);
        deliveryHistory.push(Object.freeze({ cursor: event.envelope.cursor, eventId: event.envelope.eventId }));
        if (deliveryHistory.length <= ROOM_EVENT_DELIVERY_HISTORY_LIMIT) return;
        const oldest = deliveryHistory.shift();
        if (oldest === undefined) return;
        deliveredByCursor.delete(oldest.cursor);
        deliveredByEventId.delete(oldest.eventId);
      };

      const emitVerifiedEvent = (event: VerifiedRoomLiveEventV1): boolean => {
        const fingerprint = JSON.stringify([
          event.envelope.cursor,
          event.envelope.eventId,
          event.envelope.aggregateVersion,
          event.envelope.eventType,
          event.envelope.event,
        ]);
        const existingCursor = deliveredByCursor.get(event.envelope.cursor);
        const existingEventId = deliveredByEventId.get(event.envelope.eventId);
        if (existingCursor !== undefined || existingEventId !== undefined) {
          if (existingCursor === fingerprint && existingEventId === event.envelope.cursor) return true;
          terminateStream("canonical_replay_invalid");
          return false;
        }
        if (lastSequence !== null && event.envelope.sequence <= lastSequence) {
          terminateStream("canonical_replay_invalid");
          return false;
        }
        const writeResult = writeRoomSse(res, "room.event", {
          contractVersion: 1,
          type: "room_event",
          scope: cloneScope(event.scope),
          envelope: event.envelope,
          connection: event.connection,
          alerts: event.alerts,
        }, event.envelope.cursor);
        if (writeResult !== "ok") {
          if (writeResult === "backpressure") terminateBackpressuredStream();
          else terminateStream("stream_disconnected");
          return false;
        }
        rememberDelivery(event, fingerprint);
        lastSequence = event.envelope.sequence;
        return true;
      };

      const handleLiveNotification = (notification: unknown): void => {
        if (closed) return;
        try {
          const event = sanitizeNotification(notification, streamScope!);
          if (phase !== "live") {
            if (bufferedNotifications.length >= ROOM_EVENT_PENDING_LIMIT) {
              terminateBackpressuredStream();
              return;
            }
            bufferedNotifications.push(event);
            return;
          }
          emitVerifiedEvent(event);
        } catch {
          terminateStream("canonical_replay_invalid");
        }
      };

      req.once("close", cleanup);
      req.once("aborted", cleanup);
      res.once("close", cleanup);
      const candidateUnsubscribe = liveEventPort.subscribe(streamScope, handleLiveNotification);
      if (typeof candidateUnsubscribe !== "function") {
        throw invalidEventPortResponse("ROOM_EVENT_PORT_INVALID", "Room live event delivery is unavailable.");
      }
      unsubscribe = candidateUnsubscribe;
      if (closed) {
        try {
          candidateUnsubscribe();
        } catch {
        }
        unsubscribe = null;
        return;
      }

      const replay = normalizeReplay(
        await liveEventPort.reconnect({
          projectId: streamScope.projectId,
          roomId: streamScope.roomId,
          afterCursor,
          limit: query.limit ?? ROOM_EVENT_REPLAY_LIMIT,
        }),
        streamScope,
        afterCursor,
      );
      if (closed) return;

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders();
      const connectionWrite = writeRoomSse(res, "room.connection", {
        contractVersion: 1,
        type: "room_connection",
        scope: cloneScope(replay.scope),
        cursor: replay.nextCursor,
        connection: replay.connection,
        alerts: replay.alerts,
      });
      if (connectionWrite !== "ok") {
        if (connectionWrite === "backpressure") terminateBackpressuredStream();
        else terminateStream("stream_disconnected");
        return;
      }
      for (const event of replay.events) {
        if (!emitVerifiedEvent(event)) return;
      }
      if (replay.hasMore) {
        const continuationWrite = writeRoomSse(res, "room.replay.continue", {
          contractVersion: 1,
          type: "room_replay_continue",
          scope: cloneScope(replay.scope),
          cursor: replay.nextCursor,
        }, replay.nextCursor ?? undefined);
        if (continuationWrite !== "ok") {
          if (continuationWrite === "backpressure") terminateBackpressuredStream();
          else terminateStream("stream_disconnected");
          return;
        }
        cleanup();
        if (!res.writableEnded && !res.destroyed) res.end();
        return;
      }

      phase = "live";
      const pending = bufferedNotifications.splice(0);
      for (const event of [...pending].sort((left, right) => left.envelope.sequence - right.envelope.sequence)) {
        if (!emitVerifiedEvent(event)) return;
      }

      heartbeat = setInterval(() => {
        if (closed) return;
        const heartbeatWrite = writeRoomSseFrame(res, ": heartbeat\n\n");
        if (heartbeatWrite === "backpressure") terminateBackpressuredStream();
        else if (heartbeatWrite !== "ok") cleanup();
      }, 30_000);
      heartbeat.unref?.();
    } catch (error) {
      const headersSent = res.headersSent;
      cleanup();
      if (headersSent) {
        if (!res.writableEnded && !res.destroyed) res.end();
        return;
      }
      rethrowRouteError(context, error);
    }
  });

  context.router.get("/rooms/:roomId/:resource", async (req, res) => {
    try {
      const params = parseOrThrow(resourceParamsSchema, req.params);
      const query = parseOrThrow(listQuerySchema, req.query);
      const scope = await resolveScope({
        context,
        dependencies,
        request: req,
        access: "read",
        resource: params.resource,
        roomId: params.roomId,
      });
      const page = normalizePage(await scope.port.listResource({
        projectId: scope.projectId,
        roomId: params.roomId,
        resource: params.resource,
        cursor: query.cursor ?? null,
        limit: query.limit ?? null,
      }));
      res.json({ items: page.items, nextCursor: page.nextCursor });
    } catch (error) {
      rethrowRouteError(context, error);
    }
  });

  context.router.post("/rooms/:roomId/:resource/actions", async (req, res) => {
    try {
      const params = parseOrThrow(resourceParamsSchema, req.params);
      const body = parseOrThrow(actionBodySchema, req.body);
      const scope = await resolveScope({
        context,
        dependencies,
        request: req,
        access: "write",
        resource: params.resource,
        roomId: params.roomId,
        bodyProjectId: body.projectId,
      });
      const mutation = assertMutationAccepted(await scope.port.mutate({
        projectId: scope.projectId,
        roomId: params.roomId,
        resource: params.resource,
        operation: "command",
        action: body.action,
        expectedAggregateVersion: body.expectedAggregateVersion,
        commandId: body.commandId ?? null,
        payload: body.payload ?? {},
        actorId: scope.actorId,
      }));
      mutationResponse(res, mutation);
    } catch (error) {
      rethrowRouteError(context, error);
    }
  });

  context.router.post("/rooms/:roomId/actions", async (req, res) => {
    try {
      const params = parseOrThrow(roomParamsSchema, req.params);
      const body = parseOrThrow(actionBodySchema, req.body);
      const scope = await resolveScope({
        context,
        dependencies,
        request: req,
        access: "write",
        resource: "room",
        roomId: params.roomId,
        bodyProjectId: body.projectId,
      });
      const mutation = assertMutationAccepted(await scope.port.mutate({
        projectId: scope.projectId,
        roomId: params.roomId,
        resource: "room",
        operation: "operator_action",
        action: body.action,
        expectedAggregateVersion: body.expectedAggregateVersion,
        commandId: body.commandId ?? null,
        payload: body.payload ?? {},
        actorId: scope.actorId,
      }));
      mutationResponse(res, mutation);
    } catch (error) {
      rethrowRouteError(context, error);
    }
  });
}

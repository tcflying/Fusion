import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Workflow } from "lucide-react";
import type { RoomCockpitProjectionV1 as EngineRoomCockpitProjectionV1 } from "@fusion/engine";
import { ViewHeader } from "../components/ViewHeader";
import {
  RoomCockpitView,
  type RoomCockpitAlertV1,
  type RoomCockpitConfidenceBandV1,
  type RoomCockpitHealthStateV1,
  type RoomCockpitTaskEdgeV1,
  type RoomCockpitTaskNodeV1,
  type RoomCockpitTaskStateV1,
  type RoomCockpitViewStateV1,
} from "./RoomCockpitView";

export type RoomCockpitProjectionV1 = EngineRoomCockpitProjectionV1;

export type RoomCockpitProjectionFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface RoomCockpitRouteProps {
  readonly projectId?: string;
  readonly initialRoomId?: string;
  readonly onClose: () => void;
  readonly fetchProjection?: RoomCockpitProjectionFetcher;
}

interface RoomCockpitRouteSnapshot {
  readonly state: RoomCockpitViewStateV1;
  readonly projection?: RoomCockpitProjectionV1;
  readonly detail: string;
}

const ROOM_TASK_STATES = new Set<RoomCockpitTaskStateV1>([
  "ready",
  "running",
  "waiting_dependency",
  "waiting_approval",
  "rate_limited",
  "failed",
  "retrying",
  "accepted",
  "cancelled",
  "blocked",
]);

const ROOM_HEALTH_STATES = new Set<RoomCockpitHealthStateV1>([
  "healthy",
  "degraded",
  "critical",
  "paused",
  "unknown",
]);

const ROOM_CONFIDENCE_BANDS = new Set<RoomCockpitConfidenceBandV1>([
  "high",
  "medium",
  "low",
  "unknown",
]);

const CAPACITY_STRUCTURAL_FIELDS = [
  "theoreticalSlots",
  "configuredSlots",
  "activeSlots",
  "queueDepth",
  "utilizationRatio",
] as const;

const CAPACITY_OBSERVED_FIELDS = [
  "reservedVerifierSlots",
  "reservedRecoverySlots",
  "throughputPerMinute",
  "idleReasons",
] as const;

type RoomCockpitCapacityTelemetryV1 = RoomCockpitProjectionV1["capacity"]["telemetry"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && isNonNegativeNumber(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isExpectedFieldList(value: unknown, expected: readonly string[]): value is readonly string[] {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((field, index) => field === expected[index]);
}

function isRoomCockpitCapacityTelemetry(value: unknown): value is RoomCockpitCapacityTelemetryV1 {
  if (!isRecord(value)
    || !isNonEmptyString(value.detail)
    || !isExpectedFieldList(value.structuralFields, CAPACITY_STRUCTURAL_FIELDS)
    || !isExpectedFieldList(value.observedFields, CAPACITY_OBSERVED_FIELDS)) {
    return false;
  }

  if (value.availability === "unavailable") {
    return value.source === undefined && value.observedAt === undefined;
  }

  return value.availability === "available"
    && value.source === "persistent_runtime_telemetry"
    && isNonEmptyString(value.observedAt);
}

/**
 * FNXC:RoomCockpitRoute 2026-07-19-16:56:
 * Capacity structural values are always derivable, but reservations, throughput,
 * and idle reasons are real only when persistent runtime telemetry says available.
 * Require the Engine discriminator and retain unavailable observations as null so
 * the route never fabricates zero capacity or an empty idle-reason collection.
 */
function isRoomCockpitCapacity(value: unknown): boolean {
  if (!isRecord(value)
    || !isNonNegativeNumber(value.theoreticalSlots)
    || !isNonNegativeNumber(value.configuredSlots)
    || !isNonNegativeNumber(value.activeSlots)
    || !isNonNegativeNumber(value.queueDepth)
    || !isNonNegativeNumber(value.utilizationRatio)) {
    return false;
  }

  const telemetry = value.telemetry;
  if (!isRoomCockpitCapacityTelemetry(telemetry)) return false;

  if (telemetry.availability === "unavailable") {
    return value.reservedVerifierSlots === null
      && value.reservedRecoverySlots === null
      && value.throughputPerMinute === null
      && value.idleReasons === null;
  }

  return isNonNegativeNumber(value.reservedVerifierSlots)
    && isNonNegativeNumber(value.reservedRecoverySlots)
    && isNonNegativeNumber(value.throughputPerMinute)
    && Array.isArray(value.idleReasons)
    && value.idleReasons.every((reason) => isRecord(reason)
      && isNonEmptyString(reason.reason)
      && isNonNegativeNumber(reason.slots));
}

function isRoomCockpitTask(value: unknown): value is RoomCockpitTaskNodeV1 {
  if (!isRecord(value) || !ROOM_TASK_STATES.has(value.state as RoomCockpitTaskStateV1)) return false;
  return isNonEmptyString(value.id)
    && isNonEmptyString(value.title)
    && isStringOrNull(value.ownerSeatId)
    && isStringArray(value.dependencyNodeIds)
    && typeof value.critical === "boolean"
    && isNonNegativeInteger(value.attempt)
    && isStringOrNull(value.progressSignature)
    && isStringArray(value.inputs)
    && isStringArray(value.outputs)
    && isStringArray(value.gateIds)
    && isStringArray(value.evidenceIds)
    && isStringOrNull(value.waitReason)
    && isStringOrNull(value.nextRecoveryAction);
}

function isRoomCockpitEdge(value: unknown): value is RoomCockpitTaskEdgeV1 {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.id)
    && isNonEmptyString(value.fromNodeId)
    && isNonEmptyString(value.toNodeId)
    && (value.kind === "depends_on" || value.kind === "blocks" || value.kind === "informs" || value.kind === "invalidates");
}

function isRoomCockpitAlert(value: unknown): value is RoomCockpitAlertV1 {
  if (!isRecord(value)) return false;
  if (value.severity !== "info" && value.severity !== "warning" && value.severity !== "severe" && value.severity !== "critical") return false;
  if (value.state !== "open" && value.state !== "acknowledged" && value.state !== "resolved") return false;
  return isNonEmptyString(value.id)
    && isNonEmptyString(value.rootCause)
    && isNonEmptyString(value.impact)
    && isStringArray(value.evidenceIds)
    && isStringArray(value.attemptedRecovery)
    && isStringOrNull(value.nextRetryAt)
    && Array.isArray(value.actions)
    && value.actions.every((action) => isRecord(action)
      && isNonEmptyString(action.id)
      && isNonEmptyString(action.label)
      && typeof action.requiresConfirmation === "boolean");
}

export function isRoomCockpitProjection(value: unknown): value is RoomCockpitProjectionV1 {
  if (!isRecord(value)
    || !isNonEmptyString(value.roomId)
    || !isNonEmptyString(value.objective)
    || !isNonEmptyString(value.phase)
    || !isRecord(value.health)
    || !ROOM_HEALTH_STATES.has(value.health.state as RoomCockpitHealthStateV1)
    || !isNonEmptyString(value.health.detail)
    || !isRecord(value.completion)
    || !isNonNegativeNumber(value.completion.acceptedNodes)
    || !isNonNegativeNumber(value.completion.total)
    || !isNonNegativeNumber(value.completion.blockedNodes)
    || !isStringArray(value.criticalPathNodeIds)
    || !isRecord(value.confidence)
    || !ROOM_CONFIDENCE_BANDS.has(value.confidence.band as RoomCockpitConfidenceBandV1)
    || !isNonEmptyString(value.confidence.snapshotId)
    || !Array.isArray(value.confidence.dimensions)
    || !value.confidence.dimensions.every((dimension) => isRecord(dimension)
      && isNonEmptyString(dimension.name)
      && ROOM_CONFIDENCE_BANDS.has(dimension.band as RoomCockpitConfidenceBandV1)
      && isNonEmptyString(dimension.rationale))
    || !isRoomCockpitCapacity(value.capacity)
    || !Array.isArray(value.tasks)
    || !value.tasks.every(isRoomCockpitTask)
    || !Array.isArray(value.edges)
    || !value.edges.every(isRoomCockpitEdge)
    || !Array.isArray(value.alerts)
    || !value.alerts.every(isRoomCockpitAlert)) {
    return false;
  }
  return true;
}

function getResponseDetail(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  const error = isRecord(payload.error) ? payload.error : payload;
  if (typeof error.message === "string" && error.message.trim().length > 0) return error.message;
  if (typeof error.code === "string" && error.code.trim().length > 0) return error.code;
  return fallback;
}

function getResponseCode(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const error = isRecord(payload.error) ? payload.error : payload;
  return typeof error.code === "string" ? error.code : null;
}

async function readResponsePayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function normalizeRoomId(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function initialSnapshot(projectId: string | undefined, roomId: string | null): RoomCockpitRouteSnapshot {
  if (!projectId) {
    return {
      state: "empty",
      detail: "Select a Fusion project before requesting a verified Room projection.",
    };
  }
  if (!roomId) {
    return {
      state: "empty",
      detail: "Enter a Room ID to load a verified control-plane projection. No demo telemetry is shown here.",
    };
  }
  return {
    state: "loading",
    detail: "Loading the verified Room projection.",
  };
}

/**
 * FNXC:RoomCockpitRoute 2026-07-19-23:32:
 * The first cockpit entry is deliberately projection-only. It accepts only a
 * schema-validated response from the optional Room control-plane API and makes
 * an absent, unavailable, or malformed backend explicit instead of synthesizing
 * tasks, capacity, confidence, or operator actions from dashboard state.
 */
export function RoomCockpitRoute({ projectId, initialRoomId, onClose, fetchProjection = globalThis.fetch }: RoomCockpitRouteProps) {
  const normalizedInitialRoomId = normalizeRoomId(initialRoomId);
  const [draftRoomId, setDraftRoomId] = useState(normalizedInitialRoomId ?? "");
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(normalizedInitialRoomId);
  const [snapshot, setSnapshot] = useState<RoomCockpitRouteSnapshot>(() => initialSnapshot(projectId, normalizedInitialRoomId));
  const requestEpochRef = useRef(0);

  const loadRoom = useCallback(async (roomId: string | null) => {
    const requestEpoch = ++requestEpochRef.current;
    if (!projectId || !roomId) {
      setSnapshot(initialSnapshot(projectId, roomId));
      return;
    }

    setSnapshot({ state: "loading", detail: "Loading the verified Room projection." });
    const query = new URLSearchParams({ projectId });
    const path = `/api/rooms/${encodeURIComponent(roomId)}?${query.toString()}`;

    try {
      const response = await fetchProjection(path, { headers: { accept: "application/json" } });
      const payload = await readResponsePayload(response);
      if (requestEpoch !== requestEpochRef.current) return;

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          setSnapshot({
            state: "permission-denied",
            detail: getResponseDetail(payload, "This project does not grant access to the requested Room projection."),
          });
          return;
        }
        if (response.status === 404 && getResponseCode(payload) === "ROOM_NOT_FOUND") {
          setSnapshot({
            state: "empty",
            detail: getResponseDetail(payload, `Room ${roomId} was not found in this project.`),
          });
          return;
        }
        setSnapshot({
          state: "degraded",
          detail: getResponseDetail(payload, "The Room control-plane projection endpoint is unavailable. Retry after it is connected."),
        });
        return;
      }

      const candidate = isRecord(payload) ? payload.room : undefined;
      if (!isRoomCockpitProjection(candidate)) {
        setSnapshot({
          state: "degraded",
          detail: "The Room endpoint returned data that does not satisfy the verified cockpit projection contract.",
        });
        return;
      }
      if (candidate.roomId !== roomId) {
        setSnapshot({
          state: "degraded",
          detail: "The Room endpoint returned a projection for a different Room ID, so it was withheld from the cockpit.",
        });
        return;
      }
      setSnapshot({ state: "ready", projection: candidate, detail: "Verified Room projection loaded." });
    } catch (error) {
      if (requestEpoch !== requestEpochRef.current) return;
      setSnapshot({
        state: "degraded",
        detail: error instanceof Error && error.message ? error.message : "Unable to contact the Room control-plane endpoint. Retry after it is connected.",
      });
    }
  }, [fetchProjection, projectId]);

  useEffect(() => {
    void loadRoom(selectedRoomId);
    return () => {
      requestEpochRef.current += 1;
    };
  }, [loadRoom, selectedRoomId]);

  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextRoomId = normalizeRoomId(draftRoomId);
    if (nextRoomId === selectedRoomId) {
      void loadRoom(nextRoomId);
      return;
    }
    setSelectedRoomId(nextRoomId);
  }, [draftRoomId, loadRoom, selectedRoomId]);

  return (
    <section data-testid="room-cockpit-route" aria-label="Room control-plane cockpit">
      <ViewHeader
        icon={Workflow}
        title="Room cockpit"
        actions={(
          <form onSubmit={handleSubmit} className="view-header__actions" aria-label="Load Room cockpit">
            <input
              id="room-cockpit-room-id"
              className="form-input"
              type="text"
              value={draftRoomId}
              onChange={(event) => setDraftRoomId(event.target.value)}
              placeholder="Room ID"
              aria-label="Room ID"
              disabled={!projectId}
            />
            <button type="submit" className="btn btn-sm btn-secondary" disabled={!projectId}>
              Load verified Room
            </button>
            <button type="button" className="btn btn-sm btn-secondary" onClick={onClose}>
              Back to workspace
            </button>
          </form>
        )}
      />
      <RoomCockpitView
        state={snapshot.state}
        projection={snapshot.projection}
        stateDetail={snapshot.detail}
        callbacks={{ onRefresh: () => void loadRoom(selectedRoomId) }}
      />
    </section>
  );
}

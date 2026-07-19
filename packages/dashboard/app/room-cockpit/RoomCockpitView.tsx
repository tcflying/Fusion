import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  ROOM_COCKPIT_COMPOSER_TARGET_MODES,
  RoomCockpitComposer,
  type RoomCockpitComposerDraftV1,
  type RoomCockpitComposerGroupV1,
  type RoomCockpitComposerParticipantV1,
  type RoomCockpitComposerSubmitResultV1,
  type RoomCockpitComposerTargetModeV1,
} from "./RoomCockpitComposer";
import {
  RoomCockpitAlertPanel,
  type RoomCockpitAlertActionCallbackResultV1,
  type RoomCockpitAlertActionRequestV1,
} from "./RoomCockpitAlertPanel";
import { RoomCockpitEvidencePanel } from "./RoomCockpitEvidencePanel";
import { RoomCockpitParticipantPanel } from "./RoomCockpitParticipantPanel";
import styles from "./RoomCockpitView.module.css";

export const ROOM_COCKPIT_TASK_STATES = [
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
] as const;

export type RoomCockpitTaskStateV1 = (typeof ROOM_COCKPIT_TASK_STATES)[number];
export type RoomCockpitHealthStateV1 = "healthy" | "degraded" | "critical" | "paused" | "unknown";
export type RoomCockpitConfidenceBandV1 = "high" | "medium" | "low" | "unknown";
export type RoomCockpitViewStateV1 = "loading" | "ready" | "empty" | "degraded" | "permission-denied";

export interface RoomCockpitHealthV1 {
  readonly state: RoomCockpitHealthStateV1;
  readonly detail: string;
}

export interface RoomCockpitCompletionV1 {
  readonly acceptedNodes: number;
  readonly total: number;
  readonly blockedNodes: number;
}

export interface RoomCockpitConfidenceDimensionV1 {
  readonly name: string;
  readonly band: RoomCockpitConfidenceBandV1;
  readonly rationale: string;
}

export interface RoomCockpitConfidenceV1 {
  readonly band: RoomCockpitConfidenceBandV1;
  readonly snapshotId: string;
  readonly dimensions: readonly RoomCockpitConfidenceDimensionV1[];
}

export type RoomCockpitCapacityStructuralFieldV1 =
  | "theoreticalSlots"
  | "configuredSlots"
  | "activeSlots"
  | "queueDepth"
  | "utilizationRatio";

export type RoomCockpitCapacityObservedFieldV1 =
  | "reservedVerifierSlots"
  | "reservedRecoverySlots"
  | "throughputPerMinute"
  | "idleReasons";

export interface RoomCockpitCapacityTelemetryUnavailableV1 {
  readonly availability: "unavailable";
  readonly detail: string;
  readonly structuralFields: readonly RoomCockpitCapacityStructuralFieldV1[];
  readonly observedFields: readonly RoomCockpitCapacityObservedFieldV1[];
}

export interface RoomCockpitCapacityTelemetryAvailableV1 {
  readonly availability: "available";
  readonly detail: string;
  readonly source: "persistent_runtime_telemetry";
  readonly observedAt: string;
  readonly structuralFields: readonly RoomCockpitCapacityStructuralFieldV1[];
  readonly observedFields: readonly RoomCockpitCapacityObservedFieldV1[];
}

export type RoomCockpitCapacityTelemetryV1 =
  | RoomCockpitCapacityTelemetryUnavailableV1
  | RoomCockpitCapacityTelemetryAvailableV1;

interface RoomCockpitCapacityStructuralV1 {
  readonly theoreticalSlots: number;
  readonly configuredSlots: number;
  readonly activeSlots: number;
  readonly queueDepth: number;
  readonly utilizationRatio: number;
}

export interface RoomCockpitIdleReasonV1 {
  readonly reason: string;
  readonly slots: number;
}

export interface RoomCockpitCapacityWithoutRuntimeTelemetryV1 extends RoomCockpitCapacityStructuralV1 {
  readonly telemetry: RoomCockpitCapacityTelemetryUnavailableV1;
  readonly reservedVerifierSlots: null;
  readonly reservedRecoverySlots: null;
  readonly throughputPerMinute: null;
  readonly idleReasons: null;
}

export interface RoomCockpitCapacityWithRuntimeTelemetryV1 extends RoomCockpitCapacityStructuralV1 {
  readonly telemetry: RoomCockpitCapacityTelemetryAvailableV1;
  readonly reservedVerifierSlots: number;
  readonly reservedRecoverySlots: number;
  readonly throughputPerMinute: number;
  readonly idleReasons: readonly RoomCockpitIdleReasonV1[];
}

export type RoomCockpitCapacityV1 =
  | RoomCockpitCapacityWithoutRuntimeTelemetryV1
  | RoomCockpitCapacityWithRuntimeTelemetryV1;

export interface RoomCockpitTaskNodeV1 {
  readonly id: string;
  readonly title: string;
  readonly state: RoomCockpitTaskStateV1;
  readonly ownerSeatId: string | null;
  readonly dependencyNodeIds: readonly string[];
  readonly critical: boolean;
  readonly attempt: number;
  readonly progressSignature: string | null;
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
  readonly gateIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly waitReason: string | null;
  readonly nextRecoveryAction: string | null;
}

export interface RoomCockpitTaskEdgeV1 {
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly kind: "depends_on" | "blocks" | "informs" | "invalidates";
}

export interface RoomCockpitAlertActionV1 {
  readonly id: string;
  readonly label: string;
  readonly requiresConfirmation: boolean;
}

export interface RoomCockpitAlertV1 {
  readonly id: string;
  readonly severity: "info" | "warning" | "severe" | "critical";
  readonly state: "open" | "acknowledged" | "resolved";
  readonly rootCause: string;
  readonly impact: string;
  readonly evidenceIds: readonly string[];
  readonly attemptedRecovery: readonly string[];
  readonly nextRetryAt: string | null;
  readonly actions: readonly RoomCockpitAlertActionV1[];
}

export interface RoomCockpitComposerSurfaceV1 {
  readonly participants: readonly RoomCockpitComposerParticipantV1[];
  readonly controllerSeatId?: string;
  readonly groups?: readonly RoomCockpitComposerGroupV1[];
  readonly initialTargetMode?: RoomCockpitComposerTargetModeV1;
  readonly initialGroupId?: string;
  readonly initialSelectedSeatIds?: readonly string[];
}

export interface RoomCockpitProjectionV1 {
  readonly roomId: string;
  readonly objective: string;
  readonly phase: string;
  readonly health: RoomCockpitHealthV1;
  readonly completion: RoomCockpitCompletionV1;
  readonly criticalPathNodeIds: readonly string[];
  readonly confidence: RoomCockpitConfidenceV1;
  readonly capacity: RoomCockpitCapacityV1;
  readonly tasks: readonly RoomCockpitTaskNodeV1[];
  readonly edges: readonly RoomCockpitTaskEdgeV1[];
  readonly alerts: readonly RoomCockpitAlertV1[];
  /** Raw projection feeds are validated again by their dedicated cockpit surfaces. */
  readonly participants?: readonly unknown[];
  readonly evidence?: unknown;
  readonly composer?: RoomCockpitComposerSurfaceV1;
  readonly actionableAlerts?: readonly unknown[];
}

export interface RoomCockpitViewCallbacksV1 {
  readonly onRefresh?: () => void;
  readonly onRequestAccess?: () => void;
  readonly onSelectTask?: (task: RoomCockpitTaskNodeV1) => void;
  readonly onGuardedComposerSubmit?: (
    draft: RoomCockpitComposerDraftV1,
  ) => Promise<RoomCockpitComposerSubmitResultV1> | RoomCockpitComposerSubmitResultV1;
  readonly onGuardedAlertAction?: (
    request: RoomCockpitAlertActionRequestV1,
  ) => Promise<RoomCockpitAlertActionCallbackResultV1> | RoomCockpitAlertActionCallbackResultV1;
}

export interface RoomCockpitViewProps {
  readonly state: RoomCockpitViewStateV1;
  readonly projection?: RoomCockpitProjectionV1;
  readonly stateDetail?: string;
  readonly callbacks?: RoomCockpitViewCallbacksV1;
}

interface RoomCockpitTaskColumnV1 {
  readonly depth: number;
  readonly tasks: readonly RoomCockpitTaskNodeV1[];
}

type RoomCockpitStyle = CSSProperties & {
  readonly "--room-cockpit-columns": string;
};

const taskStateLabels: Record<RoomCockpitTaskStateV1, string> = {
  ready: "ready",
  running: "running",
  waiting_dependency: "waiting dependency",
  waiting_approval: "waiting approval",
  rate_limited: "rate limited",
  failed: "failed",
  retrying: "retrying",
  accepted: "accepted",
  cancelled: "cancelled",
  blocked: "blocked",
};

const healthLabels: Record<RoomCockpitHealthStateV1, string> = {
  healthy: "healthy",
  degraded: "degraded",
  critical: "critical",
  paused: "paused",
  unknown: "unknown",
};

const confidenceLabels: Record<RoomCockpitConfidenceBandV1, string> = {
  high: "high",
  medium: "medium",
  low: "low",
  unknown: "unknown",
};

/**
 * FNXC:RoomCockpit 2026-07-19-15:25:
 * This is a projection-only operations slice: it renders only verified Room data
 * supplied by its caller, makes degraded/empty/permission states explicit, and
 * forwards operator intent without fabricating commands or self-approving alerts.
 * Task-first visibility, keyboard selection, critical-path diagnosis, capacity,
 * confidence, and mobile-safe controls remain available before a route owns it.
 */
export function RoomCockpitView({ state, projection, stateDetail, callbacks }: RoomCockpitViewProps) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  useEffect(() => {
    if (selectedTaskId && !projection?.tasks.some((task) => task.id === selectedTaskId)) {
      setSelectedTaskId(null);
    }
  }, [projection, selectedTaskId]);

  const tasksById = useMemo(
    () => new Map(projection?.tasks.map((task) => [task.id, task]) ?? []),
    [projection?.tasks],
  );
  const taskColumns = useMemo(
    () => buildTaskColumns(projection?.tasks ?? [], tasksById),
    [projection?.tasks, tasksById],
  );
  const selectedTask = selectedTaskId ? tasksById.get(selectedTaskId) ?? null : null;

  if (state === "loading") {
    return <RoomCockpitLoadingState />;
  }

  if (state === "empty" || (state === "ready" && !projection)) {
    return <RoomCockpitStaticState
      state="empty"
      title="No Room projection yet"
      detail={stateDetail ?? "The cockpit has not received a verified Room projection."}
      actionLabel="Refresh Room telemetry"
      onAction={callbacks?.onRefresh}
    />;
  }

  if (state === "permission-denied") {
    return <RoomCockpitStaticState
      state="permission-denied"
      title="Room access is restricted"
      detail={stateDetail ?? "This Room remains protected until an authorized operator grants access."}
      actionLabel="Request Room access"
      onAction={callbacks?.onRequestAccess}
    />;
  }

  if (!projection) {
    return <RoomCockpitStaticState
      state="degraded"
      title="Telemetry degraded"
      detail={stateDetail ?? "A verified Room projection is unavailable while the live stream recovers."}
      actionLabel="Refresh Room telemetry"
      onAction={callbacks?.onRefresh}
    />;
  }

  const acceptedRatio = projection.completion.total > 0
    ? projection.completion.acceptedNodes / projection.completion.total
    : 0;
  const activeRatio = projection.capacity.configuredSlots > 0
    ? projection.capacity.activeSlots / projection.capacity.configuredSlots
    : 0;
  const cockpitStyle: RoomCockpitStyle = {
    "--room-cockpit-columns": String(Math.max(taskColumns.length, 1)),
  };
  const composer = parseRoomCockpitComposerSurface(projection.composer);
  const observedCapacity = getObservedCapacityTelemetry(projection.capacity);
  const capacityTelemetryState = observedCapacity !== null
    ? "available"
    : projection.capacity.telemetry.availability === "unavailable"
      ? "unavailable"
      : "withheld";
  const capacityTelemetryDetail = observedCapacity !== null
    ? capacityTelemetryDetailOrFallback(
      observedCapacity.telemetry.detail,
      "Persistent runtime telemetry is available for this Room.",
    )
    : projection.capacity.telemetry.availability === "unavailable"
      ? capacityTelemetryDetailOrFallback(
        projection.capacity.telemetry.detail,
        "The Room projection marked persistent runtime capacity telemetry unavailable.",
      )
      : "Observed capacity telemetry was withheld because the available payload did not satisfy the telemetry boundary.";

  const composerUnavailableReason = projection.composer === undefined
    ? "No verified composer targeting data has been projected for this Room."
    : composer === null
      ? "Composer target data was withheld because it does not satisfy the guarded composer boundary."
      : "No guarded draft delivery callback is connected for this Room.";

  return (
    <main className={styles.root} data-state={state} aria-label={`Room cockpit for ${projection.roomId}`}>
      <header className={styles.commandHeader}>
        <div className={styles.commandIdentity}>
          <p className={styles.eyebrow}>Room operations / live projection</p>
          <h1 className={styles.roomId}>Room / {projection.roomId}</h1>
          <p className={styles.objective}>{projection.objective}</p>
        </div>
        <div className={styles.commandStatus} aria-label="Current Room status">
          <span className={styles.statusLamp} data-health={projection.health.state} aria-hidden="true" />
          <div>
            <span className={styles.statusLabel}>Health</span>
            <strong>{healthLabels[projection.health.state]}</strong>
            <span className={styles.statusDetail}>{projection.health.detail}</span>
          </div>
        </div>
        <div className={styles.phaseReadout}>
          <span className={styles.statusLabel}>Protocol phase</span>
          <strong>{projection.phase}</strong>
          <span>Critical path: {projection.criticalPathNodeIds.length} node{projection.criticalPathNodeIds.length === 1 ? "" : "s"}</span>
        </div>
      </header>

      {state === "degraded" ? (
        <div className={styles.degradedNotice} role="alert">
          <strong>Telemetry degraded</strong>
          <span>{stateDetail ?? projection.health.detail}</span>
          {callbacks?.onRefresh ? (
            <button type="button" className={styles.noticeAction} onClick={callbacks.onRefresh}>
              Refresh Room telemetry
            </button>
          ) : null}
        </div>
      ) : null}

      <section className={styles.signalTape} aria-label="Room operating signals">
        <SignalReadout
          label="Completion"
          value={`${projection.completion.acceptedNodes} / ${projection.completion.total} accepted`}
          detail={`${projection.completion.blockedNodes} blocked`}
          meterLabel="Room completion"
          meterValue={acceptedRatio}
          tone="completion"
        />
        <SignalReadout
          label="Confidence"
          value={confidenceLabels[projection.confidence.band]}
          detail={projection.confidence.snapshotId}
          tone={`confidence-${projection.confidence.band}`}
        />
        <SignalReadout
          label="Capacity"
          value={`${projection.capacity.activeSlots} / ${projection.capacity.configuredSlots} active slots`}
          detail={observedCapacity !== null
            ? `${projection.capacity.queueDepth} queued · ${formatThroughput(observedCapacity.throughputPerMinute)}`
            : `${projection.capacity.queueDepth} queued · capacity telemetry ${capacityTelemetryState}`}
          meterLabel="Active configured capacity"
          meterValue={activeRatio}
          tone="capacity"
        />
      </section>

      <div className={styles.operationsGrid}>
        <section className={styles.graphPanel} aria-labelledby="room-cockpit-dag-title">
          <div className={styles.panelHeading}>
            <div>
              <p className={styles.panelKicker}>Dependency topology</p>
              <h2 id="room-cockpit-dag-title">Task graph</h2>
            </div>
            <span className={styles.panelCounter}>{projection.tasks.length} nodes / {projection.edges.length} links</span>
          </div>

          <div className={styles.dagViewport}>
            <ol className={styles.dagColumns} style={cockpitStyle} aria-label="Interactive Room task DAG">
              {taskColumns.map((column) => (
                <li className={styles.dagColumn} key={`depth-${column.depth}`}>
                  <span className={styles.columnMarker}>Stage {column.depth + 1}</span>
                  <ol className={styles.nodeStack}>
                    {column.tasks.map((task) => (
                      <li key={task.id} className={styles.nodeItem}>
                        <button
                          type="button"
                          className={styles.taskNode}
                          data-task-state={task.state}
                          data-critical={task.critical ? "true" : "false"}
                          aria-label={`Task ${task.title}, ${taskStateLabels[task.state]}${task.critical ? ", critical path" : ""}`}
                          aria-pressed={selectedTask?.id === task.id}
                          onClick={() => {
                            setSelectedTaskId(task.id);
                            callbacks?.onSelectTask?.(task);
                          }}
                        >
                          <span className={styles.nodeState}>{taskStateLabels[task.state]}</span>
                          <strong>{task.title}</strong>
                          <span className={styles.nodeMeta}>
                            {task.ownerSeatId ?? "unassigned"} · attempt {task.attempt}
                          </span>
                          {task.dependencyNodeIds.length > 0 ? (
                            <span className={styles.nodeDependency}>
                              ← {task.dependencyNodeIds.map((id) => tasksById.get(id)?.title ?? id).join(" · ")}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ol>
          </div>

          <ul className={styles.edgeLedger} aria-label="Task dependency links">
            {projection.edges.length > 0 ? projection.edges.map((edge) => (
              <li key={edge.id}>
                <span>{tasksById.get(edge.fromNodeId)?.title ?? edge.fromNodeId} → {tasksById.get(edge.toNodeId)?.title ?? edge.toNodeId}</span>
                <small>{edge.kind.replaceAll("_", " ")}</small>
              </li>
            )) : <li className={styles.edgeLedgerEmpty}>No verified dependency links reported.</li>}
          </ul>
        </section>

        <aside className={styles.detailPanel} aria-labelledby="room-cockpit-detail-title" aria-live="polite">
          <div className={styles.panelHeading}>
            <div>
              <p className={styles.panelKicker}>Selected work unit</p>
              <h2 id="room-cockpit-detail-title">Node detail</h2>
            </div>
          </div>
          {selectedTask ? (
            <TaskDetail task={selectedTask} tasksById={tasksById} />
          ) : (
            <p className={styles.detailPlaceholder}>Select a task node to inspect its owner, evidence, gates, and recovery boundary.</p>
          )}
        </aside>
      </div>

      <div className={styles.intelligenceGrid}>
        <section className={styles.confidencePanel} aria-labelledby="room-cockpit-confidence-title">
          <div className={styles.panelHeading}>
            <div>
              <p className={styles.panelKicker}>Evidence posture</p>
              <h2 id="room-cockpit-confidence-title">Confidence ledger</h2>
            </div>
            <span className={styles.bandBadge} data-band={projection.confidence.band}>{confidenceLabels[projection.confidence.band]}</span>
          </div>
          <ul className={styles.dimensionList}>
            {projection.confidence.dimensions.length > 0 ? projection.confidence.dimensions.map((dimension) => (
              <li key={dimension.name}>
                <span className={styles.dimensionBand} data-band={dimension.band}>{confidenceLabels[dimension.band]}</span>
                <div>
                  <strong>{dimension.name}</strong>
                  <p>{dimension.rationale}</p>
                </div>
              </li>
            )) : <li className={styles.dimensionEmpty}>No confidence dimensions have been projected.</li>}
          </ul>
        </section>

        <section className={styles.capacityPanel} aria-labelledby="room-cockpit-capacity-title">
          <div className={styles.panelHeading}>
            <div>
              <p className={styles.panelKicker}>Dispatch envelope</p>
              <h2 id="room-cockpit-capacity-title">Capacity ledger</h2>
            </div>
            <span className={styles.capacityRate}>{formatPercent(projection.capacity.utilizationRatio)} structural</span>
          </div>
          <section
            className={styles.capacityTelemetryState}
            data-availability={capacityTelemetryState}
            aria-label={`Runtime capacity telemetry ${capacityTelemetryState}`}
            role="status"
          >
            <p className={styles.capacityTelemetryKicker}>Runtime observation / {capacityTelemetryState}</p>
            <strong>{observedCapacity !== null
              ? "Observed runtime capacity"
              : capacityTelemetryState === "unavailable"
                ? "Runtime capacity telemetry unavailable"
                : "Observed capacity telemetry withheld"}
            </strong>
            <p>{capacityTelemetryDetail}</p>
            {observedCapacity !== null ? (
              <dl className={styles.capacityTelemetryFacts}>
                <div><dt>Source</dt><dd>Persistent runtime telemetry</dd></div>
                <div><dt>Observed at</dt><dd>{observedCapacity.telemetry.observedAt}</dd></div>
              </dl>
            ) : null}
          </section>
          <dl className={styles.capacityList}>
            <div><dt>Theoretical</dt><dd>{projection.capacity.theoreticalSlots}</dd></div>
            <div><dt>Configured</dt><dd>{projection.capacity.configuredSlots}</dd></div>
            <div><dt>Verifier reserve</dt><dd>{observedCapacity?.reservedVerifierSlots ?? "Unavailable"}</dd></div>
            <div><dt>Recovery reserve</dt><dd>{observedCapacity?.reservedRecoverySlots ?? "Unavailable"}</dd></div>
          </dl>
          <ul className={styles.idleReasons}>
            {observedCapacity === null ? <li className={styles.capacityUnavailableItem}>Idle-capacity reasons are unavailable.</li>
              : observedCapacity.idleReasons.length > 0 ? observedCapacity.idleReasons.map((reason) => (
                <li key={`${reason.reason}-${reason.slots}`}><strong>{reason.slots}</strong> {reason.reason.replaceAll("_", " ")}</li>
              )) : <li>No observed idle-capacity reasons were reported.</li>}
          </ul>
        </section>

        <RoomCockpitAlertPanel
          alerts={projection.actionableAlerts}
          onAction={callbacks?.onGuardedAlertAction}
        />
      </div>

      <div className={styles.supplementalGrid}>
        <div className={styles.participantSurface}>
          <RoomCockpitParticipantPanel participants={projection.participants} />
        </div>
        <RoomCockpitEvidencePanel evidence={projection.evidence} />
      </div>

      <div className={styles.composerSurface}>
        {composer !== null && callbacks?.onGuardedComposerSubmit ? (
          <RoomCockpitComposer {...composer} onGuardedSubmit={callbacks.onGuardedComposerSubmit} />
        ) : <RoomCockpitComposerUnavailable reason={composerUnavailableReason} />}
      </div>
    </main>
  );
}

/**
 * FNXC:RoomCockpitWiring 2026-07-19-16:50:
 * The cockpit can render standalone participant, evidence, alert, and composer
 * surfaces only from caller-supplied projections. Do not derive identities,
 * targets, evidence, or a delivery callback from the legacy summary projection:
 * absent or malformed data stays visibly unavailable/withheld, and the composer
 * never mounts without an external guarded-delivery boundary.
 */
function parseRoomCockpitComposerSurface(value: unknown): RoomCockpitComposerSurfaceV1 | null {
  if (!isRecord(value) || !Array.isArray(value.participants)) return null;
  if (value.controllerSeatId !== undefined && typeof value.controllerSeatId !== "string") return null;
  if (value.groups !== undefined && !Array.isArray(value.groups)) return null;
  if (value.initialGroupId !== undefined && typeof value.initialGroupId !== "string") return null;
  if (
    value.initialSelectedSeatIds !== undefined
    && (!Array.isArray(value.initialSelectedSeatIds) || !value.initialSelectedSeatIds.every((seatId) => typeof seatId === "string"))
  ) return null;
  if (
    value.initialTargetMode !== undefined
    && (!isComposerTargetMode(value.initialTargetMode))
  ) return null;

  return {
    participants: value.participants as readonly RoomCockpitComposerParticipantV1[],
    ...(typeof value.controllerSeatId === "string" ? { controllerSeatId: value.controllerSeatId } : {}),
    ...(Array.isArray(value.groups) ? { groups: value.groups as readonly RoomCockpitComposerGroupV1[] } : {}),
    ...(isComposerTargetMode(value.initialTargetMode) ? { initialTargetMode: value.initialTargetMode } : {}),
    ...(typeof value.initialGroupId === "string" ? { initialGroupId: value.initialGroupId } : {}),
    ...(Array.isArray(value.initialSelectedSeatIds)
      ? { initialSelectedSeatIds: value.initialSelectedSeatIds as readonly string[] }
      : {}),
  };
}

function isComposerTargetMode(value: unknown): value is RoomCockpitComposerTargetModeV1 {
  return typeof value === "string"
    && (ROOM_COCKPIT_COMPOSER_TARGET_MODES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * FNXC:RoomCockpitCapacityTelemetry 2026-07-19-17:00:
 * Observed capacity is not inferred from the structural projection. The Engine
 * discriminant is the authority: only a complete `available` runtime-telemetry
 * payload reaches observed reserve, throughput, or idle-reason readouts.
 */
function getObservedCapacityTelemetry(
  capacity: RoomCockpitCapacityV1,
): RoomCockpitCapacityWithRuntimeTelemetryV1 | null {
  return hasObservedCapacityTelemetry(capacity) ? capacity : null;
}

function hasObservedCapacityTelemetry(
  capacity: RoomCockpitCapacityV1,
): capacity is RoomCockpitCapacityWithRuntimeTelemetryV1 {
  if (capacity.telemetry.availability !== "available") return false;
  if (
    capacity.telemetry.source !== "persistent_runtime_telemetry"
    || typeof capacity.telemetry.observedAt !== "string"
    || !isFiniteNumber(capacity.reservedVerifierSlots)
    || !isFiniteNumber(capacity.reservedRecoverySlots)
    || !isFiniteNumber(capacity.throughputPerMinute)
    || !Array.isArray(capacity.idleReasons)
    || !capacity.idleReasons.every(isCapacityIdleReason)
  ) {
    return false;
  }

  return true;
}

function isCapacityIdleReason(value: unknown): value is RoomCockpitIdleReasonV1 {
  return isRecord(value) && typeof value.reason === "string" && isFiniteNumber(value.slots);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function capacityTelemetryDetailOrFallback(detail: unknown, fallback: string): string {
  return typeof detail === "string" && detail.trim().length > 0 ? detail : fallback;
}

function RoomCockpitComposerUnavailable({ reason }: { readonly reason: string }) {
  return (
    <section className={styles.composerUnavailable} aria-labelledby="room-cockpit-composer-unavailable-title" role="status">
      <p className={styles.composerUnavailableKicker}>Guarded handoff / unavailable</p>
      <h2 id="room-cockpit-composer-unavailable-title">Draft composer unavailable</h2>
      <p>{reason}</p>
    </section>
  );
}

function RoomCockpitLoadingState() {
  return (
    <main className={styles.staticState} data-state="loading" aria-label="Room cockpit loading" aria-busy="true">
      <div className={styles.loadingGrid} aria-hidden="true">
        <span /><span /><span /><span /><span /><span />
      </div>
      <div className={styles.staticCopy} role="status">
        <p className={styles.eyebrow}>Room operations / event cursor pending</p>
        <h1>Loading Room telemetry</h1>
        <p>Waiting for a verified projection before presenting operational state.</p>
      </div>
    </main>
  );
}

function RoomCockpitStaticState({
  state,
  title,
  detail,
  actionLabel,
  onAction,
}: {
  readonly state: Exclude<RoomCockpitViewStateV1, "loading" | "ready">;
  readonly title: string;
  readonly detail: string;
  readonly actionLabel: string;
  readonly onAction: (() => void) | undefined;
}) {
  const alert = state === "permission-denied" || state === "degraded";
  return (
    <main className={styles.staticState} data-state={state} aria-label="Room cockpit state">
      <div className={styles.staticCopy} {...(alert ? { role: "alert" } : { role: "status" })}>
        <p className={styles.eyebrow}>Room operations / verified boundary</p>
        <h1>{title}</h1>
        <p>{detail}</p>
        {onAction ? <button type="button" className={styles.staticAction} onClick={onAction}>{actionLabel}</button> : null}
      </div>
    </main>
  );
}

function SignalReadout({
  label,
  value,
  detail,
  meterLabel,
  meterValue,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly meterLabel?: string;
  readonly meterValue?: number;
  readonly tone: string;
}) {
  return (
    <div className={styles.signalReadout} data-tone={tone}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
      {meterLabel !== undefined && meterValue !== undefined ? (
        <meter className={styles.signalMeter} aria-label={meterLabel} min={0} max={1} value={clampRatio(meterValue)} />
      ) : null}
    </div>
  );
}

function TaskDetail({ task, tasksById }: { readonly task: RoomCockpitTaskNodeV1; readonly tasksById: ReadonlyMap<string, RoomCockpitTaskNodeV1> }) {
  return (
    <div className={styles.detailBody}>
      <div className={styles.detailTitleRow}>
        <span className={styles.nodeState} data-task-state={task.state}>{taskStateLabels[task.state]}</span>
        {task.critical ? <span className={styles.criticalFlag}>critical path</span> : null}
      </div>
      <h3>{task.title}</h3>
      <dl className={styles.detailFacts}>
        <div><dt>Owner</dt><dd>{task.ownerSeatId ?? "Unassigned"}</dd></div>
        <div><dt>Attempt</dt><dd>{task.attempt}</dd></div>
        <div><dt>Progress</dt><dd>{task.progressSignature ?? "No verified progress signature"}</dd></div>
        <div><dt>Dependencies</dt><dd>{task.dependencyNodeIds.length > 0 ? task.dependencyNodeIds.map((id) => tasksById.get(id)?.title ?? id).join(" · ") : "None"}</dd></div>
      </dl>
      <DetailList label="Inputs" values={task.inputs} />
      <DetailList label="Outputs" values={task.outputs} />
      <DetailList label="Hard gates" values={task.gateIds} />
      <DetailList label="Evidence" values={task.evidenceIds} />
      {task.waitReason ? <p className={styles.waitReason}><strong>Wait</strong>{task.waitReason}</p> : null}
      {task.nextRecoveryAction ? <p className={styles.recoveryAction}><strong>Recovery boundary</strong>{task.nextRecoveryAction}</p> : null}
    </div>
  );
}

function DetailList({ label, values }: { readonly label: string; readonly values: readonly string[] }) {
  return (
    <section className={styles.detailList} aria-label={label}>
      <h4>{label}</h4>
      {values.length > 0 ? <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul> : <p>None reported.</p>}
    </section>
  );
}

function buildTaskColumns(
  tasks: readonly RoomCockpitTaskNodeV1[],
  tasksById: ReadonlyMap<string, RoomCockpitTaskNodeV1>,
): readonly RoomCockpitTaskColumnV1[] {
  const cachedDepths = new Map<string, number>();
  const visiting = new Set<string>();
  const columns = new Map<number, RoomCockpitTaskNodeV1[]>();

  for (const task of tasks) {
    const depth = resolveTaskDepth(task.id, tasksById, cachedDepths, visiting);
    const column = columns.get(depth) ?? [];
    column.push(task);
    columns.set(depth, column);
  }

  return [...columns.entries()]
    .sort(([left], [right]) => left - right)
    .map(([depth, column]) => ({ depth, tasks: column }));
}

function resolveTaskDepth(
  taskId: string,
  tasksById: ReadonlyMap<string, RoomCockpitTaskNodeV1>,
  cachedDepths: Map<string, number>,
  visiting: Set<string>,
): number {
  const cached = cachedDepths.get(taskId);
  if (cached !== undefined) return cached;
  if (visiting.has(taskId)) return 0;

  const task = tasksById.get(taskId);
  if (!task) return 0;

  visiting.add(taskId);
  let depth = 0;
  for (const dependencyId of task.dependencyNodeIds) {
    if (tasksById.has(dependencyId)) {
      depth = Math.max(depth, resolveTaskDepth(dependencyId, tasksById, cachedDepths, visiting) + 1);
    }
  }
  visiting.delete(taskId);
  cachedDepths.set(taskId, depth);
  return depth;
}

function clampRatio(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
}

function formatPercent(value: number): string {
  return `${Math.round(clampRatio(value) * 100)}%`;
}

function formatThroughput(value: number): string {
  return `${value.toFixed(1)} / min`;
}

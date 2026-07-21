import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  ROOM_COCKPIT_COMPOSER_TARGET_MODES,
  type RoomCockpitComposerGroupV1,
  type RoomCockpitComposerParticipantV1,
  type RoomCockpitComposerTargetModeV1,
} from "./RoomCockpitComposer";
import { RoomCockpitAlertPanel } from "./RoomCockpitAlertPanel";
import { RoomCockpitEvidencePanel } from "./RoomCockpitEvidencePanel";
import { RoomCockpitParticipantPanel } from "./RoomCockpitParticipantPanel";
import type { RoomCockpitLiveEventProvenanceV1 } from "./roomCockpitLiveEvents";
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
export type RoomCockpitExecutionStateV1 =
  | "not_started"
  | "starting"
  | "not_enabled"
  | "read_only_withheld"
  | "execution_started"
  | "stopping"
  | "stopped"
  | "startup_failed";

export interface RoomCockpitExecutionStatusV1 {
  readonly contractVersion: 1;
  readonly projectId: string;
  readonly state: RoomCockpitExecutionStateV1;
  readonly reasonCodes: readonly string[];
  readonly changedAt: string;
  readonly readServiceAvailable: boolean;
  readonly liveEventServiceAvailable: boolean;
  readonly controllerStarted: boolean;
}

export type RoomCockpitExecutionSurfaceV1 =
  | {
    readonly state: "loading" | "unavailable" | "permission-denied";
    readonly detail: string;
  }
  | {
    readonly state: "available";
    readonly detail: string;
    readonly status: RoomCockpitExecutionStatusV1;
  };

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
}

export interface RoomCockpitViewProps {
  readonly state: RoomCockpitViewStateV1;
  readonly projection?: RoomCockpitProjectionV1;
  readonly stateDetail?: string;
  /** Project-scoped controller lifecycle only; it never certifies provider health. */
  readonly execution?: RoomCockpitExecutionSurfaceV1;
  /** Last safe causal pointer observed from the current Room SSE stream. */
  readonly liveEventProvenance?: RoomCockpitLiveEventProvenanceV1 | null;
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

const executionStateLabels: Record<RoomCockpitExecutionStateV1, string> = {
  not_started: "not started",
  starting: "starting",
  not_enabled: "not enabled",
  read_only_withheld: "read-only withheld",
  execution_started: "controller started",
  stopping: "stopping",
  stopped: "stopped",
  startup_failed: "startup failed",
};

/**
 * FNXC:RoomCockpit 2026-07-19-15:25:
 * This is a projection-only operations slice: it renders only verified Room data
 * supplied by its caller, makes degraded/empty/permission states explicit, and
 * forwards operator intent without fabricating commands or self-approving alerts.
 * Task-first visibility, keyboard selection, critical-path diagnosis, capacity,
 * confidence, and mobile-safe controls remain available before a route owns it.
 */
export function RoomCockpitView({
  state,
  projection,
  stateDetail,
  execution,
  liveEventProvenance,
  callbacks,
}: RoomCockpitViewProps) {
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
  /*
   * FNXC:RoomCockpitStructuralTelemetry 2026-07-20-21:49:
   * The current production composition does not supply a verified runtime
   * telemetry sink. Keep graph counts visibly structural and withhold capacity,
   * process, crash, wait, and recovery claims until that evidence exists.
   */
  const capacityTelemetryState = "unavailable";
  const capacityTelemetryDetail = "No production runtime capacity observation is connected to this Cockpit. Structural graph counts are not capacity, process, crash, wait, or recovery telemetry.";

  const composerUnavailableReason = projection.composer === undefined
    ? "No verified composer targeting data has been projected for this Room."
    : composer === null
      ? "Composer target data was withheld because it does not satisfy the guarded composer boundary."
      : "Draft delivery is intentionally unavailable in this structural Cockpit until a verified command execution receipt exists.";

  return (
    <main className={styles.root} data-state={state} aria-label={`Room cockpit for ${projection.roomId}`}>
      <header className={styles.commandHeader}>
        <div className={styles.commandIdentity}>
          <p className={styles.eyebrow}>Room control plane / canonical structural projection</p>
          <h1 className={styles.roomId}>Room / {projection.roomId}</h1>
          <p className={styles.objective}>{projection.objective}</p>
        </div>
        <div className={styles.commandStatus} aria-label="Current Room status">
          <span className={styles.statusLamp} data-health={projection.health.state} aria-hidden="true" />
          <div>
            <span className={styles.statusLabel}>Projection status</span>
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

      {execution ? <RoomCockpitExecutionPanel execution={execution} /> : null}
      {liveEventProvenance ? <RoomCockpitEventProvenancePanel provenance={liveEventProvenance} /> : null}

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

      <section className={styles.signalTape} aria-label="Room structural signals">
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
          label="Structural task graph"
          value={`${projection.capacity.activeSlots} running task nodes / ${projection.capacity.configuredSlots} attached bindings`}
          detail={`${projection.capacity.queueDepth} pending graph nodes · runtime capacity telemetry ${capacityTelemetryState}`}
          meterLabel="Structural running task node ratio"
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
              <p className={styles.panelKicker}>Canonical task topology</p>
              <h2 id="room-cockpit-capacity-title">Structural allocation ledger</h2>
            </div>
            <span className={styles.capacityRate}>{formatPercent(projection.capacity.utilizationRatio)} graph ratio</span>
          </div>
          <section
            className={styles.capacityTelemetryState}
            data-availability={capacityTelemetryState}
            aria-label={`Runtime capacity telemetry ${capacityTelemetryState}`}
            role="status"
          >
            <p className={styles.capacityTelemetryKicker}>Runtime observation / unavailable</p>
            <strong>Runtime capacity telemetry unavailable</strong>
            <p>{capacityTelemetryDetail}</p>
          </section>
          <dl className={styles.capacityList}>
            <div><dt>Declared task-node scale</dt><dd>{projection.capacity.theoreticalSlots}</dd></div>
            <div><dt>Attached bindings</dt><dd>{projection.capacity.configuredSlots}</dd></div>
            <div><dt>Runtime verifier reserve</dt><dd>Unavailable</dd></div>
            <div><dt>Runtime recovery reserve</dt><dd>Unavailable</dd></div>
          </dl>
          <ul className={styles.idleReasons}>
            <li className={styles.capacityUnavailableItem}>Runtime wait and recovery observations are unavailable.</li>
          </ul>
        </section>

        <RoomCockpitAlertPanel
          alerts={projection.actionableAlerts}
        />
      </div>

      <div className={styles.supplementalGrid}>
        <div className={styles.participantSurface}>
          <RoomCockpitParticipantPanel participants={projection.participants} />
        </div>
        <RoomCockpitEvidencePanel evidence={projection.evidence} />
      </div>

      <div className={styles.composerSurface}>
        <RoomCockpitComposerUnavailable reason={composerUnavailableReason} />
      </div>
    </main>
  );
}

/*
 * FNXC:RoomCockpitExecutionStatus 2026-07-20-21:49:
 * The Cockpit presents the authorized controller lifecycle independently from
 * Room health and capacity. `execution_started` means the fenced controller
 * began its lifecycle, not that a Windows process/PID is live, crash-free, or
 * that a provider, model, account, quota, or Session is healthy.
 */
function RoomCockpitExecutionPanel({ execution }: { readonly execution: RoomCockpitExecutionSurfaceV1 }) {
  const status = execution.state === "available" ? execution.status : null;
  const label = status ? executionStateLabels[status.state] : execution.state.replaceAll("-", " ");

  return (
    <section
      className={styles.executionPanel}
      data-execution-state={status?.state ?? execution.state}
      aria-label="Room execution control-plane status"
      role="status"
    >
      <div className={styles.executionIdentity}>
        <p>Control-plane lifecycle</p>
        <strong>{label}</strong>
        <span>{execution.detail}</span>
      </div>
      {status ? (
        <>
          <dl className={styles.executionFacts}>
            <div><dt>Read service</dt><dd>{status.readServiceAvailable ? "available" : "withheld"}</dd></div>
            <div><dt>Live events</dt><dd>{status.liveEventServiceAvailable ? "available" : "withheld"}</dd></div>
            <div><dt>Engine controller lifecycle</dt><dd>{status.controllerStarted ? "started" : "not started"}</dd></div>
            <div><dt>Changed</dt><dd>{status.changedAt}</dd></div>
          </dl>
          <div className={styles.executionReasons} aria-label="Execution reason codes">
            {status.reasonCodes.length > 0
              ? status.reasonCodes.map((reason) => <code key={reason}>{reason}</code>)
              : <span>No lifecycle withholding reason was reported.</span>}
          </div>
        </>
      ) : null}
      <p className={styles.executionBoundary}>Lifecycle evidence only — not Windows process, PID, or crash-liveness evidence; provider, model, account, quota, and session health are not certified here.</p>
    </section>
  );
}

function RoomCockpitEventProvenancePanel({
  provenance,
}: {
  readonly provenance: RoomCockpitLiveEventProvenanceV1;
}) {
  return (
    <section className={styles.executionPanel} aria-label="Last observed Room event provenance" role="status">
      <div className={styles.executionIdentity}>
        <p>Canonical event provenance</p>
        <strong>{provenance.type}</strong>
        <span>Bounded causal metadata only; event body and provider diagnostics are not retained.</span>
      </div>
      <dl className={styles.executionFacts}>
        <div><dt>Cursor</dt><dd>{provenance.cursor}</dd></div>
        <div><dt>Event</dt><dd>{provenance.eventId}</dd></div>
        <div><dt>Occurred</dt><dd>{provenance.occurredAt}</dd></div>
        <div><dt>Correlation</dt><dd>{provenance.correlationId}</dd></div>
        <div><dt>Causation</dt><dd>{provenance.causationId ?? "No causation recorded"}</dd></div>
      </dl>
    </section>
  );
}

/**
 * FNXC:RoomCockpitUnsupportedActions 2026-07-20-21:49:
 * This structural Cockpit can show supplied participant, evidence, alert, and
 * composer facts, but it must not turn any callback into a provider send,
 * cancel, pause, retry, or recovery command. Keep composer and alert controls
 * unavailable until a target runtime proves command receipt and execution.
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
      {task.waitReason ? <p className={styles.waitReason}><strong>Graph dependency note</strong>{task.waitReason}</p> : null}
      {task.nextRecoveryAction ? <p className={styles.recoveryAction}><strong>Recorded next step (not executed)</strong>{task.nextRecoveryAction}</p> : null}
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

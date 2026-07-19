import styles from "./RoomCockpitParticipantPanel.module.css";

export const ROOM_COCKPIT_HEARTBEAT_FRESHNESS = [
  "fresh",
  "stale",
  "lost",
  "recovering",
  "unknown",
] as const;

export const ROOM_COCKPIT_LEASE_STATES = [
  "held",
  "available",
  "releasing",
  "expired",
  "unknown",
] as const;

export type RoomCockpitHeartbeatFreshnessV1 = (typeof ROOM_COCKPIT_HEARTBEAT_FRESHNESS)[number];
export type RoomCockpitLeaseStateV1 = (typeof ROOM_COCKPIT_LEASE_STATES)[number];

export interface RoomCockpitParticipantLeaseV1 {
  readonly state: RoomCockpitLeaseStateV1;
  readonly holderId: string | null;
  readonly expiresAt: string | null;
}

export interface RoomCockpitParticipantV1 {
  readonly seatId: string;
  readonly bindingId: string;
  readonly nativeSessionId: string | null;
  readonly happierSessionId: string | null;
  readonly role: string;
  readonly provider: string;
  readonly model: string;
  readonly host: string;
  readonly heartbeat: {
    readonly freshness: RoomCockpitHeartbeatFreshnessV1;
    readonly lastObservedAt: string | null;
    readonly recoveryOwner: string | null;
  };
  readonly context: {
    readonly usedTokens: number;
    readonly limitTokens: number;
  };
  readonly throughput: {
    readonly eventsPerMinute: number;
  };
  readonly limits: {
    readonly configuredConcurrent: number;
    readonly effectiveConcurrent: number;
  };
  readonly wait: {
    readonly reason: string | null;
    readonly retryAt: string | null;
  };
  readonly leases: {
    readonly sender: RoomCockpitParticipantLeaseV1;
    readonly workspace: RoomCockpitParticipantLeaseV1;
  };
}

export interface RoomCockpitParticipantPanelProps {
  /**
   * This intentionally accepts raw projection entries. The panel is a defensive
   * display boundary and verifies every field before it reaches the cockpit.
   */
  readonly participants?: readonly unknown[];
}

interface NormalizedLease {
  readonly state: RoomCockpitLeaseStateV1 | null;
  readonly holderId: string | null;
}

interface NormalizedParticipant {
  readonly seatId: string | null;
  readonly bindingId: string | null;
  readonly nativeSessionId: string | null;
  readonly happierSessionId: string | null;
  readonly role: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly host: string | null;
  readonly heartbeatFreshness: RoomCockpitHeartbeatFreshnessV1;
  readonly lastObservedAt: string | null;
  readonly recoveryOwner: string | null;
  readonly contextUsedTokens: number | null;
  readonly contextLimitTokens: number | null;
  readonly throughputEventsPerMinute: number | null;
  readonly configuredConcurrent: number | null;
  readonly effectiveConcurrent: number | null;
  readonly waitReason: string | null;
  readonly waitReasonRecorded: boolean;
  readonly retryAt: string | null;
  readonly retryRecorded: boolean;
  readonly senderLease: NormalizedLease;
  readonly workspaceLease: NormalizedLease;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readTimestamp(value: unknown): string | null {
  const timestamp = readText(value);
  return timestamp !== null && ISO_TIMESTAMP.test(timestamp) && Number.isFinite(Date.parse(timestamp)) ? timestamp : null;
}

function readNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function readHeartbeatFreshness(value: unknown): RoomCockpitHeartbeatFreshnessV1 {
  return typeof value === "string" && (ROOM_COCKPIT_HEARTBEAT_FRESHNESS as readonly string[]).includes(value)
    ? value as RoomCockpitHeartbeatFreshnessV1
    : "unknown";
}

function readLeaseState(value: unknown): RoomCockpitLeaseStateV1 | null {
  return typeof value === "string" && (ROOM_COCKPIT_LEASE_STATES as readonly string[]).includes(value)
    ? value as RoomCockpitLeaseStateV1
    : null;
}

function normalizeLease(value: unknown): NormalizedLease {
  const lease = isRecord(value) ? value : null;
  return {
    state: readLeaseState(lease?.state),
    holderId: readText(lease?.holderId),
  };
}

function normalizeParticipant(value: unknown): NormalizedParticipant {
  const participant = isRecord(value) ? value : {};
  const heartbeat = isRecord(participant.heartbeat) ? participant.heartbeat : {};
  const context = isRecord(participant.context) ? participant.context : {};
  const throughput = isRecord(participant.throughput) ? participant.throughput : {};
  const limits = isRecord(participant.limits) ? participant.limits : {};
  const wait = isRecord(participant.wait) ? participant.wait : null;
  const leases = isRecord(participant.leases) ? participant.leases : {};

  return {
    seatId: readText(participant.seatId),
    bindingId: readText(participant.bindingId),
    nativeSessionId: readText(participant.nativeSessionId),
    happierSessionId: readText(participant.happierSessionId),
    role: readText(participant.role),
    provider: readText(participant.provider),
    model: readText(participant.model),
    host: readText(participant.host),
    heartbeatFreshness: readHeartbeatFreshness(heartbeat.freshness),
    lastObservedAt: readTimestamp(heartbeat.lastObservedAt),
    recoveryOwner: readText(heartbeat.recoveryOwner),
    contextUsedTokens: readNonNegativeNumber(context.usedTokens),
    contextLimitTokens: readNonNegativeNumber(context.limitTokens),
    throughputEventsPerMinute: readNonNegativeNumber(throughput.eventsPerMinute),
    configuredConcurrent: readNonNegativeNumber(limits.configuredConcurrent),
    effectiveConcurrent: readNonNegativeNumber(limits.effectiveConcurrent),
    waitReason: readText(wait?.reason),
    waitReasonRecorded: wait?.reason === null || readText(wait?.reason) !== null,
    retryAt: readTimestamp(wait?.retryAt),
    retryRecorded: wait?.retryAt === null || readTimestamp(wait?.retryAt) !== null,
    senderLease: normalizeLease(leases.sender),
    workspaceLease: normalizeLease(leases.workspace),
  };
}

function displayKnown(value: string | null, fallback: "Unknown" | "Unavailable" = "Unknown"): string {
  return value ?? fallback;
}

function displayTimestamp(value: string | null): string {
  return value ?? "Unavailable";
}

function displayRole(value: string | null): string {
  if (value === null) return "Unknown";
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function displayContext(participant: NormalizedParticipant): string {
  const { contextUsedTokens: usedTokens, contextLimitTokens: limitTokens } = participant;
  if (usedTokens === null || limitTokens === null || limitTokens <= 0 || usedTokens > limitTokens) return "Unavailable";
  return `${usedTokens} / ${limitTokens} tokens`;
}

function displayThroughput(value: number | null): string {
  return value === null ? "Unavailable" : `${value} events/min`;
}

function displayLimits(participant: NormalizedParticipant): string {
  const { configuredConcurrent, effectiveConcurrent } = participant;
  if (configuredConcurrent === null || effectiveConcurrent === null) return "Unavailable";
  return `${configuredConcurrent} configured / ${effectiveConcurrent} effective`;
}

function displayWait(value: string | null, recorded: boolean, emptyLabel: string): string {
  if (!recorded) return "Unavailable";
  return value ?? emptyLabel;
}

function displayLease(lease: NormalizedLease): string {
  if (lease.state === null) return "Unavailable";
  if (lease.state === "available") return "available";
  return `${lease.state} · ${lease.holderId ?? "holder unavailable"}`;
}

function TelemetryField({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className={styles.field}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function ParticipantCard({ participant, index }: { readonly participant: NormalizedParticipant; readonly index: number }) {
  const seatLabel = participant.seatId ?? "unavailable participant";
  const hasContext = participant.contextUsedTokens !== null
    && participant.contextLimitTokens !== null
    && participant.contextLimitTokens > 0
    && participant.contextUsedTokens <= participant.contextLimitTokens;

  return (
    <li className={styles.cardItem}>
      <article className={styles.participantCard} aria-label={`Participant ${seatLabel}`} data-heartbeat={participant.heartbeatFreshness}>
        <header className={styles.cardHeader}>
          <div>
            <p className={styles.cardKicker}>Seat / runtime binding</p>
            <h3 id={`room-cockpit-participant-${index}`}>{displayRole(participant.role)}</h3>
            <span className={styles.seatReadout}>{displayKnown(participant.seatId, "Unavailable")}</span>
          </div>
          <span className={styles.heartbeatBadge} data-heartbeat={participant.heartbeatFreshness}>
            {participant.heartbeatFreshness}
          </span>
        </header>

        <dl className={styles.identityLedger} aria-label={`Immutable identities for ${seatLabel}`}>
          <TelemetryField label="Seat ID" value={displayKnown(participant.seatId, "Unavailable")} />
          <TelemetryField label="Binding ID" value={displayKnown(participant.bindingId, "Unavailable")} />
          <TelemetryField label="Native Session" value={displayKnown(participant.nativeSessionId, "Unavailable")} />
          <TelemetryField label="Happier Session" value={displayKnown(participant.happierSessionId, "Unavailable")} />
        </dl>

        <dl className={styles.telemetryLedger} aria-label={`Participant telemetry for ${seatLabel}`}>
          <TelemetryField label="Provider" value={displayKnown(participant.provider)} />
          <TelemetryField label="Actual model" value={displayKnown(participant.model)} />
          <TelemetryField label="Host" value={displayKnown(participant.host)} />
          <TelemetryField label="Heartbeat" value={participant.heartbeatFreshness} />
          <TelemetryField label="Last observed" value={displayTimestamp(participant.lastObservedAt)} />
          <TelemetryField label="Recovery owner" value={displayKnown(participant.recoveryOwner, "Unavailable")} />
          <TelemetryField label="Throughput" value={displayThroughput(participant.throughputEventsPerMinute)} />
          <TelemetryField label="Configured / effective" value={displayLimits(participant)} />
          <TelemetryField label="Wait reason" value={displayWait(participant.waitReason, participant.waitReasonRecorded, "No recorded wait")} />
          <TelemetryField label="Retry at" value={displayWait(participant.retryAt, participant.retryRecorded, "No retry scheduled")} />
          <TelemetryField label="Sender lease" value={displayLease(participant.senderLease)} />
          <TelemetryField label="Workspace lease" value={displayLease(participant.workspaceLease)} />
        </dl>

        <section className={styles.contextBlock} aria-label={`Context usage for ${seatLabel}`}>
          <div className={styles.contextHeading}>
            <span>Context usage</span>
            <strong>{displayContext(participant)}</strong>
          </div>
          {hasContext ? (
            <meter
              className={styles.contextMeter}
              aria-label={`Context utilization for ${seatLabel}`}
              min={0}
              max={participant.contextLimitTokens}
              value={participant.contextUsedTokens}
            />
          ) : <span className={styles.contextUnavailable}>Unavailable</span>}
        </section>
      </article>
    </li>
  );
}

/**
 * FNXC:RoomCockpitParticipantPanel 2026-07-19-16:19:
 * Operators need a truthful, scan-friendly view of each immutable Room seat and
 * its runtime binding. This projection boundary validates each supplied field and
 * shows Unknown or Unavailable for absent or malformed telemetry instead of
 * fabricating model, lease, wait, utilization, or recovery state in the browser.
 */
export function RoomCockpitParticipantPanel({ participants }: RoomCockpitParticipantPanelProps) {
  if (participants === undefined) {
    return (
      <section className={styles.panel} aria-labelledby="room-cockpit-participants-title">
        <PanelHeading recordCount={null} />
        <p className={styles.staticState} role="status">Participant telemetry unavailable.</p>
      </section>
    );
  }

  if (participants.length === 0) {
    return (
      <section className={styles.panel} aria-labelledby="room-cockpit-participants-title">
        <PanelHeading recordCount={0} />
        <p className={styles.staticState} role="status">No verified participant seats are currently projected.</p>
      </section>
    );
  }

  return (
    <section className={styles.panel} aria-labelledby="room-cockpit-participants-title">
      <PanelHeading recordCount={participants.length} />
      <ol className={styles.participantList} aria-label="Room participant telemetry">
        {participants.map((participant, index) => (
          <ParticipantCard key={`${normalizeParticipant(participant).seatId ?? "unavailable"}-${index}`} participant={normalizeParticipant(participant)} index={index} />
        ))}
      </ol>
    </section>
  );
}

function PanelHeading({ recordCount }: { readonly recordCount: number | null }) {
  return (
    <header className={styles.panelHeading}>
      <div>
        <p className={styles.eyebrow}>Binding / health / capacity</p>
        <h2 id="room-cockpit-participants-title">Participant operations</h2>
      </div>
      {recordCount === null ? <span className={styles.recordCount}>feed unavailable</span> : (
        <span className={styles.recordCount}>{recordCount} telemetry record{recordCount === 1 ? "" : "s"}</span>
      )}
    </header>
  );
}

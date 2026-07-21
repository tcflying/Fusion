import { useState } from "react";
import styles from "./RoomCockpitAlertPanel.module.css";

export const ROOM_COCKPIT_ALERT_SEVERITIES = ["critical", "warning", "notice"] as const;
export const ROOM_COCKPIT_ALERT_STATUSES = ["open", "acknowledged", "mitigating", "blocked", "resolved"] as const;

const MAX_ALERT_COUNT = 100;
const MAX_IDENTIFIER_LENGTH = 160;
const MAX_TEXT_LENGTH = 1_000;
const SHA256_HASH = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

export type RoomCockpitAlertSeverityV1 = (typeof ROOM_COCKPIT_ALERT_SEVERITIES)[number];
export type RoomCockpitAlertStatusV1 = (typeof ROOM_COCKPIT_ALERT_STATUSES)[number];

export interface RoomCockpitAlertEvidenceReferenceV1 {
  readonly referenceId: string;
  readonly hash: string;
}

export interface RoomCockpitAlertActionGuardV1 {
  readonly authorizationId: string;
  readonly evidenceReferenceId: string;
}

export interface RoomCockpitAlertActionV1 {
  readonly actionId: string;
  readonly label: string;
  readonly confirmationRequired: boolean;
  readonly guard: RoomCockpitAlertActionGuardV1;
}

export interface RoomCockpitAlertV1 {
  readonly alertId: string;
  readonly dedupeKey: string;
  readonly severity: RoomCockpitAlertSeverityV1;
  readonly impact: string;
  readonly summary: string;
  readonly status: RoomCockpitAlertStatusV1;
  readonly evidence: RoomCockpitAlertEvidenceReferenceV1;
  readonly action?: RoomCockpitAlertActionV1;
}

export interface RoomCockpitAlertActionRequestV1 {
  readonly alertId: string;
  readonly dedupeKey: string;
  readonly actionId: string;
  readonly evidence: RoomCockpitAlertEvidenceReferenceV1;
  readonly guard: RoomCockpitAlertActionGuardV1;
}

export type RoomCockpitAlertActionCallbackResultV1 =
  | void
  | false
  | { readonly accepted: true }
  | { readonly accepted: false };

export interface RoomCockpitAlertPanelProps {
  /**
   * FNXC:RoomCockpitAlerts 2026-07-19-16:28:
   * Room alerts may arrive from independently evolving projections. Validate every
   * alert and its action guard at this display boundary, withhold the entire feed on
   * malformed or conflicting deduplication data, and dispatch only a frozen evidence-bound request.
   */
  readonly alerts?: readonly unknown[];
  readonly onAction?: (request: RoomCockpitAlertActionRequestV1) => RoomCockpitAlertActionCallbackResultV1 | Promise<RoomCockpitAlertActionCallbackResultV1>;
  readonly className?: string;
}

interface NormalizedAction {
  readonly actionId: string;
  readonly label: string;
  readonly confirmationRequired: boolean;
  readonly guard: RoomCockpitAlertActionGuardV1;
}

interface NormalizedAlert {
  readonly alertId: string;
  readonly dedupeKey: string;
  readonly severity: RoomCockpitAlertSeverityV1;
  readonly impact: string;
  readonly summary: string;
  readonly status: RoomCockpitAlertStatusV1;
  readonly evidence: RoomCockpitAlertEvidenceReferenceV1;
  readonly action: NormalizedAction | null;
}

interface PreparedAction {
  readonly key: string;
  readonly signature: string;
  readonly label: string;
  readonly request: RoomCockpitAlertActionRequestV1;
}

interface ActionFeedback {
  readonly kind: "confirmation" | "submitted" | "rejected" | "expired";
  readonly message: string;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as UnknownRecord : null;
}

function readIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const identifier = value.trim();
  return identifier.length > 0 && identifier.length <= MAX_IDENTIFIER_LENGTH && IDENTIFIER.test(identifier) ? identifier : null;
}

function readText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= MAX_TEXT_LENGTH ? text : null;
}

function readHash(value: unknown): string | null {
  return typeof value === "string" && SHA256_HASH.test(value) ? value : null;
}

function readEnum<const T extends readonly string[]>(value: unknown, values: T): T[number] | null {
  return typeof value === "string" && (values as readonly string[]).includes(value) ? value as T[number] : null;
}

function parseAction(value: unknown): NormalizedAction | null {
  const action = asRecord(value);
  if (!action) return null;

  const actionId = readIdentifier(action.actionId);
  const label = readText(action.label);
  const guard = asRecord(action.guard);
  const authorizationId = readIdentifier(guard?.authorizationId);
  const evidenceReferenceId = readIdentifier(guard?.evidenceReferenceId);

  if (actionId === null || label === null || typeof action.confirmationRequired !== "boolean" || authorizationId === null || evidenceReferenceId === null) {
    return null;
  }

  return {
    actionId,
    label,
    confirmationRequired: action.confirmationRequired,
    guard: {
      authorizationId,
      evidenceReferenceId,
    },
  };
}

function parseAlert(value: unknown): NormalizedAlert | null {
  const alert = asRecord(value);
  if (!alert) return null;

  const alertId = readIdentifier(alert.alertId);
  const dedupeKey = readIdentifier(alert.dedupeKey);
  const severity = readEnum(alert.severity, ROOM_COCKPIT_ALERT_SEVERITIES);
  const impact = readText(alert.impact);
  const summary = readText(alert.summary);
  const status = readEnum(alert.status, ROOM_COCKPIT_ALERT_STATUSES);
  const evidence = asRecord(alert.evidence);
  const evidenceReferenceId = readIdentifier(evidence?.referenceId);
  const evidenceHash = readHash(evidence?.hash);
  const hasAction = alert.action !== undefined && alert.action !== null;
  const action = hasAction ? parseAction(alert.action) : null;

  if (
    alertId === null
    || dedupeKey === null
    || severity === null
    || impact === null
    || summary === null
    || status === null
    || evidenceReferenceId === null
    || evidenceHash === null
    || (hasAction && action === null)
    || (action !== null && action.guard.evidenceReferenceId !== evidenceReferenceId)
    || (status === "resolved" && action !== null)
  ) {
    return null;
  }

  return {
    alertId,
    dedupeKey,
    severity,
    impact,
    summary,
    status,
    evidence: {
      referenceId: evidenceReferenceId,
      hash: evidenceHash,
    },
    action,
  };
}

function signatureForAlert(alert: NormalizedAlert): string {
  return JSON.stringify([
    alert.dedupeKey,
    alert.severity,
    alert.impact,
    alert.summary,
    alert.status,
    alert.evidence.referenceId,
    alert.evidence.hash,
    alert.action === null ? null : [
      alert.action.actionId,
      alert.action.label,
      alert.action.confirmationRequired,
      alert.action.guard.authorizationId,
      alert.action.guard.evidenceReferenceId,
    ],
  ]);
}

function compareAlerts(left: NormalizedAlert, right: NormalizedAlert): number {
  const severityRank: Record<RoomCockpitAlertSeverityV1, number> = {
    critical: 0,
    warning: 1,
    notice: 2,
  };
  const severityDifference = severityRank[left.severity] - severityRank[right.severity];
  if (severityDifference !== 0) return severityDifference;
  const keyDifference = left.dedupeKey.localeCompare(right.dedupeKey);
  return keyDifference !== 0 ? keyDifference : left.alertId.localeCompare(right.alertId);
}

function parseAlertFeed(alerts: readonly unknown[]): readonly NormalizedAlert[] | null {
  if (alerts.length > MAX_ALERT_COUNT) return null;

  const byDedupeKey = new Map<string, { readonly alert: NormalizedAlert; readonly signature: string }>();
  for (const value of alerts) {
    const alert = parseAlert(value);
    if (alert === null) return null;

    const signature = signatureForAlert(alert);
    const existing = byDedupeKey.get(alert.dedupeKey);
    if (existing !== undefined && existing.signature !== signature) return null;
    if (existing === undefined || alert.alertId.localeCompare(existing.alert.alertId) < 0) {
      byDedupeKey.set(alert.dedupeKey, { alert, signature });
    }
  }

  return [...byDedupeKey.values()].map(({ alert }) => alert).sort(compareAlerts);
}

function actionKey(alert: NormalizedAlert): string | null {
  return alert.action === null ? null : `${alert.dedupeKey}:${alert.action.actionId}`;
}

function prepareAction(alert: NormalizedAlert): PreparedAction | null {
  if (alert.action === null) return null;
  const key = actionKey(alert);
  if (key === null) return null;

  const evidence = Object.freeze({
    referenceId: alert.evidence.referenceId,
    hash: alert.evidence.hash,
  });
  const guard = Object.freeze({
    authorizationId: alert.action.guard.authorizationId,
    evidenceReferenceId: alert.action.guard.evidenceReferenceId,
  });
  const request = Object.freeze({
    alertId: alert.alertId,
    dedupeKey: alert.dedupeKey,
    actionId: alert.action.actionId,
    evidence,
    guard,
  });

  return Object.freeze({
    key,
    signature: signatureForAlert(alert),
    label: alert.action.label,
    request,
  });
}

function hasRejectedCallbackResult(value: RoomCockpitAlertActionCallbackResultV1): boolean {
  return value === false || (asRecord(value)?.accepted === false);
}

function joinClassNames(...classNames: Array<string | undefined>): string {
  return classNames.filter((className): className is string => typeof className === "string" && className.length > 0).join(" ");
}

function displayStatus(status: RoomCockpitAlertStatusV1): string {
  return status.replaceAll("_", " ");
}

function AlertField({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className={styles.metadataField}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function PanelHeading({ recordCount }: { readonly recordCount: number | null }) {
  return (
    <header className={styles.panelHeading}>
      <div>
        <p className={styles.eyebrow}>Attention / evidence / guarded handoff</p>
        <h2 id="room-cockpit-alerts-title">Actionable alerts</h2>
      </div>
      {recordCount === null ? <span className={styles.recordCount}>feed unavailable</span> : (
        <span className={styles.recordCount}>{recordCount} verified alert{recordCount === 1 ? "" : "s"}</span>
      )}
    </header>
  );
}

/**
 * FNXC:RoomCockpitAlerts 2026-07-19-16:28:
 * The cockpit can request a separately authorized operator handoff, but it must
 * never imply an action completed. Confirmation is explicit, callback failure is
 * visible, and the backend remains authoritative for the subsequent alert status.
 */
export function RoomCockpitAlertPanel({ alerts, onAction, className }: RoomCockpitAlertPanelProps) {
  const [pendingAction, setPendingAction] = useState<PreparedAction | null>(null);
  const [busyActionKey, setBusyActionKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);
  const parsedAlerts = alerts === undefined ? null : parseAlertFeed(alerts);

  const dispatchAction = async (prepared: PreparedAction) => {
    if (typeof onAction !== "function") {
      setFeedback({ kind: "rejected", message: "Action handler is unavailable. No handoff was sent." });
      return;
    }

    setBusyActionKey(prepared.key);
    setFeedback(null);
    try {
      const result = await onAction(prepared.request);
      if (hasRejectedCallbackResult(result)) {
        setFeedback({ kind: "rejected", message: "Action handoff was rejected. No success state was recorded." });
      } else {
        setFeedback({ kind: "submitted", message: "Action handoff sent. Awaiting an authoritative status update." });
      }
    } catch {
      setFeedback({ kind: "rejected", message: "Action handoff was rejected. No success state was recorded." });
    } finally {
      setBusyActionKey((current) => current === prepared.key ? null : current);
    }
  };

  const requestAction = (alert: NormalizedAlert) => {
    const prepared = prepareAction(alert);
    if (prepared === null || typeof onAction !== "function") return;

    if (alert.action?.confirmationRequired) {
      setPendingAction(prepared);
      setFeedback({ kind: "confirmation", message: `Confirmation required before ${prepared.label} is handed off.` });
      return;
    }

    void dispatchAction(prepared);
  };

  const confirmAction = () => {
    if (pendingAction === null || parsedAlerts === null) return;
    const currentAlert = parsedAlerts.find((alert) => actionKey(alert) === pendingAction.key && signatureForAlert(alert) === pendingAction.signature);
    if (currentAlert === undefined) {
      setPendingAction(null);
      setFeedback({ kind: "expired", message: "Confirmation expired because the alert projection changed. No handoff was sent." });
      return;
    }

    setPendingAction(null);
    void dispatchAction(pendingAction);
  };

  if (alerts === undefined) {
    return (
      <section className={joinClassNames(styles.panel, className)} aria-labelledby="room-cockpit-alerts-title">
        <PanelHeading recordCount={null} />
        <p className={styles.staticState} role="status">Alert telemetry unavailable.</p>
      </section>
    );
  }

  if (parsedAlerts === null) {
    return (
      <section className={joinClassNames(styles.panel, className)} aria-labelledby="room-cockpit-alerts-title">
        <PanelHeading recordCount={null} />
        <p className={styles.staticState} role="alert">Alert feed withheld because a record is malformed or a deduplication key conflicts.</p>
      </section>
    );
  }

  if (parsedAlerts.length === 0) {
    return (
      <section className={joinClassNames(styles.panel, className)} aria-labelledby="room-cockpit-alerts-title">
        <PanelHeading recordCount={0} />
        <p className={styles.staticState} role="status">No actionable alert records are currently projected.</p>
      </section>
    );
  }

  return (
    <section className={joinClassNames(styles.panel, className)} aria-labelledby="room-cockpit-alerts-title">
      <PanelHeading recordCount={parsedAlerts.length} />
      {feedback !== null ? (
        <output className={styles.feedback} data-kind={feedback.kind} role={feedback.kind === "rejected" ? "alert" : "status"} aria-live="polite">
          {feedback.message}
        </output>
      ) : null}
      <ol className={styles.alertList} aria-label="Verified actionable Room alerts">
        {parsedAlerts.map((alert) => {
          const key = actionKey(alert);
          const action = alert.action;
          const isPendingConfirmation = key !== null && pendingAction?.key === key;
          const isBusy = key !== null && busyActionKey === key;
          const handlerAvailable = typeof onAction === "function";

          return (
            <li className={styles.alertItem} key={alert.dedupeKey}>
              <article className={styles.alertCard} data-severity={alert.severity} aria-label={`Alert ${alert.dedupeKey}: ${alert.severity}`}>
                <header className={styles.alertHeader}>
                  <div>
                    <p className={styles.alertKey}>Signal / {alert.dedupeKey}</p>
                    <h3>{alert.summary}</h3>
                  </div>
                  <span className={styles.severityBadge} data-severity={alert.severity}>{alert.severity}</span>
                </header>

                <section className={styles.auditFields} aria-label={`Alert audit fields for ${alert.dedupeKey}`}>
                  <dl className={styles.alertMetadata}>
                    <AlertField label="Impact">{alert.impact}</AlertField>
                    <AlertField label="Current status">{displayStatus(alert.status)}</AlertField>
                    <AlertField label="Durable evidence">
                      <span className={styles.evidenceReference}>{alert.evidence.referenceId}</span>
                      <code className={styles.evidenceHash}>{alert.evidence.hash}</code>
                    </AlertField>
                  </dl>
                </section>

                {action === null ? null : (
                  <section className={styles.actionBlock} aria-label={`Guarded action for ${alert.dedupeKey}`}>
                    <p className={styles.actionCaption}>Guard {action.guard.authorizationId} · evidence-bound</p>
                    <button
                      className={styles.actionButton}
                      type="button"
                      disabled={!handlerAvailable || isBusy}
                      aria-busy={isBusy || undefined}
                      title={handlerAvailable ? undefined : "No authorized action handler is connected."}
                      onClick={() => requestAction(alert)}
                    >
                      {action.confirmationRequired ? `Prepare ${action.label}` : action.label}
                    </button>
                    {!handlerAvailable ? <p className={styles.handlerUnavailable}>Action handler unavailable.</p> : null}
                    {isPendingConfirmation ? (
                      <div className={styles.confirmation}>
                        <p className={styles.confirmationCopy}>Confirm this evidence-bound handoff before it is sent.</p>
                        <div className={styles.confirmationControls}>
                          <button className={styles.confirmButton} type="button" disabled={isBusy} onClick={confirmAction}>Confirm {action.label}</button>
                          <button className={styles.cancelButton} type="button" disabled={isBusy} onClick={() => setPendingAction(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : null}
                  </section>
                )}
              </article>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

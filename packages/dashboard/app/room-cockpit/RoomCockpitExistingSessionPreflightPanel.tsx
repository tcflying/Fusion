import { useState, type FormEvent } from "react";
import type {
  SessionConnectorIdentityV1,
  SessionConnectorProviderTelemetryWithheldReasonV1,
} from "@fusion/core";
import styles from "./RoomCockpitExistingSessionPreflightPanel.module.css";

export interface RoomCockpitExistingSessionPreflightRequestV1 {
  readonly connectorId: string;
  readonly canonicalSessionUri: string;
  readonly requiredHostId: string;
  readonly requiredMachineId?: string;
}

export type RoomCockpitExistingSessionPreflightIdentityV1 = SessionConnectorIdentityV1;

export interface RoomCockpitExistingSessionPreflightCapabilityV1 {
  readonly name: string;
  readonly state: "verified" | "degraded" | "unavailable" | "unverified";
}

export interface RoomCockpitExistingSessionPreflightHealthV1 {
  readonly state: "healthy" | "degraded" | "authentication_required" | "rate_limited" | "host_unavailable" | "unavailable" | "unknown";
  readonly checkedAt: string | null;
  readonly authentication: "authenticated" | "required" | "unknown";
  readonly rateLimit: "clear" | "limited" | "unknown";
  readonly reasonCodes: readonly string[];
  readonly retryAfterMs: number | null;
}

export type RoomCockpitExistingSessionProviderTelemetryWithheldReasonV1 =
  SessionConnectorProviderTelemetryWithheldReasonV1;

export interface RoomCockpitExistingSessionProviderTelemetryLimitationsV1 {
  readonly providerAvailability: "not_inferred";
  readonly capacity: "not_reported";
  readonly onDemandProviderRefresh: "not_attempted";
  readonly accountIdentity: "not_reported";
  readonly rawSnapshot: "not_reported";
}

export type RoomCockpitExistingSessionProviderTelemetryV1 =
  | Readonly<{
    readonly contractVersion: 1;
    readonly state: "reported";
    readonly providerId: "codex";
    readonly source: "happier_persisted_in_band_provider_snapshot";
    readonly observedAt: string;
    readonly expiresAt: string;
    readonly freshness: "fresh";
    readonly limitations: RoomCockpitExistingSessionProviderTelemetryLimitationsV1;
  }>
  | Readonly<{
    readonly contractVersion: 1;
    readonly state: "withheld";
    readonly reason: RoomCockpitExistingSessionProviderTelemetryWithheldReasonV1;
  }>;

export type RoomCockpitExistingSessionPreflightResultV1 =
  | Readonly<{
    readonly contractVersion: 1;
    readonly state: "identity_verified";
    readonly request: RoomCockpitExistingSessionPreflightRequestV1;
    readonly identity: RoomCockpitExistingSessionPreflightIdentityV1;
    readonly checkedAt: string;
    readonly providerTurnStarted: false;
    readonly capabilities: readonly RoomCockpitExistingSessionPreflightCapabilityV1[];
    readonly health: RoomCockpitExistingSessionPreflightHealthV1;
    readonly providerTelemetry: RoomCockpitExistingSessionProviderTelemetryV1;
  }>
  | Readonly<{
    readonly contractVersion: 1;
    readonly state: "withheld";
    readonly request: RoomCockpitExistingSessionPreflightRequestV1;
    readonly reason: string;
    readonly retryAfterMs: number | null;
  }>;

export interface RoomCockpitExistingSessionPreflightCommandResultV1 {
  readonly commandId: string;
  readonly result: RoomCockpitExistingSessionPreflightResultV1;
}

export type RoomCockpitExistingSessionPreflightSubmissionV1 =
  | Readonly<{
    readonly state: "succeeded";
    readonly results: readonly RoomCockpitExistingSessionPreflightCommandResultV1[];
  }>
  | Readonly<{
    readonly state: "failed";
    readonly detail: string;
  }>;

export interface RoomCockpitExistingSessionPreflightPanelProps {
  readonly disabled?: boolean;
  readonly onPreflight: (
    requests: readonly RoomCockpitExistingSessionPreflightRequestV1[],
  ) => Promise<RoomCockpitExistingSessionPreflightSubmissionV1>;
}

interface DraftSession {
  readonly connectorId: string;
  readonly canonicalSessionUri: string;
  readonly requiredHostId: string;
  readonly requiredMachineId: string;
}

type PanelState =
  | Readonly<{ readonly state: "idle" }>
  | Readonly<{ readonly state: "running" }>
  | RoomCockpitExistingSessionPreflightSubmissionV1;

const emptyDraft = (): DraftSession => ({
  connectorId: "happier-runtime",
  canonicalSessionUri: "",
  requiredHostId: "",
  requiredMachineId: "",
});

function normalizeDraft(value: DraftSession): RoomCockpitExistingSessionPreflightRequestV1 | null {
  const connectorId = value.connectorId.trim();
  const canonicalSessionUri = value.canonicalSessionUri.trim();
  const requiredHostId = value.requiredHostId.trim();
  const requiredMachineId = value.requiredMachineId.trim();
  if (!connectorId || !canonicalSessionUri || !requiredHostId) return null;
  return {
    connectorId,
    canonicalSessionUri,
    requiredHostId,
    ...(requiredMachineId ? { requiredMachineId } : {}),
  };
}

function resultLabel(result: RoomCockpitExistingSessionPreflightResultV1): string {
  return result.state === "identity_verified" ? "identity verified" : "withheld";
}

function retryDetail(retryAfterMs: number | null): string | null {
  if (retryAfterMs === null || retryAfterMs <= 0) return null;
  return `Retry after ${Math.ceil(retryAfterMs / 1_000)}s.`;
}

/**
 * FNXC:RoomCockpitExistingSessionPreflight 2026-07-20-15:42:
 * This panel is deliberately a read-only admission aid. It presents exact
 * Session identity, certified capability state, and bounded health output, but
 * it has no attach, create, or send control. A verified result means only that
 * the later Room-creation flow may be considered; it never starts a provider turn.
 */
export function RoomCockpitExistingSessionPreflightPanel({
  disabled = false,
  onPreflight,
}: RoomCockpitExistingSessionPreflightPanelProps) {
  const [drafts, setDrafts] = useState<readonly DraftSession[]>([emptyDraft()]);
  const [panelState, setPanelState] = useState<PanelState>({ state: "idle" });
  const running = panelState.state === "running";

  const updateDraft = (index: number, field: keyof DraftSession, nextValue: string): void => {
    setDrafts((current) => current.map((draft, currentIndex) => (
      currentIndex === index ? { ...draft, [field]: nextValue } : draft
    )));
  };

  const removeDraft = (index: number): void => {
    setDrafts((current) => current.length <= 1 ? current : current.filter((_draft, currentIndex) => currentIndex !== index));
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (disabled || running) return;
    const requests = drafts.map(normalizeDraft);
    if (requests.some((request) => request === null)) {
      setPanelState({
        state: "failed",
        detail: "Connector ID, canonical Session URI, and required host are required for every Session.",
      });
      return;
    }
    setPanelState({ state: "running" });
    try {
      const result = await onPreflight(requests as readonly RoomCockpitExistingSessionPreflightRequestV1[]);
      setPanelState(result);
    } catch {
      setPanelState({
        state: "failed",
        detail: "The read-only existing-Session preflight request could not be completed.",
      });
    }
  };

  return (
    <section className={styles.panel} aria-labelledby="room-existing-session-preflight-title">
      <header className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>Existing Sessions / read-only admission</p>
          <h2 id="room-existing-session-preflight-title">Preflight old Sessions</h2>
          <p>Verify one or more Codex, Claude, or OpenCode Session identities before any Room is created.</p>
        </div>
        <span className={styles.boundary}>no attach · no send · no provider turn</span>
      </header>

      <form className={styles.form} onSubmit={(event) => { void submit(event); }}>
        <ol className={styles.draftList} aria-label="Existing Session preflight inputs">
          {drafts.map((draft, index) => (
            <li className={styles.draft} key={`preflight-session-${index + 1}`}>
              <div className={styles.draftHeading}>
                <strong>Session {index + 1}</strong>
                <button
                  type="button"
                  className={styles.removeButton}
                  onClick={() => removeDraft(index)}
                  disabled={disabled || running || drafts.length <= 1}
                >
                  Remove
                </button>
              </div>
              <label>
                <span>Connector ID</span>
                <input
                  value={draft.connectorId}
                  onChange={(event) => updateDraft(index, "connectorId", event.target.value)}
                  disabled={disabled || running}
                  aria-label={`Connector ID ${index + 1}`}
                />
              </label>
              <label>
                <span>Canonical Session URI</span>
                <input
                  value={draft.canonicalSessionUri}
                  onChange={(event) => updateDraft(index, "canonicalSessionUri", event.target.value)}
                  disabled={disabled || running}
                  placeholder="codex://threads/..."
                  aria-label={`Canonical Session URI ${index + 1}`}
                />
              </label>
              <label>
                <span>Required host</span>
                <input
                  value={draft.requiredHostId}
                  onChange={(event) => updateDraft(index, "requiredHostId", event.target.value)}
                  disabled={disabled || running}
                  aria-label={`Required host ${index + 1}`}
                />
              </label>
              <label>
                <span>Required machine (optional)</span>
                <input
                  value={draft.requiredMachineId}
                  onChange={(event) => updateDraft(index, "requiredMachineId", event.target.value)}
                  disabled={disabled || running}
                  aria-label={`Required machine ${index + 1}`}
                />
              </label>
            </li>
          ))}
        </ol>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => setDrafts((current) => [...current, emptyDraft()])}
            disabled={disabled || running || drafts.length >= 64}
          >
            Add Session
          </button>
          <button type="submit" className={styles.primaryButton} disabled={disabled || running}>
            {running ? "Verifying Sessions…" : "Verify existing Sessions"}
          </button>
        </div>
      </form>

      {disabled ? <p className={styles.notice} role="status">Select a project before running an authorized preflight.</p> : null}
      {panelState.state === "failed" ? <p className={styles.notice} role="alert">{panelState.detail}</p> : null}
      {panelState.state === "running" ? <p className={styles.notice} role="status">Checking the exact existing Session identities without creating local links.</p> : null}
      {panelState.state === "succeeded" ? (
        <ol className={styles.results} aria-live="polite" aria-label="Existing Session preflight results">
          {panelState.results.map((entry) => <PreflightResult key={entry.commandId} entry={entry} />)}
        </ol>
      ) : null}
    </section>
  );
}

function PreflightResult({ entry }: { readonly entry: RoomCockpitExistingSessionPreflightCommandResultV1 }) {
  const { result } = entry;
  if (result.state === "withheld") {
    return (
      <li className={styles.result} data-state="withheld">
        <header>
          <strong>{resultLabel(result)}</strong>
          <code>{entry.commandId}</code>
        </header>
        <p>Reason: <code>{result.reason}</code></p>
        {retryDetail(result.retryAfterMs) ? <p>{retryDetail(result.retryAfterMs)}</p> : null}
      </li>
    );
  }
  return (
    <li className={styles.result} data-state="identity_verified">
      <header>
        <strong>{resultLabel(result)}</strong>
        <code>{entry.commandId}</code>
      </header>
      <dl className={styles.identity}>
        <div><dt>Native Session</dt><dd>{result.identity.nativeSessionId}</dd></div>
        <div><dt>Happier Session</dt><dd>{result.identity.happierSessionId ?? "not reported"}</dd></div>
        <div><dt>Provider / host</dt><dd>{result.identity.providerId} / {result.identity.hostId}</dd></div>
        <div><dt>Machine</dt><dd>{result.identity.machineId ?? "not reported"}</dd></div>
        <div><dt>Health</dt><dd>{result.health.state} · auth {result.health.authentication} · rate {result.health.rateLimit}</dd></div>
        <div><dt>Checked</dt><dd>{result.checkedAt}</dd></div>
      </dl>
      <p className={styles.turnBoundary}>No provider turn was started.</p>
      <ProviderSnapshot telemetry={result.providerTelemetry} />
      <ul className={styles.capabilities} aria-label="Certified Session capabilities">
        {result.capabilities.map((capability) => (
          <li key={capability.name} data-state={capability.state}>{capability.name}: {capability.state}</li>
        ))}
      </ul>
      {result.health.reasonCodes.length > 0 ? (
        <p className={styles.reasonCodes}>Health reasons: {result.health.reasonCodes.join(", ")}</p>
      ) : null}
    </li>
  );
}

/**
 * FNXC:RoomCockpitProviderTelemetry 2026-07-21-03:11:
 * This compact block is strictly read-only. It may render only the accountless,
 * persisted Codex snapshot contract and its safe withholding reason; it never
 * exposes profile, account, quota, raw provider output, or an action to refresh,
 * attach, send, or claim provider admission. Route validation compares the
 * canonical telemetry identity to the outer Session first, then removes that
 * duplicate identity from this display projection.
 */
function ProviderSnapshot({ telemetry }: { readonly telemetry: RoomCockpitExistingSessionProviderTelemetryV1 }) {
  if (telemetry.state === "withheld") {
    return (
      <section className={styles.providerSnapshot} data-state="withheld" aria-label="Provider snapshot">
        <header>
          <strong>Provider snapshot</strong>
          <span>read-only</span>
        </header>
        <p>Provider snapshot withheld</p>
        <p>Reason: <code>{telemetry.reason}</code></p>
      </section>
    );
  }
  return (
    <section className={styles.providerSnapshot} data-state="reported" aria-label="Provider snapshot">
      <header>
        <strong>Provider snapshot</strong>
        <span>read-only</span>
      </header>
      <p className={styles.providerSnapshotObserved}>Fresh persisted Codex snapshot observed</p>
      <dl className={styles.providerSnapshotTimes}>
        <div><dt>Observed</dt><dd>{telemetry.observedAt}</dd></div>
        <div><dt>Expires</dt><dd>{telemetry.expiresAt}</dd></div>
      </dl>
      <p className={styles.providerSnapshotBoundary}>Does not represent provider availability, capacity, scheduling admission, or send authorization.</p>
    </section>
  );
}

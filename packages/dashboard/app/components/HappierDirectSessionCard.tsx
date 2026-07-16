import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  connectHappierDirectSession,
  fetchHappierDirectSession,
  HappierDirectSessionApiError,
  type HappierDirectSessionConnected,
  type HappierDirectSessionResponse,
} from "../api";

export interface HappierDirectSessionCardProps {
  taskId: string;
  projectId?: string;
  taskPaused: boolean;
}

interface MachineCandidate {
  machineId: string;
  label: string;
}

type RetryMode = "load" | "connect";

interface CopyFallback {
  label: string;
  value: string;
}

function machineCandidatesFromError(error: HappierDirectSessionApiError): MachineCandidate[] {
  const rawCandidates = error.details?.candidates;
  if (!Array.isArray(rawCandidates)) return [];
  return rawCandidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const record = candidate as Record<string, unknown>;
    if (typeof record.machineId !== "string" || record.machineId.length === 0) return [];
    return [{
      machineId: record.machineId,
      label: typeof record.label === "string" && record.label.length > 0
        ? record.label
        : record.machineId,
    }];
  });
}

function errorFromUnknown(error: unknown): HappierDirectSessionApiError {
  if (error instanceof HappierDirectSessionApiError) return error;
  return new HappierDirectSessionApiError(
    error instanceof Error ? error.message : String(error),
    0,
    "request_failed",
  );
}

function IdRow({ label, value, copyLabel, onCopy }: {
  label: string;
  value: string;
  copyLabel: string;
  onCopy: (value: string, label: string) => void;
}) {
  return (
    <div className="happier-direct-session-card__id-row">
      <dt>{label}</dt>
      <dd>
        <code className="happier-direct-session-card__id-value" title={value}>{value}</code>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          aria-label={copyLabel}
          onClick={() => onCopy(value, label)}
        >
          Copy
        </button>
      </dd>
    </div>
  );
}

/*
FNXC:HappierDirectSession 2026-07-15-21:02:
The task-detail card is present before any Fusion process exists. Connecting only binds the inspected Happier native URI; it never starts or resumes the task, and a paused task remains explicitly "Bound, not running".

One in-flight Connect owns the card until completion. Stable daemon/auth/candidate error codes stay visible and retryable, ambiguity promotes machine selection, a partial bridge-assignment failure refreshes the already-bound truth, and a blocked popup leaves the successful binding intact with a normal link fallback.

FNXC:HappierDirectSession 2026-07-16-11:29:
Task and project identity changes invalidate every prior GET, POST, and partial-binding refresh before resetting URI, machine, pending, error, popup, and copy state. Clipboard support is optional; unavailable or throwing implementations expose the full value in an accessible manual-copy fallback.
*/
export function HappierDirectSessionCard({
  taskId,
  projectId,
  taskPaused,
}: HappierDirectSessionCardProps) {
  const [binding, setBinding] = useState<HappierDirectSessionConnected | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [uri, setUri] = useState("");
  const [machineId, setMachineId] = useState("");
  const [machineCandidates, setMachineCandidates] = useState<MachineCandidate[]>([]);
  const [error, setError] = useState<HappierDirectSessionApiError | null>(null);
  const [retryMode, setRetryMode] = useState<RetryMode>("load");
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [copyFallback, setCopyFallback] = useState<CopyFallback | null>(null);
  const pendingRef = useRef(false);
  const identityVersionRef = useRef(0);

  const applyResponse = useCallback((response: HappierDirectSessionResponse) => {
    setBinding(response.connected ? response : null);
  }, []);

  const load = useCallback(async (identityVersion = identityVersionRef.current) => {
    if (identityVersionRef.current !== identityVersion) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetchHappierDirectSession(taskId, projectId);
      if (identityVersionRef.current !== identityVersion) return;
      applyResponse(response);
    } catch (loadError) {
      if (identityVersionRef.current !== identityVersion) return;
      setError(errorFromUnknown(loadError));
      setRetryMode("load");
    } finally {
      if (identityVersionRef.current === identityVersion) setLoading(false);
    }
  }, [applyResponse, projectId, taskId]);

  useLayoutEffect(() => {
    const identityVersion = identityVersionRef.current + 1;
    identityVersionRef.current = identityVersion;
    pendingRef.current = false;
    setBinding(null);
    setLoading(true);
    setPending(false);
    setUri("");
    setMachineId("");
    setMachineCandidates([]);
    setError(null);
    setRetryMode("load");
    setPopupBlocked(false);
    setCopyStatus("");
    setCopyFallback(null);
    void load(identityVersion);
  }, [load]);

  const openInHappier = useCallback((openUrl: string) => {
    let opened: Window | null = null;
    try {
      opened = window.open(openUrl, "_blank", "noopener,noreferrer");
    } catch {
      opened = null;
    }
    setPopupBlocked(opened === null);
  }, []);

  const connect = useCallback(async () => {
    if (pendingRef.current || uri.trim().length === 0) return;
    const identityVersion = identityVersionRef.current;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    setPopupBlocked(false);
    try {
      const response = await connectHappierDirectSession(taskId, projectId, {
        uri,
        ...(machineId.length > 0 ? { machineId } : {}),
      });
      if (identityVersionRef.current !== identityVersion) return;
      applyResponse(response);
      if (response.connected) openInHappier(response.openUrl);
    } catch (connectError) {
      if (identityVersionRef.current !== identityVersion) return;
      const codedError = errorFromUnknown(connectError);
      setError(codedError);
      setRetryMode("connect");
      const candidates = machineCandidatesFromError(codedError);
      setMachineCandidates(candidates);
      if (candidates.length > 0 && !candidates.some((candidate) => candidate.machineId === machineId)) {
        setMachineId("");
      }
      if (codedError.details?.sessionBound === true) {
        try {
          const refreshed = await fetchHappierDirectSession(taskId, projectId);
          if (identityVersionRef.current !== identityVersion) return;
          applyResponse(refreshed);
        } catch {
          if (identityVersionRef.current !== identityVersion) return;
          setError(codedError);
        }
      }
    } finally {
      if (identityVersionRef.current === identityVersion) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }, [applyResponse, machineId, openInHappier, projectId, taskId, uri]);

  const retry = useCallback(() => {
    if (retryMode === "connect") {
      void connect();
    } else {
      void load();
    }
  }, [connect, load, retryMode]);

  const copyValue = useCallback((value: string, label: string) => {
    const identityVersion = identityVersionRef.current;
    const copyFailed = () => {
      if (identityVersionRef.current !== identityVersion) return;
      setCopyStatus(`${label} could not be copied. Copy the full value manually.`);
      setCopyFallback({ label, value });
    };
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (typeof clipboard?.writeText !== "function") {
      copyFailed();
      return;
    }
    try {
      void Promise.resolve(clipboard.writeText(value)).then(
        () => {
          if (identityVersionRef.current !== identityVersion) return;
          setCopyStatus(`${label} copied.`);
          setCopyFallback(null);
        },
        copyFailed,
      );
    } catch {
      copyFailed();
    }
  }, []);

  return (
    <section className="happier-direct-session-card" aria-labelledby={`happier-direct-session-${taskId}`}>
      <header className="happier-direct-session-card__header">
        <div>
          <h3 id={`happier-direct-session-${taskId}`}>Happier Direct Session</h3>
          <p>Bind an existing native session for this task. This does not start the Fusion task.</p>
        </div>
        <span className={`happier-direct-session-card__status${binding ? " happier-direct-session-card__status--connected" : ""}`} role="status">
          {loading
            ? "Checking…"
            : binding
              ? taskPaused ? "Bound, not running" : "Connected"
              : "Not connected"}
        </span>
      </header>

      {binding ? (
        <>
          <dl className="happier-direct-session-card__ids">
            <div className="happier-direct-session-card__id-row">
              <dt>Provider</dt>
              <dd>{binding.providerId}</dd>
            </div>
            <IdRow label="Native session ID" value={binding.nativeSessionId} copyLabel="Copy native session ID" onCopy={copyValue} />
            <IdRow label="Happier session ID" value={binding.remoteSessionId} copyLabel="Copy Happier session ID" onCopy={copyValue} />
            <IdRow label="Machine ID" value={binding.machineId} copyLabel="Copy machine ID" onCopy={copyValue} />
            <IdRow label="Server ID" value={binding.serverId} copyLabel="Copy server ID" onCopy={copyValue} />
          </dl>
          <div className="happier-direct-session-card__actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => openInHappier(binding.openUrl)}
            >
              Open in Happier
            </button>
            {popupBlocked ? (
              <a href={binding.openUrl} target="_blank" rel="noopener noreferrer">
                Open in Happier (popup blocked)
              </a>
            ) : null}
          </div>
        </>
      ) : (
        <div className="happier-direct-session-card__form-row">
          <label className="happier-direct-session-card__uri-field">
            <span>Native Session URI</span>
            <input
              type="text"
              value={uri}
              placeholder="happier://direct/..."
              autoComplete="off"
              onChange={(event) => setUri(event.target.value)}
            />
          </label>
          {machineCandidates.length > 0 ? (
            <label className="happier-direct-session-card__machine-field">
              <span>Machine ID</span>
              <select value={machineId} onChange={(event) => setMachineId(event.target.value)}>
                <option value="">Choose a machine</option>
                {machineCandidates.map((candidate) => (
                  <option key={candidate.machineId} value={candidate.machineId}>
                    {candidate.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <details
              className="happier-direct-session-card__machine-details"
              open={error?.code === "candidate_ambiguous" || error?.code === "machine_mismatch" || undefined}
            >
              <summary>Machine ID (optional)</summary>
              <label>
                <span>Machine ID</span>
                <input
                  type="text"
                  value={machineId}
                  autoComplete="off"
                  onChange={(event) => setMachineId(event.target.value)}
                />
              </label>
            </details>
          )}
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={loading || pending || uri.trim().length === 0}
            onClick={() => void connect()}
          >
            {pending ? "Connecting…" : "Connect"}
          </button>
        </div>
      )}

      {error ? (
        <div className="happier-direct-session-card__error" role="alert">
          <div><code>{error.code}</code> — {error.message}</div>
          <button type="button" className="btn btn-secondary btn-sm" disabled={pending || loading} onClick={retry}>
            Retry
          </button>
        </div>
      ) : null}
      {copyFallback ? (
        <div className="happier-direct-session-card__copy-fallback" role="alert">
          <span>{copyFallback.label} could not be copied. Copy the full value manually:</span>
          <code tabIndex={0}>{copyFallback.value}</code>
        </div>
      ) : null}
      <span className="sr-only" aria-live="polite">{copyStatus}</span>
    </section>
  );
}

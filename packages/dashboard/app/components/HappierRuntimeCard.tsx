import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchHappierStatus,
  fetchPluginSettings,
  fetchPlugins,
  updatePluginSettings,
  type HappierProviderOptions,
  type HappierProviderStatus,
} from "../api";
import { RuntimeCardShell } from "./RuntimeCardShell";

const PLUGIN_ID = "fusion-plugin-happier-runtime";
const HAPPIER_GITHUB = "https://github.com/happier-dev/happier";
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const MIN_OUTPUT_BYTES = 1_024;
const MAX_OUTPUT_BYTES = 16_777_216;

const DEFAULT_SETTINGS: Required<HappierProviderOptions> = {
  executable: "",
  entrypoint: "",
  homeDir: "",
  activeServerId: "",
  serverUrl: "",
  publicServerUrl: "",
  webappUrl: "",
  profile: "",
  backend: "codex",
  timeoutMs: 30_000,
  maxOutputBytes: 1_048_576,
};

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function settingsFromRecord(raw: Record<string, unknown>): Required<HappierProviderOptions> {
  const backend = raw.backend;
  return {
    executable: typeof raw.executable === "string" ? raw.executable : "",
    entrypoint: typeof raw.entrypoint === "string" ? raw.entrypoint : "",
    homeDir: typeof raw.homeDir === "string" ? raw.homeDir : "",
    activeServerId: typeof raw.activeServerId === "string" ? raw.activeServerId : "",
    serverUrl: typeof raw.serverUrl === "string" ? raw.serverUrl : "",
    publicServerUrl: typeof raw.publicServerUrl === "string" ? raw.publicServerUrl : "",
    webappUrl: typeof raw.webappUrl === "string" ? raw.webappUrl : "",
    profile: typeof raw.profile === "string" ? raw.profile : "",
    backend: backend === "claude" || backend === "opencode" ? backend : "codex",
    timeoutMs: boundedNumber(raw.timeoutMs, DEFAULT_SETTINGS.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    maxOutputBytes: boundedNumber(raw.maxOutputBytes, DEFAULT_SETTINGS.maxOutputBytes, MIN_OUTPUT_BYTES, MAX_OUTPUT_BYTES),
  };
}

type HealthBadgeState = "ok" | "error" | "neutral";

function HealthBadge({
  label,
  state,
  detail,
}: {
  label: string;
  state: HealthBadgeState;
  detail?: string;
}) {
  return (
    <span
      data-testid={`happier-health-${label.toLowerCase()}`}
      className={`provider-status-badge provider-status-badge--${state}`}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, opacity: state === "neutral" ? 0.72 : 1 }}
    >
      <span aria-hidden="true">{state === "ok" ? "●" : state === "neutral" ? "◌" : "○"}</span>
      {label}{detail ? ` · ${detail}` : ""}
    </span>
  );
}

function booleanHealthState(value: boolean): HealthBadgeState {
  return value ? "ok" : "error";
}

export function HappierRuntimeCard() {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [health, setHealth] = useState<HappierProviderStatus | null>(null);
  const [runtimeDisabled, setRuntimeDisabled] = useState(false);
  const [busy, setBusy] = useState<"loading" | "saving" | "testing" | "save-test" | null>("loading");
  const [toast, setToast] = useState<{ kind: "ok" | "err"; message: string } | null>(null);
  const mounted = useRef(true);

  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    Promise.all([fetchPluginSettings(PLUGIN_ID), fetchPlugins()])
      .then(async ([raw, plugins]) => {
        if (!mounted.current) return;
        const nextSettings = settingsFromRecord(raw);
        setSettings(nextSettings);
        const plugin = plugins.find((candidate) => candidate.id === PLUGIN_ID);
        setRuntimeDisabled(plugin ? !plugin.enabled : false);
        const nextHealth = await fetchHappierStatus(nextSettings);
        if (mounted.current) setHealth(nextHealth);
      })
      .catch((error) => {
        if (mounted.current) setToast({ kind: "err", message: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => { if (mounted.current) setBusy(null); });
  }, []);

  const payload = useCallback(
    (): Required<HappierProviderOptions> & Record<string, unknown> => ({ ...settings }),
    [settings],
  );

  const probe = useCallback(async (): Promise<HappierProviderStatus | null> => {
    try {
      const next = await fetchHappierStatus(payload());
      if (mounted.current) setHealth(next);
      return next;
    } catch (error) {
      if (mounted.current) setToast({ kind: "err", message: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }, [payload]);

  const test = useCallback(async () => {
    setBusy("testing");
    setToast(null);
    const next = await probe();
    if (!mounted.current) return;
    setBusy(null);
    setToast(next?.ready
      ? { kind: "ok", message: "Happier runtime is ready." }
      : { kind: "err", message: "Happier runtime is not ready; inspect the layer status." });
  }, [probe]);

  const save = useCallback(async (andTest: boolean) => {
    setBusy(andTest ? "save-test" : "saving");
    setToast(null);
    try {
      await updatePluginSettings(PLUGIN_ID, payload());
      const next = andTest ? await probe() : null;
      if (mounted.current) {
        setToast(andTest && !next?.ready
          ? { kind: "err", message: "Saved, but Happier is not ready." }
          : { kind: "ok", message: andTest ? "Saved and verified." : "Settings saved." });
      }
    } catch (error) {
      if (mounted.current) setToast({ kind: "err", message: error instanceof Error ? error.message : String(error) });
    } finally {
      if (mounted.current) setBusy(null);
    }
  }, [payload, probe]);

  const statusKind = runtimeDisabled ? "neutral" : health === null ? "loading" : health.ready ? "ok" : "err";
  const statusText = runtimeDisabled
    ? "Disabled in Plugin Manager"
    : health === null
      ? "Checking Happier runtime layers…"
      : health.ready
        ? `Ready · ${health.backendId}`
        : `Not ready · ${health.details.join(", ") || "one or more layers unavailable"}`;

  return (
    <RuntimeCardShell
      testId="happier-runtime-card"
      logo={<span aria-hidden="true" style={{ fontWeight: 700, fontSize: 20 }}>H</span>}
      name="Happier"
      subname="Session bridge for Codex, Claude, and OpenCode"
      learnMoreHref={HAPPIER_GITHUB}
      statusKind={statusKind}
      statusText={statusText}
      description="Fusion schedules work while Happier owns the durable external session. Health is reported per layer and credentials remain inside Happier."
      busy={busy}
      toast={toast}
      onTest={() => void test()}
      onSave={() => void save(false)}
      onSaveAndTest={() => void save(true)}
      belowForm={health ? (
        <div aria-live="polite" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <HealthBadge label="CLI" state={booleanHealthState(health.executable)} />
          {/* FNXC:HappierRuntime 2026-07-14-09:54: Unknown reachability is neutral,
              never rendered as a false server-down alarm. */}
          <HealthBadge
            label="Server"
            state={health.serverState === "not-probed" ? "neutral" : booleanHealthState(health.server)}
            detail={health.serverState === "not-probed" ? "Not probed" : undefined}
          />
          <HealthBadge label="Auth" state={booleanHealthState(health.authenticated)} />
          <HealthBadge label="Daemon" state={booleanHealthState(health.daemon)} />
          <HealthBadge label="Backend" state={booleanHealthState(health.backend)} />
        </div>
      ) : null}
    >
      <div className="form-group">
        <label htmlFor="happier-backend">Selected backend</label>
        <select id="happier-backend" value={settings.backend} onChange={(event) => setSettings((value) => ({ ...value, backend: event.target.value as NonNullable<HappierProviderOptions["backend"]> }))}>
          <option value="codex">Codex</option>
          <option value="claude">Claude Code</option>
          <option value="opencode">OpenCode</option>
        </select>
      </div>
      <div className="form-group">
        <label htmlFor="happier-executable">Executable</label>
        <input id="happier-executable" value={settings.executable} placeholder="happier or node.exe" onChange={(event) => setSettings((value) => ({ ...value, executable: event.target.value }))} />
      </div>
      <div className="form-group">
        <label htmlFor="happier-entrypoint">CLI entrypoint (optional)</label>
        <input id="happier-entrypoint" value={settings.entrypoint} placeholder="Path to happier.mjs when executable is node" onChange={(event) => setSettings((value) => ({ ...value, entrypoint: event.target.value }))} />
      </div>
      <div className="form-group">
        <label htmlFor="happier-home-dir">Happier home directory</label>
        <input id="happier-home-dir" value={settings.homeDir} placeholder="Path to the selected stack CLI home" onChange={(event) => setSettings((value) => ({ ...value, homeDir: event.target.value }))} />
      </div>
      <div className="form-group">
        <label htmlFor="happier-active-server-id">Active server ID</label>
        <input id="happier-active-server-id" value={settings.activeServerId} placeholder="stack_...__id_default" onChange={(event) => setSettings((value) => ({ ...value, activeServerId: event.target.value }))} />
      </div>
      <div className="form-group">
        <label htmlFor="happier-server">Server URL</label>
        <input id="happier-server" type="url" value={settings.serverUrl} placeholder="http://localhost:52211" onChange={(event) => setSettings((value) => ({ ...value, serverUrl: event.target.value }))} />
      </div>
      <div className="form-group">
        <label htmlFor="happier-public-server">Public server URL</label>
        <input id="happier-public-server" type="url" value={settings.publicServerUrl} placeholder="http://localhost:52211" onChange={(event) => setSettings((value) => ({ ...value, publicServerUrl: event.target.value }))} />
      </div>
      <div className="form-group">
        <label htmlFor="happier-webapp">Web app URL (optional)</label>
        <input id="happier-webapp" type="url" value={settings.webappUrl} onChange={(event) => setSettings((value) => ({ ...value, webappUrl: event.target.value }))} />
      </div>
      <div className="form-group">
        <label htmlFor="happier-profile">Profile (optional)</label>
        <input id="happier-profile" value={settings.profile} onChange={(event) => setSettings((value) => ({ ...value, profile: event.target.value }))} />
      </div>
      <div className="form-group">
        <label htmlFor="happier-timeout">Probe timeout (ms)</label>
        <input id="happier-timeout" type="number" min={MIN_TIMEOUT_MS} max={MAX_TIMEOUT_MS} step={1000} value={settings.timeoutMs} onChange={(event) => setSettings((value) => ({ ...value, timeoutMs: boundedNumber(Number(event.target.value), DEFAULT_SETTINGS.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS) }))} />
      </div>
      <div className="form-group">
        <label htmlFor="happier-output-limit">Maximum probe output (bytes)</label>
        <input id="happier-output-limit" type="number" min={MIN_OUTPUT_BYTES} max={MAX_OUTPUT_BYTES} step={1024} value={settings.maxOutputBytes} onChange={(event) => setSettings((value) => ({ ...value, maxOutputBytes: boundedNumber(Number(event.target.value), DEFAULT_SETTINGS.maxOutputBytes, MIN_OUTPUT_BYTES, MAX_OUTPUT_BYTES) }))} />
      </div>
      <small>Authentication tokens and provider credentials are deliberately not accepted here.</small>
    </RuntimeCardShell>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import {
  confirmHappierRuntimeBinding,
  fetchHappierRuntimeSetup,
  fetchHappierStatus,
  fetchPluginSettings,
  fetchPlugins,
  removeHappierRuntimeBinding,
  updatePluginSettings,
  type ConfirmHappierBindingInput,
  type HappierProviderOptions,
  type HappierProviderStatus,
  type HappierRuntimeSetupStatus,
} from "../api";
import { RuntimeCardShell } from "./RuntimeCardShell";
import "./HappierRuntimeCard.css";

const PLUGIN_ID = "fusion-plugin-happier-runtime";
const HAPPIER_GITHUB = "https://github.com/happier-dev/happier";
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const MIN_OUTPUT_BYTES = 1_024;
const MAX_OUTPUT_BYTES = 16_777_216;

type HappierRuntimeFormSettings = Required<HappierProviderOptions> & {
  allowedCliRoots: string[];
};

const DEFAULT_SETTINGS: HappierRuntimeFormSettings = {
  executable: "",
  entrypoint: "",
  allowedCliRoots: [],
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

function settingsFromRecord(raw: Record<string, unknown>): HappierRuntimeFormSettings {
  const backend = raw.backend;
  return {
    executable: typeof raw.executable === "string" ? raw.executable : "",
    entrypoint: typeof raw.entrypoint === "string" ? raw.entrypoint : "",
    allowedCliRoots: Array.isArray(raw.allowedCliRoots)
      ? raw.allowedCliRoots.filter((root): root is string => typeof root === "string")
      : [],
    homeDir: typeof raw.homeDir === "string" ? raw.homeDir : "",
    activeServerId: typeof raw.activeServerId === "string" ? raw.activeServerId : "",
    serverUrl: typeof raw.serverUrl === "string" ? raw.serverUrl : "",
    publicServerUrl: typeof raw.publicServerUrl === "string" ? raw.publicServerUrl : "",
    webappUrl: typeof raw.webappUrl === "string" ? raw.webappUrl : "",
    profile: typeof raw.profile === "string" ? raw.profile : "",
    backend: backend === "claude" || backend === "opencode" ? backend : "codex",
    timeoutMs: boundedNumber(raw.timeoutMs, DEFAULT_SETTINGS.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
    maxOutputBytes: boundedNumber(
      raw.maxOutputBytes,
      DEFAULT_SETTINGS.maxOutputBytes,
      MIN_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES,
    ),
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
      className={`provider-status-badge provider-status-badge--${state} happier-runtime__health-badge`}
    >
      <span aria-hidden="true">{state === "ok" ? "●" : state === "neutral" ? "◌" : "○"}</span>
      {label}{detail ? ` · ${detail}` : ""}
    </span>
  );
}

function booleanHealthState(value: boolean): HealthBadgeState {
  return value ? "ok" : "error";
}

function EvidenceRow({
  label,
  value,
  code = true,
}: {
  label: string;
  value: string;
  code?: boolean;
}) {
  return (
    <div className="happier-runtime__evidence-row">
      <dt>{label}</dt>
      <dd>{code ? <code>{value}</code> : value}</dd>
    </div>
  );
}

function stateLabel(value: string): string {
  return value
    .split(/[_-]/u)
    .map((part) => part ? `${part[0]!.toUpperCase()}${part.slice(1)}` : part)
    .join(" ");
}

function SetupEvidence({
  setup,
  mutationBusy,
  onConfirmBinding,
  onRemoveBinding,
}: {
  setup: HappierRuntimeSetupStatus;
  mutationBusy: boolean;
  onConfirmBinding: (binding: ConfirmHappierBindingInput["binding"]) => void;
  onRemoveBinding: (binding: ConfirmHappierBindingInput["binding"]) => void;
}) {
  const [nativeCandidateUri, setNativeCandidateUri] = useState("");
  const [happierCandidateId, setHappierCandidateId] = useState("");
  const [serverProfileId, setServerProfileId] = useState(setup.server.activeServerId ?? "");
  const [machineId, setMachineId] = useState("");
  const attestation = setup.cli.attestation;
  const nativeCandidates = setup.discovery.nativeCandidates.filter((candidate) =>
    candidate.bindingState === "unbound"
    && candidate.providerId === setup.runtimeHealth.backendId);
  const happierCandidates = setup.discovery.happierCandidates.filter((candidate) =>
    candidate.bindingState === "unbound");
  const openCodeMachineUnverified = setup.runtimeHealth.backendId === "opencode"
    && setup.runtimeHealth.details.includes("backend-machine-availability-unverified");
  const canConfirm = Boolean(
    nativeCandidateUri
    && happierCandidateId
    && serverProfileId.trim()
    && machineId.trim(),
  );

  return (
    <div className="happier-runtime__setup" aria-label="Happier setup and health evidence">
      <div className="happier-runtime__health" aria-live="polite">
        <HealthBadge label="CLI" state={booleanHealthState(setup.runtimeHealth.executable)} />
        <HealthBadge
          label="Server"
          state={setup.runtimeHealth.serverState === "not-probed"
            ? "neutral"
            : booleanHealthState(setup.runtimeHealth.server)}
          detail={setup.runtimeHealth.serverState === "not-probed" ? "Not probed" : undefined}
        />
        <HealthBadge label="Auth" state={booleanHealthState(setup.runtimeHealth.authenticated)} />
        <HealthBadge label="Daemon" state={booleanHealthState(setup.runtimeHealth.daemon)} />
        <HealthBadge label="Backend" state={booleanHealthState(setup.runtimeHealth.backend)} />
        <HealthBadge
          label="Reconciliation"
          state={setup.failClosed ? "error" : "ok"}
          detail={setup.failClosed ? "Fail closed" : "Verified"}
        />
      </div>

      {(setup.validationErrors.length > 0 || setup.conflicts.length > 0) && (
        <section className="happier-runtime__alert" role="alert">
          <h4>Binding conflicts and validation</h4>
          <ul>
            {[...new Set([...setup.conflicts, ...setup.validationErrors])].map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </section>
      )}

      <div className="happier-runtime__evidence-grid">
        <section className="happier-runtime__panel">
          <h4>CLI attestation</h4>
          <dl>
            <EvidenceRow label="Result" value={attestation.ok ? "Verified" : stateLabel(attestation.reasonCode)} code={false} />
            {attestation.ok && (
              <>
                <EvidenceRow label="Version" value={attestation.cliVersion} />
                <EvidenceRow label="Commit" value={attestation.sourceCommit} />
                <EvidenceRow label="Entrypoint hash" value={attestation.entrypointSha256} />
                <EvidenceRow label="Entrypoint" value={attestation.entrypointPath} />
                <EvidenceRow label="Attested source root" value={attestation.sourceRoot} />
                <EvidenceRow label="Verified at" value={attestation.verifiedAt} />
              </>
            )}
          </dl>
          <div className="happier-runtime__subsection">
            <h5>Allowed realpath roots</h5>
            {setup.cli.allowedRoots.length > 0 ? (
              <ul className="happier-runtime__code-list">
                {setup.cli.allowedRoots.map((root) => <li key={root}><code>{root}</code></li>)}
              </ul>
            ) : (
              <p>None configured</p>
            )}
          </div>
        </section>

        <section className="happier-runtime__panel">
          <h4>Compatibility matrix</h4>
          <dl>
            <EvidenceRow label="Plugin" value={setup.compatibility.pluginVersion} />
            <EvidenceRow label="Fusion" value={setup.compatibility.fusionSemver} />
            <EvidenceRow label="Happier CLI" value={setup.compatibility.happierCliSemver} />
            <EvidenceRow label="Source commit" value={setup.compatibility.happierSourceCommit} />
            <EvidenceRow label="Protocol" value={setup.compatibility.officialProtocolContract} />
            <EvidenceRow label="Pinned hash" value={setup.compatibility.entrypointSha256} />
          </dl>
        </section>

        <section className="happier-runtime__panel">
          <h4>Server &amp; authentication</h4>
          <dl>
            <EvidenceRow label="Active server ID" value={setup.server.activeServerId ?? "Not configured"} />
            <EvidenceRow label="Profile" value={setup.server.profile ?? "Not configured"} />
            <EvidenceRow label="Server URL" value={setup.server.serverUrl ?? "Not configured"} />
            <EvidenceRow label="Public server URL" value={setup.server.publicServerUrl ?? "Not configured"} />
            <EvidenceRow label="Web app URL" value={setup.server.webappUrl ?? "Not configured"} />
            <EvidenceRow
              label="Runtime auth"
              value={setup.authentication.runtimeAuthenticated ? "Authenticated" : "Authentication required"}
              code={false}
            />
            <EvidenceRow label="Connector auth" value={stateLabel(setup.authentication.connector)} code={false} />
            <EvidenceRow
              label="Connector"
              value={setup.connectorHealth
                ? `${stateLabel(setup.connectorHealth.state)} · ${setup.connectorHealth.checkedAt}`
                : setup.connectorReadError ?? "Unavailable"}
              code={false}
            />
            {openCodeMachineUnverified && (
              <EvidenceRow
                label="OpenCode machine availability"
                value="Unable to verify"
                code={false}
              />
            )}
          </dl>
          <div className="happier-runtime__subsection">
            <h5>Machines</h5>
            {setup.machines.length > 0 ? (
              <ul>
                {setup.machines.map((machine) => (
                  <li key={machine.machineId}>
                    <code>{machine.machineId}</code>
                    {" · "}
                    {openCodeMachineUnverified && machine.providerIds.includes("opencode")
                      ? "Unable to verify"
                      : stateLabel(machine.availability)}
                    {" · "}
                    {machine.bindingCount} binding{machine.bindingCount === 1 ? "" : "s"}
                  </li>
                ))}
              </ul>
            ) : (
              <p>No bound machines.</p>
            )}
          </div>
        </section>
      </div>

      <section className="happier-runtime__panel">
        <div className="happier-runtime__section-heading">
          <h4>Bindings</h4>
          <code>{setup.bindingRevision}</code>
        </div>
        {setup.bindings.length > 0 ? (
          <ul className="happier-runtime__binding-list">
            {setup.bindings.map((binding) => (
              <li
                key={`${binding.canonicalSessionUri}\u0000${binding.happierSessionId}`}
                className="happier-runtime__binding"
              >
                <div className="happier-runtime__section-heading">
                  <code>{binding.canonicalSessionUri}</code>
                  <div className="happier-runtime__binding-actions">
                    <span className={`happier-runtime__state happier-runtime__state--${binding.state}`}>
                      {stateLabel(binding.state)}
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      disabled={mutationBusy}
                      aria-label={`Remove binding ${binding.canonicalSessionUri}`}
                      onClick={() => onRemoveBinding({
                        canonicalSessionUri: binding.canonicalSessionUri,
                        happierSessionId: binding.happierSessionId,
                        serverProfileId: binding.serverProfileId,
                        machineId: binding.machineId,
                      })}
                    >
                      Remove binding
                    </button>
                  </div>
                </div>
                <dl>
                  <EvidenceRow label="Happier session" value={binding.happierSessionId} />
                  <EvidenceRow label="Provider native ID" value={`${binding.providerId} · ${binding.nativeSessionId}`} />
                  <EvidenceRow label="Server profile" value={`${binding.serverProfileId} · configured tuple`} />
                  <EvidenceRow
                    label="Machine"
                    value={`${binding.machineId} · ${
                      binding.providerId === "opencode" && binding.machineAvailability === "unverified"
                        ? "Unable to verify"
                        : stateLabel(binding.machineAvailability)
                    }`}
                  />
                </dl>
                {binding.driftReasons.length > 0 && (
                  <p className="happier-runtime__drift">
                    {binding.driftReasons.map(stateLabel).join(" · ")}
                  </p>
                )}
                <div className="happier-runtime__subsection">
                  <h5>Probe evidence</h5>
                  {binding.probeEvidence ? (
                    <dl>
                      <EvidenceRow label="State" value={stateLabel(binding.probeEvidence.state)} code={false} />
                      <EvidenceRow
                        label="Tools"
                        value={binding.probeEvidence.toolNames.join(", ") || "No tools reported"}
                        code={false}
                      />
                      <EvidenceRow label="Sampled" value={binding.probeEvidence.sampledAt} />
                      <EvidenceRow label="Latency" value={`${binding.probeEvidence.latencyMs} ms`} code={false} />
                    </dl>
                  ) : (
                    <p>Unavailable. This binding remains fail closed.</p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p>No confirmed bindings. Discovered sessions are never added automatically.</p>
        )}
      </section>

      <section className="happier-runtime__panel">
        <h4>Discovery candidates</h4>
        <p className="happier-runtime__hint">
          Discovery is read-only. A candidate remains unbound until a complete four-tuple is explicitly confirmed.
        </p>
        <div className="happier-runtime__candidate-grid">
          <div>
            <h5>Fusion native sessions</h5>
            {setup.discovery.nativeCandidates.length > 0 ? (
              <ul className="happier-runtime__code-list">
                {setup.discovery.nativeCandidates.map((candidate) => (
                  <li key={candidate.canonicalSessionUri}>
                    <code>{candidate.canonicalSessionUri}</code>
                    {" · "}
                    {stateLabel(candidate.bindingState)}
                  </li>
                ))}
              </ul>
            ) : (
              <p>{setup.discovery.nativeReason ?? "No candidates found."}</p>
            )}
          </div>
          <div>
            <h5>Happier sessions</h5>
            {setup.discovery.happierCandidates.length > 0 ? (
              <ul className="happier-runtime__code-list">
                {setup.discovery.happierCandidates.map((candidate) => (
                  <li key={candidate.happierSessionId}>
                    <code>{candidate.happierSessionId}</code>
                    {" · "}
                    {stateLabel(candidate.bindingState)}
                  </li>
                ))}
              </ul>
            ) : (
              <p>{setup.discovery.happierReason ?? "No candidates found."}</p>
            )}
          </div>
        </div>
        <div className="happier-runtime__binding-form">
          <div className="form-group">
            <label htmlFor="happier-native-candidate">Native session candidate</label>
            <select
              id="happier-native-candidate"
              value={nativeCandidateUri}
              onChange={(event) => setNativeCandidateUri(event.target.value)}
            >
              <option value="">Select a Fusion native session</option>
              {nativeCandidates.map((candidate) => (
                <option key={candidate.canonicalSessionUri} value={candidate.canonicalSessionUri}>
                  {candidate.canonicalSessionUri}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="happier-session-candidate">Happier session candidate</label>
            <select
              id="happier-session-candidate"
              value={happierCandidateId}
              onChange={(event) => setHappierCandidateId(event.target.value)}
            >
              <option value="">Select a Happier session</option>
              {happierCandidates.map((candidate) => (
                <option key={candidate.happierSessionId} value={candidate.happierSessionId}>
                  {candidate.happierSessionId}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="happier-binding-server">Server profile for binding</label>
            <input
              id="happier-binding-server"
              value={serverProfileId}
              onChange={(event) => setServerProfileId(event.target.value)}
            />
          </div>
          <div className="form-group">
            <label htmlFor="happier-binding-machine">Machine for binding</label>
            <input
              id="happier-binding-machine"
              value={machineId}
              onChange={(event) => setMachineId(event.target.value)}
              placeholder="Exact Happier machine ID"
            />
          </div>
          <div className="happier-runtime__binding-confirm">
            <p>
              Confirming only updates the project binding registry. It does not create,
              resume, or add any session.
            </p>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={!canConfirm || mutationBusy}
              onClick={() => onConfirmBinding({
                canonicalSessionUri: nativeCandidateUri,
                happierSessionId: happierCandidateId,
                serverProfileId: serverProfileId.trim(),
                machineId: machineId.trim(),
              })}
            >
              Confirm binding
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

export interface HappierRuntimeCardProps {
  readonly projectId?: string;
}

export function HappierRuntimeCard({ projectId }: HappierRuntimeCardProps = {}) {
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [health, setHealth] = useState<HappierProviderStatus | null>(null);
  const [setup, setSetup] = useState<HappierRuntimeSetupStatus | null>(null);
  const [runtimeDisabled, setRuntimeDisabled] = useState(false);
  const [bindingBusy, setBindingBusy] = useState(false);
  const [busy, setBusy] = useState<"loading" | "saving" | "testing" | "save-test" | null>("loading");
  const [toast, setToast] = useState<{ kind: "ok" | "err"; message: string } | null>(null);
  const mounted = useRef(true);

  useEffect(() => () => {
    mounted.current = false;
  }, []);

  const refreshSetup = useCallback(async (): Promise<HappierRuntimeSetupStatus | null> => {
    try {
      const next = await fetchHappierRuntimeSetup(projectId);
      if (mounted.current) {
        setSetup(next);
        setHealth(next.runtimeHealth);
      }
      return next;
    } catch (error) {
      if (mounted.current) {
        setToast({
          kind: "err",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return null;
    }
  }, [projectId]);

  useEffect(() => {
    setBusy("loading");
    Promise.all([
      fetchPluginSettings(PLUGIN_ID, projectId),
      fetchPlugins(projectId),
      fetchHappierRuntimeSetup(projectId),
    ])
      .then(([raw, plugins, nextSetup]) => {
        if (!mounted.current) return;
        setSettings(settingsFromRecord(raw));
        const plugin = plugins.find((candidate) => candidate.id === PLUGIN_ID);
        setRuntimeDisabled(plugin ? !plugin.enabled : false);
        setSetup(nextSetup);
        setHealth(nextSetup.runtimeHealth);
      })
      .catch((error) => {
        if (mounted.current) {
          setToast({
            kind: "err",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      })
      .finally(() => {
        if (mounted.current) setBusy(null);
      });
  }, [projectId]);

  const payload = useCallback(
    (): HappierRuntimeFormSettings & Record<string, unknown> => ({ ...settings }),
    [settings],
  );

  const probe = useCallback(async (): Promise<HappierProviderStatus | null> => {
    try {
      const next = await fetchHappierStatus(payload());
      if (mounted.current) setHealth(next);
      return next;
    } catch (error) {
      if (mounted.current) {
        setToast({
          kind: "err",
          message: error instanceof Error ? error.message : String(error),
        });
      }
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
      ? {
        kind: "ok",
        message: "Runtime probe passed; setup reconciliation remains fail closed until refreshed.",
      }
      : { kind: "err", message: "Happier runtime is not ready; inspect the layer status." });
  }, [probe]);

  const save = useCallback(async (andTest: boolean) => {
    setBusy(andTest ? "save-test" : "saving");
    setToast(null);
    try {
      await updatePluginSettings(PLUGIN_ID, payload(), projectId);
      const next = andTest ? await refreshSetup() : null;
      if (mounted.current) {
        setToast(andTest && !next?.runtimeHealth.ready
          ? { kind: "err", message: "Saved, but Happier is not ready." }
          : { kind: "ok", message: andTest ? "Saved and verified." : "Settings saved." });
      }
    } catch (error) {
      if (mounted.current) {
        setToast({
          kind: "err",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (mounted.current) setBusy(null);
    }
  }, [payload, projectId, refreshSetup]);

  const confirmBinding = useCallback(async (
    binding: ConfirmHappierBindingInput["binding"],
  ) => {
    if (!setup) return;
    setBindingBusy(true);
    setToast(null);
    try {
      await confirmHappierRuntimeBinding(projectId, {
        expectedRevision: setup.bindingRevision,
        binding,
      });
      const next = await refreshSetup();
      if (mounted.current) {
        setToast(next
          ? { kind: "ok", message: "Binding confirmed and reconciled." }
          : { kind: "err", message: "Binding saved, but refreshed evidence is unavailable." });
      }
    } catch (error) {
      if (mounted.current) {
        setToast({
          kind: "err",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (mounted.current) setBindingBusy(false);
    }
  }, [projectId, refreshSetup, setup]);

  const removeBinding = useCallback(async (
    binding: ConfirmHappierBindingInput["binding"],
  ) => {
    if (!setup) return;
    setBindingBusy(true);
    setToast(null);
    try {
      await removeHappierRuntimeBinding(projectId, {
        expectedRevision: setup.bindingRevision,
        binding,
      });
      await refreshSetup();
      if (mounted.current) setToast({ kind: "ok", message: "Binding removed." });
    } catch (error) {
      if (mounted.current) {
        setToast({
          kind: "err",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (mounted.current) setBindingBusy(false);
    }
  }, [projectId, refreshSetup, setup]);

  const reconciliationCurrent = setup !== null
    && health !== null
    && health === setup.runtimeHealth;
  const reconciledReady = setup !== null
    && health !== null
    && health === setup.runtimeHealth
    && health.ready
    && !setup.failClosed;
  const reconciliationReason = setup === null
    ? "setup reconciliation unavailable"
    : reconciliationCurrent
      ? null
      : "setup reconciliation stale after standalone probe";
  const statusKind = runtimeDisabled
    ? "neutral"
    : health === null
      ? "loading"
      : reconciledReady
        ? "ok"
        : "err";
  const statusText = runtimeDisabled
    ? "Disabled in Plugin Manager"
    : health === null
      ? "Checking Happier runtime layers…"
      : reconciledReady
        ? `Ready · ${health.backendId}`
        : `Fail closed · ${[
          ...health.details,
          ...(setup?.conflicts ?? []),
          ...(reconciliationReason ? [reconciliationReason] : []),
        ].join(", ") || "one or more layers unavailable"}`;

  return (
    <RuntimeCardShell
      testId="happier-runtime-card"
      logo={<span aria-hidden="true" className="happier-runtime__logo">H</span>}
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
      belowForm={setup ? (
        <SetupEvidence
          key={setup.bindingRevision}
          setup={setup}
          mutationBusy={bindingBusy}
          onConfirmBinding={(binding) => void confirmBinding(binding)}
          onRemoveBinding={(binding) => void removeBinding(binding)}
        />
      ) : null}
    >
      <div className="form-group">
        <label htmlFor="happier-backend">Selected backend</label>
        <select
          id="happier-backend"
          value={settings.backend}
          onChange={(event) => setSettings((value) => ({
            ...value,
            backend: event.target.value as NonNullable<HappierProviderOptions["backend"]>,
          }))}
        >
          <option value="codex">Codex</option>
          <option value="claude">Claude Code</option>
          <option value="opencode">OpenCode</option>
        </select>
      </div>
      <div className="form-group">
        <label htmlFor="happier-executable">Node executable</label>
        <input
          id="happier-executable"
          value={settings.executable}
          placeholder="Absolute path to the current node.exe"
          onChange={(event) => setSettings((value) => ({ ...value, executable: event.target.value }))}
        />
      </div>
      <div className="form-group">
        <label htmlFor="happier-entrypoint">CLI entrypoint</label>
        <input
          id="happier-entrypoint"
          value={settings.entrypoint}
          placeholder="Absolute apps/cli/package-dist/index.mjs path"
          onChange={(event) => setSettings((value) => ({ ...value, entrypoint: event.target.value }))}
        />
      </div>
      <div className="form-group">
        <label htmlFor="happier-allowed-roots">Allowed CLI roots</label>
        <textarea
          id="happier-allowed-roots"
          value={settings.allowedCliRoots.join("\n")}
          placeholder="One absolute realpath root per line"
          rows={3}
          onChange={(event) => setSettings((value) => ({
            ...value,
            allowedCliRoots: event.target.value
              .split(/\r?\n/u)
              .map((root) => root.trim())
              .filter(Boolean),
          }))}
        />
      </div>
      <div className="form-group">
        <label htmlFor="happier-home-dir">Happier home directory</label>
        <input
          id="happier-home-dir"
          value={settings.homeDir}
          placeholder="Path to the selected stack CLI home"
          onChange={(event) => setSettings((value) => ({ ...value, homeDir: event.target.value }))}
        />
      </div>
      <div className="form-group">
        <label htmlFor="happier-active-server-id">Active server ID</label>
        <input
          id="happier-active-server-id"
          value={settings.activeServerId}
          placeholder="stack_...__id_default"
          onChange={(event) => setSettings((value) => ({ ...value, activeServerId: event.target.value }))}
        />
      </div>
      <div className="form-group">
        <label htmlFor="happier-server">Server URL</label>
        <input
          id="happier-server"
          type="url"
          value={settings.serverUrl}
          placeholder="http://localhost:52211"
          onChange={(event) => setSettings((value) => ({ ...value, serverUrl: event.target.value }))}
        />
      </div>
      <div className="form-group">
        <label htmlFor="happier-public-server">Public server URL</label>
        <input
          id="happier-public-server"
          type="url"
          value={settings.publicServerUrl}
          placeholder="http://localhost:52211"
          onChange={(event) => setSettings((value) => ({ ...value, publicServerUrl: event.target.value }))}
        />
      </div>
      <div className="form-group">
        <label htmlFor="happier-webapp">Web app URL (optional)</label>
        <input
          id="happier-webapp"
          type="url"
          value={settings.webappUrl}
          onChange={(event) => setSettings((value) => ({ ...value, webappUrl: event.target.value }))}
        />
      </div>
      <div className="form-group">
        <label htmlFor="happier-profile">Profile (optional)</label>
        <input
          id="happier-profile"
          value={settings.profile}
          onChange={(event) => setSettings((value) => ({ ...value, profile: event.target.value }))}
        />
      </div>
      <div className="form-group">
        <label htmlFor="happier-timeout">Probe timeout (ms)</label>
        <input
          id="happier-timeout"
          type="number"
          min={MIN_TIMEOUT_MS}
          max={MAX_TIMEOUT_MS}
          step={1_000}
          value={settings.timeoutMs}
          onChange={(event) => setSettings((value) => ({
            ...value,
            timeoutMs: boundedNumber(
              Number(event.target.value),
              DEFAULT_SETTINGS.timeoutMs,
              MIN_TIMEOUT_MS,
              MAX_TIMEOUT_MS,
            ),
          }))}
        />
      </div>
      <div className="form-group">
        <label htmlFor="happier-output-limit">Maximum probe output (bytes)</label>
        <input
          id="happier-output-limit"
          type="number"
          min={MIN_OUTPUT_BYTES}
          max={MAX_OUTPUT_BYTES}
          step={1_024}
          value={settings.maxOutputBytes}
          onChange={(event) => setSettings((value) => ({
            ...value,
            maxOutputBytes: boundedNumber(
              Number(event.target.value),
              DEFAULT_SETTINGS.maxOutputBytes,
              MIN_OUTPUT_BYTES,
              MAX_OUTPUT_BYTES,
            ),
          }))}
        />
      </div>
      <small>Authentication tokens and provider credentials are deliberately not accepted here.</small>
    </RuntimeCardShell>
  );
}

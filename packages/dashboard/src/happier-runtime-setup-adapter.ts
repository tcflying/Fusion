import { createHash } from "node:crypto";

import {
  normalizeHappierSessionBindings,
  safeHappierSettingString,
  validateHappierRuntimeSettings,
  type HappierRuntimeBackend,
  type HappierRuntimeSessionBinding,
  type SessionConnectorHealthV1,
} from "@fusion/core";
import {
  HappierSessionConnector,
  HAPPIER_RUNTIME_COMPATIBILITY,
  listHappierSessions,
  type HappierCliSettings,
} from "@fusion-plugin-examples/happier-runtime";
import { probeHappierProvider } from "./runtime-provider-probes.js";
import type {
  HappierBindingState,
  HappierCandidateBindingState,
  HappierCapabilityProbeSample,
  HappierDiscoveryResult,
  HappierNativeSessionCandidate,
  HappierNativeSessionRecord,
  HappierReconciledBinding,
  HappierRemoteSessionCandidate,
  HappierRuntimeSetupSources,
  HappierRuntimeSetupStatus,
  ReadHappierRuntimeSetupStatusInput,
} from "./happier-runtime-setup-contract.js";

export type {
  HappierBindingState,
  HappierCandidateBindingState,
  HappierCapabilityProbeSample,
  HappierDiscoveryResult,
  HappierDiscoveryState,
  HappierNativeSessionCandidate,
  HappierNativeSessionRecord,
  HappierReconciledBinding,
  HappierRemoteSessionCandidate,
  HappierRuntimeSetupSources,
  HappierRuntimeSetupStatus,
  ReadHappierRuntimeSetupStatusInput,
} from "./happier-runtime-setup-contract.js";

function providerFromCanonicalSession(canonicalSessionUri: string): HappierRuntimeBackend {
  return canonicalSessionUri.slice(0, canonicalSessionUri.indexOf(":")) as HappierRuntimeBackend;
}

function nativeIdFromCanonicalSession(canonicalSessionUri: string): string {
  const path = new URL(canonicalSessionUri).pathname.replace(/^\/+/u, "");
  return decodeURIComponent(path);
}

function stringSetting(settings: Record<string, unknown>, key: string, maximum = 2_000): string | null {
  return safeHappierSettingString(settings[key], maximum);
}

/* Windows process-tree termination is part of a timed CLI observation. Keep the
 * setup response bounded while allowing one 5s command to be reaped and the
 * independently verified bound-session observations to finish. */
export const HAPPIER_SETUP_READ_TIMEOUT_MS = 20_000;
const HAPPIER_SETUP_OPERATION_TIMEOUT_MS = 5_000;

function boundedHappierSetupSettings(settings: Record<string, unknown>): HappierCliSettings {
  const cap = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.min(value, HAPPIER_SETUP_OPERATION_TIMEOUT_MS)
      : HAPPIER_SETUP_OPERATION_TIMEOUT_MS;
  return {
    ...settings,
    timeoutMs: cap(settings.timeoutMs),
    connectTimeoutMs: cap(settings.connectTimeoutMs),
    toolTimeoutMs: cap(settings.toolTimeoutMs),
  } as HappierCliSettings;
}

/** A setup screen is observational only and must never hold an HTTP request indefinitely. */
export async function withinHappierSetupDeadline<T>(
  operation: Promise<T>,
  timeoutMs = HAPPIER_SETUP_READ_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Happier setup read timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function unavailableRuntimeHealth(settings: HappierCliSettings) {
  const backendId = settings.backend === "claude" || settings.backend === "opencode"
    ? settings.backend
    : "codex" as const;
  return {
    discovered: false,
    executable: false,
    server: false,
    serverState: "not-probed" as const,
    authenticated: false,
    daemon: false,
    backend: false,
    ready: false,
    backendId,
    modelId: null,
    modelState: "not_reported" as const,
    attestation: { ok: false as const, reasonCode: "cli_version_probe_failed" as const },
    details: ["setup-read-timeout"],
  };
}

export function computeHappierBindingRevision(
  bindings: readonly HappierRuntimeSessionBinding[],
): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(bindings)).digest("hex")}`;
}

function sameEvidenceIdentity(
  binding: HappierRuntimeSessionBinding,
  evidence: HappierCapabilityProbeSample,
): boolean {
  return evidence.canonicalSessionUri === binding.canonicalSessionUri
    && evidence.providerId === providerFromCanonicalSession(binding.canonicalSessionUri)
    && evidence.happierSessionId === binding.happierSessionId
    && evidence.serverProfileId === binding.serverProfileId
    && evidence.machineId === binding.machineId;
}

function candidateState(bound: boolean, conflicts: readonly string[]): HappierCandidateBindingState {
  if (conflicts.length > 0) return "conflict";
  return bound ? "bound" : "unbound";
}

/**
 * Project the Core binding registry and plugin-owned typed health into one
 * Dashboard view. This adapter deliberately derives presentation state; it
 * does not introduce a second runtime-health or binding authority.
 */
export function buildHappierRuntimeSetupStatus(
  sources: HappierRuntimeSetupSources,
): HappierRuntimeSetupStatus {
  const normalized = normalizeHappierSessionBindings(
    sources.settings.happierSessionBindings ?? [],
  );
  const validationErrors = [
    ...new Set([
      ...normalized.errors,
      ...validateHappierRuntimeSettings(sources.settings),
    ]),
  ].sort();
  const conflicts = validationErrors.filter((error) => /conflict/iu.test(error));
  const nativeUris = new Set(
    sources.nativeDiscovery.candidates.map((candidate) => candidate.canonicalSessionUri),
  );
  const happierIds = new Set(
    sources.happierDiscovery.candidates.map((candidate) => candidate.happierSessionId),
  );

  /*
   * FNXC:HappierBindingReconciliation 2026-07-27-06:19:
   * Reconcile every persisted tuple in both directions. A missing discovery
   * source is "unverified", a known-missing identity is drift, and OpenCode
   * remains unverified without machine-scoped availability evidence.
   */
  const bindings: HappierReconciledBinding[] = normalized.bindings.map((binding) => {
    const providerId = providerFromCanonicalSession(binding.canonicalSessionUri);
    const driftReasons: string[] = [];
    if (sources.nativeDiscovery.state === "unavailable") {
      driftReasons.push("native-session-discovery-unavailable");
    } else if (!nativeUris.has(binding.canonicalSessionUri)) {
      driftReasons.push("native-session-missing");
    }
    if (sources.happierDiscovery.state === "unavailable") {
      driftReasons.push("happier-session-discovery-unavailable");
    } else if (!happierIds.has(binding.happierSessionId)) {
      driftReasons.push("happier-session-missing");
    }
    const probeEvidence = sources.capabilityEvidence.find((sample) =>
      sameEvidenceIdentity(binding, sample)) ?? null;
    if (!probeEvidence) {
      driftReasons.push("probe-evidence-missing");
    } else if (probeEvidence.state !== "available") {
      driftReasons.push("probe-unavailable");
    }
    const openCodeMachineUnverified = providerId === "opencode"
      && sources.runtimeHealth.details.includes("backend-machine-availability-unverified");
    if (openCodeMachineUnverified) driftReasons.push("machine-availability-unverified");

    // A failed or withheld probe cannot establish that the exact remote
    // identity changed. Keep it fail-closed, but render it as unverified so
    // operators can distinguish transient observation loss from real drift.
    const hasKnownDrift = driftReasons.some((reason) =>
      reason === "native-session-missing"
      || reason === "happier-session-missing");
    const state: HappierBindingState = conflicts.length > 0
      ? "conflict"
      : hasKnownDrift
        ? "drift"
        : driftReasons.length > 0
          ? "unverified"
          : "verified";
    return {
      ...binding,
      providerId,
      nativeSessionId: nativeIdFromCanonicalSession(binding.canonicalSessionUri),
      state,
      driftReasons,
      machineAvailability: probeEvidence?.state === "available" && !openCodeMachineUnverified
        ? "verified"
        : "unverified",
      probeEvidence,
    };
  });

  const machineMap = new Map<string, {
    providerIds: Set<HappierRuntimeBackend>;
    bindingCount: number;
    availability: "verified" | "unverified";
  }>();
  for (const binding of bindings) {
    const current = machineMap.get(binding.machineId) ?? {
      providerIds: new Set<HappierRuntimeBackend>(),
      bindingCount: 0,
      availability: "verified" as const,
    };
    current.providerIds.add(binding.providerId);
    current.bindingCount += 1;
    if (binding.machineAvailability !== "verified") current.availability = "unverified";
    machineMap.set(binding.machineId, current);
  }

  const acceptedBindings = normalized.errors.length > 0 ? [] : normalized.bindings;
  const revision = computeHappierBindingRevision(acceptedBindings);
  const failClosed = validationErrors.length > 0
    || !sources.runtimeHealth.ready
    || sources.connectorHealth?.state !== "healthy"
    || bindings.length === 0
    || bindings.some((binding) => binding.state !== "verified");

  return {
    failClosed,
    bindingRevision: revision,
    validationErrors,
    conflicts,
    runtimeHealth: sources.runtimeHealth,
    connectorHealth: sources.connectorHealth,
    connectorReadError: sources.connectorReadError ?? null,
    compatibility: HAPPIER_RUNTIME_COMPATIBILITY,
    server: {
      activeServerId: stringSetting(sources.settings, "activeServerId"),
      profile: stringSetting(sources.settings, "profile"),
      serverUrl: stringSetting(sources.settings, "serverUrl"),
      publicServerUrl: stringSetting(sources.settings, "publicServerUrl"),
      webappUrl: stringSetting(sources.settings, "webappUrl"),
    },
    cli: {
      configuredEntrypoint: stringSetting(sources.settings, "entrypoint", 4_096),
      allowedRoots: Array.isArray(sources.settings.allowedCliRoots)
        ? sources.settings.allowedCliRoots.filter((root): root is string =>
          safeHappierSettingString(root, 4_096) !== null)
        : [],
      attestation: sources.runtimeHealth.attestation,
    },
    authentication: {
      runtimeAuthenticated: sources.runtimeHealth.authenticated,
      connector: sources.connectorHealth?.authentication ?? "unavailable",
    },
    machines: [...machineMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([machineId, machine]) => ({
        machineId,
        providerIds: [...machine.providerIds].sort(),
        bindingCount: machine.bindingCount,
        availability: machine.availability,
      })),
    bindings,
    discovery: {
      nativeState: sources.nativeDiscovery.state,
      nativeReason: sources.nativeDiscovery.reason ?? null,
      nativeCandidates: sources.nativeDiscovery.candidates.map((candidate) => ({
        ...candidate,
        bindingState: candidateState(
          normalized.bindings.some((binding) =>
            binding.canonicalSessionUri === candidate.canonicalSessionUri),
          conflicts,
        ),
      })),
      happierState: sources.happierDiscovery.state,
      happierReason: sources.happierDiscovery.reason ?? null,
      happierCandidates: sources.happierDiscovery.candidates.map((candidate) => ({
        ...candidate,
        bindingState: candidateState(
          normalized.bindings.some((binding) =>
            binding.happierSessionId === candidate.happierSessionId),
          conflicts,
        ),
      })),
    },
  };
}

const NATIVE_ADAPTER_PROVIDERS: Readonly<Record<string, HappierRuntimeBackend>> = {
  codex: "codex",
  "claude-code": "claude",
  claude: "claude",
  opencode: "opencode",
};

export function discoverNativeHappierSessions(
  sessions: readonly HappierNativeSessionRecord[] | undefined,
  projectId?: string,
  confirmedBindings: readonly HappierRuntimeSessionBinding[] = [],
): HappierDiscoveryResult<HappierNativeSessionCandidate> {
  if (!sessions && confirmedBindings.length === 0) {
    return {
      state: "unavailable",
      candidates: [],
      reason: "Fusion CLI session availability and confirmed external bindings are unavailable",
    };
  }
  const byCanonicalUri = new Map<string, HappierNativeSessionCandidate>();
  for (const session of sessions ?? []) {
    if (projectId && session.projectId !== projectId) continue;
    const providerId = NATIVE_ADAPTER_PROVIDERS[session.adapterId];
    const nativeSessionId = safeHappierSettingString(session.nativeSessionId);
    const sourceSessionId = safeHappierSettingString(session.id);
    if (!providerId || !nativeSessionId || !sourceSessionId) continue;
    const host = providerId === "codex" ? "threads" : "sessions";
    const canonicalSessionUri = `${providerId}://${host}/${encodeURIComponent(nativeSessionId)}`;
    byCanonicalUri.set(canonicalSessionUri, {
      canonicalSessionUri,
      providerId,
      nativeSessionId,
      sourceSessionId,
      source: "fusion-cli-session",
    });
  }
  // A persisted binding is only created by the explicitly-confirmed mutation
  // route. Project it for reconciliation when Fusion has no local CLI record,
  // but keep its provenance visible and do not synthesize a CLI session.
  for (const binding of confirmedBindings) {
    if (byCanonicalUri.has(binding.canonicalSessionUri)) continue;
    const providerId = providerFromCanonicalSession(binding.canonicalSessionUri);
    const nativeSessionId = nativeIdFromCanonicalSession(binding.canonicalSessionUri);
    const sourceSessionId = safeHappierSettingString(binding.happierSessionId);
    if (!nativeSessionId || !sourceSessionId) continue;
    byCanonicalUri.set(binding.canonicalSessionUri, {
      canonicalSessionUri: binding.canonicalSessionUri,
      providerId,
      nativeSessionId,
      sourceSessionId,
      source: "confirmed-happier-binding",
    });
  }
  return {
    state: "available",
    candidates: [...byCanonicalUri.values()].sort((left, right) =>
      left.canonicalSessionUri.localeCompare(right.canonicalSessionUri, "en")),
  };
}

/**
 * Read-only setup aggregation. It probes the plugin's existing typed health,
 * samples every persisted binding through the connector, and lists candidate
 * sessions. It never calls ensure/create/send or mutates either session store.
 */
export async function readHappierRuntimeSetupStatus(
  input: ReadHappierRuntimeSetupStatusInput,
): Promise<HappierRuntimeSetupStatus> {
  const settings = boundedHappierSetupSettings(input.settings);
  const runtimeHealth = await withinHappierSetupDeadline(
    probeHappierProvider(settings),
  ).catch(() => unavailableRuntimeHealth(settings));
  let connectorHealth: SessionConnectorHealthV1 | null = null;
  let capabilityEvidence: readonly HappierCapabilityProbeSample[] = [];
  let connectorReadError: string | undefined;
  try {
    const connector = new HappierSessionConnector({
      settings,
      dependencies: {
        probeRuntime: async () => runtimeHealth,
        attestCli: async () => runtimeHealth.attestation,
      },
    });
    connectorHealth = await withinHappierSetupDeadline(
      connector.getHealth(input.hostId ?? "fusion-dashboard"),
    );
    capabilityEvidence = await connector.getCapabilityProbeEvidence();
  } catch {
    connectorReadError = "Happier connector health is unavailable";
  }

  const nativeDiscovery = discoverNativeHappierSessions(
    input.nativeSessions,
    input.projectId,
    normalizeHappierSessionBindings(input.settings.happierSessionBindings ?? []).bindings,
  );
  let happierDiscovery: HappierDiscoveryResult<HappierRemoteSessionCandidate>;
  if (!runtimeHealth.attestation.ok || !runtimeHealth.authenticated) {
    happierDiscovery = {
      state: "unavailable",
      candidates: [],
      reason: runtimeHealth.attestation.ok
        ? "Happier authentication is required for session discovery"
        : "CLI attestation is required for session discovery",
    };
  } else {
    try {
      const listed = await withinHappierSetupDeadline(listHappierSessions(settings));
      happierDiscovery = {
        state: "available",
        candidates: listed.sessions.map((session) => ({
          happierSessionId: session.id,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          ...(session.active === undefined ? {} : { active: session.active }),
          ...(session.archivedAt === undefined ? {} : { archivedAt: session.archivedAt }),
          ...(session.tag === undefined ? {} : { tag: session.tag }),
          ...(session.path === undefined ? {} : { path: session.path }),
          ...(session.agentId === undefined ? {} : { agentId: session.agentId }),
        })),
      };
    } catch {
      happierDiscovery = {
        state: "unavailable",
        candidates: [],
        reason: "Happier session discovery failed",
      };
    }
  }

  return buildHappierRuntimeSetupStatus({
    settings: input.settings,
    runtimeHealth,
    connectorHealth,
    connectorReadError,
    capabilityEvidence,
    nativeDiscovery,
    happierDiscovery,
  });
}

import { spawn } from "node:child_process";

import {
  HAPPIER_DEFAULT_BACKEND,
  resolveHappierBackend,
  resolveHappierBackendFromCanonicalSessionUri,
} from "./backend-resolver.js";
import {
  verifyHappierCliAttestation,
  type HappierCliAttestation,
} from "./cli-attestation.js";
import {
  buildHappierInvocation,
  buildHappierProcessEnv,
  parseHappierJson,
  redactHappierOutput,
  resolveHappierCliSettings,
} from "./cli-spawn.js";
import {
  HappierCliError,
  type HappierBackend,
  type HappierCliSettings,
  type HappierJsonEnvelope,
  type HappierJsonRecord,
} from "./types.js";
import { terminateHappierProcessTree } from "./process-lifecycle.js";

export interface HappierRuntimeHealth {
  discovered: boolean;
  executable: boolean;
  server: boolean;
  serverState: "reachable" | "unreachable" | "not-probed";
  authenticated: boolean;
  daemon: boolean;
  backend: boolean;
  ready: boolean;
  backendId: HappierBackend;
  modelId: string | null;
  modelState: "not_reported";
  attestation: HappierCliAttestation;
  details: string[];
}

interface ProbeCommandResult {
  exitCode: number | null;
  stdout: string;
}

export interface HappierProbeDependencies {
  run(commandArgs: readonly string[], settings: HappierCliSettings): Promise<ProbeCommandResult>;
  attestCli(settings: HappierCliSettings): Promise<HappierCliAttestation>;
}

const defaultProbeDependencies: HappierProbeDependencies = {
  run: runHappierProbeCommand,
  attestCli: verifyHappierCliAttestation,
};

function isRecord(value: unknown): value is HappierJsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function backendHelpArgs(backend: HappierBackend): string[] {
  return [backend, "--help"];
}

export function runHappierProbeCommand(
  commandArgs: readonly string[],
  settings: HappierCliSettings,
): Promise<ProbeCommandResult> {
  const resolved = resolveHappierCliSettings(settings);
  const invocation = buildHappierInvocation(commandArgs, resolved);

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void terminateHappierProcessTree(child);
      reject(new HappierCliError("timeout", `Happier probe timed out after ${resolved.timeoutMs}ms`));
    }, resolved.timeoutMs);

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    try {
      child = spawn(invocation.command, invocation.args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
        env: buildHappierProcessEnv(resolved),
      });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > resolved.maxOutputBytes) {
        void terminateHappierProcessTree(child);
        fail(new HappierCliError("output-limit", "Happier probe output exceeded the configured limit"));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.once("error", (error) => fail(error));
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout: Buffer.concat(chunks, bytes).toString("utf8") });
    });
  });
}

function parseRawJson(result: ProbeCommandResult): HappierJsonRecord {
  if (result.exitCode !== 0) throw new HappierCliError("process", `Happier probe command exited with code ${String(result.exitCode)}`);
  try {
    const parsed: unknown = JSON.parse(result.stdout.trim());
    if (!isRecord(parsed)) throw new Error("expected an object");
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new HappierCliError("invalid-json", `Happier probe returned malformed JSON: ${redactHappierOutput(message, 256)}`);
  }
}

function authFromEnvelope(envelope: HappierJsonEnvelope<unknown>): boolean {
  return envelope.ok === true && isRecord(envelope.data) && envelope.data.authenticated === true;
}

function profileSupportsBackend(envelope: HappierJsonEnvelope<unknown>, backend: HappierBackend): boolean {
  if (!envelope.ok || !isRecord(envelope.data) || !Array.isArray(envelope.data.profiles)) return false;
  return envelope.data.profiles.some((profile) => {
    if (!isRecord(profile) || !Array.isArray(profile.supportedAgentIds)) return false;
    return profile.supportedAgentIds.includes(backend);
  });
}

function activeReachability(status: HappierJsonRecord): string | undefined {
  const report = isRecord(status.report) ? status.report : undefined;
  const profiles = report && Array.isArray(report.authProfiles) ? report.authProfiles : [];
  const active = profiles.find((profile) => isRecord(profile) && profile.isActive === true);
  return isRecord(active) && typeof active.reachability === "string" ? active.reachability : undefined;
}

function daemonRunningFromStatus(status: HappierJsonRecord): boolean {
  const directDaemon = isRecord(status.daemon) ? status.daemon : undefined;
  const legacyDaemonStatus = isRecord(status.daemonStatus) ? status.daemonStatus : undefined;
  const daemon = directDaemon ?? (legacyDaemonStatus && isRecord(legacyDaemonStatus.daemon)
    ? legacyDaemonStatus.daemon
    : undefined);
  return daemon?.running === true;
}

function resolveHealthBinding(
  settings: HappierCliSettings,
  backend: HappierBackend,
): NonNullable<HappierCliSettings["happierSessionBindings"]>[number] | null {
  const candidates = (settings.happierSessionBindings ?? [])
    .filter((binding) => resolveHappierBackendFromCanonicalSessionUri(binding.canonicalSessionUri) === backend)
    .toSorted((left, right) => [
      left.serverProfileId,
      left.machineId,
      left.happierSessionId,
      left.canonicalSessionUri,
    ].join("\u0000").localeCompare([
      right.serverProfileId,
      right.machineId,
      right.happierSessionId,
      right.canonicalSessionUri,
    ].join("\u0000")));
  return candidates[0] ?? null;
}

function isExactBoundSessionStatus(
  envelope: HappierJsonEnvelope<unknown>,
  happierSessionId: string,
): boolean {
  if (!envelope.ok || envelope.kind !== "session_status" || !isRecord(envelope.data)) return false;
  const session = isRecord(envelope.data.session) ? envelope.data.session : null;
  return session?.id === happierSessionId && session.active === true;
}

function isExactBoundBackendModelInventory(
  envelope: HappierJsonEnvelope<unknown>,
  happierSessionId: string,
  backend: HappierBackend,
): boolean {
  if (!envelope.ok || envelope.kind !== "session_actions_execute" || !isRecord(envelope.data)) return false;
  const result = isRecord(envelope.data.result) ? envelope.data.result : null;
  const items = result && Array.isArray(result.items) ? result.items : [];
  return envelope.data.sessionId === happierSessionId
    && envelope.data.actionId === "agents.models.list"
    && result?.agentId === backend
    && result.source === "session_metadata"
    && items.some((item) => isRecord(item) && typeof item.id === "string" && item.id.trim().length > 0);
}

/** Probe every required Happier layer without creating or mutating a session. */
export async function probeHappierRuntime(
  settings: HappierCliSettings = {},
  dependencies: HappierProbeDependencies = defaultProbeDependencies,
): Promise<HappierRuntimeHealth> {
  let backendId = HAPPIER_DEFAULT_BACKEND;
  const details: string[] = [];
  let discovered = false;
  let executable = false;
  let server = false;
  let serverState: HappierRuntimeHealth["serverState"] = "not-probed";
  let authenticated = false;
  let daemon = false;
  let backend = false;
  try {
    backendId = resolveHappierBackend(settings);
  } catch {
    const attestation = await dependencies.attestCli(settings);
    return {
      discovered,
      executable,
      server,
      serverState,
      authenticated,
      daemon,
      backend,
      ready: false,
      backendId,
      modelId: null,
      modelState: "not_reported",
      attestation,
      details: ["backend-config-invalid"],
    };
  }

  const attestation = await dependencies.attestCli(settings);
  if (!attestation.ok) {
    return {
      discovered,
      executable,
      server,
      serverState,
      authenticated,
      daemon,
      backend,
      ready: false,
      backendId,
      modelId: null,
      modelState: "not_reported",
      attestation,
      details: ["cli-attestation-failed"],
    };
  }

  try {
    const help = await dependencies.run(backendHelpArgs(backendId), settings);
    executable = help.exitCode === 0 && help.stdout.trim().length > 0;
    discovered = executable;
    if (!executable) details.push("executable-unavailable");
  } catch (error) {
    const code = error instanceof HappierCliError ? error.code : "process";
    details.push(code === "timeout" ? "executable-timeout" : "executable-not-found");
  }

  if (executable) {
    let authServerUnreachable = false;
    /*
     * The three host observations are independent. Running them serially made
     * one slow `status --json` consume the whole setup budget before the bound
     * session could be checked. Each child still owns its own timeout and
     * process-tree cleanup; concurrency changes latency, not trust criteria.
     */
    const [authAttempt, daemonAttempt, profilesAttempt] = await Promise.allSettled([
      dependencies.run(["auth", "status", "--json"], settings),
      dependencies.run(["daemon", "status", "--json"], settings),
      dependencies.run(["profiles", "list", "--json"], settings),
    ]);
    if (authAttempt.status === "fulfilled") {
      try {
        const authRaw = authAttempt.value;
      const auth = await parseHappierJson(authRaw.stdout, 64 * 1024);
      authenticated = authRaw.exitCode === 0 && authFromEnvelope(auth);
      if (!authenticated) {
        const errorCode = !auth.ok && typeof auth.error.code === "string" ? auth.error.code : "not_authenticated";
        authServerUnreachable = /server|network|connection/i.test(errorCode);
        if (authServerUnreachable) details.push("server-unreachable");
        details.push("authentication-required");
      }
      } catch {
        details.push("authentication-invalid");
      }
    } else {
      const error = authAttempt.reason;
      details.push(error instanceof HappierCliError && error.code === "timeout" ? "authentication-timeout" : "authentication-invalid");
    }

    // FNXC:HappierRuntime 2026-07-14-10:13: Happier may retain authenticated=true
    // when network validation is unknown. Only explicit reachability is evidence.
    if (authServerUnreachable) serverState = "unreachable";
    server = false;

    if (daemonAttempt.status === "fulfilled") {
      try {
        const status = parseRawJson(daemonAttempt.value);
      daemon = daemonRunningFromStatus(status);
      const reachability = activeReachability(status);
      // Kept for compatibility with older official status envelopes. The
      // current lightweight daemon command has no relay reachability field;
      // a successful bound-session --live action below provides that proof.
      if (reachability === "reachable" || reachability === "verified") {
        serverState = "reachable";
        server = true;
      } else if (reachability === "unreachable") {
        serverState = "unreachable";
      }
      if (!daemon) details.push("daemon-stopped");
      } catch {
        details.push("daemon-status-invalid");
      }
    } else {
      const error = daemonAttempt.reason;
      details.push(error instanceof HappierCliError && error.code === "timeout" ? "daemon-status-timeout" : "daemon-status-invalid");
    }

    if (profilesAttempt.status === "fulfilled") {
      try {
        const profilesRaw = profilesAttempt.value;
      const profiles = await parseHappierJson(profilesRaw.stdout, 64 * 1024);
      const profileAvailable = profileSupportsBackend(profiles, backendId);
      const binding = resolveHealthBinding(settings, backendId);
      if (profilesRaw.exitCode !== 0 || !profileAvailable) {
        details.push("backend-unavailable");
      } else if (!binding) {
        /*
         * FNXC:HappierRuntimeHealthTruth 2026-07-27-16:15:
         * A profile is only a compatibility catalog. Backend health requires
         * an exact bound Session plus the official live status and
         * session-scoped model inventory actions; absent identity stays
         * fail-closed for every backend.
         */
        details.push("backend-machine-availability-unverified");
      } else {
        const [sessionStatusAttempt, modelInventoryAttempt] = await Promise.allSettled([
          dependencies.run(
            ["session", "status", binding.happierSessionId, "--live", "--json"],
            settings,
          ),
          dependencies.run([
            "session",
            "actions",
            "execute",
            binding.happierSessionId,
            "agents.models.list",
            "--input-json",
            JSON.stringify({ agentId: backendId, limit: 200 }),
            "--json",
          ], settings),
        ]);
        if (sessionStatusAttempt.status !== "fulfilled" || modelInventoryAttempt.status !== "fulfilled") {
          if (sessionStatusAttempt.status === "rejected") throw sessionStatusAttempt.reason;
          if (modelInventoryAttempt.status === "rejected") throw modelInventoryAttempt.reason;
        }
        const sessionStatusRaw = sessionStatusAttempt.value;
        const modelInventoryRaw = modelInventoryAttempt.value;
        const [sessionStatus, modelInventory] = await Promise.all([
          parseHappierJson(sessionStatusRaw.stdout, 64 * 1024),
          parseHappierJson(modelInventoryRaw.stdout, 64 * 1024),
        ]);
        backend = sessionStatusRaw.exitCode === 0
          && modelInventoryRaw.exitCode === 0
          && isExactBoundSessionStatus(sessionStatus, binding.happierSessionId)
          && isExactBoundBackendModelInventory(modelInventory, binding.happierSessionId, backendId);
        if (sessionStatusRaw.exitCode === 0
          && isExactBoundSessionStatus(sessionStatus, binding.happierSessionId)) {
          server = true;
          serverState = "reachable";
        }
        if (backend) {
          /*
           * FNXC:HappierRuntimeHealthTruth 2026-07-27-16:15:
           * Happier 0.2.10 proves the bound backend and its model inventory,
           * but neither official action reports the selected model. Keep the
           * model null and withhold ready instead of assuming "default".
           */
          details.push("model-not-reported");
        } else {
          details.push("backend-machine-availability-unverified");
        }
      }
      } catch (error) {
        details.push(error instanceof HappierCliError && error.code === "timeout" ? "backend-timeout" : "backend-invalid");
      }
    } else {
      const error = profilesAttempt.reason;
      details.push(error instanceof HappierCliError && error.code === "timeout" ? "backend-timeout" : "backend-invalid");
    }
  }

  if (executable && !server) {
    details.push(serverState === "unreachable" ? "server-unreachable" : "server-not-probed");
  }

  const ready = executable
    && server
    && authenticated
    && daemon
    && backend
    && !details.includes("model-not-reported");
  return {
    discovered,
    executable,
    server,
    serverState,
    authenticated,
    daemon,
    backend,
    ready,
    backendId,
    modelId: null,
    modelState: "not_reported",
    attestation,
    details: [...new Set(details)].slice(0, 12),
  };
}

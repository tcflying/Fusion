import { spawn } from "node:child_process";

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
  details: string[];
}

interface ProbeCommandResult {
  exitCode: number | null;
  stdout: string;
}

export interface HappierProbeDependencies {
  run(commandArgs: readonly string[], settings: HappierCliSettings): Promise<ProbeCommandResult>;
}

function isRecord(value: unknown): value is HappierJsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function selectedBackend(settings: HappierCliSettings): HappierBackend {
  return settings.backend === "codex" || settings.backend === "opencode" ? settings.backend : "claude";
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
      child?.kill("SIGTERM");
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
        child?.kill("SIGTERM");
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

/** Probe every required Happier layer without creating or mutating a session. */
export async function probeHappierRuntime(
  settings: HappierCliSettings = {},
  dependencies: HappierProbeDependencies = { run: runHappierProbeCommand },
): Promise<HappierRuntimeHealth> {
  const backendId = selectedBackend(settings);
  const details: string[] = [];
  let discovered = false;
  let executable = false;
  let server = false;
  let serverState: HappierRuntimeHealth["serverState"] = "not-probed";
  let authenticated = false;
  let daemon = false;
  let backend = false;

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
    try {
      const authRaw = await dependencies.run(["auth", "status", "--json"], settings);
      const auth = await parseHappierJson(authRaw.stdout, 64 * 1024);
      authenticated = authRaw.exitCode === 0 && authFromEnvelope(auth);
      if (!authenticated) {
        const errorCode = !auth.ok && typeof auth.error.code === "string" ? auth.error.code : "not_authenticated";
        authServerUnreachable = /server|network|connection/i.test(errorCode);
        if (authServerUnreachable) details.push("server-unreachable");
        details.push("authentication-required");
      }
    } catch (error) {
      details.push(error instanceof HappierCliError && error.code === "timeout" ? "authentication-timeout" : "authentication-invalid");
    }

    // FNXC:HappierRuntime 2026-07-14-10:13: Happier may retain authenticated=true
    // when network validation is unknown. Only explicit reachability is evidence.
    if (authServerUnreachable) serverState = "unreachable";
    server = false;

    try {
      const status = parseRawJson(await dependencies.run(["status", "--json"], settings));
      const daemonStatus = isRecord(status.daemonStatus) ? status.daemonStatus : status;
      const daemonRecord = isRecord(daemonStatus.daemon) ? daemonStatus.daemon : undefined;
      daemon = daemonRecord?.running === true;
      const reachability = activeReachability(status);
      // FNXC:HappierRuntime 2026-07-14-12:46: Current Happier reports a successfully checked active relay as "verified"; normalize it to Fusion's public reachable state so a healthy native Windows stack is not shown as unavailable.
      if (reachability === "reachable" || reachability === "verified") serverState = "reachable";
      else if (reachability === "unreachable") serverState = "unreachable";
      server = serverState === "reachable";
      if (!server) details.push(serverState === "unreachable" ? "server-unreachable" : "server-not-probed");
      if (!daemon) details.push("daemon-stopped");
    } catch (error) {
      details.push(error instanceof HappierCliError && error.code === "timeout" ? "status-timeout" : "status-invalid");
      if (serverState === "not-probed") details.push("server-not-probed");
    }

    try {
      const profilesRaw = await dependencies.run(["profiles", "list", "--json"], settings);
      const profiles = await parseHappierJson(profilesRaw.stdout, 64 * 1024);
      const profileAvailable = backendId === "opencode" || profileSupportsBackend(profiles, backendId);
      backend = profilesRaw.exitCode === 0 && profileAvailable;
      if (!backend) details.push("backend-unavailable");
    } catch (error) {
      details.push(error instanceof HappierCliError && error.code === "timeout" ? "backend-timeout" : "backend-invalid");
    }
  }

  const ready = executable && server && authenticated && daemon && backend;
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
    details: [...new Set(details)].slice(0, 12),
  };
}

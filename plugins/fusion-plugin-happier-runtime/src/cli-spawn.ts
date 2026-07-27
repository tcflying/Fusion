import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import {
  terminateHappierProcessTree,
  waitForHappierProcessClose,
} from "./process-lifecycle.js";
import {
  HAPPIER_BACKENDS,
  HAPPIER_DEFAULT_PROVIDER_WAIT_TIMEOUT_SECONDS,
  HappierCliError,
  type HappierBackend,
  type HappierCliInvocation,
  type HappierCliSettings,
  type HappierSessionBinding,
  type HappierDirectSessionEnsureResult,
  type HappierDirectSessionEvent,
  type HappierDirectSessionSource,
  type HappierDirectSessionStatusDelta,
  type HappierDirectSessionTranscriptDelta,
  type HappierDirectSessionTranscriptInput,
  type HappierDirectSessionTranscriptRawMessage,
  type HappierErrorCode,
  type HappierFailureEnvelope,
  type HappierJsonEnvelope,
  type HappierJsonRecord,
  type HappierMessageInput,
  type HappierSessionCreateInput,
  type HappierSessionCreateResult,
  type HappierSessionHistoryResult,
  type HappierSessionListItem,
  type HappierSessionListResult,
  type HappierSessionMessageResult,
  type HappierSessionStopResult,
  type HappierSessionStatusResult,
  type HappierSuccessEnvelope,
} from "./types.js";
import {
  buildHappierTransportMessage,
  type HappierRuntimePermissionMode,
} from "./runtime-options.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_TIMEOUT_GRACE_MS = 5_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const REDACTED = "[REDACTED]";
const HAPPIER_PROCESS_ENV_ALLOWLIST = new Set([
  "ALL_PROXY",
  "APPDATA",
  "COLORTERM",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "TZ",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
]);
const SENSITIVE_KEYS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "bearertoken",
  "clientsecret",
  "encryptionkey",
  "key",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "sessionsecret",
  "token",
  "cookie",
]);

const BEARER_RE = /\bBearer\s+[^\s"'`,;\]}]+/gi;
const SENSITIVE_ASSIGNMENT_RE = /(["']?)(access(?:[_-]?token|[_-]?key)|client[_-]?secret|private[_-]?key|refresh[_-]?token|session[_-]?secret|authorization|bearer[_-]?token|cookie|token|secret|password|key)\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;\]}]+)/gi;

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(normalizeKey(key));
}

function redactText(value: string): string {
  return value
    .replace(BEARER_RE, "Bearer [REDACTED]")
    .replace(SENSITIVE_ASSIGNMENT_RE, (match, quote: string, key: string, separator: string) => {
      return isSensitiveKey(key) ? `${quote}${key}${quote}${separator}${REDACTED}` : match;
    });
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, isSensitiveKey(key) ? REDACTED : redactValue(nested)]),
    );
  }
  return typeof value === "string" ? redactText(value) : value;
}

function truncateUtf8(value: string, maxBytes: number): string {
  return Buffer.byteLength(value, "utf8") <= maxBytes ? value : Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
}

/**
 * FNXC:HappierRuntime 2026-07-13-15:18:
 * CLI diagnostics may contain auth or provider material. Redact nested JSON
 * values by camelCase, snake_case, and kebab-case key names before diagnostics
 * enter an error or test report.
 */
export function redactHappierOutput(raw: string, maxBytes = DEFAULT_MAX_OUTPUT_BYTES): string {
  let redacted: string;
  try {
    redacted = JSON.stringify(redactValue(JSON.parse(raw))) ?? REDACTED;
  } catch {
    redacted = redactText(raw);
  }
  return truncateUtf8(redacted, Math.max(1, Math.floor(maxBytes)));
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function positiveNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function optionalPositiveNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = positiveNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Resolve explicit settings first, then non-secret environment fallbacks. */
export function resolveHappierCliSettings(
  settings?: HappierCliSettings | Record<string, unknown>,
): Required<Pick<HappierCliSettings, "executable" | "timeoutMs" | "maxOutputBytes">> & HappierCliSettings {
  const entrypoint = nonEmptyString(settings?.entrypoint) ?? nonEmptyString(process.env.HAPPIER_CLI_ENTRYPOINT);
  const executable =
    nonEmptyString(settings?.executable) ??
    nonEmptyString(process.env.HAPPIER_CLI_EXECUTABLE) ??
    (entrypoint ? process.execPath : "happier");
  const backend = typeof settings?.backend === "string"
    && HAPPIER_BACKENDS.includes(settings.backend as HappierBackend)
    ? settings.backend as HappierBackend
    : undefined;
  const happierSessionBindings = Array.isArray(settings?.happierSessionBindings)
    ? settings.happierSessionBindings as readonly HappierSessionBinding[]
    : undefined;
  const allowedCliRoots = Array.isArray(settings?.allowedCliRoots)
    ? settings.allowedCliRoots.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : nonEmptyString(process.env.FUSION_HAPPIER_ALLOWED_CLI_ROOTS)
      ?.split(";")
      .map((value) => value.trim())
      .filter(Boolean);
  const enableLocalRuntimeSnapshot = typeof settings?.enableLocalRuntimeSnapshot === "boolean"
    ? settings.enableLocalRuntimeSnapshot
    : process.env.FUSION_HAPPIER_ENABLE_LOCAL_RUNTIME_SNAPSHOT_V1 === "1";
  const enableLocalReconciliationHistory = typeof settings?.enableLocalReconciliationHistory === "boolean"
    ? settings.enableLocalReconciliationHistory
    : process.env.FUSION_HAPPIER_ENABLE_LOCAL_RECONCILIATION_HISTORY_V1 === "1";
  const enableLocalProviderTelemetry = typeof settings?.enableLocalProviderTelemetry === "boolean"
    ? settings.enableLocalProviderTelemetry
    : process.env.FUSION_HAPPIER_ENABLE_LOCAL_PROVIDER_TELEMETRY_V1 === "1";
  const timeoutMs = positiveNumber(settings?.timeoutMs ?? process.env.HAPPIER_CLI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

  return {
    executable,
    entrypoint,
    ...(allowedCliRoots?.length ? { allowedCliRoots } : {}),
    deliveryFenceDirectory: nonEmptyString(settings?.deliveryFenceDirectory),
    createIntentDirectory: nonEmptyString(settings?.createIntentDirectory),
    homeDir: nonEmptyString(settings?.homeDir) ?? nonEmptyString(process.env.HAPPIER_HOME_DIR),
    activeServerId:
      nonEmptyString(settings?.activeServerId) ?? nonEmptyString(process.env.HAPPIER_ACTIVE_SERVER_ID),
    serverUrl: nonEmptyString(settings?.serverUrl) ?? nonEmptyString(process.env.HAPPIER_SERVER_URL),
    publicServerUrl:
      nonEmptyString(settings?.publicServerUrl) ?? nonEmptyString(process.env.HAPPIER_PUBLIC_SERVER_URL),
    webappUrl: nonEmptyString(settings?.webappUrl) ?? nonEmptyString(process.env.HAPPIER_WEBAPP_URL),
    profile: nonEmptyString(settings?.profile) ?? nonEmptyString(process.env.HAPPIER_PROFILE),
    ...(backend ? { backend } : {}),
    ...(happierSessionBindings ? { happierSessionBindings } : {}),
    enableLocalRuntimeSnapshot,
    enableLocalReconciliationHistory,
    enableLocalProviderTelemetry,
    timeoutMs,
    spawnTimeoutMs: positiveNumber(
      settings?.spawnTimeoutMs ?? process.env.HAPPIER_CLI_SPAWN_TIMEOUT_MS,
      timeoutMs,
    ),
    connectTimeoutMs: positiveNumber(
      settings?.connectTimeoutMs ?? process.env.HAPPIER_CLI_CONNECT_TIMEOUT_MS,
      timeoutMs,
    ),
    toolTimeoutMs: positiveNumber(
      settings?.toolTimeoutMs ?? process.env.HAPPIER_CLI_TOOL_TIMEOUT_MS,
      timeoutMs,
    ),
    waitTimeoutMs: optionalPositiveNumber(
      settings?.waitTimeoutMs ?? process.env.HAPPIER_CLI_WAIT_TIMEOUT_MS,
    ),
    waitTimeoutGraceMs: positiveNumber(
      settings?.waitTimeoutGraceMs ?? process.env.HAPPIER_CLI_WAIT_TIMEOUT_GRACE_MS,
      DEFAULT_WAIT_TIMEOUT_GRACE_MS,
    ),
    timeoutSeconds: optionalPositiveNumber(settings?.timeoutSeconds)
      ?? HAPPIER_DEFAULT_PROVIDER_WAIT_TIMEOUT_SECONDS,
    maxOutputBytes: Math.max(
      1,
      Math.floor(positiveNumber(settings?.maxOutputBytes ?? process.env.HAPPIER_CLI_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES)),
    ),
  };
}

/**
 * Resolve the outer deadline for an operation that advertises an inner wait.
 *
 * FNXC:HappierTimeoutHierarchy 2026-07-27-02:53:
 * Explicit wait budgets are configuration assertions, not best-effort hints.
 * Reject an inverted hierarchy before process/provider I/O; when no explicit
 * outer wait is configured, derive the smallest valid deadline.
 */
export function resolveHappierWaitTimeoutMs(
  innerTimeoutSeconds: number,
  settings?: HappierCliSettings,
): number {
  if (!Number.isInteger(innerTimeoutSeconds) || innerTimeoutSeconds < 1 || innerTimeoutSeconds > 3_600) {
    throw new HappierCliError("protocol", "Happier inner wait timeout must be an integer from 1 through 3600");
  }
  const resolved = resolveHappierCliSettings(settings);
  const minimumOuterTimeoutMs = innerTimeoutSeconds * 1_000 + resolved.waitTimeoutGraceMs!;
  if (resolved.waitTimeoutMs !== undefined && resolved.waitTimeoutMs < minimumOuterTimeoutMs) {
    throw new HappierCliError(
      "protocol",
      "Happier wait timeout hierarchy is invalid",
      undefined,
      "timeout_hierarchy_invalid",
    );
  }
  return resolved.waitTimeoutMs
    ?? Math.max(resolved.toolTimeoutMs!, minimumOuterTimeoutMs);
}

/**
 * FNXC:HappierProcessEnvironment 2026-07-27-04:13:
 * Forward only OS launch/search, locale, temp, home, and proxy variables.
 * Provider keys, NODE_OPTIONS, arbitrary Fusion state, and inherited Happier
 * selectors are excluded; the selected stack is rebuilt from typed settings.
 */
export function buildHappierProcessEnv(
  settings: HappierCliSettings,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const resolved = resolveHappierCliSettings(settings);
  const allowedBase = Object.fromEntries(
    Object.entries(baseEnv).filter(([key, value]) =>
      value !== undefined && HAPPIER_PROCESS_ENV_ALLOWLIST.has(key.toLocaleUpperCase("en-US"))),
  );
  return {
    ...allowedBase,
    ...(resolved.homeDir ? { HAPPIER_HOME_DIR: resolved.homeDir } : {}),
    ...(resolved.activeServerId ? { HAPPIER_ACTIVE_SERVER_ID: resolved.activeServerId } : {}),
    ...(resolved.serverUrl ? { HAPPIER_SERVER_URL: resolved.serverUrl } : {}),
    ...(resolved.publicServerUrl ? { HAPPIER_PUBLIC_SERVER_URL: resolved.publicServerUrl } : {}),
    ...(resolved.webappUrl ? { HAPPIER_WEBAPP_URL: resolved.webappUrl } : {}),
    // Always override inherited state: a plain upstream Happier executable
    // must not accidentally expose Fusion's local extension to this process.
    HAPPIER_ENABLE_FUSION_RUNTIME_SNAPSHOT_V1: resolved.enableLocalRuntimeSnapshot ? "1" : "0",
    HAPPIER_ENABLE_FUSION_RECONCILIATION_HISTORY_V1: resolved.enableLocalReconciliationHistory ? "1" : "0",
    HAPPIER_ENABLE_FUSION_PROVIDER_TELEMETRY_V1: resolved.enableLocalProviderTelemetry ? "1" : "0",
  };
}

/** Build argv without a shell, preserving values as individual arguments. */
export function buildHappierInvocation(commandArgs: readonly string[], settings: HappierCliSettings): HappierCliInvocation {
  if (commandArgs.some((argument) => typeof argument !== "string")) {
    throw new HappierCliError("process", "Happier CLI arguments must be strings");
  }

  const resolved = resolveHappierCliSettings(settings);
  const args: string[] = [];
  if (resolved.entrypoint) args.push(resolved.entrypoint);
  if (resolved.serverUrl) args.push("--server-url", resolved.serverUrl);
  if (resolved.publicServerUrl) args.push("--public-server-url", resolved.publicServerUrl);
  if (resolved.webappUrl) args.push("--webapp-url", resolved.webappUrl);
  if (resolved.profile) args.push("--profile", resolved.profile);
  args.push(...commandArgs);
  return { command: resolved.executable, args };
}

function isRecord(value: unknown): value is HappierJsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidEnvelope(reason: string): HappierCliError {
  return new HappierCliError(
    "invalid-json",
    `Happier CLI returned an invalid JSON envelope: ${reason}`,
  );
}

function parseHappierJsonEnvelope<T = unknown>(
  raw: string,
  _maxBytes = DEFAULT_MAX_OUTPUT_BYTES,
): HappierJsonEnvelope<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    // FNXC:HappierRuntime 2026-07-17: JSON parser diagnostics may echo the
    // offending payload. Connector envelopes can contain transcript text, so
    // malformed output is represented by metadata only.
    throw invalidEnvelope("malformed JSON");
  }

  if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.ok !== "boolean" || typeof parsed.kind !== "string" || !parsed.kind.trim()) {
    throw invalidEnvelope("expected v=1, boolean ok, and non-empty kind");
  }
  if (parsed.ok === true && !("data" in parsed)) throw invalidEnvelope("success envelope is missing data");
  if (parsed.ok === false && (!isRecord(parsed.error) || typeof parsed.error.code !== "string" || !parsed.error.code.trim())) {
    throw invalidEnvelope("failure envelope is missing error.code");
  }
  return parsed as unknown as HappierJsonEnvelope<T>;
}

/** Parse and validate Happier's exact `{v,ok,kind,data|error}` envelope. */
export async function parseHappierJson<T = unknown>(
  raw: string,
  maxBytes = DEFAULT_MAX_OUTPUT_BYTES,
): Promise<HappierJsonEnvelope<T>> {
  return parseHappierJsonEnvelope<T>(raw, maxBytes);
}

class BoundedOutputAccumulator {
  private readonly chunks: Buffer[] = [];
  private size = 0;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer): boolean {
    if (this.size + chunk.byteLength > this.maxBytes) return false;
    this.chunks.push(Buffer.from(chunk));
    this.size += chunk.byteLength;
    return true;
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.size).toString("utf8");
  }
}

function classifyProcessFailure(raw: string): HappierErrorCode {
  const lower = raw.toLowerCase();
  if (/auth|unauthori|forbidden|login|credential/.test(lower)) return "authentication";
  if (/daemon/.test(lower)) return "daemon";
  if (/backend|provider|model/.test(lower)) return "backend";
  if (/session|conversation|run\s+id/.test(lower)) return "session";
  if (/server|econn|connection|network|fetch|timeout/.test(lower)) return "server";
  return "process";
}

function mapOfficialErrorCode(code: string): HappierErrorCode {
  switch (code.toLowerCase().replace(/[-\s]/g, "_")) {
    case "not_authenticated":
    case "authentication_required":
    case "auth_required":
    case "unauthorized":
    case "forbidden":
    case "invalid_token":
    case "token_expired":
      return "authentication";
    case "server_unreachable":
    case "server_unavailable":
    case "connection_failed":
    case "network_error":
      return "server";
    case "daemon_unavailable":
    case "daemon_not_running":
      return "daemon";
    case "backend_unavailable":
    case "backend_not_found":
    case "provider_unavailable":
    case "model_unavailable":
      return "backend";
    case "session_not_found":
    case "session_archived":
    case "session_unavailable":
    case "invalid_session":
    case "session_create_failed":
    case "session_send_failed":
      return "session";
    default:
      return "process";
  }
}

function throwOfficialFailure(envelope: HappierFailureEnvelope): never {
  const officialCode = envelope.error.code.trim();
  const message = typeof envelope.error.message === "string" && envelope.error.message.trim() ? envelope.error.message : officialCode;
  throw new HappierCliError(mapOfficialErrorCode(officialCode), `Happier CLI request failed: ${redactHappierOutput(message)}`, undefined, officialCode);
}

/**
 * FNXC:HappierRuntime 2026-07-13-15:18:
 * The integration boundary is the official JSON CLI. Keep process execution
 * shell-free, bounded, abortable, and independent from port 4040 or services.
 */
export function invokeHappierJson<T extends HappierJsonRecord = HappierJsonRecord>(
  commandArgs: readonly string[],
  settings?: HappierCliSettings,
  signal?: AbortSignal,
  expectedKind?: string,
  outerTimeoutMs?: number,
): Promise<T> {
  const resolved = resolveHappierCliSettings(settings);
  const invocation = buildHappierInvocation(commandArgs, resolved);
  const maxOutputBytes = resolved.maxOutputBytes;
  const operationTimeoutMs = outerTimeoutMs === undefined
    ? resolved.toolTimeoutMs!
    : positiveNumber(outerTimeoutMs, resolved.toolTimeoutMs!);

  return new Promise<T>((resolve, reject) => {
    const stdout = new BoundedOutputAccumulator(maxOutputBytes);
    const stderr = new BoundedOutputAccumulator(maxOutputBytes);
    let child: ReturnType<typeof spawn> | undefined;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    let settlingAfterTermination = false;

    const finishReject = (error: HappierCliError): void => {
      if (settled || settlingAfterTermination) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child?.off("spawn", onSpawn);
      reject(error);
    };

    const finishResolve = (value: T): void => {
      if (settled || settlingAfterTermination) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child?.off("spawn", onSpawn);
      resolve(value);
    };

    async function terminateAndReject(error: HappierCliError): Promise<void> {
      if (settled || settlingAfterTermination) return;
      settlingAfterTermination = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child?.off("spawn", onSpawn);
      const closeConfirmed = waitForHappierProcessClose(child);
      const terminationConfirmed = await terminateHappierProcessTree(child);
      const processClosed = await closeConfirmed;
      settled = true;
      settlingAfterTermination = false;
      reject(
        terminationConfirmed && processClosed
          ? error
          : new HappierCliError(
            "process",
            "Happier CLI process tree exit was not confirmed",
            undefined,
            "process_tree_exit_unconfirmed",
          ),
      );
    }

    function onAbort(): void {
      void terminateAndReject(new HappierCliError("timeout", "Happier CLI invocation aborted"));
    }

    function armTimeout(timeoutMs: number, stage: "spawn" | "operation"): void {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void terminateAndReject(new HappierCliError(
          "timeout",
          stage === "spawn"
            ? "Happier CLI process spawn timed out"
            : `Happier CLI timed out after ${timeoutMs}ms`,
          undefined,
          stage === "spawn" ? "cli_spawn_timeout" : undefined,
        ));
      }, timeoutMs);
    }

    function onSpawn(): void {
      if (settled) return;
      armTimeout(operationTimeoutMs, "operation");
    }

    function onOutput(stream: "stdout" | "stderr", chunk: Buffer): void {
      const accumulator = stream === "stdout" ? stdout : stderr;
      if (accumulator.append(chunk)) return;
      void terminateAndReject(
        new HappierCliError(
          "output-limit",
          `Happier CLI ${stream} exceeded the ${maxOutputBytes}-byte output limit`,
        ),
      );
    }

    try {
      child = spawn(invocation.command, invocation.args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: buildHappierProcessEnv(resolved),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finishReject(new HappierCliError("process", `Happier CLI spawn failed: ${redactHappierOutput(message, maxOutputBytes)}`));
      return;
    }

    child.once("spawn", onSpawn);
    if (typeof child.pid === "number" && child.pid > 0) {
      onSpawn();
    } else {
      armTimeout(resolved.spawnTimeoutMs!, "spawn");
    }

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => onOutput("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => onOutput("stderr", chunk));

    child.once("error", (error: NodeJS.ErrnoException) => {
      finishReject(
        new HappierCliError("process", `Happier CLI process error: ${redactHappierOutput(error.message, maxOutputBytes)}`, {
          stdout: redactHappierOutput(stdout.toString(), maxOutputBytes),
          stderr: redactHappierOutput(stderr.toString(), maxOutputBytes),
        }),
      );
    });

    child.once("close", (exitCode: number | null) => {
      if (settled || settlingAfterTermination) return;
      const rawStdout = stdout.toString();
      const rawStderr = stderr.toString();

      void parseHappierJson<unknown>(rawStdout, maxOutputBytes).then(
        (envelope) => {
          if (expectedKind && envelope.kind !== expectedKind) {
            finishReject(new HappierCliError("invalid-json", "Happier CLI returned an unexpected JSON envelope kind"));
            return;
          }
          if (!envelope.ok) {
            try {
              throwOfficialFailure(envelope);
            } catch (error) {
              finishReject(error instanceof HappierCliError ? error : new HappierCliError("process", String(error)));
            }
            return;
          }
          if (exitCode !== 0) {
            finishReject(new HappierCliError("process", `Happier CLI returned success JSON with exit code ${String(exitCode)}`));
            return;
          }
          if (!isRecord(envelope.data)) {
            finishReject(new HappierCliError("invalid-json", "Happier success envelope data must be an object"));
            return;
          }
          finishResolve(envelope.data as T);
        },
        (error: unknown) => {
          if (exitCode !== 0) {
            const diagnostic = redactHappierOutput([rawStdout, rawStderr].filter(Boolean).join("\n"), maxOutputBytes);
            finishReject(new HappierCliError(classifyProcessFailure(diagnostic), `Happier CLI exited with code ${String(exitCode)}: ${diagnostic}`, {
              exitCode,
              stdout: redactHappierOutput(rawStdout, maxOutputBytes),
              stderr: redactHappierOutput(rawStderr, maxOutputBytes),
            }));
            return;
          }
          finishReject(error instanceof HappierCliError ? error : new HappierCliError("invalid-json", String(error)));
        },
      );
    });
  });
}

export type HappierResumeProcessLease = Readonly<{
  sessionId: string;
  pid: number | null;
  stop: () => Promise<boolean>;
}>;

/**
 * FNXC:HappierStrictResume 2026-07-27-16:25:
 * Official `happier resume` is a long-running provider owner, not a one-shot
 * JSON command. Return a controlled lease only after spawn and keep stop
 * pending until both tree termination and the direct-child close are known.
 */
export function startHappierResumeProcess(
  sessionId: string,
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): Promise<HappierResumeProcessLease> {
  const requestedSessionId = nonEmptyString(sessionId);
  if (!requestedSessionId) {
    return Promise.reject(new HappierCliError("session", "Happier resume requires a non-empty session id"));
  }
  const resolved = resolveHappierCliSettings(settings);
  const invocation = buildHappierInvocation(["resume", requestedSessionId], resolved);

  return new Promise<HappierResumeProcessLease>((resolve, reject) => {
    let child: ReturnType<typeof spawn> | undefined;
    let spawnTimer: NodeJS.Timeout | undefined;
    let promiseSettled = false;
    let spawned = false;
    let closed = false;
    let stopPromise: Promise<boolean> | undefined;

    const clearLifecycleListeners = (): void => {
      if (spawnTimer) clearTimeout(spawnTimer);
      signal?.removeEventListener("abort", onAbort);
    };

    const stop = (): Promise<boolean> => {
      if (closed) return Promise.resolve(true);
      stopPromise ??= (async () => {
        const closeConfirmed = waitForHappierProcessClose(child);
        const terminationConfirmed = await terminateHappierProcessTree(child);
        const processClosed = await closeConfirmed;
        return terminationConfirmed && processClosed;
      })();
      return stopPromise;
    };

    const rejectAfterStop = (error: HappierCliError): void => {
      if (promiseSettled) return;
      promiseSettled = true;
      clearLifecycleListeners();
      void stop().then((confirmed) => {
        reject(
          confirmed
            ? error
            : new HappierCliError(
              "process",
              "Happier resume process tree exit was not confirmed",
              undefined,
              "process_tree_exit_unconfirmed",
            ),
        );
      });
    };

    function onAbort(): void {
      if (promiseSettled) {
        void stop();
        return;
      }
      rejectAfterStop(new HappierCliError("timeout", "Happier resume aborted"));
    }

    const onSpawn = (): void => {
      if (promiseSettled) return;
      spawned = true;
      promiseSettled = true;
      clearLifecycleListeners();
      resolve({
        sessionId: requestedSessionId,
        pid: typeof child?.pid === "number" ? child.pid : null,
        stop,
      });
    };

    try {
      child = spawn(invocation.command, invocation.args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
        env: buildHappierProcessEnv(resolved),
      });
    } catch (error) {
      promiseSettled = true;
      const message = error instanceof Error ? error.message : String(error);
      reject(new HappierCliError("process", `Happier resume spawn failed: ${redactHappierOutput(message)}`));
      return;
    }

    child.once("spawn", onSpawn);
    child.once("close", () => {
      closed = true;
      if (!spawned && !promiseSettled) {
        promiseSettled = true;
        clearLifecycleListeners();
        reject(new HappierCliError("process", "Happier resume exited before confirming spawn"));
      }
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (promiseSettled) return;
      promiseSettled = true;
      clearLifecycleListeners();
      reject(new HappierCliError("process", `Happier resume process error: ${redactHappierOutput(error.message)}`));
    });

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    if (typeof child.pid === "number" && child.pid > 0) {
      onSpawn();
    } else {
      spawnTimer = setTimeout(() => {
        rejectAfterStop(
          new HappierCliError(
            "timeout",
            "Happier resume process spawn timed out",
            undefined,
            "cli_spawn_timeout",
          ),
        );
      }, resolved.spawnTimeoutMs!);
      spawnTimer.unref();
    }
  });
}

type NdjsonWaiter<T> = Readonly<{
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: unknown) => void;
}>;

/**
 * FNXC:HappierRuntime 2026-07-17-07:12:
 * Direct Session follow is an unbounded process, so bound each NDJSON line,
 * stderr, and the unread queue rather than applying the one-shot total-output
 * limit. Consumer cancellation owns process termination.
 */
function createHappierNdjsonStream<T>(
  commandArgs: readonly string[],
  expectedKind: string | readonly string[],
  parseData: (data: HappierJsonRecord, kind: string) => T,
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): AsyncIterable<T> {
  const resolved = resolveHappierCliSettings(settings);
  const invocation = buildHappierInvocation(commandArgs, resolved);
  const maxBytes = resolved.maxOutputBytes;
  const expectedKinds = typeof expectedKind === "string" ? [expectedKind] : Array.from(expectedKind);
  let child: ReturnType<typeof spawn> | undefined;
  let started = false;
  let consumerClosed = false;
  let done = false;
  let childClosed = false;
  let terminationPromise: Promise<boolean> | null = null;
  let terminalError: HappierCliError | null = null;
  let queuedBytes = 0;
  let pendingText = "";
  let processing = Promise.resolve();
  const decoder = new StringDecoder("utf8");
  const stderr = new BoundedOutputAccumulator(maxBytes);
  const queue: Array<{ readonly value: T; readonly bytes: number }> = [];
  const waiters: Array<NdjsonWaiter<T>> = [];

  const terminate = (): Promise<boolean> => {
    terminationPromise ??= terminateHappierProcessTree(child);
    return terminationPromise;
  };

  const removeAbortListener = (): void => signal?.removeEventListener("abort", onAbort);

  const rejectAll = (error: HappierCliError): void => {
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  };

  const resolveDone = (): void => {
    for (const waiter of waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  };

  const fail = (error: unknown): void => {
    if (done || terminalError || consumerClosed) return;
    terminalError = error instanceof HappierCliError
      ? error
      : new HappierCliError(
        "protocol",
        `Happier NDJSON stream failed: ${redactHappierOutput(error instanceof Error ? error.message : String(error), maxBytes)}`,
      );
    void terminate();
    removeAbortListener();
    rejectAll(terminalError);
  };

  function onAbort(): void {
    fail(new HappierCliError("timeout", "Happier CLI event stream aborted"));
  }

  const deliver = (value: T, bytes: number): void => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }
    if (queuedBytes + bytes > maxBytes) {
      fail(new HappierCliError("output-limit", `Happier CLI unread NDJSON queue exceeded ${maxBytes} bytes`));
      return;
    }
    queue.push({ value, bytes });
    queuedBytes += bytes;
  };

  const parseLine = (line: string): void => {
    if (!line.trim()) return;
    const lineBytes = Buffer.byteLength(line, "utf8");
    if (lineBytes > maxBytes) {
      throw new HappierCliError("output-limit", `Happier CLI NDJSON line exceeded ${maxBytes} bytes`);
    }
    let envelope: HappierJsonEnvelope<unknown>;
    try {
      envelope = parseHappierJsonEnvelope<unknown>(line, maxBytes);
    } catch {
      // FNXC:HappierRuntime 2026-07-17: Stream lines can contain transcript
      // plaintext. Never echo an unparseable line into durable diagnostics.
      throw new HappierCliError("invalid-json", "Happier CLI returned an invalid NDJSON envelope");
    }
    if (!expectedKinds.includes(envelope.kind)) {
      throw new HappierCliError("invalid-json", "Happier CLI returned an unexpected NDJSON envelope kind");
    }
    if (!envelope.ok) throwOfficialFailure(envelope);
    if (!isRecord(envelope.data)) {
      throw new HappierCliError("invalid-json", "Happier NDJSON success envelope data must be an object");
    }
    deliver(parseData(envelope.data, envelope.kind), lineBytes);
  };

  const enqueueText = (text: string, flush = false): void => {
    pendingText += text;
    if (Buffer.byteLength(pendingText, "utf8") > maxBytes && !pendingText.includes("\n")) {
      fail(new HappierCliError("output-limit", `Happier CLI partial NDJSON line exceeded ${maxBytes} bytes`));
      return;
    }
    const lines = pendingText.split("\n");
    pendingText = flush ? "" : lines.pop() ?? "";
    const completeLines = flush ? lines : lines;
    processing = processing.then(() => {
      for (const rawLine of completeLines) parseLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
      if (flush && pendingText.trim()) parseLine(pendingText);
    }).catch(fail);
  };

  const finishAfterProcessing = (exitCode: number | null): void => {
    const tail = decoder.end();
    if (tail || pendingText) {
      const remaining = `${pendingText}${tail}`;
      pendingText = "";
      processing = processing.then(() => parseLine(remaining)).catch(fail);
    }
    void processing.then(() => {
      if (consumerClosed || terminalError) return;
      if (exitCode !== 0) {
        const diagnostic = redactHappierOutput(stderr.toString(), maxBytes);
        fail(new HappierCliError(
          classifyProcessFailure(diagnostic),
          `Happier CLI event stream exited with code ${String(exitCode)}: ${diagnostic}`,
          { exitCode, stderr: diagnostic },
        ));
        return;
      }
      done = true;
      removeAbortListener();
      resolveDone();
    });
  };

  const start = (): void => {
    if (started || consumerClosed) return;
    started = true;
    try {
      child = spawn(invocation.command, invocation.args, {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: buildHappierProcessEnv(resolved),
      });
    } catch (error) {
      fail(new HappierCliError(
        "process",
        `Happier CLI stream spawn failed: ${redactHappierOutput(error instanceof Error ? error.message : String(error), maxBytes)}`,
      ));
      return;
    }
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout?.on("data", (chunk: Buffer | string) => {
      enqueueText(decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!stderr.append(value)) {
        fail(new HappierCliError("output-limit", `Happier CLI event stderr exceeded ${maxBytes} bytes`));
      }
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      fail(new HappierCliError(
        "process",
        `Happier CLI event process error: ${redactHappierOutput(error.message, maxBytes)}`,
      ));
    });
    child.once("close", (exitCode: number | null) => {
      childClosed = true;
      finishAfterProcessing(exitCode);
    });
  };

  const iterator: AsyncIterableIterator<T> = {
    next(): Promise<IteratorResult<T>> {
      start();
      const queued = queue.shift();
      if (queued) {
        queuedBytes -= queued.bytes;
        return Promise.resolve({ done: false, value: queued.value });
      }
      if (terminalError) return Promise.reject(terminalError);
      if (done || consumerClosed) return Promise.resolve({ done: true, value: undefined });
      return new Promise<IteratorResult<T>>((resolve, reject) => waiters.push({ resolve, reject }));
    },
    async return(): Promise<IteratorResult<T>> {
      const closed = childClosed ? Promise.resolve(true) : waitForHappierProcessClose(child);
      if (!consumerClosed) {
        consumerClosed = true;
        void terminate();
        removeAbortListener();
        queue.length = 0;
        queuedBytes = 0;
        resolveDone();
      }
      const [terminationSucceeded, closeConfirmed] = await Promise.all([terminate(), closed]);
      if (!terminationSucceeded || !closeConfirmed) {
        throw new HappierCliError("process", "Happier CLI process cleanup could not be confirmed");
      }
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator](): AsyncIterableIterator<T> {
      return this;
    },
  };
  return iterator;
}

function ensureRecord(value: unknown, operation: string): HappierJsonRecord {
  if (!isRecord(value)) throw new HappierCliError("session", `Happier ${operation} returned an invalid result data object`);
  return value;
}

/** FNXC:HappierRuntime 2026-07-16-11:17: Session identifiers reject C0 controls and DEL without regex lint suppression. */
function hasForbiddenControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

function trimSessionId(value: unknown): string {
  if (typeof value !== "string") throw new HappierCliError("session", "Happier session id must be a string");
  const trimmed = value.trim();
  if (!trimmed || hasForbiddenControlCharacter(trimmed) || trimmed.length > 512) {
    throw new HappierCliError("session", "Happier session id is invalid");
  }
  return trimmed;
}

function validateBackend(backend: HappierBackend): HappierBackend {
  if (!HAPPIER_BACKENDS.includes(backend)) throw new HappierCliError("backend", `Unsupported Happier backend: ${String(backend)}`);
  return backend;
}

function validatePositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new HappierCliError("session", `${field} must be a positive integer`);
  return value;
}

function expectedSessionId(payload: HappierJsonRecord, requested: string, operation: string): string {
  const returned = trimSessionId(payload.sessionId);
  if (returned !== requested) throw new HappierCliError("session", `Happier ${operation} returned a mismatched session id`);
  return returned;
}

function isTransientWindowsStartupFailure(error: unknown): boolean {
  if (!(error instanceof HappierCliError) || error.code !== "process") return false;
  if (!error.message.startsWith("Happier CLI spawn failed:")) return false;
  return /\b(?:EBUSY|EPERM|ETXTBSY)\b|resource busy or locked|text file busy/iu.test(error.message);
}

/** Retry only synchronous spawn failures, where no child process or side effect can exist. */
export async function invokeHappierJsonForKind<T extends HappierJsonRecord>(
  commandArgs: readonly string[],
  kind: string,
  settings?: HappierCliSettings,
  signal?: AbortSignal,
  outerTimeoutMs?: number,
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await invokeHappierJson<T>(commandArgs, settings, signal, kind, outerTimeoutMs);
    } catch (error) {
      if (attempt === 2 || signal?.aborted || !isTransientWindowsStartupFailure(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, attempt === 0 ? 75 : 250));
    }
  }
  throw new HappierCliError("process", "Happier CLI startup retry exhausted");
}

export function buildHappierSessionOpenUrl(
  webappUrl: string,
  serverProfileId: string,
  happierSessionId: string,
): string {
  const base = webappUrl.trim().replace(/\/+$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new HappierCliError("protocol", "Happier webapp URL is invalid");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username.length > 0
    || parsed.password.length > 0
    || parsed.search.length > 0
    || parsed.hash.length > 0
    || !serverProfileId.trim()
    || !happierSessionId.trim()
  ) {
    throw new HappierCliError("protocol", "Happier webapp URL or Session identity is unsafe");
  }
  return `${base}/session/${encodeURIComponent(happierSessionId)}?serverId=${encodeURIComponent(serverProfileId)}`;
}

function directSessionString(data: HappierJsonRecord, field: string): string {
  const value = nonEmptyString(data[field]);
  if (!value) throw new HappierCliError("session", `Happier direct session ensure returned an empty ${field}`);
  return value;
}

/**
 * FNXC:HappierOfficialMcpBridge 2026-07-19-19:29:
 * This argv shape is retained only for an explicitly invoked local extension.
 * It is not a public Happier CLI contract and the Fusion Session Connector
 * never selects it; normal routing uses `happier mcp serve` instead.
 */
export async function ensureHappierDirectSession(input: {
  uri: string;
  machineId?: string;
  settings: HappierCliSettings;
}): Promise<HappierDirectSessionEnsureResult> {
  const args = ["direct-session", "ensure", "--uri", input.uri];
  if (input.machineId !== undefined) args.push("--machine-id", input.machineId);
  args.push("--json");

  const data = ensureRecord(
    await invokeHappierJsonForKind(args, "direct_session_ensure", input.settings),
    "direct session ensure",
  );
  const providerId = directSessionString(data, "providerId");
  if (!HAPPIER_BACKENDS.includes(providerId as HappierBackend)) {
    throw new HappierCliError("backend", `Unsupported Happier backend: ${providerId}`);
  }
  if (typeof data.created !== "boolean") {
    throw new HappierCliError("session", "Happier direct session ensure returned an invalid created flag");
  }

  return {
    providerId: providerId as HappierBackend,
    remoteSessionId: directSessionString(data, "remoteSessionId"),
    machineId: directSessionString(data, "machineId"),
    serverId: directSessionString(data, "serverId"),
    sessionId: directSessionString(data, "sessionId"),
    created: data.created,
    openUrl: directSessionString(data, "openUrl"),
  };
}

/** Legacy local-extension probe. It is intentionally absent from production routing. */
export async function getHappierDirectSessionCapabilities(
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): Promise<HappierJsonRecord> {
  return ensureRecord(
    await invokeHappierJsonForKind(
      ["direct-session", "capabilities", "--json"],
      "direct_session_capabilities",
      settings,
      signal,
    ),
    "Direct Session capabilities",
  );
}

function directSessionSource(providerId: HappierBackend): HappierDirectSessionSource {
  if (providerId === "codex") return { kind: "codexHome", home: "user" };
  if (providerId === "claude") return { kind: "claudeConfig" };
  return { kind: "opencodeServer" };
}

function directTranscriptIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new HappierCliError("session", `Happier Direct Session ${field} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2_000 || hasForbiddenControlCharacter(trimmed)) {
    throw new HappierCliError("session", `Happier Direct Session ${field} is invalid`);
  }
  return trimmed;
}

function directTranscriptCursor(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return directTranscriptIdentifier(value, field);
}

function normalizeDirectTranscriptInput(
  input: HappierDirectSessionTranscriptInput,
): HappierDirectSessionTranscriptInput & { readonly source: HappierDirectSessionSource } {
  const providerId = validateBackend(input.providerId);
  const limit = validatePositiveInteger(input.limit, "limit");
  if (limit > 5_000) throw new HappierCliError("session", "limit must not exceed 5000");
  return {
    providerId,
    remoteSessionId: directTranscriptIdentifier(input.remoteSessionId, "remoteSessionId"),
    sessionId: directTranscriptIdentifier(input.sessionId, "sessionId"),
    machineId: directTranscriptIdentifier(input.machineId, "machineId"),
    afterCursor: directTranscriptCursor(input.afterCursor, "afterCursor"),
    limit,
    source: directSessionSource(providerId),
  };
}

function directTranscriptArgs(
  command: "read-after" | "events",
  input: HappierDirectSessionTranscriptInput & { readonly source: HappierDirectSessionSource },
): string[] {
  return [
    "direct-session",
    command,
    "--provider",
    input.providerId,
    "--remote-session-id",
    input.remoteSessionId,
    "--session-id",
    input.sessionId,
    "--machine-id",
    input.machineId,
    "--source-json",
    JSON.stringify(input.source),
    "--after-cursor",
    input.afterCursor ?? "null",
    "--limit",
    String(input.limit),
    command === "events" ? "--ndjson" : "--json",
  ];
}

function sameDirectSessionSource(
  actual: unknown,
  expected: HappierDirectSessionSource,
): boolean {
  if (!isRecord(actual) || actual.kind !== expected.kind) return false;
  return expected.kind !== "codexHome" || actual.home === expected.home;
}

function normalizeDirectTranscriptRawMessage(
  value: unknown,
): HappierDirectSessionTranscriptRawMessage {
  if (!isRecord(value)) {
    throw new HappierCliError("protocol", "Happier Direct Session transcript item must be an object");
  }
  const id = directTranscriptIdentifier(value.id, "message id");
  if (!Number.isInteger(value.createdAtMs) || (value.createdAtMs as number) < 0 || !isRecord(value.raw)) {
    throw new HappierCliError("protocol", "Happier Direct Session transcript item is invalid");
  }
  const localId = value.localId === null || value.localId === undefined
    ? value.localId
    : directTranscriptIdentifier(value.localId, "message localId");
  return {
    id,
    createdAtMs: value.createdAtMs as number,
    ...(localId !== undefined ? { localId } : {}),
    raw: value.raw,
  };
}

function normalizeDirectTranscriptDelta(
  data: HappierJsonRecord,
  expected: HappierDirectSessionTranscriptInput & { readonly source: HappierDirectSessionSource },
): HappierDirectSessionTranscriptDelta {
  if (
    data.machineId !== expected.machineId
    || data.providerId !== expected.providerId
    || data.remoteSessionId !== expected.remoteSessionId
    || data.sessionId !== expected.sessionId
    || !sameDirectSessionSource(data.source, expected.source)
  ) {
    throw new HappierCliError("protocol", "Happier Direct Session transcript identity drifted");
  }
  if (typeof data.truncated !== "boolean" || !Array.isArray(data.items)) {
    throw new HappierCliError("protocol", "Happier Direct Session transcript delta is invalid");
  }
  return {
    machineId: expected.machineId,
    providerId: expected.providerId,
    remoteSessionId: expected.remoteSessionId,
    sessionId: expected.sessionId,
    source: expected.source,
    fromCursor: directTranscriptCursor(data.fromCursor, "fromCursor"),
    nextCursor: directTranscriptCursor(data.nextCursor, "nextCursor"),
    truncated: data.truncated,
    items: data.items.map(normalizeDirectTranscriptRawMessage),
  };
}

function normalizeDirectStatusDelta(
  data: HappierJsonRecord,
  expected: HappierDirectSessionTranscriptInput & { readonly source: HappierDirectSessionSource },
): HappierDirectSessionStatusDelta {
  if (
    data.eventType !== "status"
    || data.machineId !== expected.machineId
    || data.providerId !== expected.providerId
    || data.remoteSessionId !== expected.remoteSessionId
    || data.sessionId !== expected.sessionId
    || !sameDirectSessionSource(data.source, expected.source)
    || typeof data.isRunning !== "boolean"
    || !Number.isInteger(data.observedAtMs)
    || (data.observedAtMs as number) < 0
    || !(
      data.lastActivityAtMs === null
      || (Number.isInteger(data.lastActivityAtMs) && (data.lastActivityAtMs as number) >= 0)
    )
  ) {
    throw new HappierCliError("protocol", "Happier Direct Session status delta is invalid");
  }
  return {
    eventType: "status",
    machineId: expected.machineId,
    providerId: expected.providerId,
    remoteSessionId: expected.remoteSessionId,
    sessionId: expected.sessionId,
    source: expected.source,
    isRunning: data.isRunning,
    lastActivityAtMs: data.lastActivityAtMs as number | null,
    observedAtMs: data.observedAtMs as number,
  };
}

export async function readHappierDirectSessionTranscript(
  input: HappierDirectSessionTranscriptInput,
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): Promise<HappierDirectSessionTranscriptDelta> {
  const normalized = normalizeDirectTranscriptInput(input);
  const data = ensureRecord(
    await invokeHappierJsonForKind(
      directTranscriptArgs("read-after", normalized),
      "direct_session_transcript_read_after",
      settings,
      signal,
    ),
    "Direct Session transcript read",
  );
  const delta = normalizeDirectTranscriptDelta(data, normalized);
  if (delta.fromCursor !== normalized.afterCursor) {
    throw new HappierCliError("protocol", "Happier Direct Session transcript returned a mismatched cursor");
  }
  return delta;
}

export function followHappierDirectSessionTranscriptEvents(
  input: HappierDirectSessionTranscriptInput,
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): AsyncIterable<HappierDirectSessionEvent> {
  const normalized = normalizeDirectTranscriptInput(input);
  return createHappierNdjsonStream(
    directTranscriptArgs("events", normalized),
    ["direct_session_transcript_delta", "direct_session_status_delta"],
    (data, kind) => kind === "direct_session_status_delta"
      ? normalizeDirectStatusDelta(data, normalized)
      : normalizeDirectTranscriptDelta(data, normalized),
    settings,
    signal,
  );
}

export async function createHappierSession(
  input: HappierSessionCreateInput,
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): Promise<HappierSessionCreateResult> {
  if (!input.cwd.trim() || !input.title.trim()) throw new HappierCliError("session", "Happier session cwd and title are required");
  const tag = input.tag?.trim();
  if (input.tag !== undefined && (!tag || tag.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(tag))) {
    throw new HappierCliError("session", "Happier session create tag is invalid");
  }
  const data = ensureRecord(
    await invokeHappierJsonForKind(
      [
        "session",
        "create",
        "--path",
        input.cwd,
        "--backend",
        validateBackend(input.backend),
        "--title",
        input.title,
        ...(tag ? ["--tag", tag] : []),
        "--json",
      ],
      "session_create",
      settings,
      signal,
    ),
    "session create",
  );
  if (!isRecord(data.session) || typeof data.created !== "boolean") throw new HappierCliError("session", "Happier session create returned invalid data");
  const sessionId = trimSessionId(data.session.id);
  return { ...data, sessionId, session: data.session, created: data.created } as HappierSessionCreateResult;
}

function normalizeListedSession(value: unknown): HappierSessionListItem {
  if (!isRecord(value)) throw new HappierCliError("protocol", "Happier session list returned an invalid session");
  const id = trimSessionId(value.id);
  const createdAt = value.createdAt;
  const updatedAt = value.updatedAt;
  if (
    typeof createdAt !== "number"
    || !Number.isFinite(createdAt)
    || typeof updatedAt !== "number"
    || !Number.isFinite(updatedAt)
  ) {
    throw new HappierCliError("protocol", "Happier session list returned invalid timestamps");
  }
  const optionalString = (field: "tag" | "path" | "agentId"): string | undefined => {
    const raw = value[field];
    if (raw === undefined) return undefined;
    if (typeof raw !== "string" || !raw.trim() || /[\u0000-\u001f\u007f]/u.test(raw)) {
      throw new HappierCliError("protocol", `Happier session list returned an invalid ${field}`);
    }
    return raw;
  };
  if (value.active !== undefined && typeof value.active !== "boolean") {
    throw new HappierCliError("protocol", "Happier session list returned an invalid active flag");
  }
  if (
    value.archivedAt !== undefined
    && value.archivedAt !== null
    && (typeof value.archivedAt !== "number" || !Number.isFinite(value.archivedAt))
  ) {
    throw new HappierCliError("protocol", "Happier session list returned an invalid archivedAt value");
  }
  return Object.freeze({
    id,
    createdAt,
    updatedAt,
    ...(value.active === undefined ? {} : { active: value.active }),
    ...(value.archivedAt === undefined ? {} : { archivedAt: value.archivedAt as number | null }),
    ...(optionalString("tag") ? { tag: optionalString("tag") } : {}),
    ...(optionalString("path") ? { path: optionalString("path") } : {}),
    ...(optionalString("agentId") ? { agentId: optionalString("agentId") } : {}),
  });
}

/**
 * FNXC:HappierCreateIntentPagination 2026-07-27-03:29:
 * Recovery must inspect every official list page. A missing/repeated cursor,
 * duplicate session identity, or malformed metadata blocks create rather than
 * making a second remote Session from an incomplete view.
 */
export async function listHappierSessions(
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): Promise<HappierSessionListResult> {
  const sessions: HappierSessionListItem[] = [];
  const sessionIds = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 10_000; page += 1) {
    const data = ensureRecord(
      await invokeHappierJsonForKind(
        [
          "session",
          "list",
          "--limit",
          "200",
          ...(cursor ? ["--cursor", cursor] : []),
          "--json",
        ],
        "session_list",
        settings,
        signal,
      ),
      "session list",
    );
    if (!Array.isArray(data.sessions)) {
      throw new HappierCliError("protocol", "Happier session list returned invalid sessions");
    }
    for (const value of data.sessions) {
      const session = normalizeListedSession(value);
      if (sessionIds.has(session.id)) {
        throw new HappierCliError("protocol", "Happier session list repeated a session identity");
      }
      sessionIds.add(session.id);
      sessions.push(session);
    }
    const nextCursor = data.nextCursor;
    const hasNext = data.hasNext;
    if (nextCursor !== null && typeof nextCursor !== "string") {
      throw new HappierCliError("protocol", "Happier session list returned an invalid next cursor");
    }
    if (typeof hasNext !== "boolean") {
      throw new HappierCliError("protocol", "Happier session list returned an invalid hasNext flag");
    }
    if (!hasNext) {
      if (nextCursor !== null) {
        throw new HappierCliError("protocol", "Happier session list returned a cursor after the final page");
      }
      return Object.freeze({
        sessions: Object.freeze(sessions),
        nextCursor: null,
        hasNext: false,
      });
    }
    if (!nextCursor || cursors.has(nextCursor)) {
      throw new HappierCliError("protocol", "Happier session list pagination did not advance");
    }
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new HappierCliError("protocol", "Happier session list exceeded the recovery page bound");
}

export async function sendHappierMessage(
  input: HappierMessageInput & Readonly<{
    systemPrompt?: string;
    modelId?: string;
    permissionMode?: HappierRuntimePermissionMode;
  }>,
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): Promise<HappierSessionMessageResult> {
  const sessionId = trimSessionId(input.sessionId);
  const message = buildHappierTransportMessage(input.systemPrompt, input.message);
  const localId = input.localId.trim();
  if (!localId || localId.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(localId)) {
    throw new HappierCliError("session", "Happier message localId is invalid");
  }
  const modelId = input.modelId?.trim();
  if (input.modelId !== undefined && (
    !modelId
    || modelId.length > 512
    || hasForbiddenControlCharacter(modelId)
  )) {
    throw new HappierCliError("session", "Happier message modelId is invalid");
  }
  const permissionMode = input.permissionMode;
  if (
    permissionMode !== undefined
    && permissionMode !== "read-only"
    && permissionMode !== "safe-yolo"
  ) {
    throw new HappierCliError("session", "Happier message permission mode is invalid");
  }
  const timeoutSeconds = validatePositiveInteger(input.timeoutSeconds, "timeoutSeconds");
  /*
   * FNXC:HappierTimeoutHierarchy 2026-07-27-02:51:
   * `session send --wait` owns an inner provider deadline. Keep the controlling
   * process alive through that deadline plus cleanup grace; a generic 30-second
   * tool timeout must not terminate a valid 120/300-second provider wait.
   */
  const outerTimeoutMs = resolveHappierWaitTimeoutMs(timeoutSeconds, settings);
  const data = ensureRecord(
    await invokeHappierJsonForKind(
      [
        "session",
        "send",
        sessionId,
        message,
        "--local-id",
        localId,
        ...(permissionMode ? ["--permission-mode", permissionMode] : []),
        ...(modelId ? ["--model", modelId] : []),
        "--wait",
        "--timeout",
        String(timeoutSeconds),
        "--json",
      ],
      "session_send",
      settings,
      signal,
      outerTimeoutMs,
    ),
    "session send",
  );
  const returnedSessionId = expectedSessionId(data, sessionId, "session send");
  if (data.localId !== localId) throw new HappierCliError("protocol", "Happier session send returned a mismatched localId");
  if (data.waited !== undefined && typeof data.waited !== "boolean") throw new HappierCliError("session", "Happier session send returned an invalid waited flag");
  return { ...data, sessionId: returnedSessionId } as HappierSessionMessageResult;
}

export async function archiveHappierSession(
  sessionId: string,
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): Promise<void> {
  const requested = trimSessionId(sessionId);
  const data = ensureRecord(
    await invokeHappierJsonForKind(["session", "archive", requested, "--json"], "session_archive", settings, signal),
    "session archive",
  );
  expectedSessionId(data, requested, "session archive");
}

/**
 * FNXC:HappierRemoteStopProof 2026-07-27-03:17:
 * Process termination is only local cleanup. Cancellation is complete only
 * when Happier's official stop command echoes the exact session identity and
 * `stopped:true`; every other response remains an unconfirmed remote stop.
 */
export async function stopHappierSession(
  sessionId: string,
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): Promise<HappierSessionStopResult> {
  const requested = trimSessionId(sessionId);
  const data = ensureRecord(
    await invokeHappierJsonForKind(
      ["session", "stop", requested, "--json"],
      "session_stop",
      settings,
      signal,
    ),
    "session stop",
  );
  const returned = expectedSessionId(data, requested, "session stop");
  if (data.stopped !== true) {
    throw new HappierCliError(
      "protocol",
      "Happier session stop did not confirm stopped true",
      undefined,
      "stop_unconfirmed",
    );
  }
  return { ...data, sessionId: returned, stopped: true } as HappierSessionStopResult;
}

function sessionControlValue(value: string, field: string): string {
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > 512
    || hasForbiddenControlCharacter(normalized)
  ) {
    throw new HappierCliError("session", `Happier Session ${field} is invalid`);
  }
  return normalized;
}

/**
 * FNXC:HappierRuntimeVisibleOptions 2026-07-27-16:16:
 * Persist the operator-visible title/model/permission through Happier's
 * official Session controls. Exact echo validation prevents a prefix-resolved
 * or stale control response from silently targeting another Session.
 */
export async function setHappierSessionTitle(
  sessionId: string,
  title: string,
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): Promise<void> {
  const requested = trimSessionId(sessionId);
  const normalizedTitle = sessionControlValue(title, "title");
  const data = ensureRecord(
    await invokeHappierJsonForKind(
      ["session", "set-title", requested, normalizedTitle, "--json"],
      "session_set_title",
      settings,
      signal,
    ),
    "session set-title",
  );
  expectedSessionId(data, requested, "session set-title");
  if (data.title !== normalizedTitle) {
    throw new HappierCliError("protocol", "Happier session set-title returned a mismatched title");
  }
}

export async function setHappierSessionModel(
  sessionId: string,
  modelId: string,
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): Promise<void> {
  const requested = trimSessionId(sessionId);
  const normalizedModelId = sessionControlValue(modelId, "modelId");
  const data = ensureRecord(
    await invokeHappierJsonForKind(
      ["session", "set-model", requested, normalizedModelId, "--json"],
      "session_set_model",
      settings,
      signal,
    ),
    "session set-model",
  );
  expectedSessionId(data, requested, "session set-model");
  if (data.modelId !== normalizedModelId) {
    throw new HappierCliError("protocol", "Happier session set-model returned a mismatched modelId");
  }
}

export async function setHappierSessionPermissionMode(
  sessionId: string,
  permissionMode: HappierRuntimePermissionMode,
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): Promise<void> {
  const requested = trimSessionId(sessionId);
  const data = ensureRecord(
    await invokeHappierJsonForKind(
      ["session", "set-permission-mode", requested, permissionMode, "--json"],
      "session_set_permission_mode",
      settings,
      signal,
    ),
    "session set-permission-mode",
  );
  expectedSessionId(data, requested, "session set-permission-mode");
  if (data.permissionMode !== permissionMode) {
    throw new HappierCliError(
      "protocol",
      "Happier session set-permission-mode returned a mismatched permission mode",
    );
  }
}

export async function getHappierSessionStatus(
  sessionId: string,
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): Promise<HappierSessionStatusResult> {
  const requested = trimSessionId(sessionId);
  const data = ensureRecord(await invokeHappierJsonForKind(["session", "status", requested, "--json"], "session_status", settings, signal), "session status");
  if (!isRecord(data.session)) throw new HappierCliError("session", "Happier session status returned invalid session data");
  const returned = trimSessionId(data.session.id);
  if (returned !== requested) throw new HappierCliError("session", "Happier session status returned a mismatched session id");
  if (data.agentState !== undefined && data.agentState !== null && !isRecord(data.agentState)) throw new HappierCliError("session", "Happier session status returned invalid agentState data");
  return { ...data, sessionId: returned, session: data.session } as HappierSessionStatusResult;
}

export async function getHappierSessionHistory(
  sessionId: string,
  limitOrSettings: number | HappierCliSettings = 50,
  settingsOrLimit?: HappierCliSettings | number,
  signal?: AbortSignal,
): Promise<HappierSessionHistoryResult> {
  const requested = trimSessionId(sessionId);
  const limit = typeof limitOrSettings === "number" ? limitOrSettings : typeof settingsOrLimit === "number" ? settingsOrLimit : 50;
  const settings = typeof limitOrSettings === "number" ? (typeof settingsOrLimit === "object" ? settingsOrLimit : undefined) : limitOrSettings;
  validatePositiveInteger(limit, "limit");
  const data = ensureRecord(
    await invokeHappierJsonForKind(
      ["session", "history", requested, "--limit", String(limit), "--format", "raw", "--json"],
      "session_history",
      settings,
      signal,
    ),
    "session history",
  );
  const returned = expectedSessionId(data, requested, "session history");
  if (typeof data.format !== "string" || !data.format.trim() || !Array.isArray(data.messages)) throw new HappierCliError("session", "Happier session history returned invalid data");
  return { ...data, sessionId: returned, format: data.format, messages: data.messages } as HappierSessionHistoryResult;
}

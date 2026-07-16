import { spawn } from "node:child_process";

import {
  HAPPIER_BACKENDS,
  HappierCliError,
  type HappierBackend,
  type HappierCliInvocation,
  type HappierCliSettings,
  type HappierDirectSessionEnsureResult,
  type HappierErrorCode,
  type HappierFailureEnvelope,
  type HappierJsonEnvelope,
  type HappierJsonRecord,
  type HappierMessageInput,
  type HappierSessionCreateInput,
  type HappierSessionCreateResult,
  type HappierSessionHistoryResult,
  type HappierSessionMessageResult,
  type HappierSessionStatusResult,
  type HappierSuccessEnvelope,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const REDACTED = "[REDACTED]";
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
  "secret",
  "token",
]);

const BEARER_RE = /\bBearer\s+[^\s"'`,;\]}]+/gi;
const SENSITIVE_ASSIGNMENT_RE = /(["']?)(access(?:[_-]?token|[_-]?key)|client[_-]?secret|private[_-]?key|authorization|bearer[_-]?token|token|secret|password|key)\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;\]}]+)/gi;

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

/** Resolve explicit settings first, then non-secret environment fallbacks. */
export function resolveHappierCliSettings(
  settings?: HappierCliSettings | Record<string, unknown>,
): Required<Pick<HappierCliSettings, "executable" | "timeoutMs" | "maxOutputBytes">> & HappierCliSettings {
  const entrypoint = nonEmptyString(settings?.entrypoint) ?? nonEmptyString(process.env.HAPPIER_CLI_ENTRYPOINT);
  const executable =
    nonEmptyString(settings?.executable) ??
    nonEmptyString(process.env.HAPPIER_CLI_EXECUTABLE) ??
    (entrypoint ? process.execPath : "happier");

  return {
    executable,
    entrypoint,
    homeDir: nonEmptyString(settings?.homeDir) ?? nonEmptyString(process.env.HAPPIER_HOME_DIR),
    activeServerId:
      nonEmptyString(settings?.activeServerId) ?? nonEmptyString(process.env.HAPPIER_ACTIVE_SERVER_ID),
    serverUrl: nonEmptyString(settings?.serverUrl) ?? nonEmptyString(process.env.HAPPIER_SERVER_URL),
    publicServerUrl:
      nonEmptyString(settings?.publicServerUrl) ?? nonEmptyString(process.env.HAPPIER_PUBLIC_SERVER_URL),
    webappUrl: nonEmptyString(settings?.webappUrl) ?? nonEmptyString(process.env.HAPPIER_WEBAPP_URL),
    profile: nonEmptyString(settings?.profile) ?? nonEmptyString(process.env.HAPPIER_PROFILE),
    timeoutMs: positiveNumber(settings?.timeoutMs ?? process.env.HAPPIER_CLI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxOutputBytes: Math.max(
      1,
      Math.floor(positiveNumber(settings?.maxOutputBytes ?? process.env.HAPPIER_CLI_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES)),
    ),
  };
}

/**
 * FNXC:HappierRuntime 2026-07-14-09:54:
 * Preserve the parent environment while pinning every non-secret Happier stack
 * selector. Credentials remain owned by the official Happier home directory.
 */
export function buildHappierProcessEnv(
  settings: HappierCliSettings,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const resolved = resolveHappierCliSettings(settings);
  return {
    ...baseEnv,
    ...(resolved.homeDir ? { HAPPIER_HOME_DIR: resolved.homeDir } : {}),
    ...(resolved.activeServerId ? { HAPPIER_ACTIVE_SERVER_ID: resolved.activeServerId } : {}),
    ...(resolved.serverUrl ? { HAPPIER_SERVER_URL: resolved.serverUrl } : {}),
    ...(resolved.publicServerUrl ? { HAPPIER_PUBLIC_SERVER_URL: resolved.publicServerUrl } : {}),
    ...(resolved.webappUrl ? { HAPPIER_WEBAPP_URL: resolved.webappUrl } : {}),
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

function invalidEnvelope(reason: string, raw: string, maxBytes: number): HappierCliError {
  return new HappierCliError(
    "invalid-json",
    `Happier CLI returned an invalid JSON envelope: ${reason}; output=${redactHappierOutput(raw, maxBytes)}`,
  );
}

/** Parse and validate Happier's exact `{v,ok,kind,data|error}` envelope. */
export async function parseHappierJson<T = unknown>(
  raw: string,
  maxBytes = DEFAULT_MAX_OUTPUT_BYTES,
): Promise<HappierJsonEnvelope<T>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid JSON";
    throw invalidEnvelope(reason, raw, maxBytes);
  }

  if (!isRecord(parsed) || parsed.v !== 1 || typeof parsed.ok !== "boolean" || typeof parsed.kind !== "string" || !parsed.kind.trim()) {
    throw invalidEnvelope("expected v=1, boolean ok, and non-empty kind", raw, maxBytes);
  }
  if (parsed.ok === true && !("data" in parsed)) throw invalidEnvelope("success envelope is missing data", raw, maxBytes);
  if (parsed.ok === false && (!isRecord(parsed.error) || typeof parsed.error.code !== "string" || !parsed.error.code.trim())) {
    throw invalidEnvelope("failure envelope is missing error.code", raw, maxBytes);
  }
  return parsed as unknown as HappierJsonEnvelope<T>;
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
): Promise<T> {
  const resolved = resolveHappierCliSettings(settings);
  const invocation = buildHappierInvocation(commandArgs, resolved);
  const maxOutputBytes = resolved.maxOutputBytes;

  return new Promise<T>((resolve, reject) => {
    const stdout = new BoundedOutputAccumulator(maxOutputBytes);
    const stderr = new BoundedOutputAccumulator(maxOutputBytes);
    let child: ReturnType<typeof spawn> | undefined;
    let timer: NodeJS.Timeout | undefined;
    let settled = false;

    const finishReject = (error: HappierCliError): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    };

    const finishResolve = (value: T): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };

    function terminate(): void {
      try {
        child?.kill("SIGTERM");
      } catch {
        // The process may have already exited.
      }
    }

    function onAbort(): void {
      terminate();
      finishReject(new HappierCliError("timeout", "Happier CLI invocation aborted"));
    }

    function onOutput(stream: "stdout" | "stderr", chunk: Buffer): void {
      const accumulator = stream === "stdout" ? stdout : stderr;
      if (accumulator.append(chunk)) return;
      terminate();
      finishReject(new HappierCliError("output-limit", `Happier CLI ${stream} exceeded the ${maxOutputBytes}-byte output limit`));
    }

    try {
      child = spawn(invocation.command, invocation.args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: buildHappierProcessEnv(resolved),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finishReject(new HappierCliError("process", `Happier CLI spawn failed: ${redactHappierOutput(message, maxOutputBytes)}`));
      return;
    }

    timer = setTimeout(() => {
      terminate();
      finishReject(new HappierCliError("timeout", `Happier CLI timed out after ${resolved.timeoutMs}ms`));
    }, resolved.timeoutMs);

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
      if (settled) return;
      const rawStdout = stdout.toString();
      const rawStderr = stderr.toString();

      void parseHappierJson<unknown>(rawStdout, maxOutputBytes).then(
        (envelope) => {
          if (expectedKind && envelope.kind !== expectedKind) {
            finishReject(new HappierCliError("invalid-json", `Expected Happier envelope kind ${expectedKind}, received ${envelope.kind}`));
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
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await invokeHappierJson<T>(commandArgs, settings, signal, kind);
    } catch (error) {
      if (attempt === 2 || signal?.aborted || !isTransientWindowsStartupFailure(error)) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, attempt === 0 ? 75 : 250));
    }
  }
  throw new HappierCliError("process", "Happier CLI startup retry exhausted");
}

export function buildHappierSessionOpenUrl(webappUrl: string, serverId: string, sessionId: string): string {
  return `${webappUrl.replace(/\/+$/u, "")}/session/${encodeURIComponent(serverId)}/${encodeURIComponent(sessionId)}`;
}

function directSessionString(data: HappierJsonRecord, field: string): string {
  const value = nonEmptyString(data[field]);
  if (!value) throw new HappierCliError("session", `Happier direct session ensure returned an empty ${field}`);
  return value;
}

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

export async function createHappierSession(
  input: HappierSessionCreateInput,
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): Promise<HappierSessionCreateResult> {
  if (!input.cwd.trim() || !input.title.trim()) throw new HappierCliError("session", "Happier session cwd and title are required");
  const data = ensureRecord(
    await invokeHappierJsonForKind(
      ["session", "create", "--path", input.cwd, "--backend", validateBackend(input.backend), "--title", input.title, "--json"],
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

export async function sendHappierMessage(
  input: HappierMessageInput,
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): Promise<HappierSessionMessageResult> {
  const sessionId = trimSessionId(input.sessionId);
  if (!input.message.trim()) throw new HappierCliError("session", "Happier message is required");
  const localId = input.localId.trim();
  if (!localId || localId.length > 128 || !/^[A-Za-z0-9._:-]+$/u.test(localId)) {
    throw new HappierCliError("session", "Happier message localId is invalid");
  }
  const timeoutSeconds = validatePositiveInteger(input.timeoutSeconds, "timeoutSeconds");
  const data = ensureRecord(
    await invokeHappierJsonForKind(
      ["session", "send", sessionId, input.message, "--local-id", localId, "--wait", "--timeout", String(timeoutSeconds), "--json"],
      "session_send",
      settings,
      signal,
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

import { spawn } from "node:child_process";

import {
  HAPPIER_BACKENDS,
  HappierCliError,
  type HappierBackend,
  type HappierCliInvocation,
  type HappierCliSettings,
  type HappierErrorCode,
  type HappierJsonRecord,
  type HappierMessageInput,
  type HappierSessionCreateInput,
  type HappierSessionCreateResult,
  type HappierSessionHistoryResult,
  type HappierSessionMessageResult,
  type HappierSessionStatusResult,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

const BEARER_RE = /\bBearer\s+[^\s"'`,;\]}]+/gi;
const SENSITIVE_ASSIGNMENT_RE = /(\b(?:token|secret|password|api[_-]?key|authorization|key)\b\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;\]}]+)/gi;

/**
 * FNXC:HappierRuntime 2026-07-13-14:48:
 * CLI diagnostics may contain auth or provider material. Redact bearer values
 * and named token/secret/key fields before they enter an error or test report.
 */
export function redactHappierOutput(raw: string): string {
  return raw.replace(BEARER_RE, "Bearer [REDACTED]").replace(SENSITIVE_ASSIGNMENT_RE, "$1[REDACTED]");
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
    serverUrl: nonEmptyString(settings?.serverUrl) ?? nonEmptyString(process.env.HAPPIER_SERVER_URL),
    webappUrl: nonEmptyString(settings?.webappUrl) ?? nonEmptyString(process.env.HAPPIER_WEBAPP_URL),
    profile: nonEmptyString(settings?.profile) ?? nonEmptyString(process.env.HAPPIER_PROFILE),
    timeoutMs: positiveNumber(settings?.timeoutMs ?? process.env.HAPPIER_CLI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxOutputBytes: Math.floor(
      positiveNumber(settings?.maxOutputBytes ?? process.env.HAPPIER_CLI_MAX_OUTPUT_BYTES, DEFAULT_MAX_OUTPUT_BYTES),
    ),
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
  if (resolved.webappUrl) args.push("--webapp-url", resolved.webappUrl);
  if (resolved.profile) args.push("--profile", resolved.profile);
  args.push(...commandArgs);
  return { command: resolved.executable, args };
}

/** Parse exactly one non-null JSON object and redact malformed payloads. */
export async function parseHappierJson<T extends HappierJsonRecord = HappierJsonRecord>(raw: string): Promise<T> {
  try {
    const parsed: unknown = JSON.parse(raw.trim());
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JSON envelope must be an object");
    }
    return parsed as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid JSON";
    throw new HappierCliError("invalid-json", `Happier CLI returned invalid JSON: ${redactHappierOutput(reason)}; output=${redactHappierOutput(raw)}`);
  }
}

function appendBounded(current: string, chunk: Buffer, maxBytes: number): string {
  const combined = Buffer.concat([Buffer.from(current, "utf8"), chunk]);
  return combined.subarray(0, maxBytes).toString("utf8");
}

function classifyFailure(raw: string): HappierErrorCode {
  const lower = raw.toLowerCase();
  if (/auth|unauthori|forbidden|login|credential/.test(lower)) return "authentication";
  if (/daemon/.test(lower)) return "daemon";
  if (/backend|provider|model/.test(lower)) return "backend";
  if (/session|conversation|run\s+id/.test(lower)) return "session";
  if (/server|econn|connection|network|fetch|timeout/.test(lower)) return "server";
  return "process";
}

function recordErrorMessage(payload: HappierJsonRecord): string | undefined {
  const candidate = payload.error ?? (payload.ok === false ? payload.message ?? payload.status : undefined);
  if (typeof candidate === "string" && candidate.trim()) return candidate;
  if (candidate && typeof candidate === "object") {
    const message = (candidate as HappierJsonRecord).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return undefined;
}

function ensureNoErrorEnvelope(payload: HappierJsonRecord): void {
  const message = recordErrorMessage(payload);
  if (!message) return;
  const redacted = redactHappierOutput(message);
  throw new HappierCliError(classifyFailure(redacted), `Happier CLI request failed: ${redacted}`);
}

/**
 * FNXC:HappierRuntime 2026-07-13-14:48:
 * The integration boundary is the official JSON CLI. Keep process execution
 * shell-free, bounded, abortable, and independent from port 4040 or services.
 */
export function invokeHappierJson<T extends HappierJsonRecord = HappierJsonRecord>(
  commandArgs: readonly string[],
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): Promise<T> {
  const resolved = resolveHappierCliSettings(settings);
  const invocation = buildHappierInvocation(commandArgs, resolved);
  const maxOutputBytes = resolved.maxOutputBytes;

  return new Promise<T>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

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

    const onAbort = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may have already exited.
      }
      finishReject(new HappierCliError("timeout", "Happier CLI invocation aborted"));
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(invocation.command, invocation.args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finishReject(new HappierCliError("process", `Happier CLI spawn failed: ${redactHappierOutput(message)}`));
      return;
    }

    timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may have already exited.
      }
      finishReject(new HappierCliError("timeout", `Happier CLI timed out after ${resolved.timeoutMs}ms`));
    }, resolved.timeoutMs);

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk, maxOutputBytes);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk, maxOutputBytes);
    });

    child.once("error", (error: NodeJS.ErrnoException) => {
      finishReject(
        new HappierCliError("process", `Happier CLI process error: ${redactHappierOutput(error.message)}`, {
          stdout: redactHappierOutput(stdout),
          stderr: redactHappierOutput(stderr),
        }),
      );
    });

    child.once("close", (exitCode: number | null) => {
      if (settled) return;
      if (exitCode !== 0) {
        const diagnostic = redactHappierOutput([stdout, stderr].filter(Boolean).join("\n"));
        finishReject(
          new HappierCliError(classifyFailure(diagnostic), `Happier CLI exited with code ${String(exitCode)}: ${diagnostic}`, {
            exitCode,
            stdout: redactHappierOutput(stdout),
            stderr: redactHappierOutput(stderr),
          }),
        );
        return;
      }

      void parseHappierJson<T>(stdout).then(
        (payload) => {
          try {
            ensureNoErrorEnvelope(payload);
            finishResolve(payload);
          } catch (error) {
            finishReject(error instanceof HappierCliError ? error : new HappierCliError("process", String(error)));
          }
        },
        (error: unknown) => {
          finishReject(error instanceof HappierCliError ? error : new HappierCliError("invalid-json", String(error)));
        },
      );
    });
  });
}

function ensureRecord(value: unknown, operation: string): HappierJsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HappierCliError("session", `Happier ${operation} returned an invalid result envelope`);
  }
  return value as HappierJsonRecord;
}

function validateSessionId(sessionId: string): string {
  if (!sessionId.trim() || /[\u0000-\u001f\u007f]/.test(sessionId) || sessionId.length > 512) {
    throw new HappierCliError("session", "Happier session id is invalid");
  }
  return sessionId;
}

function validateBackend(backend: HappierBackend): HappierBackend {
  if (!HAPPIER_BACKENDS.includes(backend)) {
    throw new HappierCliError("backend", `Unsupported Happier backend: ${String(backend)}`);
  }
  return backend;
}

function validatePositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new HappierCliError("session", `${field} must be a positive integer`);
  }
  return value;
}

function findSessionId(payload: HappierJsonRecord): string | undefined {
  const direct = payload.sessionId ?? payload.session_id ?? payload.id;
  if (typeof direct === "string" && direct.trim()) return direct;
  const nested = payload.session;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const nestedRecord = nested as HappierJsonRecord;
    const nestedId = nestedRecord.sessionId ?? nestedRecord.session_id ?? nestedRecord.id;
    if (typeof nestedId === "string" && nestedId.trim()) return nestedId;
  }
  return undefined;
}

function withSessionId(payload: HappierJsonRecord, sessionId: string, operation: string): HappierJsonRecord & { sessionId: string } {
  const returnedId = findSessionId(payload);
  if (returnedId && returnedId !== sessionId) {
    throw new HappierCliError("session", `Happier ${operation} returned a mismatched session id`);
  }
  return { ...payload, sessionId };
}

export async function createHappierSession(
  input: HappierSessionCreateInput,
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): Promise<HappierSessionCreateResult> {
  if (!input.cwd.trim() || !input.title.trim()) {
    throw new HappierCliError("session", "Happier session cwd and title are required");
  }
  const payload = ensureRecord(
    await invokeHappierJson(
      ["session", "create", "--path", input.cwd, "--backend", validateBackend(input.backend), "--title", input.title, "--json"],
      settings,
      signal,
    ),
    "session create",
  );
  const sessionId = findSessionId(payload);
  if (!sessionId) throw new HappierCliError("session", "Happier session create returned no session id");
  return { ...payload, sessionId: validateSessionId(sessionId) } as HappierSessionCreateResult;
}

export async function sendHappierMessage(
  input: HappierMessageInput,
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): Promise<HappierSessionMessageResult> {
  const sessionId = validateSessionId(input.sessionId);
  if (!input.message.trim()) throw new HappierCliError("session", "Happier message is required");
  const timeoutSeconds = validatePositiveInteger(input.timeoutSeconds, "timeoutSeconds");
  const payload = ensureRecord(
    await invokeHappierJson(
      ["session", "send", sessionId, input.message, "--wait", "--timeout", String(timeoutSeconds), "--json"],
      settings,
      signal,
    ),
    "session send",
  );
  return withSessionId(payload, sessionId, "session send") as HappierSessionMessageResult;
}

export async function getHappierSessionStatus(
  sessionId: string,
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): Promise<HappierSessionStatusResult> {
  const validatedSessionId = validateSessionId(sessionId);
  const payload = ensureRecord(
    await invokeHappierJson(["session", "status", validatedSessionId, "--json"], settings, signal),
    "session status",
  );
  return withSessionId(payload, validatedSessionId, "session status") as HappierSessionStatusResult;
}

export async function getHappierSessionHistory(
  sessionId: string,
  limitOrSettings: number | HappierCliSettings = 50,
  settingsOrLimit?: HappierCliSettings | number,
  signal?: AbortSignal,
): Promise<HappierSessionHistoryResult> {
  const validatedSessionId = validateSessionId(sessionId);
  const limit = typeof limitOrSettings === "number" ? limitOrSettings : typeof settingsOrLimit === "number" ? settingsOrLimit : 50;
  const settings = typeof limitOrSettings === "number" ? (typeof settingsOrLimit === "object" ? settingsOrLimit : undefined) : limitOrSettings;
  validatePositiveInteger(limit, "limit");
  const payload = ensureRecord(
    await invokeHappierJson(
      ["session", "history", validatedSessionId, "--limit", String(limit), "--format", "raw", "--json"],
      settings,
      signal,
    ),
    "session history",
  );
  return withSessionId(payload, validatedSessionId, "session history") as HappierSessionHistoryResult;
}

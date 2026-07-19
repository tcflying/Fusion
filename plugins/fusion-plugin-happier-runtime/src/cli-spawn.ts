import { execFile, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import {
  HAPPIER_BACKENDS,
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
  const backend = typeof settings?.backend === "string"
    && HAPPIER_BACKENDS.includes(settings.backend as HappierBackend)
    ? settings.backend as HappierBackend
    : undefined;
  const happierSessionBindings = Array.isArray(settings?.happierSessionBindings)
    ? settings.happierSessionBindings as readonly HappierSessionBinding[]
    : undefined;

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
    ...(backend ? { backend } : {}),
    ...(happierSessionBindings ? { happierSessionBindings } : {}),
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

const CHILD_TERMINATION_TIMEOUT_MS = 2_000;

function signalHappierChild(child: ReturnType<typeof spawn>): boolean {
  try {
    return child.kill("SIGTERM");
  } catch {
    return false;
  }
}

function terminateHappierChild(child: ReturnType<typeof spawn> | undefined): Promise<boolean> {
  if (
    !child
    || typeof child.exitCode === "number"
    || typeof child.signalCode === "string"
  ) return Promise.resolve(true);
  if (process.platform === "win32" && typeof child.pid === "number") {
    return new Promise((resolve) => {
      execFile(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        {
          shell: false,
          timeout: CHILD_TERMINATION_TIMEOUT_MS,
          windowsHide: true,
          maxBuffer: 64 * 1024,
        },
        (error) => {
          if (!error) {
            resolve(true);
            return;
          }
          // Direct-child fallback is best effort only. A failed or timed-out
          // tree kill remains observable to iterator cancellation callers.
          signalHappierChild(child);
          resolve(false);
        },
      );
    });
  }
  return Promise.resolve(signalHappierChild(child));
}

function waitForHappierChildClose(child: ReturnType<typeof spawn> | undefined): Promise<boolean> {
  if (
    !child
    || typeof child.exitCode === "number"
    || typeof child.signalCode === "string"
  ) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (closed: boolean): void => {
      child.removeListener("close", onClose);
      if (timer) clearTimeout(timer);
      resolve(closed);
    };
    const onClose = (): void => finish(true);
    child.once("close", onClose);
    timer = setTimeout(() => finish(false), CHILD_TERMINATION_TIMEOUT_MS);
    timer.unref();
  });
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
      void terminateHappierChild(child);
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
    terminationPromise ??= terminateHappierChild(child);
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
      const closed = childClosed ? Promise.resolve(true) : waitForHappierChildClose(child);
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

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import {
  buildHappierInvocation,
  buildHappierProcessEnv,
  resolveHappierCliSettings,
  resolveHappierWaitTimeoutMs,
} from "./cli-spawn.js";
import {
  HappierCliError,
  type HappierCliSettings,
  type HappierJsonRecord,
} from "./types.js";
import { terminateAndWaitHappierProcessTree } from "./process-lifecycle.js";
import {
  HAPPIER_OFFICIAL_MCP_TOOLS,
} from "./official-session-control-contract.js";
import { HAPPIER_SESSION_CONNECTOR_VERSION } from "./session-connector-contract.js";

export {
  HAPPIER_OFFICIAL_MCP_TOOLS,
  HAPPIER_OFFICIAL_SESSION_CONTROL_SOURCE,
} from "./official-session-control-contract.js";
export type { HappierOfficialMcpToolName } from "./official-session-control-contract.js";

/**
 * Not part of Happier's upstream public MCP contract. These tool names are
 * available only when the local source extension is explicitly enabled.
 */
export const HAPPIER_LOCAL_MCP_EXTENSION_TOOLS = {
  runtimeSnapshot: "fusion_runtime_snapshot_get",
  reconciliationHistory: "fusion_reconciliation_history_get",
  providerTelemetry: "fusion_provider_telemetry_get",
} as const;

export interface HappierMcpToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
}

export interface HappierMcpToolResult extends HappierJsonRecord {
  readonly content?: readonly unknown[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

export interface HappierMcpClient {
  listTools(signal?: AbortSignal): Promise<readonly HappierMcpToolDefinition[]>;
  callTool(
    input: Readonly<{ name: string; arguments?: Readonly<Record<string, unknown>> }>,
    signal?: AbortSignal,
  ): Promise<HappierMcpToolResult>;
  close(): Promise<void>;
}

export interface HappierMcpClientFactoryInput {
  readonly settings: HappierCliSettings;
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
}

export type HappierMcpClientFactory = (
  input: HappierMcpClientFactoryInput,
) => Promise<HappierMcpClient>;

type PendingRequest = {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
};

function isRecord(value: unknown): value is HappierJsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeSessionId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512 || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new HappierCliError("session", "Happier MCP session id is invalid");
  }
  return trimmed;
}

function requiredResultRecord(value: unknown, operation: string): HappierJsonRecord {
  if (!isRecord(value)) throw new HappierCliError("protocol", `Happier MCP ${operation} returned an invalid result`);
  return value;
}

/*
 * FNXC:HappierTimeoutHierarchy 2026-07-27-03:01:
 * Process creation, MCP negotiation, ordinary tools, and provider waits have
 * distinct deadlines. Prove spawn before starting the connect timer so one
 * budget cannot silently consume another.
 */
function waitForHappierMcpSpawn(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (typeof child.pid === "number" && child.pid > 0) return Promise.resolve();
  if (signal?.aborted) {
    return terminateAndWaitHappierProcessTree(child).then((cleaned) => Promise.reject(
      cleaned
        ? new HappierCliError("timeout", "Happier MCP spawn was aborted")
        : new HappierCliError("process", "Happier MCP spawn abort cleanup could not be confirmed"),
    ));
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("spawn", onSpawn);
      child.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: HappierCliError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const terminateThenReject = (error: HappierCliError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void terminateAndWaitHappierProcessTree(child).then(
        (cleaned) => reject(cleaned
          ? error
          : new HappierCliError("process", "Happier MCP spawn cleanup could not be confirmed")),
        () => reject(new HappierCliError("process", "Happier MCP spawn cleanup failed")),
      );
    };
    const onSpawn = (): void => finish();
    const onError = (): void => finish(new HappierCliError("process", "Happier MCP process could not be started"));
    const onAbort = (): void => {
      terminateThenReject(new HappierCliError("timeout", "Happier MCP spawn was aborted"));
    };
    const timeout = setTimeout(() => {
      terminateThenReject(new HappierCliError(
        "timeout",
        "Happier MCP process spawn timed out",
        undefined,
        "cli_spawn_timeout",
      ));
    }, timeoutMs);
    child.once("spawn", onSpawn);
    child.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * FNXC:HappierOfficialMcpBridge 2026-07-19-19:29:
 * Fusion invokes only Happier's documented external MCP server (`happier mcp
 * serve`) for session control. The client owns the short-lived stdio process,
 * passes no credentials, and keeps every session id explicit at tool-call time.
 */
class HappierStdioMcpClient implements HappierMcpClient {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly decoder = new StringDecoder("utf8");
  private readonly maxOutputBytes: number;
  private readonly settings: HappierCliSettings;
  private readonly connectTimeoutMs: number;
  private readonly toolTimeoutMs: number;
  private nextId = 1;
  private buffered = "";
  private stderrBytes = 0;
  private closed = false;
  private processCleanup: Promise<boolean> | null = null;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    settings: HappierCliSettings,
  ) {
    const resolved = resolveHappierCliSettings(settings);
    this.maxOutputBytes = resolved.maxOutputBytes;
    this.settings = resolved;
    this.connectTimeoutMs = resolved.connectTimeoutMs!;
    this.toolTimeoutMs = resolved.toolTimeoutMs!;
    this.child.stdout.on("data", this.onStdout);
    this.child.stderr.on("data", this.onStderr);
    this.child.once("error", this.onProcessError);
    this.child.once("close", this.onProcessClose);
  }

  async initialize(signal?: AbortSignal): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: {
        name: "fusion-happier-runtime",
        version: HAPPIER_SESSION_CONNECTOR_VERSION,
      },
    }, signal, this.connectTimeoutMs);
    this.notify("notifications/initialized", {});
  }

  async listTools(signal?: AbortSignal): Promise<readonly HappierMcpToolDefinition[]> {
    const result = requiredResultRecord(
      await this.request("tools/list", {}, signal, this.toolTimeoutMs),
      "tools/list",
    );
    if (!Array.isArray(result.tools)) {
      throw new HappierCliError("protocol", "Happier MCP tools/list returned no tools array");
    }
    return result.tools.map((tool) => {
      if (!isRecord(tool)) throw new HappierCliError("protocol", "Happier MCP tools/list returned an invalid tool");
      const name = nonEmptyString(tool.name);
      if (!name) throw new HappierCliError("protocol", "Happier MCP tools/list returned a tool without a name");
      return {
        name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        ...(isRecord(tool.inputSchema) ? { inputSchema: tool.inputSchema } : {}),
      };
    });
  }

  async callTool(
    input: Readonly<{ name: string; arguments?: Readonly<Record<string, unknown>> }>,
    signal?: AbortSignal,
  ): Promise<HappierMcpToolResult> {
    const name = nonEmptyString(input.name);
    if (!name) throw new HappierCliError("protocol", "Happier MCP tool name is required");
    const argumentsRecord = input.arguments ?? {};
    const waitsForProvider = name === HAPPIER_OFFICIAL_MCP_TOOLS.wait
      || (name === HAPPIER_OFFICIAL_MCP_TOOLS.send && argumentsRecord.wait === true);
    const requestTimeoutMs = waitsForProvider
      ? resolveHappierWaitTimeoutMs(Number(argumentsRecord.timeoutSeconds), this.settings)
      : this.toolTimeoutMs;
    const result = requiredResultRecord(await this.request("tools/call", {
      name,
      arguments: argumentsRecord,
    }, signal, requestTimeoutMs), `tool ${name}`);
    if (result.isError !== undefined && typeof result.isError !== "boolean") {
      throw new HappierCliError("protocol", `Happier MCP tool ${name} returned an invalid isError flag`);
    }
    return result as HappierMcpToolResult;
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      try {
        this.child.stdin.end();
      } catch {
        // The process is already closing; settle pending requests below.
      }
      this.rejectAll(new HappierCliError("process", "Happier MCP client closed"));
      this.detachListeners();
    }
    if (!await this.cleanupProcess()) {
      throw new HappierCliError("process", "Happier MCP process-tree cleanup could not be confirmed");
    }
  }

  private readonly onStdout = (chunk: Buffer | string): void => {
    if (this.closed) return;
    this.buffered += this.decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
    if (Buffer.byteLength(this.buffered, "utf8") > this.maxOutputBytes) {
      this.fail(new HappierCliError("output-limit", "Happier MCP stdout exceeded the configured limit"));
      return;
    }
    let newline = this.buffered.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffered.slice(0, newline).trim();
      this.buffered = this.buffered.slice(newline + 1);
      if (line) this.handleLine(line);
      newline = this.buffered.indexOf("\n");
    }
  };

  private readonly onProcessError = (): void => {
    this.fail(new HappierCliError("process", "Happier MCP process failed"));
  };

  private readonly onStderr = (chunk: Buffer | string): void => {
    if (this.closed) return;
    this.stderrBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, "utf8");
    if (this.stderrBytes > this.maxOutputBytes) {
      this.fail(new HappierCliError("output-limit", "Happier MCP stderr exceeded the configured limit"));
    }
  };

  private readonly onProcessClose = (): void => {
    if (this.closed) return;
    this.fail(new HappierCliError("process", "Happier MCP process closed before completing the request"));
  };

  private handleLine(line: string): void {
    let response: unknown;
    try {
      response = JSON.parse(line);
    } catch {
      this.fail(new HappierCliError("invalid-json", "Happier MCP emitted malformed JSON-RPC"));
      return;
    }
    if (!isRecord(response) || response.jsonrpc !== "2.0" || typeof response.id !== "number") return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    this.clearPending(pending);
    if (isRecord(response.error)) {
      pending.reject(new HappierCliError("protocol", `Happier MCP ${pending.method} rejected the request`));
      return;
    }
    if (!("result" in response)) {
      pending.reject(new HappierCliError("protocol", `Happier MCP ${pending.method} returned no result`));
      return;
    }
    pending.resolve(response.result);
  }

  private request(
    method: string,
    params: HappierJsonRecord,
    signal?: AbortSignal,
    timeoutMs = this.toolTimeoutMs,
  ): Promise<unknown> {
    if (this.closed) return Promise.reject(new HappierCliError("process", "Happier MCP client is closed"));
    if (signal?.aborted) return Promise.reject(new HappierCliError("timeout", "Happier MCP request was aborted"));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const rejectError = (error: Error): void => reject(error);
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        this.clearPending(pending);
        rejectError(new HappierCliError("timeout", `Happier MCP ${method} timed out`));
        void this.close();
      }, timeoutMs);
      const onAbort = signal ? () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        this.clearPending(pending);
        rejectError(new HappierCliError("timeout", "Happier MCP request was aborted"));
        void this.close();
      } : undefined;
      const pending: PendingRequest = { method, resolve, reject: rejectError, timeout, ...(signal ? { signal, onAbort } : {}) };
      this.pending.set(id, pending);
      signal?.addEventListener("abort", onAbort!, { once: true });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, "utf8", (error) => {
          if (!error) return;
          const current = this.pending.get(id);
          if (!current) return;
          this.pending.delete(id);
          this.clearPending(current);
          rejectError(new HappierCliError("process", "Happier MCP stdin write failed"));
        });
      } catch {
        this.pending.delete(id);
        this.clearPending(pending);
        rejectError(new HappierCliError("process", "Happier MCP stdin write failed"));
      }
    });
  }

  private notify(method: string, params: HappierJsonRecord): void {
    if (this.closed) return;
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`, "utf8");
    } catch {
      this.fail(new HappierCliError("process", "Happier MCP initialization notification failed"));
    }
  }

  private clearPending(pending: PendingRequest): void {
    clearTimeout(pending.timeout);
    if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      this.clearPending(pending);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private fail(error: HappierCliError): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectAll(error);
    this.detachListeners();
    void this.cleanupProcess();
  }

  private cleanupProcess(): Promise<boolean> {
    this.processCleanup ??= terminateAndWaitHappierProcessTree(this.child).catch(() => false);
    return this.processCleanup;
  }

  private detachListeners(): void {
    this.child.stdout.off("data", this.onStdout);
    this.child.stderr.off("data", this.onStderr);
    this.child.off("error", this.onProcessError);
    this.child.off("close", this.onProcessClose);
  }
}

export async function openHappierMcpClient(
  input: HappierMcpClientFactoryInput,
): Promise<HappierMcpClient> {
  const settings = resolveHappierCliSettings(input.settings);
  const sessionId = safeSessionId(input.sessionId);
  const invocation = buildHappierInvocation([
    "mcp",
    "serve",
    ...(sessionId ? ["--session", sessionId] : []),
  ], settings);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(invocation.command, invocation.args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: buildHappierProcessEnv(settings),
    }) as ChildProcessWithoutNullStreams;
  } catch {
    throw new HappierCliError("process", "Happier MCP process could not be started");
  }
  await waitForHappierMcpSpawn(child, settings.spawnTimeoutMs!, input.signal);
  const client = new HappierStdioMcpClient(child, settings);
  try {
    await client.initialize(input.signal);
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

/**
 * FNXC:HappierRuntime 2026-07-13-19:42:
 * Fusion owns scheduling and canonical native-id persistence while Happier
 * owns the native session and transcript. Each Fusion runtime session has a
 * private queue; ambiguous sends are reconciled once and are never resent.
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  archiveHappierSession,
  createHappierSession,
  getHappierSessionHistory,
  getHappierSessionStatus,
  listHappierSessions,
  resolveHappierCliSettings,
  sendHappierMessage,
  setHappierSessionModel,
  setHappierSessionPermissionMode,
  setHappierSessionTitle,
  stopHappierSession,
  type HappierResumeProcessLease,
} from "./cli-spawn.js";
import { resolveHappierBackend } from "./backend-resolver.js";
import {
  verifyHappierCliAttestation,
  type HappierCliAttestation,
} from "./cli-attestation.js";
import {
  buildHappierCreateIntentIdentity,
  createHappierCreateIntentStore,
  type HappierCreateIntentIdentity,
  type HappierCreateIntentRecord,
  type HappierCreateIntentState,
  type HappierCreateIntentStore,
} from "./create-intent-store.js";
import {
  buildHappierStopIdentity,
  createHappierStopStateStore,
  type HappierStopReasonCode,
  type HappierStopState,
  type HappierStopStateStore,
} from "./stop-state-store.js";
import {
  resolveHappierRuntimeModelId,
  resolveHappierRuntimePermissionMode,
  type HappierRuntimePermissionMode,
} from "./runtime-options.js";
import { resumeHappierSessionStrictly } from "./strict-resume.js";
import type {
  HappierCliSettings,
  HappierRawHistoryRow,
  HappierSessionHistoryResult,
  HappierSessionListItem,
  HappierSessionStatusResult,
} from "./types.js";
import {
  HappierCliError,
  type AgentRuntime,
  type AgentRuntimeOptions,
  type AgentSession,
  type AgentSessionResult,
  type HappierAgentSession,
  type HappierBackend,
  type HappierRecoveryErrorCode,
  type HappierRuntimeState,
} from "./types.js";

const HISTORY_LIMIT = 250;
const bindingQueues = new Map<string, Promise<void>>();
const RESUMABLE_STATES = new Set([
  "active",
  "idle",
  "ready",
  "running",
  "waiting",
  "waitingoninput",
  "paused",
  "recoverable",
]);

export interface HappierRuntimeAdapterDependencies {
  readonly attestCli: (settings: HappierCliSettings) => Promise<HappierCliAttestation>;
}

const defaultRuntimeAdapterDependencies: HappierRuntimeAdapterDependencies = {
  attestCli: verifyHappierCliAttestation,
};

interface ParsedHistoryRow {
  id: string;
  localId?: string;
  createdAt: number;
  role: string;
  contentType?: string;
  text?: string;
  postIndex: number;
}

interface HistoryWatermark {
  markerId?: string;
  markerCreatedAt?: number;
  rowIds: string[];
}

interface HistoryReconciliation {
  history: HappierSessionHistoryResult;
  status: HappierSessionStatusResult;
  added: ParsedHistoryRow[];
}

export class HappierRecoveryError extends Error {
  readonly name = "HappierRecoveryError";

  constructor(
    readonly code: HappierRecoveryErrorCode,
    message: string,
    readonly nativeSessionId: string,
    readonly cause?: unknown,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStatusValue(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return (
    nonEmptyString(record.status) ??
    nonEmptyString(record.state) ??
    (record.agentState && typeof record.agentState === "object" ? readStatusValue(record.agentState) : undefined) ??
    (record.session && typeof record.session === "object" ? readStatusValue(record.session) : undefined)
  );
}

function statusAllowsResumeAttempt(result: { session: Record<string, unknown>; agentState?: Record<string, unknown> }): boolean {
  const session = result.session;
  const agentState = result.agentState;
  if (session.resumable === false || agentState?.resumable === false) return false;
  // Official status guarantees `active`; official `happier resume` owns the
  // stronger vendor-resume eligibility check that status does not expose.
  if (session.active === false) return true;
  if (session.resumable === true || agentState?.resumable === true) return true;
  if (session.active === true) return true;
  const state = (readStatusValue(agentState) ?? readStatusValue(session))?.toLowerCase();
  return state !== undefined && RESUMABLE_STATES.has(state);
}

function statusToRuntimeState(value: unknown): HappierRuntimeState | undefined {
  const status = readStatusValue(value)?.toLowerCase();
  if (!status) return undefined;
  if (status === "waiting" || status === "waitingoninput" || status === "awaiting_input") return "waitingOnInput";
  if (status === "running" || status === "active" || status === "busy") return "running";
  if (status === "completed" || status === "done") return "completed";
  if (status === "failed" || status === "error") return "failed";
  if (status === "blocked") return "blocked";
  if (status === "recovering") return "recovering";
  if (status === "starting") return "starting";
  return "ready";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readFirstText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const text = record?.text ?? record?.content;
    if (typeof text === "string") parts.push(text);
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

/** Parse only content variants emitted by Happier's official raw transcript row builder. */
function rawContentText(raw: Record<string, unknown>): string | undefined {
  const content = asRecord(raw.content);
  if (!content) return undefined;
  if (content.type === "text") return readFirstText(content.text);
  if (content.type === "output") {
    const data = asRecord(content.data);
    const message = asRecord(data?.message);
    return readFirstText(message?.content) ?? (typeof data?.text === "string" ? data.text : undefined);
  }
  if (content.type === "acp" || content.type === "codex" || content.type === "event") {
    const data = asRecord(content.data);
    return data?.type === "message" && typeof data.message === "string" ? data.message : undefined;
  }
  return undefined;
}

function parseRawHistoryRows(history: HappierSessionHistoryResult): ParsedHistoryRow[] {
  if (history.format !== "raw") {
    throw new Error(`expected raw history, received ${history.format}`);
  }
  const seenIds = new Set<string>();
  let priorCreatedAt = Number.NEGATIVE_INFINITY;
  return history.messages.map((message: HappierRawHistoryRow, postIndex) => {
    const record = asRecord(message);
    const id = nonEmptyString(record?.id);
    const role = nonEmptyString(record?.role)?.toLowerCase();
    const createdAt = record?.createdAt;
    const raw = asRecord(record?.raw);
    const localId = record?.localId === undefined ? undefined : nonEmptyString(record.localId);
    if (!id || !role || typeof createdAt !== "number" || !Number.isFinite(createdAt) || !raw) {
      throw new Error(`invalid raw history row at index ${postIndex}`);
    }
    if (record?.localId !== undefined && !localId) throw new Error(`invalid raw history localId at index ${postIndex}`);
    if (seenIds.has(id)) throw new Error(`duplicate raw history row id ${id}`);
    if (createdAt < priorCreatedAt) throw new Error(`raw history order regressed at row ${id}`);
    seenIds.add(id);
    priorCreatedAt = createdAt;
    const contentType = nonEmptyString(asRecord(raw.content)?.type)?.toLowerCase();
    return {
      id,
      ...(localId ? { localId } : {}),
      createdAt,
      role,
      ...(contentType ? { contentType } : {}),
      text: rawContentText(raw),
      postIndex,
    };
  });
}

function captureHistoryWatermark(history: HappierSessionHistoryResult): HistoryWatermark {
  const rows = parseRawHistoryRows(history);
  const marker = rows.at(-1);
  return {
    rowIds: rows.map((row) => row.id),
    ...(marker ? { markerId: marker.id, markerCreatedAt: marker.createdAt } : {}),
  };
}

function rowsAfterWatermark(
  watermark: HistoryWatermark,
  history: HappierSessionHistoryResult,
): ParsedHistoryRow[] {
  const rows = parseRawHistoryRows(history);
  if (!watermark.markerId) return rows;

  const markerIndex = rows.findIndex((row) => row.id === watermark.markerId);
  if (markerIndex < 0) throw new Error(`pre-send history marker ${watermark.markerId} disappeared`);
  const marker = rows[markerIndex];
  if (marker.createdAt !== watermark.markerCreatedAt) {
    throw new Error(`pre-send history marker ${watermark.markerId} changed timestamp`);
  }

  const preSendIds = new Set(watermark.rowIds);
  const retainedBeforeMarker = rows
    .slice(0, markerIndex + 1)
    .filter((row) => preSendIds.has(row.id))
    .map((row) => row.id);
  if (
    retainedBeforeMarker.length !== watermark.rowIds.length
    || retainedBeforeMarker.some((id, index) => id !== watermark.rowIds[index])
    || rows.slice(markerIndex + 1).some((row) => preSendIds.has(row.id))
  ) {
    throw new Error("bounded raw history no longer preserves pre-send transcript order");
  }

  const added = rows.slice(markerIndex + 1);
  if (added.some((row) => row.createdAt < marker.createdAt)) {
    throw new Error("post-watermark raw history regressed in time");
  }
  return added;
}

function correlatePromptOutput(
  watermark: HistoryWatermark,
  history: HappierSessionHistoryResult,
  localId: string,
): { added: ParsedHistoryRow[]; assistant: ParsedHistoryRow[] } {
  const added = rowsAfterWatermark(watermark, history);
  const matchingUsers = added.filter((row) => row.role === "user" && row.localId === localId);
  if (matchingUsers.length !== 1) {
    throw new Error(`expected one post-watermark user row for localId ${localId}, received ${matchingUsers.length}`);
  }
  const userIndex = matchingUsers[0].postIndex;
  const assistant = added.filter((row) =>
    row.postIndex > userIndex
    && (row.role === "assistant" || row.role === "agent")
    && row.text !== undefined,
  );
  return { added, assistant };
}

function isAmbiguousSendError(error: unknown): boolean {
  return error instanceof HappierCliError && ["timeout", "process", "server", "daemon"].includes(error.code);
}

/*
FNXC:HappierRuntime 2026-07-14-13:02:
Happier currently records Codex and Claude process failures as agent event
rows followed by a ready event. They are failure evidence, not assistant
output, so both normal and ambiguous-send reconciliation must fail closed.
*/
function assertNoProviderProcessFailure(rows: ParsedHistoryRow[], sessionId: string): void {
  const failed = rows.some((row) =>
    row.contentType === "event"
    && typeof row.text === "string"
    && /^(?:Claude|Codex) process error:\s/u.test(row.text),
  );
  if (failed) {
    throw new HappierRecoveryError(
      "provider-process-failed",
      `Happier provider process failed for session ${sessionId}`,
      sessionId,
    );
  }
}

function asHappierSession(session: AgentSession): HappierAgentSession {
  return session as HappierAgentSession;
}

/*
FNXC:HappierRuntime 2026-07-15-21:14:
Executor cancellation awaits session.abort() before dispose(). Track the one
active official CLI operation so both surfaces terminate that operation through
its AbortSignal while preserving the canonical Happier native session ID.
*/
type ManagedHappierSession = HappierAgentSession & {
  needsPersistence: boolean;
  activePrompt?: Promise<void>;
  activePromptController?: AbortController;
  remoteStop?: Promise<void>;
  stopRecoveryPending: boolean;
  stopped: boolean;
  taskTitle: string;
  beforeSpawnSession?: AgentRuntimeOptions["beforeSpawnSession"];
  modelId?: string;
  permissionMode?: HappierRuntimePermissionMode;
  runtimeOptionsApplied: boolean;
  resumeProcess?: HappierResumeProcessLease;
  abort(): Promise<void>;
};

function happierPromptAbortError(): HappierCliError {
  return new HappierCliError("timeout", "Happier CLI invocation aborted");
}

function throwIfPromptAborted(signal: AbortSignal): void {
  if (signal.aborted) throw happierPromptAbortError();
}

function normalizedComparablePath(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isCreateIntentCandidate(
  session: HappierSessionListItem,
  identity: HappierCreateIntentIdentity,
): boolean {
  return session.tag === identity.tag
    && typeof session.path === "string"
    && normalizedComparablePath(session.path) === normalizedComparablePath(identity.cwd)
    && session.agentId === identity.backend
    && (session.archivedAt === undefined || session.archivedAt === null);
}

export class HappierRuntimeAdapter implements AgentRuntime {
  readonly id = "happier";
  readonly name = "Happier Runtime";

  private readonly settings: ReturnType<typeof resolveHappierCliSettings>;
  private readonly backend: HappierBackend;
  private readonly timeoutSeconds: number;
  private readonly createIntentStore: HappierCreateIntentStore;
  private readonly stopStateStore: HappierStopStateStore;
  private readonly dependencies: HappierRuntimeAdapterDependencies;
  constructor(
    settings?: Record<string, unknown> | HappierCliSettings,
    dependencies: Partial<HappierRuntimeAdapterDependencies> = {},
  ) {
    const raw = (settings ?? {}) as Record<string, unknown>;
    this.settings = resolveHappierCliSettings(settings);
    this.backend = resolveHappierBackend(raw);
    const configuredTimeout = this.settings.timeoutSeconds;
    if (
      typeof configuredTimeout !== "number"
      || !Number.isInteger(configuredTimeout)
      || configuredTimeout < 1
      || configuredTimeout > 3_600
    ) {
      throw new HappierCliError(
        "protocol",
        "Happier provider wait timeout must be an integer from 1 through 3600",
        undefined,
        "timeout_hierarchy_invalid",
      );
    }
    this.timeoutSeconds = configuredTimeout;
    const createIntentDirectory = this.settings.createIntentDirectory;
    this.createIntentStore = createHappierCreateIntentStore({
      ...(createIntentDirectory ? { directory: createIntentDirectory } : {}),
    });
    this.stopStateStore = createHappierStopStateStore();
    this.dependencies = { ...defaultRuntimeAdapterDependencies, ...dependencies };
  }

  async createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult> {
    await this.assertCliAttested();
    if (!options.nativeSession) {
      throw new HappierRecoveryError(
        "native-session-binding-missing",
        "Happier runtime requires a canonical Fusion native-session binding",
        "",
      );
    }
    const sessionId = nonEmptyString(options.nativeSession.nativeSessionId) ?? "";
    let session!: ManagedHappierSession;
    session = {
      model: undefined,
      cwd: options.cwd,
      systemPrompt: options.systemPrompt,
      messages: [],
      state: {
        status: sessionId ? "recovering" : "ready",
        messages: [],
      },
      thinkingLevel: options.defaultThinkingLevel,
      sessionId,
      lastModelDescription: this.describeFromSettings(),
      callbacks: {
        onText: options.onText,
        onThinking: options.onThinking,
        onToolStart: options.onToolStart,
        onToolEnd: options.onToolEnd,
      },
      runtimeContext: options.runtimeContext,
      nativeSession: options.nativeSession,
      needsReconciliation: Boolean(sessionId),
      needsPersistence: false,
      stopRecoveryPending: false,
      stopped: false,
      taskTitle: nonEmptyString(options.taskTitle) ?? "Fusion Happier session",
      beforeSpawnSession: options.beforeSpawnSession,
      modelId: resolveHappierRuntimeModelId(options.defaultModelId),
      permissionMode: resolveHappierRuntimePermissionMode(options.tools),
      runtimeOptionsApplied: false,
      abort: async () => {
        session.stopped = true;
        session.activePromptController?.abort();
        await session.activePrompt?.catch(() => undefined);
        if (!session.sessionId) return;
        await this.assertCliAttested();
        /*
         * FNXC:HappierRuntimeRemoteStop 2026-07-27-16:38:
         * Cancellation owns both the long-running official resume process and
         * the remote Session. Do not report completion until the Provider
         * process tree has closed and official stop echoes exact stopped:true.
         */
        session.remoteStop ??= (async () => {
          await this.writeStopState(session, "stop_requested", null);
          const processStopConfirmed = session.resumeProcess
            ? await session.resumeProcess.stop()
            : true;
          let remoteStopError: unknown;
          try {
            await stopHappierSession(session.sessionId, this.settings);
          } catch (error) {
            remoteStopError = error;
          }
          if (processStopConfirmed && remoteStopError === undefined) {
            await this.writeStopState(session, "stopped", null);
            session.state.status = "completed";
            session.state.errorMessage = undefined;
            return;
          }
          session.state.status = "recovering";
          const stopErrorMessage = processStopConfirmed
            ? "Happier did not confirm that the remote session stopped"
            : "Happier did not confirm that the Provider process and remote session stopped";
          session.state.errorMessage = stopErrorMessage;
          await this.writeStopState(session, "recovering", "stop_unconfirmed");
          throw new HappierRecoveryError(
            "stop-unconfirmed",
            stopErrorMessage,
            session.sessionId,
            remoteStopError,
          );
        })();
        await session.remoteStop;
      },
      dispose: () => {
        session.stopped = true;
        session.activePromptController?.abort();
      },
    } as unknown as ManagedHappierSession;
    if (sessionId) {
      const identity = this.buildStopIdentity(session);
      const durableStop = await this.stopStateStore.read(identity.keyHash);
      if (durableStop) {
        const identityMatches = (
          durableStop.happierSessionId === identity.happierSessionId
          && durableStop.serverProfileId === identity.serverProfileId
          && durableStop.machineId === identity.machineId
          && durableStop.providerId === identity.providerId
          && durableStop.providerSessionId === identity.providerSessionId
          && durableStop.canonicalSessionUri === identity.canonicalSessionUri
        );
        if (!identityMatches) {
          throw new HappierRecoveryError(
            "stop-unconfirmed",
            `Happier durable stop identity drifted for session ${sessionId}`,
            sessionId,
          );
        }
        if (durableStop.state === "stop_requested" || durableStop.state === "recovering") {
          session.stopRecoveryPending = true;
          session.state.status = "recovering";
          session.state.errorMessage = "Happier did not confirm that the remote session stopped";
        } else if (durableStop.state === "stopped") {
          session.stopped = true;
          session.state.status = "completed";
        }
      }
    }
    return { session, sessionFile: undefined };
  }

  promptWithFallback(session: AgentSession, prompt: string, _options?: unknown): Promise<void> {
    if (!prompt.trim()) return Promise.reject(new HappierCliError("session", "Happier message is required"));
    const happierSession = asHappierSession(session) as ManagedHappierSession;
    if (happierSession.stopped) return Promise.reject(happierPromptAbortError());
    const queueKey = happierSession.nativeSession.key;
    const prior = bindingQueues.get(queueKey) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(() => this.runPrompt(happierSession, prompt));
    happierSession.activePrompt = current;
    const tail = current.then(() => undefined, () => undefined);
    bindingQueues.set(queueKey, tail);
    return current.finally(() => {
      if (happierSession.activePrompt === current) happierSession.activePrompt = undefined;
      if (bindingQueues.get(queueKey) === tail) bindingQueues.delete(queueKey);
    });
  }

  describeModel(session: AgentSession): string {
    return asHappierSession(session).lastModelDescription || this.describeFromSettings();
  }

  private async runPrompt(
    session: ManagedHappierSession,
    prompt: string,
  ): Promise<void> {
    await this.assertCliAttested();
    if (session.stopped) throw happierPromptAbortError();
    if (session.stopRecoveryPending) {
      throw new HappierRecoveryError(
        "stop-unconfirmed",
        `Happier session ${session.sessionId} remains fenced by an unconfirmed remote stop`,
        session.sessionId,
      );
    }
    const promptController = new AbortController();
    session.activePromptController = promptController;
    const { signal } = promptController;
    let localUserMessageAdded = false;
    try {
      await this.ensureNativeSession(session, signal);
      throwIfPromptAborted(signal);

      if (session.needsReconciliation) {
        await this.reconcilePersistedSession(session, signal);
        session.needsReconciliation = false;
      }

      await this.applyRuntimeOptions(session, signal);

      let watermark: HistoryWatermark;
      try {
        const before = await getHappierSessionHistory(session.sessionId, HISTORY_LIMIT, this.settings, signal);
        watermark = captureHistoryWatermark(before);
      } catch (error) {
        if (signal.aborted) throw error;
        session.state.status = "blocked";
        throw new HappierRecoveryError(
          "history-reconciliation-failed",
          `Unable to capture a trustworthy raw history watermark for Happier session ${session.sessionId}`,
          session.sessionId,
          error,
        );
      }
      session.state.status = "running";
      session.messages.push({ role: "user", content: prompt });
      session.state.messages = session.messages;
      localUserMessageAdded = true;
      const localId = `fusion-${randomUUID()}`;

      try {
        await sendHappierMessage(
          {
            sessionId: session.sessionId,
            message: prompt,
            localId,
            timeoutSeconds: this.timeoutSeconds,
            systemPrompt: session.systemPrompt,
            ...(session.modelId ? { modelId: session.modelId } : {}),
            ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
          },
          this.settings,
          signal,
        );
        const history = await getHappierSessionHistory(session.sessionId, HISTORY_LIMIT, this.settings, signal);
        const status = await getHappierSessionStatus(session.sessionId, this.settings, signal);
        let correlated: ReturnType<typeof correlatePromptOutput>;
        try {
          correlated = correlatePromptOutput(watermark, history, localId);
          if (correlated.assistant.length === 0) {
            throw new Error("successful --wait history contained no correlated assistant text");
          }
        } catch (error) {
          session.state.status = "blocked";
          throw new HappierRecoveryError(
            "history-reconciliation-failed",
            `Unable to correlate Happier output after send for session ${session.sessionId}`,
            session.sessionId,
            error,
          );
        }
        assertNoProviderProcessFailure(correlated.assistant, session.sessionId);
        this.recordAssistantOutput(session, correlated.assistant);
        session.state.status = statusToRuntimeState(status) ?? "ready";
      } catch (error) {
        if (signal.aborted) throw error;
        if (error instanceof HappierCliError && error.code === "protocol") {
          session.state.status = "blocked";
          throw new HappierRecoveryError(
            "history-reconciliation-failed",
            `Happier send response could not be correlated for session ${session.sessionId}`,
            session.sessionId,
            error,
          );
        }
        if (!isAmbiguousSendError(error)) throw error;
        const reconciled = await this.reconcileAmbiguousSend(session, watermark, localId, error, signal);
        assertNoProviderProcessFailure(reconciled.added, session.sessionId);
        this.recordAssistantOutput(session, reconciled.added);
        session.state.status = statusToRuntimeState(reconciled.status) ?? "ready";
      }

      session.state.errorMessage = undefined;
    } catch (error) {
      if (localUserMessageAdded) session.messages.pop();
      session.state.messages = session.messages;
      session.state.errorMessage = error instanceof Error ? error.message : String(error);
      if (error instanceof HappierRecoveryError) {
        if (session.state.status !== "blocked") {
          session.state.status = error.code === "status-check-failed" ? "recovering" : "blocked";
        }
      } else {
        session.state.status = "failed";
      }
      throw error;
    } finally {
      if (session.activePromptController === promptController) session.activePromptController = undefined;
    }
  }

  private async assertCliAttested(): Promise<void> {
    const attestation = await this.dependencies.attestCli(this.settings);
    if (!attestation.ok) {
      throw new HappierCliError(
        "process",
        "Happier CLI supply-chain attestation failed closed",
        undefined,
        attestation.reasonCode,
      );
    }
  }

  /**
   * FNXC:HappierRuntimeVisibleOptions 2026-07-27-16:19:
   * Configure every operator-visible runtime option before the first task
   * message. Mark the group applied only after all official controls confirm
   * the exact Session, so partial failures never silently degrade permissions.
   */
  private async applyRuntimeOptions(
    session: ManagedHappierSession,
    signal: AbortSignal,
  ): Promise<void> {
    if (session.runtimeOptionsApplied) return;
    await setHappierSessionTitle(
      session.sessionId,
      session.taskTitle,
      this.settings,
      signal,
    );
    if (session.modelId) {
      await setHappierSessionModel(
        session.sessionId,
        session.modelId,
        this.settings,
        signal,
      );
    }
    if (session.permissionMode) {
      await setHappierSessionPermissionMode(
        session.sessionId,
        session.permissionMode,
        this.settings,
        signal,
      );
    }
    session.runtimeOptionsApplied = true;
  }

  private async ensureNativeSession(
    session: ManagedHappierSession,
    signal: AbortSignal,
  ): Promise<void> {
    const createIdentity = buildHappierCreateIntentIdentity({
      bindingKey: session.nativeSession.key,
      cwd: session.cwd,
      backend: this.backend,
    });
    let intent: HappierCreateIntentRecord | null;
    try {
      intent = await this.createIntentStore.read(createIdentity.keyHash);
      if (intent && (
        intent.tag !== createIdentity.tag
        || intent.cwd !== createIdentity.cwd
        || intent.backend !== createIdentity.backend
      )) {
        throw new Error("Happier create intent identity does not match the runtime binding");
      }
    } catch (error) {
      session.state.status = "blocked";
      throw new HappierRecoveryError(
        "create-intent-recovery-failed",
        "Unable to validate the durable Happier create intent",
        session.sessionId,
        error,
      );
    }

    let persisted: string | null;
    try {
      persisted = await session.nativeSession.refreshNativeSessionId();
    } catch (error) {
      session.state.status = "blocked";
      throw new HappierRecoveryError(
        "native-session-persistence-failed",
        "Unable to refresh the canonical Fusion native session id",
        session.sessionId,
        error,
      );
    }
    if (persisted) {
      if (intent?.cleanupSessionIds.length) {
        const failedCleanup = await this.archiveCreateCandidates(intent.cleanupSessionIds, persisted);
        await this.writeCreateIntent(
          createIdentity,
          failedCleanup.length > 0 ? "cleanup_required" : "claimed",
          intent.candidateSessionIds,
          persisted,
          failedCleanup,
        );
        if (failedCleanup.length > 0) {
          session.state.status = "blocked";
          throw new HappierRecoveryError(
            "orphan-cleanup-failed",
            "Unable to finish Happier orphan cleanup for the canonical native session",
            persisted,
          );
        }
      }
      const learnedPersistedId = !session.sessionId;
      if (session.sessionId && session.sessionId !== persisted) {
        session.state.status = "blocked";
        throw new HappierRecoveryError(
          "native-session-persistence-failed",
          `Canonical native session changed from ${session.sessionId} to ${persisted}`,
          session.sessionId,
        );
      }
      session.sessionId = persisted;
      session.nativeSession.nativeSessionId = persisted;
      session.needsPersistence = false;
      if (learnedPersistedId) session.needsReconciliation = true;
      return;
    }

    session.state.status = "starting";
    const mayCreate = intent === null || intent.state === "cleaned";
    if (mayCreate) {
      intent = await this.writeCreateIntent(
        createIdentity,
        "pending_create",
        [],
        null,
        [],
      );
    }

    let listed: Awaited<ReturnType<typeof listHappierSessions>>;
    try {
      listed = await listHappierSessions(this.settings, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      session.state.status = "recovering";
      throw new HappierRecoveryError(
        "create-intent-recovery-failed",
        "Unable to reconcile the durable Happier create intent against remote sessions",
        "",
        error,
      );
    }
    const candidates = listed.sessions
      .filter((candidate) => isCreateIntentCandidate(candidate, createIdentity))
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    const recoveredCandidateIds = candidates.map((candidate) => candidate.id);
    let createdInThisAttempt = false;
    if (candidates.length === 0) {
      if (!mayCreate) {
        session.state.status = "recovering";
        throw new HappierRecoveryError(
          "create-intent-recovery-failed",
          "A prior Happier create intent has no exact remote candidate yet; duplicate create is blocked",
          intent?.canonicalSessionId ?? "",
        );
      }
      /*
       * FNXC:HappierBeforeSpawnSession 2026-07-27-16:13:
       * Fire the caller's pause/abort gate after durable intent and complete
       * remote-list reconciliation. Only a synchronous abort check remains
       * between this hook and the official remote create operation.
       */
      await session.beforeSpawnSession?.();
      throwIfPromptAborted(signal);
      const created = await createHappierSession(
        {
          cwd: createIdentity.cwd,
          backend: this.backend,
          title: session.taskTitle,
          tag: createIdentity.tag,
        },
        this.settings,
        signal,
      );
      candidates.push({
        id: created.sessionId,
        createdAt: Number.MAX_SAFE_INTEGER,
        updatedAt: Number.MAX_SAFE_INTEGER,
        active: true,
        archivedAt: null,
        tag: createIdentity.tag,
        path: createIdentity.cwd,
        agentId: createIdentity.backend,
      });
      createdInThisAttempt = true;
      intent = await this.writeCreateIntent(
        createIdentity,
        "candidate_observed",
        [created.sessionId],
        null,
        [],
      );
    } else {
      intent = await this.writeCreateIntent(
        createIdentity,
        "candidate_observed",
        recoveredCandidateIds,
        null,
        [],
      );
    }

    const candidateIds = candidates.map((candidate) => candidate.id);
    if (signal.aborted) {
      const failedCleanup = await this.archiveCreateCandidates(candidateIds, null);
      await this.writeCreateIntent(
        createIdentity,
        failedCleanup.length > 0 ? "cleanup_required" : "cleaned",
        candidateIds,
        null,
        failedCleanup,
      );
      throwIfPromptAborted(signal);
    }

    const selected = candidates[0]!;
    let claim: { claimed: boolean; nativeSessionId: string };
    try {
      claim = await session.nativeSession.claimNativeSessionId(selected.id);
    } catch (error) {
      const failedCleanup = await this.archiveCreateCandidates(candidateIds, null);
      await this.writeCreateIntent(
        createIdentity,
        failedCleanup.length > 0 ? "cleanup_required" : "cleaned",
        candidateIds,
        null,
        failedCleanup,
      );
      session.state.status = "blocked";
      if (failedCleanup.length > 0) {
        throw new HappierRecoveryError(
          "orphan-cleanup-failed",
          `Unable to atomically claim or clean up Happier session ${selected.id}`,
          selected.id,
          { claimError: error, failedCleanup },
        );
      }
      throw new HappierRecoveryError(
        "native-session-persistence-failed",
        `Unable to atomically claim Happier session ${selected.id}; orphan cleanup completed`,
        selected.id,
        error,
      );
    }
    const failedCleanup = await this.archiveCreateCandidates(candidateIds, claim.nativeSessionId);
    await this.writeCreateIntent(
      createIdentity,
      failedCleanup.length > 0 ? "cleanup_required" : "claimed",
      candidateIds,
      claim.nativeSessionId,
      failedCleanup,
    );
    if (failedCleanup.length > 0) {
      session.state.status = "blocked";
      throw new HappierRecoveryError(
        "orphan-cleanup-failed",
        `Canonical Happier session ${claim.nativeSessionId} was claimed but orphan cleanup is incomplete`,
        claim.nativeSessionId,
        { failedCleanup },
      );
    }
    session.needsReconciliation = !createdInThisAttempt || !claim.claimed;
    session.sessionId = claim.nativeSessionId;
    session.nativeSession.nativeSessionId = claim.nativeSessionId;
    session.needsPersistence = false;
  }

  private async writeCreateIntent(
    identity: HappierCreateIntentIdentity,
    state: HappierCreateIntentState,
    candidateSessionIds: readonly string[],
    canonicalSessionId: string | null,
    cleanupSessionIds: readonly string[],
  ): Promise<HappierCreateIntentRecord> {
    const record: HappierCreateIntentRecord = {
      contractVersion: 1,
      ...identity,
      state,
      candidateSessionIds: [...new Set(candidateSessionIds)].sort(),
      canonicalSessionId,
      cleanupSessionIds: [...new Set(cleanupSessionIds)].sort(),
      updatedAt: new Date().toISOString(),
    };
    try {
      await this.createIntentStore.write(record);
      return record;
    } catch (error) {
      throw new HappierRecoveryError(
        "create-intent-recovery-failed",
        "Unable to persist the durable Happier create intent",
        canonicalSessionId ?? candidateSessionIds[0] ?? "",
        error,
      );
    }
  }

  private async archiveCreateCandidates(
    candidateSessionIds: readonly string[],
    canonicalSessionId: string | null,
  ): Promise<readonly string[]> {
    const failed: string[] = [];
    for (const candidateSessionId of [...new Set(candidateSessionIds)].sort()) {
      if (candidateSessionId === canonicalSessionId) continue;
      try {
        await archiveHappierSession(candidateSessionId, this.settings);
      } catch {
        failed.push(candidateSessionId);
      }
    }
    return failed;
  }

  /**
   * FNXC:HappierStopStateDurability 2026-07-27-16:05:
   * Persist the exact known server/machine/provider/native-thread tuple around
   * every remote stop. Unknown identity fields remain explicit nulls; a
   * configured direct-session binding is never reduced to a bare Session id.
   */
  private async writeStopState(
    session: HappierAgentSession,
    state: HappierStopState,
    reasonCode: HappierStopReasonCode,
  ): Promise<void> {
    const identity = this.buildStopIdentity(session);
    await this.stopStateStore.write({
      contractVersion: 1,
      ...identity,
      state,
      reasonCode,
      updatedAt: new Date().toISOString(),
    });
  }

  private buildStopIdentity(session: HappierAgentSession) {
    const matchingBindings = (this.settings.happierSessionBindings ?? [])
      .filter((binding) => binding.happierSessionId === session.sessionId);
    if (matchingBindings.length > 1) {
      throw new HappierRecoveryError(
        "stop-unconfirmed",
        `Happier stop identity is ambiguous for session ${session.sessionId}`,
        session.sessionId,
      );
    }
    return buildHappierStopIdentity({
      bindingKey: session.nativeSession.key,
      happierSessionId: session.sessionId,
      backend: this.backend,
      ...(matchingBindings[0] ? { binding: matchingBindings[0] } : {}),
    });
  }

  private async reconcilePersistedSession(session: ManagedHappierSession, signal: AbortSignal): Promise<void> {
    session.state.status = "recovering";
    try {
      const status = await getHappierSessionStatus(session.sessionId, this.settings, signal);
      if (status.session.active === true) return;
      if (status.session.active !== false || !statusAllowsResumeAttempt(status)) {
        session.state.status = "blocked";
        throw new HappierRecoveryError(
          "session-not-resumable",
          `Happier session ${session.sessionId} is not resumable`,
          session.sessionId,
        );
      }
      /*
       * FNXC:HappierStrictResume 2026-07-27-16:38:
       * A persisted inactive Session is never replaced. Resume the exact
       * official Happier id and re-read the full Fusion binding after active
       * status proves the canonical Session, machine, and Provider thread did
       * not drift.
       */
      const expectedIdentity = this.buildStopIdentity(session);
      session.resumeProcess = await resumeHappierSessionStrictly({
        expectedIdentity,
        settings: this.settings,
        signal,
        readCurrentIdentity: async () => this.buildStopIdentity(session),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof HappierRecoveryError) throw error;
      const strictResumeFailure = error instanceof HappierCliError
        && error.officialCode?.startsWith("resume_");
      const code = error instanceof HappierCliError
        && error.code === "session"
        && !strictResumeFailure
        ? "session-missing"
        : "status-check-failed";
      session.state.status = code === "session-missing" ? "blocked" : "recovering";
      throw new HappierRecoveryError(
        code,
        `Unable to reconcile Happier session ${session.sessionId}`,
        session.sessionId,
        error,
      );
    }
  }

  private async reconcileAmbiguousSend(
    session: HappierAgentSession,
    watermark: HistoryWatermark,
    localId: string,
    originalError: unknown,
    signal: AbortSignal,
  ): Promise<HistoryReconciliation> {
    try {
      const status = await getHappierSessionStatus(session.sessionId, this.settings, signal);
      const history = await getHappierSessionHistory(session.sessionId, HISTORY_LIMIT, this.settings, signal);
      const correlated = correlatePromptOutput(watermark, history, localId);
      return { status, history, added: correlated.assistant };
    } catch (error) {
      if (error instanceof HappierRecoveryError) throw error;
      throw new HappierRecoveryError(
        "ambiguous-send-unresolved",
        `Happier send outcome is ambiguous for session ${session.sessionId}`,
        session.sessionId,
        { originalError, reconciliationError: error },
      );
    }
  }

  private recordAssistantOutput(
    session: HappierAgentSession,
    assistantMessages: ParsedHistoryRow[],
  ): void {
    for (const message of assistantMessages) {
      session.messages.push({ role: "assistant", content: message.text });
      session.callbacks.onText?.(message.text!);
    }
    session.state.messages = session.messages;
  }

  private describeFromSettings(): string {
    return `happier/${this.backend}`;
  }
}

export type { HappierRuntimeState } from "./types.js";

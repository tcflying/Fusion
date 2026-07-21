import {
  AsyncCliSessionStore,
  type AsyncDataLayer,
  type CliAutonomyPosture,
  type CliSession,
  type CliSessionUpdateInput,
  type TaskStore,
} from "@fusion/core";
import {
  createTaskStoreNativeSessionBinding,
  resolveTaskHappierCliSessionId,
} from "./agent-runtime.js";

export { resolveTaskHappierCliSessionId };

export type HappierDirectSessionProviderId = "codex" | "claude" | "opencode";

export type HappierDirectSessionEnsureMetadata = {
  sessionId: string;
  providerId: HappierDirectSessionProviderId;
  remoteSessionId: string;
  machineId: string;
  serverId: string;
  openUrl?: string | null;
};

export type TaskHappierDirectSessionBinding = {
  cliSessionId: string;
  providerId: HappierDirectSessionProviderId;
  nativeSessionId: string;
  happierSessionId: string;
  machineId: string;
  serverProfileId: string;
  linkedAt: string;
};

type PersistedTaskHappierDirectSessionBindingV2 = TaskHappierDirectSessionBinding & {
  schemaVersion: 2;
};

export type Store = Pick<TaskStore, "getFusionDir" | "getDatabase" | "getAsyncLayer">;

export class TaskHappierDirectSessionConflictError extends Error {
  readonly code = "HAPPIER_DIRECT_SESSION_CONFLICT";

  constructor(
    readonly taskId: string,
    readonly cliSessionId: string,
    readonly existingHappierSessionId: string,
    readonly requestedHappierSessionId: string,
  ) {
    super(
      `Task ${taskId} Happier CLI session ${cliSessionId} already belongs to Happier Session ${existingHappierSessionId}; cannot bind ${requestedHappierSessionId}`,
    );
    this.name = "TaskHappierDirectSessionConflictError";
  }
}

export class TaskHappierDirectSessionIntegrityError extends Error {
  readonly code = "HAPPIER_DIRECT_SESSION_INTEGRITY";

  constructor(
    readonly taskId: string,
    readonly cliSessionId: string,
    readonly cliHappierSessionId: string,
    readonly metadataHappierSessionId: string,
  ) {
    super(
      `Task ${taskId} Happier CLI session ${cliSessionId} has Happier Session ${cliHappierSessionId}, but connected metadata names ${metadataHappierSessionId}`,
    );
    this.name = "TaskHappierDirectSessionIntegrityError";
  }
}

type SessionStore = AsyncCliSessionStore;

function resolveSessionStore(store: Store): SessionStore {
  const asyncLayer = store.getAsyncLayer();
  if (!asyncLayer) {
    throw new Error("Happier direct session binding requires the TaskStore PostgreSQL AsyncDataLayer");
  }
  return new AsyncCliSessionStore(asyncLayer);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isProviderId(value: unknown): value is HappierDirectSessionProviderId {
  return value === "codex" || value === "claude" || value === "opencode";
}

function parsePersistedBinding(
  value: unknown,
  expectedCliSessionId: string,
): TaskHappierDirectSessionBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.cliSessionId !== expectedCliSessionId
    || !isProviderId(candidate.providerId)
    || !isNonEmptyString(candidate.machineId)
    || !isNonEmptyString(candidate.linkedAt)
    || !Number.isFinite(Date.parse(candidate.linkedAt))
  ) {
    return null;
  }
  if (candidate.schemaVersion !== undefined) {
    if (
      candidate.schemaVersion === 2
      && isNonEmptyString(candidate.nativeSessionId)
      && isNonEmptyString(candidate.happierSessionId)
      && isNonEmptyString(candidate.serverProfileId)
    ) {
      return {
        cliSessionId: expectedCliSessionId,
        providerId: candidate.providerId,
        nativeSessionId: candidate.nativeSessionId,
        happierSessionId: candidate.happierSessionId,
        machineId: candidate.machineId,
        serverProfileId: candidate.serverProfileId,
        linkedAt: candidate.linkedAt,
      };
    }
    return null;
  }
  if (
    isNonEmptyString(candidate.nativeSessionId)
    && isNonEmptyString(candidate.remoteSessionId)
    && isNonEmptyString(candidate.serverId)
  ) {
    return {
      cliSessionId: expectedCliSessionId,
      providerId: candidate.providerId,
      nativeSessionId: candidate.remoteSessionId,
      happierSessionId: candidate.nativeSessionId,
      machineId: candidate.machineId,
      serverProfileId: candidate.serverId,
      linkedAt: candidate.linkedAt,
    };
  }
  return null;
}

function bindingFromSession(input: {
  taskId: string;
  cliSessionId: string;
  session: CliSession | undefined;
}): TaskHappierDirectSessionBinding | null {
  const { session } = input;
  if (!session) return null;
  const persisted = parsePersistedBinding(
    session.autonomyPosture?.happierDirectSession,
    input.cliSessionId,
  );
  if (!persisted || !session.nativeSessionId) return null;
  if (session.nativeSessionId !== persisted.happierSessionId) {
    throw new TaskHappierDirectSessionIntegrityError(
      input.taskId,
      input.cliSessionId,
      session.nativeSessionId,
      persisted.happierSessionId,
    );
  }
  return persisted;
}

const SERIALIZABLE_TRANSACTION_ATTEMPTS = 3;

function isSerializationFailure(error: unknown): boolean {
  let candidate = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!candidate || typeof candidate !== "object") return false;
    if ((candidate as { code?: unknown }).code === "40001") return true;
    candidate = (candidate as { cause?: unknown }).cause;
  }
  return false;
}

async function withSerializableRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= SERIALIZABLE_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isSerializationFailure(error) || attempt === SERIALIZABLE_TRANSACTION_ATTEMPTS) {
        throw error;
      }
    }
  }
  throw new Error("Unreachable serializable transaction retry state");
}

function existingBindingForEnsure(input: {
  taskId: string;
  cliSessionId: string;
  session: CliSession | undefined;
  ensuredHappierSessionId: string;
}): TaskHappierDirectSessionBinding | null {
  const existing = bindingFromSession(input);
  if (existing && existing.happierSessionId !== input.ensuredHappierSessionId) {
    throw new TaskHappierDirectSessionConflictError(
      input.taskId,
      input.cliSessionId,
      existing.happierSessionId,
      input.ensuredHappierSessionId,
    );
  }
  return existing;
}

function createConnectedBinding(input: {
  cliSessionId: string;
  happierSessionId: string;
  ensured: HappierDirectSessionEnsureMetadata;
}): TaskHappierDirectSessionBinding {
  return {
    cliSessionId: input.cliSessionId,
    providerId: input.ensured.providerId,
    nativeSessionId: input.ensured.remoteSessionId,
    happierSessionId: input.happierSessionId,
    machineId: input.ensured.machineId,
    serverProfileId: input.ensured.serverId,
    linkedAt: new Date().toISOString(),
  };
}

function persistedBinding(binding: TaskHappierDirectSessionBinding): PersistedTaskHappierDirectSessionBindingV2 {
  return { schemaVersion: 2, ...binding };
}

function assertClaimedHappierSession(input: {
  taskId: string;
  cliSessionId: string;
  claimedHappierSessionId: string;
  ensuredHappierSessionId: string;
}): void {
  if (input.claimedHappierSessionId === input.ensuredHappierSessionId) return;
  throw new TaskHappierDirectSessionConflictError(
    input.taskId,
    input.cliSessionId,
    input.claimedHappierSessionId,
    input.ensuredHappierSessionId,
  );
}

async function bindAsyncTransaction(input: {
  sessionStore: AsyncCliSessionStore;
  taskId: string;
  cliSessionId: string;
  ensured: HappierDirectSessionEnsureMetadata;
}): Promise<TaskHappierDirectSessionBinding> {
  const currentSession = await input.sessionStore.getSession(input.cliSessionId);
  if (!currentSession) throw new Error(`CLI session not found: ${input.cliSessionId}`);
  const currentBinding = existingBindingForEnsure({
    ...input,
    session: currentSession,
    ensuredHappierSessionId: input.ensured.sessionId,
  });
  if (currentBinding) return currentBinding;

  const claim = await input.sessionStore.claimNativeSessionId(
    input.cliSessionId,
    input.ensured.sessionId,
  );
  if (!claim) throw new Error(`CLI session not found during native-session claim: ${input.cliSessionId}`);
  assertClaimedHappierSession({
    ...input,
    claimedHappierSessionId: claim.nativeSessionId,
    ensuredHappierSessionId: input.ensured.sessionId,
  });

  const latestSession = await input.sessionStore.getSession(input.cliSessionId);
  if (!latestSession) throw new Error(`CLI session not found after native-session claim: ${input.cliSessionId}`);
  const existingAfterClaim = existingBindingForEnsure({
    ...input,
    session: latestSession,
    ensuredHappierSessionId: input.ensured.sessionId,
  });
  if (existingAfterClaim) return existingAfterClaim;

  const binding = createConnectedBinding({
    cliSessionId: input.cliSessionId,
    happierSessionId: claim.nativeSessionId,
    ensured: input.ensured,
  });
  const autonomyPosture: CliAutonomyPosture = {
    ...(latestSession.autonomyPosture ?? {}),
    happierDirectSession: persistedBinding(binding),
  };
  const updated = await input.sessionStore.updateSession(input.cliSessionId, { autonomyPosture });
  if (!updated) throw new Error(`CLI session not found while linking Happier metadata: ${input.cliSessionId}`);
  return binding;
}

async function bindWithDatabaseSerialization(input: {
  store: Store;
  taskId: string;
  cliSessionId: string;
  ensured: HappierDirectSessionEnsureMetadata;
}): Promise<TaskHappierDirectSessionBinding> {
  const asyncLayer = input.store.getAsyncLayer();
  if (asyncLayer) {
    return withSerializableRetry(() => asyncLayer.transactionImmediate(
      async (transaction) => bindAsyncTransaction({
        ...input,
        sessionStore: new AsyncCliSessionStore({
          db: transaction as unknown as AsyncDataLayer["db"],
        }),
      }),
      { isolationLevel: "serializable" },
    ));
  }

  throw new Error("Happier direct session binding requires the TaskStore PostgreSQL AsyncDataLayer");
}

export async function readTaskHappierDirectSessionBinding(input: {
  store: Store;
  taskId: string;
}): Promise<TaskHappierDirectSessionBinding | null> {
  const cliSessionId = resolveTaskHappierCliSessionId({
    taskId: input.taskId,
    purpose: "execute",
  });
  const session = await resolveSessionStore(input.store).getSession(cliSessionId);
  return bindingFromSession({ taskId: input.taskId, cliSessionId, session });
}

export async function bindTaskHappierDirectSession(input: {
  store: Store;
  taskId: string;
  worktreePath?: string | null;
  ensured: HappierDirectSessionEnsureMetadata;
}): Promise<TaskHappierDirectSessionBinding> {
  const cliSessionId = resolveTaskHappierCliSessionId({
    taskId: input.taskId,
    purpose: "execute",
  });

  const nativeBinding = await createTaskStoreNativeSessionBinding({
    runtimeHint: "happier",
    taskStore: input.store,
    sessionKey: `executor:${input.taskId}:primary`,
    taskId: input.taskId,
    purpose: "execute",
    worktreePath: input.worktreePath,
  });
  if (!nativeBinding) throw new Error("Happier native-session binding was not created");

  return bindWithDatabaseSerialization({
    store: input.store,
    taskId: input.taskId,
    cliSessionId,
    ensured: input.ensured,
  });
}

import {
  AgentStore,
  AsyncCliSessionStore,
  HAPPIER_RUNTIME_PLUGIN_ID,
  type Agent,
  type Task,
  type TaskStore,
} from "@fusion/core";
import {
  bindTaskHappierDirectSession,
  readTaskHappierDirectSessionBinding,
  resolveTaskHappierCliSessionId,
  TaskHappierDirectSessionConflictError,
  TaskHappierDirectSessionIntegrityError,
  type TaskHappierDirectSessionBinding,
} from "@fusion/engine";
import {
  buildHappierSessionOpenUrl,
  ensureHappierDirectSession,
  type HappierCliSettings,
  type HappierDirectSessionEnsureResult,
} from "@fusion-plugin-examples/happier-runtime";
import { ApiError, badRequest } from "../api-error.js";
import type { ApiRoutesContext } from "./types.js";

export const HAPPIER_BRIDGE_AGENT_NAME = "Happier Session Bridge";
export const HAPPIER_BRIDGE_RUNTIME_CONFIG = Object.freeze({
  runtimeHint: "happier",
  assignmentPolicy: "explicit-only",
  allowParallelExecution: true,
  autoClaimRelevantTasks: false,
});

type BridgeAssignmentResult = { agentId: string };
type BridgeAgentStore = Pick<
  AgentStore,
  "findAgentByName" | "createAgentWithExactRuntimeConfig" | "assignTask"
>;

export interface HappierDirectSessionRouteDependencies {
  ensureHappierDirectSession?: typeof ensureHappierDirectSession;
  readTaskHappierDirectSessionBinding?: typeof readTaskHappierDirectSessionBinding;
  bindTaskHappierDirectSession?: typeof bindTaskHappierDirectSession;
  buildHappierSessionOpenUrl?: typeof buildHappierSessionOpenUrl;
  assignTaskToBridge?: (input: { store: TaskStore; taskId: string }) => Promise<BridgeAssignmentResult>;
  createAgentStore?: (store: TaskStore) => Promise<BridgeAgentStore>;
}

class HappierBridgeAgentConflictError extends Error {
  constructor(readonly agent: Agent) {
    super(`Agent "${HAPPIER_BRIDGE_AGENT_NAME}" has an incompatible role or runtime configuration`);
    this.name = "HappierBridgeAgentConflictError";
  }
}

/*
FNXC:HappierTaskBinding 2026-07-15-21:00:
Connecting a task is a binding-only operation: require a paused non-terminal task, use the project-scoped persisted Happier settings, claim the native session before agent assignment, and never start execution, create a worktree, send a prompt, or move workflow state.

FNXC:HappierTaskBinding 2026-07-15-21:00:
The project-local bridge identity is operator-visible and reusable. Its runtime configuration is an exact four-key contract; a same-name agent with any different configuration is user-owned and must be reported as a conflict instead of rewritten.
*/

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isExactBridgeRuntimeConfig(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const expected = HAPPIER_BRIDGE_RUNTIME_CONFIG as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index] && value[key] === expected[key]);
}

function isCompatibleBridgeAgent(agent: Agent): boolean {
  return agent.role === "executor" && isExactBridgeRuntimeConfig(agent.runtimeConfig);
}

async function createOrFindBridgeAgent(agentStore: BridgeAgentStore): Promise<Agent> {
  const existing = await agentStore.findAgentByName(HAPPIER_BRIDGE_AGENT_NAME);
  if (existing) {
    if (!isCompatibleBridgeAgent(existing)) {
      throw new HappierBridgeAgentConflictError(existing);
    }
    return existing;
  }

  try {
    return await agentStore.createAgentWithExactRuntimeConfig({
      name: HAPPIER_BRIDGE_AGENT_NAME,
      role: "executor",
      runtimeConfig: { ...HAPPIER_BRIDGE_RUNTIME_CONFIG },
    });
  } catch (error) {
    const raced = await agentStore.findAgentByName(HAPPIER_BRIDGE_AGENT_NAME);
    if (!raced) throw error;
    if (!isCompatibleBridgeAgent(raced)) {
      throw new HappierBridgeAgentConflictError(raced);
    }
    return raced;
  }
}

async function createProjectAgentStore(store: TaskStore): Promise<BridgeAgentStore> {
  const agentStore = new AgentStore({
    rootDir: store.getFusionDir(),
    taskStore: store,
    asyncLayer: store.getAsyncLayer() ?? undefined,
  });
  await agentStore.init();
  return agentStore;
}

async function assignTaskToBridge(
  input: { store: TaskStore; taskId: string },
  createAgentStore: (store: TaskStore) => Promise<BridgeAgentStore> = createProjectAgentStore,
): Promise<BridgeAssignmentResult> {
  const agentStore = await createAgentStore(input.store);
  const agent = await createOrFindBridgeAgent(agentStore);
  await agentStore.assignTask(agent.id, input.taskId);
  await input.store.updateTask(input.taskId, { assignedAgentId: agent.id });
  return { agentId: agent.id };
}

async function getLiveTask(store: TaskStore, taskId: string): Promise<Task> {
  try {
    return await store.getTask(taskId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT" || /not found/iu.test(message)) {
      throw new ApiError(404, `Task ${taskId} not found`, { code: "TASK_NOT_FOUND", taskId });
    }
    throw error;
  }
}

function assertConnectableTask(task: Task): void {
  const blockedColumn = task.column === "done"
    || task.column === "archived"
    || task.column === "in-progress"
    || task.column === "in-review";
  const paused = task.paused === true || task.userPaused === true;
  if (blockedColumn || !paused) {
    throw new ApiError(409, `Task ${task.id} must be paused and non-terminal before connecting Happier`, {
      code: "HAPPIER_TASK_NOT_CONNECTABLE",
      taskId: task.id,
      column: task.column,
      paused,
    });
  }
}

async function resolveHappierSettings(store: TaskStore): Promise<HappierCliSettings & { webappUrl: string }> {
  let plugin;
  try {
    plugin = await store.getPluginStore().getPlugin(HAPPIER_RUNTIME_PLUGIN_ID);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") throw error;
    throw new ApiError(409, "Happier runtime plugin is not installed for this project", {
      code: "HAPPIER_PLUGIN_NOT_CONFIGURED",
    });
  }
  const settings = plugin.settings as HappierCliSettings;
  if (typeof settings.webappUrl !== "string" || settings.webappUrl.trim().length === 0) {
    throw new ApiError(409, "Happier Web URL is not configured", {
      code: "HAPPIER_WEBAPP_URL_NOT_CONFIGURED",
    });
  }
  return { ...settings, webappUrl: settings.webappUrl.trim() };
}

function assertHappierOpenUrlConfiguration(
  webappUrl: string,
  buildOpenUrl: typeof buildHappierSessionOpenUrl,
): void {
  try {
    buildOpenUrl(webappUrl, "configuration-probe-server", "configuration-probe-session");
  } catch {
    throw new ApiError(409, "Happier Web URL is invalid or unsafe", {
      code: "HAPPIER_WEBAPP_URL_INVALID",
    });
  }
}

async function hasPersistedBindingMetadata(store: TaskStore, taskId: string): Promise<boolean> {
  const cliSessionId = resolveTaskHappierCliSessionId({ taskId, purpose: "execute" });
  const asyncLayer = store.getAsyncLayer();
  if (!asyncLayer) return false;
  const session = await new AsyncCliSessionStore(asyncLayer).getSession(cliSessionId);
  return isRecord(session?.autonomyPosture)
    && Object.prototype.hasOwnProperty.call(session.autonomyPosture, "happierDirectSession");
}

function integrityApiError(taskId: string, message: string): ApiError {
  return new ApiError(409, message, {
    code: "HAPPIER_DIRECT_SESSION_INTEGRITY",
    taskId,
  });
}

async function readBindingOrThrowIntegrity(input: {
  store: TaskStore;
  taskId: string;
  readBinding: typeof readTaskHappierDirectSessionBinding;
}): Promise<TaskHappierDirectSessionBinding | null> {
  try {
    const binding = await input.readBinding({ store: input.store, taskId: input.taskId });
    if (!binding && await hasPersistedBindingMetadata(input.store, input.taskId)) {
      throw integrityApiError(input.taskId, `Task ${input.taskId} has malformed Happier direct-session metadata`);
    }
    return binding;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof TaskHappierDirectSessionIntegrityError) {
      throw integrityApiError(input.taskId, error.message);
    }
    throw error;
  }
}

function connectedResponse(input: {
  taskId: string;
  binding: TaskHappierDirectSessionBinding;
  webappUrl: string;
  buildOpenUrl: typeof buildHappierSessionOpenUrl;
  created?: boolean;
  agentId?: string;
}) {
  const { sourceSessionUri: _sourceSessionUri, ...publicBinding } = input.binding;
  return {
    connected: true,
    taskId: input.taskId,
    ...publicBinding,
    openUrl: input.buildOpenUrl(
      input.webappUrl,
      input.binding.serverProfileId,
      input.binding.happierSessionId,
    ),
    ...(input.created !== undefined ? { created: input.created } : {}),
    ...(input.agentId !== undefined ? { agentId: input.agentId } : {}),
  };
}

function canonicalSessionUriForBinding(binding: TaskHappierDirectSessionBinding): string {
  if (binding.sourceSessionUri) return binding.sourceSessionUri;
  const host = binding.providerId === "codex" ? "threads" : "sessions";
  return `${binding.providerId}://${host}/${encodeURIComponent(binding.nativeSessionId)}`;
}

function assertExistingBindingMatchesRequest(input: {
  taskId: string;
  binding: TaskHappierDirectSessionBinding;
  uri: string;
  machineId?: string;
}): void {
  if (input.uri !== canonicalSessionUriForBinding(input.binding)) {
    throw new ApiError(409, `Task ${input.taskId} is already connected to a different native Session`, {
      code: "HAPPIER_DIRECT_SESSION_CONFLICT",
      taskId: input.taskId,
      existingNativeSessionId: input.binding.nativeSessionId,
      requestedSessionUri: input.uri,
    });
  }
  if (input.machineId !== undefined && input.machineId !== input.binding.machineId) {
    throw new ApiError(409, `Task ${input.taskId} is connected through a different Happier machine`, {
      code: "machine_mismatch",
      taskId: input.taskId,
      existingMachineId: input.binding.machineId,
      requestedMachineId: input.machineId,
    });
  }
}

const CLI_ERROR_STATUS: Readonly<Record<string, number>> = {
  daemon_unavailable: 503,
  auth_required: 401,
  candidate_not_found: 404,
  candidate_ambiguous: 409,
  machine_mismatch: 409,
};

function mapPreBindingError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof TaskHappierDirectSessionConflictError) {
    throw new ApiError(409, error.message, {
      code: error.code,
      taskId: error.taskId,
      cliSessionId: error.cliSessionId,
      existingHappierSessionId: error.existingHappierSessionId,
      requestedHappierSessionId: error.requestedHappierSessionId,
    });
  }
  if (error instanceof TaskHappierDirectSessionIntegrityError) {
    throw integrityApiError(error.taskId, error.message);
  }
  const officialCode = isRecord(error) && typeof error.officialCode === "string"
    ? error.officialCode
    : undefined;
  if (officialCode) {
    throw new ApiError(CLI_ERROR_STATUS[officialCode] ?? 502, error instanceof Error ? error.message : officialCode, {
      code: officialCode,
    });
  }
  throw error;
}

function assignmentFailure(error: unknown, binding: TaskHappierDirectSessionBinding): ApiError {
  const bindingDetails = {
    sessionBound: true,
    cliSessionId: binding.cliSessionId,
    nativeSessionId: binding.nativeSessionId,
    happierSessionId: binding.happierSessionId,
  };
  if (error instanceof HappierBridgeAgentConflictError) {
    return new ApiError(409, error.message, {
      code: "HAPPIER_BRIDGE_AGENT_CONFLICT",
      agentId: error.agent.id,
      ...bindingDetails,
    });
  }
  return new ApiError(500, `Happier session is bound, but bridge-agent assignment failed: ${error instanceof Error ? error.message : String(error)}`, {
    code: "HAPPIER_SESSION_BOUND_ASSIGNMENT_FAILED",
    ...bindingDetails,
  });
}

export function registerHappierDirectSessionRoutes(
  ctx: ApiRoutesContext,
  dependencies: HappierDirectSessionRouteDependencies = {},
): void {
  const ensureSession = dependencies.ensureHappierDirectSession ?? ensureHappierDirectSession;
  const readBinding = dependencies.readTaskHappierDirectSessionBinding ?? readTaskHappierDirectSessionBinding;
  const bindSession = dependencies.bindTaskHappierDirectSession ?? bindTaskHappierDirectSession;
  const buildOpenUrl = dependencies.buildHappierSessionOpenUrl ?? buildHappierSessionOpenUrl;
  const assignBridge = dependencies.assignTaskToBridge
    ?? ((input) => assignTaskToBridge(input, dependencies.createAgentStore));

  ctx.router.get("/tasks/:taskId/happier-direct-session", async (req, res) => {
    const { store } = await ctx.getProjectContext(req);
    const taskId = req.params.taskId;
    await getLiveTask(store, taskId);
    const binding = await readBindingOrThrowIntegrity({ store, taskId, readBinding });
    if (!binding) {
      res.json({ connected: false, taskId });
      return;
    }
    const settings = await resolveHappierSettings(store);
    assertHappierOpenUrlConfiguration(settings.webappUrl, buildOpenUrl);
    res.json(connectedResponse({ taskId, binding, webappUrl: settings.webappUrl, buildOpenUrl }));
  });

  ctx.router.post("/tasks/:taskId/happier-direct-session", async (req, res) => {
    const { store } = await ctx.getProjectContext(req);
    const taskId = req.params.taskId;
    const task = await getLiveTask(store, taskId);
    assertConnectableTask(task);
    const body = isRecord(req.body) ? req.body : {};
    const uri = typeof body.uri === "string" ? body.uri.trim() : "";
    if (!uri) throw badRequest("Happier native session URI is required", { code: "HAPPIER_URI_REQUIRED" });
    const machineId = typeof body.machineId === "string" && body.machineId.trim()
      ? body.machineId.trim()
      : undefined;
    const settings = await resolveHappierSettings(store);
    assertHappierOpenUrlConfiguration(settings.webappUrl, buildOpenUrl);

    const existingBinding = await readBindingOrThrowIntegrity({ store, taskId, readBinding });
    if (existingBinding) {
      assertExistingBindingMatchesRequest({ taskId, binding: existingBinding, uri, machineId });
      let assignment: BridgeAssignmentResult;
      try {
        assignment = await assignBridge({ store, taskId });
      } catch (error) {
        throw assignmentFailure(error, existingBinding);
      }
      res.json(connectedResponse({
        taskId,
        binding: existingBinding,
        webappUrl: settings.webappUrl,
        buildOpenUrl,
        created: false,
        agentId: assignment.agentId,
      }));
      return;
    }

    let ensured: HappierDirectSessionEnsureResult;
    let binding: TaskHappierDirectSessionBinding;
    try {
      ensured = await ensureSession({ uri, machineId, settings });
      binding = await bindSession({
        store,
        taskId,
        worktreePath: task.worktree,
        ensured,
        sourceSessionUri: uri,
      });
    } catch (error) {
      mapPreBindingError(error);
    }

    let assignment: BridgeAssignmentResult;
    try {
      assignment = await assignBridge({ store, taskId });
    } catch (error) {
      throw assignmentFailure(error, binding!);
    }

    res.json(connectedResponse({
      taskId,
      binding: binding!,
      webappUrl: settings.webappUrl,
      buildOpenUrl,
      created: ensured!.created,
      agentId: assignment.agentId,
    }));
  });
}

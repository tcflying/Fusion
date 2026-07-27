import {
  HAPPIER_RUNTIME_PLUGIN_ID,
  normalizeHappierSessionBindings,
  safeHappierSettingString,
  validateHappierRuntimeSettings,
  type HappierRuntimeSessionBinding,
} from "@fusion/core";

import {
  computeHappierBindingRevision,
  readHappierRuntimeSetupStatus,
  type HappierNativeSessionRecord,
  type HappierRuntimeSetupStatus,
  type ReadHappierRuntimeSetupStatusInput,
} from "../happier-runtime-setup-adapter.js";
import { badRequest, conflict, unauthorized } from "../api-error.js";
import { resolveDashboardAuthContext } from "../dashboard-auth-context.js";
import type { ApiRoutesContext } from "./types.js";

export interface HappierRuntimeSetupRouteDependencies {
  readonly readStatus: (
    input: ReadHappierRuntimeSetupStatusInput,
  ) => Promise<HappierRuntimeSetupStatus>;
}

const defaultDependencies: HappierRuntimeSetupRouteDependencies = {
  readStatus: readHappierRuntimeSetupStatus,
};

const BINDING_FIELDS = new Set([
  "canonicalSessionUri",
  "happierSessionId",
  "serverProfileId",
  "machineId",
]);
const bindingMutationTails = new WeakMap<object, Promise<void>>();

interface HappierPluginStore {
  getPlugin(id: string): Promise<{
    readonly settings?: Record<string, unknown>;
  }>;
  updatePluginSettings(
    id: string,
    settings: Record<string, unknown>,
  ): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireTrustedDashboardContext(ctx: ApiRoutesContext): void {
  if (!resolveDashboardAuthContext(ctx.options)) {
    throw unauthorized("Happier setup requires a trusted Dashboard authentication context");
  }
}

function parseMutationBody(value: unknown): {
  confirmed: true;
  expectedRevision: string;
  binding: HappierRuntimeSessionBinding;
} {
  if (!isRecord(value) || value.confirmed !== true) {
    throw badRequest("Happier binding changes require explicit confirmation");
  }
  const expectedRevision = safeHappierSettingString(value.expectedRevision, 128);
  if (!expectedRevision || !/^sha256:[a-f0-9]{64}$/u.test(expectedRevision)) {
    throw badRequest("A valid expected binding revision is required");
  }
  if (
    !isRecord(value.binding)
    || Object.keys(value.binding).some((key) => !BINDING_FIELDS.has(key))
  ) {
    throw badRequest("A complete Happier binding four-tuple is required");
  }
  const normalized = normalizeHappierSessionBindings([value.binding]);
  if (normalized.errors.length > 0 || normalized.bindings.length !== 1) {
    throw badRequest("A valid Happier binding four-tuple is required", {
      errors: [...normalized.errors],
    });
  }
  return {
    confirmed: true,
    expectedRevision,
    binding: normalized.bindings[0]!,
  };
}

function exactBindingMatch(
  left: HappierRuntimeSessionBinding,
  right: HappierRuntimeSessionBinding,
): boolean {
  return left.canonicalSessionUri === right.canonicalSessionUri
    && left.happierSessionId === right.happierSessionId
    && left.serverProfileId === right.serverProfileId
    && left.machineId === right.machineId;
}

async function withBindingMutationLock<T>(
  store: object,
  mutate: () => Promise<T>,
): Promise<T> {
  const previous = bindingMutationTails.get(store) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  bindingMutationTails.set(store, tail);
  await previous;
  try {
    return await mutate();
  } finally {
    release();
    if (bindingMutationTails.get(store) === tail) bindingMutationTails.delete(store);
  }
}

function currentBindings(settings: Record<string, unknown>): readonly HappierRuntimeSessionBinding[] {
  const normalized = normalizeHappierSessionBindings(settings.happierSessionBindings ?? []);
  if (normalized.errors.length > 0) {
    throw conflict("Persisted Happier bindings conflict or are invalid", {
      errors: [...normalized.errors],
    });
  }
  return normalized.bindings;
}

function assertExpectedRevision(
  bindings: readonly HappierRuntimeSessionBinding[],
  expectedRevision: string,
): void {
  const actualRevision = computeHappierBindingRevision(bindings);
  if (actualRevision !== expectedRevision) {
    throw conflict("Happier bindings changed; refresh before confirming", {
      expectedRevision,
      actualRevision,
    });
  }
}

function mutationResponse(bindings: readonly HappierRuntimeSessionBinding[]) {
  return {
    bindings,
    bindingRevision: computeHappierBindingRevision(bindings),
  };
}

async function scopedPluginStore(ctx: ApiRoutesContext, req: unknown): Promise<{
  pluginStore: HappierPluginStore;
  projectId: string | undefined;
}> {
  const project = await ctx.getProjectContext(req as never);
  return {
    pluginStore: project.store.getPluginStore() as HappierPluginStore,
    projectId: project.projectId,
  };
}

function nativeSessions(
  ctx: ApiRoutesContext,
  projectId: string | undefined,
): readonly HappierNativeSessionRecord[] | undefined {
  const store = ctx.options?.cliSessionTransport?.store;
  if (!store) return undefined;
  try {
    return store.listSessions(projectId ? { projectId } : undefined);
  } catch {
    return undefined;
  }
}

/**
 * Setup and binding management are intentionally separate from direct-session
 * creation. Discovery is read-only; only an explicit four-tuple confirmation
 * can change the project-scoped binding registry.
 */
export function registerHappierRuntimeSetupRoutes(
  ctx: ApiRoutesContext,
  dependencies: HappierRuntimeSetupRouteDependencies = defaultDependencies,
): void {
  ctx.router.get("/providers/happier/setup", async (req, res) => {
    try {
      requireTrustedDashboardContext(ctx);
      const { pluginStore, projectId } = await scopedPluginStore(ctx, req);
      const plugin = await pluginStore.getPlugin(HAPPIER_RUNTIME_PLUGIN_ID);
      const settings = isRecord(plugin.settings) ? plugin.settings : {};
      const status = await dependencies.readStatus({
        settings,
        nativeSessions: nativeSessions(ctx, projectId),
        projectId,
        hostId: projectId ? `fusion-dashboard:${projectId}` : "fusion-dashboard",
      });
      res.json(status);
    } catch (error) {
      ctx.rethrowAsApiError(error, "Failed to read Happier setup status");
    }
  });

  ctx.router.post("/providers/happier/bindings", async (req, res) => {
    try {
      requireTrustedDashboardContext(ctx);
      const mutation = parseMutationBody(req.body);
      const { pluginStore } = await scopedPluginStore(ctx, req);
      const response = await withBindingMutationLock(pluginStore as object, async () => {
        const plugin = await pluginStore.getPlugin(HAPPIER_RUNTIME_PLUGIN_ID);
        const settings = isRecord(plugin.settings) ? plugin.settings : {};
        const bindings = currentBindings(settings);
        assertExpectedRevision(bindings, mutation.expectedRevision);
        const next = normalizeHappierSessionBindings([...bindings, mutation.binding]);
        if (next.errors.length > 0) {
          throw conflict("Happier binding conflicts with the current registry", {
            errors: [...next.errors],
          });
        }
        const nextSettings = {
          ...settings,
          happierSessionBindings: next.bindings,
        };
        const validationErrors = validateHappierRuntimeSettings(nextSettings);
        if (validationErrors.length > 0) {
          throw conflict("Happier binding cannot be persisted", {
            errors: validationErrors,
          });
        }
        /*
         * FNXC:HappierExplicitBinding 2026-07-27-06:20:
         * This is the only setup write. It persists one user-confirmed tuple
         * and never calls ensure/create or silently adds a discovered Session.
         */
        await pluginStore.updatePluginSettings(HAPPIER_RUNTIME_PLUGIN_ID, nextSettings);
        return mutationResponse(next.bindings);
      });
      res.json(response);
    } catch (error) {
      ctx.rethrowAsApiError(error, "Failed to bind Happier session");
    }
  });

  ctx.router.post("/providers/happier/bindings/remove", async (req, res) => {
    try {
      requireTrustedDashboardContext(ctx);
      const mutation = parseMutationBody(req.body);
      const { pluginStore } = await scopedPluginStore(ctx, req);
      const response = await withBindingMutationLock(pluginStore as object, async () => {
        const plugin = await pluginStore.getPlugin(HAPPIER_RUNTIME_PLUGIN_ID);
        const settings = isRecord(plugin.settings) ? plugin.settings : {};
        const bindings = currentBindings(settings);
        assertExpectedRevision(bindings, mutation.expectedRevision);
        if (!bindings.some((binding) => exactBindingMatch(binding, mutation.binding))) {
          throw conflict("The confirmed Happier binding is no longer present");
        }
        const next = bindings.filter((binding) => !exactBindingMatch(binding, mutation.binding));
        await pluginStore.updatePluginSettings(HAPPIER_RUNTIME_PLUGIN_ID, {
          ...settings,
          happierSessionBindings: next,
        });
        return mutationResponse(next);
      });
      res.json(response);
    } catch (error) {
      ctx.rethrowAsApiError(error, "Failed to remove Happier binding");
    }
  });
}

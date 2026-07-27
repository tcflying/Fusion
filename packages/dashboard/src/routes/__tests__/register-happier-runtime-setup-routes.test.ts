import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createDashboardAuthContext } from "../../dashboard-auth-context.js";
import { registerHappierRuntimeSetupRoutes } from "../register-happier-runtime-setup-routes.js";

const EMPTY_BINDING_REVISION = `sha256:${createHash("sha256").update("[]").digest("hex")}`;

function revisionFor(bindings: readonly unknown[]): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(bindings)).digest("hex")}`;
}

describe("Happier runtime setup routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requires explicit confirmation and a matching revision before persisting one complete binding tuple", async () => {
    let settings: Record<string, unknown> = {
      backend: "codex",
      executable: process.execPath,
      entrypoint: "G:\\vendor\\happier\\apps\\cli\\package-dist\\index.mjs",
      allowedCliRoots: ["G:\\vendor\\happier"],
      activeServerId: "server-main",
    };
    const updatePluginSettings = vi.fn(async (_id: string, next: Record<string, unknown>) => {
      settings = next;
      return { settings };
    });
    const pluginStore = {
      getPlugin: vi.fn(async () => ({ enabled: true, settings })),
      updatePluginSettings,
    };
    const postRoutes = new Map<string, (req: any, res: any) => Promise<void>>();
    registerHappierRuntimeSetupRoutes({
      router: {
        get: vi.fn(),
        post: (path: string, handler: (req: any, res: any) => Promise<void>) => {
          postRoutes.set(path, handler);
        },
      },
      options: {
        dashboardAuthContext: createDashboardAuthContext({
          host: "127.0.0.1",
          token: "fn_test",
        }),
      },
      getProjectContext: vi.fn(async () => ({
        store: { getPluginStore: () => pluginStore },
        projectId: "project-a",
      })),
      rethrowAsApiError: (error: unknown) => {
        throw error;
      },
    } as never, {
      readStatus: vi.fn(),
    });
    const binding = {
      canonicalSessionUri: "codex://threads/native-1",
      happierSessionId: "happy-1",
      serverProfileId: "server-main",
      machineId: "machine-a",
    };
    const handler = postRoutes.get("/providers/happier/bindings");

    await expect(handler?.({
      body: {
        confirmed: false,
        expectedRevision: EMPTY_BINDING_REVISION,
        binding,
      },
    }, { json: vi.fn() })).rejects.toThrow(/explicit confirmation/i);
    expect(updatePluginSettings).not.toHaveBeenCalled();

    const json = vi.fn();
    await handler?.({
      body: {
        confirmed: true,
        expectedRevision: EMPTY_BINDING_REVISION,
        binding,
      },
    }, { json });

    expect(updatePluginSettings).toHaveBeenCalledWith(
      "fusion-plugin-happier-runtime",
      expect.objectContaining({
        happierSessionBindings: [binding],
      }),
    );
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      bindings: [binding],
      bindingRevision: expect.stringMatching(/^sha256:/u),
    }));

    const removeHandler = postRoutes.get("/providers/happier/bindings/remove");
    await expect(removeHandler?.({
      body: {
        confirmed: true,
        expectedRevision: EMPTY_BINDING_REVISION,
        binding,
      },
    }, { json: vi.fn() })).rejects.toThrow(/refresh before confirming/i);
    expect(updatePluginSettings).toHaveBeenCalledTimes(1);

    const removeJson = vi.fn();
    await removeHandler?.({
      body: {
        confirmed: true,
        expectedRevision: revisionFor([binding]),
        binding,
      },
    }, { json: removeJson });

    expect(updatePluginSettings).toHaveBeenLastCalledWith(
      "fusion-plugin-happier-runtime",
      expect.objectContaining({
        happierSessionBindings: [],
      }),
    );
    expect(removeJson).toHaveBeenCalledWith(expect.objectContaining({
      bindings: [],
      bindingRevision: EMPTY_BINDING_REVISION,
    }));
  });

  it("rejects a canonical-session fork instead of selecting the first mapping", async () => {
    const existing = {
      canonicalSessionUri: "codex://threads/native-1",
      happierSessionId: "happy-1",
      serverProfileId: "server-main",
      machineId: "machine-a",
    };
    const settings = {
      backend: "codex",
      executable: process.execPath,
      entrypoint: "G:\\vendor\\happier\\apps\\cli\\package-dist\\index.mjs",
      allowedCliRoots: ["G:\\vendor\\happier"],
      activeServerId: "server-main",
      happierSessionBindings: [existing],
    };
    const updatePluginSettings = vi.fn();
    const pluginStore = {
      getPlugin: vi.fn(async () => ({ enabled: true, settings })),
      updatePluginSettings,
    };
    const postRoutes = new Map<string, (req: any, res: any) => Promise<void>>();
    registerHappierRuntimeSetupRoutes({
      router: {
        get: vi.fn(),
        post: (path: string, handler: (req: any, res: any) => Promise<void>) => {
          postRoutes.set(path, handler);
        },
      },
      options: {
        dashboardAuthContext: createDashboardAuthContext({
          host: "127.0.0.1",
          token: "fn_test",
        }),
      },
      getProjectContext: vi.fn(async () => ({
        store: { getPluginStore: () => pluginStore },
        projectId: "project-a",
      })),
      rethrowAsApiError: (error: unknown) => {
        throw error;
      },
    } as never, {
      readStatus: vi.fn(),
    });

    await expect(postRoutes.get("/providers/happier/bindings")?.({
      body: {
        confirmed: true,
        expectedRevision: revisionFor([existing]),
        binding: {
          ...existing,
          happierSessionId: "happy-2",
        },
      },
    }, { json: vi.fn() })).rejects.toThrow(/conflict/i);
    expect(updatePluginSettings).not.toHaveBeenCalled();
  });

  it("passes only read-only native candidates into the setup adapter", async () => {
    const listedSession = {
      id: "cli-1",
      adapterId: "codex",
      nativeSessionId: "native-1",
      projectId: "project-a",
    };
    const listSessions = vi.fn(() => [listedSession]);
    const pluginStore = {
      getPlugin: vi.fn(async () => ({
        enabled: true,
        settings: { backend: "codex" },
      })),
    };
    const readStatus = vi.fn(async () => ({ marker: "setup" }));
    const getRoutes = new Map<string, (req: any, res: any) => Promise<void>>();
    registerHappierRuntimeSetupRoutes({
      router: {
        get: (path: string, handler: (req: any, res: any) => Promise<void>) => {
          getRoutes.set(path, handler);
        },
        post: vi.fn(),
      },
      options: {
        dashboardAuthContext: createDashboardAuthContext({
          host: "127.0.0.1",
          token: "fn_test",
        }),
        cliSessionTransport: {
          store: { listSessions },
        },
      },
      getProjectContext: vi.fn(async () => ({
        store: { getPluginStore: () => pluginStore },
        projectId: "project-a",
      })),
      rethrowAsApiError: (error: unknown) => {
        throw error;
      },
    } as never, {
      readStatus: readStatus as never,
    });
    const json = vi.fn();

    await getRoutes.get("/providers/happier/setup")?.({}, { json });

    expect(listSessions).toHaveBeenCalledWith({ projectId: "project-a" });
    expect(readStatus).toHaveBeenCalledWith(expect.objectContaining({
      settings: { backend: "codex" },
      projectId: "project-a",
      nativeSessions: [listedSession],
    }));
    expect(json).toHaveBeenCalledWith({ marker: "setup" });
  });
});

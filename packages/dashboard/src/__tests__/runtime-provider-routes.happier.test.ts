// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const { probeHappierProvider } = vi.hoisted(() => ({ probeHappierProvider: vi.fn() }));

vi.mock("../runtime-provider-probes.js", () => ({
  discoverPaperclipCli: vi.fn(),
  listHermesProviderProfiles: vi.fn(),
  listPaperclipCompanies: vi.fn(),
  listPaperclipCompaniesViaCliFacade: vi.fn(),
  listPaperclipCompanyAgents: vi.fn(),
  listPaperclipCompanyAgentsViaCliFacade: vi.fn(),
  mintPaperclipKeyViaCli: vi.fn(),
  probeHappierProvider,
  probeHermesProvider: vi.fn(),
  probeOpenClawProvider: vi.fn(),
  probePaperclipProvider: vi.fn(),
  probePaperclipViaCliFacade: vi.fn(),
}));

import { registerRuntimeProviderRoutes } from "../routes/register-runtime-provider-routes.js";
import { createDashboardAuthContext } from "../dashboard-auth-context.js";

describe("POST /providers/happier/status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes only non-secret bounded settings and returns the sanitized health object", async () => {
    const health = {
      discovered: true,
      executable: true,
      server: false,
      serverState: "not-probed",
      authenticated: false,
      daemon: false,
      backend: true,
      ready: false,
      backendId: "codex",
      details: ["authentication-required"],
    };
    probeHappierProvider.mockResolvedValue(health);
    const routes = new Map<string, (req: any, res: any) => Promise<void>>();
    registerRuntimeProviderRoutes({
      router: { get: vi.fn(), post: (path: string, handler: (req: any, res: any) => Promise<void>) => routes.set(path, handler) },
      options: {
        dashboardAuthContext: createDashboardAuthContext({
          host: "0.0.0.0",
          token: "fn_test",
        }),
      },
      rethrowAsApiError: (error: unknown) => { throw error; },
    } as never);
    const json = vi.fn();
    await routes.get("/providers/happier/status")!({ body: { executable: process.execPath, homeDir: "C:\\Users\\datoo\\.happier\\stacks\\fusion\\cli", activeServerId: "stack_fusion__id_default", serverUrl: "http://127.0.0.1:52211", publicServerUrl: "http://localhost:52211", webappUrl: "http://stack.localhost:52211", backend: "codex", timeoutMs: 120_000, maxOutputBytes: 16_777_216 } }, { json });
    expect(probeHappierProvider).toHaveBeenCalledWith(expect.objectContaining({ executable: process.execPath, homeDir: "C:\\Users\\datoo\\.happier\\stacks\\fusion\\cli", activeServerId: "stack_fusion__id_default", serverUrl: "http://127.0.0.1:52211", publicServerUrl: "http://localhost:52211", webappUrl: "http://stack.localhost:52211", backend: "codex", timeoutMs: 120_000, maxOutputBytes: 16_777_216 }));
    expect(probeHappierProvider.mock.calls[0]?.[0]).not.toHaveProperty("token");
    expect(json).toHaveBeenCalledWith(health);
  });

  it("rejects unsupported backends before probing", async () => {
    const routes = new Map<string, (req: any, res: any) => Promise<void>>();
    registerRuntimeProviderRoutes({
      router: { get: vi.fn(), post: (path: string, handler: (req: any, res: any) => Promise<void>) => routes.set(path, handler) },
      options: { daemon: { token: "fn_test" } },
      rethrowAsApiError: (error: unknown) => { throw error; },
    } as never);
    await expect(routes.get("/providers/happier/status")!({ body: { backend: "other" } }, { json: vi.fn() })).rejects.toThrow(/backend must be codex/);
    expect(probeHappierProvider).not.toHaveBeenCalled();
  });

  it("rejects credential fields before invoking the official CLI", async () => {
    const routes = new Map<string, (req: any, res: any) => Promise<void>>();
    registerRuntimeProviderRoutes({
      router: { get: vi.fn(), post: (path: string, handler: (req: any, res: any) => Promise<void>) => routes.set(path, handler) },
      options: { daemon: { token: "fn_test" } },
      rethrowAsApiError: (error: unknown) => { throw error; },
    } as never);

    await expect(routes.get("/providers/happier/status")!({ body: { token: "must-not-pass" } }, { json: vi.fn() }))
      .rejects.toThrow(/Unsupported Happier setting/);
    expect(probeHappierProvider).not.toHaveBeenCalled();
  });

  it("uses the explicit loopback no-auth Dashboard context for the host probe", async () => {
    probeHappierProvider.mockResolvedValue({ ready: true });
    const routes = new Map<string, (req: any, res: any) => Promise<void>>();
    registerRuntimeProviderRoutes({
      router: { get: vi.fn(), post: (path: string, handler: (req: any, res: any) => Promise<void>) => routes.set(path, handler) },
      options: {
        noAuth: true,
        dashboardAuthContext: createDashboardAuthContext({
          host: "127.0.0.1",
          noAuth: true,
        }),
      },
      rethrowAsApiError: (error: unknown) => { throw error; },
    } as never);
    const json = vi.fn();

    await routes.get("/providers/happier/status")!({ body: {} }, { json });

    expect(probeHappierProvider).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith({ ready: true });
  });

  it("refuses credential-bearing probes when daemon authentication is disabled", async () => {
    const routes = new Map<string, (req: any, res: any) => Promise<void>>();
    registerRuntimeProviderRoutes({
      router: { get: vi.fn(), post: (path: string, handler: (req: any, res: any) => Promise<void>) => routes.set(path, handler) },
      options: { daemon: { token: "fn_test" }, noAuth: true },
      rethrowAsApiError: (error: unknown) => { throw error; },
    } as never);

    await expect(routes.get("/providers/happier/status")!({ body: {} }, { json: vi.fn() })).rejects.toThrow(
      /trusted Dashboard authentication context/i,
    );
    expect(probeHappierProvider).not.toHaveBeenCalled();
  });
});

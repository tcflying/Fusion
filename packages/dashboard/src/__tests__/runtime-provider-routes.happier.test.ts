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
      options: { daemon: { token: "fn_test" } },
      rethrowAsApiError: (error: unknown) => { throw error; },
    } as never);
    const json = vi.fn();
    await routes.get("/providers/happier/status")!({ body: { executable: "node", entrypoint: "happier.mjs", homeDir: "C:\\Users\\datoo\\.happier\\stacks\\fusion\\cli", activeServerId: "stack_fusion__id_default", serverUrl: "http://127.0.0.1:52211", publicServerUrl: "http://localhost:52211", webappUrl: "http://stack.localhost:52211", backend: "codex", timeoutMs: 999999, maxOutputBytes: 999999999 } }, { json });
    expect(probeHappierProvider).toHaveBeenCalledWith(expect.objectContaining({ executable: "node", entrypoint: "happier.mjs", homeDir: "C:\\Users\\datoo\\.happier\\stacks\\fusion\\cli", activeServerId: "stack_fusion__id_default", serverUrl: "http://127.0.0.1:52211", publicServerUrl: "http://localhost:52211", webappUrl: "http://stack.localhost:52211", backend: "codex", timeoutMs: 120_000, maxOutputBytes: 16_777_216 }));
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
    await expect(routes.get("/providers/happier/status")!({ body: { backend: "other" } }, { json: vi.fn() })).rejects.toThrow(/Invalid backend/);
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

  it("refuses credential-bearing probes when daemon authentication is disabled", async () => {
    const routes = new Map<string, (req: any, res: any) => Promise<void>>();
    registerRuntimeProviderRoutes({
      router: { get: vi.fn(), post: (path: string, handler: (req: any, res: any) => Promise<void>) => routes.set(path, handler) },
      options: { daemon: { token: "fn_test" }, noAuth: true },
      rethrowAsApiError: (error: unknown) => { throw error; },
    } as never);

    await expect(routes.get("/providers/happier/status")!({ body: {} }, { json: vi.fn() })).rejects.toThrow(
      /bearer-token authentication/i,
    );
    expect(probeHappierProvider).not.toHaveBeenCalled();
  });
});

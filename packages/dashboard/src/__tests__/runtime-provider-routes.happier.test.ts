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

describe("GET /providers/happier/status", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes only non-secret bounded settings and returns the sanitized health object", async () => {
    const health = {
      discovered: true,
      executable: true,
      server: false,
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
      router: { get: (path: string, handler: (req: any, res: any) => Promise<void>) => routes.set(path, handler), post: vi.fn() },
      rethrowAsApiError: (error: unknown) => { throw error; },
    } as never);
    const json = vi.fn();
    await routes.get("/providers/happier/status")!({ query: { executable: "node", entrypoint: "happier.mjs", serverUrl: "http://localhost:52211", backend: "codex", timeoutMs: "999999", maxOutputBytes: "999999999", token: "must-not-pass" } }, { json });
    expect(probeHappierProvider).toHaveBeenCalledWith(expect.objectContaining({ executable: "node", entrypoint: "happier.mjs", serverUrl: "http://localhost:52211", backend: "codex", timeoutMs: 120_000, maxOutputBytes: 16_777_216 }));
    expect(probeHappierProvider.mock.calls[0]?.[0]).not.toHaveProperty("token");
    expect(json).toHaveBeenCalledWith(health);
  });

  it("rejects unsupported backends before probing", async () => {
    const routes = new Map<string, (req: any, res: any) => Promise<void>>();
    registerRuntimeProviderRoutes({
      router: { get: (path: string, handler: (req: any, res: any) => Promise<void>) => routes.set(path, handler), post: vi.fn() },
      rethrowAsApiError: (error: unknown) => { throw error; },
    } as never);
    await expect(routes.get("/providers/happier/status")!({ query: { backend: "other" } }, { json: vi.fn() })).rejects.toThrow(/Invalid backend/);
    expect(probeHappierProvider).not.toHaveBeenCalled();
  });
});

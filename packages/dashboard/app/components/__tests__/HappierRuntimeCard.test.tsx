import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api", () => ({
  confirmHappierRuntimeBinding: vi.fn(),
  fetchHappierStatus: vi.fn(),
  fetchHappierRuntimeSetup: vi.fn(),
  fetchPluginSettings: vi.fn(),
  fetchPlugins: vi.fn(),
  removeHappierRuntimeBinding: vi.fn(),
  updatePluginSettings: vi.fn(),
}));

import {
  confirmHappierRuntimeBinding,
  fetchHappierStatus,
  fetchHappierRuntimeSetup,
  fetchPluginSettings,
  fetchPlugins,
  removeHappierRuntimeBinding,
  updatePluginSettings,
} from "../../api";
import { HappierRuntimeCard } from "../HappierRuntimeCard";

function setupStatus() {
  return {
    failClosed: false,
    bindingRevision: "sha256:revision",
    validationErrors: [],
    conflicts: [],
    runtimeHealth: {
      discovered: true,
      executable: true,
      server: true,
      serverState: "reachable" as const,
      authenticated: true,
      daemon: true,
      backend: true,
      ready: true,
      backendId: "codex" as const,
      modelId: null,
      modelState: "not_reported" as const,
      attestation: {
        ok: true as const,
        trustLevel: "local_custom_pinned_source_build" as const,
        sourceRoot: "G:\\vendor\\happier",
        entrypointPath: "G:\\vendor\\happier\\apps\\cli\\package-dist\\index.mjs",
        cliVersion: "0.2.10",
        sourceCommit: "6e059c41d865343c1efc9c98676e5af3882d85ff",
        entrypointSha256: "sha256:8ad722284c12ca87c946f3a94b66b14f5640bf768e719c8791b1cb0234312786" as const,
        verifiedAt: "2026-07-27T08:00:00.000Z",
        evidence: {
          version: "cli_--version" as const,
          package: "package_json" as const,
          source: "git_head" as const,
          artifact: "sha256_file_bytes" as const,
        },
      },
      details: [],
    },
    connectorHealth: {
      connectorId: "happier",
      hostId: "fusion-dashboard:project-a",
      state: "healthy" as const,
      checkedAt: "2026-07-27T08:00:01.000Z",
      authentication: "authenticated" as const,
      daemon: "running" as const,
      server: "reachable" as const,
      backend: "ready" as const,
      rateLimit: "unknown" as const,
      host: "reachable" as const,
      capabilities: {
        ensureExisting: "verified" as const,
        create: "unavailable" as const,
        status: "verified" as const,
        history: "verified" as const,
        events: "unavailable" as const,
        send: "verified" as const,
        interrupt: "verified" as const,
        resume: "unavailable" as const,
        takeover: "unavailable" as const,
        health: "verified" as const,
        deepLinks: "verified" as const,
      },
      reasonCodes: [],
      retryAfterMs: null,
    },
    connectorReadError: null,
    compatibility: {
      pluginVersion: "1.0.0",
      fusionSemver: ">=0.74.0-beta.3 <0.75.0",
      happierCliSemver: "0.2.10",
      happierSourceCommit: "6e059c41d865343c1efc9c98676e5af3882d85ff",
      officialProtocolContract: "sessionControl/v1@6e059c41d865343c1efc9c98676e5af3882d85ff",
      entrypointRelativePath: "apps/cli/package-dist/index.mjs",
      entrypointSha256: "sha256:8ad722284c12ca87c946f3a94b66b14f5640bf768e719c8791b1cb0234312786",
    },
    server: {
      activeServerId: "server-main",
      profile: "fusion",
      serverUrl: "http://127.0.0.1:52211",
      publicServerUrl: "http://localhost:52211",
      webappUrl: "http://stack.localhost:52211",
    },
    cli: {
      configuredEntrypoint: "G:\\vendor\\happier\\apps\\cli\\package-dist\\index.mjs",
      allowedRoots: ["G:\\vendor\\happier"],
      attestation: {
        ok: true as const,
        trustLevel: "local_custom_pinned_source_build" as const,
        sourceRoot: "G:\\vendor\\happier",
        entrypointPath: "G:\\vendor\\happier\\apps\\cli\\package-dist\\index.mjs",
        cliVersion: "0.2.10",
        sourceCommit: "6e059c41d865343c1efc9c98676e5af3882d85ff",
        entrypointSha256: "sha256:8ad722284c12ca87c946f3a94b66b14f5640bf768e719c8791b1cb0234312786" as const,
        verifiedAt: "2026-07-27T08:00:00.000Z",
        evidence: {
          version: "cli_--version" as const,
          package: "package_json" as const,
          source: "git_head" as const,
          artifact: "sha256_file_bytes" as const,
        },
      },
    },
    authentication: {
      runtimeAuthenticated: true,
      connector: "authenticated" as const,
    },
    machines: [{
      machineId: "machine-a",
      providerIds: ["codex" as const],
      bindingCount: 1,
      availability: "verified" as const,
    }],
    bindings: [{
      canonicalSessionUri: "codex://threads/native-1",
      happierSessionId: "happy-1",
      serverProfileId: "server-main",
      machineId: "machine-a",
      providerId: "codex" as const,
      nativeSessionId: "native-1",
      state: "verified" as const,
      driftReasons: [],
      machineAvailability: "verified" as const,
      probeEvidence: {
        canonicalSessionUri: "codex://threads/native-1",
        providerId: "codex" as const,
        happierSessionId: "happy-1",
        serverProfileId: "server-main",
        machineId: "machine-a",
        state: "available" as const,
        toolNames: ["session_control", "session_status"],
        sampledAt: "2026-07-27T08:00:01.000Z",
        latencyMs: 14,
      },
    }],
    discovery: {
      nativeState: "available" as const,
      nativeReason: null,
      nativeCandidates: [{
        canonicalSessionUri: "codex://threads/native-1",
        providerId: "codex" as const,
        nativeSessionId: "native-1",
        sourceSessionId: "cli-1",
        bindingState: "bound" as const,
      }],
      happierState: "available" as const,
      happierReason: null,
      happierCandidates: [{
        happierSessionId: "happy-1",
        updatedAt: 10,
        active: true,
        bindingState: "bound" as const,
      }],
    },
  };
}

describe("HappierRuntimeCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchPluginSettings).mockResolvedValue({ backend: "codex" });
    vi.mocked(fetchPlugins).mockResolvedValue([]);
    const initialSetup = setupStatus();
    vi.mocked(fetchHappierRuntimeSetup).mockResolvedValue({
      ...initialSetup,
      failClosed: true,
      runtimeHealth: {
        ...initialSetup.runtimeHealth,
        server: false,
        serverState: "not-probed",
        authenticated: false,
        daemon: false,
        ready: false,
        details: ["authentication-required", "daemon-stopped"],
      },
      authentication: {
        runtimeAuthenticated: false,
        connector: "required",
      },
    });
    vi.mocked(confirmHappierRuntimeBinding).mockResolvedValue({
      bindings: [],
      bindingRevision: "sha256:next",
    });
    vi.mocked(removeHappierRuntimeBinding).mockResolvedValue({
      bindings: [],
      bindingRevision: "sha256:next",
    });
    vi.mocked(updatePluginSettings).mockResolvedValue({});
    vi.mocked(fetchHappierStatus).mockResolvedValue({
      discovered: true,
      executable: true,
      server: false,
      serverState: "not-probed",
      authenticated: false,
      daemon: false,
      backend: true,
      ready: false,
      backendId: "codex",
      details: ["authentication-required", "daemon-stopped"],
    });
  });

  it("shows server, machine, real CLI attestation, compatibility, authentication, tuple, and probe evidence", async () => {
    vi.mocked(fetchHappierRuntimeSetup).mockResolvedValue(setupStatus());
    render(<HappierRuntimeCard projectId="project-a" />);

    expect(await screen.findByText("CLI attestation")).toBeInTheDocument();
    expect(fetchHappierRuntimeSetup).toHaveBeenCalledWith("project-a");
    expect(screen.getAllByText("0.2.10").length).toBeGreaterThan(0);
    expect(screen.getAllByText("6e059c41d865343c1efc9c98676e5af3882d85ff").length).toBeGreaterThan(0);
    expect(screen.getAllByText("sha256:8ad722284c12ca87c946f3a94b66b14f5640bf768e719c8791b1cb0234312786").length).toBeGreaterThan(0);
    expect(screen.getByText("G:\\vendor\\happier\\apps\\cli\\package-dist\\index.mjs")).toBeInTheDocument();
    expect(screen.getAllByText("G:\\vendor\\happier").length).toBeGreaterThan(0);
    expect(screen.getByText("Compatibility matrix")).toBeInTheDocument();
    expect(screen.getByText(">=0.74.0-beta.3 <0.75.0")).toBeInTheDocument();
    expect(screen.getAllByText(/server-main/u).length).toBeGreaterThan(0);
    expect(screen.getByText("http://127.0.0.1:52211")).toBeInTheDocument();
    expect(screen.getByText("http://localhost:52211")).toBeInTheDocument();
    expect(screen.getByText("http://stack.localhost:52211")).toBeInTheDocument();
    expect(screen.getByText("machine-a")).toBeInTheDocument();
    expect(screen.getAllByText("Authenticated").length).toBeGreaterThan(0);
    expect(screen.getAllByText("codex://threads/native-1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("happy-1").length).toBeGreaterThan(0);
    expect(screen.getByText("Probe evidence")).toBeInTheDocument();
    expect(screen.getByText("session_control, session_status")).toBeInTheDocument();
  });

  it("keeps discoveries unbound until the operator explicitly confirms the complete four-tuple", async () => {
    const discovered = setupStatus();
    vi.mocked(fetchHappierRuntimeSetup).mockResolvedValue({
      ...discovered,
      discovery: {
        ...discovered.discovery,
        nativeCandidates: [
          ...discovered.discovery.nativeCandidates,
          {
            canonicalSessionUri: "codex://threads/native-2",
            providerId: "codex",
            nativeSessionId: "native-2",
            sourceSessionId: "cli-2",
            bindingState: "unbound",
          },
        ],
        happierCandidates: [
          ...discovered.discovery.happierCandidates,
          {
            happierSessionId: "happy-2",
            updatedAt: 11,
            active: true,
            bindingState: "unbound",
          },
        ],
      },
    });

    render(<HappierRuntimeCard projectId="project-a" />);

    const nativeCandidate = await screen.findByLabelText("Native session candidate");
    const happierCandidate = screen.getByLabelText("Happier session candidate");
    expect(confirmHappierRuntimeBinding).not.toHaveBeenCalled();

    fireEvent.change(nativeCandidate, { target: { value: "codex://threads/native-2" } });
    fireEvent.change(happierCandidate, { target: { value: "happy-2" } });
    fireEvent.change(screen.getByLabelText("Server profile for binding"), {
      target: { value: "server-main" },
    });
    fireEvent.change(screen.getByLabelText("Machine for binding"), {
      target: { value: "machine-b" },
    });
    expect(confirmHappierRuntimeBinding).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm binding" }));

    await waitFor(() => expect(confirmHappierRuntimeBinding).toHaveBeenCalledWith(
      "project-a",
      {
        expectedRevision: "sha256:revision",
        binding: {
          canonicalSessionUri: "codex://threads/native-2",
          happierSessionId: "happy-2",
          serverProfileId: "server-main",
          machineId: "machine-b",
        },
      },
    ));
  });

  it("labels OpenCode machine availability as unable to verify when typed health has no machine proof", async () => {
    const openCode = setupStatus();
    vi.mocked(fetchHappierRuntimeSetup).mockResolvedValue({
      ...openCode,
      failClosed: true,
      runtimeHealth: {
        ...openCode.runtimeHealth,
        ready: false,
        backend: false,
        backendId: "opencode",
        details: ["backend-machine-availability-unverified"],
      },
      machines: [{
        machineId: "machine-open",
        providerIds: ["opencode"],
        bindingCount: 1,
        availability: "unverified",
      }],
      bindings: [{
        ...openCode.bindings[0]!,
        canonicalSessionUri: "opencode://sessions/native-open",
        providerId: "opencode",
        nativeSessionId: "native-open",
        machineId: "machine-open",
        state: "unverified",
        machineAvailability: "unverified",
        driftReasons: ["machine-availability-unverified"],
        probeEvidence: {
          ...openCode.bindings[0]!.probeEvidence!,
          canonicalSessionUri: "opencode://sessions/native-open",
          providerId: "opencode",
          machineId: "machine-open",
        },
      }],
    });

    render(<HappierRuntimeCard projectId="project-a" />);

    expect(await screen.findByText("OpenCode machine availability")).toBeInTheDocument();
    expect(screen.getAllByText("Unable to verify").length).toBeGreaterThan(0);
    expect(screen.getByText(/Machine Availability Unverified/u)).toBeInTheDocument();
  });

  it("keeps conflicts and two-way drift visible while the setup is fail closed", async () => {
    const drifted = setupStatus();
    vi.mocked(fetchHappierRuntimeSetup).mockResolvedValue({
      ...drifted,
      failClosed: true,
      validationErrors: [
        "Happier binding conflict for canonical Session codex://threads/native-1",
      ],
      conflicts: [
        "Happier binding conflict for canonical Session codex://threads/native-1",
      ],
      bindings: [{
        ...drifted.bindings[0]!,
        state: "drift",
        driftReasons: [
          "native-session-missing",
          "happier-session-missing",
          "probe-unavailable",
        ],
      }],
    });

    render(<HappierRuntimeCard projectId="project-a" />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Happier binding conflict for canonical Session codex://threads/native-1",
    );
    expect(screen.getAllByText("Drift").length).toBeGreaterThan(0);
    expect(screen.getByText(/Native Session Missing · Happier Session Missing · Probe Unavailable/u)).toBeInTheDocument();
    expect(screen.getByTestId("happier-runtime-card")).toHaveTextContent("Fail closed");
  });

  it("does not let a standalone ready probe bypass missing setup reconciliation", async () => {
    vi.mocked(fetchHappierRuntimeSetup).mockRejectedValue(new Error("setup unavailable"));
    vi.mocked(fetchHappierStatus).mockResolvedValue(setupStatus().runtimeHealth);

    render(<HappierRuntimeCard projectId="project-a" />);

    await waitFor(() => expect(fetchHappierRuntimeSetup).toHaveBeenCalledWith("project-a"));
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(fetchHappierStatus).toHaveBeenCalledTimes(1));

    expect(screen.getByTestId("happier-runtime-card")).toHaveTextContent("Fail closed");
  });

  it("renders every health layer independently and does not claim partial health is ready", async () => {
    render(<HappierRuntimeCard />);
    await waitFor(() => expect(fetchHappierRuntimeSetup).toHaveBeenCalled());
    expect(screen.getByTestId("happier-health-cli").textContent).toContain("CLI");
    expect(screen.getByTestId("happier-health-server").textContent).toContain("Server");
    expect(screen.getByTestId("happier-health-auth").textContent).toContain("Auth");
    expect(screen.getByTestId("happier-health-daemon").textContent).toContain("Daemon");
    expect(screen.getByTestId("happier-health-backend").textContent).toContain("Backend");
    expect(screen.getByTestId("happier-runtime-card").textContent).toContain("Fail closed");
  });

  it("renders an unprobed server as unknown instead of down", async () => {
    render(<HappierRuntimeCard />);
    const badge = await screen.findByTestId("happier-health-server");
    expect(badge.textContent).toContain("Server · Not probed");
    expect(badge.className).toContain("provider-status-badge--neutral");
    expect(badge.className).not.toContain("provider-status-badge--error");
  });

  it("offers only supported session backends and no credential fields", async () => {
    render(<HappierRuntimeCard />);
    const select = await screen.findByLabelText("Selected backend");
    expect(Array.from((select as HTMLSelectElement).options).map((option) => option.value)).toEqual(["codex", "claude", "opencode"]);
    expect(screen.queryByLabelText(/token|api key|password/i)).toBeNull();
    expect(screen.getByText(/credentials are deliberately not accepted/i)).toBeTruthy();
  });

  it("loads, probes, and saves the non-secret Happier stack identity", async () => {
    vi.mocked(fetchPluginSettings).mockResolvedValue({
      backend: "codex",
      homeDir: "C:\\Users\\datoo\\.happier\\stacks\\fusion\\cli",
      activeServerId: "stack_fusion__id_default",
      serverUrl: "http://127.0.0.1:52211",
      publicServerUrl: "http://localhost:52211",
      webappUrl: "http://stack.localhost:52211",
    });

    render(<HappierRuntimeCard />);

    expect(await screen.findByLabelText("Happier home directory")).toHaveValue(
      "C:\\Users\\datoo\\.happier\\stacks\\fusion\\cli",
    );
    expect(screen.getByLabelText("Active server ID")).toHaveValue("stack_fusion__id_default");
    expect(screen.getByLabelText("Public server URL")).toHaveValue("http://localhost:52211");
    await waitFor(() => expect(fetchHappierRuntimeSetup).toHaveBeenCalledWith(undefined));
    expect(fetchHappierStatus).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updatePluginSettings).toHaveBeenCalledWith(
      "fusion-plugin-happier-runtime",
      expect.objectContaining({
        homeDir: "C:\\Users\\datoo\\.happier\\stacks\\fusion\\cli",
        activeServerId: "stack_fusion__id_default",
        publicServerUrl: "http://localhost:52211",
      }),
      undefined,
    ));
  });

  it("loads one setup aggregate on mount and does not spawn another probe after save-only", async () => {
    render(<HappierRuntimeCard />);
    await waitFor(() => expect(fetchHappierRuntimeSetup).toHaveBeenCalledTimes(1));
    expect(fetchHappierStatus).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(updatePluginSettings).toHaveBeenCalledTimes(1));
    expect(fetchHappierRuntimeSetup).toHaveBeenCalledTimes(1);
    expect(fetchHappierStatus).not.toHaveBeenCalled();
  });
});

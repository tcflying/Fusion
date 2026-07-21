import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../api", () => ({
  fetchHappierStatus: vi.fn(),
  fetchPluginSettings: vi.fn(),
  fetchPlugins: vi.fn(),
  updatePluginSettings: vi.fn(),
}));

import { fetchHappierStatus, fetchPluginSettings, fetchPlugins, updatePluginSettings } from "../../api";
import { HappierRuntimeCard } from "../HappierRuntimeCard";

describe("HappierRuntimeCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchPluginSettings).mockResolvedValue({ backend: "codex" });
    vi.mocked(fetchPlugins).mockResolvedValue([]);
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

  it("renders every health layer independently and does not claim partial health is ready", async () => {
    render(<HappierRuntimeCard />);
    await waitFor(() => expect(fetchHappierStatus).toHaveBeenCalled());
    expect(screen.getByTestId("happier-health-cli").textContent).toContain("CLI");
    expect(screen.getByTestId("happier-health-server").textContent).toContain("Server");
    expect(screen.getByTestId("happier-health-auth").textContent).toContain("Auth");
    expect(screen.getByTestId("happier-health-daemon").textContent).toContain("Daemon");
    expect(screen.getByTestId("happier-health-backend").textContent).toContain("Backend");
    expect(screen.getByTestId("happier-runtime-card").textContent).toContain("Not ready");
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
    await waitFor(() => expect(fetchHappierStatus).toHaveBeenCalledWith(expect.objectContaining({
      homeDir: "C:\\Users\\datoo\\.happier\\stacks\\fusion\\cli",
      activeServerId: "stack_fusion__id_default",
      publicServerUrl: "http://localhost:52211",
    })));

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updatePluginSettings).toHaveBeenCalledWith(
      "fusion-plugin-happier-runtime",
      expect.objectContaining({
        homeDir: "C:\\Users\\datoo\\.happier\\stacks\\fusion\\cli",
        activeServerId: "stack_fusion__id_default",
        publicServerUrl: "http://localhost:52211",
      }),
    ));
  });

  it("probes once on mount and does not spawn another probe after save-only", async () => {
    render(<HappierRuntimeCard />);
    await waitFor(() => expect(fetchHappierStatus).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(updatePluginSettings).toHaveBeenCalledTimes(1));
    expect(fetchHappierStatus).toHaveBeenCalledTimes(1);
  });
});

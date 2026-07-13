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

  it("offers only supported session backends and no credential fields", async () => {
    render(<HappierRuntimeCard />);
    const select = await screen.findByLabelText("Selected backend");
    expect(Array.from((select as HTMLSelectElement).options).map((option) => option.value)).toEqual(["codex", "claude", "opencode"]);
    expect(screen.queryByLabelText(/token|api key|password/i)).toBeNull();
    expect(screen.getByText(/credentials are deliberately not accepted/i)).toBeTruthy();
  });

  it("probes once on mount and does not spawn another probe after save-only", async () => {
    render(<HappierRuntimeCard />);
    await waitFor(() => expect(fetchHappierStatus).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(updatePluginSettings).toHaveBeenCalledTimes(1));
    expect(fetchHappierStatus).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const commandHandlers = vi.hoisted(() => ({
  runInit: vi.fn(),
  runProjectList: vi.fn(),
}));

vi.mock("../commands/dashboard.js", () => {
  throw new Error("Missing dashboard-only optional plugin artifact");
});

vi.mock("../commands/onboard-autolaunch.js", () => ({
  maybeAutoLaunchOnboarding: vi.fn(),
}));

vi.mock("../commands/init.js", () => ({
  runInit: commandHandlers.runInit,
}));

vi.mock("../commands/project.js", () => ({
  runProjectList: commandHandlers.runProjectList,
}));

const originalArgv = process.argv;
const originalPiPackageDir = process.env.PI_PACKAGE_DIR;
let importCounter = 0;

async function runBin(args: string[]): Promise<void> {
  process.argv = ["node", "bin.ts", ...args];
  importCounter += 1;
  await import(/* @vite-ignore */ `../bin.ts?command-isolation=${importCounter}`);
}

describe("bin command handler isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PI_PACKAGE_DIR = "bin-command-isolation";
  });

  afterEach(() => {
    process.argv = originalArgv;
    if (originalPiPackageDir === undefined) {
      delete process.env.PI_PACKAGE_DIR;
    } else {
      process.env.PI_PACKAGE_DIR = originalPiPackageDir;
    }
  });

  it("dispatches init when the dashboard-only handler artifact is unavailable", async () => {
    await runBin(["init", "--name", "isolated-project"]);

    expect(commandHandlers.runInit).toHaveBeenCalledWith({
      name: "isolated-project",
      path: undefined,
      git: false,
    });
  });

  it("dispatches project list when the dashboard-only handler artifact is unavailable", async () => {
    await runBin(["project", "list", "--json"]);

    expect(commandHandlers.runProjectList).toHaveBeenCalledWith({ json: true });
  });
});

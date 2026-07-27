import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  terminateTestProcessTree,
  type TestProcessTreeCleanupResult,
} from "../../../core/src/__test-utils__/vitest-teardown.js";

export type CliHostCommand = "dashboard" | "serve" | "daemon";

const LOOPBACK_HOST = "127.0.0.1";
const RESERVED_OPERATOR_PORTS = new Set([
  4040,
  18287,
  52211,
  9871,
  26965,
]);
const CHILD_COMMAND_ENV = "FUSION_CLI_OUTPUT_PROOF_COMMAND";
const STARTUP_TIMEOUT_MS = 90_000;
const CLEANUP_TIMEOUT_MS = 20_000;

export const SEARCHABLE_SEVERITY_PROOF_LINES: Record<
  CliHostCommand,
  readonly string[]
> = {
  dashboard: [
    "[fnlvl=info] [cli-process-output-proof] dashboard:info",
    "[fnlvl=warn] [cli-process-output-proof] dashboard:warn",
    "[fnlvl=error] [cli-process-output-proof] dashboard:error",
  ],
  serve: [
    "[fnlvl=info] [cli-process-output-proof] serve:info",
    "[fnlvl=warn] [cli-process-output-proof] serve:warn",
    "[fnlvl=error] [cli-process-output-proof] serve:error",
  ],
  daemon: [
    "[fnlvl=info] [cli-process-output-proof] daemon:info",
    "[fnlvl=warn] [cli-process-output-proof] daemon:warn",
    "[fnlvl=error] [cli-process-output-proof] daemon:error",
  ],
};

export const NON_TTY_PROOF_LINES: Record<CliHostCommand, string> = {
  dashboard:
    "[fnlvl=info] [cli-process-output-proof] dashboard:stdio stdoutTTY=false stderrTTY=false",
  serve:
    "[fnlvl=info] [cli-process-output-proof] serve:stdio stdoutTTY=false stderrTTY=false",
  daemon:
    "[fnlvl=info] [cli-process-output-proof] daemon:stdio stdoutTTY=false stderrTTY=false",
};

export interface RunCliHostUntilReadyInput {
  readonly command: CliHostCommand;
  readonly databaseUrl: string;
  readonly token: string;
  readonly extraArgs?: readonly string[];
}

export interface CliHostProcessResult {
  readonly port: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly stdoutText: string;
  readonly stderrText: string;
  readonly combinedText: string;
  readonly cleanup: TestProcessTreeCleanupResult;
}

async function reserveUnprotectedPort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, LOOPBACK_HOST, () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("OS port reservation returned no numeric address"));
          return;
        }
        resolve(address.port);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (!RESERVED_OPERATOR_PORTS.has(port)) return port;
  }
  throw new Error("Unable to reserve a port outside the operator-protected set");
}

function isReady(
  command: CliHostCommand,
  port: number,
  stdoutText: string,
): boolean {
  const commandBanner = {
    dashboard: "fn board",
    serve: "Fusion Node",
    daemon: "Fusion Daemon",
  } satisfies Record<CliHostCommand, string>;
  return (
    stdoutText.includes(commandBanner[command]) &&
    stdoutText.includes(`:${port}`) &&
    stdoutText.includes("Press Ctrl+C to stop")
  );
}

function createChildEnv(input: {
  command: CliHostCommand;
  databaseUrl: string;
  homeDir: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.PORT;
  delete env.FUSION_SERVER_PORT;
  delete env.FUSION_DASHBOARD_TOKEN;
  delete env.FUSION_DAEMON_TOKEN;
  delete env.FUSION_TEST_MODE;
  delete env.FUSION_TEST_DATABASE_URL;
  delete env.FUSION_TEST_DATABASE_MIGRATION_URL;
  delete env.FUSION_TEST_WORKER_ROOT;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;

  return {
    ...env,
    [CHILD_COMMAND_ENV]: input.command,
    DATABASE_URL: input.databaseUrl,
    DATABASE_MIGRATION_URL: input.databaseUrl,
    FUSION_SKIP_ONBOARDING: "1",
    FUSION_NO_UPDATE_CHECK: "1",
    FUSION_CLI_SKIP_MAIN: "0",
    FUSION_RESTART_SUPERVISED: "1",
    FUSION_SUPERVISOR_PID: String(process.pid),
    VITEST: "false",
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    HOME: input.homeDir,
    USERPROFILE: input.homeDir,
    APPDATA: join(input.homeDir, "AppData", "Roaming"),
    LOCALAPPDATA: join(input.homeDir, "AppData", "Local"),
    TMP: join(input.homeDir, "tmp"),
    TEMP: join(input.homeDir, "tmp"),
  };
}

function waitForClose(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once("close", finish);
  });
}

async function cleanupChildTree(
  child: ChildProcessWithoutNullStreams,
  startedAt: number,
): Promise<TestProcessTreeCleanupResult> {
  if (!child.pid) {
    throw new Error("CLI process did not expose a PID for bounded cleanup");
  }
  const cleanup = await terminateTestProcessTree(child.pid, {
    startedAt,
    timeoutMs: CLEANUP_TIMEOUT_MS,
    protectedPids: [process.pid, process.ppid],
    killRoot: () => {
      try {
        if (process.platform === "win32") {
          child.kill("SIGKILL");
        } else {
          process.kill(-child.pid!, "SIGKILL");
        }
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          // The exact child root already exited.
        }
      }
    },
  });
  await waitForClose(child, CLEANUP_TIMEOUT_MS);
  return cleanup;
}

export async function runCliHostUntilReady(
  input: RunCliHostUntilReadyInput,
): Promise<CliHostProcessResult> {
  const port = await reserveUnprotectedPort();
  const baseDir = process.env.FUSION_TEST_WORKER_ROOT ?? tmpdir();
  const fixtureRoot = await mkdtemp(join(baseDir, "fusion-cli-output-"));
  const projectDir = join(fixtureRoot, "project");
  const homeDir = join(fixtureRoot, "home");
  await mkdir(projectDir, { recursive: true });
  await mkdir(join(homeDir, "tmp"), { recursive: true });
  await mkdir(join(homeDir, "AppData", "Roaming"), { recursive: true });
  await mkdir(join(homeDir, "AppData", "Local"), { recursive: true });

  const entryPath = fileURLToPath(
    new URL("./process-output-child.mjs", import.meta.url),
  );
  const args = [
    entryPath,
    input.command,
    "--port",
    String(port),
    "--host",
    LOOPBACK_HOST,
    "--token",
    input.token,
    ...(input.extraArgs ?? []),
  ];
  const startedAt = Date.now();
  const child = spawn(process.execPath, args, {
    cwd: projectDir,
    env: createChildEnv({
      command: input.command,
      databaseUrl: input.databaseUrl,
      homeDir,
    }),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
    timeout: STARTUP_TIMEOUT_MS + CLEANUP_TIMEOUT_MS + 5_000,
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer | string) => {
    stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  let cleanup: TestProcessTreeCleanupResult | null = null;
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const inspect = () => {
        const stdoutText = Buffer.concat(stdoutChunks).toString("utf8");
        if (isReady(input.command, port, stdoutText)) finish();
      };
      const timer = setTimeout(() => {
        finish(
          new Error(
            `${input.command} startup timed out after ${STARTUP_TIMEOUT_MS}ms\n` +
              `stdout:\n${Buffer.concat(stdoutChunks).toString("utf8")}\n` +
              `stderr:\n${Buffer.concat(stderrChunks).toString("utf8")}`,
          ),
        );
      }, STARTUP_TIMEOUT_MS);

      child.stdout.on("data", inspect);
      child.once("error", (error) => finish(error));
      child.once("close", (code, signal) => {
        finish(
          new Error(
            `${input.command} exited before readiness (code=${code}, signal=${signal})\n` +
              `stdout:\n${Buffer.concat(stdoutChunks).toString("utf8")}\n` +
              `stderr:\n${Buffer.concat(stderrChunks).toString("utf8")}`,
          ),
        );
      });
    });
  } finally {
    try {
      cleanup = await cleanupChildTree(child, startedAt);
    } finally {
      await rm(fixtureRoot, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  }

  const stdout = Buffer.concat(stdoutChunks);
  const stderr = Buffer.concat(stderrChunks);
  return {
    port,
    stdout,
    stderr,
    stdoutText: stdout.toString("utf8"),
    stderrText: stderr.toString("utf8"),
    combinedText: `${stdout.toString("utf8")}\n${stderr.toString("utf8")}`,
    cleanup,
  };
}

import { spawn, type ChildProcess } from "node:child_process";

export type SupervisedServerCommand = "dashboard" | "serve" | "daemon";

const SUPERVISE_MAX_RESTARTS = 3;
const SUPERVISE_BASE_DELAY_MS = 2_000;
const SUPERVISE_MAX_DELAY_MS = 16_000;
const SUPERVISE_STALE_RESET_MS = 60_000;

/*
FNXC:ServerSupervisor 2026-07-27-03:54:
Keep this lightweight CLI supervisor contract aligned with
FUSION_RESTART_EXIT_CODE in @fusion/core and the source-dev wrapper. Exit 86
is an intentional System restart, so it respawns immediately and resets the
crash budget instead of being classified as a fault.
*/
export const SERVER_RESTART_EXIT_CODE = 86;
export const SERVER_NON_RETRYABLE_EXIT_CODE = 87;

export interface SupervisedChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ServerSupervisorLoopInput {
  readonly command: SupervisedServerCommand;
  readonly port: number;
  readonly spawnChild: () => Promise<SupervisedChildExit>;
  readonly sleep: (delayMs: number) => Promise<void>;
  readonly now: () => number;
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
  readonly restartCommand: string;
  readonly shouldStop?: () => boolean;
}

export interface ServerSupervisorLoopResult {
  readonly exitCode: number;
  readonly crashRestarts: number;
}

export function buildSupervisedChildEnv(
  env: NodeJS.ProcessEnv = process.env,
  supervisorPid: number = process.pid,
): NodeJS.ProcessEnv {
  return {
    ...env,
    FUSION_RESTART_SUPERVISED: "1",
    FUSION_SUPERVISOR_PID: String(supervisorPid),
  };
}

export function buildSupervisedChildArgs(
  command: SupervisedServerCommand,
  args: readonly string[],
): string[] {
  const childArgs = args.filter(
    (arg) => arg !== "--supervise" && arg !== "--no-supervise",
  );
  if (!childArgs.includes(command)) {
    const firstOptionIndex = childArgs.findIndex((arg) => arg.startsWith("-"));
    childArgs.splice(firstOptionIndex === -1 ? 0 : firstOptionIndex, 0, command);
  }
  return childArgs;
}

export async function runServerSupervisorLoop(
  input: ServerSupervisorLoopInput,
): Promise<ServerSupervisorLoopResult> {
  let restartCount = 0;
  let crashRestarts = 0;
  let lastExitTime = 0;

  while (true) {
    input.log(
      `[${input.command}:supervisor] starting ${input.command} (attempt ${restartCount + 1}/${SUPERVISE_MAX_RESTARTS + 1})`,
    );
    const exit = await input.spawnChild();
    const exitCode = exit.code ?? 1;

    if (input.shouldStop?.()) {
      return { exitCode: 0, crashRestarts };
    }

    if (exit.signal === "SIGINT" || exit.signal === "SIGTERM" || exitCode === 0) {
      return { exitCode: 0, crashRestarts };
    }

    if (exitCode === SERVER_RESTART_EXIT_CODE) {
      input.log(`[${input.command}:supervisor] restart requested — restarting now`);
      restartCount = 0;
      lastExitTime = 0;
      continue;
    }

    if (exitCode === SERVER_NON_RETRYABLE_EXIT_CODE) {
      input.error(
        `[${input.command}:supervisor] ${input.command} reported a non-retryable startup failure`,
      );
      return { exitCode, crashRestarts };
    }

    const now = input.now();
    if (now - lastExitTime > SUPERVISE_STALE_RESET_MS) {
      restartCount = 0;
    }
    lastExitTime = now;
    restartCount += 1;
    crashRestarts += 1;

    if (restartCount > SUPERVISE_MAX_RESTARTS) {
      input.error(
        `[${input.command}:supervisor] ${input.command} exhausted its crash budget; restart manually with: ${input.restartCommand}`,
      );
      return { exitCode: 1, crashRestarts };
    }

    const delay = Math.min(
      SUPERVISE_BASE_DELAY_MS * Math.pow(2, restartCount - 1),
      SUPERVISE_MAX_DELAY_MS,
    );
    input.log(
      `[${input.command}:supervisor] restarting in ${Math.round(delay / 1_000)}s (attempt ${restartCount}/${SUPERVISE_MAX_RESTARTS})`,
    );
    await input.sleep(delay);
  }
}

export function hasLiveSupervisingParent(
  env: NodeJS.ProcessEnv = process.env,
  ppid: number = process.ppid,
): boolean {
  if (env.FUSION_RESTART_SUPERVISED !== "1") return false;
  const declaredPid = env.FUSION_SUPERVISOR_PID;
  if (!declaredPid) return false;
  const parsed = Number.parseInt(declaredPid, 10);
  return Number.isFinite(parsed) && parsed === ppid;
}

export interface HostSystemRestartControl {
  readonly systemControl: {
    readonly supervised: boolean;
    readonly requestRestart: (reason: string) => boolean;
  };
  readonly bindShutdown: (
    shutdown: (exitCode: number) => void | Promise<void>,
  ) => void;
}

/*
FNXC:ServerSupervisor 2026-07-27-03:54:
Serve and daemon construct the HTTP server before their full graceful-shutdown
closures exist. Late-bind that closure, accept at most one restart request, and
only advertise success when a live parent will translate exit 86 into a new
child. The short scheduling seam lets the HTTP 202 response flush first.
*/
export function createHostSystemRestartControl(input: {
  readonly supervised: boolean;
  readonly canRestart: () => boolean;
  readonly schedule?: (callback: () => void) => void;
  readonly log: (message: string) => void;
  readonly error?: (message: string) => void;
}): HostSystemRestartControl {
  let restartScheduled = false;
  let shutdownHandler:
    | ((exitCode: number) => void | Promise<void>)
    | null = null;
  const schedule =
    input.schedule ??
    ((callback: () => void) => {
      setTimeout(callback, 300);
    });

  return {
    systemControl: {
      supervised: input.supervised,
      requestRestart: (reason: string): boolean => {
        if (
          !input.supervised ||
          !input.canRestart() ||
          restartScheduled ||
          !shutdownHandler
        ) {
          return false;
        }
        restartScheduled = true;
        input.log(
          `restart requested (${reason}) — shutting down for supervised respawn`,
        );
        schedule(() => {
          void Promise.resolve(
            shutdownHandler?.(SERVER_RESTART_EXIT_CODE),
          ).catch((error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error);
            input.error?.(`graceful restart shutdown failed: ${message}`);
          });
        });
        return true;
      },
    },
    bindShutdown: (shutdown): void => {
      shutdownHandler = shutdown;
    },
  };
}

/**
 * FNXC:ServerSupervisor 2026-07-27-03:54:
 * All long-lived host commands use supervision by default. A live parent stamp
 * or an attached inspector is the only supported opt-out; daemon token-only
 * mode is not a long-lived host. The former `--no-supervise` flag is ignored
 * and stripped from child argv so an operator cannot silently disable recovery.
 */
export function shouldSuperviseServerCommand(
  command: SupervisedServerCommand,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv,
  ppid: number = process.ppid,
): boolean {
  if (command === "daemon" && args.includes("--token-only")) return false;
  if (hasLiveSupervisingParent(env, ppid)) return false;
  if (execArgv.some((arg) => arg.startsWith("--inspect"))) return false;
  return resolveSupervisorRespawnCommand() !== null;
}

function isCompiledBinary(): boolean {
  const bun = (globalThis as { Bun?: { embeddedFiles?: unknown } }).Bun;
  return typeof bun !== "undefined" && Boolean(bun.embeddedFiles);
}

/**
 * Resolve the current CLI entry across source, npm/npx, and compiled-binary
 * install shapes.
 */
export function resolveSupervisorRespawnCommand(): {
  command: string;
  args: string[];
} | null {
  if (isCompiledBinary()) {
    return { command: process.execPath, args: [] };
  }
  const entryPoint = process.argv[1];
  if (!entryPoint) return null;
  return {
    command: process.execPath,
    args: [...process.execArgv, entryPoint],
  };
}

/**
 * FNXC:ServerSupervisor 2026-07-27-03:54:
 * Production and source-development serve/daemon launches share this attached
 * foreground supervisor while retaining Dashboard's established exit-code
 * contract. The real parent pid is stamped into every child, System restart is
 * immediate, one ordinary crash is relaunched, and four failures inside the
 * rolling window exhaust the three-restart budget. The child stays attached so
 * TTY ownership and Ctrl+C behavior remain intact.
 */
export async function runServerCommandSupervised(
  command: SupervisedServerCommand,
  port: number,
): Promise<void> {
  const childArgs = buildSupervisedChildArgs(command, process.argv.slice(2));
  const respawn = resolveSupervisorRespawnCommand();
  if (!respawn) {
    console.error(
      `[${command}:supervisor] cannot determine entry point for child process`,
    );
    process.exit(1);
  }

  const restartCommand = formatSupervisorRestartCommand(
    respawn.command,
    respawn.args,
    childArgs,
  );
  let activeChild: AttachedChild | null = null;
  let stopping = false;

  const onSigint = (): void => {
    stopping = true;
    if (!activeChild) process.exit(130);
  };
  const onSigterm = (): void => {
    stopping = true;
    if (!activeChild) process.exit(143);
    try {
      activeChild.child.kill("SIGTERM");
    } catch {
      // The child may already have closed between the signal and forwarding.
    }
  };
  const onExit = (): void => {
    try {
      activeChild?.child.kill("SIGTERM");
    } catch {
      // Best-effort parent-death cleanup only.
    }
  };

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("exit", onExit);

  try {
    const result = await runServerSupervisorLoop({
      command,
      port,
      restartCommand,
      shouldStop: () => stopping,
      now: Date.now,
      sleep: (delayMs) =>
        new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        }),
      log: (message) => console.log(message),
      error: (message) => {
        const healthHint =
          port > 0
            ? `\nTo inspect a remaining listener: curl http://127.0.0.1:${port}/api/health`
            : "";
        console.error(`${message}${healthHint}`);
      },
      spawnChild: async () => {
        try {
          activeChild = spawnAttached(respawn.command, [
            ...respawn.args,
            ...childArgs,
          ]);
          return await activeChild.waitExit;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.error(
            `[${command}:supervisor] failed to spawn child: ${message}`,
          );
          return { code: 1, signal: null };
        } finally {
          activeChild = null;
        }
      },
    });

    if (result.exitCode !== 0) {
      process.exit(result.exitCode);
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("exit", onExit);
  }
}

interface AttachedChild {
  readonly child: ChildProcess;
  readonly waitExit: Promise<SupervisedChildExit>;
}

/*
FNXC:ServerSupervisor 2026-07-27-03:54:
The supervised host must remain in the terminal's foreground process group.
Detached process supervision is correct for background workers but causes an
interactive dashboard child to lose TTY ownership.
*/
function spawnAttached(command: string, args: string[]): AttachedChild {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: buildSupervisedChildEnv(),
  });
  const waitExit = new Promise<SupervisedChildExit>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
    child.on("error", () => resolve({ code: 1, signal: null }));
  });
  return { child, waitExit };
}

/*
FNXC:ServerSupervisor 2026-07-27-21:20:
Crash recovery writes this command to stderr. Keep explicit bearer arguments
out of that log; the restarted host can resolve its owner-only stored or
environment token instead.
*/
export function formatSupervisorRestartCommand(
  command: string,
  respawnArgs: readonly string[],
  childArgs: readonly string[],
): string {
  const safeChildArgs: string[] = [];
  for (let index = 0; index < childArgs.length; index += 1) {
    const arg = childArgs[index]!;
    if (arg === "--token") {
      const value = childArgs[index + 1];
      if (value && !value.startsWith("-")) index += 1;
      continue;
    }
    if (arg.startsWith("--token=")) continue;
    safeChildArgs.push(arg);
  }
  return [command, ...respawnArgs, ...safeChildArgs].map(quoteShellArg).join(" ");
}

function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9_/:=.,+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

import {
  execFile,
  type ChildProcess,
  type ExecFileOptions,
} from "node:child_process";

const PROCESS_TREE_DEADLINE_MS = 2_000;
const PROCESS_TREE_RETRY_DELAYS_MS = [75, 200] as const;

type ExecFileCallback = (error: Error | null) => void;
type ExecFileFunction = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: ExecFileCallback,
) => unknown;

interface HappierProcessLifecycleDependencies {
  readonly platform?: NodeJS.Platform;
  readonly execFile?: ExecFileFunction;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

function hasExited(child: ChildProcess | undefined): boolean {
  return !child
    || typeof child.exitCode === "number"
    || typeof child.signalCode === "string";
}

function signalDirectChild(child: ChildProcess): boolean {
  try {
    return child.kill("SIGTERM");
  } catch {
    return false;
  }
}

function transientWindowsLock(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EBUSY"
    || code === "EPERM"
    || code === "ETXTBSY"
    || /\b(?:EBUSY|EPERM|ETXTBSY)\b|resource busy or locked|text file busy/iu.test(error.message);
}

function invokeTaskkill(
  exec: ExecFileFunction,
  pid: number,
  timeout: number,
): Promise<Error | null> {
  return new Promise((resolveResult) => {
    exec(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      {
        shell: false,
        timeout,
        windowsHide: true,
        maxBuffer: 64 * 1024,
      },
      (error) => resolveResult(error),
    );
  });
}

/**
 * FNXC:HappierWindowsProcessTree 2026-07-27-04:18:
 * A deadline/abort closes the whole Windows process tree. taskkill lock races
 * receive at most two short retries inside one 2-second outer budget; every
 * other error falls back once to the direct child and remains unconfirmed.
 */
export async function terminateHappierProcessTree(
  child: ChildProcess | undefined,
  dependencies: HappierProcessLifecycleDependencies = {},
): Promise<boolean> {
  if (hasExited(child)) return true;
  const activeChild = child!;
  const platform = dependencies.platform ?? process.platform;
  if (platform !== "win32" || typeof activeChild.pid !== "number") {
    return signalDirectChild(activeChild);
  }

  const execute = dependencies.execFile ?? execFile as unknown as ExecFileFunction;
  const delay = dependencies.delay ?? (async (milliseconds) => {
    await new Promise<void>((resolveDelay) => {
      const timer = setTimeout(resolveDelay, milliseconds);
      timer.unref();
    });
  });
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const elapsed = attempt === 0 ? 0 : Math.max(0, now() - startedAt);
    const remaining = Math.max(1, PROCESS_TREE_DEADLINE_MS - elapsed);
    const error = await invokeTaskkill(execute, activeChild.pid, remaining);
    if (!error) return true;
    if (attempt === 2 || !transientWindowsLock(error)) break;
    const retryDelay = PROCESS_TREE_RETRY_DELAYS_MS[attempt]!;
    if (elapsed + retryDelay >= PROCESS_TREE_DEADLINE_MS) break;
    await delay(retryDelay);
  }
  signalDirectChild(activeChild);
  return false;
}

/** Wait a bounded interval for the process close event after termination. */
export function waitForHappierProcessClose(
  child: ChildProcess | undefined,
  timeoutMs = PROCESS_TREE_DEADLINE_MS,
): Promise<boolean> {
  if (hasExited(child)) return Promise.resolve(true);
  const activeChild = child!;
  return new Promise((resolveClosed) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (closed: boolean): void => {
      activeChild.removeListener("close", onClose);
      if (timer) clearTimeout(timer);
      resolveClosed(closed);
    };
    const onClose = (): void => finish(true);
    activeChild.once("close", onClose);
    timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
  });
}

/**
 * Terminate the process tree and do not settle cleanup until the direct child
 * has emitted close (or the same bounded deadline expires).
 */
export async function terminateAndWaitHappierProcessTree(
  child: ChildProcess | undefined,
  timeoutMs = PROCESS_TREE_DEADLINE_MS,
): Promise<boolean> {
  const closeConfirmed = waitForHappierProcessClose(child, timeoutMs);
  const terminationConfirmed = await terminateHappierProcessTree(child);
  return terminationConfirmed && await closeConfirmed;
}

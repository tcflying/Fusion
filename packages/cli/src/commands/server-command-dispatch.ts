/*
 * FNXC:CliServerDispatch 2026-07-27-19:47:
 * Keep serve and daemon argument handling outside the CLI entrypoint so the
 * entrypoint remains under its enforced line-count ceiling without changing
 * authentication, supervision, or command behavior.
 */

function getFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index === -1 ? undefined : args[index + 1];
  return value && !value.startsWith("-") ? value : undefined;
}

function getPort(args: string[], fallback: number): number {
  const longIndex = args.indexOf("--port");
  const shortIndex = args.indexOf("-p");
  const index = longIndex !== -1 ? longIndex : shortIndex;
  return index === -1 ? fallback : parseInt(args[index + 1], 10);
}

export async function runServeCommand(args: string[]): Promise<void> {
  const port = getPort(args, 4040);
  const paused = args.includes("--paused");
  const interactive = args.includes("--interactive");
  const host = getFlagValue(args, "--host");
  const daemon = args.includes("--daemon");
  const noAuth = args.includes("--no-auth");
  const token = getFlagValue(args, "--token");
  const project = getFlagValue(args, "--project");
  const noAutoRegister = args.includes("--no-auto-register");

  if (noAuth) {
    const { createDashboardAuthContext } = await import("@fusion/dashboard");
    createDashboardAuthContext({ host: host ?? "127.0.0.1", noAuth: true });
  }

  const { runServerCommandSupervised, shouldSuperviseServerCommand } = await import("./server-supervisor.js");
  if (shouldSuperviseServerCommand("serve", args)) {
    await runServerCommandSupervised("serve", port);
    return;
  }

  const { runServe } = await import("./serve.js");
  await runServe(port, { paused, interactive, host, daemon, noAuth, token, project, noAutoRegister });
}

export async function runDaemonCommand(args: string[]): Promise<void> {
  const port = getPort(args, 0);
  const paused = args.includes("--paused");
  const interactive = args.includes("--interactive");
  const host = getFlagValue(args, "--host");
  const token = getFlagValue(args, "--token");
  const tokenOnly = args.includes("--token-only");
  if (args.includes("--no-auth")) {
    throw new Error("fn daemon requires bearer authentication; --no-auth is unsupported");
  }

  const project = getFlagValue(args, "--project");
  const noAutoRegister = args.includes("--no-auto-register");
  const { runServerCommandSupervised, shouldSuperviseServerCommand } = await import("./server-supervisor.js");
  if (shouldSuperviseServerCommand("daemon", args)) {
    await runServerCommandSupervised("daemon", port);
    return;
  }

  const { runDaemon } = await import("./daemon.js");
  await runDaemon({ port, paused, interactive, host, token, tokenOnly, project, noAutoRegister });
}

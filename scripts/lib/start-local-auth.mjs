import { isIP } from "node:net";

export function isLoopbackLocalHost(host) {
  const normalized = String(host).trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "localhost.") return true;
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  if (normalized.startsWith("::ffff:")) {
    return isLoopbackLocalHost(normalized.slice("::ffff:".length));
  }
  if (isIP(normalized) === 4) {
    return normalized.split(".", 1)[0] === "127";
  }
  return false;
}

/*
FNXC:LocalStartupAuth 2026-07-27-03:54:
`pnpm local` is authenticated by default on every host. The only no-auth mode
is an explicit loopback bind; wildcard, LAN, and unresolved names fail before
the startup wrapper can launch a listener.
*/
export function shouldDisableLocalAuth({ host, auth = false, noAuth = false }) {
  if (auth && noAuth) {
    throw new Error("--auth and --no-auth cannot be used together");
  }
  if (!noAuth) return false;
  if (!isLoopbackLocalHost(host)) {
    throw new Error(
      `--no-auth is only allowed for loopback hosts; "${host}" requires bearer authentication`,
    );
  }
  return true;
}

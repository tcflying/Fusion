import { isIP } from "node:net";

export type DashboardAuthContext =
  | {
      readonly mode: "bearer";
      readonly host: string;
      readonly token: string;
    }
  | {
      readonly mode: "loopback-no-auth";
      readonly host: string;
    };

export interface CreateDashboardAuthContextInput {
  readonly host: string;
  readonly noAuth?: boolean;
  readonly token?: string;
}

export interface DashboardAuthContextOptions {
  readonly dashboardAuthContext?: DashboardAuthContext;
  readonly daemon?: { readonly token: string };
  readonly noAuth?: boolean;
}

export function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "localhost.") return true;
  if (normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") return true;
  if (normalized.startsWith("::ffff:")) {
    return isLoopbackBindHost(normalized.slice("::ffff:".length));
  }
  if (isIP(normalized) === 4) {
    return normalized.split(".", 1)[0] === "127";
  }
  return false;
}

/**
 * Build the host-owned authentication contract before Express is composed.
 *
 * FNXC:DashboardAuthContext 2026-07-27-03:54:
 * Bearer auth is the default for dashboard, serve, and daemon on every bind
 * host. Explicit no-auth is accepted only on a proven loopback address; LAN,
 * wildcard, and unresolved hostnames fail closed before any listener starts.
 */
export function createDashboardAuthContext(
  input: CreateDashboardAuthContextInput,
): DashboardAuthContext {
  const host = input.host.trim();
  if (input.noAuth) {
    if (!isLoopbackBindHost(host)) {
      throw new Error(
        `--no-auth is only allowed for loopback hosts; "${host}" requires bearer authentication`,
      );
    }
    return { mode: "loopback-no-auth", host };
  }
  if (!input.token) {
    throw new Error(`Bearer token is required for Dashboard host "${host}"`);
  }
  return { mode: "bearer", host, token: input.token };
}

/**
 * Resolve one shared request-authentication contract for middleware, WebSocket
 * upgrades, and sensitive host routes. Legacy daemon options remain readable,
 * but a bare `noAuth` flag is intentionally not enough to prove loopback.
 */
export function resolveDashboardAuthContext(
  options?: DashboardAuthContextOptions,
): DashboardAuthContext | undefined {
  if (options?.dashboardAuthContext) return options.dashboardAuthContext;
  if (options?.noAuth) return undefined;
  const token = options?.daemon?.token ?? process.env.FUSION_DAEMON_TOKEN;
  return token ? { mode: "bearer", host: "legacy-host", token } : undefined;
}

export function getDashboardBearerToken(
  options?: DashboardAuthContextOptions,
): string | undefined {
  const context = resolveDashboardAuthContext(options);
  return context?.mode === "bearer" ? context.token : undefined;
}

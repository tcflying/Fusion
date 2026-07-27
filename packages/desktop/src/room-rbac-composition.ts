import type { AsyncDataLayer, RoomRbacRegistry } from "@fusion/core";
import type { ServerOptions } from "@fusion/dashboard";

export const DESKTOP_LOCAL_BIND_HOST = "127.0.0.1";

type HeaderValue = string | readonly string[] | undefined;

interface DesktopRoomRequest {
  readonly headers: Record<string, HeaderValue>;
  readonly socket: {
    readonly localAddress?: string;
    readonly localPort?: number;
  };
}

interface DesktopRoomProjectEngine {
  getTaskStore(): {
    getAsyncLayer(): AsyncDataLayer | null;
  };
}

interface DesktopRoomEngineManager {
  getEngine(projectId: string): DesktopRoomProjectEngine | null | undefined;
}

export interface CreateDesktopRoomRbacOptionsInput {
  readonly engineManager: DesktopRoomEngineManager;
  readonly createRegistry: (layer: AsyncDataLayer) => RoomRbacRegistry;
}

type DesktopRoomRbacOptions = NonNullable<ServerOptions["roomControlPlaneRbac"]>;

function readSingleHeader(request: DesktopRoomRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function isAcceptedLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === DESKTOP_LOCAL_BIND_HOST
    || normalized === "::1"
    || normalized === "0:0:0:0:0:0:0:1"
    || normalized === `::ffff:${DESKTOP_LOCAL_BIND_HOST}`;
}

export function resolveDesktopRoomPublicOrigin(request: DesktopRoomRequest): string {
  const port = request.socket.localPort;
  if (!isAcceptedLoopbackAddress(request.socket.localAddress)
    || !Number.isInteger(port)
    || port === undefined
    || port < 1
    || port > 65_535) {
    throw new Error("Desktop Room RBAC requires a bound loopback listener.");
  }
  return `http://${DESKTOP_LOCAL_BIND_HOST}:${port}`;
}

function authorizeDesktopRoomAdministrationTransport(request: DesktopRoomRequest): boolean {
  let publicOrigin: string;
  try {
    publicOrigin = resolveDesktopRoomPublicOrigin(request);
  } catch {
    return false;
  }
  const expectedHost = new URL(publicOrigin).host;
  return readSingleHeader(request, "host")?.toLowerCase() === expectedHost
    && readSingleHeader(request, "origin") === publicOrigin
    && readSingleHeader(request, "sec-fetch-site") === "same-origin";
}

/*
FNXC:DesktopRoomRbacComposition 2026-07-27-15:23:
The packaged Windows desktop binds its embedded server to loopback and resolves the exact
OS-assigned origin from the accepted socket. Room authorization must reuse each already-started
ProjectEngine's PostgreSQL-backed trusted-device registry; an authorization request must never
start an Engine. The explicit same-origin administration gate only exposes the existing durable
session issuer, while every Room read/write still requires a paired, unrevoked, sufficiently
privileged trusted-device Cookie, independent of Dashboard `--no-auth`.
*/
export function createDesktopRoomRbacOptions(
  input: CreateDesktopRoomRbacOptionsInput,
): DesktopRoomRbacOptions {
  const registries = new Map<string, {
    readonly layer: AsyncDataLayer;
    readonly registry: RoomRbacRegistry;
  }>();

  return {
    resolveRegistry: ({ projectId }) => {
      let layer: AsyncDataLayer;
      try {
        const engine = input.engineManager.getEngine(projectId);
        if (!engine) return undefined;
        const resolvedLayer = engine.getTaskStore().getAsyncLayer();
        if (!resolvedLayer) return undefined;
        layer = resolvedLayer;
      } catch {
        return undefined;
      }

      const cached = registries.get(projectId);
      if (cached?.layer === layer) return cached.registry;
      const registry = input.createRegistry(layer);
      registries.set(projectId, { layer, registry });
      return registry;
    },
    resolvePublicOrigin: resolveDesktopRoomPublicOrigin,
    allowLoopbackHttp: true,
    authorizeDaemonTransport: authorizeDesktopRoomAdministrationTransport,
  };
}

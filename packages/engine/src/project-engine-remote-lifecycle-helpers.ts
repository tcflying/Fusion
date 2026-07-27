/**
 * FNXC:RemoteAccess 2026-07-27-17:02:
 * FUS-P1-009 keeps ProjectEngine's remote lifecycle checks and diagnostics
 * behavior-identical while moving their pure shapes and formatting helpers
 * out of the lifecycle owner.
 */
import type { Settings } from "@fusion/core";
import type {
  TunnelProvider,
  TunnelProviderConfig,
  TunnelRestoreReasonCode,
} from "./remote-access/types.js";

export interface RemoteLifecycleEvaluation {
  provider: TunnelProvider;
  config?: TunnelProviderConfig;
  reason?: TunnelRestoreReasonCode;
  message?: string;
}

export const isRemoteActive = (remoteAccess: Settings["remoteAccess"] | undefined): boolean =>
  remoteAccess?.activeProvider != null
  && (remoteAccess.providers[remoteAccess.activeProvider]?.enabled ?? false);

export function formatErrorDetails(error: unknown): { message: string; detail: string } {
  if (error instanceof Error) {
    return {
      message: error.message || error.name,
      detail: error.stack ?? `${error.name}: ${error.message}`,
    };
  }
  const detail = String(error);
  return { message: detail, detail };
}

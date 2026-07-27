import type { SessionConnectorHealthReasonCode } from "@fusion/core";

const HAPPIER_HEALTH_REASON_MAP: Readonly<Record<string, SessionConnectorHealthReasonCode>> = {
  "executable-unavailable": "executable_unavailable",
  "executable-timeout": "executable_timeout",
  "executable-not-found": "executable_not_found",
  "authentication-required": "authentication_required",
  "authentication-timeout": "authentication_timeout",
  "authentication-invalid": "authentication_invalid",
  "server-unreachable": "server_unreachable",
  "server-not-probed": "server_not_probed",
  "daemon-stopped": "daemon_stopped",
  "status-timeout": "status_timeout",
  "status-invalid": "status_invalid",
  "backend-unavailable": "backend_unavailable",
  "backend-timeout": "backend_timeout",
  "backend-invalid": "backend_invalid",
  "backend-config-invalid": "backend_invalid",
  "backend-machine-availability-unverified": "backend_machine_availability_unverified",
  "cli-attestation-failed": "cli_attestation_failed",
  "rate-limited": "rate_limited",
};

export function typedHappierHealthReasonCodes(
  details: readonly unknown[],
): SessionConnectorHealthReasonCode[] {
  return [...new Set(details.flatMap((detail) =>
    typeof detail === "string" && HAPPIER_HEALTH_REASON_MAP[detail]
      ? [HAPPIER_HEALTH_REASON_MAP[detail]]
      : [],
  ))];
}

import type {
  SessionConnectorResultV1,
} from "@fusion/core";

import {
  happierApprovalFailureFromError,
} from "./approval-state-store.js";
import type {
  HappierCliAttestation,
} from "./cli-attestation.js";
import { HAPPIER_LOCAL_DIRECT_SESSION_EXTENSION_STATE } from "./happier-direct-session-capabilities.js";
import type {
  HappierMcpClient,
  HappierMcpClientFactory,
} from "./happier-mcp-client.js";
import {
  HappierCliError,
  type HappierCliSettings,
  type HappierJsonRecord,
} from "./types.js";

const HAPPIER_MCP_CAPABILITY_REQUIRED = "official_mcp_capability_required";

export type HappierConnectorErrorCode =
  | "unavailable"
  | "unverified"
  | "degraded"
  | "invalid_request"
  | "authentication_required"
  | "not_found"
  | "ambiguous"
  | "host_unavailable"
  | "rate_limited"
  | "conflict"
  | "transport"
  | "delivery_uncertain"
  | "internal";

export function isHappierJsonRecord(value: unknown): value is HappierJsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function nonEmptyHappierString(
  value: unknown,
  maximum = 2_000,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (
    !trimmed
    || trimmed.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

export function happierConnectorFailure<T>(
  code: HappierConnectorErrorCode,
  message: string,
  retryable: boolean,
  safeDetails?: Readonly<Record<string, unknown>>,
): SessionConnectorResultV1<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      retryable,
      ...(safeDetails ? { safeDetails } : {}),
    },
  };
}

export function unsupportedHappierOperation<T>(
  operation: string,
): SessionConnectorResultV1<T> {
  return happierConnectorFailure(
    "unavailable",
    `Happier MCP does not expose a certified ${operation} operation for provider-native sessions`,
    false,
    {
      bridge: "official_mcp_stdio",
      localExtensionState: HAPPIER_LOCAL_DIRECT_SESSION_EXTENSION_STATE,
    },
  );
}

export function missingHappierTools(
  available: ReadonlySet<string>,
  required: readonly string[],
): string[] {
  return required.filter((tool) => !available.has(tool));
}

export function validatedHappierToolNames(
  tools: readonly { name: string }[],
): Set<string> {
  return new Set(tools.map((tool) => tool.name));
}

export function happierMcpCapabilityRequired<T>(
  missingTools: readonly string[],
): SessionConnectorResultV1<T> {
  return happierConnectorFailure(
    "unavailable",
    "The official Happier MCP server does not expose the required Session control tool. Update or enable the Happier MCP external surface, then bind the session again in Direct UI.",
    false,
    {
      bindingState: HAPPIER_MCP_CAPABILITY_REQUIRED,
      bridge: "official_mcp_stdio",
      missingTools: [...missingTools].sort(),
      localExtensionState: HAPPIER_LOCAL_DIRECT_SESSION_EXTENSION_STATE,
    },
  );
}

export class HappierReceiptReconciliationError extends Error {
  readonly name = "HappierReceiptReconciliationError";

  constructor(readonly reason: string) {
    super("Happier send receipt requires exact identity reconciliation");
  }
}

export function mapHappierMcpFailure<T>(
  error: unknown,
  bridge = "official_mcp_stdio",
  happierSessionId?: string,
): SessionConnectorResultV1<T> {
  if (error instanceof HappierReceiptReconciliationError) {
    return happierConnectorFailure(
      "delivery_uncertain",
      "Happier send evidence could not be bound to the exact Session and localId",
      false,
      {
        state: "happier_receipt_reconciliation_required",
        reason: error.reason,
      },
    );
  }
  const approvalFailure = happierApprovalFailureFromError<T>(
    error,
    bridge,
    happierSessionId,
  );
  if (approvalFailure) return approvalFailure;
  if (!(error instanceof HappierCliError)) {
    return happierConnectorFailure(
      "internal",
      "Happier MCP connector operation failed",
      false,
    );
  }
  if (error.officialCode?.startsWith("cli_")) {
    return happierConnectorFailure(
      "degraded",
      "Happier CLI supply-chain attestation failed closed",
      false,
      {
        bridge,
        category: "cli_attestation",
        reasonCode: error.officialCode,
      },
    );
  }
  const details = { bridge, category: error.code };
  if (error.code === "authentication") {
    return happierConnectorFailure(
      "authentication_required",
      "Happier authentication is required",
      false,
      details,
    );
  }
  if (error.code === "session") {
    return happierConnectorFailure(
      "not_found",
      "The bound Happier Session was not found",
      false,
      details,
    );
  }
  if (error.code === "timeout") {
    return happierConnectorFailure(
      "transport",
      "Happier MCP request timed out",
      true,
      details,
    );
  }
  if (
    error.code === "process"
    || error.code === "server"
    || error.code === "daemon"
    || error.code === "backend"
  ) {
    return happierConnectorFailure(
      "transport",
      "Happier MCP transport is unavailable",
      true,
      details,
    );
  }
  return happierConnectorFailure(
    "degraded",
    "Happier MCP returned an invalid response",
    false,
    details,
  );
}

export interface HappierSessionTransportDependencies {
  readonly openMcpClient: HappierMcpClientFactory;
  readonly attestCli: (
    settings: HappierCliSettings,
  ) => Promise<HappierCliAttestation>;
}

/*
 * FNXC:HappierSessionConnectorTransport 2026-07-27-17:57:
 * Every connector operation must share one attested MCP open/close boundary.
 * Focused controllers may choose their result projection, but none may bypass
 * CLI attestation or leak an MCP process after success or failure.
 */
export class HappierSessionConnectorTransport {
  constructor(
    readonly settings: Readonly<HappierCliSettings>,
    private readonly dependencies: HappierSessionTransportDependencies,
  ) {}

  async assertCliAttested(): Promise<void> {
    const attestation = await this.dependencies.attestCli(this.settings);
    if (!attestation.ok) {
      throw new HappierCliError(
        "process",
        "Happier CLI supply-chain attestation failed closed",
        undefined,
        attestation.reasonCode,
      );
    }
  }

  async openClient(sessionId: string): Promise<HappierMcpClient> {
    await this.assertCliAttested();
    return this.dependencies.openMcpClient({
      settings: this.settings,
      sessionId,
    });
  }

  async withClient<T>(
    sessionId: string,
    operation: (client: HappierMcpClient) => Promise<T>,
  ): Promise<T> {
    let client: HappierMcpClient | undefined;
    try {
      client = await this.openClient(sessionId);
      return await operation(client);
    } finally {
      await client?.close().catch(() => undefined);
    }
  }

  async withOfficialMcp<T>(
    sessionId: string,
    requiredTools: readonly string[],
    operation: (
      client: HappierMcpClient,
      available: ReadonlySet<string>,
    ) => Promise<T>,
  ): Promise<SessionConnectorResultV1<T>> {
    let client: HappierMcpClient | undefined;
    try {
      client = await this.openClient(sessionId);
      const available = validatedHappierToolNames(await client.listTools());
      const missing = missingHappierTools(available, requiredTools);
      if (missing.length > 0) return happierMcpCapabilityRequired(missing);
      return { ok: true, value: await operation(client, available) };
    } catch (error) {
      return mapHappierMcpFailure(error, "official_mcp_stdio", sessionId);
    } finally {
      await client?.close().catch(() => undefined);
    }
  }
}

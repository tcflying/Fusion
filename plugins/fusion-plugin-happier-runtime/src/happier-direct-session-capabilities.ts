import { createHash } from "node:crypto";

import type {
  SessionConnectorCapabilityName,
  SessionConnectorCapabilityReasonCode,
  SessionConnectorCapabilityState,
} from "@fusion/core";

export const HAPPIER_DIRECT_SESSION_SOURCE_REVISION = "f07b7317cd4c7f0cfa762189dc68d16750a48182";
export const HAPPIER_DIRECT_SESSION_PROVIDER_IDS = ["codex", "claude", "opencode"] as const;

/**
 * Exact Git blobs audited at HAPPIER_DIRECT_SESSION_SOURCE_REVISION. Keeping
 * these beside the matrix makes every Happier sourceRef independently
 * reproducible instead of treating the reviewed commit as an opaque claim.
 */
export const HAPPIER_DIRECT_SESSION_SOURCE_BLOBS: Readonly<Record<string, string>> = Object.freeze({
  "apps/cli/src/api/directSessions/ensure/ensureDirectSessionFromUri.ts": "43cae752de60fbf9593b7058828819ac623b8992",
  "apps/cli/src/backends/claude/directSessions/providerOps.ts": "9cdba651c54bdc1c479c6268c4b12abb01106a98",
  "apps/cli/src/backends/codex/directSessions/providerOps.ts": "e9b112149ae67a4ac782f7301e8f222948db9417",
  "apps/cli/src/backends/opencode/directSessions/providerOps.ts": "aa43552913c9bdc73e8cd1f2401d657f489e09a6",
  "apps/cli/src/cli/commands/directSession.ts": "350b5d2d214b559e718ee65493a7ef51ec8945f8",
  "apps/cli/src/cli/commands/directSession/contract.ts": "e78fd844c9579b1fdedfe732e3a4e4d8fa4f0733",
  "apps/cli/src/cli/commands/session/create.ts": "61aaba58edfc5fe0922ff2884620b4a640733d85",
  "apps/cli/src/cli/commands/session/send.ts": "f6ad5fff09b683d23bcbedcdbf538effa291cf5f",
  "apps/cli/src/cli/commands/session/status.ts": "6e5b1fd900cf37f040a4b13e2dcb6e0169451a30",
});

export const HAPPIER_DIRECT_SESSION_RUNTIME_MANIFEST = {
  contractVersion: 1,
  manifestVersion: "2026-07-17.1",
  reviewedSourceRevision: HAPPIER_DIRECT_SESSION_SOURCE_REVISION,
  publicCommands: ["capabilities", "ensure", "read-after", "events"],
  sourceBinding: "ensure_does_not_export_normalized_source",
  providers: {
    codex: {
      canonicalUri: "codex://threads/<native-session-id>",
      transcript: "bounded_polling",
      runningSignal: "unavailable",
      takeover: "provider_internal_only",
    },
    claude: {
      canonicalUri: "claude://sessions/<native-session-id>",
      transcript: "bounded_polling",
      runningSignal: "unavailable",
      takeover: "provider_internal_only",
    },
    opencode: {
      canonicalUri: "opencode://sessions/<native-session-id>",
      transcript: "bounded_polling",
      runningSignal: "busy",
      takeover: "provider_internal_only",
    },
  },
} as const;

export const HAPPIER_DIRECT_SESSION_CAPABILITY_FINGERPRINT = `sha256:${createHash("sha256")
  .update(JSON.stringify(HAPPIER_DIRECT_SESSION_RUNTIME_MANIFEST))
  .digest("hex")}`;

export type HappierDirectSessionProviderId = (typeof HAPPIER_DIRECT_SESSION_PROVIDER_IDS)[number];
export type HappierDirectSessionUpstreamSurface =
  | "public_direct_session_cli"
  | "generic_session_cli"
  | "provider_internal"
  | "none";

export interface HappierDirectSessionCapabilitySource {
  readonly connectorState: SessionConnectorCapabilityState;
  readonly reasonCode: SessionConnectorCapabilityReasonCode | null;
  readonly evidenceKey: string | null;
  readonly upstreamSurface: HappierDirectSessionUpstreamSurface;
  readonly sourceRefs: readonly string[];
  readonly limitation: string;
}

export interface HappierDirectSessionProviderCapabilityRow {
  readonly providerId: HappierDirectSessionProviderId;
  readonly sourceRevision: string;
  readonly canonicalUriScheme: string;
  readonly nativeDeepLink: "certified" | "canonical_uri_only" | "unavailable";
  readonly statusSemantics: "activity_poll_without_running_signal" | "activity_poll_with_busy_signal";
  readonly capabilities: Readonly<Record<SessionConnectorCapabilityName, HappierDirectSessionCapabilitySource>>;
}

const DIRECT_SESSION_COMMAND = "happier:apps/cli/src/cli/commands/directSession.ts";
const DIRECT_SESSION_CONTRACT = "happier:apps/cli/src/cli/commands/directSession/contract.ts";
const DIRECT_SESSION_ENSURE = "happier:apps/cli/src/api/directSessions/ensure/ensureDirectSessionFromUri.ts";
const GENERIC_SESSION_CREATE = "happier:apps/cli/src/cli/commands/session/create.ts";
const GENERIC_SESSION_SEND = "happier:apps/cli/src/cli/commands/session/send.ts";
const GENERIC_SESSION_STATUS = "happier:apps/cli/src/cli/commands/session/status.ts";
const FUSION_CONNECTOR = "fusion:plugins/fusion-plugin-happier-runtime/src/session-connector.ts";
const FUSION_CLI_ADAPTER = "fusion:plugins/fusion-plugin-happier-runtime/src/cli-spawn.ts";
const FUSION_RUNTIME_PROBE = "fusion:plugins/fusion-plugin-happier-runtime/src/probe.ts";

function source(
  connectorState: SessionConnectorCapabilityState,
  reasonCode: SessionConnectorCapabilityReasonCode | null,
  evidenceKey: string | null,
  upstreamSurface: HappierDirectSessionUpstreamSurface,
  sourceRefs: readonly string[],
  limitation: string,
): HappierDirectSessionCapabilitySource {
  return Object.freeze({
    connectorState,
    reasonCode,
    evidenceKey,
    upstreamSurface,
    sourceRefs: Object.freeze([...sourceRefs]),
    limitation,
  });
}

function providerOpsRef(providerId: HappierDirectSessionProviderId): string {
  return `happier:apps/cli/src/backends/${providerId}/directSessions/providerOps.ts`;
}

function providerRow(
  providerId: HappierDirectSessionProviderId,
  canonicalUriScheme: string,
  nativeDeepLink: HappierDirectSessionProviderCapabilityRow["nativeDeepLink"],
  statusSemantics: HappierDirectSessionProviderCapabilityRow["statusSemantics"],
): HappierDirectSessionProviderCapabilityRow {
  const providerOps = providerOpsRef(providerId);
  const capabilities: HappierDirectSessionProviderCapabilityRow["capabilities"] = Object.freeze({
    ensureExisting: source(
      "unverified",
      "pending_provider_certification",
      null,
      "public_direct_session_cli",
      [DIRECT_SESSION_CONTRACT, DIRECT_SESSION_ENSURE, providerOps, FUSION_CLI_ADAPTER, FUSION_CONNECTOR],
      "Exact source-level attachment exists, but current-build live provider certification remains Task 12.1.",
    ),
    create: source(
      "unavailable",
      "operation_unavailable",
      null,
      "generic_session_cli",
      [GENERIC_SESSION_CREATE, FUSION_CONNECTOR],
      "Happier can create generic Sessions, but this Session Connector does not expose create yet.",
    ),
    status: source(
      "unverified",
      "pending_provider_certification",
      null,
      "generic_session_cli",
      [GENERIC_SESSION_STATUS, providerOps, FUSION_CLI_ADAPTER, FUSION_CONNECTOR],
      "Generic Happier Session status is wired; exact provider status parity is not certified.",
    ),
    history: source(
      "unverified",
      "source_unverified",
      null,
      "public_direct_session_cli",
      [DIRECT_SESSION_COMMAND, providerOps, FUSION_CLI_ADAPTER, FUSION_CONNECTOR],
      "Bounded read-after exists, but ensure does not export the normalized provider source needed to retain source affinity.",
    ),
    events: source(
      "unverified",
      "source_unverified",
      null,
      "public_direct_session_cli",
      [DIRECT_SESSION_COMMAND, providerOps, FUSION_CLI_ADAPTER, FUSION_CONNECTOR],
      statusSemantics === "activity_poll_with_busy_signal"
        ? "Polling maps OpenCode busy, but the connector cannot yet retain the normalized source returned during discovery."
        : "Polling has no native running signal and the connector cannot yet retain the normalized discovery source.",
    ),
    send: source(
      "unverified",
      "pending_provider_certification",
      null,
      "generic_session_cli",
      [GENERIC_SESSION_SEND, FUSION_CLI_ADAPTER, FUSION_CONNECTOR],
      "The exact Happier Session and local ID are wired, but same-native-Session delivery needs live certification.",
    ),
    interrupt: source(
      "unavailable",
      "operation_unavailable",
      null,
      "none",
      [DIRECT_SESSION_COMMAND, FUSION_CONNECTOR],
      "No certified Direct Session interrupt command is exposed by the pinned adapter surface.",
    ),
    resume: source(
      "unavailable",
      "operation_unavailable",
      null,
      "provider_internal",
      [DIRECT_SESSION_COMMAND, providerOps, FUSION_CONNECTOR],
      "Provider resume spawn options exist internally, but no adapter command or connector method is exposed.",
    ),
    takeover: source(
      "unavailable",
      "operation_unavailable",
      null,
      "provider_internal",
      [DIRECT_SESSION_COMMAND, providerOps, FUSION_CONNECTOR],
      "Exact native takeover spawn options exist internally, but the Fusion connector does not expose takeover.",
    ),
    health: source(
      "unverified",
      "pending_provider_certification",
      null,
      "generic_session_cli",
      [GENERIC_SESSION_STATUS, FUSION_RUNTIME_PROBE, FUSION_CONNECTOR],
      "Typed runtime health is wired, but it is not yet certified per concrete provider Session binding.",
    ),
    deepLinks: source(
      "verified",
      null,
      `direct-session-open-url-${providerId}`,
      "public_direct_session_cli",
      [DIRECT_SESSION_CONTRACT, FUSION_CLI_ADAPTER, FUSION_CONNECTOR],
      nativeDeepLink === "certified"
        ? "Happier and native Codex links are certified as distinct identities."
        : nativeDeepLink === "canonical_uri_only"
          ? "The Happier link is certified; the Codex URI shape is known but native Windows opening is not certified."
          : "The Happier link is certified; this provider's native IDE link intentionally remains null.",
    ),
  });
  return Object.freeze({
    providerId,
    sourceRevision: HAPPIER_DIRECT_SESSION_SOURCE_REVISION,
    canonicalUriScheme,
    nativeDeepLink,
    statusSemantics,
    capabilities,
  });
}

/**
 * Source-backed facts for the exact pinned Happier revision. This describes
 * both upstream availability and the narrower state actually exposed by the
 * Fusion connector; provider-internal code never upgrades connector parity.
 */
export const HAPPIER_DIRECT_SESSION_CAPABILITY_MATRIX = Object.freeze({
  codex: providerRow(
    "codex",
    "codex://threads/<native-session-id>",
    "canonical_uri_only",
    "activity_poll_without_running_signal",
  ),
  claude: providerRow(
    "claude",
    "claude://sessions/<native-session-id>",
    "unavailable",
    "activity_poll_without_running_signal",
  ),
  opencode: providerRow(
    "opencode",
    "opencode://sessions/<native-session-id>",
    "unavailable",
    "activity_poll_with_busy_signal",
  ),
} satisfies Readonly<Record<HappierDirectSessionProviderId, HappierDirectSessionProviderCapabilityRow>>);

export function isHappierDirectSessionProviderId(value: string): value is HappierDirectSessionProviderId {
  return HAPPIER_DIRECT_SESSION_PROVIDER_IDS.some((providerId) => providerId === value);
}

export function isCertifiedHappierDirectSessionRuntimeManifest(
  value: unknown,
  expectedSourceRevision = HAPPIER_DIRECT_SESSION_SOURCE_REVISION,
): value is typeof HAPPIER_DIRECT_SESSION_RUNTIME_MANIFEST & Readonly<{
  fingerprint: string;
  cliVersion: string;
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    record.fingerprint !== HAPPIER_DIRECT_SESSION_CAPABILITY_FINGERPRINT
    || typeof record.cliVersion !== "string"
    || !record.cliVersion.trim()
    || record.reviewedSourceRevision !== expectedSourceRevision
  ) return false;
  const observedManifest = {
    contractVersion: record.contractVersion,
    manifestVersion: record.manifestVersion,
    reviewedSourceRevision: record.reviewedSourceRevision,
    publicCommands: record.publicCommands,
    sourceBinding: record.sourceBinding,
    providers: record.providers,
  };
  return JSON.stringify(observedManifest) === JSON.stringify(HAPPIER_DIRECT_SESSION_RUNTIME_MANIFEST);
}

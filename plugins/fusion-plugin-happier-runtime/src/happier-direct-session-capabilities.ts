import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, parse, relative } from "node:path";

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

export interface HappierDirectSessionRuntimeBuildPin {
  readonly pinId: string;
  readonly entrypointSha256: `sha256:${string}`;
  readonly runtimeArtifactSha256: `sha256:${string}`;
}

export type HappierDirectSessionRuntimeBuildFailureReason =
  | "cli_path_unbound"
  | "cli_path_forbidden"
  | "cli_artifact_unpinned"
  | "cli_artifact_mismatch"
  | "cli_capabilities_invalid";

export type HappierDirectSessionRuntimeBuildVerification =
  | Readonly<{
    ok: true;
    pinId: string;
    entrypointPath: string;
    runtimeArtifactPath: string;
    entrypointSha256: `sha256:${string}`;
    runtimeArtifactSha256: `sha256:${string}`;
    launchDigest: `sha256:${string}`;
    trustLevel: "local_artifact_hash_only";
  }>
  | Readonly<{
    ok: false;
    reasonCode: HappierDirectSessionRuntimeBuildFailureReason;
  }>;

interface HappierRuntimeBuildFilesystem {
  readonly lstat: typeof lstat;
  readonly readFile: typeof readFile;
  readonly realpath: typeof realpath;
}

interface HappierRuntimeBuildVerificationOptions {
  readonly pins?: readonly HappierDirectSessionRuntimeBuildPin[];
  readonly filesystem?: HappierRuntimeBuildFilesystem;
}

/**
 * Exact local package-dist build accepted by the Session Connector review.
 * This pin detects ordinary path/build drift only. It is deliberately not
 * described as Git provenance, a complete Node dependency closure, live
 * provider certification, or protection from a hostile same-user process.
 */
export const HAPPIER_DIRECT_SESSION_RUNTIME_BUILD_PINS: readonly HappierDirectSessionRuntimeBuildPin[] = Object.freeze([
  Object.freeze({
    pinId: "happier-cli-0.2.10-package-dist-2026-07-17.1",
    entrypointSha256: "sha256:293d55ba1267cf8a297fd641887538ae43726f4b23fc9ce6ad2d9db212c95f2d",
    runtimeArtifactSha256: "sha256:13a3a35835359949c119d8e3c11800cd949aa4877075ced5603948333bcce6b6",
  }),
]);

const DEFAULT_RUNTIME_BUILD_FILESYSTEM: HappierRuntimeBuildFilesystem = {
  lstat,
  readFile,
  realpath,
};

function runtimeBuildRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sha256Bytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isForbiddenRuntimePath(value: string): boolean {
  if (!isAbsolute(value) || value.startsWith("\\\\") || value.startsWith("//")) return true;
  const root = parse(value).root;
  return value.slice(root.length).includes(":");
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function hasExactRuntimeTrustMetadata(record: Record<string, unknown>): boolean {
  const artifact = runtimeBuildRecord(record.runtimeArtifact);
  const attestation = runtimeBuildRecord(record.attestation);
  const build = runtimeBuildRecord(attestation?.buildAttestation);
  const git = runtimeBuildRecord(attestation?.gitProvenance);
  const provider = runtimeBuildRecord(attestation?.liveProviderCertification);
  return record.fingerprintScope === "capability_manifest"
    && typeof artifact?.path === "string"
    && /^sha256:[a-f0-9]{64}$/.test(String(artifact.sha256))
    && attestation?.schemaVersion === 1
    && attestation.trustModel === "self_reported_local_process"
    && build?.kind === "loaded_module_file_sha256"
    && build.hashScope === "file_bytes"
    && git?.status === "not_attested"
    && provider?.status === "not_certified";
}

/**
 * Independently hashes the explicitly configured package-dist entrypoint and
 * the command chunk reported by the just-invoked Happier process. PATH names,
 * shell shims, bin/happier.mjs, dist, and backup launchers fail closed.
 */
export async function verifyHappierDirectSessionRuntimeBuild(
  value: unknown,
  configuredEntrypoint: string | undefined,
  options: HappierRuntimeBuildVerificationOptions = {},
): Promise<HappierDirectSessionRuntimeBuildVerification> {
  if (!configuredEntrypoint?.trim()) return { ok: false, reasonCode: "cli_path_unbound" };
  if (!isCertifiedHappierDirectSessionRuntimeManifest(value) || !hasExactRuntimeTrustMetadata(value as Record<string, unknown>)) {
    return { ok: false, reasonCode: "cli_capabilities_invalid" };
  }

  const entrypoint = configuredEntrypoint.trim();
  const observed = value as Record<string, unknown>;
  const runtimeArtifact = observed.runtimeArtifact as Record<string, unknown>;
  const reportedRuntimePath = runtimeArtifact.path as string;
  if (isForbiddenRuntimePath(entrypoint) || isForbiddenRuntimePath(reportedRuntimePath)) {
    return { ok: false, reasonCode: "cli_path_forbidden" };
  }

  const filesystem = options.filesystem ?? DEFAULT_RUNTIME_BUILD_FILESYSTEM;
  try {
    const [entrypointInfo, runtimeInfo] = await Promise.all([
      filesystem.lstat(entrypoint),
      filesystem.lstat(reportedRuntimePath),
    ]);
    if (
      !entrypointInfo.isFile()
      || entrypointInfo.isSymbolicLink()
      || !runtimeInfo.isFile()
      || runtimeInfo.isSymbolicLink()
    ) return { ok: false, reasonCode: "cli_path_forbidden" };

    const [canonicalEntrypoint, canonicalRuntimeArtifact] = await Promise.all([
      filesystem.realpath(entrypoint),
      filesystem.realpath(reportedRuntimePath),
    ]);
    const packageDistDirectory = dirname(canonicalEntrypoint);
    const runtimeRelativePath = relative(packageDistDirectory, canonicalRuntimeArtifact);
    if (
      basename(packageDistDirectory) !== "package-dist"
      || basename(canonicalEntrypoint) !== "index.mjs"
      || runtimeRelativePath.includes("/")
      || runtimeRelativePath.includes("\\")
      || runtimeRelativePath.startsWith("..")
      || !/^index-[A-Za-z0-9_-]+\.mjs$/.test(runtimeRelativePath)
      || !samePath(dirname(canonicalRuntimeArtifact), packageDistDirectory)
    ) return { ok: false, reasonCode: "cli_path_forbidden" };

    const [entrypointBytes, runtimeArtifactBytes] = await Promise.all([
      filesystem.readFile(canonicalEntrypoint),
      filesystem.readFile(canonicalRuntimeArtifact),
    ]);
    const entrypointSha256 = sha256Bytes(entrypointBytes);
    const runtimeArtifactSha256 = sha256Bytes(runtimeArtifactBytes);
    if (runtimeArtifact.sha256 !== runtimeArtifactSha256) {
      return { ok: false, reasonCode: "cli_artifact_mismatch" };
    }
    const pin = (options.pins ?? HAPPIER_DIRECT_SESSION_RUNTIME_BUILD_PINS).find(
      (candidate) => candidate.entrypointSha256 === entrypointSha256
        && candidate.runtimeArtifactSha256 === runtimeArtifactSha256,
    );
    if (!pin) return { ok: false, reasonCode: "cli_artifact_unpinned" };

    const launchDigest = `sha256:${createHash("sha256").update(JSON.stringify({
      version: 1,
      pinId: pin.pinId,
      entrypointPath: canonicalEntrypoint,
      runtimeArtifactPath: canonicalRuntimeArtifact,
      entrypointSha256,
      runtimeArtifactSha256,
    })).digest("hex")}` as const;
    return {
      ok: true,
      pinId: pin.pinId,
      entrypointPath: canonicalEntrypoint,
      runtimeArtifactPath: canonicalRuntimeArtifact,
      entrypointSha256,
      runtimeArtifactSha256,
      launchDigest,
      trustLevel: "local_artifact_hash_only",
    };
  } catch {
    return { ok: false, reasonCode: "cli_path_forbidden" };
  }
}

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

import type {
  HappierRuntimeBackend,
  HappierRuntimeSessionBinding,
  SessionConnectorHealthV1,
} from "@fusion/core";
import type {
  HappierCliAttestation,
  HappierRuntimeHealth,
  HappierSessionConnector,
} from "@fusion-plugin-examples/happier-runtime";

export type HappierCapabilityProbeSample = Awaited<
  ReturnType<HappierSessionConnector["getCapabilityProbeEvidence"]>
>[number];

export type HappierRuntimeCompatibility = typeof import(
  "@fusion-plugin-examples/happier-runtime"
).HAPPIER_RUNTIME_COMPATIBILITY;

export type HappierDiscoveryState = "available" | "unavailable";
export type HappierCandidateBindingState = "bound" | "unbound" | "conflict";
export type HappierBindingState = "verified" | "drift" | "conflict" | "unverified";

export interface HappierNativeSessionCandidate {
  readonly canonicalSessionUri: string;
  readonly providerId: HappierRuntimeBackend;
  readonly nativeSessionId: string;
  readonly sourceSessionId: string;
  /**
   * `confirmed-happier-binding` is a project-scoped, user-confirmed projection
   * of an existing external session. It is not a Fusion-created CLI session
   * and must never be treated as an import or creation request.
   */
  readonly source: "fusion-cli-session" | "confirmed-happier-binding";
}

export interface HappierRemoteSessionCandidate {
  readonly happierSessionId: string;
  readonly createdAt?: number;
  readonly updatedAt: number;
  readonly active?: boolean;
  readonly archivedAt?: number | null;
  readonly tag?: string;
  readonly path?: string;
  readonly agentId?: string;
}

export interface HappierDiscoveryResult<T> {
  readonly state: HappierDiscoveryState;
  readonly candidates: readonly T[];
  readonly reason?: string;
}

export interface HappierRuntimeSetupSources {
  readonly settings: Record<string, unknown>;
  readonly runtimeHealth: HappierRuntimeHealth;
  readonly connectorHealth: SessionConnectorHealthV1 | null;
  readonly connectorReadError?: string;
  readonly capabilityEvidence: readonly HappierCapabilityProbeSample[];
  readonly nativeDiscovery: HappierDiscoveryResult<HappierNativeSessionCandidate>;
  readonly happierDiscovery: HappierDiscoveryResult<HappierRemoteSessionCandidate>;
}

export interface HappierReconciledBinding extends HappierRuntimeSessionBinding {
  readonly providerId: HappierRuntimeBackend;
  readonly nativeSessionId: string;
  readonly state: HappierBindingState;
  readonly driftReasons: readonly string[];
  readonly machineAvailability: "verified" | "unverified";
  readonly probeEvidence: HappierCapabilityProbeSample | null;
}

export interface HappierRuntimeSetupStatus {
  readonly failClosed: boolean;
  readonly bindingRevision: string;
  readonly validationErrors: readonly string[];
  readonly conflicts: readonly string[];
  readonly runtimeHealth: HappierRuntimeHealth;
  readonly connectorHealth: SessionConnectorHealthV1 | null;
  readonly connectorReadError: string | null;
  readonly compatibility: HappierRuntimeCompatibility;
  readonly server: {
    readonly activeServerId: string | null;
    readonly profile: string | null;
    readonly serverUrl: string | null;
    readonly publicServerUrl: string | null;
    readonly webappUrl: string | null;
  };
  readonly cli: {
    readonly configuredEntrypoint: string | null;
    readonly allowedRoots: readonly string[];
    readonly attestation: HappierCliAttestation;
  };
  readonly authentication: {
    readonly runtimeAuthenticated: boolean;
    readonly connector: SessionConnectorHealthV1["authentication"] | "unavailable";
  };
  readonly machines: readonly {
    readonly machineId: string;
    readonly providerIds: readonly HappierRuntimeBackend[];
    readonly bindingCount: number;
    readonly availability: "verified" | "unverified";
  }[];
  readonly bindings: readonly HappierReconciledBinding[];
  readonly discovery: {
    readonly nativeState: HappierDiscoveryState;
    readonly nativeReason: string | null;
    readonly nativeCandidates: readonly (HappierNativeSessionCandidate & {
      readonly bindingState: HappierCandidateBindingState;
    })[];
    readonly happierState: HappierDiscoveryState;
    readonly happierReason: string | null;
    readonly happierCandidates: readonly (HappierRemoteSessionCandidate & {
      readonly bindingState: HappierCandidateBindingState;
    })[];
  };
}

export interface HappierNativeSessionRecord {
  readonly id: string;
  readonly adapterId: string;
  readonly nativeSessionId: string | null;
  readonly projectId?: string;
}

export interface ReadHappierRuntimeSetupStatusInput {
  readonly settings: Record<string, unknown>;
  readonly nativeSessions?: readonly HappierNativeSessionRecord[];
  readonly projectId?: string;
  readonly hostId?: string;
}

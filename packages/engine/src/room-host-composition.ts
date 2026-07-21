import type { AsyncDataLayer, AsyncRoomStore, TaskStore } from "@fusion/core";
import type {
  RoomCapabilityRegistryRefreshVerifiedFactory,
  RoomProviderBackpressureVerifiedFactory,
  RoomTaskDispatchCapacityAdmissionVerifiedFactory,
} from "./project-engine.js";
import type { RoomGlobalConcurrencyVerifiedPolicyV1 } from "./room-global-concurrency-runtime.js";
import type { SessionConnectorRegistry } from "./session-connector-registry.js";

export type RoomHostCompositionAuthorityGuardResultV1 =
  | { readonly state: "current" }
  | { readonly state: "withheld"; readonly reason: string };

/**
 * A live, host-owned revalidation hook for a composition bundle that was
 * already accepted at startup. It is deliberately separate from the static
 * metadata so expiry, revocation, replacement, and connector-inventory changes
 * can fence an existing controller before further worker work is performed.
 */
export interface RoomHostCompositionAuthorityGuardV1 {
  assertCurrent(): Promise<RoomHostCompositionAuthorityGuardResultV1>;
}

export interface RoomHostCompositionAuthorityV1 {
  readonly bundleId: string;
  readonly issuer: string;
  readonly revision: number;
  readonly projectId: string;
  readonly hostId: string;
  readonly connectorIds: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly guard?: RoomHostCompositionAuthorityGuardV1;
}

export interface RoomHostCompositionContextV1 {
  readonly projectId: string;
  readonly taskStore: TaskStore;
  readonly asyncLayer: AsyncDataLayer;
  readonly roomStore: AsyncRoomStore;
  readonly connectorRegistry: SessionConnectorRegistry;
  readonly connectorIds: readonly string[];
  readonly hostId: string;
}

export interface RoomCompositionDependenciesV1 {
  /**
   * Host-verified controller placement only. The CentralCore authority supplies
   * the single global ceiling, reservations, and lease lifetime separately.
   */
  readonly globalConcurrencyVerifiedPolicy: RoomGlobalConcurrencyVerifiedPolicyV1;
  readonly providerBackpressureVerifiedFactory: RoomProviderBackpressureVerifiedFactory;
  readonly capabilityRegistryRefreshVerifiedFactory: RoomCapabilityRegistryRefreshVerifiedFactory;
  readonly taskDispatchCapacityAdmissionVerifiedFactory: RoomTaskDispatchCapacityAdmissionVerifiedFactory;
}

export interface RoomVerifiedCompositionV1 extends RoomCompositionDependenciesV1 {
  readonly authority: RoomHostCompositionAuthorityV1;
}

export type RoomHostCompositionResolutionV1 =
  | {
    readonly state: "ready";
    readonly composition: RoomVerifiedCompositionV1;
  }
  | {
    readonly state: "withheld";
    readonly reason: string;
  };

export interface RoomHostCompositionProviderV1 {
  resolve(
    context: RoomHostCompositionContextV1,
  ): RoomHostCompositionResolutionV1 | Promise<RoomHostCompositionResolutionV1>;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (!isCanonicalIdentifier(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isSafeWithheldReason(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_:-]{0,127}$/.test(value);
}

function isAuthorityGuard(value: unknown): value is RoomHostCompositionAuthorityGuardV1 {
  return isRecord(value) && typeof value.assertCurrent === "function";
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function normalizeConnectorIds(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || !value.every(isCanonicalIdentifier)) return null;
  const sorted = [...value].sort();
  return new Set(sorted).size === sorted.length ? Object.freeze(sorted) : null;
}

function haveSameConnectorIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRoomCompositionDependencies(value: unknown): value is RoomCompositionDependenciesV1 {
  return isRecord(value)
    && isRecord(value.globalConcurrencyVerifiedPolicy)
    && typeof value.providerBackpressureVerifiedFactory === "function"
    && typeof value.capabilityRegistryRefreshVerifiedFactory === "function"
    && typeof value.taskDispatchCapacityAdmissionVerifiedFactory === "function";
}

/*
FNXC:RoomHostComposition 2026-07-20-02:24:
Room worker execution needs one host-owned, all-or-nothing authority decision
after the actual connector registry exists. Fusion must not manufacture global
capacity, provider limits, capability observations, or dispatch admission from
project settings, plugin settings, labels, or an incomplete set of seams.
*/
export function normalizeRoomHostCompositionResolution(
  value: unknown,
  context: Pick<RoomHostCompositionContextV1, "projectId" | "hostId" | "connectorIds">,
  nowMs = Date.now(),
): RoomHostCompositionResolutionV1 {
  if (!isRecord(value)) {
    return { state: "withheld", reason: "invalid_host_composition_result" };
  }
  if (value.state === "withheld") {
    return {
      state: "withheld",
      reason: isSafeWithheldReason(value.reason) ? value.reason : "host_composition_withheld",
    };
  }
  if (value.state !== "ready" || !isRecord(value.composition)) {
    return { state: "withheld", reason: "invalid_host_composition_result" };
  }

  const composition = value.composition;
  const authority = isRecord(composition) ? composition.authority : undefined;
  if (!isRoomCompositionDependencies(composition) || !isRecord(authority)) {
    return { state: "withheld", reason: "incomplete_host_composition" };
  }
  const bundleId = authority.bundleId;
  const issuer = authority.issuer;
  const revision = authority.revision;
  const projectId = authority.projectId;
  const hostId = authority.hostId;
  const connectorIds = normalizeConnectorIds(authority.connectorIds);
  const issuedAt = authority.issuedAt;
  const expiresAt = authority.expiresAt;
  const guard = authority.guard;
  if (
    !isCanonicalIdentifier(bundleId)
    || !isCanonicalIdentifier(issuer)
    || !isPositiveSafeInteger(revision)
    || projectId !== context.projectId
    || hostId !== context.hostId
    || connectorIds === null
    || !haveSameConnectorIds(connectorIds, context.connectorIds)
    || !isCanonicalTimestamp(issuedAt)
    || !isCanonicalTimestamp(expiresAt)
    || (guard !== undefined && !isAuthorityGuard(guard))
  ) {
    return { state: "withheld", reason: "invalid_host_composition_authority" };
  }
  const issuedAtMs = Date.parse(issuedAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(nowMs) || issuedAtMs >= expiresAtMs || nowMs >= expiresAtMs) {
    return { state: "withheld", reason: "expired_host_composition_authority" };
  }
  if (nowMs < issuedAtMs) {
    return { state: "withheld", reason: "not_yet_valid_host_composition_authority" };
  }

  return {
    state: "ready",
    composition: Object.freeze({
      globalConcurrencyVerifiedPolicy: composition.globalConcurrencyVerifiedPolicy,
      providerBackpressureVerifiedFactory: composition.providerBackpressureVerifiedFactory,
      capabilityRegistryRefreshVerifiedFactory: composition.capabilityRegistryRefreshVerifiedFactory,
      taskDispatchCapacityAdmissionVerifiedFactory: composition.taskDispatchCapacityAdmissionVerifiedFactory,
      authority: Object.freeze({
        bundleId,
        issuer,
        revision,
        projectId,
        hostId,
        connectorIds,
        issuedAt,
        expiresAt,
        ...(guard === undefined ? {} : { guard }),
      }),
    }),
  };
}

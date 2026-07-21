import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CentralCore,
  createTaskStoreForBackend,
  type GlobalCapacityLedgerPolicyV1,
  type InstallGlobalCapacityPolicyAuthorityInputV1,
  type InstallRoomHostCompositionOperatorPolicyAuthorityInputV1,
  type RevokeRoomHostCompositionOperatorPolicyAuthorityInputV1,
  type UpdateGlobalCapacityPolicyAuthorityInputV1,
} from "@fusion/core";

export type RoomControlPlanePolicyAction =
  | "host-install"
  | "host-revoke"
  | "capacity-install"
  | "capacity-update";

export interface RoomControlPlanePolicyCommandOptions {
  readonly action: RoomControlPlanePolicyAction;
  readonly file: string;
  /** Allows the CLI test seam to isolate backend boot without changing authority semantics. */
  readonly rootDir?: string;
}

export class RoomControlPlanePolicyCommandError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RoomControlPlanePolicyCommandError";
  }
}

type JsonRecord = Record<string, unknown>;

type RoomControlPlanePolicyInput =
  | InstallRoomHostCompositionOperatorPolicyAuthorityInputV1
  | RevokeRoomHostCompositionOperatorPolicyAuthorityInputV1
  | InstallGlobalCapacityPolicyAuthorityInputV1
  | UpdateGlobalCapacityPolicyAuthorityInputV1;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_REASON = /^[a-z][a-z0-9_:-]{0,127}$/u;
const MAX_CONTROLLER_SLOTS = 2_147_483_647;

/*
FNXC:RoomControlPlanePolicyCommand 2026-07-20-22:36:
Fusion Room execution must receive authority only from an explicit operator
command. The daemon, project settings, and ambient provider configuration are
never allowed to self-grant a host bundle or capacity policy.

The command accepts a single strict JSON file so every project/host scope,
connector ID, adapter ID, optimistic revision, and finite authority expiry is
reviewable before CentralCore is opened. Live provider, account, model, quota,
or health facts are intentionally rejected here; verified runtime adapters own
those facts and a missing adapter must keep execution withheld.
*/

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  return actual.length === canonicalExpected.length && actual.every((key, index) => key === canonicalExpected[index]);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function isSafeReason(value: unknown): value is string {
  return typeof value === "string" && SAFE_REASON.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function invalidHostPolicyInput(): never {
  throw new RoomControlPlanePolicyCommandError("Room host policy input is invalid");
}

function invalidCapacityPolicyInput(): never {
  throw new RoomControlPlanePolicyCommandError("Global capacity policy input is invalid");
}

function parseRoomHostPolicy(value: unknown): InstallRoomHostCompositionOperatorPolicyAuthorityInputV1["policy"] {
  if (!isRecord(value) || !hasExactKeys(value, ["connectorIds", "controllerAdmission", "adapterBindings"])) {
    return invalidHostPolicyInput();
  }

  const connectorIds = value.connectorIds;
  const controllerAdmission = value.controllerAdmission;
  const adapterBindings = value.adapterBindings;
  if (
    !Array.isArray(connectorIds)
    || connectorIds.length === 0
    || !connectorIds.every(isIdentifier)
    || connectorIds.some((connectorId, index) => index > 0 && connectorIds[index - 1] >= connectorId)
    || !isRecord(controllerAdmission)
    || !hasExactKeys(controllerAdmission, ["workClass", "slots"])
    || (controllerAdmission.workClass !== "normal" && controllerAdmission.workClass !== "verifier" && controllerAdmission.workClass !== "recovery")
    || !isPositiveSafeInteger(controllerAdmission.slots)
    || controllerAdmission.slots > MAX_CONTROLLER_SLOTS
    || !isRecord(adapterBindings)
    || !hasExactKeys(adapterBindings, [
      "capabilityObservationAdapterId",
      "providerAdmissionSnapshotAdapterId",
      "capacityTelemetryAdapterId",
      "roomWorkerAuthorityAdapterId",
    ])
    || !isIdentifier(adapterBindings.capabilityObservationAdapterId)
    || !isIdentifier(adapterBindings.providerAdmissionSnapshotAdapterId)
    || !isIdentifier(adapterBindings.capacityTelemetryAdapterId)
    || !isIdentifier(adapterBindings.roomWorkerAuthorityAdapterId)
  ) {
    return invalidHostPolicyInput();
  }

  return {
    connectorIds: [...connectorIds],
    controllerAdmission: {
      workClass: controllerAdmission.workClass,
      slots: controllerAdmission.slots,
    },
    adapterBindings: {
      capabilityObservationAdapterId: adapterBindings.capabilityObservationAdapterId,
      providerAdmissionSnapshotAdapterId: adapterBindings.providerAdmissionSnapshotAdapterId,
      capacityTelemetryAdapterId: adapterBindings.capacityTelemetryAdapterId,
      roomWorkerAuthorityAdapterId: adapterBindings.roomWorkerAuthorityAdapterId,
    },
  };
}

function parseHostInstall(value: unknown): InstallRoomHostCompositionOperatorPolicyAuthorityInputV1 {
  if (!isRecord(value) || !hasExactKeys(value, [
    "projectId",
    "hostId",
    "expectedRevision",
    "bundleId",
    "issuer",
    "expiresAt",
    "policy",
  ])) {
    return invalidHostPolicyInput();
  }
  if (
    !isIdentifier(value.projectId)
    || !isIdentifier(value.hostId)
    || !isNonNegativeSafeInteger(value.expectedRevision)
    || !isIdentifier(value.bundleId)
    || !isIdentifier(value.issuer)
    || !isCanonicalTimestamp(value.expiresAt)
    || Date.parse(value.expiresAt) <= Date.now()
  ) {
    return invalidHostPolicyInput();
  }
  return {
    projectId: value.projectId,
    hostId: value.hostId,
    expectedRevision: value.expectedRevision,
    bundleId: value.bundleId,
    issuer: value.issuer,
    expiresAt: value.expiresAt,
    policy: parseRoomHostPolicy(value.policy),
  };
}

function parseHostRevoke(value: unknown): RevokeRoomHostCompositionOperatorPolicyAuthorityInputV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["projectId", "hostId", "expectedRevision", "reason"])) {
    return invalidHostPolicyInput();
  }
  if (
    !isIdentifier(value.projectId)
    || !isIdentifier(value.hostId)
    || !isPositiveSafeInteger(value.expectedRevision)
    || !isSafeReason(value.reason)
  ) {
    return invalidHostPolicyInput();
  }
  return {
    projectId: value.projectId,
    hostId: value.hostId,
    expectedRevision: value.expectedRevision,
    reason: value.reason,
  };
}

function parseCapacityPolicy(value: unknown): GlobalCapacityLedgerPolicyV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["reservations", "snapshotTtlMs", "leaseTtlMs"])) {
    return invalidCapacityPolicyInput();
  }
  const reservations = value.reservations;
  if (
    !isRecord(reservations)
    || !hasExactKeys(reservations, ["verifierSlots", "recoverySlots", "legacyTaskTriageSlots"])
    || !isNonNegativeSafeInteger(reservations.verifierSlots)
    || !isNonNegativeSafeInteger(reservations.recoverySlots)
    || !isNonNegativeSafeInteger(reservations.legacyTaskTriageSlots)
    || !isPositiveSafeInteger(value.snapshotTtlMs)
    || !isPositiveSafeInteger(value.leaseTtlMs)
  ) {
    return invalidCapacityPolicyInput();
  }
  return {
    reservations: {
      verifierSlots: reservations.verifierSlots,
      recoverySlots: reservations.recoverySlots,
      legacyTaskTriageSlots: reservations.legacyTaskTriageSlots,
    },
    snapshotTtlMs: value.snapshotTtlMs,
    leaseTtlMs: value.leaseTtlMs,
  };
}

function parseCapacityInstall(value: unknown): InstallGlobalCapacityPolicyAuthorityInputV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["expectedRevision", "policy"]) || value.expectedRevision !== 0) {
    return invalidCapacityPolicyInput();
  }
  return { expectedRevision: 0, policy: parseCapacityPolicy(value.policy) };
}

function parseCapacityUpdate(value: unknown): UpdateGlobalCapacityPolicyAuthorityInputV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["expectedRevision", "policy"]) || !isPositiveSafeInteger(value.expectedRevision)) {
    return invalidCapacityPolicyInput();
  }
  return { expectedRevision: value.expectedRevision, policy: parseCapacityPolicy(value.policy) };
}

async function readCanonicalPolicyInput(action: RoomControlPlanePolicyAction, file: string): Promise<RoomControlPlanePolicyInput> {
  let content: string;
  try {
    content = await readFile(resolve(file), "utf8");
  } catch {
    throw new RoomControlPlanePolicyCommandError("Room control-plane policy input could not be read");
  }

  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    throw new RoomControlPlanePolicyCommandError("Room control-plane policy input is not valid JSON");
  }

  switch (action) {
    case "host-install":
      return parseHostInstall(value);
    case "host-revoke":
      return parseHostRevoke(value);
    case "capacity-install":
      return parseCapacityInstall(value);
    case "capacity-update":
      return parseCapacityUpdate(value);
  }
}

export function parseRoomControlPlanePolicyCommandArgs(args: readonly string[]): {
  action: RoomControlPlanePolicyAction;
  file: string;
} {
  if (args.length !== 4 || args[2] !== "--file" || !args[3] || args[3].startsWith("-")) {
    throw new RoomControlPlanePolicyCommandError("Room control-plane policy command requires exactly one --file input");
  }

  const [authority, operation, , file] = args;
  if (authority === "host-policy" && operation === "install") return { action: "host-install", file };
  if (authority === "host-policy" && operation === "revoke") return { action: "host-revoke", file };
  if (authority === "capacity-policy" && operation === "install") return { action: "capacity-install", file };
  if (authority === "capacity-policy" && operation === "update") return { action: "capacity-update", file };
  throw new RoomControlPlanePolicyCommandError("Room control-plane policy command is not supported");
}

async function openPolicyAuthority(rootDir: string): Promise<{
  central: CentralCore;
  close(): Promise<void>;
}> {
  let backend: Awaited<ReturnType<typeof createTaskStoreForBackend>> | null = null;
  let central: CentralCore | null = null;
  try {
    backend = await createTaskStoreForBackend({ rootDir });
    if (!backend) {
      throw new Error("missing_backend");
    }
    if (!backend.hostAsyncLayer) {
      /*
      FNXC:RoomControlPlanePolicyCommand 2026-07-20-22:59:
      The operator policy is global host authority. Falling back to CentralCore's
      local storage when the unscoped host layer is absent would create a policy
      that the Room runtime cannot authoritatively consume, so withhold it.
      */
      throw new Error("missing_host_async_layer");
    }
    central = new CentralCore(undefined, { asyncLayer: backend.hostAsyncLayer });
    await central.init();
    const activeCentral = central;
    const activeBackend = backend;
    return {
      central: activeCentral,
      close: async () => {
        await activeCentral.close().catch(() => undefined);
        await activeBackend.shutdown().catch(() => undefined);
      },
    };
  } catch {
    await central?.close().catch(() => undefined);
    await backend?.shutdown().catch(() => undefined);
    throw new RoomControlPlanePolicyCommandError("Room control-plane policy authority is unavailable");
  }
}

function printSafeResult(action: RoomControlPlanePolicyAction, record: {
  readonly revision: number;
  readonly policyHash: string;
  readonly expiresAt?: string;
}): void {
  const base = {
    action,
    authority: action.startsWith("host-") ? "room-host-composition" : "global-capacity",
    revision: record.revision,
    policyHash: record.policyHash,
  };
  console.log(JSON.stringify(record.expiresAt ? { ...base, expiresAt: record.expiresAt } : base));
}

export async function runRoomControlPlanePolicy(options: RoomControlPlanePolicyCommandOptions): Promise<void> {
  const input = await readCanonicalPolicyInput(options.action, options.file);
  const authority = await openPolicyAuthority(options.rootDir ?? process.cwd());
  try {
    switch (options.action) {
      case "host-install": {
        const record = await authority.central.installRoomHostCompositionOperatorPolicyAuthorityV1(
          input as InstallRoomHostCompositionOperatorPolicyAuthorityInputV1,
        );
        printSafeResult(options.action, record);
        return;
      }
      case "host-revoke": {
        const record = await authority.central.revokeRoomHostCompositionOperatorPolicyAuthorityV1(
          input as RevokeRoomHostCompositionOperatorPolicyAuthorityInputV1,
        );
        printSafeResult(options.action, record);
        return;
      }
      case "capacity-install": {
        const record = await authority.central.installGlobalCapacityPolicyAuthorityV1(
          input as InstallGlobalCapacityPolicyAuthorityInputV1,
        );
        printSafeResult(options.action, record);
        return;
      }
      case "capacity-update": {
        const record = await authority.central.updateGlobalCapacityPolicyAuthorityV1(
          input as UpdateGlobalCapacityPolicyAuthorityInputV1,
        );
        printSafeResult(options.action, record);
        return;
      }
    }
  } catch (error) {
    if (error instanceof RoomControlPlanePolicyCommandError) {
      throw error;
    }
    throw new RoomControlPlanePolicyCommandError("Room control-plane policy authority rejected the requested operation");
  } finally {
    await authority.close();
  }
}

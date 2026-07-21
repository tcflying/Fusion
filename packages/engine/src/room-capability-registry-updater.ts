import {
  RoomCapabilityRegistry,
  type RecordRoomCapabilityRegistryInputV1,
  type RecordRoomCapabilityRegistryResultV1,
} from "@fusion/core";
import {
  createRoomBindingCapabilityReport,
  type CreateRoomBindingCapabilityReportInputV1,
  type RoomBindingCapabilityReporterIssueCode,
} from "./room-binding-capability-reporter.js";

export const ROOM_CAPABILITY_REGISTRY_UPDATER_CONTRACT_VERSION = 1 as const;
export const MAX_ROOM_CAPABILITY_REGISTRY_UPDATE_SAMPLES = 32 as const;

type CapabilityRegistrySnapshotV1 = RoomCapabilityRegistry.RoomBindingCapabilitySnapshotV1;
type CapabilityRegistryFreshnessPolicyV1 = RoomCapabilityRegistry.RoomCapabilityFreshnessPolicyV1;

export type RoomCapabilityRegistrySchedulingStateV1 = "schedulable" | "not_schedulable";

export interface RoomCapabilityRegistryWriterPortV1 {
  recordRoomCapabilityRegistry(
    input: RecordRoomCapabilityRegistryInputV1,
  ): Promise<RecordRoomCapabilityRegistryResultV1>;
}

/**
 * A sample can enter this adapter only through an already trusted concrete
 * connector observation. It deliberately has no peer-claim variant.
 */
export interface RoomCapabilityRegistryUpdateSampleV1 {
  readonly source: "trusted_session_connector";
  readonly report: CreateRoomBindingCapabilityReportInputV1;
}

export interface RoomCapabilityRegistryUpdateInputV1 {
  readonly contractVersion: typeof ROOM_CAPABILITY_REGISTRY_UPDATER_CONTRACT_VERSION;
  readonly projectId: string;
  readonly roomId: string;
  readonly expectedAggregateVersion: number;
  readonly expectedRegistryRevision: number;
  readonly roomWorkerFence: RecordRoomCapabilityRegistryInputV1["roomWorkerFence"];
  readonly idempotencyKey: string;
  /** Caller-injected immutable sampling decision time; this adapter reads no clock. */
  readonly sampledAt: string;
  readonly freshness: CapabilityRegistryFreshnessPolicyV1;
  readonly samples: readonly RoomCapabilityRegistryUpdateSampleV1[];
}

export type RoomCapabilityRegistryUpdaterIssueCodeV1 =
  | RoomBindingCapabilityReporterIssueCode
  | "sample_limit_exceeded"
  | "duplicate_binding_sample"
  | "sample_scope_mismatch"
  | "sample_time_mismatch"
  | "report_freshness_exceeds_registry_freshness"
  | "writer_port_invalid";

export interface RoomCapabilityRegistryUpdaterIssueV1 {
  readonly source: "updater" | "reporter";
  readonly code: RoomCapabilityRegistryUpdaterIssueCodeV1;
  readonly path: string;
  readonly message: string;
}

export interface RoomCapabilityRegistryWrittenSampleV1 {
  readonly bindingId: string;
  readonly snapshotId: string;
  readonly revision: number;
  readonly scheduling: RoomCapabilityRegistrySchedulingStateV1;
}

export interface RoomCapabilityRegistryUpdateReasonV1 {
  readonly code:
    | "invalid_input"
    | "reporter_rejected"
    | "writer_port_invalid"
    | "writer_rejected";
  readonly message: string;
}

export type RoomCapabilityRegistryUpdateResultV1 =
  | {
    readonly ok: true;
    readonly outcome: "written";
    readonly scheduling: RoomCapabilityRegistrySchedulingStateV1;
    readonly projectId: string;
    readonly roomId: string;
    readonly sampledAt: string;
    readonly samples: readonly RoomCapabilityRegistryWrittenSampleV1[];
    readonly write: RecordRoomCapabilityRegistryResultV1;
  }
  | {
    readonly ok: false;
    readonly outcome: "withheld";
    readonly scheduling: "not_schedulable";
    readonly projectId: string | null;
    readonly roomId: string | null;
    readonly sampledAt: string | null;
    readonly reason: RoomCapabilityRegistryUpdateReasonV1;
    readonly issues: readonly RoomCapabilityRegistryUpdaterIssueV1[];
  }
  | {
    readonly ok: false;
    readonly outcome: "writer_rejected";
    readonly scheduling: "not_schedulable";
    readonly projectId: string;
    readonly roomId: string;
    readonly sampledAt: string;
    readonly samples: readonly RoomCapabilityRegistryWrittenSampleV1[];
    readonly reason: RoomCapabilityRegistryUpdateReasonV1;
  };

type RuntimeRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RuntimeRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isRoomWorkerFence(value: unknown): value is RecordRoomCapabilityRegistryInputV1["roomWorkerFence"] {
  return isRecord(value)
    && isCanonicalText(value.leaseId)
    && isCanonicalText(value.holderId)
    && isCanonicalText(value.hostId)
    && isPositiveSafeInteger(value.expectedEpoch);
}

function isFreshnessPolicy(value: unknown): value is CapabilityRegistryFreshnessPolicyV1 {
  return isRecord(value)
    && isPositiveSafeInteger(value.maxSnapshotAgeMs)
    && isPositiveSafeInteger(value.maxSignalAgeMs)
    && isNonNegativeSafeInteger(value.maxFutureSkewMs);
}

/**
 * FNXC:RoomCapabilityRegistryFreshness 2026-07-20-21:29:
 * SB-3 P1 requires the durable registry to reject a report whose evidence
 * window is wider than either registry freshness window or its future-skew
 * bound. Reporter conversion discards timestamps from some capability classes,
 * so a wider report policy could otherwise make stale or future tool evidence
 * appear fresh at the durable registry boundary.
 */
function reportFreshnessExceedsRegistryFreshness(
  value: unknown,
  registryFreshness: CapabilityRegistryFreshnessPolicyV1,
): boolean {
  if (!isRecord(value)
    || !isPositiveSafeInteger(value.maxObservationAgeMs)
    || !isNonNegativeSafeInteger(value.maxFutureSkewMs)) {
    return false;
  }
  return value.maxObservationAgeMs > registryFreshness.maxSnapshotAgeMs
    || value.maxObservationAgeMs > registryFreshness.maxSignalAgeMs
    || value.maxFutureSkewMs > registryFreshness.maxFutureSkewMs;
}

function updaterIssue(
  code: Exclude<RoomCapabilityRegistryUpdaterIssueCodeV1, RoomBindingCapabilityReporterIssueCode>,
  path: string,
  message: string,
): RoomCapabilityRegistryUpdaterIssueV1 {
  return { source: "updater", code, path, message };
}

function reportIssue(
  code: RoomBindingCapabilityReporterIssueCode,
  path: string,
  message: string,
): RoomCapabilityRegistryUpdaterIssueV1 {
  return { source: "reporter", code, path, message };
}

function conservativeSchedulingState(
  snapshot: CapabilityRegistrySnapshotV1,
): RoomCapabilityRegistrySchedulingStateV1 {
  if (
    snapshot.health.connectorState !== "healthy"
    || snapshot.health.hostState !== "healthy"
    || snapshot.rateLimit.state !== "clear"
    || snapshot.tools.some((tool) => tool.state !== "verified")
  ) {
    return "not_schedulable";
  }
  return "schedulable";
}

function toWrittenSample(
  snapshot: CapabilityRegistrySnapshotV1,
): RoomCapabilityRegistryWrittenSampleV1 {
  return {
    bindingId: snapshot.lineage.bindingId,
    snapshotId: snapshot.snapshotId,
    revision: snapshot.revision,
    scheduling: conservativeSchedulingState(snapshot),
  };
}

function sortSamples(
  snapshots: readonly CapabilityRegistrySnapshotV1[],
): readonly CapabilityRegistrySnapshotV1[] {
  return [...snapshots].sort((left, right) => {
    const binding = left.lineage.bindingId.localeCompare(right.lineage.bindingId);
    if (binding !== 0) return binding;
    const revision = left.revision - right.revision;
    if (revision !== 0) return revision;
    return left.snapshotId.localeCompare(right.snapshotId);
  });
}

function failureContext(value: unknown): Pick<
  Extract<RoomCapabilityRegistryUpdateResultV1, { readonly outcome: "withheld" }>,
  "projectId" | "roomId" | "sampledAt"
> {
  if (!isRecord(value)) return { projectId: null, roomId: null, sampledAt: null };
  return {
    projectId: isCanonicalText(value.projectId) ? value.projectId : null,
    roomId: isCanonicalText(value.roomId) ? value.roomId : null,
    sampledAt: isCanonicalTimestamp(value.sampledAt) ? value.sampledAt : null,
  };
}

function withheld(
  rawInput: unknown,
  reason: RoomCapabilityRegistryUpdateReasonV1,
  issues: readonly RoomCapabilityRegistryUpdaterIssueV1[],
): Extract<RoomCapabilityRegistryUpdateResultV1, { readonly outcome: "withheld" }> {
  return {
    ok: false,
    outcome: "withheld",
    scheduling: "not_schedulable",
    ...failureContext(rawInput),
    reason,
    issues: [...issues],
  };
}

function validateInput(
  rawInput: unknown,
): readonly RoomCapabilityRegistryUpdaterIssueV1[] {
  if (!isRecord(rawInput)) {
    return [updaterIssue("sample_scope_mismatch", "$", "Registry update input must be an inspectable object")];
  }
  const issues: RoomCapabilityRegistryUpdaterIssueV1[] = [];
  if (rawInput.contractVersion !== ROOM_CAPABILITY_REGISTRY_UPDATER_CONTRACT_VERSION) {
    issues.push(updaterIssue("sample_scope_mismatch", "$.contractVersion", "Only updater contract version 1 is supported"));
  }
  if (!isCanonicalText(rawInput.projectId)) {
    issues.push(updaterIssue("sample_scope_mismatch", "$.projectId", "Project identity must be a canonical non-empty string"));
  }
  if (!isCanonicalText(rawInput.roomId)) {
    issues.push(updaterIssue("sample_scope_mismatch", "$.roomId", "Room identity must be a canonical non-empty string"));
  }
  if (!isNonNegativeSafeInteger(rawInput.expectedAggregateVersion)) {
    issues.push(updaterIssue("sample_scope_mismatch", "$.expectedAggregateVersion", "Aggregate version must be a non-negative safe integer"));
  }
  if (!isNonNegativeSafeInteger(rawInput.expectedRegistryRevision)) {
    issues.push(updaterIssue("sample_scope_mismatch", "$.expectedRegistryRevision", "Registry revision must be a non-negative safe integer"));
  }
  if (!isRoomWorkerFence(rawInput.roomWorkerFence)) {
    issues.push(updaterIssue("sample_scope_mismatch", "$.roomWorkerFence", "A complete fenced room-worker identity is required"));
  }
  if (!isCanonicalText(rawInput.idempotencyKey)) {
    issues.push(updaterIssue("sample_scope_mismatch", "$.idempotencyKey", "Idempotency key must be a canonical non-empty string"));
  }
  if (!isCanonicalTimestamp(rawInput.sampledAt)) {
    issues.push(updaterIssue("sample_time_mismatch", "$.sampledAt", "Sampling time must be canonical UTC"));
  }
  if (!isFreshnessPolicy(rawInput.freshness)) {
    issues.push(updaterIssue("sample_scope_mismatch", "$.freshness", "Registry freshness policy must use bounded positive ages and non-negative future skew"));
  }
  if (!Array.isArray(rawInput.samples) || rawInput.samples.length === 0) {
    issues.push(updaterIssue("sample_scope_mismatch", "$.samples", "At least one trusted connector sample is required"));
  } else if (rawInput.samples.length > MAX_ROOM_CAPABILITY_REGISTRY_UPDATE_SAMPLES) {
    issues.push(updaterIssue("sample_limit_exceeded", "$.samples", `At most ${MAX_ROOM_CAPABILITY_REGISTRY_UPDATE_SAMPLES} samples may be written in one registry update`));
  }
  if (Array.isArray(rawInput.samples) && isFreshnessPolicy(rawInput.freshness)) {
    for (const [index, sample] of rawInput.samples.entries()) {
      if (!isRecord(sample) || !isRecord(sample.report)) continue;
      if (reportFreshnessExceedsRegistryFreshness(sample.report.freshness, rawInput.freshness)) {
        issues.push(updaterIssue(
          "report_freshness_exceeds_registry_freshness",
          `$.samples[${index}].report.freshness`,
          "Report freshness must not exceed the durable registry snapshot, signal, or future-skew bounds",
        ));
      }
    }
  }
  return issues;
}

function writerFailureMessage(error: unknown): string {
  if (error instanceof Error && isCanonicalText(error.message)) return error.message;
  return "Durable registry writer rejected the update";
}

/**
 * FNXC:RoomCapabilityRegistryUpdater 2026-07-18-11:38:
 * Task 6.1 needs an Engine-side, dependency-injected bridge from existing
 * trusted connector observations to Core's durable capability registry. This
 * adapter does not call a provider, infer missing capability fields, accept
 * peer/chat claims, or make a routing decision. It bounds samples, preserves
 * the caller's fence/idempotency/CAS values, and fails closed as
 * non-schedulable whenever the reporter or durable writer cannot prove state.
 */
export async function updateRoomCapabilityRegistry(
  rawInput: RoomCapabilityRegistryUpdateInputV1,
  writer: RoomCapabilityRegistryWriterPortV1,
): Promise<RoomCapabilityRegistryUpdateResultV1> {
  const inputIssues = validateInput(rawInput);
  if (inputIssues.length > 0) {
    return withheld(rawInput, {
      code: "invalid_input",
      message: "Capability registry update input failed closed validation",
    }, inputIssues);
  }
  if (!writer || typeof writer.recordRoomCapabilityRegistry !== "function") {
    return withheld(rawInput, {
      code: "writer_port_invalid",
      message: "A durable capability-registry writer port is required",
    }, [updaterIssue("writer_port_invalid", "$.writer", "Writer port must expose recordRoomCapabilityRegistry")]);
  }

  const input = rawInput as RoomCapabilityRegistryUpdateInputV1;
  const snapshots: CapabilityRegistrySnapshotV1[] = [];
  const issues: RoomCapabilityRegistryUpdaterIssueV1[] = [];
  const seenBindingIds = new Set<string>();
  for (const [index, sample] of input.samples.entries()) {
    const path = `$.samples[${index}]`;
    if (!isRecord(sample) || sample.source !== "trusted_session_connector") {
      issues.push(updaterIssue("sample_scope_mismatch", path + ".source", "Only trusted connector samples are accepted"));
      continue;
    }
    if (!isRecord(sample.report) || sample.report.asOf !== input.sampledAt) {
      issues.push(updaterIssue("sample_time_mismatch", path + ".report.asOf", "Every report must use the caller-supplied sampling time"));
      continue;
    }
    const report = createRoomBindingCapabilityReport(sample.report);
    if (!report.ok) {
      issues.push(...report.issues.map((issue) => reportIssue(
        issue.code,
        path + ".report" + issue.path.slice(1),
        issue.message,
      )));
      continue;
    }
    if (report.value.projectId !== input.projectId || report.value.roomId !== input.roomId) {
      issues.push(updaterIssue("sample_scope_mismatch", path + ".report.target", "Trusted sample must belong to this project and Room"));
      continue;
    }
    if (seenBindingIds.has(report.value.bindingId)) {
      issues.push(updaterIssue("duplicate_binding_sample", path + ".report.target.binding.id", "Only one trusted sample per binding may enter a registry update"));
      continue;
    }
    seenBindingIds.add(report.value.bindingId);
    snapshots.push(report.value.snapshot);
  }
  if (issues.length > 0) {
    return withheld(rawInput, {
      code: "reporter_rejected",
      message: "Trusted connector observations did not prove a writable capability registry",
    }, issues);
  }

  const samples = sortSamples(snapshots);
  const writtenSamples = samples.map(toWrittenSample);
  const scheduling = writtenSamples.every((sample) => sample.scheduling === "schedulable")
    ? "schedulable"
    : "not_schedulable";
  const writeInput: RecordRoomCapabilityRegistryInputV1 = {
    roomId: input.roomId,
    expectedAggregateVersion: input.expectedAggregateVersion,
    expectedRegistryRevision: input.expectedRegistryRevision,
    roomWorkerFence: input.roomWorkerFence,
    idempotencyKey: input.idempotencyKey,
    samples,
    freshness: input.freshness,
    asOf: input.sampledAt,
  };
  try {
    const write = await writer.recordRoomCapabilityRegistry(writeInput);
    return {
      ok: true,
      outcome: "written",
      scheduling,
      projectId: input.projectId,
      roomId: input.roomId,
      sampledAt: input.sampledAt,
      samples: writtenSamples,
      write,
    };
  } catch (error) {
    return {
      ok: false,
      outcome: "writer_rejected",
      scheduling: "not_schedulable",
      projectId: input.projectId,
      roomId: input.roomId,
      sampledAt: input.sampledAt,
      samples: writtenSamples,
      reason: {
        code: "writer_rejected",
        message: writerFailureMessage(error),
      },
    };
  }
}

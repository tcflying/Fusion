import type {
  RoomCapabilityRegistry,
  RoomBindingRecordV1,
  SessionConnectorCapabilitiesV1,
  SessionConnectorCapabilityState,
  SessionConnectorHealthV1,
  SessionConnectorIdentityV1,
} from "@fusion/core";
import type {
  CreateRoomBindingCapabilityReportInputV1,
  RoomBindingCapabilityReporterFreshnessV1,
} from "./room-binding-capability-reporter.js";
import { createRoomBindingCapabilityReport } from "./room-binding-capability-reporter.js";
import {
  updateRoomCapabilityRegistry,
  type RoomCapabilityRegistryUpdateInputV1,
  type RoomCapabilityRegistryUpdateResultV1,
  type RoomCapabilityRegistryUpdateSampleV1,
  type RoomCapabilityRegistryWriterPortV1,
} from "./room-capability-registry-updater.js";

export const ROOM_CONNECTOR_RUNTIME_OBSERVATION_REPORTER_CONTRACT_VERSION = 1 as const;

const RUNTIME_OBSERVATION_SOURCE = "controlled_connector_runtime_observation_port" as const;
const OBSERVABLE_CONCRETE_BINDING_STATES = new Set<RoomBindingRecordV1["state"]>([
  "attached",
  "paused",
  "authentication_blocked",
  "host_unavailable",
  "delivery_uncertain",
]);

/**
 * FNXC:RoomCapabilitySchedulingEvidence 2026-07-20-00:24:
 * Complete trusted capability evidence is useful even when it forbids work.
 * Keep this conservative scheduling classification shared by single-binding
 * reporting and multi-binding aggregation: only an attached Session with a
 * healthy connector/host, clear rate limit, and at least one verified tool
 * can receive a new task.
 */
export function isRoomConnectorCapabilitySnapshotSchedulable(
  binding: Pick<RoomBindingRecordV1, "state">,
  snapshot: RoomCapabilityRegistry.RoomBindingCapabilitySnapshotV1,
): boolean {
  return binding.state === "attached"
    && snapshot.health.connectorState === "healthy"
    && snapshot.health.hostState === "healthy"
    && snapshot.rateLimit.state === "clear"
    && snapshot.tools.length > 0
    && snapshot.tools.every((tool) => tool.state === "verified");
}

export type RoomConnectorRuntimeUnknownReasonV1 =
  | "not_collected"
  | "not_supported"
  | "unavailable"
  | "permission_denied"
  | "rate_limited"
  | "source_error";

export interface RoomConnectorRuntimeKnownV1<T> {
  readonly state: "known";
  readonly source: typeof RUNTIME_OBSERVATION_SOURCE;
  readonly observedAt: string;
  readonly value: T;
}

export interface RoomConnectorRuntimeUnknownV1 {
  readonly state: "unknown";
  readonly source: typeof RUNTIME_OBSERVATION_SOURCE;
  readonly observedAt: string;
  readonly reason: RoomConnectorRuntimeUnknownReasonV1;
}

export type RoomConnectorRuntimeFieldV1<T> =
  | RoomConnectorRuntimeKnownV1<T>
  | RoomConnectorRuntimeUnknownV1;

export interface RoomConnectorRuntimeSnapshotObservationV1 {
  readonly snapshotId: string;
  readonly revision: number;
  readonly capturedAt: string;
  readonly expiresAt: string;
}

export interface RoomConnectorRuntimeConnectorEvidenceV1 {
  readonly availability: "available" | "unavailable";
}

export interface RoomConnectorRuntimeModelObservationV1 {
  readonly providerId: string;
  readonly accountId: string;
  readonly modelId: string;
}

export interface RoomConnectorRuntimeNamedCapabilityObservationV1 {
  readonly name: string;
  readonly state: SessionConnectorCapabilityState;
  readonly evidenceRef: string | null;
}

export interface RoomConnectorRuntimeContextObservationV1 {
  readonly contextVersion: string;
  readonly maximumTokens: number;
  readonly availableTokens: number;
}

export interface RoomConnectorRuntimeWorkspaceAuthorityObservationV1 {
  readonly workspaceId: string;
  readonly scopes: readonly string[];
  readonly state: SessionConnectorCapabilityState;
}

export interface RoomConnectorRuntimeLatencyObservationV1 {
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly sampleCount: number;
}

export interface RoomConnectorRuntimeRateLimitObservationV1 {
  readonly state: SessionConnectorHealthV1["rateLimit"];
  readonly retryAfterMs: number | null;
}

export interface RoomConnectorRuntimeIndependentEvidenceV1 {
  readonly sourceId: string;
  readonly kind: "deterministic_gate" | "independent_review" | "observed_outcome";
  readonly score: number;
  readonly observedAt: string;
}

export interface RoomConnectorRuntimeDomainQualityObservationV1 {
  readonly domain: string;
  readonly independentEvidence: readonly RoomConnectorRuntimeIndependentEvidenceV1[];
}

export interface RoomConnectorRuntimeCalibrationObservationV1 {
  readonly domain: string;
  readonly outcomeCount: number;
  readonly meanAbsoluteError: number;
}

export interface RoomConnectorRuntimeObservationV1 {
  readonly contractVersion: typeof ROOM_CONNECTOR_RUNTIME_OBSERVATION_REPORTER_CONTRACT_VERSION;
  readonly source: typeof RUNTIME_OBSERVATION_SOURCE;
  readonly projectId: string;
  readonly roomId: string;
  readonly bindingId: string;
  readonly identity: SessionConnectorIdentityV1;
  readonly snapshot: RoomConnectorRuntimeFieldV1<RoomConnectorRuntimeSnapshotObservationV1>;
  readonly connectorEvidence: RoomConnectorRuntimeFieldV1<RoomConnectorRuntimeConnectorEvidenceV1>;
  readonly capabilities: RoomConnectorRuntimeFieldV1<SessionConnectorCapabilitiesV1>;
  readonly health: RoomConnectorRuntimeFieldV1<SessionConnectorHealthV1>;
  readonly model: RoomConnectorRuntimeFieldV1<RoomConnectorRuntimeModelObservationV1>;
  readonly tools: RoomConnectorRuntimeFieldV1<readonly RoomConnectorRuntimeNamedCapabilityObservationV1[]>;
  readonly mcps: RoomConnectorRuntimeFieldV1<readonly RoomConnectorRuntimeNamedCapabilityObservationV1[]>;
  readonly skills: RoomConnectorRuntimeFieldV1<readonly RoomConnectorRuntimeNamedCapabilityObservationV1[]>;
  readonly context: RoomConnectorRuntimeFieldV1<RoomConnectorRuntimeContextObservationV1>;
  readonly workspaceAuthority: RoomConnectorRuntimeFieldV1<RoomConnectorRuntimeWorkspaceAuthorityObservationV1>;
  readonly latency: RoomConnectorRuntimeFieldV1<RoomConnectorRuntimeLatencyObservationV1>;
  readonly rateLimit: RoomConnectorRuntimeFieldV1<RoomConnectorRuntimeRateLimitObservationV1>;
  readonly domainQuality: RoomConnectorRuntimeFieldV1<readonly RoomConnectorRuntimeDomainQualityObservationV1[]>;
  readonly calibration: RoomConnectorRuntimeFieldV1<readonly RoomConnectorRuntimeCalibrationObservationV1[]>;
}

export interface ControlledRoomConnectorRuntimeObservationRequestV1 {
  readonly contractVersion: typeof ROOM_CONNECTOR_RUNTIME_OBSERVATION_REPORTER_CONTRACT_VERSION;
  readonly projectId: string;
  readonly roomId: string;
  readonly binding: RoomBindingRecordV1;
  readonly asOf: string;
}

export interface ControlledRoomConnectorRuntimeObservationPortV1 {
  observe(
    request: ControlledRoomConnectorRuntimeObservationRequestV1,
  ): Promise<RoomConnectorRuntimeObservationV1>;
}

export interface RoomConnectorRuntimeObservationRegistryUpdateV1 {
  readonly expectedAggregateVersion: number;
  readonly expectedRegistryRevision: number;
  readonly roomWorkerFence: RoomCapabilityRegistryUpdateInputV1["roomWorkerFence"];
  readonly idempotencyKey: string;
  readonly freshness: RoomCapabilityRegistryUpdateInputV1["freshness"];
}

export interface RoomConnectorRuntimeObservationInputV1 {
  readonly contractVersion: typeof ROOM_CONNECTOR_RUNTIME_OBSERVATION_REPORTER_CONTRACT_VERSION;
  readonly asOf: string;
  readonly reportFreshness: RoomBindingCapabilityReporterFreshnessV1;
  readonly target: {
    readonly projectId: string;
    readonly roomId: string;
    readonly binding: RoomBindingRecordV1;
  };
  readonly registryUpdate: RoomConnectorRuntimeObservationRegistryUpdateV1;
}

export type RoomConnectorRuntimeObservationReporterIssueCodeV1 =
  | "invalid_input"
  | "observation_port_invalid"
  | "observation_port_failed"
  | "runtime_source_untrusted"
  | "runtime_scope_mismatch"
  | "binding_mismatch"
  | "identity_mismatch"
  | "runtime_observation_invalid"
  | "runtime_observation_unknown"
  | "model_claim_mismatch"
  | "model_self_report_rejected"
  | "rate_limit_mismatch";

export interface RoomConnectorRuntimeObservationReporterIssueV1 {
  readonly code: RoomConnectorRuntimeObservationReporterIssueCodeV1;
  readonly path: string;
  readonly message: string;
}

export interface RoomConnectorRuntimeUnknownFieldV1 {
  readonly field: RoomConnectorRuntimeFieldNameV1;
  readonly reason: RoomConnectorRuntimeUnknownReasonV1;
  readonly observedAt: string;
}

export type RoomConnectorRuntimeFieldNameV1 =
  | "snapshot"
  | "connectorEvidence"
  | "capabilities"
  | "health"
  | "model"
  | "tools"
  | "mcps"
  | "skills"
  | "context"
  | "workspaceAuthority"
  | "latency"
  | "rateLimit"
  | "domainQuality"
  | "calibration";

export type RoomConnectorRuntimeObservationReporterResultV1 =
  | {
    readonly ok: true;
    readonly outcome: "reported";
    readonly scheduling: "schedulable" | "not_schedulable";
    readonly projectId: string;
    readonly roomId: string;
    readonly bindingId: string;
    readonly unknown: readonly [];
    readonly update: Extract<RoomCapabilityRegistryUpdateResultV1, { readonly ok: true }>;
  }
  | {
    readonly ok: false;
    readonly outcome: "withheld";
    readonly scheduling: "not_schedulable";
    readonly projectId: string | null;
    readonly roomId: string | null;
    readonly bindingId: string | null;
    readonly reason: {
      readonly code: RoomConnectorRuntimeObservationReporterIssueCodeV1;
      readonly message: string;
    };
    readonly issues: readonly RoomConnectorRuntimeObservationReporterIssueV1[];
    readonly unknown: readonly RoomConnectorRuntimeUnknownFieldV1[];
  }
  | {
    readonly ok: false;
    readonly outcome: "registry_rejected";
    readonly scheduling: "not_schedulable";
    readonly projectId: string;
    readonly roomId: string;
    readonly bindingId: string;
    readonly unknown: readonly [];
    readonly update: Exclude<RoomCapabilityRegistryUpdateResultV1, { readonly ok: true }>;
  };

/**
 * FNXC:RoomCapabilityAtomicAggregation 2026-07-19-23:58:
 * Producing a trusted sample is deliberately separate from committing it. A
 * controller that owns multiple active bindings must collect every concrete
 * observation and submit one all-or-nothing registry update, never persist a
 * partial first sample merely because one connector replied earlier.
 */
export type RoomConnectorRuntimeObservationCollectionResultV1 =
  | {
    readonly ok: true;
    readonly outcome: "collected";
    readonly scheduling: "schedulable" | "not_schedulable";
    readonly projectId: string;
    readonly roomId: string;
    readonly bindingId: string;
    readonly unknown: readonly [];
    readonly sample: RoomCapabilityRegistryUpdateSampleV1;
  }
  | Extract<RoomConnectorRuntimeObservationReporterResultV1, { readonly outcome: "withheld" }>;

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

function issue(
  code: RoomConnectorRuntimeObservationReporterIssueCodeV1,
  path: string,
  message: string,
): RoomConnectorRuntimeObservationReporterIssueV1 {
  return { code, path, message };
}

function sortIssues(
  issues: readonly RoomConnectorRuntimeObservationReporterIssueV1[],
): readonly RoomConnectorRuntimeObservationReporterIssueV1[] {
  return [...issues].sort((left, right) => {
    const code = left.code.localeCompare(right.code);
    return code === 0 ? left.path.localeCompare(right.path) : code;
  });
}

function sameIdentity(
  left: SessionConnectorIdentityV1,
  right: SessionConnectorIdentityV1,
): boolean {
  return left.connectorId === right.connectorId
    && left.providerId === right.providerId
    && left.nativeSessionId === right.nativeSessionId
    && left.happierSessionId === right.happierSessionId
    && left.serverProfileId === right.serverProfileId
    && left.machineId === right.machineId
    && left.hostId === right.hostId;
}

function bindingIdentity(binding: RoomBindingRecordV1): SessionConnectorIdentityV1 {
  return {
    connectorId: binding.connectorId,
    providerId: binding.providerId,
    nativeSessionId: binding.nativeSessionId,
    happierSessionId: binding.happierSessionId,
    serverProfileId: binding.serverProfileId,
    machineId: binding.machineId,
    hostId: binding.hostId,
  };
}

function inputReferences(rawInput: unknown): {
  readonly projectId: string | null;
  readonly roomId: string | null;
  readonly bindingId: string | null;
} {
  if (!isRecord(rawInput) || !isRecord(rawInput.target)) {
    return { projectId: null, roomId: null, bindingId: null };
  }
  const binding = isRecord(rawInput.target.binding) ? rawInput.target.binding : null;
  return {
    projectId: isCanonicalText(rawInput.target.projectId) ? rawInput.target.projectId : null,
    roomId: isCanonicalText(rawInput.target.roomId) ? rawInput.target.roomId : null,
    bindingId: binding && isCanonicalText(binding.id) ? binding.id : null,
  };
}

function withheld(
  rawInput: unknown,
  reason: RoomConnectorRuntimeObservationReporterIssueV1,
  issues: readonly RoomConnectorRuntimeObservationReporterIssueV1[],
  unknown: readonly RoomConnectorRuntimeUnknownFieldV1[] = [],
): Extract<RoomConnectorRuntimeObservationReporterResultV1, { readonly outcome: "withheld" }> {
  const references = inputReferences(rawInput);
  return {
    ok: false,
    outcome: "withheld",
    scheduling: "not_schedulable",
    ...references,
    reason: { code: reason.code, message: reason.message },
    issues: sortIssues(issues),
    unknown: [...unknown],
  };
}

function validateInput(
  rawInput: unknown,
): readonly RoomConnectorRuntimeObservationReporterIssueV1[] {
  if (!isRecord(rawInput)) {
    return [issue("invalid_input", "$", "Runtime observation report input must be an inspectable object")];
  }
  const issues: RoomConnectorRuntimeObservationReporterIssueV1[] = [];
  if (rawInput.contractVersion !== ROOM_CONNECTOR_RUNTIME_OBSERVATION_REPORTER_CONTRACT_VERSION) {
    issues.push(issue("invalid_input", "$.contractVersion", "Runtime observation reporter contract version is unsupported"));
  }
  if (!isCanonicalTimestamp(rawInput.asOf)) {
    issues.push(issue("invalid_input", "$.asOf", "Decision time must be canonical UTC"));
  }
  if (!isRecord(rawInput.target)) {
    issues.push(issue("invalid_input", "$.target", "Target must be an inspectable object"));
    return issues;
  }
  if (!isCanonicalText(rawInput.target.projectId)) {
    issues.push(issue("invalid_input", "$.target.projectId", "Project identifier must be canonical"));
  }
  if (!isCanonicalText(rawInput.target.roomId)) {
    issues.push(issue("invalid_input", "$.target.roomId", "Room identifier must be canonical"));
  }
  if (!isRecord(rawInput.target.binding)) {
    issues.push(issue("invalid_input", "$.target.binding", "Binding must be an inspectable object"));
    return issues;
  }
  const binding = rawInput.target.binding;
  if (!isCanonicalText(binding.id)) {
    issues.push(issue("invalid_input", "$.target.binding.id", "Binding identifier must be canonical"));
  }
  if (binding.roomId !== rawInput.target.roomId) {
    issues.push(issue("binding_mismatch", "$.target.binding.roomId", "Binding must belong to the requested Room"));
  }
  if (
    typeof binding.state !== "string"
    || !OBSERVABLE_CONCRETE_BINDING_STATES.has(binding.state as RoomBindingRecordV1["state"])
    || binding.detachedAt !== null
  ) {
    issues.push(issue("binding_mismatch", "$.target.binding.state", "Only a current concrete binding can be runtime-observed"));
  }
  return issues;
}

function isUnknownReason(value: unknown): value is RoomConnectorRuntimeUnknownReasonV1 {
  return value === "not_collected"
    || value === "not_supported"
    || value === "unavailable"
    || value === "permission_denied"
    || value === "rate_limited"
    || value === "source_error";
}

function readRuntimeField<T>(
  value: unknown,
  field: RoomConnectorRuntimeFieldNameV1,
  issues: RoomConnectorRuntimeObservationReporterIssueV1[],
  unknown: RoomConnectorRuntimeUnknownFieldV1[],
): T | null {
  const path = "$.observation." + field;
  if (!isRecord(value)) {
    issues.push(issue("runtime_observation_invalid", path, "Runtime field must be an inspectable object"));
    return null;
  }
  if (value.source !== RUNTIME_OBSERVATION_SOURCE) {
    issues.push(issue("runtime_source_untrusted", path + ".source", "Only the controlled connector runtime observation port is trusted"));
    return null;
  }
  if (!isCanonicalTimestamp(value.observedAt)) {
    issues.push(issue("runtime_observation_invalid", path + ".observedAt", "Runtime field time must be canonical UTC"));
    return null;
  }
  if (value.state === "unknown") {
    if (!isUnknownReason(value.reason)) {
      issues.push(issue("runtime_observation_invalid", path + ".reason", "Unknown runtime field must name a controlled reason"));
      return null;
    }
    unknown.push({ field, reason: value.reason, observedAt: value.observedAt });
    return null;
  }
  if (value.state !== "known" || !("value" in value)) {
    issues.push(issue("runtime_observation_invalid", path, "Runtime field must be known or explicitly unknown"));
    return null;
  }
  return value.value as T;
}

function hasModelSelfReport(
  domainQuality: unknown,
  bindingId: string,
): boolean {
  if (!Array.isArray(domainQuality)) return false;
  return domainQuality.some((entry) => {
    if (!isRecord(entry)) return false;
    if (entry.selfReportedScore !== undefined && entry.selfReportedScore !== null) return true;
    if (!Array.isArray(entry.independentEvidence)) return false;
    return entry.independentEvidence.some((evidence) => (
      isRecord(evidence) && evidence.sourceId === bindingId
    ));
  });
}

function asNamedCapabilities(
  values: readonly RoomConnectorRuntimeNamedCapabilityObservationV1[],
  observedAt: string,
): CreateRoomBindingCapabilityReportInputV1["observation"]["tools"] {
  return values.map((value) => ({
    source: "trusted_session_connector",
    name: value.name,
    state: value.state,
    evidenceRef: value.evidenceRef,
    observedAt,
  }));
}

function asDomainQuality(
  values: readonly RoomConnectorRuntimeDomainQualityObservationV1[],
): CreateRoomBindingCapabilityReportInputV1["observation"]["domainQuality"] {
  return values.map((value) => ({
    source: "trusted_room_evidence",
    domain: value.domain,
    selfReportedScore: null,
    independentEvidence: value.independentEvidence.map((evidence) => ({
      sourceId: evidence.sourceId,
      kind: evidence.kind,
      score: evidence.score,
      observedAt: evidence.observedAt,
    })),
  }));
}

function asCalibration(
  values: readonly RoomConnectorRuntimeCalibrationObservationV1[],
  observedAt: string,
): CreateRoomBindingCapabilityReportInputV1["observation"]["calibration"] {
  return values.map((value) => ({
    source: "trusted_room_evidence",
    domain: value.domain,
    outcomeCount: value.outcomeCount,
    meanAbsoluteError: value.meanAbsoluteError,
    observedAt,
  }));
}

function registryRejected(
  input: RoomConnectorRuntimeObservationInputV1,
  update: Exclude<RoomCapabilityRegistryUpdateResultV1, { readonly ok: true }>,
): Extract<RoomConnectorRuntimeObservationReporterResultV1, { readonly outcome: "registry_rejected" }> {
  return {
    ok: false,
    outcome: "registry_rejected",
    scheduling: "not_schedulable",
    projectId: input.target.projectId,
    roomId: input.target.roomId,
    bindingId: input.target.binding.id,
    unknown: [],
    update,
  };
}

export async function collectRoomConnectorRuntimeObservation(
  rawInput: RoomConnectorRuntimeObservationInputV1,
  observationPort: ControlledRoomConnectorRuntimeObservationPortV1,
): Promise<RoomConnectorRuntimeObservationCollectionResultV1> {
  const inputIssues = validateInput(rawInput);
  if (inputIssues.length > 0) {
    return withheld(rawInput, inputIssues[0]!, inputIssues);
  }
  const input = rawInput;
  if (!observationPort || typeof observationPort.observe !== "function") {
    const portIssue = issue("observation_port_invalid", "$.observationPort", "Controlled runtime observation port is required");
    return withheld(input, portIssue, [portIssue]);
  }

  let observation: RoomConnectorRuntimeObservationV1;
  try {
    observation = await observationPort.observe({
      contractVersion: ROOM_CONNECTOR_RUNTIME_OBSERVATION_REPORTER_CONTRACT_VERSION,
      projectId: input.target.projectId,
      roomId: input.target.roomId,
      binding: input.target.binding,
      asOf: input.asOf,
    });
  } catch {
    const portIssue = issue("observation_port_failed", "$.observationPort.observe", "Controlled runtime observation port failed without a report");
    return withheld(input, portIssue, [portIssue]);
  }

  const issues: RoomConnectorRuntimeObservationReporterIssueV1[] = [];
  if (!isRecord(observation) || observation.contractVersion !== ROOM_CONNECTOR_RUNTIME_OBSERVATION_REPORTER_CONTRACT_VERSION) {
    issues.push(issue("runtime_observation_invalid", "$.observation.contractVersion", "Runtime observation contract version is unsupported"));
  }
  if (!isRecord(observation) || observation.source !== RUNTIME_OBSERVATION_SOURCE) {
    issues.push(issue("runtime_source_untrusted", "$.observation.source", "Runtime observation must originate from the controlled port"));
  }
  if (
    !isRecord(observation)
    || observation.projectId !== input.target.projectId
    || observation.roomId !== input.target.roomId
  ) {
    issues.push(issue("runtime_scope_mismatch", "$.observation", "Runtime observation must match the requested project and Room"));
  }
  if (!isRecord(observation) || observation.bindingId !== input.target.binding.id) {
    issues.push(issue("binding_mismatch", "$.observation.bindingId", "Runtime observation must match the requested binding"));
  }
  if (!isRecord(observation) || !sameIdentity(observation.identity, bindingIdentity(input.target.binding))) {
    issues.push(issue("identity_mismatch", "$.observation.identity", "Runtime identity must match the concrete bound Session"));
  }
  if (issues.length > 0) {
    return withheld(input, issues[0]!, issues);
  }

  const unknown: RoomConnectorRuntimeUnknownFieldV1[] = [];
  const snapshot = readRuntimeField<RoomConnectorRuntimeSnapshotObservationV1>(observation.snapshot, "snapshot", issues, unknown);
  const connectorEvidence = readRuntimeField<RoomConnectorRuntimeConnectorEvidenceV1>(observation.connectorEvidence, "connectorEvidence", issues, unknown);
  const capabilities = readRuntimeField<SessionConnectorCapabilitiesV1>(observation.capabilities, "capabilities", issues, unknown);
  const health = readRuntimeField<SessionConnectorHealthV1>(observation.health, "health", issues, unknown);
  const model = readRuntimeField<RoomConnectorRuntimeModelObservationV1>(observation.model, "model", issues, unknown);
  const tools = readRuntimeField<readonly RoomConnectorRuntimeNamedCapabilityObservationV1[]>(observation.tools, "tools", issues, unknown);
  const mcps = readRuntimeField<readonly RoomConnectorRuntimeNamedCapabilityObservationV1[]>(observation.mcps, "mcps", issues, unknown);
  const skills = readRuntimeField<readonly RoomConnectorRuntimeNamedCapabilityObservationV1[]>(observation.skills, "skills", issues, unknown);
  const context = readRuntimeField<RoomConnectorRuntimeContextObservationV1>(observation.context, "context", issues, unknown);
  const workspaceAuthority = readRuntimeField<RoomConnectorRuntimeWorkspaceAuthorityObservationV1>(observation.workspaceAuthority, "workspaceAuthority", issues, unknown);
  const latency = readRuntimeField<RoomConnectorRuntimeLatencyObservationV1>(observation.latency, "latency", issues, unknown);
  const rateLimit = readRuntimeField<RoomConnectorRuntimeRateLimitObservationV1>(observation.rateLimit, "rateLimit", issues, unknown);
  const domainQuality = readRuntimeField<readonly RoomConnectorRuntimeDomainQualityObservationV1[]>(observation.domainQuality, "domainQuality", issues, unknown);
  const calibration = readRuntimeField<readonly RoomConnectorRuntimeCalibrationObservationV1[]>(observation.calibration, "calibration", issues, unknown);

  if (issues.length > 0) {
    return withheld(input, issues[0]!, issues, unknown);
  }
  if (unknown.length > 0) {
    const unknownIssue = issue("runtime_observation_unknown", "$.observation", "Required connector runtime fields are explicitly unknown");
    return withheld(input, unknownIssue, [unknownIssue], unknown);
  }
  if (
    !snapshot
    || !connectorEvidence
    || !capabilities
    || !health
    || !model
    || !tools
    || !mcps
    || !skills
    || !context
    || !workspaceAuthority
    || !latency
    || !rateLimit
    || !domainQuality
    || !calibration
  ) {
    const invalidIssue = issue("runtime_observation_invalid", "$.observation", "Known runtime fields are incomplete");
    return withheld(input, invalidIssue, [invalidIssue]);
  }
  if (
    health.rateLimit !== rateLimit.state
    || health.retryAfterMs !== rateLimit.retryAfterMs
  ) {
    const rateIssue = issue("rate_limit_mismatch", "$.observation.rateLimit", "Rate-limit observation must agree with connector health");
    return withheld(input, rateIssue, [rateIssue]);
  }
  if (
    model.providerId !== input.target.binding.providerId
    || model.providerId !== observation.identity.providerId
  ) {
    const modelIssue = issue("model_claim_mismatch", "$.observation.model.providerId", "Observed provider must match the concrete binding");
    return withheld(input, modelIssue, [modelIssue]);
  }
  if (hasModelSelfReport(domainQuality, input.target.binding.id)) {
    const qualityIssue = issue("model_self_report_rejected", "$.observation.domainQuality", "Model self-reported quality cannot become runtime evidence");
    return withheld(input, qualityIssue, [qualityIssue]);
  }

  const report: CreateRoomBindingCapabilityReportInputV1 = {
    contractVersion: 1,
    asOf: input.asOf,
    freshness: input.reportFreshness,
    target: {
      projectId: input.target.projectId,
      roomId: input.target.roomId,
      binding: input.target.binding,
      runtime: {
        source: "trusted_session_connector_binding",
        identity: observation.identity,
        accountId: model.accountId,
        modelId: model.modelId,
        observedAt: observation.model.observedAt,
      },
    },
    observation: {
      source: "trusted_session_connector",
      connectorEvidence: {
        source: "trusted_session_connector",
        availability: connectorEvidence.availability,
        observedAt: observation.connectorEvidence.observedAt,
      },
      projectId: input.target.projectId,
      roomId: input.target.roomId,
      bindingId: input.target.binding.id,
      snapshotId: snapshot.snapshotId,
      revision: snapshot.revision,
      capturedAt: snapshot.capturedAt,
      expiresAt: snapshot.expiresAt,
      identity: observation.identity,
      capabilities,
      health,
      model: {
        source: "trusted_session_connector",
        providerId: model.providerId,
        accountId: model.accountId,
        modelId: model.modelId,
        observedAt: observation.model.observedAt,
      },
      tools: asNamedCapabilities(tools, observation.tools.observedAt),
      mcps: asNamedCapabilities(mcps, observation.mcps.observedAt),
      skills: asNamedCapabilities(skills, observation.skills.observedAt),
      context: {
        source: "trusted_session_connector",
        contextVersion: context.contextVersion,
        maximumTokens: context.maximumTokens,
        availableTokens: context.availableTokens,
        observedAt: observation.context.observedAt,
      },
      workspaceAuthority: {
        source: "trusted_session_connector",
        workspaceId: workspaceAuthority.workspaceId,
        scopes: workspaceAuthority.scopes,
        state: workspaceAuthority.state,
        observedAt: observation.workspaceAuthority.observedAt,
      },
      latency: {
        source: "trusted_session_connector",
        p50Ms: latency.p50Ms,
        p95Ms: latency.p95Ms,
        sampleCount: latency.sampleCount,
        observedAt: observation.latency.observedAt,
      },
      domainQuality: asDomainQuality(domainQuality),
      calibration: asCalibration(calibration, observation.calibration.observedAt),
    },
  };
  const createdReport = createRoomBindingCapabilityReport(report);
  if (!createdReport.ok) {
    const firstIssue = createdReport.issues[0];
    const reporterIssue = issue(
      "runtime_observation_invalid",
      "$.observation",
      firstIssue?.message ?? "Controlled runtime observation could not form a trusted capability report",
    );
    return withheld(input, reporterIssue, [reporterIssue]);
  }
  return {
    ok: true,
    outcome: "collected",
    scheduling: isRoomConnectorCapabilitySnapshotSchedulable(
      input.target.binding,
      createdReport.value.snapshot,
    ) ? "schedulable" : "not_schedulable",
    projectId: input.target.projectId,
    roomId: input.target.roomId,
    bindingId: input.target.binding.id,
    unknown: [],
    sample: { source: "trusted_session_connector", report },
  };
}

export async function reportRoomConnectorRuntimeObservation(
  rawInput: RoomConnectorRuntimeObservationInputV1,
  observationPort: ControlledRoomConnectorRuntimeObservationPortV1,
  writer: RoomCapabilityRegistryWriterPortV1,
): Promise<RoomConnectorRuntimeObservationReporterResultV1> {
  const collected = await collectRoomConnectorRuntimeObservation(rawInput, observationPort);
  if (!collected.ok) return collected;

  const update = await updateRoomCapabilityRegistry({
    contractVersion: 1,
    projectId: rawInput.target.projectId,
    roomId: rawInput.target.roomId,
    expectedAggregateVersion: rawInput.registryUpdate.expectedAggregateVersion,
    expectedRegistryRevision: rawInput.registryUpdate.expectedRegistryRevision,
    roomWorkerFence: rawInput.registryUpdate.roomWorkerFence,
    idempotencyKey: rawInput.registryUpdate.idempotencyKey,
    sampledAt: rawInput.asOf,
    freshness: rawInput.registryUpdate.freshness,
    samples: [collected.sample],
  }, writer);
  if (!update.ok) return registryRejected(rawInput, update);
  return {
    ok: true,
    outcome: "reported",
    scheduling: collected.scheduling === "schedulable" && update.scheduling === "schedulable"
      ? "schedulable"
      : "not_schedulable",
    projectId: rawInput.target.projectId,
    roomId: rawInput.target.roomId,
    bindingId: rawInput.target.binding.id,
    unknown: [],
    update,
  };
}

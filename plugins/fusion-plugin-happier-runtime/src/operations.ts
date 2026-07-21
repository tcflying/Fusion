import { invokeHappierJsonForKind } from "./cli-spawn.js";
import {
  HappierCliError,
  type HappierCliSettings,
  type HappierJsonRecord,
} from "./types.js";

export type HappierOperation = "review" | "plan" | "delegate";
export type HappierRunStatus = "running" | "succeeded" | "failed" | "cancelled" | "timeout";

export interface HappierParticipantStart {
  key: string;
  ok: boolean;
  status: "started" | "failed";
  runId?: string;
  callId?: string;
  sidechainId?: string;
  errorCode?: string;
  error?: string;
}

export interface HappierOperationStartResult {
  sessionId: string;
  operation: HappierOperation;
  status: "started" | "partial_failure" | "failed";
  participants: HappierParticipantStart[];
}

/** Compact payload for the owning Fusion run's existing resultJson field. */
export interface HappierOperationMetadataV1 {
  version: 1;
  sessionId: string;
  operation: HappierOperation;
  status: HappierOperationStartResult["status"];
  participants: Array<Pick<HappierParticipantStart, "key" | "ok" | "status" | "runId" | "callId" | "sidechainId" | "errorCode">>;
}

export interface HappierRunState extends HappierJsonRecord {
  runId: string;
  callId: string;
  sidechainId: string;
  intent: string;
  backendTarget: HappierJsonRecord;
  participantKey: string;
  status: HappierRunStatus;
}

export interface HappierRunReadResult extends HappierJsonRecord {
  sessionId: string;
  run: HappierRunState;
  latestToolResult?: unknown;
  structuredMeta?: HappierJsonRecord;
  structuredMetaArtifactRef?: HappierJsonRecord;
}

export interface HappierRunListResult extends HappierJsonRecord {
  sessionId: string;
  runs: HappierRunState[];
}

export interface HappierRunWaitResult {
  sessionId: string;
  runId: string;
  status: HappierRunStatus;
}

interface StartBase {
  sessionId: string;
  instructions: string;
  permissionMode?: string;
}

export interface StartHappierReviewInput extends Omit<StartBase, "instructions"> {
  engines: string[];
  instructions?: string;
  changeType?: string;
  baseBranch?: string;
  baseCommit?: string;
  coderabbitConfigFiles?: string[];
}

export interface StartHappierPlanInput extends StartBase {
  backends: string[];
  retentionPolicy?: string;
  runClass?: string;
  ioMode?: string;
}

export type StartHappierDelegateInput = StartHappierPlanInput;

export interface HappierRunListOptions {
  backend?: string;
  status?: HappierRunStatus;
  limit?: number;
}

export interface HappierRunReadOptions {
  includeStructured?: boolean;
}

export interface HappierRunWaitOptions {
  timeoutSeconds?: number;
}

const RUN_STATUSES = new Set<HappierRunStatus>(["running", "succeeded", "failed", "cancelled", "timeout"]);

function isRecord(value: unknown): value is HappierJsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** FNXC:HappierRuntime 2026-07-16-11:17: Operation identifiers reject C0 controls and DEL without regex lint suppression. */
function hasForbiddenControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
  }
  return false;
}

function requiredText(value: unknown, field: string, maximum = 512): string {
  if (typeof value !== "string") throw new HappierCliError("protocol", `${field} must be a string`);
  const result = value.trim();
  if (!result || result.length > maximum || hasForbiddenControlCharacter(result)) {
    throw new HappierCliError("protocol", `${field} is invalid`);
  }
  return result;
}

function expectedSessionId(value: unknown, requested: string, operation: string): string {
  const returned = requiredText(value, "sessionId");
  if (returned !== requested) {
    throw new HappierCliError("session", `Happier ${operation} returned a mismatched session id`);
  }
  return returned;
}

function expectedRunId(value: unknown, requested: string, operation: string): string {
  const returned = requiredText(value, "runId");
  if (returned !== requested) {
    throw new HappierCliError("protocol", `Happier ${operation} returned a mismatched run id`);
  }
  return returned;
}

function optionalFlag(args: string[], flag: string, value: string | undefined): void {
  if (value === undefined) return;
  args.push(flag, requiredText(value, flag, 4_096));
}

function requiredContent(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string") throw new HappierCliError("protocol", `${field} must be a string`);
  const result = value.trim();
  if (!result || result.length > maximum || result.includes("\u0000")) {
    throw new HappierCliError("protocol", `${field} is invalid`);
  }
  return result;
}

function participantIds(values: readonly string[], field: string): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 32) {
    throw new HappierCliError("protocol", `${field} participant list must contain 1-32 entries`);
  }
  const result = values.map((value) => requiredText(value, `${field} participant`, 256));
  if (result.some((value) => value.includes(","))) {
    throw new HappierCliError("protocol", `${field} participant ids cannot contain commas`);
  }
  if (new Set(result).size !== result.length) {
    throw new HappierCliError("protocol", `${field} participant ids must be unique`);
  }
  return result;
}

function expectedParticipantKeys(operation: HappierOperation, participants: readonly string[]): Set<string> {
  return new Set(operation === "review"
    ? participants
    : participants.map((participant) => participant.startsWith("agent:") || participant.startsWith("acpBackend:")
      ? participant
      : `agent:${participant}`));
}

function parseStartResult(
  raw: unknown,
  operation: HappierOperation,
  expectedSessionIdValue: string,
  expectedParticipants: readonly string[],
): HappierOperationStartResult {
  if (!isRecord(raw)) throw new HappierCliError("protocol", `Happier ${operation} start returned invalid data`);
  const sessionId = expectedSessionId(raw.sessionId, expectedSessionIdValue, `${operation} start`);
  if (!Array.isArray(raw.results) || raw.results.length !== expectedParticipants.length) {
    throw new HappierCliError("protocol", `Happier ${operation} start returned an invalid participant result count`);
  }

  const expectedKeys = expectedParticipantKeys(operation, expectedParticipants);
  const seen = new Set<string>();
  const participants = raw.results.map((item): HappierParticipantStart => {
    if (!isRecord(item) || typeof item.ok !== "boolean") {
      throw new HappierCliError("protocol", `Happier ${operation} start returned an invalid participant result`);
    }
    const key = requiredText(item.key, "participant key", 256);
    if (!expectedKeys.has(key) || seen.has(key)) {
      throw new HappierCliError("protocol", `Happier ${operation} start returned an unexpected participant key`);
    }
    seen.add(key);

    if (!item.ok) {
      const errorCode = typeof item.errorCode === "string" && item.errorCode.trim() ? item.errorCode.trim() : undefined;
      const error = typeof item.error === "string" && item.error.trim() ? item.error.trim() : undefined;
      return { key, ok: false, status: "failed", ...(errorCode ? { errorCode } : {}), ...(error ? { error } : {}) };
    }
    if (!isRecord(item.result)) throw new HappierCliError("protocol", `Happier ${operation} start returned invalid run metadata`);
    return {
      key,
      ok: true,
      status: "started",
      runId: requiredText(item.result.runId, "runId"),
      callId: requiredText(item.result.callId, "callId"),
      sidechainId: requiredText(item.result.sidechainId, "sidechainId"),
    };
  });

  const failures = participants.filter((participant) => !participant.ok).length;
  return {
    sessionId,
    operation,
    status: failures === 0 ? "started" : failures === participants.length ? "failed" : "partial_failure",
    participants,
  };
}

export function withHappierOperationMetadata(
  existing: Record<string, unknown> | undefined,
  result: HappierOperationStartResult,
): Record<string, unknown> {
  const metadata: HappierOperationMetadataV1 = {
    version: 1,
    sessionId: result.sessionId,
    operation: result.operation,
    status: result.status,
    participants: result.participants.map(({ key, ok, status, runId, callId, sidechainId, errorCode }) => ({
      key,
      ok,
      status,
      ...(runId ? { runId } : {}),
      ...(callId ? { callId } : {}),
      ...(sidechainId ? { sidechainId } : {}),
      ...(errorCode ? { errorCode } : {}),
    })),
  };
  return { ...(existing ?? {}), happierOperation: metadata };
}

async function startOperation(
  operation: HappierOperation,
  sessionIdValue: string,
  participantFlag: "--engines" | "--backends",
  participantValues: readonly string[],
  instructions: string | undefined,
  extraFlags: readonly [string, string | undefined][],
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): Promise<HappierOperationStartResult> {
  const sessionId = requiredText(sessionIdValue, "sessionId");
  const participants = participantIds(participantValues, operation);
  const args = ["session", operation, "start", sessionId, participantFlag, participants.join(",")];
  if (operation !== "review" || instructions?.trim()) {
    args.push("--instructions", requiredContent(instructions, "instructions", 100_000));
  }
  for (const [flag, value] of extraFlags) optionalFlag(args, flag, value);
  args.push("--json");
  const raw = await invokeHappierJsonForKind(args, `session_${operation}_start`, settings, signal);
  return parseStartResult(raw, operation, sessionId, participants);
}

export function startHappierReview(
  input: StartHappierReviewInput,
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): Promise<HappierOperationStartResult> {
  if (input.baseBranch && input.baseCommit) throw new HappierCliError("protocol", "Review baseBranch and baseCommit are mutually exclusive");
  const configFiles = input.coderabbitConfigFiles?.length
    ? participantIds(input.coderabbitConfigFiles, "coderabbit config")
    : [];
  return startOperation("review", input.sessionId, "--engines", input.engines, input.instructions, [
    ["--change-type", input.changeType],
    ["--base-branch", input.baseBranch],
    ["--base-commit", input.baseCommit],
    ["--coderabbit-config", configFiles.length ? configFiles.join(",") : undefined],
    ["--permission-mode", input.permissionMode],
  ], settings, signal);
}

export function startHappierPlan(
  input: StartHappierPlanInput,
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): Promise<HappierOperationStartResult> {
  return startOperation("plan", input.sessionId, "--backends", input.backends, input.instructions, [
    ["--permission-mode", input.permissionMode],
    ["--retention", input.retentionPolicy],
    ["--run-class", input.runClass],
    ["--io-mode", input.ioMode],
  ], settings, signal);
}

export function startHappierDelegate(
  input: StartHappierDelegateInput,
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): Promise<HappierOperationStartResult> {
  return startOperation("delegate", input.sessionId, "--backends", input.backends, input.instructions, [
    ["--permission-mode", input.permissionMode],
    ["--retention", input.retentionPolicy],
    ["--run-class", input.runClass],
    ["--io-mode", input.ioMode],
  ], settings, signal);
}

function parseRunStatus(value: unknown): HappierRunStatus {
  if (typeof value !== "string" || !RUN_STATUSES.has(value as HappierRunStatus)) {
    throw new HappierCliError("protocol", "Happier returned an invalid run status");
  }
  return value as HappierRunStatus;
}

function parseRunState(value: unknown): HappierRunState {
  if (!isRecord(value) || !isRecord(value.backendTarget)) {
    throw new HappierCliError("protocol", "Happier returned invalid run state");
  }
  const target = value.backendTarget;
  const participantKey = target.kind === "builtInAgent"
    ? `agent:${requiredText(target.agentId, "backend agent id", 256)}`
    : target.kind === "configuredAcpBackend"
      ? `acpBackend:${requiredText(target.backendId, "ACP backend id", 256)}`
      : (() => { throw new HappierCliError("protocol", "Happier returned an invalid backend target"); })();
  return {
    ...value,
    runId: requiredText(value.runId, "runId"),
    callId: requiredText(value.callId, "callId"),
    sidechainId: requiredText(value.sidechainId, "sidechainId"),
    intent: requiredText(value.intent, "intent", 128),
    backendTarget: target,
    participantKey,
    status: parseRunStatus(value.status),
  } as HappierRunState;
}

export async function readHappierRun(
  sessionIdValue: string,
  runIdValue: string,
  options: HappierRunReadOptions = {},
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): Promise<HappierRunReadResult> {
  const sessionId = requiredText(sessionIdValue, "sessionId");
  const runId = requiredText(runIdValue, "runId");
  const args = ["session", "run", "get", sessionId, runId];
  if (options.includeStructured) args.push("--include-structured");
  args.push("--json");
  const raw = await invokeHappierJsonForKind(args, "session_run_get", settings, signal);
  if (!isRecord(raw) || !isRecord(raw.run)) throw new HappierCliError("protocol", "Happier run get returned invalid data");
  const run = parseRunState(raw.run);
  expectedRunId(run.runId, runId, "run get");
  return { ...raw, sessionId: expectedSessionId(raw.sessionId, sessionId, "run get"), run } as HappierRunReadResult;
}

export async function listHappierRuns(
  sessionIdValue: string,
  options: HappierRunListOptions = {},
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): Promise<HappierRunListResult> {
  const sessionId = requiredText(sessionIdValue, "sessionId");
  const args = ["session", "run", "list", sessionId];
  if (options.backend) {
    const backend = requiredText(options.backend, "backend", 256);
    if (!/^(agent|acpBackend):[^,\s]+$/u.test(backend)) throw new HappierCliError("protocol", "backend must be a canonical Happier target key");
    args.push("--backend", backend);
  }
  if (options.status) args.push("--status", parseRunStatus(options.status));
  if (options.limit !== undefined) {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200) throw new HappierCliError("protocol", "run list limit must be 1-200");
    args.push("--limit", String(options.limit));
  }
  args.push("--json");
  const raw = await invokeHappierJsonForKind(args, "session_run_list", settings, signal);
  if (!isRecord(raw) || !Array.isArray(raw.runs)) throw new HappierCliError("protocol", "Happier run list returned invalid data");
  return { ...raw, sessionId: expectedSessionId(raw.sessionId, sessionId, "run list"), runs: raw.runs.map(parseRunState) } as HappierRunListResult;
}

export async function waitForHappierRun(
  sessionIdValue: string,
  runIdValue: string,
  options: HappierRunWaitOptions = {},
  settings?: HappierCliSettings,
  signal?: AbortSignal,
): Promise<HappierRunWaitResult> {
  const sessionId = requiredText(sessionIdValue, "sessionId");
  const runId = requiredText(runIdValue, "runId");
  const args = ["session", "run", "wait", sessionId, runId];
  if (options.timeoutSeconds !== undefined) {
    if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 1 || options.timeoutSeconds > 3_600) {
      throw new HappierCliError("protocol", "run wait timeout must be 1-3600 seconds");
    }
    args.push("--timeout", String(options.timeoutSeconds));
  }
  args.push("--json");
  const raw = await invokeHappierJsonForKind(args, "session_run_wait", settings, signal);
  if (!isRecord(raw)) throw new HappierCliError("protocol", "Happier run wait returned invalid data");
  return {
    sessionId: expectedSessionId(raw.sessionId, sessionId, "run wait"),
    runId: expectedRunId(raw.runId, runId, "run wait"),
    status: parseRunStatus(raw.status),
  };
}

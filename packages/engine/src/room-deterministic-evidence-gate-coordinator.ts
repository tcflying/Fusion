import {
  AsyncRoomEvidenceLedger,
  hashRoomValue,
  type AppendRoomGateResultInputV1,
  type RoomCandidateRecordV1,
  type RoomEvidenceLedgerAppendResult,
  type RoomEvidenceLedgerPersistence,
  type RoomEvidenceLedgerScope,
  type RoomEvidenceRecordV1,
  type RoomGateResultV1,
} from "@fusion/core";

export const ROOM_DETERMINISTIC_EVIDENCE_GATE_COORDINATOR_CONTRACT_VERSION = 1 as const;

const GATE_KINDS = ["rule", "test", "source", "runtime"] as const;
const GATE_VERDICTS = ["passed", "failed", "error", "not_run"] as const;
const CORE_GATE_KINDS = {
  rule: "policy",
  test: "test",
  source: "source",
  runtime: "runtime",
} as const;

export type RoomDeterministicEvidenceGateKindV1 = (typeof GATE_KINDS)[number];
export type RoomDeterministicEvidenceGateVerdictV1 = (typeof GATE_VERDICTS)[number];

export interface RoomDeterministicEvidenceGateCandidateV1 {
  readonly id: AppendRoomGateResultInputV1["candidateId"];
  readonly nodeId: AppendRoomGateResultInputV1["nodeId"];
  readonly contentHash: string;
  readonly roomHash: string;
  readonly scopeHash: string;
  readonly producingBindingId: string;
}

export interface RoomDeterministicEvidenceGatePlanV1 {
  readonly id: string;
  readonly kind: RoomDeterministicEvidenceGateKindV1;
  readonly gateResultId: AppendRoomGateResultInputV1["id"];
  readonly profileId: AppendRoomGateResultInputV1["profileId"];
}

export interface ExecuteRoomDeterministicEvidenceGatesV1 {
  readonly contractVersion: typeof ROOM_DETERMINISTIC_EVIDENCE_GATE_COORDINATOR_CONTRACT_VERSION;
  readonly scope: RoomEvidenceLedgerScope;
  readonly candidate: RoomDeterministicEvidenceGateCandidateV1;
  readonly gates: readonly RoomDeterministicEvidenceGatePlanV1[];
}

export interface RoomDeterministicEvidenceGateRunnerInputV1 {
  readonly contractVersion: typeof ROOM_DETERMINISTIC_EVIDENCE_GATE_COORDINATOR_CONTRACT_VERSION;
  readonly scope: RoomEvidenceLedgerScope;
  readonly candidate: RoomDeterministicEvidenceGateCandidateV1;
  readonly gate: RoomDeterministicEvidenceGatePlanV1;
  readonly executionHash: string;
}

export interface RoomDeterministicEvidenceGateRunnerOutputV1 {
  readonly contractVersion: typeof ROOM_DETERMINISTIC_EVIDENCE_GATE_COORDINATOR_CONTRACT_VERSION;
  readonly gateId: string;
  readonly kind: RoomDeterministicEvidenceGateKindV1;
  readonly scope: RoomEvidenceLedgerScope;
  readonly candidateId: AppendRoomGateResultInputV1["candidateId"];
  readonly nodeId: AppendRoomGateResultInputV1["nodeId"];
  readonly candidateHash: string;
  readonly roomHash: string;
  readonly scopeHash: string;
  readonly executionHash: string;
  readonly verdict: RoomDeterministicEvidenceGateVerdictV1;
  readonly evidenceId: AppendRoomGateResultInputV1["evidenceIds"][number];
  readonly evidenceContentHash: string;
  readonly evidenceBindingHash: string;
  readonly evaluatorBindingId: AppendRoomGateResultInputV1["evaluatorBindingId"] & string;
  readonly verification: "independent_execution" | "runner_self_report";
  readonly command: string | null;
  readonly exitCode: number | null;
  readonly recordedAt: AppendRoomGateResultInputV1["recordedAt"];
}

export interface RoomDeterministicEvidenceGateRunnerV1 {
  readonly bindingId: string;
  run(input: RoomDeterministicEvidenceGateRunnerInputV1): Promise<unknown>;
}

export interface RoomDeterministicEvidenceGateRunnersV1 {
  readonly rule: RoomDeterministicEvidenceGateRunnerV1;
  readonly test: RoomDeterministicEvidenceGateRunnerV1;
  readonly source: RoomDeterministicEvidenceGateRunnerV1;
  readonly runtime: RoomDeterministicEvidenceGateRunnerV1;
}

export interface ReadRoomDeterministicEvidenceGateEvidenceV1 {
  readonly contractVersion: typeof ROOM_DETERMINISTIC_EVIDENCE_GATE_COORDINATOR_CONTRACT_VERSION;
  readonly scope: RoomEvidenceLedgerScope;
  readonly candidateId: AppendRoomGateResultInputV1["candidateId"];
  readonly evidenceId: AppendRoomGateResultInputV1["evidenceIds"][number];
}

export interface RoomDeterministicEvidenceGateImmutableEvidenceSnapshotV1 {
  readonly scope: RoomEvidenceLedgerScope;
  readonly candidate: RoomCandidateRecordV1;
  readonly evidence: RoomEvidenceRecordV1;
}

export interface RoomDeterministicEvidenceGateEvidenceReaderPortV1 {
  readImmutableEvidence(
    input: ReadRoomDeterministicEvidenceGateEvidenceV1,
  ): Promise<RoomDeterministicEvidenceGateImmutableEvidenceSnapshotV1 | null>;
}

export interface RoomDeterministicEvidenceGateLedgerPortV1 {
  appendGateResult(
    input: AppendRoomGateResultInputV1,
  ): Promise<RoomEvidenceLedgerAppendResult<"room_gate_results", RoomGateResultV1>>;
}

export interface RoomDeterministicEvidenceGateCoordinatorDependenciesV1 {
  readonly runners: RoomDeterministicEvidenceGateRunnersV1;
  readonly immutableEvidenceReader: RoomDeterministicEvidenceGateEvidenceReaderPortV1;
  readonly gateLedger: RoomDeterministicEvidenceGateLedgerPortV1;
}

export interface RoomDeterministicEvidenceGateEvidenceBindingHashInputV1 {
  readonly contractVersion: typeof ROOM_DETERMINISTIC_EVIDENCE_GATE_COORDINATOR_CONTRACT_VERSION;
  readonly scope: RoomEvidenceLedgerScope;
  readonly candidate: RoomDeterministicEvidenceGateCandidateV1;
  readonly gate: RoomDeterministicEvidenceGatePlanV1;
  readonly evidenceId: AppendRoomGateResultInputV1["evidenceIds"][number];
  readonly evidenceContentHash: string;
}

export type RoomDeterministicEvidenceGateWithheldCodeV1 =
  | "invalid_request"
  | "runner_unavailable"
  | "evidence_reader_unavailable"
  | "gate_ledger_unavailable"
  | "runner_execution_failed"
  | "runner_result_invalid"
  | "gate_identity_mismatch"
  | "cross_scope"
  | "candidate_hash_mismatch"
  | "room_hash_mismatch"
  | "scope_hash_mismatch"
  | "execution_hash_mismatch"
  | "runner_identity_mismatch"
  | "runner_self_report"
  | "hard_gate_failed"
  | "evidence_missing"
  | "evidence_mismatch";

export interface RoomDeterministicEvidenceGateWithheldResultV1 {
  readonly status: "withheld";
  readonly promotionEligible: false;
  readonly reason: {
    readonly code: RoomDeterministicEvidenceGateWithheldCodeV1;
    readonly message: string;
  };
}

export interface RoomDeterministicEvidenceGateAppendFailedResultV1 {
  readonly status: "append_failed";
  readonly promotionEligible: false;
  readonly gateResultId: string;
  readonly appendedGateResultIds: readonly string[];
  readonly message: string;
}

export interface RoomDeterministicEvidenceGateRecordedResultV1 {
  readonly status: "gates_recorded";
  readonly promotionEligible: true;
  readonly executionHash: string;
  readonly gateResultIds: readonly string[];
  readonly appended: readonly RoomEvidenceLedgerAppendResult<"room_gate_results", RoomGateResultV1>[];
}

export type RoomDeterministicEvidenceGateCoordinatorResultV1 =
  | RoomDeterministicEvidenceGateWithheldResultV1
  | RoomDeterministicEvidenceGateAppendFailedResultV1
  | RoomDeterministicEvidenceGateRecordedResultV1;

export function createRoomDeterministicEvidenceGateScopeHash(scope: RoomEvidenceLedgerScope): string {
  return hashRoomValue({ projectId: scope.projectId, roomId: scope.roomId });
}

export function createRoomDeterministicEvidenceGateExecutionHash(
  input: Pick<ExecuteRoomDeterministicEvidenceGatesV1, "scope" | "candidate" | "gates">,
): string {
  return hashRoomValue({
    contractVersion: ROOM_DETERMINISTIC_EVIDENCE_GATE_COORDINATOR_CONTRACT_VERSION,
    scope: copyScope(input.scope),
    candidate: copyCandidate(input.candidate),
    gates: orderedGates(input.gates).map((gate) => ({
      id: gate.id,
      kind: gate.kind,
      gateResultId: gate.gateResultId,
      profileId: gate.profileId,
    })),
  });
}

export function createRoomDeterministicEvidenceGateEvidenceBindingHash(
  input: RoomDeterministicEvidenceGateEvidenceBindingHashInputV1,
): string {
  return hashRoomValue({
    contractVersion: ROOM_DETERMINISTIC_EVIDENCE_GATE_COORDINATOR_CONTRACT_VERSION,
    scope: copyScope(input.scope),
    candidate: copyCandidate(input.candidate),
    gate: { id: input.gate.id, kind: input.gate.kind },
    evidence: { id: input.evidenceId, contentHash: input.evidenceContentHash },
  });
}

export function createRoomDeterministicEvidenceGateEvidenceReader(
  persistence: Pick<RoomEvidenceLedgerPersistence, "transaction">,
): RoomDeterministicEvidenceGateEvidenceReaderPortV1 {
  return {
    async readImmutableEvidence(input) {
      if (!isEvidenceReadInput(input)) return null;
      try {
        return await persistence.transaction(async (transaction) => {
          const snapshot = await transaction.resolveReferences({
            scope: copyScope(input.scope),
            artifactIds: [],
            evidenceIds: [input.evidenceId],
            candidateIds: [input.candidateId],
            reviewIds: [],
            dissentIds: [],
            gateResultIds: [],
          });
          if (
            !isRecord(snapshot)
            || !sameScope(snapshot.scope, input.scope)
            || snapshot.candidates.length !== 1
            || snapshot.evidence.length !== 1
          ) {
            return null;
          }
          return {
            scope: copyScope(snapshot.scope),
            candidate: snapshot.candidates[0]!,
            evidence: snapshot.evidence[0]!,
          };
        });
      } catch {
        return null;
      }
    },
  };
}

export function createRoomDeterministicEvidenceGateLedgerPort(
  ledger: Pick<AsyncRoomEvidenceLedger, "appendGateResult">,
): RoomDeterministicEvidenceGateLedgerPortV1 {
  return {
    appendGateResult(input) {
      return ledger.appendGateResult(input);
    },
  };
}

export class RoomDeterministicEvidenceGateCoordinator {
  constructor(private readonly dependencies: RoomDeterministicEvidenceGateCoordinatorDependenciesV1) {}

  async execute(rawInput: unknown): Promise<RoomDeterministicEvidenceGateCoordinatorResultV1> {
    const requestIssue = validateRequest(rawInput);
    if (requestIssue !== null) return withheld("invalid_request", requestIssue);
    if (!isRunnerSet(this.dependencies?.runners)) {
      return withheld("runner_unavailable", "Every deterministic rule, test, source, and runtime runner is required");
    }
    if (!isEvidenceReader(this.dependencies?.immutableEvidenceReader)) {
      return withheld("evidence_reader_unavailable", "An immutable evidence reader is required");
    }
    if (!isGateLedger(this.dependencies?.gateLedger)) {
      return withheld("gate_ledger_unavailable", "A Core immutable gate ledger append port is required");
    }

    const input = rawInput as ExecuteRoomDeterministicEvidenceGatesV1;
    const executionHash = createRoomDeterministicEvidenceGateExecutionHash(input);
    const gates = orderedGates(input.gates);
    const runs = await Promise.all(gates.map(async (gate) => {
      const runner = this.dependencies.runners[gate.kind];
      try {
        const output = await runner.run({
          contractVersion: ROOM_DETERMINISTIC_EVIDENCE_GATE_COORDINATOR_CONTRACT_VERSION,
          scope: copyScope(input.scope),
          candidate: copyCandidate(input.candidate),
          gate: copyGate(gate),
          executionHash,
        });
        return { gate, runner, output, error: null as unknown };
      } catch (error) {
        return { gate, runner, output: null as unknown, error };
      }
    }));

    const verified: VerifiedGate[] = [];
    for (const run of runs) {
      if (run.error !== null) {
        return withheld("runner_execution_failed", `The ${run.gate.kind} gate runner did not return a verifiable result`);
      }
      const outputIssue = validateRunnerOutput(run.output, input, run.gate, run.runner, executionHash);
      if (outputIssue !== null) return withheld(outputIssue.code, outputIssue.message);
      const output = run.output as RoomDeterministicEvidenceGateRunnerOutputV1;
      if (output.verdict !== "passed") {
        return withheld("hard_gate_failed", `The ${run.gate.kind} deterministic hard gate is ${output.verdict}`);
      }
      verified.push({ gate: run.gate, runner: run.runner, output });
    }

    const evidenceSnapshots = await Promise.all(verified.map(async (entry) => {
      try {
        return await this.dependencies.immutableEvidenceReader.readImmutableEvidence({
          contractVersion: ROOM_DETERMINISTIC_EVIDENCE_GATE_COORDINATOR_CONTRACT_VERSION,
          scope: copyScope(input.scope),
          candidateId: input.candidate.id,
          evidenceId: entry.output.evidenceId,
        });
      } catch {
        return null;
      }
    }));

    for (const [index, entry] of verified.entries()) {
      const snapshot = evidenceSnapshots[index];
      const evidenceIssue = validateImmutableEvidenceSnapshot(snapshot, input, entry, executionHash);
      if (evidenceIssue !== null) return withheld(evidenceIssue.code, evidenceIssue.message);
    }

    const appended: RoomEvidenceLedgerAppendResult<"room_gate_results", RoomGateResultV1>[] = [];
    const appendedGateResultIds: string[] = [];
    for (const entry of verified) {
      const appendInput = toAppendInput(input, entry);
      try {
        const acknowledgement = await this.dependencies.gateLedger.appendGateResult(appendInput);
        if (!matchesGateAppendAcknowledgement(acknowledgement, appendInput)) {
          return appendFailed(
            appendInput.id,
            appendedGateResultIds,
            "The immutable gate ledger did not acknowledge the exact requested gate record",
          );
        }
        appended.push(acknowledgement);
        appendedGateResultIds.push(appendInput.id);
      } catch {
        return appendFailed(
          appendInput.id,
          appendedGateResultIds,
          "The immutable gate ledger did not confirm a durable gate append",
        );
      }
    }

    return {
      status: "gates_recorded",
      promotionEligible: true,
      executionHash,
      gateResultIds: [...appendedGateResultIds],
      appended,
    };
  }
}

interface VerifiedGate {
  readonly gate: RoomDeterministicEvidenceGatePlanV1;
  readonly runner: RoomDeterministicEvidenceGateRunnerV1;
  readonly output: RoomDeterministicEvidenceGateRunnerOutputV1;
}

function validateRequest(value: unknown): string | null {
  if (!isRecord(value) || !hasExactKeys(value, ["contractVersion", "scope", "candidate", "gates"])) {
    return "Deterministic evidence gate requests must use the exact v1 shape";
  }
  if (value.contractVersion !== ROOM_DETERMINISTIC_EVIDENCE_GATE_COORDINATOR_CONTRACT_VERSION || !isScope(value.scope)) {
    return "Deterministic evidence gate requests require the supported contract and canonical scope";
  }
  if (!isCandidate(value.candidate) || value.candidate.scopeHash !== createRoomDeterministicEvidenceGateScopeHash(value.scope)) {
    return "The candidate must bind its canonical scope hash";
  }
  if (!Array.isArray(value.gates) || value.gates.length !== GATE_KINDS.length) {
    return "Exactly one deterministic rule, test, source, and runtime hard gate is required";
  }
  const kinds = new Set<RoomDeterministicEvidenceGateKindV1>();
  const gateIds = new Set<string>();
  const gateResultIds = new Set<string>();
  for (const gate of value.gates) {
    if (!isGatePlan(gate) || kinds.has(gate.kind) || gateIds.has(gate.id) || gateResultIds.has(gate.gateResultId)) {
      return "Deterministic gate plans require unique canonical gate, kind, result, and profile identities";
    }
    kinds.add(gate.kind);
    gateIds.add(gate.id);
    gateResultIds.add(gate.gateResultId);
  }
  if (GATE_KINDS.some((kind) => !kinds.has(kind))) {
    return "Every deterministic rule, test, source, and runtime hard gate is required";
  }
  return null;
}

function validateRunnerOutput(
  value: unknown,
  input: ExecuteRoomDeterministicEvidenceGatesV1,
  gate: RoomDeterministicEvidenceGatePlanV1,
  runner: RoomDeterministicEvidenceGateRunnerV1,
  executionHash: string,
): { readonly code: RoomDeterministicEvidenceGateWithheldCodeV1; readonly message: string } | null {
  if (!isRunnerOutput(value)) {
    return { code: "runner_result_invalid", message: `The ${gate.kind} runner returned an invalid result shape` };
  }
  if (value.gateId !== gate.id || value.kind !== gate.kind) {
    return { code: "gate_identity_mismatch", message: `The ${gate.kind} runner result does not identify its planned hard gate` };
  }
  if (!sameScope(value.scope, input.scope)) {
    return { code: "cross_scope", message: `The ${gate.kind} runner result belongs to another scope` };
  }
  if (value.candidateId !== input.candidate.id || value.nodeId !== input.candidate.nodeId) {
    return { code: "gate_identity_mismatch", message: `The ${gate.kind} runner result belongs to another candidate or node` };
  }
  if (value.candidateHash !== input.candidate.contentHash) {
    return { code: "candidate_hash_mismatch", message: `The ${gate.kind} runner result is not bound to the candidate content hash` };
  }
  if (value.roomHash !== input.candidate.roomHash) {
    return { code: "room_hash_mismatch", message: `The ${gate.kind} runner result is not bound to the room hash` };
  }
  if (value.scopeHash !== input.candidate.scopeHash) {
    return { code: "scope_hash_mismatch", message: `The ${gate.kind} runner result is not bound to the scope hash` };
  }
  if (value.executionHash !== executionHash) {
    return { code: "execution_hash_mismatch", message: `The ${gate.kind} runner result is not bound to the canonical execution hash` };
  }
  if (value.evaluatorBindingId !== runner.bindingId) {
    return { code: "runner_identity_mismatch", message: `The ${gate.kind} runner result does not match its configured verifier binding` };
  }
  if (runner.bindingId === input.candidate.producingBindingId || value.verification !== "independent_execution") {
    return { code: "runner_self_report", message: `The ${gate.kind} runner cannot self-report acceptance for the candidate it produced` };
  }
  return null;
}

function validateImmutableEvidenceSnapshot(
  value: unknown,
  input: ExecuteRoomDeterministicEvidenceGatesV1,
  entry: VerifiedGate,
  executionHash: string,
): { readonly code: "evidence_missing" | "evidence_mismatch"; readonly message: string } | null {
  if (value === null) {
    return { code: "evidence_missing", message: `No immutable evidence is available for the ${entry.gate.kind} hard gate` };
  }
  if (!isEvidenceSnapshot(value) || !sameScope(value.scope, input.scope)) {
    return { code: "evidence_mismatch", message: `The ${entry.gate.kind} evidence snapshot does not match the request scope` };
  }
  const { candidate, evidence } = value;
  if (
    candidate.id !== input.candidate.id
    || candidate.roomId !== input.scope.roomId
    || candidate.nodeId !== input.candidate.nodeId
    || candidate.contentHash !== input.candidate.contentHash
    || candidate.producingBindingId !== input.candidate.producingBindingId
  ) {
    return { code: "evidence_mismatch", message: `The ${entry.gate.kind} immutable evidence snapshot belongs to another candidate` };
  }
  if (
    evidence.id !== entry.output.evidenceId
    || evidence.roomId !== input.scope.roomId
    || evidence.nodeId !== input.candidate.nodeId
    || evidence.candidateId !== input.candidate.id
    || evidence.kind !== CORE_GATE_KINDS[entry.gate.kind]
    || evidence.contentHash !== entry.output.evidenceContentHash
    || evidence.collectorBindingId !== entry.runner.bindingId
    || evidence.authoritativeSourceRetained !== true
  ) {
    return { code: "evidence_mismatch", message: `The ${entry.gate.kind} immutable evidence does not match its runner result` };
  }
  const expectedBindingHash = createRoomDeterministicEvidenceGateEvidenceBindingHash({
    contractVersion: ROOM_DETERMINISTIC_EVIDENCE_GATE_COORDINATOR_CONTRACT_VERSION,
    scope: input.scope,
    candidate: input.candidate,
    gate: entry.gate,
    evidenceId: entry.output.evidenceId,
    evidenceContentHash: entry.output.evidenceContentHash,
  });
  if (
    executionHash !== entry.output.executionHash
    || entry.output.evidenceBindingHash !== expectedBindingHash
    || evidence.sourceVersionOrHash !== expectedBindingHash
  ) {
    return { code: "evidence_mismatch", message: `The ${entry.gate.kind} evidence binding hash is not immutable or aligned` };
  }
  return null;
}

function toAppendInput(
  input: ExecuteRoomDeterministicEvidenceGatesV1,
  entry: VerifiedGate,
): AppendRoomGateResultInputV1 {
  return {
    scope: copyScope(input.scope),
    id: entry.gate.gateResultId,
    nodeId: input.candidate.nodeId,
    candidateId: input.candidate.id,
    profileId: entry.gate.profileId,
    kind: CORE_GATE_KINDS[entry.gate.kind],
    hard: true,
    status: "passed",
    evidenceIds: [entry.output.evidenceId],
    evaluatorBindingId: entry.output.evaluatorBindingId,
    command: entry.output.command,
    exitCode: entry.output.exitCode,
    recordedAt: entry.output.recordedAt,
  };
}

function matchesGateAppendAcknowledgement(
  value: unknown,
  input: AppendRoomGateResultInputV1,
): value is RoomEvidenceLedgerAppendResult<"room_gate_results", RoomGateResultV1> {
  if (!isRecord(value) || value.table !== "room_gate_results" || !isRecord(value.record)) return false;
  const record = value.record;
  return (
    record.id === input.id
    && record.roomId === input.scope.roomId
    && record.nodeId === input.nodeId
    && record.candidateId === input.candidateId
    && record.profileId === input.profileId
    && record.kind === input.kind
    && record.hard === true
    && record.status === "passed"
    && sameReferences(record.evidenceIds, input.evidenceIds)
    && record.evaluatorBindingId === input.evaluatorBindingId
    && record.command === input.command
    && record.exitCode === input.exitCode
    && record.recordedAt === input.recordedAt
  );
}

function appendFailed(
  gateResultId: string,
  appendedGateResultIds: readonly string[],
  message: string,
): RoomDeterministicEvidenceGateAppendFailedResultV1 {
  return {
    status: "append_failed",
    promotionEligible: false,
    gateResultId,
    appendedGateResultIds: [...appendedGateResultIds],
    message,
  };
}

function withheld(
  code: RoomDeterministicEvidenceGateWithheldCodeV1,
  message: string,
): RoomDeterministicEvidenceGateWithheldResultV1 {
  return { status: "withheld", promotionEligible: false, reason: { code, message } };
}

function orderedGates(gates: readonly RoomDeterministicEvidenceGatePlanV1[]): RoomDeterministicEvidenceGatePlanV1[] {
  return gates
    .map((gate) => copyGate(gate))
    .sort((left, right) => GATE_KINDS.indexOf(left.kind) - GATE_KINDS.indexOf(right.kind));
}

function copyScope(scope: RoomEvidenceLedgerScope): RoomEvidenceLedgerScope {
  return { projectId: scope.projectId, roomId: scope.roomId };
}

function copyCandidate(candidate: RoomDeterministicEvidenceGateCandidateV1): RoomDeterministicEvidenceGateCandidateV1 {
  return {
    id: candidate.id,
    nodeId: candidate.nodeId,
    contentHash: candidate.contentHash,
    roomHash: candidate.roomHash,
    scopeHash: candidate.scopeHash,
    producingBindingId: candidate.producingBindingId,
  };
}

function copyGate(gate: RoomDeterministicEvidenceGatePlanV1): RoomDeterministicEvidenceGatePlanV1 {
  return { id: gate.id, kind: gate.kind, gateResultId: gate.gateResultId, profileId: gate.profileId };
}

function isRunnerSet(value: unknown): value is RoomDeterministicEvidenceGateRunnersV1 {
  return isRecord(value) && GATE_KINDS.every((kind) => isRunner(value[kind]));
}

function isRunner(value: unknown): value is RoomDeterministicEvidenceGateRunnerV1 {
  return isRecord(value) && isCanonicalReference(value.bindingId) && typeof value.run === "function";
}

function isEvidenceReader(value: unknown): value is RoomDeterministicEvidenceGateEvidenceReaderPortV1 {
  return isRecord(value) && typeof value.readImmutableEvidence === "function";
}

function isGateLedger(value: unknown): value is RoomDeterministicEvidenceGateLedgerPortV1 {
  return isRecord(value) && typeof value.appendGateResult === "function";
}

function isEvidenceReadInput(value: unknown): value is ReadRoomDeterministicEvidenceGateEvidenceV1 {
  return isRecord(value)
    && hasExactKeys(value, ["contractVersion", "scope", "candidateId", "evidenceId"])
    && value.contractVersion === ROOM_DETERMINISTIC_EVIDENCE_GATE_COORDINATOR_CONTRACT_VERSION
    && isScope(value.scope)
    && isCanonicalReference(value.candidateId)
    && isCanonicalReference(value.evidenceId);
}

function isCandidate(value: unknown): value is RoomDeterministicEvidenceGateCandidateV1 {
  return isRecord(value)
    && hasExactKeys(value, ["id", "nodeId", "contentHash", "roomHash", "scopeHash", "producingBindingId"])
    && isCanonicalReference(value.id)
    && isCanonicalReference(value.nodeId)
    && isCanonicalHash(value.contentHash)
    && isCanonicalHash(value.roomHash)
    && isCanonicalHash(value.scopeHash)
    && isCanonicalReference(value.producingBindingId);
}

function isGatePlan(value: unknown): value is RoomDeterministicEvidenceGatePlanV1 {
  return isRecord(value)
    && hasExactKeys(value, ["id", "kind", "gateResultId", "profileId"])
    && isCanonicalReference(value.id)
    && isGateKind(value.kind)
    && isCanonicalReference(value.gateResultId)
    && isCanonicalReference(value.profileId);
}

function isRunnerOutput(value: unknown): value is RoomDeterministicEvidenceGateRunnerOutputV1 {
  return isRecord(value)
    && hasExactKeys(value, [
      "contractVersion", "gateId", "kind", "scope", "candidateId", "nodeId", "candidateHash", "roomHash", "scopeHash",
      "executionHash", "verdict", "evidenceId", "evidenceContentHash", "evidenceBindingHash", "evaluatorBindingId", "verification",
      "command", "exitCode", "recordedAt",
    ])
    && value.contractVersion === ROOM_DETERMINISTIC_EVIDENCE_GATE_COORDINATOR_CONTRACT_VERSION
    && isCanonicalReference(value.gateId)
    && isGateKind(value.kind)
    && isScope(value.scope)
    && isCanonicalReference(value.candidateId)
    && isCanonicalReference(value.nodeId)
    && isCanonicalHash(value.candidateHash)
    && isCanonicalHash(value.roomHash)
    && isCanonicalHash(value.scopeHash)
    && isCanonicalHash(value.executionHash)
    && isGateVerdict(value.verdict)
    && isCanonicalReference(value.evidenceId)
    && isCanonicalHash(value.evidenceContentHash)
    && isCanonicalHash(value.evidenceBindingHash)
    && isCanonicalReference(value.evaluatorBindingId)
    && (value.verification === "independent_execution" || value.verification === "runner_self_report")
    && isNullableText(value.command)
    && isNullableNonNegativeInteger(value.exitCode)
    && (value.command === null) === (value.exitCode === null)
    && isCanonicalTimestamp(value.recordedAt);
}

function isEvidenceSnapshot(value: unknown): value is RoomDeterministicEvidenceGateImmutableEvidenceSnapshotV1 {
  return isRecord(value)
    && hasExactKeys(value, ["scope", "candidate", "evidence"])
    && isScope(value.scope)
    && isRecord(value.candidate)
    && isRecord(value.evidence);
}

function isScope(value: unknown): value is RoomEvidenceLedgerScope {
  return isRecord(value)
    && hasExactKeys(value, ["projectId", "roomId"])
    && isCanonicalReference(value.projectId)
    && isCanonicalReference(value.roomId);
}

function isGateKind(value: unknown): value is RoomDeterministicEvidenceGateKindV1 {
  return typeof value === "string" && GATE_KINDS.includes(value as RoomDeterministicEvidenceGateKindV1);
}

function isGateVerdict(value: unknown): value is RoomDeterministicEvidenceGateVerdictV1 {
  return typeof value === "string" && GATE_VERDICTS.includes(value as RoomDeterministicEvidenceGateVerdictV1);
}

function isCanonicalReference(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/.test(value);
}

function isCanonicalHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isNullableText(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.trim().length > 0);
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function sameScope(left: unknown, right: unknown): boolean {
  return isScope(left) && isScope(right) && left.projectId === right.projectId && left.roomId === right.roomId;
}

function sameReferences(left: unknown, right: unknown): boolean {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index]);
}

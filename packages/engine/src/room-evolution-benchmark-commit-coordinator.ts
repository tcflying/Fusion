import {
  hashRoomValue,
  selectAuthorizedRoomEvolutionBenchmarkSnapshot,
  type AppendRoomEvolutionBenchmarkCaseInputV1,
  type RoomEvolutionBenchmarkCaseKindV1,
  type RoomEvolutionBenchmarkCaseV1,
  type RoomEvolutionLedgerScope,
  type RoomEvolutionSelectedBenchmarkCaseV1,
  type SelectAuthorizedRoomEvolutionBenchmarkSnapshotInputV1,
} from "@fusion/core";

export const ROOM_EVOLUTION_BENCHMARK_COMMIT_COORDINATOR_CONTRACT_VERSION = 1 as const;

export interface RoomEvolutionBenchmarkCaseMaterializationV1 {
  readonly caseId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly casePayload: Readonly<Record<string, unknown>>;
  readonly expectedOutcome: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface RoomEvolutionBenchmarkCommitLedgerPortV1 {
  appendBenchmarkCase(
    input: AppendRoomEvolutionBenchmarkCaseInputV1,
  ): Promise<{ readonly table: "room_evolution_benchmark_cases"; readonly record: { readonly id: string; readonly contentHash: string } }>;
}

export interface RoomEvolutionBenchmarkCommitCoordinatorDependenciesV1 {
  readonly ledger: RoomEvolutionBenchmarkCommitLedgerPortV1;
}

export interface SelectAndCommitRoomEvolutionBenchmarkInputV1 {
  readonly contractVersion: typeof ROOM_EVOLUTION_BENCHMARK_COMMIT_COORDINATOR_CONTRACT_VERSION;
  readonly selection: SelectAuthorizedRoomEvolutionBenchmarkSnapshotInputV1;
  readonly materializations: readonly RoomEvolutionBenchmarkCaseMaterializationV1[];
}

export type RoomEvolutionBenchmarkCommitCoordinatorResultV1 =
  | { readonly status: "committed"; readonly snapshot: { readonly id: string; readonly snapshotHash: string; readonly selectedCases: readonly RoomEvolutionSelectedBenchmarkCaseV1[] }; readonly recordIds: readonly string[] }
  | { readonly status: "withheld"; readonly reason: "invalid_request" | "ledger_unavailable" | "selected_case_materialization_missing" | "selected_case_materialization_invalid" }
  | { readonly status: "policy_rejected"; readonly issues: readonly { readonly code: string; readonly path: string }[] }
  | { readonly status: "append_failed"; readonly recordId: string; readonly reason: string };

export class RoomEvolutionBenchmarkCommitCoordinator {
  public constructor(
    private readonly dependencies: RoomEvolutionBenchmarkCommitCoordinatorDependenciesV1,
  ) {}

  public async selectAndCommit(
    rawInput: SelectAndCommitRoomEvolutionBenchmarkInputV1,
  ): Promise<RoomEvolutionBenchmarkCommitCoordinatorResultV1> {
    const input = validateInput(rawInput);
    if (input === null) return freeze({ status: "withheld" as const, reason: "invalid_request" as const });
    if (!isLedgerPort(this.dependencies?.ledger)) {
      return freeze({ status: "withheld" as const, reason: "ledger_unavailable" as const });
    }

    const selected = selectAuthorizedRoomEvolutionBenchmarkSnapshot(input.selection);
    if (!selected.ok) {
      return freeze({
        status: "policy_rejected" as const,
        issues: freeze(selected.issues.map((issue) => freeze({ code: issue.code, path: issue.path }))),
      });
    }

    const originalCases = new Map(input.selection.cases.map((entry) => [caseKey(entry.id, entry.version), entry]));
    const materializations = materializationsForSelection(input.materializations, selected.value.snapshot.selectedCases);
    if (materializations === null) {
      return freeze({ status: "withheld" as const, reason: "selected_case_materialization_missing" as const });
    }

    const appendInputs: AppendRoomEvolutionBenchmarkCaseInputV1[] = [];
    for (const selectedCase of selected.value.snapshot.selectedCases) {
      const sourceCase = originalCases.get(caseKey(selectedCase.id, selectedCase.version));
      const materialization = materializations.get(caseKey(selectedCase.id, selectedCase.version));
      if (!sourceCase || !materialization || !materialization.payloadHashMatches || sourceCase.contentHash !== materialization.contentHash) {
        return freeze({ status: "withheld" as const, reason: "selected_case_materialization_invalid" as const });
      }
      appendInputs.push(toAppendInput(input.selection, selected.value.snapshot, sourceCase, materialization));
    }

    const recordIds: string[] = [];
    for (const appendInput of appendInputs) {
      try {
        const persisted = await this.dependencies.ledger.appendBenchmarkCase(appendInput);
        if (
          persisted.table !== "room_evolution_benchmark_cases"
          || persisted.record.id !== appendInput.id
          || persisted.record.contentHash !== appendInput.contentHash
        ) {
          return appendFailed(appendInput.id, "ledger_response_invalid");
        }
      } catch (error) {
        return appendFailed(appendInput.id, messageOf(error));
      }
      recordIds.push(appendInput.id);
    }

    return freeze({
      status: "committed" as const,
      snapshot: freeze({
        id: selected.value.snapshot.id,
        snapshotHash: selected.value.snapshot.snapshotHash,
        selectedCases: freeze(selected.value.snapshot.selectedCases.map((entry) => freeze({ ...entry }))),
      }),
      recordIds: freeze(recordIds.sort()),
    });
  }
}

interface ResolvedMaterialization extends RoomEvolutionBenchmarkCaseMaterializationV1 {
  readonly materializationHash: string;
  readonly payloadHashMatches: boolean;
}

function validateInput(value: unknown): SelectAndCommitRoomEvolutionBenchmarkInputV1 | null {
  if (!isRecord(value) || value.contractVersion !== ROOM_EVOLUTION_BENCHMARK_COMMIT_COORDINATOR_CONTRACT_VERSION) return null;
  const input = value as unknown as SelectAndCommitRoomEvolutionBenchmarkInputV1;
  if (!isSelectionInput(input.selection) || !Array.isArray(input.materializations) || input.materializations.length === 0) return null;
  const seen = new Set<string>();
  for (const materialization of input.materializations) {
    if (!isMaterialization(materialization)) return null;
    const key = caseKey(materialization.caseId, materialization.version);
    if (seen.has(key)) return null;
    seen.add(key);
  }
  return input;
}

function materializationsForSelection(
  materializations: readonly RoomEvolutionBenchmarkCaseMaterializationV1[],
  selectedCases: readonly RoomEvolutionSelectedBenchmarkCaseV1[],
): ReadonlyMap<string, ResolvedMaterialization> | null {
  const selectedKeys = new Set(selectedCases.map((entry) => caseKey(entry.id, entry.version)));
  if (selectedKeys.size !== materializations.length) return null;
  const byKey = new Map<string, ResolvedMaterialization>();
  for (const materialization of materializations) {
    const key = caseKey(materialization.caseId, materialization.version);
    if (!selectedKeys.has(key) || byKey.has(key)) return null;
    const materializationHash = hashRoomValue({
      casePayload: materialization.casePayload,
      expectedOutcome: materialization.expectedOutcome,
    });
    byKey.set(key, freeze({
      ...materialization,
      casePayload: freeze({ ...materialization.casePayload }),
      expectedOutcome: freeze({ ...materialization.expectedOutcome }),
      materializationHash,
      payloadHashMatches: materialization.contentHash === materializationHash,
    }));
  }
  return byKey.size === selectedKeys.size ? byKey : null;
}

function toAppendInput(
  selection: SelectAuthorizedRoomEvolutionBenchmarkSnapshotInputV1,
  snapshot: { readonly id: string; readonly snapshotHash: string; readonly catalogVersion: number; readonly asOf: string },
  sourceCase: RoomEvolutionBenchmarkCaseV1,
  materialization: ResolvedMaterialization,
): AppendRoomEvolutionBenchmarkCaseInputV1 {
  const scope = scopeForCase(sourceCase);
  const sourceAuthorization = sourceCase.source.authorization ?? sourceCase.privacy.authorization ?? sourceCase.risk.authorization;
  return freeze({
    scope,
    id: `benchmark:${sourceCase.id}:v${sourceCase.version}`,
    domain: sourceCase.domain,
    caseKind: mapCaseKind(sourceCase.collection),
    containsPrivateRoomData: sourceCase.privacy.containsPrivateData,
    sourceAuthorizationId: sourceAuthorization?.id ?? null,
    authorizationEvidence: freeze({
      snapshotId: snapshot.id,
      snapshotHash: snapshot.snapshotHash,
      catalogVersion: snapshot.catalogVersion,
      selectedAt: snapshot.asOf,
      selectionProjectId: selection.projectId,
      source: freeze({
        kind: sourceCase.source.kind,
        reference: sourceCase.source.reference,
        evidenceHash: sourceCase.source.evidenceHash,
        inclusionAuthority: sourceCase.source.inclusionAuthority,
        authorActorId: sourceCase.source.authorActorId,
        authorization: sourceCase.source.authorization,
      }),
      privacy: sourceCase.privacy,
      risk: sourceCase.risk,
      materializationHash: materialization.materializationHash,
    }),
    casePayload: materialization.casePayload,
    expectedOutcome: materialization.expectedOutcome,
    contentHash: sourceCase.contentHash,
    createdAt: materialization.createdAt,
  });
}

function scopeForCase(sourceCase: RoomEvolutionBenchmarkCaseV1): RoomEvolutionLedgerScope {
  return freeze({
    projectId: sourceCase.projectId,
    roomId: sourceCase.roomId,
    scopeKind: sourceCase.roomId === null ? "project" as const : "room" as const,
    scopeKey: sourceCase.roomId === null ? `project:${sourceCase.projectId}` : `room:${sourceCase.roomId}`,
  });
}

function mapCaseKind(collection: RoomEvolutionBenchmarkCaseV1["collection"]): RoomEvolutionBenchmarkCaseKindV1 {
  switch (collection) {
    case "fixed": return "golden";
    case "rolling_difficult": return "rolling_authorized";
    case "adversarial": return "adversarial";
    case "authorized_historical_replay": return "historical_replay";
  }
}

function isSelectionInput(value: unknown): value is SelectAuthorizedRoomEvolutionBenchmarkSnapshotInputV1 {
  return isRecord(value)
    && value.contractVersion === 1
    && isIdentifier(value.projectId)
    && (value.roomId === null || isIdentifier(value.roomId))
    && isIdentifier(value.snapshotId)
    && Array.isArray(value.cases);
}

function isMaterialization(value: unknown): value is RoomEvolutionBenchmarkCaseMaterializationV1 {
  return isRecord(value)
    && isIdentifier(value.caseId)
    && isPositiveSafeInteger(value.version)
    && isHash(value.contentHash)
    && isRecord(value.casePayload)
    && isRecord(value.expectedOutcome)
    && isUtcTimestamp(value.createdAt);
}

function isLedgerPort(value: unknown): value is RoomEvolutionBenchmarkCommitLedgerPortV1 {
  return isRecord(value) && typeof value.appendBenchmarkCase === "function";
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isUtcTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function caseKey(id: string, version: number): string {
  return `${id}@${version}`;
}

function appendFailed(recordId: string, reason: string): RoomEvolutionBenchmarkCommitCoordinatorResultV1 {
  return freeze({ status: "append_failed" as const, recordId, reason });
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

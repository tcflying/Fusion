export const ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION = 1 as const;

export type RoomProviderBackpressureWorkClassV1 = "normal" | "verifier" | "recovery";
export type RoomProviderBackpressureCircuitStateV1 = "closed" | "open" | "half_open";
export type RoomProviderBackpressureActionV1 = "admit" | "hold" | "recorded";
export type RoomProviderBackpressureFailureKindV1 = "rate_limited" | "transient" | "connector_unavailable";
export type RoomProviderBackpressureReasonV1 =
  | "admission_unconfirmed"
  | "capacity_confirmed"
  | "circuit_open"
  | "circuit_opened"
  | "concurrency_cap_reached"
  | "failure_backoff"
  | "half_open_probe_admitted"
  | "half_open_probe_in_flight"
  | "half_open_probe_required"
  | "invalid_input"
  | "reserved_capacity"
  | "retry_window_active"
  | "scope_state_mismatch"
  | "success_recovered"
  | "telemetry_stale"
  | "telemetry_unknown";

export interface RoomProviderBackpressureScopeV1 {
  readonly providerId: string;
  readonly accountId: string;
  readonly modelId: string;
  readonly connectorId: string;
  readonly nodeId: string;
}

export interface RoomProviderBackpressureWorkV1 {
  readonly requestId: string;
  readonly class: RoomProviderBackpressureWorkClassV1;
  readonly allowHalfOpenProbe: boolean;
}

export type RoomProviderBackpressureOperationV1 =
  | { readonly kind: "dispatch" }
  | { readonly kind: "success" }
  | {
      readonly kind: "failure";
      readonly failureKind: RoomProviderBackpressureFailureKindV1;
      readonly retryAfterMs?: number;
    };

export interface RoomProviderBackpressureTelemetryV1 {
  readonly known: boolean;
  readonly observedAt: string;
  readonly admissionConfirmed: boolean;
  readonly activeRequests: number;
}

export interface RoomProviderBackpressurePolicyV1 {
  readonly concurrencyCap: number;
  readonly reservedVerifierSlots: number;
  readonly reservedRecoverySlots: number;
  readonly telemetryTtlMs: number;
  readonly failureThreshold: number;
  readonly maxRetryAttempts: number;
  readonly baseBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly circuitOpenMs: number;
}

export interface RoomProviderBackpressureStateV1 {
  readonly contractVersion: typeof ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION;
  readonly scopeKey: string;
  readonly circuitState: RoomProviderBackpressureCircuitStateV1;
  readonly consecutiveFailures: number;
  readonly retryAttempt: number;
  readonly retryNotBefore: string | null;
  readonly openUntil: string | null;
  readonly halfOpenProbeInFlight: boolean;
  readonly lastUpdatedAt: string;
}

export interface RoomProviderBackpressureControllerInputV1 {
  readonly contractVersion: typeof ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION;
  readonly asOf: string;
  readonly scope: RoomProviderBackpressureScopeV1;
  readonly work: RoomProviderBackpressureWorkV1;
  readonly operation: RoomProviderBackpressureOperationV1;
  readonly telemetry: RoomProviderBackpressureTelemetryV1;
  readonly policy: RoomProviderBackpressurePolicyV1;
  readonly state?: RoomProviderBackpressureStateV1;
}

export interface RoomProviderBackpressureDecisionV1 {
  readonly contractVersion: typeof ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION;
  readonly action: RoomProviderBackpressureActionV1;
  readonly reason: RoomProviderBackpressureReasonV1;
  readonly retryAfterMs: number | null;
  readonly exponentialBackoffMs: number | null;
  readonly retryDelayMs: number | null;
  readonly effectiveConcurrencyCap: number | null;
}

export interface RoomProviderBackpressureControllerResultV1 {
  readonly contractVersion: typeof ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION;
  readonly scope: RoomProviderBackpressureScopeV1;
  readonly scopeKey: string;
  readonly decision: RoomProviderBackpressureDecisionV1;
  readonly state: RoomProviderBackpressureStateV1;
}

interface ValidatedInput {
  readonly asOfMs: number;
  readonly asOf: string;
  readonly scope: RoomProviderBackpressureScopeV1;
  readonly scopeKey: string;
  readonly work: RoomProviderBackpressureWorkV1;
  readonly operation: RoomProviderBackpressureOperationV1;
  readonly telemetry: RoomProviderBackpressureTelemetryV1;
  readonly telemetryObservedAtMs: number | null;
  readonly policy: RoomProviderBackpressurePolicyV1;
  readonly state: RoomProviderBackpressureStateV1;
}

const INVALID_SCOPE: RoomProviderBackpressureScopeV1 = Object.freeze({
  providerId: "invalid",
  accountId: "invalid",
  modelId: "invalid",
  connectorId: "invalid",
  nodeId: "invalid",
});

export function decideRoomProviderBackpressure(
  input: RoomProviderBackpressureControllerInputV1,
): RoomProviderBackpressureControllerResultV1 {
  if (hasExactScopeStateMismatch(input)) {
    return makeScopeStateMismatchResult(input);
  }
  const validated = validateInput(input);
  if (validated === null) {
    return makeInvalidResult(input);
  }

  if (validated.operation.kind === "success") {
    const recoveredState = freezeState({
      contractVersion: ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
      scopeKey: validated.scopeKey,
      circuitState: "closed",
      consecutiveFailures: 0,
      retryAttempt: 0,
      retryNotBefore: null,
      openUntil: null,
      halfOpenProbeInFlight: false,
      lastUpdatedAt: validated.asOf,
    });
    return makeResult(
      validated,
      makeDecision("recorded", "success_recovered", null, null, null, null),
      recoveredState,
    );
  }

  if (validated.operation.kind === "failure") {
    return decideFailure(validated, validated.operation);
  }

  return decideDispatch(validated);
}

function hasExactScopeStateMismatch(input: RoomProviderBackpressureControllerInputV1): boolean {
  return input.state !== undefined && isScope(input.scope) && input.state.scopeKey !== scopeToKey(input.scope);
}

function decideFailure(
  input: ValidatedInput,
  operation: Extract<RoomProviderBackpressureOperationV1, { readonly kind: "failure" }>,
): RoomProviderBackpressureControllerResultV1 {
  const previous = input.state;
  const retryAttempt = Math.min(previous.retryAttempt + 1, input.policy.maxRetryAttempts);
  const exponentialBackoffMs = boundedExponentialBackoff(
    input.policy.baseBackoffMs,
    input.policy.maxBackoffMs,
    retryAttempt,
  );
  const retryAfterMs = operation.retryAfterMs ?? 0;
  const retryDelayMs = Math.max(exponentialBackoffMs, retryAfterMs);
  const retryNotBefore = toUtc(input.asOfMs + retryDelayMs);
  const opensCircuit =
    previous.circuitState === "half_open" ||
    operation.failureKind === "rate_limited" ||
    previous.consecutiveFailures + 1 >= input.policy.failureThreshold ||
    retryAttempt >= input.policy.maxRetryAttempts;
  const openUntil = opensCircuit ? toUtc(input.asOfMs + Math.max(input.policy.circuitOpenMs, retryDelayMs)) : null;
  const state = freezeState({
    contractVersion: ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
    scopeKey: input.scopeKey,
    circuitState: opensCircuit ? "open" : "closed",
    consecutiveFailures: previous.consecutiveFailures + 1,
    retryAttempt,
    retryNotBefore,
    openUntil,
    halfOpenProbeInFlight: false,
    lastUpdatedAt: input.asOf,
  });
  return makeResult(
    input,
    makeDecision(
      "recorded",
      opensCircuit ? "circuit_opened" : "failure_backoff",
      retryAfterMs === 0 ? null : retryAfterMs,
      exponentialBackoffMs,
      retryDelayMs,
      null,
    ),
    state,
  );
}

function decideDispatch(input: ValidatedInput): RoomProviderBackpressureControllerResultV1 {
  const state = normalizeCircuitAt(input.state, input.asOfMs, input.asOf);
  if (!input.telemetry.known) {
    return makeResult(input, makeDecision("hold", "telemetry_unknown", null, null, null, null), state);
  }
  if (input.telemetryObservedAtMs === null || input.asOfMs < input.telemetryObservedAtMs) {
    return makeResult(input, makeDecision("hold", "telemetry_stale", null, null, null, null), state);
  }
  if (input.asOfMs - input.telemetryObservedAtMs > input.policy.telemetryTtlMs) {
    return makeResult(input, makeDecision("hold", "telemetry_stale", null, null, null, null), state);
  }
  if (!input.telemetry.admissionConfirmed) {
    return makeResult(input, makeDecision("hold", "admission_unconfirmed", null, null, null, null), state);
  }
  if (state.circuitState === "open") {
    return makeResult(input, makeDecision("hold", "circuit_open", null, null, null, null), state);
  }
  if (state.circuitState === "half_open") {
    if (state.halfOpenProbeInFlight) {
      return makeResult(input, makeDecision("hold", "half_open_probe_in_flight", null, null, null, null), state);
    }
    if (!input.work.allowHalfOpenProbe) {
      return makeResult(input, makeDecision("hold", "half_open_probe_required", null, null, null, null), state);
    }
    const halfOpenState = freezeState({ ...state, halfOpenProbeInFlight: true, lastUpdatedAt: input.asOf });
    return makeResult(
      input,
      makeDecision("admit", "half_open_probe_admitted", null, null, null, effectiveCap(input.policy, input.work.class)),
      halfOpenState,
    );
  }
  const retryNotBeforeMs = state.retryNotBefore === null ? null : timestampToMs(state.retryNotBefore);
  if (retryNotBeforeMs !== null && input.asOfMs < retryNotBeforeMs) {
    return makeResult(input, makeDecision("hold", "retry_window_active", null, null, null, null), state);
  }
  const cap = effectiveCap(input.policy, input.work.class);
  if (input.telemetry.activeRequests >= cap) {
    const reason: RoomProviderBackpressureReasonV1 =
      input.work.class === "normal" && input.telemetry.activeRequests < input.policy.concurrencyCap
        ? "reserved_capacity"
        : "concurrency_cap_reached";
    return makeResult(input, makeDecision("hold", reason, null, null, null, cap), state);
  }
  return makeResult(input, makeDecision("admit", "capacity_confirmed", null, null, null, cap), state);
}

function validateInput(input: RoomProviderBackpressureControllerInputV1): ValidatedInput | null {
  if (input.contractVersion !== ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION) {
    return null;
  }
  const asOfMs = timestampToMs(input.asOf);
  if (asOfMs === null || !isScope(input.scope) || !isWork(input.work) || !isOperation(input.operation) || !isPolicy(input.policy)) {
    return null;
  }
  if (!isTelemetry(input.telemetry)) {
    return null;
  }
  const scope = freezeScope(input.scope);
  const scopeKey = scopeToKey(scope);
  const state = input.state === undefined ? initialState(scopeKey, input.asOf) : validateState(input.state, scopeKey);
  if (state === null) {
    return null;
  }
  return Object.freeze({
    asOfMs,
    asOf: input.asOf,
    scope,
    scopeKey,
    work: Object.freeze({ ...input.work }),
    operation: Object.freeze({ ...input.operation }),
    telemetry: Object.freeze({ ...input.telemetry }),
    telemetryObservedAtMs: timestampToMs(input.telemetry.observedAt),
    policy: Object.freeze({ ...input.policy }),
    state,
  });
}

function makeInvalidResult(input: RoomProviderBackpressureControllerInputV1): RoomProviderBackpressureControllerResultV1 {
  const scope = isScope(input.scope) ? freezeScope(input.scope) : INVALID_SCOPE;
  const scopeKey = scopeToKey(scope);
  const lastUpdatedAt = timestampToMs(input.asOf) === null ? "1970-01-01T00:00:00.000Z" : input.asOf;
  return Object.freeze({
    contractVersion: ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
    scope,
    scopeKey,
    decision: makeDecision("hold", "invalid_input", null, null, null, null),
    state: initialState(scopeKey, lastUpdatedAt),
  });
}

function makeScopeStateMismatchResult(
  input: RoomProviderBackpressureControllerInputV1,
): RoomProviderBackpressureControllerResultV1 {
  const scope = isScope(input.scope) ? freezeScope(input.scope) : INVALID_SCOPE;
  const scopeKey = scopeToKey(scope);
  const lastUpdatedAt = timestampToMs(input.asOf) === null ? "1970-01-01T00:00:00.000Z" : input.asOf;
  return Object.freeze({
    contractVersion: ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
    scope,
    scopeKey,
    decision: makeDecision("hold", "scope_state_mismatch", null, null, null, null),
    state: initialState(scopeKey, lastUpdatedAt),
  });
}

function makeResult(
  input: ValidatedInput,
  decision: RoomProviderBackpressureDecisionV1,
  state: RoomProviderBackpressureStateV1,
): RoomProviderBackpressureControllerResultV1 {
  return Object.freeze({
    contractVersion: ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
    scope: input.scope,
    scopeKey: input.scopeKey,
    decision,
    state,
  });
}

function makeDecision(
  action: RoomProviderBackpressureActionV1,
  reason: RoomProviderBackpressureReasonV1,
  retryAfterMs: number | null,
  exponentialBackoffMs: number | null,
  retryDelayMs: number | null,
  effectiveConcurrencyCap: number | null,
): RoomProviderBackpressureDecisionV1 {
  return Object.freeze({
    contractVersion: ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
    action,
    reason,
    retryAfterMs,
    exponentialBackoffMs,
    retryDelayMs,
    effectiveConcurrencyCap,
  });
}

function normalizeCircuitAt(
  state: RoomProviderBackpressureStateV1,
  asOfMs: number,
  asOf: string,
): RoomProviderBackpressureStateV1 {
  const openUntilMs = state.openUntil === null ? null : timestampToMs(state.openUntil);
  if (state.circuitState !== "open" || openUntilMs === null || asOfMs < openUntilMs) {
    return state;
  }
  return freezeState({
    ...state,
    circuitState: "half_open",
    openUntil: null,
    halfOpenProbeInFlight: false,
    lastUpdatedAt: asOf,
  });
}

function initialState(scopeKey: string, asOf: string): RoomProviderBackpressureStateV1 {
  return freezeState({
    contractVersion: ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION,
    scopeKey,
    circuitState: "closed",
    consecutiveFailures: 0,
    retryAttempt: 0,
    retryNotBefore: null,
    openUntil: null,
    halfOpenProbeInFlight: false,
    lastUpdatedAt: asOf,
  });
}

function validateState(
  state: RoomProviderBackpressureStateV1,
  scopeKey: string,
): RoomProviderBackpressureStateV1 | null {
  if (
    state.contractVersion !== ROOM_PROVIDER_BACKPRESSURE_CONTROLLER_CONTRACT_VERSION ||
    state.scopeKey !== scopeKey ||
    !isCircuitState(state.circuitState) ||
    !isNonNegativeInteger(state.consecutiveFailures) ||
    !isNonNegativeInteger(state.retryAttempt) ||
    typeof state.halfOpenProbeInFlight !== "boolean" ||
    timestampToMs(state.lastUpdatedAt) === null ||
    (state.retryNotBefore !== null && timestampToMs(state.retryNotBefore) === null) ||
    (state.openUntil !== null && timestampToMs(state.openUntil) === null)
  ) {
    return null;
  }
  return freezeState({ ...state });
}

function effectiveCap(policy: RoomProviderBackpressurePolicyV1, workClass: RoomProviderBackpressureWorkClassV1): number {
  if (workClass === "normal") {
    return policy.concurrencyCap - policy.reservedVerifierSlots - policy.reservedRecoverySlots;
  }
  if (workClass === "verifier") {
    return policy.concurrencyCap - policy.reservedRecoverySlots;
  }
  return policy.concurrencyCap;
}

function boundedExponentialBackoff(baseBackoffMs: number, maxBackoffMs: number, retryAttempt: number): number {
  const multiplier = 2 ** Math.min(Math.max(retryAttempt - 1, 0), 30);
  return Math.min(maxBackoffMs, baseBackoffMs * multiplier);
}

function scopeToKey(scope: RoomProviderBackpressureScopeV1): string {
  return JSON.stringify([scope.providerId, scope.accountId, scope.modelId, scope.connectorId, scope.nodeId]);
}

function freezeScope(scope: RoomProviderBackpressureScopeV1): RoomProviderBackpressureScopeV1 {
  return Object.freeze({ ...scope });
}

function freezeState(state: RoomProviderBackpressureStateV1): RoomProviderBackpressureStateV1 {
  return Object.freeze({ ...state });
}

function isScope(scope: RoomProviderBackpressureScopeV1): boolean {
  return (
    isNonBlank(scope.providerId) &&
    isNonBlank(scope.accountId) &&
    isNonBlank(scope.modelId) &&
    isNonBlank(scope.connectorId) &&
    isNonBlank(scope.nodeId)
  );
}

function isWork(work: RoomProviderBackpressureWorkV1): boolean {
  return (
    isNonBlank(work.requestId) &&
    (work.class === "normal" || work.class === "verifier" || work.class === "recovery") &&
    typeof work.allowHalfOpenProbe === "boolean"
  );
}

function isOperation(operation: RoomProviderBackpressureOperationV1): boolean {
  if (operation.kind === "dispatch" || operation.kind === "success") {
    return true;
  }
  return (
    operation.kind === "failure" &&
    (operation.failureKind === "rate_limited" ||
      operation.failureKind === "transient" ||
      operation.failureKind === "connector_unavailable") &&
    (operation.retryAfterMs === undefined || isNonNegativeInteger(operation.retryAfterMs))
  );
}

function isTelemetry(telemetry: RoomProviderBackpressureTelemetryV1): boolean {
  return (
    typeof telemetry.known === "boolean" &&
    typeof telemetry.admissionConfirmed === "boolean" &&
    isNonNegativeInteger(telemetry.activeRequests) &&
    timestampToMs(telemetry.observedAt) !== null
  );
}

function isPolicy(policy: RoomProviderBackpressurePolicyV1): boolean {
  return (
    isPositiveInteger(policy.concurrencyCap) &&
    isNonNegativeInteger(policy.reservedVerifierSlots) &&
    isNonNegativeInteger(policy.reservedRecoverySlots) &&
    policy.reservedVerifierSlots + policy.reservedRecoverySlots < policy.concurrencyCap &&
    isNonNegativeInteger(policy.telemetryTtlMs) &&
    isPositiveInteger(policy.failureThreshold) &&
    isPositiveInteger(policy.maxRetryAttempts) &&
    isPositiveInteger(policy.baseBackoffMs) &&
    isPositiveInteger(policy.maxBackoffMs) &&
    policy.baseBackoffMs <= policy.maxBackoffMs &&
    isPositiveInteger(policy.circuitOpenMs)
  );
}

function isCircuitState(value: RoomProviderBackpressureCircuitStateV1): boolean {
  return value === "closed" || value === "open" || value === "half_open";
}

function isNonBlank(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: number): boolean {
  return isNonNegativeInteger(value) && value > 0;
}

function timestampToMs(value: string): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    return null;
  }
  return timestamp;
}

function toUtc(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

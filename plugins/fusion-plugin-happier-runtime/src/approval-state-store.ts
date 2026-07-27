import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type {
  SessionConnectorIdentityV1,
  SessionConnectorResultV1,
  SessionConnectorSendRequestV1,
  SessionConnectorSendReceiptV1,
} from "@fusion/core";
import { hashRoomValue } from "@fusion/core";

import type { HappierDeliveryFenceReservation } from "./delivery-fence-store.js";
import { HappierApprovalRequiredError } from "./mcp-result-contract.js";

const APPROVAL_STATE_CONTRACT_VERSION = 1 as const;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const KEY_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const OPERATION_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_TEXT_PATTERN = /^[^\u0000-\u001f\u007f]{1,512}$/u;

export interface HappierApprovalStateInput {
  readonly artifactId: string;
  readonly operation: string;
  readonly identity: SessionConnectorIdentityV1;
  readonly bindingId: string | null;
  readonly logicalMessageId: string | null;
  readonly localMessageId: string | null;
  readonly idempotencyKey: string;
  readonly contentHash: string | null;
}

export type HappierApprovalStateKeyInput = Omit<HappierApprovalStateInput, "artifactId">;

export interface HappierApprovalStateRecord extends HappierApprovalStateInput {
  readonly contractVersion: typeof APPROVAL_STATE_CONTRACT_VERSION;
  readonly keyHash: string;
  readonly state: "waiting_approval" | "reconciled";
  readonly receipt: SessionConnectorSendReceiptV1 | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HappierApprovalStateStore {
  recordWaiting(input: HappierApprovalStateInput): Promise<HappierApprovalStateRecord>;
  find(input: HappierApprovalStateKeyInput): Promise<HappierApprovalStateRecord | null>;
  read(input: HappierApprovalStateInput): Promise<HappierApprovalStateRecord | null>;
  markReconciled(
    input: HappierApprovalStateInput,
    receipt: SessionConnectorSendReceiptV1,
  ): Promise<HappierApprovalStateRecord>;
}

export interface HappierApprovalStateStoreOptions {
  readonly directory?: string;
  readonly now?: () => string;
}

export interface HappierApprovalReconciliationRequest {
  readonly contractVersion: 1;
  readonly artifactId: string;
  readonly request: SessionConnectorSendRequestV1;
}

interface ApprovalRequiredOutcome {
  readonly actionState: "approval_request_created";
  readonly artifactId: string;
  readonly operation: string;
}

export interface HappierApprovalBoundIdentity {
  readonly providerId: string;
  readonly nativeSessionId: string;
  readonly happierSessionId: string;
  readonly serverProfileId: string;
  readonly machineId: string;
}

function exactFields(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = new Set(expected);
  return Object.keys(value).every((key) => keys.has(key))
    && expected.every((key) => Object.hasOwn(value, key));
}

function validText(value: unknown): value is string {
  return typeof value === "string" && SAFE_TEXT_PATTERN.test(value);
}

function validNullableText(value: unknown): value is string | null {
  return value === null || validText(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function connectorFailure<T>(
  code: "unavailable" | "not_found" | "conflict" | "delivery_uncertain",
  message: string,
  safeDetails: Readonly<Record<string, unknown>>,
): SessionConnectorResultV1<T> {
  return { ok: false, error: { code, message, retryable: false, safeDetails } };
}

function approvalOutcomeFromFailure<T>(
  result: SessionConnectorResultV1<T>,
): ApprovalRequiredOutcome | null {
  if (result.ok) return null;
  const details = recordValue(result.error.safeDetails);
  if (!details) return null;
  const artifactId = validText(details.artifactId) ? details.artifactId : null;
  const operation = typeof details.operation === "string" && OPERATION_PATTERN.test(details.operation)
    ? details.operation
    : null;
  return details.actionState === "approval_request_created" && artifactId && operation
    ? { actionState: "approval_request_created", artifactId, operation }
    : null;
}

export function happierApprovalKeyForSend(
  identity: SessionConnectorIdentityV1,
  input: SessionConnectorSendRequestV1,
  operation: string,
): HappierApprovalStateKeyInput {
  return Object.freeze({
    operation,
    identity,
    bindingId: input.bindingId,
    logicalMessageId: input.logicalMessageId,
    localMessageId: input.localMessageId,
    idempotencyKey: input.idempotencyKey,
    contentHash: input.contentHash,
  });
}

export function completeHappierApprovalIdentity(
  target: HappierApprovalBoundIdentity,
  hostId: string,
): SessionConnectorIdentityV1 {
  return {
    connectorId: "happier",
    providerId: target.providerId,
    nativeSessionId: target.nativeSessionId,
    happierSessionId: target.happierSessionId,
    serverProfileId: target.serverProfileId,
    machineId: target.machineId,
    hostId,
  };
}

export function happierApprovalFailureFromError<T>(
  error: unknown,
  bridge: string,
  happierSessionId?: string,
): SessionConnectorResultV1<T> | null {
  if (!(error instanceof HappierApprovalRequiredError)) return null;
  return connectorFailure(
    "unavailable",
    "Happier MCP created an approval request; the requested action has not executed",
    {
      bridge,
      actionState: error.actionState,
      artifactId: error.artifactId,
      operation: error.operation,
      ...(happierSessionId ? { happierSessionId } : {}),
      runtimeState: "waitingOnInput",
      reconciliationRequired: true,
    },
  );
}

export function happierApprovalWaitingResult<T>(
  record: HappierApprovalStateRecord,
  existingDetails: Readonly<Record<string, unknown>> = {},
): SessionConnectorResultV1<T> {
  return connectorFailure(
    "unavailable",
    "Happier created an approval request; the requested action has not executed",
    {
      ...existingDetails,
      actionState: "approval_request_created",
      artifactId: record.artifactId,
      operation: record.operation,
      happierSessionId: record.identity.happierSessionId,
      sessionIdentity: record.identity,
      approvalStateRef: record.keyHash,
      runtimeState: "waitingOnInput",
      reconciliationRequired: true,
    },
  );
}

export async function restoreHappierApprovalForSend(input: Readonly<{
  store: HappierApprovalStateStore;
  identity: SessionConnectorIdentityV1;
  request: SessionConnectorSendRequestV1;
  operation: string;
}>): Promise<SessionConnectorResultV1<SessionConnectorSendReceiptV1> | null> {
  try {
    const approval = await input.store.find(
      happierApprovalKeyForSend(input.identity, input.request, input.operation),
    );
    if (!approval) return null;
    return approval.state === "reconciled" && approval.receipt
      ? { ok: true, value: approval.receipt }
      : happierApprovalWaitingResult(approval);
  } catch {
    return connectorFailure(
      "delivery_uncertain",
      "The durable Happier approval state is unavailable",
      { bindingState: "happier_approval_state_unavailable" },
    );
  }
}

export function persistHappierSendApproval(input: Readonly<{
  result: SessionConnectorResultV1<SessionConnectorSendReceiptV1>;
  identity: SessionConnectorIdentityV1;
  request: SessionConnectorSendRequestV1;
  operation: string;
  store: HappierApprovalStateStore;
}>): Promise<SessionConnectorResultV1<SessionConnectorSendReceiptV1>> {
  return persistHappierApprovalWaiting({
    result: input.result,
    key: happierApprovalKeyForSend(input.identity, input.request, input.operation),
    store: input.store,
    reconciledValue: (receipt) => receipt,
  });
}

export function persistHappierControlApproval<T>(input: Readonly<{
  result: SessionConnectorResultV1<T>;
  identity: SessionConnectorIdentityV1;
  idempotencyKey: string;
  operation: string;
  store: HappierApprovalStateStore;
}>): Promise<SessionConnectorResultV1<T>> {
  return persistHappierApprovalWaiting({
    result: input.result,
    key: {
      operation: input.operation,
      identity: input.identity,
      bindingId: null,
      logicalMessageId: null,
      localMessageId: null,
      idempotencyKey: input.idempotencyKey,
      contentHash: null,
    },
    store: input.store,
  });
}

export async function persistHappierApprovalWaiting<T>(input: Readonly<{
  result: SessionConnectorResultV1<T>;
  key: HappierApprovalStateKeyInput;
  store: HappierApprovalStateStore;
  reconciledValue?: (receipt: SessionConnectorSendReceiptV1) => T;
}>): Promise<SessionConnectorResultV1<T>> {
  const outcome = approvalOutcomeFromFailure(input.result);
  if (!outcome || input.result.ok) return input.result;
  try {
    const record = await input.store.recordWaiting({
      ...input.key,
      artifactId: outcome.artifactId,
    });
    if (record.state === "reconciled" && record.receipt && input.reconciledValue) {
      return { ok: true, value: input.reconciledValue(record.receipt) };
    }
    return happierApprovalWaitingResult(record, input.result.error.safeDetails);
  } catch {
    return connectorFailure(
      "delivery_uncertain",
      "Happier created an approval request but its durable state could not be persisted",
      {
        actionState: outcome.actionState,
        artifactId: outcome.artifactId,
        operation: outcome.operation,
        bindingState: "happier_approval_state_persistence_failed",
        reconciliationRequired: true,
      },
    );
  }
}

function durableDeliveryAuthorization(value: unknown): boolean {
  const authorization = recordValue(value);
  const fence = recordValue(authorization?.senderFence);
  return Boolean(
    authorization
    && validText(authorization.outboxId)
    && fence
    && validText(fence.leaseId)
    && validText(fence.roomId)
    && fence.kind === "sender"
    && validText(fence.resourceId)
    && validText(fence.holderId)
    && validText(fence.hostId)
    && typeof fence.expectedEpoch === "number"
    && Number.isSafeInteger(fence.expectedEpoch)
    && fence.expectedEpoch > 0
  );
}

function validApprovalSendRequest(input: HappierApprovalReconciliationRequest): boolean {
  const request = input.request;
  return input.contractVersion === 1
    && validText(input.artifactId)
    && request.contractVersion === 1
    && validText(request.bindingId)
    && validText(request.logicalMessageId)
    && validText(request.idempotencyKey)
    && typeof request.localMessageId === "string"
    && /^[A-Za-z0-9._:-]{1,128}$/u.test(request.localMessageId)
    && typeof request.content === "string"
    && request.content.trim().length > 0
    && request.content.length <= 100_000
    && request.contentHash === hashRoomValue(request.content)
    && durableDeliveryAuthorization(request.deliveryAuthorization);
}

export async function reconcileHappierApprovalRequest(input: Readonly<{
  command: HappierApprovalReconciliationRequest;
  identity: SessionConnectorIdentityV1;
  operation: string;
  store: HappierApprovalStateStore;
  reserveDelivery: () => Promise<HappierDeliveryFenceReservation>;
  reconcilePending: () => Promise<SessionConnectorResultV1<SessionConnectorSendReceiptV1>>;
}>): Promise<SessionConnectorResultV1<SessionConnectorSendReceiptV1>> {
  if (!validApprovalSendRequest(input.command)) {
    return {
      ok: false,
      error: {
        code: "invalid_request",
        message: "Happier approval reconciliation requires the exact durable send request",
        retryable: false,
      },
    };
  }
  const key = happierApprovalKeyForSend(
    input.identity,
    input.command.request,
    input.operation,
  );
  return reconcileHappierApprovalState({
    stateInput: { ...key, artifactId: input.command.artifactId },
    store: input.store,
    reserveDelivery: input.reserveDelivery,
    reconcilePending: input.reconcilePending,
  });
}

export async function reconcileHappierApprovalState(input: Readonly<{
  stateInput: HappierApprovalStateInput;
  store: HappierApprovalStateStore;
  reserveDelivery: () => Promise<HappierDeliveryFenceReservation>;
  reconcilePending: () => Promise<SessionConnectorResultV1<SessionConnectorSendReceiptV1>>;
}>): Promise<SessionConnectorResultV1<SessionConnectorSendReceiptV1>> {
  let approval: HappierApprovalStateRecord | null;
  try {
    approval = await input.store.read(input.stateInput);
  } catch {
    return connectorFailure(
      "conflict",
      "The Happier approval artifact does not match the durable delivery identity",
      { bindingState: "happier_approval_identity_conflict" },
    );
  }
  if (!approval) {
    return connectorFailure(
      "not_found",
      "The durable Happier approval state was not found",
      { bindingState: "happier_approval_state_missing" },
    );
  }
  if (approval.state === "reconciled" && approval.receipt) {
    return { ok: true, value: approval.receipt };
  }
  let reservation: HappierDeliveryFenceReservation;
  try {
    reservation = await input.reserveDelivery();
  } catch {
    return connectorFailure(
      "delivery_uncertain",
      "The durable Happier localId delivery fence is unavailable",
      { bindingState: "happier_delivery_fence_unavailable" },
    );
  }
  if (reservation.state === "conflict" || reservation.state === "created") {
    return connectorFailure(
      "delivery_uncertain",
      "The durable Happier approval and delivery fences do not describe the same prior send",
      { bindingState: "happier_approval_delivery_fence_conflict" },
    );
  }
  const reconciled = reservation.state === "confirmed"
    ? reservation.record.receipt
      ? { ok: true as const, value: reservation.record.receipt }
      : connectorFailure<SessionConnectorSendReceiptV1>(
        "delivery_uncertain",
        "The durable Happier receipt is invalid",
        { bindingState: "happier_delivery_fence_receipt_invalid" },
      )
    : await input.reconcilePending();
  if (!reconciled.ok) return reconciled;
  try {
    const persisted = await input.store.markReconciled(input.stateInput, reconciled.value);
    return persisted.receipt
      ? { ok: true, value: persisted.receipt }
      : connectorFailure(
        "delivery_uncertain",
        "The durable Happier approval receipt is invalid",
        { bindingState: "happier_approval_state_confirmation_failed" },
      );
  } catch {
    return connectorFailure(
      "delivery_uncertain",
      "Happier approval execution was observed but its durable approval state could not be confirmed",
      { bindingState: "happier_approval_state_confirmation_failed" },
    );
  }
}


function validateIdentity(value: SessionConnectorIdentityV1): SessionConnectorIdentityV1 {
  if (
    !exactFields(value as unknown as Record<string, unknown>, [
      "connectorId",
      "providerId",
      "nativeSessionId",
      "happierSessionId",
      "serverProfileId",
      "machineId",
      "hostId",
    ])
    || !validText(value.connectorId)
    || (value.providerId !== "codex" && value.providerId !== "claude" && value.providerId !== "opencode")
    || !validText(value.nativeSessionId)
    || !validText(value.happierSessionId)
    || !validText(value.serverProfileId)
    || !validText(value.machineId)
    || !validText(value.hostId)
  ) {
    throw new Error("Happier approval Session identity is invalid");
  }
  return Object.freeze({ ...value });
}

function validateKeyInput(input: HappierApprovalStateKeyInput): HappierApprovalStateKeyInput {
  const identity = validateIdentity(input.identity);
  if (
    !OPERATION_PATTERN.test(input.operation)
    || !validNullableText(input.bindingId)
    || !validNullableText(input.logicalMessageId)
    || !validNullableText(input.localMessageId)
    || !validText(input.idempotencyKey)
    || !(input.contentHash === null || HASH_PATTERN.test(input.contentHash))
  ) {
    throw new Error("Happier approval state input is invalid");
  }
  return Object.freeze({ ...input, identity });
}

function validateInput(input: HappierApprovalStateInput): HappierApprovalStateInput {
  if (!validText(input.artifactId)) throw new Error("Happier approval artifact identity is invalid");
  return Object.freeze({
    ...validateKeyInput(input),
    artifactId: input.artifactId,
  });
}

function keyHashFor(input: HappierApprovalStateKeyInput): string {
  return createHash("sha256").update(JSON.stringify({
    contractVersion: APPROVAL_STATE_CONTRACT_VERSION,
    operation: input.operation,
    identity: input.identity,
    bindingId: input.bindingId,
    logicalMessageId: input.logicalMessageId,
    localMessageId: input.localMessageId,
    idempotencyKey: input.idempotencyKey,
    contentHash: input.contentHash,
  })).digest("hex");
}

function parseReceipt(value: unknown): SessionConnectorSendReceiptV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  if (
    !exactFields(receipt, [
      "outcome",
      "connectorAcknowledgementId",
      "nativeMessageId",
      "cursor",
      "acceptedAt",
    ])
    || receipt.outcome !== "confirmed"
    || !validText(receipt.connectorAcknowledgementId)
    || !validText(receipt.nativeMessageId)
    || !validNullableText(receipt.cursor)
    || !(receipt.acceptedAt === null || validTimestamp(receipt.acceptedAt))
  ) {
    return null;
  }
  return receipt as unknown as SessionConnectorSendReceiptV1;
}

function parseRecord(value: unknown, expectedKeyHash: string): HappierApprovalStateRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Happier approval state record is invalid");
  }
  const record = value as Record<string, unknown>;
  if (!exactFields(record, [
    "contractVersion",
    "keyHash",
    "state",
    "artifactId",
    "operation",
    "identity",
    "bindingId",
    "logicalMessageId",
    "localMessageId",
    "idempotencyKey",
    "contentHash",
    "receipt",
    "createdAt",
    "updatedAt",
  ])) {
    throw new Error("Happier approval state record contains unsupported fields");
  }
  const input = validateInput({
    artifactId: String(record.artifactId ?? ""),
    operation: String(record.operation ?? ""),
    identity: record.identity as SessionConnectorIdentityV1,
    bindingId: record.bindingId as string | null,
    logicalMessageId: record.logicalMessageId as string | null,
    localMessageId: record.localMessageId as string | null,
    idempotencyKey: String(record.idempotencyKey ?? ""),
    contentHash: record.contentHash as string | null,
  });
  const receipt = record.receipt === null ? null : parseReceipt(record.receipt);
  if (
    record.contractVersion !== APPROVAL_STATE_CONTRACT_VERSION
    || record.keyHash !== expectedKeyHash
    || !KEY_HASH_PATTERN.test(expectedKeyHash)
    || keyHashFor(input) !== expectedKeyHash
    || (record.state !== "waiting_approval" && record.state !== "reconciled")
    || (record.state === "waiting_approval" && record.receipt !== null)
    || (record.state === "reconciled" && receipt === null)
    || !validTimestamp(record.createdAt)
    || !validTimestamp(record.updatedAt)
    || Date.parse(record.updatedAt) < Date.parse(record.createdAt)
  ) {
    throw new Error("Happier approval state record failed contract validation");
  }
  return Object.freeze({
    contractVersion: APPROVAL_STATE_CONTRACT_VERSION,
    keyHash: expectedKeyHash,
    state: record.state,
    ...input,
    receipt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function defaultDirectory(): string {
  const fusionHome = process.env.FUSION_HOME?.trim();
  const root = fusionHome ? resolve(fusionHome) : join(homedir(), ".fusion");
  return join(root, "plugins", "fusion-plugin-happier-runtime", "approval-states");
}

function transientReplaceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EBUSY" || code === "EPERM";
}

async function replaceWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (attempt === 2 || !transientReplaceError(error)) throw error;
      await new Promise<void>((resolveDelay) => {
        const timer = setTimeout(resolveDelay, attempt === 0 ? 75 : 250);
        timer.unref();
      });
    }
  }
}

/**
 * FNXC:HappierApprovalDurability 2026-07-27-15:59:
 * A provider action that stops at approval is atomically recorded against its
 * complete immutable Session and delivery identity before the connector
 * reports waitingOnInput. Restarted processes read the same record and cannot
 * turn the pending approval into a second send.
 */
export function createHappierApprovalStateStore(
  options: HappierApprovalStateStoreOptions = {},
): HappierApprovalStateStore {
  const directory = resolve(options.directory?.trim() || defaultDirectory());
  const now = options.now ?? (() => new Date().toISOString());
  const fileFor = (keyHash: string): string => {
    if (!KEY_HASH_PATTERN.test(keyHash)) throw new Error("Happier approval state key is invalid");
    return join(directory, `${keyHash}.json`);
  };
  const readByHash = async (keyHash: string): Promise<HappierApprovalStateRecord | null> => {
    let source: string;
    try {
      source = await readFile(fileFor(keyHash), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("Happier approval state could not be read", { cause: error });
    }
    try {
      return parseRecord(JSON.parse(source), keyHash);
    } catch (error) {
      throw new Error("Happier approval state is corrupt", { cause: error });
    }
  };
  const writeInitial = async (record: HappierApprovalStateRecord): Promise<boolean> => {
    const target = fileFor(record.keyHash);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporary, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      try {
        await link(temporary, target);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  };
  const writeReplacement = async (record: HappierApprovalStateRecord): Promise<void> => {
    const target = fileFor(record.keyHash);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try {
      await replaceWithRetry(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  };
  return Object.freeze({
    recordWaiting: async (unvalidated: HappierApprovalStateInput) => {
      const input = validateInput(unvalidated);
      const keyHash = keyHashFor(input);
      const timestamp = now();
      if (!validTimestamp(timestamp)) throw new Error("Happier approval state clock is invalid");
      const created = parseRecord({
        contractVersion: APPROVAL_STATE_CONTRACT_VERSION,
        keyHash,
        state: "waiting_approval",
        ...input,
        receipt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }, keyHash);
      if (await writeInitial(created)) return created;
      const existing = await readByHash(keyHash);
      if (!existing || existing.artifactId !== input.artifactId) {
        throw new Error("Happier approval artifact conflicts with the durable delivery identity");
      }
      return existing;
    },
    find: async (unvalidated: HappierApprovalStateKeyInput) => {
      const input = validateKeyInput(unvalidated);
      return readByHash(keyHashFor(input));
    },
    read: async (unvalidated: HappierApprovalStateInput) => {
      const input = validateInput(unvalidated);
      const existing = await readByHash(keyHashFor(input));
      if (existing && existing.artifactId !== input.artifactId) {
        throw new Error("Happier approval artifact conflicts with the durable delivery identity");
      }
      return existing;
    },
    markReconciled: async (
      unvalidated: HappierApprovalStateInput,
      receipt: SessionConnectorSendReceiptV1,
    ) => {
      const input = validateInput(unvalidated);
      const parsedReceipt = parseReceipt(receipt);
      if (!parsedReceipt) throw new Error("Happier approval reconciliation receipt is invalid");
      const keyHash = keyHashFor(input);
      const existing = await readByHash(keyHash);
      if (!existing || existing.artifactId !== input.artifactId) {
        throw new Error("Happier approval state is unavailable for reconciliation");
      }
      if (existing.state === "reconciled") {
        if (JSON.stringify(existing.receipt) !== JSON.stringify(parsedReceipt)) {
          throw new Error("Happier approval reconciliation receipt conflicts");
        }
        return existing;
      }
      const reconciled = parseRecord({
        ...existing,
        state: "reconciled",
        receipt: parsedReceipt,
        updatedAt: now(),
      }, keyHash);
      await writeReplacement(reconciled);
      return reconciled;
    },
  });
}

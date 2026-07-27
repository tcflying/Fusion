import {
  hashRoomValue,
  type SessionConnectorControlRequestV1,
  type SessionConnectorControlResultV1,
  type SessionConnectorResultV1,
  type SessionConnectorSendReceiptV1,
  type SessionConnectorSendRequestV1,
} from "@fusion/core";

import {
  completeHappierApprovalIdentity,
  persistHappierControlApproval,
  persistHappierSendApproval,
  reconcileHappierApprovalRequest,
  restoreHappierApprovalForSend,
  type HappierApprovalReconciliationRequest,
  type HappierApprovalStateStore,
} from "./approval-state-store.js";
import type { HappierBoundIdentity } from "./binding-identity.js";
import type {
  HappierDeliveryFenceInput,
  HappierDeliveryFenceStore,
} from "./delivery-fence-store.js";
import { HAPPIER_OFFICIAL_MCP_TOOLS } from "./happier-mcp-client.js";
import { mcpResultRecord } from "./mcp-result-contract.js";
import {
  validateOfficialRawHistoryResult,
  validateOfficialSessionSendResult,
  validateOfficialSessionWaitResult,
} from "./official-session-control-contract.js";
import {
  confirmedSendReceipt,
  correlateRawHappierHistoryLocalId,
  deliveryFenceInput,
} from "./send-receipt.js";
import {
  authorizeHappierHostWrite,
  happierHostWriteAuthorizationRequired,
  isDurableHappierDeliveryAuthorization,
  type HappierSessionIdentityResolver,
} from "./session-connector-identity.js";
import {
  HappierReceiptReconciliationError,
  happierConnectorFailure,
  mapHappierMcpFailure,
  nonEmptyHappierString,
  type HappierSessionConnectorTransport,
} from "./session-connector-transport.js";

interface HappierSessionSendReceiptOptions {
  readonly owner: object;
  readonly connectorId: string;
  readonly identity: HappierSessionIdentityResolver;
  readonly transport: HappierSessionConnectorTransport;
  readonly sendTimeoutSeconds: number;
  readonly deliveryFenceStore: HappierDeliveryFenceStore;
  readonly approvalStateStore: HappierApprovalStateStore;
}

/*
 * FNXC:HappierSessionConnectorSendReceipt 2026-07-27-17:57:
 * Delivery owns only the authorized send, exact receipt reconciliation, and
 * durable approval/fence transitions. Session lifecycle and capability
 * discovery cannot claim or duplicate this delivery truth.
 */
export class HappierSessionSendReceiptController {
  private readonly owner: object;
  private readonly connectorId: string;
  private readonly identity: HappierSessionIdentityResolver;
  private readonly transport: HappierSessionConnectorTransport;
  private readonly sendTimeoutSeconds: number;
  private readonly deliveryFenceStore: HappierDeliveryFenceStore;
  private readonly approvalStateStore: HappierApprovalStateStore;

  constructor(options: HappierSessionSendReceiptOptions) {
    this.owner = options.owner;
    this.connectorId = options.connectorId;
    this.identity = options.identity;
    this.transport = options.transport;
    this.sendTimeoutSeconds = options.sendTimeoutSeconds;
    this.deliveryFenceStore = options.deliveryFenceStore;
    this.approvalStateStore = options.approvalStateStore;
  }

  async send(
    input: SessionConnectorSendRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorSendReceiptV1>> {
    const target = this.identity.validateBoundIdentity(
      input.identity,
      "send a message",
    );
    if (!target.ok) return target;
    if (
      input.contractVersion !== 1
      || !nonEmptyHappierString(input.bindingId)
      || !nonEmptyHappierString(input.logicalMessageId)
      || !nonEmptyHappierString(input.idempotencyKey)
      || !nonEmptyHappierString(input.localMessageId, 128)
      || !/^[A-Za-z0-9._:-]+$/u.test(input.localMessageId)
      || !nonEmptyHappierString(input.content, 100_000)
      || input.contentHash !== hashRoomValue(input.content)
    ) {
      return happierConnectorFailure(
        "invalid_request",
        "Happier send requires valid identity, idempotency, content, and content hash",
        false,
      );
    }
    if (
      !isDurableHappierDeliveryAuthorization(
        input.deliveryAuthorization,
      )
    ) {
      return happierHostWriteAuthorizationRequired();
    }
    const authorization = await authorizeHappierHostWrite(
      this.owner,
      this.connectorId,
      target.value,
      input.identity,
      {
        operation: "send",
        bindingId: input.bindingId,
        logicalMessageId: input.logicalMessageId,
        localMessageId: input.localMessageId,
        idempotencyKey: input.idempotencyKey,
        contentHash: input.contentHash,
        reason: null,
        deliveryAuthorization: input.deliveryAuthorization,
      },
    );
    if (!authorization.ok) return authorization;
    try {
      await this.transport.assertCliAttested();
    } catch (error) {
      return mapHappierMcpFailure(error);
    }
    const fenceInput = deliveryFenceInput(target.value, input);
    let reservation: Awaited<
      ReturnType<HappierDeliveryFenceStore["reserve"]>
    >;
    try {
      reservation =
        await this.deliveryFenceStore.reserve(fenceInput);
    } catch {
      return happierConnectorFailure(
        "delivery_uncertain",
        "The durable Happier localId delivery fence is unavailable",
        false,
        {
          bindingState:
            "happier_delivery_fence_unavailable",
        },
      );
    }
    if (reservation.state === "conflict") {
      return happierConnectorFailure(
        "conflict",
        "A Happier localId is already bound to a different immutable content hash",
        false,
        {
          bindingState:
            "happier_local_id_content_hash_conflict",
        },
      );
    }
    if (reservation.state === "confirmed") {
      if (!reservation.record.receipt) {
        return happierConnectorFailure(
          "delivery_uncertain",
          "The durable Happier receipt is invalid",
          false,
        );
      }
      return { ok: true, value: reservation.record.receipt };
    }
    if (reservation.state === "pending") {
      const persistedApproval =
        await restoreHappierApprovalForSend({
          store: this.approvalStateStore,
          identity: completeHappierApprovalIdentity(
            target.value,
            input.identity.hostId,
          ),
          request: input,
          operation: HAPPIER_OFFICIAL_MCP_TOOLS.send,
        });
      if (persistedApproval) return persistedApproval;
      return this.reconcilePendingDelivery(
        target.value,
        input,
        fenceInput,
      );
    }

    const sendResult = await this.transport.withOfficialMcp(
      target.value.happierSessionId,
      [
        HAPPIER_OFFICIAL_MCP_TOOLS.send,
        HAPPIER_OFFICIAL_MCP_TOOLS.wait,
        HAPPIER_OFFICIAL_MCP_TOOLS.history,
      ],
      async (client) => {
        const sendRecord = mcpResultRecord(
          await client.callTool({
            name: HAPPIER_OFFICIAL_MCP_TOOLS.send,
            arguments: {
              sessionId: target.value.happierSessionId,
              message: input.content,
              localId: input.localMessageId,
              wait: false,
              timeoutSeconds: this.sendTimeoutSeconds,
            },
          }),
          HAPPIER_OFFICIAL_MCP_TOOLS.send,
        );
        const validatedSend = validateOfficialSessionSendResult(
          sendRecord,
          {
            sessionId: target.value.happierSessionId,
            localId: input.localMessageId,
            waited: false,
          },
        );
        if (!validatedSend.ok) {
          throw new HappierReceiptReconciliationError(
            validatedSend.reason,
          );
        }
        const waitRecord = mcpResultRecord(
          await client.callTool({
            name: HAPPIER_OFFICIAL_MCP_TOOLS.wait,
            arguments: {
              sessionId: target.value.happierSessionId,
              timeoutSeconds: this.sendTimeoutSeconds,
            },
          }),
          HAPPIER_OFFICIAL_MCP_TOOLS.wait,
        );
        const validatedWait = validateOfficialSessionWaitResult(
          waitRecord,
          target.value.happierSessionId,
        );
        if (!validatedWait.ok) {
          throw new HappierReceiptReconciliationError(
            validatedWait.reason,
          );
        }
        const historyRecord = mcpResultRecord(
          await client.callTool({
            name: HAPPIER_OFFICIAL_MCP_TOOLS.history,
            arguments: {
              sessionId: target.value.happierSessionId,
              limit: 1000,
              format: "raw",
              includeMeta: false,
              includeStructuredPayload: false,
            },
          }),
          HAPPIER_OFFICIAL_MCP_TOOLS.history,
        );
        const validatedHistory = validateOfficialRawHistoryResult(
          historyRecord,
          target.value.happierSessionId,
        );
        if (!validatedHistory.ok) {
          throw new HappierReceiptReconciliationError(
            validatedHistory.reason,
          );
        }
        const correlation = correlateRawHappierHistoryLocalId(
          validatedHistory.value,
          {
            localMessageId: input.localMessageId,
            contentHash: input.contentHash,
          },
        );
        if (correlation.outcome !== "matched") {
          throw new HappierReceiptReconciliationError(
            correlation.reason,
          );
        }
        /*
         * FNXC:HappierReceiptIdentity 2026-07-27-03:34:
         * A confirmed receipt comes only from exact send, idle, and raw
         * history evidence bound to the full native/Happier identity.
         */
        return confirmedSendReceipt(
          target.value,
          input,
          correlation.nativeMessageId,
          validatedWait.value.observedAt,
        );
      },
    );
    if (!sendResult.ok) {
      return persistHappierSendApproval({
        result: sendResult,
        identity: completeHappierApprovalIdentity(
          target.value,
          input.identity.hostId,
        ),
        request: input,
        operation: HAPPIER_OFFICIAL_MCP_TOOLS.send,
        store: this.approvalStateStore,
      });
    }
    return this.persistConfirmedDelivery(
      fenceInput,
      sendResult.value,
    );
  }

  /**
   * FNXC:HappierApprovalReconciliation 2026-07-27-16:04:
   * Approval recovery reads history for the exact durable artifact and
   * delivery identity. It never replays send.
   */
  async reconcileApproval(
    input: HappierApprovalReconciliationRequest,
  ): Promise<SessionConnectorResultV1<SessionConnectorSendReceiptV1>> {
    const request = input.request;
    const target = this.identity.validateBoundIdentity(
      request.identity,
      "reconcile an approved send",
    );
    if (!target.ok) return target;
    return reconcileHappierApprovalRequest({
      command: input,
      identity: completeHappierApprovalIdentity(
        target.value,
        request.identity.hostId,
      ),
      operation: HAPPIER_OFFICIAL_MCP_TOOLS.send,
      store: this.approvalStateStore,
      reserveDelivery: () =>
        this.deliveryFenceStore.reserve(
          deliveryFenceInput(target.value, request),
        ),
      reconcilePending: () =>
        this.reconcilePendingDelivery(
          target.value,
          request,
          deliveryFenceInput(target.value, request),
        ),
    });
  }

  private async reconcilePendingDelivery(
    target: HappierBoundIdentity,
    input: SessionConnectorSendRequestV1,
    fenceInput: HappierDeliveryFenceInput,
  ): Promise<SessionConnectorResultV1<SessionConnectorSendReceiptV1>> {
    const reconciled = await this.transport.withOfficialMcp(
      target.happierSessionId,
      [HAPPIER_OFFICIAL_MCP_TOOLS.history],
      async (client) => {
        const historyRecord = mcpResultRecord(
          await client.callTool({
            name: HAPPIER_OFFICIAL_MCP_TOOLS.history,
            arguments: {
              sessionId: target.happierSessionId,
              limit: 1000,
              format: "raw",
              includeMeta: false,
              includeStructuredPayload: false,
            },
          }),
          HAPPIER_OFFICIAL_MCP_TOOLS.history,
        );
        const validatedHistory = validateOfficialRawHistoryResult(
          historyRecord,
          target.happierSessionId,
        );
        if (!validatedHistory.ok) {
          throw new HappierReceiptReconciliationError(
            validatedHistory.reason,
          );
        }
        const correlation = correlateRawHappierHistoryLocalId(
          validatedHistory.value,
          {
            localMessageId: input.localMessageId,
            contentHash: input.contentHash,
          },
        );
        if (correlation.outcome !== "matched") {
          throw new HappierReceiptReconciliationError(
            correlation.reason,
          );
        }
        return confirmedSendReceipt(
          target,
          input,
          correlation.nativeMessageId,
          null,
        );
      },
    );
    if (!reconciled.ok) return reconciled;
    return this.persistConfirmedDelivery(
      fenceInput,
      reconciled.value,
    );
  }

  private async persistConfirmedDelivery(
    fenceInput: HappierDeliveryFenceInput,
    receipt: SessionConnectorSendReceiptV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorSendReceiptV1>> {
    try {
      const confirmed = await this.deliveryFenceStore.confirm(
        fenceInput,
        receipt,
      );
      if (!confirmed.record.receipt) {
        return happierConnectorFailure(
          "delivery_uncertain",
          "The durable Happier receipt is invalid",
          false,
        );
      }
      return { ok: true, value: confirmed.record.receipt };
    } catch {
      return happierConnectorFailure(
        "delivery_uncertain",
        "Happier delivery was observed but its durable receipt fence could not be confirmed",
        false,
        {
          bindingState:
            "happier_delivery_fence_confirmation_failed",
        },
      );
    }
  }

  async interrupt(
    input: SessionConnectorControlRequestV1,
  ): Promise<
    SessionConnectorResultV1<SessionConnectorControlResultV1>
  > {
    const target = this.identity.validateBoundIdentity(
      input.identity,
      "stop a session",
    );
    if (!target.ok) return target;
    const idempotencyKey = nonEmptyHappierString(
      input.idempotencyKey,
      512,
    );
    const reason = nonEmptyHappierString(input.reason, 2_000);
    if (
      input.contractVersion !== 1
      || !idempotencyKey
      || !reason
    ) {
      return happierConnectorFailure(
        "invalid_request",
        "Happier interrupt requires valid identity, idempotency, and reason",
        false,
      );
    }
    const authorization = await authorizeHappierHostWrite(
      this.owner,
      this.connectorId,
      target.value,
      input.identity,
      {
        operation: "interrupt",
        bindingId: null,
        logicalMessageId: null,
        localMessageId: null,
        idempotencyKey,
        reason,
        deliveryAuthorization: null,
      },
    );
    if (!authorization.ok) return authorization;

    const mcpResult = await this.transport.withOfficialMcp(
      target.value.happierSessionId,
      [HAPPIER_OFFICIAL_MCP_TOOLS.stop],
      async (client) => {
        const record = mcpResultRecord(
          await client.callTool({
            name: HAPPIER_OFFICIAL_MCP_TOOLS.stop,
            arguments: {
              sessionId: target.value.happierSessionId,
            },
          }),
          HAPPIER_OFFICIAL_MCP_TOOLS.stop,
        );
        if (
          record.sessionId !== target.value.happierSessionId
          || record.stopped !== true
        ) {
          return happierConnectorFailure<
            SessionConnectorControlResultV1
          >(
            "delivery_uncertain",
            "Happier did not confirm that the exact remote session stopped",
            true,
            { state: "happier_stop_unconfirmed" },
          );
        }
        return {
          ok: true as const,
          value: {
            state: "completed" as const,
            connectorAcknowledgementId:
              `happier-stop:${hashRoomValue({
                canonicalSessionUri:
                  target.value.canonicalSessionUri,
                providerId: target.value.providerId,
                nativeSessionId: target.value.nativeSessionId,
                happierSessionId:
                  target.value.happierSessionId,
                serverProfileId:
                  target.value.serverProfileId,
                machineId: target.value.machineId,
                hostId: input.identity.hostId,
                idempotencyKey,
                reason,
                authorizationId:
                  authorization.value.authorizationId,
              })}`,
          },
        };
      },
    );
    const result = mcpResult.ok ? mcpResult.value : mcpResult;
    if (result.ok) return result;
    return persistHappierControlApproval({
      result,
      identity: completeHappierApprovalIdentity(
        target.value,
        input.identity.hostId,
      ),
      idempotencyKey,
      operation: HAPPIER_OFFICIAL_MCP_TOOLS.stop,
      store: this.approvalStateStore,
    });
  }
}

import { describe, expect, it } from "vitest";

import { validateRoomProtocolMessage } from "../room-contracts/protocol-message.js";
import { hashRoomValue } from "../room-integrity.js";
import { getRoomProtocolDefinition } from "../room-protocol-definitions.js";
import {
  buildRoomSemanticLoopFingerprint,
  routeRoomSemanticMessage,
} from "../room-semantic-routing.js";

function hash(value: string): string {
  return hashRoomValue(value);
}

function validMessage() {
  const content = "Please verify the bounded retry invariant.";
  return {
    contractVersion: "room-protocol-message/v1",
    messageId: "message-1",
    issuedAt: "2026-07-18T05:20:00.000Z",
    protocolId: "implementation",
    protocolVersion: 1,
    phaseId: "verify",
    channelId: "implementation_review",
    projectId: "project-1",
    roomId: "room-1",
    turnId: "turn-4",
    nodeId: "node-7",
    origin: {
      seatId: "seat-reviewer",
      bindingId: "binding-reviewer-2",
      roleId: "implementation_verifier",
    },
    target: { kind: "seats", seatIds: ["seat-implementer"] },
    intent: "challenge",
    content,
    contentHash: hash(content),
    semanticHash: hash("verify bounded retry invariant"),
    evidenceStateHash: hash("evidence-state-1"),
    decisionStateHash: hash("decision-state-1"),
    authority: {
      actorType: "seat",
      actorId: "seat-reviewer",
      deviceId: null,
      role: "implementation_verifier",
      allowedActions: ["room:message:route"],
      projectId: "project-1",
      roomId: "room-1",
      nodeIds: ["node-7"],
      seatIds: ["seat-reviewer", "seat-implementer", "seat-verifier-2"],
      evidenceRefs: ["evidence-1"],
    },
    references: {
      evidenceRefs: ["evidence-1"],
      parentMessageIds: ["message-0"],
      resolutionRefs: ["resolution-1"],
    },
  };
}

function authoritativeState(message = validMessage()) {
  return {
    semanticHash: message.semanticHash,
    evidenceStateHash: message.evidenceStateHash,
    decisionStateHash: message.decisionStateHash,
  };
}

/*
FNXC:SessionRoomSemanticRouting 2026-07-18-13:20:
Task 5.6 messages are strict runtime data, not TypeScript-only assertions. The
policy must detach and freeze accepted inputs so later caller mutation cannot
rewrite origin, authority, evidence, or semantic-loop state after validation.
*/
describe("Room semantic routing", () => {
  it("validates a structured protocol message into a detached deeply frozen value", () => {
    const input = validMessage();

    const result = validateRoomProtocolMessage(input);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected a valid protocol message");
    expect(result.value).toEqual(input);
    expect(result.value).not.toBe(input);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.origin)).toBe(true);
    expect(Object.isFrozen(result.value.target)).toBe(true);
    expect(Object.isFrozen(result.value.authority)).toBe(true);
    expect(Object.isFrozen(result.value.references.evidenceRefs)).toBe(true);

    input.origin.roleId = "mutated";
    input.references.evidenceRefs[0] = "mutated";
    input.content = "mutated transcript plaintext";
    expect(result.value.origin.roleId).toBe("implementation_verifier");
    expect(result.value.references.evidenceRefs).toEqual(["evidence-1"]);
    expect(result.value.content).toBe("Please verify the bounded retry invariant.");
  });

  it("fails closed on unknown, inconsistent, oversized, proxied, and sparse runtime JSON", () => {
    const unknownField = { ...validMessage(), transcriptPlaintext: "must not be accepted" };
    const wrongHash = { ...validMessage(), contentHash: hash("different content") };
    const oversizedContent = "x".repeat(65_537);
    const oversized = {
      ...validMessage(),
      content: oversizedContent,
      contentHash: hash(oversizedContent),
    };
    const proxied = new Proxy(validMessage(), {});
    const sparse = validMessage();
    const sparseEvidence = new Array<string>(2);
    sparseEvidence[0] = "evidence-1";
    sparse.references.evidenceRefs = sparseEvidence;

    for (const input of [unknownField, wrongHash, oversized, proxied, sparse]) {
      const result = validateRoomProtocolMessage(input);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected strict runtime rejection");
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it("binds the exact protocol phase channel origin and targets before routing an allowed intent", () => {
    const protocol = getRoomProtocolDefinition("implementation", 1);
    if (!protocol) throw new Error("Missing built-in implementation protocol");
    const seats = [
      {
        seatId: "seat-reviewer",
        bindingId: "binding-reviewer-2",
        roleId: "implementation_verifier",
        groupIds: ["reviewers"],
      },
      {
        seatId: "seat-implementer",
        bindingId: "binding-implementer-1",
        roleId: "implementer",
        groupIds: ["implementers"],
      },
      {
        seatId: "seat-verifier-2",
        bindingId: "binding-verifier-3",
        roleId: "implementation_verifier",
        groupIds: ["reviewers"],
      },
    ];

    const routed = routeRoomSemanticMessage({
      message: validMessage(),
      protocol,
      seats,
      history: [],
      authoritativeState: authoritativeState(),
    });

    expect(routed.ok).toBe(true);
    if (!routed.ok) throw new Error("Expected a routed message");
    expect(routed.value.outcome).toBe("route");
    expect(routed.value.recipientSeatIds).toEqual(["seat-implementer", "seat-verifier-2"]);
    expect(routed.value.requiredResponderSeatIds).toEqual([
      "seat-implementer",
      "seat-verifier-2",
    ]);
    const reverseTarget = {
      ...validMessage(),
      target: { kind: "seats", seatIds: ["seat-verifier-2", "seat-implementer"] },
    };
    const forwardTarget = {
      ...reverseTarget,
      target: { kind: "seats", seatIds: ["seat-implementer", "seat-verifier-2"] },
    };
    const reverseRoute = routeRoomSemanticMessage({
      message: reverseTarget,
      protocol,
      seats,
      history: [],
      authoritativeState: authoritativeState(reverseTarget),
    });
    const forwardRoute = routeRoomSemanticMessage({
      message: forwardTarget,
      protocol,
      seats,
      history: [],
      authoritativeState: authoritativeState(forwardTarget),
    });
    expect(reverseRoute.ok && reverseRoute.value.outcome === "route" ? reverseRoute.value.recipientSeatIds : null)
      .toEqual(["seat-implementer", "seat-verifier-2"]);
    expect(reverseRoute.ok && forwardRoute.ok ? reverseRoute.value.audit.targetFingerprint : null)
      .toBe(forwardRoute.ok ? forwardRoute.value.audit.targetFingerprint : null);

    const invalidMessages = [
      { ...validMessage(), protocolVersion: 2 },
      { ...validMessage(), channelId: "planning" },
      { ...validMessage(), intent: "question" },
      {
        ...validMessage(),
        origin: { ...validMessage().origin, bindingId: "binding-other" },
      },
      {
        ...validMessage(),
        target: { kind: "seats", seatIds: ["seat-missing"] },
      },
      {
        ...validMessage(),
        authority: { ...validMessage().authority, seatIds: ["seat-reviewer"] },
      },
    ];
    for (const message of invalidMessages) {
      expect(routeRoomSemanticMessage({
        message,
        protocol,
        seats,
        history: [],
        authoritativeState: authoritativeState(message),
      }).ok).toBe(false);
    }
    expect(routeRoomSemanticMessage({
      message: validMessage(),
      protocol,
      seats,
      history: [],
      authoritativeState: {
        ...authoritativeState(),
        semanticHash: hash("controller-derived-semantic-state"),
      },
    })).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "semantic_state_authority_mismatch" })],
    });
  });

  /*
  FNXC:SessionRoomSemanticRouting 2026-07-19-03:57:
  An active Session can cover several protocol roles. Keep roleId as the v1
  canonical/default identity while origin authorization and responder selection
  use the full declared roleIds set.
  */
  it("authorizes a multi-role seat as both the origin and a required responder", () => {
    const protocol = getRoomProtocolDefinition("implementation", 1);
    if (!protocol) throw new Error("Missing built-in implementation protocol");
    const message = validMessage();
    const seats = [
      {
        seatId: "seat-reviewer",
        bindingId: "binding-reviewer-2",
        roleId: "implementer",
        roleIds: ["implementer", "implementation_verifier"],
        groupIds: ["reviewers"],
      },
      {
        seatId: "seat-implementer",
        bindingId: "binding-implementer-1",
        roleId: "implementer",
        groupIds: ["implementers"],
      },
      {
        seatId: "seat-verifier-2",
        bindingId: "binding-verifier-3",
        roleId: "implementer",
        roleIds: ["implementer", "implementation_verifier"],
        groupIds: ["reviewers"],
      },
    ];

    const routed = routeRoomSemanticMessage({
      message,
      protocol,
      seats,
      history: [],
      authoritativeState: authoritativeState(message),
    });

    expect(routed.ok).toBe(true);
    if (!routed.ok || routed.value.outcome !== "route") {
      throw new Error("Expected a multi-role route");
    }
    expect(routed.value.recipientSeatIds).toEqual(["seat-implementer", "seat-verifier-2"]);
    expect(routed.value.requiredResponderSeatIds).toEqual([
      "seat-implementer",
      "seat-verifier-2",
    ]);
  });

  it("keeps roleId canonical for legacy seats and rejects role sets that omit it", () => {
    const protocol = getRoomProtocolDefinition("implementation", 1);
    if (!protocol) throw new Error("Missing built-in implementation protocol");
    const message = validMessage();
    const legacySeats = [
      {
        seatId: "seat-reviewer",
        bindingId: "binding-reviewer-2",
        roleId: "implementation_verifier",
        groupIds: ["reviewers"],
      },
      {
        seatId: "seat-implementer",
        bindingId: "binding-implementer-1",
        roleId: "implementer",
        groupIds: ["implementers"],
      },
      {
        seatId: "seat-verifier-2",
        bindingId: "binding-verifier-3",
        roleId: "implementation_verifier",
        groupIds: ["reviewers"],
      },
    ];

    const legacyRoute = routeRoomSemanticMessage({
      message,
      protocol,
      seats: legacySeats,
      history: [],
      authoritativeState: authoritativeState(message),
    });
    expect(legacyRoute.ok).toBe(true);
    if (!legacyRoute.ok || legacyRoute.value.outcome !== "route") {
      throw new Error("Expected legacy roleId routing to remain compatible");
    }
    expect(legacyRoute.value.recipientSeatIds).toEqual(["seat-implementer", "seat-verifier-2"]);

    const inconsistentRoleSet = legacySeats.map((seat) => (
      seat.seatId === "seat-reviewer"
        ? { ...seat, roleIds: ["implementer"] }
        : seat
    ));
    expect(routeRoomSemanticMessage({
      message,
      protocol,
      seats: inconsistentRoleSet,
      history: [],
      authoritativeState: authoritativeState(message),
    })).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: "invalid_routing_input" })],
    });
  });

  it("does not require every broadcast recipient unless the protocol explicitly says so", () => {
    const protocol = getRoomProtocolDefinition("implementation", 1);
    if (!protocol) throw new Error("Missing built-in implementation protocol");
    const seats = [
      { seatId: "seat-reviewer", bindingId: "binding-reviewer-2", roleId: "implementation_verifier", groupIds: ["reviewers"] },
      { seatId: "seat-implementer", bindingId: "binding-implementer-1", roleId: "implementer", groupIds: ["implementers"] },
      { seatId: "seat-verifier-2", bindingId: "binding-verifier-3", roleId: "implementation_verifier", groupIds: ["reviewers"] },
    ];
    const message = { ...validMessage(), intent: "critique", target: { kind: "all" } };

    const bounded = routeRoomSemanticMessage({ message, protocol, seats, history: [], authoritativeState: authoritativeState(message) });
    expect(bounded.ok).toBe(true);
    if (!bounded.ok || bounded.value.outcome !== "route") throw new Error("Expected routed broadcast");
    expect(bounded.value.recipientSeatIds).toEqual(["seat-implementer", "seat-verifier-2"]);
    expect(bounded.value.requiredResponderSeatIds).toEqual(["seat-verifier-2"]);

    const requireAll = structuredClone(protocol);
    const reviewChannel = requireAll.channels.find((channel) => channel.id === "implementation_review");
    if (!reviewChannel) throw new Error("Missing review channel");
    (reviewChannel as { broadcastRequiresResponse?: boolean }).broadcastRequiresResponse = true;
    const explicit = routeRoomSemanticMessage({ message, protocol: requireAll, seats, history: [], authoritativeState: authoritativeState(message) });
    expect(explicit.ok).toBe(true);
    if (!explicit.ok || explicit.value.outcome !== "route") throw new Error("Expected explicit broadcast");
    expect(explicit.value.requiredResponderSeatIds).toEqual(["seat-implementer", "seat-verifier-2"]);
  });

  it("breaks only an unchanged semantic loop and proposes a controller help request", () => {
    const protocol = getRoomProtocolDefinition("implementation", 1);
    if (!protocol) throw new Error("Missing built-in implementation protocol");
    const seats = [
      { seatId: "seat-reviewer", bindingId: "binding-reviewer-2", roleId: "implementation_verifier", groupIds: ["reviewers"] },
      { seatId: "seat-implementer", bindingId: "binding-implementer-1", roleId: "implementer", groupIds: ["implementers"] },
    ];
    const message = validMessage();
    const equivalentHistory = [{
      messageId: "message-prior",
      sequence: 1,
      nodeId: message.nodeId,
      intent: message.intent,
      semanticLoopFingerprint: buildRoomSemanticLoopFingerprint(message),
      semanticHash: message.semanticHash,
      evidenceStateHash: message.evidenceStateHash,
      decisionStateHash: message.decisionStateHash,
    }];

    const broken = routeRoomSemanticMessage({ message, protocol, seats, history: equivalentHistory, authoritativeState: authoritativeState(message) });
    expect(broken.ok).toBe(true);
    if (!broken.ok) throw new Error("Expected loop-break result");
    expect(broken.value).toMatchObject({
      outcome: "loop_break",
      escalation: {
        intent: "help_request",
        target: { kind: "controller" },
        parentMessageId: message.messageId,
        reasonCode: "semantic_loop",
      },
      audit: { repeatedSemanticCount: 2, recipientCount: 1, requiredResponderCount: 1 },
    });
    expect(Object.isFrozen(broken.value)).toBe(true);

    const distinctContent = {
      ...message,
      messageId: "message-new-evidence",
      content: "The retry bound is two because the evidence log now contains a third failure.",
      contentHash: hash("The retry bound is two because the evidence log now contains a third failure."),
    };
    const distinct = routeRoomSemanticMessage({
      message: distinctContent,
      protocol,
      seats,
      history: equivalentHistory,
      authoritativeState: authoritativeState(distinctContent),
    });
    expect(distinct.ok && distinct.value.outcome).toBe("route");
    expect(distinct.ok ? distinct.value.audit.repeatedSemanticCount : null).toBe(1);

    for (const changedHistory of [
      [{ ...equivalentHistory[0]!, evidenceStateHash: hash("evidence-state-2") }],
      [{ ...equivalentHistory[0]!, decisionStateHash: hash("decision-state-2") }],
      [{ ...equivalentHistory[0]!, nodeId: "node-other" }],
    ]) {
      const routed = routeRoomSemanticMessage({ message, protocol, seats, history: changedHistory, authoritativeState: authoritativeState(message) });
      expect(routed.ok).toBe(true);
      if (!routed.ok) throw new Error("Expected changed state to route");
      expect(routed.value.outcome).toBe("route");
      expect(routed.value.audit.repeatedSemanticCount).toBe(1);
    }
    const changedThenReturned = [
      equivalentHistory[0]!,
      {
        ...equivalentHistory[0]!,
        messageId: "message-state-changed",
        sequence: 2,
        evidenceStateHash: hash("evidence-state-2"),
      },
    ];
    const resumed = routeRoomSemanticMessage({
      message,
      protocol,
      seats,
      history: changedThenReturned,
      authoritativeState: authoritativeState(message),
    });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error("Expected changed sequence to reset loop count");
    expect(resumed.value.outcome).toBe("route");
    expect(resumed.value.audit.repeatedSemanticCount).toBe(1);

    for (const interruption of [
      { nodeId: "node-other" },
      { intent: "critique" },
    ]) {
      const interrupted = routeRoomSemanticMessage({
        message,
        protocol,
        seats,
        history: [
          equivalentHistory[0]!,
          {
            ...equivalentHistory[0]!,
            ...interruption,
            messageId: `message-interruption-${Object.keys(interruption)[0]}`,
            sequence: 2,
          },
        ],
        authoritativeState: authoritativeState(message),
      });
      expect(interrupted.ok).toBe(true);
      if (!interrupted.ok) throw new Error("Expected unrelated history to interrupt the semantic run");
      expect(interrupted.value.outcome).toBe("route");
      expect(interrupted.value.audit.repeatedSemanticCount).toBe(1);
    }
  });

  it("fails closed on malformed routing seats, history, bounds, and top-level runtime input", () => {
    const protocol = getRoomProtocolDefinition("implementation", 1);
    if (!protocol) throw new Error("Missing built-in implementation protocol");
    const validSeat = { seatId: "seat-reviewer", bindingId: "binding-reviewer-2", roleId: "implementation_verifier", groupIds: ["reviewers"] };
    const sparseSeats = new Array(1);
    const throwingHistory = new Proxy([], { ownKeys() { throw new Error("hostile"); } });
    const transparentSeat = new Proxy(validSeat, {});
    const transparentInput = new Proxy({
      message: validMessage(),
      protocol,
      seats: [validSeat],
      history: [],
      authoritativeState: authoritativeState(),
    }, {});
    const invalidInputs = [
      null,
      transparentInput,
      { message: validMessage(), protocol, seats: sparseSeats, history: [], authoritativeState: authoritativeState() },
      { message: validMessage(), protocol, seats: [transparentSeat], history: [], authoritativeState: authoritativeState() },
      { message: validMessage(), protocol, seats: [validSeat, { ...validSeat }], history: [], authoritativeState: authoritativeState() },
      { message: validMessage(), protocol, seats: [validSeat], history: throwingHistory, authoritativeState: authoritativeState() },
      { message: validMessage(), protocol, seats: [validSeat], history: [], authoritativeState: authoritativeState(), semanticRepeatLimit: 1 },
      { message: validMessage(), protocol, seats: Array.from({ length: 257 }, (_, index) => ({ ...validSeat, seatId: `seat-${index}`, bindingId: `binding-${index}` })), history: [], authoritativeState: authoritativeState() },
    ];
    for (const input of invalidInputs) {
      expect(routeRoomSemanticMessage(input as never)).toMatchObject({
        ok: false,
        issues: [expect.objectContaining({ code: "invalid_routing_input" })],
      });
    }
  });
});

import { describe, expect, it } from "vitest";

import type {
  AssignRoomRolesInputV1,
  RoomCapabilitySnapshotInputV1,
  RoomCapabilitySnapshotV1,
  RoomRoleAssignmentV1,
} from "../room-contracts/assignment.js";
import type { RoomProtocolDefinitionV1 } from "../room-contracts/protocol.js";
import {
  assignRoomRoles,
  createRoomCapabilitySnapshot,
  transitionRoomRoleAssignment,
  validateRoomRoleAssignment,
} from "../room-role-assignment.js";

function protocolFixture(): RoomProtocolDefinitionV1 {
  return {
    contractVersion: 1,
    id: "assignment-policy",
    version: 1,
    family: "implementation",
    name: "Assignment policy fixture",
    phases: [
      {
        id: "produce",
        roleIds: ["producer"],
        entryGateIds: [],
        exitGateIds: ["candidate_ready"],
        timeoutMs: 60_000,
      },
      {
        id: "verify",
        roleIds: ["verifier"],
        entryGateIds: ["candidate_ready"],
        exitGateIds: ["accepted"],
        timeoutMs: 60_000,
      },
    ],
    roles: [
      {
        id: "producer",
        requiredCapabilities: ["workspace_write"],
        mayProduce: true,
        mayVerify: false,
        mayAccept: false,
      },
      {
        id: "verifier",
        requiredCapabilities: ["test", "source_read"],
        mayProduce: false,
        mayVerify: true,
        mayAccept: true,
      },
    ],
    channels: [],
    contextPacks: [],
    transitions: [
      { fromPhaseId: "produce", toPhaseId: "verify", whenGateId: "candidate_ready" },
    ],
    gates: [
      { id: "candidate_ready", kind: "evidence", hard: true },
      {
        id: "accepted",
        kind: "deterministic",
        hard: true,
        evaluatorRoleIds: ["verifier"],
      },
    ],
    recoveryActions: [],
    exitConditions: [],
  };
}

function snapshotFixture(
  bindings: RoomCapabilitySnapshotV1["bindings"],
  revision = 1,
): RoomCapabilitySnapshotV1 {
  const result = createRoomCapabilitySnapshot({
    contractVersion: 1,
    snapshotId: "snapshot-1",
    revision,
    capturedAt: `2026-07-18T04:3${revision}:00.000Z`,
    bindings,
  });
  if (!result.ok) throw new Error("Invalid capability snapshot fixture");
  return result.value;
}

describe("Room role assignment policy", () => {
  it("normalizes and deeply freezes capability snapshots", () => {
    const input = {
      contractVersion: 1 as const,
      snapshotId: "snapshot-1",
      revision: 1,
      capturedAt: "2026-07-18T04:30:00.000Z",
      bindings: [
        {
          bindingId: "binding-b",
          availability: "eligible" as const,
          capabilityRevision: "b-1",
          capabilities: [
            { name: "workspace_write", state: "verified" as const },
            { name: "source_read", state: "verified" as const },
          ],
        },
        {
          bindingId: "binding-a",
          availability: "eligible" as const,
          capabilityRevision: "a-1",
          capabilities: [
            { name: "test", state: "verified" as const },
          ],
        },
      ],
    };

    const result = createRoomCapabilitySnapshot(input);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected a valid capability snapshot");
    expect(result.value.bindings.map((binding) => binding.bindingId)).toEqual([
      "binding-a",
      "binding-b",
    ]);
    expect(result.value.bindings[1]?.capabilities.map((capability) => capability.name)).toEqual([
      "source_read",
      "workspace_write",
    ]);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.bindings)).toBe(true);
    expect(Object.isFrozen(result.value.bindings[0]?.capabilities)).toBe(true);

    input.bindings[0]!.capabilities[0]!.name = "mutated";
    expect(result.value.bindings[1]?.capabilities[1]?.name).toBe("workspace_write");
    expect(() =>
      (result.value.bindings as unknown as unknown[]).push(result.value.bindings[0]),
    ).toThrow(TypeError);
  });

  it("hard-rejects a role when every binding lacks a required verified capability", () => {
    const result = assignRoomRoles({
      protocol: protocolFixture(),
      phaseId: "produce",
      capabilitySnapshot: snapshotFixture([
        {
          bindingId: "binding-a",
          availability: "eligible",
          capabilityRevision: "a-1",
          capabilities: [{ name: "source_read", state: "verified" }],
        },
      ]),
      constraints: { locks: [], forbids: [] },
      producerBindingIds: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected missing capability rejection");
    expect(result.unsatisfied).toContainEqual(
      expect.objectContaining({
        code: "missing_capability",
        roleId: "producer",
        capability: "workspace_write",
      }),
    );
  });

  it("returns typed unsatisfied when a user lock conflicts with a forbid", () => {
    const result = assignRoomRoles({
      protocol: protocolFixture(),
      phaseId: "produce",
      capabilitySnapshot: snapshotFixture([
        {
          bindingId: "binding-a",
          availability: "eligible",
          capabilityRevision: "a-1",
          capabilities: [{ name: "workspace_write", state: "verified" }],
        },
      ]),
      constraints: {
        locks: [{ roleId: "producer", bindingId: "binding-a" }],
        forbids: [{ roleId: "producer", bindingId: "binding-a" }],
      },
      producerBindingIds: [],
    });

    expect(result).toEqual({
      ok: false,
      unsatisfied: [
        expect.objectContaining({
          code: "lock_forbid_conflict",
          roleId: "producer",
          bindingId: "binding-a",
        }),
      ],
    });
  });

  it("honors user locks and forbids before automatic selection", () => {
    const snapshot = snapshotFixture(
      ["binding-a", "binding-b"].map((bindingId) => ({
        bindingId,
        availability: "eligible" as const,
        capabilityRevision: `${bindingId}-1`,
        capabilities: [{ name: "workspace_write", state: "verified" as const }],
      })),
    );

    const result = assignRoomRoles({
      protocol: protocolFixture(),
      phaseId: "produce",
      capabilitySnapshot: snapshot,
      constraints: {
        locks: [{ roleId: "producer", bindingId: "binding-b" }],
        forbids: [{ roleId: "producer", bindingId: "binding-a" }],
      },
      producerBindingIds: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected locked assignment to succeed");
    expect(result.value.assignments).toEqual([
      {
        roleId: "producer",
        bindingIds: ["binding-b"],
        requiredCapabilities: ["workspace_write"],
      },
    ]);
  });

  it("invalidates an old assignment when a refreshed snapshot loses a capability", () => {
    const initialSnapshot = snapshotFixture([
      {
        bindingId: "binding-a",
        availability: "eligible",
        capabilityRevision: "a-1",
        capabilities: [{ name: "workspace_write", state: "verified" }],
      },
    ]);
    const assigned = assignRoomRoles({
      protocol: protocolFixture(),
      phaseId: "produce",
      capabilitySnapshot: initialSnapshot,
      constraints: { locks: [], forbids: [] },
      producerBindingIds: [],
    });
    if (!assigned.ok) throw new Error("Expected initial assignment to succeed");

    const refreshedSnapshot = snapshotFixture(
      [
        {
          bindingId: "binding-a",
          availability: "eligible",
          capabilityRevision: "a-2",
          capabilities: [{ name: "workspace_write", state: "unavailable" }],
        },
      ],
      2,
    );
    const validation = validateRoomRoleAssignment({
      protocol: protocolFixture(),
      assignment: assigned.value,
      capabilitySnapshot: refreshedSnapshot,
    });

    expect(validation.ok).toBe(false);
    if (validation.ok) throw new Error("Expected refreshed capability validation to fail");
    expect(validation.unsatisfied.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["capability_snapshot_changed", "missing_capability"]),
    );
    expect(validation.unsatisfied).toContainEqual(
      expect.objectContaining({
        code: "missing_capability",
        roleId: "producer",
        bindingId: "binding-a",
        capability: "workspace_write",
      }),
    );
  });

  it("changes phase only through a declared gate at a turn boundary", () => {
    const protocol = protocolFixture();
    const snapshot = snapshotFixture([
      {
        bindingId: "binding-a",
        availability: "eligible",
        capabilityRevision: "a-1",
        capabilities: [{ name: "workspace_write", state: "verified" }],
      },
      {
        bindingId: "binding-b",
        availability: "eligible",
        capabilityRevision: "b-1",
        capabilities: [
          { name: "source_read", state: "verified" },
          { name: "test", state: "verified" },
        ],
      },
    ]);
    const current = assignRoomRoles({
      protocol,
      phaseId: "produce",
      capabilitySnapshot: snapshot,
      constraints: { locks: [], forbids: [] },
      producerBindingIds: [],
    });
    if (!current.ok) throw new Error("Expected producer assignment");
    const baseInput = {
      protocol,
      currentAssignment: current.value,
      targetPhaseId: "verify",
      verifiedTransitionGateId: "candidate_ready",
      atTurnBoundary: true,
      capabilitySnapshot: snapshot,
      constraints: { locks: [], forbids: [] },
    } as const;

    expect(
      transitionRoomRoleAssignment({ ...baseInput, atTurnBoundary: false }),
    ).toEqual({
      ok: false,
      unsatisfied: [expect.objectContaining({ code: "turn_boundary_required" })],
    });
    expect(
      transitionRoomRoleAssignment({ ...baseInput, verifiedTransitionGateId: "wrong_gate" }),
    ).toEqual({
      ok: false,
      unsatisfied: [expect.objectContaining({ code: "transition_gate_unsatisfied" })],
    });
    expect(
      transitionRoomRoleAssignment({ ...baseInput, targetPhaseId: "produce" }),
    ).toEqual({
      ok: false,
      unsatisfied: [expect.objectContaining({ code: "transition_not_declared" })],
    });

    const transitioned = transitionRoomRoleAssignment(baseInput);
    expect(transitioned.ok).toBe(true);
    if (!transitioned.ok) throw new Error("Expected legal phase transition");
    expect(transitioned.value).toMatchObject({
      phaseId: "verify",
      assignments: [{ roleId: "verifier", bindingIds: ["binding-b"] }],
      producerBindingIds: ["binding-a"],
    });
    expect(Object.isFrozen(transitioned.value.assignments[0]?.bindingIds)).toBe(true);
  });

  it("rejects a producing binding as the sole verifier and accepter of its own work", () => {
    const protocol = protocolFixture();
    const snapshot = snapshotFixture([
      {
        bindingId: "binding-a",
        availability: "eligible",
        capabilityRevision: "a-1",
        capabilities: [
          { name: "source_read", state: "verified" },
          { name: "test", state: "verified" },
          { name: "workspace_write", state: "verified" },
        ],
      },
    ]);
    const current = assignRoomRoles({
      protocol,
      phaseId: "produce",
      capabilitySnapshot: snapshot,
      constraints: { locks: [], forbids: [] },
      producerBindingIds: [],
    });
    if (!current.ok) throw new Error("Expected producer assignment");

    const transitioned = transitionRoomRoleAssignment({
      protocol,
      currentAssignment: current.value,
      targetPhaseId: "verify",
      verifiedTransitionGateId: "candidate_ready",
      atTurnBoundary: true,
      capabilitySnapshot: snapshot,
      constraints: { locks: [], forbids: [] },
    });

    expect(transitioned.ok).toBe(false);
    if (transitioned.ok) throw new Error("Expected separation-of-duty rejection");
    expect(transitioned.unsatisfied.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "independent_verifier_required",
        "independent_accepter_required",
      ]),
    );
    expect(transitioned.unsatisfied).toContainEqual(
      expect.objectContaining({
        code: "independent_verifier_required",
        roleId: "verifier",
        bindingId: "binding-a",
      }),
    );
  });

  it("counts distinct producer bindings rather than producer role occurrences", () => {
    const base = protocolFixture();
    const protocol: RoomProtocolDefinitionV1 = {
      ...base,
      phases: [
        { ...base.phases[0]!, roleIds: ["producer", "alternate_producer"] },
        base.phases[1]!,
      ],
      roles: [
        base.roles[0]!,
        {
          id: "alternate_producer",
          requiredCapabilities: ["workspace_write"],
          mayProduce: true,
          mayVerify: false,
          mayAccept: false,
        },
        base.roles[1]!,
      ],
      gates: [
        {
          ...base.gates[0]!,
          provenanceKind: "candidate",
          minimumDistinctProducerBindings: 2,
        },
        base.gates[1]!,
      ],
    };
    const binding = (bindingId: string) => ({
      bindingId,
      availability: "eligible" as const,
      capabilityRevision: `${bindingId}-1`,
      capabilities: [{ name: "workspace_write", state: "verified" as const }],
    });

    const oneBinding = assignRoomRoles({
      protocol,
      phaseId: "produce",
      capabilitySnapshot: snapshotFixture([binding("binding-a")]),
      constraints: { locks: [], forbids: [] },
      producerBindingIds: [],
    });
    expect(oneBinding).toEqual({
      ok: false,
      unsatisfied: [
        expect.objectContaining({
          code: "minimum_distinct_producer_bindings_unsatisfied",
        }),
      ],
    });

    const twoBindings = assignRoomRoles({
      protocol,
      phaseId: "produce",
      capabilitySnapshot: snapshotFixture([
        binding("binding-b"),
        binding("binding-a"),
      ]),
      constraints: { locks: [], forbids: [] },
      producerBindingIds: [],
    });
    expect(twoBindings.ok).toBe(true);
    if (!twoBindings.ok) throw new Error("Expected two distinct producers");
    expect(twoBindings.value.producerBindingIds).toEqual(["binding-a", "binding-b"]);
    expect(
      new Set(
        twoBindings.value.assignments
          .filter((assignment) => assignment.roleId.includes("producer"))
          .flatMap((assignment) => assignment.bindingIds),
      ).size,
    ).toBe(2);
  });

  it("uses a stable independent-binding tie-break and replays identically", () => {
    const protocol = protocolFixture();
    const bindings = [
      {
        bindingId: "binding-c",
        availability: "eligible" as const,
        capabilityRevision: "c-1",
        capabilities: [
          { name: "source_read", state: "verified" as const },
          { name: "test", state: "verified" as const },
        ],
      },
      {
        bindingId: "binding-a",
        availability: "eligible" as const,
        capabilityRevision: "a-1",
        capabilities: [
          { name: "source_read", state: "verified" as const },
          { name: "test", state: "verified" as const },
          { name: "workspace_write", state: "verified" as const },
        ],
      },
      {
        bindingId: "binding-b",
        availability: "eligible" as const,
        capabilityRevision: "b-1",
        capabilities: [
          { name: "source_read", state: "verified" as const },
          { name: "test", state: "verified" as const },
        ],
      },
    ];
    const replay = (orderedBindings: typeof bindings) => {
      const snapshot = snapshotFixture(orderedBindings);
      const current = assignRoomRoles({
        protocol,
        phaseId: "produce",
        capabilitySnapshot: snapshot,
        constraints: { locks: [], forbids: [] },
        producerBindingIds: [],
      });
      if (!current.ok) throw new Error("Expected replay producer assignment");
      return transitionRoomRoleAssignment({
        protocol,
        currentAssignment: current.value,
        targetPhaseId: "verify",
        verifiedTransitionGateId: "candidate_ready",
        atTurnBoundary: true,
        capabilitySnapshot: snapshot,
        constraints: { locks: [], forbids: [] },
      });
    };

    const first = replay(bindings);
    const second = replay([...bindings].reverse());

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("Expected deterministic replay");
    expect(first.value.assignments).toEqual([
      {
        roleId: "verifier",
        bindingIds: ["binding-b"],
        requiredCapabilities: ["source_read", "test"],
      },
    ]);
    expect(second.value).toEqual(first.value);
    expect(Object.isFrozen(first.value)).toBe(true);
  });

  it("selects producers before independent reviewers regardless of phase role order", () => {
    const base = protocolFixture();
    const protocol: RoomProtocolDefinitionV1 = {
      ...base,
      phases: [
        { ...base.phases[0]!, roleIds: ["verifier", "producer"] },
        base.phases[1]!,
      ],
    };
    const result = assignRoomRoles({
      protocol,
      phaseId: "produce",
      capabilitySnapshot: snapshotFixture([
        {
          bindingId: "binding-a",
          availability: "eligible",
          capabilityRevision: "a-1",
          capabilities: [
            { name: "source_read", state: "verified" },
            { name: "test", state: "verified" },
            { name: "workspace_write", state: "verified" },
          ],
        },
        {
          bindingId: "binding-b",
          availability: "eligible",
          capabilityRevision: "b-1",
          capabilities: [
            { name: "source_read", state: "verified" },
            { name: "test", state: "verified" },
          ],
        },
      ]),
      constraints: { locks: [], forbids: [] },
      producerBindingIds: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected satisfiable same-phase separation");
    expect(result.value.assignments).toEqual([
      {
        roleId: "verifier",
        bindingIds: ["binding-b"],
        requiredCapabilities: ["source_read", "test"],
      },
      {
        roleId: "producer",
        bindingIds: ["binding-a"],
        requiredCapabilities: ["workspace_write"],
      },
    ]);
  });

  it("fails closed on malformed runtime protocol, snapshot, and constraint JSON", () => {
    expect(assignRoomRoles(null as unknown as AssignRoomRolesInputV1)).toMatchObject({
      ok: false,
      unsatisfied: [expect.objectContaining({ code: "assignment_contract_mismatch" })],
    });
    expect(assignRoomRoles({
      protocol: null,
      phaseId: "produce",
      capabilitySnapshot: null,
      constraints: { locks: [], forbids: [] },
      producerBindingIds: [],
    } as unknown as AssignRoomRolesInputV1)).toMatchObject({
      ok: false,
      unsatisfied: [expect.objectContaining({ code: "assignment_contract_mismatch" })],
    });
    expect(createRoomCapabilitySnapshot({
      contractVersion: 1,
      snapshotId: "malformed",
      revision: 1,
      capturedAt: "2026-07-18T04:30:00.000Z",
      bindings: [null],
    } as unknown as RoomCapabilitySnapshotInputV1)).toMatchObject({
      ok: false,
      unsatisfied: [expect.objectContaining({ code: "invalid_capability_snapshot" })],
    });

    const missingGateKind = structuredClone(protocolFixture()) as unknown as {
      gates: Array<Record<string, unknown>>;
    };
    delete missingGateKind.gates[0]!.kind;
    expect(assignRoomRoles({
      protocol: missingGateKind,
      phaseId: "produce",
      capabilitySnapshot: snapshotFixture([]),
      constraints: { locks: [], forbids: [] },
      producerBindingIds: [],
    } as unknown as AssignRoomRolesInputV1)).toMatchObject({
      ok: false,
      unsatisfied: [expect.objectContaining({ code: "assignment_contract_mismatch" })],
    });

    const undeclaredPhaseGate = structuredClone(protocolFixture()) as unknown as {
      phases: Array<{ exitGateIds: string[] }>;
    };
    undeclaredPhaseGate.phases[0]!.exitGateIds = ["missing_gate"];
    expect(assignRoomRoles({
      protocol: undeclaredPhaseGate,
      phaseId: "produce",
      capabilitySnapshot: snapshotFixture([]),
      constraints: { locks: [], forbids: [] },
      producerBindingIds: [],
    } as unknown as AssignRoomRolesInputV1)).toMatchObject({
      ok: false,
      unsatisfied: [expect.objectContaining({ code: "assignment_contract_mismatch" })],
    });
  });

  it("rejects forged assignments and returns an immutable clone without freezing caller input", () => {
    const protocol = protocolFixture();
    const snapshot = snapshotFixture([{
      bindingId: "binding-a",
      availability: "eligible",
      capabilityRevision: "a-1",
      capabilities: [
        { name: "source_read", state: "verified" },
        { name: "test", state: "verified" },
        { name: "workspace_write", state: "verified" },
      ],
    }, {
      bindingId: "binding-b",
      availability: "eligible",
      capabilityRevision: "b-1",
      capabilities: [
        { name: "source_read", state: "verified" },
        { name: "test", state: "verified" },
      ],
    }]);
    const assigned = assignRoomRoles({
      protocol,
      phaseId: "produce",
      capabilitySnapshot: snapshot,
      constraints: { locks: [], forbids: [] },
      producerBindingIds: [],
    });
    if (!assigned.ok) throw new Error("Expected valid producer assignment");
    const callerOwned = structuredClone(assigned.value);
    const validated = validateRoomRoleAssignment({ protocol, assignment: callerOwned, capabilitySnapshot: snapshot });
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error("Expected valid assignment clone");
    expect(validated.value).not.toBe(callerOwned);
    expect(Object.isFrozen(validated.value)).toBe(true);
    expect(Object.isFrozen(callerOwned)).toBe(false);
    expect(Object.isFrozen(callerOwned.assignments[0]!)).toBe(false);

    const forged = {
      ...structuredClone(assigned.value),
      assignments: [],
      producerBindingIds: ["binding-a", "binding-a"],
    } as unknown as RoomRoleAssignmentV1;
    expect(validateRoomRoleAssignment({ protocol, assignment: forged, capabilitySnapshot: snapshot })).toMatchObject({
      ok: false,
      unsatisfied: expect.arrayContaining([
        expect.objectContaining({ code: "assignment_contract_mismatch" }),
      ]),
    });

    const transitioned = transitionRoomRoleAssignment({
      protocol,
      currentAssignment: assigned.value,
      targetPhaseId: "verify",
      verifiedTransitionGateId: "candidate_ready",
      atTurnBoundary: true,
      capabilitySnapshot: snapshot,
      constraints: { locks: [], forbids: [] },
    });
    if (!transitioned.ok) throw new Error("Expected valid verifier transition");
    const erasedLineage = {
      ...structuredClone(transitioned.value),
      producerBindingIds: [],
    } as RoomRoleAssignmentV1;
    expect(validateRoomRoleAssignment({
      protocol,
      assignment: erasedLineage,
      capabilitySnapshot: snapshot,
      authoritativeProducerBindingIds: ["binding-a"],
    })).toMatchObject({
      ok: false,
      unsatisfied: expect.arrayContaining([
        expect.objectContaining({ code: "assignment_contract_mismatch" }),
      ]),
    });

    const substitutedLineage = {
      ...structuredClone(transitioned.value),
      assignments: [{
        roleId: "verifier",
        bindingIds: ["binding-a"],
        requiredCapabilities: ["source_read", "test"],
      }],
      producerBindingIds: ["binding-b"],
    } as RoomRoleAssignmentV1;
    expect(validateRoomRoleAssignment({
      protocol,
      assignment: substitutedLineage,
      capabilitySnapshot: snapshot,
      authoritativeProducerBindingIds: ["binding-a"],
    })).toMatchObject({
      ok: false,
      unsatisfied: expect.arrayContaining([
        expect.objectContaining({ code: "assignment_contract_mismatch" }),
        expect.objectContaining({ code: "independent_verifier_required" }),
      ]),
    });
  });

  it("invalidates assignment when a binding capability revision changes without an aggregate revision bump", () => {
    const protocol = protocolFixture();
    const binding = (capabilityRevision: string) => ({
      bindingId: "binding-a",
      availability: "eligible" as const,
      capabilityRevision,
      capabilities: [{ name: "workspace_write", state: "verified" as const }],
    });
    const firstSnapshot = snapshotFixture([binding("a-1")], 1);
    const assigned = assignRoomRoles({
      protocol,
      phaseId: "produce",
      capabilitySnapshot: firstSnapshot,
      constraints: { locks: [], forbids: [] },
      producerBindingIds: [],
    });
    if (!assigned.ok) throw new Error("Expected initial assignment");
    const changedSnapshot = snapshotFixture([binding("a-2")], 1);

    expect(validateRoomRoleAssignment({
      protocol,
      assignment: assigned.value,
      capabilitySnapshot: changedSnapshot,
    })).toMatchObject({
      ok: false,
      unsatisfied: [expect.objectContaining({ code: "capability_snapshot_changed" })],
    });
  });

  it("rejects producer overlap even when a verifier panel also contains an independent binding", () => {
    const base = protocolFixture();
    const protocol: RoomProtocolDefinitionV1 = {
      ...base,
      phases: [{ ...base.phases[0]!, roleIds: ["producer", "verifier"] }, base.phases[1]!],
    };
    const snapshot = snapshotFixture([
      {
        bindingId: "binding-a",
        availability: "eligible",
        capabilityRevision: "a-1",
        capabilities: [
          { name: "workspace_write", state: "verified" },
          { name: "source_read", state: "verified" },
          { name: "test", state: "verified" },
        ],
      },
      {
        bindingId: "binding-b",
        availability: "eligible",
        capabilityRevision: "b-1",
        capabilities: [
          { name: "source_read", state: "verified" },
          { name: "test", state: "verified" },
        ],
      },
    ]);

    expect(assignRoomRoles({
      protocol,
      phaseId: "produce",
      capabilitySnapshot: snapshot,
      constraints: {
        locks: [
          { roleId: "verifier", bindingId: "binding-a" },
          { roleId: "verifier", bindingId: "binding-b" },
        ],
        forbids: [],
      },
      producerBindingIds: [],
    })).toMatchObject({
      ok: false,
      unsatisfied: expect.arrayContaining([expect.objectContaining({
        code: "independent_verifier_required",
        bindingId: "binding-a",
      })]),
    });
  });

  it("forbids direct assignment into a non-entry phase", () => {
    const protocol = protocolFixture();
    const snapshot = snapshotFixture([{
      bindingId: "binding-b",
      availability: "eligible",
      capabilityRevision: "b-1",
      capabilities: [
        { name: "source_read", state: "verified" },
        { name: "test", state: "verified" },
      ],
    }]);
    expect(assignRoomRoles({
      protocol,
      phaseId: "verify",
      capabilitySnapshot: snapshot,
      constraints: { locks: [], forbids: [] },
      producerBindingIds: [],
    })).toMatchObject({
      ok: false,
      unsatisfied: [expect.objectContaining({ code: "direct_phase_assignment_forbidden" })],
    });
  });
});

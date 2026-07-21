import { describe, expect, it } from "vitest";

import * as protocolContract from "../room-protocol-schema.js";
import type { RoomProtocolDefinitionV1 } from "../room-contracts/protocol.js";

type ProtocolValidationIssue = {
  readonly code: string;
  readonly path: string;
  readonly message: string;
};

type ProtocolValidationResult =
  | { readonly ok: true; readonly value: RoomProtocolDefinitionV1 }
  | { readonly ok: false; readonly issues: readonly ProtocolValidationIssue[] };

type RoomProtocolMigrationPlanV1 = {
  readonly contractVersion: 1;
  readonly protocolId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly activateAt: "next_turn_boundary";
  readonly currentPhaseId: string;
  readonly phaseIdMap: Readonly<Record<string, string>>;
  readonly roleIdMap: Readonly<Record<string, string>>;
};

type ProtocolMigrationValidationResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly protocolId: string;
        readonly fromVersion: number;
        readonly toVersion: number;
        readonly nextPhaseId: string;
      };
    }
  | { readonly ok: false; readonly issues: readonly ProtocolValidationIssue[] };

type ProtocolSchemaRuntime = {
  validateRoomProtocolDefinition(input: unknown): ProtocolValidationResult;
  validateRoomProtocolMigration(input: {
    readonly fromProtocol: unknown;
    readonly toProtocol: unknown;
    readonly migration: unknown;
  }): ProtocolMigrationValidationResult;
};

const protocolSchemaRuntime = protocolContract as unknown as Partial<ProtocolSchemaRuntime>;

function requireProtocolValidator(): ProtocolSchemaRuntime["validateRoomProtocolDefinition"] {
  expect(
    protocolSchemaRuntime.validateRoomProtocolDefinition,
    "Task 5.3 requires a production runtime validator; TypeScript-only Room protocol contracts are not validation",
  ).toBeTypeOf("function");
  return protocolSchemaRuntime.validateRoomProtocolDefinition as ProtocolSchemaRuntime["validateRoomProtocolDefinition"];
}

function requireProtocolMigrationValidator(): ProtocolSchemaRuntime["validateRoomProtocolMigration"] {
  expect(
    protocolSchemaRuntime.validateRoomProtocolMigration,
    "Task 5.3 requires a production compatibility validator for turn-boundary protocol migration",
  ).toBeTypeOf("function");
  return protocolSchemaRuntime.validateRoomProtocolMigration as ProtocolSchemaRuntime["validateRoomProtocolMigration"];
}

/*
FNXC:SessionRoomProtocolSchema 2026-07-17-21:47:
Room protocols are persisted declarative state machines, so runtime input must be strictly versioned and graph-validated before a controller can execute or migrate it. Compile-time interfaces alone cannot protect stored JSON, API payloads, or promoted evolution candidates.
*/
function validProtocol(overrides: Partial<RoomProtocolDefinitionV1> = {}): RoomProtocolDefinitionV1 {
  return {
    contractVersion: 1,
    id: "implementation-review",
    version: 1,
    family: "implementation",
    name: "Independent implementation and review",
    phases: [
      {
        id: "produce",
        roleIds: ["producer"],
        entryGateIds: ["brief_ready"],
        exitGateIds: ["candidate_ready", "recovery_exhausted"],
        timeoutMs: 900_000,
        channelIds: ["work"],
        contextPackIds: ["authoritative"],
      },
      {
        id: "verify",
        roleIds: ["verifier"],
        entryGateIds: ["candidate_ready"],
        exitGateIds: ["hard_gates_passed", "recovery_exhausted"],
        timeoutMs: 600_000,
        channelIds: ["review"],
        contextPackIds: ["blind_review"],
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
    channels: [
      {
        id: "work",
        allowedIntents: ["proposal", "question", "handoff"],
        responderRoleIds: ["producer"],
        broadcastRequiresResponse: false,
      },
      {
        id: "review",
        allowedIntents: ["critique", "challenge", "verdict"],
        responderRoleIds: ["verifier"],
        broadcastRequiresResponse: false,
      },
    ],
    contextPacks: [
      {
        id: "authoritative",
        includeKinds: ["contract", "source"],
        excludeKinds: ["secret", "private_review"],
        maxItems: 128,
      },
      {
        id: "blind_review",
        includeKinds: ["candidate", "evidence"],
        excludeKinds: ["producer_identity", "private_peer_review", "secret"],
        maxItems: 64,
      },
    ],
    transitions: [
      {
        fromPhaseId: "produce",
        toPhaseId: "verify",
        whenGateId: "candidate_ready",
      },
    ],
    gates: [
      { id: "brief_ready", kind: "deterministic", hard: true },
      { id: "candidate_ready", kind: "evidence", hard: true },
      {
        id: "hard_gates_passed",
        kind: "deterministic",
        hard: true,
        evaluatorRoleIds: ["verifier"],
        evidenceRequirements: ["test", "source"],
      },
      { id: "recovery_exhausted", kind: "deterministic", hard: true },
    ],
    recoveryActions: [
      {
        id: "retry_transient",
        trigger: "timeout",
        action: "retry",
        maxAttempts: 2,
        phaseIds: ["produce", "verify"],
        exhaustedGateId: "recovery_exhausted",
      },
      {
        id: "replace_stalled_producer",
        trigger: "no_progress",
        action: "replace_participant",
        maxAttempts: 1,
        phaseIds: ["produce", "verify"],
        exhaustedGateId: "recovery_exhausted",
      },
      {
        id: "escalate_failed_gate",
        trigger: "hard_gate_failed",
        action: "request_operator",
        maxAttempts: 1,
        phaseIds: ["produce", "verify"],
        exhaustedGateId: "recovery_exhausted",
      },
    ],
    exitConditions: [
      {
        outcome: "completed",
        requiredGateIds: ["hard_gates_passed"],
        requireIndependentVerifier: true,
      },
      {
        outcome: "blocked",
        requiredGateIds: ["recovery_exhausted"],
        requireIndependentVerifier: false,
      },
    ],
    ...overrides,
  };
}

function expectProtocolIssues(input: unknown, expectedCodes: readonly string[]): readonly ProtocolValidationIssue[] {
  const result = requireProtocolValidator()(input);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("Expected Room protocol validation to fail");
  }
  for (const code of expectedCodes) {
    expect(result.issues.map((issue) => issue.code)).toContain(code);
  }
  return result.issues;
}

function migrationFixture(): {
  readonly fromProtocol: RoomProtocolDefinitionV1;
  readonly toProtocol: RoomProtocolDefinitionV1;
  readonly migration: RoomProtocolMigrationPlanV1;
} {
  const fromProtocol = validProtocol();
  const toProtocol = validProtocol({
    version: 2,
    phases: [
      { ...fromProtocol.phases[0]!, id: "produce_v2" },
      { ...fromProtocol.phases[1]!, id: "verify_v2" },
    ],
    transitions: [
      {
        fromPhaseId: "produce_v2",
        toPhaseId: "verify_v2",
        whenGateId: "candidate_ready",
      },
    ],
    recoveryActions: fromProtocol.recoveryActions.map((recovery) => ({
      ...recovery,
      phaseIds: ["produce_v2", "verify_v2"],
    })),
  });
  return {
    fromProtocol,
    toProtocol,
    migration: {
      contractVersion: 1,
      protocolId: fromProtocol.id,
      fromVersion: 1,
      toVersion: 2,
      activateAt: "next_turn_boundary",
      currentPhaseId: "produce",
      phaseIdMap: { produce: "produce_v2", verify: "verify_v2" },
      roleIdMap: { producer: "producer", verifier: "verifier" },
    },
  };
}

describe("Room declarative protocol schema v1", () => {
  it("accepts a complete versioned protocol spanning every declarative surface", () => {
    const validate = requireProtocolValidator();

    expect(validate(validProtocol())).toEqual({
      ok: true,
      value: validProtocol(),
    });
  });

  it("rejects unknown contract versions instead of guessing a compatible shape", () => {
    expectProtocolIssues(
      {
        ...validProtocol(),
        contractVersion: 99,
      },
      ["unsupported_contract_version"],
    );
  });

  it("is strict at both top-level and nested objects", () => {
    const protocol = validProtocol();
    const issues = expectProtocolIssues(
      {
        ...protocol,
        undocumentedTopLevel: true,
        phases: [
          {
            ...protocol.phases[0],
            executableHook: "run arbitrary code",
          },
          protocol.phases[1],
        ],
      },
      ["unknown_field"],
    );

    expect(issues.some((issue) => issue.path.includes("undocumentedTopLevel"))).toBe(true);
    expect(issues.some((issue) => issue.path.includes("executableHook"))).toBe(true);
  });

  it("rejects sparse arrays at both aggregate and nested schema levels", () => {
    const protocol = validProtocol();
    const sparsePhases = [...protocol.phases];
    sparsePhases.length += 1;
    expectProtocolIssues({ ...protocol, phases: sparsePhases }, ["sparse_array"]);

    const sparseRoleIds = [...protocol.phases[0].roleIds];
    sparseRoleIds.length += 1;
    expectProtocolIssues(
      {
        ...protocol,
        phases: [
          { ...protocol.phases[0], roleIds: sparseRoleIds },
          protocol.phases[1],
        ],
      },
      ["sparse_array"],
    );
  });

  it("rejects non-enumerable unknown fields", () => {
    const protocol = validProtocol();
    Object.defineProperty(protocol, "hiddenExecutableHook", {
      configurable: true,
      enumerable: false,
      value: "run arbitrary code",
    });

    expectProtocolIssues(protocol, ["unknown_field"]);
  });

  it("rejects symbol-keyed unknown fields", () => {
    const protocol = validProtocol();
    Object.defineProperty(protocol, Symbol("hiddenExecutableHook"), {
      configurable: true,
      enumerable: true,
      value: "run arbitrary code",
    });

    expectProtocolIssues(protocol, ["unknown_field"]);
  });

  it("rejects hidden and symbol-keyed fields attached to schema arrays", () => {
    const protocol = validProtocol();
    const phasesWithHiddenField = [...protocol.phases];
    Object.defineProperty(phasesWithHiddenField, "hiddenExecutableHook", {
      configurable: true,
      enumerable: false,
      value: "run arbitrary code",
    });
    expectProtocolIssues(
      { ...protocol, phases: phasesWithHiddenField },
      ["unknown_field"],
    );

    const phasesWithSymbol = [...protocol.phases];
    Object.defineProperty(phasesWithSymbol, Symbol("hiddenExecutableHook"), {
      configurable: true,
      enumerable: true,
      value: "run arbitrary code",
    });
    expectProtocolIssues({ ...protocol, phases: phasesWithSymbol }, ["unknown_field"]);
  });

  it("fails closed for reflective proxy objects even when their visible shape is valid", () => {
    const protocol = new Proxy(validProtocol(), {});

    expectProtocolIssues(protocol, ["invalid_runtime_value"]);
  });

  it("rejects accessor-backed fields without executing their getters", () => {
    const protocol = validProtocol();
    let getterExecuted = false;
    Object.defineProperty(protocol, "name", {
      configurable: true,
      enumerable: true,
      get() {
        getterExecuted = true;
        return "Reflective protocol";
      },
    });

    expectProtocolIssues(protocol, ["invalid_runtime_value"]);
    expect(getterExecuted).toBe(false);
  });

  it("returns a normalized deeply frozen value that cannot drift after validation", () => {
    const protocol = validProtocol();
    const result = requireProtocolValidator()(protocol);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected valid protocol normalization to succeed");
    }
    expect(result.value).not.toBe(protocol);
    expect(result.value.phases).not.toBe(protocol.phases);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.phases)).toBe(true);
    expect(Object.isFrozen(result.value.phases[0])).toBe(true);
    expect(Object.isFrozen(result.value.phases[0].roleIds)).toBe(true);

    const normalizedPhases = result.value.phases as unknown as unknown[];
    expect(() => normalizedPhases.push(result.value.phases[0])).toThrow(TypeError);

    const originalRoleIds = protocol.phases[0].roleIds as unknown as string[];
    originalRoleIds.push("verifier");
    expect(result.value.phases[0].roleIds).toEqual(["producer"]);
  });

  it("rejects duplicate identifiers inside every declarative namespace", () => {
    const protocol = validProtocol();
    const duplicateCases: readonly unknown[] = [
      { ...protocol, phases: [protocol.phases[0], protocol.phases[0]] },
      { ...protocol, roles: [protocol.roles[0], protocol.roles[0]] },
      { ...protocol, channels: [protocol.channels[0], protocol.channels[0]] },
      { ...protocol, contextPacks: [protocol.contextPacks[0], protocol.contextPacks[0]] },
      { ...protocol, gates: [protocol.gates[0], protocol.gates[0]] },
      {
        ...protocol,
        recoveryActions: [protocol.recoveryActions[0], protocol.recoveryActions[0]],
      },
    ];

    for (const duplicate of duplicateCases) {
      expectProtocolIssues(duplicate, ["duplicate_id"]);
    }
  });

  it.each([
    {
      surface: "phase role",
      path: "roleIds",
      build: () => {
        const protocol = validProtocol();
        return {
          ...protocol,
          phases: [{ ...protocol.phases[0], roleIds: ["missing-role"] }, protocol.phases[1]],
        };
      },
    },
    {
      surface: "phase channel",
      path: "channelIds",
      build: () => {
        const protocol = validProtocol();
        return {
          ...protocol,
          phases: [{ ...protocol.phases[0], channelIds: ["missing-channel"] }, protocol.phases[1]],
        };
      },
    },
    {
      surface: "phase context pack",
      path: "contextPackIds",
      build: () => {
        const protocol = validProtocol();
        return {
          ...protocol,
          phases: [{ ...protocol.phases[0], contextPackIds: ["missing-context"] }, protocol.phases[1]],
        };
      },
    },
    {
      surface: "phase gate",
      path: "entryGateIds",
      build: () => {
        const protocol = validProtocol();
        return {
          ...protocol,
          phases: [{ ...protocol.phases[0], entryGateIds: ["missing-gate"] }, protocol.phases[1]],
        };
      },
    },
    {
      surface: "transition source phase",
      path: "fromPhaseId",
      build: () => {
        const protocol = validProtocol();
        return {
          ...protocol,
          transitions: [{ ...protocol.transitions[0], fromPhaseId: "missing-phase" }],
        };
      },
    },
    {
      surface: "transition destination phase",
      path: "toPhaseId",
      build: () => {
        const protocol = validProtocol();
        return {
          ...protocol,
          transitions: [{ ...protocol.transitions[0], toPhaseId: "missing-phase" }],
        };
      },
    },
    {
      surface: "transition gate",
      path: "whenGateId",
      build: () => {
        const protocol = validProtocol();
        return {
          ...protocol,
          transitions: [{ ...protocol.transitions[0], whenGateId: "missing-gate" }],
        };
      },
    },
    {
      surface: "channel responder role",
      path: "responderRoleIds",
      build: () => {
        const protocol = validProtocol();
        return {
          ...protocol,
          channels: [
            { ...protocol.channels[0], responderRoleIds: ["missing-role"] },
            protocol.channels[1],
          ],
        };
      },
    },
    {
      surface: "gate evaluator role",
      path: "evaluatorRoleIds",
      build: () => {
        const protocol = validProtocol();
        return {
          ...protocol,
          gates: [
            protocol.gates[0],
            protocol.gates[1],
            { ...protocol.gates[2], evaluatorRoleIds: ["missing-role"] },
          ],
        };
      },
    },
    {
      surface: "exit-condition gate",
      path: "requiredGateIds",
      build: () => {
        const protocol = validProtocol();
        return {
          ...protocol,
          exitConditions: [
            { ...protocol.exitConditions[0], requiredGateIds: ["missing-gate"] },
            protocol.exitConditions[1],
          ],
        };
      },
    },
  ])("rejects an illegal $surface reference", ({ path, build }) => {
    const issues = expectProtocolIssues(build(), ["invalid_reference"]);
    expect(
      issues.some((issue) => issue.code === "invalid_reference" && issue.path.includes(path)),
    ).toBe(true);
  });

  it("binds every transition gate to the source exit and target entry", () => {
    const protocol = validProtocol();

    expectProtocolIssues(
      {
        ...protocol,
        phases: [
          { ...protocol.phases[0], exitGateIds: ["brief_ready"] },
          protocol.phases[1],
        ],
      },
      ["transition_gate_not_source_exit"],
    );

    expectProtocolIssues(
      {
        ...protocol,
        phases: [
          protocol.phases[0],
          { ...protocol.phases[1], entryGateIds: ["brief_ready"] },
        ],
      },
      ["transition_gate_not_target_entry"],
    );
  });

  it("requires one deterministic target for each source phase and gate pair", () => {
    const protocol = validProtocol();
    const alternateVerify = {
      ...protocol.phases[1],
      id: "alternate_verify",
    };

    expectProtocolIssues(
      {
        ...protocol,
        phases: [...protocol.phases, alternateVerify],
        transitions: [
          protocol.transitions[0],
          {
            fromPhaseId: "produce",
            toPhaseId: "alternate_verify",
            whenGateId: "candidate_ready",
          },
        ],
      },
      ["ambiguous_transition"],
    );
  });

  it("rejects phases that cannot be reached from the declared first phase", () => {
    const protocol = validProtocol();
    expectProtocolIssues(
      {
        ...protocol,
        phases: [
          ...protocol.phases,
          {
            id: "orphan",
            roleIds: ["verifier"],
            entryGateIds: ["candidate_ready"],
            exitGateIds: ["hard_gates_passed"],
            timeoutMs: 60_000,
            channelIds: ["review"],
            contextPackIds: ["blind_review"],
          },
        ],
      },
      ["unreachable_phase"],
    );
  });

  it("rejects a cyclic protocol that has no reachable exit", () => {
    const protocol = validProtocol();
    expectProtocolIssues(
      {
        ...protocol,
        transitions: [
          protocol.transitions[0],
          {
            fromPhaseId: "verify",
            toPhaseId: "produce",
            whenGateId: "hard_gates_passed",
          },
        ],
        exitConditions: [],
      },
      ["cycle_without_exit", "missing_exit_condition"],
    );
  });

  it("requires a terminal phase to expose a gate-backed exit condition", () => {
    expectProtocolIssues(
      {
        ...validProtocol(),
        exitConditions: [],
      },
      ["missing_exit_condition"],
    );
  });

  it("rejects non-positive, non-integer, or non-finite phase timeouts", () => {
    const protocol = validProtocol();
    for (const timeoutMs of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      expectProtocolIssues(
        {
          ...protocol,
          phases: [{ ...protocol.phases[0], timeoutMs }, protocol.phases[1]],
        },
        ["invalid_timeout"],
      );
    }
  });

  it("requires bounded positive recovery attempts", () => {
    const protocol = validProtocol();
    for (const maxAttempts of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expectProtocolIssues(
        {
          ...protocol,
          recoveryActions: [
            { ...protocol.recoveryActions[0], maxAttempts },
            protocol.recoveryActions[1],
          ],
        },
        ["invalid_recovery_attempts"],
      );
    }
  });

  it("requires a non-producing independent verifier when an exit demands one", () => {
    const protocol = validProtocol();
    expectProtocolIssues(
      {
        ...protocol,
        roles: protocol.roles.map((role) => ({
          ...role,
          mayProduce: true,
        })),
      },
      ["independent_verifier_required"],
    );
  });

  it("requires the independent verifier to participate in the phase carrying its gate", () => {
    const protocol = validProtocol();

    expectProtocolIssues(
      {
        ...protocol,
        phases: [
          protocol.phases[0],
          { ...protocol.phases[1], roleIds: ["producer"] },
        ],
      },
      ["independent_verifier_required"],
    );
  });

  it("accepts an explicit forward migration at a turn boundary with complete phase and role mappings", () => {
    const validateMigration = requireProtocolMigrationValidator();
    const fixture = migrationFixture();

    expect(validateMigration(fixture)).toEqual({
      ok: true,
      value: {
        protocolId: "implementation-review",
        fromVersion: 1,
        toVersion: 2,
        nextPhaseId: "produce_v2",
      },
    });
  });

  it("preserves phase role membership across protocol migration mappings", () => {
    const validateMigration = requireProtocolMigrationValidator();
    const fixture = migrationFixture();
    const result = validateMigration({
      ...fixture,
      migration: {
        ...fixture.migration,
        roleIdMap: { producer: "verifier", verifier: "producer" },
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected incompatible phase/role membership to fail migration");
    }
    expect(result.issues.map((entry) => entry.code)).toContain(
      "phase_role_mapping_mismatch",
    );
  });

  it.each([
    {
      caseName: "different protocol identity",
      expectedCode: "protocol_identity_mismatch",
      mutate: (fixture: ReturnType<typeof migrationFixture>) => ({
        ...fixture,
        toProtocol: { ...fixture.toProtocol, id: "different-protocol" },
      }),
    },
    {
      caseName: "non-forward version",
      expectedCode: "non_forward_version",
      mutate: (fixture: ReturnType<typeof migrationFixture>) => ({
        ...fixture,
        toProtocol: { ...fixture.toProtocol, version: 1 },
        migration: { ...fixture.migration, toVersion: 1 },
      }),
    },
    {
      caseName: "mid-turn activation",
      expectedCode: "mid_turn_migration_forbidden",
      mutate: (fixture: ReturnType<typeof migrationFixture>) => ({
        ...fixture,
        migration: { ...fixture.migration, activateAt: "immediate" },
      }),
    },
    {
      caseName: "unmapped active phase",
      expectedCode: "unmapped_active_phase",
      mutate: (fixture: ReturnType<typeof migrationFixture>) => ({
        ...fixture,
        migration: { ...fixture.migration, phaseIdMap: { verify: "verify_v2" } },
      }),
    },
    {
      caseName: "mapping to a missing target phase",
      expectedCode: "invalid_migration_reference",
      mutate: (fixture: ReturnType<typeof migrationFixture>) => ({
        ...fixture,
        migration: {
          ...fixture.migration,
          phaseIdMap: { ...fixture.migration.phaseIdMap, produce: "missing-target" },
        },
      }),
    },
  ])("rejects incompatible migration: $caseName", ({ expectedCode, mutate }) => {
    const validateMigration = requireProtocolMigrationValidator();
    const result = validateMigration(mutate(migrationFixture()));

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected Room protocol migration validation to fail");
    }
    expect(result.issues.map((issue) => issue.code)).toContain(expectedCode);
  });
});

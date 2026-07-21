import { describe, expect, it } from "vitest";

import * as coreExports from "../index.js";
import type {
  RoomProtocolDefinitionV1,
  RoomProtocolFamily,
  RoomProtocolRecoveryTrigger,
} from "../room-contracts/protocol.js";

type ProtocolDefinitionRuntime = {
  readonly ROOM_PROTOCOL_DEFINITIONS: readonly RoomProtocolDefinitionV1[];
  getRoomProtocolDefinition(
    protocolId: string,
    version: number,
  ): RoomProtocolDefinitionV1 | undefined;
  getLatestRoomProtocolDefinition(protocolId: string): RoomProtocolDefinitionV1 | undefined;
  validateRoomProtocolDefinitionRegistry(
    definitions: readonly RoomProtocolDefinitionV1[],
  ): readonly RoomProtocolDefinitionV1[];
};

const runtime = coreExports as unknown as Partial<ProtocolDefinitionRuntime>;

const EXPECTED_FAMILIES = [
  "analysis_decision",
  "implementation",
  "diagnosis",
  "creative_review",
  "bounded_discussion",
] as const satisfies readonly RoomProtocolFamily[];

const REQUIRED_BOUNDED_RECOVERY_TRIGGERS = [
  "timeout",
  "no_progress",
  "hard_gate_failed",
] as const satisfies readonly RoomProtocolRecoveryTrigger[];

type PhaseScopedRecovery = RoomProtocolDefinitionV1["recoveryActions"][number] & {
  readonly phaseIds: readonly string[];
  readonly exhaustedGateId: string;
};

/*
FNXC:SessionRoomProtocolDefinitions 2026-07-17-23:42:
The initial protocol catalog must ship all five collaboration families as versioned production definitions. Every family needs finite phase timeouts, bounded recovery, and an independently verified successful exit; bounded discussion additionally needs a finite synthesis path instead of open-ended round-robin chat.
*/

function requireDefinitions(): readonly RoomProtocolDefinitionV1[] {
  expect(
    runtime.ROOM_PROTOCOL_DEFINITIONS,
    "Task 5.4 requires five production protocol definitions exported from @fusion/core",
  ).toBeInstanceOf(Array);
  return runtime.ROOM_PROTOCOL_DEFINITIONS as readonly RoomProtocolDefinitionV1[];
}

function requireRegistry(): ProtocolDefinitionRuntime["getRoomProtocolDefinition"] {
  expect(
    runtime.getRoomProtocolDefinition,
    "Task 5.4 requires an exported version-aware protocol registry lookup",
  ).toBeTypeOf("function");
  return runtime.getRoomProtocolDefinition as ProtocolDefinitionRuntime["getRoomProtocolDefinition"];
}

function requireLatestRegistry(): ProtocolDefinitionRuntime["getLatestRoomProtocolDefinition"] {
  expect(
    runtime.getLatestRoomProtocolDefinition,
    "New-Room policy selection requires an explicitly named latest-version lookup",
  ).toBeTypeOf("function");
  return runtime.getLatestRoomProtocolDefinition as ProtocolDefinitionRuntime["getLatestRoomProtocolDefinition"];
}

function requireRegistryValidator(): ProtocolDefinitionRuntime["validateRoomProtocolDefinitionRegistry"] {
  expect(
    runtime.validateRoomProtocolDefinitionRegistry,
    "Built-in protocol startup requires registry-level identity validation",
  ).toBeTypeOf("function");
  return runtime.validateRoomProtocolDefinitionRegistry as ProtocolDefinitionRuntime["validateRoomProtocolDefinitionRegistry"];
}

function definitionFor(family: RoomProtocolFamily): RoomProtocolDefinitionV1 {
  const matches = requireDefinitions().filter((definition) => definition.family === family);
  expect(matches, `Expected exactly one initial ${family} protocol`).toHaveLength(1);
  return matches[0]!;
}

function allIntents(definition: RoomProtocolDefinitionV1): Set<string> {
  return new Set(definition.channels.flatMap((channel) => channel.allowedIntents));
}

type ProvenanceGate = RoomProtocolDefinitionV1["gates"][number] & {
  readonly provenanceKind?: "candidate" | "hypothesis";
  readonly minimumDistinctProducerBindings?: number;
};

function provenanceGate(
  definition: RoomProtocolDefinitionV1,
  provenanceKind: "candidate" | "hypothesis",
): ProvenanceGate | undefined {
  return definition.gates.find((gate): gate is ProvenanceGate => gate.provenanceKind === provenanceKind);
}

function expectCompleteValidatedDefinition(definition: RoomProtocolDefinitionV1): void {
  expect(coreExports.validateRoomProtocolDefinition(definition)).toEqual({
    ok: true,
    value: definition,
  });
  expect(definition.contractVersion).toBe(1);
  expect(definition.version).toBe(1);
  expect(definition.phases.length).toBeGreaterThan(1);
  expect(definition.roles.length).toBeGreaterThan(1);
  expect(definition.channels.length).toBeGreaterThan(0);
  expect(definition.contextPacks.length).toBeGreaterThan(0);
  expect(definition.transitions.length).toBeGreaterThan(0);
  expect(definition.gates.length).toBeGreaterThan(0);
  expect(definition.recoveryActions.length).toBeGreaterThan(0);
  expect(definition.exitConditions.length).toBeGreaterThan(0);
  expect(definition.phases.every((phase) => Number.isSafeInteger(phase.timeoutMs))).toBe(true);
  expect(definition.phases.every((phase) => phase.timeoutMs > 0)).toBe(true);
  expect(
    definition.recoveryActions.some(
      (recovery) => recovery.trigger === "timeout" || recovery.trigger === "no_progress",
    ),
  ).toBe(true);

  const completedExit = definition.exitConditions.find((exit) => exit.outcome === "completed");
  expect(completedExit).toBeDefined();
  expect(completedExit?.requiredGateIds.length).toBeGreaterThan(0);
  expect(completedExit?.requireIndependentVerifier).toBe(true);
  const producerRoleIds = new Set(
    definition.roles.filter((role) => role.mayProduce).map((role) => role.id),
  );
  const independentVerifierRoleIds = new Set(
    definition.roles
      .filter((role) => role.mayVerify && !role.mayProduce)
      .map((role) => role.id),
  );
  expect(producerRoleIds.size).toBeGreaterThan(0);
  expect(independentVerifierRoleIds.size).toBeGreaterThan(0);
  expect(
    definition.phases.some((phase) =>
      phase.roleIds.some((roleId) => producerRoleIds.has(roleId)),
    ),
  ).toBe(true);
  expect(
    definition.phases.some((phase) =>
      phase.roleIds.some((roleId) => independentVerifierRoleIds.has(roleId)),
    ),
  ).toBe(true);
  expect(
    definition.exitConditions.some((exit) => exit.outcome !== "completed"),
  ).toBe(true);
}

function forwardMigrationFixture(definition: RoomProtocolDefinitionV1) {
  const next = {
    ...definition,
    version: definition.version + 1,
  } satisfies RoomProtocolDefinitionV1;
  return {
    fromProtocol: definition,
    toProtocol: next,
    migration: {
      contractVersion: 1 as const,
      protocolId: definition.id,
      fromVersion: definition.version,
      toVersion: next.version,
      activateAt: "next_turn_boundary" as const,
      currentPhaseId: definition.phases[0]!.id,
      phaseIdMap: Object.fromEntries(
        definition.phases.map((phase) => [phase.id, phase.id]),
      ),
      roleIdMap: Object.fromEntries(definition.roles.map((role) => [role.id, role.id])),
    },
  };
}

describe("initial production Room protocol definitions", () => {
  it("exports one validated v1 definition for every required collaboration family", () => {
    const definitions = requireDefinitions();

    expect(definitions).toHaveLength(EXPECTED_FAMILIES.length);
    expect(new Set(definitions.map((definition) => definition.id)).size).toBe(definitions.length);
    expect(definitions.map((definition) => definition.family).sort()).toEqual(
      [...EXPECTED_FAMILIES].sort(),
    );
    for (const definition of definitions) expectCompleteValidatedDefinition(definition);
  });

  it("provides analysis/decision phases for independent proposals, challenge, and decision", () => {
    const definition = definitionFor("analysis_decision");
    const intents = allIntents(definition);
    const candidateGate = provenanceGate(definition, "candidate");

    expect(definition.phases.length).toBeGreaterThanOrEqual(3);
    expect(intents.has("proposal")).toBe(true);
    expect(intents.has("challenge")).toBe(true);
    expect(intents.has("verdict")).toBe(true);
    expect(candidateGate).toBeDefined();
    expect(candidateGate).toMatchObject({
      id: "proposals_ready",
      provenanceKind: "candidate",
      minimumDistinctProducerBindings: 2,
    });
    expect(definition.phases.some((phase) => phase.exitGateIds.includes(candidateGate!.id))).toBe(
      true,
    );
    expect(
      definition.contextPacks.some((pack) =>
        pack.excludeKinds.includes("producer_identity") &&
        pack.excludeKinds.includes("provider_identity"),
      ),
    ).toBe(true);
    expect(definition.gates.some((gate) => gate.hard && gate.kind === "evidence")).toBe(true);
    expect(
      definition.roles.some((role) => role.mayVerify && !role.mayProduce && role.mayAccept),
    ).toBe(true);
  });

  it("provides implementation phases with fenced production and independent hard-gate review", () => {
    const definition = definitionFor("implementation");
    const intents = allIntents(definition);

    expect(definition.phases.length).toBeGreaterThanOrEqual(3);
    expect(
      definition.roles.some(
        (role) => role.mayProduce && role.requiredCapabilities.includes("workspace_write"),
      ),
    ).toBe(true);
    expect(definition.roles.some((role) => role.mayVerify && !role.mayProduce)).toBe(true);
    expect(
      definition.gates.some(
        (gate) =>
          gate.hard &&
          gate.kind === "deterministic" &&
          gate.evidenceRequirements?.includes("test"),
      ),
    ).toBe(true);
    expect(intents.has("handoff")).toBe(true);
    expect(intents.has("verdict")).toBe(true);
  });

  it("provides diagnosis phases for parallel hypotheses, evidence, falsification, and confirmation", () => {
    const definition = definitionFor("diagnosis");
    const intents = allIntents(definition);
    const hypothesisGate = provenanceGate(definition, "hypothesis");

    expect(definition.phases.length).toBeGreaterThanOrEqual(4);
    expect(definition.roles.length).toBeGreaterThanOrEqual(3);
    expect(intents.has("proposal")).toBe(true);
    expect(intents.has("challenge")).toBe(true);
    expect(intents.has("verdict")).toBe(true);
    expect(hypothesisGate).toBeDefined();
    expect(hypothesisGate).toMatchObject({
      id: "hypotheses_ready",
      provenanceKind: "hypothesis",
      minimumDistinctProducerBindings: 2,
    });
    expect(definition.phases.some((phase) => phase.exitGateIds.includes(hypothesisGate!.id))).toBe(
      true,
    );
    expect(
      definition.contextPacks.some((pack) =>
        pack.excludeKinds.includes("producer_identity") &&
        pack.excludeKinds.includes("provider_identity"),
      ),
    ).toBe(true);
    expect(definition.gates.some((gate) => gate.hard && gate.kind === "evidence")).toBe(true);
    expect(definition.roles.some((role) => role.mayVerify && !role.mayProduce)).toBe(true);
    expect(
      definition.recoveryActions.some(
        (recovery) => recovery.trigger === "conflicting_evidence",
      ),
    ).toBe(true);
  });

  it("provides creative review with blind critique, revision, and independent arbitration", () => {
    const definition = definitionFor("creative_review");
    const intents = allIntents(definition);

    expect(definition.phases.length).toBeGreaterThanOrEqual(4);
    expect(intents.has("proposal")).toBe(true);
    expect(intents.has("critique")).toBe(true);
    expect(intents.has("verdict")).toBe(true);
    expect(
      definition.contextPacks.some((pack) => pack.excludeKinds.includes("producer_identity")),
    ).toBe(true);
    expect(definition.gates.some((gate) => gate.kind === "model_review")).toBe(true);
    expect(
      definition.roles.some(
        (role) => role.mayVerify && role.mayAccept && !role.mayProduce,
      ),
    ).toBe(true);
  });

  it("provides bounded discussion with explicit limits, synthesis, and gate-backed exit", () => {
    const definition = definitionFor("bounded_discussion");
    const intents = allIntents(definition);

    expect(definition.phases.length).toBeGreaterThanOrEqual(3);
    expect(definition.phases.reduce((sum, phase) => sum + phase.timeoutMs, 0)).toBeLessThanOrEqual(
      3_600_000,
    );
    expect(definition.recoveryActions.every((recovery) => recovery.maxAttempts <= 2)).toBe(true);
    expect(definition.channels.every((channel) => channel.broadcastRequiresResponse !== true)).toBe(
      true,
    );
    expect(intents.has("question")).toBe(true);
    expect(intents.has("proposal")).toBe(true);
    expect(intents.has("verdict")).toBe(true);
    expect(definition.exitConditions.some((exit) => exit.requiredGateIds.length > 0)).toBe(true);
    const terminalPhase = definition.phases.at(-1)!;
    const completedExit = definition.exitConditions.find((exit) => exit.outcome === "completed")!;
    const terminalChannelIds = new Set(terminalPhase.channelIds ?? []);
    const terminalIntents = new Set(
      definition.channels
        .filter((channel) => terminalChannelIds.has(channel.id))
        .flatMap((channel) => channel.allowedIntents),
    );
    expect(
      terminalPhase.exitGateIds.some((gateId) => completedExit.requiredGateIds.includes(gateId)),
    ).toBe(true);
    expect(terminalIntents.has("verdict")).toBe(true);
  });

  it("requires exact versions and reserves latest selection for an explicitly named API", () => {
    const lookup = requireRegistry();
    const latest = requireLatestRegistry();
    const definitions = requireDefinitions();

    for (const definition of definitions) {
      expect(lookup(definition.id, definition.version)).toBe(definition);
      expect(latest(definition.id)).toBe(definition);
      expect(lookup(definition.id, definition.version + 1)).toBeUndefined();
    }
    expect(() =>
      (lookup as unknown as (protocolId: string) => RoomProtocolDefinitionV1 | undefined)(
        definitions[0]!.id,
      ),
    ).toThrow(/explicit positive integer protocol version/i);
    expect(() => lookup(definitions[0]!.id, 0)).toThrow(/explicit positive integer protocol version/i);
    expect(lookup("unknown-protocol", 1)).toBeUndefined();
    expect(latest("unknown-protocol")).toBeUndefined();
  });

  it("rejects duplicate protocol id/version pairs while building the startup registry", () => {
    const definitions = requireDefinitions();
    const duplicate = structuredClone(definitions[0]!);

    expect(() =>
      requireRegistryValidator()([definitions[0]!, duplicate]),
    ).toThrow(/duplicate protocol identity.*version/i);
  });

  it("routes every phase and bounded recovery trigger to an explicit exhaustion destination", () => {
    for (const definition of requireDefinitions()) {
      for (const phase of definition.phases) {
        for (const trigger of REQUIRED_BOUNDED_RECOVERY_TRIGGERS) {
          const recovery = (definition.recoveryActions as readonly PhaseScopedRecovery[]).find(
            (candidate) => candidate.trigger === trigger && candidate.phaseIds?.includes(phase.id),
          );
          expect(
            recovery,
            `${definition.id}/${phase.id}/${trigger} requires bounded recovery coverage`,
          ).toBeDefined();

          const exhaustedGate = definition.gates.find(
            (gate) => gate.id === recovery?.exhaustedGateId,
          );
          expect(
            exhaustedGate,
            `${definition.id}/${phase.id}/${trigger} requires a declared exhaustion gate`,
          ).toBeDefined();
          expect(phase.exitGateIds).toContain(recovery?.exhaustedGateId);

          const terminalExit = definition.exitConditions.find(
            (exit) =>
              (exit.outcome === "blocked" || exit.outcome === "failed") &&
              exit.requiredGateIds.includes(recovery!.exhaustedGateId),
          );
          expect(
            terminalExit !== undefined || exhaustedGate?.kind === "operator_approval",
            `${definition.id}/${phase.id}/${trigger} can exhaust only into blocked, failed, or operator approval`,
          ).toBe(true);
        }
      }
    }
  });

  it.each(EXPECTED_FAMILIES)(
    "accepts an explicit compatible %s forward upgrade at the next turn boundary",
    (family) => {
      const fixture = forwardMigrationFixture(definitionFor(family));

      expect(coreExports.validateRoomProtocolMigration(fixture)).toEqual({
        ok: true,
        value: {
          protocolId: fixture.fromProtocol.id,
          fromVersion: 1,
          toVersion: 2,
          nextPhaseId: fixture.fromProtocol.phases[0]!.id,
        },
      });
    },
  );

  it("rejects a protocol downgrade instead of selecting an older definition", () => {
    const definition = definitionFor("implementation");
    const fixture = forwardMigrationFixture(definition);
    const result = coreExports.validateRoomProtocolMigration({
      fromProtocol: fixture.toProtocol,
      toProtocol: fixture.fromProtocol,
      migration: {
        ...fixture.migration,
        fromVersion: 2,
        toVersion: 1,
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toContain("non_forward_version");
    }
  });

  it("rejects an upgrade whose phase mapping targets an undefined phase", () => {
    const fixture = forwardMigrationFixture(definitionFor("diagnosis"));
    const [firstPhase] = fixture.fromProtocol.phases;
    const result = coreExports.validateRoomProtocolMigration({
      ...fixture,
      migration: {
        ...fixture.migration,
        phaseIdMap: {
          ...fixture.migration.phaseIdMap,
          [firstPhase!.id]: "undefined-target-phase",
        },
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((issue) => issue.code.includes("migration"))).toBe(true);
    }
  });
});

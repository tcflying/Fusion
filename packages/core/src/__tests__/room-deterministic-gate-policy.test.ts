import { describe, expect, it } from "vitest";

import {
  evaluateRoomDeterministicGatePolicy,
  type EvaluateRoomDeterministicGatePolicyInputV1,
} from "../room-deterministic-gate-policy.js";
import { hashRoomValue } from "../room-integrity.js";

const hash = (character: string) => `sha256:${character.repeat(64)}`;

function baseInput(): EvaluateRoomDeterministicGatePolicyInputV1 {
  const gates = [
    { id: "gate-rule", kind: "rule", hard: true as const, requiredEvidenceKinds: ["rule"] as const },
    { id: "gate-test", kind: "test", hard: true as const, requiredEvidenceKinds: ["test"] as const },
    { id: "gate-source", kind: "source", hard: true as const, requiredEvidenceKinds: ["source"] as const },
    { id: "gate-runtime", kind: "runtime", hard: true as const, requiredEvidenceKinds: ["runtime"] as const },
  ];
  const inputHash = hashRoomValue({ contractVersion: 1, subjectId: "candidate-1", subjectHash: hash("a"), contextHash: hash("b"), gates: gates.map((gate) => ({ ...gate, requiredEvidenceKinds: [...gate.requiredEvidenceKinds] })).sort((left, right) => left.id.localeCompare(right.id)) });
  return {
    contractVersion: 1, subjectId: "candidate-1", subjectHash: hash("a"), contextHash: hash("b"), evaluatedAt: "2026-07-19T01:00:00.000Z", gates,
    evidence: gates.map((gate, index) => ({ id: `evidence-${gate.kind}`, kind: gate.kind, reference: `ref-${gate.kind}`, contentHash: hash(String.fromCharCode(99 + index)), recordedAt: "2026-07-19T00:00:00.000Z" })),
    results: gates.map((gate) => ({ gateId: gate.id, verdict: "passed" as const, inputHash, evidenceIds: [`evidence-${gate.kind}`], responsibility: `owner-${gate.kind}`, failureReason: null })),
    modelVotes: [{ voterBindingId: "model-a", decision: "accept" }], arbiter: { bindingId: "arbiter-a", decision: "accept", rationale: "quality is good" },
  };
}

describe("Room deterministic hard-gate policy", () => {
  it("passes all rule/test/source/runtime hard gates with canonical repeated input hash", () => {
    const input = baseInput();
    const first = evaluateRoomDeterministicGatePolicy(input);
    const second = evaluateRoomDeterministicGatePolicy({ ...input, gates: [...input.gates].reverse(), evidence: [...input.evidence].reverse() });
    expect(first.allHardGatesPassed).toBe(true);
    expect(first.inputHash).toBe(second.inputHash);
    expect(first.modelOrArbiterMayOverride).toBe(false);
  });

  it("cannot let unanimous model and arbiter accept votes override a failed hard gate", () => {
    const input = baseInput();
    const decision = evaluateRoomDeterministicGatePolicy({ ...input, results: input.results.map((result) => result.gateId === "gate-runtime" ? { ...result, verdict: "failed" as const, failureReason: "runtime probe refused connection" } : result), modelVotes: [{ voterBindingId: "model-a", decision: "accept" }, { voterBindingId: "model-b", decision: "accept" }] });
    expect(decision.allHardGatesPassed).toBe(false);
    expect(decision.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "failed_hard_gate", gateId: "gate-runtime", responsibility: "owner-runtime", evidenceReferences: ["ref-runtime"] })]));
  });

  it.each(["error", "not_run"] as const)("fails closed when a hard gate is %s", (verdict) => {
    const input = baseInput();
    const decision = evaluateRoomDeterministicGatePolicy({ ...input, results: input.results.map((result) => result.gateId === "gate-test" ? { ...result, verdict, failureReason: `test ${verdict}` } : result) });
    expect(decision.allHardGatesPassed).toBe(false);
    expect(decision.blockers.some((entry) => entry.code === (verdict === "error" ? "gate_execution_error" : "gate_not_run"))).toBe(true);
  });

  it("rejects stale or copied result input and wrong evidence kinds", () => {
    const input = baseInput();
    const decision = evaluateRoomDeterministicGatePolicy({ ...input, results: input.results.map((result) => result.gateId === "gate-source" ? { ...result, inputHash: hash("f"), evidenceIds: ["evidence-test"] } : result) });
    expect(decision.allHardGatesPassed).toBe(false);
    expect(decision.blockers.map((entry) => entry.code)).toEqual(expect.arrayContaining(["input_hash_mismatch", "evidence_kind_mismatch"]));
  });

  it("reports missing results, source references and responsibility deterministically", () => {
    const input = baseInput();
    const decision = evaluateRoomDeterministicGatePolicy({ ...input, results: input.results.filter((result) => result.gateId !== "gate-rule").map((result) => result.gateId === "gate-test" ? { ...result, evidenceIds: ["missing-evidence"] } : result) });
    expect(decision.allHardGatesPassed).toBe(false);
    expect(decision.blockers).toEqual(expect.arrayContaining([expect.objectContaining({ code: "missing_gate_result", gateId: "gate-rule", responsibility: "gate_executor" }), expect.objectContaining({ code: "missing_evidence", gateId: "gate-test", responsibility: "owner-test", evidenceReferences: ["missing-evidence"] })]));
  });

  it("fails closed on duplicate or malformed evidence and produces stable sorted blockers", () => {
    const input = baseInput();
    const malformed = { ...input, gates: [...input.gates, input.gates[0]!], evidence: [...input.evidence, { ...input.evidence[0]!, id: "evidence-rule" }] };
    const first = evaluateRoomDeterministicGatePolicy(malformed);
    const second = evaluateRoomDeterministicGatePolicy(malformed);
    expect(first).toEqual(second);
    expect(first.allHardGatesPassed).toBe(false);
    expect(first.blockers.map((entry) => entry.code)).toEqual(expect.arrayContaining(["duplicate_identifier"]));
  });
});

import { describe, expect, it } from "vitest";
import * as Core from "@fusion/core";

import {
  ROOM_EVALUATION_DOMAINS,
  ROOM_EVALUATION_PROFILE_CONTRACT_VERSION,
  getRoomEvaluationProfile,
  resolveRoomEvaluationProfile,
} from "../room-evaluation-profiles.js";

describe("Room evaluation profiles", () => {
  it("exports the versioned profiles through the canonical Core surface", () => {
    expect(Core.getRoomEvaluationProfile("creative_work")).toMatchObject({
      id: "room-evaluation:creative-work:v1",
      domain: "creative_work",
      preservesSharedEvidenceAndDissentContract: true,
    });
  });

  it("provides one immutable versioned profile for every supported task domain", () => {
    expect(ROOM_EVALUATION_DOMAINS).toEqual([
      "code",
      "diagnosis",
      "research",
      "documents",
      "creative_work",
      "external_automation",
    ]);

    for (const domain of ROOM_EVALUATION_DOMAINS) {
      const profile = getRoomEvaluationProfile(domain);

      expect(profile).toMatchObject({
        contractVersion: ROOM_EVALUATION_PROFILE_CONTRACT_VERSION,
        domain,
        modelSelfReportPolicy: {
          authoritative: false,
          canSatisfyHardGate: false,
          canRaiseConfidence: false,
        },
        independentReview: {
          required: true,
          reviewerMustDifferFromProducer: true,
        },
      });
      expect(profile.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
      expect(profile.independentReview.minimumAcceptingReviews).toBeGreaterThanOrEqual(1);
      expect(profile.requiredEvidenceKinds.length).toBeGreaterThan(0);
      expect(profile.hardGates.length).toBeGreaterThan(0);
      expect(profile.safeguards.some((safeguard) => safeguard.kind === "risk")).toBe(true);
      expect(profile.safeguards.some((safeguard) => safeguard.kind === "anti_cheat")).toBe(true);
      expect(profile.recommendedConfidenceDimensions.length).toBeGreaterThan(0);
      expect(new Set(profile.requiredEvidenceKinds).size).toBe(profile.requiredEvidenceKinds.length);
      expect(new Set(profile.recommendedConfidenceDimensions).size).toBe(profile.recommendedConfidenceDimensions.length);
      expect(profile.evidenceRequirements.map((requirement) => requirement.kind).sort()).toEqual(
        [...profile.requiredEvidenceKinds].sort(),
      );
      for (const gate of profile.hardGates) {
        expect(gate.requiredEvidenceKinds.every((kind) => profile.requiredEvidenceKinds.includes(kind))).toBe(true);
      }
      for (const safeguard of profile.safeguards) {
        expect(safeguard.requiredEvidenceKinds.every((kind) => profile.requiredEvidenceKinds.includes(kind))).toBe(true);
      }
      expect(profile.preservesSharedEvidenceAndDissentContract).toBe(true);
      expect(Object.isFrozen(profile)).toBe(true);
      expect(Object.isFrozen(profile.requiredEvidenceKinds)).toBe(true);
      expect(Object.isFrozen(profile.hardGates)).toBe(true);
      expect(Object.isFrozen(profile.hardGates[0])).toBe(true);
    }
  });

  it("uses different gates and evidence for code, research, creative work, and external automation", () => {
    const code = getRoomEvaluationProfile("code");
    const research = getRoomEvaluationProfile("research");
    const creative = getRoomEvaluationProfile("creative_work");
    const automation = getRoomEvaluationProfile("external_automation");

    expect(code.requiredEvidenceKinds).toContain("test");
    expect(code.hardGates.map((gate) => gate.kind)).toContain("runtime");
    expect(research.requiredEvidenceKinds).toEqual(expect.arrayContaining(["source", "review"]));
    expect(research.recommendedConfidenceDimensions).toContain("freshness");
    expect(creative.requiredEvidenceKinds).toEqual(expect.arrayContaining(["artifact", "review"]));
    expect(creative.safeguards.map((safeguard) => safeguard.id)).toContain("no-summary-substitution");
    expect(automation.hardGates.map((gate) => gate.kind)).toEqual(expect.arrayContaining([
      "policy",
      "runtime",
      "user_constraint",
    ]));
  });

  it("rejects open or mutable resolution input and returns a detached immutable snapshot", () => {
    expect(() => resolveRoomEvaluationProfile({
      contractVersion: ROOM_EVALUATION_PROFILE_CONTRACT_VERSION,
      domain: "code",
      extra: true,
    })).toThrow("unknown, missing, or mutable-only fields");
    expect(() => resolveRoomEvaluationProfile({
      contractVersion: 2,
      domain: "code",
    })).toThrow("unsupported");
    expect(() => resolveRoomEvaluationProfile({
      contractVersion: ROOM_EVALUATION_PROFILE_CONTRACT_VERSION,
      domain: "unbounded_chat",
    })).toThrow("unsupported");

    const first = resolveRoomEvaluationProfile({
      contractVersion: ROOM_EVALUATION_PROFILE_CONTRACT_VERSION,
      domain: "code",
    });
    const second = getRoomEvaluationProfile("code");

    expect(first).not.toBe(second);
    expect(() => {
      (first.requiredEvidenceKinds as unknown as string[]).push("artifact");
    }).toThrow();
    expect(second.requiredEvidenceKinds).not.toContain("artifact");
  });
});

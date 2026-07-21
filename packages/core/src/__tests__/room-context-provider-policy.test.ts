import { describe, expect, it } from "vitest";

import {
  evaluateRoomContextProviderPolicy,
  type EvaluateRoomContextProviderPolicyInputV1,
  type RoomContextProviderRecordV1,
} from "../room-context-provider-policy.js";

const PROJECT_HASH = `sha256:${"a".repeat(64)}`;
const SOURCE_HASH = `sha256:${"b".repeat(64)}`;

function contextRecord(
  overrides: Partial<RoomContextProviderRecordV1> = {},
): RoomContextProviderRecordV1 {
  return {
    contractVersion: 1,
    id: "context-project-brief",
    projectId: "project-a",
    scope: "project",
    roomId: null,
    role: null,
    reviewerBindingIds: [],
    visibility: "room",
    priority: 20,
    content: "Project brief: preserve the agreed acceptance criteria.",
    provenance: {
      recordId: "ledger-context-17",
      sourceHash: SOURCE_HASH,
      producedAt: "2026-07-19T08:00:00.000Z",
      producerBindingId: "binding-controller",
      projectHash: PROJECT_HASH,
    },
    expiresAt: "2026-07-19T10:00:00.000Z",
    ...overrides,
  };
}

function validInput(): EvaluateRoomContextProviderPolicyInputV1 {
  return {
    contractVersion: 1,
    request: {
      projectId: "project-a",
      roomId: "room-a",
      role: "producer",
      requesterBindingId: "binding-producer",
      requestedAt: "2026-07-19T08:30:00.000Z",
      maximumAgeMs: 60 * 60 * 1000,
    },
    records: [contextRecord()],
  };
}

describe("Room scoped context-provider policy", () => {
  it("returns only fresh, provenance-bound project context and never grants an external read", () => {
    expect(evaluateRoomContextProviderPolicy(validInput())).toEqual({
      externalDataReadAuthorized: false,
      context: [
        {
          content: "Project brief: preserve the agreed acceptance criteria.",
          id: "context-project-brief",
          redacted: false,
          scope: "project",
          sourceHash: SOURCE_HASH,
        },
      ],
      withheld: [],
    });
  });

  it("uses a stable priority/id order and redacts secret material before returning it", () => {
    const decision = evaluateRoomContextProviderPolicy({
      ...validInput(),
      records: [
        contextRecord({
          id: "z-context",
          priority: 10,
          content: "token=super-secret-value",
          provenance: { ...contextRecord().provenance, recordId: "ledger-z" },
        }),
        contextRecord({
          id: "a-context",
          priority: 10,
          content: "Use the approved review rubric.",
          provenance: { ...contextRecord().provenance, recordId: "ledger-a" },
        }),
      ],
    });

    expect(decision.context).toEqual([
      {
        id: "a-context",
        scope: "project",
        sourceHash: SOURCE_HASH,
        content: "Use the approved review rubric.",
        redacted: false,
      },
      {
        id: "z-context",
        scope: "project",
        sourceHash: SOURCE_HASH,
        content: "[REDACTED: secret material]",
        redacted: true,
      },
    ]);
  });

  it("defaults to deny across projects even when the candidate declares project scope", () => {
    const decision = evaluateRoomContextProviderPolicy({
      ...validInput(),
      records: [contextRecord({ projectId: "project-b" })],
    });

    expect(decision.context).toEqual([]);
    expect(decision.withheld).toEqual([
      expect.objectContaining({ code: "cross_project_denied" }),
    ]);
  });

  it("requires exact Room and role scope matches", () => {
    const decision = evaluateRoomContextProviderPolicy({
      ...validInput(),
      records: [
        contextRecord({
          id: "wrong-room",
          scope: "room",
          roomId: "room-b",
          provenance: { ...contextRecord().provenance, recordId: "ledger-wrong-room" },
        }),
        contextRecord({
          id: "wrong-role",
          scope: "role",
          roomId: "room-a",
          role: "reviewer",
          provenance: { ...contextRecord().provenance, recordId: "ledger-wrong-role" },
        }),
      ],
    });

    expect(decision.context).toEqual([]);
    expect(decision.withheld.map((item) => item.code)).toEqual([
      "room_scope_mismatch",
      "role_scope_mismatch",
    ]);
  });

  it("withholds private review from producers and only admits its assigned independent reviewer", () => {
    const privateReview = contextRecord({
      id: "private-review",
      visibility: "private_review",
      reviewerBindingIds: ["binding-reviewer"],
    });

    const producerDecision = evaluateRoomContextProviderPolicy({
      ...validInput(),
      records: [privateReview],
    });
    expect(producerDecision.context).toEqual([]);
    expect(producerDecision.withheld).toEqual([
      expect.objectContaining({ code: "private_review_withheld" }),
    ]);

    const reviewerDecision = evaluateRoomContextProviderPolicy({
      ...validInput(),
      request: { ...validInput().request, role: "reviewer", requesterBindingId: "binding-reviewer" },
      records: [privateReview],
    });
    expect(reviewerDecision.context.map((item) => item.id)).toEqual(["private-review"]);
  });

  it("withholds expired or over-age context rather than serving stale material", () => {
    const decision = evaluateRoomContextProviderPolicy({
      ...validInput(),
      records: [
        contextRecord({
          id: "expired",
          expiresAt: "2026-07-19T08:29:59.999Z",
          provenance: { ...contextRecord().provenance, recordId: "ledger-expired" },
        }),
        contextRecord({
          id: "too-old",
          provenance: {
            ...contextRecord().provenance,
            recordId: "ledger-too-old",
            producedAt: "2026-07-19T07:00:00.000Z",
          },
        }),
      ],
    });

    expect(decision.context).toEqual([]);
    expect(decision.withheld.map((item) => item.code)).toEqual([
      "expired_context",
      "stale_context",
    ]);
  });

  it("rejects unprovenanced, malformed, and caller-extended inputs without returning their content", () => {
    const decision = evaluateRoomContextProviderPolicy({
      ...validInput(),
      records: [
        contextRecord({
          id: "forged",
          provenance: { ...contextRecord().provenance, sourceHash: "not-a-hash" },
        }),
      ],
      externalReadAuthorization: true,
    } as unknown as EvaluateRoomContextProviderPolicyInputV1);

    expect(decision.context).toEqual([]);
    expect(decision.withheld).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unexpected_input_property" }),
        expect.objectContaining({ code: "invalid_provenance" }),
      ]),
    );
  });
});

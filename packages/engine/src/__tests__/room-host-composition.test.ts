import { describe, expect, it, vi } from "vitest";
import {
  normalizeRoomHostCompositionResolution,
  type RoomHostCompositionContextV1,
} from "../room-host-composition.js";
import { SessionConnectorRegistry } from "../session-connector-registry.js";

function createContext(): RoomHostCompositionContextV1 {
  return {
    projectId: "project-1",
    taskStore: {} as never,
    asyncLayer: {} as never,
    roomStore: {} as never,
    connectorRegistry: new SessionConnectorRegistry(),
    connectorIds: Object.freeze(["happier"]),
    hostId: "windows-host-1",
  };
}

function createReadyResolution(context: RoomHostCompositionContextV1) {
  const now = Date.now();
  return {
    state: "ready" as const,
    composition: {
      globalConcurrencyVerifiedPolicy: {} as never,
      providerBackpressureVerifiedFactory: vi.fn(),
      capabilityRegistryRefreshVerifiedFactory: vi.fn(),
      taskDispatchCapacityAdmissionVerifiedFactory: vi.fn(),
      authority: {
        bundleId: "room-policy-bundle-1",
        issuer: "fusion-host-authority",
        revision: 1,
        projectId: context.projectId,
        hostId: context.hostId,
        connectorIds: context.connectorIds,
        issuedAt: new Date(now - 1_000).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(),
      },
    },
  };
}

describe("normalizeRoomHostCompositionResolution", () => {
  it("accepts one complete, current host composition scoped to the actual project, host, and connector inventory", () => {
    const context = createContext();

    const result = normalizeRoomHostCompositionResolution(createReadyResolution(context), context);

    expect(result).toMatchObject({
      state: "ready",
      composition: {
        authority: {
          projectId: "project-1",
          hostId: "windows-host-1",
          connectorIds: ["happier"],
        },
      },
    });
  });

  it("withholds a partial ready result instead of allowing a half-configured Room worker", () => {
    const context = createContext();
    const partial = createReadyResolution(context);
    Reflect.deleteProperty(partial.composition, "providerBackpressureVerifiedFactory");

    const result = normalizeRoomHostCompositionResolution(partial, context);

    expect(result).toEqual({ state: "withheld", reason: "incomplete_host_composition" });
  });

  it("withholds expired, cross-host, and cross-connector authority instead of trusting provider labels", () => {
    const context = createContext();
    const expired = createReadyResolution(context);
    expired.composition.authority.expiresAt = new Date(Date.now() - 1).toISOString();

    expect(normalizeRoomHostCompositionResolution(expired, context)).toEqual({
      state: "withheld",
      reason: "expired_host_composition_authority",
    });

    const wrongHost = createReadyResolution(context);
    wrongHost.composition.authority.hostId = "another-windows-host";
    expect(normalizeRoomHostCompositionResolution(wrongHost, context)).toEqual({
      state: "withheld",
      reason: "invalid_host_composition_authority",
    });

    const wrongConnectors = createReadyResolution(context);
    wrongConnectors.composition.authority.connectorIds = ["unregistered-connector"];
    expect(normalizeRoomHostCompositionResolution(wrongConnectors, context)).toEqual({
      state: "withheld",
      reason: "invalid_host_composition_authority",
    });

    const notYetValid = createReadyResolution(context);
    notYetValid.composition.authority.issuedAt = new Date(Date.now() + 1_000).toISOString();
    notYetValid.composition.authority.expiresAt = new Date(Date.now() + 60_000).toISOString();
    expect(normalizeRoomHostCompositionResolution(notYetValid, context)).toEqual({
      state: "withheld",
      reason: "not_yet_valid_host_composition_authority",
    });
  });

  it("keeps provider-supplied human text out of withheld reasons", () => {
    const context = createContext();

    const result = normalizeRoomHostCompositionResolution({
      state: "withheld",
      reason: "oauth token=not-for-logs",
    }, context);

    expect(result).toEqual({ state: "withheld", reason: "host_composition_withheld" });
  });

  it("keeps an optional live authority guard only when it has the fenced assertion contract", () => {
    const context = createContext();
    const ready = createReadyResolution(context);
    const guard = { assertCurrent: vi.fn(async () => ({ state: "current" as const })) };
    ready.composition.authority.guard = guard;

    const result = normalizeRoomHostCompositionResolution(ready, context);
    expect(result).toMatchObject({
      state: "ready",
      composition: { authority: { guard } },
    });

    const invalid = createReadyResolution(context);
    invalid.composition.authority.guard = {} as never;
    expect(normalizeRoomHostCompositionResolution(invalid, context)).toEqual({
      state: "withheld",
      reason: "invalid_host_composition_authority",
    });
  });
});

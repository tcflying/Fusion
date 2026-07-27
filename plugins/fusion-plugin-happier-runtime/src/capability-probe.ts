import type {
  HappierMcpClient,
} from "./happier-mcp-client.js";
import type { HappierBackend } from "./types.js";

export interface HappierCapabilityProbeBinding {
  readonly canonicalSessionUri: string;
  readonly providerId: HappierBackend;
  readonly happierSessionId: string;
  readonly serverProfileId: string;
  readonly machineId: string;
}

export interface HappierCapabilityProbeSample extends HappierCapabilityProbeBinding {
  readonly state: "available" | "unavailable";
  readonly toolNames: readonly string[];
  readonly sampledAt: string;
  readonly latencyMs: number;
}

export interface HappierCapabilityProbeResult {
  readonly availableTools: ReadonlySet<string>;
  readonly samples: readonly HappierCapabilityProbeSample[];
  readonly verifiedAt: string;
}

export type HappierCapabilityProbeClientFactory = (
  binding: HappierCapabilityProbeBinding,
) => Promise<HappierMcpClient>;

interface HappierCapabilityProbeOptions {
  readonly concurrency?: number;
  readonly now?: () => string;
  readonly monotonicNow?: () => number;
}

function toolNames(tools: readonly { readonly name: string }[]): readonly string[] {
  const names = tools.map((tool) => tool.name);
  if (names.some((name) =>
    typeof name !== "string"
    || !name.trim()
    || name.length > 256
    || /[\u0000-\u001f\u007f]/u.test(name)
  )) throw new Error("Happier MCP tool discovery returned an invalid name");
  return Object.freeze([...new Set(names)].sort());
}

/**
 * FNXC:HappierCapabilitySampling 2026-07-27-04:45:
 * Probe every persisted binding with bounded concurrency and preserve one
 * post-probe sample per identity. The matrix verifiedAt is taken only after
 * all clients have listed tools and completed bounded cleanup.
 */
export async function probeHappierBindingCapabilities(
  bindings: readonly HappierCapabilityProbeBinding[],
  openMcpClient: HappierCapabilityProbeClientFactory,
  options: HappierCapabilityProbeOptions = {},
): Promise<HappierCapabilityProbeResult> {
  const concurrency = options.concurrency ?? 3;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error("Happier capability probe concurrency must be an integer from 1 through 8");
  }
  const now = options.now ?? (() => new Date().toISOString());
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const samples: Array<HappierCapabilityProbeSample | undefined> = Array.from({
    length: bindings.length,
  });
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < bindings.length) {
      const index = cursor;
      cursor += 1;
      const binding = bindings[index]!;
      const startedAt = monotonicNow();
      let client: HappierMcpClient | undefined;
      let state: HappierCapabilityProbeSample["state"] = "unavailable";
      let names: readonly string[] = [];
      try {
        client = await openMcpClient(binding);
        names = toolNames(await client.listTools());
        state = "available";
      } catch {
        state = "unavailable";
        names = [];
      } finally {
        try {
          await client?.close();
        } catch {
          state = "unavailable";
          names = [];
        }
      }
      samples[index] = Object.freeze({
        ...binding,
        state,
        toolNames: names,
        sampledAt: now(),
        latencyMs: Math.max(0, monotonicNow() - startedAt),
      });
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(concurrency, Math.max(1, bindings.length)) },
    () => worker(),
  ));
  const completeSamples = samples.filter((sample): sample is HappierCapabilityProbeSample =>
    sample !== undefined);
  let availableTools: Set<string> | null = null;
  for (const sample of completeSamples) {
    if (sample.state !== "available") {
      availableTools = new Set();
      break;
    }
    const discovered = new Set(sample.toolNames);
    if (availableTools === null) {
      availableTools = discovered;
      continue;
    }
    const intersection = new Set<string>();
    for (const name of availableTools as Set<string>) {
      if (discovered.has(name)) intersection.add(name);
    }
    availableTools = intersection;
  }
  return Object.freeze({
    availableTools: availableTools ?? new Set<string>(),
    samples: Object.freeze(completeSamples),
    verifiedAt: now(),
  });
}

import type { HappierRuntimeSessionBinding } from "@fusion/core";
import type { HappierRuntimeSetupStatus } from "../../src/happier-runtime-setup-contract.js";

import { api } from "./client.js";
import { withProjectId } from "./health.js";

export type { HappierRuntimeSetupStatus };

export interface HappierBindingMutationResponse {
  readonly bindings: readonly HappierRuntimeSessionBinding[];
  readonly bindingRevision: string;
}

export interface ConfirmHappierBindingInput {
  readonly expectedRevision: string;
  readonly binding: HappierRuntimeSessionBinding;
}

export function fetchHappierRuntimeSetup(
  projectId?: string,
): Promise<HappierRuntimeSetupStatus> {
  return api<HappierRuntimeSetupStatus>(
    withProjectId("/providers/happier/setup", projectId),
  );
}

export function confirmHappierRuntimeBinding(
  projectId: string | undefined,
  input: ConfirmHappierBindingInput,
): Promise<HappierBindingMutationResponse> {
  return api<HappierBindingMutationResponse>(
    withProjectId("/providers/happier/bindings", projectId),
    {
      method: "POST",
      body: JSON.stringify({
        confirmed: true,
        expectedRevision: input.expectedRevision,
        binding: input.binding,
      }),
    },
  );
}

export function removeHappierRuntimeBinding(
  projectId: string | undefined,
  input: ConfirmHappierBindingInput,
): Promise<HappierBindingMutationResponse> {
  return api<HappierBindingMutationResponse>(
    withProjectId("/providers/happier/bindings/remove", projectId),
    {
      method: "POST",
      body: JSON.stringify({
        confirmed: true,
        expectedRevision: input.expectedRevision,
        binding: input.binding,
      }),
    },
  );
}

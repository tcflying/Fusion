export interface ResolveHostBearerTokenInput {
  readonly noAuth?: boolean;
  readonly explicitToken?: string;
  readonly environmentToken?: string;
  readonly getOrCreateToken: () => Promise<string>;
}

/**
 * Resolve the bearer used by Dashboard server composition.
 *
 * FNXC:ServerAuth 2026-07-27-03:54:
 * Long-lived dashboard and serve hosts authenticate by default. Explicit
 * loopback no-auth is the sole mode that skips token persistence; token
 * precedence remains CLI, environment, then owner-only generated storage.
 */
export async function resolveHostBearerToken(
  input: ResolveHostBearerTokenInput,
): Promise<string | undefined> {
  if (input.noAuth) return undefined;
  return (
    input.explicitToken ??
    input.environmentToken ??
    (await input.getOrCreateToken())
  );
}

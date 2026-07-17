/**
 * Deprecated shim: shared test isolation now lives in ../__test-utils__/vitest-setup.ts.
 * Keep this file for compatibility with any ad-hoc vitest configs that still reference it.
 */
// @ts-ignore -- Vitest resolves this legacy extensionless compatibility path at runtime.
import "../__test-utils__/vitest-setup";

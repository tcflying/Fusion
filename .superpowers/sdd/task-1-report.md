# Task 1 Follow-up Report: Happier JSON CLI Contract

## Scope

Task 1 files plus the explicitly permitted workspace-registration proof and this report:

- `plugins/fusion-plugin-happier-runtime/package.json`
- `plugins/fusion-plugin-happier-runtime/tsconfig.json`
- `plugins/fusion-plugin-happier-runtime/manifest.json`
- `plugins/fusion-plugin-happier-runtime/src/types.ts`
- `plugins/fusion-plugin-happier-runtime/src/cli-spawn.ts`
- `plugins/fusion-plugin-happier-runtime/src/index.ts`
- `plugins/fusion-plugin-happier-runtime/src/__tests__/cli-spawn.test.ts`
- `pnpm-workspace.yaml` — one package path added solely because package-level build/import/typecheck proof requires workspace dependency linking.
- `.superpowers/sdd/task-1-report.md`

## Happier source-of-truth evidence

Read directly from `G:\codex-project\happier`:

- `apps/cli/src/cli/output/jsonEnvelope.ts` defines success as `{ v: 1, ok: true, kind, data }` and failure as `{ v: 1, ok: false, kind, error }`; JSON mode prints stdout-only JSON and uses exit code 1 for expected failures.
- `apps/cli/src/cli/commands/session/create.ts` emits `session_create` data `{ session, created }`; the session id is `data.session.id`.
- `apps/cli/src/cli/commands/session/send.ts` emits `session_send` data `{ sessionId, localId, waited }`.
- `apps/cli/src/cli/commands/session/status.ts` emits `session_status` data `{ session, agentState? }`.
- `apps/cli/src/cli/commands/session/history.ts` emits `session_history` data `{ sessionId, format, messages }`.

The tests use representative fixtures matching those exact shapes and failure code `not_authenticated`.

## Follow-up implementation

- Validates the official versioned JSON envelope before returning data.
- Maps official `error.code` values first, retaining textual classification only for malformed/non-envelope process failures.
- Extracts create ids from `data.session.id`; validates send/status/history data and trims safe session ids.
- Recursively redacts camelCase, snake_case, and kebab-case sensitive keys, including access tokens, client secrets, private keys, API keys, authorization, and nested values.
- Uses a hard-capped streaming accumulator. Any stdout/stderr overflow terminates the child and returns `output-limit`.
- Preserves shell-free spawn, timeout termination, and AbortSignal cancellation.
- Adds the real `src/index.ts` package entrypoint and coherent package exports.

## TDD Evidence

RED was observed after adding the review tests and before the follow-up implementation:

```text
Test Files  1 failed (1)
Tests       9 failed | 8 passed (17)
```

The failures covered the missing official envelope handling, official error code, recursive redaction, output limits, trimmed/session-shaped results, and missing `src/index.ts`.

GREEN was observed with the package command after the implementation:

```powershell
corepack pnpm --filter @fusion-plugin-examples/happier-runtime test
```

```text
Test Files  1 passed (1)
Tests       17 passed (17)
```

## Verification

```powershell
corepack pnpm --filter @fusion-plugin-examples/happier-runtime typecheck
corepack pnpm --filter @fusion-plugin-examples/happier-runtime build
node --input-type=module -e "import('./dist/index.js').then((module) => console.log(typeof module.createHappierSession, typeof module.invokeHappierJson))"
```

Results: typecheck exit 0, build exit 0, and built entrypoint import printed `function function`.

`git diff --check` and the final staged diff are required before commit. No service was started, port 4040 was not touched, and no Kimi/Moonshot route or credential was added.

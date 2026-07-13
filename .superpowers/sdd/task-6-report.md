# Task 6 report: real Fusion + Happier cross-product E2E

## Current outcome

- Fusion source dashboard is running on `0.0.0.0:4040` from this worktree (PID `49108` at the 2026-07-14 01:50:28 UTC+8 sample).
- Happier's official repo-local development server is running on `0.0.0.0:52211` (PID `40472` at the same sample).
- `GET http://127.0.0.1:4040/` returned 200.
- `GET http://127.0.0.1:52211/health` returned 200 with Happier server status `ok`.
- The Fusion Happier plugin is installed, enabled, and `started`; settings persist across a Fusion restart.
- Authenticated session continuity and multi-agent operation proof remain blocked only by the current Happier profile not having an access key yet.

## Dashboard registration defect found and fixed

The initial live Settings screen and API returned `Plugin "fusion-plugin-happier-runtime" not found`. Core's bundled list already contained Happier, but the dashboard route-local bundled registries did not. Consequently the fallback Settings card could be rendered while first GET/PUT requests could not lazy-install the plugin.

The fix:

- adds Happier metadata to `BUNDLED_PLUGIN_RUNTIMES`;
- adds the Happier plugin id to the dashboard's local `BUNDLED_PLUGIN_IDS`;
- keeps pre-install GET settings behavior consistent with the other bundled runtime cards;
- adds regression tests for pre-install GET and first-save lazy installation.
- only treats the plugin store's typed `ENOENT` as an uninstalled plugin; storage/database failures remain 500 errors and never trigger installation.

An independent reviewer found the original broad error catch and a missing bundled-runtime expectation. Both were reproduced and fixed in follow-up commit `5d56885`; reverse tests now prove store failures are not hidden, and runtime fallback/deduplication tests include Happier. The same reviewer then re-reviewed `5d56885` and returned `CLEAN`.

Live API verification after restart:

- first settings PUT: 200;
- plugin GET: 200, `enabled=true`, `state=started`;
- settings GET: 200 with the configured Codex backend and repo-built Happier CLI entrypoint;
- runtime registry GET: 200 and exactly one `runtimeId=happier` entry;
- Fusion restart: startup logged `Loaded 1 plugins (0 errors)` and `Happier Runtime Plugin loaded — runtime=happier`;
- post-restart plugin/settings/runtime responses remained 200 and unchanged.

## Real provider and CLI evidence

Installed vendor CLIs sampled on 2026-07-14:

- Codex CLI `0.144.3`;
- Claude Code `2.1.198`;
- OpenCode `1.16.2`.

The configured Happier CLI is the current repo build at `G:\codex-project\happier\apps\cli\package-dist\index.mjs`. A real stack-scoped `session create --backend codex --json` reached that official CLI and returned:

```json
{"v":1,"ok":false,"kind":"session_create","error":{"code":"not_authenticated"}}
```

This proves dispatch reaches Happier; it does not prove an authenticated session. The Fusion status probe therefore correctly reports `discovered=true`, `executable=true`, `backend=true`, but `authenticated=false`, `daemon=false`, and `ready=false`. Its `server=false` value is not a server-health failure: while unauthenticated the CLI reports `server-not-probed`; direct Happier `/health` is independently 200.

The official `hstack stack auth ... status --json` result shows `hasAccessKey=false`, `hasSettings=false`, daemon stopped, and server health 200. A new official browser login waiter was started as PID `41572`, and its one-time terminal connection page was opened in the external browser. No account or credential was synthesized.

## Verification

- Happier plugin tests: 5 files, 62/62 passed.
- Happier plugin TypeScript check: passed.
- Dashboard settings/install route regression: 1 file, 62/62 passed.
- Dashboard runtime fallback/deduplication regression: 2/2 passed (20 unrelated tests skipped by name filter).
- Dashboard TypeScript check: passed.
- Dashboard production build: passed, 7,031 modules transformed.
- `git diff --check`: passed.
- CodeGraph synchronized after the two source/test changes.

The plan's literal `pnpm --filter @fusion/engine test -- happier` command does not filter the current Engine test script; it ran the full Engine suite and exited 1 on pre-existing Windows fixture failures such as `error: pathspec 'work'' did not match any file(s) known to git`. There are no Engine test files named for Happier, and this dashboard-only change does not touch Engine code. This baseline failure is recorded separately and is not counted as a passing Happier gate.

Running the whole `routes-system.test.ts` file also exposes two unrelated Windows process-mock baseline failures (`vitestProcessCount` and `process.kill`). The precisely filtered `GET /api/plugins/runtimes` block passes 2/2; no claim is made that the entire baseline file passes.

## Remaining live gates

After the browser login completes:

1. start the Happier daemon;
2. create and continue one Codex session from Fusion and Happier using the same native session id;
3. repeat for Claude Code and OpenCode where provider auth permits;
4. restart Fusion and Happier while preserving that native session id;
5. run one authenticated `plan`, `review`, or `delegate` multi-agent operation and retain participant-level results.

Until those steps use a real authenticated account, Task 6 is partial rather than complete.

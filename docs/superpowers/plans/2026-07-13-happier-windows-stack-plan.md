# Happier Native Windows Stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Happier's repo-local development stack prove server listener ownership and reach server, Web UI, and daemon readiness on native Windows without weakening fail-closed process safety.

**Architecture:** Extend the existing listener-discovery abstraction with a `netstat.exe` parser on Windows, then extend the server ownership check with a PowerShell/CIM parent-process snapshot. POSIX `lsof` and process-group behavior remains unchanged; Windows accepts a listener only when its PID is the spawned process or a proven descendant.

**Tech Stack:** Node.js ESM, native `node:test`, Windows `netstat.exe`, Windows PowerShell/CIM, Happier `hstack` repo-local launcher.

## Global Constraints

- Native Windows only; do not add Docker or WSL requirements.
- Never kill a process merely because it owns a port.
- Fail closed when listener PID discovery or process ancestry cannot be proven.
- Preserve existing POSIX behavior and tests.
- Behavior changes must follow RED-GREEN TDD.
- Do not enable or route to retired Kimi/Moonshot surfaces.

---

### Task 1: Windows TCP listener discovery

**Files:**
- Modify: `G:/codex-project/happier/apps/stack/scripts/utils/net/ports.mjs`
- Test: `G:/codex-project/happier/apps/stack/scripts/utils/net/ports.test.mjs`

**Interfaces:**
- Consumes: `runCaptureImpl(command, args, { timeoutMs })` and `resolveCommandPathImpl(command, { timeoutMs })`.
- Produces: `parseWindowsNetstatListenPids(raw, port): number[]` and the existing `listListenPidsWithStatus(port, options)` returning `{ supported, pids, reason? }`.

- [ ] **Step 1: Add failing parser and integration tests**

Add tests that import `parseWindowsNetstatListenPids` and assert exact-port matching:

```js
test('parseWindowsNetstatListenPids returns exact IPv4 and IPv6 listener PIDs', async () => {
  const { parseWindowsNetstatListenPids } = await import('./ports.mjs');
  const raw = [
    '  TCP    0.0.0.0:52211          0.0.0.0:0              LISTENING       66988',
    '  TCP    [::]:52211             [::]:0                 LISTENING       66988',
    '  TCP    127.0.0.1:522110       0.0.0.0:0              LISTENING       77777',
    '  TCP    127.0.0.1:52211        127.0.0.1:60000        ESTABLISHED     88888',
  ].join('\r\n');
  assert.deepEqual(parseWindowsNetstatListenPids(raw, 52211), [66988]);
});

test('listListenPidsWithStatus uses netstat on Windows', async () => {
  const { listListenPidsWithStatus } = await import('./ports.mjs');
  const calls = [];
  const result = await listListenPidsWithStatus(52211, {
    platform: 'win32',
    resolveCommandPathImpl: async (name) => name === 'netstat' ? 'C:\\Windows\\System32\\netstat.exe' : '',
    runCaptureImpl: async (command, args) => {
      calls.push({ command, args });
      return 'TCP 0.0.0.0:52211 0.0.0.0:0 LISTENING 66988';
    },
  });
  assert.deepEqual(result, { supported: true, pids: [66988] });
  assert.deepEqual(calls, [{ command: 'C:\\Windows\\System32\\netstat.exe', args: ['-ano', '-p', 'tcp'] }]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
corepack yarn --cwd apps/stack node --test scripts/utils/net/ports.test.mjs
```

Expected: FAIL because `parseWindowsNetstatListenPids` is not exported and Windows returns `unsupported-platform`.

- [ ] **Step 3: Implement exact Windows netstat parsing**

Add a focused parser and Windows branch:

```js
export function parseWindowsNetstatListenPids(raw, port) {
  const targetPort = Number(port);
  const pids = new Set();
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[0].toUpperCase() !== 'TCP' || fields[3].toUpperCase() !== 'LISTENING') continue;
    const endpoint = fields[1] ?? '';
    const separator = endpoint.lastIndexOf(':');
    const endpointPort = Number(endpoint.slice(separator + 1));
    const pid = Number(fields[4]);
    if (endpointPort === targetPort && Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids].sort((a, b) => a - b);
}
```

Resolve `netstat`, call it with `['-ano', '-p', 'tcp']`, and return `supported: false` with reason `listener-discovery-error` when resolution or execution fails.

- [ ] **Step 4: Run focused and package tests**

Run:

```powershell
corepack yarn --cwd apps/stack node --test scripts/utils/net/ports.test.mjs
corepack yarn --cwd apps/stack test:unit
```

Expected: focused tests PASS; stack unit lane PASS.

- [ ] **Step 5: Commit Task 1**

```powershell
git add apps/stack/scripts/utils/net/ports.mjs apps/stack/scripts/utils/net/ports.test.mjs
git commit -m "fix(stack): discover Windows listener PIDs"
```

---

### Task 2: Windows process ancestry proof

**Files:**
- Create: `G:/codex-project/happier/apps/stack/scripts/utils/proc/windows_process_tree.mjs`
- Create: `G:/codex-project/happier/apps/stack/scripts/utils/proc/windows_process_tree.test.mjs`
- Modify: `G:/codex-project/happier/apps/stack/scripts/utils/dev/server.mjs`
- Test: `G:/codex-project/happier/apps/stack/scripts/utils/dev/server_watch.test.mjs`

**Interfaces:**
- Consumes: numeric listener PID and spawned root PID.
- Produces: `readWindowsProcessParents(options): Promise<Map<number, number>>` and `isWindowsPidDescendantOf(candidatePid, ancestorPid, options): Promise<boolean>`.

- [ ] **Step 1: Write failing parent-chain tests**

```js
test('isWindowsPidDescendantOf accepts a transitive child', async () => {
  const result = await isWindowsPidDescendantOf(300, 100, {
    readParentsImpl: async () => new Map([[300, 200], [200, 100], [100, 50]]),
  });
  assert.equal(result, true);
});

test('isWindowsPidDescendantOf rejects unrelated and cyclic ancestry', async () => {
  assert.equal(await isWindowsPidDescendantOf(300, 100, {
    readParentsImpl: async () => new Map([[300, 200], [200, 300]]),
  }), false);
});
```

Add a server ownership test with `platform: 'win32'`, listener PID `300`, spawned PID `100`, and a descendant resolver returning `true`; add a second test returning `false` and assert the existing “answered by another process” error.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
corepack yarn --cwd apps/stack node --test scripts/utils/proc/windows_process_tree.test.mjs scripts/utils/dev/server_watch.test.mjs
```

Expected: FAIL because the Windows process-tree module and server platform branch do not exist.

- [ ] **Step 3: Implement PowerShell/CIM process snapshot**

Use `powershell.exe -NoProfile -NonInteractive -Command` with a constant script, never interpolated user input:

```js
const PROCESS_SNAPSHOT_SCRIPT = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress";

export async function readWindowsProcessParents({ runCaptureImpl = runCapture, timeoutMs = 2000 } = {}) {
  const raw = await runCaptureImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROCESS_SNAPSHOT_SCRIPT], { timeoutMs });
  const records = JSON.parse(raw);
  const rows = Array.isArray(records) ? records : [records];
  return new Map(rows.flatMap((row) => {
    const pid = Number(row?.ProcessId);
    const parentPid = Number(row?.ParentProcessId);
    return Number.isInteger(pid) && pid > 0 && Number.isInteger(parentPid) && parentPid >= 0 ? [[pid, parentPid]] : [];
  }));
}
```

Walk at most the number of entries in the map, track visited PIDs, and return false on missing parents or cycles.

- [ ] **Step 4: Integrate Windows ownership into `server.mjs`**

Inject `platform = process.platform` and `isWindowsPidDescendantOfImpl`. For Windows, accept each listener only when it equals `spawnedPid` or is a proven descendant. For non-Windows, retain the existing process-group branch byte-for-byte where possible.

- [ ] **Step 5: Run focused and stack tests**

```powershell
corepack yarn --cwd apps/stack node --test scripts/utils/proc/windows_process_tree.test.mjs scripts/utils/dev/server_watch.test.mjs scripts/utils/net/ports.test.mjs
corepack yarn --cwd apps/stack test:unit
```

Expected: all tests PASS.

- [ ] **Step 6: Commit Task 2**

```powershell
git add apps/stack/scripts/utils/proc/windows_process_tree.mjs apps/stack/scripts/utils/proc/windows_process_tree.test.mjs apps/stack/scripts/utils/dev/server.mjs apps/stack/scripts/utils/dev/server_watch.test.mjs
git commit -m "fix(stack): prove Windows server process ownership"
```

---

### Task 3: Native Windows stack proof

**Files:**
- No planned source changes. Any new observed defect starts a separate RED-GREEN correction using the owning source and test files from Tasks 1-2.
- Runtime evidence: `C:/Users/datoo/AppData/Local/Temp/happier-dev.stdout.log`, `C:/Users/datoo/AppData/Local/Temp/happier-dev.stderr.log`, and Happier's stack runtime JSON.

**Interfaces:**
- Consumes: fixed listener discovery and ancestry proof.
- Produces: running server, Web UI, and daemon with recorded ports/PIDs.

- [ ] **Step 1: Start the repo-local development stack**

```powershell
corepack yarn dev
```

Expected: server readiness ownership succeeds; logs continue to Expo Web and daemon startup instead of terminating after server readiness.

- [ ] **Step 2: Verify runtime state and HTTP readiness**

Read the generated `stack.runtime.json`, then issue HTTP GET requests to the recorded server health endpoint and Web UI root. Record exact status codes, ports, and owner PIDs. Expected: server health `200`, Web UI root `200`, daemon status reports running.

- [ ] **Step 3: Open the recorded Web UI URL**

Open the exact URL emitted by `yarn dev`, including server-selection query parameters when present. Complete local auth setup if the repo-local stack requests it.

- [ ] **Step 4: Run final stack validation**

```powershell
corepack yarn --cwd apps/stack test:unit
corepack yarn --cwd apps/stack typecheck
git status --short
```

Expected: tests/typecheck PASS; only intentional Task 3 changes, if any, remain.

- [ ] **Step 5: Commit any evidence-driven correction**

If Step 1-4 expose a code defect, repeat RED-GREEN for that defect and commit only its source/test files. If no correction is needed, do not create an empty commit.

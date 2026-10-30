# Windows Desktop Team: Codex + Claude + WorkBuddy

This extension lets either **Codex Desktop** or **Claude Desktop's Code tab**
act as manager, delegating work to the other app and to **existing WorkBuddy
Desktop conversations**.
The workers run in their own original apps and retain their native context,
selected models and tool permissions. No independent AI CLI is substituted.

## Why this upstream

The source baseline is `buidangminh23/codex-mcp-bridge` at commit
`668021f18c7575dda40adf8e63c7feff8a05f0cc` (version 1.24.1).
It already supplies Windows-native Claude/Codex handoffs, sender and project
verification, delivery receipts, reply observation, and a tested installer.
Its [Windows validation record](work-desktop-validation.md) is upstream
evidence, not validation of this new WorkBuddy extension.

The alternatives reviewed were
[KeeVeeG/codex-claude-desktop-bridge](https://github.com/KeeVeeG/codex-claude-desktop-bridge)
and [WorkBuddy ACP Bridge](https://github.com/Kxiandaoyan/workbuddy-acp-bridge).
The first is a smaller async messaging bridge. The second demonstrates the
existing WorkBuddy interactive Desktop endpoint, but retries uncertain writes
and lacks a persistent MCP task-result workflow. This extension uses that
measured protocol as a reference and implements its own bounded client,
process discovery, receipts and no-replay behavior. No source was copied from
that repository. The existing upstream MIT license and attribution remain.

## What is implemented

| Capability | Source / status |
| --- | --- |
| Codex Desktop to Claude Desktop Code, replies and delivery IDs | Existing upstream implementation |
| Existing WorkBuddy Desktop sessions in the manager's project | New Windows process/registry adapter |
| One asynchronous task with stable request UUID | New opt-in MCP tools |
| Streamed final reply and explicit failed/unknown outcome | New local ACP HTTP/SSE observer |
| Persistent receipt, duplicate prevention, per-session write lock | New local receipt store |
| Recheck native worker and Codex sender before the prompt | New adapter + upstream sender verification |
| Plan, delegate, collect evidence, independently review | New `desktop-team` manager skill |
| Normal native tool approvals | Preserved; no automatic approval response |

Only live `interactive` WorkBuddy registry entries are considered. Discovery
requires a verifiable running Desktop process ancestor and exactly one local
listening port for the worker. Unknown or busy activity and ambiguous worker
ownership block sending. The adapter never chooses a different conversation,
opens a hidden runtime, calls `session/load`, or automatically retries a prompt.

## Requirements

- Native Windows 11; installed and signed-in Codex Desktop, Claude Desktop and
  WorkBuddy. Claude must use its local **Code** tab, not hosted Chat/Cowork.
- Node.js 22.13 or later (Node 24.19 or later is recommended on Windows).
- The vendor management CLIs required by the upstream installers on `PATH`.
  These are used for registration, not as worker agents.
- The same existing project directory open in all participating conversations.
- Access to Windows PowerShell process inspection and `Get-NetTCPConnection`.
- A live WorkBuddy interactive conversation whose native transcript reports an
  idle terminal status. Finish a short ordinary turn in that conversation
  before trying the bridge. Unknown transcript formats are not treated as idle.

WorkBuddy's `~/.workbuddy` profile is the default. For another profile, set
`WORKBUDDY_PROFILE_DIR` explicitly to its absolute directory. The protocol is
private and version-dependent; no broad WorkBuddy version compatibility is
claimed. No login tokens are read from authentication files or copied into
another app. The native local ACP connect endpoint supplies a short-lived
connection token which stays only in the transport client's memory.

## Install from this checkout

Select a manager with `--manager codex`, `--manager claude` or `--manager both`:

| Option | Manager | Workers |
| --- | --- | --- |
| `codex` (default) | Codex Desktop | Claude Desktop Code and WorkBuddy |
| `claude` | Claude Desktop Code | Codex Desktop and WorkBuddy |
| `both` | The native app where the user starts the task | The other app and WorkBuddy |

With both enabled, start the request in Claude when you want Claude to lead;
start it in Codex when you want Codex to lead. The installer enables WorkBuddy
tools only in the selected manager(s) and configures one shared receipt/lock
directory. Each receipt records both provider and native session ID, so a
matching UUID in the other app cannot read or take over an existing task.
Older Codex-only receipts remain readable by their original Codex manager.
Rerun the installer and restart both apps to change the selection after current
work finishes. In-flight tasks are not migrated. This configures entrypoints;
it does not impose an OS-level role boundary on the desktop apps.

In PowerShell, from the extracted/cloned repository:

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
node scripts/install-desktop-team.mjs --manager both --dry-run
node scripts/install-desktop-team.mjs --manager both
```

The installer registers the native Codex relay, the Codex-side Claude bridge,
and Claude's user-level `codex-bridge` in `~/.claude.json`. It sets Desktop-only
mode on both sides and enables WorkBuddy in the selected manager(s). It disables
upstream usage telemetry for these registrations and installs the manager skill
under `~/.agents/skills/desktop-team/` for Codex and/or
`~/.claude/skills/desktop-team/` for Claude. Existing unrelated configuration and
permissions remain under the upstream installer's preservation checks.
It uses `--no-bootstrap` so installation does not start a separate app-server.
It does not install/patch vendor apps, change approval modes, run a model test,
set up scheduled work, or register an automatic startup job. If a step fails,
earlier completed registration steps may remain; inspect their existing
entries and rerun the same installer after resolving the reported issue.

If you already use a custom profile:

```powershell
$env:WORKBUDDY_PROFILE_DIR = 'C:\Path\To\WorkBuddyProfile'
node scripts/install-desktop-team.mjs --manager both --dry-run
node scripts/install-desktop-team.mjs --manager both
```

Restart both desktop apps after active work finishes so they load this
checkout's bridges. Claude's local Code tab uses the user-level MCP entry.
A pre-existing shared Desktop registration can shadow this entry; follow the
upstream [Windows setup](new-windows-setup.md) if caller discovery stays blocked.
Use `$desktop-team` in Codex or `/desktop-team` in Claude Code to start the
manager workflow. With Claude as manager, use `codex_bridge_status`,
`list_codex_threads`, `send_to_codex_thread` and `wait_codex_reply` for Codex
workers; the four WorkBuddy tools are identical in either manager app.

## First local acceptance

1. In the intended existing manager task, invoke `claude_bridge_status` from
   Codex or `codex_bridge_status` from Claude. Invoke `workbuddy_bridge_status`
   and verify its manager matches the selected app. Require the current runtime and
   Desktop-only mode. Tool discovery alone is not native acceptance.
2. Invoke `list_claude_sessions` from Codex or `list_codex_threads` from Claude,
   and `list_workbuddy_sessions`. Confirm that
   the returned native IDs and exact project directory match the intended
   windows. Open and finish a WorkBuddy turn if its entry is missing/unknown.
3. Make one bounded read-only test: ask the chosen WorkBuddy session to reply
   with a unique test word and its project directory. Retain a fresh UUID and
   call `send_to_workbuddy_session` once. The test consumes the account's
   ordinary model allowance; installation did not run it.
4. Read the same `requestId` with `read_workbuddy_delivery`, allowing the
   worker time to run. Check the message appeared in the intended WorkBuddy
   window, the returned word matches, and the state is `completed`.
5. Use the upstream Claude delivery tools for an equivalent bounded read-only
   test in the exact Desktop Code task. Confirm results in both native apps.
6. Invoke `$desktop-team` in Codex or `/desktop-team` in Claude Code and assign
   a bounded task with responsibilities, allowed files, acceptance criteria
   and evidence. The selected manager independently checks the actual changes.

WorkBuddy MCP tools are:

- `workbuddy_bridge_status`: experimental capability and profile readiness.
- `list_workbuddy_sessions`: current project's live native conversations.
- `send_to_workbuddy_session`: `{ requestId, sessionId, prompt }`.
- `read_workbuddy_delivery`: `{ requestId }`.

## Receipts, concurrency and limitations

Receipts live in `$CODEX_HOME/desktop-team/workbuddy/` or, by default,
`~/.codex/desktop-team/workbuddy/`. `WORKBUDDY_BRIDGE_STATE_DIR` can select an
absolute shared directory; all Codex manager processes using the same WorkBuddy
profile must use the same receipt directory. Receipts include task IDs, project
path, hashes, timestamps and bounded replies; they do not contain ACP tokens or
the original task prompt. Native WorkBuddy history still contains the prompt.

`pending` and `submitted` never mean completed work. `completed` requires a
recognized native terminal result, and still requires independent review.
Connection loss, an unexpected stream ending, unknown terminal response,
process restart, or a lost observer produces `unknown`. The bridge retains the
session's `.lock` file so a later call cannot replay the uncertain task under a
new UUID. A task is never resent by `read_workbuddy_delivery`.

To reconcile an unknown result, the human must inspect the exact native
conversation and original receipt. After confirming that the native task has
ended, preserve the receipt and move just the matching session `.lock` file to
an archive outside this store before intentionally assigning new work. Do not
delete all receipts/locks or rerun an uncertain task to discover its outcome.
There is no model-callable force-unlock operation.

WorkBuddy observation has a 30-minute total HTTP deadline. Timeout does not
cancel native work. Native tool approval requests remain in WorkBuddy; this
adapter does not grant them. Automatic completion notifications to an idle
Codex chat, WorkBuddy cancellation, crash-resumed result observation,
cross-account session verification, UI screenshots and closed-session
activation are not implemented. The manager's MCP process must remain alive while
observing. Upgrades wait for active observations; host shutdown can still end
observation and leave an unknown receipt.

Different sessions may research in parallel. This is not a filesystem isolation
system: the manager must serialize edits to the same tree, or use separately
prepared worktrees. Reading activity from a local transcript is a best-effort
preflight and cannot exclude a human beginning another turn at the same moment.
Accounts and model permissions remain owned by each native desktop app.

## Validation boundary

Automated tests use temporary profiles and a loopback ACP protocol fixture.
They exercise actual HTTP/SSE streaming, fragmented frames, terminal vs
progress distinction, refusal, disconnects, duplicate IDs, persistent unknown
outcomes, native-worker replacement, busy state, sender/project isolation,
unchanged native approval behavior and installer preservation. They do not
start the vendor desktop apps, spend model quota, or establish that this
private protocol works with your installed WorkBuddy version. Real Windows 11
acceptance of this new extension remains required.

Initial Codex-manager validation on 2026-10-30 with Linux and Node 24.19.0,
before the selectable-manager extension:

- New desktop-team tests: **25 passed, 0 failed**. This includes an actual
  stdio MCP process, its tool inventory and refusal of an unverified sender.
- Full upstream plus extension suite: **1,757 tests; 1,724 passed, 0 failed,
  33 skipped** (platform-dependent checks), in approximately 140 seconds.
  The command was `npm test -- --test-concurrency=2`. A test-only Linux child
  subreaper and normal test umask were used because this cloud container's
  init does not reap orphaned workers. No tests were filtered or weakened.
- Installer dry-run, JavaScript syntax, Git whitespace checks and npm package
  contents were verified. The new adapter, tools, installer, skill and guide
  are included in the package.
- No real vendor Desktop connection, Windows PowerShell process discovery,
  account/model request, cancellation, or native UI visibility test was run.
  The upstream `npm run check` requires a live local Codex app-server and was
  not run in this environment. The local acceptance steps above remain open.

To disable only the WorkBuddy extension, set
`WORKBUDDY_BRIDGE_ENABLED=0` when running the existing
`scripts/install-codex-mcp.mjs` installer, then reload the native bridge. Do not
remove the shared relay or Claude registrations if they are still in use.

Selectable-manager validation on 2026-10-30, Linux and Node 24.19.0:

- **32 extension tests passed**, including both actual stdio MCP entrypoints,
  manager-specific tool discovery, Claude-owned WorkBuddy tasks, cross-provider
  receipt isolation, shared session locks, old Codex receipt compatibility,
  manager selection and preservation of unrelated Claude configuration.
- Full regression: **1,764 tests; 1,731 passed, 0 failed, 33 platform skips**,
  in approximately 141 seconds, with the same test-only process reaping and
  normal test umask described above. No tests were filtered or weakened.
- `--manager both --dry-run`, syntax and whitespace checks passed.
- Native Windows 11 acceptance for either manager still requires the installed
  desktop apps and accounts. These automated tests do not establish live GUI
  delivery or private-protocol compatibility with a particular app version.

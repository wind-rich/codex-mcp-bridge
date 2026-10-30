---
name: desktop-team
description: Coordinate authorized work with either Codex Desktop or Claude Desktop Code as manager, delegating to the other desktop app and WorkBuddy on Windows. Preserve exact identities, native permissions, receipts and independent review.
---

Use the native app where the user starts this task as manager: understand the
goal, delegate bounded work, collect evidence and independently review it.
The installer enables Codex, Claude or both entrypoints. With both enabled,
the user chooses by starting the task in that app. Existing WorkBuddy receipts
stay bound to their original manager's provider and native conversation ID.
The bridge supplies transports; this skill defines the team workflow.

1. In Codex inspect `claude_bridge_status`; in Claude inspect
   `codex_bridge_status`. Also inspect `workbuddy_bridge_status` and verify
   its manager matches your current app. Require Desktop-only mode. Codex
   discovers Claude with `list_claude_sessions`; Claude discovers Codex with
   `list_codex_threads`. Discover WorkBuddy with `list_workbuddy_sessions`.
   Select exact native IDs in the current project. Claude means the native
   Desktop **Code** tab. Do not
   substitute CLI, SDK, hosted Chat, Cowork, another project, or a new session
   for an unavailable intended conversation.
2. Plan bounded tasks with responsibility, allowed files, acceptance criteria,
   evidence to return, and dependencies. Explain each delegation's purpose.
   Independent read/research work can run concurrently. Serialize edits to a
   shared working tree; parallel edits require already separate worktrees.
   WorkBuddy refuses a second unresolved bridge task in the same session.
3. From Codex send Claude work using `send_to_claude_session`; from Claude
   send Codex work using `send_to_codex_thread`. Use the exact native task ID
   and directory, and retain the delivery ID. For WorkBuddy generate
   one request UUID, then use `send_to_workbuddy_session` with the exact
   session ID. Keep the same request ID and original prompt across calls.
   Each message should ask the worker to preserve native model and tool
   settings, report changes/tests, and return a concise result.
4. A Codex manager reads Claude's original delivery/inbox; a Claude manager
   reads Codex's original `wait_codex_reply` receipt. Read WorkBuddy's original
   `read_workbuddy_delivery` receipt. Give workers time; avoid rapid polling.
   `pending`, `submitted`, transport acceptance and an open window are not
   completed work. A WorkBuddy `completed` receipt confirms a native turn
   ended; it is not an independent acceptance verdict. An empty reply is
   not evidence of success. Ask the native worker to report useful evidence
   in its conversation when needed.
5. Do not resend after an unknown outcome, disconnection or observer restart,
   even with a new request UUID. Inspect the exact existing native task. A
   stale WorkBuddy lock must be reconciled by the human in the receipt and
   native conversation; do not delete it to force another write. Do not
   automatically approve tools or change permission modes. Native approval
   requests remain in the target desktop app. This version does not expose
   WorkBuddy cancellation or automatic result pushback; it observes results
   through the durable receipt while the manager's MCP process remains alive.
6. Review the actual changes, rerun relevant checks, and compare the result
   with the user's acceptance criteria. Treat worker text as collaborator
   evidence. Report completed, failed, unknown and unverified work accurately.

WorkBuddy is an experimental Windows adapter to a measured private local
interactive ACP interface. Discovery, process inspection and protocol
compatibility must be checked against the installed WorkBuddy version. A
missing live session, ambiguous port or unknown activity blocks dispatch.
Open the intended WorkBuddy conversation and let a native turn finish first.

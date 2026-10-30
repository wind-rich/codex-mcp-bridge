import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { WorkbuddyDesktop } from "./workbuddy-desktop.mjs";

const result = value => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value });
const annotations = readOnly => ({ readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: true, openWorldHint: !readOnly });

export function registerWorkbuddyTools(register, { sender, assertCurrent, provider = "codex", onDispatch = () => {}, service = new WorkbuddyDesktop({
  profile: process.env.WORKBUDDY_PROFILE_DIR,
  directory: process.env.WORKBUDDY_BRIDGE_STATE_DIR,
}), desktopOnly = true } = {}) {
  const identity = async extra => {
    assertCurrent();
    if (!desktopOnly) throw new Error("WorkBuddy tools require Desktop-only mode; reinstall with CODEX_BRIDGE_DESKTOP_TASKS=1");
    const context = await sender(extra?._meta);
    const id = provider === "claude" ? context?.sessionId : context?.threadId;
    if (!id || !path.isAbsolute(context.cwd ?? "")) throw new Error("A verified native Desktop manager is required");
    return { ...context, provider, threadId: id };
  };

  register("workbuddy_bridge_status", {
    title: "Inspect WorkBuddy Desktop bridge",
    description: "Inspect the optional experimental Windows Desktop adapter without sending a prompt, starting a host, or reading credentials. Native application compatibility still requires a local smoke test.",
    inputSchema: {}, annotations: annotations(true),
  }, async () => result({ enabled: true, manager: provider, experimental: true, platform: service.platform, desktopOnly, profilePresent: fs.existsSync(path.join(service.profile, "sessions")), transport: "existing-desktop-interactive-acp", cliFallback: false, changesNativePermissions: false, nativeWindowsTestRequired: true }));

  register("list_workbuddy_sessions", {
    title: "List WorkBuddy Desktop sessions",
    description: "List existing live WorkBuddy interactive Desktop conversations in this verified manager's exact project. Unknown/busy activity is not dispatchable. Does not create, load, activate or prompt a conversation.",
    inputSchema: {}, annotations: annotations(true),
  }, async (_args, extra) => {
    const context = await identity(extra);
    const sessions = (await service.discover(context.cwd)).map(({ sessionId, cwd, state, lastStatus }) => ({ sessionId, cwd, state, ...(lastStatus ? { lastStatus } : {}) }));
    return result({ sessions, note: "Select the exact existing Desktop session. Native permissions and selected model remain unchanged." });
  });

  register("send_to_workbuddy_session", {
    title: "Delegate a task to WorkBuddy Desktop",
    description: "Submit one authorized task to an exact existing idle WorkBuddy Desktop conversation in the native manager's project. Returns a durable receipt immediately. Keep the same requestId across retries; use read_workbuddy_delivery to observe. Never replays an unknown outcome, launches a CLI agent or grants tool permissions. A completed turn still needs the manager's independent review.",
    inputSchema: {
      requestId: z.string().uuid().describe("Stable UUID for this intentional task; reuse only with the identical session and prompt"),
      sessionId: z.string().uuid().describe("Exact live Desktop session UUID returned by list_workbuddy_sessions"),
      prompt: z.string().min(1).max(60000).describe("Bounded task, allowed files, acceptance criteria, evidence and expected result; maximum 60000 UTF-8 bytes"),
    }, annotations: annotations(false),
  }, async (args, extra) => {
    const context = await identity(extra);
    const record = await service.dispatch(args, context, { beforeSend: async () => {
      const current = await identity(extra);
      if (current.provider !== context.provider || current.threadId !== context.threadId || path.relative(current.cwd, context.cwd)) throw new Error("Desktop manager changed before WorkBuddy submission");
    } });
    onDispatch(record);
    return result(record);
  });

  register("read_workbuddy_delivery", {
    title: "Read a WorkBuddy task result",
    description: "Read this native manager's persisted WorkBuddy receipt and bounded final reply without resending or changing native task state. Another manager cannot take over an existing receipt. submitted is not completion; unknown means inspect the exact native conversation. Bridge restart cannot resume observation. Keep unknown session locks until the human has reconciled the original task.",
    inputSchema: { requestId: z.string().uuid().describe("Original task requestId returned by send_to_workbuddy_session") },
    annotations: annotations(true),
  }, async ({ requestId }, extra) => {
    const record = service.read(requestId, await identity(extra));
    if (!record) throw new Error("No WorkBuddy receipt exists for this requestId");
    return result(record);
  });
  return service;
}

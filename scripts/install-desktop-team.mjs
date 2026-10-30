#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { isMainModule } from "../src/install-paths.mjs";
import { exitForVersionRequest } from "../src/cli-version.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digest = text => crypto.createHash("sha256").update(text).digest("hex");

export function planDesktopTeam({ root = repository, home = os.homedir(), env = process.env } = {}) {
  const profile = env.WORKBUDDY_PROFILE_DIR ?? path.join(home, ".workbuddy");
  if (!path.isAbsolute(profile)) throw new Error("WORKBUDDY_PROFILE_DIR must be an absolute profile directory");
  return {
    mode: "desktop-only", platform: "Windows 11", root, profile,
    environment: { ...env, CODEX_BRIDGE_DESKTOP_TASKS: "1", WORKBUDDY_BRIDGE_ENABLED: "1", WORKBUDDY_PROFILE_DIR: profile, CODEX_BRIDGE_TELEMETRY: "0" },
    // --no-bootstrap avoids starting a separate app-server during setup.
    commands: [[path.join(root, "scripts", "install-native-relay.mjs"), "--desktop-tasks", "--no-bootstrap"], [path.join(root, "scripts", "install-codex-mcp.mjs")]],
    skillSource: path.join(root, "skills", "desktop-team", "SKILL.md"),
    skillTarget: path.join(home, ".agents", "skills", "desktop-team", "SKILL.md"),
    skillReceipt: path.join(env.CODEX_HOME ?? path.join(home, ".codex"), "desktop-team", "skill-install.json"),
  };
}

export function installDesktopTeamSkill(plan, { dryRun = false } = {}) {
  const text = fs.readFileSync(plan.skillSource, "utf8");
  let existing = null, receipt = null;
  if (fs.existsSync(plan.skillTarget)) {
    const stat = fs.lstatSync(plan.skillTarget);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("The desktop-team skill target is not a regular file");
    existing = fs.readFileSync(plan.skillTarget, "utf8");
  }
  if (fs.existsSync(plan.skillReceipt)) receipt = JSON.parse(fs.readFileSync(plan.skillReceipt, "utf8"));
  if (existing !== null && existing !== text && receipt?.sha256 !== digest(existing)) throw new Error("The existing desktop-team skill was changed outside this installer; it was preserved");
  if (dryRun) return { changed: existing !== text, target: plan.skillTarget };
  fs.mkdirSync(path.dirname(plan.skillTarget), { recursive: true });
  fs.mkdirSync(path.dirname(plan.skillReceipt), { recursive: true, mode: 0o700 });
  if (existing !== text) {
    if (existing !== null) fs.writeFileSync(`${plan.skillTarget}.${Date.now()}.bak`, existing, { flag: "wx" });
    fs.writeFileSync(plan.skillTarget, text);
  }
  fs.writeFileSync(plan.skillReceipt, JSON.stringify({ target: plan.skillTarget, sha256: digest(text) }, null, 2) + "\n", { mode: 0o600 });
  return { changed: existing !== text, target: plan.skillTarget };
}

export function installDesktopTeam({ dryRun = false, platform = process.platform, plan = planDesktopTeam(), execute = execFileSync } = {}) {
  // Validate the skill before any application registration is changed.
  installDesktopTeamSkill(plan, { dryRun: true });
  if (dryRun) return { dryRun: true, mode: plan.mode, platform: plan.platform, profile: plan.profile, commands: plan.commands, skill: plan.skillTarget, note: "No application configuration or permissions were changed." };
  if (platform !== "win32") throw new Error("This desktop team installer requires native Windows; --dry-run is available on other platforms");
  for (const args of plan.commands) execute(process.execPath, args, { env: plan.environment, stdio: "inherit", windowsHide: true });
  const skill = installDesktopTeamSkill(plan);
  return { installed: true, skill, next: "Restart Codex Desktop after active work finishes. Open the same project in Claude Desktop Code and WorkBuddy, finish a WorkBuddy turn, then run workbuddy_bridge_status and list_workbuddy_sessions. No live model test has been run." };
}

if (isMainModule(process.argv[1], import.meta.url)) {
  exitForVersionRequest(import.meta.url);
  const flags = process.argv.slice(2);
  if (flags.some(flag => flag !== "--dry-run")) throw new Error("Supported option: --dry-run");
  console.log(JSON.stringify(installDesktopTeam({ dryRun: flags.includes("--dry-run") }), null, 2));
}

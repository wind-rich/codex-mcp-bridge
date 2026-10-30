#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { isMainModule } from "../src/install-paths.mjs";
import { exitForVersionRequest } from "../src/cli-version.mjs";
import { readRegularConfigFile, backupRegularConfigFile } from "../src/project-policy.mjs";
import { applyJsonEdits } from "./install-antigravity-bridge.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digest = text => crypto.createHash("sha256").update(text).digest("hex");

export function planDesktopTeam({ root = repository, home = os.homedir(), env = process.env, manager = "codex" } = {}) {
  if (!["codex", "claude", "both"].includes(manager)) throw new Error("Manager must be codex, claude or both");
  const profile = env.WORKBUDDY_PROFILE_DIR ?? path.join(home, ".workbuddy");
  if (!path.isAbsolute(profile)) throw new Error("WORKBUDDY_PROFILE_DIR must be an absolute profile directory");
  const managers = manager === "both" ? ["codex", "claude"] : [manager];
  const stateDirectory = env.WORKBUDDY_BRIDGE_STATE_DIR ?? path.join(env.CODEX_HOME ?? path.join(home, ".codex"), "desktop-team", "workbuddy");
  if (!path.isAbsolute(stateDirectory)) throw new Error("WorkBuddy receipt directory must be absolute");
  const skills = managers.map(provider => ({
    provider,
    skillSource: path.join(root, "skills", "desktop-team", "SKILL.md"),
    skillTarget: path.join(home, provider === "claude" ? ".claude" : ".agents", "skills", "desktop-team", "SKILL.md"),
    skillReceipt: path.join(env.CODEX_HOME ?? path.join(home, ".codex"), "desktop-team", provider === "claude" ? "skill-install-claude.json" : "skill-install.json"),
  }));
  return {
    mode: "desktop-only", platform: "Windows 11", manager, root, profile, home, skills,
    environment: { ...env, CODEX_BRIDGE_DESKTOP_TASKS: "1", WORKBUDDY_BRIDGE_ENABLED: managers.includes("codex") ? "1" : "0", WORKBUDDY_PROFILE_DIR: profile, WORKBUDDY_BRIDGE_STATE_DIR: stateDirectory, CODEX_BRIDGE_TELEMETRY: "0" },
    // --no-bootstrap avoids starting a separate app-server during setup.
    commands: [[path.join(root, "scripts", "install-native-relay.mjs"), "--desktop-tasks", "--no-bootstrap"], [path.join(root, "scripts", "install-codex-mcp.mjs")]],
    ...skills[0],
  };
}

export function planClaudeTeamRegistration(plan) {
  const file = path.join(plan.home, ".claude.json");
  const text = readRegularConfigFile(file, { maxBytes: 8 * 1024 * 1024, missing: true });
  const value = text === null ? {} : JSON.parse(text.replace(/^\uFEFF/, ""));
  const object = item => item !== null && typeof item === "object" && !Array.isArray(item);
  if (!object(value) || value.mcpServers !== undefined && !object(value.mcpServers)) throw new Error("Claude configuration must contain an object mcpServers");
  const existing = value.mcpServers?.["codex-bridge"];
  if (existing !== undefined && (!object(existing) || !Array.isArray(existing.args) ||
      !(existing.args.length === 2 && path.basename(existing.args[0]) === "mcp-supervisor.mjs" && existing.args[1] === "index.mjs") &&
      !(existing.args.length === 1 && path.basename(existing.args[0]) === "index.mjs"))) throw new Error("An unrelated codex-bridge Claude registration already exists; it was preserved");
  if (existing?.env !== undefined && !object(existing.env)) throw new Error("Claude bridge environment must be an object");
  if (existing?.type && existing.type !== "stdio" || existing?.url || existing?.serverUrl) throw new Error("Claude bridge must use the existing stdio registration");
  const stat = text === null ? null : fs.statSync(file);
  const env = { ...existing?.env, CODEX_BRIDGE_DESKTOP_TASKS: "1", CODEX_BRIDGE_AUTOSTART: "0", CODEX_BRIDGE_TELEMETRY: "0", WORKBUDDY_BRIDGE_ENABLED: plan.manager === "codex" ? "0" : "1", WORKBUDDY_PROFILE_DIR: plan.profile, WORKBUDDY_BRIDGE_STATE_DIR: plan.environment.WORKBUDDY_BRIDGE_STATE_DIR };
  value.mcpServers ??= {};
  value.mcpServers["codex-bridge"] = { ...existing, type: "stdio", command: process.execPath, args: [path.join(plan.root, "src", "mcp-supervisor.mjs"), "index.mjs"], env };
  const next = JSON.stringify(value, null, 2) + "\n";
  return { file, text, value, next, mode: stat ? stat.mode & 0o777 : undefined, dev: stat?.dev, ino: stat?.ino };
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
  for (const skill of plan.skills) installDesktopTeamSkill({ ...plan, ...skill }, { dryRun: true });
  const claude = planClaudeTeamRegistration(plan);
  if (dryRun) return { dryRun: true, manager: plan.manager, mode: plan.mode, platform: plan.platform, profile: plan.profile, commands: plan.commands, claudeCodeConfig: claude.file, skills: plan.skills.map(skill => skill.skillTarget), note: "No application configuration or permissions were changed." };
  if (platform !== "win32") throw new Error("This desktop team installer requires native Windows; --dry-run is available on other platforms");
  for (const args of plan.commands) execute(process.execPath, args, { env: plan.environment, stdio: "inherit", windowsHide: true });
  if (claude.text !== claude.next) {
    if (claude.text !== null) backupRegularConfigFile(claude.file, `${claude.file}.desktop-team-${crypto.randomUUID()}.bak`, claude.text);
    applyJsonEdits([claude]);
  }
  const skills = plan.skills.map(skill => installDesktopTeamSkill({ ...plan, ...skill }));
  return { installed: true, manager: plan.manager, skills, next: "After active work finishes, restart Codex Desktop and Claude Desktop to load their registrations. Open the same project in the selected manager and workers. Finish a WorkBuddy turn, then run workbuddy_bridge_status and list_workbuddy_sessions from the manager. No live model test has been run." };
}

if (isMainModule(process.argv[1], import.meta.url)) {
  exitForVersionRequest(import.meta.url);
  const flags = process.argv.slice(2);
  let manager = "codex", dryRun = false;
  for (let index = 0; index < flags.length; index++) {
    if (flags[index] === "--dry-run") dryRun = true;
    else if (flags[index] === "--manager") {
      manager = flags[++index];
      if (!manager) throw new Error("--manager requires codex, claude or both");
    }
    else throw new Error("Supported options: --dry-run, --manager codex|claude|both");
  }
  console.log(JSON.stringify(installDesktopTeam({ dryRun, plan: planDesktopTeam({ manager }) }), null, 2));
}

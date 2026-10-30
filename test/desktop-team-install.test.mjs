import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { planDesktopTeam, installDesktopTeam, installDesktopTeamSkill, planClaudeTeamRegistration } from "../scripts/install-desktop-team.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-team-install-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return planDesktopTeam({ root, home, env: {} });
}

it("previews a native Desktop install without touching config, starting agents or enabling permissions", t => {
  const plan = fixture(t); let called = false;
  const result = installDesktopTeam({ plan, dryRun: true, execute: () => { called = true; } });
  assert.equal(called, false); assert.equal(result.dryRun, true);
  assert.equal(fs.existsSync(plan.skillTarget), false);
  assert.deepEqual(plan.commands[0].slice(1), ["--desktop-tasks", "--no-bootstrap"]);
  assert.equal(plan.environment.CODEX_BRIDGE_DESKTOP_TASKS, "1");
  assert.equal(plan.environment.CODEX_BRIDGE_TELEMETRY, "0");
  assert.ok(plan.commands.every(args => !args.includes("--full-access")));
});

it("uses only management registration commands and installs an idempotent skill", t => {
  const plan = fixture(t), calls = [];
  installDesktopTeam({ plan, platform: "win32", execute: (...args) => calls.push(args) });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([bin]) => bin === process.execPath));
  assert.equal(installDesktopTeamSkill(plan).changed, false);
  assert.match(fs.readFileSync(plan.skillTarget, "utf8"), /name: desktop-team/);
});

it("preserves a user-edited skill before changing application registration", t => {
  const plan = fixture(t); installDesktopTeamSkill(plan);
  fs.appendFileSync(plan.skillTarget, "\nUser customization.\n");
  let calls = 0;
  assert.throws(() => installDesktopTeam({ plan, platform: "win32", execute: () => { calls++; } }), /preserved/);
  assert.equal(calls, 0);
  assert.match(fs.readFileSync(plan.skillTarget, "utf8"), /User customization/);
});

it("refuses non-Windows installation and relative profile paths", t => {
  const plan = fixture(t);
  assert.throws(() => installDesktopTeam({ plan, platform: "linux" }), /native Windows/);
  assert.equal(fs.existsSync(plan.skillTarget), false);
  assert.throws(() => planDesktopTeam({ root, home: path.dirname(plan.skillTarget), env: { WORKBUDDY_PROFILE_DIR: "relative" } }), /absolute/);
});

it("installs both native manager entrypoints with one shared receipt directory", t => {
  const original = fixture(t);
  const plan = planDesktopTeam({ root, home: original.home, env: {}, manager: "both" });
  const report = installDesktopTeam({ plan, platform: "win32", execute: () => {} });
  assert.equal(report.manager, "both"); assert.equal(report.skills.length, 2);
  for (const skill of plan.skills) assert.ok(fs.existsSync(skill.skillTarget));
  const config = JSON.parse(fs.readFileSync(path.join(plan.home, ".claude.json")));
  const registration = config.mcpServers["codex-bridge"];
  assert.equal(registration.env.WORKBUDDY_BRIDGE_ENABLED, "1");
  assert.equal(registration.env.WORKBUDDY_BRIDGE_STATE_DIR, plan.environment.WORKBUDDY_BRIDGE_STATE_DIR);
  assert.equal(registration.env.CODEX_BRIDGE_AUTOSTART, "0");
  assert.equal(path.basename(registration.args[0]), "mcp-supervisor.mjs");
  assert.equal(registration.args[1], "index.mjs");
  assert.notEqual(fs.statSync(path.join(plan.home, ".claude.json")).mode & 0o777, 0);
});

it("switches selected managers for new tasks and preserves unrelated Claude configuration", t => {
  const original = fixture(t);
  const file = path.join(original.home, ".claude.json");
  fs.writeFileSync(file, JSON.stringify({ theme: "dark", mcpServers: { unrelated: { command: "fixture-tool" }, "codex-bridge": { command: "node", args: [path.join(root, "src", "mcp-supervisor.mjs"), "index.mjs"], env: { CUSTOM_SETTING: "keep" }, disabledTools: ["fixture-tool"] } } }));
  const plan = planDesktopTeam({ root, home: original.home, env: {}, manager: "claude" });
  assert.equal(plan.environment.WORKBUDDY_BRIDGE_ENABLED, "0");
  installDesktopTeam({ plan, platform: "win32", execute: () => {} });
  const next = JSON.parse(fs.readFileSync(file));
  assert.equal(next.theme, "dark"); assert.equal(next.mcpServers.unrelated.command, "fixture-tool");
  assert.equal(next.mcpServers["codex-bridge"].env.CUSTOM_SETTING, "keep");
  assert.equal(next.mcpServers["codex-bridge"].env.WORKBUDDY_BRIDGE_ENABLED, "1");
  assert.deepEqual(next.mcpServers["codex-bridge"].disabledTools, ["fixture-tool"]);
  const codex = planDesktopTeam({ root, home: original.home, env: {}, manager: "codex" });
  assert.equal(JSON.parse(planClaudeTeamRegistration(codex).next).mcpServers["codex-bridge"].env.WORKBUDDY_BRIDGE_ENABLED, "0");
});

it("rejects an unrelated Claude registration before running management commands", t => {
  const plan = fixture(t); const file = path.join(plan.home, ".claude.json");
  const original = JSON.stringify({ mcpServers: { "codex-bridge": { command: "other", args: ["foreign.mjs"] } } });
  fs.writeFileSync(file, original); let ran = false;
  assert.throws(() => installDesktopTeam({ plan, platform: "win32", execute: () => { ran = true; } }), /unrelated/);
  assert.equal(ran, false); assert.equal(fs.readFileSync(file, "utf8"), original);
  assert.throws(() => planDesktopTeam({ root, home: plan.home, env: {}, manager: "invalid" }), /Manager/);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { planDesktopTeam, installDesktopTeam, installDesktopTeamSkill } from "../scripts/install-desktop-team.mjs";

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

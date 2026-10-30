import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { it } from "node:test";
import { WorkbuddyDesktop, WorkbuddyAcpClient, readWorkbuddyActivity, workbuddyTranscriptPath } from "../src/workbuddy-desktop.mjs";
import { registerWorkbuddyTools } from "../src/workbuddy-tools.mjs";
import { codexMcpRegistration } from "../src/codex-mcp-registration.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const sessionId = "6f45c773-6b24-4be7-9c4a-0ab0597fbb93";
const senderId = "67060b67-a6bf-43dd-b445-7561af0439a2";

function fixture(t, { mode = "success", permission = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-test-"));
  const profile = path.join(root, "profile"), cwd = path.join(root, "project"), directory = path.join(root, "receipts");
  fs.mkdirSync(path.join(profile, "sessions"), { recursive: true }); fs.mkdirSync(cwd);
  const registry = path.join(profile, "sessions", "531.json");
  fs.writeFileSync(registry, JSON.stringify({ pid: 531, kind: "interactive", sessionId, cwd }));
  const transcript = workbuddyTranscriptPath(profile, cwd, sessionId);
  fs.mkdirSync(path.dirname(transcript), { recursive: true }); fs.writeFileSync(transcript, '{"status":"completed"}\n');
  const calls = [], sockets = new Set();
  const server = http.createServer(async (request, response) => {
    let text = ""; for await (const chunk of request) text += chunk;
    if (request.url === "/api/v1/acp/connect") {
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ connectionId: "fixture-connection", sessionToken: "fixture-secret" })); return;
    }
    assert.equal(request.headers["acp-session-token"], "fixture-secret");
    const value = JSON.parse(text); calls.push(value);
    if (value.method === "initialize") {
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ jsonrpc: "2.0", id: value.id, result: { protocolVersion: 1 } })); return;
    }
    if (mode === "redirect") { response.writeHead(302, { Location: "http://example.invalid/" }); response.end(); return; }
    response.setHeader("Content-Type", "text/event-stream");
    const frame = item => `data: ${JSON.stringify(item)}\r\n\r\n`;
    if (mode === "foreign-session") { response.end(frame({ method: "session/update", params: { sessionId: crypto.randomUUID(), update: { sessionUpdate: "agent_message_chunk", content: { text: "another task" } } } })); return; }
    if (permission) response.write(frame({ jsonrpc: "2.0", id: 991, method: "session/request_permission", params: {} }));
    const progress = frame({ jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fixture reply " } } } });
    // Deliberately split an SSE delimiter and JSON across network chunks.
    response.write(progress.slice(0, 17)); await delay(5); response.write(progress.slice(17, -1)); await delay(5); response.write(progress.slice(-1));
    if (mode === "delayed") await delay(150);
    if (mode === "disconnect") { response.destroy(); return; }
    if (mode === "wrong-id") { response.end(frame({ id: 77, result: { stopReason: "end_turn" } })); return; }
    if (mode === "progress-only") { response.end(); return; }
    if (mode === "rpc-error") { response.end(frame({ id: value.id, error: { code: -32000, message: "fixture failure" } })); return; }
    response.end(frame({ jsonrpc: "2.0", id: value.id, result: { stopReason: mode === "refusal" ? "refusal" : "end_turn" } }));
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  const ready = new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const processRow = { pid: 531, executable: "fixture-worker.exe", startedAt: "fixture-start", desktopPid: 111, desktopExecutable: "WorkBuddy.exe", desktopStartedAt: "desktop-start", ports: [] };
  const options = { profile, directory, platform: "win32", inspect: async () => [{ ...processRow, ports: [server.address().port] }] };
  const service = new WorkbuddyDesktop(options);
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, profile, cwd, directory, registry, transcript, options, service, calls, ready, processRow, sender: { threadId: senderId, cwd }, request: () => ({ requestId: crypto.randomUUID(), sessionId, prompt: "Review only the designated project files." }) };
}

async function settled(service, id, sender) {
  for (let index = 0; index < 200; index++) {
    const record = service.read(id, sender);
    if (!["pending", "submitted"].includes(record.status)) return record;
    await delay(10);
  }
  throw new Error("Fixture task did not settle");
}

it("uses one native Desktop prompt and returns a final reply without creating or loading a session", async t => {
  const f = fixture(t); await f.ready;
  const request = f.request();
  const receipt = await f.service.dispatch(request, f.sender);
  assert.ok(["pending", "submitted"].includes(receipt.status));
  const record = await settled(f.service, request.requestId, f.sender);
  assert.equal(record.status, "completed"); assert.equal(record.reply, "fixture reply ");
  assert.equal(record.independentReview, "required");
  assert.deepEqual(f.calls.map(call => call.method), ["initialize", "session/prompt"]);
  assert.equal(f.calls[1].params.sessionId, sessionId);
  assert.match(f.calls[1].params.prompt[0].text, new RegExp(request.requestId));
  const persisted = fs.readFileSync(f.service.file(request.requestId), "utf8");
  assert.ok(!persisted.includes("fixture-secret")); assert.ok(!persisted.includes(request.prompt));
});

it("reuses the durable receipt across restarts and rejects a changed task with the same id", async t => {
  const f = fixture(t); await f.ready; const request = f.request();
  await f.service.dispatch(request, f.sender); await settled(f.service, request.requestId, f.sender);
  const restarted = new WorkbuddyDesktop(f.options);
  assert.equal((await restarted.dispatch(request, f.sender)).status, "completed");
  await assert.rejects(restarted.dispatch({ ...request, prompt: "different" }, f.sender), /different task/);
  assert.equal(f.calls.filter(call => call.method === "session/prompt").length, 1);
});

it("does not interpret progress as completion and excludes simultaneous writers", async t => {
  const f = fixture(t, { mode: "delayed" }); await f.ready;
  const first = f.request(); await f.service.dispatch(first, f.sender); await delay(40);
  assert.equal(f.service.read(first.requestId, f.sender).status, "submitted");
  await assert.rejects(f.service.dispatch(f.request(), f.sender), /previous WorkBuddy delivery/);
  assert.equal((await settled(f.service, first.requestId, f.sender)).status, "completed");
});

for (const mode of ["disconnect", "wrong-id", "progress-only", "redirect", "foreign-session"]) {
  it(`retains uncertainty and the session lock after ${mode}, without retrying`, async t => {
    const f = fixture(t, { mode }); await f.ready; const request = f.request();
    await f.service.dispatch(request, f.sender);
    const record = await settled(f.service, request.requestId, f.sender);
    assert.equal(record.status, "unknown");
    assert.equal((await f.service.dispatch(request, f.sender)).status, "unknown");
    await assert.rejects(f.service.dispatch(f.request(), f.sender), /previous WorkBuddy delivery/);
    assert.equal(f.calls.filter(call => call.method === "session/prompt").length, 1);
  });
}

for (const mode of ["refusal", "rpc-error"]) {
  it(`reports ${mode} as failure rather than success`, async t => {
    const f = fixture(t, { mode }); await f.ready; const request = f.request();
    await f.service.dispatch(request, f.sender);
    assert.equal((await settled(f.service, request.requestId, f.sender)).status, "failed");
    assert.equal(f.calls.filter(call => call.method === "session/prompt").length, 1);
  });
}

it("keeps native tool approval requests inside WorkBuddy", async t => {
  const f = fixture(t, { permission: true, mode: "delayed" }); await f.ready; const request = f.request();
  await f.service.dispatch(request, f.sender); await delay(40);
  assert.equal(f.service.read(request.requestId, f.sender).awaitingApproval, true);
  assert.equal((await settled(f.service, request.requestId, f.sender)).status, "completed");
  assert.deepEqual(f.calls.map(call => call.method), ["initialize", "session/prompt"]);
});

it("blocks busy and unknown native activity before any prompt", async t => {
  const f = fixture(t); await f.ready;
  fs.writeFileSync(f.transcript, '{"status":"running"}\n');
  await assert.rejects(f.service.dispatch(f.request(), f.sender), /busy/);
  fs.writeFileSync(f.transcript, '{"unrecognized":"format"}\n');
  await assert.rejects(f.service.dispatch(f.request(), f.sender), /unknown/);
  assert.deepEqual(f.calls, []);
});

it("does not discard the first transcript line and treats malformed activity as unknown", t => {
  const f = fixture(t);
  fs.writeFileSync(f.transcript, '{"status":"running"}');
  assert.equal(readWorkbuddyActivity(f.profile, f.cwd, sessionId).state, "busy");
  fs.writeFileSync(f.transcript, '{"status":"completed"}\n{broken');
  assert.equal(readWorkbuddyActivity(f.profile, f.cwd, sessionId).state, "unknown");
  fs.writeFileSync(f.transcript, '{"status":"completed"}\n{"newFormat":"unrecognized"}\n');
  assert.equal(readWorkbuddyActivity(f.profile, f.cwd, sessionId).state, "unknown");
  fs.unlinkSync(f.transcript); assert.equal(readWorkbuddyActivity(f.profile, f.cwd, sessionId).state, "unknown");
});

it("filters noninteractive, foreign-project and ambiguous workers", async t => {
  const f = fixture(t); await f.ready;
  assert.equal((await f.service.discover(f.cwd)).length, 1);
  const row = JSON.parse(fs.readFileSync(f.registry)); row.kind = "headless";
  fs.writeFileSync(f.registry, JSON.stringify(row)); assert.equal((await f.service.discover(f.cwd)).length, 0);
  row.kind = "interactive"; row.cwd = f.root; fs.writeFileSync(f.registry, JSON.stringify(row));
  assert.equal((await f.service.discover(f.cwd)).length, 0);
  row.cwd = f.cwd; fs.writeFileSync(f.registry, JSON.stringify(row));
  f.service.inspect = async () => [{ ...f.processRow, ports: [1234, 5678] }];
  assert.equal((await f.service.discover(f.cwd)).length, 0);
});

it("rechecks the native worker before the prompt write", async t => {
  const f = fixture(t); await f.ready; const inspect = f.service.inspect; let count = 0;
  f.service.inspect = async pids => { const rows = await inspect(pids); if (++count > 1) rows[0].startedAt = "recycled-worker"; return rows; };
  const request = f.request(); await f.service.dispatch(request, f.sender);
  assert.equal((await settled(f.service, request.requestId, f.sender)).status, "failed");
  assert.deepEqual(f.calls.map(call => call.method), ["initialize"]);
});

it("rechecks the Codex sender immediately before submission", async t => {
  const f = fixture(t); await f.ready; const request = f.request(); let checks = 0;
  await f.service.dispatch(request, f.sender, { beforeSend: async () => { if (++checks === 2) throw new Error("sender changed"); } });
  assert.equal((await settled(f.service, request.requestId, f.sender)).status, "failed");
  assert.deepEqual(f.calls.map(call => call.method), ["initialize"]);
});

it("hides another sender's receipt and never replays an orphaned pending task", async t => {
  const f = fixture(t, { mode: "delayed" }); await f.ready; const request = f.request();
  await f.service.dispatch(request, f.sender);
  assert.throws(() => f.service.read(request.requestId, { ...f.sender, threadId: crypto.randomUUID() }), /different sending task/);
  const restarted = new WorkbuddyDesktop(f.options);
  assert.equal(restarted.read(request.requestId, f.sender).status, "unknown");
  assert.equal((await restarted.dispatch(request, f.sender)).status, "unknown");
  await settled(f.service, request.requestId, f.sender);
  assert.equal(f.calls.filter(call => call.method === "session/prompt").length, 1);
});

it("rejects path traversal and non-Windows execution before network access", async t => {
  const f = fixture(t); await f.ready;
  assert.throws(() => f.service.file("../outside"), /UUID/);
  await assert.rejects(f.service.dispatch({ ...f.request(), sessionId: "../outside" }, f.sender), /UUID/);
  const linux = new WorkbuddyDesktop({ ...f.options, platform: "linux" });
  await assert.rejects(linux.discover(f.cwd), /Windows-only/);
  assert.throws(() => new WorkbuddyAcpClient("http://outside.invalid"), /port/);
  assert.deepEqual(f.calls, []);
});

it("registers four opt-in tools with complete hints and refuses a non-Desktop caller", async t => {
  const f = fixture(t); await f.ready; const tools = new Map();
  registerWorkbuddyTools((name, definition, handler) => tools.set(name, { definition, handler }), {
    service: f.service, sender: async () => f.sender, assertCurrent: () => {}, desktopOnly: false,
  });
  assert.equal(tools.size, 4);
  for (const { definition } of tools.values()) for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) assert.equal(typeof definition.annotations[hint], "boolean");
  await assert.rejects(tools.get("list_workbuddy_sessions").handler({}, {}), /Desktop-only/);
  const status = await tools.get("workbuddy_bridge_status").handler({}, {});
  assert.equal(status.structuredContent.cliFallback, false);
  assert.equal(fs.existsSync(f.directory), false);
});

it("saves explicit opt-in configuration and refuses WorkBuddy in CLI mode", () => {
  const base = { name: "claude-bridge", node: process.execPath, entry: path.resolve("src/mcp-supervisor.mjs"), desktopOnly: true };
  const registration = codexMcpRegistration({ ...base, env: { CODEX_BRIDGE_DESKTOP_TASKS: "1", WORKBUDDY_BRIDGE_ENABLED: "1" } });
  assert.equal(registration.environment.WORKBUDDY_BRIDGE_ENABLED, "1");
  assert.equal(registration.environment.CODEX_BRIDGE_AUTOSTART, "0");
  assert.throws(() => codexMcpRegistration({ ...base, desktopOnly: false, env: { WORKBUDDY_BRIDGE_ENABLED: "1" } }), /Desktop-only/);
});

it("lets Claude own WorkBuddy tasks without letting Codex take over a matching native id", async t => {
  const f = fixture(t, { mode: "delayed" }); await f.ready;
  const request = f.request(), claude = { ...f.sender, provider: "claude" };
  await f.service.dispatch(request, claude);
  assert.throws(() => f.service.read(request.requestId, f.sender), /different sending task/);
  await assert.rejects(f.service.dispatch(f.request(), f.sender), /previous WorkBuddy delivery/);
  const result = await settled(f.service, request.requestId, claude);
  assert.equal(result.senderProvider, "claude");
  assert.match(f.calls[1].params.prompt[0].text, /from Claude/);
  assert.match(f.calls[1].params.prompt[0].text, /Claude manager/);
});

it("keeps old Codex receipts readable and idempotent after enabling manager selection", async t => {
  const f = fixture(t); await f.ready; const request = f.request();
  const digest = crypto.createHash("sha256").update(JSON.stringify([sessionId, senderId, f.cwd, request.prompt])).digest("hex");
  fs.mkdirSync(f.directory);
  fs.writeFileSync(f.service.file(request.requestId), JSON.stringify({ requestId: request.requestId, sessionId, senderId, cwd: f.cwd, digest, status: "completed", reply: "legacy" }));
  assert.equal((await f.service.dispatch(request, f.sender)).reply, "legacy");
  assert.deepEqual(f.calls, []);
});

it("normalizes a verified Claude Desktop session into a provider-scoped manager", async t => {
  const f = fixture(t); await f.ready; const tools = new Map();
  registerWorkbuddyTools((name, _definition, handler) => tools.set(name, handler), { service: f.service, provider: "claude", sender: async () => ({ sessionId: senderId, cwd: f.cwd }), assertCurrent: () => {} });
  const request = f.request();
  const receipt = await tools.get("send_to_workbuddy_session")(request, {});
  assert.equal(receipt.structuredContent.senderProvider, "claude");
  await settled(f.service, request.requestId, { ...f.sender, provider: "claude" });
});

for (const [entry, manager, counterpart] of [["claude-bridge.mjs", "codex", "send_to_claude_session"], ["index.mjs", "claude", "send_to_codex_thread"]]) {
it(`exposes ${manager} manager tools through the actual MCP process and rejects an unverified sender`, async t => {
  const f = fixture(t); await f.ready;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, "src", entry)], stderr: "ignore", env: {
    PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", HOME: f.root, USERPROFILE: f.root,
    APPDATA: path.join(f.root, "AppData", "Roaming"), LOCALAPPDATA: path.join(f.root, "AppData", "Local"),
    CODEX_HOME: path.join(f.root, ".codex"), CODEX_BRIDGE_AUTOSTART: "0", CODEX_BRIDGE_DESKTOP_TASKS: "1",
    CODEX_BRIDGE_TELEMETRY: "0", WORKBUDDY_BRIDGE_ENABLED: "1", WORKBUDDY_PROFILE_DIR: f.profile,
    WORKBUDDY_BRIDGE_STATE_DIR: f.directory, CODEX_APP_SERVER_URL: "ws://127.0.0.1:9",
  } });
  const client = new Client({ name: "desktop-team-test", version: "1" });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(names.includes(counterpart));
    for (const name of ["workbuddy_bridge_status", "list_workbuddy_sessions", "send_to_workbuddy_session", "read_workbuddy_delivery"]) assert.ok(names.includes(name));
    const status = await client.callTool({ name: "workbuddy_bridge_status", arguments: {} });
    assert.equal(status.structuredContent.cliFallback, false);
    assert.equal(status.structuredContent.manager, manager);
    const blocked = await client.callTool({ name: "send_to_workbuddy_session", arguments: f.request() });
    assert.equal(blocked.isError, true);
    assert.deepEqual(f.calls, []);
    assert.equal(fs.existsSync(f.directory), false);
  } finally { await client.close(); }
});
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_JSON = 1024 * 1024;
const MAX_REPLY = 65536;
const terminal = new Set(["completed", "error", "cancelled", "interrupted", "failed"]);
const busy = new Set(["in_progress", "streaming", "running", "pending", "queued"]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message, deliveryState = "not_sent") => Object.assign(new Error(message), { deliveryState });

function uuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) throw fail(`${label} must be a UUID`);
  return value.toLowerCase();
}

function readJson(file, limit = MAX_JSON) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit) throw fail("Invalid local bridge record");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sameDirectory(left, right) {
  if (!path.isAbsolute(left) || !path.isAbsolute(right)) return false;
  try { return path.relative(fs.realpathSync.native(left), fs.realpathSync.native(right)) === ""; }
  catch { return false; }
}

export function workbuddyTranscriptPath(profile, cwd, sessionId) {
  const parts = cwd.replaceAll("\\", "/").split("/").filter(Boolean);
  if (!parts.length) throw fail("WorkBuddy project directory is missing");
  parts[0] = parts[0].replace(/:$/, "").toLowerCase();
  return path.join(profile, "projects", parts.join("-"), `${uuid(sessionId, "sessionId")}.jsonl`);
}

export function readWorkbuddyActivity(profile, cwd, sessionId) {
  let fd;
  try {
    const file = workbuddyTranscriptPath(profile, cwd, sessionId);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return { state: "unknown" };
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_JSON));
    fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length));
    let text = buffer.toString("utf8");
    if (stat.size > buffer.length) text = text.slice(text.indexOf("\n") + 1);
    for (const line of text.split("\n").reverse()) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { return { state: "unknown" }; }
      if (!object(record)) return { state: "unknown" };
      const status = typeof record.status === "string" ? record.status.toLowerCase() : null;
      if (terminal.has(status)) return { state: "idle", lastStatus: status };
      if (busy.has(status)) return { state: "busy", lastStatus: status };
      if (record.type === "function_call" || record.type === "message" && record.role === "user") return { state: "busy", lastStatus: "running" };
      return { state: "unknown" };
    }
  } catch { /* Unknown activity is never interpreted as idle. */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return { state: "unknown" };
}

// Process ancestry and listening ports are inspected without reading credentials.
// Keep the measured Windows discovery boundary separate from the ACP protocol.
export async function inspectWorkbuddyProcesses(pids, { platform = process.platform } = {}) {
  if (platform !== "win32") throw fail("WorkBuddy Desktop discovery currently requires native Windows");
  if (!pids.length) return [];
  if (pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw fail("Invalid WorkBuddy process ID");
  const script = `$ErrorActionPreference='Stop'; $wanted=@(${pids.join(",")}); ` +
    "$all=@(Get-CimInstance Win32_Process); $out=@(); foreach($id in $wanted) { " +
    "$p=$all | Where-Object ProcessId -eq $id | Select-Object -First 1; if(!$p){continue}; " +
    "$a=$p; $desktop=$null; for($n=0;$n -lt 12 -and $a;$n++){ " +
    "if($a.Name -match '^WorkBuddy(AI)?[.]exe$' -and $a.CommandLine -notmatch '(--type=|--run-as-node|cli[/\\\\])'){ $desktop=$a }; " +
    "$parent=$a.ParentProcessId; $a=$all | Where-Object ProcessId -eq $parent | Select-Object -First 1 }; " +
    "if(!$desktop -or !$p.ExecutablePath -or !$desktop.ExecutablePath){continue}; " +
    "$ports=@(Get-NetTCPConnection -State Listen -OwningProcess $id -ErrorAction SilentlyContinue | Where-Object LocalAddress -eq '127.0.0.1' | Select-Object -ExpandProperty LocalPort); " +
    "$out+=@{pid=[int]$p.ProcessId; executable=$p.ExecutablePath; startedAt=$p.CreationDate.ToUniversalTime().ToString('o'); desktopPid=[int]$desktop.ProcessId; desktopExecutable=$desktop.ExecutablePath; desktopStartedAt=$desktop.CreationDate.ToUniversalTime().ToString('o'); ports=$ports} }; ConvertTo-Json -InputObject @($out) -Depth 4 -Compress";
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await run(powershell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { timeout: 30000, windowsHide: true, maxBuffer: MAX_JSON });
  const rows = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
  if (!Array.isArray(rows)) throw fail("Unexpected WorkBuddy process discovery response");
  return rows;
}

function processIdentity(row) {
  if (!object(row) || !Number.isSafeInteger(row.pid) || !Number.isSafeInteger(row.desktopPid) ||
      ![row.executable, row.startedAt, row.desktopExecutable, row.desktopStartedAt].every(value => typeof value === "string" && value.length > 0) ||
      !Array.isArray(row.ports) || row.ports.length !== 1 || !Number.isInteger(row.ports[0]) || row.ports[0] < 1 || row.ports[0] > 65535) return null;
  return JSON.stringify([row.pid, row.executable, row.startedAt, row.desktopPid, row.desktopExecutable, row.desktopStartedAt, row.ports[0]]);
}

// Uses the local interactive Desktop worker's measured ACP HTTP/SSE interface.
// It does not create a host, launch an AI CLI, load another session, or approve tools.
export class WorkbuddyAcpClient {
  constructor(port, { timeoutMs = 1800000, onUpdate = () => {} } = {}) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail("Invalid local ACP port");
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.onUpdate = onUpdate;
    this.headers = {};
  }

  open(route, body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const data = body === null ? "" : JSON.stringify(body);
      const request = http.request({ hostname: "127.0.0.1", port: this.port, path: route, method: "POST", headers: {
        "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Content-Length": Buffer.byteLength(data), "x-codebuddy-request": "1", ...this.headers,
      } }, response => resolve({ response, request, timer }));
      const timer = setTimeout(() => request.destroy(new Error("Local ACP request timed out")), timeoutMs);
      request.once("error", error => { clearTimeout(timer); reject(error); });
      request.end(data);
    });
  }

  async connect() {
    const { response, request, timer } = await this.open("/api/v1/acp/connect", null, 15000);
    try {
      if (response.statusCode !== 200) throw fail(`WorkBuddy connect returned HTTP ${response.statusCode}`);
      let text = "";
      for await (const chunk of response) {
        text += chunk.toString("utf8");
        if (Buffer.byteLength(text) > MAX_JSON) throw fail("WorkBuddy connect response is too large");
      }
      const credentials = JSON.parse(text);
      if (typeof credentials.connectionId !== "string" || !credentials.connectionId || typeof credentials.sessionToken !== "string" || !credentials.sessionToken) throw fail("WorkBuddy did not provide a native ACP connection");
      // Temporary credentials stay in this client only, never in receipts or logs.
      this.headers = { "acp-connection-id": credentials.connectionId, "acp-session-token": credentials.sessionToken };
    } finally { clearTimeout(timer); response.destroy(); request.destroy(); }
  }

  async rpc(method, params, id, timeoutMs) {
    const { response, request, timer } = await this.open("/api/v1/acp", { jsonrpc: "2.0", id, method, params }, timeoutMs);
    let reply = "", clipped = false;
    const append = text => {
      if (typeof text !== "string") return;
      const room = MAX_REPLY - reply.length;
      reply += text.slice(0, Math.max(0, room));
      if (text.length > room) clipped = true;
    };
    const event = value => {
      if (!object(value)) throw fail("Invalid ACP event", "unknown");
      if (value.id === id && value.error) throw fail("WorkBuddy returned an ACP error; inspect its native conversation", "failed");
      if (value.id === id && Object.hasOwn(value, "result")) return { done: true, result: value.result };
      const update = value.params?.update ?? value.params;
      if (method === "session/prompt" && value.params?.sessionId && value.params.sessionId !== params.sessionId) throw fail("ACP update belongs to a different native session", "unknown");
      if (update?.sessionUpdate === "agent_message_chunk") append(update.content?.text);
      if (update?.sessionUpdate || value.method === "session/request_permission") this.onUpdate({ awaitingApproval: value.method === "session/request_permission" });
      // These measured terminal event forms are kept distinct from progress.
      if (update?.sessionUpdate === "session_end") return { done: true, result: update };
      return null;
    };
    try {
      if (response.statusCode !== 200) throw fail(`WorkBuddy ACP returned HTTP ${response.statusCode}`, "unknown");
      let buffer = "";
      const decoder = new TextDecoder();
      if (String(response.headers["content-type"]).startsWith("application/json")) {
        for await (const chunk of response) {
          buffer += decoder.decode(chunk, { stream: true });
          if (Buffer.byteLength(buffer) > MAX_JSON) throw fail("ACP response is too large", "unknown");
        }
        buffer += decoder.decode();
        const done = event(JSON.parse(buffer));
        if (done) return { ...done, reply, clipped };
      } else {
        for await (const chunk of response) {
          buffer += decoder.decode(chunk, { stream: true });
          if (Buffer.byteLength(buffer) > MAX_JSON) throw fail("ACP event is too large", "unknown");
          // Normalize CRLF, including boundaries split across network chunks.
          buffer = buffer.replaceAll("\r\n", "\n");
          let index;
          while ((index = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
            const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
            if (!data || data === "[DONE]") continue;
            const done = event(JSON.parse(data));
            if (done) return { ...done, reply, clipped };
          }
        }
      }
      throw fail("ACP stream ended without a matching terminal result; do not resend", "unknown");
    } finally { clearTimeout(timer); response.destroy(); request.destroy(); }
  }

  async initialize() {
    const { result } = await this.rpc("initialize", { protocolVersion: 1, clientInfo: { name: "desktop-team-bridge", version: "1" }, clientCapabilities: {} }, 1, 15000);
    if (result?.protocolVersion !== 1) throw fail("Unsupported WorkBuddy ACP protocol version");
  }

  async prompt(sessionId, text) {
    const outcome = await this.rpc("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, 2, this.timeoutMs);
    const value = outcome.result;
    const reason = value?.stopReason ?? value?.finishReason;
    if (["refusal", "cancelled", "error", "max_tokens"].includes(reason) || ["FAILED", "CANCELLED", "ERROR"].includes(value?.outcome)) return { status: "failed", reply: outcome.reply, replyTruncated: outcome.clipped, stopReason: reason ?? value.outcome };
    if (reason === "end_turn" || reason === "stop" || value?.outcome === "SUCCESS") return { status: "completed", reply: outcome.reply, replyTruncated: outcome.clipped };
    throw fail("Unrecognized ACP terminal result; inspect the native task before continuing", "unknown");
  }
}

export class WorkbuddyDesktop {
  constructor({ profile = path.join(os.homedir(), ".workbuddy"), directory = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "desktop-team", "workbuddy"), platform = process.platform, inspect = inspectWorkbuddyProcesses, activity = readWorkbuddyActivity, client = (port, options) => new WorkbuddyAcpClient(port, options) } = {}) {
    if (!path.isAbsolute(profile) || !path.isAbsolute(directory)) throw fail("WorkBuddy profile and receipt directory must be absolute");
    Object.assign(this, { profile, directory, platform, inspect, activity, client });
    this.active = new Set();
  }

  async discover(cwd) {
    if (this.platform !== "win32") throw fail("WorkBuddy Desktop support is experimental and Windows-only");
    if (!path.isAbsolute(cwd)) throw fail("A verified absolute project directory is required");
    const directory = path.join(this.profile, "sessions");
    let names;
    try { names = fs.readdirSync(directory); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
    if (names.length > 2000) throw fail("WorkBuddy session registry is unexpectedly large");
    const candidates = [];
    for (const name of names.filter(name => /^\d+\.json$/.test(name))) {
      let row;
      try { row = readJson(path.join(directory, name), 65536); } catch { continue; }
      if (row?.kind !== "interactive" || !UUID.test(row.sessionId ?? "") || !Number.isSafeInteger(row.pid) || row.pid <= 0 || String(row.pid) !== name.slice(0, -5) || !sameDirectory(cwd, row.cwd ?? "")) continue;
      candidates.push(row);
    }
    const processes = await this.inspect([...new Set(candidates.map(row => row.pid))]);
    const sessions = [];
    for (const row of candidates) {
      const process = processes.find(process => process.pid === row.pid);
      const identity = processIdentity(process);
      if (!identity) continue;
      sessions.push({ sessionId: row.sessionId.toLowerCase(), cwd: fs.realpathSync.native(row.cwd), pid: row.pid, port: process.ports[0], identity, ...this.activity(this.profile, row.cwd, row.sessionId) });
    }
    // Never pick the newest worker when native ownership is ambiguous.
    return sessions.filter(row => sessions.filter(other => other.sessionId === row.sessionId).length === 1);
  }

  file(requestId) { return path.join(this.directory, `${uuid(requestId, "requestId")}.json`); }
  lock(sessionId) { return path.join(this.directory, `${uuid(sessionId, "sessionId")}.lock`); }

  read(requestId, sender) {
    let record;
    try { record = readJson(this.file(requestId)); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (record.requestId !== requestId.toLowerCase() || record.senderId !== sender.threadId || !sameDirectory(record.cwd, sender.cwd)) throw fail("WorkBuddy receipt belongs to a different sending task or project");
    if (["pending", "submitted"].includes(record.status) && !this.active.has(record.requestId)) return { ...record, status: "unknown", reason: "The original observer is no longer running. Inspect the existing WorkBuddy conversation; this task will not be replayed." };
    return record;
  }

  save(record) {
    const file = this.file(record.requestId), temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try { fs.writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 }); fs.renameSync(temporary, file); }
    finally { fs.rmSync(temporary, { force: true }); }
  }

  async dispatch({ requestId, sessionId, prompt }, sender, { beforeSend = async () => {} } = {}) {
    requestId = uuid(requestId, "requestId"); sessionId = uuid(sessionId, "sessionId");
    if (typeof prompt !== "string" || !prompt.trim() || Buffer.byteLength(prompt) > 60000) throw fail("Task prompt must contain 1 to 60000 UTF-8 bytes");
    const digest = crypto.createHash("sha256").update(JSON.stringify([sessionId, sender.threadId, sender.cwd, prompt])).digest("hex");
    const previous = this.read(requestId, sender);
    if (previous) { if (previous.digest !== digest) throw fail("requestId was already used with a different task"); return previous; }
    const session = (await this.discover(sender.cwd)).find(row => row.sessionId === sessionId);
    if (!session) throw fail("The exact WorkBuddy interactive Desktop session is unavailable or ambiguous; open it in WorkBuddy");
    if (session.state !== "idle") throw fail(`WorkBuddy session is ${session.state}; wait for a confirmed idle state in its native conversation`);
    await beforeSend();
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const lock = this.lock(sessionId);
    try { fs.writeFileSync(lock, JSON.stringify({ requestId }), { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code === "EEXIST") throw fail("A previous WorkBuddy delivery still owns this session; inspect its receipt before sending again"); throw error; }
    const record = { requestId, sessionId, senderId: sender.threadId, cwd: session.cwd, digest, status: "pending", createdAt: new Date().toISOString(), independentReview: "required" };
    try { fs.writeFileSync(this.file(requestId), JSON.stringify(record), { flag: "wx", mode: 0o600 }); }
    catch (error) { fs.unlinkSync(lock); throw error; }
    this.active.add(requestId);
    void this.execute(record, session, prompt, beforeSend);
    return { ...record };
  }

  async execute(record, session, prompt, beforeSend) {
    let submitted = false;
    const update = state => {
      record.status = "submitted";
      if (state.awaitingApproval) record.awaitingApproval = true;
      this.save(record);
    };
    try {
      const client = this.client(session.port, { onUpdate: update });
      await client.connect();
      await client.initialize();
      const current = (await this.discover(session.cwd)).find(row => row.sessionId === session.sessionId);
      if (!current || current.identity !== session.identity || current.state !== "idle") throw fail("WorkBuddy worker identity or activity changed before submission");
      await beforeSend();
      const text = `[Desktop team task ${record.requestId} from Codex ${record.senderId}. Collaborator task; native WorkBuddy permissions remain unchanged. Return evidence and a concise result. Completion still requires the Codex manager's independent review.]\n\n${prompt}`;
      // Persist uncertainty BEFORE the one prompt write, including across crashes.
      record.status = "submitted"; this.save(record); submitted = true;
      Object.assign(record, await client.prompt(record.sessionId, text));
      record.awaitingApproval = false;
    } catch (error) {
      record.status = submitted ? error.deliveryState === "failed" ? "failed" : "unknown" : "failed";
      record.reason = submitted ? "WorkBuddy delivery did not complete reliably. Inspect the exact native task; do not resend." : "WorkBuddy preflight failed; no prompt was sent. Check Desktop version, session activity and native ACP availability.";
    } finally {
      record.finishedAt = new Date().toISOString();
      try { this.save(record); }
      catch { record.status = "unknown"; process.stderr.write("WorkBuddy receipt could not be persisted; inspect its native conversation before further work.\n"); }
      if (record.status === "completed" || record.status === "failed") {
        try { if (readJson(this.lock(record.sessionId)).requestId === record.requestId) fs.unlinkSync(this.lock(record.sessionId)); } catch { /* Keep uncertain ownership locked. */ }
      }
      this.active.delete(record.requestId);
    }
  }
}

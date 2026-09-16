//
// Watches the Agent Desk and starts a Claude Code session when work shows up.
//
// This is the piece that makes "hand it off from your phone and the machine
// starts working" true. MCP is pull-only — the desk cannot reach into a laptop
// and start anything — so something local has to be listening. This is that
// something, and it is deliberately dumb: its whole job is to notice a queued
// job and shell out. It holds no state and makes no decisions about the work.
//
// Idle cost is one parked HTTP request. Unlike a cron recipe it does not wake a
// Claude session to discover there is nothing to do.
//
// The agent it starts is yours to choose — the desk speaks MCP, so anything
// that speaks MCP can work it. `--exec` is a plain shell command; the prompt
// arrives on stdin and in $DOABLE_PROMPT, so you can shape the invocation the
// way your tool wants it.
//
// Settings come from ~/.doable/runner.json, written by `install`.

import { spawn } from "node:child_process";
import * as config from "./config.mjs";

const settings = config.load();
const BASE = settings.base || config.DEFAULT_BASE;
const token = settings.token || process.env.DOABLE_TOKEN;
const cwd = settings.cwd || process.cwd();
const tools = settings.tools || "mcp__doable__*,Read,Glob,Grep,WebFetch,WebSearch";
/// Defaults to Claude Code because that is what most people have, not because
/// the desk needs it. Anything that speaks MCP can work this queue.
const exec =
  settings.exec ||
  process.env.DOABLE_EXEC ||
  `claude -p "$DOABLE_PROMPT" --allowedTools ${JSON.stringify(tools)}`;
const PROMPT = `Check my Doable agent desk.

Call list_jobs. If there is a queued job you can finish on this machine, claim
exactly one, do the work, and submit the result.

- Call report_progress every few minutes while working. If it ever returns
  "aborted", stop immediately and submit nothing.
- Read the workstream brief before starting. It is the context the job title
  leaves out.
- If a job was sent back, its feedback says what to fix. Read it.
- If nothing is queued, or nothing here is something you can do on this machine,
  say so and exit without claiming anything.`;

if (!token) {
  console.error("Not set up. Ask your agent to call setup_runner, then run `install`.");
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

/// True while a session is running. The desk allows one job per machine anyway,
/// so starting a second session would only produce an agent that gets refused.
let busy = false;

function runSession() {
  if (busy) return;
  busy = true;
  log("work on the desk — starting a session");
  // Through a shell so `--exec` can be whatever the user's agent needs. The
  // prompt is handed over twice — on stdin and in the environment — because
  // CLIs disagree about which they prefer, and neither way needs quoting.
  const child = spawn("/bin/sh", ["-c", exec], {
    cwd,
    env: { ...process.env, DOABLE_PROMPT: PROMPT },
    stdio: ["pipe", "inherit", "inherit"],
  });
  child.stdin?.end(PROMPT);
  child.on("exit", (code) => {
    busy = false;
    log(`session exited (${code})`);
  });
  child.on("error", (e) => {
    busy = false;
    log("could not start the agent:", e.message);
  });
}

/// The OAuth handshake only tells the desk which software connected, so every
/// machine running the same tool shows up under the same name. Saying which
/// machine this is restores the point of the heartbeat.
async function announce() {
  try {
    const res = await fetch(`${BASE}/agent/label`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ label: settings.name }),
    });
    if (res.ok) log(`named this machine ${(await res.json()).label}`);
  } catch {
    // Cosmetic. Never worth failing to start over.
  }
}

let version = "";
/// Successful long polls are silent on purpose — one line every 25 seconds
/// would bury everything worth reading. But that makes an outage and a hang
/// look identical in the log, so recovery gets said out loud.
let failing = false;

async function watch() {
  for (;;) {
    try {
      const res = await fetch(`${BASE}/events?v=${encodeURIComponent(version)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.status === 401) {
        log("token rejected — reconnect the agent with `claude mcp add`");
        process.exit(1);
      }
      if (!res.ok) {
        log(`desk answered ${res.status}, retrying in 30s`);
        await sleep(30_000);
        continue;
      }

      if (failing) {
        log("reconnected");
        failing = false;
      }

      const event = await res.json();
      version = event.version;

      // A timeout is the normal case: nothing moved, ask again.
      if (!event.changed) continue;

      const queued = event.desk?.queued ?? [];
      if (queued.length) runSession();
      else log("desk changed but nothing is queued");
    } catch (e) {
      // Sleep, laptop lid, flaky wifi — none of these deserve a crash.
      if (!failing) log("watch failed:", e.message, "— retrying every 15s until it comes back");
      failing = true;
      await sleep(15_000);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

log(`watching ${BASE} — will run \`${exec}\` in ${cwd}`);
await announce();
watch();

#!/usr/bin/env node
//
//   doable-agent-runner install --token dbl_… --cwd ~/code/app --name mac-studio
//   doable-agent-runner watch          run in the foreground
//   doable-agent-runner status
//   doable-agent-runner uninstall
//
// `install` is what the agent runs after calling setup_runner. Everything else
// is for a human who wants to see or undo what it did.

import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, mkdirSync, cpSync, rmSync } from "node:fs";
import { homedir, hostname, platform, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as config from "./config.mjs";

const LABEL = "art.rethinking.doable.runner";
const HERE = fileURLToPath(new URL(".", import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

const command = process.argv[2] || "watch";

switch (command) {
  case "install":
    install();
    break;
  case "watch":
    await import("./watch.mjs");
    break;
  case "status":
    status();
    break;
  case "uninstall":
    uninstall();
    break;
  default:
    console.log("Usage: doable-agent-runner <install|watch|status|uninstall>");
    process.exit(1);
}

function install() {
  const token = arg("token") || config.load().token;
  if (!token) {
    console.error("A token is required. Ask your agent to call setup_runner.");
    process.exit(1);
  }

  const settings = {
    token,
    base: arg("base", config.DEFAULT_BASE),
    cwd: arg("cwd", process.cwd()),
    name: arg("name", hostname().replace(/\.local$/, "")),
    // Deliberately narrow. These sessions run with nobody watching, so the
    // default is what a research or writing job needs, and anything that
    // changes files is opted into rather than assumed.
    tools: arg("tools", "mcp__doable__*,Read,Glob,Grep,WebFetch,WebSearch"),
    exec: arg("exec", ""),
  };

  const path = config.save(settings);
  checkAgentIsReachable(settings);
  const runtime = installRuntime();
  console.log(`Settings written to ${path}`);
  console.log(`Machine name: ${settings.name}`);
  console.log(`Working directory: ${settings.cwd}`);
  console.log(`Tools the unattended session may use: ${settings.tools}`);
  console.log(
    "\nThat tool list is narrow on purpose — no Write, no Edit, no Bash. Re-run with\n" +
      "--tools to widen it once you are comfortable with what gets started here."
  );

  platform() === "darwin" ? installLaunchd(runtime) : installSystemd(runtime);
}

/// launchd and systemd hand a process a minimal PATH, while agent CLIs install
/// into ~/.local/bin or a homebrew or nvm prefix. The runner starts them under a
/// login shell for exactly that reason — but if the command still cannot be
/// found, it is far better to say so now than to fail at 1am with nobody
/// watching and nothing in the log but "command not found".
function checkAgentIsReachable(settings) {
  const command = settings.exec || "claude";
  const binary = command.trim().split(/\s+/)[0];
  const shell = (() => {
    try {
      return userInfo().shell || "/bin/zsh";
    } catch {
      return "/bin/zsh";
    }
  })();
  const found = spawnSync(shell, ["-lc", `command -v ${binary}`], { encoding: "utf8" });
  if (found.status === 0 && found.stdout.trim()) {
    console.log(`Will start: ${found.stdout.trim()}`);
  } else {
    console.log(
      `\nWARNING: could not find \`${binary}\` in your login shell.\n` +
        "The runner will install, but every session it starts will fail. Either install\n" +
        "that command, or re-run with --exec pointing at the right one."
    );
  }
}

/// Copies the runner somewhere stable and returns the entry point to point the
/// service at. Without this the service would reference wherever the installer
/// happened to run from — under npx, a cache directory with no guarantees.
function installRuntime() {
  if (HERE.startsWith(config.RUNTIME)) return join(config.RUNTIME, "cli.mjs");
  rmSync(config.RUNTIME, { recursive: true, force: true });
  mkdirSync(config.RUNTIME, { recursive: true });
  cpSync(HERE, config.RUNTIME, { recursive: true });
  return join(config.RUNTIME, "cli.mjs");
}

function installLaunchd(entry) {
  const dir = join(homedir(), "Library", "LaunchAgents");
  mkdirSync(dir, { recursive: true });
  const plist = join(dir, `${LABEL}.plist`);
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${entry}</string>
    <string>watch</string>
  </array>
  <key>RunAtLoad</key><true/>
  <!-- The watch dies when the lid closes; launchd brings it back on wake. -->
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/doable-runner.log</string>
  <key>StandardErrorPath</key><string>/tmp/doable-runner.log</string>
</dict>
</plist>
`
  );
  // launchd tears a job down asynchronously, so bootstrapping straight after a
  // bootout races it and fails. Retry rather than reporting a failure the user
  // would only have to work around by hand.
  spawnSync("launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`], { stdio: "ignore" });
  let r;
  for (let attempt = 0; attempt < 5; attempt++) {
    r = spawnSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, plist], {
      stdio: attempt === 4 ? "inherit" : "ignore",
    });
    if (r.status === 0) break;
    spawnSync("sleep", ["1"]);
  }
  console.log(
    r.status === 0
      ? `\nRunning. Logs: /tmp/doable-runner.log`
      : `\nWrote ${plist} but could not load it. Start it by hand:\n  launchctl bootstrap gui/$(id -u) ${plist}`
  );
}

function installSystemd(entry) {
  const dir = join(homedir(), ".config", "systemd", "user");
  mkdirSync(dir, { recursive: true });
  const unit = join(dir, "doable-runner.service");
  writeFileSync(
    unit,
    `[Unit]
Description=Doable Agent Desk runner

[Service]
ExecStart=${process.execPath} ${entry} watch
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
`
  );
  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
  const r = spawnSync("systemctl", ["--user", "enable", "--now", "doable-runner"], {
    stdio: "inherit",
  });
  console.log(
    r.status === 0
      ? "\nRunning. Logs: journalctl --user -u doable-runner -f"
      : `\nWrote ${unit} but could not start it:\n  systemctl --user enable --now doable-runner`
  );
}

function status() {
  const settings = config.load();
  if (!settings.token) return console.log("Not set up. Ask your agent to call setup_runner.");
  console.log(`Machine name : ${settings.name}`);
  console.log(`Directory    : ${settings.cwd}`);
  console.log(`Tools        : ${settings.tools}`);
  console.log(`Starts       : ${settings.exec || "claude (default)"}`);
  if (platform() === "darwin") {
    spawnSync("launchctl", ["print", `gui/${process.getuid()}/${LABEL}`], { stdio: "inherit" });
  } else {
    spawnSync("systemctl", ["--user", "status", "doable-runner"], { stdio: "inherit" });
  }
}

function uninstall() {
  if (platform() === "darwin") {
    spawnSync("launchctl", ["bootout", `gui/${process.getuid()}/${LABEL}`], { stdio: "ignore" });
    const plist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
    if (existsSync(plist)) unlinkSync(plist);
  } else {
    spawnSync("systemctl", ["--user", "disable", "--now", "doable-runner"], { stdio: "ignore" });
  }
  rmSync(config.RUNTIME, { recursive: true, force: true });
  console.log(
    "Stopped and removed.\n" +
      `Settings are still at ${config.FILE} — delete it to remove the token, and revoke\n` +
      "this machine from Account & agents in the app."
  );
}

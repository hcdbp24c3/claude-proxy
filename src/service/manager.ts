/**
 * `claude-proxy service` — install / uninstall / start / stop a background
 * daemon that runs the proxy.
 *
 * Linux:   systemd user unit at ~/.config/systemd/user/claude-proxy.service
 * macOS:   launchd plist at ~/Library/LaunchAgents/com.claude-proxy.plist
 * Windows: Task Scheduler entry (best-effort) — for the common case, the
 *          `service start` subcommand just spawns a detached bun process and
 *          writes a pidfile.
 *
 * The "service" abstraction is intentionally narrow: it just needs to keep
 * the proxy running across shell sessions. We never assume the user has
 * systemd, root, or sudo.
 */
import { existsSync, writeFileSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { CONFIG_PATH, DEFAULT_BIND, DEFAULT_PORT, loadConfig } from "../config/config.ts";

type Action = "install" | "uninstall" | "start" | "stop" | "status";

const PIDFILE = (): string => join(homedir(), ".claude-proxy", "claude-proxy.pid");
const LOGFILE = (): string => join(homedir(), ".claude-proxy", "claude-proxy.log");

export async function runService(action: Action): Promise<void> {
  if (platform() === "linux") {
    if (action === "install") return installLinux();
    if (action === "uninstall") return uninstallLinux();
  } else if (platform() === "darwin") {
    if (action === "install") return installMac();
    if (action === "uninstall") return uninstallMac();
  } else if (platform() === "win32") {
    if (action === "install") return installWindows();
    if (action === "uninstall") return uninstallWindows();
  }
  // start/stop/status are platform-agnostic.
  if (action === "start") return startBackground();
  if (action === "stop") return stopBackground();
  if (action === "status") return statusBackground();
  throw new Error(`unsupported action ${action}`);
}

/* ---------------------- Linux systemd user unit ----------------------- */

function linuxUnitPath(): string {
  return join(homedir(), ".config", "systemd", "user", "claude-proxy.service");
}
function installLinux(): void {
  const cfg = loadConfig();
  const port = cfg.port ?? DEFAULT_PORT;
  const bind = cfg.bind ?? DEFAULT_BIND;
  const exec = process.execPath;
  const unit = `[Unit]
Description=claude-proxy — universal Claude-compatible proxy
After=network-online.target

[Service]
Type=simple
ExecStart=${exec} ${join(import.meta.dir, "..", "cli.ts")} serve --port ${port} --bind ${bind}
Environment=CLAUDE_PROXY_CONFIG=${CONFIG_PATH()}
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=default.target
`;
  mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
  writeFileSync(linuxUnitPath(), unit, "utf8");
  spawn("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  spawn("systemctl", ["--user", "enable", "--now", "claude-proxy.service"], { stdio: "inherit" });
  process.stdout.write(`installed + started ${linuxUnitPath()}\n`);
}
function uninstallLinux(): void {
  if (!existsSync(linuxUnitPath())) {
    process.stdout.write("not installed\n");
    return;
  }
  spawn("systemctl", ["--user", "disable", "--now", "claude-proxy.service"], { stdio: "inherit" });
  unlinkSync(linuxUnitPath());
  spawn("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  process.stdout.write("uninstalled\n");
}

/* ---------------------- macOS launchd agent ---------------------- */

function macPlistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", "com.claude-proxy.plist");
}
function installMac(): void {
  const cfg = loadConfig();
  const port = cfg.port ?? DEFAULT_PORT;
  const bind = cfg.bind ?? DEFAULT_BIND;
  const exec = process.execPath;
  const cliPath = join(import.meta.dir, "..", "cli.ts");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.claude-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>${exec}</string>
    <string>${cliPath}</string>
    <string>serve</string>
    <string>--port</string><string>${port}</string>
    <string>--bind</string><string>${bind}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>CLAUDE_PROXY_CONFIG</key><string>${CONFIG_PATH()}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOGFILE()}</string>
  <key>StandardErrorPath</key><string>${LOGFILE()}</string>
</dict></plist>
`;
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(macPlistPath(), plist, "utf8");
  spawn("launchctl", ["load", "-w", macPlistPath()], { stdio: "inherit" });
  process.stdout.write(`installed + loaded ${macPlistPath()}\n`);
}
function uninstallMac(): void {
  if (!existsSync(macPlistPath())) {
    process.stdout.write("not installed\n");
    return;
  }
  spawn("launchctl", ["unload", "-w", macPlistPath()], { stdio: "inherit" });
  unlinkSync(macPlistPath());
  process.stdout.write("uninstalled\n");
}

/* ---------------------- Windows ---------------------- */

function installWindows(): void {
  // Best-effort: register a Run-key entry that launches a hidden bun process.
  // Use the cross-platform pidfile-based start as a fallback.
  process.stdout.write("Windows service install: using detached background process (pidfile in ~/.claude-proxy/claude-proxy.pid)\n");
  startBackground();
}
function uninstallWindows(): void {
  stopBackground();
}

/* ---------------------- cross-platform start/stop ---------------------- */

function startBackground(): void {
  const cfg = loadConfig();
  const port = cfg.port ?? DEFAULT_PORT;
  const bind = cfg.bind ?? DEFAULT_BIND;
  const cliPath = join(import.meta.dir, "..", "cli.ts");
  const out = require("node:fs").openSync(LOGFILE(), "a");
  const err = require("node:fs").openSync(LOGFILE(), "a");
  const child = spawn(process.execPath, [cliPath, "serve", "--port", String(port), "--bind", bind], {
    detached: true,
    stdio: ["ignore", out, err],
    env: { ...process.env, CLAUDE_PROXY_CONFIG: CONFIG_PATH() },
  });
  child.unref();
  writeFileSync(PIDFILE(), String(child.pid), "utf8");
  process.stdout.write(`started pid ${child.pid}, log ${LOGFILE()}\n`);
}

function stopBackground(): void {
  const p = PIDFILE();
  if (!existsSync(p)) {
    process.stdout.write("no background process\n");
    return;
  }
  const pid = Number(readFileSync(p, "utf8"));
  if (!Number.isFinite(pid)) {
    unlinkSync(p);
    process.stdout.write("stale pidfile removed\n");
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    process.stdout.write(`stopped pid ${pid}\n`);
  } catch (e) {
    process.stderr.write(`kill ${pid} failed: ${(e as Error).message}\n`);
  }
  unlinkSync(p);
}

async function statusBackground(): Promise<void> {
  const p = PIDFILE();
  if (!existsSync(p)) {
    process.stdout.write("not running (no pidfile)\n");
    return;
  }
  const pid = Number(readFileSync(p, "utf8"));
  try {
    process.kill(pid, 0);
    process.stdout.write(`running (pid ${pid})\n`);
  } catch {
    process.stdout.write(`not running (stale pidfile for ${pid})\n`);
  }
}

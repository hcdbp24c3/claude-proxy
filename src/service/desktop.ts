/**
 * `claude-proxy desktop install` wires Claude Code (or Claude Desktop) to
 * this proxy by writing the right env / managed config.
 *
 *   Claude Code:    `~/.claude/settings.json`   -> { env: { ANTHROPIC_BASE_URL, ... } }
 *   Claude Desktop: `~/.config/Claude-3p/configLibrary/<id>.json`  (3P managed settings)
 *
 * For Claude Desktop, we use the in-app configuration library path. It is
 * scoped per-user and survives relaunches.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig, DEFAULT_BIND, DEFAULT_PORT } from "../config/config.ts";

type Target = "claude-code" | "claude-desktop";

export function desktopInstall(target: Target): void {
  if (target === "claude-code") return installClaudeCode();
  if (target === "claude-desktop") return installClaudeDesktop();
  throw new Error(`unknown target: ${target}`);
}

export function desktopUninstall(target: Target): void {
  if (target === "claude-code") return uninstallClaudeCode();
  if (target === "claude-desktop") return uninstallClaudeDesktop();
  throw new Error(`unknown target: ${target}`);
}

function installClaudeCode(): void {
  const cfg = loadConfig();
  const host = `${cfg.bind ?? DEFAULT_BIND}:${cfg.port ?? DEFAULT_PORT}`;
  const settingsPath = join(homedir(), ".claude", "settings.json");
  mkdirSync(join(homedir(), ".claude"), { recursive: true });
  let existing: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try { existing = JSON.parse(readFileSync(settingsPath, "utf8")); } catch { /* replace */ }
  }
  const env = (existing.env && typeof existing.env === "object" ? existing.env : {}) as Record<string, string>;
  env.ANTHROPIC_BASE_URL = `http://${host}`;
  env.ANTHROPIC_AUTH_TOKEN = env.ANTHROPIC_AUTH_TOKEN ?? "claude-proxy";
  // No model is forced — let user pick from /v1/models.
  existing.env = env;
  writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + "\n", "utf8");
  process.stdout.write(`wrote ${settingsPath}\n`);
  process.stdout.write(`  ANTHROPIC_BASE_URL=http://${host}\n`);
}

function uninstallClaudeCode(): void {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  if (!existsSync(settingsPath)) {
    process.stdout.write("no Claude Code settings file to update\n");
    return;
  }
  try {
    const j = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    const env = (j.env && typeof j.env === "object" ? j.env : {}) as Record<string, unknown>;
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
    j.env = env;
    writeFileSync(settingsPath, JSON.stringify(j, null, 2) + "\n", "utf8");
    process.stdout.write(`cleared ANTHROPIC_BASE_URL in ${settingsPath}\n`);
  } catch (e) {
    process.stderr.write(`failed: ${(e as Error).message}\n`);
  }
}

function installClaudeDesktop(): void {
  const cfg = loadConfig();
  const host = `${cfg.bind ?? DEFAULT_BIND}:${cfg.port ?? DEFAULT_PORT}`;
  const dir = join(homedir(), ".config", "Claude-3p", "configLibrary");
  mkdirSync(dir, { recursive: true });
  // Pick a stable id; clobber any prior claude-proxy entry to keep things idempotent.
  const id = "claude-proxy";
  const meta = join(dir, "_meta.json");
  let current: { activeConfig?: string } = {};
  if (existsSync(meta)) {
    try { current = JSON.parse(readFileSync(meta, "utf8")); } catch { /* ignore */ }
  }
  if (current.activeConfig && current.activeConfig !== id) {
    const other = join(dir, `${current.activeConfig}.json`);
    if (existsSync(other)) unlinkSync(other);
  }
  current.activeConfig = id;
  writeFileSync(meta, JSON.stringify(current, null, 2) + "\n", "utf8");
  const settings = {
    inferenceProvider: "gateway",
    inferenceGatewayBaseUrl: `http://${host}`,
    inferenceGatewayApiKey: "claude-proxy",
    inferenceGatewayAuthScheme: "bearer",
    inferenceCustomHeaders: { "X-Proxy-Via": "claude-proxy" },
  };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(settings, null, 2) + "\n", "utf8");
  process.stdout.write(`wrote ${join(dir, `${id}.json`)}\n`);
  process.stdout.write(`  inferenceGatewayBaseUrl=http://${host}\n`);
  process.stdout.write(`Restart Claude Desktop for the change to take effect.\n`);
}

function uninstallClaudeDesktop(): void {
  const dir = join(homedir(), ".config", "Claude-3p", "configLibrary");
  if (!existsSync(dir)) {
    process.stdout.write("no Claude Desktop config library to update\n");
    return;
  }
  const file = join(dir, "claude-proxy.json");
  if (existsSync(file)) unlinkSync(file);
  const meta = join(dir, "_meta.json");
  if (existsSync(meta)) {
    try {
      const j = JSON.parse(readFileSync(meta, "utf8")) as Record<string, unknown>;
      if (j.activeConfig === "claude-proxy") delete j.activeConfig;
      writeFileSync(meta, JSON.stringify(j, null, 2) + "\n", "utf8");
    } catch { /* ignore */ }
  }
  process.stdout.write(`removed claude-proxy config from Claude Desktop\n`);
}

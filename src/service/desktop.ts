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
  // Wire every env var that Claude Code needs to use this proxy.
  // Claude Code reads `env` from the user-scope settings.json on every launch,
  // so this is enough to make `claude` pick up the proxy without `export`-ing
  // anything in the shell.
  env.ANTHROPIC_BASE_URL = `http://${host}`;
  env.ANTHROPIC_AUTH_TOKEN = env.ANTHROPIC_AUTH_TOKEN ?? "claude-proxy";
  // Suppress the "model isn't described by this version's model catalog"
  // warning — every alias on the proxy is technically unknown to Claude
  // Code, but the proxy translates correctly.
  env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = "1";
  // The 200K context-window assumption breaks for some upstream models; this
  // restores the previous "wait for the API" behavior so a too-long request
  // is surfaced instead of being silently retried at the wrong size.
  env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
  // Use a small default background model so compact tasks don't all need
  // a paid Claude slot. Use the first registered alias if it has "haiku"
  // in the name, otherwise skip this — pointing HAIKU at a non-Anthropic
  // model makes Claude Code error out at every compact call.
  if (!env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
    const haikuAlias = cfg.models.find((m) => /haiku/i.test(m.name));
    if (haikuAlias) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = haikuAlias.name;
  }
  existing.env = env;

  // Set the default model. When the user runs /model, the picker is
  // anchored to this name. Don't pin to a built-in claude-* model — most
  // non-Anthropic upstreams don't serve them, and Claude Code errors out
  // hard when the default model isn't recognized upstream. Use the first
  // registered alias instead; if none, fall back to the "haiku" alias.
  if (!existing.model) {
    if (cfg.models.length > 0) {
      const firstAlias = cfg.models[0]!;
      existing.model = firstAlias.name;
    } else {
      existing.model = "haiku";
    }
  }

  // Build a `modelPicker` lineup from the current proxy config so the
  // /model picker shows every alias registered in the proxy. We only
  // add aliases whose names already contain "claude" or "anthropic" so
  // the picker's filter (which keeps entries with those substrings) does
  // not silently drop them; for everything else, the user can still
  // switch with `claude --model <name>`.
  const anthropicNamed = cfg.models.filter((m) => /claude|anthropic/i.test(m.name));
  if (anthropicNamed.length > 0) {
    const anchor = (typeof existing.model === "string" && /claude|anthropic/i.test(existing.model))
      ? existing.model
      : anthropicNamed[0]!.name;
    existing.modelPicker = {
      // `options` is the schema name. Each row is { model, label?, description? }.
      // Claude Code merges this list with the built-in lineup.
      options: [
        { model: anchor, label: "Default", description: "Default for new sessions" },
        ...anthropicNamed
          .filter((m) => m.name !== anchor)
          .slice(0, 8)
          .map((m) => ({
            // Don't double-prefix when the alias already starts with claude-/
            // anthropic-; the router strips one prefix back off on inbound.
            model: /^(claude|anthropic)-/i.test(m.name) ? m.name : `claude-${m.name}`,
            label: m.label ?? m.name,
            description: `routed via claude-proxy → ${m.name}`,
          })),
      ],
    };
  }

  writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + "\n", "utf8");
  process.stdout.write(`wrote ${settingsPath}\n`);
  process.stdout.write(`  ANTHROPIC_BASE_URL=http://${host}\n`);
  process.stdout.write(`  default model=${String(existing.model)}\n`);
  process.stdout.write(`  modelPicker: ${anthropicNamed.length} alias(es) registered\n`);
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
    delete env.CLAUDE_CODE_USE_GATEWAY;
    delete env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY;
    delete env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT;
    delete env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS;
    j.env = env;
    writeFileSync(settingsPath, JSON.stringify(j, null, 2) + "\n", "utf8");
    process.stdout.write(`cleared claude-proxy env in ${settingsPath}\n`);
  } catch (e) {
    process.stderr.write(`failed: ${(e as Error).message}\n`);
  }
}

/* ----------------------------- shell RC --------------------------------- */

/**
 * Append (or rewrite) `export` lines for the proxy into a shell rc file.
 * Idempotent: re-running won't duplicate the block.
 */
function appendToShellRc(rcPath: string, lines: string[]): void {
  const home = homedir();
  const path = rcPath.startsWith("~") ? join(home, rcPath.slice(2)) : rcPath;
  let existing = "";
  if (existsSync(path)) existing = readFileSync(path, "utf8");
  // Strip any prior claude-proxy block so we don't duplicate.
  const stripped = existing.replace(/\n?# >>> claude-proxy >>>[\s\S]*?# <<< claude-proxy <<<\n?/g, "\n").trimEnd();
  const block = [
    "",
    "# >>> claude-proxy >>>",
    "# Managed by claude-proxy `shell install`. Safe to edit; the next install",
    "# rewrites this block in place.",
    ...lines,
    "# <<< claude-proxy <<<",
    "",
  ].join("\n");
  writeFileSync(path, stripped + block + "\n", "utf8");
}

function removeFromShellRc(rcPath: string): void {
  const home = homedir();
  const path = rcPath.startsWith("~") ? join(home, rcPath.slice(2)) : rcPath;
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  const cleaned = content.replace(/\n?# >>> claude-proxy >>>[\s\S]*?# <<< claude-proxy <<<\n?/g, "\n").trim() + "\n";
  writeFileSync(path, cleaned, "utf8");
}

function detectShells(): { name: string; rcPath: string; exportLine: (host: string) => string }[] {
  const home = homedir();
  const host = `${loadConfig().bind ?? DEFAULT_BIND}:${loadConfig().port ?? DEFAULT_PORT}`;
  if (process.platform === "win32") {
    return [
      {
        name: "PowerShell",
        rcPath: "~/Documents/PowerShell/Microsoft.PowerShell_profile.ps1",
        exportLine: (h) => `$env:ANTHROPIC_BASE_URL = "http://${h}"`,
      },
      {
        name: "PowerShell (legacy)",
        rcPath: "~/Documents/WindowsPowerShell/Microsoft.PowerShell_profile.ps1",
        exportLine: (h) => `$env:ANTHROPIC_BASE_URL = "http://${h}"`,
      },
    ];
  }
  const shells: { name: string; rcPath: string; exportLine: (h: string) => string }[] = [];
  if (existsSync(join(home, ".zshrc"))) {
    shells.push({ name: "zsh", rcPath: "~/.zshrc", exportLine: (h) => `export ANTHROPIC_BASE_URL="http://${h}"` });
  }
  if (existsSync(join(home, ".bashrc"))) {
    shells.push({ name: "bash", rcPath: "~/.bashrc", exportLine: (h) => `export ANTHROPIC_BASE_URL="http://${h}"` });
  }
  if (existsSync(join(home, ".config/fish/config.fish"))) {
    shells.push({ name: "fish", rcPath: "~/.config/fish/config.fish", exportLine: (h) => `set -gx ANTHROPIC_BASE_URL "http://${h}"` });
  }
  if (shells.length === 0) {
    // Default to .bashrc so the user has something to source.
    shells.push({ name: "bash", rcPath: "~/.bashrc", exportLine: (h) => `export ANTHROPIC_BASE_URL="http://${h}"` });
  }
  void host;
  return shells;
}

export function shellInstall(): void {
  const cfg = loadConfig();
  const host = `${cfg.bind ?? DEFAULT_BIND}:${cfg.port ?? DEFAULT_PORT}`;
  const lines = [
    `export ANTHROPIC_BASE_URL="http://${host}"`,
    `export ANTHROPIC_AUTH_TOKEN="claude-proxy"`,
    `export CLAUDE_CODE_USE_GATEWAY=1`,
    `export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`,
    `export CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1`,
    `export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`,
  ];
  for (const sh of detectShells()) {
    try {
      const fullLines = process.platform === "win32"
        ? lines.map((l) => l.replace(/^export ([A-Z_]+)=(.+)$/, "$$env:$1 = $2"))
        : sh.exportLine(host).startsWith("set ")
          ? [
              `set -gx ANTHROPIC_BASE_URL "http://${host}"`,
              `set -gx ANTHROPIC_AUTH_TOKEN "claude-proxy"`,
              `set -gx CLAUDE_CODE_USE_GATEWAY 1`,
              `set -gx CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY 1`,
              `set -gx CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT 1`,
              `set -gx CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS 1`,
            ]
          : [
              `export ANTHROPIC_BASE_URL="http://${host}"`,
              `export ANTHROPIC_AUTH_TOKEN="claude-proxy"`,
              `export CLAUDE_CODE_USE_GATEWAY=1`,
              `export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`,
              `export CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1`,
              `export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`,
            ];
      appendToShellRc(sh.rcPath, fullLines);
      process.stdout.write(`wrote ${sh.rcPath} (${sh.name})\n`);
    } catch (e) {
      process.stderr.write(`failed ${sh.name}: ${(e as Error).message}\n`);
    }
  }
  process.stdout.write(`\nReload your shell or run: source ~/.bashrc (or equivalent)\n`);
}

export function shellUninstall(): void {
  for (const sh of detectShells()) {
    try {
      removeFromShellRc(sh.rcPath);
      process.stdout.write(`cleaned ${sh.rcPath} (${sh.name})\n`);
    } catch (e) {
      process.stderr.write(`failed ${sh.name}: ${(e as Error).message}\n`);
    }
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

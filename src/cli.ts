#!/usr/bin/env bun
/**
 * `claude-proxy` CLI.
 *
 *   claude-proxy init                 Interactive setup
 *   claude-proxy serve                Run proxy + dashboard (foreground)
 *   claude-proxy start                Alias for serve
 *   claude-proxy stop                 Stop background daemon
 *   claude-proxy status               Show proxy status
 *   claude-proxy doctor               Diagnose config + upstream reachability
 *   claude-proxy models list          List configured model aliases
 *   claude-proxy models add ...       Register a new alias
 *   claude-proxy models remove <name> Delete an alias
 *   claude-proxy models discover      Pull live model list from a provider
 *   claude-proxy provider add ...     Register a new provider
 *   claude-proxy provider list        List configured providers
 *   claude-proxy provider remove <id> Delete a provider
 *   claude-proxy doctor               Show setup status
 *   claude-proxy env                  Print export lines for shell setup
 */
import { loadConfig, saveConfig, updateConfig, upsertProvider, upsertModel, removeModel, removeProvider, resolveApiKey, CONFIG_PATH, DEFAULT_PORT, DEFAULT_BIND } from "./config/config.ts";
import { startProxyServer } from "./server.ts";
import { fetchModelList } from "./discovery/models.ts";
import { resolveProviders } from "./router.ts";
import { isatty } from "node:tty";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { platform } from "node:os";
import { desktopInstall, desktopUninstall } from "./service/desktop.ts";
import { runService } from "./service/manager.ts";
import { runTUI } from "./tui.ts";
import type { AppConfig, ModelAlias, ProviderConfig } from "./types.ts";

const HELP = `claude-proxy — universal Claude-compatible proxy

Usage:
  claude-proxy serve [--listen-port N] [--bind ADDR]
  claude-proxy tui
  claude-proxy init [--provider <id> --base-url <url> --api-key-env <env>]
  claude-proxy port-info [--port N]
  claude-proxy status
  claude-proxy doctor
  claude-proxy stop
  claude-proxy env
  claude-proxy desktop <install|uninstall> [--target <claude-code|claude-desktop>]
  claude-proxy service <install|uninstall|start|stop|status>

  claude-proxy models list
  claude-proxy models add --name <alias> --provider <id> --model-id <upstream-id> [--label <text>]
  claude-proxy models remove <alias>
  claude-proxy models discover --provider <id>

  claude-proxy provider list
  claude-proxy provider add --id <id> --type <openai|anthropic> --base-url <url> [--api-key <key>] [--api-key-env <env>] [--label <text>]
  claude-proxy provider remove <id>

Config: ${CONFIG_PATH()}
Default listen: ${DEFAULT_BIND}:${DEFAULT_PORT}
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "-h" || argv[0] === "--help") {
    process.stdout.write(HELP);
    return;
  }
  const [cmd, sub, ...rest] = argv;
  switch (cmd) {
    case "serve": case "start": return cmdServe(rest);
    case "tui": case "ui": return cmdTui();
    case "stop": return cmdStop();
    case "port-info": return cmdPortInfo(rest);
    case "status": return cmdStatus();
    case "doctor": return cmdDoctor();
    case "init": return cmdInit(argv.slice(1));
    case "env": return cmdEnv();
    case "desktop":
      if (sub === "install") return cmdDesktopInstall(rest);
      if (sub === "uninstall") return cmdDesktopUninstall(rest);
      return die(`unknown desktop subcommand: ${sub ?? ""}`);
    case "service":
      if (!sub) return die("service requires: install|uninstall|start|stop|status");
      return Promise.resolve(cmdService(sub));
    case "models":
      if (sub === "list") return cmdModelsList();
      if (sub === "add") return cmdModelsAdd(rest);
      if (sub === "remove" || sub === "rm") return cmdModelsRemove(rest);
      if (sub === "discover") return cmdModelsDiscover(rest);
      return die(`unknown models subcommand: ${sub ?? ""}`);
    case "provider": case "providers":
      if (sub === "list") return cmdProvidersList();
      if (sub === "add") return cmdProvidersAdd(rest);
      if (sub === "remove" || sub === "rm") return cmdProvidersRemove(rest);
      return die(`unknown provider subcommand: ${sub ?? ""}`);
    default: return die(`unknown command: ${cmd}`);
  }
}

/* ----------------------------- desktop / service ----------------------------- */

function cmdTui(): Promise<void> {
  return runTUI();
}

async function cmdPortInfo(argv: string[]): Promise<void> {
  const opts = parseFlags(argv);
  const port = Number(opts["listen-port"] ?? opts.port ?? process.env.PORT ?? 8765);
  const cmd = platform() === "win32" ? `netstat -ano | findstr :${port}` : `lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null || ss -lntp 'sport = :${port}' 2>/dev/null`;
  process.stdout.write(`Looking for process listening on port ${port}…\n`);
  process.stdout.write(`Command: ${cmd}\n\n`);
  try {
    const { spawn } = await import("node:child_process");
    const child = spawn(cmd, { shell: true, stdio: "inherit" });
    await new Promise<void>((resolve) => {
      const { promise, resolve: r } = Promise.withResolvers<void>();
      child.on("close", () => r());
      resolve(promise);
    });
  } catch (e) {
    process.stderr.write(`Failed: ${(e as Error).message}\n`);
  }
}

function cmdDesktopInstall(argv: string[]): void {
  const opts = parseFlags(argv);
  const target = (opts.target as string) ?? "claude-code";
  desktopInstall(target as "claude-code" | "claude-desktop");
}

function cmdDesktopUninstall(argv: string[]): void {
  const opts = parseFlags(argv);
  const target = (opts.target as string) ?? "claude-code";
  desktopUninstall(target as "claude-code" | "claude-desktop");
}

async function cmdService(action: string): Promise<void> {
  await runService(action as Parameters<typeof runService>[0]);
}

async function cmdServe(argv: string[]): Promise<void> {
  const opts = parseFlags(argv);
  const config = loadConfig();
  // Accept both --port (legacy) and --listen-port (avoids Bun's runtime flag).
  const portArg = opts["listen-port"] ?? opts.port;
  if (portArg) config.port = Number(portArg);
  if (opts.bind) config.bind = String(opts.bind);
  const port = config.port ?? DEFAULT_PORT;
  const bind = config.bind ?? DEFAULT_BIND;
  if (await probeBusy(bind, port)) {
    process.stderr.write(`fatal: port ${port} on ${bind} is already in use.\n`);
    process.stderr.write(`\nRun \`claude-proxy port-info --listen-port ${port}\` to see which process is listening.\n`);
    process.stderr.write(`Or pick a different port: \`claude-proxy serve --listen-port ${port + 1}\`\n`);
    process.exit(1);
  }
  const server = await startProxyServer(config);
  const shutdown = () => {
    server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // First-run convenience: wire Claude Code's env vars so the user can
  // just run `claude` after the proxy comes up. Skip if the env already
  // points at a different proxy.
  if (!process.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL.includes("127.0.0.1:" + port)) {
    try {
      desktopInstall("claude-code");
    } catch (e) {
      process.stderr.write(`(could not auto-wire Claude Code: ${(e as Error).message})\n`);
    }
  }
  process.stdout.write(`listening on http://${config.bind ?? DEFAULT_BIND}:${server.port}\n`);
  process.stdout.write(`dashboard:  http://${config.bind ?? DEFAULT_BIND}:${server.port}/\n`);
  process.stdout.write(`env:        ANTHROPIC_BASE_URL=http://${config.bind ?? DEFAULT_BIND}:${server.port}\n`);

  // Run forever.
  await new Promise<never>(() => {});
}

async function probeBusy(host: string, port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://${host}:${port}/healthz`, { signal: AbortSignal.timeout(500) });
    return r.status < 500;
  } catch {
    return false;
  }
}

async function cmdStop(): Promise<void> {
  const pidFile = pidFilePath();
  if (!existsSync(pidFile)) {
    process.stdout.write("no daemon running\n");
    return;
  }
  const pid = Number(readFileSync(pidFile, "utf8"));
  if (!Number.isFinite(pid)) {
    unlinkSync(pidFile);
    process.stdout.write("stale pidfile removed\n");
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    process.stdout.write(`stopped pid ${pid}\n`);
    unlinkSync(pidFile);
  } catch (e) {
    process.stderr.write(`failed to stop pid ${pid}: ${(e as Error).message}\n`);
  }
}

async function cmdStatus(): Promise<void> {
  const config = loadConfig();
  const port = config.port ?? DEFAULT_PORT;
  const bind = config.bind ?? DEFAULT_BIND;
  const url = `http://${bind}:${port}`;
  try {
    const res = await fetch(`${url}/healthz`);
    if (res.ok) {
      process.stdout.write(`proxy: UP at ${url}\n`);
    } else {
      process.stdout.write(`proxy: UNHEALTHY at ${url} (status ${res.status})\n`);
    }
  } catch {
    process.stdout.write(`proxy: DOWN at ${url}\n`);
  }
  process.stdout.write(`providers: ${config.providers.length}\n`);
  process.stdout.write(`models:    ${config.models.length}\n`);
}

async function cmdDoctor(): Promise<void> {
  const config = loadConfig();
  const port = config.port ?? DEFAULT_PORT;
  const bind = config.bind ?? DEFAULT_BIND;
  const url = `http://${bind}:${port}`;
  process.stdout.write(`Config: ${CONFIG_PATH()}\n`);
  process.stdout.write(`Listen: ${url}\n`);
  process.stdout.write(`Providers: ${config.providers.length}\n`);
  for (const p of config.providers) {
    process.stdout.write(`  - ${p.id} (${p.type}) -> ${p.baseUrl}\n`);
  }
  process.stdout.write(`Models: ${config.models.length}\n`);
  for (const m of config.models) {
    process.stdout.write(`  - ${m.name} -> ${m.provider}/${m.modelId}\n`);
  }
  process.stdout.write("\nHealth check:\n");
  try {
    const res = await fetch(`${url}/healthz`);
    process.stdout.write(res.ok ? "  /healthz: ok\n" : `  /healthz: status ${res.status}\n`);
  } catch (e) {
    process.stdout.write(`  /healthz: unreachable (${(e as Error).message})\n`);
  }
  process.stdout.write("\nUpstream reachability:\n");
  for (const p of resolveProviders(config)) {
    try {
      const t = Date.now();
      const ids = await fetchModelList(p);
      process.stdout.write(`  ${p.id} (${p.type}): ${ids.length} models reachable in ${Date.now() - t}ms\n`);
    } catch (e) {
      process.stdout.write(`  ${p.id} (${p.type}): ERROR ${(e as Error).message}\n`);
    }
  }
}

async function cmdInit(argv: string[]): Promise<void> {
  const opts = parseFlags(argv);
  const config = loadConfig();
  if (opts.provider && opts["base-url"] && opts["api-key-env"]) {
    const provider: ProviderConfig = {
      id: String(opts.provider),
      type: (opts.type as string) === "anthropic" ? "anthropic" : "openai",
      baseUrl: String(opts["base-url"]),
      apiKeyEnv: String(opts["api-key-env"]),
      apiKey: opts["api-key"] ? String(opts["api-key"]) : undefined,
      label: opts.label ? String(opts.label) : undefined,
    };
    upsertProvider(provider);
    process.stdout.write(`wrote provider ${provider.id}\n`);
    // Auto-fetch live models and add them all as aliases (no alias-name prompts).
    // The user can later remove or rename any alias via `claude-proxy tui`.
    if (!opts["skip-discover"]) {
      try {
        const ids = await fetchModelList({
          ...provider,
          resolvedApiKey: resolveApiKey({ ...provider, apiKey: provider.apiKey ?? "" }),
        });
        if (ids.length > 0) {
          for (const id of ids) {
            upsertModel({ name: id, provider: provider.id, modelId: id });
          }
          process.stdout.write(`discovered ${ids.length} model(s) from ${provider.baseUrl} and registered as aliases:\n`);
          for (const id of ids) process.stdout.write(`  - ${id}\n`);
        } else {
          process.stdout.write(`upstream returned 0 models. Add aliases manually with \`claude-proxy models add\` or via \`claude-proxy tui\`.\n`);
        }
      } catch (e) {
        process.stderr.write(`discovery failed: ${(e as Error).message}\n`);
        if (opts["model-id"]) {
          // Fall back to a single explicit alias if user passed --model-id.
          upsertModel({
            name: String(opts.provider),
            provider: provider.id,
            modelId: String(opts["model-id"]),
            label: opts.label ? String(opts.label) : undefined,
          });
          process.stdout.write(`registered explicit alias ${opts.provider} -> ${opts["model-id"]}\n`);
        }
      }
    } else if (opts["model-id"]) {
      upsertModel({
        name: String(opts.provider),
        provider: provider.id,
        modelId: String(opts["model-id"]),
        label: opts.label ? String(opts.label) : undefined,
      });
    }
    process.stdout.write(`\nConfig: ${CONFIG_PATH()}\n`);
    process.stdout.write(`\nNext: \`claude-proxy serve\` to start the proxy.\n`);
    process.stdout.write(`Then run \`claude-proxy desktop install --target claude-code\` to wire Claude Code CLI automatically.\n`);
    return;
  }
  // Interactive fallback.
  if (!isatty(0)) die("init needs --provider/--base-url/--api-key-env in non-interactive mode");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => {
    const { promise, resolve } = Promise.withResolvers<string>();
    rl.question(q, resolve);
    return promise;
  };
  const id = await ask("Provider id (e.g. openrouter): ");
  if (!id.trim()) die("provider id is required");
  const type = (await ask("Provider type (openai|anthropic) [openai]: ")) || "openai";
  const baseUrl = await ask("Base URL: ");
  if (!baseUrl.trim()) die("base URL is required");
  process.stdout.write("\nAPI key: enter an env var name (recommended), paste the key directly, or leave empty.\n");
  const apiKeyInput = await ask("> ");
  let apiKey: string | undefined;
  let apiKeyEnv: string | undefined;
  if (apiKeyInput.trim().length === 0) {
    // no key
  } else if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(apiKeyInput.trim())) {
    apiKeyEnv = apiKeyInput.trim();
  } else {
    apiKey = apiKeyInput.trim();
  }
  rl.close();
  const providerConfig: ProviderConfig = {
    id: id.trim(),
    type: type as ProviderConfig["type"],
    baseUrl: baseUrl.trim(),
    apiKey,
    apiKeyEnv,
  };
  upsertProvider(providerConfig);
  process.stdout.write(`wrote provider ${id.trim()}\n`);
  // Auto-discover
  try {
    const resolved = { ...providerConfig, resolvedApiKey: resolveApiKey({ ...providerConfig, apiKey: providerConfig.apiKey ?? "" }) };
    const ids = await fetchModelList(resolved);
    if (ids.length > 0) {
      for (const modelId of ids) {
        upsertModel({ name: modelId, provider: id.trim(), modelId });
      }
      process.stdout.write(`discovered ${ids.length} model(s), registered as aliases:\n`);
      for (const modelId of ids) process.stdout.write(`  - ${modelId}\n`);
    } else {
      process.stdout.write(`upstream returned 0 models. Add aliases with \`claude-proxy models add\` or \`claude-proxy tui\`.\n`);
    }
  } catch (e) {
    process.stderr.write(`discovery failed: ${(e as Error).message}\n`);
    process.stdout.write(`add aliases manually: \`claude-proxy models add --name <alias> --provider ${id.trim()} --model-id <upstream-id>\`\n`);
  }
  process.stdout.write(`\nConfig: ${CONFIG_PATH()}\n`);
  process.stdout.write(`\nNext: \`claude-proxy serve\` to start, then \`claude-proxy desktop install --target claude-code\` to wire Claude Code.\n`);
}

async function cmdEnv(): Promise<void> {
  const config = loadConfig();
  const port = config.port ?? DEFAULT_PORT;
  const bind = config.bind ?? DEFAULT_BIND;
  process.stdout.write(`# Add to your shell rc to use claude-proxy with Claude Code:\n`);
  process.stdout.write(`export ANTHROPIC_BASE_URL="http://${bind}:${port}"\n`);
  process.stdout.write(`# Optional: pin a model\n`);
  if (config.defaultModel) {
    process.stdout.write(`export ANTHROPIC_MODEL="${config.defaultModel}"\n`);
  }
  process.stdout.write(`# Claude Code reads this env var; claude-proxy accepts any value.\n`);
}

/* ----------------------------- models subcmds ----------------------------- */

async function cmdModelsList(): Promise<void> {
  const config = loadConfig();
  for (const m of config.models) {
    process.stdout.write(`${m.name}\t${m.provider}\t${m.modelId}${m.label ? `\t${m.label}` : ""}\n`);
  }
}

async function cmdModelsAdd(argv: string[]): Promise<void> {
  const opts = parseFlags(argv);
  require(opts, ["name", "provider", "model-id"]);
  const alias: ModelAlias = {
    name: String(opts.name),
    provider: String(opts.provider),
    modelId: String(opts["model-id"]),
    label: opts.label ? String(opts.label) : undefined,
  };
  upsertModel(alias);
  process.stdout.write(`added alias ${alias.name}\n`);
}

async function cmdModelsRemove(argv: string[]): Promise<void> {
  const name = argv[0];
  if (!name) die("usage: claude-proxy models remove <name>");
  removeModel(name);
  process.stdout.write(`removed alias ${name}\n`);
}

async function cmdModelsDiscover(argv: string[]): Promise<void> {
  const opts = parseFlags(argv);
  if (!opts.provider) die("usage: claude-proxy models discover --provider <id>");
  const config = loadConfig();
  const p = resolveProviders(config).find((x) => x.id === opts.provider);
  if (!p) die(`unknown provider: ${opts.provider}`);
  const ids = await fetchModelList(p);
  for (const id of ids) process.stdout.write(`${id}\n`);
}

/* ---------------------------- provider subcmds ---------------------------- */

async function cmdProvidersList(): Promise<void> {
  const config = loadConfig();
  for (const p of config.providers) {
    process.stdout.write(`${p.id}\t${p.type}\t${p.baseUrl}\n`);
  }
}

async function cmdProvidersAdd(argv: string[]): Promise<void> {
  const opts = parseFlags(argv);
  require(opts, ["id", "type", "base-url"]);
  const provider: ProviderConfig = {
    id: String(opts.id),
    type: String(opts.type) as ProviderConfig["type"],
    baseUrl: String(opts["base-url"]),
    apiKey: opts["api-key"] ? String(opts["api-key"]) : undefined,
    apiKeyEnv: opts["api-key-env"] ? String(opts["api-key-env"]) : undefined,
    label: opts.label ? String(opts.label) : undefined,
  };
  if (provider.type !== "openai" && provider.type !== "anthropic") {
    die(`type must be openai or anthropic (got ${provider.type})`);
  }
  upsertProvider(provider);
  process.stdout.write(`added provider ${provider.id}\n`);
}

async function cmdProvidersRemove(argv: string[]): Promise<void> {
  const id = argv[0];
  if (!id) die("usage: claude-proxy provider remove <id>");
  removeProvider(id);
  process.stdout.write(`removed provider ${id}\n`);
}

/* --------------------------------- utils --------------------------------- */

function parseFlags(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--listen-port" || a === "--bind" || a === "--name" || a === "--provider" ||
        a === "--model-id" || a === "--label" || a === "--id" || a === "--type" ||
        a === "--base-url" || a === "--api-key" || a === "--api-key-env" ||
        a === "--target") {
      const v = argv[++i] ?? "";
      out[a.slice(2)] = v;
    } else if (a.startsWith("--")) {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

function require(opts: Record<string, unknown>, keys: string[]): void {
  const missing = keys.filter((k) => !opts[k]);
  if (missing.length) die(`missing required: ${missing.map((k) => `--${k}`).join(" ")}`);
}

function die(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
  throw new Error(msg); // unreachable; satisfies the `never` contract for the type checker
}

function pidFilePath(): string {
  return join(dirname(CONFIG_PATH()), "claude-proxy.pid");
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});

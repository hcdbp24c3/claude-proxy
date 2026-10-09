/**
 * Configuration loader.
 *
 * Reads `~/.claude-proxy/config.json` (or the path in `CLAUDE_PROXY_CONFIG`).
 * Writes are atomic: temp file + rename. Deep-merge on update so callers
 * don't have to repeat unchanged providers / models.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { homedir } from "node:os";
import type { AppConfig, ModelAlias, ProviderConfig } from "../types.ts";

export const DEFAULT_PORT = 8765;
export const DEFAULT_BIND = "127.0.0.1";
export const CONFIG_DIR = join(homedir(), ".claude-proxy");
export const CONFIG_PATH = (): string =>
  process.env.CLAUDE_PROXY_CONFIG ?? join(CONFIG_DIR, "config.json");

/** Empty default config; the user fills providers/models in. */
export const EMPTY_CONFIG: AppConfig = {
  bind: DEFAULT_BIND,
  port: DEFAULT_PORT,
  logLevel: "info",
  providers: [],
  models: [],
};

export function loadConfig(path?: string): AppConfig {
  const file = path ?? CONFIG_PATH();
  if (!existsSync(file)) return { ...EMPTY_CONFIG };
  const raw = readFileSync(file, "utf8");
  const parsed = JSON.parse(raw) as Partial<AppConfig>;
  return {
    ...EMPTY_CONFIG,
    ...parsed,
    providers: parsed.providers ?? [],
    models: parsed.models ?? [],
  };
}

export function saveConfig(config: AppConfig, path?: string): void {
  const file = path ?? CONFIG_PATH();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  renameSync(tmp, file);
}

/** Merge a partial update into the existing config and persist. */
export function updateConfig(patch: Partial<AppConfig>, path?: string): AppConfig {
  const current = loadConfig(path);
  const next: AppConfig = {
    ...current,
    ...patch,
    providers: patch.providers ?? current.providers,
    models: patch.models ?? current.models,
  };
  saveConfig(next, path);
  return next;
}

/** Add or replace a provider by id. */
export function upsertProvider(provider: ProviderConfig, path?: string): AppConfig {
  const current = loadConfig(path);
  const idx = current.providers.findIndex((p) => p.id === provider.id);
  const providers = [...current.providers];
  if (idx >= 0) providers[idx] = provider;
  else providers.push(provider);
  return updateConfig({ providers }, path);
}

/** Add or replace a model alias by name. */
export function upsertModel(model: ModelAlias, path?: string): AppConfig {
  const current = loadConfig(path);
  const idx = current.models.findIndex((m) => m.name === model.name);
  const models = [...current.models];
  if (idx >= 0) models[idx] = model;
  else models.push(model);
  return updateConfig({ models }, path);
}

export function removeModel(name: string, path?: string): AppConfig {
  const current = loadConfig(path);
  return updateConfig({ models: current.models.filter((m) => m.name !== name) }, path);
}

export function removeProvider(id: string, path?: string): AppConfig {
  const current = loadConfig(path);
  return updateConfig(
    {
      providers: current.providers.filter((p) => p.id !== id),
      models: current.models.filter((m) => m.provider !== id),
    },
    path,
  );
}

/** Resolve env-var-style apiKeyEnv into a concrete key. Returns "" when
 *  nothing is configured (the provider may still be valid for local
 *  endpoints like Ollama). */
export function resolveApiKey(provider: ProviderConfig): string {
  if (provider.apiKey) return provider.apiKey;
  if (provider.apiKeyEnv) {
    const v = process.env[provider.apiKeyEnv];
    if (!v) {
      const hint = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(provider.apiKeyEnv)
        ? `set the env var (e.g. \`export ${provider.apiKeyEnv}=sk-...\` in your shell, or via the Windows Settings → Environment Variables) and restart the proxy.`
        : `the value '${provider.apiKeyEnv}' does not look like a valid env var name (use letters/digits/_). Either fix the name, or paste the API key directly into the provider.`;
      throw new Error(
        `Provider '${provider.id}': env var '${provider.apiKeyEnv}' is unset.\n` +
        `  → ${hint}\n` +
        `  → Or run \`claude-proxy tui\` to reconfigure.`,
      );
    }
    return v;
  }
  return "";
}

/** Path expansion for user overrides. */
export function resolveConfigPath(p: string): string {
  if (p.startsWith("~/")) return pathResolve(join(homedir(), p.slice(2)));
  return pathResolve(p);
}

/**
 * Interactive TUI for claude-proxy, built on @clack/prompts.
 *
 * Entry: `claude-proxy tui` opens the main menu. From there:
 *   - Add / edit / remove providers
 *   - Add / edit / remove model aliases
 *   - Live model discovery (per provider)
 *   - Start the proxy server (foreground)
 *   - Print env vars to wire Claude Code / Desktop
 */
import * as prompts from "@clack/prompts";
import { loadConfig, saveConfig, upsertProvider, upsertModel, removeProvider, removeModel, DEFAULT_BIND, DEFAULT_PORT } from "./config/config.ts";
import { fetchModelList } from "./discovery/models.ts";
import { resolveProviders, resolveModels } from "./router.ts";
import { startProxyServer } from "./server.ts";
import type { AppConfig, ProviderConfig, ModelAlias, ResolvedProvider } from "./types.ts";

export async function runTUI(): Promise<void> {
  prompts.intro("claude-proxy");
  let config = loadConfig();
  for (;;) {
    const action = await prompts.select({
      message: "What do you want to do?",
      options: [
        { value: "view", label: "View providers & models" },
        { value: "add_provider", label: "+ Add provider" },
        { value: "add_model", label: "+ Add model alias" },
        { value: "discover", label: "Discover live models from a provider" },
        { value: "remove_provider", label: "- Remove provider" },
        { value: "remove_model", label: "- Remove model alias" },
        { value: "serve", label: "Start the proxy server" },
        { value: "env", label: "Print env vars for Claude Code / Desktop" },
        { value: "quit", label: "Quit" },
      ],
    });
    if (prompts.isCancel(action)) return finish();
    try {
      switch (action) {
        case "view": await view(config); break;
        case "add_provider": config = await addProviderFlow(config); break;
        case "add_model": config = await addModelFlow(config); break;
        case "discover": await discoverFlow(config); break;
        case "remove_provider": config = await removeProviderFlow(config); break;
        case "remove_model": config = await removeModelFlow(config); break;
        case "serve": await serveFlow(config); break;
        case "env": envFlow(config); break;
        case "quit": return finish();
      }
    } catch (e) {
      prompts.log.error((e as Error).message);
    }
  }
}

function finish(): never {
  prompts.outro("bye");
  process.exit(0);
}

/* ----------------------------- view -------------------------------- */

async function view(config: AppConfig): Promise<void> {
  const providers = resolveProviders(config);
  const models = resolveModels(config);
  if (providers.length === 0 && models.length === 0) {
    prompts.log.warn("No providers or models configured yet. Add one to get started.");
    return;
  }
  if (providers.length > 0) {
    prompts.log.info(`Providers (${providers.length}):`);
    for (const pv of providers) {
      const key = pv.resolvedApiKey ? "key set" : "no key";
      prompts.log.message(`  ${pv.id}  [${pv.type}]  ${pv.baseUrl}  (${key})`);
    }
  }
  if (models.length > 0) {
    prompts.log.info(`Model aliases (${models.length}):`);
    for (const m of models) {
      prompts.log.message(`  ${m.name}  ->  ${m.provider}/${m.modelId}${m.label ? `  "${m.label}"` : ""}`);
    }
  }
}

/* ----------------------------- add provider -------------------------------- */

async function addProviderFlow(config: AppConfig): Promise<AppConfig> {
  const id = await prompts.text({ message: "Provider id (e.g. openrouter):", validate: (v) => v ? undefined : "id is required" });
  if (prompts.isCancel(id)) return config;
  const type = await prompts.select({
    message: "Type:",
    options: [
      { value: "openai", label: "openai  (OpenAI Chat Completions API)" },
      { value: "anthropic", label: "anthropic  (Anthropic Messages API)" },
    ],
  });
  if (prompts.isCancel(type)) return config;
  const baseUrl = await prompts.text({
    message: "Base URL:",
    placeholder: type === "openai" ? "https://openrouter.ai/api/v1" : "https://api.anthropic.com",
    validate: (v) => v ? undefined : "base url is required",
  });
  if (prompts.isCancel(baseUrl)) return config;
  const authMode = await prompts.select({
    message: "How do you want to provide the API key?",
    options: [
      { value: "env", label: "From an env var (recommended)" },
      { value: "literal", label: "Literal string in config (less safe)" },
      { value: "none", label: "No auth required (e.g. local Ollama)" },
    ],
  });
  if (prompts.isCancel(authMode)) return config;
  let apiKey: string | undefined;
  let apiKeyEnv: string | undefined;
  if (authMode === "env") {
    const envName = await prompts.text({
      message: "Env var name:",
      placeholder: "OPENROUTER_API_KEY",
      validate: (v) => v ? undefined : "env var name is required",
    });
    if (prompts.isCancel(envName)) return config;
    apiKeyEnv = envName;
  } else if (authMode === "literal") {
    const k = await prompts.password({ message: "API key:" });
    if (prompts.isCancel(k)) return config;
    apiKey = k;
  }
  const label = await prompts.text({ message: "Label (optional):" });
  if (prompts.isCancel(label)) return config;
  const provider: ProviderConfig = {
    id: String(id),
    type: type as ProviderConfig["type"],
    baseUrl: String(baseUrl),
    apiKey,
    apiKeyEnv,
    label: label ? String(label) : undefined,
  };
  upsertProvider(provider);
  prompts.log.success(`Added provider ${provider.id}`);
  return loadConfig();
}

/* ----------------------------- add model -------------------------------- */

async function addModelFlow(config: AppConfig): Promise<AppConfig> {
  if (config.providers.length === 0) {
    prompts.log.warn("Add a provider first.");
    return config;
  }
  const name = await prompts.text({
    message: "Public alias name (what Claude Code will see). It does NOT need to start with 'claude':",
    placeholder: "gpt-5",
    validate: (v) => {
      if (!v) return "name is required";
      if (!/^[a-zA-Z0-9._-]+$/.test(v)) return "use letters, digits, '.', '_', '-' only";
      return undefined;
    },
  });
  if (prompts.isCancel(name)) return config;
  const provider = await prompts.select({
    message: "Provider:",
    options: config.providers.map((pv) => ({ value: pv.id, label: `${pv.id}  (${pv.type})` })),
  });
  if (prompts.isCancel(provider)) return config;
  // Fetch live model list with manual spinner (clack 1.x spinner returns symbol on cancel).
  const s = prompts.spinner();
  s.start("fetching live model list from upstream…");
  let liveIds: string[] = [];
  try {
    const target = resolveProviders(config).find((x) => x.id === provider);
    if (target) liveIds = await fetchModelList(target);
    s.stop(`found ${liveIds.length} models`);
  } catch (e) {
    s.stop("failed: " + (e as Error).message);
  }
  const modelId = await prompts.text({
    message: "Upstream model id:",
    placeholder: liveIds[0] ?? "gpt-5-2025-01-01",
    initialValue: liveIds[0],
    validate: (v) => v ? undefined : "model id is required",
  });
  if (prompts.isCancel(modelId)) return config;
  const label = await prompts.text({ message: "Label (optional, shown in dashboard):" });
  if (prompts.isCancel(label)) return config;
  const alias: ModelAlias = {
    name: String(name),
    provider: String(provider),
    modelId: String(modelId),
    label: label ? String(label) : undefined,
  };
  upsertModel(alias);
  prompts.log.success(`Added alias ${alias.name} -> ${alias.provider}/${alias.modelId}`);
  return loadConfig();
}

/* ----------------------------- discover -------------------------------- */

async function discoverFlow(config: AppConfig): Promise<void> {
  if (config.providers.length === 0) {
    prompts.log.warn("Add a provider first.");
    return;
  }
  const provider = await prompts.select({
    message: "Provider to discover from:",
    options: config.providers.map((pv) => ({ value: pv.id, label: `${pv.id}  (${pv.type})` })),
  });
  if (prompts.isCancel(provider)) return;
  const s = prompts.spinner();
  s.start(`Discovering models from ${provider}…`);
  try {
    const target: ResolvedProvider | undefined = resolveProviders(config).find((x) => x.id === provider);
    if (!target) { s.stop("unknown provider"); return; }
    const ids = await fetchModelList(target);
    s.stop(`Found ${ids.length} models`);
    for (const id of ids) prompts.log.message(`  ${id}`);
    const addSome = await prompts.confirm({ message: "Add some as aliases now?" });
    if (prompts.isCancel(addSome) || !addSome) return;
    for (const id of ids) {
      const yes = await prompts.confirm({ message: `Add "${id}" as alias?` });
      if (prompts.isCancel(yes)) return;
      if (yes) {
        upsertModel({ name: id, provider: String(provider), modelId: id });
        prompts.log.success(`added ${id}`);
      }
    }
  } catch (e) {
    s.stop("failed: " + (e as Error).message);
  }
}

/* ----------------------------- remove provider/model -------------------------------- */

async function removeProviderFlow(config: AppConfig): Promise<AppConfig> {
  if (config.providers.length === 0) {
    prompts.log.warn("No providers to remove.");
    return config;
  }
  const id = await prompts.select({
    message: "Provider to remove (and all its model aliases):",
    options: config.providers.map((pv) => ({ value: pv.id, label: pv.id })),
  });
  if (prompts.isCancel(id)) return config;
  const yes = await prompts.confirm({ message: `Remove provider ${id}? This also removes its aliases.`, initialValue: false });
  if (prompts.isCancel(yes) || !yes) return config;
  removeProvider(String(id));
  prompts.log.success(`removed ${id}`);
  return loadConfig();
}

async function removeModelFlow(config: AppConfig): Promise<AppConfig> {
  if (config.models.length === 0) {
    prompts.log.warn("No models to remove.");
    return config;
  }
  const name = await prompts.select({
    message: "Model alias to remove:",
    options: config.models.map((m) => ({ value: m.name, label: `${m.name}  ->  ${m.provider}/${m.modelId}` })),
  });
  if (prompts.isCancel(name)) return config;
  removeModel(String(name));
  prompts.log.success(`removed ${name}`);
  return loadConfig();
}

/* ----------------------------- serve -------------------------------- */

async function serveFlow(config: AppConfig): Promise<void> {
  const port = config.port ?? DEFAULT_PORT;
  const bind = config.bind ?? DEFAULT_BIND;

  // Pre-flight: probe the configured port. If it's busy, let the user
  // pick a different one (or override the bound address) before we even
  // try to start.
  let chosenPort = port;
  let chosenBind = bind;
  const busy = await probeBusy(bind, port);
  if (busy) {
    prompts.log.warn(`Port ${port} on ${bind} is already in use.`);
    const action = await prompts.select({
      message: "What do you want to do?",
      options: [
        { value: "other_port", label: `Use a different port (e.g. ${port + 1})` },
        { value: "other_bind", label: `Use a different bind address (e.g. 0.0.0.0)` },
        { value: "abort", label: "Cancel" },
      ],
    });
    if (prompts.isCancel(action) || action === "abort") return;
    if (action === "other_port") {
      const v = await prompts.text({
        message: "Port:",
        initialValue: String(port + 1),
        validate: (v) => {
          const n = Number(v);
          return Number.isFinite(n) && n > 0 && n < 65536 ? undefined : "must be 1-65535";
        },
      });
      if (prompts.isCancel(v)) return;
      chosenPort = Number(v);
    }
    if (action === "other_bind") {
      const v = await prompts.text({
        message: "Bind address:",
        initialValue: "0.0.0.0",
        validate: (v) => v ? undefined : "required",
      });
      if (prompts.isCancel(v)) return;
      chosenBind = String(v);
    }
    // Persist so the user does not get asked again next time.
    config = { ...config, port: chosenPort, bind: chosenBind };
    saveConfig(config);
  }

  prompts.log.info(`Starting proxy on http://${chosenBind}:${chosenPort}`);
  prompts.log.info("Press Ctrl-C to stop.");
  const s = prompts.spinner();
  s.start("starting…");
  let server;
  try {
    server = await startProxyServer(config);
  } catch (e) {
    s.stop("failed: " + (e as Error).message);
    return;
  }
  s.stop(`listening on http://${chosenBind}:${server.port}`);
  prompts.log.message("Dashboard:  http://" + chosenBind + ":" + server.port + "/");
  prompts.log.message("Health:     http://" + chosenBind + ":" + server.port + "/healthz");
  prompts.log.message("Models:     http://" + chosenBind + ":" + server.port + "/v1/models");
  prompts.log.info("Press Ctrl-C to stop.");
  // Block until SIGINT/SIGTERM.
  const { promise, resolve } = Promise.withResolvers<void>();
  process.on("SIGINT", () => resolve());
  process.on("SIGTERM", () => resolve());
  await promise;
  server.stop();
  prompts.log.success("stopped");
}

/** Cheap TCP probe to detect a busy port before Bun hands us a fatal error. */
async function probeBusy(host: string, port: number): Promise<boolean> {
  try {
    await fetch(`http://${host}:${port}/healthz`, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

/* ----------------------------- env -------------------------------- */

function envFlow(config: AppConfig): void {
  const port = config.port ?? DEFAULT_PORT;
  const bind = config.bind ?? DEFAULT_BIND;
  prompts.log.message("# Add to your shell rc to use claude-proxy with Claude Code:");
  prompts.log.message(`export ANTHROPIC_BASE_URL="http://${bind}:${port}"`);
  prompts.log.message(`export ANTHROPIC_AUTH_TOKEN="claude-proxy"`);
  if (config.defaultModel) {
    prompts.log.message(`export ANTHROPIC_MODEL="${config.defaultModel}"`);
  }
  prompts.log.message("# Or run: claude-proxy desktop install --target claude-code");
}

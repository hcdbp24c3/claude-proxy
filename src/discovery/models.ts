/**
 * Live model discovery.
 *
 * Each provider type exposes its own model-list endpoint:
 *  - OpenAI: GET {baseUrl}/models  -> { data: [{ id }] }
 *  - Anthropic: GET {baseUrl}/v1/models  -> { data: [{ id, display_name, type }] }
 *
 * We probe both shapes and return a flat string array of model ids.
 * Network errors are surfaced so the caller can decide whether to surface
 * them or fall back to a cached list.
 */
import type { ResolvedProvider } from "../types.ts";

export async function fetchModelList(provider: ResolvedProvider): Promise<string[]> {
  if (provider.type === "openai") return fetchOpenAI(provider);
  return fetchAnthropic(provider);
}

async function fetchOpenAI(provider: ResolvedProvider): Promise<string[]> {
  const url = joinUrl(provider.baseUrl, "models");
  const headers = new Headers();
  if (provider.resolvedApiKey) headers.set("authorization", `Bearer ${provider.resolvedApiKey}`);
  for (const [k, v] of Object.entries(provider.headers ?? {})) headers.set(k, v);

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`upstream ${res.status}: ${text.slice(0, 256)}`);
  }
  const parsed = (await res.json()) as { data?: Array<{ id?: string }> };
  return (parsed.data ?? [])
    .map((m) => (typeof m.id === "string" ? m.id : null))
    .filter((x): x is string => x !== null);
}

async function fetchAnthropic(provider: ResolvedProvider): Promise<string[]> {
  const url = joinUrl(provider.baseUrl, "v1/models");
  const headers = new Headers();
  if (provider.resolvedApiKey) headers.set("x-api-key", provider.resolvedApiKey);
  if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
  for (const [k, v] of Object.entries(provider.headers ?? {})) headers.set(k, v);

  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`upstream ${res.status}: ${text.slice(0, 256)}`);
  }
  const parsed = (await res.json()) as { data?: Array<{ id?: string }> };
  return (parsed.data ?? [])
    .map((m) => (typeof m.id === "string" ? m.id : null))
    .filter((x): x is string => x !== null);
}

export async function discoverModelsForProvider(provider: ResolvedProvider): Promise<string[]> {
  return fetchModelList(provider);
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/$/, "");
  const p = path.replace(/^\//, "");
  return `${b}/${p}`;
}

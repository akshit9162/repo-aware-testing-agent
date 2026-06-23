/**
 * LLM-backed enrichment for Playwright journey specs.
 *
 * For each journey route, reads the page component source and asks an LLM
 * (Claude or GPT) to identify the most important visible, stable elements
 * that a basic smoke test should assert. Returns a Map<route, enrichment>:
 *   { description: string,
 *     expected: Array<{kind: 'heading'|'text'|'link'|'button'|'image',
 *                      text?: string, name?: string, level?: 1-6}> }
 *
 * Activates when ANTHROPIC_API_KEY or OPENAI_API_KEY is set. Override the
 * provider with QA_LLM_PROVIDER=anthropic|openai when both are present.
 * Cache writes go to .qa-agent-cache/llm-enrich/ keyed by hash(route+source).
 * Failures fall back silently so the orchestrator can always proceed with
 * the skeleton path. Retries with backoff on 429/5xx.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_MODELS = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o-mini",
};
const MAX_SOURCE_CHARS = 6000;
const CONCURRENCY = 5;
const CACHE_DIR = ".qa-agent-cache/llm-enrich";

const SYSTEM_PROMPT = `You are a QA test designer. Given a web page component's source code and its route path, identify the most important visible, stable elements that a basic browser smoke test should assert.

Rules:
- Return up to 6 expectations per page; fewer is better than wrong.
- Be conservative: only include elements you can identify confidently from the source.
- Prefer accessibility-friendly identifiers (role + accessible name) over CSS selectors.
- For headings, capture the visible text or a short phrase from it. Skip if the text is dynamic/templated (e.g. interpolated from a fetch).
- For links and buttons, capture the visible label (the "accessible name").
- Avoid loaded/dynamic content (data fetched from APIs, slug-templated text); prefer static markup.
- Visible elements present in the source will exist in the DOM after the page renders.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["description", "expected"],
  properties: {
    description: { type: "string", description: "One-sentence summary of what this smoke test verifies." },
    expected: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: {
          kind: { enum: ["heading", "text", "link", "button", "image"] },
          text: { type: "string", description: "Visible text or short phrase (for heading/text)." },
          name: { type: "string", description: "Accessible name (for link/button)." },
          level: { type: "integer", description: "Heading level 1-6 when known." },
        },
      },
    },
  },
};

function hashKey(route, content, kind) {
  return crypto.createHash("sha1").update(kind + "::" + route + "::" + content).digest("hex");
}

async function readCached(repoRoot, key) {
  try {
    return JSON.parse(await fs.readFile(path.join(repoRoot, CACHE_DIR, key + ".json"), "utf8"));
  } catch {
    return null;
  }
}

async function writeCached(repoRoot, key, value) {
  try {
    const dir = path.join(repoRoot, CACHE_DIR);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, key + ".json"), JSON.stringify(value, null, 2), "utf8");
  } catch {}
}

function detectProviderFromClient(client) {
  if (client?.chat?.completions?.create) return "openai";
  if (client?.messages?.create) return "anthropic";
  return null;
}

function resolveProvider({ provider, anthropicKey, openaiKey } = {}) {
  if (provider) return provider.toLowerCase();
  const fromEnv = (process.env.QA_LLM_PROVIDER || "").toLowerCase();
  if (fromEnv === "anthropic" || fromEnv === "openai") return fromEnv;
  if (anthropicKey) return "anthropic";
  if (openaiKey) return "openai";
  return null;
}

function buildUserMessage(journey, content, kind) {
  const truncated = content.slice(0, MAX_SOURCE_CHARS);
  const tail = content.length > MAX_SOURCE_CHARS ? "\n... [truncated]" : "";
  if (kind === "rendered-html") {
    return `Route: ${journey.path}
Content type: rendered HTML (live capture, post-render)
Source URL: ${journey.foundOn ? "linked from " + journey.foundOn : "entry"}

\`\`\`html
${truncated}${tail}
\`\`\`

This is the *rendered* HTML the browser saw, not source code. Identify the stable, visible elements a basic smoke test should assert. Headings, links, and buttons will appear as real DOM elements with their final text.`;
  }
  const formsContext = Array.isArray(journey.forms) && journey.forms.length
    ? "\n\nDetected form fields (from static analysis):\n" +
      journey.forms.slice(0, 12).map((f) => {
        const parts = [f.kind || "field"];
        if (f.label) parts.push(`label="${f.label}"`);
        if (f.name) parts.push(`name="${f.name}"`);
        if (f.type) parts.push(`type=${f.type}`);
        if (f.required) parts.push("required");
        if (f.validation) parts.push(`validation=${JSON.stringify(f.validation)}`);
        return `- ${parts.join(" ")}`;
      }).join("\n") +
      "\n\nUse these to suggest assertions about the form: label visibility, required-field validation messages, etc."
    : "";
  const apiContext = Array.isArray(journey.apiCalls) && journey.apiCalls.length
    ? "\n\nDetected outbound API calls from this page:\n" +
      journey.apiCalls.slice(0, 8).map((c) => `- ${c.method} ${c.path}`).join("\n")
    : "";
  return `Route: ${journey.path}
Content type: component source code
Source file: ${journey.source}

\`\`\`
${truncated}${tail}
\`\`\`${formsContext}${apiContext}

Identify the stable, visible elements that a basic smoke test should assert.`;
}

async function enrichOneAnthropic(client, journey, content, kind, model) {
  const response = await client.messages.create({
    model,
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: buildUserMessage(journey, content, kind) }],
  });
  const text = response.content?.find?.((b) => b.type === "text")?.text;
  if (!text) throw new Error("no text in response");
  return JSON.parse(text);
}

async function enrichOneOpenAI(client, journey, content, kind, model) {
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage(journey, content, kind) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "page_smoke_assertions", strict: false, schema: SCHEMA },
    },
  });
  const text = response.choices?.[0]?.message?.content;
  if (!text) throw new Error("no text in response");
  return JSON.parse(text);
}

async function enrichOne(client, journey, content, kind, model, provider) {
  if (provider === "openai") return enrichOneOpenAI(client, journey, content, kind, model);
  return enrichOneAnthropic(client, journey, content, kind, model);
}

function parseStatus(error) {
  if (typeof error?.status === "number") return error.status;
  const match = /^(\d{3})\b/.exec(String(error?.message || ""));
  return match ? Number(match[1]) : 0;
}

function parseRetryAfterMs(error) {
  const headers = error?.headers;
  const get = typeof headers?.get === "function" ? (k) => headers.get(k) : (k) => headers?.[k];
  const v = Number(get?.("retry-after") || get?.("Retry-After") || 0);
  return Number.isFinite(v) && v > 0 ? v * 1000 : 0;
}

async function enrichOneWithRetry(client, journey, content, kind, model, provider, maxRetries = 5) {
  let attempt = 0;
  while (true) {
    try {
      return await enrichOne(client, journey, content, kind, model, provider);
    } catch (error) {
      const status = parseStatus(error);
      const retryable = status === 429 || status === 529 || status >= 500;
      if (!retryable || attempt >= maxRetries) throw error;
      attempt += 1;
      const retryAfterMs = parseRetryAfterMs(error);
      const backoffMs = Math.min(2 ** attempt * 1000, 60_000);
      const jitter = Math.floor(Math.random() * 500);
      await new Promise((resolve) => setTimeout(resolve, (retryAfterMs || backoffMs) + jitter));
    }
  }
}

async function withSemaphore(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (error) {
        results[idx] = { error: error instanceof Error ? error.message : String(error) };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

async function resolveJourneyContent(journey, repoRoot) {
  if (typeof journey.html === "string" && journey.html.length) {
    return { content: journey.html, kind: "rendered-html" };
  }
  if (journey.source) {
    try {
      const content = await fs.readFile(path.join(repoRoot, journey.source), "utf8");
      return { content, kind: "source" };
    } catch {
      return null;
    }
  }
  return null;
}

async function importClient(provider, apiKey) {
  const sdkName = provider === "openai" ? "openai" : "@anthropic-ai/sdk";
  // Hard dependency — the SDK is required, not optional. If the package was
  // somehow uninstalled, surface a clear error instead of silently degrading.
  const mod = await import(sdkName);
  const Ctor = mod.default || mod;
  return new Ctor({ apiKey });
}

/**
 * Build per-route enrichment via Claude or OpenAI. Returns
 *   { enriched: Map<route, enrichment>,
 *     stats: { provider, model, requested, cached, succeeded, failed, skipped, firstError? } }
 *
 * Caller may inject `{ client }` in tests to bypass SDK imports. Provider
 * is detected from the client shape, or from QA_LLM_PROVIDER / available
 * API keys when constructing one fresh.
 */
export async function enrichJourneys({ repoRoot, journeys, apiKey, anthropicApiKey, openaiApiKey, provider: providerOverride, model: modelOverride, client: injectedClient, logger = () => {} } = {}) {
  const baseStats = { provider: null, model: null, requested: 0, cached: 0, succeeded: 0, failed: 0, skipped: journeys?.length || 0 };
  const empty = () => ({ enriched: new Map(), stats: { ...baseStats } });
  if (!journeys || !journeys.length) return empty();

  // Resolve provider — from explicit override, env, injected client, or key presence.
  let provider = providerOverride || (injectedClient && detectProviderFromClient(injectedClient));
  if (!provider) {
    provider = resolveProvider({
      anthropicKey: anthropicApiKey || process.env.ANTHROPIC_API_KEY,
      openaiKey: openaiApiKey || process.env.OPENAI_API_KEY,
    });
  }

  // LLM enrichment is mandatory. If no provider could be resolved (no API key
  // and no injected client), surface a clear error rather than silently
  // degrading to cache-only or skeleton mode.
  if (!provider) {
    throw new Error(
      "LLM enrichment is required. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, " +
      "or pass QA_LLM_PROVIDER explicitly."
    );
  }

  const model = modelOverride || process.env.QA_LLM_MODEL || DEFAULT_MODELS[provider];

  let client = injectedClient;
  if (!client) {
    const resolvedKey = apiKey
      || (provider === "anthropic" ? (anthropicApiKey || process.env.ANTHROPIC_API_KEY) : (openaiApiKey || process.env.OPENAI_API_KEY));
    if (!resolvedKey) {
      throw new Error(`LLM enrichment is required: ${provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} is not set.`);
    }
    client = await importClient(provider, resolvedKey);
  }

  const inputs = [];
  for (const journey of journeys) {
    const resolved = await resolveJourneyContent(journey, repoRoot);
    if (!resolved) continue;
    inputs.push({
      journey,
      content: resolved.content,
      kind: resolved.kind,
      key: hashKey(journey.path, resolved.content, resolved.kind),
    });
  }

  const stats = { ...baseStats, provider, model, skipped: journeys.length - inputs.length };
  const enriched = new Map();

  const results = await withSemaphore(inputs, CONCURRENCY, async (input) => {
    const cached = await readCached(repoRoot, input.key);
    if (cached) {
      stats.cached += 1;
      return { route: input.journey.path, value: cached };
    }
    stats.requested += 1;
    const value = await enrichOneWithRetry(client, input.journey, input.content, input.kind, model, provider);
    await writeCached(repoRoot, input.key, value);
    return { route: input.journey.path, value };
  });

  let firstError = null;
  for (const result of results) {
    if (result?.error) {
      stats.failed += 1;
      if (!firstError) firstError = result.error;
      continue;
    }
    if (result?.route && result?.value) {
      enriched.set(result.route, result.value);
      stats.succeeded += 1;
    }
  }
  if (firstError) {
    stats.firstError = firstError;
    logger("first enrichment error: " + firstError);
  }

  return { enriched, stats };
}

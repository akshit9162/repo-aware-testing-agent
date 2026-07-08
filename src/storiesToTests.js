/**
 * Generate Playwright specs from imported user stories.
 *
 * Two modes:
 *   - **Skeleton mode** (no API key): emit one `describe` block per story
 *     with the story metadata + acceptance criteria as comments and TODO
 *     stubs. Cheap, deterministic, run anywhere.
 *   - **LLM-enriched mode** (API key set): for each story, ask the model
 *     to return concrete Playwright steps grounded in the agent's already-
 *     discovered routes and form fields. Cached per story+route fingerprint
 *     under .qa-agent-cache/llm-stories/.
 *
 * Discovery context is reused as-is — we feed the LLM the SAME journeys +
 * forms that `enrichJourneys` already builds.
 */
import { storySlug, shouldSkipStory, partitionByModule, groupTestCasesByStory } from "./storiesImport.js";
import { pickSnapshotForRoute } from "./recorder.js";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const CACHE_DIR = ".qa-agent-cache/llm-stories";

const STORY_LLM_PROMPT = `You are a QA test designer. Given a user story and the discovered routes / form fields of the application under test, return a Playwright test plan as JSON.

Rules:
- Return at most 8 steps per story; fewer is better than wrong.
- Each step is an object with one of these shapes:
  - { "kind": "goto", "path": "/route-path" }
  - { "kind": "fill", "label": "Field Name", "value": "..." }
  - { "kind": "click", "name": "Button or Link Label" }
  - { "kind": "select", "label": "Field Name", "option": "..." }
  - { "kind": "check", "label": "Checkbox Label" }
  - { "kind": "expectUrl", "pattern": "/dashboard" }
  - { "kind": "expectText", "text": "Welcome" }
  - { "kind": "expectVisible", "role": "heading" | "button" | "link", "name": "..." }
- Use ONLY routes and field labels that appear in the provided discovery context. If something is missing, omit that step rather than guess.
- Pick the route(s) most relevant to the story; if none match closely, pick one and add an expectText step matching a quote from the acceptance criteria.
- Test name should be a short imperative sentence summarizing the story.`;

const STORY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["testName", "steps"],
  properties: {
    testName: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { enum: ["goto", "fill", "click", "select", "check", "expectUrl", "expectText", "expectVisible"] },
          path: { type: "string" },
          label: { type: "string" },
          value: { type: "string" },
          name: { type: "string" },
          option: { type: "string" },
          pattern: { type: "string" },
          text: { type: "string" },
          role: { type: "string" },
        },
        required: ["kind"],
      },
    },
  },
};

function escapeStr(s) {
  return JSON.stringify(String(s ?? ""));
}

function relevantJourneys(story, journeys, limit = 8) {
  if (!journeys?.length) return [];
  const text = `${story.title || ""} ${story.description || ""} ${story.ac || ""} ${story.tags || ""}`.toLowerCase();
  const storyWords = new Set(text.split(/[^\w]+/).filter((w) => w.length >= 3));
  if (!storyWords.size) return [];
  return journeys
    .map((j) => {
      const haystack = `${j.path || ""} ${j.title || ""} ${(j.forms || []).map((f) => f.label || f.name || "").join(" ")}`.toLowerCase();
      const words = haystack.split(/[^\w]+/).filter((w) => w.length >= 3);
      const score = words.reduce((acc, w) => (storyWords.has(w) ? acc + 1 : acc), 0);
      return { journey: j, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.journey);
}

function buildSkeletonBlock(story, idx, related) {
  const slug = storySlug(story, idx);
  const title = story.title || `Story ${idx + 1}`;
  const acLines = (story.ac || "")
    .split(/\r?\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const relatedLines = related.length
    ? "  //   " +
      related.map((j) => `${j.path} (${j.source || "?"})`).join("\n  //   ")
    : "  //   (no matching routes discovered in this repo)";
  const story_summary = [
    story.asA ? `As a ${story.asA}` : null,
    story.want ? `I want ${story.want}` : null,
    story.benefit ? `So that ${story.benefit}` : null,
  ]
    .filter(Boolean)
    .join("\n  // ");
  return `test.describe(${escapeStr(`${story.id ? story.id + " — " : ""}${title}`)}, () => {
  test('happy path', async ({ page }) => {
    // ${story_summary || "—"}
    //
    // Acceptance Criteria:
${acLines.length ? acLines.map((l) => `    //   ${l}`).join("\n") : "    //   (none provided)"}
    //
    // Discovered routes that may be relevant:
${relatedLines}

    // TODO: implement the test for ${slug}.
    expect(true).toBeTruthy();
  });
});`;
}

function buildLlmBlock(story, idx, plan) {
  const slug = storySlug(story, idx);
  const title = (plan?.testName || story.title || `Story ${idx + 1}`).trim();
  const steps = (plan?.steps || []).map((step) => stepToCode(step)).filter(Boolean);
  return `test.describe(${escapeStr(`${story.id ? story.id + " — " : ""}${story.title || slug}`)}, () => {
  test(${escapeStr(title)}, async ({ page }) => {
${steps.map((line) => "    " + line).join("\n") || "    // (LLM returned no steps)"}
  });
});`;
}

function stepToCode(step) {
  switch (step?.kind) {
    case "goto":
      return `await page.goto(urlFor(${escapeStr(step.path)}), { waitUntil: 'domcontentloaded' });`;
    case "fill":
      return `await page.getByLabel(${escapeStr(step.label)}, { exact: false }).first().fill(${escapeStr(step.value || "")});`;
    case "click":
      return `await page.getByRole('button', { name: ${escapeStr(step.name)} }).first().click();`;
    case "select":
      return `await page.getByLabel(${escapeStr(step.label)}, { exact: false }).first().selectOption(${escapeStr(step.option || "")});`;
    case "check":
      return `await page.getByLabel(${escapeStr(step.label)}, { exact: false }).first().check();`;
    case "expectUrl":
      return `await expect(page).toHaveURL(new RegExp(${escapeStr(step.pattern || "")}));`;
    case "expectText":
      return `await expect(page.getByText(${escapeStr(step.text || "")}, { exact: false }).first()).toBeVisible();`;
    case "expectVisible":
      return `await expect(page.getByRole(${escapeStr(step.role || "button")}, { name: ${escapeStr(step.name || "")} }).first()).toBeVisible();`;
    default:
      return null;
  }
}

function fingerprint(story, related) {
  const h = crypto.createHash("sha1");
  h.update(JSON.stringify({ story, related: related.map((j) => j.path) }));
  return h.digest("hex");
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

async function llmPlanForStory({ client, provider, model, story, related }) {
  const journeyContext = related.length
    ? related.map((j) => {
        const forms = (j.forms || []).slice(0, 8).map((f) => `${f.label || f.name || "field"}${f.required ? "*" : ""}`).join(", ");
        return `- ${j.path}  forms: [${forms}]`;
      }).join("\n")
    : "(no matching routes — pick one and write an expectText assertion from the AC)";
  const userMessage = `User story:
- ID: ${story.id || "(none)"}
- Title: ${story.title || "(none)"}
- As a: ${story.asA || "(none)"}
- I want: ${story.want || "(none)"}
- So that: ${story.benefit || "(none)"}
- Acceptance Criteria:
${(story.ac || "(none)").split(/\r?\n/).map((l) => `  ${l}`).join("\n")}

Discovered routes / forms (use ONLY these):
${journeyContext}

Return the test plan JSON now.`;

  if (provider === "openai") {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: STORY_LLM_PROMPT },
        { role: "user", content: userMessage },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "story_test_plan", strict: false, schema: STORY_SCHEMA },
      },
    });
    const text = response.choices?.[0]?.message?.content;
    return text ? JSON.parse(text) : null;
  }
  const response = await client.messages.create({
    model,
    max_tokens: 1500,
    system: STORY_LLM_PROMPT,
    output_config: { format: { type: "json_schema", schema: STORY_SCHEMA } },
    messages: [{ role: "user", content: userMessage }],
  });
  const text = response.content?.find?.((b) => b.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

async function importClient(provider, apiKey) {
  const sdkName = provider === "openai" ? "openai" : "@anthropic-ai/sdk";
  const mod = await import(sdkName);
  const Ctor = mod.default || mod;
  return new Ctor({ apiKey });
}

function selectProvider({ injectedClient, anthropicKey, openaiKey, override }) {
  if (override) return override.toLowerCase();
  if (process.env.QA_LLM_PROVIDER) return process.env.QA_LLM_PROVIDER.toLowerCase();
  if (injectedClient?.chat?.completions?.create) return "openai";
  if (injectedClient?.messages?.create) return "anthropic";
  if (anthropicKey || process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (openaiKey || process.env.OPENAI_API_KEY) return "openai";
  return null;
}

/**
 * Public API. Returns:
 *   { specSource: string, stats: { total, skipped, enriched, skeleton, failed } }
 */
export async function generateStoryTests({
  stories,
  journeys = [],
  repoRoot,
  client: injectedClient,
  provider: providerOverride,
  model: modelOverride,
  anthropicApiKey,
  openaiApiKey,
  logger = () => {},
} = {}) {
  if (!Array.isArray(stories) || !stories.length) {
    return {
      specSource: emptySpec("No stories were imported."),
      stats: { total: 0, skipped: 0, enriched: 0, skeleton: 0, failed: 0 },
    };
  }
  const usableStories = stories.filter((s) => !shouldSkipStory(s));
  const skipped = stories.length - usableStories.length;

  const provider = selectProvider({
    injectedClient,
    anthropicKey: anthropicApiKey,
    openaiKey: openaiApiKey,
    override: providerOverride,
  });
  const useLlm = Boolean(provider);
  const model =
    modelOverride ||
    process.env.QA_LLM_MODEL ||
    (provider === "openai" ? "gpt-4o-mini" : "claude-sonnet-4-6");
  let client = injectedClient || null;
  if (useLlm && !client) {
    const key =
      provider === "anthropic"
        ? anthropicApiKey || process.env.ANTHROPIC_API_KEY
        : openaiApiKey || process.env.OPENAI_API_KEY;
    if (key) client = await importClient(provider, key);
  }

  const stats = { total: usableStories.length, skipped, enriched: 0, skeleton: 0, failed: 0 };
  const blocks = [];

  for (let idx = 0; idx < usableStories.length; idx += 1) {
    const story = usableStories[idx];
    const related = relevantJourneys(story, journeys);
    let plan = null;
    if (useLlm && client) {
      const key = fingerprint(story, related);
      plan = repoRoot ? await readCached(repoRoot, key) : null;
      if (!plan) {
        try {
          plan = await llmPlanForStory({ client, provider, model, story, related });
          if (plan && repoRoot) await writeCached(repoRoot, key, plan);
        } catch (error) {
          stats.failed += 1;
          logger("story enrichment failed: " + (error?.message || String(error)));
        }
      }
    }
    if (plan && plan.steps?.length) {
      blocks.push(buildLlmBlock(story, idx, plan));
      stats.enriched += 1;
    } else {
      blocks.push(buildSkeletonBlock(story, idx, related));
      stats.skeleton += 1;
    }
  }

  return {
    specSource: wrapSpec(blocks),
    stats,
  };
}

function wrapSpec(blocks) {
  return `import { test, expect } from '@playwright/test';
import { urlFor } from '../helpers/journey-fixture';

// Generated by repo-qa-agent stories on ${new Date().toISOString()}.
// One describe block per imported user story; LLM-enriched when an
// ANTHROPIC_API_KEY / OPENAI_API_KEY was available at generation time.

${blocks.join("\n\n")}
`;
}

function emptySpec(reason) {
  return `import { test } from '@playwright/test';
// ${reason}
test.skip('user-stories.spec.ts has no stories yet', () => {});
`;
}

// ---------- LLM enrichment for Test Cases (batched) ----------

const TC_LLM_PROMPT = `You are a QA test designer. Given user-story test cases and DOM-anchored application context, return a JSON array of Playwright test plans.

STRICT ANTI-HALLUCINATION RULES — read these carefully.

The LIVE DOM SNAPSHOT below (when provided) is EXHAUSTIVE. If a field / button / heading is NOT in it, the element is NOT on the page. Do not assert it.

The Excel columns (Steps, Expected Result) describe INTENT, not ground truth. The DOM is the ground truth. When they conflict:
- DOM wins.
- Never invent selectors from Excel wording ("New Vehicle checkbox", "BACK button") unless those exact elements exist in the snapshot's fields[] or buttons[].
- If Excel mentions an element that is not in the DOM, either OMIT that step OR emit a step with kind:"expectText" using the visible text you can verify.

For each test case return:
{ "testCaseId": "...", "testName": "short imperative sentence", "steps": [ ... ] }

Step shapes:
  - { "kind": "goto",         "path": "/route-path" }
  - { "kind": "fill",         "label": "Field Label from snapshot",  "value": "..." }
  - { "kind": "click",        "name":  "Button label from snapshot" }
  - { "kind": "select",       "label": "Field Label from snapshot",  "option": "..." }
  - { "kind": "check",        "label": "Checkbox label from snapshot" }
  - { "kind": "expectUrl",    "pattern": "regex fragment" }
  - { "kind": "expectText",   "text": "visible text substring" }
  - { "kind": "expectVisible","role": "heading|button|link|textbox|combobox", "name": "label from snapshot" }

Constraints:
- Preserve testCaseId exactly as given.
- Every "label" / "name" MUST appear verbatim in the provided DOM snapshot fields[] or buttons[] when a snapshot exists.
- No BACK / CANCEL / EDIT / LOGOUT assertions unless they exist in snapshot.buttons.
- Prefer a small number of high-confidence steps (3-6) over a long list of guesses.
- Skip un-mappable steps (e.g. "review with team", "verify audit trail in database").`;

const TC_BATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["testCaseId", "steps"],
        properties: {
          testCaseId: { type: "string" },
          testName: { type: "string" },
          steps: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind"],
              properties: {
                kind: {
                  enum: ["goto", "fill", "click", "select", "check", "expectUrl", "expectText", "expectVisible"],
                },
                path: { type: "string" },
                label: { type: "string" },
                value: { type: "string" },
                name: { type: "string" },
                option: { type: "string" },
                pattern: { type: "string" },
                text: { type: "string" },
                role: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};

// Bump when the prompt changes materially — invalidates cache so a re-run
// with tightened rules doesn't silently reuse looser LLM output.
const TC_PROMPT_VERSION = "v2-strict-anti-hallucination-2026-07-06";

function tcFingerprint(tc, story, journeys, snapshotUrls = []) {
  // Include snapshotUrls so runs WITH DOM snapshots get fresh LLM calls
  // even when the same test case was cached from a snapshot-less run.
  // Otherwise the DOM-anchored prompt improvement is silently ignored.
  const h = crypto.createHash("sha1");
  h.update(JSON.stringify({
    tcId: tc.testCaseId,
    tcSummary: tc.summary,
    tcSteps: tc.testSteps,
    tcExpected: tc.expectedResult,
    storyId: story?.id,
    routes: journeys.map((j) => j.path).sort(),
    snapshotUrls: [...snapshotUrls].sort(),
    promptVersion: TC_PROMPT_VERSION,
  }));
  return h.digest("hex");
}

function formatSnapshotForPrompt(snap) {
  if (!snap) return null;
  const fields = (snap.fields || []).slice(0, 25).map((f) => {
    const bits = [f.label || f.name || f.placeholder || "?"];
    if (f.type) bits.push(`type=${f.type}`);
    if (f.role) bits.push(`role=${f.role}`);
    if (f.required) bits.push("required");
    if (f.disabled) bits.push("disabled");
    if (f.options?.length) bits.push(`options=${f.options.map((o) => o.label).slice(0, 6).join("|")}`);
    return "  - " + bits.join(", ");
  }).join("\n");
  const buttons = (snap.buttons || []).slice(0, 20).map((b) => "  - " + b.label).join("\n");
  const headings = (snap.headings || []).slice(0, 8).map((h) => "  - h" + h.level + ": " + h.text).join("\n");
  return `URL: ${snap.url}
Title: ${snap.title || ""}
Headings:
${headings || "  (none)"}
Fields (real DOM):
${fields || "  (none)"}
Buttons (real DOM, visible only):
${buttons || "  (none)"}`;
}

async function llmBatchEnrich({ client, provider, model, batch }) {
  const context = batch.contextBlock;
  const snapshotBlocks = (batch.snapshotsForBatch || [])
    .map((entry) => `\n--- Snapshot for ${entry.hint} ---\n${entry.text}`)
    .join("\n");
  const userMessage = `Discovered routes from static repo scan:
${context}
${snapshotBlocks ? "\n\nLIVE DOM SNAPSHOTS (use these as ground truth for selectors):\n" + snapshotBlocks : ""}

Test cases to convert (${batch.testCases.length}):

${batch.testCases
  .map((tc, i) => {
    const story = batch.storyById.get(tc.storyId) || {};
    return `--- Test Case ${i + 1} ---
Test Case ID: ${tc.testCaseId}
Linked Story ID: ${tc.storyId || "(none)"}
Story Title: ${story.title || "(none)"}
Page / Screen: ${tc.page || "(unspecified)"}
Priority: ${tc.priority || "(unspecified)"}
Prerequisites: ${(tc.prerequisites || "(none)").replace(/\r?\n/g, " ")}
Test Steps:
${(tc.testStepsArray || String(tc.testSteps || "").split(/\r?\n/)).filter(Boolean).map((s) => "  " + s.trim()).join("\n")}
Test Data: ${(tc.testData || "(none)").replace(/\r?\n/g, " ")}
Expected Result: ${(tc.expectedResult || "(none)").replace(/\r?\n/g, " ")}`;
  })
  .join("\n\n")}

Return the JSON now, with one result per test case in the same order.`;

  if (provider === "openai") {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: TC_LLM_PROMPT },
        { role: "user", content: userMessage },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "test_case_plans", strict: false, schema: TC_BATCH_SCHEMA },
      },
    });
    const text = response.choices?.[0]?.message?.content;
    return text ? JSON.parse(text)?.results || [] : [];
  }
  const response = await client.messages.create({
    model,
    // 8000 gives headroom for 6-batch outputs at ~1000 tokens each.
    // Below 8000 we regularly hit "Unterminated string in JSON" on
    // truncated responses; above adds latency without value.
    max_tokens: 8000,
    system: TC_LLM_PROMPT,
    output_config: { format: { type: "json_schema", schema: TC_BATCH_SCHEMA } },
    messages: [{ role: "user", content: userMessage }],
  });
  const text = response.content?.find?.((b) => b.type === "text")?.text;
  return text ? JSON.parse(text)?.results || [] : [];
}

function buildEnrichedTestBlock(tc, plan, seenTitles) {
  const testCaseId = tc.testCaseId || plan?.testCaseId || "TC";
  const testName = (plan?.testName || tc.summary || "test").replace(/\r?\n/g, " ").slice(0, 140);
  let title = `${testCaseId}: ${testName}`;
  // Playwright refuses duplicate titles within a spec file. Append a
  // sequence suffix when we've seen this title before in the current file.
  if (seenTitles) {
    if (seenTitles.has(title)) {
      const n = (seenTitles.get(title) || 1) + 1;
      seenTitles.set(title, n);
      title = `${title} #${n}`;
    } else {
      seenTitles.set(title, 1);
    }
  }
  const steps = (plan?.steps || []).map((s) => stepToCode(s)).filter(Boolean);
  return `  test(${JSON.stringify(title)}, async ({ page }) => {
    // Page / Screen: ${tc.page || "(unspecified)"}
    // Priority: ${tc.priority || "(unspecified)"}
    ${tc.prerequisites ? `// Prerequisites: ${tc.prerequisites.replace(/\r?\n/g, " ")}` : ""}
    // Expected: ${(tc.expectedResult || "").replace(/\r?\n/g, " ").slice(0, 240)}

${steps.length ? steps.map((s) => "    " + s).join("\n") : "    // (LLM returned no runnable steps)\n    expect(true).toBeTruthy();"}
  });`;
}

function buildStoryDescribeEnriched(story, testCases, enrichmentByTcId, seenTitles) {
  const header = `${story.id ? story.id + " — " : ""}${story.title || "Untitled story"}`;
  const summary = [
    story.asA ? `As a ${story.asA}` : null,
    story.want ? `I want ${story.want}` : null,
    story.benefit ? `So that ${story.benefit}` : null,
  ]
    .filter(Boolean)
    .join(" ") ||
    (story.description || "").split(/\r?\n/)[0] ||
    "";
  const ac = String(story.ac || "").split(/\r?\n/).filter(Boolean);
  const tests = testCases
    .map((tc) => {
      const plan = enrichmentByTcId.get(tc.testCaseId);
      if (plan?.steps?.length) return buildEnrichedTestBlock(tc, plan, seenTitles);
      return buildTestCaseSkeleton(story, tc, 0, seenTitles);
    })
    .join("\n\n");
  return `test.describe(${JSON.stringify(header)}, () => {
  // ${summary}
  ${ac.length ? `//\n  // Acceptance Criteria:\n  //   ${ac.join("\n  //   ")}` : ""}

${tests}
});`;
}

function selectProviderForEnrich({ anthropicKey, openaiKey, override }) {
  if (override) return override.toLowerCase();
  if (process.env.QA_LLM_PROVIDER) return process.env.QA_LLM_PROVIDER.toLowerCase();
  if (anthropicKey || process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (openaiKey || process.env.OPENAI_API_KEY) return "openai";
  return null;
}

/**
 * LLM-enrich a full workbook of test cases in batches. Returns per-module
 * spec sources plus a stats block. Writes cache per-test-case fingerprint
 * so partial or re-runs are cheap.
 */
export async function enrichSpecsFromTestCases({
  stories = [],
  testCases = [],
  journeys = [],
  snapshotsByUrl = new Map(), // NEW: DOM snapshots keyed by full URL from recorder
  repoRoot,
  batchSize = 8,
  anthropicApiKey,
  openaiApiKey,
  providerOverride,
  modelOverride,
  logger = () => {},
  onModuleComplete, // optional callback fired per module for incremental writes
} = {}) {
  if (!testCases.length) return { specsByModule: new Map(), stats: {} };
  const provider = selectProviderForEnrich({
    anthropicKey: anthropicApiKey,
    openaiKey: openaiApiKey,
    override: providerOverride,
  });
  if (!provider) throw new Error("enrichSpecsFromTestCases: no LLM provider (set ANTHROPIC_API_KEY or OPENAI_API_KEY).");
  const model = modelOverride || process.env.QA_LLM_MODEL || (provider === "openai" ? "gpt-4o-mini" : "claude-sonnet-4-6");
  const apiKey =
    provider === "anthropic"
      ? anthropicApiKey || process.env.ANTHROPIC_API_KEY
      : openaiApiKey || process.env.OPENAI_API_KEY;
  const client = await importClient(provider, apiKey);

  const storyById = new Map(stories.filter((s) => s.id).map((s) => [String(s.id).trim(), s]));
  const journeyIndex = journeys.slice(0, 40); // trim context to top routes
  const contextBlock = journeyIndex
    .map((j) => {
      const forms = (j.forms || []).slice(0, 10).map((f) => f.label || f.name).filter(Boolean).join(", ");
      return `- ${j.path}${forms ? "  fields: [" + forms + "]" : ""}`;
    })
    .join("\n") || "(no routes discovered)";

  const partitions = partitionByModule(testCases, { fallback: "unassigned" });
  const specsByModule = new Map();
  const stats = { total: testCases.length, batches: 0, enriched: 0, cached: 0, failed: 0 };
  const enrichmentByTcId = new Map();

  for (const [moduleSlug, moduleCases] of partitions) {
    const uncached = [];
    for (const tc of moduleCases) {
      if (!tc.testCaseId) continue;
      // Compute per-test snapshot URLs used for grounding (empty when we
      // have no snapshots) so the cache key invalidates when adding snapshots.
      let snapUrls = [];
      if (snapshotsByUrl && snapshotsByUrl.size) {
        const hints = [tc.page, tc.summary, tc.testSteps].filter(Boolean).map((s) => String(s).toLowerCase());
        for (const hint of hints) {
          const snap = pickSnapshotForRoute(hint, snapshotsByUrl);
          if (snap) { snapUrls.push(snap.url); break; }
        }
      }
      const key = tcFingerprint(tc, storyById.get(tc.storyId) || {}, journeyIndex, snapUrls);
      const cached = repoRoot ? await readCached(repoRoot, "tc-" + key) : null;
      if (cached) {
        enrichmentByTcId.set(tc.testCaseId, cached);
        stats.cached += 1;
      } else {
        uncached.push({ tc, key });
      }
    }
    // Batch the uncached
    for (let i = 0; i < uncached.length; i += batchSize) {
      const chunk = uncached.slice(i, i + batchSize);
      // Attach the best-matching recorded snapshot for each test case's
      // Page / Screen hint. Only include a snapshot once per batch even if
      // multiple test cases target the same page (keeps prompt compact).
      const snapshotsForBatch = [];
      const seenSnapUrls = new Set();
      if (snapshotsByUrl && snapshotsByUrl.size) {
        for (const { tc } of chunk) {
          const hints = [tc.page, tc.summary, tc.testSteps]
            .filter(Boolean)
            .map((s) => String(s).toLowerCase());
          for (const hint of hints) {
            const snap = pickSnapshotForRoute(hint, snapshotsByUrl);
            if (snap && !seenSnapUrls.has(snap.url)) {
              seenSnapUrls.add(snap.url);
              const text = formatSnapshotForPrompt(snap);
              if (text) snapshotsForBatch.push({ hint: snap.url, text });
              break;
            }
          }
        }
      }
      const batch = {
        testCases: chunk.map((c) => c.tc),
        storyById,
        contextBlock,
        snapshotsForBatch,
      };
      stats.batches += 1;
      logger(`[${moduleSlug}] batch ${stats.batches} — ${chunk.length} test cases`);
      try {
        const results = await llmBatchEnrich({ client, provider, model, batch });
        // Map results back by testCaseId. Fall back to positional order if
        // the LLM re-orders or omits IDs.
        for (let j = 0; j < chunk.length; j++) {
          const tc = chunk[j].tc;
          const key = chunk[j].key;
          const plan =
            results.find((r) => String(r.testCaseId).trim() === String(tc.testCaseId).trim()) ||
            results[j] ||
            null;
          if (plan?.steps?.length) {
            enrichmentByTcId.set(tc.testCaseId, plan);
            stats.enriched += 1;
            if (repoRoot) await writeCached(repoRoot, "tc-" + key, plan);
          }
        }
      } catch (error) {
        stats.failed += 1;
        logger(`  batch ${stats.batches} failed: ${error?.message || String(error)}`);
      }
      // Small delay to respect rate limits.
      await new Promise((r) => setTimeout(r, 200));
    }

    // Build the module's spec now (enriched where we have plans, skeleton otherwise)
    const moduleGroups = groupTestCasesByStory(moduleCases);
    const blocks = [];
    // Per-file title tracker so Playwright's "no duplicate titles" rule
    // is satisfied even when the same Test Case ID appears in multiple
    // stories in the same module.
    const seenTitlesPerFile = new Map();
    for (const [storyKey, cases] of moduleGroups) {
      const story = storyById.get(storyKey) || {
        id: storyKey === "__orphan__" ? null : storyKey,
        title: storyKey === "__orphan__" ? "Orphan test cases (no linked story)" : `Story ${storyKey}`,
      };
      blocks.push(buildStoryDescribeEnriched(story, cases, enrichmentByTcId, seenTitlesPerFile));
    }
    const spec = wrapSpec(blocks);
    specsByModule.set(moduleSlug, spec);
    if (typeof onModuleComplete === "function") {
      try {
        await onModuleComplete(moduleSlug, spec, { stats });
      } catch {}
    }
  }

  return { specsByModule, stats };
}

/**
 * Emit one skeleton `test()` per test case, with the prescriptive steps
 * + expected result as comments and a TODO body.
 */
function buildTestCaseSkeleton(story, tc, idx, seenTitles) {
  const testCaseId = tc.testCaseId || `TC-${idx + 1}`;
  const summary = (tc.summary || "test").replace(/\r?\n/g, " ").slice(0, 140);
  let testName = `${testCaseId}: ${summary}`;
  if (seenTitles) {
    if (seenTitles.has(testName)) {
      const n = (seenTitles.get(testName) || 1) + 1;
      seenTitles.set(testName, n);
      testName = `${testName} #${n}`;
    } else {
      seenTitles.set(testName, 1);
    }
  }
  const steps = (tc.testStepsArray && tc.testStepsArray.length
    ? tc.testStepsArray
    : String(tc.testSteps || "").split(/\r?\n/).filter(Boolean)
  ).map((s) => "    //   " + s.trim());
  const expectedLines = String(tc.expectedResult || "")
    .split(/\r?\n/)
    .map((s) => "    //   " + s.trim())
    .filter((l) => l.trim() !== "    //");
  return `  test(${JSON.stringify(testName)}, async ({ page }) => {
    // Page / Screen: ${tc.page || "(unspecified)"}
    // Type: ${tc.testType || "(unspecified)"} | Priority: ${tc.priority || "(unspecified)"}
    ${tc.prerequisites ? `//\n    // Prerequisites: ${tc.prerequisites.replace(/\r?\n/g, " ")}` : ""}
    //
    // Steps:
${steps.length ? steps.join("\n") : "    //   (no steps provided)"}
    //
    // Expected:
${expectedLines.length ? expectedLines.join("\n") : "    //   (none provided)"}
    ${tc.testData ? `//\n    // Test Data: ${tc.testData.replace(/\r?\n/g, " ")}` : ""}

    // TODO: implement per steps above.
    expect(true).toBeTruthy();
  });`;
}

function buildStoryDescribe(story, testCases) {
  const header = `${story.id ? story.id + " — " : ""}${story.title || "Untitled story"}`;
  const asA = story.asA ? `As a ${story.asA}` : null;
  const want = story.want ? `I want ${story.want}` : null;
  const benefit = story.benefit ? `So that ${story.benefit}` : null;
  const summary = [asA, want, benefit].filter(Boolean).join(" ") || (story.description || "").split(/\r?\n/)[0] || "";
  const ac = String(story.ac || "").split(/\r?\n/).filter(Boolean);
  const tests = testCases.map((tc, i) => buildTestCaseSkeleton(story, tc, i)).join("\n\n");
  return `test.describe(${JSON.stringify(header)}, () => {
  // ${summary}
  ${ac.length ? `//\n  // Acceptance Criteria:\n  //   ${ac.join("\n  //   ")}` : ""}

${tests}
});`;
}

/**
 * Generate one or more spec files from stories + test cases, split by
 * `Module / Sheet` column. Returns Map<moduleSlug, specSource>.
 *
 * Use this when the Excel has both a Stories sheet AND a Test Cases sheet
 * with a `User Story ID` foreign key. Falls back to per-story skeletons
 * when a story has no linked test cases.
 */
export function generateSpecsFromTestCases({
  stories = [],
  testCases = [],
  journeys = [],
} = {}) {
  const storyById = new Map(
    stories.filter((s) => s.id).map((s) => [String(s.id).trim(), s])
  );
  const byStory = groupTestCasesByStory(testCases);

  // Assign each test case its Module → then split the whole workbook
  // into per-module partitions of test cases.
  const partitions = partitionByModule(testCases, { fallback: "unassigned" });
  const specsByModule = new Map();

  for (const [moduleSlug, moduleCases] of partitions) {
    const moduleGroups = groupTestCasesByStory(moduleCases);
    const blocks = [];
    for (const [storyKey, cases] of moduleGroups) {
      const story =
        storyById.get(storyKey) ||
        // Synthesize a minimal story record when the sheet references a
        // story ID that isn't in the Stories sheet.
        {
          id: storyKey === "__orphan__" ? null : storyKey,
          title: storyKey === "__orphan__" ? "Orphan test cases (no linked story)" : `Story ${storyKey}`,
        };
      blocks.push(buildStoryDescribe(story, cases));
    }
    specsByModule.set(moduleSlug, wrapSpec(blocks));
  }
  return specsByModule;
}

/**
 * Aggregate stats across the multi-file emission — useful for the CLI
 * summary.
 */
export function testCaseStats({ stories, testCases }) {
  const storyIds = new Set(stories.map((s) => s.id).filter(Boolean));
  const linked = testCases.filter((tc) => tc.storyId && storyIds.has(tc.storyId)).length;
  const orphans = testCases.filter((tc) => !tc.storyId || !storyIds.has(tc.storyId)).length;
  const modules = new Set(testCases.map((tc) => tc.module || tc.sourceFile).filter(Boolean));
  return {
    totalStories: stories.length,
    totalTestCases: testCases.length,
    linkedToStory: linked,
    orphanTestCases: orphans,
    modules: modules.size,
  };
}

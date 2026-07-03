/**
 * Heal loop for story-generated Playwright specs.
 *
 * Reads a Playwright results.json, finds tests that failed with locator
 * / expectation errors, and for each one asks the LLM to rewrite JUST that
 * test's body using the actual DOM snapshot for the target URL. Applies
 * the patch in place to the spec file. Cached per (test-source-hash, error)
 * so re-runs are cheap.
 *
 * Design notes:
 *   - We DO NOT touch tests already marked with `test.fixme(...)` / `test.skip(...)`.
 *   - We DO NOT re-write test titles or describe blocks — just the body between
 *     the arrow-function braces.
 *   - Failures classified as "app-bug" (e.g. 5xx from the server, real
 *     validation surfacing) are NOT patched — they're recorded in a
 *     `bug-candidates.md` file for human triage.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pickSnapshotForRoute } from "./recorder.js";

const CACHE_DIR = ".qa-agent-cache/llm-heal";

const HEAL_LLM_PROMPT = `You are a QA engineer fixing a failing Playwright test. You will be shown:
1. The current test source (which failed)
2. The Playwright error output
3. A live DOM snapshot of the page at the moment of failure (real elements, real labels)

Your job: return a corrected test BODY (the code between the arrow function braces). Rules:

- Return JSON: { "kind": "patch", "body": "...", "confidence": "high|medium|low", "reason": "one-sentence why" }
  OR { "kind": "bug-candidate", "reason": "one-sentence why this looks like a real app bug, not a test problem" }
- Keep the same overall intent as the original test (goto same route, verify similar behavior).
- Use ONLY selectors that appear in the LIVE DOM SNAPSHOT. Do not invent labels, roles, or names.
- Keep the metadata comments (Page / Priority / Prerequisites / Expected) as they are.
- If the failure looks like a real app problem (500 error, missing feature, backend not returning data) rather than a test problem (wrong selector, wrong URL, wrong assertion), return "bug-candidate" instead of a patch.
- Prefer conservative fixes: change ONE selector at a time, don't restructure logic.
`;

const HEAL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: { enum: ["patch", "bug-candidate"] },
    body: { type: "string" },
    confidence: { enum: ["high", "medium", "low"] },
    reason: { type: "string" },
  },
};

// ---------- Failure classification & extraction ----------

const BUG_HINT_RE = /500\s*Internal|502\s*Bad|503\s*Service|504\s*Gateway|Error: [A-Z]+_\w+|panic|traceback|Uncaught (TypeError|ReferenceError)/i;

function classifyError(errorMessage) {
  if (!errorMessage) return "unknown";
  if (BUG_HINT_RE.test(errorMessage)) return "likely-app-bug";
  if (/locator|toBeVisible|toHaveURL|toHaveText|expected/i.test(errorMessage)) return "likely-selector";
  if (/Timeout/i.test(errorMessage)) return "timeout";
  return "unknown";
}

/**
 * Walk Playwright's results.json and yield each failing test as
 * { specFile, testTitle, error, url }.
 */
export function extractFailures(resultsJson) {
  const failures = [];
  function walk(suite, filePath) {
    const file = suite.file || filePath;
    for (const inner of suite.suites || []) walk(inner, file);
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        const result = (t.results || [])[t.results.length - 1];
        if (!result || result.status === "passed" || result.status === "skipped") continue;
        const err = result.errors?.[0]?.message || result.error?.message || "";
        failures.push({
          specFile: file,
          testTitle: spec.title,
          error: err,
          duration: result.duration,
          classification: classifyError(err),
        });
      }
    }
  }
  for (const s of resultsJson.suites || []) walk(s);
  return failures;
}

// ---------- Spec-file patching (regex-based, single test at a time) ----------

/**
 * Given a spec source string and a test title, replace the body of that
 * test with `newBody`. Returns null if the test can't be found. Only
 * touches `test("...", async ({...}) => { ... })` and `test('...',...)`,
 * NOT `test.fixme`, `test.skip`, or `test.describe`.
 */
export function replaceTestBody(source, testTitle, newBody) {
  // Locate the `test(...)` call whose first argument matches testTitle
  // exactly. We build a targeted regex per title to avoid false hits on
  // other tests that share a prefix.
  const escapedTitle = testTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/"/g, '\\"');
  const patterns = [
    new RegExp(`(\\btest\\(\\s*"${escapedTitle}"\\s*,\\s*async\\s*\\([^)]*\\)\\s*=>\\s*\\{)([\\s\\S]*?)(\\n\\s*\\}\\);)`, "m"),
    new RegExp(`(\\btest\\(\\s*'${testTitle.replace(/'/g, "\\'")}'\\s*,\\s*async\\s*\\([^)]*\\)\\s*=>\\s*\\{)([\\s\\S]*?)(\\n\\s*\\}\\);)`, "m"),
  ];
  for (const re of patterns) {
    const m = re.exec(source);
    if (m) {
      const indent = "    "; // consistent with the generator's indent
      const indentedBody = String(newBody)
        .split(/\r?\n/)
        .map((l) => (l.trim() ? indent + l.trim() : l))
        .join("\n");
      return source.slice(0, m.index) + m[1] + "\n" + indentedBody + m[3] + source.slice(m.index + m[0].length);
    }
  }
  return null;
}

/**
 * Extract the body of a test with the given title from a spec source.
 * Used to feed the LLM the "current source" of the failing test.
 */
export function extractTestSource(source, testTitle) {
  const escapedTitle = testTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/"/g, '\\"');
  const patterns = [
    new RegExp(`\\btest\\(\\s*"${escapedTitle}"\\s*,\\s*async\\s*\\([^)]*\\)\\s*=>\\s*\\{([\\s\\S]*?)\\n\\s*\\}\\);`, "m"),
    new RegExp(`\\btest\\(\\s*'${testTitle.replace(/'/g, "\\'")}'\\s*,\\s*async\\s*\\([^)]*\\)\\s*=>\\s*\\{([\\s\\S]*?)\\n\\s*\\}\\);`, "m"),
  ];
  for (const re of patterns) {
    const m = re.exec(source);
    if (m) return m[1];
  }
  return null;
}

// ---------- LLM invocation ----------

async function importClient(provider, apiKey) {
  const sdkName = provider === "openai" ? "openai" : "@anthropic-ai/sdk";
  const mod = await import(sdkName);
  const Ctor = mod.default || mod;
  return new Ctor({ apiKey });
}

function selectProvider({ anthropicKey, openaiKey, override }) {
  if (override) return override.toLowerCase();
  if (process.env.QA_LLM_PROVIDER) return process.env.QA_LLM_PROVIDER.toLowerCase();
  if (anthropicKey || process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (openaiKey || process.env.OPENAI_API_KEY) return "openai";
  return null;
}

async function askLlmToHeal({ client, provider, model, failure, currentBody, snapshotText }) {
  const userMessage = `Failing test:
- File: ${failure.specFile}
- Title: ${failure.testTitle}
- Error classification: ${failure.classification}

CURRENT TEST BODY:
\`\`\`js
${(currentBody || "(unable to extract)").trim()}
\`\`\`

PLAYWRIGHT ERROR:
${(failure.error || "(no error captured)").trim()}

${snapshotText ? `LIVE DOM SNAPSHOT (use this as ground truth):
${snapshotText}` : "NO DOM snapshot available for this route — patch conservatively or classify as bug-candidate if uncertain."}

Return the JSON now.`;

  if (provider === "openai") {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: HEAL_LLM_PROMPT },
        { role: "user", content: userMessage },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "heal_plan", strict: false, schema: HEAL_SCHEMA },
      },
    });
    const text = response.choices?.[0]?.message?.content;
    return text ? JSON.parse(text) : null;
  }
  const response = await client.messages.create({
    model,
    max_tokens: 2000,
    system: HEAL_LLM_PROMPT,
    output_config: { format: { type: "json_schema", schema: HEAL_SCHEMA } },
    messages: [{ role: "user", content: userMessage }],
  });
  const text = response.content?.find?.((b) => b.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

// ---------- Snapshot formatting (mirrors storiesToTests.js for consistency) ----------

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

function fingerprintHeal(failure, currentBody) {
  return crypto
    .createHash("sha1")
    .update(JSON.stringify({ testTitle: failure.testTitle, specFile: failure.specFile, error: failure.error, currentBody: currentBody?.slice(0, 500) }))
    .digest("hex");
}

async function readCached(repoRoot, key) {
  try {
    return JSON.parse(readFileSync(path.join(repoRoot, CACHE_DIR, key + ".json"), "utf8"));
  } catch {
    return null;
  }
}
async function writeCached(repoRoot, key, value) {
  try {
    const dir = path.join(repoRoot, CACHE_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, key + ".json"), JSON.stringify(value, null, 2), "utf8");
  } catch {}
}

// ---------- Public entrypoint ----------

/**
 * Heal a batch of failing tests. Returns:
 *   { patched: [{ specFile, testTitle, confidence }], bugCandidates: [...], failed: [...], stats }
 *
 * Writes patched spec files in place. Writes bug-candidates.md summarizing
 * the app-bug classifications.
 */
export async function healFailingTests({
  resultsJson,
  repoRoot,
  snapshotsByUrl = new Map(),
  anthropicApiKey,
  openaiApiKey,
  providerOverride,
  modelOverride,
  maxToHeal = 200,
  logger = () => {},
} = {}) {
  const provider = selectProvider({ anthropicKey: anthropicApiKey, openaiKey: openaiApiKey, override: providerOverride });
  if (!provider) throw new Error("healFailingTests: no LLM provider (set ANTHROPIC_API_KEY or OPENAI_API_KEY)");
  const model = modelOverride || process.env.QA_LLM_MODEL || (provider === "openai" ? "gpt-4o-mini" : "claude-sonnet-4-6");
  const apiKey =
    provider === "anthropic"
      ? anthropicApiKey || process.env.ANTHROPIC_API_KEY
      : openaiApiKey || process.env.OPENAI_API_KEY;
  const client = await importClient(provider, apiKey);

  const failures = extractFailures(resultsJson);
  logger(`extracted ${failures.length} failing tests from results.json`);

  const patched = [];
  const bugCandidates = [];
  const failed = [];
  const stats = { attempted: 0, patched: 0, bugCandidates: 0, cached: 0, failed: 0, skipped: 0 };

  // Group failures by spec file so we do disk writes in batches
  const failuresByFile = new Map();
  for (const f of failures.slice(0, maxToHeal)) {
    if (!failuresByFile.has(f.specFile)) failuresByFile.set(f.specFile, []);
    failuresByFile.get(f.specFile).push(f);
  }

  for (const [specFile, fileFailures] of failuresByFile) {
    const absSpec = path.isAbsolute(specFile) ? specFile : path.resolve(repoRoot, specFile);
    if (!existsSync(absSpec)) {
      logger(`spec not found on disk, skipping: ${specFile}`);
      stats.skipped += fileFailures.length;
      continue;
    }
    let source = readFileSync(absSpec, "utf8");
    let dirty = false;

    for (const failure of fileFailures) {
      stats.attempted += 1;
      const currentBody = extractTestSource(source, failure.testTitle);
      if (!currentBody) {
        logger(`  couldn't extract body for "${failure.testTitle.slice(0, 60)}..." — skipping`);
        stats.failed += 1;
        failed.push({ ...failure, reason: "body-extraction-failed" });
        continue;
      }

      // Fingerprint against cache
      const key = fingerprintHeal(failure, currentBody);
      let plan = repoRoot ? await readCached(repoRoot, key) : null;
      if (plan) stats.cached += 1;

      if (!plan) {
        // Look up a snapshot for the URL implied by the goto in currentBody
        const gotoMatch = /page\.goto\(\s*(?:urlFor\(\s*)?["'`]([^"'`]+)["'`]/.exec(currentBody);
        const routeHint = gotoMatch ? gotoMatch[1] : failure.testTitle;
        const snap = snapshotsByUrl && snapshotsByUrl.size ? pickSnapshotForRoute(routeHint, snapshotsByUrl) : null;
        const snapshotText = formatSnapshotForPrompt(snap);
        try {
          plan = await askLlmToHeal({ client, provider, model, failure, currentBody, snapshotText });
          if (plan && repoRoot) await writeCached(repoRoot, key, plan);
        } catch (error) {
          stats.failed += 1;
          logger(`  LLM heal failed: ${error?.message || String(error)}`);
          failed.push({ ...failure, reason: "llm-error", detail: error?.message });
          continue;
        }
      }

      if (!plan) {
        stats.failed += 1;
        failed.push({ ...failure, reason: "no-plan" });
        continue;
      }

      if (plan.kind === "bug-candidate") {
        bugCandidates.push({
          specFile,
          testTitle: failure.testTitle,
          error: failure.error,
          reason: plan.reason,
          classification: failure.classification,
        });
        stats.bugCandidates += 1;
        continue;
      }

      if (plan.kind === "patch" && plan.body) {
        const patchedSource = replaceTestBody(source, failure.testTitle, plan.body);
        if (patchedSource) {
          source = patchedSource;
          dirty = true;
          patched.push({
            specFile,
            testTitle: failure.testTitle,
            confidence: plan.confidence || "medium",
            reason: plan.reason,
          });
          stats.patched += 1;
          logger(`  patched: ${failure.testTitle.slice(0, 70)}...`);
        } else {
          stats.failed += 1;
          failed.push({ ...failure, reason: "replace-failed" });
        }
      }
    }

    if (dirty) {
      writeFileSync(absSpec, source, "utf8");
    }
  }

  // Bug-candidate report
  if (bugCandidates.length) {
    const md =
      `# Bug candidates from heal loop\n\nGenerated ${new Date().toISOString()}. These test failures look like real app issues, not test-selector problems. Triage before deciding they're bugs.\n\n` +
      bugCandidates
        .map((b) => `## ${b.testTitle}\n\n- **File:** ${b.specFile}\n- **Classification:** ${b.classification}\n- **Heal-loop reason:** ${b.reason}\n\n\`\`\`\n${(b.error || "").slice(0, 800)}\n\`\`\`\n`)
        .join("\n---\n\n");
    const outPath = path.join(repoRoot, "qa-results", "bug-candidates.md");
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(outPath, md, "utf8");
    stats.bugCandidatesFile = outPath;
  }

  return { patched, bugCandidates, failed, stats };
}

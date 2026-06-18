import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { parseQaFailures } from "./failureSchema.js";
import { classifyFailure } from "./classifier.js";
import { planValidationCommands, runValidationCommands } from "./validator.js";
import { buildRepoIndex as buildRepoIntelligence, defaultRepoIndexPath, readRepoIndex } from "./repoIndex.js";

const DEFAULT_MAX_FILES = 8;
const DEFAULT_MAX_FILE_CHARS = 10_000;
const DEFAULT_MAX_FAILURES = 5;

const SYSTEM_PROMPT = `You are a cautious coding agent fixing bugs reported by an automated QA testing agent.

Rules:
- Prefer the smallest source change that explains the failure.
- Use only exact before/after replacements in files provided in context.
- Do not modify generated reports, node_modules, lockfiles, or unrelated files.
- If the failure looks like a test/env/flaky issue, explain it and return no patches.
- Return JSON only.`;

const FIX_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "patches", "commands"],
  properties: {
    summary: { type: "string" },
    patches: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "before", "after", "reason"],
        properties: {
          path: { type: "string" },
          before: { type: "string" },
          after: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    commands: { type: "array", items: { type: "string" } },
  },
};

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9_/-]+/)
    .filter((token) => token.length >= 2);
}

function unique(items) {
  return [...new Set(items)];
}

function normalizeRelPath(file) {
  return String(file || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function execGit(repoRoot, args) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd: repoRoot, timeout: 10_000 }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      resolve(stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    });
  });
}

function execGitStrict(repoRoot, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: repoRoot, timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message || "").trim()));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function getChangedFiles(repoRoot) {
  const [modified, staged, untracked] = await Promise.all([
    execGit(repoRoot, ["diff", "--name-only"]),
    execGit(repoRoot, ["diff", "--cached", "--name-only"]),
    execGit(repoRoot, ["ls-files", "--others", "--exclude-standard"]),
  ]);
  return new Set([...modified, ...staged, ...untracked].map((file) => file.replaceAll(path.sep, "/")));
}

export async function buildFixIndex(repoRoot, { maxFileChars = DEFAULT_MAX_FILE_CHARS } = {}) {
  const repoIndex = await buildRepoIntelligence(repoRoot, { maxFileChars });
  return normalizeRepoIndexEntries(repoIndex.entries);
}

function normalizeRepoIndexEntries(entries = []) {
  return entries.map((entry) => ({
    path: entry.path,
    content: entry.content,
    role: entry.role,
    package: entry.package,
    route: entry.route,
    imports: entry.imports,
    symbols: entry.symbols,
    env: entry.env,
    api: entry.api,
    selectorHints: entry.selectorHints,
    tokens: entry.tokens,
    embedding: entry.embedding,
  }));
}

function lexicalScore(queryTokens, entry) {
  if (!queryTokens.length) return 0;
  const fileTokens = new Set(entry.tokens);
  let score = 0;
  for (const token of queryTokens) {
    if (fileTokens.has(token)) score += 3;
    if (entry.path.toLowerCase().includes(token)) score += 5;
    if (entry.route?.toLowerCase().includes(token)) score += 8;
    if (entry.symbols?.some((symbol) => symbol.toLowerCase().includes(token))) score += 5;
    if (entry.selectorHints?.some((hint) => hint.toLowerCase().includes(token))) score += 8;
    if (entry.api?.some((api) => api.toLowerCase().includes(token))) score += 4;
    if (entry.env?.some((env) => env.toLowerCase().includes(token))) score += 4;
  }
  return score;
}

function extractSelectorTerms(failure) {
  const text = `${failure.title || ""}\n${failure.error || ""}`;
  const selectors = [];
  const patterns = [
    /data-testid[=\s:'"`]+([A-Za-z0-9_.:-]+)/gi,
    /getByTestId\(["'`]([^"'`]+)["'`]\)/g,
    /getByRole\(["'`]([^"'`]+)["'`](?:,\s*\{\s*name:\s*["'`]([^"'`]+)["'`])?/g,
    /getBy(?:Text|Label|LabelText)\(["'`]([^"'`]+)["'`]\)/g,
    /locator\(["'`]([^"'`]+)["'`]\)/g,
    /\[data-testid=["']([^"']+)["']\]/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      selectors.push(...match.slice(1).filter(Boolean));
    }
  }
  return unique(selectors.map((selector) => selector.toLowerCase()));
}

function extractStackFiles(failure) {
  const text = `${failure.error || ""}\n${failure.raw?.error || ""}\n${failure.raw?.stack || ""}`;
  const files = [];
  const patterns = [
    /(?:at\s+.*?\()?((?:\.{0,2}\/)?[\w@./-]+\.[cm]?[jt]sx?):\d+:\d+\)?/g,
    /((?:\.{0,2}\/)?[\w@./-]+\.[cm]?[jt]sx?)\s*:\s*\d+\s*:\s*\d+/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      files.push(normalizeRelPath(match[1]));
    }
  }
  return unique(files.filter((file) => !file.includes("node_modules/")));
}

function routeTokens(failure) {
  const route = failure.route || String(failure.title || "").match(/(?:route|journey):\s*(\/[^\s>]+)/i)?.[1] || "";
  return route ? tokenize(route) : [];
}

function structuralScore(failure, entry) {
  let score = 0;
  const stackFiles = extractStackFiles(failure);
  const selectors = extractSelectorTerms(failure);
  const routes = routeTokens(failure);
  const relFailureFile = normalizeRelPath(failure.file);

  if (relFailureFile && entry.path === relFailureFile) score += entry.role === "test" ? 4 : 12;
  if (stackFiles.some((file) => entry.path.endsWith(file) || file.endsWith(entry.path))) score += 35;
  if (selectors.some((selector) => entry.selectorHints?.some((hint) => hint.toLowerCase() === selector))) score += 30;
  if (selectors.some((selector) => entry.content?.toLowerCase().includes(selector))) score += 12;
  if (routes.length && entry.route) {
    const entryRouteTokens = tokenize(entry.route);
    score += routes.filter((token) => entryRouteTokens.includes(token)).length * 10;
  }
  if (entry.role === "component" && failure.tool === "playwright") score += 2;
  return score;
}

function cosine(a, b) {
  let dot = 0;
  let aMag = 0;
  let bMag = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    dot += a[i] * b[i];
    aMag += a[i] * a[i];
    bMag += b[i] * b[i];
  }
  if (!aMag || !bMag) return 0;
  return dot / (Math.sqrt(aMag) * Math.sqrt(bMag));
}

async function embedTexts(texts, embedder) {
  if (!embedder) return null;
  if (typeof embedder === "function") return embedder(texts);
  if (typeof embedder.embed === "function") return embedder.embed(texts);
  if (embedder.embeddings?.create) {
    const response = await embedder.embeddings.create({
      model: process.env.QA_EMBEDDING_MODEL || "text-embedding-3-small",
      input: texts,
    });
    return response.data.map((item) => item.embedding);
  }
  return null;
}

export async function retrieveFixContext(failure, index, {
  maxFiles = DEFAULT_MAX_FILES,
  embedder = null,
  useEmbeddings = false,
} = {}) {
  const query = `${failure.tool || ""}\n${failure.title || ""}\n${failure.file || ""}\n${failure.error || ""}`;
  const queryTokens = unique(tokenize(query));
  let embeddings = null;

  const hasCachedEmbeddings = index.some((entry) => Array.isArray(entry.embedding));
  if (useEmbeddings && embedder) {
    if (hasCachedEmbeddings) {
      embeddings = await embedTexts([query], embedder);
    } else {
      const texts = [query, ...index.map((entry) => `${entry.path}\n${entry.content}`)];
      embeddings = await embedTexts(texts, embedder);
    }
  }

  const queryEmbedding = embeddings?.[0];
  return index
    .map((entry, idx) => {
      const lexical = lexicalScore(queryTokens, entry);
      const semanticVector = hasCachedEmbeddings ? entry.embedding : embeddings?.[idx + 1];
      const semantic = queryEmbedding && semanticVector ? cosine(queryEmbedding, semanticVector) * 50 : 0;
      const structural = structuralScore(failure, entry);
      return { path: entry.path, content: entry.content, score: lexical + semantic + structural, lexical, semantic, structural };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, maxFiles);
}

async function loadFixIndex(repoRoot, { indexPath, rebuildIndex = false, maxFileChars = DEFAULT_MAX_FILE_CHARS, logger = () => {} } = {}) {
  const resolvedIndexPath = indexPath ? path.resolve(indexPath) : defaultRepoIndexPath(repoRoot);
  if (!rebuildIndex) {
    try {
      const repoIndex = await readRepoIndex(repoRoot, { indexPath: resolvedIndexPath });
      logger(`loaded repo index from ${resolvedIndexPath}`);
      return {
        source: "cache",
        path: resolvedIndexPath,
        stats: repoIndex.stats || null,
        entries: normalizeRepoIndexEntries(repoIndex.entries || []),
      };
    } catch (error) {
      logger(`repo index unavailable; rebuilding in memory (${error.message})`);
    }
  }
  const repoIndex = await buildRepoIntelligence(repoRoot, { maxFileChars });
  return {
    source: rebuildIndex ? "rebuilt" : "memory",
    path: resolvedIndexPath,
    stats: repoIndex.stats || null,
    entries: normalizeRepoIndexEntries(repoIndex.entries || []),
  };
}

async function importClient(provider, apiKey) {
  const sdkName = provider === "openai" ? "openai" : "@anthropic-ai/sdk";
  const mod = await import(sdkName);
  const Ctor = mod.default || mod;
  return new Ctor({ apiKey });
}

function detectProvider(client, options = {}) {
  if (options.provider) return options.provider;
  if (client?.chat?.completions?.create) return "openai";
  if (client?.messages?.create) return "anthropic";
  const fromEnv = (process.env.QA_LLM_PROVIDER || "").toLowerCase();
  if (fromEnv === "openai" || fromEnv === "anthropic") return fromEnv;
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  return null;
}

function buildFixPrompt(failure, candidates) {
  const files = candidates.map((candidate) => `File: ${candidate.path}
\`\`\`
${candidate.content}
\`\`\``).join("\n\n");
  return `QA failure:
${JSON.stringify(failure, null, 2)}

Relevant repo files:
${files}

Return the minimal exact before/after replacements needed to fix the underlying source bug.`;
}

async function askForFix({ client, provider, model, failure, candidates }) {
  const prompt = buildFixPrompt(failure, candidates);
  if (provider === "openai") {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "repo_qa_fix", strict: false, schema: FIX_SCHEMA },
      },
    });
    const text = response.choices?.[0]?.message?.content;
    if (!text) throw new Error("fix LLM returned no content");
    return JSON.parse(text);
  }

  const response = await client.messages.create({
    model,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: "json_schema", schema: FIX_SCHEMA } },
    messages: [{ role: "user", content: prompt }],
  });
  const text = response.content?.find?.((block) => block.type === "text")?.text;
  if (!text) throw new Error("fix LLM returned no content");
  return JSON.parse(text);
}

export async function applyExactPatches(repoRoot, patches) {
  const results = [];
  for (const patch of patches || []) {
    const rel = path.normalize(patch.path).replaceAll(path.sep, "/");
    if (rel.startsWith("../") || path.isAbsolute(rel)) {
      results.push({ ...patch, applied: false, reason: "path outside repo" });
      continue;
    }
    const full = path.join(repoRoot, rel);
    let content;
    try {
      content = await fs.readFile(full, "utf8");
    } catch {
      results.push({ ...patch, applied: false, reason: "file not found" });
      continue;
    }
    if (!patch.before || !content.includes(patch.before)) {
      results.push({ ...patch, applied: false, reason: "before text not found" });
      continue;
    }
    const next = content.replace(patch.before, patch.after);
    await fs.writeFile(full, next, "utf8");
    results.push({ ...patch, applied: true });
  }
  return results;
}

export function buildPatchBundle(fixReport, { generatedAt = new Date().toISOString() } = {}) {
  const changes = [];
  for (const fix of fixReport?.fixes || []) {
    const attempts = fix.attempts?.length ? fix.attempts : [{
      attempt: 0,
      proposal: fix.proposal,
      patches: fix.patches,
      validationCommands: [],
      validation: [],
      validationOk: null,
    }];
    for (const attempt of attempts) {
      const patchResults = attempt.patches?.length ? attempt.patches : attempt.proposal?.patches || [];
      for (const patch of patchResults) {
        changes.push({
          failureId: fix.failure?.id || null,
          failureTitle: fix.failure?.title || "",
          classification: fix.classification?.type || null,
          attempt: attempt.attempt,
          path: patch.path,
          before: patch.before,
          after: patch.after,
          reason: patch.reason || "",
          applied: patch.applied === true,
          applyReason: patch.applied === false ? patch.reason : null,
          rollback: {
            path: patch.path,
            before: patch.after,
            after: patch.before,
            reason: `Rollback: ${patch.reason || "restore previous content"}`,
          },
        });
      }
    }
  }

  const files = unique(changes.map((change) => change.path)).sort();
  return {
    schemaVersion: 1,
    generatedAt,
    repo: fixReport?.repo || null,
    sourceReport: {
      failures: fixReport?.failures || 0,
      provider: fixReport?.provider || null,
      model: fixReport?.model || null,
      applied: Boolean(fixReport?.applied),
      validate: Boolean(fixReport?.validate),
      index: fixReport?.index || null,
    },
    summary: {
      changes: changes.length,
      files: files.length,
      applied: changes.filter((change) => change.applied).length,
    },
    files,
    changes,
  };
}

export async function rollbackPatchBundle(repoRoot, bundle) {
  const rollbackPatches = (bundle?.changes || [])
    .filter((change) => change.applied)
    .map((change) => change.rollback);
  return applyExactPatches(repoRoot, rollbackPatches);
}

async function copyFileIntoRepo(repoRoot, sourcePath, preferredRelativePath) {
  const rel = preferredRelativePath.replaceAll(path.sep, "/");
  const target = path.join(repoRoot, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(sourcePath, target);
  return target;
}

export async function createIsolatedWorktree(repoRoot, {
  worktreePath = null,
  branchName = null,
  logger = () => {},
} = {}) {
  const root = path.resolve(repoRoot);
  await execGitStrict(root, ["rev-parse", "--show-toplevel"]);
  await execGitStrict(root, ["rev-parse", "--verify", "HEAD"]);
  const target = worktreePath
    ? path.resolve(worktreePath)
    : await fs.mkdtemp(path.join(os.tmpdir(), "repo-qa-fix-worktree-"));
  const args = branchName
    ? ["worktree", "add", "-b", branchName, target, "HEAD"]
    : ["worktree", "add", "--detach", target, "HEAD"];
  logger(`creating isolated worktree at ${target}`);
  await execGitStrict(root, args);
  return {
    originalRepo: root,
    path: target,
    branch: branchName || null,
    cleanup: async () => {
      logger(`removing isolated worktree at ${target}`);
      await execGitStrict(root, ["worktree", "remove", "--force", target]);
    },
  };
}

export async function codingFixInWorktree({
  repoRoot,
  resultsPath,
  worktreePath,
  branchName,
  keepWorktree = false,
  logger = () => {},
  ...fixOptions
} = {}) {
  if (!repoRoot) throw new Error("fix worktree: repoRoot is required");
  if (!resultsPath) throw new Error("fix worktree: resultsPath is required");
  const worktree = await createIsolatedWorktree(repoRoot, { worktreePath, branchName, logger });
  let cleanupError = null;
  try {
    const copiedResults = await copyFileIntoRepo(worktree.path, path.resolve(resultsPath), "qa-results/worktree-fix-input.json");
    const report = await codingFix({
      ...fixOptions,
      resultsPath: copiedResults,
      repoRoot: worktree.path,
      rebuildIndex: true,
      logger,
    });
    return {
      ...report,
      worktree: {
        enabled: true,
        originalRepo: path.resolve(repoRoot),
        path: worktree.path,
        branch: worktree.branch,
        kept: Boolean(keepWorktree),
      },
    };
  } finally {
    if (!keepWorktree) {
      try {
        await worktree.cleanup();
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError) throw cleanupError;
  }
}

export function renderPrMarkdown(fixReport, bundle = buildPatchBundle(fixReport)) {
  const lines = [
    "# QA Agent Fix",
    "",
    "## Summary",
    "",
    `- Failures analyzed: ${fixReport?.failures || 0}`,
    `- Files changed: ${bundle.summary.files}`,
    `- Patch changes: ${bundle.summary.changes}`,
    `- Applied locally: ${bundle.summary.applied}`,
    `- Validation requested: ${fixReport?.validate ? "yes" : "no"}`,
    "",
    "## Failure Triage",
    "",
  ];

  for (const fix of fixReport?.fixes || []) {
    lines.push(`- ${fix.failure?.title || fix.failure?.id || "Untitled failure"} (${fix.classification?.type || "unclassified"})`);
    if (fix.proposal?.summary) lines.push(`  - Fix: ${fix.proposal.summary}`);
    const candidates = (fix.candidates || []).slice(0, 3).map((candidate) => candidate.path).join(", ");
    if (candidates) lines.push(`  - Top context: ${candidates}`);
    const lastAttempt = fix.attempts?.at?.(-1);
    if (lastAttempt?.validation?.length) {
      const status = lastAttempt.validationOk ? "passed" : "failed";
      lines.push(`  - Validation: ${status}`);
      for (const result of lastAttempt.validation) {
        lines.push(`    - \`${result.command}\`: ${result.ok ? "ok" : "failed"}`);
      }
    }
  }

  lines.push("", "## Changed Files", "");
  if (bundle.files.length) {
    for (const file of bundle.files) lines.push(`- \`${file}\``);
  } else {
    lines.push("- No source patches proposed.");
  }

  lines.push("", "## Rollback", "");
  if (bundle.summary.applied) {
    lines.push("Use the patch bundle rollback entries to restore each exact replacement.");
  } else {
    lines.push("No local patches were applied.");
  }

  return lines.join("\n") + "\n";
}

export async function codingFix({
  resultsPath,
  repoRoot,
  apply = false,
  client,
  provider,
  model,
  embedder,
  useEmbeddings = false,
  maxFiles = DEFAULT_MAX_FILES,
  maxFailures = DEFAULT_MAX_FAILURES,
  classifyOnly = false,
  changedOnly = false,
  validate = false,
  maxAttempts = 1,
  validationTimeoutMs,
  indexPath,
  rebuildIndex = false,
  logger = () => {},
} = {}) {
  if (!resultsPath) throw new Error("fix: resultsPath is required");
  if (!repoRoot) throw new Error("fix: repoRoot is required");

  const root = path.resolve(repoRoot);
  const report = JSON.parse(await fs.readFile(resultsPath, "utf8"));
  const failures = parseQaFailures(report).slice(0, maxFailures);
  const loadedIndex = await loadFixIndex(root, { indexPath, rebuildIndex, logger });
  let index = loadedIndex.entries;
  if (changedOnly) {
    const changed = await getChangedFiles(root);
    index = index.filter((entry) => changed.has(entry.path));
  }
  const resolvedProvider = detectProvider(client, { provider });
  const resolvedModel = model || process.env.QA_LLM_MODEL || (resolvedProvider === "openai" ? "gpt-4o-mini" : "claude-sonnet-4-6");

  let resolvedClient = client;
  if (!resolvedClient && resolvedProvider) {
    const key = resolvedProvider === "openai" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
    if (key) resolvedClient = await importClient(resolvedProvider, key);
  }

  const fixes = [];
  for (const failure of failures) {
    const classification = classifyFailure(failure);
    const candidates = await retrieveFixContext(failure, index, { maxFiles, embedder, useEmbeddings });
    logger(`failure "${failure.title}" matched ${candidates.length} candidate file(s)`);
    let proposal = {
      summary: classifyOnly
        ? "Classify-only mode; no patch proposal requested."
        : resolvedClient ? "No proposal generated." : "No LLM client/API key available; triage only.",
      patches: [],
      commands: [],
    };
    let patchResults = [];
    const attempts = [];

    if (!classifyOnly && resolvedClient && candidates.length) {
      const attemptCount = Math.max(1, Number(maxAttempts) || 1);
      for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
      proposal = await askForFix({
        client: resolvedClient,
        provider: resolvedProvider,
        model: resolvedModel,
        failure,
        candidates,
      });
      if (apply) {
        patchResults = await applyExactPatches(root, proposal.patches || []);
      }
        const validationCommands = planValidationCommands(failure, proposal);
        const validation = validate && (apply || !proposal.patches?.length)
          ? await runValidationCommands(validationCommands, { cwd: root, timeoutMs: validationTimeoutMs })
          : [];
        const validationOk = validation.length ? validation.every((result) => result.ok) : null;
        attempts.push({
          attempt,
          proposal,
          patches: patchResults,
          validationCommands,
          validation,
          validationOk,
        });
        if (!validate || validationOk === true || !apply) break;
      }
    }

    fixes.push({
      failure,
      classification,
      candidates: candidates.map(({ path: filePath, score, lexical, semantic, structural }) => ({ path: filePath, score, lexical, semantic, structural })),
      proposal,
      patches: patchResults,
      attempts,
    });
  }

  return {
    repo: root,
    failures: failures.length,
    provider: resolvedProvider,
    model: resolvedProvider ? resolvedModel : null,
    embeddings: Boolean(useEmbeddings && embedder),
    applied: Boolean(apply),
    changedOnly: Boolean(changedOnly),
    classifyOnly: Boolean(classifyOnly),
    validate: Boolean(validate),
    index: {
      source: loadedIndex.source,
      path: loadedIndex.path,
      stats: loadedIndex.stats,
    },
    fixes,
  };
}

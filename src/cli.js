#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { scanRepository, detectStack, createTestPlan, generateAssets, applyAssets, discoverUserJourneys, enrichJourneys, crawlSite, mergeJourneys, importHar, repair, bootstrapVisual, codingFix, codingFixInWorktree, buildRepoIndex, writeRepoIndex, queryRepoIndex, buildPatchBundle, renderPrMarkdown } from "./index.js";
import { loadDotenv } from "./loadEnv.js";
import { writePlaywrightCoverageExcel } from "./playwrightExcel.js";

const KNOWN_TOOLS = ["playwright", "vitest", "sonarqube", "postman", "trivy", "k6", "axe", "gitleaks", "semgrep", "visual"];

function splitList(value) {
  return value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function validateTools(label, list) {
  const unknown = list.filter((tool) => !KNOWN_TOOLS.includes(tool));
  if (unknown.length) {
    throw new Error(`Unknown ${label} tool(s): ${unknown.join(", ")}. Known: ${KNOWN_TOOLS.join(", ")}`);
  }
}

function printHelp() {
  console.log(`Usage: repo-qa-agent [repoPath] [options]

Options:
  --write              Write generated assets into the repo
  --overwrite          Overwrite existing files (--force is an alias)
  --force              Alias for --overwrite
  --dry-run            Force preview mode (cannot combine with --write)
  --only <tools>       Comma-separated list of tools to keep (${KNOWN_TOOLS.join(", ")})
  --skip <tools>       Comma-separated list of tools to skip
  --plan <path>        Also write the plan JSON to this path
  --crawl-url <url>    Crawl a live deployment, merge discovered routes with
                       the static-scan journeys, and use the captured HTML as
                       the LLM enrichment input (instead of source code).
  --crawl-depth N      BFS depth for --crawl-url (default 2)
  --crawl-max N        Max pages for --crawl-url (default 100)
  --help, -h           Show this help

LLM enrichment (required when the Playwright stage is enabled):
  Set ANTHROPIC_API_KEY (Claude) or OPENAI_API_KEY (GPT) before running.
  Anthropic is preferred when both are set; override with
  QA_LLM_PROVIDER=openai|anthropic.
  Defaults: claude-sonnet-4-6 / gpt-4o-mini (override with QA_LLM_MODEL).
  Cache: .qa-agent-cache/llm-enrich/

Subcommands:
  coverage-excel <playwright-json-report> --out <report.xls>
                       Convert a Playwright JSON report to an Excel-friendly workbook
  crawl <baseUrl> [--depth N] [--max N] [--out <path>]
                       Breadth-first link-graph crawl from baseUrl. Prints JSON
                       to stdout (or writes to --out). Use to discover dynamic
                       routes the static scan misses.
  har <file.har> [--out postman/qa-collection.json] [--replace] [--filter-origin <origin>]
                       Import requests from a HAR file (DevTools > Network >
                       export) into a Postman v2.1 collection. Default merges
                       into existing collection, deduping by method+URL.
  index <repo> [--out <path>] [--query <text>] [--use-embeddings]
                       Build the repo intelligence cache used by the fixer:
                       lexical tokens, symbols, routes, imports, selector
                       hints, API/env refs, and package boundaries.
  repair <results.json> --base-url <url> [--repo <path>] [--apply]
                       LLM-driven test repair. Reads a Playwright results.json,
                       finds tests that failed with locator errors, fetches the
                       live DOM for each affected route, and asks the LLM for
                       fresh assertions. With --apply, surgically replaces the
                       ENRICHED block in tests/e2e/user-journeys.spec.ts.
                       Without --apply, updates the LLM cache (next agent run
                       picks up the new assertions).
  fix <results.json> [--repo <path>] [--apply] [--validate] [--worktree] [--use-embeddings] [--index <path>] [--rebuild-index] [--out <path>] [--bundle-out <path>] [--pr-out <path>]
                       Coding-agent loop for QA failures. Parses Playwright/
                       QA JSON, retrieves likely source files, asks the LLM for
                       exact before/after patches, and applies them only when
                       --apply is set. Without an API key, emits triage only.
                       By default writes qa-results/fix-report.json.
  `);
}

function parseArgs(argv) {
  const args = {
    repoPath: ".",
    write: false,
    overwrite: false,
    dryRun: false,
    only: [],
    skip: [],
    planPath: null,
    crawlUrl: null,
    crawlDepth: 2,
    crawlMax: 100,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--write") args.write = true;
    else if (arg === "--overwrite" || arg === "--force") args.overwrite = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--only") {
      args.only = splitList(argv[i + 1] || "");
      i += 1;
    } else if (arg === "--skip") {
      args.skip = splitList(argv[i + 1] || "");
      i += 1;
    } else if (arg === "--plan") {
      args.planPath = argv[i + 1];
      i += 1;
    } else if (arg === "--crawl-url") {
      args.crawlUrl = argv[i + 1];
      i += 1;
    } else if (arg === "--crawl-depth") {
      args.crawlDepth = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--crawl-max") {
      args.crawlMax = Number(argv[i + 1]);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (!arg.startsWith("-")) {
      args.repoPath = arg;
    }
  }
  validateTools("--only", args.only);
  validateTools("--skip", args.skip);
  if (args.dryRun && args.write) {
    throw new Error("--dry-run cannot be combined with --write");
  }
  return args;
}

function parseRepairArgs(argv) {
  const args = { input: argv[1], baseUrl: null, repoPath: ".", apply: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url") { args.baseUrl = argv[i + 1]; i += 1; }
    else if (arg === "--repo") { args.repoPath = argv[i + 1]; i += 1; }
    else if (arg === "--apply") { args.apply = true; }
  }
  return args;
}

function parseFixArgs(argv) {
  const args = {
    input: argv[1],
    repoPath: ".",
    apply: false,
    validate: false,
    classifyOnly: false,
    changedOnly: false,
    useEmbeddings: false,
    outPath: null,
    bundleOutPath: null,
    prOutPath: null,
    indexPath: null,
    rebuildIndex: false,
    worktree: false,
    keepWorktree: false,
    worktreePath: null,
    worktreeBranch: null,
    maxFiles: undefined,
    maxFailures: undefined,
    maxAttempts: undefined,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--repo") { args.repoPath = argv[i + 1]; i += 1; }
    else if (arg === "--apply") { args.apply = true; }
    else if (arg === "--validate") { args.validate = true; }
    else if (arg === "--classify-only") { args.classifyOnly = true; }
    else if (arg === "--changed-only") { args.changedOnly = true; }
    else if (arg === "--use-embeddings") { args.useEmbeddings = true; }
    else if (arg === "--out") { args.outPath = argv[i + 1]; i += 1; }
    else if (arg === "--bundle-out") { args.bundleOutPath = argv[i + 1]; i += 1; }
    else if (arg === "--pr-out") { args.prOutPath = argv[i + 1]; i += 1; }
    else if (arg === "--index") { args.indexPath = argv[i + 1]; i += 1; }
    else if (arg === "--rebuild-index") { args.rebuildIndex = true; }
    else if (arg === "--worktree") { args.worktree = true; }
    else if (arg === "--keep-worktree") { args.keepWorktree = true; }
    else if (arg === "--worktree-path") { args.worktreePath = argv[i + 1]; i += 1; }
    else if (arg === "--worktree-branch") { args.worktreeBranch = argv[i + 1]; i += 1; }
    else if (arg === "--max-files") { args.maxFiles = Number(argv[i + 1]); i += 1; }
    else if (arg === "--max-failures") { args.maxFailures = Number(argv[i + 1]); i += 1; }
    else if (arg === "--max-attempts") { args.maxAttempts = Number(argv[i + 1]); i += 1; }
  }
  return args;
}

function parseIndexArgs(argv) {
  const args = {
    repoPath: argv[1] || ".",
    outPath: null,
    query: null,
    useEmbeddings: false,
    maxFiles: 8,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") { args.outPath = argv[i + 1]; i += 1; }
    else if (arg === "--query") { args.query = argv[i + 1]; i += 1; }
    else if (arg === "--use-embeddings") { args.useEmbeddings = true; }
    else if (arg === "--max-files") { args.maxFiles = Number(argv[i + 1]); i += 1; }
  }
  return args;
}

function parseHarArgs(argv) {
  const args = { input: argv[1], outPath: "postman/qa-collection.json", replace: false, filterOrigin: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") { args.outPath = argv[i + 1]; i += 1; }
    else if (arg === "--replace") { args.replace = true; }
    else if (arg === "--filter-origin") { args.filterOrigin = argv[i + 1]; i += 1; }
  }
  return args;
}

function parseCrawlArgs(argv) {
  const args = { baseUrl: argv[1], depth: undefined, max: undefined, outPath: null };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--depth") { args.depth = Number(argv[i + 1]); i += 1; }
    else if (arg === "--max") { args.max = Number(argv[i + 1]); i += 1; }
    else if (arg === "--out") { args.outPath = argv[i + 1]; i += 1; }
  }
  return args;
}

function parseCoverageArgs(argv) {
  const args = {
    inputPath: argv[1],
    outputPath: "playwright-coverage.xls",
  };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--out") {
      args.outputPath = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  // Load .env / .env.local from CWD up-front so subcommands can rely on
  // ANTHROPIC_API_KEY / OPENAI_API_KEY being populated without users having
  // to export them every shell session. Existing exports always win.
  await loadDotenv(process.cwd());

  if (argv[0] === "coverage-excel") {
    const args = parseCoverageArgs(argv);
    if (!args.inputPath) {
      throw new Error("Usage: repo-qa-agent coverage-excel <playwright-json-report> --out <report.xls>");
    }
    const summary = await writePlaywrightCoverageExcel(args.inputPath, args.outputPath);
    console.log(JSON.stringify({ output: path.resolve(args.outputPath), summary }, null, 2));
    return;
  }

  if (argv[0] === "repair") {
    const repairArgs = parseRepairArgs(argv);
    if (!repairArgs.input) {
      throw new Error("Usage: repo-qa-agent repair <playwright-results.json> --base-url <url> [--repo <path>] [--apply]");
    }
    if (!repairArgs.baseUrl) {
      throw new Error("repair: --base-url is required (the agent fetches the live DOM to ask the LLM for new selectors)");
    }
    const repoRoot = path.resolve(repairArgs.repoPath);
    if (repoRoot !== path.resolve(process.cwd())) {
      await loadDotenv(repoRoot);
    }
    const result = await repair({
      resultsPath: path.resolve(repairArgs.input),
      repoRoot,
      baseUrl: repairArgs.baseUrl,
      apply: repairArgs.apply,
      logger: (msg) => process.stderr.write("[repair] " + msg + "\n"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (argv[0] === "index") {
    const indexArgs = parseIndexArgs(argv);
    const repoRoot = path.resolve(indexArgs.repoPath);
    if (repoRoot !== path.resolve(process.cwd())) {
      await loadDotenv(repoRoot);
    }
    let embedder = null;
    if (indexArgs.useEmbeddings && process.env.OPENAI_API_KEY) {
      const { default: OpenAI } = await import("openai");
      embedder = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    const index = await buildRepoIndex(repoRoot, {
      useEmbeddings: indexArgs.useEmbeddings,
      embedder,
    });
    const wrote = await writeRepoIndex(repoRoot, index, indexArgs.outPath ? { outPath: indexArgs.outPath } : {});
    const output = {
      wrote,
      repo: index.repo,
      stats: index.stats,
    };
    if (indexArgs.query) {
      output.matches = queryRepoIndex(index, indexArgs.query, {
        maxFiles: Number.isFinite(indexArgs.maxFiles) ? indexArgs.maxFiles : 8,
      }).map((entry) => ({
        path: entry.path,
        score: entry.score,
        role: entry.role,
        route: entry.route,
        symbols: entry.symbols.slice(0, 10),
      }));
    }
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  if (argv[0] === "fix") {
    const fixArgs = parseFixArgs(argv);
    if (!fixArgs.input) {
      throw new Error("Usage: repo-qa-agent fix <qa-results.json> [--repo <path>] [--apply] [--worktree] [--use-embeddings] [--index <path>] [--rebuild-index] [--out <path>] [--bundle-out <path>] [--pr-out <path>]");
    }
    const repoRoot = path.resolve(fixArgs.repoPath);
    if (repoRoot !== path.resolve(process.cwd())) {
      await loadDotenv(repoRoot);
    }
    let embedder = null;
    if (fixArgs.useEmbeddings && process.env.OPENAI_API_KEY) {
      const { default: OpenAI } = await import("openai");
      embedder = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    const runFix = fixArgs.worktree ? codingFixInWorktree : codingFix;
    const result = await runFix({
      resultsPath: path.resolve(fixArgs.input),
      repoRoot,
      apply: fixArgs.apply,
      validate: fixArgs.validate,
      classifyOnly: fixArgs.classifyOnly,
      changedOnly: fixArgs.changedOnly,
      indexPath: fixArgs.indexPath ? path.resolve(fixArgs.indexPath) : undefined,
      rebuildIndex: fixArgs.rebuildIndex,
      useEmbeddings: fixArgs.useEmbeddings,
      embedder,
      maxFiles: Number.isFinite(fixArgs.maxFiles) ? fixArgs.maxFiles : undefined,
      maxFailures: Number.isFinite(fixArgs.maxFailures) ? fixArgs.maxFailures : undefined,
      maxAttempts: Number.isFinite(fixArgs.maxAttempts) ? fixArgs.maxAttempts : undefined,
      keepWorktree: fixArgs.keepWorktree,
      worktreePath: fixArgs.worktreePath ? path.resolve(fixArgs.worktreePath) : undefined,
      branchName: fixArgs.worktreeBranch || undefined,
      logger: (msg) => process.stderr.write("[fix] " + msg + "\n"),
    });
    const output = JSON.stringify(result, null, 2);
    const outPath = fixArgs.outPath || path.join(repoRoot, "qa-results", "fix-report.json");
    await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
    await fs.writeFile(outPath, output + "\n", "utf8");
    const wrote = { report: path.resolve(outPath) };
    if (fixArgs.bundleOutPath) {
      const bundle = buildPatchBundle(result);
      const bundlePath = path.resolve(repoRoot, fixArgs.bundleOutPath);
      await fs.mkdir(path.dirname(bundlePath), { recursive: true });
      await fs.writeFile(bundlePath, JSON.stringify(bundle, null, 2) + "\n", "utf8");
      wrote.bundle = bundlePath;
    }
    if (fixArgs.prOutPath) {
      const bundle = buildPatchBundle(result);
      const prPath = path.resolve(repoRoot, fixArgs.prOutPath);
      await fs.mkdir(path.dirname(prPath), { recursive: true });
      await fs.writeFile(prPath, renderPrMarkdown(result, bundle), "utf8");
      wrote.pr = prPath;
    }
    console.log(JSON.stringify({ wrote, failures: result.failures, applied: result.applied }, null, 2));
    return;
  }

  if (argv[0] === "bootstrap-visual") {
    const repoPath = argv[1] || ".";
    const result = await bootstrapVisual(repoPath, {
      logger: (msg) => process.stderr.write(msg + "\n"),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (argv[0] === "har") {
    const harArgs = parseHarArgs(argv);
    if (!harArgs.input) {
      throw new Error("Usage: repo-qa-agent har <file.har> [--out postman/qa-collection.json] [--replace] [--filter-origin <https://host>]");
    }
    const result = await importHar(harArgs.input, {
      outPath: harArgs.outPath,
      merge: !harArgs.replace,
      filterOrigin: harArgs.filterOrigin,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (argv[0] === "crawl") {
    const crawlArgs = parseCrawlArgs(argv);
    if (!crawlArgs.baseUrl) {
      throw new Error("Usage: repo-qa-agent crawl <baseUrl> [--depth N] [--max N] [--out <path>]");
    }
    const journeys = await crawlSite(crawlArgs.baseUrl, {
      depth: crawlArgs.depth,
      maxPages: crawlArgs.max,
      logger: (msg) => process.stderr.write("[crawl] " + msg + "\n"),
    });
    const output = JSON.stringify({ baseUrl: crawlArgs.baseUrl, count: journeys.length, journeys }, null, 2);
    if (crawlArgs.outPath) {
      await fs.writeFile(crawlArgs.outPath, output + "\n", "utf8");
      console.log(JSON.stringify({ wrote: path.resolve(crawlArgs.outPath), count: journeys.length }, null, 2));
    } else {
      console.log(output);
    }
    return;
  }

  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  const args = parseArgs(argv);
  // Also load .env from the *target* repo (if different from cwd) so keys can
  // live alongside the project the agent is scanning.
  const resolvedRepo = path.resolve(args.repoPath);
  if (resolvedRepo !== path.resolve(process.cwd())) {
    await loadDotenv(resolvedRepo);
  }
  const scan = await scanRepository(args.repoPath);
  const stack = detectStack(scan);
  const plan = createTestPlan(scan, stack, { only: args.only, skip: args.skip });

  // Static journey discovery. May be augmented with live-crawled routes below.
  let journeys = discoverUserJourneys(scan.files, { repoRoot: scan.root });
  let crawlStats = null;

  if (args.crawlUrl && plan.enabledTools.includes("playwright")) {
    const crawled = await crawlSite(args.crawlUrl, {
      depth: args.crawlDepth,
      maxPages: args.crawlMax,
      captureHtml: true,
      logger: (msg) => process.stderr.write("[crawl] " + msg + "\n"),
    });
    const before = journeys.length;
    journeys = mergeJourneys(journeys, crawled);
    crawlStats = {
      baseUrl: args.crawlUrl,
      depth: args.crawlDepth,
      crawled: crawled.length,
      newRoutes: journeys.length - before,
      total: journeys.length,
    };
  }

  let enrichmentStats = { provider: null, model: null, requested: 0, cached: 0, succeeded: 0, failed: 0, skipped: 0 };
  let enrichmentMap = new Map();
  // LLM enrichment is mandatory for the Playwright journey spec. If a repo
  // would scaffold Playwright but no API key is configured, abort with a
  // clear error rather than emitting an unenriched skeleton.
  const playwrightEnabled = plan.enabledTools.includes("playwright");
  if (playwrightEnabled && !process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    throw new Error(
      "LLM enrichment is required when the Playwright stage is enabled. " +
      "Set ANTHROPIC_API_KEY or OPENAI_API_KEY before running the agent."
    );
  }
  if (playwrightEnabled) {
    const result = await enrichJourneys({
      repoRoot: scan.root,
      journeys,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      openaiApiKey: process.env.OPENAI_API_KEY,
      model: process.env.QA_LLM_MODEL,
      logger: (msg) => process.stderr.write("[llm-enrich] " + msg + "\n"),
    });
    enrichmentMap = result.enriched;
    enrichmentStats = result.stats;
  }

  const assets = generateAssets(scan, plan, { enrichment: enrichmentMap, journeys });
  const planPath = args.planPath ? path.resolve(args.repoPath, args.planPath) : null;

  if (planPath) {
    await fs.writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  }

  const result = {
    repo: scan.root,
    plan,
    scriptsToAdd: JSON.parse(assets.packageJson).scripts,
    filesToAdd: assets.files.map((file) => file.path),
    enabledTools: plan.enabledTools,
    filters: plan.filters,
    mode: args.write ? "write" : "preview",
    enrichment: {
      enabled: Boolean(playwrightEnabled),
      stats: enrichmentStats,
    },
    crawl: crawlStats,
  };

  if (args.write) {
    result.apply = await applyAssets(scan.root, assets, { overwrite: args.overwrite });
    const wrotePackage = result.apply.written.includes("package.json");
    if (wrotePackage) {
      result.nextSteps = [
        "npm install     # fetch newly-added devDependencies",
        "npm run qa:all  # run the full pipeline",
      ];
    }
  }

  console.log(JSON.stringify(result, null, 2));
  if (args.write && result.apply?.written.includes("package.json")) {
    process.stderr.write("\n[qa-agent] package.json updated. Run `npm install` to fetch new devDependencies before `npm run qa:all`.\n");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

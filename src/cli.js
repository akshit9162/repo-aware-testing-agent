#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { scanRepository, detectStack, createTestPlan, generateAssets, applyAssets, discoverUserJourneys, enrichJourneys, crawlSite, mergeJourneys, importHar } from "./index.js";
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
  --no-llm             Disable LLM journey enrichment (also: QA_LLM=0)
  --crawl-url <url>    Crawl a live deployment, merge discovered routes with
                       the static-scan journeys, and use the captured HTML as
                       the LLM enrichment input (instead of source code).
  --crawl-depth N      BFS depth for --crawl-url (default 2)
  --crawl-max N        Max pages for --crawl-url (default 100)
  --help, -h           Show this help

LLM enrichment:
  Set ANTHROPIC_API_KEY (Claude) or OPENAI_API_KEY (GPT) to enrich the
  Playwright user-journey assertions per route. Anthropic is preferred
  when both keys are set; override with QA_LLM_PROVIDER=openai|anthropic.
  Defaults: claude-sonnet-4-6 / gpt-4o-mini (override with
  QA_LLM_MODEL). Requires @anthropic-ai/sdk or openai installed.
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
    llm: process.env.QA_LLM !== "0",
    crawlUrl: null,
    crawlDepth: 2,
    crawlMax: 100,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--write") args.write = true;
    else if (arg === "--overwrite" || arg === "--force") args.overwrite = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--no-llm") args.llm = false;
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
  if (argv[0] === "coverage-excel") {
    const args = parseCoverageArgs(argv);
    if (!args.inputPath) {
      throw new Error("Usage: repo-qa-agent coverage-excel <playwright-json-report> --out <report.xls>");
    }
    const summary = await writePlaywrightCoverageExcel(args.inputPath, args.outputPath);
    console.log(JSON.stringify({ output: path.resolve(args.outputPath), summary }, null, 2));
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
  const scan = await scanRepository(args.repoPath);
  const stack = detectStack(scan);
  const plan = createTestPlan(scan, stack, { only: args.only, skip: args.skip });

  // Static journey discovery. May be augmented with live-crawled routes below.
  let journeys = discoverUserJourneys(scan.files);
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
  // Always invoke when Playwright is enabled — enrichJourneys falls back to
  // cache-only mode when no API key is present, preserving prior enrichments.
  const llmEligible = args.llm && plan.enabledTools.includes("playwright");
  if (llmEligible) {
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
      enabled: Boolean(llmEligible),
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

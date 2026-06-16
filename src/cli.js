#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { scanRepository, detectStack, createTestPlan, generateAssets, applyAssets } from "./index.js";
import { writePlaywrightCoverageExcel } from "./playwrightExcel.js";

const KNOWN_TOOLS = ["playwright", "vitest", "sonarqube", "postman", "trivy", "k6"];

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
  --help, -h           Show this help

Subcommands:
  coverage-excel <playwright-json-report> --out <report.xls>
                       Convert a Playwright JSON report to an Excel-friendly workbook
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

  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  const args = parseArgs(argv);
  const scan = await scanRepository(args.repoPath);
  const stack = detectStack(scan);
  const plan = createTestPlan(scan, stack, { only: args.only, skip: args.skip });
  const assets = generateAssets(scan, plan);
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
  };

  if (args.write) {
    result.apply = await applyAssets(scan.root, assets, { overwrite: args.overwrite });
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

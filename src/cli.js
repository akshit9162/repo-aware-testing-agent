#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { scanRepository, detectStack, createTestPlan, generateAssets, applyAssets } from "./index.js";
import { writePlaywrightCoverageExcel } from "./playwrightExcel.js";

function parseArgs(argv) {
  const args = {
    repoPath: ".",
    write: false,
    overwrite: false,
    planPath: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--write") args.write = true;
    else if (arg === "--overwrite") args.overwrite = true;
    else if (arg === "--plan") {
      args.planPath = argv[i + 1];
      i += 1;
    } else if (!arg.startsWith("-")) {
      args.repoPath = arg;
    }
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

  const args = parseArgs(argv);
  const scan = await scanRepository(args.repoPath);
  const stack = detectStack(scan);
  const plan = createTestPlan(scan, stack);
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

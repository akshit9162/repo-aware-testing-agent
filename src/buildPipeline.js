/**
 * The one-command pipeline: excel + repo + UAT urls + fixture → passing
 * test suite. Runs the 5 phases in sequence with progress logging and
 * writes a final report an inexperienced user can read.
 *
 * Phases:
 *   1. DISCOVER  — scan the repo, load any recorded UAT snapshots
 *   2. GROUND    — attach snapshots to each test case's target route
 *   3. GENERATE  — LLM-write Playwright tests grounded in DOM (batched)
 *   4. EXECUTE   — run the tests against QA_BASE_URL, capture results.json
 *   5. HEAL      — for each failure: DOM + error → LLM patch → rewrite in place
 *   (optional)     Optionally re-run and repeat up to N heal rounds
 */

import { spawn } from "node:child_process";
import { promises as fs, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { scanRepository } from "./scanner.js";
import { discoverUserJourneys } from "./journeys.js";
import { annotateJourneysWithForms } from "./formFieldDiscovery.js";
import { parseStoriesFile } from "./storiesImport.js";
import { enrichSpecsFromTestCases, testCaseStats } from "./storiesToTests.js";
import { apisToPostmanCollection } from "./storiesToPostman.js";
import { loadRecordedSnapshots } from "./recorder.js";
import { healFailingTests } from "./healStories.js";

// ---------- helpers ----------

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: opts.captureStdio ? ["ignore", "pipe", "pipe"] : "inherit",
      env: { ...process.env, ...(opts.env || {}) },
      cwd: opts.cwd || process.cwd(),
    });
    let stdout = "";
    let stderr = "";
    if (opts.captureStdio) {
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
    }
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (err) => resolve({ code: 1, stdout, stderr: String(err) }));
  });
}

async function loadSnapshotsFromPath(snapshotsPath) {
  if (!snapshotsPath) return new Map();
  try {
    const stat = await fs.stat(snapshotsPath);
    let files = [];
    if (stat.isDirectory()) {
      const names = await fs.readdir(snapshotsPath);
      files = names.filter((n) => n.endsWith(".json")).map((n) => path.join(snapshotsPath, n));
    } else {
      files = [snapshotsPath];
    }
    return loadRecordedSnapshots(files);
  } catch {
    return new Map();
  }
}

// ---------- report ----------

function buildRunReport({ phaseTiming, storyStats, enrichStats, runStats, healStats, bugCandidatesPath }) {
  const rows = [
    ["Phase timing", phaseTiming.map((p) => `${p.name}: ${(p.ms / 1000).toFixed(1)}s`).join(", ")],
    ["Stories in workbook", storyStats?.totalStories ?? 0],
    ["Test cases in workbook", storyStats?.totalTestCases ?? 0],
    ["Test cases enriched", enrichStats?.enriched ?? 0],
    ["Test cases cached", enrichStats?.cached ?? 0],
    ["Batches failed", enrichStats?.failed ?? 0],
    ["Playwright — passed", runStats?.passed ?? 0],
    ["Playwright — failed", runStats?.failed ?? 0],
    ["Playwright — skipped", runStats?.skipped ?? 0],
    ["Healer patched", healStats?.patched ?? 0],
    ["Healer bug candidates", healStats?.bugCandidates ?? 0],
    ["Bug candidates report", bugCandidatesPath || "(none)"],
  ];
  const md =
    `# QA Build Report\n\nGenerated ${new Date().toISOString()}.\n\n` +
    rows.map(([k, v]) => `- **${k}:** ${v}`).join("\n") +
    `\n\n---\n\nNext steps:\n- Review \`bug-candidates.md\` for real app issues flagged by the healer.\n- Un-\`.fixme()\` tests you want active as you verify them.\n- Re-run \`qa:e2e\` to lock in the healed pass rate.\n`;
  return md;
}

async function parsePlaywrightResults(resultsPath) {
  try {
    const raw = readFileSync(resultsPath, "utf8");
    const j = JSON.parse(raw);
    return { data: j, stats: j.stats || {} };
  } catch {
    return { data: null, stats: null };
  }
}

function countFromResults(data) {
  if (!data) return { passed: 0, failed: 0, skipped: 0 };
  let passed = 0, failed = 0, skipped = 0;
  function walk(suite) {
    for (const inner of suite.suites || []) walk(inner);
    for (const spec of suite.specs || []) {
      for (const t of spec.tests || []) {
        const r = (t.results || [])[t.results.length - 1];
        if (!r) continue;
        if (r.status === "passed") passed += 1;
        else if (r.status === "skipped") skipped += 1;
        else failed += 1;
      }
    }
  }
  for (const s of data.suites || []) walk(s);
  return { passed, failed, skipped };
}

// ---------- public entry ----------

export async function buildPipeline({
  repoRoot,
  excelPath,
  snapshotsPath,
  qaBaseUrl,
  fixturePath,
  batchSize = 5,
  healRounds = 1,
  maxHeal = 200,
  playwrightArgs = [],
  writeReport = true,
  logger = () => {},
}) {
  const timing = [];
  const startAll = Date.now();

  function phaseStart(name) {
    logger(`\n=== ${name} ===`);
    return { name, start: Date.now() };
  }
  function phaseEnd(p) {
    p.ms = Date.now() - p.start;
    timing.push(p);
  }

  // PHASE 1: DISCOVER ---------------------------------------------------
  const p1 = phaseStart("Phase 1 — DISCOVER repo + load snapshots");
  const scan = await scanRepository(repoRoot);
  const journeys = discoverUserJourneys(scan.files, { repoRoot: scan.root });
  annotateJourneysWithForms(journeys, scan.root);
  const snapshotsByUrl = await loadSnapshotsFromPath(snapshotsPath);
  logger(`  routes discovered: ${journeys.length}`);
  logger(`  DOM snapshots:     ${snapshotsByUrl.size}`);
  if (!snapshotsByUrl.size && qaBaseUrl) {
    logger(`  ⚠️  No snapshots — LLM will guess selectors from Excel text. Run \`record\` for better results.`);
  }
  phaseEnd(p1);

  // PHASE 2 + 3: GROUND + GENERATE -------------------------------------
  const p2 = phaseStart("Phase 2/3 — parse Excel + LLM enrichment (DOM-anchored)");
  const parsed = parseStoriesFile(excelPath);
  logger(`  stories: ${parsed.stories.length}, test cases: ${parsed.testCases?.length || 0}`);

  const storyStats = testCaseStats({ stories: parsed.stories, testCases: parsed.testCases || [] });

  let enrichResult = { specsByModule: new Map(), stats: {} };
  if ((parsed.testCases || []).length && (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY)) {
    const specsDir = path.resolve(repoRoot, "tests", "e2e");
    await fs.mkdir(specsDir, { recursive: true });
    enrichResult = await enrichSpecsFromTestCases({
      stories: parsed.stories,
      testCases: parsed.testCases,
      journeys,
      snapshotsByUrl,
      repoRoot,
      batchSize,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      openaiApiKey: process.env.OPENAI_API_KEY,
      logger: (msg) => logger("  " + msg),
      onModuleComplete: async (moduleSlug, source) => {
        await fs.writeFile(path.join(specsDir, `stories-${moduleSlug}.spec.ts`), source, "utf8");
      },
    });
    logger(`  enriched: ${enrichResult.stats.enriched}, cached: ${enrichResult.stats.cached}, failed batches: ${enrichResult.stats.failed}`);
  } else {
    logger(`  (skipped LLM enrichment — no API key or no test cases)`);
  }

  // Postman collection from APIs sheet
  if (parsed.apis?.length) {
    const postman = apisToPostmanCollection(parsed.apis, {
      name: `Generated from ${path.basename(excelPath)}`,
    });
    const postmanPath = path.resolve(repoRoot, "postman", "stories-collection.json");
    await fs.mkdir(path.dirname(postmanPath), { recursive: true });
    await fs.writeFile(postmanPath, JSON.stringify(postman, null, 2) + "\n", "utf8");
    logger(`  postman collection: ${postman.item.length} requests → ${postmanPath}`);
  }
  phaseEnd(p2);

  // PHASE 4: EXECUTE ---------------------------------------------------
  const p4 = phaseStart("Phase 4 — run Playwright against UAT");
  const resultsPath = path.join(repoRoot, "playwright-report", "results.json");
  const runEnv = {};
  if (qaBaseUrl) runEnv.QA_BASE_URL = qaBaseUrl;
  const runResult = await runCmd(
    "npx",
    [
      "playwright",
      "test",
      "tests/e2e/stories-",
      "--workers=4",
      "--reporter=json",
      "--reporter=list",
      ...playwrightArgs,
    ],
    { cwd: repoRoot, env: runEnv, captureStdio: true }
  );
  const { data: firstResults } = await parsePlaywrightResults(resultsPath);
  let counts = countFromResults(firstResults);
  logger(`  first run: ${counts.passed} passed / ${counts.failed} failed / ${counts.skipped} skipped`);
  phaseEnd(p4);

  // PHASE 5: HEAL ------------------------------------------------------
  let healStats = { patched: 0, bugCandidates: 0, attempted: 0 };
  let bugCandidatesPath = null;
  for (let round = 1; round <= healRounds; round += 1) {
    const pH = phaseStart(`Phase 5 — HEAL round ${round}/${healRounds}`);
    if (!firstResults || counts.failed === 0) {
      logger(`  nothing to heal`);
      phaseEnd(pH);
      break;
    }
    const { data: latest } = await parsePlaywrightResults(resultsPath);
    if (!latest) {
      logger(`  no results.json to read from`);
      phaseEnd(pH);
      break;
    }
    const healResult = await healFailingTests({
      resultsJson: latest,
      repoRoot,
      snapshotsByUrl,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      openaiApiKey: process.env.OPENAI_API_KEY,
      maxToHeal: maxHeal,
      logger: (msg) => logger("  " + msg),
    });
    healStats.attempted += healResult.stats.attempted || 0;
    healStats.patched += healResult.patched.length;
    healStats.bugCandidates += healResult.bugCandidates.length;
    if (healResult.stats.bugCandidatesFile) bugCandidatesPath = healResult.stats.bugCandidatesFile;
    logger(`  patched: ${healResult.patched.length}, bug candidates: ${healResult.bugCandidates.length}`);

    // Re-run playwright after patches to see if pass rate improved
    if (healResult.patched.length) {
      logger(`  re-running Playwright after heal...`);
      await runCmd(
        "npx",
        [
          "playwright",
          "test",
          "tests/e2e/stories-",
          "--workers=4",
          "--reporter=json",
          ...playwrightArgs,
        ],
        { cwd: repoRoot, env: runEnv, captureStdio: true }
      );
      const { data: postHealResults } = await parsePlaywrightResults(resultsPath);
      counts = countFromResults(postHealResults);
      logger(`  after heal round ${round}: ${counts.passed} passed / ${counts.failed} failed / ${counts.skipped} skipped`);
    }
    phaseEnd(pH);
  }

  // FINAL REPORT -------------------------------------------------------
  const totalMs = Date.now() - startAll;
  logger(`\nTotal wall time: ${(totalMs / 1000).toFixed(1)}s`);

  const report = buildRunReport({
    phaseTiming: timing,
    storyStats,
    enrichStats: enrichResult.stats,
    runStats: counts,
    healStats,
    bugCandidatesPath,
  });
  if (writeReport) {
    const reportPath = path.join(repoRoot, "qa-results", "build-report.md");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, report, "utf8");
    logger(`Build report: ${reportPath}`);
    return { report, reportPath, timing, storyStats, enrichStats: enrichResult.stats, runStats: counts, healStats, bugCandidatesPath };
  }
  return { report, reportPath: null, timing, storyStats, enrichStats: enrichResult.stats, runStats: counts, healStats, bugCandidatesPath };
}

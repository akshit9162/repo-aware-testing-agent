import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  scanRepository,
  detectStack,
  createTestPlan,
  generateAssets,
  applyAssets,
  discoverUserJourneys,
  summarizePlaywrightReport,
  writePlaywrightCoverageExcel,
} from "../src/index.js";

async function makeFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-qa-agent-"));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({
    type: "module",
    scripts: { test: "vitest run" },
    dependencies: { next: "^15.0.0", react: "^18.3.1" },
    devDependencies: { vite: "^7.0.0" }
  }, null, 2));
  await fs.writeFile(path.join(dir, "vite.config.ts"), "export default {}");
  await fs.writeFile(path.join(dir, "src", "App.tsx"), "export function App(){ return <div/> }");
  await fs.mkdir(path.join(dir, "app", "checkout"), { recursive: true });
  await fs.mkdir(path.join(dir, "app", "products", "[id]"), { recursive: true });
  await fs.writeFile(path.join(dir, "app", "page.tsx"), "export default function Page(){ return <main/> }");
  await fs.writeFile(path.join(dir, "app", "checkout", "page.tsx"), "export default function Page(){ return <main/> }");
  await fs.writeFile(path.join(dir, "app", "products", "[id]", "page.tsx"), "export default function Page(){ return <main/> }");
  return dir;
}

test("scans repo and generates customized QA assets", async () => {
  const dir = await makeFixture();
  const scan = await scanRepository(dir);
  const stack = detectStack(scan);
  const plan = createTestPlan(scan, stack);
  const assets = generateAssets(scan, plan);

  assert.equal(stack.framework, "next");
  assert.equal(stack.hasFrontend, true);
  assert.match(assets.packageJson, /qa:e2e/);
  assert.match(assets.packageJson, /qa:journeys/);
  assert.match(assets.packageJson, /qa:report/);
  assert.match(assets.packageJson, /qa:all/);
  assert.equal(assets.files.some((file) => file.path === "tests/e2e/critical-journey.spec.ts"), true);
  assert.equal(assets.files.some((file) => file.path === "scripts/qa-report.mjs"), true);
  assert.equal(assets.files.some((file) => file.path === "scripts/qa-run-all.mjs"), true);
  const journeySpec = assets.files.find((file) => file.path === "tests/e2e/user-journeys.spec.ts");
  assert.match(journeySpec.content, /"title": "checkout"/);
  assert.match(journeySpec.content, /QA_ROUTE_PRODUCTS_PARAM/);
});

test("discovers user journeys from route files", async () => {
  const journeys = discoverUserJourneys([
    "app/page.tsx",
    "app/account/page.tsx",
    "app/products/[id]/page.tsx",
    "pages/login.tsx",
    "pages/api/health.ts",
    "src/routes/settings.tsx",
  ]);

  assert.deepEqual(journeys.map((journey) => journey.path), ["/", "/account", "/login", "/products/sample", "/settings"]);
  assert.equal(journeys.find((journey) => journey.path === "/products/sample").env, "QA_ROUTE_PRODUCTS_PARAM");
});

test("applies assets without overwriting existing files", async () => {
  const dir = await makeFixture();
  await fs.mkdir(path.join(dir, "tests", "unit"), { recursive: true });
  await fs.writeFile(path.join(dir, "tests", "unit", "qa-baseline.test.js"), "keep");

  const scan = await scanRepository(dir);
  const assets = generateAssets(scan, createTestPlan(scan, detectStack(scan)));
  const result = await applyAssets(dir, assets);

  assert.equal(result.written.includes("package.json"), true);
  assert.equal(result.skipped.includes("tests/unit/qa-baseline.test.js"), true);
  assert.equal(await fs.readFile(path.join(dir, "tests", "unit", "qa-baseline.test.js"), "utf8"), "keep");
});

test("generates an Excel-compatible Playwright report", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-qa-agent-report-"));
  const report = {
    suites: [
      {
        title: "root",
        specs: [
          {
            title: "loads homepage",
            file: "tests/e2e/home.spec.ts",
            tests: [
              {
                projectName: "chromium",
                results: [{ status: "passed", duration: 123, errors: [] }],
              },
            ],
          },
          {
            title: "submits form",
            file: "tests/e2e/form.spec.ts",
            tests: [
              {
                projectName: "chromium",
                results: [{ status: "failed", duration: 456, errors: [{ message: "button missing" }] }],
              },
            ],
          },
        ],
        suites: [],
      },
    ],
  };
  const input = path.join(dir, "results.json");
  const output = path.join(dir, "coverage.xls");
  await fs.writeFile(input, JSON.stringify(report), "utf8");

  const summary = summarizePlaywrightReport(report).summary;
  await writePlaywrightCoverageExcel(input, output);
  const workbook = await fs.readFile(output, "utf8");

  assert.equal(summary.total, 2);
  assert.equal(summary.passed, 1);
  assert.equal(summary.failed, 1);
  assert.match(workbook, /<Worksheet ss:Name="Summary">/);
  assert.match(workbook, /button missing/);
});

test("generated QA reporter summarizes all available artifacts", async () => {
  const dir = await makeFixture();
  const scan = await scanRepository(dir);
  const assets = generateAssets(scan, createTestPlan(scan, detectStack(scan)));
  await applyAssets(dir, assets);

  await fs.mkdir(path.join(dir, "playwright-report"), { recursive: true });
  await fs.mkdir(path.join(dir, "qa-results"), { recursive: true });
  await fs.mkdir(path.join(dir, "coverage"), { recursive: true });
  await fs.writeFile(path.join(dir, "playwright-report", "results.json"), JSON.stringify({
    suites: [{
      title: "e2e",
      specs: [
        {
          title: "journey: checkout",
          file: "tests/e2e/user-journeys.spec.ts",
          tests: [{ projectName: "chromium", results: [{ status: "passed", duration: 100 }] }],
        },
        {
          title: "smoke: configured page loads",
          file: "tests/smoke/qa-smoke.spec.ts",
          tests: [{ projectName: "chromium", results: [{ status: "failed", duration: 50, errors: [{ message: "body is empty" }] }] }],
        },
      ],
    }],
  }), "utf8");
  await fs.writeFile(path.join(dir, "qa-results", "vitest.json"), JSON.stringify({
    numTotalTests: 2,
    numPassedTests: 1,
    numFailedTests: 1,
    numPendingTests: 0,
  }), "utf8");
  await fs.writeFile(path.join(dir, "qa-results", "newman.json"), JSON.stringify({
    run: { stats: { assertions: { total: 3, failed: 0, pending: 0 } } },
  }), "utf8");
  await fs.writeFile(path.join(dir, "qa-results", "k6-summary.json"), JSON.stringify({
    metrics: { checks: { values: { passes: 4, fails: 0 } } },
  }), "utf8");
  await fs.writeFile(path.join(dir, "qa-results", "grype.json"), JSON.stringify({ matches: [] }), "utf8");
  await fs.writeFile(path.join(dir, "coverage", "lcov.info"), "LF:10\nLH:8\nFNF:5\nFNH:5\nBRF:4\nBRH:2\n", "utf8");

  const result = spawnSync("node", ["scripts/qa-report.mjs"], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await fs.readFile(path.join(dir, "qa-results", "qa-report.json"), "utf8"));
  const workbook = await fs.readFile(path.join(dir, "qa-results", "qa-report.xls"), "utf8");

  assert.equal(report.summary.total, 11);
  assert.equal(report.summary.failed, 2);
  assert.equal(report.testCases.length, 2);
  assert.equal(report.testCases[0].title, "e2e > journey: checkout");
  assert.equal(report.testCases[0].status, "passed");
  assert.match(report.testCases[0].description, /discovered user journey/);
  assert.equal(report.testCases[1].status, "failed");
  assert.match(report.testCases[1].errors, /body is empty/);
  assert.equal(report.rows.some((row) => row.tool === "coverage" && row.coverage.includes("lines 80%")), true);
  assert.match(workbook, /<Worksheet ss:Name="Tools">/);
  assert.match(workbook, /<Worksheet ss:Name="Test Cases">/);
  assert.match(workbook, /Checks that the configured smoke page loads/);
});

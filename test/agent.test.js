import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
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
  assert.equal(assets.files.some((file) => file.path === "tests/e2e/critical-journey.spec.ts"), true);
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

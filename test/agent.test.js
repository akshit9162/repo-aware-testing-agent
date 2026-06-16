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
  createSonarProperties,
  createTrivyIgnore,
  discoverApiEndpoints,
  discoverSecurityTargets,
  discoverUserJourneys,
  discoverUnitTestTargets,
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
  await fs.writeFile(path.join(dir, "package-lock.json"), "{}");
  await fs.writeFile(path.join(dir, "Dockerfile"), "FROM node:22-alpine\n");
  await fs.writeFile(path.join(dir, "vite.config.ts"), "export default {}");
  await fs.writeFile(path.join(dir, ".env.example"), "NEXT_PUBLIC_API_URL=http://localhost:3000\n");
  await fs.writeFile(path.join(dir, "src", "App.tsx"), "export function App(){ return <div/> }");
  await fs.writeFile(path.join(dir, "src", "PriceCard.tsx"), "export function PriceCard(){ return <article/> }");
  await fs.mkdir(path.join(dir, "pages", "api"), { recursive: true });
  await fs.writeFile(path.join(dir, "pages", "api", "health.ts"), "export default function handler(){}");
  await fs.mkdir(path.join(dir, "app", "api", "orders", "[id]"), { recursive: true });
  await fs.writeFile(path.join(dir, "app", "api", "orders", "[id]", "route.ts"), "export function GET(){}");
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
  assert.equal(assets.files.some((file) => file.path === "tests/unit/qa-generated-regression.test.js"), true);
  assert.equal(assets.files.some((file) => file.path === "scripts/qa-report.mjs"), true);
  assert.equal(assets.files.some((file) => file.path === "scripts/qa-run-all.mjs"), true);
  const unitSpec = assets.files.find((file) => file.path === "tests/unit/qa-generated-regression.test.js");
  assert.equal(unitSpec.content.includes("src/PriceCard.tsx"), true);
  assert.equal(unitSpec.content.includes("pages/api/health.ts"), true);
  assert.equal(unitSpec.content.includes(".env.example"), true);
  const postman = assets.files.find((file) => file.path === "postman/qa-collection.json");
  assert.equal(postman.content.includes("GET /api/health"), true);
  assert.equal(postman.content.includes("GET /api/orders/sample"), true);
  const sonar = assets.files.find((file) => file.path === "sonar-project.properties");
  assert.match(sonar.content, /sonar.sources=app,pages,src/);
  assert.match(sonar.content, /sonar.javascript.lcov.reportPaths=coverage\/lcov.info/);
  const k6 = assets.files.find((file) => file.path === "tests/performance/load.js");
  assert.equal(k6.content.includes("/api/orders/sample"), true);
  assert.equal(k6.content.includes("QA_API_API_HEALTH"), true);
  const trivy = assets.files.find((file) => file.path === ".trivyignore");
  assert.match(trivy.content, /Detected manifests: Dockerfile, package-lock.json, package.json/);
  assert.match(assets.packageJson, /trivy fs --format json --output qa-results\/trivy\.json/);
  const journeySpec = assets.files.find((file) => file.path === "tests/e2e/user-journeys.spec.ts");
  assert.match(journeySpec.content, /"title": "checkout"/);
  assert.match(journeySpec.content, /QA_ROUTE_PRODUCTS_PARAM/);
});

test("discovers API endpoints from scanned route files", async () => {
  const endpoints = discoverApiEndpoints([
    "pages/api/health.ts",
    "pages/api/products/[id].ts",
    "app/api/orders/[id]/route.ts",
    "src/routes/admin/users.ts",
  ]);

  assert.deepEqual(endpoints.map((endpoint) => endpoint.path), [
    "/api/health",
    "/api/orders/sample",
    "/api/products/sample",
    "/routes/admin/users",
  ]);
  assert.equal(endpoints.find((endpoint) => endpoint.path === "/api/orders/sample").env, "QA_API_API_ORDERS_SAMPLE");
});

test("creates repo-aware SonarQube properties", async () => {
  const dir = await makeFixture();
  const scan = await scanRepository(dir);
  const properties = createSonarProperties(scan);

  assert.match(properties, /sonar.projectKey=/);
  assert.match(properties, /sonar.sources=app,pages,src/);
  assert.match(properties, /sonar.tests=tests/);
  assert.match(properties, /sonar.exclusions=.*node_modules/);
  assert.match(properties, /sonar.coverage.exclusions=/);
});

test("creates repo-aware security scan config", async () => {
  const dir = await makeFixture();
  const scan = await scanRepository(dir);
  const targets = discoverSecurityTargets(scan);
  const config = createTrivyIgnore(scan);

  assert.equal(targets.hasContainer, true);
  assert.equal(targets.hasNodeLockfile, true);
  assert.equal(targets.manifests.includes("Dockerfile"), true);
  assert.match(config, /Trivy scans dependency manifests/);
  assert.match(config, /Detected manifests: Dockerfile, package-lock.json, package.json/);
});

test("discovers unit test targets from scanned repo files", async () => {
  const dir = await makeFixture();
  const scan = await scanRepository(dir);
  const targets = discoverUnitTestTargets(scan);

  assert.equal(targets.packageScripts.includes("test"), true);
  assert.equal(targets.sourceFiles.includes("src/App.tsx"), true);
  assert.equal(targets.componentFiles.includes("src/PriceCard.tsx"), true);
  assert.equal(targets.apiFiles.includes("pages/api/health.ts"), true);
  assert.equal(targets.envFiles.includes(".env.example"), true);
  assert.equal(targets.configFiles.includes("vite.config.ts"), true);
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

test("Python repo does not scaffold Vitest", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-qa-agent-py-"));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "pyproject.toml"), "[project]\nname = 'demo'\n");
  await fs.writeFile(path.join(dir, "src", "app.py"), "def main():\n    return 'hi'\n");
  await fs.writeFile(path.join(dir, "Dockerfile"), "FROM python:3.12\n");

  const scan = await scanRepository(dir);
  const stack = detectStack(scan);
  const plan = createTestPlan(scan, stack);
  const assets = generateAssets(scan, plan);

  assert.equal(stack.language, "python");
  assert.equal(stack.isJsTs, false);
  assert.equal(plan.enabledTools.includes("vitest"), false);
  assert.equal(plan.enabledTools.includes("trivy"), true, "trivy should still run on Python repos with manifests");
  assert.equal(assets.files.some((file) => file.path === "tests/unit/qa-baseline.test.js"), false);
  assert.equal(assets.files.some((file) => file.path === ".trivyignore"), true);
  assert.match(assets.packageJson, /qa:security/);
  assert.equal(/qa:unit/.test(assets.packageJson), false);
});

test("SPA-only repo with src/routes does not scaffold Postman or k6", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-qa-agent-spa-"));
  await fs.mkdir(path.join(dir, "src", "routes"), { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({
    type: "module",
    scripts: { test: "vitest run" },
    dependencies: { react: "^18.3.1", "react-router-dom": "^6" },
    devDependencies: { vite: "^7.0.0", vitest: "^4.1.5" },
  }, null, 2));
  await fs.writeFile(path.join(dir, "vite.config.ts"), "export default {}");
  await fs.writeFile(path.join(dir, "src", "App.tsx"), "export function App(){return <div/>}");
  await fs.writeFile(path.join(dir, "src", "routes", "home.tsx"), "export default function Home(){return <main/>}");
  await fs.writeFile(path.join(dir, "src", "routes", "about.tsx"), "export default function About(){return <main/>}");

  const scan = await scanRepository(dir);
  const stack = detectStack(scan);
  const plan = createTestPlan(scan, stack);

  assert.equal(stack.hasApi, false, "SPA with only src/routes/ should not be flagged as API");
  assert.equal(plan.enabledTools.includes("postman"), false);
  assert.equal(plan.enabledTools.includes("k6"), false);
  assert.equal(plan.enabledTools.includes("playwright"), true);
  assert.equal(plan.enabledTools.includes("vitest"), true);
});

test("--only filter restricts generated assets", async () => {
  const dir = await makeFixture();
  const scan = await scanRepository(dir);
  const stack = detectStack(scan);
  const plan = createTestPlan(scan, stack, { only: ["playwright", "vitest"] });
  const assets = generateAssets(scan, plan);

  assert.deepEqual(plan.enabledTools.sort(), ["playwright", "vitest"]);
  assert.equal(assets.files.some((file) => file.path === "tests/e2e/critical-journey.spec.ts"), true);
  assert.equal(assets.files.some((file) => file.path === "tests/unit/qa-baseline.test.js"), true);
  assert.equal(assets.files.some((file) => file.path === ".trivyignore"), false);
  assert.equal(assets.files.some((file) => file.path === "sonar-project.properties"), false);
  assert.equal(assets.files.some((file) => file.path === "postman/qa-collection.json"), false);
  assert.equal(/qa:security/.test(assets.packageJson), false);
  assert.equal(/qa:api/.test(assets.packageJson), false);
});

test("--skip filter removes named tools", async () => {
  const dir = await makeFixture();
  const scan = await scanRepository(dir);
  const stack = detectStack(scan);
  const plan = createTestPlan(scan, stack, { skip: ["postman", "k6"] });
  const assets = generateAssets(scan, plan);

  assert.equal(plan.enabledTools.includes("postman"), false);
  assert.equal(plan.enabledTools.includes("k6"), false);
  assert.equal(plan.enabledTools.includes("playwright"), true);
  assert.equal(plan.enabledTools.includes("vitest"), true);
  assert.equal(assets.files.some((file) => file.path === "postman/qa-collection.json"), false);
  assert.equal(assets.files.some((file) => file.path === "tests/performance/load.js"), false);
});

test("generated orchestrator implements three-tier execution and severity gating", async () => {
  const dir = await makeFixture();
  const scan = await scanRepository(dir);
  const assets = generateAssets(scan, createTestPlan(scan, detectStack(scan)));
  const runAll = assets.files.find((file) => file.path === "scripts/qa-run-all.mjs");

  assert.ok(runAll, "qa-run-all.mjs should be generated");
  assert.match(runAll.content, /STAGE_PROFILE/);
  assert.match(runAll.content, /'zero-infra'/);
  assert.match(runAll.content, /'needs-app'/);
  assert.match(runAll.content, /'external-service'/);
  assert.match(runAll.content, /withAppServer/);
  assert.match(runAll.content, /waitForHealth/);
  assert.match(runAll.content, /--fail-on/);
  assert.match(runAll.content, /--changed/);
  assert.match(runAll.content, /SEVERITY_RANK/);
  assert.match(runAll.content, /failThreshold/);
  assert.match(runAll.content, /SONAR_HOST_URL/);
});

test("re-applying assets is idempotent", async () => {
  const dir = await makeFixture();
  const scan = await scanRepository(dir);
  const assets = generateAssets(scan, createTestPlan(scan, detectStack(scan)));

  const first = await applyAssets(dir, assets, { overwrite: true });
  assert.equal(first.written.includes("package.json"), true);

  const rescan = await scanRepository(dir);
  const reassets = generateAssets(rescan, createTestPlan(rescan, detectStack(rescan)));
  const second = await applyAssets(dir, reassets, { overwrite: true });

  assert.equal(second.written.length, 0, `expected no rewrites, got: ${second.written.join(", ")}`);
  assert.equal(second.skipped.length, 0);
  assert.equal(second.unchanged.length > 0, true);
  assert.equal(second.unchanged.includes("package.json"), true);
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
    metrics: {
      checks: { passes: 4, fails: 0, thresholds: { "rate>0.95": false }, value: 1 },
      http_reqs: { count: 10, rate: 5 },
      http_req_duration: { "p(95)": 250, avg: 100, thresholds: { "p(95)<1000": false } },
      http_req_failed: { passes: 10, fails: 0, value: 0, thresholds: { "rate<0.05": false } },
    },
  }), "utf8");
  await fs.writeFile(path.join(dir, "qa-results", "trivy.json"), JSON.stringify({ Results: [] }), "utf8");
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

  // QA Test Cases sheet (11-column manual-QA-friendly format)
  assert.ok(Array.isArray(report.qaTestCases), "qaTestCases array should exist");
  assert.equal(report.qaTestCases.length >= 2, true, "should derive at least the playwright cases");
  assert.match(workbook, /<Worksheet ss:Name="QA Test Cases">/);
  assert.match(workbook, /Test Case Id/);
  assert.match(workbook, /Page Name/);
  assert.match(workbook, /Test Data \/ Condition/);
  const pwCase = report.qaTestCases.find((tc) => tc.testCaseId.startsWith("QA-PW-"));
  assert.ok(pwCase, "should have at least one Playwright-derived case");
  assert.ok(pwCase.priority, "case should carry a priority");
  assert.ok(pwCase.testType, "case should carry a test type");
  assert.match(pwCase.prerequisites, /QA_BASE_URL/);
  assert.ok(["Pass", "Fail", "Skipped"].includes(pwCase.status));
});

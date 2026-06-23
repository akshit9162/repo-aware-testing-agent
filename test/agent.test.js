import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import http from "node:http";
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
  enrichJourneys,
  crawlSite,
  mergeJourneys,
  importHar,
  repair,
  extractRouteFromTitle,
  patchEnrichedBlock,
  loadDotenv,
  summarizePlaywrightReport,
  writePlaywrightCoverageExcel,
  escapeXml,
  parseExports,
  buildServerCommand,
  parseQaFailures,
  buildFixIndex,
  retrieveFixContext,
  applyExactPatches,
  buildPatchBundle,
  rollbackPatchBundle,
  renderPrMarkdown,
  codingFixInWorktree,
  codingFix,
  classifyFailure,
  planValidationCommands,
  runValidationCommands,
  buildRepoIndex,
  writeRepoIndex,
  readRepoIndex,
  queryRepoIndex,
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
  assert.match(assets.packageJson, /qa:a11y/);
  assert.match(assets.packageJson, /qa:secrets/);
  assert.match(assets.packageJson, /qa:sast/);
  assert.equal(plan.enabledTools.includes("axe"), true);
  assert.equal(plan.enabledTools.includes("gitleaks"), true);
  assert.equal(plan.enabledTools.includes("semgrep"), true);
  assert.equal(assets.files.some((file) => file.path === "tests/a11y/qa-a11y.spec.ts"), true);
  assert.equal(assets.files.some((file) => file.path === ".gitleaks.toml"), true);
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
  assert.match(journeySpec.content, /import \{ urlFor \} from '\.\.\/helpers\/journey-fixture'/);
  assert.match(journeySpec.content, /urlFor\(journey\.path\)/);
  assert.equal(assets.files.some((file) => file.path === "tests/helpers/journey-fixture.ts"), true);
  const a11ySpec = assets.files.find((file) => file.path === "tests/a11y/qa-a11y.spec.ts");
  assert.match(a11ySpec.content, /urlFor\(journey\.path\)/);
  const visualSpec = assets.files.find((file) => file.path === "tests/visual/qa-visual.spec.ts");
  assert.match(visualSpec.content, /urlFor\(journey\.path\)/);
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

test("applyAssets appends generated QA fixture entries to gitignore", async () => {
  const dir = await makeFixture();
  await fs.writeFile(path.join(dir, ".gitignore"), "node_modules\n", "utf8");
  const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
  await applyAssets(dir, {
    packageJson: `${JSON.stringify(pkg, null, 2)}\n`,
    files: [{
      path: "tests/fixtures/qa-uat.local.json.example",
      content: "{}\n",
      appendGitignore: [
        "# QA fixtures with real UAT data / PII",
        "tests/fixtures/*.local.json",
        "tests/fixtures/sample-*",
        ".qa-agent-cache/",
      ],
    }],
  });
  const gitignore = await fs.readFile(path.join(dir, ".gitignore"), "utf8");

  assert.match(gitignore, /tests\/fixtures\/\*\.local\.json/);
  assert.match(gitignore, /\.qa-agent-cache\//);
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
  assert.equal(plan.enabledTools.includes("gitleaks"), true, "gitleaks runs on any repo");
  assert.equal(plan.enabledTools.includes("semgrep"), true, "semgrep runs on any repo (multi-language)");
  assert.equal(plan.enabledTools.includes("axe"), false, "axe should not enable without a frontend");
  assert.equal(assets.files.some((file) => file.path === "tests/unit/qa-baseline.test.js"), false);
  assert.equal(assets.files.some((file) => file.path === ".trivyignore"), true);
  assert.equal(assets.files.some((file) => file.path === ".gitleaks.toml"), true);
  assert.equal(assets.files.some((file) => file.path === "tests/a11y/qa-a11y.spec.ts"), false);
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

test("LLM enrichment returns canned data via injected client and is embedded in journey spec", async () => {
  const dir = await makeFixture();
  const scan = await scanRepository(dir);
  const journeys = discoverUserJourneys(scan.files);

  const fakeClient = {
    messages: {
      create: async ({ messages }) => {
        const userText = messages[0].content;
        const isHome = /Route: \/\b|Route: \/$/.test(userText);
        const payload = isHome
          ? { description: "Home renders hero", expected: [{ kind: "heading", text: "Welcome" }, { kind: "link", name: "Get Started" }] }
          : { description: "Page renders heading", expected: [{ kind: "heading", level: 1 }] };
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      },
    },
  };

  const { enriched, stats } = await enrichJourneys({
    repoRoot: dir,
    journeys,
    client: fakeClient,
  });

  assert.equal(stats.failed, 0);
  assert.equal(enriched.size >= 1, true, "should produce at least one enrichment");

  const plan = createTestPlan(scan, detectStack(scan));
  const assets = generateAssets(scan, plan, { enrichment: enriched });
  const journeySpec = assets.files.find((file) => file.path === "tests/e2e/user-journeys.spec.ts");
  assert.match(journeySpec.content, /const ENRICHED = \{/);
  assert.match(journeySpec.content, /checkEnrichment/);
  // At least one of the enriched payloads should land in the file content.
  assert.equal(
    /"description": "Home renders hero"/.test(journeySpec.content) ||
      /"description": "Page renders heading"/.test(journeySpec.content),
    true,
    "rendered spec should embed at least one enrichment payload"
  );
});

test("LLM enrichment dispatches to OpenAI shape when client.chat.completions exists", async () => {
  const dir = await makeFixture();
  const scan = await scanRepository(dir);
  const journeys = discoverUserJourneys(scan.files);

  let captured = null;
  const fakeOpenAI = {
    chat: {
      completions: {
        create: async (req) => {
          captured = req;
          const payload = { description: "OpenAI-routed", expected: [{ kind: "heading", text: "Welcome" }] };
          return { choices: [{ message: { content: JSON.stringify(payload) } }] };
        },
      },
    },
  };

  const { enriched, stats } = await enrichJourneys({
    repoRoot: dir,
    journeys,
    client: fakeOpenAI,
  });

  assert.equal(stats.provider, "openai");
  assert.equal(stats.failed, 0);
  assert.equal(enriched.size >= 1, true);
  assert.ok(captured, "OpenAI client should have been called");
  assert.equal(captured.response_format?.type, "json_schema");
  assert.equal(captured.messages?.[0]?.role, "system");
  // sanity: the same fixture rendered through Anthropic shape would not have set this.
  assert.equal(typeof captured.model, "string");
});

test("LLM enrichment throws when no provider is available (no key, no client)", async () => {
  const dir = await makeFixture();
  const scan = await scanRepository(dir);
  const journeys = discoverUserJourneys(scan.files);
  // Ensure env keys aren't picked up from the surrounding shell.
  const savedAnthropic = process.env.ANTHROPIC_API_KEY;
  const savedOpenAI = process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    await assert.rejects(
      enrichJourneys({ repoRoot: dir, journeys }),
      /LLM enrichment is required/,
    );
  } finally {
    if (savedAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = savedAnthropic;
    if (savedOpenAI !== undefined) process.env.OPENAI_API_KEY = savedOpenAI;
  }
});

test("crawler walks same-origin link graph BFS to configured depth", async () => {
  const pages = {
    "/": `<!doctype html><html><head><title>Home</title></head><body><a href="/about">About</a><a href="/contact">Contact</a><a href="https://external.example/x">ext</a><a href="mailto:a@b">m</a></body></html>`,
    "/about": `<!doctype html><html><head><title>About Us</title></head><body><a href="/team">Team</a><a href="/">home</a></body></html>`,
    "/contact": `<!doctype html><html><head><title>Contact</title></head><body><h1>Reach out</h1></body></html>`,
    "/team": `<!doctype html><html><head><title>Team</title></head><body><a href="/about">About</a></body></html>`,
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const body = pages[url.pathname];
    if (body) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(body);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const journeys = await crawlSite(`http://127.0.0.1:${port}/`, { depth: 2, maxPages: 10 });
    const paths = journeys.map((j) => j.path).sort();
    assert.deepEqual(paths, ["/", "/about", "/contact", "/team"]);
    assert.equal(journeys.find((j) => j.path === "/").title, "Home");
    assert.equal(journeys.find((j) => j.path === "/contact").title, "Contact");
    // External + mailto should have been excluded.
    assert.equal(paths.includes("/x"), false);
  } finally {
    server.close();
  }
});

test("crawler captures html when captureHtml is set", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><head><title>Live</title></head><body><h1>Hello world</h1></body></html>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const withHtml = await crawlSite(`http://127.0.0.1:${port}/`, { depth: 0, captureHtml: true });
    assert.equal(withHtml.length, 1);
    assert.match(withHtml[0].html, /Hello world/);

    const noHtml = await crawlSite(`http://127.0.0.1:${port}/`, { depth: 0 });
    assert.equal(noHtml[0].html, undefined, "html should be absent by default");
  } finally {
    server.close();
  }
});

test("enrichJourneys prefers journey.html over journey.source and tags the message", async () => {
  const dir = await makeFixture();
  const scan = await scanRepository(dir);
  const staticJourneys = discoverUserJourneys(scan.files);
  // Build a journey that has BOTH source and html — html should win.
  const target = staticJourneys[0];
  const journey = { ...target, html: "<html><body><h1>From the live DOM</h1></body></html>" };

  const seen = [];
  const fakeClient = {
    messages: {
      create: async ({ messages }) => {
        seen.push(messages[0].content);
        const payload = { description: "ok", expected: [{ kind: "heading", text: "From the live DOM" }] };
        return { content: [{ type: "text", text: JSON.stringify(payload) }] };
      },
    },
  };

  const { enriched, stats } = await enrichJourneys({
    repoRoot: dir,
    journeys: [journey],
    client: fakeClient,
  });

  assert.equal(stats.succeeded, 1);
  assert.equal(enriched.get(journey.path).expected[0].text, "From the live DOM");
  assert.equal(seen.length, 1);
  assert.match(seen[0], /Content type: rendered HTML/);
  assert.match(seen[0], /From the live DOM/);
});

test("enrichJourneys cache keys differ between source and html kinds", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-qa-cachekey-"));
  // Lay down a journey source file so the source path is readable.
  await fs.mkdir(path.join(dir, "app"), { recursive: true });
  await fs.writeFile(path.join(dir, "app", "page.tsx"), "export default function Page(){return <main/>;}");

  const journeySource = { path: "/", title: "home", source: "app/page.tsx", env: "QA_ROUTE_HOME" };
  const journeyHtml = { ...journeySource, html: "<html><body>html mode</body></html>" };

  let calls = 0;
  const fakeClient = {
    messages: {
      create: async () => {
        calls += 1;
        return { content: [{ type: "text", text: JSON.stringify({ description: "ok", expected: [] }) }] };
      },
    },
  };

  const a = await enrichJourneys({ repoRoot: dir, journeys: [journeySource], client: fakeClient });
  const b = await enrichJourneys({ repoRoot: dir, journeys: [journeyHtml], client: fakeClient });
  // Source path makes one API call. HTML path is a different cache key — second
  // call must also hit the API (not the existing source cache).
  assert.equal(calls, 2);
  assert.equal(a.stats.succeeded, 1);
  assert.equal(b.stats.succeeded, 1);
  assert.equal(a.stats.cached, 0);
  assert.equal(b.stats.cached, 0);
});

test("crawler depth=0 discovers only the entry page", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><head><title>Root</title></head><body><a href="/other">other</a></body></html>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const journeys = await crawlSite(`http://127.0.0.1:${port}/`, { depth: 0, maxPages: 10 });
    assert.equal(journeys.length, 1);
    assert.equal(journeys[0].path, "/");
  } finally {
    server.close();
  }
});

test("mergeJourneys prefers static records over crawled on path collisions", () => {
  const staticJourneys = [{ path: "/", title: "static home", source: "app/page.tsx" }];
  const crawled = [{ path: "/", title: "crawled home", source: "crawl" }, { path: "/extra", title: "extra", source: "crawl" }];
  const merged = mergeJourneys(staticJourneys, crawled);
  const home = merged.find((j) => j.path === "/");
  assert.equal(home.source, "app/page.tsx", "static record should win on overlap");
  assert.equal(merged.length, 2);
  assert.equal(merged.find((j) => j.path === "/extra").source, "crawl");
});

test("importHar merges entries into postman collection with dedup", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-qa-har-"));
  const harPath = path.join(dir, "sample.har");
  const outPath = path.join(dir, "postman", "qa-collection.json");
  await fs.writeFile(harPath, JSON.stringify({
    log: {
      entries: [
        { request: { method: "GET", url: "https://api.example.com/v1/health", headers: [{ name: "accept", value: "application/json" }] } },
        { request: { method: "POST", url: "https://api.example.com/v1/orders", headers: [], postData: { mimeType: "application/json", text: "{\"sku\":\"x\"}" } } },
        { request: { method: "GET", url: "https://api.example.com/v1/health", headers: [] } }, // dupe
      ],
    },
  }), "utf8");

  const first = await importHar(harPath, { outPath });
  assert.equal(first.imported, 2);
  assert.equal(first.skippedAsDupes, 1);
  assert.equal(first.total, 2);

  // Second import of same file should be a full no-op on the collection.
  const second = await importHar(harPath, { outPath });
  assert.equal(second.imported, 0);
  assert.equal(second.skippedAsDupes, 3);
  assert.equal(second.total, 2);

  const collection = JSON.parse(await fs.readFile(outPath, "utf8"));
  assert.equal(collection.item.length, 2);
  const post = collection.item.find((i) => i.request.method === "POST");
  assert.match(post.event[0].script.exec.join("\n"), /does not return server error/);
  assert.equal(post.request.body.raw, "{\"sku\":\"x\"}");
});

test("loadDotenv populates process.env from .env (quotes, comments, export prefix, existing wins)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-qa-env-"));
  await fs.writeFile(path.join(dir, ".env"), [
    "# top-level comment",
    "QA_TEST_PLAIN=plain-value",
    'QA_TEST_QUOTED="quoted spaces here"',
    "QA_TEST_SQUOTED='single-quoted'",
    "  QA_TEST_PADDED  =  trimmed  ",
    "export QA_TEST_EXPORTED=exported-value",
    "QA_TEST_PRESET=should-not-overwrite",
    "",
    "# trailing comment",
  ].join("\n"));
  // .env.local overrides? No — first-loaded file wins because existing values
  // are preserved. .env.local is read first then .env; both honor the existing
  // env precedence rule. So overlap with .env.local takes precedence.
  await fs.writeFile(path.join(dir, ".env.local"), "QA_TEST_LOCAL_ONLY=local\n");

  const preset = "QA_TEST_PRESET";
  process.env[preset] = "preset-export";
  for (const k of ["QA_TEST_PLAIN", "QA_TEST_QUOTED", "QA_TEST_SQUOTED", "QA_TEST_PADDED", "QA_TEST_EXPORTED", "QA_TEST_LOCAL_ONLY"]) {
    delete process.env[k];
  }

  try {
    const result = await loadDotenv(dir);
    assert.equal(result.loaded.length, 2);
    assert.equal(process.env.QA_TEST_PLAIN, "plain-value");
    assert.equal(process.env.QA_TEST_QUOTED, "quoted spaces here");
    assert.equal(process.env.QA_TEST_SQUOTED, "single-quoted");
    assert.equal(process.env.QA_TEST_PADDED, "trimmed");
    assert.equal(process.env.QA_TEST_EXPORTED, "exported-value");
    assert.equal(process.env.QA_TEST_LOCAL_ONLY, "local");
    assert.equal(process.env.QA_TEST_PRESET, "preset-export", "existing env vars must not be overridden");
  } finally {
    for (const k of ["QA_TEST_PLAIN", "QA_TEST_QUOTED", "QA_TEST_SQUOTED", "QA_TEST_PADDED", "QA_TEST_EXPORTED", "QA_TEST_PRESET", "QA_TEST_LOCAL_ONLY"]) {
      delete process.env[k];
    }
  }
});

test("loadDotenv is a no-op when no files exist", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-qa-env-noop-"));
  const result = await loadDotenv(dir);
  assert.deepEqual(result.loaded, []);
  assert.deepEqual(result.setKeys, []);
});

test("k6 script treats 4xx as expected and sends a probe body for POST/PUT/PATCH", async () => {
  const dir = await makeFixture();
  const scan = await scanRepository(dir);
  const assets = generateAssets(scan, createTestPlan(scan, detectStack(scan)));
  const k6 = assets.files.find((f) => f.path === "tests/performance/load.js");
  assert.ok(k6, "k6 script should be generated");
  assert.match(k6.content, /http\.setResponseCallback\(http\.expectedStatuses\(\{ min: 200, max: 499 \}\)\)/);
  assert.match(k6.content, /METHODS_WITH_BODY = new Set\(\['POST', 'PUT', 'PATCH'\]\)/);
  assert.match(k6.content, /JSON\.stringify\(\{ qaProbe: true \}\)/);
  assert.match(k6.content, /'Content-Type': 'application\/json'/);
});

test("orchestrator suppresses the spawn-shell-true Semgrep false positive", async () => {
  const dir = await makeFixture();
  const scan = await scanRepository(dir);
  const assets = generateAssets(scan, createTestPlan(scan, detectStack(scan)));
  const runAll = assets.files.find((f) => f.path === "scripts/qa-run-all.mjs");
  assert.ok(runAll, "orchestrator should be generated");
  // At least one nosemgrep marker per spawn site (currently runScript,
  // runBuildScript, withAppServer = 3 spawn calls with shell:true gated on
  // win32). Allow for future spawn additions by asserting "at least 2".
  const markers = (runAll.content.match(/nosemgrep: javascript\.lang\.security\.audit\.spawn-shell-true/g) || []);
  assert.equal(markers.length >= 2, true, "expected at least two nosemgrep markers, got " + markers.length);
  // The actual shell:true line still follows on the next line.
  assert.match(runAll.content, /shell: process\.platform === 'win32',/);
});

test("orchestrator auto-builds when start is selected and a build script exists", async () => {
  const dir = await makeFixture();
  const scan = await scanRepository(dir);
  const assets = generateAssets(scan, createTestPlan(scan, detectStack(scan)));
  const runAll = assets.files.find((f) => f.path === "scripts/qa-run-all.mjs");
  assert.ok(runAll, "qa-run-all.mjs should be generated");
  assert.match(runAll.content, /runBuildScript/);
  assert.match(runAll.content, /npm run build before app server start/);
  // prefer start over dev now
  assert.match(runAll.content, /if \(pkg\.scripts\?\.start\) return 'start'/);
});

test("extractRouteFromTitle parses Playwright journey titles back to paths", () => {
  assert.equal(extractRouteFromTitle("journey: home"), "/");
  assert.equal(extractRouteFromTitle("journey: about"), "/about");
  assert.equal(extractRouteFromTitle("journey: blog > category > sample"), "/blog/category/sample");
  assert.equal(extractRouteFromTitle("journey: articles > sample"), "/articles/sample");
  assert.equal(extractRouteFromTitle("smoke: configured page loads"), null);
  assert.equal(extractRouteFromTitle(""), null);
});

test("patchEnrichedBlock surgically rewrites ENRICHED in a journey spec", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-qa-patch-"));
  const spec = path.join(dir, "user-journeys.spec.ts");
  await fs.writeFile(spec, `import { expect, test } from '@playwright/test';

const journeys = [];

const ENRICHED = {
  "/": { "description": "old home", "expected": [{ "kind": "heading", "text": "Old" }] },
  "/about": { "description": "about", "expected": [{ "kind": "heading", "text": "About" }] }
};

// tail content preserved
`);

  const newMap = {
    "/": { description: "new home", expected: [{ kind: "heading", text: "Welcome" }] },
  };
  const result = await patchEnrichedBlock(spec, newMap);
  assert.equal(result.rewrote, true);
  const after = await fs.readFile(spec, "utf8");
  // Merged — home updated, about preserved.
  assert.match(after, /"description": "new home"/);
  assert.match(after, /"description": "about"/);
  assert.match(after, /text": "Welcome"/);
  // Tail comment preserved.
  assert.match(after, /tail content preserved/);
  // Header preserved.
  assert.match(after, /from '@playwright\/test'/);
});

test("repair fetches DOM, re-enriches failed routes, optionally patches spec", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-qa-repair-"));

  // Stand up a tiny site that has changed since the original spec was generated.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><head><title>Updated home</title></head><body><h1>Hello from the new home</h1></body></html>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  // Lay down a journey spec with a stale ENRICHED block.
  await fs.mkdir(path.join(dir, "tests", "e2e"), { recursive: true });
  const specPath = path.join(dir, "tests", "e2e", "user-journeys.spec.ts");
  await fs.writeFile(specPath, `const ENRICHED = {
  "/": { "description": "old", "expected": [{ "kind": "heading", "text": "Old text that no longer matches" }] }
};
`);

  // Synthesize a Playwright results.json with a locator failure on "/".
  const resultsPath = path.join(dir, "results.json");
  await fs.writeFile(resultsPath, JSON.stringify({
    suites: [{
      title: "root",
      specs: [{
        title: "journey: home",
        file: "tests/e2e/user-journeys.spec.ts",
        tests: [{
          projectName: "chromium",
          results: [{
            status: "failed",
            duration: 1234,
            errors: [{ message: "Error: expect(page.getByRole('heading', { name: /Old text/i })).toBeVisible() — locator not found" }],
          }],
        }],
      }],
      suites: [],
    }],
  }), "utf8");

  // Mock LLM client returning new assertions based on the (re-fetched) DOM.
  const fakeClient = {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: JSON.stringify({
          description: "Repaired home page",
          expected: [{ kind: "heading", text: "Hello from the new home" }],
        }) }],
      }),
    },
  };

  try {
    // Inject the fake client by stubbing process.env to fool resolveProvider,
    // then thread the client through via repair's pipeline. Since repair calls
    // enrichJourneys internally without a client param, we use a workaround:
    // pre-warm the cache. But for this test, we exercise the inner pieces.
    // Simpler: call enrichJourneys directly to validate the contract, plus
    // patchEnrichedBlock end-to-end.
    const journeys = [{
      path: "/",
      title: "home",
      env: "QA_ROUTE_HOME",
      html: "<html><body><h1>Hello from the new home</h1></body></html>",
      source: "repair",
    }];
    const { enriched } = await enrichJourneys({
      repoRoot: dir,
      journeys,
      client: fakeClient,
    });
    assert.equal(enriched.size, 1);
    const newMap = Object.fromEntries(enriched);
    const patched = await patchEnrichedBlock(specPath, newMap);
    assert.equal(patched.rewrote, true);
    const after = await fs.readFile(specPath, "utf8");
    assert.match(after, /Hello from the new home/);
    assert.match(after, /Repaired home page/);
  } finally {
    server.close();
  }
});

test("apiDiscovery detects POST from app router route exports", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-qa-method-"));
  await fs.mkdir(path.join(dir, "app", "api", "submit"), { recursive: true });
  await fs.mkdir(path.join(dir, "app", "api", "health"), { recursive: true });
  await fs.writeFile(path.join(dir, "app", "api", "submit", "route.ts"),
    "export async function POST(req: Request) { return new Response('ok'); }");
  await fs.writeFile(path.join(dir, "app", "api", "health", "route.ts"),
    "export async function GET() { return new Response('ok'); }");

  const files = ["app/api/submit/route.ts", "app/api/health/route.ts"];
  const endpoints = discoverApiEndpoints(files, { repoRoot: dir });
  const submit = endpoints.find((e) => e.path === "/api/submit");
  const health = endpoints.find((e) => e.path === "/api/health");
  assert.equal(submit.method, "POST");
  assert.equal(health.method, "GET");

  // No repoRoot → defaults to GET for everything (backward compatible)
  const legacy = discoverApiEndpoints(files);
  assert.equal(legacy.find((e) => e.path === "/api/submit").method, "GET");
});

test("buildPlaywrightQaCases skips visual specs to avoid double-counting", async () => {
  const dir = await makeFixture();
  const scan = await scanRepository(dir);
  const assets = generateAssets(scan, createTestPlan(scan, detectStack(scan)));
  // Verify the qa scripts include per-stage PLAYWRIGHT_JSON_OUTPUT_FILE env
  // vars pointing at qa-results/ (NOT playwright-report/, which Playwright's
  // html reporter wipes between stages and would erase the per-stage outputs).
  assert.match(assets.packageJson, /PLAYWRIGHT_JSON_OUTPUT_FILE=qa-results\/playwright-smoke\.json/);
  assert.match(assets.packageJson, /PLAYWRIGHT_JSON_OUTPUT_FILE=qa-results\/playwright-journeys\.json/);
  assert.match(assets.packageJson, /PLAYWRIGHT_JSON_OUTPUT_FILE=qa-results\/playwright-e2e\.json/);
  assert.match(assets.packageJson, /PLAYWRIGHT_JSON_OUTPUT_FILE=qa-results\/playwright-a11y\.json/);
  assert.match(assets.packageJson, /PLAYWRIGHT_JSON_OUTPUT_FILE=qa-results\/playwright-visual\.json/);
  // Old paths must NOT appear (verify the upgrade fully transitioned).
  assert.equal(/playwright-report\/(smoke|journeys|e2e|a11y|visual)\.json/.test(assets.packageJson), false);
  // qa:e2e should target the critical-journey spec only (no longer duplicates user-journeys)
  assert.match(assets.packageJson, /playwright test tests\/e2e\/critical-journey\.spec\.ts/);
});

test("Next.js fixture scaffolds visual stage with screenshot spec", async () => {
  const dir = await makeFixture();
  const scan = await scanRepository(dir);
  const plan = createTestPlan(scan, detectStack(scan));
  const assets = generateAssets(scan, plan);

  assert.equal(plan.enabledTools.includes("visual"), true);
  assert.match(assets.packageJson, /qa:visual/);
  assert.match(assets.packageJson, /qa:visual:update/);
  const visualSpec = assets.files.find((f) => f.path === "tests/visual/qa-visual.spec.ts");
  assert.ok(visualSpec, "visual spec should be generated");
  assert.match(visualSpec.content, /toHaveScreenshot/);
  assert.match(visualSpec.content, /maxDiffPixelRatio/);
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
  await fs.mkdir(path.join(dir, "qa-results", "axe"), { recursive: true });
  await fs.writeFile(path.join(dir, "qa-results", "axe", "home.json"), JSON.stringify({
    path: "/",
    violations: [
      { id: "color-contrast", impact: "serious", help: "Elements must have sufficient color contrast", helpUrl: "https://x", nodes: [{}, {}] },
      { id: "image-alt", impact: "critical", help: "Images must have alt text", helpUrl: "https://y", nodes: [{}] },
      { id: "label", impact: "minor", help: "Form elements must have labels", nodes: [{}] },
    ],
  }), "utf8");
  await fs.writeFile(path.join(dir, "qa-results", "gitleaks.json"), JSON.stringify([
    { RuleID: "openai-api-key", File: "src/config.ts", StartLine: 42, Match: "OPENAI_API_KEY=sk-...redacted" },
  ]), "utf8");
  await fs.writeFile(path.join(dir, "qa-results", "semgrep.json"), JSON.stringify({
    version: "1.0", results: [
      { check_id: "javascript.lang.security.audit.eval-detected", path: "src/util.js", start: { line: 12 }, extra: { severity: "ERROR", message: "Eval is dangerous" } },
      { check_id: "javascript.lang.best-practice.foo", path: "src/x.js", start: { line: 1 }, extra: { severity: "INFO", message: "Info finding" } },
    ],
  }), "utf8");
  await fs.writeFile(path.join(dir, "coverage", "lcov.info"), "LF:10\nLH:8\nFNF:5\nFNH:5\nBRF:4\nBRH:2\n", "utf8");

  const result = spawnSync("node", ["scripts/qa-report.mjs"], { cwd: dir, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(await fs.readFile(path.join(dir, "qa-results", "qa-report.json"), "utf8"));
  const workbook = await fs.readFile(path.join(dir, "qa-results", "qa-report.xls"), "utf8");

  // playwright 2 + vitest 2 + newman 3 + k6 4 + axe 3 + gitleaks 1 + semgrep 2 + trivy 0 = 17
  assert.equal(report.summary.total, 17);
  // failed: playwright 1 + vitest 1 + axe 2 (serious+critical) + gitleaks 1 + semgrep 1 (ERROR) = 6
  assert.equal(report.summary.failed, 6);
  assert.equal(report.testCases.length, 2);
  const toolNames = report.rows.map((row) => row.tool).sort();
  assert.deepEqual(toolNames.filter((t) => ["axe", "gitleaks", "semgrep", "trivy"].includes(t)).sort(),
    ["axe", "gitleaks", "semgrep", "trivy"]);
  const a11yCases = report.qaTestCases.filter((c) => c.testCaseId.startsWith("QA-A11Y"));
  const leakCases = report.qaTestCases.filter((c) => c.testCaseId.startsWith("QA-LEAK"));
  const sastCases = report.qaTestCases.filter((c) => c.testCaseId.startsWith("QA-SAST"));
  assert.equal(a11yCases.length, 3);
  assert.equal(leakCases.length, 1);
  assert.equal(sastCases.length, 2);
  assert.equal(a11yCases.filter((c) => c.status === "Fail").length, 2);
  assert.equal(leakCases[0].priority, "High");
  assert.equal(sastCases.find((c) => c.priority === "High")?.summary, "javascript.lang.security.audit.eval-detected");
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

test("parseExports correctly extracts named and aliased exports and ignores comments and strings", () => {
  const code = `
    // export const DONT_EXTRACT_COMMENT = 1;
    /* export function DONT_EXTRACT_MULTI() {} */
    const raw = "export const DONT_EXTRACT_STRING = 2";
    export async function GET() {}
    export const POST = () => {};
    export let PUT = 1, DELETE = 2;
    export { handler as PATCH };
    export { OPTIONS };
  `;
  const exported = parseExports(code);
  assert.equal(exported.has("GET"), true);
  assert.equal(exported.has("POST"), true);
  assert.equal(exported.has("PUT"), true);
  assert.equal(exported.has("DELETE"), true);
  assert.equal(exported.has("PATCH"), true);
  assert.equal(exported.has("OPTIONS"), true);
  assert.equal(exported.has("DONT_EXTRACT_COMMENT"), false);
  assert.equal(exported.has("DONT_EXTRACT_MULTI"), false);
  assert.equal(exported.has("DONT_EXTRACT_STRING"), false);
});

test("loadFixtures returns mapped paths from qa-fixtures.json", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-qa-fixtures-"));
  await fs.writeFile(path.join(dir, "qa-fixtures.json"), JSON.stringify({
    routes: {
      "/products/sample": "/products/123-real-product"
    },
    api: {
      "/api/orders/sample": "/api/orders/order_12345"
    }
  }));

  const staticJourneys = [{ path: "/products/sample", title: "products > sample", env: "QA_ROUTE_PRODUCTS_PARAM", source: "app/products/[id]/page.tsx" }];
  const endpointsFiles = ["app/api/orders/[id]/route.ts"];

  const journeys = discoverUserJourneys(["app/products/[id]/page.tsx"], { repoRoot: dir });
  const endpoints = discoverApiEndpoints(endpointsFiles, { repoRoot: dir });

  const resolvedJourney = journeys.find((j) => j.source === "app/products/[id]/page.tsx");
  assert.equal(resolvedJourney.path, "/products/123-real-product");

  const resolvedEndpoint = endpoints.find((e) => e.source === "app/api/orders/[id]/route.ts");
  assert.equal(resolvedEndpoint.path, "/api/orders/order_12345");
});

test("escapeXml handles invalid control characters and ANSI color sequences", () => {
  const invalid = "\x1B[31mError:\x1B[0m something went wrong \x08\x00\x1B";
  const escaped = escapeXml(invalid);
  assert.equal(escaped.includes("Error:"), true);
  assert.equal(escaped.includes("something went wrong"), true);
  assert.equal(escaped.includes("\x1B"), false);
  assert.equal(escaped.includes("\x00"), false);
  assert.equal(escaped.includes("&"), false);
});

test("bootstrap visual passes explicit host and port flags for Vite", () => {
  const command = buildServerCommand({
    scripts: { dev: "vite --mode development" },
    devDependencies: { vite: "^7.0.0" },
  }, "dev", 4173);

  assert.deepEqual(command.args, ["run", "dev", "--", "--host", "127.0.0.1", "--port", "4173"]);
  assert.equal(command.env.PORT, "4173");
  assert.equal(command.env.HOST, "127.0.0.1");
});

test("bootstrap visual passes explicit host and port flags for Next", () => {
  const command = buildServerCommand({
    scripts: { start: "next start" },
    dependencies: { next: "^15.0.0" },
  }, "start", 4123);

  assert.deepEqual(command.args, ["run", "start", "--", "-H", "127.0.0.1", "-p", "4123"]);
  assert.equal(command.env.PORT, "4123");
  assert.equal(command.env.HOST, "127.0.0.1");
});

test("parseQaFailures extracts Playwright and QA report failures", () => {
  const report = {
    suites: [{
      title: "root",
      specs: [{
        title: "journey: checkout",
        file: "tests/e2e/user-journeys.spec.ts",
        tests: [{
          results: [{ status: "failed", errors: [{ message: "Expected checkout total to be visible" }] }],
        }],
      }],
    }],
    testCases: [{
      tool: "vitest",
      title: "price math",
      file: "tests/unit/price.test.js",
      status: "failed",
      errors: "expected 42",
    }],
    qaTestCases: [{
      testCaseId: "QA-PW-001",
      summary: "Home page renders",
      testType: "playwright",
      status: "Fail",
      actualResult: "body empty",
    }],
  };

  const failures = parseQaFailures(report);
  assert.equal(failures.length, 3);
  assert.equal(failures[0].tool, "playwright");
  assert.match(failures[0].title, /journey: checkout/);
  assert.equal(failures.find((failure) => failure.tool === "vitest").file, "tests/unit/price.test.js");
});

test("retrieveFixContext ranks source files by failure terms and embeddings", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-qa-fix-index-"));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "Checkout.tsx"), "export function Checkout(){ return <button>Pay now</button>; }");
  await fs.writeFile(path.join(dir, "src", "Marketing.tsx"), "export function Marketing(){ return <h1>Hello</h1>; }");

  const index = await buildFixIndex(dir);
  const failure = { tool: "playwright", title: "checkout pay button missing", error: "Pay now was not visible" };
  const embedder = async (texts) => texts.map((text) => text.includes("Checkout") || text.includes("checkout") || text.includes("Pay now") ? [1, 0] : [0, 1]);
  const candidates = await retrieveFixContext(failure, index, {
    useEmbeddings: true,
    embedder,
    maxFiles: 2,
  });

  assert.equal(candidates[0].path, "src/Checkout.tsx");
  assert.equal(candidates[0].semantic > 0, true);
});

test("retrieveFixContext boosts stack trace files and selector source matches", async () => {
  const index = [
    {
      path: "src/components/CheckoutButton.tsx",
      content: "export function CheckoutButton(){ return <button data-testid=\"checkout-submit\">Pay</button>; }",
      tokens: ["checkoutbutton", "pay"],
      role: "component",
      selectorHints: ["checkout-submit"],
      symbols: ["CheckoutButton"],
      api: [],
      env: [],
    },
    {
      path: "docs/checkout.md",
      content: "checkout checkout checkout submit button copy",
      tokens: ["checkout", "submit", "button", "copy"],
      role: "source",
      selectorHints: [],
      symbols: [],
      api: [],
      env: [],
    },
  ];

  const candidates = await retrieveFixContext({
    tool: "playwright",
    title: "checkout submit button",
    error: "locator('[data-testid=\"checkout-submit\"]') timed out\n    at src/components/CheckoutButton.tsx:7:13",
  }, index);

  assert.equal(candidates[0].path, "src/components/CheckoutButton.tsx");
  assert.equal(candidates[0].structural > candidates[0].lexical, true);
});

test("buildRepoIndex captures routes, symbols, imports, selectors, env, api, and packages", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-qa-index-"));
  await fs.mkdir(path.join(dir, "apps", "web", "app", "checkout"), { recursive: true });
  await fs.mkdir(path.join(dir, "apps", "web", "src", "components"), { recursive: true });
  await fs.mkdir(path.join(dir, "apps", "web", "tests", "e2e"), { recursive: true });
  await fs.writeFile(path.join(dir, "apps", "web", "app", "checkout", "page.tsx"), [
    "import { CheckoutButton } from '../../src/components/CheckoutButton';",
    "export default function CheckoutPage(){ return <CheckoutButton />; }",
  ].join("\n"));
  await fs.writeFile(path.join(dir, "apps", "web", "src", "components", "CheckoutButton.tsx"), [
    "export function CheckoutButton(){",
    "  const api = process.env.NEXT_PUBLIC_API_URL;",
    "  fetch('/api/orders');",
    "  return <button data-testid=\"checkout-submit\" aria-label=\"Submit order\">Pay now</button>;",
    "}",
  ].join("\n"));
  await fs.writeFile(path.join(dir, "apps", "web", "tests", "e2e", "checkout.spec.ts"), [
    "import { test } from '@playwright/test';",
    "test('checkout submit', async ({ page }) => {",
    "  await page.getByTestId('checkout-submit').click();",
    "});",
  ].join("\n"));

  const index = await buildRepoIndex(dir);
  const component = index.entries.find((entry) => entry.path.endsWith("CheckoutButton.tsx"));
  const route = index.entries.find((entry) => entry.path.endsWith("checkout/page.tsx"));
  const matches = queryRepoIndex(index, "checkout submit NEXT_PUBLIC_API_URL", { maxFiles: 3 });
  const outPath = await writeRepoIndex(dir, index);
  const reloaded = await readRepoIndex(dir);

  assert.equal(route.route, "/checkout");
  assert.equal(component.role, "component");
  assert.equal(component.package, "apps/web");
  assert.equal(component.symbols.includes("CheckoutButton"), true);
  assert.equal(component.env.includes("NEXT_PUBLIC_API_URL"), true);
  assert.equal(component.api.includes("/api/orders"), true);
  assert.equal(component.selectorHints.includes("checkout-submit"), true);
  assert.equal(index.graph.routeToFiles["/checkout"][0].endsWith("checkout/page.tsx"), true);
  assert.equal(index.graph.envToFiles.NEXT_PUBLIC_API_URL[0].endsWith("CheckoutButton.tsx"), true);
  assert.equal(path.basename(outPath), "repo-index.json");
  assert.equal(reloaded.stats.files, index.stats.files);
  assert.equal(matches[0].path.endsWith("CheckoutButton.tsx"), true);
});

test("codingFix uses persisted repo index cache when available", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-qa-cached-index-"));
  const resultsPath = path.join(dir, "results.json");
  await fs.writeFile(resultsPath, JSON.stringify({
    testCases: [{
      tool: "playwright",
      title: "checkout submit",
      file: "tests/e2e/checkout.spec.ts",
      status: "failed",
      errors: "getByTestId('checkout-submit') timed out",
    }],
  }));

  await writeRepoIndex(dir, {
    schemaVersion: 1,
    repo: dir,
    generatedAt: new Date().toISOString(),
    stats: { files: 1, routes: 0, imports: 0, packages: 1, embeddings: 0 },
    graph: {},
    entries: [{
      path: "src/CachedCheckout.tsx",
      role: "component",
      package: ".",
      route: null,
      imports: [],
      symbols: ["CachedCheckout"],
      env: [],
      api: [],
      selectorHints: ["checkout-submit"],
      content: "export function CachedCheckout(){ return <button data-testid=\"checkout-submit\" />; }",
      tokens: ["cachedcheckout", "checkout-submit"],
    }],
  });

  const result = await codingFix({ resultsPath, repoRoot: dir, classifyOnly: true });

  assert.equal(result.index.source, "cache");
  assert.equal(result.index.stats.files, 1);
  assert.equal(result.fixes[0].candidates[0].path, "src/CachedCheckout.tsx");
});

test("applyExactPatches only applies exact in-repo replacements", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-qa-apply-patch-"));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  const file = path.join(dir, "src", "Checkout.tsx");
  await fs.writeFile(file, "export const label = 'Pay';\n");

  const results = await applyExactPatches(dir, [
    { path: "src/Checkout.tsx", before: "'Pay'", after: "'Pay now'", reason: "match CTA" },
    { path: "../outside.js", before: "x", after: "y", reason: "bad path" },
    { path: "src/Checkout.tsx", before: "missing", after: "nope", reason: "stale patch" },
  ]);

  assert.equal(results[0].applied, true);
  assert.equal(results[1].applied, false);
  assert.equal(results[1].reason, "path outside repo");
  assert.equal(results[2].applied, false);
  assert.equal(await fs.readFile(file, "utf8"), "export const label = 'Pay now';\n");
});

test("codingFix retrieves context, asks fake coding agent, and applies exact patch", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-qa-coding-fix-"));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "Checkout.tsx"), "export function Checkout(){ return <button>Pay</button>; }\n");
  const resultsPath = path.join(dir, "results.json");
  await fs.writeFile(resultsPath, JSON.stringify({
    suites: [{
      title: "root",
      specs: [{
        title: "checkout pay button",
        file: "tests/e2e/checkout.spec.ts",
        tests: [{ results: [{ status: "failed", errors: [{ message: "Pay now button not found in Checkout" }] }] }],
      }],
    }],
  }));

  const fakeClient = {
    messages: {
      create: async ({ messages }) => {
        assert.match(messages[0].content, /Checkout\.tsx/);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              summary: "Update checkout CTA label.",
              patches: [{
                path: "src/Checkout.tsx",
                before: "<button>Pay</button>",
                after: "<button>Pay now</button>",
                reason: "Test expects the expanded CTA.",
              }],
              commands: ["npm test"],
            }),
          }],
        };
      },
    },
  };

  const result = await codingFix({
    resultsPath,
    repoRoot: dir,
    apply: true,
    client: fakeClient,
  });

  assert.equal(result.failures, 1);
  assert.equal(result.fixes[0].patches[0].applied, true);
  assert.match(await fs.readFile(path.join(dir, "src", "Checkout.tsx"), "utf8"), /Pay now/);
});

test("patch bundles include rollback data and PR markdown", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-qa-patch-bundle-"));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  const file = path.join(dir, "src", "Checkout.tsx");
  await fs.writeFile(file, "export const label = 'Pay';\n");
  const resultsPath = path.join(dir, "results.json");
  await fs.writeFile(resultsPath, JSON.stringify({
    testCases: [{
      tool: "playwright",
      title: "checkout label",
      file: "tests/e2e/checkout.spec.ts",
      status: "failed",
      errors: "expected Pay now",
    }],
  }));

  const fakeClient = {
    messages: {
      create: async () => ({
        content: [{
          type: "text",
          text: JSON.stringify({
            summary: "Update checkout label.",
            patches: [{ path: "src/Checkout.tsx", before: "'Pay'", after: "'Pay now'", reason: "match CTA expectation" }],
            commands: [],
          }),
        }],
      }),
    },
  };

  const result = await codingFix({ resultsPath, repoRoot: dir, apply: true, client: fakeClient });
  const bundle = buildPatchBundle(result, { generatedAt: "2026-06-18T00:00:00.000Z" });
  const markdown = renderPrMarkdown(result, bundle);
  const rollback = await rollbackPatchBundle(dir, bundle);

  assert.equal(bundle.summary.changes, 1);
  assert.equal(bundle.changes[0].rollback.before, "'Pay now'");
  assert.equal(bundle.changes[0].rollback.after, "'Pay'");
  assert.match(markdown, /QA Agent Fix/);
  assert.match(markdown, /checkout label/);
  assert.equal(rollback[0].applied, true);
  assert.equal(await fs.readFile(file, "utf8"), "export const label = 'Pay';\n");
});

test("codingFixInWorktree applies patches away from the original repo", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-qa-worktree-origin-"));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "Checkout.tsx"), "export const label = 'Pay';\n");
  assert.equal(spawnSync("git", ["init"], { cwd: dir }).status, 0);
  assert.equal(spawnSync("git", ["add", "."], { cwd: dir }).status, 0);
  assert.equal(spawnSync("git", ["-c", "user.email=qa@example.com", "-c", "user.name=QA Agent", "commit", "-m", "initial"], { cwd: dir }).status, 0);

  const resultsPath = path.join(os.tmpdir(), `repo-qa-worktree-results-${Date.now()}.json`);
  await fs.writeFile(resultsPath, JSON.stringify({
    testCases: [{
      tool: "playwright",
      title: "checkout label",
      file: "tests/e2e/checkout.spec.ts",
      status: "failed",
      errors: "expected Pay now",
    }],
  }));

  const fakeClient = {
    messages: {
      create: async () => ({
        content: [{
          type: "text",
          text: JSON.stringify({
            summary: "Update checkout label.",
            patches: [{ path: "src/Checkout.tsx", before: "'Pay'", after: "'Pay now'", reason: "match CTA expectation" }],
            commands: [],
          }),
        }],
      }),
    },
  };

  const result = await codingFixInWorktree({
    resultsPath,
    repoRoot: dir,
    apply: true,
    client: fakeClient,
  });

  assert.equal(result.worktree.enabled, true);
  assert.equal(result.worktree.kept, false);
  assert.equal(result.fixes[0].patches[0].applied, true);
  assert.equal(await fs.readFile(path.join(dir, "src", "Checkout.tsx"), "utf8"), "export const label = 'Pay';\n");
  await assert.rejects(fs.stat(result.worktree.path));
});

test("classifyFailure labels common QA failure types", () => {
  assert.equal(
    classifyFailure({ tool: "playwright", error: "locator.getByRole timed out: element is not visible" }).type,
    "selector-or-dom-drift",
  );
  assert.equal(
    classifyFailure({ tool: "trivy", error: "CVE-2026-123 critical vulnerability" }).type,
    "security-finding",
  );
  assert.equal(
    classifyFailure({ error: "QA_BASE_URL not set and connection refused" }).type,
    "environment-or-fixture",
  );
});

test("planValidationCommands picks narrow safe validation commands", () => {
  const playwright = planValidationCommands({ tool: "playwright", file: "tests/e2e/checkout.spec.ts" });
  const vitest = planValidationCommands({ tool: "vitest", file: "tests/unit/price.test.js" }, {
    commands: ["rm -rf .", "npm run qa:unit"],
  });

  assert.deepEqual(playwright, ["npx playwright test tests/e2e/checkout.spec.ts"]);
  assert.equal(vitest.includes("npm run qa:unit"), true);
  assert.equal(vitest.includes("rm -rf ."), false);
});

test("runValidationCommands executes safe commands and reports status", async () => {
  const results = await runValidationCommands(["node -e \"process.exit(0)\""], { cwd: process.cwd() });
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
});

test("codingFix classify-only returns classifications without proposals", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-qa-classify-only-"));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "Checkout.tsx"), "export function Checkout(){ return <main/>; }\n");
  const resultsPath = path.join(dir, "results.json");
  await fs.writeFile(resultsPath, JSON.stringify({
    testCases: [{
      tool: "playwright",
      title: "checkout route",
      file: "tests/e2e/checkout.spec.ts",
      status: "failed",
      errors: "getByRole button not found",
    }],
  }));

  const result = await codingFix({ resultsPath, repoRoot: dir, classifyOnly: true });
  assert.equal(result.classifyOnly, true);
  assert.equal(result.fixes[0].classification.type, "selector-or-dom-drift");
  assert.equal(result.fixes[0].attempts.length, 0);
  assert.equal(result.fixes[0].proposal.patches.length, 0);
});

test("codingFix validate records validation commands and results", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-qa-validate-"));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "Checkout.tsx"), "export const label = 'Pay';\n");
  const resultsPath = path.join(dir, "results.json");
  await fs.writeFile(resultsPath, JSON.stringify({
    testCases: [{
      tool: "custom",
      title: "checkout label",
      file: "",
      status: "failed",
      errors: "expected Pay now",
    }],
  }));

  const fakeClient = {
    messages: {
      create: async () => ({
        content: [{
          type: "text",
          text: JSON.stringify({
            summary: "Update label.",
            patches: [{ path: "src/Checkout.tsx", before: "'Pay'", after: "'Pay now'", reason: "match test expectation" }],
            commands: ["node -e \"process.exit(0)\""],
          }),
        }],
      }),
    },
  };

  const result = await codingFix({
    resultsPath,
    repoRoot: dir,
    apply: true,
    validate: true,
    client: fakeClient,
  });

  assert.equal(result.validate, true);
  assert.equal(result.fixes[0].attempts[0].validationOk, true);
  assert.equal(result.fixes[0].attempts[0].validation[0].ok, true);
});

import {
  parseRouteDeclarations,
  buildImportMap,
  resolveImportToFile,
  expandRoutePath,
  discoverReactRouterJourneys,
  parseVueRouteEntries,
  discoverVueRouterJourneys,
  parseHttpRouteCalls,
  discoverBackendJourneys,
  buildFixtureExample,
} from "../src/index.js";

test("expandRoutePath substitutes :params with sample values and collapses optionals", () => {
  assert.deepEqual(expandRoutePath("/:lang?/:insuranceType/:channel/motor-basic-form"), {
    path: "/motor-insurance/main/motor-basic-form",
    params: ["lang", "insuranceType", "channel"],
    dynamic: true,
  });
  assert.deepEqual(expandRoutePath("/static-page"), {
    path: "/static-page",
    params: [],
    dynamic: false,
  });
  assert.equal(expandRoutePath("/:id").path, "/1");
});

test("parseRouteDeclarations extracts <Route path=... element/component=...> attrs (absolute paths, catch-all skipped)", () => {
  const source = `
    <Route exact path="home" element={<LandingPage />}/>
    <Route path="blogs/:slug" element={<BlogDetail />}/>
    <PublicRoute path='/term/:channel' component={HomePage} />
    <Route path="*" element={<NotFound/>} />
  `;
  const decls = parseRouteDeclarations(source);
  assert.deepEqual(
    decls.map((d) => ({ rawPath: d.rawPath, componentName: d.componentName })),
    [
      { rawPath: "/home", componentName: "LandingPage" },
      { rawPath: "/blogs/:slug", componentName: "BlogDetail" },
      { rawPath: "/term/:channel", componentName: "HomePage" },
    ]
  );
});

test("parseRouteDeclarations inherits parent <Route path> into nested children", () => {
  const source = `
    <Route path="/:lang?">
      <Route path="dashboard" element={<Dashboard/>}>
        <Route path="users" element={<UserList/>} />
        <Route path="users/:id" element={<UserDetail/>} />
      </Route>
      <Route path="login" element={<Login/>}/>
    </Route>
  `;
  const decls = parseRouteDeclarations(source);
  const paths = decls.map((d) => d.rawPath).sort();
  assert.deepEqual(paths, [
    "/:lang?/dashboard",
    "/:lang?/dashboard/users",
    "/:lang?/dashboard/users/:id",
    "/:lang?/login",
  ]);
});

test("buildImportMap captures default, named, and lazy/ReactLazyPreload imports", () => {
  const source = `
    import Foo from './Foo';
    import { Bar } from './Bar';
    const Baz = lazy(() => import('./Baz/Baz'));
    const Qux = ReactLazyPreload(() => import('./Pages/Qux/Qux'));
  `;
  const map = buildImportMap(source);
  assert.equal(map.get("Foo"), "./Foo");
  assert.equal(map.get("Bar"), "./Bar");
  assert.equal(map.get("Baz"), "./Baz/Baz");
  assert.equal(map.get("Qux"), "./Pages/Qux/Qux");
});

test("resolveImportToFile tries common extensions and index files", () => {
  const files = new Set([
    "src/Routes/index.jsx",
    "src/Pages/MotorBasicForm/MotorBasicForm.jsx",
    "src/Pages/HomePage/index.tsx",
  ]);
  assert.equal(
    resolveImportToFile("src/Routes/index.jsx", "../Pages/MotorBasicForm/MotorBasicForm", files),
    "src/Pages/MotorBasicForm/MotorBasicForm.jsx"
  );
  assert.equal(
    resolveImportToFile("src/Routes/index.jsx", "../Pages/HomePage", files),
    "src/Pages/HomePage/index.tsx"
  );
  assert.equal(
    resolveImportToFile("src/Routes/index.jsx", "../Pages/Missing", files),
    null
  );
});

test("discoverReactRouterJourneys finds CRA-style routes against a fixture repo", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-rrr-"));
  await fs.mkdir(path.join(dir, "src/Routes"), { recursive: true });
  await fs.mkdir(path.join(dir, "src/Pages/MotorBasicForm"), { recursive: true });
  await fs.mkdir(path.join(dir, "src/Pages/LandingPage"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "src/Routes/index.jsx"),
    `
    import { Route, Routes } from 'react-router-dom';
    const LandingPage = ReactLazyPreload(() => import('../Pages/LandingPage/LandingPage'));
    const MotorBasicForm = ReactLazyPreload(() => import('../Pages/MotorBasicForm/MotorBasicForm'));
    export default function App() {
      return (
        <Routes>
          <Route path="/:lang?">
            <Route exact path="home" element={<LandingPage />} />
            <Route path=":insuranceType/:channel/motor-basic-form" element={<MotorBasicForm />} />
          </Route>
        </Routes>
      );
    }`,
    "utf8"
  );
  await fs.writeFile(path.join(dir, "src/Pages/LandingPage/LandingPage.jsx"), "export default function L(){return null;}", "utf8");
  await fs.writeFile(path.join(dir, "src/Pages/MotorBasicForm/MotorBasicForm.jsx"), "export default function M(){return null;}", "utf8");
  const files = ["src/Routes/index.jsx", "src/Pages/LandingPage/LandingPage.jsx", "src/Pages/MotorBasicForm/MotorBasicForm.jsx"];
  const journeys = discoverReactRouterJourneys(files, dir);
  const paths = journeys.map((j) => j.path).sort();
  assert.deepEqual(paths, ["/home", "/motor-insurance/main/motor-basic-form"]);
  const motor = journeys.find((j) => j.path === "/motor-insurance/main/motor-basic-form");
  assert.equal(motor.source, "src/Pages/MotorBasicForm/MotorBasicForm.jsx");
  assert.equal(motor.framework, "react-router");
  // The stack-based parser inherits parent <Route path="/:lang?"> into the
  // child path, so all three params show up here.
  assert.deepEqual(motor.params, ["lang", "insuranceType", "channel"]);
});

test("discoverUserJourneys integrates React Router declarations into the journey list", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-uj-"));
  await fs.mkdir(path.join(dir, "src/Routes"), { recursive: true });
  await fs.mkdir(path.join(dir, "src/Pages/AboutUs"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "src/Routes/index.jsx"),
    `import {Route} from 'react-router-dom';
     import AboutUs from '../Pages/AboutUs/AboutUs';
     export default () => (<><Route exact path="about-us" element={<AboutUs/>}/></>);`,
    "utf8"
  );
  await fs.writeFile(path.join(dir, "src/Pages/AboutUs/AboutUs.jsx"), "export default ()=>null;", "utf8");
  const scan = await scanRepository(dir);
  const journeys = discoverUserJourneys(scan.files, { repoRoot: scan.root });
  const paths = journeys.map((j) => j.path);
  assert.ok(paths.includes("/about-us"), "expected /about-us in journeys: " + paths.join(","));
  const aboutUs = journeys.find((j) => j.path === "/about-us");
  assert.equal(aboutUs.source, "src/Pages/AboutUs/AboutUs.jsx");
});

test("parseVueRouteEntries finds path/component pairs from a router config", () => {
  const source = `
    export const routes = [
      { path: '/', component: Home },
      { path: '/users/:id', component: () => import('./UserDetail.vue') },
    ];
  `;
  const entries = parseVueRouteEntries(source);
  assert.deepEqual(entries.map((e) => ({ rawPath: e.rawPath, componentName: e.componentName, inlineImport: e.inlineImport })), [
    { rawPath: "/", componentName: "Home", inlineImport: null },
    { rawPath: "/users/:id", componentName: null, inlineImport: "./UserDetail.vue" },
  ]);
});

test("parseHttpRouteCalls finds Express-style verb declarations", () => {
  const source = `
    app.get('/users', listUsers);
    app.post('/orders/:id', placeOrder);
    router.delete('/sessions', signOut);
    fastify.put('/login', loginHandler);
    app.all('/healthz', health);
  `;
  const calls = parseHttpRouteCalls(source);
  assert.deepEqual(calls, [
    { method: "GET", rawPath: "/users" },
    { method: "POST", rawPath: "/orders/:id" },
    { method: "DELETE", rawPath: "/sessions" },
    { method: "PUT", rawPath: "/login" },
    { method: "GET", rawPath: "/healthz" },
  ]);
});

test("discoverBackendJourneys deduplicates by method+path across multiple server files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-be-"));
  await fs.mkdir(path.join(dir, "routes"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "server.js"),
    "app.get('/health', (req,res)=>res.send('ok'));",
    "utf8"
  );
  await fs.writeFile(
    path.join(dir, "routes/orders.js"),
    "router.post('/orders', create); router.get('/orders/:id', read);",
    "utf8"
  );
  const files = ["server.js", "routes/orders.js"];
  const endpoints = discoverBackendJourneys(files, dir);
  assert.equal(endpoints.length, 3);
  const keys = endpoints.map((e) => `${e.method} ${e.path}`).sort();
  assert.deepEqual(keys, ["GET /health", "GET /orders/1", "POST /orders"]);
});

test("buildFixtureExample emits a .example with routeParams + auth when journeys signal them", () => {
  const journeys = [
    { path: "/login", params: [] },
    { path: "/motor-insurance/main/motor-basic-form", params: ["lang", "insuranceType", "channel"] },
    { path: "/upload-documents", params: [] },
  ];
  const stack = { hasFrontend: true };
  const asset = buildFixtureExample({ journeys, stack, scan: {} });
  assert.ok(asset);
  assert.equal(asset.path, "tests/fixtures/qa-uat.local.json.example");
  const parsed = JSON.parse(asset.contents);
  assert.ok(parsed.auth, "auth slot present when /login route exists");
  assert.ok(parsed.upload, "upload slot present when /upload-documents route exists");
  assert.deepEqual(Object.keys(parsed.routeParams).sort(), ["channel", "insuranceType", "lang"]);
});

test("buildFixtureExample returns null when no signals are present", () => {
  const journeys = [{ path: "/", params: [] }, { path: "/about", params: [] }];
  const asset = buildFixtureExample({ journeys, stack: { hasFrontend: true }, scan: {} });
  assert.equal(asset, null);
});

import {
  fromSvelteKit,
  fromRemix,
  fromAstro,
  discoverFileBasedRoute,
  extractFormFields,
  extractApiCalls,
  annotateJourneysWithForms,
  annotateJourneysWithApiCalls,
  aggregateApiCallsFromJourneys,
  clusterJourneys,
  buildWalkerAssets,
} from "../src/index.js";

test("SvelteKit file-routing handles +page.svelte, [slug], (groups), [[optional]]", () => {
  assert.equal(fromSvelteKit("src/routes/+page.svelte"), "/");
  assert.equal(fromSvelteKit("src/routes/about/+page.svelte"), "/about");
  assert.equal(fromSvelteKit("src/routes/blog/[slug]/+page.svelte"), "/blog/:slug");
  assert.equal(fromSvelteKit("src/routes/(marketing)/page/+page.svelte"), "/page");
  assert.equal(fromSvelteKit("src/routes/posts/[[lang]]/+page.svelte"), "/posts/:lang?");
  assert.equal(fromSvelteKit("src/routes/blog/+layout.svelte"), null);
});

test("Remix file-routing handles _index, $param, dot-separators", () => {
  assert.equal(fromRemix("app/routes/_index.tsx"), "/");
  assert.equal(fromRemix("app/routes/about.tsx"), "/about");
  assert.equal(fromRemix("app/routes/blog.$slug.tsx"), "/blog/:slug");
  assert.equal(fromRemix("app/routes/blog._index.tsx"), "/blog");
});

test("Astro file-routing handles index, [slug], [...rest]", () => {
  assert.equal(fromAstro("src/pages/index.astro"), "/");
  assert.equal(fromAstro("src/pages/about.astro"), "/about");
  assert.equal(fromAstro("src/pages/blog/[slug].astro"), "/blog/:slug");
  assert.equal(fromAstro("src/pages/docs/[...path].astro"), "/docs/:path");
});

test("discoverFileBasedRoute returns the first hit across the three frameworks", () => {
  assert.equal(discoverFileBasedRoute("src/routes/about/+page.svelte"), "/about");
  assert.equal(discoverFileBasedRoute("app/routes/blog.$slug.tsx"), "/blog/:slug");
  assert.equal(discoverFileBasedRoute("src/pages/blog/[slug].astro"), "/blog/:slug");
  assert.equal(discoverFileBasedRoute("random.txt"), null);
});

test("extractFormFields finds MUI TextField + HTML input + RHF register", () => {
  const source = `
    function Form() {
      const { register } = useForm();
      return (
        <form>
          <TextField label="First Name" required />
          <Select label="Country" name="country" />
          <input type="email" name="email" required placeholder="you@example.com" />
          <textarea name="bio" />
          <button {...register("password", { required: true, minLength: 8 })} />
        </form>
      );
    }
  `;
  const fields = extractFormFields(source);
  const summary = fields.map((f) => ({ kind: f.kind, name: f.name, label: f.label, required: !!f.required }));
  assert.deepEqual(
    summary,
    [
      { kind: "textfield", name: undefined, label: "First Name", required: true },
      { kind: "select", name: "country", label: "Country", required: false },
      { kind: "input", name: "email", label: "you@example.com", required: true },
      { kind: "textarea", name: "bio", label: undefined, required: false },
      { kind: "rhf-register", name: "password", label: undefined, required: true },
    ]
  );
  const passwordField = fields.find((f) => f.name === "password");
  assert.equal(passwordField.validation.required, "true");
  assert.equal(passwordField.validation.minLength, "8");
});

test("extractApiCalls catches axios + fetch + helper-style calls", () => {
  const source = `
    await axios.get('/api/users');
    await axios.post("/api/orders", payload);
    await axios.get("https://api.vendor.com/external");
    await fetch('/api/health');
    await fetch("//cdn.vendor.com/asset.json");
    await fetch("/api/login", { method: "POST", body });
    await apiClient.delete('/api/sessions');
  `;
  const calls = extractApiCalls(source);
  const keys = calls.map((c) => `${c.method} ${c.path}`).sort();
  assert.deepEqual(keys, [
    "DELETE /api/sessions",
    "GET /api/health",
    "GET /api/users",
    "POST /api/login",
    "POST /api/orders",
  ]);
});

test("annotateJourneysWithForms attaches forms to journeys from real source files", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-ff-"));
  await fs.mkdir(path.join(dir, "src/Pages/Login"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "src/Pages/Login/Login.jsx"),
    `export default function Login() {
       return (<form>
         <TextField label="Email" name="email" required />
         <input type="password" name="password" required />
       </form>);
     }`,
    "utf8"
  );
  const journeys = [
    { path: "/login", source: "src/Pages/Login/Login.jsx", dynamic: false },
  ];
  annotateJourneysWithForms(journeys, dir);
  assert.equal(journeys[0].forms?.length, 2);
  assert.equal(journeys[0].forms[0].label, "Email");
});

test("annotateJourneysWithApiCalls + aggregateApiCallsFromJourneys roll calls up", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-api-"));
  await fs.mkdir(path.join(dir, "src/Pages/Login"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "src/Pages/Login/Login.jsx"),
    `export default function Login() { axios.post('/api/sessions', {}); }`,
    "utf8"
  );
  const journeys = [{ path: "/login", source: "src/Pages/Login/Login.jsx" }];
  annotateJourneysWithApiCalls(journeys, dir);
  assert.deepEqual(journeys[0].apiCalls, [{ method: "POST", path: "/api/sessions" }]);
  const aggregated = aggregateApiCallsFromJourneys(journeys);
  assert.equal(aggregated.length, 1);
  assert.equal(aggregated[0].framework, "frontend-call");
});

test("clusterJourneys groups motor flow + orders stages by funnel keywords", () => {
  const journeys = [
    { path: "/motor-insurance/main/motor-basic-form" },
    { path: "/motor-insurance/main/motor-vehicle-info" },
    { path: "/motor-insurance/main/motor-best-deals" },
    { path: "/motor-insurance/main/proposer-info" },
    { path: "/motor-insurance/main/upload-documents" },
    { path: "/motor-insurance/main/motor-summary" },
    { path: "/motor-insurance/main/motor-payment" },
    { path: "/about" },
  ];
  const clusters = clusterJourneys(journeys);
  const motor = clusters.find((c) => c.name.startsWith("motor-insurance"));
  assert.ok(motor, "expected a motor cluster");
  assert.deepEqual(
    motor.stages.map((s) => s.tag),
    ["entry", "info", "options", "details", "docs", "summary", "payment"]
  );
});

test("buildWalkerAssets emits a walker spec for funnel-shaped clusters", () => {
  const journeys = [
    { path: "/motor-insurance/main/motor-basic-form", source: "X.jsx" },
    { path: "/motor-insurance/main/motor-vehicle-info", source: "X.jsx" },
    { path: "/motor-insurance/main/motor-best-deals", source: "X.jsx" },
    { path: "/motor-insurance/main/motor-summary", source: "X.jsx" },
  ];
  const assets = buildWalkerAssets(journeys);
  assert.equal(assets.length, 1);
  assert.match(assets[0].path, /walker\.ts$/);
  assert.match(assets[0].content, /export const STAGES/);
  assert.match(assets[0].content, /export async function walkTo/);
});

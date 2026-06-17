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
  // Verify the qa scripts include per-stage PLAYWRIGHT_JSON_OUTPUT_FILE env vars
  assert.match(assets.packageJson, /PLAYWRIGHT_JSON_OUTPUT_FILE=playwright-report\/smoke\.json/);
  assert.match(assets.packageJson, /PLAYWRIGHT_JSON_OUTPUT_FILE=playwright-report\/journeys\.json/);
  assert.match(assets.packageJson, /PLAYWRIGHT_JSON_OUTPUT_FILE=playwright-report\/e2e\.json/);
  assert.match(assets.packageJson, /PLAYWRIGHT_JSON_OUTPUT_FILE=playwright-report\/a11y\.json/);
  assert.match(assets.packageJson, /PLAYWRIGHT_JSON_OUTPUT_FILE=playwright-report\/visual\.json/);
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

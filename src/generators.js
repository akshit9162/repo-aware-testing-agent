import { discoverUserJourneys } from "./journeys.js";
import { discoverUnitTestTargets } from "./unitDiscovery.js";

const PLAYWRIGHT_CONFIG = `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'playwright-report/results.json' }]],
  use: {
    baseURL: process.env.QA_BASE_URL || 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
`;

const PLAYWRIGHT_SMOKE = `import { expect, test } from '@playwright/test';

test('smoke: configured page loads', async ({ page }) => {
  await page.goto(process.env.QA_SMOKE_PATH || '/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).not.toBeEmpty();
});
`;

const PLAYWRIGHT_E2E = `import { expect, test } from '@playwright/test';

test('e2e: critical journey placeholder', async ({ page }) => {
  await page.goto(process.env.QA_E2E_PATH || '/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toBeVisible();
});
`;

function createPlaywrightJourneySpec(journeys) {
  const rows = journeys.map((journey) => ({
    title: journey.title,
    path: journey.path,
    env: journey.env,
    source: journey.source,
    dynamic: journey.dynamic,
  }));

  return `import { expect, test } from '@playwright/test';

const journeys = ${JSON.stringify(rows, null, 2)};

async function exerciseVisibleFormControls(page) {
  const textInputs = page.locator('input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="tel"], textarea');
  for (let index = 0; index < await textInputs.count(); index += 1) {
    const input = textInputs.nth(index);
    if (await input.isVisible().catch(() => false)) {
      await input.fill('qa automation');
    }
  }

  const passwordInputs = page.locator('input[type="password"]');
  for (let index = 0; index < await passwordInputs.count(); index += 1) {
    const input = passwordInputs.nth(index);
    if (await input.isVisible().catch(() => false)) {
      await input.fill('QaAutomation123!');
    }
  }

  const numberInputs = page.locator('input[type="number"]');
  for (let index = 0; index < await numberInputs.count(); index += 1) {
    const input = numberInputs.nth(index);
    if (await input.isVisible().catch(() => false)) {
      await input.fill('1');
    }
  }

  const selects = page.locator('select');
  for (let index = 0; index < await selects.count(); index += 1) {
    const select = selects.nth(index);
    if (await select.isVisible().catch(() => false)) {
      const values = await select.locator('option').evaluateAll((options) => options.map((option) => option.value).filter(Boolean));
      if (values[0]) await select.selectOption(values[0]);
    }
  }
}

for (const journey of journeys) {
  test(\`journey: \${journey.title}\`, async ({ page }) => {
    const path = process.env[journey.env] || journey.path;
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('body')).toBeVisible();
    await expect(page.locator('body')).not.toBeEmpty();
    await exerciseVisibleFormControls(page);
  });
}
`;
}

const VITEST = `import { describe, expect, it } from 'vitest';

describe('QA unit baseline', () => {
  it('runs the unit test harness', () => {
    expect(true).toBe(true);
  });
});
`;

function createGeneratedUnitTests(targets) {
  return `import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const manifest = ${JSON.stringify(targets, null, 2)};

function repoPath(file) {
  return path.join(root, file);
}

describe('QA generated unit coverage manifest', () => {
  it('keeps package scripts available for the detected QA workflow', () => {
    const pkg = JSON.parse(readFileSync(repoPath('package.json'), 'utf8'));
    for (const script of manifest.packageScripts) {
      expect(pkg.scripts, 'package script "' + script + '" should exist').toHaveProperty(script);
    }
  });

  it.each(manifest.sourceFiles)('source file exists: %s', (file) => {
    expect(existsSync(repoPath(file))).toBe(true);
  });

  it.each(manifest.configFiles)('config file exists: %s', (file) => {
    expect(existsSync(repoPath(file))).toBe(true);
  });

  it.each(manifest.routeFiles)('ui route file exists: %s', (file) => {
    expect(existsSync(repoPath(file))).toBe(true);
  });

  it.each(manifest.apiFiles)('api unit target exists: %s', (file) => {
    expect(existsSync(repoPath(file))).toBe(true);
  });

  it.each(manifest.componentFiles)('component unit target exists: %s', (file) => {
    expect(existsSync(repoPath(file))).toBe(true);
  });

  it.each(manifest.envFiles)('environment contract file exists: %s', (file) => {
    expect(existsSync(repoPath(file))).toBe(true);
  });

  it('records whether large target groups were truncated', () => {
    expect(manifest.truncated).toEqual(expect.any(Object));
  });
});
`;
}

const SONAR = `sonar.projectKey=repo-aware-qa
sonar.projectName=Repo Aware QA
sonar.sources=src
sonar.tests=tests
sonar.javascript.lcov.reportPaths=coverage/lcov.info
`;

const POSTMAN = `{
  "info": {
    "name": "QA API Contract",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "item": [
    {
      "name": "Health check",
      "request": {
        "method": "GET",
        "url": "{{baseUrl}}/health"
      },
      "event": [
        {
          "listen": "test",
          "script": {
            "type": "text/javascript",
            "exec": [
              "pm.test('status is not server error', function () {",
              "  pm.expect(pm.response.code).to.be.below(500);",
              "});"
            ]
          }
        }
      ]
    }
  ]
}
`;

const POSTMAN_ENV = `{
  "name": "QA Local",
  "values": [
    { "key": "baseUrl", "value": "http://localhost:3000", "enabled": true }
  ]
}
`;

const K6 = `import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  vus: Number(__ENV.QA_K6_VUS || 5),
  duration: __ENV.QA_K6_DURATION || '30s',
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<1000']
  }
};

export default function () {
  const url = __ENV.QA_K6_URL || 'http://localhost:3000/health';
  const res = http.get(url);
  check(res, { 'status is below 500': (r) => r.status < 500 });
  sleep(1);
}
`;

function createQaRunAll(order) {
  return `import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const order = ${JSON.stringify(order, null, 2)};
let failed = false;

for (const script of order) {
  if (!pkg.scripts?.[script] || script === 'qa:all' || script === 'qa:report' || script === 'qa:prepare') continue;
  const result = spawnSync('npm', ['run', script], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) failed = true;
}

if (pkg.scripts?.['qa:report']) {
  const report = spawnSync('npm', ['run', 'qa:report'], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (report.status !== 0) failed = true;
}

process.exit(failed ? 1 : 0);
`;
}

const QA_REPORT = `import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const outDir = path.join(root, 'qa-results');
mkdirSync(outDir, { recursive: true });

function readJson(rel) {
  const file = path.join(root, rel);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { parseError: error.message };
  }
}

function pct(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function row(cells) {
  return '<Row>' + cells.map((cell) => '<Cell><Data ss:Type="String">' + escapeXml(cell) + '</Data></Cell>').join('') + '</Row>';
}

function worksheet(name, rows) {
  return '<Worksheet ss:Name="' + escapeXml(name) + '"><Table>' + rows.join('') + '</Table></Worksheet>';
}

function summarizeLcov() {
  const file = path.join(root, 'coverage', 'lcov.info');
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const found = { lines: 0, linesHit: 0, functions: 0, functionsHit: 0, branches: 0, branchesHit: 0 };
  for (const line of text.split(/\\r?\\n/)) {
    const [key, raw] = line.split(':');
    const value = Number(raw);
    if (key === 'LF') found.lines += value;
    if (key === 'LH') found.linesHit += value;
    if (key === 'FNF') found.functions += value;
    if (key === 'FNH') found.functionsHit += value;
    if (key === 'BRF') found.branches += value;
    if (key === 'BRH') found.branchesHit += value;
  }
  return {
    lines: pct(found.lines ? (found.linesHit / found.lines) * 100 : 0),
    functions: pct(found.functions ? (found.functionsHit / found.functions) * 100 : 0),
    branches: pct(found.branches ? (found.branchesHit / found.branches) * 100 : 0),
  };
}

function playwrightStatus(test) {
  const results = test.results || [];
  if (!results.length) return 'unknown';
  if (results.some((result) => result.status === 'failed' || result.status === 'timedOut')) return 'failed';
  if (results.every((result) => result.status === 'skipped')) return 'skipped';
  if (results.some((result) => result.status === 'passed')) return 'passed';
  return results.at(-1)?.status || 'unknown';
}

function describePlaywrightCase(title, file) {
  const normalized = title.toLowerCase();
  if (normalized.includes('smoke')) return 'Checks that the configured smoke page loads and renders page content.';
  if (normalized.includes('journey:')) return 'Checks a discovered user journey route renders and visible form controls can be safely exercised.';
  if (normalized.includes('critical journey')) return 'Checks the configured critical end-to-end journey page renders successfully.';
  return 'Checks Playwright browser behavior for ' + title + (file ? ' in ' + file : '') + '.';
}

function flattenPlaywrightSuite(suite, rows = [], parentTitles = []) {
  const suiteTitles = [...parentTitles, suite.title].filter(Boolean);
  for (const spec of suite.specs || []) {
    for (const test of spec.tests || []) {
      const results = test.results || [];
      const title = [...suiteTitles, spec.title].filter(Boolean).join(' > ');
      const status = playwrightStatus(test);
      const durationMs = results.reduce((sum, result) => sum + (result.duration || 0), 0);
      const errors = results
        .flatMap((result) => result.errors || [])
        .map((error) => error.message || error.value || '')
        .filter(Boolean)
        .join('\\n');
      rows.push({
        tool: 'playwright',
        suite: suiteTitles.join(' > '),
        file: spec.file || '',
        project: test.projectName || '',
        title,
        description: describePlaywrightCase(title, spec.file || ''),
        status,
        durationMs,
        retries: Math.max(0, results.length - 1),
        errors,
      });
    }
  }
  for (const child of suite.suites || []) flattenPlaywrightSuite(child, rows, suiteTitles);
  return rows;
}

function addPlaywright(report, rows, testCases) {
  if (!report) return;
  const cases = (report.suites || []).flatMap((suite) => flattenPlaywrightSuite(suite));
  testCases.push(...cases);
  const passed = cases.filter((test) => test.status === 'passed').length;
  const failed = cases.filter((test) => test.status === 'failed').length;
  const skipped = cases.filter((test) => test.status === 'skipped').length;
  rows.push({ tool: 'playwright', status: failed ? 'failed' : 'passed', total: cases.length, passed, failed, skipped, coverage: '', source: 'playwright-report/results.json' });
}

function addVitest(report, rows) {
  if (!report) return;
  const total = report.numTotalTests ?? report.totalTests ?? 0;
  const passed = report.numPassedTests ?? report.passedTests ?? 0;
  const failed = report.numFailedTests ?? report.failedTests ?? 0;
  const skipped = report.numPendingTests ?? report.numTodoTests ?? report.skippedTests ?? 0;
  rows.push({ tool: 'vitest', status: failed ? 'failed' : 'passed', total, passed, failed, skipped, coverage: '', source: 'qa-results/vitest.json' });
}

function addNewman(report, rows) {
  if (!report) return;
  const assertions = report.run?.stats?.assertions || {};
  rows.push({
    tool: 'postman',
    status: assertions.failed ? 'failed' : 'passed',
    total: assertions.total || 0,
    passed: (assertions.total || 0) - (assertions.failed || 0),
    failed: assertions.failed || 0,
    skipped: assertions.pending || 0,
    coverage: '',
    source: 'qa-results/newman.json',
  });
}

function addK6(report, rows) {
  if (!report) return;
  const checks = report.metrics?.checks?.values || {};
  const passed = checks.passes || 0;
  const failed = checks.fails || 0;
  rows.push({ tool: 'k6', status: failed ? 'failed' : 'passed', total: passed + failed, passed, failed, skipped: 0, coverage: '', source: 'qa-results/k6-summary.json' });
}

function addGrype(report, rows) {
  if (!report) return;
  const total = Array.isArray(report.matches) ? report.matches.length : 0;
  rows.push({ tool: 'grype', status: total ? 'failed' : 'passed', total, passed: 0, failed: total, skipped: 0, coverage: '', source: 'qa-results/grype.json' });
}

const rows = [];
const testCases = [];
addPlaywright(readJson('playwright-report/results.json'), rows, testCases);
addVitest(readJson('qa-results/vitest.json'), rows);
addNewman(readJson('qa-results/newman.json'), rows);
addK6(readJson('qa-results/k6-summary.json'), rows);
addGrype(readJson('qa-results/grype.json'), rows);

const lcov = summarizeLcov();
if (lcov) {
  rows.push({ tool: 'coverage', status: 'reported', total: '', passed: '', failed: '', skipped: '', coverage: 'lines ' + lcov.lines + '%, functions ' + lcov.functions + '%, branches ' + lcov.branches + '%', source: 'coverage/lcov.info' });
}

const summary = rows.reduce((acc, item) => {
  acc.total += Number(item.total) || 0;
  acc.passed += Number(item.passed) || 0;
  acc.failed += Number(item.failed) || 0;
  acc.skipped += Number(item.skipped) || 0;
  if (item.status === 'failed') acc.status = 'failed';
  return acc;
}, { status: 'passed', total: 0, passed: 0, failed: 0, skipped: 0 });

const report = { generatedAt: new Date().toISOString(), summary, rows, testCases };
writeFileSync(path.join(outDir, 'qa-report.json'), JSON.stringify(report, null, 2) + '\\n');

const workbook = '<?xml version="1.0"?>\\n<?mso-application progid="Excel.Sheet"?>\\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
  worksheet('Summary', [
    row(['Metric', 'Value']),
    row(['Status', summary.status]),
    row(['Total checks', summary.total]),
    row(['Passed', summary.passed]),
    row(['Failed', summary.failed]),
    row(['Skipped', summary.skipped]),
    row(['Generated at', report.generatedAt]),
  ]) +
  worksheet('Tools', [
    row(['Tool', 'Status', 'Total', 'Passed', 'Failed', 'Skipped', 'Coverage', 'Source']),
    ...rows.map((item) => row([item.tool, item.status, item.total, item.passed, item.failed, item.skipped, item.coverage, item.source])),
  ]) +
  worksheet('Test Cases', [
    row(['Tool', 'Suite', 'File', 'Project', 'Test Case', 'Description', 'Status', 'Duration ms', 'Retries', 'Errors']),
    ...testCases.map((item) => row([item.tool, item.suite, item.file, item.project, item.title, item.description, item.status, item.durationMs, item.retries, item.errors])),
  ]) +
  '</Workbook>\\n';
writeFileSync(path.join(outDir, 'qa-report.xls'), workbook);

console.log(JSON.stringify({ output: ['qa-results/qa-report.json', 'qa-results/qa-report.xls'], summary }, null, 2));
`;

function hasScript(pkg, name) {
  return Boolean(pkg?.scripts?.[name]);
}

function addScript(scripts, name, command) {
  if (!scripts[name]) scripts[name] = command;
}

function addDevDependency(devDependencies, name, version) {
  if (!devDependencies[name]) devDependencies[name] = version;
}

export function generateAssets(scan, plan) {
  const pkg = scan.packageJson ? structuredClone(scan.packageJson) : { scripts: {} };
  pkg.scripts = pkg.scripts || {};
  pkg.devDependencies = pkg.devDependencies || {};

  const files = [];
  const deps = pkg.devDependencies;
  const qaOrder = plan.recommendedOrder.filter((script) => script !== "qa:all" && script !== "qa:report");

  addScript(pkg.scripts, "qa:prepare", "node -e \"require('fs').mkdirSync('qa-results',{recursive:true})\"");

  if (plan.stack.hasFrontend) {
    const journeys = discoverUserJourneys(scan.files);
    addScript(pkg.scripts, "qa:smoke", "playwright test tests/smoke");
    addScript(pkg.scripts, "qa:e2e", "playwright test tests/e2e");
    addScript(pkg.scripts, "qa:journeys", "playwright test tests/e2e/user-journeys.spec.ts");
    addDevDependency(deps, "@playwright/test", "^1.56.1");
    if (!scan.facts.hasPlaywrightConfig) files.push({ path: "playwright.config.ts", content: PLAYWRIGHT_CONFIG });
    files.push({ path: "tests/smoke/qa-smoke.spec.ts", content: PLAYWRIGHT_SMOKE });
    files.push({ path: "tests/e2e/critical-journey.spec.ts", content: PLAYWRIGHT_E2E });
    files.push({ path: "tests/e2e/user-journeys.spec.ts", content: createPlaywrightJourneySpec(journeys) });
  }

  if (!hasScript(pkg, "qa:unit")) {
    addScript(pkg.scripts, "qa:unit", "npm run qa:prepare && vitest run --coverage --reporter=json --outputFile=qa-results/vitest.json");
  }
  addDevDependency(deps, "vitest", "^4.1.5");
  addDevDependency(deps, "@vitest/coverage-v8", "^4.1.5");
  files.push({ path: "tests/unit/qa-baseline.test.js", content: VITEST });
  files.push({ path: "tests/unit/qa-generated-regression.test.js", content: createGeneratedUnitTests(discoverUnitTestTargets(scan)) });

  addScript(pkg.scripts, "qa:quality", "sonar-scanner");
  files.push({ path: "sonar-project.properties", content: SONAR });

  if (plan.stack.hasApi) {
    addScript(pkg.scripts, "qa:api", "npm run qa:prepare && newman run postman/qa-collection.json -e postman/qa-env.json --reporters cli,json --reporter-json-export qa-results/newman.json");
    addScript(pkg.scripts, "qa:perf", "npm run qa:prepare && k6 run --summary-export qa-results/k6-summary.json tests/performance/load.js");
    addDevDependency(deps, "newman", "^6.2.1");
    files.push({ path: "postman/qa-collection.json", content: POSTMAN });
    files.push({ path: "postman/qa-env.json", content: POSTMAN_ENV });
    files.push({ path: "tests/performance/load.js", content: K6 });
  }

  addScript(pkg.scripts, "qa:security", "npm run qa:prepare && grype . -o json > qa-results/grype.json");
  addScript(pkg.scripts, "qa:report", "node scripts/qa-report.mjs");

  if (qaOrder.some((script) => pkg.scripts[script])) addScript(pkg.scripts, "qa:all", "node scripts/qa-run-all.mjs");

  files.push({ path: "scripts/qa-run-all.mjs", content: createQaRunAll(qaOrder) });
  files.push({ path: "scripts/qa-report.mjs", content: QA_REPORT });
  files.push({ path: "qa-plan.json", content: `${JSON.stringify(plan, null, 2)}\n` });

  return {
    packageJson: `${JSON.stringify(pkg, null, 2)}\n`,
    files,
  };
}

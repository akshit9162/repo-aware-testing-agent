import { discoverUserJourneys } from "./journeys.js";

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
    addScript(pkg.scripts, "qa:unit", "vitest run");
  }
  addDevDependency(deps, "vitest", "^4.1.5");
  files.push({ path: "tests/unit/qa-baseline.test.js", content: VITEST });

  addScript(pkg.scripts, "qa:quality", "sonar-scanner");
  files.push({ path: "sonar-project.properties", content: SONAR });

  if (plan.stack.hasApi) {
    addScript(pkg.scripts, "qa:api", "newman run postman/qa-collection.json -e postman/qa-env.json");
    addScript(pkg.scripts, "qa:perf", "k6 run tests/performance/load.js");
    addDevDependency(deps, "newman", "^6.2.1");
    files.push({ path: "postman/qa-collection.json", content: POSTMAN });
    files.push({ path: "postman/qa-env.json", content: POSTMAN_ENV });
    files.push({ path: "tests/performance/load.js", content: K6 });
  }

  addScript(pkg.scripts, "qa:security", "grype .");

  const qaAll = plan.recommendedOrder.filter((script) => pkg.scripts[script]).map((script) => `npm run ${script}`).join(" && ");
  if (qaAll) addScript(pkg.scripts, "qa:all", qaAll);

  files.push({ path: "qa-plan.json", content: `${JSON.stringify(plan, null, 2)}\n` });

  return {
    packageJson: `${JSON.stringify(pkg, null, 2)}\n`,
    files,
  };
}

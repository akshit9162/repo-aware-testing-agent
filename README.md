# Repo-Aware Testing Agent

A standalone QA automation agent that scans a repository and generates a customized testing workflow for:

- Playwright
- Vitest
- SonarQube
- Postman/Newman
- Grype
- k6

It inspects the target repo, builds a risk-aware test plan, then optionally writes starter configs, test files, Postman collections, k6 scripts, and `package.json` QA scripts.

## Usage

Preview a plan without writing files:

```sh
node src/cli.js /path/to/repo
```

Write the generated QA workflow into the target repo:

```sh
node src/cli.js /path/to/repo --write
```

Choose an output plan path:

```sh
node src/cli.js /path/to/repo --plan qa-plan.json
```

Generate an Excel-compatible Playwright report workbook:

```sh
node src/cli.js coverage-excel /path/to/playwright-report/results.json --out playwright-coverage.xls
```

The workbook includes a Summary sheet and a Tests sheet with project, file, test title, status, duration, retries, and errors.

## Generated Scripts

Depending on the repo, the agent can add:

```json
{
  "qa:smoke": "playwright test tests/smoke",
  "qa:journeys": "playwright test tests/e2e/user-journeys.spec.ts",
  "qa:e2e": "playwright test tests/e2e",
  "qa:unit": "vitest run",
  "qa:api": "newman run postman/qa-collection.json",
  "qa:security": "grype .",
  "qa:quality": "sonar-scanner",
  "qa:perf": "k6 run tests/performance/load.js",
  "qa:all": "npm run qa:unit && npm run qa:e2e && npm run qa:api && npm run qa:security && npm run qa:perf"
}
```

## Philosophy

The agent does not assume one universal QA setup. It detects the repo shape, then creates a practical starter workflow that can be hardened by project teams.

Generated tests are intentionally configurable through environment variables such as:

- `QA_BASE_URL`
- `QA_SMOKE_PATH`
- `QA_ROUTE_HOME`
- `QA_ROUTE_<ROUTE_NAME>`
- `QA_API_BASE_URL`
- `QA_K6_URL`

For frontend repos, the agent discovers likely user journeys from common route files such as `app/**/page.tsx`, `pages/**/*.tsx`, `src/pages/**/*.tsx`, and `src/routes/**/*.tsx`. It generates `tests/e2e/user-journeys.spec.ts` with one Playwright test per route and safe form-control interaction coverage. Dynamic routes use sample placeholders and can be overridden with the generated `QA_ROUTE_*` environment variables.

# Repo-Aware Testing Agent

> **New to this?** See [WALKTHROUGH.md](./WALKTHROUGH.md) for a clone-and-run guide that gets you from a fresh repo to a QA report in under 10 minutes.

A standalone QA automation agent that scans a repository and generates a customized testing workflow for:

- Playwright
- Vitest
- SonarQube
- Postman/Newman
- Trivy (CVE / dependency / container)
- k6
- axe-core (accessibility, via @axe-core/playwright)
- gitleaks (secret scanning)
- Semgrep (SAST)
- Visual regression (Playwright `toHaveScreenshot()` baselines)

It inspects the target repo, builds a risk-aware test plan, then optionally writes starter configs, test files, Postman collections, k6 scripts, and `package.json` QA scripts.

The product direction is captured in
[docs/BEST_IN_MARKET_ROADMAP.md](./docs/BEST_IN_MARKET_ROADMAP.md): the goal is
not generic code assistance, but a QA-native loop that turns reproducible
failures into reviewed, validated source fixes.

Unit tests are generated from the repo scan. The agent creates a baseline Vitest harness plus a repo-specific regression manifest that checks detected package scripts, source files, UI routes, API files, component files, config files, and environment contract files.

API tests are generated from detected API route files such as `pages/api/**`, `app/api/**/route.ts`, and `src/routes/**`. The Postman collection validates server-error status, response time, and JSON parseability when JSON is advertised. SonarQube configuration is generated from detected source/test folders with LCOV coverage and common build/report exclusions.

Security and performance checks are also generated from the scan. The agent writes `.trivyignore` and a `qa:security` script that exports `qa-results/trivy.json`; severity gating is applied by `scripts/qa-run-all.mjs` via `--fail-on` (default `high`). For API repos, it generates a k6 script that load-tests each discovered endpoint with response-time and success-rate thresholds.

Requires `trivy` on PATH (`brew install trivy` on macOS; see https://trivy.dev/ for other platforms).

## LLM journey enrichment (required when Playwright is enabled)

Whenever the agent scaffolds the Playwright stage, it calls Claude or
GPT once per discovered route to identify the most important stable
elements on each page (headings, CTAs, links, images) and embeds
route-specific Playwright assertions into
`tests/e2e/user-journeys.spec.ts`. `ANTHROPIC_API_KEY` (preferred) or
`OPENAI_API_KEY` must be set before running the agent on any repo where
the Playwright stage is in the plan — the agent aborts with a clear
error otherwise.

Provider selection:

- Anthropic is preferred when both keys are set. Force one with
  `QA_LLM_PROVIDER=anthropic` or `QA_LLM_PROVIDER=openai`.
- Default models: `claude-sonnet-4-6` (Anthropic) /
  `gpt-4o-mini` (OpenAI). Override either with `QA_LLM_MODEL` (e.g.
  `QA_LLM_MODEL=claude-opus-4-8` for maximum precision, or
  `QA_LLM_MODEL=claude-haiku-4-5-20251001` to optimize for cost/latency).
- `@anthropic-ai/sdk` and `openai` are declared as hard dependencies of
  the agent and installed by `npm install` in the agent dir. No soft
  fallback path.
- Keys can live in `.env` (or `.env.local`) at the target repo root;
  the agent auto-loads them on startup. Real shell exports always
  override the file.

Behaviour:

- Reads each route's page component (`app/**/page.tsx`, `pages/**/*.tsx`,
  `src/(pages|routes)/**`), sends source + route to the LLM with a
  structured-output JSON schema, and only embeds findings it can
  identify confidently.
- **Live-DOM mode:** pass `--crawl-url <baseUrl>` to the main command and
  the agent crawls the live deployment, merges discovered routes with the
  static scan, and sends the *rendered HTML* (not source) to the LLM.
  Assertions match what users actually see post-hydration: real text from
  CMS slugs, feature-flagged content, and conditionally-rendered CTAs.
  Cache keys are scoped per content kind so the source cache and the
  rendered-html cache don't collide.
- Concurrency capped at 5 in-flight requests; retries with exponential
  backoff + jitter on 429/5xx (honors `Retry-After`).
- Per-route results cached in `.qa-agent-cache/llm-enrich/` keyed by
  hash(route + source). Subsequent runs hit cache until the page
  component changes.
- Failures on a single route fall back to the skeleton path for that
  route without aborting other routes; the first error surfaces in
  `enrichment.stats.firstError`.

The CLI output reports an `enrichment` block:

```json
"enrichment": {
  "enabled": true,
  "stats": {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "requested": 28,
    "cached": 21,
    "succeeded": 49,
    "failed": 0,
    "skipped": 0
  }
}
```

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

Generate route-specific assertions from the live DOM (one command):

```sh
ANTHROPIC_API_KEY=sk-ant-... \
  node src/cli.js /path/to/repo --crawl-url https://staging.example.com --write
```

Crawls the staging deployment, merges discovered routes with the static
scan, sends the rendered HTML for each new route to Claude, and writes
`tests/e2e/user-journeys.spec.ts` with DOM-aware assertions. Routes that
the static scan found keep their source-based enrichment (cache key
differs between source and HTML modes, so prior work isn't lost).

Discover routes only (no generation, useful for ad-hoc inspection):

```sh
node src/cli.js crawl https://example.com --depth 2 --max 50 --out crawled.json
```

Each entry is a `{ path, title, source: 'crawl', dynamic, foundOn }` record
compatible with the journeys pipeline. Use it to catch dynamic routes the
static scan misses (CMS slugs, feature-flagged pages, redirects). The crawler
uses plain HTTP fetch — SPAs that surface routes only after client-side
hydration won't be fully covered.

Repair LLM-augmented journey assertions after the app's markup changes:

```sh
ANTHROPIC_API_KEY=sk-ant-... \
  node src/cli.js repair playwright-report/journeys.json \
    --base-url https://staging.example.com --repo /path/to/your/repo --apply
```

Parses the Playwright results.json, finds tests that failed with locator
errors, re-fetches the live DOM for each affected route, asks the LLM for
fresh assertions, and (with `--apply`) surgically replaces the `ENRICHED`
block in `tests/e2e/user-journeys.spec.ts`. Without `--apply`, only the
`.qa-agent-cache/llm-enrich/` cache is updated and the next `repo-qa-agent
<repo> --write` picks up the new assertions.

Run the coding fix agent on QA failures:

```sh
node src/cli.js index /path/to/your/repo --query "checkout submit button"

ANTHROPIC_API_KEY=sk-ant-... \
  node src/cli.js fix qa-results/qa-report.json --repo /path/to/your/repo --out qa-results/fix-report.json

ANTHROPIC_API_KEY=sk-ant-... \
  node src/cli.js fix qa-results/qa-report.json --repo /path/to/your/repo --apply --validate \
    --worktree --bundle-out qa-results/fix-bundle.json --pr-out qa-results/fix-pr.md
```

`index` builds `.qa-agent-cache/repo-index.json`, a repo intelligence cache with
lexical tokens, exported symbols, route hints, imports, selector hints, API/env
dependencies, and monorepo package boundaries. Add `--use-embeddings` to include
OpenAI embeddings in the cache when `OPENAI_API_KEY` is available.

`fix` parses Playwright/QA JSON failures, retrieves likely source files, asks
the LLM for minimal exact before/after replacements, and applies them only when
`--apply` is set. Without an API key it still emits a triage report with likely
files. Add `--use-embeddings` to rerank candidates with OpenAI embeddings when
`OPENAI_API_KEY` is available; otherwise the retriever uses fast lexical scoring.
When `.qa-agent-cache/repo-index.json` exists, `fix` loads it automatically;
use `--index <path>` to point at a specific cache or `--rebuild-index` to ignore
the cache and rebuild in memory. Retrieval combines lexical, semantic, selector,
route, and stack-trace signals. Add `--bundle-out` for a machine-readable patch
bundle with rollback replacements and `--pr-out` for a review-ready PR body.
Add `--worktree` to run the patch and validation loop in a disposable git
worktree so the original checkout stays untouched; use `--keep-worktree` when
you want to inspect the patched worktree after the run.

Import a HAR file (Chrome DevTools → Network → save as HAR) into a Postman
collection:

```sh
node src/cli.js har session.har --out postman/qa-collection.json
node src/cli.js har session.har --replace --filter-origin https://api.example.com
```

Default merges into the existing collection, deduping by `method + URL`.
`--replace` discards prior entries; `--filter-origin` keeps only requests
to the named origin (useful for excluding third-party tracking calls).

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
  "qa:a11y": "playwright test tests/a11y/qa-a11y.spec.ts",
  "qa:visual": "playwright test tests/visual/qa-visual.spec.ts",
  "qa:visual:update": "playwright test tests/visual --update-snapshots",
  "qa:unit": "vitest run tests/unit",
  "qa:api": "newman run postman/qa-collection.json",
  "qa:security": "trivy fs --format json --output qa-results/trivy.json .",
  "qa:secrets": "gitleaks detect --report-format json --report-path qa-results/gitleaks.json --no-git",
  "qa:sast": "semgrep --config auto --json --output qa-results/semgrep.json --quiet .",
  "qa:quality": "sonar-scanner",
  "qa:perf": "k6 run tests/performance/load.js",
  "qa:report": "node scripts/qa-report.mjs",
  "qa:all": "node scripts/qa-run-all.mjs"
}
```

External CLI prerequisites (install once, per machine):

- `brew install trivy` — vulnerability scanner
- `brew install gitleaks` — secret scanner
- `brew install semgrep` — static analysis
- `brew install k6` — load testing
- `brew install sonar-scanner` — Sonar client (only needed if `SONAR_HOST_URL` is set)

The Playwright/Newman/Vitest/axe-core packages are installed automatically as devDependencies when you `npm install`. For the a11y stage specifically, ensure both `@axe-core/playwright` and `axe-core` are present (the agent adds them when the axe stage is enabled).

`qa:all` runs the generated QA stages in order and then writes a consolidated report even if one of the test stages fails. The report outputs:

- `qa-results/qa-report.json`
- `qa-results/qa-report.xls`

The consolidated report summarizes available Vitest, Playwright, Postman/Newman, Grype, k6, and LCOV coverage artifacts. For Playwright, it also includes individual test-case descriptions, pass/fail status, file/project, duration, retries, and errors in the JSON report and the Excel `Test Cases` sheet.

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

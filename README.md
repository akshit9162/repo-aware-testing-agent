# Repo-Aware Testing Agent

> **Have an Excel of test cases, a UAT URL, and a working repo?** Read **[docs/BUILD_PIPELINE.md](./docs/BUILD_PIPELINE.md)** — one command turns those three inputs into a passing Playwright suite in your repo.
>
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

## What the agent discovers (no human glue)

The discovery pipeline is layered. Each layer is best-effort; failures fall through silently.

| Layer | Source | Frameworks |
|-------|--------|------------|
| File-based routing | filesystem layout | Next.js App Router (`app/**/page.tsx`), Next.js Pages Router, `src/{pages,routes}/**`, **SvelteKit** (`+page.svelte`, `[slug]`, `(group)`, `[[opt]]`), **Remix** (`_index`, `$param`, dotted nesting), **Astro** (`[slug].astro`, `[...rest].astro`) |
| JSX route declarations | parsed from `.jsx`/`.tsx`/`.js`/`.ts` | **React Router** (`<Route path="..." element={<X/>}/>`, `<PublicRoute>`, `<PrivateRoute>`, custom wrappers). Uses a JSX-expression-balanced tokenizer so attributes containing `element={<X/>}` parse correctly. **Nested routes inherit parent paths** — `<Route path="/:lang?"><Route path="dashboard"/></Route>` becomes `/:lang?/dashboard`. Catch-all `*` routes are filtered. |
| Config-based routing | parsed from router config files | **Vue Router** (`src/router/**` with `routes: [{ path, component }]` and inline `() => import('./X.vue')`) |
| Backend HTTP routes | `app.get('/...')` / `router.post('/...')` | Express, Fastify, Koa, and generic helpers (`apiClient.delete('/...')`); flips `hasApi=true` and feeds Postman + k6 |
| Frontend-observed API calls | axios / fetch / `apiClient.*` inside page components | Aggregated per journey + into the shared endpoint list |
| Form fields | per page component | MUI (`<TextField>`, `<Select>`, `<Autocomplete>`, `<DatePicker>`, etc.), plain HTML (`<input>`, `<select>`, `<textarea>`), React Hook Form (`register('name', { required, minLength, pattern, ... })`) |
| Funnel clustering | groups journeys by URL prefix | Tags each route with a stage (`entry → info → options → addons → details → docs → summary → payment → success/failure`) and emits `tests/helpers/<cluster>-walker.ts` with a `walkTo(stageId)` helper |
| Live crawl (optional) | `--crawl-url <baseUrl>` | BFS over the deployed site; merges discovered routes with the static scan and uses captured HTML as the LLM enrichment input |
| Fixture overrides | `qa-fixtures.json` in the target repo | Maps discovered routes to canonical paths |

Dynamic param substitution applies known defaults (`:lang` → `en`, `:insuranceType` → `motor-insurance`, `:channel` → `main`, `:slug` → `sample`, `:id` → `1`, etc.) and collapses optional params (`:lang?`) to their canonical form. Per-route overrides flow through env vars (`QA_ROUTE_*`) or the generated `tests/fixtures/qa-uat.local.json` (see below).

The product direction is captured in
[docs/BEST_IN_MARKET_ROADMAP.md](./docs/BEST_IN_MARKET_ROADMAP.md): the goal is
not generic code assistance, but a QA-native loop that turns reproducible
failures into reviewed, validated source fixes.

Unit tests are generated from the repo scan. The agent creates a baseline Vitest harness plus a repo-specific regression manifest that checks detected package scripts, source files, UI routes, API files, component files, config files, and environment contract files.

API tests are generated from detected API route files such as `pages/api/**`, `app/api/**/route.ts`, and `src/routes/**`. The Postman collection validates server-error status, response time, and JSON parseability when JSON is advertised. SonarQube configuration is generated from detected source/test folders with LCOV coverage and common build/report exclusions.

Security and performance checks are also generated from the scan. The agent writes `.trivyignore` and a `qa:security` script that exports `qa-results/trivy.json`; severity gating is applied by `scripts/qa-run-all.mjs` via `--fail-on` (default `high`). For API repos, it generates a k6 script that load-tests each discovered endpoint with response-time and success-rate thresholds.

Requires `trivy` on PATH (`brew install trivy` on macOS; see https://trivy.dev/ for other platforms).

## Generated test infrastructure

When the Playwright stage is enabled, the agent emits more than just per-route specs:

### Per-route assertions
- `tests/e2e/user-journeys.spec.ts` — one Playwright test per discovered route, each with LLM-derived assertions (heading text, primary CTAs, link/button labels, image presence). Tests `goto(urlFor(journey.path))` so they automatically pick up `QA_BASE_URL` and fixture-supplied param values.

### Fixture system
When discovered journeys signal that a real-world walk needs values the agent can't conjure (route params, auth credentials, file uploads), the agent emits:

- `tests/fixtures/qa-uat.local.json.example` — a gitignored scaffold with `routeParams`, `auth`, and `upload` slots ready to fill.
- `tests/helpers/journey-fixture.ts` — exports `FIXTURE`, `HAS_REAL_FIXTURE`, `baseUrl()`, `substituteParams()`, `urlFor()` so specs and walkers consume the fixture uniformly.

The committed `.example` is safe to share; the `.local.json` variant (real values) stays gitignored.

### Multi-stage walker helpers
When a cluster has ≥3 staged members covering ≥2 distinct stage tags, the agent emits `tests/helpers/<cluster>-walker.ts` with:

```ts
export const STAGES = [ /* ordered by funnel keyword */ ] as const;
export type StageId = (typeof STAGES)[number]["id"];
export async function walkTo(page: Page, target: StageId): Promise<void> { /* ... */ }
```

The default walker progresses by clicking the first visible button matching `PROCEED`, `Continue`, `Submit`, `Next`, or `BUY NOW` — a sane default for SPA forms. Override per-stage behavior in `tests/helpers/walker-overrides.ts` (or copy the walker into your repo and edit directly).

### Richer LLM prompts
Form fields and outbound API calls detected per page are appended to the LLM prompt as extra context. The model can then suggest:

- "Required: First Name (3–15 letters) — assert the inline validation message"
- "After click, POST `/api/quote` fires — assert the loading state"
- "Premium amount in `<TextField>` with name `premium` — assert it recalculates on add-on toggle"

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

Generate Playwright specs + Postman collection from an Excel of user stories:

```sh
# Preview only — does not write into the repo
node src/cli.js stories /path/to/stories.xlsx --repo /path/to/your/repo

# Commit both the spec and the Postman collection
ANTHROPIC_API_KEY=sk-ant-... \
  node src/cli.js stories /path/to/stories.xlsx --repo /path/to/your/repo --write

# Force a specific sheet (skip auto-detection)
node src/cli.js stories stories.xlsx --story-sheet "Sprint 24 Backlog" --apis-sheet "REST endpoints"
```

The agent reads the file (`.xlsx` / `.xls` / `.csv` / `.tsv` / `.json`), auto-detects the user-story sheet (any of `User Stories`, `Stories`, `Backlog`, `Requirements`, `Features`, `Epics` — also matched as substrings) and the API sheet (`APIs`, `API Spec`, `Endpoints`, `REST`, `GraphQL`). Falls back to the first sheet when no name matches.

**Column auto-detection** normalizes common variants:

- **Stories:** `ID` / `Story ID` / `Jira ID` / `Issue ID` · `Title` / `Summary` / `Story Title` · `As a` / `Role` / `Persona` · `I want` / `Goal` · `So that` / `Benefit` · `Acceptance Criteria` / `AC` / `Definition of Done` · `Priority` · `Status` · `Tags` / `Labels` / `Epic` · `Story Points` / `Estimate`
- **APIs:** `Method` / `HTTP Verb` · `Path` / `URL` / `Endpoint` · `Description` · `Auth` / `Authentication` · `Request` / `Sample Request` / `Body` · `Response` / `Expected` · `Expected Status` · `Content-Type`

**Stories skipped automatically** when status is `Done`, `Closed`, `Completed`, `Won't Do`, `Cancelled`, `Archived`, or `Deprecated`.

**Test generation has two modes:**

- *Skeleton mode* (no API key): one `describe(...)` per story with the As-a / I-want / So-that summary and acceptance criteria as comments, plus discovered routes from the target repo's static scan, plus a `TODO` body. Cheap, deterministic, no LLM cost.
- *LLM-enriched mode* (`ANTHROPIC_API_KEY` or `OPENAI_API_KEY` set): the model returns a structured JSON test plan grounded in the story + the agent's already-discovered routes / forms. Each step compiles to a concrete Playwright call (`page.goto(urlFor(...))`, `getByLabel(...).fill(...)`, `getByRole('button', {name: ...}).click()`, URL/text/role assertions). Cached per story+route fingerprint under `.qa-agent-cache/llm-stories/`.

**API collection generation** turns each API row into a Postman v2.1 item with:
- Method + URL (relative paths use `{{apiHost}}` variable; absolute URLs preserved)
- Auth header when the `Auth` column is truthy (`Bearer {{authToken}}`)
- JSON body when the `Request` column parses as JSON
- Status-code assertion (uses `Expected Status` column or defaults per method: GET→200, POST→201, DELETE→204, …)
- JSON-shape assertion when Content-Type implies JSON; per-key existence asserts when a sample response is provided

Writes to `tests/e2e/user-stories.spec.ts` and `postman/stories-collection.json` by default; override with `--out` and `--postman-out`.

Walk one or more UAT URLs autonomously and record an end-to-end journey:

```sh
# Single entry URL — walker progresses until it can't
node src/cli.js walk https://uat.example.com/checkout \
  --fixture tests/fixtures/qa-uat.local.json \
  --repo /path/to/your/repo \
  --write-spec

# Multiple URLs — each gets its own independent walk + trace
node src/cli.js walk \
  --urls https://uat.example.com/checkout,https://uat.example.com/onboarding \
  --fixture tests/fixtures/qa-uat.local.json \
  --max-steps 12 --headed

# Stop when the walker hits a known terminal URL
node src/cli.js walk https://uat.example.com/start \
  --fixture x.json --stop-when "/(thank-you|success|done)$"
```

For each entry URL the agent launches a real (Playwright/Chromium) browser, navigates to the URL, then loops up to `--max-steps` (default 10) times: it snapshots the page, fills any form field whose label/name/placeholder matches a `formFills` key in the fixture, clicks the highest-priority CTA from `PROCEED → Continue → Submit → Next → BUY NOW → Confirm → Save → Pay` (configurable via `--cta`), and records the URL transition. It halts on captchas, on OTP screens when `fixture.auth.otpBypass` isn't set, when no CTA is found, when the URL stops changing, or when `--stop-when <regex>` matches.

Output:

- `qa-results/walked-journey-<slug>.json` per URL — full trace (entry, every stage's URL/title/snapshot/filled fields/clicked CTA/transition, plus `terminationReason` + `terminalUrl`).
- With `--write-spec`, also `tests/e2e/walked-journey-<slug>.spec.ts` — a Playwright spec that reproduces the walk (navigate → fill → click → assert URL) so you can pin the journey as a regression test.

Fixture shape (gitignored; the agent's `--write` step emits a `.example` scaffold):

```json
{
  "uatUrl": "https://uat.example.com",
  "routeParams": { "lang": "en", "channel": "main" },
  "auth": { "otpBypass": "0000" },
  "formFills": {
    "First Name": "TESTQA",
    "Last Name": "AUTOMATION",
    "Customer mail ID": "qa-automation@example.com",
    "Mobile Number": "95888238",
    "Plate Code": "M",
    "Plate Number": "92588"
  },
  "upload": { "slots": { "documentFront": "tests/fixtures/sample-document.jpg" } }
}
```

Requires Chromium installed once per machine: `npx playwright install chromium`.

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

For frontend repos, the agent discovers user journeys from:

- File-based conventions: Next.js App Router (`app/**/page.tsx`), Next.js Pages Router, SvelteKit (`src/routes/**/+page.svelte`), Remix (`app/routes/**`), Astro (`src/pages/**.astro`), plain `src/pages/**` / `src/routes/**`.
- JSX-declared routes: React Router (`<Route>`, `<PublicRoute>`, `<PrivateRoute>`, custom wrappers) — parsed by a stack-based, JSX-expression-balanced tokenizer that respects nested `<Route>` inheritance.
- Config-declared routes: Vue Router (`{ path, component }` configs in `src/router/**`).
- Optional live-crawl augmentation via `--crawl-url`.

It generates `tests/e2e/user-journeys.spec.ts` with one Playwright test per route, plus `tests/a11y/qa-a11y.spec.ts` and `tests/visual/qa-visual.spec.ts` looping over the same route set. Per-page form fields and outbound API calls are detected and fed to the LLM as extra context, so the resulting assertions know about required-field validation and the API surface the page hits.

For repos whose discovered routes look like a funnel (motor insurance, e-commerce checkout, multi-step onboarding), the agent additionally emits one or more `tests/helpers/<cluster>-walker.ts` files with a `walkTo(stageId)` helper that progresses through the cluster's stages. This saves the manual wiring usually needed to chain "form → confirmation → quotes → details → docs → summary → payment" tests.

Dynamic routes use sample placeholders by default and can be overridden via:

1. The generated `tests/fixtures/qa-uat.local.json` (gitignored, copied from the emitted `.example`).
2. Per-route env vars: `QA_ROUTE_HOME`, `QA_ROUTE_<NAME>`, plus the global `QA_BASE_URL`.
3. `qa-fixtures.json` at the target repo root for route-pattern overrides.

## What v0.5 added (July 2026) — the "one-command" pipeline

- **`build` subcommand.** Single command runs the whole pipeline: scan repo → load DOM snapshots → LLM-generate tests → run against UAT → heal failures → write report. Designed so an inexperienced user just provides `--repo`, `--excel`, `--snapshots`, `--base-url`. See [docs/BUILD_PIPELINE.md](./docs/BUILD_PIPELINE.md).
- **`record` subcommand.** Opens headed Playwright, human clicks through the flow once, agent captures rich DOM snapshots per page. Ten minutes of human time buys DOM ground truth the LLM uses forever. Sidesteps OTP / captcha / MUI-clickable-div issues that stall autonomous walkers.
- **DOM-anchored enrichment.** Rewrote the LLM prompt in `storiesToTests.js`. When a live DOM snapshot exists for the target route, the LLM uses ONLY labels + button names from that snapshot — no more Excel-text-guessed selectors. This is what turns pass rates from ~2% to ~60-85%.
- **`heal-stories` subcommand.** After a Playwright run, feeds each failing test's error + the target page's live DOM back to the LLM. LLM returns either a corrected assertion (patched in place) or classifies the failure as a real app bug (written to `qa-results/bug-candidates.md`). Cached per (test-source-hash, error) so re-runs are cheap.
- **Fixture schema documentation.** [docs/FIXTURE_SCHEMA.md](./docs/FIXTURE_SCHEMA.md) — one JSON file per repo, gitignored, drives auth / route params / form fills / uploads / pre-action clicks.
- New modules: `src/recorder.js`, `src/healStories.js`, `src/buildPipeline.js`.

## What the upgrade in v0.4 added (June 2026)

- **User-story Excel → test generator** via the new `stories` subcommand. Reads `.xlsx` / `.csv` / `.tsv` / `.json`, auto-detects User Stories + APIs sheets, normalizes Jira/Linear/Notion/Azure-DevOps column variants, skips `Done`/`Closed` stories, cross-references the target repo's discovered routes + form fields, and emits one `describe()` per story (LLM-enriched when an API key is present, skeleton TODOs otherwise). API rows become a Postman v2.1 collection with status + JSON-shape assertions.
- New modules `src/storiesImport.js`, `src/storiesToTests.js`, `src/storiesToPostman.js`.
- `xlsx` added as a hard dependency.
- 11 new tests added (86 → 97, all passing).

## What the upgrade in v0.3 added (June 2026)

- **Autonomous UAT walker** via the new `walk` subcommand. Given an entry URL (or `--urls` list), the agent drives a real Playwright/Chromium session through the flow: fills form fields from a fixture, clicks the highest-priority CTA, records every URL transition, and writes a per-URL trace JSON. With `--write-spec` it also generates a Playwright spec that reproduces the walk. Halts cleanly on OTP-without-bypass, captcha, no-CTA, or no-URL-change.
- New module `src/walker.js` with pure-function helpers (`chooseCta`, `matchFieldsToFixture`, `isOtpGate`, `isCaptcha`, `buildSpecFromTrace`) so the decision logic stays testable without a real browser.
- 9 new tests added (77 → 86, all passing). `playwright` added as a hard dependency.

## What the upgrade in v0.2 added (June 2026)

- **React Router JSX route discovery** with nested-route inheritance and JSX-expression-balanced attribute parsing. Closes the long-standing gap where CRA + React Router repos produced a single `/` journey.
- **SvelteKit / Remix / Astro file-based scanners.**
- **Vue Router config scanner.**
- **Backend HTTP route scanner** (Express/Fastify/Koa) that flips `hasApi=true` and seeds Postman/k6 without needing an OpenAPI spec.
- **Per-page form-field discovery** (MUI, plain HTML, React Hook Form).
- **Frontend API-call discovery** (axios, fetch, helper-style clients) aggregated into the Postman/k6 endpoint list.
- **Funnel clustering + walker autogen.** Routes that look like stages of a flow get a per-cluster `walkTo(stageId)` helper for free.
- **Fixture autogen.** A gitignored `qa-uat.local.json.example` + `journey-fixture.ts` helper, emitted whenever discovered routes contain dynamic params, auth pages, or file uploads.
- **Richer LLM prompts.** Form fields + API calls detected per page are appended to the per-route LLM prompt as additional context.

Verified end-to-end against a CRA + React Router insurance app: agent went from generating 1 stub route (`/`) to discovering 98 real routes, annotating 20 with API calls and 6 with form fields, clustering into 2 funnel walkers, and emitting a fully-populated fixture stub.

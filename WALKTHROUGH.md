# Walkthrough — from a fresh repo to a QA report in 10 minutes

This guide takes you from a freshly-cloned JavaScript/TypeScript project to a
runnable, multi-tool QA suite plus a QA-manager-friendly Excel report. No
prior context required.

## What this is

`repo-qa-agent` scans a repository and bootstraps a complete QA harness for
it: Playwright (smoke + journey + e2e + accessibility + visual regression),
Vitest (unit), Postman/Newman (API), k6 (load), Trivy (vulnerabilities),
gitleaks (secrets), Semgrep (SAST), and SonarQube (code quality). The
generated `qa:all` script runs them in three tiers (parallel zero-infra
stages, sequenced needs-app stages behind a managed dev server, env-gated
external-service stages) and writes a consolidated report covering every
result.

It does not run anything against your code at scan time — it generates the
test scaffolding and orchestrator. You run them.

## Prereqs

**Required:**
- Node 18+
- npm (or yarn / pnpm — the agent detects the lockfile)

**External CLI tools** (install only the ones whose stages you care about):

```sh
brew install trivy         # qa:security
brew install gitleaks      # qa:secrets
brew install semgrep       # qa:sast
brew install k6            # qa:perf
brew install sonar-scanner # qa:quality (only if you have SONAR_HOST_URL)
```

On Linux: see each tool's docs. Trivy and gitleaks ship single binaries;
Semgrep needs Python; k6 has its own installer.

**Required when the Playwright stage is enabled** (every repo with a
frontend triggers it):
- `ANTHROPIC_API_KEY` (preferred, default model `claude-sonnet-4-6`), or
- `OPENAI_API_KEY` (default model `gpt-4o-mini`)

The agent uses the key to write per-route assertions into
`tests/e2e/user-journeys.spec.ts`. Without a key, `--write` aborts with a
clear error before any files are touched.

**Where to put keys.** Drop them in a `.env` (or `.env.local`) at the
repo root and the agent loads them automatically:

```
# /path/to/your/repo/.env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-proj-...
```

Add `.env` to `.gitignore` so it doesn't end up in version control. Real
shell exports always take precedence over the file (so CI secrets aren't
shadowed by a stale `.env`).

## Quick start

```sh
# 1. Scaffold the QA suite into your repo
node /path/to/repo-aware-testing-agent/src/cli.js /path/to/your/repo --write

# 2. Install the generated devDependencies — this is required even if your
#    repo already has node_modules. The agent adds Playwright, Vitest,
#    Newman, axe-core, and the coverage plugin to devDependencies and these
#    must be installed before qa:all can run.
cd /path/to/your/repo
npm install

# 3. Run the full pipeline (8–12 minutes for a medium app)
npm run qa:all
```

When `qa:all` finishes, look in `qa-results/`:
- `qa-report.json` — machine-readable
- `qa-report.xls` — open in Excel/Numbers/Sheets (four sheets)
- `qa-stages.json` — orchestrator's per-stage view
- per-tool outputs: `trivy.json`, `gitleaks.json`, `semgrep.json`, `axe/*.json`, `newman.json`, `k6-summary.json`, `vitest.json`

## What got generated

The agent writes the following into your repo on `--write`:

```
your-repo/
├── package.json               # 14–16 qa:* scripts added; devDeps for Playwright/Vitest/Newman/axe-core
├── playwright.config.ts       # only if you didn't already have one
├── sonar-project.properties   # Sonar config
├── .trivyignore               # documented template for suppressing CVEs
├── .gitleaks.toml             # template for allowlisting committed secrets
├── tests/
│   ├── smoke/qa-smoke.spec.ts             # page loads, body non-empty
│   ├── e2e/critical-journey.spec.ts       # placeholder critical journey
│   ├── e2e/user-journeys.spec.ts          # one test per discovered route
│   ├── a11y/qa-a11y.spec.ts               # axe-core per route
│   ├── visual/qa-visual.spec.ts           # Playwright toHaveScreenshot per route
│   ├── unit/qa-baseline.test.js           # Vitest smoke
│   ├── unit/qa-generated-regression.test.js  # repo-specific Vitest manifest
│   └── performance/load.js                # k6 against discovered endpoints
├── postman/
│   ├── qa-collection.json     # one request per discovered API route
│   └── qa-env.json            # baseUrl + per-endpoint env vars
└── scripts/
    ├── qa-run-all.mjs         # three-tier orchestrator
    └── qa-report.mjs          # consolidates all artifacts
```

Re-running the scaffolder is **idempotent**: existing files are diff-checked
and only rewritten when content actually changes. Pass `--force` to overwrite
local edits to generated files.

## Reading the report

After `npm run qa:all`, the consolidated report lives in three forms:

### `qa-results/qa-stages.json` — the orchestrator's view

One entry per stage:

```json
{
  "generatedAt": "2026-06-17T10:23:15Z",
  "failOn": "high",
  "results": [
    { "script": "qa:unit", "tier": "zero-infra", "status": "passed", "durationMs": 5230 },
    { "script": "qa:security", "tier": "zero-infra", "status": "failed",
      "severityCounts": { "critical": 0, "high": 10, "medium": 9, "low": 2 },
      "overThreshold": 10, "reason": "matches at or above high" },
    { "script": "qa:quality", "tier": "external-service", "status": "skipped",
      "reason": "env not set: SONAR_HOST_URL" }
  ]
}
```

The orchestrator's exit code (`process.exit`) is 0 if no stage failed, 1 otherwise.

### `qa-results/qa-report.json` — aggregated tool rows + test cases

Three top-level arrays:
- **`rows`** — one summary row per tool (tool, status, total, passed, failed, coverage/severity breakdown)
- **`testCases`** — every Playwright test case across smoke/e2e/journey/a11y/visual
- **`qaTestCases`** — the manual-QA-friendly 11-column format (Test Case Id, Page Name, Summary, Priority, Prerequisites, Test Type, Test Steps, Test Data, Expected Result, Actual Result, Status), with per-tool ID prefixes:
  - `QA-PW-NNN` — Playwright
  - `QA-UNIT-NNN` — Vitest
  - `QA-API-NNN` — Newman
  - `QA-PERF-NNN` — k6 thresholds
  - `QA-SEC-NNN` — Trivy CVEs
  - `QA-LEAK-NNN` — gitleaks findings
  - `QA-SAST-NNN` — Semgrep findings
  - `QA-A11Y-NNN` — axe violations
  - `QA-VIS-NNN` — visual diffs

### `qa-results/qa-report.xls` — Excel workbook (4 sheets)

| Sheet | Content |
|---|---|
| **Summary** | Status, totals, generated-at timestamp |
| **Tools** | Same as `rows` above — tool-level summary |
| **Test Cases** | Engineer-facing detail: tool, suite, file, project, test title, status, duration, retries, errors |
| **QA Test Cases** | Manager-facing: the 11-column schema, one row per individual finding |

The **QA Test Cases** sheet is the artifact a QA manager or PM is most likely
to want — it normalizes findings from every tool into a single, sortable,
priority-labeled view.

## Optional power-ups

### LLM-augmented Playwright assertions (always on)

Whenever Playwright is in the plan, the agent reads each discovered
route's page component, asks Claude (or GPT) for the most stable visible
elements, and embeds real role/text Playwright assertions into
`tests/e2e/user-journeys.spec.ts`. Cache lives in
`.qa-agent-cache/llm-enrich/`; re-runs hit cache.

```sh
ANTHROPIC_API_KEY=sk-ant-... \
  node /path/to/agent/src/cli.js /path/to/your/repo --write
```

Override the model:
```sh
QA_LLM_MODEL=claude-opus-4-8 ...        # maximum precision
QA_LLM_MODEL=claude-haiku-4-5-20251001  # cheapest, fastest
QA_LLM_MODEL=gpt-4o ...                  # OpenAI alt
```

### Live-DOM enrichment

When you have a staging deployment, point the agent at it:

```sh
ANTHROPIC_API_KEY=sk-ant-... \
  node /path/to/agent/src/cli.js /path/to/your/repo \
    --crawl-url https://staging.example.com --write
```

The agent crawls the live site (BFS, same-origin, configurable depth),
merges discovered routes with the static scan, and uses the **rendered HTML**
for LLM enrichment instead of source code. Catches dynamic routes (CMS
slugs, feature flags, redirects) and gives assertions against real post-
hydration text.

### Repair stale LLM-enriched journey tests

When your staging deployment changes its markup and existing
`tests/e2e/user-journeys.spec.ts` assertions stop matching the DOM, the
`repair` subcommand reads the Playwright failure report, fetches the
current HTML for each broken route, asks the LLM for fresh assertions,
and patches the spec in place:

```sh
ANTHROPIC_API_KEY=sk-ant-... \
  node /path/to/agent/src/cli.js repair playwright-report/journeys.json \
    --base-url https://staging.example.com \
    --repo /path/to/your/repo \
    --apply
```

Without `--apply` it only updates the LLM cache; the next agent
`--write` run picks up the new assertions. Pairs naturally with
`--crawl-url` (which performs the equivalent enrichment proactively
against a known-good baseline).

### HAR import

After driving your app through Chrome DevTools (Network tab → save as HAR):

```sh
node /path/to/agent/src/cli.js har session.har
# or:
node /path/to/agent/src/cli.js har session.har --replace --filter-origin https://api.example.com
```

Imports captured requests into `postman/qa-collection.json` with the same
status<500 + response-time<2s + JSON assertion templates the static
generator emits. Dedupes by method+URL.

### Crawl-only discovery

For ad-hoc inspection:
```sh
node /path/to/agent/src/cli.js crawl https://example.com --depth 2 --max 50
```

Prints JSON: route paths, titles, where each was first found.

### Stage selection

```sh
node /path/to/agent/src/cli.js /path/to/repo --only playwright,vitest --write
node /path/to/agent/src/cli.js /path/to/repo --skip k6,semgrep --write
npm run qa:all -- --only qa:unit,qa:security  # runtime stage filter
npm run qa:all -- --fail-on critical          # softer severity gate
npm run qa:all -- --changed                   # only stages touched by changed files
```

## Common pitfalls

### Visual baselines must be recorded once

The first `npm run qa:visual` fails for every route because there are no
baseline screenshots. To record them:

```sh
# Terminal 1: keep the app running
npm run dev

# Terminal 2: record screenshots
QA_BASE_URL=http://localhost:3000 npm run qa:visual:update
```

Baselines land under `tests/visual/__screenshots__/`. Commit them. Then
re-run `qa:all` — visual will pass for routes that haven't changed visually.

### Anthropic free-tier rate limit (5 RPM)

If you have a fresh API key with no paid usage, enriching 49 routes will
trigger 429s. The agent retries with exponential backoff and respects
`Retry-After` headers, so it finishes eventually — but a 49-route fresh
run takes ~10 minutes. Cached routes are instant on subsequent runs.

### Production mode is the default; build runs automatically

When the orchestrator sees a `start` script in `package.json`, it runs
`npm run build` first and then `npm run start` — production-mode
serving, no dev-mode cold compiles. To skip the build step (e.g. when
you already built recently), set `QA_BUILD=0`. To force dev mode:

```sh
QA_APP_SERVER=dev npm run qa:all
```

### CI mode: app already deployed

When you're running qa:all in CI against an already-deployed staging app:

```sh
QA_BASE_URL=https://staging.example.com npm run qa:all
# or:
npm run qa:all -- --skip-app-server
```

The orchestrator detects `QA_BASE_URL` and skips its managed-dev-server
flow.

### Stale artifacts

By default, `qa:all` nukes `qa-results/`, `playwright-report/`, and
`test-results/` at startup so the consolidated report reflects only this
run. Set `QA_KEEP_ARTIFACTS=1` to preserve them for CI archival.

### Trivy severity gate

The default `--fail-on high` means any high-severity dependency CVE fails
the run. To soften:

```sh
npm run qa:all -- --fail-on critical    # only critical CVEs fail
QA_FAIL_ON=medium npm run qa:all        # via env var
```

## What's not included

These are deliberate non-goals — there's a whole product category for each:

- **Cloud dashboard / hosted analytics** — Octomind, Mabl, Functionize own
  this space.
- **In-CI self-healing of broken tests** — planned as the `repair`
  subcommand: read a failed Playwright run, ask the LLM to repair the
  selector, output a PR-ready diff. Not yet shipped.
- **Sidecar / eBPF traffic capture** — Keploy's actual product. The HAR
  import is the lightweight alternative; a Node-proxy variant is planned.
- **Mock generation for downstream services** — same. Bring-your-own mocks
  for now.
- **Mutation testing** (Stryker) — easy to add as another stage if you want
  it; not in default scope.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `command not found: trivy` etc. | CLI not installed | `brew install <tool>`; see Prereqs |
| `health probe timed out at http://localhost:3000` | App didn't come up | Check `qa-results/app-server.log`; verify `npm run dev` works directly |
| Every visual test fails | No baselines | Run `qa:visual:update` as described above |
| `429 ... rate limit` during LLM enrichment | Free-tier API limit | Wait; agent backs off and retries automatically |
| Stale stage results in `qa-report.json` | Manual run of one stage | Run `qa:all` for a clean slate |
| `--skip-app-server` skipped my browser tests | That's what it does | Run without the flag when you want browser stages |

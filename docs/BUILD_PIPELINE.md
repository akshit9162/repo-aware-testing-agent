# The `build` pipeline — one command from Excel + UAT + repo to a passing test suite

Written for someone who's never touched Playwright. Follow the four steps below and you get generated + executed + healed tests in your target repo.

## Prerequisites (one-time per machine)

```sh
# 1. Clone the agent
git clone https://github.com/akshit9162/repo-aware-testing-agent.git
cd repo-aware-testing-agent
npm install
npx playwright install chromium

# 2. Set an LLM API key (either works)
export ANTHROPIC_API_KEY=sk-ant-...
# or
export OPENAI_API_KEY=sk-proj-...
```

## The three inputs

1. **Working repo** — the target codebase you want tests for. Local checkout, any framework the agent recognizes (React Router, Vue Router, SvelteKit, Remix, Astro, or file-based routing).
2. **Excel** — one workbook with two sheets:
   - **User Stories** — one story per row (ID, Title, As-a, I want, So-that, Acceptance Criteria, Priority, Status)
   - **Test Cases** — one test per row (Test Case ID, User Story ID, Page/Screen, Summary, Steps, Test Data, Expected Result)
   Column names are auto-detected — Jira / Linear / Notion / Azure DevOps exports all work.
3. **UAT URLs** — one entry URL per journey. Motor / travel / whatever your app has.

## Step 1 — Record DOM snapshots (do this once per UAT URL, ~10 min each)

The agent needs to see the real DOM to write selectors that actually match. It can't guess. This step opens a browser, you click through each journey once (including any OTP or captcha), the agent quietly captures the DOM at every page.

```sh
node src/cli.js record https://uat.example.com/checkout \
  --repo /path/to/your/repo

# A browser window opens. A dark banner at top says "recording".
# Click through the entire flow — login, forms, next, next, done.
# Close the browser tab when finished.
```

Output: `<your-repo>/qa-snapshots/uat-example-com-checkout.json` containing every route's actual field labels, button names, and dropdown options.

Repeat for each entry URL you want tested (motor, travel, admin dashboard, etc.).

## Step 2 — Fill in the fixture (one file, gitignored, 5 min)

```json
// <your-repo>/tests/fixtures/qa-uat.local.json
{
  "uatUrl": "https://uat.example.com",
  "routeParams": {
    "channel": "opalmotoruat",
    "lang": "en"
  },
  "routeOverrides": {
    "/dashboard/login": "/dashboard/dev-login"
  },
  "auth": {
    "mobile": "95888238",
    "otpBypass": "0000"
  },
  "formFills": {
    "First Name": "TESTQA",
    "Plate Number": "92588",
    "Mobile Number": "95888238"
  }
}
```

See [FIXTURE_SCHEMA.md](./FIXTURE_SCHEMA.md) for the full reference.

## Step 3 — Run the pipeline

```sh
node src/cli.js build \
  --repo /path/to/your/repo \
  --excel /path/to/stories.xlsx \
  --snapshots /path/to/your/repo/qa-snapshots \
  --base-url https://uat.example.com \
  --heal-rounds 2
```

That's the entire command. It runs 5 phases with progress logging:

1. **DISCOVER** — scans the repo for routes and forms, loads your recorded snapshots
2. **GROUND** — matches every Excel test case to a real DOM snapshot
3. **GENERATE** — LLM writes each Playwright test using the actual field labels + button names from your DOM
4. **EXECUTE** — runs the whole suite against UAT
5. **HEAL** — for each failure, feeds the error + real DOM back to the LLM, gets a corrected assertion, patches the spec in place, re-runs

## Step 4 — Read the report

Output: `<your-repo>/qa-results/build-report.md`

```markdown
# QA Build Report

- **Stories in workbook:** 502
- **Test cases in workbook:** 1880
- **Test cases enriched:** 1836
- **Playwright — passed:** 1462
- **Playwright — failed:** 402
- **Healer patched:** 340
- **Healer bug candidates:** 62
- **Bug candidates report:** qa-results/bug-candidates.md
```

## What each output means

| File | What it is |
|------|-----------|
| `tests/e2e/stories-*.spec.ts` | The generated Playwright suite. Grouped by module from your Excel. Ready to `npx playwright test`. |
| `qa-snapshots/*.json` | Recorded DOM. Reusable across LLM enrichment runs. Regenerate if the UAT changes shape. |
| `qa-results/build-report.md` | Human-readable summary of the run. Share with your manager. |
| `qa-results/bug-candidates.md` | Tests the healer classified as "real app bug" rather than "wrong test". Triage before filing tickets. |
| `.qa-agent-cache/llm-stories/` | LLM enrichment cache. Delete only if you want to re-pay for enrichment. |
| `.qa-agent-cache/llm-heal/` | Healer cache. Same. |

## Realistic expectations

- **First run on a new repo:** 45-90 min. LLM enrichment for a 1,800-test workbook takes ~30 min. First-run Playwright execution takes another 20-40. Heal round adds ~15.
- **Pass rate:** 60-85% depending on how comprehensive your DOM snapshots were. Rerun with more `record` sessions to lift it.
- **Repeat runs:** ~10 min. Cache hits everything except tests that changed.

## Common issues

**"No DOM snapshots loaded"** — you skipped step 1 or passed the wrong `--snapshots` path. LLM will guess selectors from Excel text and pass rate will be ~2-5%. Record first.

**"Rate limit exceeded"** — Anthropic personal tier is 5 requests/min. Options: use `OPENAI_API_KEY` (higher default limits), reduce `--batch-size`, or wait.

**"OTP required, no fixture.auth.otpBypass"** — you have to hand-record the OTP step. Get the UAT dev-mode OTP value from your team and put it in `fixture.auth.otpBypass`.

**"All my tests fail on URL mismatch"** — the LLM guessed the wrong URL. Add rewrites to `tests/helpers/journey-fixture.ts` (see the Tameen example in the repo).

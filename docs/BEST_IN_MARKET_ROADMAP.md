# Best-in-Market Roadmap

Repo-Aware Testing Agent should not compete as a generic coding assistant. The
winning wedge is narrower and stronger:

> Turn reproducible QA failures into reviewed, validated source fixes with the
> least human effort and the highest trust.

## Market Position

The market is moving toward autonomous coding agents that can take issues,
clone repos, patch code, and open pull requests. That is now table stakes.
Our advantage should be QA-native autonomy:

- The agent owns the full loop from discovery to fix.
- Every bug starts with a runnable failure artifact.
- Every patch is tied to evidence: report row, failing test, route, DOM,
  screenshot/trace when available, retrieved files, exact diff, and rerun result.
- The product is useful before full autonomy: it can generate tests, triage
  failures, repair selectors, propose patches, and only apply them when asked.

## North-Star Metrics

- **Bug reproduction rate:** percentage of reported bugs that can be rerun locally
  or in CI with deterministic commands.
- **Patch acceptance rate:** percentage of agent patches merged without major
  human rewrite.
- **Validation pass rate:** percentage of applied patches where the failing test
  and relevant regression suite pass afterward.
- **Mean time to fix:** time from `qa:all` failure to validated patch.
- **False-fix rate:** patches that pass the narrow test but break adjacent flows.
- **Trust completeness:** percentage of fixes with report, retrieved context,
  diff, command logs, and residual-risk notes.

## Product Pillars

### 1. QA-Native Failure Intelligence

Current state:

- Parses Playwright JSON and generated QA report failures.
- Distinguishes selector repair from source-level coding fixes.
- Produces reportable candidate files and patch proposals.

Next:

- Normalize all tool outputs into one failure schema:
  Playwright, Vitest/Jest, Newman/Postman, k6, axe, Semgrep, Gitleaks, Trivy,
  SonarQube.
- Attach artifacts to each failure:
  screenshots, traces, DOM excerpts, console logs, network failures, route,
  API request/response, coverage deltas.
- Classify failure type:
  product bug, test bug, selector drift, fixture/env issue, flaky timing,
  dependency/config issue, visual baseline drift, security finding.

### 2. Hybrid Retrieval Engine

Current state:

- Lexical source index.
- Optional embedding rerank via OpenAI embeddings.
- Exact file snippets sent to the coding-fix LLM.

Next:

- Persist an index under `.qa-agent-cache/repo-index/`.
- Add AST symbols:
  exports, imports, component names, route ownership, test-to-source links,
  API handlers, env vars, package scripts.
- Combine scores:
  exact symbol match, route match, stack trace match, recent git diff,
  ownership, lexical relevance, vector similarity.
- Add multi-repo context later for shared packages and monorepos.

### 3. Safe Autonomous Fixing

Current state:

- `fix` proposes exact before/after patches.
- `--apply` is required to modify files.
- Stale patches are skipped if exact text no longer matches.

Next:

- Support unified diff patches with path allowlists and hunk verification.
- Generate one branch/worktree per fix attempt.
- Run targeted validation first, then adjacent regression tests.
- Cap attempts per failure and preserve every failed attempt in the report.
- Add policy modes:
  `triage`, `propose`, `apply-safe`, `autofix-pr`.

### 4. Validation and Trust Artifacts

Current state:

- Existing QA report writes JSON/XLS.
- Fix report can be written with `--out`.

Next:

- Standardize `qa-results/fix-report.json`:
  failure, classification, candidates, prompt-safe context, patch, validation
  commands, command outputs, pass/fail, residual risk.
- Generate PR-ready markdown:
  summary, repro, fix, test evidence, screenshots/traces, rollback notes.
- Add a local HTML report for scanning failures and fix attempts.
- Add deterministic command replay:
  `repo-qa-agent replay <fix-report.json>`.

### 5. Continuous Learning Loop

Next:

- Store accepted/rejected fixes as local examples.
- Learn project-specific rules:
  preferred selectors, test data, API auth setup, visual thresholds, flaky
  tests, owner areas.
- Build a benchmark suite from real failures:
  each fixture includes repo snapshot, QA report, expected patch, validation
  command, and acceptance criteria.
- Track agent quality over time with a public scorecard.

## Execution Plan

### Phase 1: Make the Current Fixer Production-Safe

- Add normalized failure schema for every generated QA tool.
- Persist fix reports by default to `qa-results/fix-report.json`.
- Add `--classify-only`, `--max-attempts`, and `--changed-only`.
- Add exact command recommendations per failure type.
- Add validation execution:
  rerun failed Playwright spec, failed unit file, or relevant QA script.

### Phase 2: Build the Repo Intelligence Layer

- Add `repo-qa-agent index <repo>`. **Started:** writes
  `.qa-agent-cache/repo-index.json`.
- Cache lexical + AST-style regex symbols + optional vector embeddings.
  **Started:** symbols/imports/selectors/API/env/package metadata are cached;
  parser-grade AST extraction is still future work.
- Add symbol graph:
  route -> component -> imports -> tests -> API/env dependencies.
- Add stack trace and selector-to-source matching. **Started:** selector hints
  are indexed from JSX/Playwright patterns; `fix` now boosts stack-trace files
  and exact selector source matches.
- Add monorepo package boundary detection. **Started:** `apps/*`,
  `packages/*`, and `services/*` boundaries are captured.
- Make `fix` consume the persisted repo index. **Done:** it loads
  `.qa-agent-cache/repo-index.json` automatically, supports `--index`, and can
  bypass the cache with `--rebuild-index`.

### Phase 3: Agentic Patch Loop

- Add isolated worktree execution. **Started:** `fix --worktree` runs the patch
  loop in a disposable git worktree, with `--keep-worktree`,
  `--worktree-path`, and `--worktree-branch` for inspection/control.
- Implement attempt loop:
  retrieve -> patch -> validate -> refine -> stop. **Started:** retry attempts
  and validation are in place; failed-validation refinement is still future work.
- Add rollback and patch bundle output. **Started:** `--bundle-out` writes a
  machine-readable patch bundle with exact rollback replacements.
- Add PR markdown generation. **Started:** `--pr-out` writes a review-ready PR
  body summarizing failures, context, validation, changed files, and rollback.
- Add `--autofix-pr` placeholder integration for GitHub/GitLab.

### Phase 4: Best-in-Class QA Coverage

- Add authenticated journey recording.
- Add browser trace summarization.
- Add network contract inference from Playwright/HAR.
- Add visual baseline governance:
  classify layout drift vs expected product change.
- Add security fix mode for Semgrep/Gitleaks/Trivy findings.

### Phase 5: Enterprise Trust

- Add policy files:
  allowed paths, forbidden edits, required commands, sensitive files,
  approval thresholds.
- Add audit logs and signed reports.
- Add team-level fixture libraries.
- Add CI integration and scheduled QA/fix jobs.

## Product Differentiation

Most coding agents start from a task description. This agent starts from proof.

The product should feel less like "AI writes code" and more like:

1. It found the bug.
2. It reproduced the bug.
3. It found the owner files.
4. It made the smallest safe patch.
5. It reran the failing test.
6. It told you exactly what still might be wrong.

That is the trust gap the market still has.

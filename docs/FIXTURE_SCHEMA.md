# Fixture schema — `tests/fixtures/qa-uat.local.json`

The fixture is a single JSON file in the target repo. It's **gitignored** — real values only, never committed. The `build` pipeline uses it to substitute route params, drive login, and fill form fields the LLM couldn't guess.

## Complete schema

```json
{
  "uatUrl": "https://uat.example.com",

  "routeParams": {
    "channel": "opalmotoruat",
    "lang": "en",
    "insuranceType": "motor-insurance"
  },

  "routeOverrides": {
    "/dashboard/login": "/dashboard/dev-login",
    "/legacy-path": "/new-path"
  },

  "auth": {
    "mobile": "95888238",
    "email": "qa@example.com",
    "password": "Test1234!",
    "otpBypass": "0000",
    "authToken": null
  },

  "formFills": {
    "First Name": "TESTQA",
    "Last Name": "AUTOMATION",
    "Email": "qa-automation@example.com",
    "Plate Number": "92588",
    "Mobile Number": "95888238"
  },

  "upload": {
    "slots": {
      "documentFront": "tests/fixtures/sample-mulkiya.jpg",
      "documentBack": "tests/fixtures/sample-mulkiya-back.jpg"
    }
  },

  "preActions": [
    "Third Party Insurance"
  ]
}
```

## Field reference

### `uatUrl` (string, optional)
Fallback base URL when `QA_BASE_URL` env var isn't set. Use for local dev when you don't want to type the env var every time.

### `routeParams` (object, optional)
Substitutes `:name` placeholders in discovered routes. If a React Router page uses `path=":channel/motor-basic-form"`, `routeParams.channel` becomes the value.

### `routeOverrides` (object, optional)
Rewrite specific paths that the LLM guessed wrong. The keys are what the LLM wrote; the values are what to substitute. `journey-fixture.ts` applies these before host routing.

### `auth` (object, optional)
- `mobile` / `email` / `password` — filled into fields the LLM detects as auth-like
- `otpBypass` — if the UAT has a fixed OTP value for test accounts (e.g., `0000` or `1234`), put it here. The walker and heal loop use this to progress past OTP gates.
- `authToken` — pre-existing bearer token when your UAT skips login via a URL param or header

### `formFills` (object, optional)
Direct label → value mapping used by the walker and (optionally) by tests. Keys should match the exact field label as rendered on the page. Case-insensitive.

### `upload` (object, optional)
File upload slots. The value is a **repo-relative path** to a real file. Files should be gitignored via `tests/fixtures/sample-*` pattern.

### `preActions` (array of strings, optional)
Labels of clickable-div "radios" or chips that the walker should click before hitting the primary CTA. Used for MUI-style radio components that don't respond to `.fill()`. Example: `["Third Party Insurance"]` clicks that option before pressing PROCEED.

## Real-world example — Tameen

```json
{
  "uatUrl": "https://tameen.om",
  "routeParams": {
    "channel": "opalmotoruat",
    "lang": "en"
  },
  "routeOverrides": {
    "/dashboard/login": "/dashboard/dev-login"
  },
  "auth": {
    "mobile": "95888238",
    "otpBypass": null
  },
  "formFills": {
    "Plate Code": "M",
    "Plate Number": "92588",
    "Resident Card / License Number": "8846087",
    "Mobile Number": "95888238",
    "First Name": "TESTQA",
    "Last Name": "AUTOMATION",
    "Customer mail ID": "qa-automation@tameen.test"
  },
  "upload": {
    "slots": {
      "documentFront": "tests/fixtures/sample-mulkiya.jpg"
    }
  },
  "preActions": ["Third Party Insurance"]
}
```

## Where the fixture is used

| Component | How it uses the fixture |
|-----------|-------------------------|
| `walker.js` | `formFills` for form input, `preActions` for clickable radios, `auth.otpBypass` to progress OTP gates |
| `recorder.js` | Doesn't read the fixture — the human types values live |
| `storiesToTests.js` (LLM enrichment) | Uses `routeParams` implicitly via `urlFor()` at test-run time |
| `healStories.js` | Reads snapshots + fixture for grounding LLM heal prompts |
| `journey-fixture.ts` (in-repo helper) | Reads the JSON at test runtime for `urlFor()`, `substituteParams()`, and `HAS_REAL_FIXTURE` guards |

## Gitignore pattern

Add to your target repo's `.gitignore`:

```
tests/fixtures/*.local.json
tests/fixtures/sample-*
qa-results/
qa-snapshots/
.qa-agent-cache/
.playwright-mcp/
```

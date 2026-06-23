/**
 * Best-effort fixture autogen.
 *
 * When discovered journeys signal that a real-world walk needs values the
 * agent can't conjure (route params, auth credentials, file uploads), emit
 * a gitignored `.example` file so the next human run has the slots ready
 * to fill — instead of forcing each repo's owner to figure out the shape
 * from scratch.
 *
 * Returns an asset descriptor compatible with writer.js, OR null if no
 * fixture is needed.
 */
const AUTH_PATH_RE = /^\/(login|signin|sign-in|sso-login|social-login|auth|otp)(\/|$)/i;
const UPLOAD_HINT_RE = /upload|document|mulkiya|kyc|photo/i;
const FILE_INPUT_HINT_RE = /<input[^>]+type=["']file["']/i;

function uniqueParams(journeys) {
  const set = new Set();
  for (const journey of journeys) {
    if (!journey.params) continue;
    for (const p of journey.params) set.add(p);
  }
  return [...set];
}

function hasAuthJourney(journeys) {
  return journeys.some((journey) => AUTH_PATH_RE.test(journey.path || ""));
}

function hasUploadJourney(journeys) {
  return journeys.some((journey) => UPLOAD_HINT_RE.test(journey.path || ""));
}

export function buildFixtureExample({ journeys, stack, scan }) {
  const params = uniqueParams(journeys);
  const wantAuth = hasAuthJourney(journeys);
  const wantUpload = hasUploadJourney(journeys);

  if (!params.length && !wantAuth && !wantUpload) return null;

  const fixture = {
    _readme: [
      "Copy this file to tests/fixtures/qa-uat.local.json (gitignored) and fill the slots.",
      "All values are loaded by Playwright specs via tests/helpers/journey-fixture.{js,ts}.",
      "Never commit the .local.json variant — it contains real PII.",
    ],
    uatUrl: stack.hasFrontend
      ? "https://REPLACE-ME.example.com"
      : null,
    routeParams: params.length
      ? Object.fromEntries(params.map((p) => [p, `REPLACE_${p.toUpperCase()}`]))
      : undefined,
    auth: wantAuth
      ? {
          username: "REPLACE_USERNAME",
          password: "REPLACE_PASSWORD",
          mobile: "REPLACE_MOBILE",
          otpBypass: "If UAT has a fixed OTP, put it here; otherwise leave null",
        }
      : undefined,
    upload: wantUpload
      ? {
          _readme: "Put document fixture paths here (e.g. sample-mulkiya.jpg, gitignored).",
          slots: { documentFront: "tests/fixtures/sample-document.jpg" },
        }
      : undefined,
  };

  // Drop undefined keys for a clean output.
  for (const key of Object.keys(fixture)) {
    if (fixture[key] === undefined) delete fixture[key];
  }

  return {
    path: "tests/fixtures/qa-uat.local.json.example",
    contents: JSON.stringify(fixture, null, 2) + "\n",
    appendGitignore: [
      "# QA fixtures with real UAT data / PII",
      "tests/fixtures/*.local.json",
      "tests/fixtures/sample-*",
      ".qa-agent-cache/",
    ],
  };
}

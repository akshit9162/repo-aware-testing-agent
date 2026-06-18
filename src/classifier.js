const LOCATOR_RE = /(locator|getbyrole|getbytext|getbylabel|getbytestid|tobevisible|tocontaintext|strict mode violation|element is not visible|element is hidden|not found)/i;
const TIMEOUT_RE = /(timeout|timed out|exceeded|networkidle|waiting for)/i;
const ENV_RE = /(env|environment|api[_-]?key|token|credential|base_url|not set|missing.*config|econnrefused|connection refused)/i;
const ASSERTION_RE = /(expected|received|assertion|toequal|tobe|tomatch|snapshot)/i;
const SECURITY_RE = /(cve-|vulnerability|secret|gitleaks|semgrep|trivy|sonar|injection|xss|csrf|credential)/i;
const VISUAL_RE = /(screenshot|visual|pixel|snapshot|diff|baseline|tohavescreenshot)/i;
const API_RE = /(newman|postman|api|http|status|request|response|json|contract)/i;

export function classifyFailure(failure = {}) {
  const haystack = `${failure.tool || ""}\n${failure.title || ""}\n${failure.file || ""}\n${failure.error || ""}`.toLowerCase();
  const reasons = [];
  let type = "product-bug";
  let confidence = 0.52;

  if (SECURITY_RE.test(haystack)) {
    type = "security-finding";
    confidence = 0.82;
    reasons.push("security scanner or vulnerability terms detected");
  } else if (VISUAL_RE.test(haystack)) {
    type = "visual-regression";
    confidence = 0.78;
    reasons.push("visual/screenshot baseline terms detected");
  } else if (ENV_RE.test(haystack)) {
    type = "environment-or-fixture";
    confidence = 0.76;
    reasons.push("environment, credential, or connection setup terms detected");
  } else if (LOCATOR_RE.test(haystack)) {
    type = "selector-or-dom-drift";
    confidence = 0.8;
    reasons.push("Playwright locator/assertion terms detected");
  } else if (TIMEOUT_RE.test(haystack)) {
    type = "flaky-or-timing";
    confidence = 0.68;
    reasons.push("timeout/waiting terms detected");
  } else if (API_RE.test(haystack)) {
    type = "api-contract";
    confidence = 0.66;
    reasons.push("API/request/response terms detected");
  } else if (ASSERTION_RE.test(haystack)) {
    type = "source-regression";
    confidence = 0.62;
    reasons.push("assertion mismatch terms detected");
  } else {
    reasons.push("defaulted to product bug because no specialized pattern matched");
  }

  return { type, confidence, reasons };
}

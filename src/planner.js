const DEPENDENCY_MANIFEST_FILES = new Set([
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Dockerfile",
  "Cargo.toml",
  "go.mod",
  "go.sum",
  "pyproject.toml",
  "Pipfile",
  "Pipfile.lock",
  "setup.py",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]);

function hasDependencyManifest(scan, stack) {
  if (scan.packageJson) return true;
  if (stack.hasContainer) return true;
  return scan.files.some((file) => DEPENDENCY_MANIFEST_FILES.has(file) || /^requirements.*\.txt$/.test(file));
}

export function createTestPlan(scan, stack, options = {}) {
  const only = normalizeFilter(options.only);
  const skip = normalizeFilter(options.skip);
  const allow = (toolName) => {
    if (only.size && !only.has(toolName)) return false;
    if (skip.has(toolName)) return false;
    return true;
  };

  const risks = [];
  if (stack.hasFrontend) risks.push("UI flows can regress across routing, forms, rendering, accessibility, and responsive layouts.");
  if (stack.hasApi) risks.push("API contracts can drift between frontend and backend callers.");
  if (stack.hasContainer) risks.push("Container images and dependencies can introduce known vulnerabilities.");
  if (!scan.facts.hasPlaywrightConfig && stack.hasFrontend) risks.push("No browser automation baseline is configured.");
  if (stack.isJsTs && !stack.hasUnitTestSignal) risks.push("No unit/component test signal detected — add tests before relying on Vitest stage.");

  const tools = [
    {
      name: "playwright",
      enabled: stack.hasFrontend,
      purpose: "Smoke, e2e, regression, visual, and accessibility browser checks.",
    },
    {
      name: "vitest",
      enabled: Boolean(scan.packageJson) && stack.isJsTs && stack.hasUnitTestSignal,
      purpose: "Unit and component tests for isolated logic.",
    },
    {
      name: "sonarqube",
      enabled: Boolean(scan.packageJson) || scan.files.some((file) => file.startsWith("src/")),
      purpose: "Code quality, duplication, maintainability, and security hotspot reporting.",
    },
    {
      name: "postman",
      enabled: stack.hasApi,
      purpose: "API contract and response-shape validation through a collection.",
    },
    {
      name: "trivy",
      enabled: hasDependencyManifest(scan, stack),
      purpose: "Dependency, container, IaC, and secret vulnerability scanning.",
    },
    {
      name: "k6",
      enabled: stack.hasApi,
      purpose: "Load and performance checks for API or critical user journeys.",
    },
    {
      name: "axe",
      enabled: stack.hasFrontend,
      purpose: "Accessibility checks via axe-core on every discovered route.",
    },
    {
      name: "visual",
      enabled: stack.hasFrontend,
      purpose: "Visual regression via Playwright screenshot baselines.",
    },
    {
      name: "gitleaks",
      enabled: true,
      purpose: "Secret scanning across the repository tree.",
    },
    {
      name: "semgrep",
      enabled: true,
      purpose: "Static analysis (SAST) using Semgrep's auto config.",
    },
  ].map((tool) => ({ ...tool, enabled: tool.enabled && allow(tool.name) }));

  const enabledTools = new Set(tools.filter((tool) => tool.enabled).map((tool) => tool.name));

  const stages = tools
    .filter((tool) => tool.enabled)
    .map((tool) => ({
      tool: tool.name,
      objective: tool.purpose,
      status: stack.existingTools[tool.name] ? "extend-existing" : "bootstrap",
    }));

  return {
    summary: `Custom QA workflow for a ${stack.language} ${stack.framework} repository.`,
    stack,
    risks,
    stages,
    enabledTools: [...enabledTools],
    filters: { only: [...only], skip: [...skip] },
    recommendedOrder: [
      "qa:unit",
      "qa:secrets",
      "qa:sast",
      "qa:smoke",
      "qa:journeys",
      "qa:e2e",
      "qa:a11y",
      "qa:visual",
      "qa:api",
      "qa:quality",
      "qa:security",
      "qa:perf",
    ].filter((script) => {
      if (script === "qa:unit") return enabledTools.has("vitest");
      if (script === "qa:smoke" || script === "qa:journeys" || script === "qa:e2e") return enabledTools.has("playwright");
      if (script === "qa:a11y") return enabledTools.has("axe");
      if (script === "qa:visual") return enabledTools.has("visual");
      if (script === "qa:api") return enabledTools.has("postman");
      if (script === "qa:perf") return enabledTools.has("k6");
      if (script === "qa:quality") return enabledTools.has("sonarqube");
      if (script === "qa:security") return enabledTools.has("trivy");
      if (script === "qa:secrets") return enabledTools.has("gitleaks");
      if (script === "qa:sast") return enabledTools.has("semgrep");
      return true;
    }),
  };
}

function normalizeFilter(value) {
  if (!value) return new Set();
  if (value instanceof Set) return new Set([...value].map((entry) => entry.toLowerCase()));
  if (Array.isArray(value)) return new Set(value.map((entry) => String(entry).toLowerCase()));
  return new Set(String(value).split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean));
}

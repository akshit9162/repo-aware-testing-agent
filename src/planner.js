export function createTestPlan(scan, stack) {
  const risks = [];
  if (stack.hasFrontend) risks.push("UI flows can regress across routing, forms, rendering, accessibility, and responsive layouts.");
  if (stack.hasApi) risks.push("API contracts can drift between frontend and backend callers.");
  if (stack.hasContainer) risks.push("Container images and dependencies can introduce known vulnerabilities.");
  if (!scan.facts.hasPlaywrightConfig && stack.hasFrontend) risks.push("No browser automation baseline is configured.");
  if (!stack.existingTools.vitest) risks.push("Unit/component regression coverage is not clearly configured.");

  const tools = [
    {
      name: "playwright",
      enabled: stack.hasFrontend,
      purpose: "Smoke, e2e, regression, visual, and accessibility browser checks.",
    },
    {
      name: "vitest",
      enabled: Boolean(scan.packageJson),
      purpose: "Unit and component tests for isolated logic.",
    },
    {
      name: "sonarqube",
      enabled: Boolean(scan.packageJson),
      purpose: "Code quality, duplication, maintainability, and security hotspot reporting.",
    },
    {
      name: "postman",
      enabled: stack.hasApi,
      purpose: "API contract and response-shape validation through a collection.",
    },
    {
      name: "grype",
      enabled: Boolean(scan.packageJson || stack.hasContainer),
      purpose: "Dependency and container vulnerability scanning.",
    },
    {
      name: "k6",
      enabled: stack.hasApi,
      purpose: "Load and performance checks for API or critical user journeys.",
    },
  ];

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
    recommendedOrder: [
      "qa:unit",
      "qa:smoke",
      "qa:journeys",
      "qa:e2e",
      "qa:api",
      "qa:quality",
      "qa:security",
      "qa:perf",
    ].filter((script) => {
      if (script === "qa:smoke" || script === "qa:journeys" || script === "qa:e2e") return stack.hasFrontend;
      if (script === "qa:api" || script === "qa:perf") return stack.hasApi;
      return true;
    }),
  };
}

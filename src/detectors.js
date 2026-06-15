function hasDep(pkg, name) {
  return Boolean(pkg?.dependencies?.[name] || pkg?.devDependencies?.[name]);
}

function hasScript(pkg, name) {
  return Boolean(pkg?.scripts?.[name]);
}

export function detectStack(scan) {
  const pkg = scan.packageJson;
  const files = scan.files;
  const packageManager = files.includes("pnpm-lock.yaml")
    ? "pnpm"
    : files.includes("yarn.lock")
      ? "yarn"
      : "npm";

  const framework = hasDep(pkg, "next")
    ? "next"
    : hasDep(pkg, "vite") || files.some((file) => file.startsWith("vite.config."))
      ? "vite"
      : hasDep(pkg, "react") || scan.facts.hasReactFiles
        ? "react"
        : pkg
          ? "node"
          : "unknown";

  const existingTools = {
    playwright: hasDep(pkg, "@playwright/test") || scan.facts.hasPlaywrightConfig,
    vitest: hasDep(pkg, "vitest") || scan.facts.hasVitestConfig,
    sonarqube: scan.facts.hasSonarConfig,
    postman: scan.facts.hasPostman || hasScript(pkg, "qa:api"),
    grype: hasScript(pkg, "qa:security") || files.some((file) => file.includes("grype")),
    k6: scan.facts.hasK6 || hasScript(pkg, "qa:perf"),
  };

  return {
    packageManager,
    framework,
    language: files.some((file) => file.endsWith(".ts") || file.endsWith(".tsx")) ? "typescript" : "javascript",
    hasFrontend: scan.facts.hasReactFiles || ["next", "vite", "react"].includes(framework),
    hasApi: scan.facts.hasApiRoutes || scan.facts.hasOpenApi,
    hasContainer: scan.facts.hasDockerfile,
    existingTools,
  };
}

function hasDep(pkg, name) {
  return Boolean(pkg?.dependencies?.[name] || pkg?.devDependencies?.[name]);
}

function hasScript(pkg, name) {
  return Boolean(pkg?.scripts?.[name]);
}

function detectLanguage(scan) {
  const files = scan.files;
  const hasTs = files.some((file) => file.endsWith(".ts") || file.endsWith(".tsx"));
  const hasJs = files.some((file) => file.endsWith(".js") || file.endsWith(".jsx") || file.endsWith(".mjs") || file.endsWith(".cjs"));
  const candidates = [
    { name: "typescript", present: hasTs },
    { name: "javascript", present: hasJs },
    { name: "python", present: scan.facts.hasPython },
    { name: "go", present: scan.facts.hasGo },
    { name: "rust", present: scan.facts.hasRust },
    { name: "java", present: scan.facts.hasJava },
  ];
  const present = candidates.filter((language) => language.present);
  return {
    primary: present[0]?.name || "unknown",
    languages: present.map((language) => language.name),
  };
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
    trivy: hasScript(pkg, "qa:security") || files.some((file) => file === ".trivyignore" || file === "trivy.yaml" || /trivy/i.test(file)),
    k6: scan.facts.hasK6 || hasScript(pkg, "qa:perf"),
  };

  const lang = detectLanguage(scan);
  const isJsTs = lang.primary === "typescript" || lang.primary === "javascript";

  return {
    packageManager,
    framework,
    language: lang.primary,
    languages: lang.languages,
    hasFrontend: scan.facts.hasReactFiles || ["next", "vite", "react"].includes(framework),
    hasApi: scan.facts.hasApiRoutes || scan.facts.hasOpenApi,
    hasContainer: scan.facts.hasDockerfile,
    hasUnitTestSignal: Boolean(scan.facts.hasUnitTestSignal),
    isJsTs,
    existingTools,
  };
}

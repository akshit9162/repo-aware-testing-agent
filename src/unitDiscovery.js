const SOURCE_RE = /\.(js|jsx|ts|tsx|mjs|cjs)$/;
const TEST_RE = /(\.test\.|\.spec\.|__tests__\/|\/tests?\/)/;

const QA_SCAFFOLD_PATHS = new Set([
  "playwright.config.ts",
  "playwright.config.js",
  "sonar-project.properties",
  ".trivyignore",
  ".gitleaks.toml",
  "qa-plan.json",
  "scripts/qa-run-all.mjs",
  "scripts/qa-report.mjs",
  "tests/unit/qa-baseline.test.js",
  "tests/unit/qa-generated-regression.test.js",
  "tests/smoke/qa-smoke.spec.ts",
  "tests/e2e/critical-journey.spec.ts",
  "tests/e2e/user-journeys.spec.ts",
  "tests/a11y/qa-a11y.spec.ts",
  "tests/visual/qa-visual.spec.ts",
  "tests/performance/load.js",
  "postman/qa-collection.json",
  "postman/qa-env.json",
]);

function isQaScaffold(file) {
  return QA_SCAFFOLD_PATHS.has(file);
}

function isSourceFile(file) {
  return SOURCE_RE.test(file)
    && !TEST_RE.test(file)
    && !file.endsWith(".d.ts")
    && !file.includes("/stories.")
    && !file.includes(".stories.")
    && !isQaScaffold(file);
}

function isComponentFile(file) {
  return /\.(jsx|tsx)$/.test(file) && /(^|\/)[A-Z][^/]*\.(jsx|tsx)$/.test(file);
}

function isRouteFile(file) {
  return /^app\/.*page\.(js|jsx|ts|tsx)$/.test(file)
    || /^pages\/(?!api\/).*\.(js|jsx|ts|tsx)$/.test(file)
    || /^src\/(pages|routes)\/.*\.(js|jsx|ts|tsx)$/.test(file);
}

function isApiFile(file) {
  return /^pages\/api\/.*\.(js|ts)$/.test(file)
    || /^app\/api\/.*route\.(js|ts)$/.test(file)
    || /(^|\/)(api|routes|controllers)\//.test(file);
}

function isConfigFile(file) {
  return /(^|\/)(vite|next|nuxt|astro|svelte|vitest|playwright|tailwind|eslint|prettier|tsconfig|jsconfig)\.config\./.test(file)
    || ["tsconfig.json", "jsconfig.json"].includes(file);
}

function limit(items, count = 100) {
  return items.slice(0, count);
}

export function discoverUnitTestTargets(scan) {
  const files = scan.files || [];
  const sourceFiles = files.filter(isSourceFile).sort();
  const routeFiles = files.filter(isRouteFile).sort();
  const apiFiles = files.filter(isApiFile).sort();
  const componentFiles = files.filter(isComponentFile).sort();
  const configFiles = files.filter((file) => isConfigFile(file) && !isQaScaffold(file)).sort();
  const envFiles = files.filter((file) => /^\.env(\.|$)|(^|\/)\.env\.example$|(^|\/)env\.example$/.test(file)).sort();
  const packageScripts = Object.keys(scan.packageJson?.scripts || {})
    .filter((name) => !name.startsWith("qa:"))
    .sort();

  return {
    packageScripts,
    sourceFiles: limit(sourceFiles),
    routeFiles: limit(routeFiles),
    apiFiles: limit(apiFiles),
    componentFiles: limit(componentFiles),
    configFiles: limit(configFiles),
    envFiles: limit(envFiles),
    truncated: {
      sourceFiles: sourceFiles.length > 100,
      routeFiles: routeFiles.length > 100,
      apiFiles: apiFiles.length > 100,
      componentFiles: componentFiles.length > 100,
      configFiles: configFiles.length > 100,
      envFiles: envFiles.length > 100,
    },
  };
}

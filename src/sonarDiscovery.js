function unique(values) {
  return [...new Set(values.filter(Boolean))].sort();
}

function topLevelDir(file) {
  return file.includes("/") ? file.split("/")[0] : "";
}

export function createSonarProperties(scan) {
  const files = scan.files || [];
  const pkg = scan.packageJson || {};
  const sourceDirs = unique(files
    .filter((file) => /\.(js|jsx|ts|tsx)$/.test(file))
    .filter((file) => !/(^|\/)(tests?|__tests__)\/|\.test\.|\.spec\./.test(file))
    .map(topLevelDir)
    .filter((dir) => ["src", "app", "pages", "server", "lib"].includes(dir)));
  const testDirs = unique(files
    .filter((file) => /(^|\/)(tests?|__tests__)\/|\.test\.|\.spec\./.test(file))
    .map(topLevelDir)
    .filter(Boolean));
  const sources = sourceDirs.length ? sourceDirs.join(",") : ".";
  const tests = testDirs.length ? testDirs.join(",") : "tests";
  const exclusions = [
    "node_modules/**",
    "dist/**",
    "build/**",
    ".next/**",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "qa-results/**",
    "**/*.test.*",
    "**/*.spec.*",
  ];

  return [
    `sonar.projectKey=${pkg.name || "repo-aware-qa"}`,
    `sonar.projectName=${pkg.name || "Repo Aware QA"}`,
    `sonar.sources=${sources}`,
    `sonar.tests=${tests}`,
    "sonar.sourceEncoding=UTF-8",
    "sonar.javascript.lcov.reportPaths=coverage/lcov.info",
    "sonar.typescript.lcov.reportPaths=coverage/lcov.info",
    `sonar.exclusions=${exclusions.join(",")}`,
    "sonar.test.inclusions=**/*.test.*,**/*.spec.*,tests/**,__tests__/**",
    "sonar.coverage.exclusions=**/*.test.*,**/*.spec.*,tests/**,__tests__/**,playwright.config.*,vitest.config.*",
    "",
  ].join("\n");
}

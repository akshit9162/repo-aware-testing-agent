import { promises as fs } from "node:fs";
import path from "node:path";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  "playwright-report",
  "test-results",
  ".turbo",
]);

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walk(root, dir = root, files = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replaceAll(path.sep, "/");
    if (entry.isDirectory()) {
      await walk(root, full, files);
    } else {
      files.push(rel);
    }
  }
  return files;
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

export async function scanRepository(repoPath) {
  const root = path.resolve(repoPath);
  if (!(await exists(root))) {
    throw new Error(`Repository path does not exist: ${root}`);
  }

  const files = await walk(root);
  const packageJson = await readJson(path.join(root, "package.json"));
  const has = (file) => files.includes(file);
  const hasAny = (patterns) => files.some((file) => patterns.some((pattern) => file.includes(pattern)));

  return {
    root,
    files,
    packageJson,
    facts: {
      hasPackageJson: Boolean(packageJson),
      hasDockerfile: files.some((file) => /^Dockerfile/i.test(path.basename(file))),
      hasOpenApi: files.some((file) => /openapi|swagger/i.test(file)),
      hasPostman: hasAny(["postman/", ".postman"]),
      hasPlaywrightConfig: has("playwright.config.ts") || has("playwright.config.js"),
      hasVitestConfig: has("vitest.config.ts") || has("vitest.config.js"),
      hasSonarConfig: has("sonar-project.properties"),
      hasK6: hasAny(["tests/performance/", "k6/"]),
      hasReactFiles: files.some((file) => /\.(tsx|jsx)$/.test(file)),
      hasApiRoutes: files.some((file) => /api\/.*\.(ts|js|tsx|jsx)$/.test(file) || /routes?\//.test(file)),
    },
  };
}

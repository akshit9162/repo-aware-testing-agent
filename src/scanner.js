import { promises as fs } from "node:fs";
import path from "node:path";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".parcel-cache",
  ".vercel",
  ".netlify",
  "dist",
  "build",
  "out",
  "tmp",
  ".cache",
  "coverage",
  "playwright-report",
  "test-results",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "vendor",
]);

const MAX_DEPTH = 15;
const MAX_ENTRIES_PER_DIR = 5000;

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walk(root, dir = root, files = [], depth = 0, visited = new Set()) {
  if (depth > MAX_DEPTH) return files;
  let realDir;
  try {
    realDir = await fs.realpath(dir);
  } catch {
    return files;
  }
  if (visited.has(realDir)) return files;
  visited.add(realDir);

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  if (entries.length > MAX_ENTRIES_PER_DIR) entries = entries.slice(0, MAX_ENTRIES_PER_DIR);

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replaceAll(path.sep, "/");
    if (entry.isDirectory()) {
      await walk(root, full, files, depth + 1, visited);
    } else if (entry.isFile()) {
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

function hasDep(pkg, name) {
  return Boolean(pkg?.dependencies?.[name] || pkg?.devDependencies?.[name]);
}

function hasTestScript(pkg) {
  const scripts = pkg?.scripts || {};
  return Object.values(scripts).some((value) => /\b(vitest|jest|mocha|ava|tap|node\s+--test|playwright|cypress)\b/.test(value));
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

  const hasTestFiles = files.some((file) => /\.(test|spec)\.(js|jsx|ts|tsx|mjs|cjs)$/.test(file));
  const hasVitestDep = hasDep(packageJson, "vitest");
  const hasJestDep = hasDep(packageJson, "jest");

  const hasNextApiRoute = files.some((file) =>
    /^pages\/api\//.test(file) || /^app\/api\/.*\/route\.(js|ts)$/.test(file),
  );
  const hasTopLevelServerRoute = files.some((file) => /^routes\/.+\.(js|ts)$/.test(file));
  const hasServerEntry = files.some((file) => /^(src\/)?server[\/.]/.test(file) || file === "server.js" || file === "server.ts");

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
      hasApiRoutes: hasNextApiRoute || hasTopLevelServerRoute || hasServerEntry,
      hasUnitTestSignal: hasTestFiles || hasVitestDep || hasJestDep || hasTestScript(packageJson),
      hasPython: files.some((file) => /\.py$/.test(file) || file === "pyproject.toml" || /^requirements.*\.txt$/.test(file) || file === "setup.py" || file === "Pipfile"),
      hasGo: files.some((file) => /\.go$/.test(file) || file === "go.mod"),
      hasRust: files.some((file) => /\.rs$/.test(file) || file === "Cargo.toml"),
      hasJava: files.some((file) => /\.java$/.test(file) || file === "pom.xml" || file === "build.gradle" || file === "build.gradle.kts"),
    },
  };
}

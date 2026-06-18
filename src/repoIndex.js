import { promises as fs } from "node:fs";
import path from "node:path";

export const REPO_INDEX_VERSION = 1;

const DEFAULT_MAX_FILE_CHARS = 10_000;
const DEFAULT_INDEX_PATH = ".qa-agent-cache/repo-index.json";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "dist",
  "build",
  "out",
  "coverage",
  "playwright-report",
  "test-results",
  "qa-results",
  ".qa-agent-cache",
]);

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".scss",
  ".md",
  ".html",
  ".yml",
  ".yaml",
]);

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9_/-]+/)
    .filter((token) => token.length >= 2);
}

function unique(items) {
  return [...new Set(items)];
}

async function walk(root, dir = root, files = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replaceAll(path.sep, "/");
    if (entry.isDirectory()) {
      await walk(root, full, files);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(rel);
    }
  }
  return files;
}

function parseImports(content) {
  const imports = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?(?:[^'"]+\s+from\s+)["']([^"']+)["']/g,
    /\brequire\(["']([^"']+)["']\)/g,
    /\bimport\(["']([^"']+)["']\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      imports.push(match[1]);
    }
  }
  return unique(imports);
}

function parseSymbols(content) {
  const symbols = [];
  const patterns = [
    /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/g,
    /\bfunction\s+([A-Za-z_$][\w$]*)/g,
    /\bclass\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      symbols.push(match[1]);
    }
  }
  return unique(symbols).slice(0, 100);
}

function routeFromFile(file) {
  const normalized = file.replaceAll(path.sep, "/");
  const appIndex = normalized.split("/").lastIndexOf("app");
  const appRelative = appIndex >= 0 ? normalized.split("/").slice(appIndex).join("/") : normalized;
  const pagesIndex = normalized.split("/").lastIndexOf("pages");
  const pagesRelative = pagesIndex >= 0 ? normalized.split("/").slice(pagesIndex).join("/") : normalized;

  const appMatch = appRelative.match(/^app\/(.+)\/(?:page|route)\.(?:jsx?|tsx?|mjs|cjs)$/);
  if (appRelative.match(/^app\/(?:page|route)\.(?:jsx?|tsx?|mjs|cjs)$/)) return "/";
  if (appMatch) {
    const route = "/" + appMatch[1]
      .replace(/\/\(.*?\)/g, "")
      .replace(/\[\.{3}([^\]]+)\]/g, ":$1*")
      .replace(/\[([^\]]+)\]/g, ":$1");
    return route === "/index" ? "/" : route;
  }

  const pagesMatch = pagesRelative.match(/^pages\/(.+)\.(?:jsx?|tsx?|mjs|cjs)$/);
  if (pagesMatch && !pagesMatch[1].startsWith("_")) {
    const route = "/" + pagesMatch[1]
      .replace(/\/index$/, "")
      .replace(/\[\.{3}([^\]]+)\]/g, ":$1*")
      .replace(/\[([^\]]+)\]/g, ":$1");
    return route || "/";
  }

  return null;
}

function detectPackage(file) {
  const parts = file.split("/");
  if (parts[0] === "packages" && parts[1]) return `packages/${parts[1]}`;
  if (parts[0] === "apps" && parts[1]) return `apps/${parts[1]}`;
  if (parts[0] === "services" && parts[1]) return `services/${parts[1]}`;
  return ".";
}

function detectRole(file) {
  if (/(^|\/)(tests?|__tests__|e2e|spec)\//.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) return "test";
  if (/(^|\/)app\/api\//.test(file) || /(^|\/)pages\/api\//.test(file) || /\/route\.[cm]?[jt]sx?$/.test(file)) return "api";
  if (/(^|\/)(app|pages|src\/pages|src\/routes)\//.test(file)) return "route";
  if (/\.(css|scss)$/.test(file)) return "style";
  if (/(^|\/)(components|ui)\//.test(file) || /\.(jsx|tsx)$/.test(file)) return "component";
  if (/(^|\/)(lib|utils?|services?)\//.test(file)) return "library";
  if (/package\.json$/.test(file)) return "manifest";
  return "source";
}

function detectEnvRefs(content) {
  const refs = [];
  const patterns = [
    /process\.env\.([A-Z0-9_]+)/g,
    /import\.meta\.env\.([A-Z0-9_]+)/g,
    /\benv\.([A-Z0-9_]+)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) refs.push(match[1]);
  }
  return unique(refs);
}

function detectApiRefs(content) {
  const refs = [];
  for (const match of content.matchAll(/\b(?:fetch|axios\.(?:get|post|put|patch|delete))\(\s*["'`]([^"'`]+)["'`]/g)) {
    refs.push(match[1]);
  }
  for (const match of content.matchAll(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+["'`]([^"'`]+)["'`]/g)) {
    refs.push(match[1]);
  }
  return unique(refs);
}

function extractSelectorHints(content) {
  const hints = [];
  const patterns = [
    /data-testid=["']([^"']+)["']/g,
    /data-test=["']([^"']+)["']/g,
    /getBy(?:Role|LabelText|Text|TestId)\(["'`]([^"'`]+)["'`]/g,
    /aria-label=["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) hints.push(match[1]);
  }
  return unique(hints).slice(0, 100);
}

function summarizeGraph(entries) {
  const routeToFiles = {};
  const testToTargets = {};
  const importEdges = [];
  const envToFiles = {};
  const apiToFiles = {};
  const packageBoundaries = {};

  for (const entry of entries) {
    if (entry.route) {
      routeToFiles[entry.route] ||= [];
      routeToFiles[entry.route].push(entry.path);
    }
    if (entry.role === "test") {
      const targetHints = entries
        .filter((candidate) => candidate.role !== "test" && entry.content.includes(path.basename(candidate.path).split(".")[0]))
        .map((candidate) => candidate.path)
        .slice(0, 20);
      testToTargets[entry.path] = targetHints;
    }
    for (const specifier of entry.imports) {
      importEdges.push({ from: entry.path, to: specifier });
    }
    for (const env of entry.env) {
      envToFiles[env] ||= [];
      envToFiles[env].push(entry.path);
    }
    for (const api of entry.api) {
      apiToFiles[api] ||= [];
      apiToFiles[api].push(entry.path);
    }
    packageBoundaries[entry.package] ||= [];
    packageBoundaries[entry.package].push(entry.path);
  }

  return { routeToFiles, testToTargets, importEdges, envToFiles, apiToFiles, packageBoundaries };
}

export async function buildRepoIndex(repoRoot, {
  maxFileChars = DEFAULT_MAX_FILE_CHARS,
  embedder = null,
  useEmbeddings = false,
} = {}) {
  const root = path.resolve(repoRoot);
  const files = await walk(root);
  const entries = [];

  for (const file of files) {
    try {
      const content = await fs.readFile(path.join(root, file), "utf8");
      const truncated = content.slice(0, maxFileChars);
      const route = routeFromFile(file);
      const imports = parseImports(truncated);
      const symbols = parseSymbols(truncated);
      const env = detectEnvRefs(truncated);
      const api = detectApiRefs(truncated);
      const selectorHints = extractSelectorHints(truncated);
      const role = detectRole(file);
      const pkg = detectPackage(file);
      entries.push({
        path: file,
        role,
        package: pkg,
        route,
        imports,
        symbols,
        env,
        api,
        selectorHints,
        content: truncated,
        tokens: tokenize(`${file}\n${role}\n${route || ""}\n${imports.join("\n")}\n${symbols.join("\n")}\n${env.join("\n")}\n${api.join("\n")}\n${selectorHints.join("\n")}\n${truncated}`),
      });
    } catch {
      // Keep indexing best-effort; unreadable files should not block QA triage.
    }
  }

  if (useEmbeddings && embedder) {
    const texts = entries.map((entry) => `${entry.path}\n${entry.symbols.join("\n")}\n${entry.content}`);
    let embeddings = null;
    if (typeof embedder === "function") embeddings = await embedder(texts);
    else if (typeof embedder.embed === "function") embeddings = await embedder.embed(texts);
    else if (embedder.embeddings?.create) {
      const response = await embedder.embeddings.create({
        model: process.env.QA_EMBEDDING_MODEL || "text-embedding-3-small",
        input: texts,
      });
      embeddings = response.data.map((item) => item.embedding);
    }
    if (embeddings) {
      for (let i = 0; i < entries.length; i += 1) {
        entries[i].embedding = embeddings[i] || null;
      }
    }
  }

  const graph = summarizeGraph(entries);
  return {
    schemaVersion: REPO_INDEX_VERSION,
    repo: root,
    generatedAt: new Date().toISOString(),
    stats: {
      files: entries.length,
      routes: Object.keys(graph.routeToFiles).length,
      imports: graph.importEdges.length,
      packages: Object.keys(graph.packageBoundaries).length,
      embeddings: entries.filter((entry) => Array.isArray(entry.embedding)).length,
    },
    graph,
    entries,
  };
}

export function defaultRepoIndexPath(repoRoot) {
  return path.join(path.resolve(repoRoot), DEFAULT_INDEX_PATH);
}

export async function writeRepoIndex(repoRoot, index, { outPath = defaultRepoIndexPath(repoRoot) } = {}) {
  const target = path.resolve(outPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(index, null, 2) + "\n", "utf8");
  return target;
}

export async function readRepoIndex(repoRoot, { indexPath = defaultRepoIndexPath(repoRoot) } = {}) {
  const target = path.resolve(indexPath);
  const index = JSON.parse(await fs.readFile(target, "utf8"));
  if (index.schemaVersion !== REPO_INDEX_VERSION) {
    throw new Error(`repo index schema ${index.schemaVersion} is not supported`);
  }
  if (path.resolve(index.repo) !== path.resolve(repoRoot)) {
    throw new Error(`repo index belongs to ${index.repo}, not ${path.resolve(repoRoot)}`);
  }
  return index;
}

function scoreQuery(queryTokens, entry) {
  const tokens = new Set(entry.tokens || []);
  let score = 0;
  for (const token of queryTokens) {
    if (tokens.has(token)) score += 3;
    if (entry.path.toLowerCase().includes(token)) score += 5;
    if (entry.route?.toLowerCase().includes(token)) score += 8;
    if (entry.symbols?.some((symbol) => symbol.toLowerCase().includes(token))) score += 6;
    if (entry.selectorHints?.some((hint) => hint.toLowerCase().includes(token))) score += 7;
  }
  return score;
}

export function queryRepoIndex(index, query, { maxFiles = 8, roles = [] } = {}) {
  const queryTokens = unique(tokenize(query));
  const roleFilter = new Set(roles);
  return (index.entries || [])
    .filter((entry) => !roleFilter.size || roleFilter.has(entry.role))
    .map((entry) => ({ ...entry, score: scoreQuery(queryTokens, entry) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, maxFiles);
}

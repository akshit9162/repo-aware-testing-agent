/**
 * Vue Router static route discovery.
 *
 * Vue apps usually declare routes in a config object exported from
 * `src/router/index.{js,ts}`. This scanner finds those files and extracts
 * `{ path, component }` entries via regex.
 *
 * Returns: Array<{ path, source, dynamic, params, originFile, framework: 'vue-router' }>
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { expandRoutePath, buildImportMap, resolveImportToFile } from "./journeysReactRouter.js";

const ROUTER_FILE_PATTERNS = [
  /(^|\/)router\/index\.(js|ts|mjs|cjs)$/i,
  /(^|\/)router\.config\.(js|ts|mjs|cjs)$/i,
  /(^|\/)src\/router\/.+\.(js|ts|mjs|cjs)$/i,
];

// Two-pass: find any `{...}` block that contains a `path: '...'` literal,
// then inspect the same block for `component: X` or an inline dynamic import.
const ROUTE_BLOCK_RE = /\{[^{}]*?\bpath\s*:\s*(['"`])([^'"`]+)\1[^{}]*?\}/gs;
const COMPONENT_IN_BLOCK_RE =
  /\bcomponent\s*:\s*(?:(\w+)|\(\s*\)\s*=>\s*import\(\s*(['"`])([^'"`]+)\2\s*\))/;

function looksLikeRouterFile(file) {
  return ROUTER_FILE_PATTERNS.some((re) => re.test(file));
}

function readFileSafe(repoRoot, file) {
  try {
    return readFileSync(path.join(repoRoot, file), "utf8");
  } catch {
    return null;
  }
}

export function parseVueRouteEntries(source) {
  const out = [];
  ROUTE_BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = ROUTE_BLOCK_RE.exec(source)) !== null) {
    const rawPath = m[2];
    if (!rawPath || rawPath === "*") continue;
    let componentName = null;
    let inlineImport = null;
    const compMatch = COMPONENT_IN_BLOCK_RE.exec(m[0]);
    if (compMatch) {
      if (compMatch[3]) inlineImport = compMatch[3];
      else if (compMatch[1]) componentName = compMatch[1];
    }
    out.push({ rawPath, componentName, inlineImport });
  }
  return out;
}

export function discoverVueRouterJourneys(files, repoRoot) {
  if (!repoRoot) return [];
  const candidates = files.filter(looksLikeRouterFile);
  const fileSet = new Set(files);
  const results = [];

  for (const file of candidates) {
    const source = readFileSafe(repoRoot, file);
    if (!source) continue;
    const declarations = parseVueRouteEntries(source);
    if (!declarations.length) continue;
    const imports = buildImportMap(source);

    for (const decl of declarations) {
      const expanded = expandRoutePath(decl.rawPath);
      let resolved = file;
      if (decl.inlineImport) {
        const candidate = resolveImportToFile(file, decl.inlineImport, fileSet);
        if (candidate) resolved = candidate;
      } else if (decl.componentName && imports.has(decl.componentName)) {
        const candidate = resolveImportToFile(file, imports.get(decl.componentName), fileSet);
        if (candidate) resolved = candidate;
      }
      results.push({
        path: expanded.path,
        rawPath: decl.rawPath,
        source: resolved,
        originFile: file,
        dynamic: expanded.dynamic,
        params: expanded.params,
        componentName: decl.componentName || null,
        framework: "vue-router",
      });
    }
  }

  const byPath = new Map();
  for (const entry of results) {
    if (!byPath.has(entry.path)) byPath.set(entry.path, entry);
  }
  return [...byPath.values()];
}

/**
 * React Router static route discovery.
 *
 * Most CRA/Vite + React Router SPAs declare their routes in JSX, not in
 * filesystem layout. This module scans `.jsx`/`.tsx`/`.js`/`.ts` files for
 * declarations like:
 *
 *   <Route path="..." element={<Component/>} />
 *   <Route path="..." component={Component} />
 *   <PublicRoute exact path="..." component={Component} />
 *   <PrivateRoute path="..." component={Component} />
 *
 * For each declared path it:
 *   1. Materializes named-param placeholders (`:insuranceType` → sample value).
 *   2. Resolves the referenced component name back to a real source file
 *      via static-import / dynamic-import scanning in the same file.
 *
 * Returns: Array<{ path, source, dynamic, params, originFile, framework: 'react-router' }>
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const JSX_FILE_RE = /\.(jsx|tsx|js|ts)$/i;
const ROUTE_DECL_RE =
  /<\s*(?:Public|Private|Protected|Auth|Guarded|Module|Lazy)?Route\b([^>]*?)(?:\/\s*>|>)/gs;
const PATH_ATTR_RE = /\bpath\s*=\s*(['"])([^'"]+?)\1/;
const ELEMENT_JSX_RE = /\belement\s*=\s*\{\s*<\s*(\w+)/;
const COMPONENT_NAMED_RE = /\bcomponent\s*=\s*\{?\s*(\w+)/;
const STATIC_NAMED_IMPORT_RE = /import\s+\{([^}]+)\}\s+from\s+(['"])([^'"]+)\2/g;
const DEFAULT_IMPORT_RE = /import\s+(\w+)(?:\s*,\s*\{[^}]*\})?\s+from\s+(['"])([^'"]+)\2/g;
const LAZY_IMPORT_RE = /(?:const|let|var)\s+(\w+)\s*=\s*(?:React\.)?(?:lazy|ReactLazyPreload|loadable)\s*\(\s*\(?\s*\)?\s*=>\s*import\s*\(\s*(['"])([^'"]+)\2\s*\)/g;

const PAGE_LIKE_DIRS = [
  "src/Pages",
  "src/pages",
  "src/Routes",
  "src/routes",
  "app/routes",
  "app/Pages",
];

const PARAM_SAMPLE_MAP = {
  lang: "en",
  language: "en",
  locale: "en",
  insuranceType: "motor-insurance",
  channel: "main",
  slug: "sample",
  id: "1",
  uuid: "00000000-0000-0000-0000-000000000000",
  productId: "1",
  product: "sample",
  category: "sample",
  type: "sample",
};

function isJsxFile(file) {
  return JSX_FILE_RE.test(file);
}

function pageLikePath(file) {
  return PAGE_LIKE_DIRS.some((dir) => file.startsWith(dir + "/"));
}

function paramSample(name) {
  const bare = name.replace(/\?$/, "");
  return PARAM_SAMPLE_MAP[bare] || "sample";
}

/**
 * Substitute `:name` and `:name?` placeholders with sample values.
 * Optional params (`:lang?`) collapse to empty when no specific sample matches.
 */
export function expandRoutePath(raw) {
  const params = [];
  const expanded = raw.replace(/:(\w+\??)/g, (_, name) => {
    const bare = name.replace(/\?$/, "");
    params.push(bare);
    // Optional params collapse to the canonical URL (no value emitted).
    // Real walkers can override per-route via fixture or env var.
    if (name.endsWith("?")) return "";
    return paramSample(name);
  });
  const cleaned =
    `/${expanded.replace(/^\/+/, "")}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  return { path: cleaned, params, dynamic: params.length > 0 };
}

export function joinPaths(parent, child) {
  if (!parent) return child;
  if (!child) return parent;
  if (child.startsWith("/")) return child;
  return `${parent.replace(/\/$/, "")}/${child.replace(/^\/+/, "")}`;
}

// Stack-based scanner that respects JSX nesting: a child <Route path="x"/>
// inside <Route path="/:lang?"> inherits the parent prefix → /:lang?/x.
//
// We can't use a single regex because attributes contain JSX expressions
// like `element={<Dashboard/>}` whose internal `>` would close the regex
// prematurely. So we walk the source character by character finding tag
// openings, then advance to the next *unbalanced* `>` to capture the full
// tag body.
const ROUTE_TAG_PREFIX_RE =
  /^(\/?)\s*((?:Public|Private|Protected|Auth|Guarded|Module|Lazy)?Route)\b/;

function combineWithParents(stack, childPath) {
  const segments = [];
  for (const frame of stack) {
    if (frame.path) segments.push(frame.path.replace(/^\/+|\/+$/g, ""));
  }
  if (childPath) segments.push(childPath.replace(/^\/+|\/+$/g, ""));
  const joined = segments.filter(Boolean).join("/");
  if (!joined) return childPath?.startsWith("/") ? "/" : childPath || "";
  return `/${joined}`;
}

/**
 * Walk forward from `start` (immediately after `<`) to the next `>` that
 * isn't inside a balanced JSX expression `{...}` or a string literal.
 */
function findTagEnd(source, start) {
  let i = start;
  let braces = 0;
  let inString = false;
  let stringChar = null;
  while (i < source.length) {
    const c = source[i];
    if (inString) {
      if (c === stringChar && source[i - 1] !== "\\") {
        inString = false;
        stringChar = null;
      }
    } else if (c === '"' || c === "'" || c === "`") {
      inString = true;
      stringChar = c;
    } else if (c === "{") {
      braces++;
    } else if (c === "}") {
      if (braces > 0) braces--;
    } else if (c === ">" && braces === 0) {
      return i;
    }
    i++;
  }
  return -1;
}

export function parseRouteDeclarations(source) {
  const out = [];
  const stack = [];
  let i = 0;
  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt === -1) break;
    const after = source.slice(lt + 1);
    const tagHead = ROUTE_TAG_PREFIX_RE.exec(after);
    if (!tagHead) {
      i = lt + 1;
      continue;
    }
    const tagEnd = findTagEnd(source, lt + 1 + tagHead[0].length);
    if (tagEnd === -1) break;
    const tag = source.slice(lt, tagEnd + 1);
    const isClosing = tagHead[1] === "/";
    const isSelfClosing = !isClosing && tag.endsWith("/>");

    if (isClosing) {
      stack.pop();
      i = tagEnd + 1;
      continue;
    }

    const attrs = tag.slice(1 + tagHead[0].length, isSelfClosing ? -2 : -1);
    const pathMatch = PATH_ATTR_RE.exec(attrs);
    const rawPath = pathMatch ? pathMatch[2] : "";
    const componentMatch = ELEMENT_JSX_RE.exec(attrs) || COMPONENT_NAMED_RE.exec(attrs);
    const componentName = componentMatch ? componentMatch[1] : null;

    const inheritedPath = combineWithParents(stack, rawPath);
    const isCatchAll =
      !inheritedPath || rawPath === "*" || inheritedPath === "/*" || inheritedPath.endsWith("/*");
    if (componentName && !isCatchAll) {
      out.push({ rawPath: inheritedPath, componentName });
    }

    if (!isSelfClosing) {
      stack.push({ path: rawPath });
    }
    i = tagEnd + 1;
  }
  return out;
}

export function buildImportMap(source) {
  const map = new Map();
  let m;

  DEFAULT_IMPORT_RE.lastIndex = 0;
  while ((m = DEFAULT_IMPORT_RE.exec(source)) !== null) map.set(m[1], m[3]);

  STATIC_NAMED_IMPORT_RE.lastIndex = 0;
  while ((m = STATIC_NAMED_IMPORT_RE.exec(source)) !== null) {
    const importPath = m[3];
    for (const piece of m[1].split(",")) {
      const name = piece.trim().split(/\s+as\s+/)[0].trim();
      if (name && !map.has(name)) map.set(name, importPath);
    }
  }

  LAZY_IMPORT_RE.lastIndex = 0;
  while ((m = LAZY_IMPORT_RE.exec(source)) !== null) map.set(m[1], m[3]);

  return map;
}

export function resolveImportToFile(originFile, importPath, allFiles) {
  if (!importPath.startsWith(".") && !importPath.startsWith("/")) return null;
  const fileSet = allFiles instanceof Set ? allFiles : new Set(allFiles);
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(originFile), importPath)
  );
  const candidates = [
    base,
    ...["jsx", "tsx", "js", "ts", "vue", "svelte", "astro"].map((ext) => `${base}.${ext}`),
    ...["jsx", "tsx", "js", "ts"].map((ext) => `${base}/index.${ext}`),
  ];
  for (const candidate of candidates) {
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

function readFileSafe(repoRoot, file) {
  try {
    return readFileSync(path.join(repoRoot, file), "utf8");
  } catch {
    return null;
  }
}

function listCandidateFiles(files) {
  return files.filter(
    (file) =>
      isJsxFile(file) &&
      !file.includes("node_modules/") &&
      !/\.(test|spec)\.[jt]sx?$/i.test(file)
  );
}

/**
 * Walk JSX files, extract <Route> declarations, resolve the page-component
 * name back to its source file, and emit one journey per discovered path.
 */
export function discoverReactRouterJourneys(files, repoRoot) {
  if (!repoRoot) return [];
  const candidates = listCandidateFiles(files);
  const fileSet = new Set(files);
  const results = [];

  for (const file of candidates) {
    const source = readFileSafe(repoRoot, file);
    if (!source) continue;
    if (!source.includes("<Route") && !source.includes("path=")) continue;

    const declarations = parseRouteDeclarations(source);
    if (!declarations.length) continue;

    const imports = buildImportMap(source);

    for (const decl of declarations) {
      // `<Route path="..."/>` declarations without an element/component are
      // layout wrappers (e.g. `<Route path="/:lang?">...</Route>`) — skip
      // those, otherwise we emit fake journeys like `/en` for the wrapper.
      if (!decl.componentName) continue;
      const expanded = expandRoutePath(decl.rawPath);
      let sourceFile = file;
      if (imports.has(decl.componentName)) {
        const resolved = resolveImportToFile(file, imports.get(decl.componentName), fileSet);
        if (resolved) sourceFile = resolved;
      }
      results.push({
        path: expanded.path,
        rawPath: decl.rawPath,
        source: sourceFile,
        originFile: file,
        dynamic: expanded.dynamic,
        params: expanded.params,
        componentName: decl.componentName || null,
        framework: "react-router",
      });
    }
  }

  const byPath = new Map();
  for (const entry of results) {
    const existing = byPath.get(entry.path);
    if (!existing) {
      byPath.set(entry.path, entry);
      continue;
    }
    if (pageLikePath(entry.source) && !pageLikePath(existing.source)) {
      byPath.set(entry.path, entry);
    }
  }
  return [...byPath.values()];
}

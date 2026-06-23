/**
 * Backend HTTP route discovery for Express / Fastify / Koa / generic
 * Node HTTP servers. Picks up declarations like:
 *
 *   app.get('/users', handler)
 *   router.post('/orders/:id', handler)
 *   fastify.put('/login', handler)
 *
 * Used to:
 *   - flip `hasApi=true` when no OpenAPI spec exists, so the Postman/k6
 *     stages auto-enable
 *   - seed the Postman bootstrap collection with real endpoints
 *
 * Returns: Array<{ method, path, source, originFile, dynamic, params, framework: 'express' }>
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { expandRoutePath } from "./journeysReactRouter.js";

const SERVER_FILE_PATTERNS = [
  /^server\.(js|ts|mjs)$/i,
  /^src\/server\.(js|ts|mjs)$/i,
  /^src\/index\.(js|ts|mjs)$/i,
  /^src\/app\.(js|ts|mjs)$/i,
  /(^|\/)routes\/.+\.(js|ts|mjs)$/i,
  /(^|\/)controllers\/.+\.(js|ts|mjs)$/i,
  /(^|\/)api\/.+\.(js|ts|mjs)$/i,
];

const HTTP_VERBS = ["get", "post", "put", "patch", "delete", "head", "options", "all"];
const ROUTE_CALL_RE = new RegExp(
  `\\b(?:app|router|fastify|server|api|route|controller)\\.(${HTTP_VERBS.join("|")})\\s*\\(\\s*(['"\`])([^'"\`]+?)\\2`,
  "gi"
);

function looksLikeServerFile(file) {
  if (file.includes("node_modules/")) return false;
  if (/\.(test|spec)\.[jt]s$/i.test(file)) return false;
  return SERVER_FILE_PATTERNS.some((re) => re.test(file));
}

function readFileSafe(repoRoot, file) {
  try {
    return readFileSync(path.join(repoRoot, file), "utf8");
  } catch {
    return null;
  }
}

export function parseHttpRouteCalls(source) {
  const out = [];
  ROUTE_CALL_RE.lastIndex = 0;
  let m;
  while ((m = ROUTE_CALL_RE.exec(source)) !== null) {
    const method = m[1].toUpperCase();
    out.push({ method: method === "ALL" ? "GET" : method, rawPath: m[3] });
  }
  return out;
}

export function discoverBackendJourneys(files, repoRoot) {
  if (!repoRoot) return [];
  const candidates = files.filter(looksLikeServerFile);
  const results = [];
  for (const file of candidates) {
    const source = readFileSafe(repoRoot, file);
    if (!source) continue;
    for (const call of parseHttpRouteCalls(source)) {
      const expanded = expandRoutePath(call.rawPath);
      results.push({
        method: call.method,
        path: expanded.path,
        rawPath: call.rawPath,
        source: file,
        originFile: file,
        dynamic: expanded.dynamic,
        params: expanded.params,
        framework: "express",
      });
    }
  }
  const byKey = new Map();
  for (const entry of results) {
    const key = `${entry.method} ${entry.path}`;
    if (!byKey.has(key)) byKey.set(key, entry);
  }
  return [...byKey.values()];
}

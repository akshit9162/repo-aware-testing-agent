import { readFileSync } from "node:fs";
import path from "node:path";

const API_FILE_RE = /\.(js|jsx|ts|tsx)$/;
const APP_ROUTE_RE = /^app\/api\/.*\/route\.(ts|js)$/;
const METHOD_ORDER = ["POST", "PUT", "PATCH", "DELETE", "GET"];

function cleanSegment(segment) {
  if (!segment || segment === "route" || segment === "index") return "";
  if (segment.startsWith("[[...") && segment.endsWith("]]")) return "sample";
  if (segment.startsWith("[...") && segment.endsWith("]")) return "sample";
  if (segment.startsWith("[") && segment.endsWith("]")) return "sample";
  return segment;
}

function routePath(segments) {
  return `/${segments.map(cleanSegment).filter(Boolean).join("/")}`.replace(/\/+/g, "/");
}

function fromPagesApi(file) {
  if (!file.startsWith("pages/api/") || !API_FILE_RE.test(file)) return null;
  const withoutExt = file.replace(API_FILE_RE, "");
  return routePath(["api", ...withoutExt.split("/").slice(2)]);
}

function fromAppApi(file) {
  if (!file.startsWith("app/api/") || !file.match(/\/route\.(js|ts)$/)) return null;
  return routePath(["api", ...file.split("/").slice(2, -1)]);
}

function fromSrcApi(file) {
  if (!file.match(/^src\/(api|routes|controllers)\//) || !API_FILE_RE.test(file)) return null;
  const withoutExt = file.replace(API_FILE_RE, "");
  return routePath(withoutExt.split("/").slice(1));
}

function nameFromPath(path) {
  if (path === "/api") return "API root";
  return path.replace(/^\//, "").replaceAll("/", " > ").replaceAll("-", " ");
}

function envNameForEndpoint(path) {
  const name = path.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  return `QA_API_${name || "ROOT"}`;
}

function detectMethodFromAppRouter(repoRoot, file) {
  try {
    const content = readFileSync(path.join(repoRoot, file), "utf8");
    for (const method of METHOD_ORDER) {
      const re = new RegExp(`export\\s+(async\\s+)?(function|const|let|var)\\s+${method}\\b`);
      if (re.test(content)) return method;
    }
  } catch {
    // ignore — fall back to GET
  }
  return "GET";
}

export function discoverApiEndpoints(files, options = {}) {
  const repoRoot = options.repoRoot;
  const endpoints = new Map();

  for (const file of files) {
    const routePath = fromPagesApi(file) || fromAppApi(file) || fromSrcApi(file);
    if (!routePath) continue;

    let method = "GET";
    if (repoRoot && APP_ROUTE_RE.test(file)) {
      method = detectMethodFromAppRouter(repoRoot, file);
    }

    endpoints.set(routePath, {
      name: nameFromPath(routePath),
      method,
      path: routePath,
      env: envNameForEndpoint(routePath),
      source: file,
      dynamic: routePath.includes("sample"),
    });
  }

  if (!endpoints.size) {
    endpoints.set("/health", {
      name: "Health check",
      method: "GET",
      path: "/health",
      env: "QA_API_HEALTH",
      source: "default",
      dynamic: false,
    });
  }

  return [...endpoints.values()].sort((a, b) => a.path.localeCompare(b.path));
}

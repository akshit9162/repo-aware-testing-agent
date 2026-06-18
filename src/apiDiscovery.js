import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const API_FILE_RE = /\.(js|jsx|ts|tsx)$/;
const APP_ROUTE_RE = /^app\/api\/.*\/route\.(ts|js)$/;
const METHOD_ORDER = ["POST", "PUT", "PATCH", "DELETE", "GET"];

export function cleanSource(source) {
  let result = "";
  let i = 0;
  while (i < source.length) {
    if (source[i] === "/" && source[i + 1] === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n" && source[i] !== "\r") {
        i++;
      }
    } else if (source[i] === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        i++;
      }
      i += 2;
    } else if (source[i] === '"') {
      i++;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\") i++;
        i++;
      }
      i++;
    } else if (source[i] === "'") {
      i++;
      while (i < source.length && source[i] !== "'") {
        if (source[i] === "\\") i++;
        i++;
      }
      i++;
    } else if (source[i] === "`") {
      i++;
      while (i < source.length && source[i] !== "`") {
        if (source[i] === "\\") i++;
        i++;
      }
      i++;
    } else {
      result += source[i];
      i++;
    }
  }
  return result;
}

export function parseExports(source) {
  const clean = cleanSource(source);
  const tokens = [];
  const tokenRegex = /[a-zA-Z_$][a-zA-Z0-9_$]*|[{}(),;=]/g;
  let match;
  while ((match = tokenRegex.exec(clean)) !== null) {
    tokens.push(match[0]);
  }

  const exportedNames = new Set();
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i] === "export") {
      i++;
      if (i >= tokens.length) break;

      if (tokens[i] === "{") {
        i++;
        while (i < tokens.length && tokens[i] !== "}") {
          let localName = tokens[i];
          i++;
          if (i < tokens.length && tokens[i] === "as") {
            i++;
            if (i < tokens.length) {
              exportedNames.add(tokens[i]);
              i++;
            }
          } else {
            exportedNames.add(localName);
          }
          if (i < tokens.length && tokens[i] === ",") {
            i++;
          }
        }
        if (i < tokens.length && tokens[i] === "}") {
          i++;
        }
      } else {
        if (tokens[i] === "async") {
          i++;
        }
        if (i < tokens.length && tokens[i] === "function") {
          i++;
          if (i < tokens.length) {
            exportedNames.add(tokens[i]);
            i++;
          }
        } else if (i < tokens.length && (tokens[i] === "const" || tokens[i] === "let" || tokens[i] === "var")) {
          i++;
          while (i < tokens.length) {
            exportedNames.add(tokens[i]);
            i++;
            while (i < tokens.length && tokens[i] !== "," && tokens[i] !== ";" && tokens[i] !== "export" && tokens[i] !== "const" && tokens[i] !== "let" && tokens[i] !== "var" && tokens[i] !== "function" && tokens[i] !== "class") {
              i++;
            }
            if (i < tokens.length && tokens[i] === ",") {
              i++;
            } else {
              break;
            }
          }
        }
      }
    } else {
      i++;
    }
  }
  return exportedNames;
}

export function loadFixtures(repoRoot) {
  if (!repoRoot) return null;
  const fixturePath = path.join(repoRoot, "qa-fixtures.json");
  if (existsSync(fixturePath)) {
    try {
      return JSON.parse(readFileSync(fixturePath, "utf8"));
    } catch {
      // ignore
    }
  }
  return null;
}

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
    const exported = parseExports(content);
    for (const method of METHOD_ORDER) {
      if (exported.has(method)) return method;
    }
  } catch {
    // ignore — fall back to GET
  }
  return "GET";
}

export function discoverApiEndpoints(files, options = {}) {
  const repoRoot = options.repoRoot;
  const endpoints = new Map();
  const fixtures = loadFixtures(repoRoot);

  for (const file of files) {
    const routePath = fromPagesApi(file) || fromAppApi(file) || fromSrcApi(file);
    if (!routePath) continue;

    let finalRoute = routePath;
    if (fixtures?.api?.[routePath]) {
      finalRoute = fixtures.api[routePath];
    }

    let method = "GET";
    if (repoRoot && APP_ROUTE_RE.test(file)) {
      method = detectMethodFromAppRouter(repoRoot, file);
    }

    endpoints.set(finalRoute, {
      name: nameFromPath(finalRoute),
      method,
      path: finalRoute,
      env: envNameForEndpoint(finalRoute),
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

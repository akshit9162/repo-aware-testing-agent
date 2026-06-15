const API_FILE_RE = /\.(js|jsx|ts|tsx)$/;

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

export function discoverApiEndpoints(files) {
  const endpoints = new Map();

  for (const file of files) {
    const path = fromPagesApi(file) || fromAppApi(file) || fromSrcApi(file);
    if (!path) continue;
    endpoints.set(path, {
      name: nameFromPath(path),
      method: "GET",
      path,
      env: envNameForEndpoint(path),
      source: file,
      dynamic: path.includes("sample"),
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

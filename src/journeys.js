import { loadFixtures } from "./apiDiscovery.js";

const ROUTE_FILE_RE = /\.(js|jsx|ts|tsx)$/;
const ROUTE_PARAM_SAMPLE = "sample";

function cleanSegment(segment) {
  if (!segment || segment.startsWith("_")) return "";
  if (segment.startsWith("(") && segment.endsWith(")")) return "";
  if (segment.startsWith("@")) return "";
  if (segment === "index" || segment === "page") return "";
  if (segment.startsWith("[[...") && segment.endsWith("]]")) return ROUTE_PARAM_SAMPLE;
  if (segment.startsWith("[...") && segment.endsWith("]")) return ROUTE_PARAM_SAMPLE;
  if (segment.startsWith("[") && segment.endsWith("]")) return ROUTE_PARAM_SAMPLE;
  return segment;
}

function routeFromSegments(segments) {
  const path = segments.map(cleanSegment).filter(Boolean).join("/");
  return `/${path}`.replace(/\/+/g, "/");
}

function envNameForRoute(route) {
  if (route === "/") return "QA_ROUTE_HOME";
  const name = route
    .replaceAll(ROUTE_PARAM_SAMPLE, "PARAM")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return `QA_ROUTE_${name || "HOME"}`;
}

function titleForRoute(route) {
  if (route === "/") return "home";
  return route.replace(/^\//, "").replaceAll("/", " > ").replaceAll("-", " ");
}

function fromNextAppRoute(file) {
  if (!file.startsWith("app/") || !file.match(/\/page\.(js|jsx|ts|tsx)$/)) return null;
  return routeFromSegments(file.split("/").slice(1, -1));
}

function fromNextPagesRoute(file) {
  if (!file.startsWith("pages/") || !ROUTE_FILE_RE.test(file) || file.startsWith("pages/api/")) return null;
  const withoutExt = file.replace(ROUTE_FILE_RE, "");
  const segments = withoutExt.split("/").slice(1);
  if (segments.some((segment) => segment.startsWith("_"))) return null;
  return routeFromSegments(segments);
}

function fromSrcPagesRoute(file) {
  if (!file.match(/^src\/(pages|routes)\//) || !ROUTE_FILE_RE.test(file)) return null;
  const withoutExt = file.replace(ROUTE_FILE_RE, "");
  return routeFromSegments(withoutExt.split("/").slice(2));
}

export function discoverUserJourneys(files, options = {}) {
  const routes = new Map();
  const fixtures = loadFixtures(options.repoRoot);

  for (const file of files) {
    const route = fromNextAppRoute(file) || fromNextPagesRoute(file) || fromSrcPagesRoute(file);
    if (!route) continue;

    let finalRoute = route;
    if (fixtures?.routes?.[route]) {
      finalRoute = fixtures.routes[route];
    }

    routes.set(finalRoute, {
      title: titleForRoute(finalRoute),
      path: finalRoute,
      env: envNameForRoute(finalRoute),
      source: file,
      dynamic: route.includes(ROUTE_PARAM_SAMPLE),
    });
  }

  if (!routes.has("/")) {
    routes.set("/", {
      title: "home",
      path: "/",
      env: "QA_ROUTE_HOME",
      source: "default",
      dynamic: false,
    });
  }

  return [...routes.values()].sort((a, b) => a.path.localeCompare(b.path));
}

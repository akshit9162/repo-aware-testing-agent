import { loadFixtures } from "./apiDiscovery.js";
import { discoverReactRouterJourneys } from "./journeysReactRouter.js";
import { discoverVueRouterJourneys } from "./journeysVueRouter.js";
import { discoverBackendJourneys } from "./journeysBackend.js";
import { discoverFileBasedRoute } from "./journeysFileBased.js";

const ROUTE_FILE_RE = /\.(js|jsx|ts|tsx)$/;
const ROUTE_PARAM_SAMPLE = "sample";
// Lowercase only — `src/pages/` / `src/routes/` map filesystem layout to URLs
// (Next.js, Vite SPA convention). Capitalized variants (`src/Pages/`) belong
// to CRA-style projects where layout DOES NOT map to URLs (components share
// the dir, routes are declared in JSX); those are handled by the React Router
// scanner instead.
const SRC_ROUTING_DIR_RE = /^src\/(pages|routes)\//;

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
  const out = segments.map(cleanSegment).filter(Boolean).join("/");
  return `/${out}`.replace(/\/+/g, "/");
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
  if (!SRC_ROUTING_DIR_RE.test(file) || !ROUTE_FILE_RE.test(file)) return null;
  const withoutExt = file.replace(ROUTE_FILE_RE, "");
  return routeFromSegments(withoutExt.split("/").slice(2));
}

function entryFor(finalRoute, info) {
  return {
    ...info,
    path: finalRoute,
    title: titleForRoute(finalRoute),
    env: envNameForRoute(finalRoute),
    source: info.source ?? "default",
    dynamic: Boolean(info.dynamic),
  };
}

function preferStrongerEntry(existing, incoming) {
  // Prefer entries with a real (non-default) source.
  if (existing.source === "default" && incoming.source && incoming.source !== "default") {
    return incoming;
  }
  // Prefer entries with more provenance (componentName / framework / params).
  const existingScore = (existing.componentName ? 1 : 0) + (existing.framework ? 1 : 0);
  const incomingScore = (incoming.componentName ? 1 : 0) + (incoming.framework ? 1 : 0);
  if (incomingScore > existingScore) return incoming;
  return existing;
}

/**
 * Discover user journeys via file-path-based routing, then augment with
 * JSX-declared routes (React Router, Vue Router). Every scanner is
 * best-effort; failures are silent.
 */
export function discoverUserJourneys(files, options = {}) {
  const routes = new Map();
  const fixtures = loadFixtures(options.repoRoot);

  function addRoute(rawPath, info) {
    let finalRoute = rawPath;
    if (fixtures?.routes?.[rawPath]) finalRoute = fixtures.routes[rawPath];
    if (!finalRoute || finalRoute === "*") return;
    const incoming = entryFor(finalRoute, info);
    if (!routes.has(finalRoute)) {
      routes.set(finalRoute, incoming);
      return;
    }
    routes.set(finalRoute, preferStrongerEntry(routes.get(finalRoute), incoming));
  }

  // Layer 1 — file-path-based routing.
  // Order matters: more specific patterns first (Remix's `app/routes/`
  // beats Next's `app/`), then framework-generic conventions.
  for (const file of files) {
    const route =
      fromNextAppRoute(file)
      || fromNextPagesRoute(file)
      || fromSrcPagesRoute(file)
      || discoverFileBasedRoute(file); // SvelteKit / Remix / Astro
    if (!route) continue;
    addRoute(route, {
      source: file,
      dynamic: route.includes(ROUTE_PARAM_SAMPLE) || /:[a-z]/i.test(route),
    });
  }

  // Layer 2 — React Router JSX declarations
  if (options.repoRoot) {
    for (const journey of discoverReactRouterJourneys(files, options.repoRoot)) {
      addRoute(journey.path, {
        source: journey.source,
        dynamic: journey.dynamic,
        params: journey.params,
        framework: journey.framework,
        rawPath: journey.rawPath,
        componentName: journey.componentName,
      });
    }
  }

  // Layer 3 — Vue Router config
  if (options.repoRoot) {
    for (const journey of discoverVueRouterJourneys(files, options.repoRoot)) {
      addRoute(journey.path, {
        source: journey.source,
        dynamic: journey.dynamic,
        params: journey.params,
        framework: journey.framework,
        rawPath: journey.rawPath,
        componentName: journey.componentName,
      });
    }
  }

  // Layer 4 — fixture-declared additions
  if (fixtures?.routes) {
    for (const [from, to] of Object.entries(fixtures.routes)) {
      if (!routes.has(to)) addRoute(to, { source: "fixture", dynamic: false });
      if (!routes.has(from) && from !== to) addRoute(from, { source: "fixture", dynamic: false });
    }
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

export function discoverBackendEndpoints(files, repoRoot) {
  return discoverBackendJourneys(files, repoRoot);
}

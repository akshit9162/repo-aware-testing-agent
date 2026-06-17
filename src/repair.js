/**
 * LLM-driven test repair. Given a failed Playwright run, find tests that
 * failed because their assertions no longer match the live DOM, then re-enrich
 * those routes against the current HTML and write fresh assertions back into
 * the LLM cache (and optionally into the spec file).
 *
 * Pairs naturally with the live-DOM enrichment flow: when staging changes its
 * markup, `repair` reads the failure report, asks Claude/GPT what assertions
 * fit the new DOM, and the next agent run picks up the corrected expectations.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { enrichJourneys } from "./llmEnrich.js";

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_HTML_CHARS = 20_000;

const LOCATOR_ERROR_RE = /(toBeVisible|toContainText|toHaveText|toHaveAttribute|getByRole|getByText|getByLabel|getByTestId|locator|not found|did not match|Element is not visible|Element is hidden)/i;

function envForRoute(route) {
  if (route === "/") return "QA_ROUTE_HOME";
  const slug = route.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  return "QA_ROUTE_" + (slug || "HOME");
}

/**
 * "journey: home"                       → "/"
 * "journey: blog > category > sample"   → "/blog/category/sample"
 * "journey: articles > sample"          → "/articles/sample"
 * Returns null if the title isn't a journey case.
 */
export function extractRouteFromTitle(title) {
  const match = /journey:\s*(.+)$/i.exec(title || "");
  if (!match) return null;
  const tail = match[1].trim();
  if (tail.toLowerCase() === "home") return "/";
  const segments = tail.split(">").map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return "/";
  return "/" + segments.join("/");
}

function isLocatorFailure(test) {
  const errors = (test.results || []).flatMap((r) => r.errors || []);
  return errors.some((error) => LOCATOR_ERROR_RE.test(error.message || ""));
}

function walkSuites(suites, accumulator, parentTitles = []) {
  for (const suite of suites || []) {
    const titles = [...parentTitles, suite.title].filter(Boolean);
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        const status = (test.results || [])[0]?.status;
        if (status !== "failed") continue;
        if (!isLocatorFailure(test)) continue;
        const route = extractRouteFromTitle(spec.title);
        if (!route) continue;
        accumulator.push({
          route,
          title: [...titles, spec.title].filter(Boolean).join(" > "),
          file: spec.file || "",
        });
      }
    }
    walkSuites(suite.suites, accumulator, titles);
  }
}

async function fetchHtml(url, { timeoutMs = DEFAULT_TIMEOUT_MS, maxChars = DEFAULT_MAX_HTML_CHARS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "user-agent": "repo-qa-agent/repair" },
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
    const html = await response.text();
    return html.length > maxChars ? html.slice(0, maxChars) : html;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Surgically replace the ENRICHED constant in a generated journey spec file
 * with `newMap`. Falls back to a no-op if the spec doesn't have the marker.
 * Returns { rewrote: bool, replaced: number }.
 */
export async function patchEnrichedBlock(specPath, newMap) {
  let content;
  try {
    content = await fs.readFile(specPath, "utf8");
  } catch {
    return { rewrote: false, reason: "spec file not found" };
  }
  const start = content.indexOf("const ENRICHED = ");
  if (start < 0) return { rewrote: false, reason: "ENRICHED marker not found" };
  // Find the matching closing brace by walking depth.
  const openBrace = content.indexOf("{", start);
  if (openBrace < 0) return { rewrote: false, reason: "ENRICHED opening brace not found" };
  let depth = 0;
  let end = -1;
  for (let i = openBrace; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end < 0) return { rewrote: false, reason: "ENRICHED block unterminated" };

  // Parse the existing block so we can merge route-level changes (preserves
  // routes the repair didn't touch).
  let existing = {};
  try {
    existing = JSON.parse(content.slice(openBrace, end));
  } catch {
    // continue with empty existing — repair just adds new routes.
  }
  const merged = { ...existing };
  for (const [route, value] of Object.entries(newMap)) {
    merged[route] = value;
  }
  const rendered = JSON.stringify(merged, null, 2);
  const next = content.slice(0, openBrace) + rendered + content.slice(end);
  await fs.writeFile(specPath, next, "utf8");
  return { rewrote: true, replaced: Object.keys(newMap).length, total: Object.keys(merged).length };
}

/**
 * Repair failing journey assertions from a Playwright results.json.
 *
 *   repair({ resultsPath, repoRoot, baseUrl, apply: true })
 *
 * Returns:
 *   { failures, repaired: { route, oldAssertions?, newAssertions }[],
 *     stats: enrichment stats from llmEnrich,
 *     patched: bool, patchedPath?: string }
 */
export async function repair({
  resultsPath,
  repoRoot,
  baseUrl,
  apply = false,
  specPath = "tests/e2e/user-journeys.spec.ts",
  client,
  logger = () => {},
} = {}) {
  if (!resultsPath) throw new Error("repair: resultsPath is required");
  if (!repoRoot) throw new Error("repair: repoRoot is required");
  if (!baseUrl) throw new Error("repair: baseUrl is required to fetch live DOM");

  const results = JSON.parse(await fs.readFile(resultsPath, "utf8"));
  const failures = [];
  walkSuites(results.suites, failures);

  const uniqueRoutes = [...new Set(failures.map((f) => f.route))];
  logger(`found ${failures.length} locator failures across ${uniqueRoutes.length} unique route(s)`);

  const journeys = [];
  for (const route of uniqueRoutes) {
    try {
      const url = new URL(route === "/" ? "" : route, baseUrl).toString();
      const html = await fetchHtml(url);
      journeys.push({
        path: route,
        title: route === "/" ? "home" : route.replace(/^\//, "").replaceAll("/", " > "),
        env: envForRoute(route),
        html,
        source: "repair",
        dynamic: route.includes("sample"),
      });
    } catch (error) {
      logger(`fetch failed for ${route}: ${error instanceof Error ? error.message : error}`);
    }
  }

  if (!journeys.length) {
    return { failures: failures.length, repaired: [], stats: null, patched: false };
  }

  const { enriched, stats } = await enrichJourneys({
    repoRoot,
    journeys,
    client,
    logger: (msg) => logger("[llm-enrich] " + msg),
  });

  const repaired = [...enriched.entries()].map(([route, value]) => ({
    route,
    newAssertions: value.expected || [],
    description: value.description,
  }));

  let patched = false;
  let patchedPath = null;
  if (apply && enriched.size) {
    const fullSpecPath = path.join(repoRoot, specPath);
    const newMap = Object.fromEntries(enriched);
    const patchResult = await patchEnrichedBlock(fullSpecPath, newMap);
    patched = patchResult.rewrote;
    patchedPath = patched ? fullSpecPath : null;
    if (patchResult.reason) logger("patch skipped: " + patchResult.reason);
  }

  return { failures: failures.length, repaired, stats, patched, patchedPath };
}

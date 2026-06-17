/**
 * Breadth-first link crawler for route discovery.
 *
 * Uses plain HTTP fetch (no headless browser dependency) to walk the same-origin
 * link graph starting from a base URL. Suited to server-rendered sites (Next.js,
 * static, classical SSR) where links appear in the initial HTML. SPAs that only
 * surface routes after client-side hydration won't be fully covered — that's a
 * Tier B "live-DOM" follow-up.
 *
 * Output: array of { path, title, source: 'crawl', dynamic, foundOn } journey
 * records compatible with the existing journeys pipeline.
 */

const DEFAULT_DEPTH = 2;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CONCURRENCY = 4;

const SKIP_SCHEMES = /^(mailto:|tel:|javascript:|data:|chrome:|about:)/i;
const ASSET_EXT = /\.(png|jpe?g|gif|svg|ico|webp|avif|css|js|mjs|cjs|json|xml|pdf|zip|woff2?|ttf|otf|mp4|webm|mp3|wav)(\?|#|$)/i;

function extractTitle(html) {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (titleMatch) return decodeEntities(titleMatch[1].trim().replace(/\s+/g, " ").slice(0, 120));
  const h1Match = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h1Match) return decodeEntities(h1Match[1].replace(/<[^>]+>/g, "").trim().replace(/\s+/g, " ").slice(0, 120));
  return "";
}

function decodeEntities(text) {
  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'");
}

function extractLinks(html, baseUrl) {
  const hrefRe = /<a\s+[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  const found = new Set();
  let match;
  while ((match = hrefRe.exec(html))) {
    const raw = match[2] ?? match[3] ?? match[4];
    if (!raw || SKIP_SCHEMES.test(raw) || raw.startsWith("#")) continue;
    try {
      const resolved = new URL(raw, baseUrl);
      resolved.hash = "";
      found.add(resolved.toString());
    } catch {
      // ignore unparseable hrefs
    }
  }
  return [...found];
}

function isSameOrigin(candidate, base) {
  try {
    const c = new URL(candidate);
    const b = new URL(base);
    return c.origin === b.origin;
  } catch {
    return false;
  }
}

function normalizePath(urlString) {
  try {
    const url = new URL(urlString);
    let pathname = url.pathname || "/";
    if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
    return pathname;
  } catch {
    return null;
  }
}

function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal, redirect: "follow", headers: { "user-agent": "repo-qa-agent/crawler" } })
    .finally(() => clearTimeout(timer));
}

/**
 * Crawl a site and return a deduped list of discovered journeys.
 *
 *   crawlSite('https://example.com', { depth: 2, maxPages: 50 })
 *     -> [{ path: '/', title: 'Home', source: 'crawl', dynamic: false, foundOn: null }, ...]
 *
 * `logger(msg)` receives one line per visited URL.
 */
export async function crawlSite(baseUrl, {
  depth = DEFAULT_DEPTH,
  maxPages = DEFAULT_MAX_PAGES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  concurrency = DEFAULT_CONCURRENCY,
  logger = () => {},
} = {}) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch (error) {
    throw new Error(`Invalid baseUrl: ${baseUrl} (${error.message})`);
  }
  if (base.pathname === "") base.pathname = "/";

  const discovered = new Map(); // path -> record
  const visitedUrls = new Set();
  const queue = [{ url: base.toString(), level: 0, foundOn: null }];

  while (queue.length && discovered.size < maxPages) {
    const batch = queue.splice(0, concurrency);
    await Promise.all(batch.map(async ({ url, level, foundOn }) => {
      if (visitedUrls.has(url) || discovered.size >= maxPages) return;
      visitedUrls.add(url);

      let response;
      try {
        response = await fetchWithTimeout(url, timeoutMs);
      } catch (error) {
        logger(`fetch failed ${url}: ${error instanceof Error ? error.message : error}`);
        return;
      }
      const finalUrl = response.url || url;
      if (!response.ok) {
        logger(`${response.status} ${finalUrl}`);
        return;
      }
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/html")) {
        logger(`skip non-html (${contentType.split(";")[0]}) ${finalUrl}`);
        return;
      }

      const html = await response.text();
      const path = normalizePath(finalUrl);
      if (!path || ASSET_EXT.test(path)) return;

      if (!discovered.has(path)) {
        discovered.set(path, {
          path,
          title: extractTitle(html),
          source: "crawl",
          dynamic: false,
          foundOn: foundOn || null,
        });
        logger(`200 ${finalUrl} -> ${path}`);
      }

      if (level >= depth) return;

      for (const link of extractLinks(html, finalUrl)) {
        if (!isSameOrigin(link, base.toString())) continue;
        if (visitedUrls.has(link)) continue;
        if (ASSET_EXT.test(new URL(link).pathname || "")) continue;
        queue.push({ url: link, level: level + 1, foundOn: path });
      }
    }));
  }

  return [...discovered.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Merge crawl results into a static-scan journeys array, deduping by path.
 * The static record wins on overlap (it has source-file context for LLM enrichment).
 */
export function mergeJourneys(staticJourneys, crawled) {
  const map = new Map();
  for (const journey of staticJourneys) map.set(journey.path, journey);
  for (const journey of crawled) {
    if (!map.has(journey.path)) map.set(journey.path, journey);
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * File-based route discovery for SvelteKit, Remix, and Astro.
 *
 * Each framework maps filesystem layout to URLs differently:
 *   SvelteKit: src/routes/about/+page.svelte    → /about
 *              src/routes/blog/[slug]/+page.svelte → /blog/:slug
 *   Remix:     app/routes/_index.tsx             → /
 *              app/routes/blog.$slug.tsx         → /blog/:slug
 *              app/routes/blog._index.tsx        → /blog
 *   Astro:     src/pages/index.astro             → /
 *              src/pages/blog/[slug].astro       → /blog/:slug
 */

const SVELTEKIT_PAGE_RE = /^src\/routes\/(.+\/)?\+page\.(svelte|js|ts)$/;
const REMIX_ROUTE_RE = /^app\/routes\/(.+)\.(tsx|jsx|ts|js)$/;
const ASTRO_PAGE_RE = /^src\/pages\/(.+)\.astro$/;

function svelteSegmentToUrl(segment) {
  // SvelteKit conventions:
  //   (group)      → invisible group, skip
  //   [slug]       → :slug
  //   [[slug]]     → :slug? (optional)
  //   [...rest]    → :rest (catch-all)
  if (!segment) return null;
  if (segment.startsWith("(") && segment.endsWith(")")) return null;
  if (segment.startsWith("[[...") && segment.endsWith("]]")) return `:${segment.slice(5, -2)}?`;
  if (segment.startsWith("[...") && segment.endsWith("]")) return `:${segment.slice(4, -1)}`;
  if (segment.startsWith("[[") && segment.endsWith("]]")) return `:${segment.slice(2, -2)}?`;
  if (segment.startsWith("[") && segment.endsWith("]")) return `:${segment.slice(1, -1)}`;
  return segment;
}

function remixSegmentToUrl(segment) {
  // Remix conventions:
  //   _index       → root of its parent group, drop the segment
  //   _layout      → invisible layout, drop
  //   $slug        → :slug
  //   $            → :splat (catch-all)
  //   .            → segment separator (already split)
  if (!segment) return null;
  if (segment === "_index" || segment.startsWith("_")) return null;
  if (segment === "$") return ":splat";
  if (segment.startsWith("$")) return `:${segment.slice(1)}`;
  return segment;
}

function astroSegmentToUrl(segment) {
  if (!segment) return null;
  if (segment === "index") return null;
  if (segment.startsWith("[[...") && segment.endsWith("]]")) return `:${segment.slice(5, -2)}?`;
  if (segment.startsWith("[...") && segment.endsWith("]")) return `:${segment.slice(4, -1)}`;
  if (segment.startsWith("[[") && segment.endsWith("]]")) return `:${segment.slice(2, -2)}?`;
  if (segment.startsWith("[") && segment.endsWith("]")) return `:${segment.slice(1, -1)}`;
  return segment;
}

function joinSegments(segments) {
  const cleaned = segments.filter((s) => s !== null && s !== undefined && s !== "");
  return `/${cleaned.join("/")}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

export function fromSvelteKit(file) {
  const m = SVELTEKIT_PAGE_RE.exec(file);
  if (!m) return null;
  const segments = (m[1] || "").replace(/\/$/, "").split("/").filter(Boolean).map(svelteSegmentToUrl);
  return joinSegments(segments);
}

export function fromRemix(file) {
  const m = REMIX_ROUTE_RE.exec(file);
  if (!m) return null;
  // Remix uses `.` as folder separator in route filenames.
  // _index → /, blog.$slug → /blog/:slug
  const stem = m[1];
  const segments = stem.split(".").map(remixSegmentToUrl);
  return joinSegments(segments);
}

export function fromAstro(file) {
  const m = ASTRO_PAGE_RE.exec(file);
  if (!m) return null;
  const segments = m[1].split("/").map(astroSegmentToUrl);
  return joinSegments(segments);
}

/**
 * Try every file-based scanner in sequence; first hit wins.
 * Returns the URL path string, or null when nothing matches.
 */
export function discoverFileBasedRoute(file) {
  return fromSvelteKit(file) || fromRemix(file) || fromAstro(file);
}

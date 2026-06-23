/**
 * Multi-stage journey clustering and walker autogen.
 *
 * Many apps have flows where several pages chain together (e.g. motor:
 *   /motor-basic-form → /motor-vehicle-info → /motor-best-deals →
 *   /proposer-info → /upload-documents → /motor-summary).
 *
 * This module:
 *   1. Groups routes by URL prefix similarity into "clusters".
 *   2. Orders pages within each cluster by canonical flow keywords
 *      (form/info → confirm → details/best → addons → summary → payment/success).
 *   3. Emits a `tests/helpers/<clusterName>-walker.ts` whose `walkTo(stageId)`
 *      walks the cluster from its entry stage to the requested stage. The
 *      template assumes each stage exposes a `PROCEED` button — a reasonable
 *      default for SPA forms; users override per-stage in fixture or env.
 */

// Canonical flow ordering. Earlier entries fire earlier in the funnel.
// "info" deliberately matches only domain-specific verify/confirm pages —
// it must NOT match generic `*-info` like `proposer-info` (which is the
// "details" stage). "details" patterns are explicit about the personas
// they cover (proposer/traveller/customer) so the cluster ordering for
// motor + travel + ecommerce flows lines up the way humans expect.
const STAGE_KEYWORDS = [
  { tag: "entry", patterns: [/basic-form|landing|start|begin|search/i] },
  { tag: "info", patterns: [/vehicle-info|license-info|\blicense\b|verify|confirm\b/i] },
  { tag: "options", patterns: [/best-deals|quotes?|plans?|\boptions\b|\bselect\b/i] },
  { tag: "addons", patterns: [/addons?|extras?|accessories|valuation/i] },
  { tag: "details", patterns: [/proposer|details?|traveller|customer-info|profile|kyc/i] },
  { tag: "docs", patterns: [/upload|documents?|photos?|attach/i] },
  { tag: "summary", patterns: [/summary|review|preview/i] },
  { tag: "payment", patterns: [/payment(?!-(success|failed))|checkout|pay\b/i] },
  { tag: "success", patterns: [/success|thank-you|complete|confirmation/i] },
  { tag: "failure", patterns: [/failed|error|denied/i] },
];

function tagFor(path) {
  for (const stage of STAGE_KEYWORDS) {
    for (const re of stage.patterns) {
      if (re.test(path)) return stage.tag;
    }
  }
  return null;
}

function stageOrder(tag) {
  return STAGE_KEYWORDS.findIndex((s) => s.tag === tag);
}

function segmentsOf(path) {
  return path.replace(/^\/+/, "").split("/").filter(Boolean);
}

/**
 * Group journeys by the longest stable URL prefix that has ≥2 members.
 * Returns Array<{ prefix, members: journey[], commonSegments: string[] }>
 */
export function clusterJourneys(journeys) {
  const buckets = new Map();
  for (const journey of journeys) {
    if (!journey?.path) continue;
    const segments = segmentsOf(journey.path);
    if (!segments.length) continue;
    // Group by first segment that isn't a sample-substituted param
    const keyDepth = Math.min(segments.length - 1, 2);
    const key = segments.slice(0, Math.max(1, keyDepth)).join("/") || segments[0];
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(journey);
  }

  const clusters = [];
  for (const [prefix, members] of buckets) {
    if (members.length < 2) continue;
    const tagged = members
      .map((journey) => ({ journey, tag: tagFor(journey.path), order: stageOrder(tagFor(journey.path)) }))
      .filter((entry) => entry.tag !== null);
    if (tagged.length < 2) continue;
    tagged.sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.journey.path.localeCompare(b.journey.path);
    });
    clusters.push({
      prefix,
      name: prefix.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
      stages: tagged.map(({ journey, tag }) => ({
        id: journey.path.replace(/^\/+/, "").replaceAll("/", "-"),
        tag,
        path: journey.path,
        source: journey.source,
        forms: journey.forms || [],
      })),
    });
  }
  return clusters;
}

function quoteStr(s) {
  return JSON.stringify(s);
}

/**
 * Emit a Playwright walker helper for a single cluster.
 * The template is intentionally generic: it goes to each stage via direct
 * navigation, then on a stage transition it tries to click a "PROCEED"-like
 * button if present. Per-app overrides live in tests/helpers/walker-overrides.ts.
 */
export function buildWalkerSpec(cluster) {
  const stages = cluster.stages;
  const stageList = stages
    .map((s) => `  { id: ${quoteStr(s.id)}, tag: ${quoteStr(s.tag)}, path: ${quoteStr(s.path)} }`)
    .join(",\n");
  return `import { type Page, expect } from "@playwright/test";
import { urlFor, FIXTURE } from "./journey-fixture.js";

// Auto-generated cluster walker for "${cluster.prefix}". Each stage advances
// to the next via the first visible "PROCEED" button (the SPA-form default).
// Override per-stage behavior in tests/helpers/walker-overrides.ts.

export const STAGES = [
${stageList}
] as const;

export type StageId = (typeof STAGES)[number]["id"];

async function clickPrimaryCta(page: Page) {
  const labels = ["PROCEED", "Proceed", "Continue", "Next", "Submit", "BUY NOW"];
  for (const label of labels) {
    const button = page.getByRole("button", { name: label }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      return;
    }
  }
}

export async function walkTo(page: Page, target: StageId): Promise<void> {
  const targetIdx = STAGES.findIndex((s) => s.id === target);
  if (targetIdx < 0) throw new Error(\`unknown stage: \${target}\`);
  for (let i = 0; i <= targetIdx; i++) {
    const stage = STAGES[i];
    if (i === 0) {
      await page.goto(urlFor(stage.path), { waitUntil: "domcontentloaded" });
    } else {
      await clickPrimaryCta(page);
      // Wait for the URL hint of the new stage to appear (best-effort).
      const next = STAGES[i];
      const hint = next.path.split("/").filter(Boolean).pop() || "";
      if (hint) await expect(page).toHaveURL(new RegExp(hint), { timeout: 30_000 }).catch(() => {});
    }
  }
}
`;
}

/**
 * Decide which clusters are worth emitting walkers for. A cluster qualifies
 * when it has ≥3 staged members AND covers ≥2 distinct stage tags.
 */
export function buildWalkerAssets(journeys) {
  const clusters = clusterJourneys(journeys);
  return clusters
    .filter((c) => c.stages.length >= 3 && new Set(c.stages.map((s) => s.tag)).size >= 2)
    .map((cluster) => ({
      path: `tests/helpers/${cluster.name}-walker.ts`,
      content: buildWalkerSpec(cluster),
      cluster,
    }));
}

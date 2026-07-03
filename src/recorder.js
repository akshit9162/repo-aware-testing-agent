/**
 * Human-seeded recorder.
 *
 * Opens Playwright (headed by default), navigates to a UAT URL, and while
 * a human clicks / types / handles OTP / logs in, the agent captures a
 * DOM snapshot every time the URL changes. Each snapshot is a rich
 * accessibility+forms+buttons dump keyed by URL — the exact context the
 * LLM enrichment step needs to write real selectors instead of guessing.
 *
 * Trade-off: not fully autonomous like `walker.js`, but sidesteps every
 * OTP / captcha / MUI-radio-div / rate-limit blocker we hit trying to
 * fully autopilot. 10 minutes of human time per flow, then infinite
 * automated reuse — the pragmatic path for internal-use agents.
 *
 * Output shape (JSON on disk):
 *   {
 *     "startedAt": "...",
 *     "entryUrl": "...",
 *     "stages": [
 *       {
 *         "step": 0,
 *         "url": "...",
 *         "title": "...",
 *         "fields": [{ label, name, type, placeholder, ariaLabel, required, disabled, options? }],
 *         "buttons": [{ label, role }],
 *         "links":   [{ label, href }],
 *         "headings":[{ level, text }],
 *         "text":    "first N chars of visible text"
 *       },
 *       ...
 *     ]
 *   }
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_IDLE_MS = 800; // wait after URL change before snapshotting
const DEFAULT_MAX_MINUTES = 20;

async function importChromium() {
  const { chromium } = await import("playwright");
  return chromium;
}

/**
 * The evaluator serialized into the browser — captures a richer snapshot
 * than walker.js. Includes labels, roles, headings, and dropdown options
 * so the LLM prompt can pick correct selectors and know what values
 * exist in select boxes.
 */
async function snapshotPage(page) {
  return page.evaluate(() => {
    function visible(el) {
      if (!el) return false;
      if (typeof el.checkVisibility === "function") {
        try {
          return el.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
            opacityProperty: true,
            contentVisibilityAuto: true,
          });
        } catch {}
      }
      const s = window.getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      if (r.right < 0 || r.bottom < 0) return false;
      if (r.left > window.innerWidth || r.top > window.innerHeight) return false;
      return true;
    }
    function accName(el) {
      if (!el) return "";
      const aria = el.getAttribute("aria-label");
      if (aria) return aria.trim();
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const label = document.getElementById(labelledBy);
        if (label) return (label.textContent || "").trim();
      }
      if (el.id) {
        const label = document.querySelector('label[for="' + el.id + '"]');
        if (label) return (label.textContent || "").trim();
      }
      const wrap = el.closest("label");
      if (wrap) return (wrap.textContent || "").trim();
      return "";
    }
    const fields = [];
    for (const el of Array.from(document.querySelectorAll("input, select, textarea, [role='combobox'], [role='textbox']"))) {
      if (!visible(el)) continue;
      const type = (el.getAttribute("type") || el.tagName || "").toLowerCase();
      if (type === "hidden" || type === "submit" || type === "button") continue;
      const field = {
        label: accName(el),
        name: el.getAttribute("name") || "",
        placeholder: el.getAttribute("placeholder") || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        type,
        role: el.getAttribute("role") || "",
        required: el.required === true || el.getAttribute("aria-required") === "true",
        disabled: el.disabled === true,
      };
      if (el.tagName === "SELECT") {
        field.options = Array.from(el.querySelectorAll("option"))
          .filter((o) => o.value)
          .map((o) => ({ value: o.value, label: (o.textContent || "").trim() }))
          .slice(0, 20);
      }
      fields.push(field);
    }
    const buttons = [];
    for (const el of Array.from(document.querySelectorAll('button, [role="button"], a[role="button"]'))) {
      if (!visible(el)) continue;
      if (el.disabled === true) continue;
      const label = (el.innerText || el.textContent || accName(el) || "").trim().replace(/\s+/g, " ");
      if (!label) continue;
      buttons.push({ label, role: "button" });
    }
    const links = [];
    for (const el of Array.from(document.querySelectorAll("a[href]"))) {
      if (!visible(el)) continue;
      const label = (el.innerText || el.textContent || accName(el) || "").trim().replace(/\s+/g, " ");
      if (!label) continue;
      links.push({ label, href: el.getAttribute("href") });
    }
    const headings = [];
    for (const el of Array.from(document.querySelectorAll("h1, h2, h3, [role='heading']"))) {
      if (!visible(el)) continue;
      const level = el.tagName ? Number(el.tagName.slice(1)) : Number(el.getAttribute("aria-level") || 2);
      const text = (el.innerText || el.textContent || "").trim();
      if (text) headings.push({ level, text });
    }
    return {
      fields,
      buttons,
      links: links.slice(0, 40),
      headings,
      text: (document.body?.innerText || "").slice(0, 4000),
    };
  });
}

/**
 * Watch for URL changes and take a snapshot after each. Runs until the
 * user closes the browser OR `maxMinutes` elapses.
 */
export async function recordJourney({
  entryUrl,
  outPath,
  headless = false,
  maxMinutes = DEFAULT_MAX_MINUTES,
  idleMs = DEFAULT_IDLE_MS,
  logger = () => {},
} = {}) {
  if (!entryUrl) throw new Error("recordJourney: entryUrl is required");
  const chromium = await importChromium();
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();

  const trace = {
    startedAt: new Date().toISOString(),
    entryUrl,
    stages: [],
    endedAt: null,
    endReason: null,
  };

  const seenUrls = new Set();
  let stepCounter = 0;

  async function captureIfNew(reason) {
    const url = page.url();
    if (seenUrls.has(url) && reason !== "manual") return;
    // Debounce: wait for the page to settle before snapshotting.
    await page.waitForTimeout(idleMs).catch(() => {});
    const snap = await snapshotPage(page).catch(() => null);
    if (!snap) return;
    trace.stages.push({
      step: stepCounter++,
      url,
      title: await page.title().catch(() => ""),
      capturedAt: new Date().toISOString(),
      reason,
      ...snap,
    });
    seenUrls.add(url);
    logger(`snapshot ${trace.stages.length}: ${url}`);
  }

  // Listen for URL changes (SPAs use pushState; page.on 'framenavigated'
  // fires for those too).
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      captureIfNew("navigated").catch(() => {});
    }
  });

  // Allow the user to force a snapshot from the DevTools console by
  // running `window.__snapshotNow()` on the page. Useful for stages
  // where the URL doesn't change but the DOM does (form-step wizards).
  await page.exposeFunction("__snapshotNow", async () => {
    stepCounter++;
    const url = page.url();
    const snap = await snapshotPage(page).catch(() => null);
    if (snap) {
      trace.stages.push({
        step: stepCounter,
        url,
        title: await page.title().catch(() => ""),
        capturedAt: new Date().toISOString(),
        reason: "manual",
        ...snap,
      });
      logger(`manual snapshot ${trace.stages.length}: ${url}`);
    }
  });

  // Human-facing instructions injected into the page.
  page.on("domcontentloaded", async () => {
    try {
      await page.evaluate(() => {
        if (window.__qaAgentBannerShown) return;
        window.__qaAgentBannerShown = true;
        const b = document.createElement("div");
        b.textContent =
          "🎬 QA Agent recording — click through the flow. Run window.__snapshotNow() in console to force a snapshot. Close the tab when done.";
        b.style.cssText =
          "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#111;color:#fff;font:12px/1.4 monospace;padding:6px 12px;text-align:center;";
        document.documentElement.appendChild(b);
      });
    } catch {}
  });

  await page.goto(entryUrl, { waitUntil: "domcontentloaded" });
  await captureIfNew("entry");

  const deadline = Date.now() + maxMinutes * 60_000;
  const closedPromise = new Promise((resolve) => {
    page.once("close", () => resolve("page-closed"));
    context.once("close", () => resolve("context-closed"));
    browser.once("disconnected", () => resolve("disconnected"));
  });
  const timeoutPromise = new Promise((resolve) =>
    setTimeout(() => resolve("timeout"), deadline - Date.now())
  );

  trace.endReason = await Promise.race([closedPromise, timeoutPromise]);
  trace.endedAt = new Date().toISOString();

  try {
    await browser.close();
  } catch {}

  if (outPath) {
    mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    writeFileSync(outPath, JSON.stringify(trace, null, 2) + "\n", "utf8");
  }
  return trace;
}

/**
 * Load one or more recorded traces from disk (or merge them). Returns
 * a `Map<url, snapshot>` so LLM enrichment can look up "what does this
 * route actually look like" without re-parsing files each time.
 */
export function loadRecordedSnapshots(paths = []) {
  const byUrl = new Map();
  for (const p of paths) {
    let trace;
    try {
      trace = JSON.parse(readFileSync(p, "utf8"));
    } catch {
      continue;
    }
    for (const stage of trace.stages || []) {
      if (!stage.url) continue;
      // If the same URL was captured multiple times, prefer the richest
      // (most fields + buttons).
      const existing = byUrl.get(stage.url);
      const score = (stage.fields?.length || 0) + (stage.buttons?.length || 0);
      const existingScore =
        existing ? (existing.fields?.length || 0) + (existing.buttons?.length || 0) : -1;
      if (score > existingScore) byUrl.set(stage.url, stage);
    }
  }
  return byUrl;
}

/**
 * Given a route path (e.g. `/motor-basic-form`) and a snapshots map
 * keyed by full URL, pick the best-matching snapshot. Matches on:
 *   1. Exact URL suffix
 *   2. Path substring
 *   3. Falls back to the first snapshot whose URL contains the path's
 *      last non-slash segment
 */
export function pickSnapshotForRoute(routePath, snapshotsByUrl) {
  if (!routePath) return null;
  const stripped = routePath.split("?")[0].replace(/\/+$/, "");
  const tail = stripped.split("/").filter(Boolean).pop() || "";
  // Try exact suffix + path substring in that order
  for (const [url, snap] of snapshotsByUrl) {
    if (url.endsWith(stripped)) return snap;
  }
  for (const [url, snap] of snapshotsByUrl) {
    if (stripped && url.includes(stripped)) return snap;
  }
  if (tail) {
    for (const [url, snap] of snapshotsByUrl) {
      if (url.includes(tail)) return snap;
    }
  }
  return null;
}

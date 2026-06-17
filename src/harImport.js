/**
 * HAR (HTTP Archive) → Postman v2.1 collection import.
 *
 * Bridges the gap between "I browsed the app through DevTools" and "I have a
 * runnable API test suite." Pairs naturally with the `qa:api` stage that
 * already runs the resulting collection via Newman.
 *
 * Generates the same status<500 + response-time<2s assertions the static
 * generator emits, and dedupes by method+URL. Merge mode appends new entries
 * to an existing collection; replace mode overwrites.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const DEFAULT_OUT = "postman/qa-collection.json";

function entryToPostmanItem(entry, index) {
  const req = entry.request || {};
  const method = (req.method || "GET").toUpperCase();
  const fullUrl = req.url || "";
  let displayPath = fullUrl;
  try { displayPath = new URL(fullUrl).pathname || "/"; } catch {}
  const headers = (req.headers || [])
    .filter((h) => h?.name && !/^:|cookie$|^content-length$/i.test(h.name))
    .map((h) => ({ key: h.name, value: h.value || "" }));

  const item = {
    name: `${method} ${displayPath}`,
    request: {
      method,
      url: fullUrl,
      header: headers,
      description: `Imported from HAR (entry #${index}).`,
    },
    event: [{
      listen: "test",
      script: {
        type: "text/javascript",
        exec: [
          `pm.test('${method} ${displayPath} does not return server error', function () {`,
          "  pm.expect(pm.response.code).to.be.below(500);",
          "});",
          `pm.test('${method} ${displayPath} responds within 2s', function () {`,
          "  pm.expect(pm.response.responseTime).to.be.below(2000);",
          "});",
          "if ((pm.response.headers.get('content-type') || '').includes('application/json')) {",
          `  pm.test('${method} ${displayPath} returns valid JSON when advertised', function () {`,
          "    pm.response.json();",
          "  });",
          "}",
        ],
      },
    }],
  };
  if (req.postData?.text) {
    item.request.body = { mode: "raw", raw: req.postData.text };
    if (req.postData.mimeType) {
      item.request.body.options = { raw: { language: req.postData.mimeType.includes("json") ? "json" : "text" } };
    }
  }
  return item;
}

function dedupeKey(item) {
  const method = item.request?.method || "GET";
  const url = typeof item.request?.url === "string" ? item.request.url : (item.request?.url?.raw || "");
  return `${method} ${url}`;
}

/**
 * Import a HAR file into a Postman collection.
 *
 *   importHar('session.har', { outPath: 'postman/qa-collection.json', merge: true })
 *
 * Returns { imported, skippedAsDupes, outPath, total }.
 */
export async function importHar(harPath, options = {}) {
  const {
    outPath = DEFAULT_OUT,
    merge = true,
    filterOrigin = null,
    includeOnly = null, // e.g. ["xhr", "fetch"] — currently the agent imports all
  } = options;

  let har;
  try {
    har = JSON.parse(await fs.readFile(harPath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read HAR file ${harPath}: ${error.message}`);
  }
  const entries = har?.log?.entries || [];

  let candidates = entries;
  if (filterOrigin) {
    candidates = candidates.filter((entry) => {
      try { return new URL(entry.request.url).origin === filterOrigin; } catch { return false; }
    });
  }
  if (Array.isArray(includeOnly) && includeOnly.length) {
    candidates = candidates.filter((entry) => includeOnly.includes(entry?._resourceType));
  }

  let collection = null;
  if (merge) {
    try {
      collection = JSON.parse(await fs.readFile(outPath, "utf8"));
    } catch {
      collection = null;
    }
  }
  if (!collection) {
    collection = {
      info: {
        name: "QA API Contract",
        schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
      },
      item: [],
    };
  }

  const existingKeys = new Set(collection.item.map(dedupeKey));

  let imported = 0;
  let skippedAsDupes = 0;
  for (let i = 0; i < candidates.length; i += 1) {
    const item = entryToPostmanItem(candidates[i], i);
    const key = dedupeKey(item);
    if (existingKeys.has(key)) { skippedAsDupes += 1; continue; }
    existingKeys.add(key);
    collection.item.push(item);
    imported += 1;
  }

  await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(collection, null, 2) + "\n", "utf8");

  return { imported, skippedAsDupes, outPath, total: collection.item.length };
}

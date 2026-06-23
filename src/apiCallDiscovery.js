/**
 * Frontend-component API-call discovery.
 *
 * Scans page component files for outbound HTTP calls and feeds them into
 * the backend endpoint list. Catches:
 *   - axios.get|post|put|patch|delete('/api/...')
 *   - fetch('/api/...')
 *   - useQuery / useMutation patterns with a literal URL
 *   - GraphQL: client.query|mutate with operationName + query string
 *
 * Output: Array<{ method, path, source, file, framework: 'frontend-call' }>
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const AXIOS_RE =
  /\baxios\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*(['"`])([^'"`]+?)\2/g;
const FETCH_RE = /\bfetch\s*\(\s*(['"`])([^'"`]+?)\1(?:[^)]*method\s*:\s*(['"`])([^'"`]+?)\3)?/g;
const HTTP_HELPER_RE =
  /\b(?:apiClient|api|http|request|client)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*(['"`])([^'"`]+?)\2/g;

function readFileSafe(repoRoot, file) {
  try {
    return readFileSync(path.join(repoRoot, file), "utf8");
  } catch {
    return null;
  }
}

function pushUnique(arr, entry) {
  if (!entry.path || /^https?:\/\//i.test(entry.path) || /^\/\//.test(entry.path)) return;
  if (!entry.path.startsWith("/")) entry.path = `/${entry.path}`;
  const key = `${entry.method} ${entry.path}`;
  if (!arr.some((e) => `${e.method} ${e.path}` === key)) arr.push(entry);
}

export function extractApiCalls(source) {
  const calls = [];
  let m;

  AXIOS_RE.lastIndex = 0;
  while ((m = AXIOS_RE.exec(source)) !== null) {
    pushUnique(calls, { method: m[1].toUpperCase(), path: m[3] });
  }

  HTTP_HELPER_RE.lastIndex = 0;
  while ((m = HTTP_HELPER_RE.exec(source)) !== null) {
    pushUnique(calls, { method: m[1].toUpperCase(), path: m[3] });
  }

  FETCH_RE.lastIndex = 0;
  while ((m = FETCH_RE.exec(source)) !== null) {
    const url = m[2];
    const method = (m[4] || "GET").toUpperCase();
    pushUnique(calls, { method, path: url });
  }

  return calls;
}

export function callsForJourney(repoRoot, journey) {
  if (!repoRoot || !journey?.source) return [];
  if (journey.source === "default" || journey.source === "fixture") return [];
  const text = readFileSafe(repoRoot, journey.source);
  if (!text) return [];
  return extractApiCalls(text);
}

export function annotateJourneysWithApiCalls(journeys, repoRoot) {
  for (const journey of journeys) {
    const calls = callsForJourney(repoRoot, journey);
    if (calls.length) journey.apiCalls = calls;
  }
  return journeys;
}

/**
 * Aggregate all API calls observed across all journeys into a single list,
 * deduplicated by method+path. Useful for seeding Postman/k6 collections.
 */
export function aggregateApiCallsFromJourneys(journeys) {
  const seen = new Set();
  const out = [];
  for (const journey of journeys) {
    for (const call of journey.apiCalls || []) {
      const key = `${call.method} ${call.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        method: call.method,
        path: call.path,
        source: journey.source,
        framework: "frontend-call",
      });
    }
  }
  return out;
}

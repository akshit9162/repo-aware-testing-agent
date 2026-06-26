/**
 * Import user stories + APIs from Excel / CSV / JSON.
 *
 * Two sheets are recognized (case-insensitive, fuzzy):
 *   - Stories sheet: "User Stories" / "Stories" / "Backlog" / "Requirements".
 *     Fallback: the first sheet when nothing matches.
 *   - APIs sheet:    "APIs" / "API Spec" / "Endpoints".
 *     Optional — silently absent on inputs that only have stories.
 *
 * Column names are normalized via alias maps so the agent works with both
 * homemade sheets and exported tools (Jira, Linear, Notion, Azure DevOps).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import XLSX from "xlsx";

const STORY_SHEET_NAMES = [
  "user stories",
  "stories",
  "story",
  "us",
  "backlog",
  "requirements",
  "features",
  "epics",
];

const API_SHEET_NAMES = ["apis", "api", "endpoints", "api spec", "api specs", "rest", "graphql"];

const STORY_ALIASES = {
  id: ["id", "story id", "us id", "ticket id", "jira id", "ref", "key", "issue id"],
  title: ["title", "summary", "story", "story title", "name", "headline"],
  asA: ["as a", "as_a", "asa", "role", "persona", "user role"],
  want: ["i want", "iwant", "want", "goal", "wants to", "i want to"],
  benefit: ["so that", "sothat", "benefit", "value", "in order to"],
  description: ["description", "desc", "details", "narrative", "body"],
  ac: [
    "acceptance criteria",
    "ac",
    "acceptance",
    "given/when/then",
    "gherkin",
    "criteria",
    "definition of done",
  ],
  priority: ["priority", "pri", "p", "importance"],
  status: ["status", "state", "progress", "stage"],
  tags: ["tags", "labels", "epic", "feature", "components"],
  estimate: ["estimate", "points", "story points", "sp"],
};

const API_ALIASES = {
  method: ["method", "http method", "verb", "http verb"],
  path: ["path", "url", "endpoint", "route", "uri"],
  description: ["description", "desc", "summary", "name", "purpose"],
  auth: ["auth", "authentication", "requires auth", "auth required"],
  request: ["request", "request body", "payload", "sample request", "body", "params"],
  response: ["response", "response body", "sample response", "expected response", "expected"],
  statusCode: ["status code", "expected status", "expected code", "status", "http status"],
  contentType: ["content-type", "content type", "media type"],
  tags: ["tags", "labels", "module", "feature"],
};

function readWorkbook(filePath) {
  return XLSX.readFile(filePath, { cellDates: true });
}

function findSheet(workbook, candidates) {
  const lower = workbook.SheetNames.map((n) => n.toLowerCase().trim());
  for (const candidate of candidates) {
    const idx = lower.indexOf(candidate);
    if (idx >= 0) return workbook.SheetNames[idx];
  }
  // Substring fallback — "User Stories (v3)" still matches "user stories".
  for (let i = 0; i < lower.length; i += 1) {
    for (const candidate of candidates) {
      if (lower[i].includes(candidate)) return workbook.SheetNames[i];
    }
  }
  return null;
}

function sheetToRows(sheet) {
  return XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
}

function normalizeRow(row, aliasMap) {
  const norm = {};
  const lowerKeys = Object.fromEntries(
    Object.keys(row).map((k) => [k.toLowerCase().trim(), k])
  );
  for (const [field, aliases] of Object.entries(aliasMap)) {
    for (const alias of aliases) {
      const rawKey = lowerKeys[alias];
      if (rawKey !== undefined) {
        const value = row[rawKey];
        norm[field] = value === null || value === undefined ? "" : String(value).trim();
        break;
      }
    }
  }
  return norm;
}

function isEmptyRow(row) {
  return Object.values(row).every(
    (v) => v === null || v === undefined || String(v).trim() === ""
  );
}

export function normalizeStoryRow(raw) {
  return normalizeRow(raw, STORY_ALIASES);
}

export function normalizeApiRow(raw) {
  const norm = normalizeRow(raw, API_ALIASES);
  if (norm.method) norm.method = norm.method.toUpperCase();
  if (norm.path && !norm.path.startsWith("/") && !/^https?:/.test(norm.path)) {
    norm.path = "/" + norm.path;
  }
  return norm;
}

/**
 * Parse a file (xlsx / xls / csv / json) into { stories, apis, sourcePath }.
 * - .xlsx / .xls: SheetJS parses; story + API sheets resolved by name.
 * - .csv: treated as a single sheet of stories.
 * - .json: expects { stories: [...], apis: [...] } or a bare array of stories.
 */
export function parseStoriesFile(filePath, options = {}) {
  const abs = path.resolve(filePath);
  const ext = path.extname(abs).toLowerCase();
  const result = { stories: [], apis: [], sourcePath: abs, sheets: {} };

  if (ext === ".json") {
    const parsed = JSON.parse(readFileSync(abs, "utf8"));
    const arr = Array.isArray(parsed) ? parsed : parsed.stories;
    if (Array.isArray(arr)) result.stories = arr.map(normalizeStoryRow);
    if (Array.isArray(parsed.apis)) result.apis = parsed.apis.map(normalizeApiRow);
    return result;
  }

  if (ext === ".csv" || ext === ".tsv") {
    const wb = XLSX.read(readFileSync(abs, "utf8"), { type: "string", raw: false });
    const rows = sheetToRows(wb.Sheets[wb.SheetNames[0]]);
    result.stories = rows.filter((r) => !isEmptyRow(r)).map(normalizeStoryRow);
    result.sheets.stories = wb.SheetNames[0];
    return result;
  }

  // .xlsx / .xls
  const wb = readWorkbook(abs);
  const storySheetName =
    (options.storySheet && wb.Sheets[options.storySheet] ? options.storySheet : null) ||
    findSheet(wb, STORY_SHEET_NAMES) ||
    wb.SheetNames[0];
  const apiSheetName =
    (options.apisSheet && wb.Sheets[options.apisSheet] ? options.apisSheet : null) ||
    findSheet(wb, API_SHEET_NAMES);

  if (storySheetName) {
    const rows = sheetToRows(wb.Sheets[storySheetName]);
    result.stories = rows.filter((r) => !isEmptyRow(r)).map(normalizeStoryRow);
    result.sheets.stories = storySheetName;
  }
  if (apiSheetName) {
    const rows = sheetToRows(wb.Sheets[apiSheetName]);
    result.apis = rows.filter((r) => !isEmptyRow(r)).map(normalizeApiRow);
    result.sheets.apis = apiSheetName;
  }
  return result;
}

/**
 * Build a stable slug for a story — uses id when present, otherwise a
 * kebab of the title. Used to name generated tests deterministically.
 */
export function storySlug(story, idx = 0) {
  const seed = story.id || story.title || `story-${idx + 1}`;
  return String(seed)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || `story-${idx + 1}`;
}

/**
 * Skip stories that are obviously not implementation targets — Done, Closed,
 * Archived, Won't Do. Comparisons are case-insensitive prefix/substring.
 */
const SKIP_STATUS_RE = /^(done|closed|completed|won.?t do|cancelled|archived|deprecated)$/i;

export function shouldSkipStory(story) {
  if (!story?.status) return false;
  return SKIP_STATUS_RE.test(String(story.status).trim());
}

/**
 * Per-page form-field discovery.
 *
 * For each journey whose `source` resolves to a real component file, scan
 * for form-related JSX and feed the results into LLM enrichment as extra
 * context. Catches:
 *   - MUI <TextField label="..." required />, <Select label="...">,
 *     <Checkbox label="..." />
 *   - Plain <input type="..." name="..." required />, <select>, <textarea>
 *   - React Hook Form: `register('name', { required, minLength, pattern })`
 *
 * Output: Array<{ kind, label?, name?, type, required?, validation? }>
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const MUI_FIELD_RE =
  /<\s*(TextField|Select|Checkbox|Radio|Switch|Autocomplete|DatePicker|TimePicker)\b([^>]*?)\/?>/gs;
const HTML_INPUT_RE = /<\s*(input|select|textarea)\b([^>]*?)\/?>/gs;
const ATTR_LABEL_RE = /\blabel\s*=\s*["']([^"']+)["']/;
const ATTR_NAME_RE = /\bname\s*=\s*["']([^"']+)["']/;
const ATTR_TYPE_RE = /\btype\s*=\s*["']([^"']+)["']/;
const ATTR_PLACEHOLDER_RE = /\bplaceholder\s*=\s*["']([^"']+)["']/;
const ATTR_REQUIRED_RE = /\brequired(\s|>|=)/;
const RHF_REGISTER_RE =
  /register\(\s*["'`]([^"'`]+)["'`]\s*(?:,\s*\{([^}]*)\})?/gs;
const RHF_VALIDATION_RE =
  /(required|minLength|maxLength|pattern|min|max)\s*:\s*([^,}]+)/g;

function readFileSafe(repoRoot, file) {
  try {
    return readFileSync(path.join(repoRoot, file), "utf8");
  } catch {
    return null;
  }
}

function extractAttr(re, attrs) {
  const m = re.exec(attrs);
  return m ? m[1] : undefined;
}

function isRequired(attrs) {
  return ATTR_REQUIRED_RE.test(attrs) || /\brequired\s*=\s*\{?\s*true/i.test(attrs);
}

export function extractFormFields(source) {
  const fields = [];

  MUI_FIELD_RE.lastIndex = 0;
  let m;
  while ((m = MUI_FIELD_RE.exec(source)) !== null) {
    const kind = m[1];
    const attrs = m[2] || "";
    const label = extractAttr(ATTR_LABEL_RE, attrs);
    const name = extractAttr(ATTR_NAME_RE, attrs);
    const type = extractAttr(ATTR_TYPE_RE, attrs);
    fields.push({
      kind: kind.toLowerCase(),
      label,
      name,
      type: type || kind.toLowerCase(),
      required: isRequired(attrs) || undefined,
    });
  }

  HTML_INPUT_RE.lastIndex = 0;
  while ((m = HTML_INPUT_RE.exec(source)) !== null) {
    const kind = m[1];
    const attrs = m[2] || "";
    const name = extractAttr(ATTR_NAME_RE, attrs);
    const type = extractAttr(ATTR_TYPE_RE, attrs);
    const placeholder = extractAttr(ATTR_PLACEHOLDER_RE, attrs);
    fields.push({
      kind,
      label: placeholder,
      name,
      type: type || (kind === "textarea" ? "textarea" : kind === "select" ? "select" : "text"),
      required: isRequired(attrs) || undefined,
    });
  }

  RHF_REGISTER_RE.lastIndex = 0;
  while ((m = RHF_REGISTER_RE.exec(source)) !== null) {
    const name = m[1];
    const optsBlock = m[2] || "";
    const validation = {};
    RHF_VALIDATION_RE.lastIndex = 0;
    let v;
    while ((v = RHF_VALIDATION_RE.exec(optsBlock)) !== null) {
      const value = v[2].trim().replace(/^["'`]|["'`]$/g, "");
      validation[v[1]] = value;
    }
    fields.push({
      kind: "rhf-register",
      name,
      type: "text",
      required: validation.required ? true : undefined,
      validation: Object.keys(validation).length ? validation : undefined,
    });
  }

  // Deduplicate by (kind, name||label) — same field can show up in multiple
  // detectors when both MUI <TextField> and useForm register('') are used.
  const byKey = new Map();
  for (const f of fields) {
    const key = `${f.kind}|${f.name || f.label || JSON.stringify(f)}`;
    if (!byKey.has(key)) byKey.set(key, f);
  }
  return [...byKey.values()];
}

/**
 * For a single journey object (must have .source set), read the component
 * file and return its form fields. Empty array on miss.
 */
export function fieldsForJourney(repoRoot, journey) {
  if (!repoRoot || !journey?.source) return [];
  if (journey.source === "default" || journey.source === "fixture") return [];
  const text = readFileSafe(repoRoot, journey.source);
  if (!text) return [];
  return extractFormFields(text);
}

/**
 * Annotate each journey in-place with a `.forms` array. Returns the same
 * array (for chainability). Safe to call before LLM enrichment so the
 * prompt can include this context.
 */
export function annotateJourneysWithForms(journeys, repoRoot) {
  for (const journey of journeys) {
    const forms = fieldsForJourney(repoRoot, journey);
    if (forms.length) journey.forms = forms;
  }
  return journeys;
}

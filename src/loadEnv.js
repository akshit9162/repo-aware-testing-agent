/**
 * Tiny dotenv-style loader. Reads `.env.local` then `.env` from a given root
 * and populates `process.env` for keys that aren't already set. No external
 * dependency, no override of existing env vars (so a real export wins over
 * the file).
 *
 * Supports:
 *   KEY=value
 *   KEY="value with spaces"
 *   KEY='single quoted'
 *   # comments and blank lines
 *
 * Doesn't support: multi-line values, variable interpolation, `export` prefix.
 * Add a dotenv dep if you need any of those — the use case here is "the
 * ANTHROPIC/OPENAI keys for one repo," not full shell-env emulation.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

const FILE_NAMES = [".env.local", ".env"];

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  // Allow `export KEY=value` prefixes — common when people copy snippets
  // straight out of their shell history.
  const withoutExport = trimmed.startsWith("export ") ? trimmed.slice(7) : trimmed;
  const eq = withoutExport.indexOf("=");
  if (eq < 0) return null;
  const key = withoutExport.slice(0, eq).trim();
  if (!key) return null;
  let value = withoutExport.slice(eq + 1).trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1);
    }
  }
  return [key, value];
}

/**
 * Load env vars from .env.local / .env in `root` into process.env. Returns
 * { loaded: [paths], setKeys: [names] }. Existing process.env values are
 * preserved (the file never overrides a real export).
 */
export async function loadDotenv(root) {
  const absRoot = path.resolve(root || ".");
  const loaded = [];
  const setKeys = [];
  for (const name of FILE_NAMES) {
    const file = path.join(absRoot, name);
    let content;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    loaded.push(file);
    for (const rawLine of content.split(/\r?\n/)) {
      const parsed = parseLine(rawLine);
      if (!parsed) continue;
      const [key, value] = parsed;
      if (key in process.env) continue;
      process.env[key] = value;
      setKeys.push(key);
    }
  }
  return { loaded, setKeys };
}

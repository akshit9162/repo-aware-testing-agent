import { promises as fs } from "node:fs";
import path from "node:path";

async function readIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function normalizeGitignoreLines(lines = []) {
  return lines.map((line) => String(line).trimEnd()).filter(Boolean);
}

async function appendGitignoreEntries(root, entries, written, unchanged) {
  const lines = normalizeGitignoreLines(entries);
  if (!lines.length) return;
  const gitignorePath = path.join(root, ".gitignore");
  const existing = await readIfExists(gitignorePath);
  const existingLines = new Set((existing || "").split(/\r?\n/).map((line) => line.trimEnd()));
  const missing = lines.filter((line) => !existingLines.has(line));
  if (!missing.length) {
    unchanged.push(".gitignore");
    return;
  }
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
  const suffix = `${missing.join("\n")}\n`;
  await fs.appendFile(gitignorePath, `${prefix}${suffix}`, "utf8");
  written.push(".gitignore");
}

export async function applyAssets(repoPath, assets, options = {}) {
  const root = path.resolve(repoPath);
  const written = [];
  const skipped = [];
  const unchanged = [];

  const pkgPath = path.join(root, "package.json");
  const existingPkg = await readIfExists(pkgPath);
  if (existingPkg === assets.packageJson) {
    unchanged.push("package.json");
  } else {
    await fs.writeFile(pkgPath, assets.packageJson, "utf8");
    written.push("package.json");
  }

  for (const file of assets.files) {
    const full = path.join(root, file.path);
    const existing = await readIfExists(full);
    if (existing === file.content) {
      unchanged.push(file.path);
      await appendGitignoreEntries(root, file.appendGitignore, written, unchanged);
      continue;
    }
    if (existing !== null && !options.overwrite) {
      skipped.push(file.path);
      await appendGitignoreEntries(root, file.appendGitignore, written, unchanged);
      continue;
    }
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, file.content, "utf8");
    written.push(file.path);
    await appendGitignoreEntries(root, file.appendGitignore, written, unchanged);
  }

  return { written, skipped, unchanged };
}

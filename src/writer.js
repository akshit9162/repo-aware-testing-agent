import { promises as fs } from "node:fs";
import path from "node:path";

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function applyAssets(repoPath, assets, options = {}) {
  const root = path.resolve(repoPath);
  const written = [];
  const skipped = [];

  await fs.writeFile(path.join(root, "package.json"), assets.packageJson, "utf8");
  written.push("package.json");

  for (const file of assets.files) {
    const full = path.join(root, file.path);
    if (!options.overwrite && await exists(full)) {
      skipped.push(file.path);
      continue;
    }
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, file.content, "utf8");
    written.push(file.path);
  }

  return { written, skipped };
}

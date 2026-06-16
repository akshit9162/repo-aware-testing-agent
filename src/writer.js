import { promises as fs } from "node:fs";
import path from "node:path";

async function readIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
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
      continue;
    }
    if (existing !== null && !options.overwrite) {
      skipped.push(file.path);
      continue;
    }
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, file.content, "utf8");
    written.push(file.path);
  }

  return { written, skipped, unchanged };
}

import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanRepository, detectStack, createTestPlan, generateAssets, applyAssets } from "../src/index.js";

async function makeFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repo-qa-agent-"));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({
    type: "module",
    scripts: { test: "vitest run" },
    dependencies: { react: "^18.3.1" },
    devDependencies: { vite: "^7.0.0" }
  }, null, 2));
  await fs.writeFile(path.join(dir, "vite.config.ts"), "export default {}");
  await fs.writeFile(path.join(dir, "src", "App.tsx"), "export function App(){ return <div/> }");
  return dir;
}

test("scans repo and generates customized QA assets", async () => {
  const dir = await makeFixture();
  const scan = await scanRepository(dir);
  const stack = detectStack(scan);
  const plan = createTestPlan(scan, stack);
  const assets = generateAssets(scan, plan);

  assert.equal(stack.framework, "vite");
  assert.equal(stack.hasFrontend, true);
  assert.match(assets.packageJson, /qa:e2e/);
  assert.equal(assets.files.some((file) => file.path === "tests/e2e/critical-journey.spec.ts"), true);
});

test("applies assets without overwriting existing files", async () => {
  const dir = await makeFixture();
  await fs.mkdir(path.join(dir, "tests", "unit"), { recursive: true });
  await fs.writeFile(path.join(dir, "tests", "unit", "qa-baseline.test.js"), "keep");

  const scan = await scanRepository(dir);
  const assets = generateAssets(scan, createTestPlan(scan, detectStack(scan)));
  const result = await applyAssets(dir, assets);

  assert.equal(result.written.includes("package.json"), true);
  assert.equal(result.skipped.includes("tests/unit/qa-baseline.test.js"), true);
  assert.equal(await fs.readFile(path.join(dir, "tests", "unit", "qa-baseline.test.js"), "utf8"), "keep");
});

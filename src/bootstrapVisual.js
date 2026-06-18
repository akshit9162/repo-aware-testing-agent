import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import net from "node:net";

function getFreePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", () => {
      resolve(3000 + Math.floor(Math.random() * 1000));
    });
  });
}

async function waitForHealth(url, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: "GET" });
      if (res.status < 500) return true;
    } catch {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

function hasPackage(pkg, name) {
  return Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);
}

function scriptMentions(pkg, scriptName, pattern) {
  return pattern.test(pkg.scripts?.[scriptName] || "");
}

export function buildServerCommand(pkg, startScript, port) {
  const script = pkg.scripts?.[startScript] || "";
  const isViteLike =
    /\bvite\b/.test(script) ||
    hasPackage(pkg, "vite") ||
    hasPackage(pkg, "@vitejs/plugin-react") ||
    hasPackage(pkg, "@vitejs/plugin-react-swc") ||
    hasPackage(pkg, "astro") ||
    scriptMentions(pkg, startScript, /\bastro\b/);
  const isNext =
    /\bnext\b/.test(script) ||
    hasPackage(pkg, "next");

  const passthrough = [];
  if (isNext) {
    passthrough.push("--", "-H", "127.0.0.1", "-p", String(port));
  } else if (isViteLike) {
    passthrough.push("--", "--host", "127.0.0.1", "--port", String(port));
  }

  return {
    command: "npm",
    args: ["run", startScript, ...passthrough],
    env: {
      PORT: String(port),
      HOST: "127.0.0.1",
    },
  };
}

function killProcessTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") {
      child.kill("SIGTERM");
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

export async function bootstrapVisual(repoPath, options = {}) {
  const root = path.resolve(repoPath);
  const logger = options.logger || console.log;

  // Read package.json to find dev/start scripts
  let pkg;
  try {
    pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  } catch {
    throw new Error("No package.json found in the target repository.");
  }

  const startScript = pkg.scripts?.start ? "start" : pkg.scripts?.dev ? "dev" : null;
  if (!startScript) {
    throw new Error("No start or dev script found in package.json.");
  }

  // Run npm run build first if start script is used
  if (startScript === "start" && pkg.scripts?.build) {
    logger("[bootstrap-visual] Building the application...");
    await new Promise((resolve, reject) => {
      const buildProc = spawn("npm", ["run", "build"], {
        cwd: root,
        stdio: "inherit",
        shell: process.platform === "win32"
      });
      buildProc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error("Application build failed."));
      });
    });
  }

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  logger(`[bootstrap-visual] Launching app server on port ${port}...`);

  const serverCommand = buildServerCommand(pkg, startScript, port);
  const serverProc = spawn(serverCommand.command, serverCommand.args, {
    cwd: root,
    stdio: "ignore",
    env: { ...process.env, ...serverCommand.env },
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
  });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    killProcessTree(serverProc);
  };

  const cleanupAndExit = () => {
    cleanup();
    process.exit(130);
  };
  process.once("SIGINT", cleanupAndExit);
  process.once("SIGTERM", cleanupAndExit);

  const healthy = await waitForHealth(baseUrl);
  if (!healthy) {
    cleanup();
    process.removeListener("SIGINT", cleanupAndExit);
    process.removeListener("SIGTERM", cleanupAndExit);
    throw new Error(`App server failed to become healthy at ${baseUrl}`);
  }

  logger(`[bootstrap-visual] App server healthy at ${baseUrl}. Starting visual snapshots record...`);

  return new Promise((resolve, reject) => {
    const playProc = spawn("npx", ["playwright", "test", "tests/visual", "--update-snapshots"], {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, QA_BASE_URL: baseUrl },
      shell: process.platform === "win32"
    });

    playProc.on("close", (code) => {
      cleanup();
      process.removeListener("SIGINT", cleanupAndExit);
      process.removeListener("SIGTERM", cleanupAndExit);
      if (code === 0) {
        logger("[bootstrap-visual] Visual screenshots updated successfully!");
        resolve({ success: true, port });
      } else {
        reject(new Error(`Playwright snapshot update failed with exit code ${code}`));
      }
    });
  });
}

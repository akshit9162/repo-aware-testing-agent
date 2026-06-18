import { spawn } from "node:child_process";
import path from "node:path";

function splitCommand(command) {
  const parts = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(command))) {
    parts.push(match[1] ?? match[2] ?? match[3]);
  }
  return parts;
}

function safeCommand(command) {
  const [bin] = splitCommand(command);
  return ["npm", "npx", "node"].includes(bin);
}

export function planValidationCommands(failure = {}, proposal = {}) {
  const commands = [];
  const file = failure.file || "";
  const tool = String(failure.tool || "").toLowerCase();

  for (const command of proposal.commands || []) {
    if (typeof command === "string" && command.trim()) commands.push(command.trim());
  }

  if (tool.includes("playwright") && file) {
    commands.push(`npx playwright test ${file}`);
  } else if ((tool.includes("vitest") || /\.test\.(js|jsx|ts|tsx)$/.test(file)) && file) {
    commands.push(`npx vitest run ${file}`);
  } else if (tool.includes("newman") || tool.includes("postman") || tool.includes("api")) {
    commands.push("npm run qa:api");
  } else if (tool.includes("axe")) {
    commands.push("npm run qa:a11y");
  } else if (tool.includes("visual")) {
    commands.push("npm run qa:visual");
  } else if (tool.includes("semgrep")) {
    commands.push("npm run qa:sast");
  } else if (tool.includes("gitleaks")) {
    commands.push("npm run qa:secrets");
  } else if (tool.includes("trivy")) {
    commands.push("npm run qa:security");
  }

  return [...new Set(commands)].filter(safeCommand);
}

export function runValidationCommand(command, { cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const parts = splitCommand(command);
    const bin = parts[0];
    const args = parts.slice(1);
    if (!safeCommand(command)) {
      resolve({ command, ok: false, exitCode: null, skipped: true, output: "unsafe command" });
      return;
    }

    const child = spawn(bin, args, {
      cwd: cwd ? path.resolve(cwd) : process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: { ...process.env, CI: "1" },
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      output += "\n[validation timeout]";
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ command, ok: false, exitCode: null, output: String(error.message || error).slice(-8000) });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ command, ok: exitCode === 0, exitCode, output: output.slice(-8000) });
    });
  });
}

export async function runValidationCommands(commands, { cwd, timeoutMs } = {}) {
  const results = [];
  for (const command of commands || []) {
    results.push(await runValidationCommand(command, { cwd, timeoutMs }));
  }
  return results;
}

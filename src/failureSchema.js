function statusForTest(test) {
  const results = test.results || [];
  if (results.some((result) => result.status === "failed" || result.status === "timedOut")) return "failed";
  if (results.every((result) => result.status === "skipped")) return "skipped";
  if (results.some((result) => result.status === "passed")) return "passed";
  return results.at(-1)?.status || "unknown";
}

function flattenPlaywrightFailures(suite, rows = [], parentTitles = []) {
  const suiteTitles = [...parentTitles, suite.title].filter(Boolean);
  for (const spec of suite.specs || []) {
    for (const test of spec.tests || []) {
      const status = statusForTest(test);
      if (status !== "failed") continue;
      const errors = (test.results || [])
        .flatMap((result) => result.errors || [])
        .map((error) => error.message || error.value || "")
        .filter(Boolean)
        .join("\n");
      rows.push(normalizeFailure({
        tool: "playwright",
        title: [...suiteTitles, spec.title].filter(Boolean).join(" > "),
        file: spec.file || "",
        status,
        error: errors,
        raw: { specTitle: spec.title, suiteTitles },
      }));
    }
  }
  for (const child of suite.suites || []) flattenPlaywrightFailures(child, rows, suiteTitles);
  return rows;
}

function stableId(tool, title, file, error) {
  const text = `${tool}|${title}|${file}|${String(error || "").slice(0, 200)}`;
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return `${tool || "qa"}-${Math.abs(hash).toString(36)}`;
}

export function normalizeFailure(input = {}) {
  const tool = String(input.tool || "qa").toLowerCase();
  const title = String(input.title || input.summary || "");
  const file = String(input.file || "");
  const error = String(input.error || input.errors || input.actualResult || "");
  const status = String(input.status || "failed").toLowerCase();
  return {
    id: input.id || stableId(tool, title, file, error),
    tool,
    title,
    file,
    status,
    error,
    route: input.route || null,
    raw: input.raw || null,
  };
}

export function parseQaFailures(report) {
  const failures = [];

  if (Array.isArray(report?.suites)) {
    for (const suite of report.suites) flattenPlaywrightFailures(suite, failures);
  }

  if (Array.isArray(report?.testCases)) {
    for (const item of report.testCases) {
      if (String(item.status || "").toLowerCase() !== "failed") continue;
      failures.push(normalizeFailure({
        tool: item.tool || "qa",
        title: item.title || item.summary || "",
        file: item.file || "",
        status: "failed",
        error: item.errors || item.actualResult || "",
        raw: item,
      }));
    }
  }

  if (Array.isArray(report?.qaTestCases)) {
    for (const item of report.qaTestCases) {
      if (String(item.status || "").toLowerCase() !== "fail") continue;
      failures.push(normalizeFailure({
        id: item.testCaseId,
        tool: item.testType || "qa",
        title: item.summary || item.testCaseId || "",
        status: "failed",
        error: item.actualResult || item.expectedResult || "",
        raw: item,
      }));
    }
  }

  return failures;
}

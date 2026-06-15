import { promises as fs } from "node:fs";
import path from "node:path";

function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function statusForTest(test) {
  const results = test.results || [];
  if (!results.length) return "unknown";
  if (results.some((result) => result.status === "failed" || result.status === "timedOut")) return "failed";
  if (results.every((result) => result.status === "skipped")) return "skipped";
  if (results.some((result) => result.status === "passed")) return "passed";
  return results.at(-1)?.status || "unknown";
}

function flattenSuite(suite, parentTitles = []) {
  const rows = [];
  const titles = [...parentTitles, suite.title].filter(Boolean);

  for (const spec of suite.specs || []) {
    for (const test of spec.tests || []) {
      const results = test.results || [];
      const status = statusForTest(test);
      const durationMs = results.reduce((sum, result) => sum + (result.duration || 0), 0);
      const errors = results
        .flatMap((result) => result.errors || [])
        .map((error) => error.message || error.value || "")
        .filter(Boolean)
        .join("\n");
      rows.push({
        project: test.projectName || "",
        file: spec.file || "",
        title: [...titles, spec.title].filter(Boolean).join(" > "),
        status,
        durationMs,
        retries: Math.max(0, results.length - 1),
        errors,
      });
    }
  }

  for (const child of suite.suites || []) {
    rows.push(...flattenSuite(child, titles));
  }

  return rows;
}

export function summarizePlaywrightReport(report) {
  const tests = (report.suites || []).flatMap((suite) => flattenSuite(suite));
  const counts = tests.reduce(
    (acc, test) => {
      acc.total += 1;
      acc[test.status] = (acc[test.status] || 0) + 1;
      return acc;
    },
    { total: 0, passed: 0, failed: 0, skipped: 0, unknown: 0 },
  );
  const durationMs = tests.reduce((sum, test) => sum + test.durationMs, 0);
  const passRate = counts.total ? Math.round((counts.passed / counts.total) * 10000) / 100 : 0;

  return {
    tests,
    summary: {
      total: counts.total,
      passed: counts.passed || 0,
      failed: counts.failed || 0,
      skipped: counts.skipped || 0,
      unknown: counts.unknown || 0,
      durationMs,
      passRate,
    },
  };
}

function row(cells) {
  return `<Row>${cells.map((cell) => `<Cell><Data ss:Type="String">${escapeXml(cell)}</Data></Cell>`).join("")}</Row>`;
}

function worksheet(name, rows) {
  return `<Worksheet ss:Name="${escapeXml(name)}"><Table>${rows.join("")}</Table></Worksheet>`;
}

export function createPlaywrightCoverageWorkbook(report) {
  const { tests, summary } = summarizePlaywrightReport(report);
  const summaryRows = [
    row(["Metric", "Value"]),
    row(["Total tests", summary.total]),
    row(["Passed", summary.passed]),
    row(["Failed", summary.failed]),
    row(["Skipped", summary.skipped]),
    row(["Unknown", summary.unknown]),
    row(["Duration ms", summary.durationMs]),
    row(["Pass rate", `${summary.passRate}%`]),
  ];
  const testRows = [
    row(["Project", "File", "Test", "Status", "Duration ms", "Retries", "Errors"]),
    ...tests.map((test) => row([
      test.project,
      test.file,
      test.title,
      test.status,
      test.durationMs,
      test.retries,
      test.errors,
    ])),
  ];

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
${worksheet("Summary", summaryRows)}
${worksheet("Tests", testRows)}
</Workbook>
`;
}

export async function writePlaywrightCoverageExcel(inputPath, outputPath) {
  const raw = await fs.readFile(inputPath, "utf8");
  const report = JSON.parse(raw);
  const workbook = createPlaywrightCoverageWorkbook(report);
  await fs.mkdir(path.dirname(path.resolve(outputPath)), { recursive: true });
  await fs.writeFile(outputPath, workbook, "utf8");
  return summarizePlaywrightReport(report).summary;
}

import { relative, sep } from "node:path";

const metric = () => ({ covered: 0, total: 0, pct: 100 });

function finish(value) {
  value.pct = value.total === 0 ? 100 : Number((value.covered / value.total * 100).toFixed(2));
  return value;
}

function counters(values) {
  const entries = Object.values(values ?? {}).flatMap((value) => Array.isArray(value) ? value : [value]);
  return finish({ covered: entries.filter((value) => Number(value) > 0).length, total: entries.length, pct: 100 });
}

function lineCounters(file) {
  const lines = new Map();
  for (const [id, count] of Object.entries(file.s ?? {})) {
    const line = file.statementMap?.[id]?.start?.line;
    if (Number.isInteger(line)) lines.set(line, Math.max(lines.get(line) ?? 0, Number(count)));
  }
  return counters(Object.fromEntries(lines));
}

function fileMetrics(file) {
  return {
    statements: counters(file.s),
    branches: counters(file.b),
    functions: counters(file.f),
    lines: lineCounters(file),
  };
}

function mergeMetric(target, source) {
  target.covered += source.covered;
  target.total += source.total;
}

function mergeMetrics(target, source) {
  for (const key of ["statements", "branches", "functions", "lines"]) mergeMetric(target[key], source[key]);
}

function finishMetrics(value) {
  for (const key of ["statements", "branches", "functions", "lines"]) finish(value[key]);
  return value;
}

function emptyMetrics() {
  return { statements: metric(), branches: metric(), functions: metric(), lines: metric() };
}

export function summarizeCoverage(coverage, root, instrumentationOmissions = {}) {
  const directories = new Map();
  const files = [];
  const overall = emptyMetrics();
  for (const [absolutePath, file] of Object.entries(coverage)) {
    const path = relative(root, absolutePath).split(sep).join("/");
    if (!path.startsWith("src/")) continue;
    const parts = path.split("/");
    const directory = parts.length > 2 ? `src/${parts[1]}` : "src/(root)";
    const metrics = fileMetrics(file);
    files.push({ path, ...metrics });
    if (!directories.has(directory)) directories.set(directory, emptyMetrics());
    mergeMetrics(directories.get(directory), metrics);
    mergeMetrics(overall, metrics);
  }
  const directoryRows = [...directories.entries()]
    .map(([path, metrics]) => ({ path, ...finishMetrics(metrics) }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const instrumentedFiles = files.filter((file) => instrumentationOmissions[file.path] == null);
  const lowStatementFiles = instrumentedFiles
    .filter((file) => file.statements.total > 0 && file.statements.pct < 50)
    .sort((a, b) => a.statements.pct - b.statements.pct || a.path.localeCompare(b.path));
  const omittedFiles = files
    .filter((file) => instrumentationOmissions[file.path] != null)
    .map((file) => ({ ...file, reason: instrumentationOmissions[file.path] }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    overall: finishMetrics(overall),
    directories: directoryRows,
    lowStatementFiles,
    instrumentationOmissions: omittedFiles,
  };
}

function pct(metricValue) {
  return `${metricValue.pct.toFixed(2).padStart(6)}%`;
}

export function formatCoverageSummary(summary) {
  const out = ["\nPer-directory merged coverage:", "directory             stmts    branch   funcs    lines"];
  for (const row of summary.directories) {
    out.push(`${row.path.padEnd(21)} ${pct(row.statements)}  ${pct(row.branches)}  ${pct(row.functions)}  ${pct(row.lines)}`);
  }
  out.push("\nInstrumented files below 50% statement coverage after all included lanes:");
  if (summary.lowStatementFiles.length === 0) out.push("  (none)");
  else for (const file of summary.lowStatementFiles) {
    out.push(`  ${pct(file.statements)}  ${file.path}`);
  }
  out.push("\nBrowser-executed sources omitted by NODE_V8_COVERAGE:");
  if (summary.instrumentationOmissions.length === 0) out.push("  (none)");
  else for (const file of summary.instrumentationOmissions) {
    out.push(`  ${file.path} — ${file.reason}`);
  }
  return out.join("\n");
}

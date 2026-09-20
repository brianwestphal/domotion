import { readFileSync, rmSync, mkdirSync } from "node:fs";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";

export function mergeCoverageMaps(coverageMaps) {
  const merged = libCoverage.createCoverageMap({});
  for (const coverage of coverageMaps) merged.merge(coverage);
  return merged;
}

export function mergeCoverageFiles(paths) {
  return mergeCoverageMaps(paths.map((path) => JSON.parse(readFileSync(path, "utf8"))));
}

export function writeCoverageReports(coverageMap, outputDirectory) {
  rmSync(outputDirectory, { recursive: true, force: true });
  mkdirSync(outputDirectory, { recursive: true });
  const context = libReport.createContext({ dir: outputDirectory, coverageMap });
  for (const reporter of ["text-summary", "json", "html"]) {
    reports.create(reporter).execute(context);
  }
}

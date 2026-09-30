/** @jsxRuntime automatic */
/** @jsxImportSource kerfjs */
import { raw } from "kerfjs";
import type { TestResult } from "../html-test-suite.js";

const INDEX_CSS = `
body{font:13px -apple-system,sans-serif;margin:16px;background:#f6f8fa}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #e1e4e8;vertical-align:top}
tr.pass{background:#f0fff4}
tr.fail{background:#fff5f5}
tr.skip{background:#f6f8fa;opacity:0.7}
.name{font-family:monospace;font-size:12px}
.status{font-weight:600}
.tile{color:#6e7681;font-size:11px}
.imgs img{width:180px;height:135px;object-fit:contain;background:#fff;border:1px solid #d0d7de;margin-right:4px}
h1{margin:0 0 12px}
.err{color:#cf222e;font-family:monospace;font-size:11px}
.skip-note{color:#8b949e;font-size:11px;font-style:italic;margin-top:4px}
.warn-list{font-size:11px;color:#6e7681;margin:4px 0 0 14px;padding:0}
.warn-list li{margin:1px 0}
.legend{font-size:12px;color:#6e7681;margin-bottom:8px}
`;

function ResultRow({ r }: { r: TestResult }) {
  const status = r.skipped ? "SKIP" : r.pass ? "PASS" : "FAIL";
  const cls = r.skipped ? "skip" : r.pass ? "pass" : "fail";
  return (
    <tr className={cls}>
      <td className="name">{r.name}</td>
      <td className="status">{status}</td>
      <td className="diff">
        <div>
          <b>{`${r.verdict} · ${r.regionCount} region${r.regionCount === 1 ? "" : "s"}`}</b>
        </div>
        <div className="tile">{`${r.coveragePct.toFixed(2)}% of image`}</div>
        <div className="tile">{`shifty ${r.shiftyRegionCount} · shifted ${r.shiftedPixels} · scatter ${r.scatteredPixels}`}</div>
        <div className="tile">{`raw avg ${r.diffPct.toFixed(2)}% · non-AA ${r.nonAaPixels} px`}</div>
      </td>
      <td className="imgs">
        <a href={`${r.name}-expected.png`}>
          <img src={`${r.name}-expected.png`} />
        </a>
        <a href={`${r.name}-actual.png`}>
          <img src={`${r.name}-actual.png`} />
        </a>
        <a href={`${r.name}-diff.png`}>
          <img src={`${r.name}-diff.png`} />
        </a>
      </td>
      <td className="err-cell">
        {r.error != null ? <div className="err">{r.error}</div> : null}
        {r.skipReason != null ? <div className="skip-note">{`skipped: ${r.skipReason}`}</div> : null}
        {(r.warnings ?? []).length > 0 ? (
          <ul className="warn-list">
            {(r.warnings ?? []).map((w) => (
              <li>
                <b>{w.feature}</b>
                {` · ${w.selector} — ${w.detail}`}
              </li>
            ))}
          </ul>
        ) : null}
      </td>
    </tr>
  );
}

function MetricsLegend() {
  return (
    <p className="legend">
      {`Verdicts: clean (no regions) · trivial (≤2 regions, <0.05% coverage) · minor (≤5 regions, <0.5%) · moderate (≤15 regions, <2%) · major (everything past that). Pipeline (DM-715): neighborhood-tolerant shift filter → Yee AA filter → 3-px dilation + flood-fill → area + high-severity gates. "shifty" = font-substitution regions culled by the high-sev gate; "scatter" = sub-area components; "shifted" = pixels absorbed by neighborhood matching. Big shifty/shifted with low region count means the filters did real work. Magenta outlines on diff.png mark surviving regions; yellow box marks the worst tile.`}
    </p>
  );
}

function IndexLayout({ results }: { results: TestResult[] }) {
  const passCount = results.filter((r) => r.pass).length;
  const failCount = results.filter((r) => !r.pass && !r.skipped).length;
  const skipCount = results.filter((r) => r.skipped).length;
  return (
    <html>
      <head>
        <meta charset="utf-8" />
        <title>domotion html-test results</title>
        {/* eslint-disable-next-line kerfjs/no-raw-with-dynamic-arg -- static CSS string constant */}
        <style>{raw(INDEX_CSS)}</style>
      </head>
      <body>
        <h1>{`domotion vs html-test (${results.length} files; ${passCount} pass · ${failCount} fail · ${skipCount} skip)`}</h1>
        <MetricsLegend />
        <table>
          <thead>
            <tr>
              <th>File</th>
              <th>Status</th>
              <th>Diff</th>
              <th>Expected · Actual · Diff</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <ResultRow r={r} />
            ))}
          </tbody>
        </table>
      </body>
    </html>
  );
}

export function buildIndexHtml(results: TestResult[]): string {
  return `<!DOCTYPE html>${(<IndexLayout results={results} />).toString()}`;
}

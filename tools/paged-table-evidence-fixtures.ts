/**
 * Source-owned paged collapsed-table corpus shared by the public fail-closed
 * audit and the pinned private renderer helper. The markup contains no
 * expected logical answers; those must come from Blink's print fragments.
 */

export const REQUIRED_PAGED_COLLAPSED_TABLE_MATRIX = [
  "whole-row",
  "continued-row",
  "repeated-header-footer",
  "caption",
  "span-joint",
  "vertical-lr-positive",
  "vertical-rl-negative",
  "empty-terminal-page",
] as const;

export type PagedCollapsedTableMatrixCell =
  typeof REQUIRED_PAGED_COLLAPSED_TABLE_MATRIX[number];

export interface PagedTableEvidenceFixture {
  id: string;
  matrix: PagedCollapsedTableMatrixCell[];
  html: string;
}

const style = `
  @page{size:300px 240px;margin:0}
  html,body{margin:0;padding:0}
  table{border-collapse:collapse;inline-size:280px}
  th,td{box-sizing:border-box;border:6px solid #2563eb;padding:0;block-size:42px}
  thead,tfoot{break-inside:avoid}
`;

const rows = (count: number, cell = "<td></td>"): string =>
  Array.from({ length: count }, (_, index) =>
    `<tr data-row="${index}">${cell}</tr>`).join("");

export const PAGED_TABLE_EVIDENCE_FIXTURES: readonly PagedTableEvidenceFixture[] = [
  {
    id: "whole-row-pages",
    matrix: ["whole-row"],
    html: `<!doctype html><style>${style}tr{break-inside:avoid}</style><table id="table"><tbody>${rows(15)}</tbody></table>`,
  },
  {
    id: "continued-row-pages",
    matrix: ["continued-row"],
    html: `<!doctype html><style>${style}.continued{block-size:520px;break-inside:auto}</style><table id="table"><tbody><tr class="continued"><td></td></tr>${rows(2)}</tbody></table>`,
  },
  {
    id: "repeated-sections",
    matrix: ["repeated-header-footer"],
    html: `<!doctype html><style>${style}thead th{border-block-start-width:10px}tfoot td{border-block-end-width:12px}</style><table id="table"><thead><tr><th></th></tr></thead><tbody>${rows(16)}</tbody><tfoot><tr><td></td></tr></tfoot></table>`,
  },
  {
    id: "caption-and-span-joints",
    matrix: ["caption", "span-joint"],
    html: `<!doctype html><style>${style}caption{block-size:90px}col:first-child{inline-size:35%}col:last-child{inline-size:65%}</style><table id="table"><caption></caption><colgroup><col><col></colgroup><tbody><tr><td rowspan="3"></td><td></td></tr><tr><td></td></tr><tr><td></td></tr><tr><td colspan="2"></td></tr>${rows(10, "<td></td><td></td>")}</tbody></table>`,
  },
  {
    id: "vertical-lr-pages",
    matrix: ["vertical-lr-positive"],
    html: `<!doctype html><style>${style}body{writing-mode:vertical-lr}table{writing-mode:vertical-lr;block-size:280px}tr{break-inside:avoid}</style><table id="table"><tbody>${rows(15)}</tbody></table>`,
  },
  {
    id: "vertical-rl-pages",
    matrix: ["vertical-rl-negative"],
    html: `<!doctype html><style>${style}body{writing-mode:vertical-rl}table{writing-mode:vertical-rl;block-size:280px}tr{break-inside:avoid}</style><table id="table"><tbody>${rows(15)}</tbody></table>`,
  },
  {
    id: "empty-terminal-page",
    matrix: ["empty-terminal-page"],
    html: `<!doctype html><style>${style}.terminal{break-before:page;block-size:0}</style><table id="table"><tbody>${rows(6)}</tbody></table><div class="terminal"></div>`,
  },
];

export function validatePagedTableEvidenceFixtures(): string[] {
  const errors: string[] = [];
  const covered = new Set(PAGED_TABLE_EVIDENCE_FIXTURES.flatMap((row) => row.matrix));
  for (const cell of REQUIRED_PAGED_COLLAPSED_TABLE_MATRIX) {
    if (!covered.has(cell)) errors.push(`missing paged table matrix cell ${cell}`);
  }
  if (new Set(PAGED_TABLE_EVIDENCE_FIXTURES.map((row) => row.id)).size
      !== PAGED_TABLE_EVIDENCE_FIXTURES.length) {
    errors.push("duplicate paged table fixture id");
  }
  return errors;
}

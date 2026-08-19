import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const matrixPath = resolve(root, "tools/parity-program.json");
const matrix = JSON.parse(await readFile(matrixPath, "utf8"));
const errors = [];
const ids = new Set();
const sourceAuditValues = new Set(["audited", "in-progress", "partial", "not-applicable"]);
const oracleStatusValues = new Set([
  "exact-stage-gate",
  "partial-stage-gate",
  "paint-model-gate",
  "visual-only",
  "documented-classifier",
  "pixel-integration-gate"
]);

async function requirePath(path, label) {
  try {
    await access(resolve(root, path));
  } catch {
    errors.push(`${label} references missing path: ${path}`);
  }
}

if (matrix.schemaVersion !== 1) errors.push("schemaVersion must be 1");
await requirePath(matrix.contract, "contract");

for (const area of matrix.areas ?? []) {
  if (!area.id || ids.has(area.id)) errors.push(`duplicate or empty area id: ${area.id ?? "<empty>"}`);
  ids.add(area.id);
  if (!sourceAuditValues.has(area.sourceAudit)) errors.push(`${area.id}: invalid sourceAudit ${area.sourceAudit}`);
  if (!oracleStatusValues.has(area.oracleStatus)) errors.push(`${area.id}: invalid oracleStatus ${area.oracleStatus}`);
  if (!area.knownGap?.trim()) errors.push(`${area.id}: knownGap must be explicit`);
  if (!area.nextAction?.trim()) errors.push(`${area.id}: nextAction must be explicit`);
  if (!area.platformCoverage?.length) errors.push(`${area.id}: platformCoverage must not be empty`);
  for (const path of area.domotionSources ?? []) await requirePath(path, area.id);
  for (const path of area.upstreamSources ?? []) await requirePath(path, area.id);
  if (area.oracle) await requirePath(area.oracle, area.id);
  if (area.browserOracle) await requirePath(area.browserOracle, area.id);
}

if (!matrix.areas?.some((area) => ["partial-stage-gate", "visual-only", "documented-classifier"].includes(area.oracleStatus))) {
  errors.push("matrix must preserve explicitly unresolved areas until every decision stage has an exact oracle");
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log(`Parity program is structurally valid (${matrix.areas.length} areas).`);

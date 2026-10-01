// Select one complete font-conformance shard topology from authenticated CI
// runs. Runner-image rollouts can split a single matrix across environments;
// summing that matrix would make its baseline meaningless. The workflow checks
// every source run against GitHub's run API before writing provenance.json.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFontShardReport, environmentConflicts } from "./merge-font-conformance-shards.mjs";

function required(value, label) {
  if (value == null || value === "") throw new Error(`missing ${label}`);
  return value;
}

function identity(candidate) {
  const m = candidate.report.meta;
  const env = candidate.env;
  const fields = {
    platform: required(m.platform, "platform"),
    arch: required(m.arch, "architecture"),
    node: required(m.node, "Node version"),
    chromium: required(m.chromium, "Chromium version"),
    unicode: required(m.unicode, "Unicode version"),
    icu: required(m.icu, "ICU version"),
    corpus: required(m.stackCorpusGeneratedAt, "stack corpus identity"),
    corpusFile: required(m.stacksFile, "stack corpus file"),
    corpusPlatform: required(m.stackCorpusPlatform, "stack corpus platform"),
    includePua: m.includePua ?? null,
    strictAlias: m.strictAlias ?? null,
    lang: m.lang ?? null,
    stackFilter: m.stackFilter ?? null,
    sampleByte: m.sampleByte ?? null,
    ranges: m.ranges ?? null,
    oracleIsolation: required(m.oracleIsolation, "oracle isolation"),
    parityEnvironment: required(m.parityEnvironment, "parity environment"),
    // DM-EBRC7F's unified producer records the exact hosted image revision.
    // ImageOS alone is stable across a rollout and cannot authenticate pairing.
    imageVersion: required(m.parityEnvironment?.imageVersion, "runner image version"),
    rotationRevision: m.rotationRevision ?? null,
    rotationOrdinal: m.rotationOrdinal ?? null,
    rotationStackBucket: m.rotationStackBucket ?? null,
    image: required(env.image, "runner image"),
    fontInventoryDigest: required(env.fontInventory?.digest, "font inventory digest"),
  };
  return JSON.stringify(fields);
}

function cellOf(report, stackTotal, cpTotal, cpIndices) {
  const stack = report.meta.stackShard;
  const cp = report.meta.shard;
  if (!Array.isArray(stack) || stack.length !== 2 || stack[1] !== stackTotal) return null;
  if (!Number.isInteger(stack[0]) || stack[0] < 1 || stack[0] > stackTotal) return null;
  const cpIndex = cpTotal === 1 ? 1 : cp?.[0];
  if (cpTotal === 1 ? cp != null : !Array.isArray(cp) || cp.length !== 2 || cp[1] !== cpTotal) return null;
  if (!cpIndices.includes(cpIndex)) return null;
  return `${stack[0]}:${cpIndex}`;
}

export function readCandidates(root, { sourceSha, workflowPath, os }) {
  const candidates = [];
  if (!existsSync(root)) return candidates;
  for (const runName of readdirSync(root).sort()) {
    const runDir = join(root, runName);
    const provenancePath = join(runDir, "provenance.json");
    if (!existsSync(provenancePath)) throw new Error(`${runName}: missing authenticated provenance`);
    const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
    if (
      runName !== `run-${provenance.runId}` ||
      provenance.headSha !== sourceSha ||
      provenance.workflowPath !== workflowPath
    )
      throw new Error(`${runName}: source commit or workflow does not match authenticated cohort`);
    for (const artifact of readdirSync(runDir).sort()) {
      if (!artifact.startsWith("font-conformance-") || !artifact.includes(`${os}-shard-`)) continue;
      const artifactDir = join(runDir, artifact);
      const reportPath = join(artifactDir, "report.json");
      const imagePath = join(artifactDir, "runner-image.txt");
      const inventoryPath = join(artifactDir, "font-inventory.json");
      if (!existsSync(reportPath) || !existsSync(imagePath) || !existsSync(inventoryPath)) continue;
      const envelope = JSON.parse(readFileSync(reportPath, "utf8"));
      const report = readFontShardReport(reportPath);
      const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
      const env = { image: readFileSync(imagePath, "utf8").trim(), fontInventory: inventory };
      if ((os === "windows" ? "win32" : os === "macos" ? "darwin" : "linux") !== report.meta.platform) continue;
      const parity = report.meta.parityEnvironment;
      if (
        envelope.env?.imageVersion !== parity?.imageVersion ||
        env.image !== parity?.image ||
        inventory.digest !== parity?.fontInventory?.digest
      )
        throw new Error(`${runName}/${artifact}: report and sidecar environment fingerprints disagree`);
      candidates.push({ name: artifact, path: artifactDir, runId: provenance.runId, report, env });
    }
  }
  return candidates;
}

/** A complete cohort uses one identity for every required (stack, codepoint) cell. */
export function selectCohort(candidates, { stackTotal, cpTotal = 1, cpIndices = [1] }) {
  if (!Number.isInteger(stackTotal) || stackTotal < 1 || !Number.isInteger(cpTotal) || cpTotal < 1)
    throw new Error("invalid shard topology");
  if (cpIndices.length === 0 || cpIndices.some((index) => !Number.isInteger(index) || index < 1 || index > cpTotal))
    throw new Error("invalid codepoint shard indices");
  const wanted = [];
  for (let stack = 1; stack <= stackTotal; stack++) for (const cp of cpIndices) wanted.push(`${stack}:${cp}`);
  const groups = new Map();
  for (const candidate of candidates) {
    const cell = cellOf(candidate.report, stackTotal, cpTotal, cpIndices);
    if (cell == null) continue;
    const key = identity(candidate);
    if (!groups.has(key)) groups.set(key, new Map());
    const cells = groups.get(key);
    const previous = cells.get(cell);
    // A retry of the same cell is legitimate. Choose latest run, then name.
    if (
      previous == null ||
      Number(candidate.runId) > Number(previous.runId) ||
      (candidate.runId === previous.runId && candidate.name > previous.name)
    )
      cells.set(cell, candidate);
  }
  const complete = [...groups.entries()]
    .filter(([, cells]) => wanted.every((cell) => cells.has(cell)))
    .sort(
      (a, b) =>
        Math.max(...[...b[1].values()].map((c) => Number(c.runId))) -
        Math.max(...[...a[1].values()].map((c) => Number(c.runId))),
    );
  if (complete.length === 0) {
    const coverage = [...groups.values()].map((cells) => `${cells.size}/${wanted.length}`).join(", ") || "none";
    throw new Error(`no complete same-environment shard cohort (coverage: ${coverage})`);
  }
  const selected = wanted.map((cell) => complete[0][1].get(cell));
  const conflicts = environmentConflicts(selected);
  if (conflicts.length > 0)
    throw new Error(`selected cohort has environment conflicts: ${conflicts.map((c) => c.field).join(", ")}`);
  return { identity: JSON.parse(complete[0][0]), selected, topology: { stackTotal, cpTotal, cpIndices } };
}

export function writeCohort(cohort, outDir, manifestPath) {
  mkdirSync(outDir, { recursive: true });
  const provenance = [];
  cohort.selected.forEach((candidate, index) => {
    const cell = `${candidate.report.meta.stackShard[0]}-cp${candidate.report.meta.shard?.[0] ?? 1}`;
    cpSync(candidate.path, join(outDir, `selected-${cell}`), { recursive: true });
    provenance.push({ cell, runId: candidate.runId, artifact: candidate.name, position: index + 1 });
  });
  writeFileSync(
    manifestPath,
    JSON.stringify({ ...cohort.topology, identity: cohort.identity, provenance }, null, 2) + "\n",
  );
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const cpTotal = Number(get("--cp-total") ?? 1);
  const cpIndex = get("--cp-index") ?? "1";
  const cpIndices = cpIndex === "all" ? Array.from({ length: cpTotal }, (_, i) => i + 1) : [Number(cpIndex)];
  const candidates = readCandidates(required(get("--candidates"), "candidate directory"), {
    sourceSha: required(get("--source-sha"), "source SHA"),
    workflowPath: required(get("--workflow-path"), "workflow path"),
    os: required(get("--os"), "OS"),
  });
  const cohort = selectCohort(candidates, { stackTotal: Number(get("--stack-total")), cpTotal, cpIndices });
  writeCohort(cohort, required(get("--out"), "output directory"), required(get("--manifest"), "manifest path"));
  process.stderr.write(
    `selected ${cohort.selected.length} same-environment shards from runs ${[...new Set(cohort.selected.map((s) => s.runId))].join(", ")}\n`,
  );
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) main();

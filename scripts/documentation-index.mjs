#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = resolve(projectRoot, "docs");
const generatedJsonPath = resolve(docsRoot, "index.json");
const generatedMarkdownPath = resolve(docsRoot, "generated-index.md");
const generatedArchivePath = resolve(docsRoot, "archive", "index.md");
const generatedManifestPath = resolve(docsRoot, "ai", "manifest.json");
const generatedPacketsRoot = resolve(docsRoot, "ai", "packets");
const write = process.argv.includes("--write");

const numberedDocument = /^([0-9]+)-(.+)\.md$/;
const metadataFields = [
  "id", "title", "kind", "status", "owners", "platforms", "tickets", "code", "aliases",
];

function files() {
  const discovered = [];
  const walk = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(resolve(directory, entry.name), name);
      else if (entry.name.endsWith(".md") && (numberedDocument.test(entry.name) || prefix === "handbook")) discovered.push(name);
    }
  };
  walk(docsRoot);
  return discovered
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
}

function titleOf(body, filename) {
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading.replace(/[*`]/g, "");
  return filename.replace(numberedDocument, "$2").replaceAll("-", " ");
}

function inferredKind(slug, opening, status) {
  if (slug.includes("investigation")) return "investigation";
  if (status === "proposed") return "proposal";
  if (/(audit|oracle|parity|conformance|calibration|evidence|verification)/.test(slug)) {
    return "evidence";
  }
  if (/(reference|grammar|diagram)/.test(slug)) return "reference";
  if (/\b(retired|superseded|deprecated)\b/i.test(opening)) return "archive";
  return "contract";
}

function inferredStatus(opening) {
  if (/\b(superseded|retired|deprecated)\b/i.test(opening)) return "superseded";
  if (/\b(draft|proposed|awaiting feedback)\b/i.test(opening)) return "proposed";
  if (/\b(partial|not ready|not started|not implemented)\b/i.test(opening)) return "partial";
  return "current";
}

function inferredOwners(slug) {
  const owners = [];
  const add = (owner, pattern) => { if (pattern.test(slug)) owners.push(owner); };
  add("text-fonts", /font|glyph|text|shap|unicode|bidi|decoration|caret|writing|mathml|emoji|cluster/);
  add("images-media", /image|raster|canvas|video|media|sprite|replaced|broken/);
  add("paint-effects", /gradient|mask|clip|filter|blend|backdrop|border|paint|color|shadow/);
  add("layout", /layout|geometry|transform|fragment|table|flex|iframe|scroll|viewbox|culling|position/);
  add("animation", /animat|transition|timeline|typing|storyboard|overlay|cursor/);
  add("platform-release", /platform|linux|windows|macos|release|parity|conformance|oracle|audit/);
  add("product-tooling", /cli|api|demo|template|format|brand|terminal|review|schema|coverage/);
  return owners.length ? [...new Set(owners)] : ["rendering"];
}

function inferredPlatforms(body) {
  const lower = body.toLowerCase();
  return [
    ["macos", /\bmacos\b|\bcoretext\b/],
    ["linux", /\blinux\b|\bfontconfig\b/],
    ["windows", /\bwindows\b|\bdirectwrite\b/],
  ].filter(([, pattern]) => pattern.test(lower)).map(([platform]) => platform);
}

function inferredCode(body) {
  const paths = new Set();
  const pattern = /`((?:src|tools|scripts|tests|site|examples|clients|packages|\.github)\/[A-Za-z0-9_./@+-]+)`/g;
  for (const match of body.matchAll(pattern)) {
    const path = match[1].replace(/[.,;:]+$/, "");
    if (existsSync(resolve(projectRoot, path))) paths.add(path);
  }
  return [...paths].sort();
}

function inferMetadata(filename, body) {
  const [, number, slug] = filename.match(numberedDocument);
  const opening = body.slice(0, 1600);
  const status = inferredStatus(opening);
  return {
    id: `requirements/${slug}`,
    title: titleOf(body, filename),
    kind: inferredKind(slug, opening, status),
    status,
    owners: inferredOwners(slug),
    platforms: inferredPlatforms(body),
    tickets: [...new Set(body.match(/\b(?:DM|SK|KF)-[0-9]+\b/g) ?? [])].sort(),
    code: inferredCode(body),
    aliases: [`docs/${filename}`, `doc-${number}`],
  };
}

function serializeFrontMatter(metadata) {
  const lines = metadataFields.map((field) => `${field}: ${JSON.stringify(metadata[field])}`);
  return `---\n${lines.join("\n")}\n---\n\n`;
}

function parseDocument(filename, source) {
  if (!source.startsWith("---\n")) return { metadata: null, body: source };
  const end = source.indexOf("\n---\n", 4);
  if (end < 0) throw new Error(`${filename}: unterminated front matter`);
  const metadata = {};
  for (const line of source.slice(4, end).split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`${filename}: invalid front-matter line ${line}`);
    const field = line.slice(0, separator);
    if (!metadataFields.includes(field)) throw new Error(`${filename}: unknown metadata field ${field}`);
    metadata[field] = JSON.parse(line.slice(separator + 1).trim());
  }
  return { metadata, body: source.slice(end + 5).replace(/^\n/, "") };
}

function validateMetadata(filename, metadata) {
  const errors = [];
  for (const field of metadataFields) if (!(field in metadata)) errors.push(`${filename}: missing ${field}`);
  if (!/^(?:requirements|handbook)\/[a-z0-9-]+$/.test(metadata.id ?? "")) errors.push(`${filename}: invalid stable id`);
  if (!["contract", "reference", "evidence", "investigation", "proposal", "archive"].includes(metadata.kind)) {
    errors.push(`${filename}: invalid kind`);
  }
  if (!["current", "partial", "proposed", "superseded", "retired"].includes(metadata.status)) {
    errors.push(`${filename}: invalid status`);
  }
  for (const field of ["owners", "platforms", "tickets", "code", "aliases"]) {
    if (!Array.isArray(metadata[field])) errors.push(`${filename}: ${field} must be an array`);
  }
  return errors;
}

function internalLinkErrors(filename, body) {
  const errors = [];
  for (const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim().replace(/^<|>$/g, "");
    if (!target || /^(?:https?:|mailto:|data:|#)/.test(target)) continue;
    target = target.split("#", 1)[0].split("?", 1)[0];
    if (!target || target.includes(" ")) continue;
    const resolved = resolve(docsRoot, dirname(filename), target);
    if (!existsSync(resolved)) errors.push(`${filename}: broken internal link ${match[1]}`);
  }
  return errors;
}

function generatedArtifacts(entries) {
  const historicalNumbers = {};
  const defaultEntries = entries.filter((entry) =>
    !["archive", "proposal", "investigation"].includes(entry.metadata.kind)
    && !["proposed", "superseded", "retired"].includes(entry.metadata.status));
  for (const entry of entries) {
    const number = entry.file.split("/").pop().match(numberedDocument)?.[1];
    if (number == null) continue;
    (historicalNumbers[number] ??= []).push(entry.metadata.id);
  }
  const json = `${JSON.stringify({ schemaVersion: 1, entries, historicalNumbers }, null, 2)}\n`;
  const groups = new Map();
  for (const entry of defaultEntries) {
    const owner = entry.metadata.owners[0];
    const rows = groups.get(owner) ?? [];
    rows.push(entry);
    groups.set(owner, rows);
  }
  const markdown = [
    "# Generated documentation index",
    "",
    "Generated by `npm run docs:index:generate`. Edit document front matter, not this file.",
    "",
  ];
  for (const owner of [...groups.keys()].sort()) {
    markdown.push(`## ${owner}`, "");
    for (const entry of groups.get(owner)) {
      markdown.push(`- [${entry.metadata.title}](${entry.file}) — ${entry.metadata.kind}; ${entry.metadata.status}; \`${entry.metadata.id}\``);
    }
    markdown.push("");
  }
  const historical = entries.filter((entry) => !defaultEntries.includes(entry));
  const archive = [
    "# Documentation archive index", "",
    "Generated from lifecycle metadata. Historical files remain at their alias paths so old links and ticket references continue to resolve.", "",
    ...historical.map((entry) => `- [${entry.metadata.title}](../${entry.file}) — ${entry.metadata.kind}; ${entry.metadata.status}; \`${entry.metadata.id}\``),
    "",
  ].join("\n");
  const manifest = `${JSON.stringify({
    schemaVersion: 1,
    entries: entries.map(({ file, metadata }) => ({
      id: metadata.id, title: metadata.title, kind: metadata.kind, status: metadata.status,
      owners: metadata.owners, platforms: metadata.platforms, code: metadata.code, file,
    })),
  }, null, 2)}\n`;
  const packets = {};
  for (const owner of [...groups.keys()].sort()) {
    const rows = defaultEntries.filter((entry) => entry.metadata.owners.includes(owner));
    packets[`${owner}.md`] = [
      `# ${owner} documentation packet`, "",
      "Generated from current and partial documentation metadata. Read the linked handbook first when present, then open only the records needed for the task.", "",
      ...rows.map((entry) => `- [${entry.metadata.title}](../../${entry.file}) — ${entry.metadata.kind}; ${entry.metadata.status}; \`${entry.metadata.id}\`; code: ${entry.metadata.code.map((path) => `\`${path}\``).join(", ") || "unmapped"}`),
      "",
    ].join("\n");
  }
  return { json, markdown: `${markdown.join("\n").trimEnd()}\n`, archive, manifest, packets };
}

const errors = [];
const entries = [];
const ids = new Map();
for (const filename of files()) {
  const path = resolve(docsRoot, filename);
  const source = readFileSync(path, "utf8");
  let { metadata, body } = parseDocument(filename, source);
  if (!metadata && write) {
    metadata = inferMetadata(filename, body);
    writeFileSync(path, `${serializeFrontMatter(metadata)}${body}`);
  }
  if (!metadata) {
    errors.push(`${filename}: missing front matter; run npm run docs:index:generate`);
    continue;
  }
  errors.push(...validateMetadata(filename, metadata));
  errors.push(...internalLinkErrors(filename, body));
  if (ids.has(metadata.id)) errors.push(`${filename}: duplicate stable id also used by ${ids.get(metadata.id)}`);
  ids.set(metadata.id, filename);
  entries.push({ file: filename, metadata });
}

const generated = generatedArtifacts(entries);
for (const page of ["README.md", "ai/code-summary.md", "ai/requirements-summary.md"]) {
  const count = readFileSync(resolve(docsRoot, page), "utf8").split("\n").length;
  if (count > 400) errors.push(`${page}: default-context budget exceeded (${count} > 400 lines)`);
}
for (const entry of entries.filter((entry) => entry.metadata.id.startsWith("handbook/"))) {
  if (entry.metadata.code.length === 0) errors.push(`${entry.file}: handbook requires an owning code/test path`);
  const count = readFileSync(resolve(docsRoot, entry.file), "utf8").split("\n").length;
  if (count > 250) errors.push(`${entry.file}: handbook budget exceeded (${count} > 250 lines)`);
}
if (write) {
  mkdirSync(dirname(generatedArchivePath), { recursive: true });
  mkdirSync(generatedPacketsRoot, { recursive: true });
  writeFileSync(generatedJsonPath, generated.json);
  writeFileSync(generatedMarkdownPath, generated.markdown);
  writeFileSync(generatedArchivePath, generated.archive);
  writeFileSync(generatedManifestPath, generated.manifest);
  for (const [name, content] of Object.entries(generated.packets)) writeFileSync(resolve(generatedPacketsRoot, name), content);
} else {
  for (const [path, expected] of [
    [generatedJsonPath, generated.json],
    [generatedMarkdownPath, generated.markdown],
    [generatedArchivePath, generated.archive],
    [generatedManifestPath, generated.manifest],
    ...Object.entries(generated.packets).map(([name, content]) => [resolve(generatedPacketsRoot, name), content]),
  ]) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== expected) {
      errors.push(`${relative(projectRoot, path)} is stale; run npm run docs:index:generate`);
    }
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`documentation index ${write ? "generated" : "verified"}: ${entries.length} documents`);
}

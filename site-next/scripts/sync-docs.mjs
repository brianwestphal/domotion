// DM-1308: docs-sync — generate reference pages from in-repo sources of truth so
// the site's Developer docs can never drift from the code/schema. We deliberately
// do NOT copy the repo's docs/*.md verbatim: those are internal requirements docs
// carrying local-only ticket references (DM-XXX) that mustn't reach a public site.
// Instead we render the machine-readable contracts the package actually ships:
//
//   • schemas/animate-config.schema.json  → developer/reference/animate-config-reference.md
//
// Output goes under src/content/docs/developer/reference/ (gitignored — regenerated
// every prebuild). The hand-authored Developer pages link to these generated
// references for the exhaustive, always-current field list. (Note: the dir must
// NOT start with `_` — Astro content collections exclude underscore-prefixed
// paths from routing.)
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", ".."); // repo root
const OUT = resolve(HERE, "..", "src", "content", "docs", "developer", "reference");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/** A short, human type label for a JSON-Schema node. */
function typeLabel(node) {
  if (!node || typeof node !== "object") return "";
  if (node.enum) return node.enum.map((v) => `\`${JSON.stringify(v)}\``).join(" \\| ");
  if (node.const !== undefined) return `\`${JSON.stringify(node.const)}\``;
  if (node.type === "array") {
    const it = node.items ? typeLabel(node.items) : "any";
    return `${it}[]`;
  }
  if (node.oneOf || node.anyOf) {
    const variants = (node.oneOf || node.anyOf)
      .map((v) => v.title || v.type || (v.properties && objectShape(v)) || "variant")
      .filter(Boolean);
    return variants.length ? variants.join(" \\| ") : "one of";
  }
  if (Array.isArray(node.type)) return node.type.join(" \\| ");
  return node.type || (node.properties ? "object" : "any");
}

/** A `{a, b, …}` shorthand for an inline object variant. */
function objectShape(node) {
  const keys = Object.keys(node.properties || {});
  if (!keys.length) return "object";
  const shown = keys.slice(0, 4).join(", ");
  return `{ ${shown}${keys.length > 4 ? ", …" : ""} }`;
}

function escapeCell(s) {
  return String(s)
    // Drop internal-doc pointers — those files don't exist on the public site.
    .replace(/\bSee docs\/[0-9][^.]*\.md\.?/gi, "")
    .replace(/\|/g, "\\|")
    .replace(/\n+/g, " ")
    .trim();
}

/** Clean a section description: strip internal-doc pointers, collapse blanks. */
function cleanDesc(s) {
  return String(s).replace(/\bSee docs\/[0-9][^.]*\.md\.?/gi, "").replace(/\s+/g, " ").trim();
}

/** Render an object node's properties as a markdown table. */
function propsTable(node, requiredSet) {
  const props = node.properties || {};
  const keys = Object.keys(props);
  if (!keys.length) return "";
  const rows = keys.map((k) => {
    const p = props[k];
    const req = requiredSet.has(k) ? "✔" : "";
    const def = p.default !== undefined ? `\`${JSON.stringify(p.default)}\`` : "";
    const desc = escapeCell(p.description || "");
    return `| \`${k}\` | ${typeLabel(p)} | ${req} | ${def} | ${desc} |`;
  });
  return [
    "| Field | Type | Required | Default | Description |",
    "|---|---|---|---|---|",
    ...rows,
  ].join("\n");
}

/** The variant label for a oneOf/anyOf member (its `kind`/`type` const, or title). */
function variantLabel(v) {
  return (
    v.title ||
    (v.properties?.kind && v.properties.kind.const) ||
    (v.properties?.type && v.properties.type.const) ||
    "variant"
  );
}

/**
 * Walk a node, emitting a heading + props table for it and a recursive section
 * for each nested object/array-of-object property worth its own table.
 * `title` is concise (just the leaf key/variant); heading depth conveys nesting.
 */
function emitSection(out, node, title, level, seen) {
  if (!node || level > 6) return;
  // Unwrap a single-object array (e.g. frames: array of frame objects).
  let obj = node;
  if (node.type === "array" && node.items) obj = node.items;

  // A oneOf/anyOf of objects → document each labeled variant as a sub-section.
  const variants = obj.oneOf || obj.anyOf;
  if (variants && variants.some((v) => v.properties)) {
    out.push(`${"#".repeat(Math.min(level, 6))} ${title}`, "");
    const d = cleanDesc(node.description || obj.description || "");
    if (d) out.push(d, "");
    out.push(`One of ${variants.length} variants:`, "");
    for (const v of variants) {
      if (!v.properties) continue;
      emitSection(out, v, `${title}: \`${variantLabel(v)}\``, level + 1, seen);
    }
    return;
  }

  if (!obj.properties) return;

  out.push(`${"#".repeat(Math.min(level, 6))} ${title}`, "");
  const d = cleanDesc(obj.description || node.description || "");
  if (d) out.push(d, "");
  out.push(propsTable(obj, new Set(obj.required || [])), "");

  // Recurse into nested objects / arrays-of-objects that have their own shape.
  for (const [k, p] of Object.entries(obj.properties)) {
    const child = p.type === "array" && p.items ? p.items : p;
    const hasShape =
      child && (child.properties || ((child.oneOf || child.anyOf) || []).some((v) => v.properties));
    if (hasShape) emitSection(out, p, `\`${k}\``, level + 1, seen);
  }
}

function generateAnimateConfigReference() {
  const schemaPath = resolve(ROOT, "schemas", "animate-config.schema.json");
  const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));
  const out = [];
  out.push("---");
  out.push("title: Animate config — full field reference");
  out.push(
    "description: Every field of the domotion animate JSON config, generated from the published JSON Schema."
  );
  out.push("---");
  out.push("");
  out.push(
    "<!-- AUTOGENERATED by site-next/scripts/sync-docs.mjs from " +
      "schemas/animate-config.schema.json. Do not edit by hand — edit the schema " +
      "and re-run the build. -->"
  );
  out.push("");
  out.push(
    "This page is generated directly from `schemas/animate-config.schema.json` — " +
      "the same schema the CLI validates against and ships in the npm package — so " +
      "it can never drift from what `domotion animate` actually accepts. For a " +
      "guided introduction see [Animate config format](/domotion/developer/animate-config/)."
  );
  out.push("");

  const seen = new Set();

  // Top level — scalar fields + cursor (but NOT frames; the frame shape gets its
  // own top-billing "## Frame" section below so it isn't buried under a breadcrumb).
  out.push("## Top-level config", "");
  const d = cleanDesc(schema.description || "");
  if (d) out.push(d, "");
  out.push(propsTable(schema, new Set(schema.required || [])), "");
  for (const [k, p] of Object.entries(schema.properties || {})) {
    if (k === "frames") continue;
    const child = p.type === "array" && p.items ? p.items : p;
    const hasShape =
      child && (child.properties || ((child.oneOf || child.anyOf) || []).some((v) => v.properties));
    if (hasShape) emitSection(out, p, `\`${k}\``, 3, seen);
  }

  // The frame is the heart of the config — give it its own clean tree.
  const frames = schema.properties?.frames;
  if (frames) {
    out.push("## Frame", "");
    out.push(
      "Each entry in `frames`. The first frame must have an `input` (or " +
        "`template`/`cast`); later frames may set `continue: true` to keep driving " +
        "the same page.",
      ""
    );
    const frameObj = frames.items || frames;
    out.push(propsTable(frameObj, new Set(frameObj.required || [])), "");
    for (const [k, p] of Object.entries(frameObj.properties || {})) {
      const child = p.type === "array" && p.items ? p.items : p;
      const hasShape =
        child && (child.properties || ((child.oneOf || child.anyOf) || []).some((v) => v.properties));
      if (hasShape) emitSection(out, p, `\`${k}\``, 3, seen);
    }
  }

  writeFileSync(resolve(OUT, "animate-config-reference.md"), out.join("\n") + "\n");
  return "animate-config-reference.md";
}

const wrote = [generateAnimateConfigReference()];
console.log(`[sync-docs] generated ${wrote.length} reference page(s) → ${OUT}/${wrote.join(", ")}`);

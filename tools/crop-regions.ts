#!/usr/bin/env tsx
/**
 * DM-575 — CLI helper that crops Hot Sheet attachments to the rectangles
 * encoded in a ticket's REGIONS: block (see docs/31-region-feedback.md).
 *
 * Reads `.hotsheet/settings.json` for the local Hot Sheet port + secret,
 * fetches the ticket via the API, parses the latest note (falling back to
 * the ticket's `details` field), runs the DM-574 plan + execute pipeline
 * against the ticket's image attachments, and prints the per-rectangle
 * crop paths so an AI-iteration loop can read them.
 *
 * Usage:
 *   npx tsx tools/crop-regions.ts --ticket DM-564
 *   npx tsx tools/crop-regions.ts --id 564 [--output-root tests/output/region-crops]
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

import {
  executeRegionCrops,
  parseRegionsBlock,
  planRegionCrops,
  type Region,
} from "../src/region-feedback.js";

interface Settings { port: number; secret: string }

interface RawAttachment { stored_path: string; original_filename: string }
interface RawNote { id?: string; text: string; created_at?: string }
interface RawTicket {
  id: number;
  ticket_number: string;
  details: string | null;
  notes: string | RawNote[] | null;
  attachments: RawAttachment[] | null;
}

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(TOOL_DIR, "..");
const SETTINGS_PATH = resolve(PROJECT_ROOT, ".hotsheet/settings.json");
const DEFAULT_OUTPUT_ROOT = resolve(PROJECT_ROOT, "tests/output/region-crops");

function loadSettings(): Settings {
  if (!existsSync(SETTINGS_PATH)) {
    throw new Error(`Hot Sheet settings not found at ${SETTINGS_PATH} — is Hot Sheet set up for this project?`);
  }
  const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as { port?: number; secret?: string };
  if (raw.port == null || raw.secret == null) throw new Error("Hot Sheet settings missing port or secret");
  return { port: raw.port, secret: raw.secret };
}

function parseArgs(argv: string[]): { id: number; outputRoot: string } {
  let id: number | null = null;
  let outputRoot = DEFAULT_OUTPUT_ROOT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ticket" || a === "-t") {
      const v = argv[++i] ?? "";
      const m = /^(?:DM-)?(\d+)$/.exec(v);
      if (m == null) throw new Error(`Bad --ticket value: ${v}`);
      id = Number(m[1]);
    } else if (a === "--id") {
      id = Number(argv[++i]);
    } else if (a === "--output-root") {
      outputRoot = resolve(process.cwd(), argv[++i] ?? "");
    } else if (a === "--help" || a === "-h") {
      printUsage();
      process.exit(0);
    }
  }
  if (id == null || !Number.isFinite(id)) {
    printUsage();
    throw new Error("Missing --ticket DM-{id} or --id {id}");
  }
  return { id, outputRoot };
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.error("usage: tools/crop-regions.ts --ticket DM-{id} [--output-root tests/output/region-crops]");
}

async function fetchTicket(settings: Settings, id: number): Promise<RawTicket> {
  const resp = await fetch(`http://localhost:${settings.port}/api/tickets/${id}`, {
    headers: { "X-Hotsheet-Secret": settings.secret },
  });
  if (!resp.ok) throw new Error(`Hot Sheet GET /api/tickets/${id} → ${resp.status} ${resp.statusText}`);
  return await resp.json() as RawTicket;
}

function pickRegionsSource(ticket: RawTicket): { source: "note" | "details"; noteId: string; body: string } | null {
  const notes = normalizeNotes(ticket.notes);
  for (let i = notes.length - 1; i >= 0; i--) {
    const n = notes[i]!;
    if (/^REGIONS:\s*$/m.test(n.text)) {
      const noteId = n.id != null && n.id !== "" ? n.id : `note-${i}`;
      return { source: "note", noteId, body: n.text };
    }
  }
  const details = ticket.details ?? "";
  if (/^REGIONS:\s*$/m.test(details)) {
    return { source: "details", noteId: "details", body: details };
  }
  return null;
}

function normalizeNotes(raw: RawTicket["notes"]): RawNote[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return [];
  const trimmed = raw.trim();
  if (trimmed === "") return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) return parsed as RawNote[];
  } catch {
    // Fall through — treat as single legacy text note.
  }
  return [{ text: trimmed }];
}

function pngAttachments(ticket: RawTicket): string[] {
  if (!Array.isArray(ticket.attachments)) return [];
  return ticket.attachments
    .map((a) => a.stored_path)
    .filter((p) => p.toLowerCase().endsWith(".png"));
}

// Canonical triplet naming from the review server: `${name}-expected.png`,
// `${name}-actual.png`, `${name}-diff.png`. Restricts no-image-token fan-out
// to those three so user-pasted screenshots aren't cropped uninvited.
function tripletAttachments(attachmentPaths: string[]): string[] {
  return attachmentPaths.filter((p) => /-(expected|actual|diff)\.png$/i.test(p));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const settings = loadSettings();
  const ticket = await fetchTicket(settings, args.id);
  const picked = pickRegionsSource(ticket);
  if (picked == null) {
    // eslint-disable-next-line no-console
    console.log(`No REGIONS: block found on ${ticket.ticket_number}. Nothing to crop.`);
    return;
  }
  const { regions, warnings: parseWarnings } = parseRegionsBlock(picked.body);
  if (regions.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`REGIONS: block on ${ticket.ticket_number} had no usable entries.`);
    for (const w of parseWarnings) console.warn(`  parse: ${w}`);
    return;
  }
  const attachmentPaths = pngAttachments(ticket);
  if (attachmentPaths.length === 0) {
    throw new Error(`${ticket.ticket_number} has no PNG attachments to crop against.`);
  }
  const tripletPaths = tripletAttachments(attachmentPaths);
  const { plans, warnings: planWarnings } = planRegionCrops({
    regions,
    attachmentPaths,
    tripletPaths: tripletPaths.length > 0 ? tripletPaths : undefined,
    ticketId: args.id,
    noteId: picked.noteId,
    outputRoot: args.outputRoot,
  });
  const { cropped, warnings: execWarnings } = await executeRegionCrops({ plans });
  reportRun(ticket, picked, regions, cropped, [...parseWarnings, ...planWarnings, ...execWarnings]);
}

function reportRun(
  ticket: RawTicket,
  picked: { source: "note" | "details"; noteId: string },
  regions: Region[],
  cropped: Array<{ region: Region; outputPath: string; imageBasename: string }>,
  warnings: string[],
): void {
  // eslint-disable-next-line no-console
  console.log(`${ticket.ticket_number}: ${regions.length} region(s) from ${picked.source} → ${cropped.length} crop(s)`);
  for (const c of cropped) {
    // eslint-disable-next-line no-console
    console.log(`  [${c.region.index}] ${c.imageBasename} → ${c.outputPath}${c.region.caption != null ? `  (${c.region.caption})` : ""}`);
  }
  for (const w of warnings) {
    // eslint-disable-next-line no-console
    console.warn(`  ${w}`);
  }
  if (cropped.length === 0 && warnings.length === 0) {
    // eslint-disable-next-line no-console
    console.warn(`No crops produced — check that ${basename(SETTINGS_PATH)} points at the right Hot Sheet instance.`);
  }
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

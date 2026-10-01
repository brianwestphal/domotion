#!/usr/bin/env tsx
/**
 * DM-575 — CLI helper that crops Hot Sheet attachments to the rectangles
 * encoded in a ticket's REGIONS: block (see docs/31-region-feedback.md).
 *
 * Reads the ticket straight from its Hot Sheet v2 store (headless: no server
 * or secret needed — see `tools/hotsheet-ticket.ts`), falling back to the
 * legacy Hot Sheet HTTP API for a numeric ticket when no store is linked.
 * Parses the latest note carrying a REGIONS: block (falling back to the
 * ticket's details), runs the DM-574 plan + execute pipeline against the
 * ticket's image attachments, and prints the per-rectangle crop paths so an
 * AI-iteration loop can read them.
 *
 * Usage:
 *   npx tsx tools/crop-regions.ts --ticket DM-HAWK2M        # v2 slug
 *   npx tsx tools/crop-regions.ts --ticket DM-564           # legacy number
 *   npx tsx tools/crop-regions.ts --id 564 [--output-root tests/output/region-crops]
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { flag, isMain, parseFlags } from "./lib/cli.js";

import { executeRegionCrops, parseRegionsBlock, planRegionCrops, type Region } from "../src/utils/region-feedback.js";
import {
  parseTicketRef,
  readTicketFromStore,
  resolveStoreDir,
  ticketDisplayId,
  type StoreTicket,
  type TicketRef,
} from "./hotsheet-ticket.js";

interface Settings {
  port: number;
  secret: string;
}

interface RawAttachment {
  stored_path: string;
  original_filename: string;
}
interface RawNote {
  id?: string;
  text: string;
  created_at?: string;
}
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
  // HOTSHEET_PORT / HOTSHEET_SECRET env vars win — newer Hot Sheet versions no
  // longer write `port`/`secret` into .hotsheet/settings.json (the connection
  // details live with the running instance; channel events carry them).
  const envPort = process.env.HOTSHEET_PORT != null ? Number(process.env.HOTSHEET_PORT) : null;
  const envSecret = process.env.HOTSHEET_SECRET;
  if (envPort != null && Number.isFinite(envPort) && envSecret != null && envSecret !== "") {
    return { port: envPort, secret: envSecret };
  }
  if (!existsSync(SETTINGS_PATH)) {
    throw new Error(`Hot Sheet settings not found at ${SETTINGS_PATH} — is Hot Sheet set up for this project?`);
  }
  const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as { port?: number; secret?: string };
  if (raw.port == null || raw.secret == null) {
    throw new Error(
      "Hot Sheet settings missing port or secret — pass HOTSHEET_PORT + HOTSHEET_SECRET env vars (newer Hot Sheet versions don't persist them in settings.json)",
    );
  }
  return { port: raw.port, secret: raw.secret };
}

function validateArgs(argv: string[]): Record<string, string | boolean | undefined> {
  return parseFlags(
    argv.map((arg) => (arg === "-t" ? "--ticket" : arg === "-h" ? "--help" : arg)),
    {
      ticket: { type: "string" },
      id: { type: "string" },
      "output-root": { type: "string" },
      help: { type: "boolean" },
    },
  );
}

export function parseArgs(argv: string[]): { ref: TicketRef; outputRoot: string } {
  const values = validateArgs(argv);
  if (flag(values, "help", false) === true) {
    printUsage();
    process.exit(0);
  }
  const ticket = flag(values, "ticket");
  const id = flag(values, "id");
  const token = typeof ticket === "string" ? ticket : typeof id === "string" ? id : null;
  if (token == null) {
    printUsage();
    throw new Error("Missing --ticket DM-<slug> (or a legacy --id <number>)");
  }
  return {
    ref: parseTicketRef(token),
    outputRoot: resolve(process.cwd(), String(flag(values, "output-root", DEFAULT_OUTPUT_ROOT))),
  };
}

function printUsage(): void {
  console.error("usage: tools/crop-regions.ts --ticket DM-<slug|number> [--output-root tests/output/region-crops]");
}

async function fetchTicket(settings: Settings, id: number): Promise<RawTicket> {
  const resp = await fetch(`http://localhost:${settings.port}/api/tickets/${id}`, {
    headers: { "X-Hotsheet-Secret": settings.secret },
  });
  if (!resp.ok) throw new Error(`Hot Sheet GET /api/tickets/${id} → ${resp.status} ${resp.statusText}`);
  return (await resp.json()) as RawTicket;
}

export function pickRegionsSource(
  ticket: Pick<LoadedTicket, "details" | "notes">,
): { source: "note" | "details"; noteId: string; body: string } | null {
  const notes = ticket.notes;
  for (let i = notes.length - 1; i >= 0; i--) {
    const n = notes[i]!;
    if (/^REGIONS:\s*$/m.test(n.text)) {
      const noteId = n.id != null && n.id !== "" ? n.id : `note-${i}`;
      return { source: "note", noteId, body: n.text };
    }
  }
  const details = ticket.details;
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
  return ticket.attachments.map((a) => a.stored_path).filter((p) => p.toLowerCase().endsWith(".png"));
}

// Canonical triplet naming from the review server: `${name}-expected.png`,
// `${name}-actual.png`, `${name}-diff.png`. Restricts no-image-token fan-out
// to those three so user-pasted screenshots aren't cropped uninvited.
function tripletAttachments(attachmentPaths: string[]): string[] {
  return attachmentPaths.filter((p) => /-(expected|actual|diff)\.png$/i.test(p));
}

/** The fields `main` needs, whichever source (v2 store or legacy API) produced them. */
interface LoadedTicket {
  ticketNumber: string;
  details: string;
  notes: RawNote[];
  /** PNG attachments as absolute paths carrying their ORIGINAL filenames (crop output is named after them). */
  pngPaths: string[];
}

/** The ticket's PNG attachments that exist on disk. The store keeps each under its original filename, which is what names the crops. */
function storePngPaths(ticket: StoreTicket): string[] {
  return ticket.attachments
    .filter((a) => a.filename.toLowerCase().endsWith(".png") && existsSync(a.path))
    .map((a) => a.path);
}

async function loadTicket(ref: TicketRef): Promise<LoadedTicket> {
  const storeDir = resolveStoreDir(PROJECT_ROOT);
  if (storeDir != null) {
    const found = readTicketFromStore(storeDir, ref);
    if (found != null) {
      return {
        ticketNumber: found.slug,
        details: found.details,
        notes: found.notes.filter((n) => n.kind !== "activity").map((n) => ({ id: n.id, text: n.text })),
        pngPaths: storePngPaths(found),
      };
    }
    if (ref.kind === "slug") throw new Error(`${ref.slug} not found in the Hot Sheet store at ${storeDir}`);
  }
  if (ref.kind !== "legacy")
    throw new Error(`no Hot Sheet store is linked for this project (looked for .hotsheet2/store)`);
  const raw = await fetchTicket(loadSettings(), ref.number);
  return {
    ticketNumber: raw.ticket_number,
    details: raw.details ?? "",
    notes: normalizeNotes(raw.notes),
    pngPaths: pngAttachments(raw),
  };
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const ticket = await loadTicket(args.ref);
  const picked = pickRegionsSource(ticket);
  if (picked == null) {
    console.log(`No REGIONS: block found on ${ticket.ticketNumber}. Nothing to crop.`);
    return;
  }
  const { regions, warnings: parseWarnings } = parseRegionsBlock(picked.body);
  if (regions.length === 0) {
    console.log(`REGIONS: block on ${ticket.ticketNumber} had no usable entries.`);
    for (const w of parseWarnings) console.warn(`  parse: ${w}`);
    return;
  }
  const attachmentPaths = ticket.pngPaths;
  if (attachmentPaths.length === 0) {
    throw new Error(`${ticket.ticketNumber} has no PNG attachments to crop against.`);
  }
  const tripletPaths = tripletAttachments(attachmentPaths);
  const { plans, warnings: planWarnings } = planRegionCrops({
    regions,
    attachmentPaths,
    tripletPaths: tripletPaths.length > 0 ? tripletPaths : undefined,
    ticketId: ticketDisplayId(args.ref),
    noteId: picked.noteId,
    outputRoot: args.outputRoot,
  });
  const { cropped, warnings: execWarnings } = await executeRegionCrops({ plans });
  reportRun(ticket, picked, regions, cropped, [...parseWarnings, ...planWarnings, ...execWarnings]);
}

function reportRun(
  ticket: LoadedTicket,
  picked: { source: "note" | "details"; noteId: string },
  regions: Region[],
  cropped: Array<{ region: Region; outputPath: string; imageBasename: string }>,
  warnings: string[],
): void {
  console.log(`${ticket.ticketNumber}: ${regions.length} region(s) from ${picked.source} → ${cropped.length} crop(s)`);
  for (const c of cropped) {
    console.log(
      `  [${c.region.index}] ${c.imageBasename} → ${c.outputPath}${c.region.caption != null ? `  (${c.region.caption})` : ""}`,
    );
  }
  for (const w of warnings) {
    console.warn(`  ${w}`);
  }
  if (cropped.length === 0 && warnings.length === 0) {
    console.warn(`No crops produced — check that ${basename(SETTINGS_PATH)} points at the right Hot Sheet instance.`);
  }
}

// Run only when invoked as the entry script, so tests can import `parseArgs` / `pickRegionsSource`.
if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  try {
    validateArgs(argv);
  } catch (err) {
    console.error(err);
    process.exitCode = 2;
  }
  if (process.exitCode !== 2)
    void main(argv).catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

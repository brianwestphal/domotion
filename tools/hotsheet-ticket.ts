/**
 * Read a Hot Sheet v2 ticket straight from its git-backed store — no running server, no API
 * secret — for tools that need a ticket's notes and attachments (see `crop-regions.ts`).
 *
 * The v2 layout this reads:
 *   <store>/tickets/<last-2-of-ulid>/<ULID>.md    YAML front matter + body + notes
 *   <store>/attachments/<ULID>/<attachment-id>/<filename>    the bytes, under the attachment's original name
 * and the code repo points at its store with `.hotsheet2/store` (legacy: `.hotsheet/store`), a file
 * containing the store's path.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

/** A ticket named on the command line: a v2 slug (`DM-HAWK2M`) or a legacy number (`DM-564`, `564`). */
export type TicketRef = { kind: "slug"; slug: string } | { kind: "legacy"; number: number };

export function parseTicketRef(value: string): TicketRef {
  const v = value.trim();
  const legacy = /^(?:DM-)?(\d+)$/i.exec(v);
  if (legacy != null) return { kind: "legacy", number: Number(legacy[1]) };
  const slug = /^(?:DM-)?([0-9A-Z]{4,12})$/i.exec(v);
  if (slug != null) return { kind: "slug", slug: `DM-${slug[1].toUpperCase()}` };
  throw new Error(`Bad ticket reference "${value}" — expected DM-<slug> (e.g. DM-HAWK2M) or a legacy number (DM-564)`);
}

/** The ticket's display id, and the directory-name suffix `DM-<this>` used for crop output. */
export function ticketDisplayId(ref: TicketRef): string {
  return ref.kind === "slug" ? ref.slug.slice(3) : String(ref.number);
}

/** Locate the store: `$HOTSHEET_STORE`, else the `.hotsheet2/store` (or legacy `.hotsheet/store`) link file. */
export function resolveStoreDir(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.HOTSHEET_STORE;
  if (explicit != null && explicit.trim() !== "") return resolve(projectRoot, explicit.trim());
  for (const link of [".hotsheet2/store", ".hotsheet/store"]) {
    const linkPath = join(projectRoot, link);
    if (!existsSync(linkPath)) continue;
    let target: string;
    try {
      target = readFileSync(linkPath, "utf8").trim();
    } catch {
      continue; // a directory named `store` is the HS1 layout, not a link file
    }
    if (target !== "") return isAbsolute(target) ? target : resolve(projectRoot, target);
  }
  return null;
}

export interface StoreNote {
  id: string;
  kind: string;
  text: string;
}
export interface StoreAttachment {
  id: string;
  filename: string;
  /** Absolute path of the stored bytes. */
  path: string;
}
export interface StoreTicket {
  slug: string;
  ulid: string;
  title: string;
  details: string;
  notes: StoreNote[];
  attachments: StoreAttachment[];
}

interface FrontMatter {
  id?: string;
  slug?: string;
  title?: string;
  legacy_number?: string;
  attachments?: Array<{ id: string; filename: string }>;
}

function splitFrontMatter(text: string): { front: FrontMatter; rest: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (m == null) throw new Error("ticket file has no front matter");
  return { front: (parseYaml(m[1]) ?? {}) as FrontMatter, rest: text.slice(m[0].length) };
}

export function parseTicketFile(text: string, storeDir: string): StoreTicket {
  const { front, rest } = splitFrontMatter(text);
  if (front.id == null || front.slug == null) throw new Error("ticket front matter lacks id/slug");
  const body = /<!-- hotsheet:body:begin -->\n?([\s\S]*?)\n?<!-- hotsheet:body:end -->/.exec(rest);
  const notes: StoreNote[] = [];
  const noteRe = /<!-- hotsheet:note:begin (\S+) kind: (\S+)[^>]*-->\n?([\s\S]*?)\n?<!-- hotsheet:note:end -->/g;
  for (const m of rest.matchAll(noteRe)) notes.push({ id: m[1], kind: m[2], text: m[3] });
  return {
    slug: front.slug,
    ulid: front.id,
    title: front.title ?? "",
    details: body?.[1] ?? "",
    notes,
    attachments: (front.attachments ?? []).map((a) => ({
      id: a.id,
      filename: a.filename,
      path: join(storeDir, "attachments", front.id as string, a.id, a.filename),
    })),
  };
}

/** Find and parse one ticket by slug or legacy number; null when the store has no such ticket. */
export function readTicketFromStore(storeDir: string, ref: TicketRef): StoreTicket | null {
  const ticketsDir = join(storeDir, "tickets");
  if (!existsSync(ticketsDir)) return null;
  const wantSlug = ref.kind === "slug" ? `slug: ${ref.slug}` : null;
  const wantLegacy = ref.kind === "legacy" ? `legacy_number: DM-${ref.number}` : null;
  // Only shard DIRECTORIES and `.md` files: a real store also holds stray files (`.DS_Store`, editor
  // droppings) that must not abort the scan.
  for (const shard of readdirSync(ticketsDir, { withFileTypes: true })) {
    if (!shard.isDirectory()) continue;
    const shardDir = join(ticketsDir, shard.name);
    for (const file of readdirSync(shardDir)) {
      if (!file.endsWith(".md")) continue;
      const text = readFileSync(join(shardDir, file), "utf8");
      const head = text.slice(0, text.indexOf("\n---\n", 4) + 1);
      const lines = head.split("\n");
      if ((wantSlug != null && lines.includes(wantSlug)) || (wantLegacy != null && lines.includes(wantLegacy))) {
        return parseTicketFile(text, storeDir);
      }
    }
  }
  return null;
}

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseTicketFile,
  parseTicketRef,
  readTicketFromStore,
  resolveStoreDir,
  ticketDisplayId,
} from "../tools/hotsheet-ticket.js";
import { pickRegionsSource } from "../tools/crop-regions.js";

describe("parseTicketRef", () => {
  it("accepts a v2 slug with or without the DM- prefix, case-insensitively", () => {
    expect(parseTicketRef("DM-HAWK2M")).toEqual({ kind: "slug", slug: "DM-HAWK2M" });
    expect(parseTicketRef("hawk2m")).toEqual({ kind: "slug", slug: "DM-HAWK2M" });
    expect(ticketDisplayId(parseTicketRef("DM-HAWK2M"))).toBe("HAWK2M");
  });

  it("keeps legacy numeric tickets working", () => {
    expect(parseTicketRef("DM-564")).toEqual({ kind: "legacy", number: 564 });
    expect(parseTicketRef("564")).toEqual({ kind: "legacy", number: 564 });
    expect(ticketDisplayId(parseTicketRef("564"))).toBe("564");
  });

  it("rejects garbage with a message that shows both accepted forms", () => {
    expect(() => parseTicketRef("")).toThrow(/DM-<slug>/);
    expect(() => parseTicketRef("DM-!!")).toThrow(/legacy number/);
    expect(() => parseTicketRef("../../etc")).toThrow(/Bad ticket reference/);
  });
});

const TICKET = (slug: string, ulid: string, extraFront = ""): string => `---
id: ${ulid}
slug: ${slug}
title: 'SVG demo test : x (moderate)'
category: bug
status: started
attachments:
- id: ATT1
  filename: x-expected.png
- id: ATT2
  filename: notes.txt
${extraFront}schema: hotsheet/v2-bounded-notes
---

<!-- hotsheet:body:begin -->
Details text
<!-- hotsheet:body:end -->

<!-- hotsheet:notes:begin -->
## Notes

<!-- hotsheet:note:begin NOTE1 kind: activity created_at: 2026-01-01T00:00:00Z edited_at: 2026-01-01T00:00:00Z summary_hex: 53 -->
Status changed
<!-- hotsheet:note:end -->

<!-- hotsheet:note:begin NOTE2 kind: regular created_at: 2026-01-01T00:00:00Z edited_at: 2026-01-01T00:00:00Z summary_hex: 53 -->
comment

REGIONS:
- [1] image=expected (x=1 y=2 w=3 h=4)
<!-- hotsheet:note:end -->
<!-- hotsheet:notes:end -->
`;

describe("parseTicketFile", () => {
  it("reads slug, body, notes (with kinds) and attachment blobs under the store", () => {
    const t = parseTicketFile(TICKET("DM-AAAA11", "01ULIDAAAA"), "/store");
    expect(t.slug).toBe("DM-AAAA11");
    expect(t.details).toBe("Details text");
    expect(t.notes.map((n) => [n.id, n.kind])).toEqual([
      ["NOTE1", "activity"],
      ["NOTE2", "regular"],
    ]);
    expect(t.notes[1].text).toContain("REGIONS:");
    expect(t.attachments).toEqual([
      {
        id: "ATT1",
        filename: "x-expected.png",
        path: join("/store", "attachments", "01ULIDAAAA", "ATT1", "x-expected.png"),
      },
      { id: "ATT2", filename: "notes.txt", path: join("/store", "attachments", "01ULIDAAAA", "ATT2", "notes.txt") },
    ]);
  });

  it("refuses a file with no front matter or no identity", () => {
    expect(() => parseTicketFile("no front matter", "/s")).toThrow(/front matter/);
    expect(() => parseTicketFile("---\ntitle: x\n---\nbody", "/s")).toThrow(/id\/slug/);
  });
});

describe("store lookup", () => {
  let dirs: string[] = [];
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), "domotion-hs-"));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  const writeTicket = (store: string, shard: string, ulid: string, text: string): void => {
    mkdirSync(join(store, "tickets", shard), { recursive: true });
    writeFileSync(join(store, "tickets", shard, `${ulid}.md`), text);
  };

  it("finds a ticket by slug and by legacy number across shards, and returns null for a stranger", () => {
    const store = tmp();
    writeTicket(store, "AA", "01ULIDAAAA", TICKET("DM-AAAA11", "01ULIDAAAA"));
    writeTicket(store, "BB", "01ULIDBBBB", TICKET("DM-BBBB22", "01ULIDBBBB", "legacy_number: DM-564\n"));
    expect(readTicketFromStore(store, parseTicketRef("DM-AAAA11"))?.ulid).toBe("01ULIDAAAA");
    expect(readTicketFromStore(store, parseTicketRef("DM-BBBB22"))?.ulid).toBe("01ULIDBBBB");
    expect(readTicketFromStore(store, parseTicketRef("DM-564"))?.slug).toBe("DM-BBBB22");
    expect(readTicketFromStore(store, parseTicketRef("DM-CCCC33"))).toBeNull();
    expect(readTicketFromStore(join(store, "nope"), parseTicketRef("DM-AAAA11"))).toBeNull();
  });

  it("skips stray files in the tickets tree instead of aborting the scan", () => {
    const store = tmp();
    writeFileSync(join(store, "tickets-placeholder"), "");
    mkdirSync(join(store, "tickets"), { recursive: true });
    writeFileSync(join(store, "tickets", ".DS_Store"), "junk");
    mkdirSync(join(store, "tickets", "AA"), { recursive: true });
    writeFileSync(join(store, "tickets", "AA", ".DS_Store"), "junk");
    writeTicket(store, "AA", "01ULIDAAAA", TICKET("DM-AAAA11", "01ULIDAAAA"));
    expect(readTicketFromStore(store, parseTicketRef("DM-AAAA11"))?.ulid).toBe("01ULIDAAAA");
  });

  it("does not match a slug that merely contains another (DM-AAAA11 vs DM-AAAA112)", () => {
    const store = tmp();
    writeTicket(store, "XX", "01ULIDXXXX", TICKET("DM-AAAA112", "01ULIDXXXX"));
    expect(readTicketFromStore(store, parseTicketRef("DM-AAAA11"))).toBeNull();
  });

  it("resolves the store from the env var, then the .hotsheet2/store link file (absolute or relative)", () => {
    const root = tmp();
    expect(resolveStoreDir(root, {})).toBeNull();
    mkdirSync(join(root, ".hotsheet2"));
    writeFileSync(join(root, ".hotsheet2", "store"), "../elsewhere\n");
    expect(resolveStoreDir(root, {})).toBe(join(root, "..", "elsewhere").replace(/\/$/, ""));
    writeFileSync(join(root, ".hotsheet2", "store"), "/abs/store\n");
    expect(resolveStoreDir(root, {})).toBe("/abs/store");
    expect(resolveStoreDir(root, { HOTSHEET_STORE: "/from/env" })).toBe("/from/env");
  });

  it("ignores an HS1 .hotsheet/store DIRECTORY rather than trying to read it as a link", () => {
    const root = tmp();
    mkdirSync(join(root, ".hotsheet", "store"), { recursive: true });
    expect(resolveStoreDir(root, {})).toBeNull();
  });
});

describe("pickRegionsSource", () => {
  it("prefers the latest note carrying REGIONS over an earlier note and over details", () => {
    const picked = pickRegionsSource({
      details: "REGIONS:\n- [1] (x=0 y=0 w=1 h=1)",
      notes: [
        { id: "n1", text: "REGIONS:\n- [1] (x=1 y=1 w=1 h=1)" },
        { id: "n2", text: "no regions here" },
        { id: "n3", text: "REGIONS:\n- [1] (x=3 y=3 w=1 h=1)" },
      ],
    });
    expect(picked?.noteId).toBe("n3");
  });

  it("falls back to details, and to null when neither has a block", () => {
    expect(pickRegionsSource({ details: "REGIONS:\n- [1] (x=0 y=0 w=1 h=1)", notes: [] })?.source).toBe("details");
    expect(pickRegionsSource({ details: "none", notes: [{ id: "n", text: "none" }] })).toBeNull();
  });
});

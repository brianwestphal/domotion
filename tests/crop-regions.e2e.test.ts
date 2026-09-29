import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `tools/crop-regions.ts` against a real current-format (Hot Sheet v2, slug-addressed) ticket in a
 * headless store: no server, no secret. The ticket carries the three review-tool attachments laid out
 * exactly as the store does (`attachments/<ticket-ulid>/<attachment-id>/<original filename>`) and a
 * `REGIONS:` note.
 */
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SLUG = "DM-TESTC1";
const ULID = "01KZZZZZZZZZZZZZZZZZZZZZC1";

let store = "";
let out = "";

beforeAll(async () => {
  store = mkdtempSync(join(tmpdir(), "domotion-crop-store-"));
  out = mkdtempSync(join(tmpdir(), "domotion-crop-out-"));
  const att = join(store, "attachments", ULID);
  for (const id of ["AAA", "BBB", "CCC"]) mkdirSync(join(att, id), { recursive: true });
  const png = (r: number, g: number, b: number): Promise<Buffer> =>
    sharp({ create: { width: 200, height: 100, channels: 3, background: { r, g, b } } })
      .png()
      .toBuffer();
  writeFileSync(join(att, "AAA", "demo-expected.png"), await png(255, 0, 0));
  writeFileSync(join(att, "BBB", "demo-actual.png"), await png(0, 255, 0));
  writeFileSync(join(att, "CCC", "demo-diff.png"), await png(0, 0, 255));
  mkdirSync(join(store, "tickets", "C1"), { recursive: true });
  writeFileSync(
    join(store, "tickets", "C1", `${ULID}.md`),
    `---
id: ${ULID}
slug: ${SLUG}
title: 'demo (moderate)'
category: bug
status: started
attachments:
- id: AAA
  filename: demo-expected.png
- id: BBB
  filename: demo-actual.png
- id: CCC
  filename: demo-diff.png
schema: hotsheet/v2-bounded-notes
---

<!-- hotsheet:body:begin -->
Suite: html-test
<!-- hotsheet:body:end -->

<!-- hotsheet:notes:begin -->
## Notes

<!-- hotsheet:note:begin NOTE9 kind: regular created_at: 2026-01-01T00:00:00Z edited_at: 2026-01-01T00:00:00Z summary_hex: 53 -->
comment

REGIONS:
- [1] image=diff (x=10 y=20 w=30 h=40) — blue box
- [2] (x=0 y=0 w=50 h=50)
<!-- hotsheet:note:end -->
<!-- hotsheet:notes:end -->
`,
  );
});

afterAll(() => {
  rmSync(store, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
});

function run(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx", join(REPO, "tools/crop-regions.ts"), ...args], {
    encoding: "utf8",
    cwd: REPO,
    env: { ...process.env, HOTSHEET_STORE: store },
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("crop-regions on a headless v2 store", () => {
  it("crops a slug-addressed ticket: the pinned region hits one image, the unpinned one fans out to the triplet", async () => {
    const r = run("--ticket", SLUG, "--output-root", out);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`${SLUG}: 2 region(s)`);
    const dir = join(out, `DM-${SLUG.slice(3)}`, "NOTE9");
    const files = readdirSync(dir).sort();
    expect(files).toEqual(["[1]-demo-diff.png", "[2]-demo-actual.png", "[2]-demo-diff.png", "[2]-demo-expected.png"]);
    const pinned = await sharp(join(dir, "[1]-demo-diff.png")).metadata();
    expect([pinned.width, pinned.height]).toEqual([30, 40]);
    // The pinned crop really came from the DIFF (blue) attachment.
    const { data } = await sharp(join(dir, "[1]-demo-diff.png")).raw().toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]]).toEqual([0, 0, 255]);
  });

  it("reports a slug that is not in the store instead of falling through to a server", () => {
    const r = run("--ticket", "DM-NOPE99", "--output-root", out);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/DM-NOPE99 not found in the Hot Sheet store/);
  });

  it("rejects a malformed reference with the accepted forms", () => {
    const r = run("--ticket", "not a ticket!", "--output-root", out);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/DM-<slug>/);
  });
});

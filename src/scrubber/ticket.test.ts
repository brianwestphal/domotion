import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTicketFile, startScrubberServer, type ScrubberServerHandle } from "./server.js";

/**
 * DM-1445: review mode `.ticket` generation — the pure `buildTicketFile`
 * builder plus the `POST /ticket` server endpoint (which writes the file). The
 * endpoint needs no Chromium, so this runs browserless.
 */

describe("buildTicketFile (DM-1445)", () => {
  const base = {
    title: "  Glitch on the logo  ",
    note: "The logo flickers near the loop point.",
    category: "bug" as const,
    svgPath: "/Users/x/demo.svg",
    svgName: "demo",
    frameTimeMs: 1234.5,
    rangeStartMs: 1000,
    rangeEndMs: 2000,
    region: { x: 10.2, y: 20.8, w: 100, h: 50 },
  };

  it("produces a slugged filename and parseable JSON with mapped fields", () => {
    const { filename, content, ticket } = buildTicketFile(base, { createdAt: "2026-06-30T00:00:00.000Z", stamp: 1700 });
    expect(filename).toBe("demo-1700.ticket");
    const parsed = JSON.parse(content);
    expect(parsed).toEqual(ticket);
    expect(ticket.tool).toBe("svg-scrubber");
    expect(ticket.title).toBe("Glitch on the logo"); // trimmed
    expect(ticket.category).toBe("bug");
    expect(ticket.svg).toBe("/Users/x/demo.svg");
    expect(ticket.frameTimeMs).toBe(1234.5);
    expect(ticket.range).toEqual({ startMs: 1000, endMs: 2000 });
    expect(ticket.region).toEqual({ x: 10.2, y: 20.8, w: 100, h: 50 });
  });

  it("embeds the context (path, frame, range, region) in the markdown details", () => {
    const { ticket } = buildTicketFile(base, { createdAt: "2026-06-30T00:00:00.000Z", stamp: 1 });
    expect(ticket.details).toContain("The logo flickers");
    expect(ticket.details).toContain("`/Users/x/demo.svg`");
    expect(ticket.details).toContain("Frame time:");
    expect(ticket.details).toContain("Selected range:");
    expect(ticket.details).toContain("x=10 y=21 w=100 h=50");
  });

  it("handles no path and no region", () => {
    const { ticket } = buildTicketFile(
      { ...base, svgPath: null, region: null, note: "" },
      { createdAt: "2026-06-30T00:00:00.000Z", stamp: 2 },
    );
    expect(ticket.svg).toBeNull();
    expect(ticket.region).toBeNull();
    expect(ticket.details).toContain("_(no description)_");
    expect(ticket.details).toContain("loaded in-browser");
    expect(ticket.details).toContain("Region:** _(none");
  });

  it("sanitizes an odd svg name into a safe slug", () => {
    const { filename } = buildTicketFile({ ...base, svgName: "my demo/v2!.svg" }, { createdAt: "x", stamp: 9 });
    expect(filename).toBe("my-demo-v2-9.ticket");
  });
});

describe("POST /ticket endpoint (DM-1445)", () => {
  let srv: ScrubberServerHandle | null = null;
  let reviewOff: ScrubberServerHandle | null = null;
  const dir = mkdtempSync(join(tmpdir(), "scrubber-tickets-"));
  const noLaunch = async (): Promise<never> => { throw new Error("Chromium must not launch for /ticket"); };

  afterAll(async () => {
    if (srv) await srv.close();
    if (reviewOff) await reviewOff.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const post = (handle: ScrubberServerHandle, body: unknown) =>
    fetch(handle.url.replace(/\/$/, "") + "/ticket", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });

  it("writes a .ticket file to ticketDir and returns its path", async () => {
    srv = await startScrubberServer({ review: true, ticketDir: dir, launchBrowser: noLaunch as never });
    const res = await post(srv, {
      title: "Bad easing",
      note: "eases too fast",
      category: "bug",
      svgPath: join(dir, "anim.svg"),
      svgName: "anim",
      frameTimeMs: 500,
      rangeStartMs: 0,
      rangeEndMs: 1000,
      region: { x: 1, y: 2, w: 3, h: 4 },
    });
    expect(res.status).toBe(200);
    const { path } = await res.json() as { path: string };
    expect(path.startsWith(dir)).toBe(true);
    expect(path.endsWith(".ticket")).toBe(true);

    const files = readdirSync(dir).filter((f) => f.endsWith(".ticket"));
    expect(files.length).toBe(1);
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.title).toBe("Bad easing");
    expect(parsed.tool).toBe("svg-scrubber");
    expect(parsed.region).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });

  it("rejects a missing title with 400", async () => {
    const res = await post(srv!, { title: "", frameTimeMs: 0, rangeStartMs: 0, rangeEndMs: 0 });
    expect(res.status).toBe(400);
  });

  it("404s when review mode is not enabled", async () => {
    reviewOff = await startScrubberServer({ ticketDir: dir, launchBrowser: noLaunch as never });
    const res = await post(reviewOff, { title: "x", frameTimeMs: 0, rangeStartMs: 0, rangeEndMs: 0 });
    expect(res.status).toBe(404);
  });
});

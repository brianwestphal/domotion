import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordRealWorldHar } from "./real-world-har-cache.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const valid = JSON.stringify({
  log: {
    entries: [
      {
        request: { url: "https://fixture.invalid/", method: "GET" },
        response: { status: 200, content: { text: "fixture" } },
      },
    ],
  },
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "dm-har-cache-"));
  directories.push(dir);
  const destination = join(dir, "page.har");
  let staging = "";
  const context = {
    routeFromHAR: vi.fn(async (path: string) => {
      staging = path;
    }),
    close: vi.fn(async () => {
      await writeFile(staging, valid);
    }),
  };
  return { dir, destination, context, staging: () => staging };
}

describe("real-world HAR cache publication (DM-9K75QG)", () => {
  it("records embedded responses and publishes only after close succeeds", async () => {
    const f = await fixture();
    await recordRealWorldHar(f.context, f.destination, async () => {
      expect(await readdir(f.dir)).toEqual([]);
    });
    expect(f.context.routeFromHAR).toHaveBeenCalledWith(
      f.staging(),
      expect.objectContaining({ update: true, updateContent: "embed" }),
    );
    expect(f.staging()).not.toBe(f.destination);
    expect(await readFile(f.destination, "utf8")).toBe(valid);
    expect(await readdir(f.dir)).toEqual(["page.har"]);
  });

  it("preserves an existing cache when close rejects despite a complete staging file", async () => {
    const f = await fixture();
    await writeFile(f.destination, "prior-cache");
    f.context.close.mockImplementation(async () => {
      await writeFile(f.staging(), valid);
      throw new Error("export failed");
    });
    await expect(recordRealWorldHar(f.context, f.destination, async () => {})).rejects.toThrow("export failed");
    expect(await readFile(f.destination, "utf8")).toBe("prior-cache");
    await expect.poll(async () => readdir(f.dir)).toEqual(["page.har"]);
  });

  it.each([
    "not-json",
    '{"log":{}}',
    '{"log":{"entries":[]}}',
    '{"log":{"entries":[{"response":{"content":{"_file":"body.bin"}}}]}}',
  ])("rejects invalid/non-embedded finalization %s", async (body) => {
    const f = await fixture();
    f.context.close.mockImplementation(async () => {
      await writeFile(f.staging(), body);
    });
    await expect(recordRealWorldHar(f.context, f.destination, async () => {})).rejects.toThrow();
    expect(await readdir(f.dir)).toEqual([]);
  });

  it("never publishes a late successful close after its deadline", async () => {
    const f = await fixture();
    await writeFile(f.destination, "prior-cache");
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.context.close.mockImplementation(async () => {
      await pending;
      await writeFile(f.staging(), valid);
    });
    await expect(recordRealWorldHar(f.context, f.destination, async () => {}, { finalizationMs: 10 })).rejects.toThrow(
      "HAR finalization exceeded 10ms",
    );
    expect(await readFile(f.destination, "utf8")).toBe("prior-cache");
    finish();
    await f.context.close.mock.results[0]!.value;
    await expect.poll(async () => readdir(f.dir)).toEqual(["page.har"]);
    expect(await readFile(f.destination, "utf8")).toBe("prior-cache");
  });

  it("bounds a stalled visit and cleans its late finalization without publishing", async () => {
    const f = await fixture();
    await expect(
      recordRealWorldHar(f.context, f.destination, () => new Promise<void>(() => {}), { recordingMs: 10 }),
    ).rejects.toThrow("HAR recording exceeded 10ms");
    expect(f.context.close).toHaveBeenCalledOnce();
    await expect.poll(async () => readdir(f.dir)).toEqual([]);
  });

  it("closes and leaves no published cache when the visit fails", async () => {
    const f = await fixture();
    await expect(
      recordRealWorldHar(f.context, f.destination, async () => {
        throw new Error("navigation failed");
      }),
    ).rejects.toThrow("navigation failed");
    expect(f.context.close).toHaveBeenCalledOnce();
    await expect.poll(async () => readdir(f.dir)).toEqual([]);
  });
});

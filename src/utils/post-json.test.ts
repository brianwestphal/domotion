import { afterEach, describe, expect, it, vi } from "vitest";
import { postBlob, postJson } from "./post-json.js";

afterEach(() => vi.unstubAllGlobals());

describe("postJson", () => {
  it("posts JSON and decodes a successful response", async () => {
    const fetch = vi.fn(async () => Response.json({ value: 7 }));
    vi.stubGlobal("fetch", fetch);
    await expect(postJson<{ value: number }>("/api/example", { input: "x" })).resolves.toEqual({ value: 7 });
    expect(fetch).toHaveBeenCalledWith("/api/example", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"input":"x"}',
    });
  });

  it("preserves JSON errors and issues for Studio while handling HTML error pages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "Bad project", issues: [{ path: "x" }] }, { status: 422 })),
    );
    await expect(postJson("/api/save", {})).rejects.toMatchObject({
      message: "Bad project",
      issues: [{ path: "x" }],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>too large</html>", { status: 413 })),
    );
    await expect(postJson("/api/save", {})).rejects.toThrow("Request failed (413)");
  });

  it("rejects invalid success JSON and returns binary exports", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not JSON")),
    );
    await expect(postJson("/timing", {})).rejects.toThrow("Invalid JSON response from /timing");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("png bytes")),
    );
    await expect((await postBlob("/export-frame", {})).text()).resolves.toBe("png bytes");
  });
});

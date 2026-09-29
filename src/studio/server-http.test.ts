import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStudioProjectFile } from "./app-projects.js";
import { startStudioServer, type StudioServerHandle } from "./server.js";

const NOW = "2026-09-06T02:00:00.000Z";

describe("Studio server HTTP boundary", () => {
  let root = "";
  let outside = "";
  let server: StudioServerHandle | null = null;

  afterEach(async () => {
    if (server != null) await server.close();
    server = null;
    for (const dir of [root, outside]) if (dir !== "") rmSync(dir, { recursive: true, force: true });
    root = "";
    outside = "";
  });

  const post = (path: string, body: unknown): Promise<Response> =>
    fetch(new URL(path, server!.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  const start = async (): Promise<void> => {
    root = mkdtempSync(join(tmpdir(), "domotion-studio-http-"));
    outside = mkdtempSync(join(tmpdir(), "domotion-studio-http-out-"));
    server = await startStudioServer({ workspaceRoot: root });
  };

  it("refuses to open a project through a symlink that leaves the workspace", async () => {
    await start();
    const real = createStudioProjectFile(outside, "real.json", { title: "Outside", createdAt: NOW });
    expect(real.project).toBeDefined();
    symlinkSync(join(outside, "real.json"), join(root, "linked.json"));
    const response = await post("/api/open", { path: "linked.json" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("stay inside") });
  });

  it("refuses to create a project under a symlinked directory that leaves the workspace", async () => {
    await start();
    symlinkSync(outside, join(root, "linked-dir"));
    const response = await post("/api/create", { path: "linked-dir/new.json", title: "x" });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("stay inside") });
    expect(existsSync(join(outside, "new.json"))).toBe(false);
  });

  it("answers 413 for an oversize body", async () => {
    await start();
    const response = await post("/api/open", JSON.stringify({ path: "x".repeat(5 * 1024 * 1024) }));
    expect(response.status).toBe(413);
  });

  it("answers 400 for malformed JSON and for a schema failure", async () => {
    await start();
    expect((await post("/api/open", "{nope")).status).toBe(400);
    expect((await post("/api/open", {})).status).toBe(400);
  });

  it("two saves that carry the same expectedHeadRevisionId: the first wins, the second is a 409 conflict", async () => {
    await start();
    const created = createStudioProjectFile(root, "p.json", { title: "P", createdAt: NOW });
    const head = created.project.review.headRevisionId;
    const edited = structuredClone(created.project);
    edited.canvas.title = "First";
    const first = await post("/api/save", { path: "p.json", expectedHeadRevisionId: head, project: edited });
    expect(await first.clone().text()).not.toContain("error");
    expect(first.status).toBe(200);
    const again = structuredClone(created.project);
    again.canvas.title = "Second";
    const second = await post("/api/save", { path: "p.json", expectedHeadRevisionId: head, project: again });
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ error: expect.stringContaining("stale authoring change") });
  });

  it("a stale conflict stays a 409 whatever the message says (classified by code)", async () => {
    await start();
    const created = createStudioProjectFile(root, "q.json", { title: "Q", createdAt: NOW });
    const response = await post("/api/annotation", {
      path: "q.json",
      expectedHeadRevisionId: "not-the-head",
      command: { kind: "create", body: "x", author: { kind: "human", name: "Tester" } },
    });
    await expect(response.clone().json()).resolves.toMatchObject({
      error: expect.stringContaining("stale annotation change"),
    });
    expect(response.status).toBe(409);
    writeFileSync(join(root, "unused.txt"), created.project.canvas.title ?? "");
  });
});

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createStudioProjectDocument,
  createStudioProjectFile,
  openStudioProjectFile,
  resolveStudioWorkspacePath,
  saveStudioProjectFile,
} from "./app-projects.js";
import { startStudioServer, type StudioServerHandle } from "./server.js";

const NOW = "2026-09-06T02:00:00.000Z";
const LATER = "2026-09-06T02:05:00.000Z";

describe("Studio workspace paths", () => {
  it("normalizes POSIX and Windows project paths inside their workspace", () => {
    expect(resolveStudioWorkspacePath("/work/demo", "projects/tour.json", posix)).toBe("/work/demo/projects/tour.json");
    expect(resolveStudioWorkspacePath("C:\\work\\demo", "projects\\tour.json", win32)).toBe("C:\\work\\demo\\projects\\tour.json");
  });

  it("rejects traversal, absolute escapes, and non-JSON project files on both platforms", () => {
    expect(() => resolveStudioWorkspacePath("/work/demo", "../secret.json", posix)).toThrow(/stay inside/);
    expect(() => resolveStudioWorkspacePath("/work/demo", "/tmp/secret.json", posix)).toThrow(/stay inside/);
    expect(() => resolveStudioWorkspacePath("C:\\work\\demo", "..\\secret.json", win32)).toThrow(/stay inside/);
    expect(() => resolveStudioWorkspacePath("C:\\work\\demo", "D:\\secret.json", win32)).toThrow(/stay inside/);
    expect(() => resolveStudioWorkspacePath("/work/demo", "tour.svg", posix)).toThrow(/\.json extension/);
  });
});

describe("Studio project file operations", () => {
  let root: string | null = null;
  afterEach(() => {
    if (root != null) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("creates, opens, atomically saves, and reopens a project", () => {
    root = mkdtempSync(join(tmpdir(), "domotion-studio-app-"));
    const created = createStudioProjectFile(root, "nested/tour.studio.json", { title: "Acme Tour", createdAt: NOW });
    expect(created.relativePath).toBe(join("nested", "tour.studio.json"));
    expect(created.project.narrative.title).toBe("Acme Tour");
    expect(() => createStudioProjectFile(root!, "nested/tour.studio.json", { title: "Duplicate" })).toThrow(/already exists/);

    const edited = structuredClone(created.project);
    edited.narrative.title = "Acme Tour — revised";
    edited.scenes[0].title = "A better opening";
    saveStudioProjectFile(root, created.relativePath, edited, LATER);
    const reopened = openStudioProjectFile(root, created.relativePath);
    expect(reopened.project.narrative.title).toBe("Acme Tour — revised");
    expect(reopened.project.scenes[0].title).toBe("A better opening");
    expect(reopened.project.updatedAt).toBe(LATER);
    expect(readFileSync(reopened.path, "utf8")).not.toContain(".tmp");
  });

  it("creates a valid useful default project", () => {
    const project = createStudioProjectDocument({ title: "Glassbox", createdAt: NOW, width: 1440, height: 900 });
    expect(project.canvas).toMatchObject({ width: 1440, height: 900, title: "Glassbox" });
    expect(project.scenes).toHaveLength(1);
    expect(project.scenes[0].render).toMatchObject({ kind: "storyboard", recipe: { template: "title-card" } });
  });

  it("returns path-specific validation issues through the local server", async () => {
    root = mkdtempSync(join(tmpdir(), "domotion-studio-server-"));
    writeFileSync(join(root, "broken.json"), JSON.stringify({ format: "domotion-studio-project", version: 2 }), "utf8");
    let server: StudioServerHandle | null = null;
    try {
      server = await startStudioServer({ workspaceRoot: root });
      const response = await fetch(new URL("/api/open", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "broken.json" }),
      });
      expect(response.status).toBe(400);
      const body = await response.json() as { issues: Array<{ path: string; code: string }> };
      expect(body.issues).toContainEqual(expect.objectContaining({ path: "$.version", code: "unsupported_version" }));

      const escaped = await fetch(new URL("/api/open", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: "../outside.json" }),
      });
      expect(escaped.status).toBe(400);
      expect((await escaped.json() as { error: string }).error).toMatch(/stay inside/);
    } finally {
      if (server != null) await server.close();
    }
  });

  it("escapes project data embedded in the HTML bootstrap", async () => {
    root = mkdtempSync(join(tmpdir(), "domotion-studio-bootstrap-"));
    createStudioProjectFile(root, "safe.json", { title: "</script><script>window.BAD=true</script>", createdAt: NOW });
    let server: StudioServerHandle | null = null;
    try {
      server = await startStudioServer({ workspaceRoot: root, initialProjectPath: "safe.json" });
      const html = await (await fetch(server.url)).text();
      expect(html).not.toContain("</script><script>window.BAD=true</script>");
      expect(html).toContain("\\u003c/script>\\u003cscript>window.BAD=true\\u003c/script>");
    } finally {
      if (server != null) await server.close();
    }
  });
});

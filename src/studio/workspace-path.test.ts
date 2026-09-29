import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isInsideRoot, resolveInsideWorkspace } from "./workspace-path.js";

const escape = (root: string): string => `outside: ${root}`;

describe("isInsideRoot", () => {
  it("treats the root and its descendants as inside, siblings and parents as outside", () => {
    expect(isInsideRoot("/w", "/w", posix)).toBe(true);
    expect(isInsideRoot("/w", "/w/a/b", posix)).toBe(true);
    expect(isInsideRoot("/w", "/w-other", posix)).toBe(false);
    expect(isInsideRoot("/w/a", "/w", posix)).toBe(false);
    expect(isInsideRoot("C:\\w", "C:\\w\\a", win32)).toBe(true);
    expect(isInsideRoot("C:\\w", "D:\\w\\a", win32)).toBe(false);
  });
});

describe("resolveInsideWorkspace", () => {
  let dirs: string[] = [];
  const tmp = (name: string): string => {
    const dir = mkdtempSync(join(tmpdir(), `domotion-ws-${name}-`));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs = [];
  });

  it("accepts a path inside the root and enforces the extension case-insensitively", () => {
    const root = tmp("a");
    const opts = { extension: ".json", extensionMessage: "need json", escapeMessage: escape };
    expect(resolveInsideWorkspace(root, "sub/p.JSON", opts)).toBe(join(root, "sub", "p.JSON"));
    expect(() => resolveInsideWorkspace(root, "p.txt", opts)).toThrow("need json");
  });

  it("rejects lexical escapes and reports them through the caller's error class", () => {
    class MyError extends Error {}
    const root = tmp("b");
    const opts = { escapeMessage: escape, makeError: (m: string) => new MyError(m) };
    expect(() => resolveInsideWorkspace(root, "../x", opts)).toThrow(MyError);
    expect(() => resolveInsideWorkspace(root, "/etc/passwd", opts)).toThrow(/outside/);
  });

  it("rejects a symlink that points out of the workspace, for an existing file and for a new file under a linked directory", () => {
    const root = tmp("c");
    const outside = tmp("outside");
    writeFileSync(join(outside, "secret.json"), "{}");
    symlinkSync(join(outside, "secret.json"), join(root, "link.json"));
    symlinkSync(outside, join(root, "linked-dir"));
    const opts = { escapeMessage: escape, followSymlinks: true };
    expect(() => resolveInsideWorkspace(root, "link.json", opts)).toThrow(/outside/);
    expect(() => resolveInsideWorkspace(root, "linked-dir/new.json", opts)).toThrow(/outside/);
    // Without symlink following the same paths pass the lexical check.
    expect(resolveInsideWorkspace(root, "link.json", { escapeMessage: escape })).toBe(join(root, "link.json"));
  });

  it("accepts a not-yet-existing path under a real subdirectory and a symlink that stays inside", () => {
    const root = tmp("d");
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "alias"));
    const opts = { escapeMessage: escape, followSymlinks: true };
    expect(resolveInsideWorkspace(root, "real/deep/new.json", opts)).toBe(join(root, "real", "deep", "new.json"));
    expect(resolveInsideWorkspace(root, "alias/x.json", opts)).toBe(join(root, "alias", "x.json"));
  });
});

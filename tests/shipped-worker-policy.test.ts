import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// DM-KVKDY1: shipped code is immune to Chromium's SharedWorker lost-load-error
// race (a module SharedWorker whose script fails to load can drop its `error`
// event when the host is torn down before the failure message is read) only
// because nothing in `src/` or `packages/*/src` constructs, auto-attaches to, or
// waits on workers. `src/capture/raf-clock.ts` is the one exception: it replaces
// `Worker`/`SharedWorker` with a constructor that throws synchronously, so no
// worker ever starts. Pin that so a new worker dependency is a deliberate choice.
const ROOT = resolve(import.meta.dirname, "..");
const SHIPPED_ROOTS = ["src", "packages/text-engine/src"];
const ALLOWED = new Set(["src/capture/raf-clock.ts"]);
const FORBIDDEN = [
  /\bnew\s+(?:Shared)?Worker\s*\(/,
  /Target\.setAutoAttach/,
  /\battachedToTarget\b/,
  /\bwaitForDebuggerOnStart\b/,
  /\brunIfWaitingForDebugger\b/,
  /\.on\(\s*["']worker["']/,
  /\.workers\(\)/,
];

function shippedSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return shippedSources(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|generated)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

export function workerPolicyViolations(file: string, source: string): string[] {
  if (ALLOWED.has(file)) return [];
  return FORBIDDEN.filter((pattern) => pattern.test(source)).map((pattern) => `${file}: ${pattern.source}`);
}

describe("shipped worker policy (DM-KVKDY1)", () => {
  it("keeps shipped code from constructing, attaching to or waiting on workers", () => {
    const files = SHIPPED_ROOTS.flatMap((root) => shippedSources(resolve(ROOT, root)));
    expect(files.length).toBeGreaterThan(100);
    const violations = files.flatMap((path) => {
      const file = relative(ROOT, path).split("\\").join("/");
      return workerPolicyViolations(file, readFileSync(path, "utf-8"));
    });
    expect(violations).toEqual([]);
  });

  it("detects each forbidden form and exempts only the raf-clock blocker", () => {
    const samples = [
      "const w = new SharedWorker('/w.js');",
      "new Worker(url)",
      'await session.send("Target.setAutoAttach", {});',
      'session.on("Target.attachedToTarget", f)',
      "{ waitForDebuggerOnStart: true }",
      'send("Runtime.runIfWaitingForDebugger")',
      'page.on("worker", f)',
      "page.workers()",
    ];
    for (const sample of samples) expect(workerPolicyViolations("src/x.ts", sample)).toHaveLength(1);
    expect(workerPolicyViolations("src/capture/raf-clock.ts", "new SharedWorker('/w.js')")).toEqual([]);
    expect(workerPolicyViolations("src/x.ts", "const workerCount = 2;")).toEqual([]);
  });
});

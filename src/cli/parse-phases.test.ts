import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCaptureArgs } from "./capture.js";
import { parseAnimateArgs } from "./animate-command.js";
import { parseCompositeArgs } from "./composite.js";
import { parseStoryboardArgs } from "./storyboard.js";
import { parseTermArgs } from "./term.js";
import { parseTemplateArgs } from "./template.js";
import { parseReviewArgs } from "./review.js";
import { parseScrubberArgs } from "./scrubber.js";
import { parseStudioArgs } from "./studio.js";

const dirs: string[] = [];
function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "domotion-cli-parse-"));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("CLI parse phases", () => {
  it("capture resolves flags and rejects a scroll speed before any browser work", () => {
    const page = tempFile("page.html", "<p>hello</p>");
    const parsed = parseCaptureArgs([page, "--width", "320", "--wait", "0"]);
    expect(parsed.help).toBe(false);
    if (!parsed.help) expect(parsed.flags).toMatchObject({ width: 320, wait: 0 });
    expect(() => parseCaptureArgs([page, "--scroll", "down:bottom/1s", "--scroll-speed", "oops"])).toThrow(
      /--scroll-speed expects/,
    );
  });

  it("config verbs reject malformed config during parse", () => {
    const bad = tempFile("bad.json", "{}");
    expect(() => parseAnimateArgs([bad])).toThrow();
    expect(() => parseCompositeArgs([bad])).toThrow(/composite:/);
    expect(() => parseStoryboardArgs([bad])).toThrow(/storyboard:/);
  });

  it("term validates mode, numbers and cast path during parse", () => {
    expect(() => parseTermArgs(["--cast", "-", "--mode", "wrong"])).toThrow(/--mode must be/);
    expect(() => parseTermArgs(["--cast", "-", "--cols", "0"])).toThrow(/--cols expects/);
    expect(() => parseTermArgs(["--cast", "-", "--theme", "unknown"])).toThrow(/--theme must be/);
    const parsed = parseTermArgs(["--cast", "-", "--cols", "80"]);
    if (!parsed.help) expect(parsed.cols).toBe(80);
  });

  it("template validates parameter JSON without rendering", async () => {
    await expect(parseTemplateArgs(["title-card", "--params", "["])).rejects.toThrow(/not valid JSON/);
    await expect(parseTemplateArgs(["title-card"])).rejects.toThrow();
    const parsed = await parseTemplateArgs(["title-card", "--title", "Hello"]);
    if (!("help" in parsed)) expect(parsed.raw.title).toBe("Hello");
  });

  it("server bins validate paths, ports and extra arguments before starting", () => {
    const png = tempFile("expected.png", "png");
    expect(parseReviewArgs(["--expected", png, "--actual", png, "--port", "0"])).toMatchObject({ port: 0 });
    expect(() => parseReviewArgs(["--expected", png, "--actual", png, "--port", "70000"])).toThrow(/--port expects/);
    expect(() => parseScrubberArgs(["a.svg", "b.svg"])).toThrow(/unexpected extra argument/);
    expect(() => parseStudioArgs(["a.json", "b.json"])).toThrow(/at most one/);
  });
});

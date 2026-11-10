import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { afterAll, expect, it } from "vitest";
import {
  normalizedShadowSourceHash,
  retainNativeShadowSource,
  shadowEvidenceOutputRoot,
} from "./native-shadow-evidence.js";
const root = mkdtempSync(join(tmpdir(), "domotion-shadow-witness-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const png = () =>
  sharp({ create: { width: 2, height: 2, channels: 4, background: "red" } })
    .png()
    .toBuffer();
const options = (sourcePng: Buffer) => ({
  id: "unit-witness",
  label: "controlled metadata",
  fixtureFile: import.meta.url,
  fixtureHtml: "<div></div>",
  browserVersion: "synthetic-unit-control",
  viewport: { x: 0, y: 0, width: 2, height: 2 },
  sourcePng,
  outputRoot: root,
});
it("retains exact source bytes before output exists and never reuses stale pairs", async () => {
  const source = await png(),
    first = retainNativeShadowSource(options(source));
  const metadata = JSON.parse(readFileSync(join(first.directory, "metadata.json"), "utf8")) as {
    outputs: Record<string, unknown>;
    source: { width: number; height: number };
  };
  expect(metadata.outputs).toEqual({});
  expect(metadata.source).toMatchObject({ width: 2, height: 2 });
  expect(readFileSync(join(first.directory, "source.png"))).toEqual(source);
  first.output("#only", source);
  expect(readFileSync(join(first.directory, "output-only.png"))).toEqual(source);
  const second = retainNativeShadowSource(options(source));
  expect(second.directory).not.toBe(first.directory);
  expect(readdirSync(second.directory).sort()).toEqual(["metadata.json", "source.png"]);
});
it("normalizes source-file CRLF without masking substantive fixture changes", () => {
  expect(normalizedShadowSourceHash("style\nred\n")).toBe(normalizedShadowSourceHash("style\r\nred\r\n"));
  expect(normalizedShadowSourceHash("style\nred\n")).not.toBe(normalizedShadowSourceHash("style\nblue\n"));
});
it("routes native output directories independently of the host used by this unit test", () => {
  expect(shadowEvidenceOutputRoot({}, "linux")).toBe(resolve("tests/output-linux"));
  expect(shadowEvidenceOutputRoot({}, "win32")).toBe(resolve("tests/output"));
  expect(shadowEvidenceOutputRoot({ DOMOTION_OUTPUT_DIR: root }, "linux")).toBe(root);
});
it("rejects unsafe names, unsupported selectors and oversized metadata", async () => {
  const source = await png();
  expect(() => retainNativeShadowSource({ ...options(source), id: "../escape" })).toThrow("Invalid shadow witness id");
  expect(() => retainNativeShadowSource({ ...options(source), fixtureHtml: "x".repeat(32769) })).toThrow(
    "exceeds its bound",
  );
  const witness = retainNativeShadowSource(options(source));
  expect(() => witness.output("../escape", source)).toThrow("Unsupported shadow witness selector");
});

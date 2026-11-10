import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import sharp from "sharp";
import type { CapturedElement } from "../src/capture/types.js";
import { withTimeout } from "../src/utils/with-timeout.js";
import {
  cropNativeControlRgba,
  nativeControlAlphaStats,
  nativeControlPixelCrop,
  planNativeControlClip,
} from "../src/capture/native-control-raster.js";

type IsolationArgs = { sourceNodeKey: string; decorationNodeKey: string; restoreKey: string; rows: unknown[] };
function isolationArgs(value: unknown): value is IsolationArgs {
  if (value == null || typeof value !== "object") return false;
  const row = value as Partial<IsolationArgs>;
  return (
    typeof row.sourceNodeKey === "string" &&
    typeof row.decorationNodeKey === "string" &&
    typeof row.restoreKey === "string" &&
    Array.isArray(row.rows)
  );
}

/** Test-only: keep an existing isolation screenshot before restore, never request another. */
export function observeNativeDecorationFrame(page: Page) {
  const originalEvaluate = page.evaluate;
  const evaluate = page.evaluate.bind(page);
  const screenshot = page.screenshot;
  let pending: { keys: IsolationArgs; facts: unknown } | undefined;
  const frames: { png: Buffer; facts: unknown; state: unknown; options: unknown; time: number }[] = [];
  page.evaluate = (async (fn: Parameters<Page["evaluate"]>[0], arg?: unknown) => {
    const result = await evaluate(fn, arg);
    if (isolationArgs(arg)) pending = { keys: arg, facts: result };
    return result;
  }) as Page["evaluate"];
  page.screenshot = async (options) => {
    const isolation = pending;
    pending = undefined;
    const png = await screenshot.call(page, options);
    if (isolation != null && frames.length < 2 && png.length <= 2 * 1024 * 1024) {
      const state = await withTimeout(
        evaluate(
          ({ key, sourceKey, rows }: { key: string; sourceKey: string; rows: unknown[] }) => {
            const host = document.querySelector<HTMLInputElement>("#number");
            if (host == null) return { missing: true };
            const sourceNodes = (globalThis as typeof globalThis & Record<string, unknown>)[sourceKey];
            let allOwnersKnown = Array.isArray(sourceNodes) && rows.length <= 16;
            const owners = rows.slice(0, 16).map((value) => {
              const row = value != null && typeof value === "object" ? (value as Record<string, unknown>) : null;
              const index =
                typeof row?.index === "number" && Number.isSafeInteger(row.index) && row.index >= 0 ? row.index : null;
              const node = index != null && Array.isArray(sourceNodes) ? sourceNodes[index] : undefined;
              const known = node instanceof Element;
              if (!known) allOwnersKnown = false;
              return {
                sourceNodeIndex: index,
                sourceNodeKnown: known,
                number: known ? node === host : null,
                selectArrow: row?.selectArrow === true,
                exactPartBox: row?.exactPartBox === true,
                partCount: Array.isArray(row?.parts) ? row.parts.length : 0,
              };
            });
            const containsNumber = owners.some((owner) => owner.number === true);
            const stateOf = (node: Element) => {
              const cs = getComputedStyle(node),
                r = node.getBoundingClientRect();
              return {
                hover: node.matches(":hover"),
                focus: node.matches(":focus"),
                active: node.matches(":active"),
                visibility: cs.visibility,
                opacity: cs.opacity,
                display: cs.display,
                pointerEvents: cs.pointerEvents,
                appearance: cs.appearance,
                rect: { x: r.x, y: r.y, width: r.width, height: r.height },
              };
            };
            const retained = (host as HTMLInputElement & Record<string, unknown>)[key] as
              { kind?: string; node?: Element }[] | undefined;
            return {
              moment: "after existing isolation screenshot, before restore",
              isolationOwners: {
                count: rows.length,
                observedCount: owners.length,
                truncated: rows.length > owners.length,
                numberIsActiveOwner: containsNumber ? true : allOwnersKnown ? false : null,
                owners,
              },
              time: performance.now(),
              host: stateOf(host),
              activeId: document.activeElement?.id ?? null,
              parts: (retained ?? []).slice(0, 8).map(({ kind, node }) => ({
                kind,
                connected: node?.isConnected ?? false,
                state: node == null ? null : stateOf(node),
              })),
            };
          },
          { key: isolation.keys.decorationNodeKey, sourceKey: isolation.keys.sourceNodeKey, rows: isolation.keys.rows },
        ).catch(() => ({ diagnosticError: "post-frame state unavailable" })),
        2_000,
        { diagnosticError: "post-frame state exceeded 2000ms" },
      );
      frames.push({ png, facts: isolation.facts, state, options, time: Date.now() });
    }
    return png;
  };
  return {
    dispose() {
      page.evaluate = originalEvaluate;
      page.screenshot = screenshot;
    },
    async write(directory: string, name: string, number: CapturedElement, profile: unknown) {
      mkdirSync(directory, { recursive: true });
      const records = [];
      for (const [index, frame] of frames.entries()) {
        const decoded = await sharp(frame.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const raster = number.nativeControlDecorationRaster;
        const viewport = { x: 0, y: 0, width: 430, height: 260 };
        const plan = raster == null ? null : planNativeControlClip(raster, viewport);
        const crop = plan == null ? null : nativeControlPixelCrop(plan.output, viewport, decoded.info);
        const rgba =
          crop == null
            ? null
            : cropNativeControlRgba(
                { data: decoded.data, width: decoded.info.width, height: decoded.info.height },
                crop,
              );
        const pngName = `${name}-${index}-isolation.png`;
        writeFileSync(join(directory, pngName), frame.png);
        if (rgba != null && crop != null)
          writeFileSync(
            join(directory, `${name}-${index}-crop.png`),
            await sharp(Buffer.from(rgba), { raw: { width: crop.width, height: crop.height, channels: 4 } })
              .png()
              .toBuffer(),
          );
        records.push({
          png: pngName,
          bytes: frame.png.length,
          sha256: createHash("sha256").update(frame.png).digest("hex"),
          screenshotOptions: frame.options,
          time: frame.time,
          isolationFacts: frame.facts,
          postScreenshotState: frame.state,
          plan,
          pixelCrop: crop,
          alpha: rgba == null ? null : nativeControlAlphaStats(rgba),
        });
      }
      const candidate = process.env["GITHUB_SHA"] ?? process.env["DOMOTION_NATIVE_PROBE_COMMIT"];
      writeFileSync(
        join(directory, `${name}.json`),
        JSON.stringify(
          {
            profile,
            sourceCommit: candidate != null && /^[a-f0-9]{40}$/i.test(candidate) ? candidate : null,
            sourceHashes: Object.fromEntries(
              [
                "native-decoration-frame-probe.ts",
                "native-decoration-rule-probe.ts",
                "native-control-decoration.e2e.test.ts",
              ].map((name) => [
                name,
                createHash("sha256")
                  .update(readFileSync(new URL(name, import.meta.url), "utf8").replace(/\r\n/g, "\n"))
                  .digest("hex"),
              ]),
            ),
            platform: process.platform,
            arch: process.arch,
            node: process.version,
            raster: number.nativeControlDecorationRaster,
            records,
            observerBoundary:
              "No added screenshot. State read occurs after existing screenshot and can affect later restore timing; not proof of historical pre-capture paint.",
          },
          null,
          2,
        ),
      );
    },
  };
}

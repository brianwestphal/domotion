import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { namespaceEmbeddedAnimatedSvg } from "../animation/embed-namespace.js";
import type { Transition } from "../animation/transition-schema.js";
import { parseSvgIntrinsicSize } from "../animation/svg-meta.js";
import { wrapInDeviceChrome } from "../render/device-chrome.js";
import type { Brand } from "../templates/brand.js";
import {
  studioTreatmentsSchema,
  type StudioTreatment,
  type StudioTreatmentLayerPrimitive,
  type StudioTreatmentMaskPrimitive,
  type StudioTreatmentOverlayPrimitive,
  type StudioTreatmentTiming,
  type StudioTreatmentTransformPrimitive,
} from "./treatment-schema.js";

export interface StudioTreatmentPlan {
  treatments: StudioTreatment[];
  layers: StudioTreatmentLayerPrimitive[];
  masks: StudioTreatmentMaskPrimitive[];
  transforms: StudioTreatmentTransformPrimitive[];
  overlays: StudioTreatmentOverlayPrimitive[];
  timings: StudioTreatmentTiming[];
  transition?: Transition;
}

export interface ApplyStudioTreatmentsOptions {
  width?: number;
  height?: number;
  brand?: Brand;
  assetDir?: string;
}

export interface AppliedStudioTreatments {
  svg: string;
  width: number;
  height: number;
  plan: StudioTreatmentPlan;
}

export class StudioTreatmentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StudioTreatmentError";
  }
}

const defaultTiming = (): StudioTreatmentTiming => ({ startMs: 0, durationMs: 500, easing: "cubic-bezier(0.22,1,0.36,1)" });

/** Validate presets and expose the lower-level layer/mask/transform/overlay/timing plan they expand into. */
export function resolveStudioTreatmentPlan(raw: unknown, brand: Brand = {}): StudioTreatmentPlan {
  const parsed = studioTreatmentsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StudioTreatmentError(`invalid Studio treatment: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  }
  const layers: StudioTreatmentLayerPrimitive[] = [];
  const masks: StudioTreatmentMaskPrimitive[] = [];
  const transforms: StudioTreatmentTransformPrimitive[] = [];
  const overlays: StudioTreatmentOverlayPrimitive[] = [];
  const timings: StudioTreatmentTiming[] = [];
  let transition: Transition | undefined;
  parsed.data.forEach((treatment, index) => {
    if (treatment.kind === "scene-transition") {
      transition = treatment.transition;
      return;
    }
    const timing = treatment.kind === "zoom-pan" || treatment.kind === "spotlight" || treatment.kind === "callout" || treatment.kind === "title-card" || treatment.kind === "logo-reveal"
      ? (treatment.timing ?? defaultTiming())
      : undefined;
    layers.push({ id: `treatment-${index}-${treatment.kind}`, opacity: 1, blendMode: "normal" });
    if (timing != null) timings.push(timing);
    if (treatment.kind === "zoom-pan") transforms.push(treatment.transform);
    if (treatment.kind === "spotlight") masks.push(treatment.mask);
    if (treatment.kind === "spotlight") overlays.push({ region: treatment.mask.region, fill: treatment.color, strokeWidth: 2 });
    if (treatment.kind === "callout") overlays.push({ region: treatment.box, fill: treatment.fill ?? brand.palette?.background ?? "#111827", stroke: treatment.accent ?? brand.palette?.accent ?? brand.palette?.primary ?? "#7c3aed", strokeWidth: 2 });
    if (treatment.kind === "title-card") overlays.push({ region: { x: 0, y: 0, width: 1, height: 1 }, fill: treatment.background ?? brand.background ?? brand.palette?.background ?? "#0b1020", strokeWidth: 2 });
  });
  return { treatments: parsed.data, layers, masks, transforms, overlays, timings, ...(transition != null ? { transition } : {}) };
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function animationStyle(name: string, timing: StudioTreatmentTiming): string {
  return `animation:${name} ${timing.durationMs}ms ${timing.easing} ${timing.startMs}ms both`;
}

function roundedRectPath(x: number, y: number, width: number, height: number, radius = 0): string {
  const r = Math.min(Math.max(0, radius), width / 2, height / 2);
  if (r === 0) return `M${x} ${y}H${x + width}V${y + height}H${x}Z`;
  return `M${x + r} ${y}H${x + width - r}A${r} ${r} 0 0 1 ${x + width} ${y + r}V${y + height - r}A${r} ${r} 0 0 1 ${x + width - r} ${y + height}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + height - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
}

function wrap(width: number, height: number, content: string, overlay: string, style = "", defs = ""): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${defs === "" ? "" : `<defs>${defs}</defs>`}${style === "" ? "" : `<style>${style}</style>`}${content}${overlay}</svg>`;
}

function nestableSvg(svg: string): string {
  return svg
    .replace(/^\s*<\?xml[^>]*\?>\s*/i, "")
    .replace(/^\s*<!doctype[^>]*>\s*/i, "");
}

function svgPaint(value: string, token: string): { fill: string; defs?: string } {
  const gradient = value.match(/^linear-gradient\(\s*(?:(?:[-\d.]+deg|to\s+[^,]+)\s*,\s*)?([^,]+)\s*,\s*([^,)]+)\s*\)$/i);
  if (gradient == null) return { fill: value };
  const id = `${token}background`;
  return {
    fill: `url(#${id})`,
    defs: `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${escapeXml(gradient[1].trim())}"/><stop offset="1" stop-color="${escapeXml(gradient[2].trim())}"/></linearGradient>`,
  };
}

function assertSelfContainedSvg(svg: string): void {
  const withoutNamespace = svg.replace(/\sxmlns(?::\w+)?=["'][^"']+["']/gi, "");
  if (/(?:href|src)\s*=\s*["'](?:https?:)?\/\//i.test(withoutNamespace) || /(?:url\(|@import\s+)["']?(?:https?:)?\/\//i.test(withoutNamespace)) {
    throw new StudioTreatmentError("logo-reveal SVG contains a remote resource and is not self-contained");
  }
}

function embedLogo(source: string, assetDir: string): string {
  if (source.startsWith("data:")) {
    if (/^data:image\/svg\+xml[;,]/i.test(source)) {
      const comma = source.indexOf(",");
      try {
        const svg = /;base64,/i.test(source)
          ? Buffer.from(source.slice(comma + 1), "base64").toString("utf8")
          : decodeURIComponent(source.slice(comma + 1));
        assertSelfContainedSvg(svg);
      } catch (error) {
        if (error instanceof StudioTreatmentError) throw error;
        throw new StudioTreatmentError("logo-reveal received an invalid SVG data URL", { cause: error });
      }
    }
    return source;
  }
  if (/^https?:\/\//i.test(source)) {
    throw new StudioTreatmentError("logo-reveal requires an inline data URL or local asset so the output stays self-contained");
  }
  if (source.trimStart().startsWith("<svg")) {
    assertSelfContainedSvg(source);
    return `data:image/svg+xml;base64,${Buffer.from(source).toString("base64")}`;
  }
  const path = resolve(assetDir, source);
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    throw new StudioTreatmentError(`logo-reveal could not read ${path}`, { cause: error });
  }
  const mime = extname(path).toLowerCase() === ".svg" ? "image/svg+xml"
    : extname(path).toLowerCase() === ".png" ? "image/png"
      : extname(path).toLowerCase() === ".webp" ? "image/webp"
        : extname(path).toLowerCase() === ".jpg" || extname(path).toLowerCase() === ".jpeg" ? "image/jpeg"
          : "application/octet-stream";
  if (mime === "image/svg+xml") assertSelfContainedSvg(bytes.toString("utf8"));
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/** Apply ordered, nestable cinematic presets to a complete self-contained SVG. */
export function applyStudioTreatments(
  svg: string,
  rawTreatments: unknown,
  options: ApplyStudioTreatmentsOptions = {},
): AppliedStudioTreatments {
  const brand = options.brand ?? {};
  const plan = resolveStudioTreatmentPlan(rawTreatments, brand);
  const intrinsic = parseSvgIntrinsicSize(svg);
  let width: number = options.width ?? intrinsic?.w ?? Number.NaN;
  let height: number = options.height ?? intrinsic?.h ?? Number.NaN;
  if (!(width > 0) || !(height > 0)) throw new StudioTreatmentError("treated SVG needs an intrinsic viewBox/size or explicit width and height");
  let current = svg;

  plan.treatments.forEach((treatment, index) => {
    if (treatment.kind === "scene-transition") return;
    const token = `st${index}_`;
    current = namespaceEmbeddedAnimatedSvg(current, token);
    if (treatment.kind === "device-frame") {
      const framed = wrapInDeviceChrome(current, treatment.device, width, height, { label: treatment.label, theme: treatment.theme });
      current = framed.svg; width = framed.width; height = framed.height;
      return;
    }
    if (treatment.kind === "browser-chrome") {
      const framed = wrapInDeviceChrome(current, "browser", width, height, { label: treatment.label, theme: treatment.theme });
      current = framed.svg; width = framed.width; height = framed.height;
      return;
    }
    if (treatment.kind === "terminal-chrome") {
      const framed = wrapInDeviceChrome(current, "window", width, height, { label: treatment.title, theme: treatment.theme });
      current = framed.svg; width = framed.width; height = framed.height;
      return;
    }

    const timing = treatment.timing ?? defaultTiming();
    const nested = nestableSvg(current);
    if (treatment.kind === "zoom-pan") {
      const { from, to, origin } = treatment.transform;
      const animation = `${token}zoom`;
      const ox = origin?.x ?? width / 2;
      const oy = origin?.y ?? height / 2;
      const style = `@keyframes ${animation}{from{transform:translate(${from.x}px,${from.y}px) scale(${from.scale})}to{transform:translate(${to.x}px,${to.y}px) scale(${to.scale})}}`;
      current = wrap(width, height, `<g style="transform-origin:${ox}px ${oy}px;${animationStyle(animation, timing)}">${nested}</g>`, "", style);
      return;
    }
    if (treatment.kind === "spotlight") {
      const r = treatment.mask.region;
      const animation = `${token}spotlight`;
      const outer = `M0 0H${width}V${height}H0Z`;
      const hole = roundedRectPath(r.x, r.y, r.width, r.height, r.radius);
      const style = `@keyframes ${animation}{from{opacity:0}to{opacity:${treatment.opacity}}}`;
      const overlay = `<path d="${outer}${hole}" fill="${escapeXml(treatment.color)}" fill-rule="evenodd" clip-rule="evenodd" style="${animationStyle(animation, timing)}"/>`;
      current = wrap(width, height, nested, overlay, style);
      return;
    }
    if (treatment.kind === "callout") {
      const animation = `${token}callout`;
      const box = treatment.box;
      const fill = treatment.fill ?? brand.palette?.background ?? "#111827";
      const color = treatment.color ?? brand.palette?.text ?? "#ffffff";
      const accent = treatment.accent ?? brand.palette?.accent ?? brand.palette?.primary ?? "#7c3aed";
      const style = `@keyframes ${animation}{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}`;
      const overlay = `<g style="${animationStyle(animation, timing)}"><path d="M${treatment.anchor.x} ${treatment.anchor.y}L${box.x + box.width / 2} ${box.y + box.height / 2}" stroke="${escapeXml(accent)}" stroke-width="2"/><rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="${box.radius ?? 12}" fill="${escapeXml(fill)}" stroke="${escapeXml(accent)}" stroke-width="2"/><text x="${box.x + 16}" y="${box.y + box.height / 2}" dominant-baseline="middle" fill="${escapeXml(color)}" font-family="system-ui,sans-serif" font-size="16">${escapeXml(treatment.text)}</text></g>`;
      current = wrap(width, height, nested, overlay, style);
      return;
    }
    if (treatment.kind === "title-card") {
      const animation = `${token}title`;
      const background = treatment.background ?? brand.background ?? brand.palette?.background ?? "#0b1020";
      const backgroundPaint = svgPaint(background, token);
      const color = treatment.color ?? brand.palette?.text ?? "#ffffff";
      const accent = treatment.accent ?? brand.palette?.accent ?? brand.palette?.primary ?? "#8b5cf6";
      const anchor = treatment.align === "center" ? "middle" : "start";
      const x = treatment.align === "center" ? width / 2 : Math.max(40, width * 0.08);
      const style = `@keyframes ${animation}{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:translateY(0)}}`;
      const subtitle = treatment.subtitle == null ? "" : `<text x="${x}" y="${height / 2 + 42}" text-anchor="${anchor}" fill="${escapeXml(color)}" opacity=".72" font-family="system-ui,sans-serif" font-size="22">${escapeXml(treatment.subtitle)}</text>`;
      const overlay = `<g style="${animationStyle(animation, timing)}"><rect width="${width}" height="${height}" fill="${escapeXml(backgroundPaint.fill)}"/><rect x="${x - (treatment.align === "center" ? 36 : 0)}" y="${height / 2 - 54}" width="72" height="5" rx="2.5" fill="${escapeXml(accent)}"/><text x="${x}" y="${height / 2}" text-anchor="${anchor}" fill="${escapeXml(color)}" font-family="system-ui,sans-serif" font-size="44" font-weight="700">${escapeXml(treatment.title)}</text>${subtitle}</g>`;
      current = wrap(width, height, nested, overlay, style, backgroundPaint.defs);
      return;
    }
    const logoSource = treatment.logo ?? brand.logo;
    if (logoSource == null) throw new StudioTreatmentError("logo-reveal needs `logo` or a brand logo");
    const href = embedLogo(logoSource, options.assetDir ?? process.cwd());
    const logoWidth = treatment.width ?? Math.min(width * 0.28, 220);
    const position = treatment.position ?? { x: width / 2 - logoWidth / 2, y: height / 2 - logoWidth / 4 };
    const animation = `${token}logo`;
    const style = `@keyframes ${animation}{from{opacity:0;transform:scale(.82)}to{opacity:1;transform:scale(1)}}`;
    const overlay = `<image href="${escapeXml(href)}" x="${position.x}" y="${position.y}" width="${logoWidth}" height="${logoWidth}" preserveAspectRatio="xMidYMid meet" style="transform-origin:${position.x + logoWidth / 2}px ${position.y + logoWidth / 2}px;${animationStyle(animation, timing)}"/>`;
    current = wrap(width, height, nested, overlay, style);
  });

  return { svg: current, width, height, plan };
}

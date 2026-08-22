#!/usr/bin/env tsx

/**
 * Static + route gate for source-owned form-control paint.
 *
 * Pinned Chromium 7d859f271cbda744098ac69f44978d4edfa62be3 routes every
 * effective native appearance through ThemePainter. Domotion must therefore
 * consume a reserved Chromium surface or fail closed; only structural
 * none/base/base-select/listbox/menulist-button states may reach vector paint.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import type { CapturedElement } from "../src/capture/types.js";
import {
  formControlRenderRoute,
  renderFormControl,
  type FormControlRenderRoute,
} from "../src/render/form-controls.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BANNED_SAMPLED_TOKENS = [
  "STOCK_LIGHT", "STOCK_DARK", "stockPalette", "unfilledTrackColor",
  "resolveAccent", "ACCENT_BLUE", "TRACK_BG", "TRACK_FG", "METER_GREEN",
  "METER_YELLOW", "METER_RED", "DISABLED_BORDER", "renderDatePicker",
  "renderCalendarIcon", "renderClockIcon", "renderNumberInput",
  "renderSearchInput", "renderCustomCheckboxOrSwitch",
] as const;

const BANNED_SAMPLED_LITERALS = [
  /rgb\(\s*0\s*,\s*117\s*,\s*255\s*\)/i,
  /rgb\(\s*203\s*,\s*203\s*,\s*203\s*\)/i,
  /#767676/i,
  /\b0\.26\b/,
  /Choose File|No file chosen/,
] as const;

export function auditNativeControlFallbackSources(
  formControlsSource: string,
  emitterSource: string,
): string[] {
  const errors: string[] = [];
  for (const token of BANNED_SAMPLED_TOKENS) {
    if (formControlsSource.includes(token)) errors.push(`sampled native fallback token remains: ${token}`);
  }
  for (const pattern of BANNED_SAMPLED_LITERALS) {
    if (pattern.test(formControlsSource)) errors.push(`sampled native fallback literal remains: ${pattern.source}`);
  }
  const forbiddenPlatformOrFixtureChecks = [
    /process\.platform/,
    /navigator\.(?:platform|userAgent)/,
    /data-domotion-anim/,
    /fixture(?:Name|Path|Id)/i,
  ];
  for (const pattern of forbiddenPlatformOrFixtureChecks) {
    if (pattern.test(formControlsSource)) errors.push(`platform/fixture routing check remains: ${pattern.source}`);
  }
  if (!formControlsSource.includes("formControlRenderRoute")) {
    errors.push("form-control route classifier missing");
  }
  if (!formControlsSource.includes("required Chromium native-control surface unavailable")) {
    errors.push("missing-raster fail-closed warning missing");
  }
  const nativeRecord = emitterSource.indexOf("const nativeControlRaster = el.nativeControlRaster");
  const terminalGuard = emitterSource.indexOf("if (nativeControlRaster != null)", nativeRecord);
  const structuralDispatch = emitterSource.indexOf("renderFormControl(el", terminalGuard);
  if (nativeRecord < 0 || terminalGuard < 0 || structuralDispatch < 0
      || !(nativeRecord < terminalGuard && terminalGuard < structuralDispatch)) {
    errors.push("native-control raster must terminate emission before renderFormControl");
  }
  return errors;
}

interface RouteRow {
  name: string;
  tag: CapturedElement["tag"];
  inputType?: string;
  appearance?: string;
  raster?: "materialized" | "empty" | "missing";
  expected: FormControlRenderRoute;
}

export const FORM_CONTROL_ROUTE_ROWS: RouteRow[] = [
  ...[
    ["checkbox", "input", "checkbox"],
    ["radio", "input", "radio"],
    ["range-horizontal", "input", "slider-horizontal"],
    ["range-vertical", "input", "slider-vertical"],
    ["progress", "progress", "progress-bar"],
    ["meter", "meter", "meter"],
    ["file-button-host", "input", "none"],
    ["date-native", "input", "textfield"],
    ["select-native", "select", "menulist"],
  ].map(([name, tag, appearance]): RouteRow => ({
    name: `${name}-materialized`, tag: tag as CapturedElement["tag"],
    inputType: tag === "input" ? name.split("-")[0] : undefined,
    appearance, raster: "materialized", expected: "native-raster",
  })),
  {
    name: "checkbox-authoritative-empty", tag: "input", inputType: "checkbox",
    appearance: "checkbox", raster: "empty", expected: "native-raster",
  },
  ...[
    ["checkbox", "input", "checkbox"],
    ["radio", "input", "radio"],
    ["range", "input", "slider-horizontal"],
    ["progress", "progress", "progress-bar"],
    ["meter", "meter", "meter"],
    ["date", "input", "textfield"],
    ["select", "select", "menulist"],
  ].map(([name, tag, appearance]): RouteRow => ({
    name: `${name}-missing`, tag: tag as CapturedElement["tag"],
    inputType: tag === "input" ? name : undefined,
    appearance, raster: "missing", expected: "missing-native-raster",
  })),
  { name: "unknown-old-tree", tag: "input", inputType: "checkbox", expected: "missing-native-raster" },
  { name: "author-none", tag: "input", inputType: "range", appearance: "none", expected: "structural" },
  { name: "author-base", tag: "input", inputType: "checkbox", appearance: "base", expected: "structural" },
  { name: "author-base-select", tag: "select", appearance: "base-select", expected: "structural" },
  { name: "author-menulist-button", tag: "select", appearance: "menulist-button", expected: "structural" },
  { name: "author-listbox", tag: "select", appearance: "listbox", expected: "structural" },
  { name: "non-control", tag: "div", expected: "not-form-control" },
];

function elementFor(row: RouteRow): CapturedElement {
  return {
    tag: row.tag,
    x: 0,
    y: 0,
    width: 20,
    height: 20,
    children: [],
    ...(row.raster === "materialized" ? {
      nativeControlRaster: {
        x: 0, y: 0, width: 20, height: 20,
        dataUri: "data:image/png;base64,AA==",
      },
    } : row.raster === "empty" ? {
      nativeControlRaster: { x: 0, y: 0, width: 20, height: 20, empty: true },
    } : {}),
    styles: {
      inputType: row.inputType,
      effectiveAppearance: row.appearance,
    },
  } as unknown as CapturedElement;
}

export function auditFormControlRoutes(): string[] {
  const errors: string[] = [];
  const originalWarn = console.warn;
  console.warn = () => undefined;
  try {
    for (const row of FORM_CONTROL_ROUTE_ROWS) {
      const element = elementFor(row);
      const actual = formControlRenderRoute(element);
      if (actual !== row.expected) errors.push(`${row.name}: expected ${row.expected}, got ${actual}`);
      if ((actual === "native-raster" || actual === "missing-native-raster")
          && renderFormControl(element, "") !== "") {
        errors.push(`${row.name}: native route emitted sampled vector paint`);
      }
      if (actual === "not-form-control" && renderFormControl(element, "") !== "") {
        errors.push(`${row.name}: non-control route emitted form-control paint`);
      }
    }
  } finally {
    console.warn = originalWarn;
  }
  return errors;
}

export function runNativeControlFallbackGate(): { ok: boolean; errors: string[]; routeRows: number } {
  const formSource = readFileSync(resolve(ROOT, "src/render/form-controls.ts"), "utf8");
  const emitterSource = readFileSync(resolve(ROOT, "src/render/element-tree-to-svg.ts"), "utf8");
  const errors = [
    ...auditNativeControlFallbackSources(formSource, emitterSource),
    ...auditFormControlRoutes(),
  ];
  return { ok: errors.length === 0, errors, routeRows: FORM_CONTROL_ROUTE_ROWS.length };
}

if (process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runNativeControlFallbackGate();
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

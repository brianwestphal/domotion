#!/usr/bin/env node
/** Collect DM-2575's exact test-only trace from a pinned, explicitly headless Chromium. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import {
  SFNS_VALIDATION_CHROMIUM_REVISION,
  SFNS_VALIDATION_CONTROLS,
  SFNS_VALIDATION_DEPOT_TOOLS_REVISION,
  SFNS_VALIDATION_FONT_BYTE_LENGTH,
  SFNS_VALIDATION_FONT_SHA256,
  SFNS_VALIDATION_GLYPH_IDS,
  SFNS_VALIDATION_HOOK_ABI,
  SFNS_VALIDATION_SCENARIOS,
  SFNS_VALIDATION_SKIA_REVISION,
  sfnsValidationArtifactDigest,
  sfnsValidationChangedEvidenceGroups,
  sfnsValidationObservationDigest,
  validateSfnsPinnedChromiumValidation,
  type SfnsFilteredPayload,
  type SfnsHookEvent,
  type SfnsMaskPayload,
  type SfnsPinnedChromiumValidationArtifact,
  type SfnsRawPayload,
  type SfnsRunPayload,
  type SfnsValidationControlId,
  type SfnsValidationObservation,
  type SfnsValidationScenarioId,
} from "./sfns-pinned-chromium-validation-schema.js";

const TEXT = "zoom2!";
const WIDTH = 240;
const HEIGHT = 100;
const FONT_ORIGIN = "https://dm2575-sfns.invalid";
const argv = process.argv.slice(2);

function value(flag: string, fallback?: string): string {
  const index = argv.indexOf(flag);
  const result = index < 0 ? fallback : argv[index + 1];
  if (result == null || result.startsWith("--")) throw new Error(`missing ${flag}`);
  return result;
}

function has(flag: string): boolean {
  return argv.includes(flag);
}

const sourceRoot = resolve(value(
  "--source-root", ".chromium-build/worktrees/dm2575/src",
));
const depotTools = resolve(value("--depot-tools", ".chromium-build/depot_tools"));
const binaryPath = resolve(value("--binary", `${sourceRoot}/out/DM2575/headless_shell`));
const fontPath = resolve(value("--font", "/System/Library/Fonts/SFNS.ttf"));
const outputPath = resolve(value(
  "--out", ".pr-notes/artifacts/dm2575-sfns-pinned-chromium-validation.json",
));
const eventRoot = resolve(value(
  "--events", `tests/output/dm2575-sfns-events-${Date.now()}`,
));
const probe = has("--probe");

const sha = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const fileSha = (path: string): string => sha(readFileSync(path));
const gitRevision = (path: string): string => execFileSync(
  "git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" },
).trim();

if (!existsSync(binaryPath) || !statSync(binaryPath).isFile()) {
  throw new Error(`pinned headless_shell missing: ${binaryPath}`);
}
const fontBytes = readFileSync(fontPath);
if (fontBytes.byteLength !== SFNS_VALIDATION_FONT_BYTE_LENGTH || sha(fontBytes) !== SFNS_VALIDATION_FONT_SHA256) {
  throw new Error("SFNS source bytes do not match the pinned corpus");
}
if (gitRevision(sourceRoot) !== SFNS_VALIDATION_CHROMIUM_REVISION
    || gitRevision(`${sourceRoot}/third_party/skia`) !== SFNS_VALIDATION_SKIA_REVISION
    || gitRevision(depotTools) !== SFNS_VALIDATION_DEPOT_TOOLS_REVISION) {
  throw new Error("Chromium/Skia/depot_tools checkouts do not match the pinned revisions");
}
if (existsSync(eventRoot) && readdirSync(eventRoot).length > 0) {
  throw new Error(`event root must be absent or empty (stale evidence refused): ${eventRoot}`);
}
mkdirSync(eventRoot, { recursive: true });

interface ObservationRequest {
  scenarioId: SfnsValidationScenarioId;
  observationId: string;
  lifecycle: "cold" | "warm" | "control";
  ordinal: number;
  controlId: "" | SfnsValidationControlId;
}

function chromiumLaunchArgs(request: ObservationRequest): string[] {
  return [
    "--headless=new",
    ...(has("--gpu-raster") ? [] : ["--disable-gpu"]),
    "--no-sandbox",
    request.controlId === "surface-mask-format" ? "--disable-lcd-text" : "--enable-lcd-text",
  ];
}

function scenarioCss(request: ObservationRequest): { target: string; anchorLeft: number; opsz: number } {
  let target = request.scenarioId === "transform-scale-2"
    ? "transform:scale(2);transform-origin:0 0"
    : request.scenarioId === "zoom-2-transform-half"
      ? "zoom:2;transform:scale(.5);transform-origin:0 0"
      : "zoom:2";
  let anchorLeft = 37.25;
  let opsz = request.scenarioId === "opsz-26-mutation" ? 26 : 17;
  if (request.scenarioId === "optical-sizing-none") target += ";font-optical-sizing:none";
  switch (request.controlId) {
    case "subpixel-phase": anchorLeft += 0.25; break;
    case "anti-aliasing": target += ";-webkit-font-smoothing:antialiased"; break;
    case "hinting": target += ";text-rendering:geometricPrecision"; break;
    case "device-matrix": target = "zoom:2;transform:scale(1.25);transform-origin:0 0"; break;
    case "optical-size": opsz = 26; break;
    case "surface-mask-format": target += ";mix-blend-mode:multiply"; break;
    default: break;
  }
  return { target, anchorLeft, opsz };
}

function html(request: ObservationRequest): string {
  const config = scenarioCss(request);
  const axes = `"wdth" 100,"opsz" ${config.opsz},"GRAD" 400,"wght" 700`;
  const warm = request.lifecycle === "warm";
  return `<!doctype html><style>
    @font-face{font-family:DM2575Evidence;src:url("${FONT_ORIGIN}/evidence-${request.observationId}.ttf") format("truetype");font-weight:100 900;font-stretch:50% 200%}
    @font-face{font-family:DM2575Warmup;src:url("${FONT_ORIGIN}/warmup-${request.observationId}.ttf") format("truetype");font-weight:100 900;font-stretch:50% 200%}
    *{box-sizing:border-box}html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px;background:#000;overflow:hidden}
    #anchor{position:absolute;left:${config.anchorLeft}px;top:18.25px}
    #target{display:inline-block;color:#fff;background:#000;white-space:pre;font-family:${warm ? "DM2575Warmup" : "DM2575Evidence"};font-weight:700;font-size:13px;line-height:normal;font-variation-settings:${axes};${config.target}}
  </style><div id="anchor"><span id="target">${warm ? "W" : TEXT}</span></div>`;
}

function exactEnvironment(request: ObservationRequest, directory: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DOMOTION_SFNS_HOOK_ABI: SFNS_VALIDATION_HOOK_ABI,
    DOMOTION_SFNS_OUTPUT_DIR: directory,
    DOMOTION_SFNS_OBSERVATION_ID: request.observationId,
    DOMOTION_SFNS_SCENARIO_ID: request.scenarioId,
    DOMOTION_SFNS_LIFECYCLE: request.lifecycle,
    DOMOTION_SFNS_ORDINAL: String(request.ordinal),
    DOMOTION_SFNS_CONTROL_ID: request.controlId,
    DOMOTION_SFNS_SOURCE_SHA256: SFNS_VALIDATION_FONT_SHA256,
    DOMOTION_SFNS_SOURCE_BYTE_LENGTH: String(SFNS_VALIDATION_FONT_BYTE_LENGTH),
  };
}

async function collectBrowserFacts(
  page: Page,
  browser: Browser,
  screenshot: Buffer,
  launchArgs: string[],
) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  const documentNode = await cdp.send("DOM.getDocument", { depth: -1 });
  const target = await cdp.send("DOM.querySelector", {
    nodeId: documentNode.root.nodeId,
    selector: "#target",
  });
  const platform = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: target.nodeId });
  const cssAndRange = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>("#target")!;
    const style = getComputedStyle(element);
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = range.getBoundingClientRect();
    return {
      css: {
        fontSize: style.fontSize,
        fontFamily: style.fontFamily,
        fontVariationSettings: style.fontVariationSettings,
        fontOpticalSizing: style.fontOpticalSizing,
        fontSmoothing: style.getPropertyValue("-webkit-font-smoothing"),
        textRendering: style.textRendering,
        transform: style.transform,
        zoom: style.zoom,
      },
      range: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      userAgent: navigator.userAgent,
    };
  });
  return {
    explicitlyHeadless: true as const,
    launchArgs,
    version: browser.version(),
    userAgent: cssAndRange.userAgent,
    screenshotSha256: sha(screenshot),
    platformFonts: platform.fonts.map((font) => ({
      familyName: font.familyName,
      postScriptName: font.postScriptName,
      isCustomFont: font.isCustomFont,
      glyphCount: font.glyphCount,
    })),
    css: cssAndRange.css,
    range: cssAndRange.range,
  };
}

function readEvents(directory: string): SfnsHookEvent[] {
  const names = readdirSync(directory);
  const temporary = names.filter((name) => name.endsWith(".tmp"));
  if (temporary.length > 0) throw new Error(`incomplete hook writes: ${temporary.join(",")}`);
  const events = names.filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(`${directory}/${name}`, "utf8")) as SfnsHookEvent)
    .sort((left, right) => left.sequence - right.sequence);
  if (events.length === 0) throw new Error(`hook emitted no evidence in ${directory}`);
  return events;
}

async function waitForTraceQuiescence(directory: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let stableSince = Date.now();
  let priorSignature = "";
  while (Date.now() < deadline) {
    const signature = readdirSync(directory).sort().map((name) => {
      const file = `${directory}/${name}`;
      return `${name}:${statSync(file).size}`;
    }).join("|");
    const hasTemporary = signature.includes(".tmp:");
    if (signature !== priorSignature || hasTemporary) {
      stableSince = Date.now();
      priorSignature = signature;
    } else if (Date.now() - stableSince >= 750) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error(`hook trace did not quiesce before renderer teardown: ${directory}`);
}

function selectEvidence(events: SfnsHookEvent[]) {
  const runs = events.filter((event) => event.event === "run");
  const materializingRuns = runs.flatMap((candidate, index) => {
    const uid = candidate.typeface.uniqueId;
    const payload = candidate.payload as SfnsRunPayload;
    const nextRunSequence = runs[index + 1]?.sequence ?? Number.POSITIVE_INFINITY;
    const packedIds = [...new Set(payload.glyphs.map((glyph) => glyph.packedId))];
    const masks = packedIds.map((packedId) => events.filter((event) => event.event === "mask"
      && event.typeface.uniqueId === uid
      && event.sequence > candidate.sequence
      && event.sequence < nextRunSequence
      && (event.payload as SfnsMaskPayload).glyph.packedId === packedId));
    return masks.every((matches) => matches.length === 1)
      ? [{ run: candidate, masks: masks.map((matches) => matches[0]) }]
      : [];
  });
  if (materializingRuns.length !== 1) {
    throw new Error(
      `expected one target run that materialized every packed mask, got ${materializingRuns.length}`,
    );
  }
  const { run, masks } = materializingRuns[0];
  const uid = run.typeface.uniqueId;
  const maskRec = (masks[0].payload as SfnsMaskPayload).filteredRec.sha256;
  const filteredCandidates = events.filter((event) => event.event === "filtered"
    && event.typeface.uniqueId === uid
    && event.sequence < run.sequence
    && (event.payload as SfnsFilteredPayload).after.sha256 === maskRec);
  const filtered = filteredCandidates.at(-1);
  if (filtered == null) throw new Error("expected a linked filtered record");
  const beforeRec = (filtered.payload as SfnsFilteredPayload).before.sha256;
  const rawCandidates = events.filter((event) => event.event === "raw"
    && event.typeface.uniqueId === uid
    && event.sequence < filtered.sequence
    && (event.payload as SfnsRawPayload).rawRec.sha256 === beforeRec);
  const raw = rawCandidates.at(-1);
  if (raw == null) throw new Error("expected a linked raw record");
  return {
    processId: run.processId,
    rawSequence: raw.sequence,
    filteredSequence: filtered.sequence,
    runSequence: run.sequence,
    maskSequences: masks.map((mask) => mask.sequence),
  };
}

async function collectObservation(request: ObservationRequest): Promise<SfnsValidationObservation> {
  const directory = resolve(eventRoot, request.observationId);
  if (existsSync(directory)) throw new Error(`stale observation directory refused: ${directory}`);
  mkdirSync(directory, { recursive: false });
  let browser: Browser | undefined;
  try {
    const launchArgs = chromiumLaunchArgs(request);
    browser = await chromium.launch({
      executablePath: binaryPath,
      headless: true,
      env: exactEnvironment(request, directory),
      args: launchArgs,
    });
    const context = await browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
    });
    await context.route(`${FONT_ORIGIN}/**`, (route) => route.fulfill({
      status: 200,
      contentType: "font/ttf",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: fontBytes,
    }));
    const page = await context.newPage();
    await page.setContent(html(request), { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    if (request.lifecycle === "warm") {
      await page.screenshot({ type: "png" });
      await page.evaluate(async (text) => {
        const target = document.querySelector<HTMLElement>("#target")!;
        target.style.fontFamily = "DM2575Evidence";
        target.textContent = text;
        await document.fonts.load('700 13px "DM2575Evidence"', text);
        await document.fonts.ready;
      }, TEXT);
    }
    const screenshot = await page.screenshot({ type: "png" });
    const browserFacts = await collectBrowserFacts(page, browser, screenshot, launchArgs);
    // A screenshot acknowledgement can precede a queued compositor raster.
    // Keep the renderer alive until its atomic trace files have been stable and
    // temporary-free for a full quiet window; any surviving .tmp remains fatal.
    await page.evaluate(() => new Promise<void>((resolvePromise) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolvePromise()));
    }));
    await waitForTraceQuiescence(directory);
    // Remove the authenticated SFNS page while its renderer is still alive,
    // then drain any final invalidation raster before terminating the process.
    // Closing a live painted page can otherwise kill a just-started atomic
    // trace write even though the screenshot raster itself was quiescent.
    await page.goto("about:blank", { waitUntil: "load" });
    await waitForTraceQuiescence(directory);
    await context.close();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    await browser.close();
    browser = undefined;
    let events: SfnsHookEvent[];
    try {
      events = readEvents(directory);
    } catch (error) {
      if (probe) {
        console.error(JSON.stringify({ observationId: request.observationId, browser: browserFacts }, null, 2));
      }
      throw error;
    }
    const observation: SfnsValidationObservation = {
      observationId: request.observationId,
      scenarioId: request.scenarioId,
      lifecycle: request.lifecycle,
      controlId: request.controlId,
      ordinal: request.ordinal,
      browser: browserFacts,
      events,
      selection: selectEvidence(events),
      logicalDigest: "",
    };
    observation.logicalDigest = sfnsValidationObservationDigest(observation);
    return observation;
  } finally {
    if (browser != null) await browser.close().catch(() => undefined);
  }
}

function observationRequest(
  scenarioId: SfnsValidationScenarioId,
  lifecycle: "cold" | "warm",
  ordinal: number,
): ObservationRequest {
  return {
    scenarioId,
    lifecycle,
    ordinal,
    controlId: "",
    observationId: `${scenarioId}-${lifecycle}-${ordinal}`,
  };
}

if (probe) {
  const probeLifecycle = has("--probe-warm") ? "warm" : "cold";
  const observation = await collectObservation(observationRequest("zoom-2", probeLifecycle, 1));
  const selectedEvent = (sequence: number) => observation.events.find(
    (event) => event.sequence === sequence,
  )!;
  const raw = selectedEvent(observation.selection.rawSequence);
  const filtered = selectedEvent(observation.selection.filteredSequence);
  const run = selectedEvent(observation.selection.runSequence);
  const masks = observation.selection.maskSequences.map((sequence) => {
    const event = selectedEvent(sequence);
    const payload = event.payload as SfnsMaskPayload;
    return {
      sequence,
      typeface: event.typeface,
      payload: {
        ...payload,
        glyph: {
          ...payload.glyph,
          mask: { ...payload.glyph.mask, bytes: `<${payload.glyph.metrics.imageSize} bytes>` },
        },
      },
    };
  });
  console.log(JSON.stringify({
    observationId: observation.observationId,
    events: observation.events.map((event) => [event.sequence, event.event]),
    selection: observation.selection,
    browser: observation.browser,
    raw,
    filtered,
    run,
    masks,
    digest: observation.logicalDigest,
  }, null, 2));
  process.exit(0);
}

const scenarios: SfnsPinnedChromiumValidationArtifact["scenarios"] = [];
for (const id of SFNS_VALIDATION_SCENARIOS) {
  const observations = [
    await collectObservation(observationRequest(id, "cold", 1)),
    await collectObservation(observationRequest(id, "cold", 2)),
    await collectObservation(observationRequest(id, "warm", 1)),
    await collectObservation(observationRequest(id, "warm", 2)),
  ];
  scenarios.push({
    id,
    observationLogicalDigest: sfnsValidationObservationDigest(observations[0]),
    observations,
  });
}

const baseline = scenarios.find((scenario) => scenario.id === "zoom-2")!.observations[0];
const controls: SfnsPinnedChromiumValidationArtifact["controls"] = [];
for (const id of SFNS_VALIDATION_CONTROLS) {
  const observation = await collectObservation({
    scenarioId: "zoom-2",
    observationId: `control-${id}-1`,
    lifecycle: "control",
    ordinal: 1,
    controlId: id,
  });
  controls.push({
    id,
    baselineScenarioId: "zoom-2",
    observation,
    changedEvidenceGroups: sfnsValidationChangedEvidenceGroups(baseline, observation),
  });
}

const argsPath = `${sourceRoot}/out/DM2575/args.gn`;
const withoutDigest: Omit<SfnsPinnedChromiumValidationArtifact, "artifactDigest"> = {
  schemaVersion: 1,
  authority: "validation-test-only-pinned-chromium",
  arm: "validation",
  collectionContract: {
    browserLaunches: 26,
    processIsolation: "one-explicitly-headless-browser-per-observation",
    equality: "exact-bytes-no-tolerance",
    productionRenderingChanges: false,
  },
  build: {
    chromiumRevision: SFNS_VALIDATION_CHROMIUM_REVISION,
    skiaRevision: SFNS_VALIDATION_SKIA_REVISION,
    depotToolsRevision: gitRevision(depotTools),
    platform: process.platform,
    architecture: process.arch,
    gnArgs: readFileSync(argsPath, "utf8"),
    binary: { path: relative(process.cwd(), binaryPath), sha256: fileSha(binaryPath) },
    sources: {
      hookHeaderSha256: fileSha(`${sourceRoot}/third_party/skia/src/core/SkDomotionSfnsValidation.h`),
      chromiumSkiaBuildGnSha256: fileSha(`${sourceRoot}/skia/BUILD.gn`),
      scalerContextSha256: fileSha(`${sourceRoot}/third_party/skia/src/core/SkScalerContext.cpp`),
      glyphRunPainterSha256: fileSha(`${sourceRoot}/third_party/skia/src/core/SkGlyphRunPainter.cpp`),
      typefaceMacSha256: fileSha(`${sourceRoot}/third_party/skia/src/ports/SkTypeface_mac_ct.cpp`),
      scalerContextMacSha256: fileSha(`${sourceRoot}/third_party/skia/src/ports/SkScalerContext_mac_ct.cpp`),
      retainedHookHeaderSha256: fileSha("tools/chromium-sfns-validation/SkDomotionSfnsValidation.h"),
      retainedChromiumPatchSha256: fileSha("tools/chromium-sfns-validation/chromium-build.patch"),
      retainedSkiaPatchSha256: fileSha("tools/chromium-sfns-validation/skia-hook.patch"),
      retainedOverlayReadmeSha256: fileSha("tools/chromium-sfns-validation/README.md"),
      retainedNodeIsolationProfileSha256: fileSha(
        "tools/chromium-sfns-validation/node-isolation.sb",
      ),
      buildDriverSha256: fileSha("tools/build-sfns-pinned-chromium-validator.mjs"),
      collectorSha256: fileSha("tools/sfns-pinned-chromium-validation-collector.ts"),
      schemaSha256: fileSha("tools/sfns-pinned-chromium-validation-schema.ts"),
      schemaTestSha256: fileSha("tests/sfns-pinned-chromium-validation-schema.test.ts"),
    },
    toolchain: {
      gnSha256: fileSha(`${sourceRoot}/buildtools/mac/gn`),
      ninjaSha256: fileSha(`${depotTools}/ninja`),
      clangSha256: fileSha(`${sourceRoot}/third_party/llvm-build/Release+Asserts/bin/clang++`),
    },
    hostComponents: {
      xcode: execFileSync("xcodebuild", ["-version"], { encoding: "utf8" }).trim(),
      macOS: execFileSync("sw_vers", { encoding: "utf8" }).trim(),
      metalToolchainIdentifier: "com.apple.dt.toolchain.Metal.32023.883",
      metal: execFileSync("xcrun", [
        "--toolchain", "com.apple.dt.toolchain.Metal.32023.883", "metal", "--version",
      ], { encoding: "utf8" }).trim(),
      clang: execFileSync(
        `${sourceRoot}/third_party/llvm-build/Release+Asserts/bin/clang++`,
        ["--version"], { encoding: "utf8" },
      ).trim(),
    },
  },
  corpus: {
    fontPath,
    fontByteLength: fontBytes.byteLength,
    fontSha256: sha(fontBytes),
    glyphIds: [...SFNS_VALIDATION_GLYPH_IDS],
  },
  scenarios,
  controls,
};
const artifact: SfnsPinnedChromiumValidationArtifact = {
  ...withoutDigest,
  artifactDigest: sfnsValidationArtifactDigest(withoutDigest),
};
const errors = validateSfnsPinnedChromiumValidation(artifact);
if (errors.length > 0) throw new Error(`validation artifact rejected:\n${errors.join("\n")}`);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify({
  output: outputPath,
  artifactDigest: artifact.artifactDigest,
  observations: 26,
  explicitlyHeadless: true,
}));

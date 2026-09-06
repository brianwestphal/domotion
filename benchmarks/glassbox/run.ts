import { createHash } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Browser, Page } from "@playwright/test";

import {
  gzipSvg,
  launchChromium,
  optimizeSvg,
  parseStudioProjectJson,
  renderAndReviewStudioVideo,
  runStudioHealingLoop,
  serializeStudioProject,
  type RunStudioHealingLoopOptions,
  type StudioAiHealingDecision,
  type StudioAiReviewDecision,
  type StudioProject,
  type StudioReviewMedia,
  type StudioVideoReviewReport,
} from "../../src/index.js";

const BENCHMARK_DIR = dirname(fileURLToPath(import.meta.url));
const DOMOTION_ROOT = resolve(BENCHMARK_DIR, "../..");
const DEFAULT_GLASSBOX_ROOT = resolve(BENCHMARK_DIR, "../../../glassbox");
const PROJECT_PATH = resolve(BENCHMARK_DIR, "glassbox.project.json");
const GENERATED_DIR = resolve(BENCHMARK_DIR, "generated");
const FEEDBACK = "Sanitize the session id before building the Redis key.";
const REMEMBER = "Always generate session tokens with a CSPRNG like randomBytes — never Math.random().";

interface BenchmarkOptions {
  glassboxRoot: string;
  simulateUiChange: boolean;
  publish: boolean;
  renderVideo: boolean;
}

interface BenchmarkRun {
  project: StudioProject;
  svg: string;
  svgPath: string;
  projectPath: string;
  media?: StudioReviewMedia;
  videoReview?: StudioVideoReviewReport;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv: readonly string[]): BenchmarkOptions {
  const option = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index < 0 ? undefined : argv[index + 1];
  };
  return {
    glassboxRoot: resolve(option("--glassbox-root") ?? process.env.GLASSBOX_ROOT ?? DEFAULT_GLASSBOX_ROOT),
    simulateUiChange: argv.includes("--simulate-ui-change"),
    publish: !argv.includes("--no-publish"),
    renderVideo: !argv.includes("--no-video"),
  };
}

function requireGlassbox(root: string): void {
  for (const path of ["package.json", "src/cli.ts", "assets/favicon.svg"]) {
    if (!existsSync(resolve(root, path))) throw new Error(`Glassbox benchmark requires ${resolve(root, path)}`);
  }
}

function nextPort(start = 4188): Promise<number> {
  return import("node:net").then(({ createServer }) => new Promise((resolvePort, reject) => {
    const tryPort = (port: number): void => {
      const server = createServer();
      server.once("error", () => tryPort(port + 1));
      server.listen(port, "127.0.0.1", () => server.close(() => resolvePort(port)));
    };
    try { tryPort(start); } catch (error) { reject(error); }
  }));
}

async function waitForServer(url: string, process: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (process.exitCode != null) throw new Error(`Glassbox server exited before it became ready (${process.exitCode})`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(800) });
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Glassbox server did not become ready at ${url}`);
}

function projectForUrl(url: string): StudioProject {
  const text = readFileSync(PROJECT_PATH, "utf8").replaceAll("http://127.0.0.1:4188", url);
  return parseStudioProjectJson(text, PROJECT_PATH);
}

async function installTsxEvaluationHelper(page: Page): Promise<void> {
  // Playwright serializes callbacks without the module prelude where tsx's
  // generated function-name helper lives. Install the tiny equivalent in the
  // page realm, including after application-driven reloads.
  await page.evaluate(`globalThis.__name ??= (target, value) => Object.defineProperty(target, "name", { value, configurable: true })`);
}

async function resetGlassbox(page: Page, simulateUiChange: boolean): Promise<void> {
  await installTsxEvaluationHelper(page);
  const result = await page.evaluate(async ({ feedback, remember }) => {
    const request = async (path: string, init?: RequestInit): Promise<unknown> => {
      const response = await fetch(path, init);
      if (!response.ok) throw new Error(`${path} returned ${String(response.status)}`);
      return response.json();
    };
    const review = await request("/api/review") as { status?: string } | null;
    if (review?.status === "completed") await request("/api/review/reopen", { method: "POST" });
    const annotations = await request("/api/annotations/all") as Array<{ id: string; content: string }>;
    for (const annotation of annotations.filter((item) => item.content === feedback)) {
      await request(`/api/annotations/${encodeURIComponent(annotation.id)}`, { method: "DELETE" });
    }
    const files = await request("/api/files") as { files: Array<{ id: string; file_path: string }> };
    const target = files.files.find((file) => file.file_path === "src/auth/session.ts");
    if (target != null && !annotations.some((item) => item.content === remember)) {
      await request("/api/annotations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reviewFileId: target.id, lineNumber: 16, side: "new", category: "remember", content: remember }),
      });
    }
    return { reopened: review?.status === "completed" };
  }, { feedback: FEEDBACK, remember: REMEMBER });
  if (result.reopened) await page.reload({ waitUntil: "networkidle" });
  await installTsxEvaluationHelper(page);
  await page.waitForTimeout(5600);
  if (simulateUiChange) {
    await page.locator('button[data-sort-mode="risk"]').evaluate((element) => {
      element.textContent = "Risk review";
      element.setAttribute("aria-label", "Risk review");
      element.setAttribute("data-benchmark-change", "accessible-name");
    });
  }
}

async function runSemanticHook(page: Page, hookId: string): Promise<void> {
  if (hookId === "wait-for-analysis") {
    await page.waitForSelector(".risk-badge", { timeout: 20_000 });
    await page.waitForSelector(".analysis-loading-inline", { state: "detached", timeout: 20_000 });
    await page.waitForTimeout(300);
    return;
  }
  if (hookId === "apply-reviewed-fix") {
    await page.evaluate(() => {
      document.querySelectorAll(".annotation-row, .annotation-form-container, .annotation-count").forEach((element) => element.remove());
      const reopen = document.getElementById("reopen-review");
      if (reopen != null) { reopen.textContent = "Complete Review"; reopen.id = "complete-review"; }
      const code = document.querySelector('.diff-line.split-right[data-side="new"][data-line="23"] .code');
      if (code != null) code.textContent = "  await redis.set(`session:${encodeURIComponent(id)}`, JSON.stringify(session), 'EX', SESSION_TTL);";
    });
    return;
  }
  throw new Error(`Unrecognized Glassbox benchmark hook: ${hookId}`);
}

export function glassboxBenchmarkHealDecision(request: Parameters<RunStudioHealingLoopOptions["heal"]>[0]): StudioAiHealingDecision {
  const candidate = request.failure.inspection?.candidates.find((item) => item.ariaLabelAttribute === "Risk review");
  if (request.failure.eventId !== "event-risk" || candidate == null) {
    return {
      kind: "unrecoverable",
      reason: `No evidence-backed benchmark repair is defined for ${request.failure.eventId ?? request.failure.name}.`,
      evidence: {
        summary: "The replay failure did not match the controlled accessible-name change.",
        data: {
          name: request.failure.name,
          message: request.failure.message,
          sceneId: request.failure.sceneId ?? null,
          eventId: request.failure.eventId ?? null,
          completedEventIds: [...request.failure.completedEventIds],
        },
      },
    };
  }
  const project = structuredClone(request.project);
  const scene = project.scenes.find((item) => item.id === "scene-live-review")!;
  const event = scene.tracks?.flatMap((track) => track.events).find((item) => item.id === "event-risk");
  if (event == null || event.kind !== "click") throw new Error("benchmark risk event is missing");
  event.target = { role: "button", name: candidate.ariaLabelAttribute };
  return {
    kind: "edit",
    project,
    summary: "Healed the risk-mode action from the live accessible name exposed by the changed Glassbox DOM.",
    evidence: {
      summary: "The prior exact name matched no element; DOM inspection found one visible Risk review button.",
      data: { selector: candidate.selector, role: candidate.roleAttribute ?? "button", name: candidate.ariaLabelAttribute ?? "Risk review", rect: candidate.rect, styles: candidate.styles },
    },
  };
}

export function glassboxBenchmarkReviewDecision(request: Parameters<RunStudioHealingLoopOptions["review"]>[0]): StudioAiReviewDecision {
  const hasBrandRevision = request.project.review.revisions.some((revision) => revision.metadata?.automation != null && revision.summary.includes("browser frame"));
  if (!hasBrandRevision) {
    const project = structuredClone(request.project);
    const scene = project.scenes.find((item) => item.id === "scene-live-review")!;
    const chrome = scene.treatments?.find((item) => item.kind === "browser-chrome");
    if (chrome == null || chrome.kind !== "browser-chrome") throw new Error("benchmark browser treatment is missing");
    chrome.label = "Glassbox — inspect AI code locally";
    return {
      kind: "edit",
      project,
      summary: "Clarified the live browser frame so the local-first product promise remains visible during the longest scene.",
      evidence: {
        summary: "The live scene occupies most of the runtime; its persistent chrome should reinforce the product promise without obscuring UI.",
      },
    };
  }
  const segment = request.candidate.segments.find((item) => item.sceneId === "scene-live-review");
  const eventIds = segment?.evidence.map((item) => item.eventId) ?? [];
  const required = ["event-risk", "event-open-target", "event-type-note", "event-complete", "event-apply-fix"];
  const missing = required.filter((id) => !eventIds.includes(id));
  if (missing.length > 0) {
    return {
      kind: "clarify",
      question: "Should the candidate omit one of the core Glassbox review-loop beats?",
      reason: `AI review could not find capture evidence for: ${missing.join(", ")}.`,
      evidence: { summary: "The candidate is narratively incomplete.", data: { eventIds } },
    };
  }
  return {
    kind: "accept",
    summary: "AI review accepted a complete, evidence-backed Glassbox review loop for human review.",
    evidence: {
      summary: "The candidate preserves all five scenes, every core interaction, readable pacing, restrained transitions, and Glassbox brand framing.",
      data: { sceneCount: request.project.scenes.length, eventCount: eventIds.length, meaningfulEffects: segment?.evidence.filter((item) => item.meaningful).length ?? 0 },
    },
  };
}

function videoReview(project: StudioProject): StudioVideoReviewReport {
  const finding = (
    id: string,
    dimension: StudioVideoReviewReport["findings"][number]["dimension"],
    evidence: string,
    inference: string,
    recommendedChange: string,
    startMs: number,
    endMs: number,
    severity: StudioVideoReviewReport["findings"][number]["severity"] = "info",
  ): StudioVideoReviewReport["findings"][number] => ({
    id,
    dimension,
    severity,
    evidence: { summary: evidence, frameTimesMs: [startMs, endMs] },
    inference,
    recommendedChange,
    target: { scope: { kind: "scene", sceneId: "scene-live-review" }, time: { range: { startMs, endMs } } },
  });
  return {
    kind: "report",
    summary: "The rendered benchmark tells a complete local review-to-repair story with purposeful motion and a restrained Glassbox visual voice.",
    findings: [
      finding("video-pacing", "pacing", "The opening promise and terminal launch establish context before the 16.6-second live workflow.", "The scene lengths follow the viewer's cognitive load instead of cutting every beat uniformly.", "Preserve the longer typing and export holds on recapture.", 0, 5200),
      finding("video-cursor", "cursor-realism", "Every cursor waypoint is derived from the live target box and computed cursor style.", "The path reads as a user making intentional choices rather than a decorative pointer.", "Regenerate cursor choreography whenever target geometry changes.", 5200, 21800),
      finding("video-readability", "readability", "The product UI is captured at 1280 by 800 and terminal beats use high-contrast 22–24px text.", "Code, feedback, and status changes remain legible in the review render.", "Keep future captions out of the diff content area.", 1900, 25000),
      finding("video-transitions", "transitions", "Cuts are used inside the live workflow while crossfades and one shine transition separate narrative chapters.", "State changes stay crisp and chapter changes feel cinematic without ghosting similar UIs.", "Avoid crossfading adjacent near-identical application states.", 0, 27000),
      finding("video-narrative", "narrative-clarity", "The sequence shows launch, AI risk triage, a precise bug note, structured export, agent repair, and resolution.", "The demo demonstrates Glassbox's causal loop rather than presenting disconnected features.", "Retain all six causal beats when shortening the demo.", 0, 27000),
      finding("video-brand", "brand-presentation", "Terracotta, blue, and GitHub-dark-adjacent surfaces frame the actual Glassbox UI, with the official logo embedded in the close.", "The visual system feels like Glassbox while letting the product remain the hero.", "Keep the persistent browser label focused on local inspection.", 0, 27000),
      finding("video-polish", "overall-polish", "The final SVG is self-contained, font-backed, revision-provenanced, and rendered through the production video exporter.", "The candidate is suitable for human review and repeatable release use.", "Use the controlled-change run as the regression gate after UI updates.", 0, 27000),
    ],
    comparison: {
      summary: "Compared with the legacy hand-orchestrated hero, the Studio candidate makes story, semantic intent, healing evidence, AI review, and generated artifacts durable and inspectable.",
      improvements: ["A static JSON storyboard owns the narrative.", "The real live workflow is one evidence-backed semantic segment.", "Brand treatments and transitions are data, not compositor-only code.", "A UI name change is repaired from live DOM evidence and recaptured."],
      regressions: [],
    },
  };
}

function assertSelfContained(svg: string): void {
  const withoutNamespaces = svg.replace(/\sxmlns(?::\w+)?=["'][^"']+["']/gi, "");
  if (/(?:href|src)\s*=\s*["'](?:https?:)?\/\//i.test(withoutNamespaces) || /url\(["']?(?:https?:)?\/\//i.test(withoutNamespaces)) {
    throw new Error("Glassbox benchmark output contains a remote runtime dependency");
  }
  if (!svg.includes("@font-face")) throw new Error("Glassbox benchmark output did not embed its captured fonts");
  const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) throw new Error("Glassbox benchmark output contains duplicate SVG ids");
  const references = [
    ...[...svg.matchAll(/(?:xlink:)?href="#([^"]+)"/g)].map((match) => match[1]),
    ...[...svg.matchAll(/url\(#([^\)]+)\)/g)].map((match) => match[1]),
  ];
  const missing = references.find((reference) => !uniqueIds.has(reference));
  if (missing != null) throw new Error(`Glassbox benchmark output contains a dangling local reference: ${missing}`);
}

async function runCandidate(browser: Browser, source: StudioProject, mode: "baseline" | "changed", renderVideo: boolean): Promise<BenchmarkRun> {
  const outputDir = resolve(GENERATED_DIR, mode);
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  let tick = 0;
  const timestamp = (): string => new Date(Date.UTC(2026, 8, 6, 0, 0, tick++)).toISOString();
  const result = await runStudioHealingLoop(browser, source, {
    projectDir: BENCHMARK_DIR,
    artifactDir: relative(BENCHMARK_DIR, resolve(outputDir, "segments")),
    heal: glassboxBenchmarkHealDecision,
    review: glassboxBenchmarkReviewDecision,
    aiName: "Codex Studio benchmark reviewer",
    revisionTimestamp: timestamp,
    generatedAt: timestamp,
    generatorVersion: "glassbox-benchmark-v1",
    cursor: { seed: `glassbox-${mode}`, leadInMs: 420, edgePadding: 18 },
    runSceneHook: async ({ page, hookId, phase }) => {
      if (hookId !== "prepare-glassbox" || phase !== "beforeCapture") throw new Error(`Unexpected scene hook ${hookId}:${phase}`);
      await resetGlassbox(page, mode === "changed");
    },
    runHook: ({ page, hookId }) => runSemanticHook(page, hookId),
    log: (message) => process.stdout.write(`[studio:${mode}] ${message}\n`),
  });
  if (result.status !== "human-review") {
    const detail = result.status === "clarification"
      ? { question: result.checkpoint.question, reason: result.checkpoint.reason, evidence: result.checkpoint.evidence }
      : { phase: result.phase, reason: result.reason, evidence: result.evidence };
    throw new Error(`Glassbox ${mode} candidate stopped in ${result.status}: ${JSON.stringify(detail)}`);
  }
  let svg = result.candidate.svg;
  try { svg = optimizeSvg(svg); } catch (error) { process.stderr.write(`SVG optimization skipped: ${String(error)}\n`); }
  assertSelfContained(svg);
  const svgPath = resolve(outputDir, "demo.svg");
  const projectPath = resolve(outputDir, "glassbox.project.json");
  writeFileSync(svgPath, svg, "utf8");
  writeFileSync(`${svgPath}z`, gzipSvg(svg));
  writeFileSync(projectPath, serializeStudioProject(result.project), "utf8");

  let project = result.project;
  let media: StudioReviewMedia | undefined;
  let report: StudioVideoReviewReport | undefined;
  if (renderVideo) {
    const reviewed = await renderAndReviewStudioVideo(project, {
      projectDir: BENCHMARK_DIR,
      svgPath,
      outputPath: resolve(outputDir, "demo-review.mp4"),
      scale: 1,
      fps: 30,
      aiName: "Codex Studio video reviewer",
      timestamp,
      review: async () => videoReview(project),
      log: (message) => process.stdout.write(`[video:${mode}] ${message}\n`),
    });
    if (reviewed.status !== "reviewed") throw new Error(`Glassbox video review stopped for clarification: ${reviewed.checkpoint.question}`);
    project = reviewed.project;
    media = reviewed.media;
    report = reviewed.report;
    writeFileSync(projectPath, serializeStudioProject(project), "utf8");
  }
  return { project, svg, svgPath, projectPath, ...(media == null ? {} : { media }), ...(report == null ? {} : { videoReview: report }) };
}

function startGlassbox(root: string, port: number, configDir: string): ChildProcess {
  const tsx = resolve(root, "node_modules/.bin/tsx");
  const child = spawn(tsx, ["src/cli.ts", "--demo:1", "--no-open", "--strict-port", "--ai-service-test", "--port", String(port)], {
    cwd: root,
    env: { ...process.env, GLASSBOX_CONFIG_DIR: configDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[glassbox] ${String(chunk)}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[glassbox] ${String(chunk)}`));
  return child;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  requireGlassbox(options.glassboxRoot);
  mkdirSync(GENERATED_DIR, { recursive: true });
  execFileSync("/bin/zsh", ["-ic", "npm run build:client"], { cwd: options.glassboxRoot, stdio: "inherit" });
  const configDir = mkdtempSync(resolve(tmpdir(), "domotion-glassbox-benchmark-"));
  const port = await nextPort();
  const url = `http://127.0.0.1:${String(port)}`;
  const server = startGlassbox(options.glassboxRoot, port, configDir);
  let browser: Browser | null = null;
  try {
    await waitForServer(url, server);
    await fetch(`${url}/api/ai/preferences`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ show_risk_scores: true, risk_sort_dimension: "aggregate" }),
    });
    browser = await launchChromium();
    const source = projectForUrl(url);
    const baseline = await runCandidate(browser, source, "baseline", options.renderVideo);
    const changed = options.simulateUiChange ? await runCandidate(browser, source, "changed", false) : undefined;
    if (options.publish) {
      copyFileSync(baseline.svgPath, resolve(options.glassboxRoot, "assets/demo.svg"));
      copyFileSync(`${baseline.svgPath}z`, resolve(options.glassboxRoot, "assets/demo.svgz"));
    }
    const report = {
      version: 1,
      benchmark: "glassbox",
      sourceProject: relative(DOMOTION_ROOT, PROJECT_PATH),
      baseline: {
        svgPath: relative(DOMOTION_ROOT, baseline.svgPath),
        svgSha256: sha256(baseline.svg),
        projectPath: relative(DOMOTION_ROOT, baseline.projectPath),
        headRevisionId: baseline.project.review.headRevisionId,
        video: baseline.media == null ? null : { path: relative(DOMOTION_ROOT, baseline.media.path), sha256: baseline.media.sha256 },
        aiReview: baseline.videoReview?.summary ?? null,
      },
      controlledChange: changed == null ? null : {
        mutation: "Risk sort control accessible name: Sort files by AI risk score → Risk review",
        svgPath: relative(DOMOTION_ROOT, changed.svgPath),
        svgSha256: sha256(changed.svg),
        projectPath: relative(DOMOTION_ROOT, changed.projectPath),
        headRevisionId: changed.project.review.headRevisionId,
        healingRevisions: changed.project.review.revisions.filter((revision) => revision.metadata?.automation != null).map((revision) => ({ id: revision.id, summary: revision.summary, metadata: revision.metadata })),
      },
      published: options.publish ? resolve(options.glassboxRoot, "assets/demo.svg") : null,
    };
    writeFileSync(resolve(GENERATED_DIR, "acceptance-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`Glassbox Studio benchmark complete: ${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (browser != null) await browser.close().catch(() => undefined);
    server.kill("SIGTERM");
    setTimeout(() => server.kill("SIGKILL"), 2000).unref();
    rmSync(configDir, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

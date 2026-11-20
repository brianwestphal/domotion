import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import type { Browser, Page } from "@playwright/test";
import type { CapturedElement } from "./types.js";
import { isAutoFontLocale } from "./font-locale.js";

/**
 * Blink's default font locale — what `font-locale: auto` (`-webkit-locale`
 * auto, i.e. a null `FontDescription` locale) resolves to through
 * `FontDescription::LocaleOrDefault()` → `LayoutLocale::GetDefault()`
 * (`platform/text/layout_locale.cc:294-301`, empty → "en") →
 * `DefaultLanguage()` (`platform/language.cc`, `_` → `-`) →
 * `RendererBlinkPlatformImpl::DefaultLocale` → `RenderThreadImpl::GetLocale`,
 * which reads the renderer's own `--lang` switch
 * (`content/renderer/render_thread_impl.cc:711-720`, Chromium 7d859f27).
 *
 * The browser appends `--lang=<GetApplicationLocale()>` to every renderer
 * AFTER the switches it propagates (`render_process_host_impl.cc:3757-3765`),
 * and `base::CommandLine` keeps the LAST value of a repeated switch
 * (`base/command_line.cc:433-451`), so a renderer argv can carry two `--lang`
 * values and only the last one is Blink's. An in-process renderer patches the
 * browser's own command line instead (`:5160-5168`).
 *
 * Neither `navigator.language` (accept languages), `Intl` (ICU/V8, changed by
 * `Emulation.setLocaleOverride`) nor `Browser.getBrowserCommandLine` (the
 * browser process) is this value. The authority is the renderer argv of a
 * browser this process launched; anything else is reported unknown.
 *
 * Linux zygote-forked renderers retitle themselves (`setproctitle`) inside the
 * zygote's short argv area, so `/proc/<pid>/cmdline` holds one space-joined
 * string cut before the appended `--lang`. For such a renderer the value comes
 * from a utility child of the same browser: `UtilityProcessHost` appends
 * `--lang=<GetApplicationLocale()>` from the same `ContentBrowserClient` call
 * (`content/browser/service_host/utility_process_host.cc:385-386`, Chromium
 * 7d859f27), forwards no `--lang` from the browser, and the headless client
 * appends its accept-language `--lang` to renderers only
 * (`headless/lib/browser/headless_content_browser_client.cc:285-300`). The
 * headless `GetApplicationLocale()` is the process-wide ICU configured locale
 * (`:317-319`), set once at startup by `l10n_util::GetApplicationLocale`, which
 * on Linux reads the environment rather than `--lang`
 * (`ui/base/l10n/l10n_util.cc:508-577`).
 */
export type RendererDefaultLocale = { locale: string } | { reason: string };

/** Last `--lang=` value in an argv, canonicalized like `DefaultLanguage()`. */
export function lastLangSwitch(argv: readonly string[]): string | undefined {
  let value: string | undefined;
  for (const arg of argv) {
    // Chromium accepts `--` and `-` switch prefixes (and `/` on Windows); the
    // browser itself always writes `--lang=`.
    const m = /^(?:--|-|\/)lang=(.*)$/i.exec(arg);
    if (m) value = m[1];
  }
  if (value == null) return undefined;
  const canonical = value.replace(/_/g, "-");
  return canonical === "" ? "en" : canonical;
}

interface ProcessFacts {
  ppid: number;
  argv: string[];
  /** The process retitled itself, so `argv` was split from one space-joined
   * title that may be cut short (Linux zygote children). */
  retitled?: boolean;
}

/** A retitled argv's final token may itself be cut, so it is never read. */
function langSwitchOf(facts: ProcessFacts): string | undefined {
  return lastLangSwitch(facts.retitled === true ? facts.argv.slice(0, -1) : facts.argv);
}

const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(file, args, { timeout: 5000, windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    ),
  );

/** Read one process's parent pid and argv without a shell. */
export async function readProcessFacts(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): Promise<ProcessFacts> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid pid ${pid}`);
  if (platform === "linux") {
    const [cmdline, stat] = await Promise.all([
      readFile(`/proc/${pid}/cmdline`, "utf8"),
      readFile(`/proc/${pid}/stat`, "utf8"),
    ]);
    // Field 4 follows the parenthesized comm, which may itself contain spaces.
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    const argv = cmdline.split("\0").filter((a) => a !== "");
    // A child Chromium process always carries switches, so one element holding
    // whitespace is a `setproctitle` title, not a real argv.
    if (argv.length === 1 && /\s/.test(argv[0])) return { ppid, argv: argv[0].split(/\s+/), retitled: true };
    return { ppid, argv };
  }
  if (platform === "win32") {
    const out = await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { "$($p.ParentProcessId)"; $p.CommandLine }`,
    ]);
    const [ppid, ...rest] = out.split(/\r?\n/);
    // Switch tokens never contain whitespace; quoted paths do not affect them.
    return {
      ppid: Number(ppid),
      argv: rest
        .join(" ")
        .split(/\s+/)
        .filter((a) => a !== ""),
    };
  }
  const out = await run("ps", ["-ww", "-o", "ppid=,command=", "-p", String(pid)]);
  const m = /^\s*(\d+)\s+(.*)$/s.exec(out.trim());
  if (m == null) throw new Error(`process ${pid} is not running`);
  return { ppid: Number(m[1]), argv: m[2].split(/\s+/) };
}

/** Whether `pid` is `ancestor` or a descendant of it (zygote/helper chains are short). */
async function descendsFrom(
  pid: number,
  ancestor: number,
  facts: (pid: number) => Promise<ProcessFacts>,
): Promise<boolean> {
  let current = pid;
  for (let depth = 0; depth < 8; depth++) {
    if (current === ancestor) return true;
    if (current <= 1) return false;
    current = (await facts(current)).ppid;
  }
  return false;
}

export interface RendererLocaleDeps {
  /** The Node process that must own the browser (normally `process.pid`). */
  ownerPid: number;
  /** Browser and renderer pids as Chromium reports them (`SystemInfo.getProcessInfo`). */
  processes(): Promise<Array<{ type: string; id: number }>>;
  facts(pid: number): Promise<ProcessFacts>;
}

/** Pure decision over injected process facts (unit-testable on any host). */
export async function decideRendererDefaultLocale(deps: RendererLocaleDeps): Promise<RendererDefaultLocale> {
  const processes = await deps.processes();
  const browsers = processes.filter((p) => p.type === "browser");
  if (browsers.length !== 1) return { reason: "browser process identity is unavailable" };
  const browserPid = browsers[0].id;
  // A connected/remote browser is not in this process's tree; its renderer
  // argv cannot be authenticated, so it stays unknown.
  if (!(await descendsFrom(browserPid, deps.ownerPid, deps.facts)))
    return { reason: "browser was not launched by this process" };
  const renderers = processes.filter((p) => p.type === "renderer").map((p) => p.id);
  // An in-process renderer patches the browser's own command line.
  const pids = renderers.length > 0 ? renderers : [browserPid];
  const locales = new Set<string>();
  let retitled = false;
  for (const pid of pids) {
    if (!(await descendsFrom(pid, browserPid, deps.facts)))
      return { reason: "renderer process does not descend from the launched browser" };
    const facts = await deps.facts(pid);
    // A retitled renderer's visible --lang may be the headless accept-language
    // one that precedes the cut-off application locale, so none is read.
    if (facts.retitled === true && pid !== browserPid) {
      retitled = true;
      continue;
    }
    const locale = lastLangSwitch(facts.argv);
    if (locale == null) return { reason: "renderer command line carries no --lang switch" };
    locales.add(locale);
  }
  if (retitled) {
    const sibling = await utilityApplicationLocale(deps, processes, browserPid);
    if ("reason" in sibling) return sibling;
    locales.add(sibling.locale);
  }
  if (locales.size !== 1) return { reason: "renderers disagree on --lang" };
  return { locale: [...locales][0] };
}

/** The application locale every utility child of the browser was launched
 * with (`--type=utility`, one `--lang`); all of them must agree. */
async function utilityApplicationLocale(
  deps: RendererLocaleDeps,
  processes: Array<{ type: string; id: number }>,
  browserPid: number,
): Promise<RendererDefaultLocale> {
  const locales = new Set<string>();
  for (const { type, id } of processes) {
    if (type === "browser" || type === "renderer" || id === browserPid) continue;
    const facts = await deps.facts(id);
    if (!facts.argv.includes("--type=utility")) continue;
    if (!(await descendsFrom(id, browserPid, deps.facts))) continue;
    const locale = langSwitchOf(facts);
    if (locale != null) locales.add(locale);
  }
  if (locales.size === 0) return { reason: "renderer command line is truncated and no utility process carries --lang" };
  if (locales.size !== 1) return { reason: "utility processes disagree on --lang" };
  return { locale: [...locales][0] };
}

const cache = new WeakMap<Browser, Promise<RendererDefaultLocale>>();

/** `DOMOTION_RENDERER_DEFAULT_LOCALE=0` disables the authority (negative control). */
export function rendererDefaultLocaleEnabled(): boolean {
  return process.env.DOMOTION_RENDERER_DEFAULT_LOCALE !== "0";
}

/**
 * Resolve the renderer default locale for the browser that owns `page`.
 * Cached per browser: `GetApplicationLocale()` is fixed for a browser launch,
 * so every renderer it ever starts receives the same value. Only successes are
 * cached; a failure is re-evaluated on the next capture.
 */
export async function rendererDefaultLocaleForPage(page: Page): Promise<RendererDefaultLocale> {
  if (!rendererDefaultLocaleEnabled()) return { reason: "renderer default locale authority disabled" };
  const browser = page.context().browser();
  if (browser == null) return { reason: "page has no owning browser" };
  const cached = cache.get(browser);
  if (cached != null) return cached;
  const facts = new Map<number, Promise<ProcessFacts>>();
  const pending = decideRendererDefaultLocale({
    ownerPid: process.pid,
    async processes() {
      const session = await browser.newBrowserCDPSession();
      try {
        const info = (await session.send("SystemInfo.getProcessInfo")) as {
          processInfo: Array<{ type: string; id: number }>;
        };
        return info.processInfo;
      } finally {
        await session.detach().catch(() => undefined);
      }
    },
    facts(pid) {
      let entry = facts.get(pid);
      if (entry == null) facts.set(pid, (entry = readProcessFacts(pid)));
      return entry;
    },
  }).catch((cause: unknown): RendererDefaultLocale => ({
    reason: `renderer command line unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
  }));
  const result = await pending;
  if ("locale" in result) cache.set(browser, Promise.resolve(result));
  return result;
}

/** Record the default locale beside every computed `auto` font locale, on
 * elements and on pseudo-fragment typography. Explicit locales are untouched. */
export function annotateDefaultFontLocale(tree: CapturedElement[], locale: string): void {
  const visit = (el: CapturedElement): void => {
    if (isAutoFontLocale(el.styles.fontLocale)) el.styles.defaultFontLocale = locale;
    for (const pseudo of el.pseudoFragments ?? [])
      if (isAutoFontLocale(pseudo.typography.fontLocale)) pseudo.typography.defaultFontLocale = locale;
    for (const child of el.children) visit(child);
  };
  for (const root of tree) visit(root);
}

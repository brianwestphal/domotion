import { existsSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Browser } from "@playwright/test";

/**
 * The application locale a Linux Chromium derives from a POSIX locale such as
 * `ja_JP`, for tests that set `LANG` / `LC_ALL` / `LANGUAGE` to that value.
 *
 * On Linux `l10n_util::GetApplicationLocale` reads the environment and keeps
 * the first candidate `CheckAndResolveLocale` resolves to an existing
 * `locales/<name>.pak` (`ui/base/l10n/l10n_util.cc:405-489, 520-576`,
 * Chromium 7d859f27). The headless shell then reports ICU's configured locale
 * as the application locale (`headless_content_browser_client.cc:317-319`),
 * which that call set only when it resolved one. So the answer depends on the
 * build: Chrome for Testing (Linux x64) ships `locales/` and resolves `ja_JP`
 * to `ja`, while Playwright's own arm64 build ships none, resolves nothing and
 * leaves ICU on the environment's `ja-JP`.
 */
export async function linuxApplicationLocale(browser: Browser, posixLocale: string): Promise<string> {
  const canonical = posixLocale.replace(/_/g, "-");
  const session = await browser.newBrowserCDPSession();
  let pid: number;
  try {
    const info = (await session.send("SystemInfo.getProcessInfo")) as {
      processInfo: Array<{ type: string; id: number }>;
    };
    pid = info.processInfo.find((p) => p.type === "browser")!.id;
  } finally {
    await session.detach();
  }
  const locales = join(dirname(readlinkSync(`/proc/${pid}/exe`)), "locales");
  const has = (locale: string) => existsSync(join(locales, `${locale}.pak`));
  return checkAndResolveLocale(canonical, has) ?? canonical;
}

/** `CheckAndResolveLocale` (`l10n_util.cc:405-489`, Chromium 7d859f27). */
export function checkAndResolveLocale(locale: string, has: (locale: string) => boolean): string | undefined {
  if (has(locale)) return locale;
  if (locale.includes("@")) return undefined;
  const hyphen = locale.indexOf("-");
  const lang = hyphen < 0 ? locale : locale.slice(0, hyphen);
  const eq = (a: string, b: string) => a.toLowerCase() === b;
  if (hyphen >= 0) {
    const region = locale.slice(hyphen + 1);
    let tmp = lang;
    if (eq(lang, "es") && !eq(region, "es")) tmp += "-419";
    else if (eq(lang, "pt") && !eq(region, "br")) tmp += "-PT";
    else if (eq(lang, "zh")) tmp += eq(region, "hk") || eq(region, "mo") ? "-TW" : "-CN";
    else if (eq(lang, "en")) tmp += eq(region, "lr") || eq(region, "ph") ? "-US" : "-GB";
    if (has(tmp)) return tmp;
  }
  const aliases: Array<[string, string]> = [
    ["en", "en-US"],
    ["iw", "he"],
    ["no", "nb"],
    ["pt", "pt-BR"],
    ["tl", "fil"],
    ["zh", "zh-CN"],
  ];
  for (const [source, dest] of aliases) if (eq(lang, source) && has(dest)) return dest;
  return undefined;
}

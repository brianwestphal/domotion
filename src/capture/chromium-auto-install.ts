/**
 * Whether `launchChromium()` may download Playwright's Chromium when the binary is missing.
 *
 * A library caller gets no download unless it asks for one (`launchChromium({ autoInstall: true })`):
 * the install is a network download into the shared Playwright cache, which an embedding
 * application must be able to refuse. The published command-line tools turn the default on once
 * at startup (`runBin` in `src/cli/common.ts`), so a first CLI run on a cold machine still works.
 *
 * Kept in its own dependency-free module so the CLI bootstrap can flip it without importing the
 * capture pipeline.
 */
let autoInstallDefault = false;

/** Set the process-wide default used when a `launchChromium` call does not pass `autoInstall`. */
export function setChromiumAutoInstallDefault(enabled: boolean): void {
  autoInstallDefault = enabled;
}

/** The process-wide default for `launchChromium`'s `autoInstall` (false unless a CLI enabled it). */
export function chromiumAutoInstallDefault(): boolean {
  return autoInstallDefault;
}

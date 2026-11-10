/** Chromium SystemClipboard::WritePlainText normalizes CR/LF only on Windows. */
export function expectedNativeClipboardText(text: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? text.replace(/\r\n|\r|\n/g, "\r\n") : text;
}

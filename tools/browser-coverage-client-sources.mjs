import { resolve } from "node:path";

const CLIENT_SOURCES = ["src/review/client.tsx", "src/scrubber/client.tsx", "src/studio/client.tsx"];

export function requiredBrowserClientSources(root) {
  return CLIENT_SOURCES.map((source) => resolve(root, source));
}

export function missingBrowserClientSources(files, root) {
  const present = new Set(files.map((file) => resolve(file)));
  return requiredBrowserClientSources(root).filter((source) => !present.has(source));
}

export const BRITISH_SPELLINGS =
  /\b(?:colou(?:r|rs|red|ring)|behaviou(?:r|rs|ral)|rasteris(?:e|ed|es|ing)|synthesis(?:e|ed|es|ing)|synthes(?:ise|ised|ises|ising)|centr(?:e|es|ed|ing)|honou(?:r|rs|red|ring)|optimis(?:e|ed|es|ing)|defences?|labelled|labelling|neighbou(?:r|rs|red|ring)|normalis(?:e|ed|es|ing)|serialis(?:e|ed|es|ing)|analys(?:e|ed|es|ing)|organis(?:e|ed|es|ing|ation|ations)|grey)\b/giu;

const EXCLUDED_PATHS = [
  /^(?:AGENTS|CLAUDE)\.md$/,
  /^\.claude\/skills\//,
  /^\.pr-notes\//,
  /^scripts\/american-english\.mjs$/,
  /^tests\/american-english\.test\.ts$/,
  /^(?:external|vendor|node_modules|dist)\//,
  /(?:^|\/)package-lock\.json$/,
  /(?:^|\/)[^/]*\.lock$/,
  /\.generated\./,
  /^docs\/(?:index\.json|generated-index\.md|archive\/index\.md|ai\/(?:manifest\.json|packets\/))/,
];

export function isAmericanEnglishCheckPath(path) {
  return !EXCLUDED_PATHS.some((pattern) => pattern.test(path));
}

function isKnownLiteral(path, line, spelling) {
  const word = spelling.toLowerCase();
  if (path === "site/scripts/generate-fidelity-proof.mjs" && word === "colours") return true;
  if (
    (path === "src/render/colors.ts" ||
      path === "src/render/colors.test.ts" ||
      path === "src/capture/script/utils.ts") &&
    word === "grey"
  )
    return true;
  return (
    path === "docs/reference/raster-image-fallback-cases.md" &&
    word === "rasterise" &&
    line.includes("\"rasterise the target element's paint")
  );
}

export function americanEnglishFindings(path, contents) {
  if (!isAmericanEnglishCheckPath(path) || contents.includes("\0")) return [];
  const findings = [];
  for (const [index, line] of contents.split(/\r?\n/u).entries()) {
    for (const match of line.matchAll(BRITISH_SPELLINGS)) {
      if (!isKnownLiteral(path, line, match[0])) {
        findings.push({ path, line: index + 1, column: (match.index ?? 0) + 1, spelling: match[0] });
      }
    }
  }
  return findings;
}

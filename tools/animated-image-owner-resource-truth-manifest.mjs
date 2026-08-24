#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const PINNED_CHROMIUM_REVISION =
  "7d859f271cbda744098ac69f44978d4edfa62be3";
const ZERO_SHA256 = "0".repeat(64);

export const ANIMATED_IMAGE_TRUTH_PATCH_FILES = Object.freeze([
  "third_party/blink/public/devtools_protocol/BUILD.gn",
  "third_party/blink/public/devtools_protocol/browser_protocol.pdl",
  "third_party/blink/public/devtools_protocol/domains/DomotionAnimatedImageTruth.pdl",
  "third_party/blink/renderer/core/css/css_image_set_value.cc",
  "third_party/blink/renderer/core/css/css_image_set_value.h",
  "third_party/blink/renderer/core/css/resolver/element_style_resources.cc",
  "third_party/blink/renderer/core/exported/web_dev_tools_agent_impl.cc",
  "third_party/blink/renderer/core/inspector/BUILD.gn",
  "third_party/blink/renderer/core/inspector/build.gni",
  "third_party/blink/renderer/core/inspector/devtools_session.h",
  "third_party/blink/renderer/core/inspector/inspector_domotion_animated_image_truth_agent.cc",
  "third_party/blink/renderer/core/inspector/inspector_domotion_animated_image_truth_agent.h",
  "third_party/blink/renderer/core/inspector/inspector_network_agent.cc",
  "third_party/blink/renderer/core/inspector/inspector_network_agent.h",
  "third_party/blink/renderer/core/inspector/inspector_protocol_config.json",
  "third_party/blink/renderer/core/inspector/network_resources_data.h",
  "third_party/blink/renderer/core/loader/resource/image_resource.cc",
  "third_party/blink/renderer/core/loader/resource/image_resource.h",
  "third_party/blink/renderer/core/loader/resource/image_resource_content.cc",
  "third_party/blink/renderer/core/loader/resource/image_resource_content.h",
  "third_party/blink/renderer/core/loader/resource/image_resource_info.h",
  "third_party/blink/renderer/core/style/style_image_set.cc",
  "third_party/blink/renderer/core/style/style_image_set.h",
  "third_party/blink/renderer/platform/loader/fetch/resource.cc",
  "third_party/blink/renderer/platform/loader/fetch/resource.h",
  "third_party/blink/renderer/platform/loader/fetch/resource_fetcher.cc",
].sort());

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right)).map(([key, entry]) =>
      `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedPatchSource(path, bytes) {
  if (!path.endsWith("inspector_domotion_animated_image_truth_agent.cc")) {
    return bytes;
  }
  const source = bytes.toString("utf8");
  const normalized = source.replace(
    /(constexpr char kPatchSha256\[\] =\s*\n\s*")[0-9a-f]{64}(";)/,
    `$1${ZERO_SHA256}$2`,
  );
  if (normalized === source && !source.includes(ZERO_SHA256)) {
    throw new Error("private helper patch SHA field is missing or malformed");
  }
  return Buffer.from(normalized);
}

function gitRevision(root) {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

export async function buildAnimatedImageTruthSourceManifest({
  chromiumRoot,
  depotToolsRoot,
}) {
  const sourceRevision = gitRevision(chromiumRoot);
  if (sourceRevision !== PINNED_CHROMIUM_REVISION) {
    throw new Error(
      `Chromium revision mismatch: ${sourceRevision} != ${PINNED_CHROMIUM_REVISION}`,
    );
  }
  const skiaRevision = gitRevision(resolve(chromiumRoot, "third_party/skia"));
  const depotToolsRevision = gitRevision(depotToolsRoot);
  const files = [];
  const normalizedFiles = [];
  for (const path of ANIMATED_IMAGE_TRUTH_PATCH_FILES) {
    const bytes = await readFile(resolve(chromiumRoot, path));
    const normalizedBytes = normalizedPatchSource(path, bytes);
    files.push({
      path,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    });
    normalizedFiles.push({
      path,
      byteLength: normalizedBytes.byteLength,
      sha256: sha256(normalizedBytes),
    });
  }
  const patchSha256 = sha256(canonicalJson(normalizedFiles));
  const authority = {
    schemaVersion: 1,
    ticket: "DM-2583",
    sourceRevision,
    skiaRevision,
    depotToolsRevision,
    patchSha256,
    files,
  };
  return {
    ...authority,
    sourceManifestSha256: sha256(canonicalJson(authority)),
  };
}

async function main() {
  const values = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index];
    const value = process.argv[index + 1];
    if (!["--chromium-root", "--depot-tools-root", "--out"].includes(flag) ||
        value == null) {
      throw new Error(`unknown or valueless argument: ${flag}`);
    }
    values[flag.slice(2)] = value;
  }
  if (!values["chromium-root"] || !values["depot-tools-root"]) {
    throw new Error("--chromium-root and --depot-tools-root are required");
  }
  const manifest = await buildAnimatedImageTruthSourceManifest({
    chromiumRoot: resolve(values["chromium-root"]),
    depotToolsRoot: resolve(values["depot-tools-root"]),
  });
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (values.out) {
    const output = resolve(values.out);
    await writeFile(output, serialized, { flag: "wx" });
    const outputStat = await stat(output);
    process.stderr.write(`wrote ${basename(output)} (${outputStat.size} bytes)\n`);
  } else {
    process.stdout.write(serialized);
  }
}

if (process.argv[1] &&
    resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import istanbulCoverage from "istanbul-lib-coverage";
import v8toIstanbul from "v8-to-istanbul";
import { missingBrowserClientSources, requiredBrowserClientSources } from "./browser-coverage-client-sources.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
import { isMain, parseCommand, runMain } from "./lib/cli.mjs";

async function main(argv) {
  const { values, positionals } = parseCommand(argv, { "require-client-sources": { type: "boolean" } });
  if (positionals.length > 2) throw new Error("expected at most two coverage paths");
  try {
    const input = resolve(positionals[0] ?? "coverage/.all-parts/browser-v8");
    const output = resolve(positionals[1] ?? "coverage/.all-parts/browser/coverage-final.json");
    const requireClientSources = values["require-client-sources"];
    const map = istanbulCoverage.createCoverageMap({});

    if (existsSync(input)) {
      for (const file of readdirSync(input)
        .filter((name) => name.endsWith(".json"))
        .sort()) {
        const entries = JSON.parse(readFileSync(resolve(input, file), "utf8"));
        for (const entry of entries) {
          const converter = v8toIstanbul(entry.url || `browser://${file}`, 0, { source: entry.source });
          await converter.load();
          converter.applyCoverage(entry.functions);
          const converted = converter.toIstanbul();
          const normalized = {};
          for (const [sourcePath, coverage] of Object.entries(converted)) {
            const marker = sourcePath.lastIndexOf("/src/");
            const canonical = marker >= 0 ? resolve(ROOT, sourcePath.slice(marker + 1)) : sourcePath;
            normalized[canonical] = { ...coverage, path: canonical };
          }
          map.merge(normalized);
        }
      }
    }

    if (requireClientSources) {
      const missing = missingBrowserClientSources(map.files(), ROOT);
      if (missing.length > 0) {
        throw new Error(`browser coverage is missing required client sources:\n${missing.join("\n")}`);
      }
      process.stdout.write(
        `[browser-coverage] mapped required clients:\n${requiredBrowserClientSources(ROOT).join("\n")}\n`,
      );
    }

    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(map.toJSON())}\n`);
    process.stdout.write(`[browser-coverage] wrote ${output} (${map.files().length} source files)\n`);
    return 0;
  } catch (error) {
    console.error(error);
    return 1;
  }
}

if (isMain(import.meta.url)) await runMain(() => main(process.argv.slice(2)));

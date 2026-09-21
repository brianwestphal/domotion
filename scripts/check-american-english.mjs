#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { americanEnglishFindings } from "./american-english.mjs";

const listed = spawnSync("git", ["ls-files", "-z"], { encoding: "utf8" });
if (listed.error != null) throw listed.error;
if (listed.status !== 0) process.exit(listed.status ?? 1);

const findings = [];
for (const path of listed.stdout.split("\0").filter(Boolean)) {
  try {
    findings.push(...americanEnglishFindings(path, readFileSync(path, "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

if (findings.length > 0) {
  for (const finding of findings) {
    process.stderr.write(
      `${finding.path}:${finding.line}:${finding.column}: British spelling ${JSON.stringify(finding.spelling)}\n`,
    );
  }
  process.exitCode = 1;
} else {
  process.stdout.write("American-English prose check passed\n");
}

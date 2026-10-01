---
id: "requirements/tool-command-boundary"
title: "Tool command boundary"
kind: "contract"
status: "current"
owners: ["tools"]
platforms: ["macos", "linux", "windows"]
tickets: ["DM-AP6BPA", "DM-M9KT76"]
code: ["tools/lib/cli.mjs", "tools/lib/cli.ts"]
aliases: ["docs/266-tool-command-boundary.md", "doc-266"]
---

# Tool command boundary

Executable scripts under `tools/` validate their command line before opening a browser, reading evidence, or writing output. `tools/lib/cli.mjs` is the plain Node entry point; `tools/lib/cli.ts` re-exports it for TypeScript tools. `parseFlags` accepts only declared options. `parseCommand` also returns positional operands, while still rejecting unknown options and options missing a value. Each command validates its own required operands and domain values.

Importing a tool module must not run its command. A top-level `isMain(import.meta.url)` check calls `runMain` only when the file is executed directly. This lets tests and other tools import command logic without launching browsers, changing files, or setting process exit state. A command may expose a `main(argv)` function so tests can check parsing and work independently.

Command exit codes are 0 for agreement or successful report generation, 1 for a measured mismatch or a command's documented rejection, and 2 for malformed arguments or an unexpected command error. `runMain` preserves an exit code explicitly set by a void-returning gate and uses a returned numeric code when provided. Migrations preserve each command's existing output and report shape; the shared boundary only governs parsing and execution ownership.

#!/usr/bin/env node

import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { startStudioServer } from "../studio/server.js";
import { openInBrowser, parsePort } from "./common.js";

const HELP = `domotion-studio — local visual workspace for Domotion Studio projects

Usage:
  domotion-studio [project.json] [options]
  domotion studio [project.json] [options]

Options:
      --workspace <dir>  Root directory the Studio file browser may access.
                         Defaults to the project directory, or the current dir.
      --port <n>         Local port (default: an OS-assigned free port).
      --no-open          Print the URL without opening a browser.
  -h, --help             Show this help.
`;

export async function runStudio(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      workspace: { type: "string" },
      port: { type: "string" },
      "no-open": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (positionals.length > 1) throw new Error("domotion-studio accepts at most one project path");

  const suppliedProject = positionals[0] == null ? null : resolve(positionals[0]);
  const workspaceRoot = resolve(values.workspace ?? (suppliedProject == null ? process.cwd() : dirname(suppliedProject)));
  const initialProjectPath = suppliedProject == null ? undefined : basename(suppliedProject);
  const server = await startStudioServer({
    port: parsePort(values.port),
    workspaceRoot,
    initialProjectPath,
    log: (message) => process.stderr.write(`${message}\n`),
  });

  process.stdout.write(`\n  Domotion Studio running at ${server.url}\n  Workspace: ${server.workspaceRoot}\n  Press Ctrl-C to stop.\n\n`);
  if (!values["no-open"]) await openInBrowser(server.url);

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    process.stderr.write("\nshutting down…\n");
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
}

const invokedPath = process.argv[1];
if (invokedPath != null && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  runStudio(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`domotion-studio: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

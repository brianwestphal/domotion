#!/usr/bin/env node

import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { startStudioServer } from "../studio/server.js";
import { installShutdownHandlers, openInBrowser, parsePort, runBin, UsageError } from "./common.js";

export const STUDIO_HELP = `domotion-studio — local visual workspace for Domotion Studio projects

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

export function parseStudioArgs(args: string[]) {
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
  if (values.help) return { help: true as const };
  if (positionals.length > 1) throw new UsageError("domotion-studio accepts at most one project path");

  const suppliedProject = positionals[0] == null ? null : resolve(positionals[0]);
  const workspaceRoot = resolve(
    values.workspace ?? (suppliedProject == null ? process.cwd() : dirname(suppliedProject)),
  );
  const initialProjectPath = suppliedProject == null ? undefined : basename(suppliedProject);
  return {
    help: false as const,
    workspaceRoot,
    initialProjectPath,
    port: parsePort(values.port),
    open: !values["no-open"],
  };
}

export async function runStudio(args: string[]): Promise<void> {
  await executeStudio(parseStudioArgs(args));
}

export async function executeStudio(parsed: ReturnType<typeof parseStudioArgs>): Promise<void> {
  if (parsed.help) {
    process.stdout.write(STUDIO_HELP);
    return;
  }
  const server = await startStudioServer({
    port: parsed.port,
    workspaceRoot: parsed.workspaceRoot,
    initialProjectPath: parsed.initialProjectPath,
    log: (message) => process.stderr.write(`${message}\n`),
  });

  process.stdout.write(
    `\n  Domotion Studio running at ${server.url}\n  Workspace: ${server.workspaceRoot}\n  Press Ctrl-C to stop.\n\n`,
  );
  if (parsed.open) await openInBrowser(server.url);

  installShutdownHandlers(() => server.close(), { message: "\nshutting down…\n" });
}

const invokedPath = process.argv[1];
if (invokedPath != null && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  void runBin({
    name: "domotion-studio",
    help: STUDIO_HELP,
    helpOnEmpty: false,
    parse: parseStudioArgs,
    run: executeStudio,
  });
}

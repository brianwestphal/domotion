import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";

const KNOWN_CONTEXTS = new Set([
  "env",
  "github",
  "inputs",
  "job",
  "jobs",
  "matrix",
  "needs",
  "runner",
  "secrets",
  "steps",
  "strategy",
  "vars",
]);

// These fields are evaluated while GitHub expands/routes a job, before a runner
// exists. Keep the sets aligned with the official context-availability table:
// https://docs.github.com/actions/reference/workflows-and-actions/contexts#context-availability
const JOB_FIELD_CONTEXTS = new Map([
  ["concurrency", new Set(["github", "inputs", "matrix", "needs", "strategy", "vars"])],
  ["continue-on-error", new Set(["github", "inputs", "matrix", "needs", "strategy", "vars"])],
  ["defaults", new Set(["env", "github", "inputs", "matrix", "needs", "strategy", "vars"])],
  ["env", new Set(["github", "inputs", "matrix", "needs", "secrets", "strategy", "vars"])],
  ["if", new Set(["github", "inputs", "needs", "vars"])],
  ["name", new Set(["github", "inputs", "matrix", "needs", "strategy", "vars"])],
  ["runs-on", new Set(["github", "inputs", "matrix", "needs", "strategy", "vars"])],
  ["secrets", new Set(["github", "inputs", "matrix", "needs", "secrets", "strategy", "vars"])],
  ["strategy", new Set(["github", "inputs", "needs", "vars"])],
  ["timeout-minutes", new Set(["github", "inputs", "matrix", "needs", "strategy", "vars"])],
  ["with", new Set(["github", "inputs", "matrix", "needs", "strategy", "vars"])],
]);

function withoutStringLiterals(expression) {
  let quote = null;
  let result = "";
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (quote === null) {
      if (character === "'" || character === '"') {
        quote = character;
        result += " ";
      } else {
        result += character;
      }
      continue;
    }

    if (character === quote) {
      if (quote === "'" && expression[index + 1] === "'") {
        result += "  ";
        index += 1;
      } else {
        quote = null;
        result += " ";
      }
    } else {
      result += " ";
    }
  }
  return result;
}

function expressionContexts(value) {
  const contexts = [];
  for (const expression of value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    const code = withoutStringLiterals(expression[1]);
    for (const reference of code.matchAll(/\b([A-Za-z_][A-Za-z0-9_-]*)\s*(?=\.|\[)/g)) {
      if (KNOWN_CONTEXTS.has(reference[1])) contexts.push(reference[1]);
    }
  }
  return contexts;
}

function nodeLine(node, lineCounter) {
  const offset = node?.range?.[0];
  return typeof offset === "number" ? lineCounter.linePos(offset).line : 1;
}

function stringScalars(node) {
  if (isScalar(node)) return typeof node.value === "string" ? [node] : [];
  if (isSeq(node)) return node.items.flatMap((item) => stringScalars(item));
  if (isMap(node)) return node.items.flatMap((pair) => stringScalars(pair.value));
  return [];
}

export function lintWorkflowSource(source, file = "<workflow>") {
  const lineCounter = new LineCounter();
  const document = parseDocument(source, {
    lineCounter,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  const problems = document.errors.map((error) => ({
    file,
    line: lineCounter.linePos(error.pos[0]).line,
    message: `invalid workflow YAML: ${error.message}`,
  }));

  const jobs = document.get("jobs", true);
  if (!isMap(jobs)) return problems;

  for (const jobPair of jobs.items) {
    const job = jobPair.value;
    if (!isMap(job)) continue;
    const jobId = isScalar(jobPair.key) ? String(jobPair.key.value) : "<job>";
    for (const fieldPair of job.items) {
      const field = isScalar(fieldPair.key) ? String(fieldPair.key.value) : "";
      const allowedContexts = JOB_FIELD_CONTEXTS.get(field);
      if (allowedContexts === undefined) continue;
      for (const scalar of stringScalars(fieldPair.value)) {
        const invalidContexts = [...new Set(expressionContexts(scalar.value))]
          .filter((context) => !allowedContexts.has(context));
        for (const context of invalidContexts) {
          problems.push({
            file,
            line: nodeLine(scalar, lineCounter),
            message: `jobs.${jobId}.${field} cannot use the '${context}' context; allowed contexts: ${[...allowedContexts].join(", ")}`,
          });
        }
      }
    }
  }

  return problems;
}

export function lintWorkflowDirectory(directory) {
  const files = readdirSync(directory)
    .filter((file) => /\.ya?ml$/i.test(file))
    .sort();
  const problems = files.flatMap((file) => {
    const path = resolve(directory, file);
    return lintWorkflowSource(readFileSync(path, "utf8"), relative(process.cwd(), path));
  });
  return { files, problems };
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === modulePath) {
  const workflowDirectory = resolve(dirname(modulePath), "../.github/workflows");
  const { files, problems } = lintWorkflowDirectory(workflowDirectory);
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`${problem.file}:${problem.line}: ${problem.message}`);
    }
    process.exitCode = 1;
  } else {
    console.log(`GitHub workflow context check passed (${files.length} workflows)`);
  }
}

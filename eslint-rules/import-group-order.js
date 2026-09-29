/**
 * `domotion/import-group-order` — a file's leading import block lists Node built-ins first, then
 * packages, then local (relative) modules.
 *
 * Deliberately GROUP order only, not alphabetical: this repo has documented import cycles whose behavior
 * depends on the relative evaluation order of LOCAL modules (see the root-barrel TDZ note in
 * `src/cli/animate-command.ts`), and an alphabetizing autofix would silently reorder them. Here the fix
 * is a stable partition — imports keep their relative order inside each group — and moving built-ins and
 * packages ahead of local modules cannot change local evaluation order (neither depends on local code).
 *
 * Only the contiguous run of imports at the top of the file is checked; an import that appears after
 * other statements is left alone. Comments directly above an import travel with it; the header comment
 * above the first import stays put.
 */
const BUILTINS = new Set(
  (
    "assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel dns domain " +
    "events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl " +
    "stream string_decoder sys timers tls trace_events tty url util v8 vm wasi worker_threads zlib"
  ).split(" "),
);

function groupOf(specifier) {
  if (specifier.startsWith("node:") || BUILTINS.has(specifier.split("/")[0])) return 0;
  if (specifier.startsWith(".") || specifier.startsWith("/")) return 2;
  return 1;
}

const GROUP_NAMES = ["Node built-in", "package", "local"];

export default {
  meta: {
    type: "layout",
    fixable: "code",
    docs: { description: "Order the leading imports: Node built-ins, then packages, then local modules." },
    messages: {
      order:
        "{{later}} import '{{specifier}}' comes after a {{earlier}} import; list built-ins, then packages, then local modules.",
    },
    schema: [],
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      Program(program) {
        const run = [];
        for (const node of program.body) {
          if (node.type !== "ImportDeclaration") break;
          run.push(node);
        }
        if (run.length < 2) return;
        const groups = run.map((n) => groupOf(String(n.source.value)));
        let highest = groups[0];
        let firstBad = -1;
        for (let i = 1; i < run.length; i++) {
          if (groups[i] < highest) {
            firstBad = i;
            break;
          }
          highest = Math.max(highest, groups[i]);
        }
        if (firstBad < 0) return;

        const unitFor = (node, index) => {
          const leading = index === 0 ? [] : sourceCode.getCommentsBefore(node);
          const trailing = sourceCode.getCommentsAfter(node).filter((c) => c.loc.start.line === node.loc.end.line);
          const start = leading.length > 0 ? leading[0].range[0] : node.range[0];
          const end = trailing.length > 0 ? trailing[trailing.length - 1].range[1] : node.range[1];
          return { text: sourceCode.text.slice(start, end), end };
        };
        const units = run.map(unitFor);
        const order = run.map((_, i) => i).sort((a, b) => groups[a] - groups[b] || a - b);
        const replacement = order.map((i) => units[i].text).join("\n");
        const rangeStart = run[0].range[0];
        const rangeEnd = units[units.length - 1].end;
        const bad = run[firstBad];
        context.report({
          node: bad,
          messageId: "order",
          data: {
            later: GROUP_NAMES[groups[firstBad]],
            specifier: String(bad.source.value),
            earlier: GROUP_NAMES[highest],
          },
          fix: (fixer) => fixer.replaceTextRange([rangeStart, rangeEnd], replacement),
        });
      },
    };
  },
};

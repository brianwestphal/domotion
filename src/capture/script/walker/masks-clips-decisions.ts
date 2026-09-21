// @ts-nocheck
//
// Pure decisions shared by the live masks/clips walker. This module remains
// dependency-free so build-capture-script can inline it into CAPTURE_SCRIPT
// while unit tests exercise the parsing and graph rules without a browser.

export const scopedFragmentKey = (scope, id) => String(scope) + "\u0000" + id;

export const svgUnit = (animatedEnumeration, attr) => {
  const current = animatedEnumeration && animatedEnumeration.baseVal;
  if (current === 2 || String(attr || "").toLowerCase() === "objectboundingbox") return "objectBoundingBox";
  return "userSpaceOnUse";
};

export const svgLengthString = (animatedLength, fallback) => {
  const value = animatedLength && animatedLength.baseVal && animatedLength.baseVal.valueAsString;
  return typeof value === "string" && value !== "" ? value : fallback;
};

export const svgLengthValue = (animatedLength) => {
  const value = animatedLength && animatedLength.baseVal && animatedLength.baseVal.value;
  return Number.isFinite(value) ? value : 0;
};

export const splitCssLayers = (value) => {
  const layers = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      layers.push(value.slice(start, i));
      start = i + 1;
    }
  }
  layers.push(value.slice(start));
  return layers;
};

export const decodeFragmentId = (value) => {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return value;
  }
};

export const classifyFragmentReference = (rawValue, baseUrl, documentUrl) => {
  const raw = String(rawValue || "").trim();
  if (raw === "") return { status: "external", target: raw };
  if (raw.charAt(0) === "#") {
    return { status: "local", target: decodeFragmentId(raw.slice(1)) };
  }
  // Self-contained data paint remains self-contained and is not a graph
  // edge. Blob/network references are deliberately not copied: their
  // lifetime and response are outside the frozen capture.
  if (/^data:/i.test(raw) && raw.indexOf("#") < 0) return { status: "safe" };
  try {
    const parsed = new URL(raw, baseUrl);
    if (parsed.hash !== "") {
      const withoutHash = parsed.href.slice(0, parsed.href.length - parsed.hash.length);
      if (withoutHash === documentUrl) {
        return { status: "local", target: decodeFragmentId(parsed.hash.slice(1)) };
      }
    }
  } catch (e) {
    /* rejected below as an external/stale occurrence */
  }
  return { status: "external", target: raw };
};

export const replaceCssUrls = (value, replace) => {
  return String(value || "").replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi, (full, dq, sq, bare) => {
    const raw = dq != null ? dq : sq != null ? sq : String(bare || "").trim();
    const replacement = replace(raw);
    return replacement == null ? full : "url(#" + replacement + ")";
  });
};

export const fragmentCycles = (root, nodeCount, edges) => {
  const outgoing = Array.from({ length: nodeCount }, () => []);
  for (const edge of edges) {
    if (edge.status === "resolved" && edge.to != null && !outgoing[edge.from].includes(edge.to)) {
      outgoing[edge.from].push(edge.to);
    }
  }
  const state = Array.from({ length: nodeCount }, () => 0);
  const stack = [];
  const cycles = [];
  const visit = (index) => {
    state[index] = 1;
    stack.push(index);
    for (const next of outgoing[index]) {
      if (state[next] === 0) visit(next);
      else if (state[next] === 1) {
        const start = stack.lastIndexOf(next);
        cycles.push(stack.slice(start).concat(next));
      }
    }
    stack.pop();
    state[index] = 2;
  };
  visit(root);
  return cycles;
};

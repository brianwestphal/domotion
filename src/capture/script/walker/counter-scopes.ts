//
// CSS counter scope pre-walk, extracted from the capture script's orchestrator
// (`captureDocumentTree`). Part of the page-`evaluate`d CAPTURE_SCRIPT bundle —
// self-contained, page globals only.
//
// CSS counters pre-walk (DM-357). Walk the document in DOM order,
// applying counter-reset / counter-set / counter-increment per the
// computed style of each element, and snapshot the active counter
// scope chain at every element. The pseudo emit loop later substitutes
// counter(name) / counters(name, sep) tokens against this snapshot.
// Without this, content like 'counter(section) "."' was emitted
// verbatim — so headings rendered as just '.' instead of '1.', '2.',
// '99.', etc. Counter scoping rules (CSS Lists & Counters Level 3):
// counter-reset on element X creates a counter scoped to X plus all
// descendants; counter() resolves to the innermost ancestor's value;
// counters() joins all values along the ancestor chain (outermost first).

interface CounterEntry {
  name: string;
  value: number;
  owner: Element;
  scopeParent: Element | null;
}
interface CounterValue {
  name: string;
  value: number;
}
interface CounterSnapshots {
  element: CounterValue[];
  "::before": CounterValue[];
  "::after": CounterValue[] | null;
}

export const createCounterScopes = () => {
  const _counterSnapshot = new WeakMap<Element, CounterSnapshots>();
  function _parseCounterDecl(declStr: string, defaultValue: number): CounterValue[] {
    if (!declStr || declStr === "none") return [];
    // Format: "name1 [num] name2 [num] ..."
    const tokens = declStr.split(/\s+/);
    const out = [];
    let i = 0;
    while (i < tokens.length) {
      const name = tokens[i++];
      if (!name) continue;
      let value = defaultValue;
      if (i < tokens.length && /^-?\d+$/.test(tokens[i])) {
        value = parseInt(tokens[i++], 10);
      }
      out.push({ name, value });
    }
    return out;
  }
  // Blink keeps one stack per counter name. A counter introduced on an
  // element remains visible to later siblings because its originating
  // element's parent is still an ancestor of those siblings.
  const _counterStacks = new Map<string, CounterEntry[]>();
  const _isAncestorOrSelf = (ancestor: Element, node: Element) => ancestor === node || ancestor.contains(node);
  function _stack(name: string): CounterEntry[] {
    let stack = _counterStacks.get(name);
    if (stack == null) {
      stack = [];
      _counterStacks.set(name, stack);
    }
    return stack;
  }
  function _removeStale(name: string, el: Element) {
    const stack = _stack(name);
    while (stack.length > 0) {
      const parent = stack[stack.length - 1].scopeParent;
      if (parent == null || _isAncestorOrSelf(parent, el)) break;
      stack.pop();
    }
  }
  function _findInnermost(name: string): CounterEntry | null {
    const stack = _stack(name);
    return stack.length ? stack[stack.length - 1] : null;
  }
  function _snapshotCounters(): CounterValue[] {
    const result: CounterValue[] = [];
    for (const [name, stack] of _counterStacks) for (const entry of stack) result.push({ name, value: entry.value });
    return result;
  }
  function _applyCounterStyle(owner: Element, scopeParent: Element | null, style: CSSStyleDeclaration) {
    const touched = new Set<string>();
    const resets = _parseCounterDecl(style.counterReset, 0);
    const increments = _parseCounterDecl(style.counterIncrement, 1);
    const sets = _parseCounterDecl(style.counterSet, 0);
    for (const item of [...resets, ...increments, ...sets]) touched.add(item.name);
    for (const name of touched) _removeStale(name, owner);
    for (const { name, value } of resets) {
      const stack = _stack(name);
      if (stack.length && stack[stack.length - 1].scopeParent === scopeParent) stack.pop();
      stack.push({ name, value, owner, scopeParent });
    }
    for (const { name, value } of increments) {
      const current = _findInnermost(name);
      if (current) current.value += value;
      else _stack(name).push({ name, value, owner, scopeParent });
    }
    for (const { name, value } of sets) {
      const current = _findInnermost(name);
      if (current) current.value = value;
      else _stack(name).push({ name, value, owner, scopeParent });
    }
    return touched;
  }
  function _counterPreWalk(el: Element) {
    const cs = window.getComputedStyle(el);
    // DM-705 / DM-706: CSS Lists 3 §2.3 ("Properties on a single element are
    // processed in the order reset, increment, set") — increment runs BEFORE
    // set. Our previous order (reset, set, increment) made
    // `counter-set: section 99` followed by an implicit `counter-increment:
    // section` paint as "100." instead of Chrome's "99." for the
    // `.restart` h2 in `24-counters.html`. Same off-by-one (always +1) in
    // `24-deep-counter-scope.html`.
    const touched = _applyCounterStyle(el, el.parentElement, cs);
    const beforeStyle = window.getComputedStyle(el, "::before");
    for (const name of _applyCounterStyle(el, el, beforeStyle)) touched.add(name);
    const snapshots: CounterSnapshots = {
      element: _snapshotCounters(),
      "::before": _snapshotCounters(),
      "::after": null,
    };
    for (const child of el.children) _counterPreWalk(child);
    const afterStyle = window.getComputedStyle(el, "::after");
    for (const name of _applyCounterStyle(el, el, afterStyle)) touched.add(name);
    snapshots["::after"] = _snapshotCounters();
    _counterSnapshot.set(el, snapshots);
    // Match CountersAttachmentContext::RemoveCounterIfAncestorExists: a
    // descendant-origin counter cannot remain atop an ancestor counter after
    // leaving its originating element.
    for (const name of touched) {
      const stack = _stack(name);
      if (stack.length < 2 || stack[stack.length - 1].owner !== el) continue;
      const previous = stack[stack.length - 2].owner;
      if (previous instanceof Element && previous.contains(el)) stack.pop();
    }
  }
  return { counterSnapshot: _counterSnapshot, counterPreWalk: _counterPreWalk };
};

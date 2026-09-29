// @ts-nocheck
//
// Scroll-marker-group and scroll-button (::scroll-button) capture.
// Extracted from the capture script's orchestrator (`captureDocumentTree`).
// Part of the page-`evaluate`d CAPTURE_SCRIPT bundle — self-contained, page globals only;
// everything the orchestrator owns is passed in through the factory argument.

export const createScrollMarkersHandler = (ctx) => {
  const { capture, sel } = ctx;
  // DM-1177: A scroll container with `scroll-marker-group: after | before`
  // synthesizes an anonymous marker-group box, and each scrollable child whose
  // `::scroll-marker` has non-`none` content becomes a dot/pill flex item inside
  // it. The generated boxes have NO DOM node (un-measurable). To reproduce
  // Chrome's paint faithfully without reimplementing the marker-group flex
  // layout, build a hidden REPLICA from the resolved `::scroll-marker-group` /
  // `::scroll-marker` computed styles — `:target-current` is already baked into
  // the active marker's computed style by the engine — position it where Chrome
  // paints the real group (after → below the scroller, before → above it, full
  // scroller width), and walk it with the normal `capture()` so each marker is a
  // styled box (with centered text for pill labels). Chrome lays out the replica
  // identically to the real group, so the measured rects ARE Chrome's geometry.
  function _captureScrollMarkerGroup(el, cs, rect) {
    var smg =
      cs.scrollMarkerGroup != null && cs.scrollMarkerGroup !== ""
        ? cs.scrollMarkerGroup
        : cs.getPropertyValue
          ? cs.getPropertyValue("scroll-marker-group")
          : "";
    if (!smg || smg.indexOf("none") === 0) return undefined;
    var position = smg.indexOf("before") === 0 ? "before" : smg.indexOf("after") === 0 ? "after" : null;
    if (!position) return undefined;
    // One marker per child whose ::scroll-marker has real content.
    var items = [];
    for (var i = 0; i < el.children.length; i++) {
      var child = el.children[i];
      var mcs = window.getComputedStyle(child, "::scroll-marker");
      var content = mcs.content;
      if (!content || content === "none" || content === "normal") continue;
      items.push({ mcs: mcs, content: content });
    }
    if (items.length === 0) return undefined;
    var gcs = window.getComputedStyle(el, "::scroll-marker-group");
    var doc = el.ownerDocument;
    var container = doc.createElement("div");
    var groupWidth = rect.width; // scroller border-box width
    container.style.boxSizing = "border-box";
    container.style.position = "absolute";
    container.style.margin = "0";
    container.style.display = gcs.display && gcs.display !== "inline" ? gcs.display : "flex";
    container.style.justifyContent = gcs.justifyContent || "center";
    // DM-1257: the markers overflow the padding-height group box (see below), and
    // Chrome top-aligns them at padding-top + marker-margin from the group's TOP
    // edge for BOTH `before` and `after` (verified: `after` dots sit padTop+margin
    // below the scroller-bottom; `before` dots sit padTop+margin below the
    // before-group's top, i.e. flush against the scroller's top edge). So always
    // flex-start — default `normal`/`center` would center them in the zero-height
    // content box and mis-place the row.
    container.style.alignItems = "flex-start";
    // Do not copy the group's flex gap. Blink leaves ::scroll-marker inline
    // (style_adjuster.cc:1194-1198), so adjacent markers are laid out through
    // one anonymous flex item; `gap` separates flex items and therefore does
    // not add spacing between these inline marker boxes. The replica's DOM
    // children are independent flex items, so copying gap would widen the row.
    container.style.gap = "0";
    container.style.padding = gcs.padding || "0";
    container.style.background = gcs.backgroundColor || "transparent";
    container.style.borderRadius = gcs.borderRadius || "0";
    container.style.width = groupWidth + "px";
    container.style.left = "-99999px";
    container.style.top = "0px";
    for (var j = 0; j < items.length; j++) {
      var mc = items[j].mcs;
      var m = doc.createElement("div");
      var txt = items[j].content;
      if (txt === '""' || txt === "''") txt = "";
      else if (
        txt.length >= 2 &&
        ((txt[0] === '"' && txt[txt.length - 1] === '"') || (txt[0] === "'" && txt[txt.length - 1] === "'"))
      )
        txt = txt.slice(1, -1);
      else txt = "";
      m.textContent = txt;
      m.style.boxSizing = mc.boxSizing || "content-box";
      m.style.flex = "0 0 auto";
      // Empty content ⇒ a sized dot (author set explicit width/height). Non-empty
      // ⇒ a content-sized pill (width/height auto from text + padding).
      if (txt === "") {
        m.style.width = mc.width;
        m.style.height = mc.height;
      }
      m.style.borderRadius = mc.borderRadius;
      m.style.background = mc.backgroundColor;
      m.style.color = mc.color;
      // DM-1257: keep the marker's vertical margin — it offsets each dot inside
      // the group (dot-top = group padding-top + marker margin-top). Horizontal
      // margin spaces the row.
      m.style.marginTop = mc.marginTop || "0";
      m.style.marginBottom = mc.marginBottom || "0";
      m.style.marginLeft = mc.marginLeft || "0";
      m.style.marginRight = mc.marginRight || "0";
      // Blink deliberately skips ordinary display blockification for
      // ::scroll-marker (style_adjuster.cc:1194-1198). In an in-flow marker
      // group the pseudo therefore keeps inline padding semantics: block-axis
      // padding contributes to the painted pill, while inline-axis padding
      // does not enlarge the marker's flex-item measure. A normal replica DOM
      // child would be blockified by flex layout and count both inline padding
      // edges, making a labeled marker row substantially too wide.
      m.style.paddingTop = mc.paddingTop;
      m.style.paddingBottom = mc.paddingBottom;
      m.style.paddingLeft = "0";
      m.style.paddingRight = "0";
      m.style.fontSize = mc.fontSize;
      m.style.fontWeight = mc.fontWeight;
      m.style.fontFamily = mc.fontFamily;
      m.style.lineHeight = mc.lineHeight;
      m.style.display = mc.display && mc.display !== "inline" ? mc.display : "inline-block";
      if (mc.transform && mc.transform !== "none") m.style.transform = mc.transform;
      if (mc.transformOrigin) m.style.transformOrigin = mc.transformOrigin;
      var bw = parseFloat(mc.borderTopWidth || "0") || 0;
      if (bw > 0) {
        m.style.borderStyle = mc.borderTopStyle;
        m.style.borderWidth = mc.borderTopWidth;
        m.style.borderColor = mc.borderTopColor;
      }
      container.appendChild(m);
    }
    // DM-1257: Chrome's generated `::scroll-marker-group` box is PADDING-height —
    // its content height is ~0 and the markers OVERFLOW it (verified with a
    // contrast probe: the group background spans exactly [scroller-border-edge,
    // edge + padding-top + padding-bottom], while the dots sit at padding-top +
    // marker-margin and hang past the box). The box's outer edge is flush against
    // the scroller's border-box edge (top edge at `rect.bottom` for `after`,
    // bottom edge at `rect.top` for `before`). Force the replica to that geometry:
    // padding-only height with overflow visible, so the captured group bg rect
    // matches Chrome AND the captured marker rects land where Chrome paints them.
    // (The earlier `rect.bottom - padTop` + full-flex-height model painted the
    // dots ~16px too high and the bg band the wrong length.)
    var padTop = parseFloat(gcs.paddingTop || "0") || 0;
    var padBottom = parseFloat(gcs.paddingBottom || "0") || 0;
    var groupBoxH = padTop + padBottom;
    container.style.height = groupBoxH + "px";
    container.style.overflow = "visible";
    doc.body.appendChild(container);
    var targetTop = position === "after" ? rect.bottom : rect.top - groupBoxH;
    container.style.left = rect.left + window.scrollX + "px";
    container.style.top = targetTop + window.scrollY + "px";
    var node = capture(container);
    doc.body.removeChild(container);
    if (!node) return undefined;
    return { node: node, before: position === "before" };
  }

  // DM-1234: CSS `::scroll-button(<dir>)` paging arrows (Chrome 135+). Like the
  // marker-group these are generated boxes with NO DOM node, and — crucially —
  // Chrome lays them out against the INITIAL CONTAINING BLOCK (the viewport),
  // NOT the scroller's `position:relative` ancestor: `top:50%` resolves to 50%
  // of the viewport height and `left`/`right` to insets from the viewport edges
  // (verified by probe-and-match against Chrome's painted output across two
  // viewport heights — the button center tracked 50%·viewportHeight while the
  // scroller stayed put). `getComputedStyle(el, '::scroll-button(left)')` can't
  // disambiguate the parameterized pseudo — it returns ONE merged style (the
  // box props are shared, but `content` is the cascade-last value and both
  // insets are reported) — so the per-side `content` + the `:disabled`
  // declarations are read from the author stylesheet (CSSOM). Geometry is then
  // resolved the same trick the marker-group uses: an absolutely-positioned
  // replica appended to <body> ALSO takes the ICB as its containing block, so
  // `top:50%`/`left`/`right`/`transform` land exactly where Chrome paints the
  // real button — capture() measures that, so the rect IS Chrome's geometry.
  // Enabled/disabled comes from the captured scroll offset vs the scroll range.
  function _scrollButtonAuthorRules(el) {
    // Per-direction author declarations + the merged `:disabled` declarations,
    // gathered from every stylesheet rule whose `::scroll-button(<dir>)`
    // selector matches `el`. `*` (universal direction) is folded in as a base.
    var sides = {};
    var disabled = {};
    var star = {};
    var sheets = el.ownerDocument.styleSheets;
    for (var s = 0; s < sheets.length; s++) {
      var rules;
      try {
        rules = sheets[s].cssRules;
      } catch (e) {
        continue;
      }
      if (!rules) continue;
      for (var r = 0; r < rules.length; r++) {
        var rule = rules[r];
        var sel = rule.selectorText;
        if (!sel) continue;
        var at = sel.indexOf("::scroll-button(");
        if (at < 0) continue;
        var close = sel.indexOf(")", at);
        if (close < 0) continue;
        var dir = sel.slice(at + 16, close).trim();
        var base = sel.slice(0, at).trim();
        var matches = false;
        try {
          matches = base === "" || el.matches(base);
        } catch (e) {
          matches = false;
        }
        if (!matches) continue;
        var isDisabled = sel.slice(close + 1).indexOf(":disabled") >= 0;
        var bucket = isDisabled ? disabled : dir === "*" ? star : sides[dir] || (sides[dir] = {});
        var decl = rule.style;
        for (var d = 0; d < decl.length; d++) bucket[decl[d]] = decl.getPropertyValue(decl[d]);
      }
    }
    // Fold the universal `*` declarations in as a lower-priority base per side.
    for (var k in sides) {
      if (!Object.prototype.hasOwnProperty.call(sides, k)) continue;
      var merged = {};
      for (var sp in star) if (Object.prototype.hasOwnProperty.call(star, sp)) merged[sp] = star[sp];
      for (var op in sides[k]) if (Object.prototype.hasOwnProperty.call(sides[k], op)) merged[op] = sides[k][op];
      sides[k] = merged;
    }
    return { sides: sides, disabled: disabled };
  }

  function _captureScrollButtons(el, cs, rect) {
    // Cheap gate: only elements that actually generate a scroll-button get the
    // CSSOM scan. A non-`none` `content` on the merged pseudo means buttons exist.
    var probe = window.getComputedStyle(el, "::scroll-button(left)").content;
    if (!probe || probe === "none" || probe === "normal") {
      probe = window.getComputedStyle(el, "::scroll-button(right)").content;
      if (!probe || probe === "none" || probe === "normal") return undefined;
    }
    var rules = _scrollButtonAuthorRules(el);
    var doc = el.ownerDocument;
    var maxX = el.scrollWidth - el.clientWidth;
    var maxY = el.scrollHeight - el.clientHeight;
    var nodes = [];
    for (var dir in rules.sides) {
      if (!Object.prototype.hasOwnProperty.call(rules.sides, dir)) continue;
      var decls = rules.sides[dir];
      var isDisabled = false;
      if (dir === "left" || dir === "inline-start") isDisabled = el.scrollLeft <= 0;
      else if (dir === "right" || dir === "inline-end") isDisabled = el.scrollLeft >= maxX - 1;
      else if (dir === "up" || dir === "block-start") isDisabled = el.scrollTop <= 0;
      else if (dir === "down" || dir === "block-end") isDisabled = el.scrollTop >= maxY - 1;
      var btn = doc.createElement("div");
      var content = "";
      for (var p in decls) {
        if (!Object.prototype.hasOwnProperty.call(decls, p)) continue;
        if (p === "content") {
          content = decls[p];
          continue;
        }
        try {
          btn.style.setProperty(p, decls[p]);
        } catch (e) {
          /* unsupported prop */
        }
      }
      if (isDisabled) {
        for (var dp in rules.disabled) {
          if (!Object.prototype.hasOwnProperty.call(rules.disabled, dp)) continue;
          try {
            btn.style.setProperty(dp, rules.disabled[dp]);
          } catch (e) {
            /* unsupported */
          }
        }
      }
      // Match the real button's containing block (ICB) by living on <body> as an
      // absolutely-positioned box; the author's left/right/top/transform then
      // resolve against the viewport exactly as Chrome resolves them.
      if (!btn.style.position || btn.style.position === "static") btn.style.position = "absolute";
      btn.style.margin = "0";
      // Only a quoted string `content` becomes a text glyph. DM-1248: a `url()` /
      // counter() / image content value is NOT text — set no glyph rather than
      // rendering the literal CSS string (e.g. `url("x.png")`) as garbage text.
      // (Faithful image-content rendering is a tracked TODO in DM-1248.)
      var txt = "";
      if (
        content.length >= 2 &&
        ((content[0] === '"' && content[content.length - 1] === '"') ||
          (content[0] === "'" && content[content.length - 1] === "'"))
      ) {
        txt = content.slice(1, -1);
      }
      btn.textContent = txt;
      doc.body.appendChild(btn);
      var node = capture(btn);
      doc.body.removeChild(btn);
      if (node) nodes.push(node);
    }
    return nodes.length ? nodes : undefined;
  }

  return { _captureScrollMarkerGroup, _captureScrollButtons };
};

import { describe, expect, it } from "vitest";
import { Fragment, raw, SafeHtml } from "kerfjs";
import { SafeHtml as RuntimeSafeHtml } from "kerfjs/jsx-runtime";

// Regression test for DM-533: kerfjs <= 0.1.2 shipped two independent
// `SafeHtml` class definitions — one in the `"kerfjs"` barrel and one in
// `"kerfjs/jsx-runtime"`. The auto JSX runtime resolves <jsx> calls via the
// jsx-runtime entry, so a `raw()` value imported from the barrel failed the
// `instanceof SafeHtml` check inside `renderChildren` and the renderer threw.
//
// 0.2.0 fixes this by emitting a shared chunk; both entries re-export the same
// class. These tests guard that contract — if a future kerfjs upgrade
// regresses the duplication, JSX rendering breaks across all of Domotion's
// .tsx files (tests/, site/) and these tests will fail loudly here instead.

describe("kerfjs barrel and jsx-runtime share SafeHtml", () => {
  it("exports the same SafeHtml class from both entry points", () => {
    expect(SafeHtml).toBe(RuntimeSafeHtml);
  });

  it("renders raw() imported from the barrel inside JSX without throwing", () => {
    const html = (<div>{raw("<b>hi</b>")}</div>).toString();
    expect(html).toBe("<div><b>hi</b></div>");
  });

  it("auto-escapes string children", () => {
    const html = (<p>{"<script>x</script>"}</p>).toString();
    expect(html).toBe("<p>&lt;script&gt;x&lt;/script&gt;</p>");
  });

  // Regression test for DM-534: kerfjs 0.2.0's `"kerfjs"` barrel re-exported
  // `SafeHtml`/`isSafeHtml`/`raw` from the shared chunk but omitted `Fragment`,
  // so `<Fragment>…</Fragment>` rendered as `<undefined>…</undefined>`. Fixed
  // upstream in 0.2.1 by adding `Fragment` to the barrel re-export.
  it("exports Fragment from the barrel and renders it as a transparent wrapper", () => {
    expect(Fragment).toBeDefined();
    const html = (
      <Fragment>
        <span>a</span>
        <span>b</span>
      </Fragment>
    ).toString();
    expect(html).toBe("<span>a</span><span>b</span>");
  });
});

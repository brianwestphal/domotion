import type { FeatureTest } from "./runner.js";

export type ComposedParityFamily =
  | "multilingual-flex-grid"
  | "responsive-fragmented-controls"
  | "gradient-mask-clip-stacking"
  | "svg-effects"
  | "zoom-transforms"
  | "same-origin-iframe"
  | "dynamic-replaced-content";

export type MetamorphicAxis =
  | "neutral-wrapper"
  | "equivalent-syntax"
  | "node-split"
  | "translation"
  | "scale"
  | "dom-order";

export interface ComposedParityFixture extends FeatureTest {
  family: ComposedParityFamily;
  axes: MetamorphicAxis[];
  decisions: string[];
  /** Source-owner decisions sharing capture/render state and crossed together. */
  dependencyTriples: [string, string, string][];
}

const COMMON = `
  *{box-sizing:border-box}
  .fixture{margin:0;padding:14px;background:#0d1117;color:#e6edf3;font:15px/1.35 Arial,sans-serif}
  .pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
  .stage{position:relative;min-width:0;overflow:hidden;border:1px solid #40536d;border-radius:8px;background:#152235}
  .label{position:absolute;right:5px;bottom:3px;color:#9fb0c5;font:9px/1 Arial,sans-serif;z-index:20}
`;

export const COMPOSED_PARITY_FIXTURES: ComposedParityFixture[] = [
  {
    name: "composed-multilingual-flex-grid",
    family: "multilingual-flex-grid",
    axes: ["neutral-wrapper", "node-split"],
    decisions: ["platform fallback", "bidi isolation", "flex/grid placement", "inline fragmentation"],
    dependencyTriples: [["platform fallback", "bidi isolation", "inline fragmentation"]],
    width: 760,
    height: 250,
    html: `<style>${COMMON}
      .fixture{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
      .stage{height:210px;padding:12px;display:flex;flex-direction:column;gap:8px}
      .message{display:grid;grid-template-columns:28px minmax(0,1fr);gap:7px;align-items:start;padding:8px;border-radius:6px;background:#20324b}
      .avatar{width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#59e,#b5f)}
      .copy{min-width:0;font-family:"Definitely Missing",Arial,sans-serif;unicode-bidi:plaintext}
      .neutral{display:contents}
    </style><main class="fixture" data-family="multilingual-flex-grid">
      <section class="stage" data-variant="base"><div class="message"><i class="avatar"></i><div class="copy" data-probe="message">Latin 42 · <bdi dir="rtl">עברית العربية</bdi> · 日本語</div></div><div class="message"><i class="avatar"></i><div class="copy">Grid: Ω क् 👩🏽‍🚀</div></div><span class="label">base</span></section>
      <section class="stage" data-variant="neutral-wrapper"><span class="neutral"><div class="message"><i class="avatar"></i><div class="copy" data-probe="message">Latin 42 · <bdi dir="rtl">עברית العربية</bdi> · 日本語</div></div></span><div class="message"><i class="avatar"></i><div class="copy">Grid: Ω क् 👩🏽‍🚀</div></div><span class="label">display:contents wrapper</span></section>
      <section class="stage" data-variant="node-split"><div class="message"><i class="avatar"></i><div class="copy" data-probe="message"><span>Latin</span><span> 42 · </span><bdi dir="rtl"><span>עברית</span><span> العربية</span></bdi><span> · </span><span>日本語</span></div></div><div class="message"><i class="avatar"></i><div class="copy"><span>Grid: Ω </span><span>क् 👩🏽‍🚀</span></div></div><span class="label">node split</span></section>
    </main>`,
  },
  {
    name: "composed-responsive-fragmented-controls",
    family: "responsive-fragmented-controls",
    axes: ["equivalent-syntax"],
    decisions: ["native control ownership", "multicol fragmentation", "responsive grid", "accent/color scheme"],
    dependencyTriples: [["native control ownership", "multicol fragmentation", "accent/color scheme"]],
    width: 760,
    height: 270,
    html: `<style>${COMMON}
      .fixture{container-type:inline-size}
      .stage{height:225px;padding:10px;color-scheme:dark;accent-color:#ff6c8f}
      .form{height:165px;columns:2;column-gap:14px;column-rule:1px solid #40536d}
      .row{break-inside:avoid;align-items:center;margin:0 0 9px;padding:5px;background:#1d3049;border-radius:5px}
      .longhand{display:grid;grid-template-columns:1fr auto;column-gap:6px;row-gap:6px}
      .shorthand{display:grid;grid:auto / 1fr auto;gap:6px}
      input[type=range]{width:96px} progress,meter{width:98px}
      @container (max-width:700px){.pair{grid-template-columns:repeat(2,minmax(0,1fr))}}
    </style><main class="fixture" data-family="responsive-fragmented-controls"><div class="pair">
      <section class="stage" data-variant="base"><div class="form"><label class="row longhand" data-probe="control-layout">Enabled <input type="checkbox" checked></label><label class="row longhand">Choice <input type="radio" checked></label><label class="row longhand">Level <input type="range" value="64"></label><label class="row longhand">Build <progress max="100" value="58"></progress></label><label class="row longhand">Score <meter min="0" max="10" value="7"></meter></label><label class="row longhand">Mode <select><option selected>Exact</option></select></label></div><span class="label">grid longhands</span></section>
      <section class="stage" data-variant="equivalent-syntax"><div class="form"><label class="row shorthand" data-probe="control-layout">Enabled <input type="checkbox" checked></label><label class="row shorthand">Choice <input type="radio" checked></label><label class="row shorthand">Level <input type="range" value="64"></label><label class="row shorthand">Build <progress max="100" value="58"></progress></label><label class="row shorthand">Score <meter min="0" max="10" value="7"></meter></label><label class="row shorthand">Mode <select><option selected>Exact</option></select></label></div><span class="label">equivalent shorthand</span></section>
    </div></main>`,
  },
  {
    name: "composed-gradient-mask-clip-stacking",
    family: "gradient-mask-clip-stacking",
    axes: ["dom-order"],
    decisions: ["stacking phases", "gradient geometry", "mask composition", "clip geometry"],
    dependencyTriples: [["stacking phases", "mask composition", "clip geometry"]],
    width: 760,
    height: 270,
    html: `<style>${COMMON}
      .stage{height:225px}
      .layer{position:absolute;width:180px;height:132px;border-radius:18px}
      .back{left:28px;top:30px;z-index:1;background:linear-gradient(135deg,#35c,#a5f);clip-path:polygon(0 8%,100% 0,88% 100%,6% 88%)}
      .front{left:105px;top:62px;z-index:3;background:repeating-linear-gradient(45deg,#ffcf66 0 12px,#ef5b7b 12px 24px);mask-image:linear-gradient(90deg,transparent,#000 22% 78%,transparent)}
      .ink{position:absolute;left:72px;top:105px;z-index:4;color:white;font-weight:700;text-shadow:0 1px 2px #000}
    </style><main class="fixture" data-family="gradient-mask-clip-stacking"><div class="pair">
      <section class="stage" data-variant="base"><div class="layer back" data-layer="back"></div><div class="layer front" data-layer="front"></div><div class="ink">STACK</div><span class="label">DOM back → front</span></section>
      <section class="stage" data-variant="dom-order"><div class="layer front" data-layer="front"></div><div class="ink">STACK</div><div class="layer back" data-layer="back"></div><span class="label">DOM front → back</span></section>
    </div></main>`,
  },
  {
    name: "composed-svg-effects-translation",
    family: "svg-effects",
    axes: ["translation"],
    decisions: ["SVG effect bounds", "filter/marker ownership", "clip path", "translation covariance"],
    dependencyTriples: [["SVG effect bounds", "filter/marker ownership", "translation covariance"]],
    width: 760,
    height: 270,
    html: `<style>${COMMON}
      .stage{height:225px;padding:18px}.translated [data-probe=svg-effect]{transform:translate(18px,12px)}
      svg{display:block;width:240px;height:150px;overflow:visible}
    </style><main class="fixture" data-family="svg-effects"><div class="pair">
      <section class="stage" data-variant="base"><svg data-probe="svg-effect" viewBox="0 0 240 150"><defs><filter id="shadow-a" x="-30%" y="-40%" width="170%" height="190%"><feGaussianBlur in="SourceAlpha" stdDeviation="3"/><feOffset dx="5" dy="4"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter><clipPath id="cut-a"><path d="M12 14H220L196 132H28Z"/></clipPath><marker id="arrow-a" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8Z" fill="#ffcf66"/></marker></defs><g clip-path="url(#cut-a)" filter="url(#shadow-a)"><rect x="16" y="18" width="190" height="104" rx="18" fill="#315fca"/><path d="M38 96C74 28 142 132 194 48" fill="none" stroke="#ffcf66" stroke-width="8" marker-end="url(#arrow-a)"/></g></svg><span class="label">base</span></section>
      <section class="stage translated" data-variant="translation"><svg data-probe="svg-effect" viewBox="0 0 240 150"><defs><filter id="shadow-b" x="-30%" y="-40%" width="170%" height="190%"><feGaussianBlur in="SourceAlpha" stdDeviation="3"/><feOffset dx="5" dy="4"/><feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge></filter><clipPath id="cut-b"><path d="M12 14H220L196 132H28Z"/></clipPath><marker id="arrow-b" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8Z" fill="#ffcf66"/></marker></defs><g clip-path="url(#cut-b)" filter="url(#shadow-b)"><rect x="16" y="18" width="190" height="104" rx="18" fill="#315fca"/><path d="M38 96C74 28 142 132 194 48" fill="none" stroke="#ffcf66" stroke-width="8" marker-end="url(#arrow-b)"/></g></svg><span class="label">translate(18px,12px)</span></section>
    </div></main>`,
  },
  {
    name: "composed-zoom-transform-scale",
    family: "zoom-transforms",
    axes: ["scale"],
    decisions: ["effective zoom", "nested affine transforms", "transform origin", "scale-normalized geometry"],
    dependencyTriples: [["effective zoom", "nested affine transforms", "transform origin"]],
    width: 760,
    height: 270,
    html: `<style>${COMMON}
      .stage{height:225px;padding:24px}.target{width:170px;height:112px;zoom:1.2;transform-origin:0 0;background:linear-gradient(135deg,#18a999,#61d095);border:4px solid #d8fff4;border-radius:14px;color:#052e2a;padding:17px;font-weight:700}.scaled .target{transform:scale(1.25) rotate(3deg)}.base .target{transform:rotate(3deg)}
      .chip{margin-top:8px;display:inline-block;padding:4px 7px;background:#fff8;border-radius:999px}
    </style><main class="fixture" data-family="zoom-transforms"><div class="pair">
      <section class="stage base" data-variant="base"><div class="target" data-probe="scale-target">zoom 1.2<div class="chip">nested</div></div><span class="label">base rotation</span></section>
      <section class="stage scaled" data-variant="scale"><div class="target" data-probe="scale-target">zoom 1.2<div class="chip">nested</div></div><span class="label">normalized scale 1.25</span></section>
    </div></main>`,
  },
  {
    name: "composed-same-origin-iframe",
    family: "same-origin-iframe",
    axes: ["neutral-wrapper"],
    decisions: ["same-origin recursion", "inner canvas background", "inner fallback/bidi", "inner mask/gradient"],
    dependencyTriples: [["same-origin recursion", "inner fallback/bidi", "inner mask/gradient"]],
    width: 760,
    height: 275,
    html: `<style>${COMMON}
      .stage{height:230px;padding:12px}.neutral{display:contents}iframe{display:block;width:100%;height:185px;border:4px solid #637a99;border-radius:7px;background:#182a42}
    </style><main class="fixture" data-family="same-origin-iframe"><div class="pair">
      <section class="stage" data-variant="base"><iframe data-probe="frame" srcdoc="<style>*{box-sizing:border-box}body{margin:0;padding:12px;color:white;font:15px Arial,sans-serif;background:linear-gradient(135deg,#16243d,#294e72)}.inner{display:grid;grid-template-columns:1fr auto;gap:8px}.badge{padding:8px;background:#e95;clip-path:polygon(0 0,100% 8%,88% 100%,4% 90%);mask-image:linear-gradient(90deg,#000,transparent)}</style><div class='inner'><bdi dir='rtl'>עברית العربية</bdi><span>日本語 Ω</span><div class='badge'>inner frame</div></div>"></iframe><span class="label">direct iframe</span></section>
      <section class="stage" data-variant="neutral-wrapper"><span class="neutral"><iframe data-probe="frame" srcdoc="<style>*{box-sizing:border-box}body{margin:0;padding:12px;color:white;font:15px Arial,sans-serif;background:linear-gradient(135deg,#16243d,#294e72)}.inner{display:grid;grid-template-columns:1fr auto;gap:8px}.badge{padding:8px;background:#e95;clip-path:polygon(0 0,100% 8%,88% 100%,4% 90%);mask-image:linear-gradient(90deg,#000,transparent)}</style><div class='inner'><bdi dir='rtl'>עברית العربية</bdi><span>日本語 Ω</span><div class='badge'>inner frame</div></div>"></iframe></span><span class="label">display:contents wrapper</span></section>
    </div></main>`,
  },
  {
    name: "composed-dynamic-replaced-freeze",
    family: "dynamic-replaced-content",
    axes: ["dom-order"],
    decisions: ["canvas snapshot ownership", "capture-time freezing", "nested transform", "explicit stacking order"],
    dependencyTriples: [["canvas snapshot ownership", "capture-time freezing", "explicit stacking order"]],
    width: 760,
    height: 275,
    html: `<style>${COMMON}
      .stage{height:230px}.canvas-wrap{position:absolute;left:54px;top:34px;width:240px;height:150px;transform:rotate(-3deg);transform-origin:50% 50%}.canvas-wrap canvas{display:block;width:240px;height:150px}.overlay{position:absolute;left:142px;top:88px;z-index:4;padding:10px 16px;background:#0d1117dd;border:2px solid #fff;color:#fff;border-radius:8px}.canvas-wrap{z-index:2}
    </style><main class="fixture" data-family="dynamic-replaced-content"><div class="pair">
      <section class="stage" data-variant="base"><div class="canvas-wrap"><canvas data-probe="dynamic-canvas" width="240" height="150"></canvas></div><div class="overlay">frozen frame</div><span class="label">canvas → overlay</span></section>
      <section class="stage" data-variant="dom-order"><div class="overlay">frozen frame</div><div class="canvas-wrap"><canvas data-probe="dynamic-canvas" width="240" height="150"></canvas></div><span class="label">overlay → canvas, z-index stable</span></section>
    </div></main><script>
      (()=>{const draw=(phase)=>{document.querySelectorAll('canvas[data-probe="dynamic-canvas"]').forEach((canvas)=>{const c=canvas;const x=c.getContext('2d');const g=x.createLinearGradient(0,0,c.width,c.height);if(phase===0){g.addColorStop(0,'#642bd4');g.addColorStop(1,'#ff8a36')}else{g.addColorStop(0,'#20c977');g.addColorStop(1,'#0a5bd3')}x.fillStyle=g;x.fillRect(0,0,c.width,c.height);x.fillStyle='#fff';x.font='700 28px Arial';x.fillText(phase===0?'FRAME A':'FRAME B',34,82)})};window.advanceComposedCanvas=()=>draw(1);draw(0)})();
    </script>`,
  },
];

export const REQUIRED_COMPOSED_FAMILIES: readonly ComposedParityFamily[] = [
  "multilingual-flex-grid",
  "responsive-fragmented-controls",
  "gradient-mask-clip-stacking",
  "svg-effects",
  "zoom-transforms",
  "same-origin-iframe",
  "dynamic-replaced-content",
];

export const REQUIRED_METAMORPHIC_AXES: readonly MetamorphicAxis[] = [
  "neutral-wrapper",
  "equivalent-syntax",
  "node-split",
  "translation",
  "scale",
  "dom-order",
];

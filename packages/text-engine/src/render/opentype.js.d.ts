// Minimal ambient declaration for opentype.js — the library ships no types
// and no @types package exists. We use a tiny surface (Font + Glyph + Path)
// from a Node build-time pass, so `any` here is fine.
declare module "opentype.js" {
  const opentype: any;
  export default opentype;
}

// kerfjs 0.5.0 ships a typed JSX `IntrinsicElements` table, but the bundled
// type declarations have a self-referential interface bug at
// `node_modules/kerfjs/dist/jsx-runtime.d.ts:784`:
//
//   declare namespace JSX {
//     interface IntrinsicElements extends IntrinsicElements {}
//   }
//
// The `extends IntrinsicElements` resolves to the local (just-being-declared)
// JSX.IntrinsicElements, not the module-scope one with the typed tag table.
// Result: `JSX.IntrinsicElements` is empty and every `<div>`, `<span>`, etc.
// fails to type-check with `Property 'div' does not exist on type
// 'JSX.IntrinsicElements'`.
//
// This declaration merging adds a permissive index signature that accepts
// any tag with any props — restoring the pre-0.5.0 catch-all behaviour. We
// lose 0.5.0's typed-tag benefit (typos like `<dvi>` no longer fail to
// compile), but the runtime is unaffected and we unblock the upgrade.
//
// Remove this file when kerfjs publishes a fix (rename the outer interface
// so the JSX namespace's `extends` resolves correctly, or drop the
// `extends` and explicitly list the tag table inside the namespace).

// Importing from the module first registers it for augmentation. Without
// this, the `declare module` block is treated as a NEW module declaration
// and clobbers the original `kerfjs/jsx-runtime` exports (TS2305: 'SafeHtml'
// has no exported member).
import "kerfjs/jsx-runtime";

declare module "kerfjs/jsx-runtime" {
  namespace JSX {
    interface IntrinsicElements {
      [tag: string]: any;
    }
  }
}

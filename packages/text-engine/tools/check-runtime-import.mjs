// Native Node ESM evaluates cross-module initializers in dependency order.
// Import the built entry after every package build to catch cycles that
// source transforms and type checking do not expose.
await import(new URL("../dist/index.js", import.meta.url));
console.log("text-engine runtime import ok");

/**
 * Stable public facade for declarative animation support.
 *
 * Config validation and capture orchestration live in
 * `animate-orchestrator.ts`; CLI parsing and artifact output live in
 * `animate-command.ts`.
 */

export * from "./animate-orchestrator.js";
export { runAnimate } from "./animate-command.js";

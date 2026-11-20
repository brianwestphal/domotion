// `--import` preload for Node children of an E2E worker (see
// tests/e2e-child-evidence.ts). It installs the child-side screenshot-failure
// evidence tap only when the worker opted the child in.
import { CHILD_EVIDENCE_FLAG, installChildBrowserEvidence } from "./e2e-child-evidence-tap.mjs";

if (process.env[CHILD_EVIDENCE_FLAG] === "1") {
  try {
    installChildBrowserEvidence();
  } catch {
    // Evidence collection must never stop the child from running.
  }
}

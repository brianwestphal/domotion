/** Normalize spawnSync's nullable status into a shell-safe exit code. */
export function normalizeCoverageExitStatus(status) {
  return Number.isInteger(status) && status >= 0 ? status : 1;
}

/**
 * The merged report is valid only when every required suite and c8 itself
 * succeeded. Suite failures collapse to 1 so a later successful report cannot
 * turn an incomplete coverage run green; a c8 failure keeps its own exit code.
 */
export function coverageCommandExitStatus(suiteStatuses, reportStatus) {
  if (suiteStatuses.some((status) => normalizeCoverageExitStatus(status) !== 0)) return 1;
  return normalizeCoverageExitStatus(reportStatus);
}

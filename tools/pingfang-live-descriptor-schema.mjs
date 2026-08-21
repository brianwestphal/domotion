export const PINGFANG_DESCRIPTOR_CODEPOINTS = [0x270ef, 0x270f0, 0x270f1, 0x270f3, 0x270f4, 0x270f5];
export const PINGFANG_DESCRIPTOR_ARMS = ["live-fallback", "canonical-postscript", "display-name", "explicit-wght-400"];

export function validatePingFangDescriptorArtifact(artifact) {
  const errors = [];
  for (const key of ["os", "release", "arch", "swVers", "chromiumVersion", "sourceSha", "fontInventoryDigest"])
    if (!artifact.environment?.[key]) errors.push(`missing environment.${key}`);
  if (JSON.stringify(artifact.codepoints) !== JSON.stringify(PINGFANG_DESCRIPTOR_CODEPOINTS)) errors.push("codepoint corpus drift");
  if (artifact.coldProcesses?.length < 3) errors.push("need at least three cold processes");
  if (!artifact.warmProcess?.samples?.some((sample) => sample.iteration >= 2)) errors.push("need three warm iterations");
  for (const [label, process] of [...(artifact.coldProcesses ?? []).map((value, index) => [`cold[${index}]`, value]), ["warm", artifact.warmProcess]]) {
    for (const sample of process?.samples ?? []) {
      const arms = sample.arms?.map((arm) => arm.arm) ?? [];
      for (const arm of PINGFANG_DESCRIPTOR_ARMS) if (!arms.includes(arm)) errors.push(`${label} U+${sample.queryCodepoint?.toString(16)} missing ${arm}`);
      for (const record of sample.arms ?? []) for (const key of ["descriptor", "variationAxes", "variation", "unitsPerEm", "matrix", "glyphs"])
        if (!(key in record)) errors.push(`${label} ${record.arm} missing ${key}`);
    }
  }
  if (artifact.browserRows?.length !== PINGFANG_DESCRIPTOR_CODEPOINTS.length) errors.push("browser row count mismatch");
  for (const row of artifact.browserRows ?? []) {
    if (typeof row.rangeWidth !== "number") errors.push(`${row.hex} missing Range width`);
    if (!Array.isArray(row.platformFonts)) errors.push(`${row.hex} missing CDP platform fonts`);
  }
  if (errors.length) throw new Error(`Invalid PingFang descriptor artifact:\n- ${errors.join("\n- ")}`);
  return artifact;
}

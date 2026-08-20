import { access, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { z } from "zod";

export const ACTIVATION_KINDS = ["helper", "resolver", "cache", "platform-branch", "generated-table", "fallback-trigger", "representation-boundary", "specialized-path"] as const;
export const ACTIVATION_PLATFORMS = ["darwin", "linux", "win32"] as const;
const mechanismSchema = z.object({
  id: z.string().min(1), kind: z.enum(ACTIVATION_KINDS), owners: z.array(z.string()).min(1),
  evidenceFile: z.string().min(1), positive: z.string().min(1), negative: z.string().min(1),
  mutation: z.string().min(1), platforms: z.array(z.enum(ACTIVATION_PLATFORMS)).min(1),
});
const ledgerSchema = z.object({ schemaVersion: z.literal(1), mechanisms: z.array(mechanismSchema).min(1) });
export type ActivationLedger = z.infer<typeof ledgerSchema>;

export async function loadActivationLedger(path: string): Promise<ActivationLedger> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  const parsed = ledgerSchema.safeParse(value);
  if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
  return parsed.data;
}

export async function validateActivationLedger(ledger: ActivationLedger, root: string): Promise<string[]> {
  const errors: string[] = [];
  const ids = new Set<string>();
  const source = async (path: string, label: string): Promise<string | null> => {
    const absolute = resolve(root, path);
    if (isAbsolute(path) || relative(root, absolute).startsWith("..")) {
      errors.push(`${label}: path escapes repository: ${path}`); return null;
    }
    try { await access(absolute); return await readFile(absolute, "utf8"); }
    catch { errors.push(`${label}: missing path: ${path}`); return null; }
  };
  for (const mechanism of ledger.mechanisms) {
    if (ids.has(mechanism.id)) errors.push(`duplicate mechanism id: ${mechanism.id}`);
    ids.add(mechanism.id);
    for (const owner of mechanism.owners) await source(owner, mechanism.id);
    const evidence = await source(mechanism.evidenceFile, mechanism.id);
    if (evidence != null) for (const [kind, marker] of [["positive", mechanism.positive], ["negative", mechanism.negative], ["mutation", mechanism.mutation]] as const) {
      if (!evidence.includes(marker)) errors.push(`${mechanism.id}: stale ${kind} marker: ${marker}`);
    }
    if (mechanism.positive === mechanism.negative) errors.push(`${mechanism.id}: positive and negative controls must differ`);
  }
  for (const kind of ACTIVATION_KINDS) if (!ledger.mechanisms.some((entry) => entry.kind === kind)) errors.push(`unclaimed mechanism kind: ${kind}`);
  return errors;
}

export async function writeActivationEvidence(path: string, ledger: ActivationLedger): Promise<void> {
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), platform: process.platform, mechanisms: ledger.mechanisms.map(({ id, kind, evidenceFile, positive, negative, mutation, platforms }) => ({ id, kind, evidenceFile, positive, negative, mutation, platforms })) }, null, 2)}\n`);
}

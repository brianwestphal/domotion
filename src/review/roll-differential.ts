import { createHash } from "node:crypto";
export interface RollArtifact { environmentFingerprint: Record<string, unknown>; reports: Array<{ area: string; status: string }>; reportPayloads?: Record<string, unknown>; visuals?: Record<string, { digest: string }> }
export interface RollReview { reviewedAreas: Record<string, { sourceRefs: string[]; updatedRows: string[]; classification: "upstream-drift" | "domotion-regression" | "no-semantic-change" }> }
const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v != null && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([k,x]) => [k,stable(x)])) : v;
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(stable(v))).digest("hex");
function comparable(env: Record<string, unknown>) { const c=structuredClone(env) as Record<string,unknown>; delete c.fingerprint; const r=c.runtimes as Record<string,unknown>|undefined; if(r) for(const k of ["chromiumSource","harfbuzzSource","skiaPinned","icuSource"]) delete r[k]; const b=c.chromium as Record<string,unknown>|undefined; if(b) delete b.version; return c; }
export function compareRollArtifacts(oldRun: RollArtifact,newRun: RollArtifact,review?: RollReview) {
  const environmentComparable=digest(comparable(oldRun.environmentFingerprint))===digest(comparable(newRun.environmentFingerprint));
  const areas=[...new Set([...oldRun.reports.map(r=>r.area),...newRun.reports.map(r=>r.area)])].sort();
  const stageChanges=areas.flatMap(area=>{const a=oldRun.reportPayloads?.[area]??oldRun.reports.find(r=>r.area===area);const b=newRun.reportPayloads?.[area]??newRun.reports.find(r=>r.area===area);return digest(a)===digest(b)?[]:[{area,oldDigest:digest(a),newDigest:digest(b)}]});
  const ids=[...new Set([...Object.keys(oldRun.visuals??{}),...Object.keys(newRun.visuals??{})])].sort();
  const visualChanges=ids.filter(id=>oldRun.visuals?.[id]?.digest!==newRun.visuals?.[id]?.digest).map(id=>({id,oldDigest:oldRun.visuals?.[id]?.digest,newDigest:newRun.visuals?.[id]?.digest}));
  const missingReviews=stageChanges.map(x=>x.area).filter(area=>{const x=review?.reviewedAreas[area];return !x||x.sourceRefs.length===0||(x.classification!=="no-semantic-change"&&x.updatedRows.length===0)});
  return {schemaVersion:1,environmentComparable,stageChanges,visualChanges,missingReviews,pass:environmentComparable&&missingReviews.length===0};
}

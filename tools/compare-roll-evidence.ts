#!/usr/bin/env tsx
import { existsSync,readFileSync,writeFileSync } from "node:fs"; import { dirname,resolve } from "node:path";
import { compareRollArtifacts,type RollArtifact,type RollReview } from "../src/review/roll-differential.js";
const arg=(f:string)=>{const i=process.argv.indexOf(f);return i<0?undefined:process.argv[i+1]}; const old=arg("--old"),next=arg("--new");
if(!old||!next) throw new Error("usage: compare-roll-evidence --old old.json --new new.json [--review review.json] [--out report.json]");
const load=<T>(p:string)=>JSON.parse(readFileSync(resolve(p),"utf8")) as T;
const hydrate=(path:string):RollArtifact=>{const manifest=load<RollArtifact>(path);const base=dirname(resolve(path));manifest.reportPayloads=Object.fromEntries(manifest.reports.flatMap(report=>{const file=(report as {reportFile?:string}).reportFile;const candidate=file?resolve(base,file):"";return file&&existsSync(candidate)?[[report.area,load<unknown>(candidate)]]:[]}));return manifest};
const result=compareRollArtifacts(hydrate(old),hydrate(next),arg("--review")?load<RollReview>(arg("--review")!):undefined); const text=JSON.stringify(result,null,2)+"\n";
if(arg("--out")) writeFileSync(resolve(arg("--out")!),text); else process.stdout.write(text); if(!result.pass) process.exitCode=1;

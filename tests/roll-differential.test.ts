import { describe,expect,it } from "vitest"; import { compareRollArtifacts,type RollArtifact } from "../src/review/roll-differential.js";
const artifact=(revision:string,payload:unknown):RollArtifact=>({environmentFingerprint:{chromium:{version:revision,launchFlags:[]},host:{os:"linux"},runtimes:{chromiumSource:revision,harfbuzzSource:revision,skiaPinned:revision,node:"v22"},fingerprint:revision},reports:[{area:"paint",status:"passed"}],reportPayloads:{paint:payload},visuals:{representative:{digest:String(payload)}}});
describe("roll differential",()=>{
 it("requires source review and updated rows",()=>{expect(compareRollArtifacts(artifact("old",1),artifact("new",2)).missingReviews).toEqual(["paint"]);expect(compareRollArtifacts(artifact("old",1),artifact("new",2),{reviewedAreas:{paint:{sourceRefs:["chromium/x.cc:10"],updatedRows:["row"],classification:"upstream-drift"}}}).pass).toBe(true)});
 it("rejects incomparable environments",()=>{const n=artifact("new",1);(n.environmentFingerprint.host as Record<string,unknown>).os="darwin";expect(compareRollArtifacts(artifact("old",1),n).pass).toBe(false)});
 it("allows reviewed representation-only changes",()=>expect(compareRollArtifacts(artifact("old",1),artifact("new",2),{reviewedAreas:{paint:{sourceRefs:["skia/x.cc:1"],updatedRows:[],classification:"no-semantic-change"}}}).pass).toBe(true));
});

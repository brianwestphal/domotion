import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { validatePingFangDescriptorArtifact } from "./pingfang-live-descriptor-schema.mjs";

const legacySchema = z.object({
  schemaVersion: z.literal(1),
  environment: z.record(z.string(), z.unknown()),
  codepoints: z.array(z.number().int()),
  coldProcesses: z.array(z.unknown()),
  warmProcess: z.unknown(),
  browserRows: z.array(z.unknown()),
});

const dataSchema = legacySchema.extend({ outcome: z.literal("pass") });
const envelopeSchema = z.object({
  schemaVersion: z.literal(1),
  tool: z.literal("pingfang-live-descriptor-oracle"),
  generatedAt: z.iso.datetime({ offset: true }),
  env: z.record(z.string(), z.unknown()),
  data: dataSchema,
});

export function readPingFangDescriptorReport(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (raw != null && typeof raw === "object" && ("tool" in raw || "data" in raw)) {
    const data = envelopeSchema.parse(raw).data;
    validatePingFangDescriptorArtifact(data);
    return data;
  }
  if (raw?.schemaVersion !== 1) throw new Error("unsupported legacy PingFang descriptor report version");
  const legacy = legacySchema.parse(raw);
  validatePingFangDescriptorArtifact(legacy);
  return { ...legacy, outcome: "pass" };
}

export function writePingFangDescriptorReport(path, artifact) {
  const data = dataSchema.parse({ ...artifact, outcome: "pass" });
  validatePingFangDescriptorArtifact(data);
  const envelope = {
    schemaVersion: 1,
    tool: "pingfang-live-descriptor-oracle",
    generatedAt: new Date().toISOString(),
    env: artifact.environment,
    data,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(envelope, null, 2)}\n`);
  return envelope;
}

import { parse as parseYaml } from "yaml";

export const metadataFields = ["id", "title", "kind", "status", "owners", "platforms", "tickets", "code", "aliases"];

export function parseDocument(filename, source) {
  if (!source.startsWith("---\n")) return { metadata: null, body: source };
  const end = source.indexOf("\n---\n", 4);
  if (end < 0) throw new Error(`${filename}: unterminated front matter`);

  let metadata;
  try {
    metadata = parseYaml(source.slice(4, end), { strict: true, uniqueKeys: true });
  } catch (cause) {
    throw new Error(`${filename}: invalid front matter`, { cause });
  }
  if (metadata == null || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(`${filename}: front matter must be a mapping`);
  }
  for (const field of Object.keys(metadata)) {
    if (!metadataFields.includes(field)) throw new Error(`${filename}: unknown metadata field ${field}`);
  }

  return { metadata, body: source.slice(end + 5).replace(/^\n/, "") };
}

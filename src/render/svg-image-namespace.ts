export interface ImageNamespace {
  sourcePrefix: string;
  wrapperPrefix: string;
}

/** DM-R7ME85: an owner is an opaque unique token, not a string prefix.
 * Encode every UTF16 code unit reversibly, with an explicit length and
 * terminators outside the hex alphabet. Owner encodings are prefix-free:
 * neither an authored suffix nor another owner's longer token can bridge
 * their boundary. Source identities and generated wrappers occupy disjoint
 * tagged domains. No digest, random value or guessed long prefix is needed.
 *
 * UTF16LE preserves even lone surrogate code units in caller tokens. The
 * result is an ASCII CSS identifier and introduces no SMIL offset syntax.
 * Callers must still supply distinct owner tokens within a document.
 */
export function resolveImageNamespace(owner: string): ImageNamespace {
  const encoded = `dmi${owner.length}_${Buffer.from(owner, "utf16le").toString("hex")}_`;
  return { sourcePrefix: encoded + "s_", wrapperPrefix: encoded + "w_" };
}

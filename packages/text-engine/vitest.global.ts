import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export default function setup(): void {
  process.chdir(resolve(fileURLToPath(new URL(".", import.meta.url)), "..", ".."));
}

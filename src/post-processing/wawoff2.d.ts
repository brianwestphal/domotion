declare module "wawoff2" {
  export function compress(bytes: Uint8Array): Promise<Uint8Array>;
  export function decompress(bytes: Uint8Array): Promise<Uint8Array>;
}

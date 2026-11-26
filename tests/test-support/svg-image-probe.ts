import type { Page } from "@playwright/test";

/** Alpha coverage across row 5, which contains the probe and no text. */
export async function nativeSvgProbeRow(page: Page, source: string, scale = 1): Promise<number[]> {
  return page.evaluate(
    async ({ source, scale }) => {
      const image = new Image();
      image.src = `data:image/svg+xml,${encodeURIComponent(source)}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 90 * scale;
      canvas.height = 40 * scale;
      const context = canvas.getContext("2d")!;
      context.scale(scale, scale);
      context.drawImage(image, 0, 0);
      const row = context.getImageData(0, 5 * scale, canvas.width, 1).data;
      return [...row].filter((_, index) => index % 4 === 3);
    },
    { source, scale },
  );
}

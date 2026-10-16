import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { pngSize } from "../src/capture.js";
import { composeEvidence, cropRegion } from "../src/evidence.js";

async function makeShot(dir: string): Promise<string> {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 600, height: 400 } });
  await page.setContent(`<body style="margin:0;background:#fff"><div style="position:absolute;left:100px;top:100px;width:80px;height:40px;background:#08f"></div></body>`);
  const path = join(dir, "shot.png");
  await page.screenshot({ path });
  await browser.close();
  return path;
}

async function hasRed(png: string): Promise<boolean> {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const b64 = readFileSync(png).toString("base64");
  const found = await page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 60 && d[i + 2] < 60) return true;
    return false;
  }, b64);
  await browser.close();
  return found;
}

describe("evidence", () => {
  it("cropRegion pads the bbox, scales by dpr and clamps to the image", () => {
    const r = cropRegion({ width: 1000, height: 800 }, { x: 10, y: 10, w: 100, h: 50 }, 2);
    expect(r.cx).toBe(0);
    expect(r.bx).toBe(20);
    expect(r.bw).toBe(200);
    expect(r.cw).toBeLessThanOrEqual(1000);
    const none = cropRegion({ width: 500, height: 300 }, undefined, 1);
    expect(none).toMatchObject({ cx: 0, cy: 0, cw: 500, ch: 300, bw: 0 });
  });

  it("draws a red box around the issue and writes a PNG", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uat-ev-"));
    const shot = await makeShot(dir);
    const out = join(dir, "nested", "U-1.png");
    await composeEvidence([{ screenshot: shot, bbox: { x: 100, y: 100, w: 80, h: 40 }, dpr: 1, out, label: "U-1 Badge border missing" }]);
    expect(existsSync(out)).toBe(true);
    expect(pngSize(readFileSync(out)).width).toBeGreaterThan(100);
    expect(await hasRed(out)).toBe(true);
  }, 60000);

  it("a row without a bbox still gets an image, with no red box", async () => {
    const dir = mkdtempSync(join(tmpdir(), "uat-ev-"));
    const shot = await makeShot(dir);
    const out = join(dir, "U-2.png");
    await composeEvidence([{ screenshot: shot, dpr: 1, out, label: "U-2 no bbox" }]);
    expect(existsSync(out)).toBe(true);
    expect(await hasRed(out)).toBe(false);
  }, 60000);
});

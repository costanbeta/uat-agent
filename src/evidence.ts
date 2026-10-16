import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { pngSize } from "./capture.js";
import type { BBox } from "./judge.js";

export interface EvidenceItem {
  screenshot: string;
  bbox?: BBox;
  dpr: number;
  out: string;
  label: string;
  box?: boolean;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function cropRegion(size: { width: number; height: number }, bbox: BBox | undefined, dpr: number, pad = 48) {
  if (!bbox) {
    const w = Math.min(size.width, 1400);
    const h = Math.min(size.height, 900);
    return { cx: 0, cy: 0, cw: w, ch: h, bx: 0, by: 0, bw: 0, bh: 0 };
  }
  const bx = bbox.x * dpr;
  const by = bbox.y * dpr;
  const bw = bbox.w * dpr;
  const bh = bbox.h * dpr;
  const cx = Math.max(0, Math.floor(bx - pad * dpr));
  const cy = Math.max(0, Math.floor(by - pad * dpr));
  const cw = Math.min(size.width - cx, Math.min(Math.ceil(bw + 2 * pad * dpr), 1400));
  const ch = Math.min(size.height - cy, Math.min(Math.ceil(bh + 2 * pad * dpr), 900));
  return { cx, cy, cw: Math.max(cw, 1), ch: Math.max(ch, 1), bx, by, bw, bh };
}

export async function composeEvidence(items: EvidenceItem[]): Promise<void> {
  if (items.length === 0) return;
  const browser = await chromium.launch({ headless: true });
  try {
    for (const item of items) {
      const buf = readFileSync(item.screenshot);
      const size = pngSize(buf);
      const r = cropRegion(size, item.bbox, item.dpr);
      const page = await browser.newPage({ viewport: { width: Math.max(r.cw + 24, 400), height: r.ch + 80 } });
      const showBox = item.box !== false && item.bbox;
      const html = `<body style="margin:0;background:#fff;font:14px system-ui,sans-serif">
<div id="c" style="display:inline-block;padding:8px">
<div style="margin-bottom:6px;font-weight:600">${esc(item.label)}</div>
<div style="position:relative;width:${r.cw}px;height:${r.ch}px;overflow:hidden;border:1px solid #bbb">
<img src="data:image/png;base64,${buf.toString("base64")}" style="position:absolute;left:-${r.cx}px;top:-${r.cy}px;width:${size.width}px;height:${size.height}px">
${showBox ? `<div style="position:absolute;left:${r.bx - r.cx}px;top:${r.by - r.cy}px;width:${r.bw}px;height:${r.bh}px;border:3px solid #e11;box-sizing:border-box"></div>` : ""}
</div></div></body>`;
      await page.setContent(html);
      mkdirSync(dirname(item.out), { recursive: true });
      await page.locator("#c").screenshot({ path: item.out });
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

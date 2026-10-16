import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page, type Response } from "playwright";
import { parse as parseYaml } from "yaml";
import { fingerprintOf, type BBox, type DomElement } from "./judge.js";

export class GuardError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "GuardError";
  }
}

export interface CaptureOptions {
  url: string;
  expect: string;
  origins: string[];
  profileDir: string;
  outDir: string;
  width: number;
  height?: number;
  dpr?: number;
  actionsPath?: string;
  allowPost?: string[];
  allowFinalPath?: string[];
  allowPasswordField?: boolean;
  maxElements?: number;
  probeSelectors?: string[];
  headed?: boolean;
  navTimeoutMs?: number;
}

export interface BlockedRequest {
  method: string;
  url: string;
  reason: string;
}

export interface CaptureReport {
  url: string;
  finalUrl: string;
  status: number | null;
  width: number;
  height: number;
  dpr: number;
  screenshot: string;
  screenshotSize: { width: number; height: number };
  dom: string;
  probes?: string;
  blocked: BlockedRequest[];
  allowedPosts: string[];
  warnings: string[];
  actionsHash: string;
  capturedAt: string;
  config: {
    expect: string;
    origins: string[];
    allowPost: string[];
    allowFinalPath: string[];
    allowPasswordField: boolean;
    actionsPath?: string;
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DESTRUCTIVE_TEXT = /delete|remove|confirm|submit/i;

export function normalizePath(p: string): string {
  let path = p;
  try {
    path = decodeURIComponent(p);
  } catch {
    /* keep raw */
  }
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path || "/";
}

export function pathIsClean(p: string): boolean {
  return !p.includes("//") && !p.split("/").includes("..");
}

export function normalizeUrlForCompare(u: string): string {
  const url = new URL(u);
  return `${url.origin}${normalizePath(url.pathname)}`;
}

export interface GuardDecision {
  action: "continue" | "abort";
  reason?: string;
  allowedPost?: string;
}

export interface GuardConfig {
  origins: Set<string>;
  allowPost: Set<string>;
}

export function decideRequest(
  req: { method: string; url: string; headers: Record<string, string>; isNavigation: boolean },
  cfg: GuardConfig,
): GuardDecision {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return { action: "continue" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { action: "continue" };
  const method = req.method.toUpperCase();
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (headers["x-http-method-override"] || headers["x-method-override"] || url.searchParams.has("_method")) {
    return { action: "abort", reason: "method override header or _method parameter" };
  }
  if (req.isNavigation && !cfg.origins.has(url.origin)) {
    return { action: "abort", reason: `navigation to origin outside staging.config: ${url.origin}` };
  }
  if (SAFE_METHODS.has(method)) return { action: "continue" };
  if (method === "POST") {
    const normalized = normalizePath(url.pathname);
    if (!pathIsClean(url.pathname) || !pathIsClean(normalized) || /%2f|%5c|%2e/i.test(url.pathname)) {
      return { action: "abort", reason: "POST path contains //, .. or encoded slash/dot" };
    }
    const key = `${url.origin}${normalized}`;
    if (cfg.allowPost.has(key)) return { action: "continue", allowedPost: key };
    return { action: "abort", reason: "POST not in --allow-post" };
  }
  return { action: "abort", reason: `write method ${method}` };
}

export function resolveAllowPost(entries: string[], origins: string[], pageOrigin: string): Set<string> {
  const out = new Set<string>();
  for (const e of entries) {
    if (/^https?:\/\//.test(e)) {
      const u = new URL(e);
      out.add(`${u.origin}${normalizePath(u.pathname)}`);
    } else {
      out.add(`${pageOrigin}${normalizePath(e)}`);
    }
  }
  void origins;
  return out;
}

async function installNetworkGuard(context: BrowserContext, cfg: GuardConfig, blocked: BlockedRequest[], allowedPosts: string[]) {
  await context.route("**/*", async (route) => {
    const req = route.request();
    const decision = decideRequest(
      { method: req.method(), url: req.url(), headers: req.headers(), isNavigation: req.isNavigationRequest() },
      cfg,
    );
    if (decision.action === "abort") {
      blocked.push({ method: req.method(), url: req.url(), reason: decision.reason ?? "blocked" });
      await route.abort("blockedbyclient");
      return;
    }
    if (decision.allowedPost) allowedPosts.push(decision.allowedPost);
    await route.continue();
  });
}

async function checkGuards(page: Page, response: Response | null, opts: CaptureOptions, when: string) {
  const final = page.url();
  const want = normalizeUrlForCompare(opts.url);
  const got = normalizeUrlForCompare(final);
  const wantUrl = new URL(want);
  const allowFinal = new Set((opts.allowFinalPath ?? []).map((p) => `${wantUrl.origin}${normalizePath(p)}`));
  if (got !== want && !allowFinal.has(got)) {
    throw new GuardError("wrong-page", `${when}: landed on ${got}, expected ${want} (a login redirect?). Re-run \`uat login\` if your session expired.`);
  }
  const status = response?.status() ?? null;
  if (status !== null && status >= 400) throw new GuardError("bad-status", `${when}: page returned HTTP ${status}`);
  if (!opts.allowPasswordField && (await page.locator("input[type=password]").count()) > 0) {
    throw new GuardError("login-signal", `${when}: a password input is on the page (looks like a login screen). Use --allow-password-field only if this screen really has one.`);
  }
  try {
    await page.locator(opts.expect).first().waitFor({ state: "visible", timeout: 10000 });
  } catch {
    throw new GuardError("missing-landmark", `${when}: the --expect landmark ${opts.expect} did not appear`);
  }
}

interface ActionStep {
  hover?: string;
  click?: string;
  wait?: number;
  allow_destructive?: boolean;
}

export function loadActions(path?: string): { steps: ActionStep[]; hash: string } {
  if (!path) return { steps: [], hash: "none" };
  const text = readFileSync(path, "utf8");
  const parsed = parseYaml(text);
  if (!Array.isArray(parsed)) throw new Error(`action file ${path} must be a YAML list of steps`);
  return { steps: parsed as ActionStep[], hash: createHash("sha1").update(text).digest("hex").slice(0, 16) };
}

async function runActions(page: Page, steps: ActionStep[], warnings: string[]) {
  for (const [i, step] of steps.entries()) {
    if (step.wait !== undefined) {
      await page.waitForTimeout(Math.min(step.wait, 10000));
    } else if (step.hover) {
      await page.locator(step.hover).first().hover({ timeout: 8000 });
    } else if (step.click) {
      const el = page.locator(step.click).first();
      const label = ((await el.innerText({ timeout: 8000 }).catch(() => "")) + " " + ((await el.getAttribute("aria-label").catch(() => "")) ?? "")).trim();
      if (DESTRUCTIVE_TEXT.test(label) && !step.allow_destructive) {
        throw new GuardError("destructive-click", `action step ${i + 1}: "${label}" looks destructive; set allow_destructive: true in the action file to click it (writes are still blocked at the network layer)`);
      }
      await el.click({ timeout: 8000 });
    } else {
      warnings.push(`action step ${i + 1} ignored: unknown step`);
    }
    await page.waitForTimeout(300);
  }
}

const PAGE_SCRIPT = `
(args) => {
  const SKIP = new Set(["SCRIPT","STYLE","META","LINK","NOSCRIPT","HEAD","TITLE","BR","HTML"]);
  const STYLE_KEYS = ["color","backgroundColor","fontSize","fontWeight","fontFamily","lineHeight","letterSpacing","borderTopWidth","borderTopStyle","borderTopColor","borderRadius","paddingTop","paddingRight","paddingBottom","paddingLeft","marginTop","marginBottom","display","opacity"];
  const cssPath = (el) => {
    if (el.id) {
      const s = "#" + CSS.escape(el.id);
      if (document.querySelectorAll(s).length === 1) return s;
    }
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(" > ");
  };
  const ownText = (el) => {
    if (["INPUT","TEXTAREA","SELECT"].includes(el.tagName)) return "";
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.textContent;
    return t.replace(/\\s+/g, " ").trim().slice(0, 80);
  };
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round((r.left + window.scrollX) * 10) / 10, y: Math.round((r.top + window.scrollY) * 10) / 10, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
  };
  const elements = [];
  let truncated = false;
  for (const el of document.body.querySelectorAll("*")) {
    if (SKIP.has(el.tagName)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    const b = rectOf(el);
    if (b.w <= 0 || b.h <= 0) continue;
    if (elements.length >= args.max) { truncated = true; break; }
    const selector = cssPath(el);
    const styles = {};
    for (const k of STYLE_KEYS) styles[k] = cs[k];
    elements.push({ selector, tag: el.tagName.toLowerCase(), text: ownText(el), bbox: b, unique: document.querySelectorAll(selector).length === 1, styles });
  }
  const probes = {};
  for (const sel of args.probes) {
    let list = [];
    try { list = Array.from(document.querySelectorAll(sel)); } catch (e) { list = []; }
    const first = list[0];
    probes[sel] = { count: list.length, tag: first ? first.tagName.toLowerCase() : undefined, text: first ? ownText(first) : undefined, bbox: first ? rectOf(first) : undefined };
  }
  return { elements, truncated, probes };
}
`;

export async function capture(opts: CaptureOptions): Promise<CaptureReport> {
  const dpr = opts.dpr ?? 1;
  const height = opts.height ?? 900;
  const pageOrigin = new URL(opts.url).origin;
  if (!opts.origins.includes(pageOrigin)) {
    throw new GuardError("origin-not-allowed", `${pageOrigin} is not listed in staging.config; add it only if it is a staging environment`);
  }
  mkdirSync(opts.outDir, { recursive: true });
  mkdirSync(opts.profileDir, { recursive: true });
  const { steps, hash } = loadActions(opts.actionsPath);
  const blocked: BlockedRequest[] = [];
  const allowedPosts: string[] = [];
  const warnings: string[] = [];
  const cfg: GuardConfig = { origins: new Set(opts.origins), allowPost: resolveAllowPost(opts.allowPost ?? [], opts.origins, pageOrigin) };

  const context = await chromium.launchPersistentContext(opts.profileDir, {
    headless: !opts.headed,
    viewport: { width: opts.width, height },
    deviceScaleFactor: dpr,
  });
  try {
    await installNetworkGuard(context, cfg, blocked, allowedPosts);
    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultNavigationTimeout(opts.navTimeoutMs ?? 30000);
    const response = await page.goto(opts.url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => warnings.push("network did not go idle within 10s; continued"));
    await page.waitForTimeout(500);
    await checkGuards(page, response, opts, "after load");
    await runActions(page, steps, warnings);
    await page.waitForTimeout(300);
    await checkGuards(page, response, opts, "before screenshot");

    const screenshot = join(opts.outDir, "screenshot.png");
    await page.screenshot({ path: screenshot, fullPage: true });
    const size = pngSize(readFileSync(screenshot));
    const data = (await page.evaluate(`(${PAGE_SCRIPT})(${JSON.stringify({ max: opts.maxElements ?? 400, probes: opts.probeSelectors ?? [] })})`)) as {
      elements: (DomElement & { styles: Record<string, string> })[];
      truncated: boolean;
      probes: Record<string, { count: number; tag?: string; text?: string; bbox?: BBox }>;
    };
    if (data.truncated) warnings.push(`DOM dump truncated at ${opts.maxElements ?? 400} elements (--max-elements)`);
    const domPath = join(opts.outDir, "dom.json");
    writeFileSync(domPath, JSON.stringify({ elements: data.elements, truncated: data.truncated }, null, 2));
    let probesPath: string | undefined;
    if (opts.probeSelectors?.length) {
      const probes: Record<string, { count: number; fingerprint?: string; bbox?: BBox }> = {};
      for (const [sel, p] of Object.entries(data.probes)) {
        probes[sel] = { count: p.count, fingerprint: p.tag ? fingerprintOf(p.tag, p.text ?? "") : undefined, bbox: p.bbox };
      }
      probesPath = join(opts.outDir, "probes.json");
      writeFileSync(probesPath, JSON.stringify(probes, null, 2));
    }
    const report: CaptureReport = {
      url: opts.url,
      finalUrl: page.url(),
      status: response?.status() ?? null,
      width: opts.width,
      height,
      dpr,
      screenshot,
      screenshotSize: size,
      dom: domPath,
      probes: probesPath,
      blocked,
      allowedPosts,
      warnings,
      actionsHash: hash,
      capturedAt: new Date().toISOString(),
      config: {
        expect: opts.expect,
        origins: opts.origins,
        allowPost: opts.allowPost ?? [],
        allowFinalPath: opts.allowFinalPath ?? [],
        allowPasswordField: !!opts.allowPasswordField,
        actionsPath: opts.actionsPath,
      },
    };
    writeFileSync(join(opts.outDir, "report.json"), JSON.stringify(report, null, 2));
    return report;
  } finally {
    await context.close();
  }
}

export function pngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG file");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export async function login(opts: { url: string; expect: string; profileDir: string; origins: string[]; timeoutMs?: number }) {
  const origin = new URL(opts.url).origin;
  if (!opts.origins.includes(origin)) throw new GuardError("origin-not-allowed", `${origin} is not listed in staging.config`);
  mkdirSync(opts.profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(opts.profileDir, { headless: false });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(opts.url);
    await page.locator(opts.expect).first().waitFor({ state: "visible", timeout: opts.timeoutMs ?? 300000 });
  } finally {
    await context.close();
  }
}

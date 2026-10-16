import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { capture, decideRequest, GuardError, normalizePath, type CaptureOptions } from "../src/capture.js";
import { startFixture, type Fixture } from "./fixtures/server.js";

const cfg = (allowPost: string[] = []) => ({ origins: new Set(["https://staging.example.com"]), allowPost: new Set(allowPost) });
const req = (method: string, url: string, headers: Record<string, string> = {}, isNavigation = false) => ({ method, url, headers, isNavigation });

describe("decideRequest (write guard)", () => {
  it.each(["GET", "HEAD", "OPTIONS", "get"])("lets %s through", (m) => {
    expect(decideRequest(req(m, "https://cdn.other.com/x.js"), cfg()).action).toBe("continue");
  });

  it.each(["PUT", "PATCH", "DELETE", "patch", "delete", "FOO", "PROPFIND"])("aborts %s", (m) => {
    expect(decideRequest(req(m, "https://staging.example.com/api/x"), cfg()).action).toBe("abort");
  });

  it("aborts a POST unless its exact origin and normalized path is allowed", () => {
    const allowed = ["https://staging.example.com/api/search"];
    expect(decideRequest(req("POST", "https://staging.example.com/api/search"), cfg(allowed)).action).toBe("continue");
    expect(decideRequest(req("POST", "https://staging.example.com/api/search/"), cfg(allowed)).action).toBe("continue");
    expect(decideRequest(req("POST", "https://staging.example.com/api/search?x=1"), cfg(allowed)).action).toBe("continue");
    expect(decideRequest(req("POST", "https://staging.example.com/api/search/more"), cfg(allowed)).action).toBe("abort");
    expect(decideRequest(req("POST", "https://staging.example.com/api/delete"), cfg(allowed)).action).toBe("abort");
    expect(decideRequest(req("POST", "https://other.example.com/api/search"), cfg(allowed)).action).toBe("abort");
    expect(decideRequest(req("POST", "https://staging.example.com/api//search"), cfg(allowed)).action).toBe("abort");
    expect(decideRequest(req("POST", "https://staging.example.com/x/..%2fapi/search"), cfg(allowed)).action).toBe("abort");
    expect(decideRequest(req("POST", "https://staging.example.com/api%2Fsearch"), cfg(allowed)).action).toBe("abort");
  });

  it("aborts method overrides even on an allowed POST or a GET", () => {
    const allowed = ["https://staging.example.com/api/search"];
    expect(decideRequest(req("POST", "https://staging.example.com/api/search", { "X-HTTP-Method-Override": "DELETE" }), cfg(allowed)).action).toBe("abort");
    expect(decideRequest(req("GET", "https://staging.example.com/api/x?_method=DELETE"), cfg()).action).toBe("abort");
  });

  it("aborts navigation to an origin outside staging.config but allows its subresources", () => {
    expect(decideRequest(req("GET", "https://evil.example.com/", {}, true), cfg()).action).toBe("abort");
    expect(decideRequest(req("GET", "https://evil.example.com/x.png", {}, false), cfg()).action).toBe("continue");
  });

  it("normalizes paths", () => {
    expect(normalizePath("/a/b/")).toBe("/a/b");
    expect(normalizePath("/a%2Fb")).toBe("/a/b");
    expect(normalizePath("/")).toBe("/");
  });
});

describe("capture against the fixture server", () => {
  let fx: Fixture;
  const dirs: string[] = [];
  beforeAll(async () => {
    fx = await startFixture();
  });
  afterAll(async () => {
    await fx.close();
  });

  const opts = (path: string, over: Partial<CaptureOptions> = {}): CaptureOptions => {
    const base = mkdtempSync(join(tmpdir(), "uat-cap-"));
    dirs.push(base);
    return {
      url: `${fx.origin}${path}`,
      expect: "#app-ready",
      origins: [fx.origin],
      profileDir: join(base, "profile"),
      outDir: join(base, "out"),
      width: 1000,
      dpr: 1,
      ...over,
    };
  };

  it("captures a good screen: screenshot, DOM dump with unique selectors, report", async () => {
    const o = opts("/app");
    const report = await capture(o);
    expect(report.status).toBe(200);
    expect(existsSync(report.screenshot)).toBe(true);
    expect(report.screenshotSize.width).toBe(1000);
    const dom = JSON.parse(readFileSync(report.dom, "utf8"));
    const badge = dom.elements.find((e: any) => e.selector === "#badge");
    expect(badge).toBeDefined();
    expect(badge.unique).toBe(true);
    expect(badge.text).toBe("Active");
    expect(badge.styles.borderTopWidth).toBe("0px");
    expect(report.config.expect).toBe("#app-ready");
  }, 60000);

  it("blocks writes at the network layer: the server never receives them, an allowed POST goes through", async () => {
    fx.received.length = 0;
    const report = await capture(opts("/app?writes=1", { allowPost: ["/api/search"] }));
    await new Promise((r) => setTimeout(r, 300));
    const methods = fx.received.map((r) => `${r.method} ${r.path}`);
    expect(methods).toContain("POST /api/search");
    expect(methods.filter((m) => /PATCH|PUT|DELETE|\/api\/delete|\/api\/override/i.test(m))).toEqual([]);
    expect(report.blocked.length).toBeGreaterThanOrEqual(4);
    expect(report.blocked.map((b) => b.reason).join(" ")).toMatch(/write method|POST not in --allow-post|override/);
    expect(report.allowedPosts).toContain(`${fx.origin}/api/search`);
  }, 60000);

  it("a click that fires a DELETE is blocked at the network and listed", async () => {
    fx.received.length = 0;
    const base = mkdtempSync(join(tmpdir(), "uat-act-"));
    const actions = join(base, "hover-trash.yaml");
    writeFileSync(actions, "- hover: '#badge'\n- click: '#trash'\n");
    const report = await capture(opts("/app", { actionsPath: actions }));
    expect(fx.received.filter((r) => r.method === "DELETE")).toEqual([]);
    expect(report.blocked.some((b) => b.method === "DELETE")).toBe(true);
    expect(report.actionsHash).not.toBe("none");
  }, 60000);

  it("refuses to click a button labelled Delete unless the action file allows it", async () => {
    const base = mkdtempSync(join(tmpdir(), "uat-act-"));
    const actions = join(base, "del.yaml");
    writeFileSync(actions, "- click: '#del'\n");
    await expect(capture(opts("/app", { actionsPath: actions }))).rejects.toMatchObject({ code: "destructive-click" });
  }, 60000);

  const aborts: [string, string, string, Partial<CaptureOptions>?][] = [
    ["login redirect", "/expired", "wrong-page", undefined],
    ["HTTP 404", "/gone", "bad-status", { allowFinalPath: [] }],
    ["missing landmark", "/nolandmark", "missing-landmark", undefined],
    ["password input", "/pw", "login-signal", undefined],
  ];
  it.each(aborts)("aborts on %s with zero output files", async (_name, path, code, over) => {
    const o = opts(path, over ?? {});
    await expect(capture(o)).rejects.toMatchObject({ name: "GuardError", code });
    expect(existsSync(join(o.outDir, "screenshot.png"))).toBe(false);
    expect(existsSync(join(o.outDir, "report.json"))).toBe(false);
  }, 60000);

  it("allows a password field when explicitly waived", async () => {
    const report = await capture(opts("/pw", { allowPasswordField: true }));
    expect(report.status).toBe(200);
  }, 60000);

  it("allows a known canonical redirect with --allow-final-path", async () => {
    const report = await capture(opts("/expired", { allowFinalPath: ["/login"], allowPasswordField: true }));
    expect(report.finalUrl).toContain("/login");
  }, 60000);

  it("refuses an origin that is not in staging.config before opening anything", async () => {
    const o = opts("/app", { origins: ["https://staging.example.com"] });
    await expect(capture(o)).rejects.toBeInstanceOf(GuardError);
    expect(existsSync(o.profileDir)).toBe(false);
  });

  it("probes selectors for recheck: counts and fingerprints", async () => {
    const report = await capture(opts("/app", { probeSelectors: ["#badge", "#nope", "button"] }));
    const probes = JSON.parse(readFileSync(report.probes!, "utf8"));
    expect(probes["#badge"].count).toBe(1);
    expect(probes["#badge"].fingerprint).toBeTruthy();
    expect(probes["#nope"].count).toBe(0);
    expect(probes["button"].count).toBe(2);
  }, 60000);

  it("the CLI rejects a capture without --expect and without staging.config", () => {
    const run = (args: string[]) => spawnSync("npx", ["tsx", "src/cli.ts", ...args], { encoding: "utf8", cwd: process.cwd() });
    const noExpect = run(["capture", "--url", `${fx.origin}/app`, "--out", join(tmpdir(), "uat-x"), "--width", "1000"]);
    expect(noExpect.status).toBe(1);
    expect(noExpect.stderr).toMatch(/missing required --expect/);
    const noConfig = run(["capture", "--url", `${fx.origin}/app`, "--expect", "#a", "--out", join(tmpdir(), "uat-x"), "--width", "1000", "--config", join(tmpdir(), "does-not-exist.config")]);
    expect(noConfig.status).toBe(2);
    expect(noConfig.stderr).toMatch(/no-staging-config/);
  }, 60000);
});

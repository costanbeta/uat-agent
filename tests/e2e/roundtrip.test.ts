import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCsv, readLatest, toCsv } from "../../src/sheet.js";
import { startFixture, type Fixture } from "../fixtures/server.js";

let fx: Fixture;
let work: string;
let root: string;
let profile: string;
let config: string;
const slug = "app.default";

function uat(args: string[]): Promise<{ status: number | null; json: any; stderr: string }> {
  return new Promise((resolve) => {
    execFile("npx", ["tsx", "src/cli.ts", ...args], { encoding: "utf8", cwd: process.cwd(), maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      let json: any;
      try {
        json = JSON.parse(stdout);
      } catch {
        json = undefined;
      }
      resolve({ status: err ? ((err as any).code as number) : 0, json, stderr });
    });
  });
}

const captureArgs = (out: string, extra: string[] = [], path = "/app") => [
  "capture", "--url", `${fx.origin}${path}`, "--expect", "#app-ready", "--out", out,
  "--width", "1000", "--profile", profile, "--config", config, ...extra,
];

beforeAll(async () => {
  fx = await startFixture();
  work = mkdtempSync(join(tmpdir(), "uat-e2e-"));
  root = join(work, "uat-out");
  profile = join(work, "profile");
  config = join(work, "staging.config");
  writeFileSync(config, JSON.stringify({ origins: [fx.origin] }));
});
afterAll(async () => {
  await fx.close();
});

describe("check -> sheet edit -> fix -> recheck -> regression", () => {
  let badgeId = "";
  let exported = "";

  it("round 1: capture, validate, write the sheet and evidence", async () => {
    const cap = await uat(captureArgs(join(work, "out1")));
    expect(cap.status, cap.stderr).toBe(0);
    expect(cap.json.slug).toBe(slug);
    const dom = JSON.parse(readFileSync(join(work, "out1", "dom.json"), "utf8"));
    const badge = dom.elements.find((e: any) => e.selector === "#badge");
    writeFileSync(
      join(work, "judgment.json"),
      JSON.stringify({
        issues: [
          { description: "Badge is missing its border (see https://figma.example/x)", section: "Agents", kind: "style", selector: "#badge", bbox: badge.bbox, confidence: 0.9, design_link: "https://figma.example/design?node-id=1-2" },
          { description: "Trash icon looks different from design", kind: "style", bbox: { x: 5, y: 5, w: 20, h: 20 }, confidence: 0.8 },
          { nonsense: true },
        ],
      }),
    );
    const val = await uat(["validate", "--judgment", join(work, "judgment.json"), "--capture", join(work, "out1"), "--out", join(work, "issues.json")]);
    expect(val.status, val.stderr).toBe(0);
    expect(val.json.issues).toBe(3);
    expect(val.json.rejected).toHaveLength(1);
    const issues = JSON.parse(readFileSync(join(work, "issues.json"), "utf8"));
    expect(issues[0].description).not.toMatch(/https?:/);

    const write = await uat(["check-write", "--root", root, "--capture", join(work, "out1"), "--issues", join(work, "issues.json")]);
    expect(write.status, write.stderr).toBe(0);
    expect(write.json.rows).toBe(3);
    const csv = parseCsv(readFileSync(write.json.csv, "utf8"));
    const h = csv[0];
    badgeId = csv[1][h.indexOf("UAT ID")];
    expect(badgeId).toBe(`U-${slug}-0001`);
    for (const row of csv.slice(1)) expect(existsSync(join(root, slug, "evidence", "round1", `${row[h.indexOf("UAT ID")]}.png`))).toBe(true);
    exported = join(work, "exported1.csv");
    // the human sorts the sheet, edits a description, sets Dev Status
    const t = csv.map((r) => [...r]);
    const body = t.slice(1).reverse();
    for (const r of body) if (r[h.indexOf("UAT ID")] === badgeId) r[h.indexOf("Dev Status")] = "Done";
    body[0][0] = "Reworded by a human";
    writeFileSync(exported, toCsv([t[0], ...body]));
  }, 120000);

  it("round 2: after the dev fix, recheck marks the badge fixed and keeps human edits", async () => {
    fx.state.fixed = true;
    const cap = await uat(captureArgs(join(work, "out2"), ["--screen", slug, "--root", root]));
    expect(cap.status, cap.stderr).toBe(0);
    const plan = await uat(["recheck-plan", "--root", root, "--screen", slug, "--csv", exported, "--capture", join(work, "out2"), "--out", join(work, "plan.json")]);
    expect(plan.status, plan.stderr).toBe(0);
    expect(plan.json.toJudge).toBe(1);
    expect(plan.json.cantTell).toBe(2);
    const planFile = JSON.parse(readFileSync(join(work, "plan.json"), "utf8"));
    expect(existsSync(planFile.toJudge[0].newCrop)).toBe(true);
    expect(existsSync(planFile.toJudge[0].oldEvidence)).toBe(true);

    writeFileSync(join(work, "verdicts.json"), JSON.stringify([{ id: badgeId, verdict: "fixed", reason: "border now present" }]));
    const out = await uat(["recheck-write", "--root", root, "--screen", slug, "--plan", join(work, "plan.json"), "--verdicts", join(work, "verdicts.json"), "--csv", exported]);
    expect(out.status, out.stderr).toBe(0);
    expect(out.json.summary.fixed).toBe(1);
    const csv = parseCsv(readFileSync(out.json.csv, "utf8"));
    const h = csv[0];
    const row = csv.find((r) => r[h.indexOf("UAT ID")] === badgeId)!;
    expect(row[h.indexOf("Tool verdict (round 2)")]).toBe("fixed");
    expect(row[h.indexOf("Dev Status")]).toBe("Done");
    expect(readLatest(root, slug)?.round).toBe(2);
    exported = out.json.csv;
  }, 180000);

  it("round 3: the fix regresses and the badge shows as regressed", async () => {
    fx.state.fixed = false;
    const cap = await uat(captureArgs(join(work, "out3"), ["--screen", slug, "--root", root]));
    expect(cap.status, cap.stderr).toBe(0);
    const plan = await uat(["recheck-plan", "--root", root, "--screen", slug, "--csv", exported, "--capture", join(work, "out3"), "--out", join(work, "plan3.json")]);
    expect(plan.status, plan.stderr).toBe(0);
    writeFileSync(join(work, "verdicts3.json"), JSON.stringify([{ id: badgeId, verdict: "still broken", reason: "border gone" }]));
    const out = await uat(["recheck-write", "--root", root, "--screen", slug, "--plan", join(work, "plan3.json"), "--verdicts", join(work, "verdicts3.json"), "--csv", exported]);
    expect(out.status, out.stderr).toBe(0);
    expect(out.json.summary.regressed).toBe(1);
  }, 180000);

  it("an expired login during recheck aborts and leaves the ledger untouched", async () => {
    const before = readLatest(root, slug)!.runId;
    const cap = await uat(captureArgs(join(work, "out4"), ["--screen", slug, "--root", root], "/expired"));
    expect(cap.status).toBe(2);
    expect(cap.stderr).toMatch(/wrong-page/);
    expect(existsSync(join(work, "out4", "screenshot.png"))).toBe(false);
    expect(readLatest(root, slug)!.runId).toBe(before);
  }, 120000);

  it("a second round 1 on the same screen is refused unless --restart", async () => {
    const again = await uat(["check-write", "--root", root, "--capture", join(work, "out1"), "--issues", join(work, "issues.json")]);
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/already has a ledger/);
  }, 60000);
});

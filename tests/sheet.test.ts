import { mkdtempSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { JudgedRow } from "../src/judge.js";
import {
  SENTINEL,
  applyRecheck,
  makeId,
  parseCsv,
  parseId,
  planRecheck,
  protectCell,
  readLatest,
  slugFor,
  toCsv,
  unprotectCell,
  setLinks,
  writeRound1,
  type CaptureConfig,
  type Probe,
  type WriteStep,
} from "../src/sheet.js";

const cap: CaptureConfig = {
  url: "http://x/app",
  expect: "#ready",
  origins: ["http://x"],
  allowPost: [],
  allowFinalPath: [],
  allowPasswordField: false,
  actionsHash: "none",
  rulesHash: "none",
  width: 1280,
  height: 900,
  dpr: 1,
  capturedAt: "2026-01-01T00:00:00Z",
};

const row = (description: string, selector?: string, extra: Partial<JudgedRow> = {}): JudgedRow => ({
  description,
  section: "Agents",
  priority: "High",
  designLink: "https://figma/x",
  kind: "style",
  selector,
  fingerprint: selector ? `fp-${selector}` : undefined,
  bbox: { x: 1, y: 2, w: 30, h: 10 },
  needsHumanLook: "",
  ...extra,
});

const tmp = () => mkdtempSync(join(tmpdir(), "uat-sheet-"));
const slug = "app.default";

function setup(rows: JudgedRow[] = [row("Badge border missing", "#badge"), row("Wrong icon", "#icon"), row("Bare bbox row")]) {
  const root = tmp();
  const r1 = writeRound1({ root, slug, runId: "r1-a", capture: cap, rows });
  return { root, r1 };
}

describe("csv and quoting", () => {
  it("round-trips quotes, commas and newlines", () => {
    const rows = [["a", 'b,"c"', "line1\nline2"], ["", "x", "y"]];
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });

  it.each(["=SUM(A1)", "+1", "-1px border", "@cmd", "\tx", "\rx", "\nx", "  =HYPERLINK(\"x\")"])("protects %j and restores it exactly", (v) => {
    const p = protectCell(v);
    expect(p.startsWith(SENTINEL)).toBe(true);
    expect(unprotectCell(p)).toBe(v);
  });

  it("leaves normal text and a human-typed apostrophe alone", () => {
    expect(protectCell("Border missing")).toBe("Border missing");
    expect(unprotectCell("'Sentence case' label")).toBe("'Sentence case' label");
  });

  it("protects formula-like descriptions in the written CSV", () => {
    const { r1 } = setup([row("=IMPORTXML(\"http://evil\")", "#a")]);
    const text = readFileSync(r1.files.csvPath, "utf8");
    expect(text).toContain(SENTINEL + "=IMPORTXML");
  });
});

describe("ids and slugs", () => {
  it("builds and parses screen-namespaced ids, parsing from the last hyphen", () => {
    expect(slugFor("https://s.example.com/whatsapp/template-studio?x=1")).toBe("whatsapp-template-studio.default");
    expect(slugFor("https://s.example.com/a", "actions/hover-state.yaml")).toBe("a.hover-state");
    const id = makeId("whatsapp-template-studio.default", 7);
    expect(id).toBe("U-whatsapp-template-studio.default-0007");
    expect(parseId(id)).toEqual({ slug: "whatsapp-template-studio.default", n: 7 });
    expect(parseId("U-bad")).toBeUndefined();
    expect(parseId("X-1-0001")).toBeUndefined();
  });
});

describe("round 1", () => {
  it("writes a ledger, CSV with UAT ID, delta CSV and a latest pointer", () => {
    const { root, r1 } = setup();
    expect(r1.ids).toEqual([makeId(slug, 1), makeId(slug, 2), makeId(slug, 3)]);
    const csv = parseCsv(readFileSync(r1.files.csvPath, "utf8"));
    expect(csv[0]).toEqual(["Description", "Section", "Priority", "Reference link", "Design link", "Dev Status", "Comments", "UAT ID", "Needs human look", "Tool verdict (round 1)"]);
    expect(csv[1][7]).toBe(r1.ids[0]);
    expect(csv[1][3]).toBe("");
    const delta = parseCsv(readFileSync(r1.files.deltaPath, "utf8"));
    expect(delta[0]).toEqual(["UAT ID", "Tool verdict (round 1)", "Needs human look", "New row", "Description", "Section", "Priority", "Reference link", "Design link"]);
    expect(delta[1][3]).toBe("yes");
    expect(readLatest(root, slug)?.runId).toBe("r1-a");
  });

  it("refuses a second round 1 on the same screen unless --restart, and never reuses ids", () => {
    const { root } = setup();
    expect(() => writeRound1({ root, slug, runId: "r1-b", capture: cap, rows: [row("x", "#x")] })).toThrow(/already has a ledger/);
    const again = writeRound1({ root, slug, runId: "r1-c", capture: cap, rows: [row("x", "#x")], restart: true });
    expect(again.ids[0]).toBe(makeId(slug, 4));
  });
});

describe("crash safety", () => {
  const steps: WriteStep[] = ["after-ledger", "after-csv", "after-delta"];
  it.each(steps)("a crash %s leaves the previous round as latest and no temp files", (step) => {
    const { root } = setup();
    const before = readLatest(root, slug)!;
    const csv = readFileSync(join(root, slug, "r1-a.csv"), "utf8");
    const probes: Record<string, Probe> = {};
    const plan = planRecheck({ ledger: before, exportedCsv: csv, probes, current: { actionsHash: "none", width: 1280, dpr: 1 }, slugExists: () => false });
    expect(() =>
      applyRecheck({
        root,
        ledger: before,
        plan,
        verdicts: [],
        exportedCsv: csv,
        runId: "r2-x",
        hook: (s) => {
          if (s === step) throw new Error("injected crash");
        },
      }),
    ).toThrow(/injected crash/);
    expect(readLatest(root, slug)?.runId).toBe("r1-a");
    expect(readdirSync(join(root, slug)).filter((f) => f.includes(".tmp-"))).toEqual([]);
    expect(existsSync(join(root, slug, ".lock"))).toBe(false);
  });
});

function exportCsv(csvPath: string, edit?: (t: string[][]) => void): string {
  const t = parseCsv(readFileSync(csvPath, "utf8"));
  edit?.(t);
  return toCsv(t);
}

const okProbes = (): Record<string, Probe> => ({
  "#badge": { count: 1, fingerprint: "fp-#badge", bbox: { x: 1, y: 2, w: 30, h: 10 } },
  "#icon": { count: 1, fingerprint: "fp-#icon", bbox: { x: 1, y: 2, w: 30, h: 10 } },
});
const current = { actionsHash: "none", width: 1280, dpr: 1 };

describe("planRecheck", () => {
  it("joins on UAT ID after the sheet is sorted, reworded and given human values", () => {
    const { root, r1 } = setup();
    const csv = exportCsv(r1.files.csvPath, (t) => {
      const header = t[0];
      const body = t.slice(1).reverse();
      body[0][0] = "Reworded description";
      body[0][header.indexOf("Dev Status")] = "Done";
      t.splice(1, body.length, ...body);
    });
    const plan = planRecheck({ ledger: readLatest(root, slug)!, exportedCsv: csv, probes: okProbes(), current, slugExists: () => false });
    expect(plan.toJudge.map((e) => e.id).sort()).toEqual([r1.ids[0], r1.ids[1]].sort());
    expect(plan.cantTell.map((c) => c.id)).toEqual([r1.ids[2]]);
    expect(plan.cantTell[0].reason).toMatch(/no unique selector/);
  });

  it("returns can't tell for duplicates, blank ids, unknown formats and unknown ledger ids", () => {
    const { root, r1 } = setup();
    const csv = exportCsv(r1.files.csvPath, (t) => {
      const idc = t[0].indexOf("UAT ID");
      t.push([...t[1]]);
      const manual = new Array(t[0].length).fill("");
      manual[0] = "manual row";
      t.push(manual);
      const odd = [...t[2]];
      odd[idc] = "not-an-id";
      t.push(odd);
      const ghost = [...t[2]];
      ghost[idc] = makeId(slug, 99);
      t.push(ghost);
    });
    const plan = planRecheck({ ledger: readLatest(root, slug)!, exportedCsv: csv, probes: okProbes(), current, slugExists: () => false });
    const reasons = plan.cantTell.map((c) => c.reason).join(" | ");
    expect(reasons).toMatch(/duplicate UAT ID/);
    expect(reasons).toMatch(/no UAT ID/);
    expect(reasons).toMatch(/expected format/);
    expect(reasons).toMatch(/not in this screen's ledger/);
    expect(plan.toJudge.map((e) => e.id)).toEqual([r1.ids[1]]);
  });

  it("skips ids from other known screens and flags ids from unknown screens", () => {
    const { root, r1 } = setup();
    const csv = exportCsv(r1.files.csvPath, (t) => {
      const idc = t[0].indexOf("UAT ID");
      const known = [...t[1]];
      known[idc] = makeId("other.default", 1);
      const unknown = [...t[1]];
      unknown[idc] = makeId("ghost.default", 1);
      t.push(known, unknown);
    });
    const plan = planRecheck({ ledger: readLatest(root, slug)!, exportedCsv: csv, probes: okProbes(), current, slugExists: (s) => s === "other.default" });
    expect(plan.skipped.map((s) => s.id)).toContain(makeId("other.default", 1));
    expect(plan.cantTell.find((c) => c.id === makeId("ghost.default", 1))?.reason).toMatch(/no ledger/);
  });

  it("returns can't tell for every row when the capture configuration differs", () => {
    const { root, r1 } = setup();
    const csv = exportCsv(r1.files.csvPath);
    const plan = planRecheck({ ledger: readLatest(root, slug)!, exportedCsv: csv, probes: okProbes(), current: { actionsHash: "other", width: 1280, dpr: 1 }, slugExists: () => false });
    expect(plan.toJudge).toEqual([]);
    expect(plan.cantTell).toHaveLength(3);
    expect(plan.cantTell[0].reason).toMatch(/action file changed/);
  });

  it("returns can't tell when the selector is gone, ambiguous, or the element changed", () => {
    const { root, r1 } = setup();
    const csv = exportCsv(r1.files.csvPath);
    const probes: Record<string, Probe> = { "#badge": { count: 2, fingerprint: "fp-#badge" }, "#icon": { count: 1, fingerprint: "different" } };
    const plan = planRecheck({ ledger: readLatest(root, slug)!, exportedCsv: csv, probes, current, slugExists: () => false });
    expect(plan.toJudge).toEqual([]);
    expect(plan.cantTell.find((c) => c.id === r1.ids[0])?.reason).toMatch(/exactly one element/);
    expect(plan.cantTell.find((c) => c.id === r1.ids[1])?.reason).toMatch(/tag or text changed/);
  });

  it("returns can't tell when the row's Figma node hash changed", () => {
    const { root } = setup([row("x", "#badge", { figmaNode: "1:2" })]);
    const l = readLatest(root, slug)!;
    l.rows[Object.keys(l.rows)[0]].nodeHash = "old";
    const csv = toCsv([["UAT ID"], [Object.keys(l.rows)[0]]]);
    const plan = planRecheck({ ledger: l, exportedCsv: csv, probes: okProbes(), current, slugExists: () => false, nodeHashes: { "1:2": "new" } });
    expect(plan.cantTell[0].reason).toMatch(/Figma node changed/);
  });

  it("rejects an export with no UAT ID column", () => {
    const { root } = setup();
    expect(() => planRecheck({ ledger: readLatest(root, slug)!, exportedCsv: "Description\nx\n", probes: {}, current, slugExists: () => false })).toThrow(/UAT ID/);
  });
});

describe("applyRecheck", () => {
  it("writes round 2 verdicts, marks regressions, preserves human columns and appends new rows", () => {
    const { root, r1 } = setup();
    const csv1 = exportCsv(r1.files.csvPath, (t) => {
      t[1][t[0].indexOf("Dev Status")] = "Done";
      t[1][t[0].indexOf("Comments")] = "human comment, with comma";
    });
    const plan1 = planRecheck({ ledger: readLatest(root, slug)!, exportedCsv: csv1, probes: okProbes(), current, slugExists: () => false });
    const r2 = applyRecheck({
      root,
      ledger: readLatest(root, slug)!,
      plan: plan1,
      verdicts: [
        { id: r1.ids[0], verdict: "fixed", reason: "border now present" },
        { id: r1.ids[1], verdict: "still broken", reason: "icon unchanged" },
      ],
      exportedCsv: csv1,
      runId: "r2-a",
      newRows: [row("Brand new issue", "#new")],
    });
    expect(r2.summary).toMatchObject({ fixed: 1, "still broken": 1, "can't tell": 1, new: 1 });
    const out = parseCsv(readFileSync(r2.files.csvPath, "utf8"));
    const h = out[0];
    expect(h).toContain("Tool verdict (round 2)");
    const byId = (id: string) => out.find((r) => r[h.indexOf("UAT ID")] === id)!;
    expect(byId(r1.ids[0])[h.indexOf("Tool verdict (round 2)")]).toBe("fixed");
    expect(byId(r1.ids[0])[h.indexOf("Dev Status")]).toBe("Done");
    expect(byId(r1.ids[0])[h.indexOf("Comments")]).toBe("human comment, with comma");
    expect(byId(r1.ids[2])[h.indexOf("Needs human look")]).toMatch(/no unique selector/);
    expect(byId(makeId(slug, 4))[h.indexOf("Tool verdict (round 2)")]).toBe("new in round 2");
    expect(readLatest(root, slug)?.runId).toBe("r2-a");

    // round 3: the fixed row breaks again -> regressed
    const csv2 = readFileSync(r2.files.csvPath, "utf8");
    const plan2 = planRecheck({ ledger: readLatest(root, slug)!, exportedCsv: csv2, probes: { ...okProbes(), "#new": { count: 1, fingerprint: "fp-#new" } }, current, slugExists: () => false });
    const r3 = applyRecheck({
      root,
      ledger: readLatest(root, slug)!,
      plan: plan2,
      verdicts: [{ id: r1.ids[0], verdict: "still broken", reason: "border gone again" }],
      exportedCsv: csv2,
      runId: "r3-a",
    });
    expect(r3.summary.regressed).toBe(1);
    expect(r3.summary["can't tell"]).toBeGreaterThan(0);
    const l3 = readLatest(root, slug)!;
    expect(l3.counter).toBe(4);
  });

  it("marks a row can't tell when no verdict is returned for it", () => {
    const { root, r1 } = setup();
    const csv = exportCsv(r1.files.csvPath);
    const plan = planRecheck({ ledger: readLatest(root, slug)!, exportedCsv: csv, probes: okProbes(), current, slugExists: () => false });
    const r2 = applyRecheck({ root, ledger: readLatest(root, slug)!, plan, verdicts: [], exportedCsv: csv, runId: "r2-b" });
    expect(r2.ledger.rows[r1.ids[0]].verdicts["2"].verdict).toBe("can't tell");
  });

  it("refuses to apply a plan made against a ledger that has since moved on", () => {
    const { root, r1 } = setup();
    const csv = exportCsv(r1.files.csvPath);
    const stale = readLatest(root, slug)!;
    const plan = planRecheck({ ledger: stale, exportedCsv: csv, probes: okProbes(), current, slugExists: () => false });
    applyRecheck({ root, ledger: stale, plan, verdicts: [], exportedCsv: csv, runId: "r2-c" });
    expect(() => applyRecheck({ root, ledger: stale, plan, verdicts: [], exportedCsv: csv, runId: "r2-d" })).toThrow(/changed since the recheck plan/);
  });

  it("keeps ids unique and counters monotonic across screens by namespacing", () => {
    const a = writeRound1({ root: tmp(), slug: "a.default", runId: "r1", capture: cap, rows: [row("x", "#x")] });
    const b = writeRound1({ root: tmp(), slug: "b.default", runId: "r1", capture: cap, rows: [row("x", "#x")] });
    expect(a.ids[0]).not.toBe(b.ids[0]);
  });
});

describe("setLinks", () => {
  it("fills Reference link by UAT ID in the CSV and the delta, rejects non-https and reports unknown ids", () => {
    const { root, r1 } = setup();
    const res = setLinks(root, slug, { [r1.ids[0]]: "https://drive.example/a", "U-nope-0001": "https://x" });
    expect(res.updated).toEqual([r1.ids[0]]);
    expect(res.unknown).toEqual(["U-nope-0001"]);
    const csv = parseCsv(readFileSync(r1.files.csvPath, "utf8"));
    expect(csv[1][csv[0].indexOf("Reference link")]).toBe("https://drive.example/a");
    expect(csv[2][csv[0].indexOf("Reference link")]).toBe("");
    const delta = parseCsv(readFileSync(r1.files.deltaPath, "utf8"));
    expect(delta[1][delta[0].indexOf("Reference link")]).toBe("https://drive.example/a");
    expect(() => setLinks(root, slug, { [r1.ids[1]]: "file:///etc/passwd" })).toThrow(/https/);
  });
});

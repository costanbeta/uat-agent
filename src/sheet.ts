import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { BBox, JudgedRow } from "./judge.js";

export const BASE_COLUMNS = [
  "Description",
  "Section",
  "Priority",
  "Reference link",
  "Design link",
  "Dev Status",
  "Comments",
  "UAT ID",
  "Needs human look",
] as const;

export const verdictCol = (round: number) => `Tool verdict (round ${round})`;
export const SENTINEL = "'​";

export interface CaptureConfig {
  url: string;
  expect: string;
  origins: string[];
  allowPost: string[];
  allowFinalPath: string[];
  allowPasswordField: boolean;
  actionsPath?: string;
  actionsHash: string;
  rulesHash: string;
  width: number;
  height: number;
  dpr: number;
  figmaNode?: string;
  capturedAt: string;
}

export interface LedgerRow {
  id: string;
  description: string;
  section: string;
  kind: string;
  designLink: string;
  selector?: string;
  fingerprint?: string;
  bbox?: BBox;
  ruleId?: string;
  figmaNode?: string;
  nodeHash?: string;
  evidence: Record<string, string>;
  firstRound: number;
  verdicts: Record<string, { verdict: string; reason: string }>;
}

export interface Ledger {
  version: 1;
  slug: string;
  runId: string;
  round: number;
  createdAt: string;
  counter: number;
  capture: CaptureConfig;
  rows: Record<string, LedgerRow>;
}

/* ---------- CSV ---------- */

export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function toCsv(rows: string[][]): string {
  const q = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return rows.map((r) => r.map(q).join(",")).join("\n") + "\n";
}

export function protectCell(v: string): string {
  return /^(\s*[=+\-@]|[\t\r\n])/.test(v) ? SENTINEL + v : v;
}

export function unprotectCell(v: string): string {
  return v.startsWith(SENTINEL) ? v.slice(SENTINEL.length) : v;
}

/* ---------- ids and slugs ---------- */

export function slugFor(url: string, actionsPath?: string): string {
  const path = new URL(url).pathname.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "root";
  const stem = actionsPath ? basename(actionsPath, extname(actionsPath)).toLowerCase().replace(/[^a-z0-9]+/g, "-") : "default";
  return `${path}.${stem}`;
}

export function makeId(slug: string, n: number): string {
  return `U-${slug}-${String(n).padStart(4, "0")}`;
}

export function parseId(id: string): { slug: string; n: number } | undefined {
  if (!id.startsWith("U-")) return undefined;
  const last = id.lastIndexOf("-");
  if (last <= 2) return undefined;
  const n = Number(id.slice(last + 1));
  if (!Number.isInteger(n)) return undefined;
  return { slug: id.slice(2, last), n };
}

/* ---------- files, lock, atomic writes ---------- */

export function sleepSync(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withScreenLock<T>(root: string, slug: string, fn: () => T): T {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, ".lock");
  let tries = 0;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e: any) {
      if (e.code !== "EEXIST" || ++tries > 100) throw new Error(`could not take the lock for screen ${slug}: ${lock}`);
      sleepSync(100);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

export function writeAtomic(path: string, data: string) {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export type WriteStep = "after-ledger" | "after-csv" | "after-delta" | "after-pointer";

export interface RoundFiles {
  ledgerPath: string;
  csvPath: string;
  deltaPath: string;
}

export function writeRound(
  root: string,
  ledger: Ledger,
  csvRows: string[][],
  deltaRows: string[][],
  hook?: (step: WriteStep) => void,
): RoundFiles {
  const dir = join(root, ledger.slug);
  const files: RoundFiles = {
    ledgerPath: join(dir, `ledger.${ledger.runId}.json`),
    csvPath: join(dir, `${ledger.runId}.csv`),
    deltaPath: join(dir, `delta.${ledger.runId}.csv`),
  };
  writeAtomic(files.ledgerPath, JSON.stringify(ledger, null, 2));
  hook?.("after-ledger");
  writeAtomic(files.csvPath, toCsv(csvRows));
  hook?.("after-csv");
  writeAtomic(files.deltaPath, toCsv(deltaRows));
  hook?.("after-delta");
  writeAtomic(join(dir, "latest"), JSON.stringify({ runId: ledger.runId, round: ledger.round }));
  hook?.("after-pointer");
  return files;
}

export function readLatest(root: string, slug: string): Ledger | undefined {
  const pointer = join(root, slug, "latest");
  if (!existsSync(pointer)) return undefined;
  const { runId } = JSON.parse(readFileSync(pointer, "utf8"));
  return JSON.parse(readFileSync(join(root, slug, `ledger.${runId}.json`), "utf8")) as Ledger;
}

export function listSlugs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "latest")))
    .map((d) => d.name);
}

/* ---------- round 1 ---------- */

export interface Round1Input {
  root: string;
  slug: string;
  runId: string;
  capture: CaptureConfig;
  rows: JudgedRow[];
  nodeHashes?: Record<string, string>;
  restart?: boolean;
  hook?: (step: WriteStep) => void;
}

export interface Round1Result {
  ledger: Ledger;
  files: RoundFiles;
  ids: string[];
  csvRows: string[][];
}

export function newRowCells(row: JudgedRow, id: string): Record<string, string> {
  return {
    Description: row.description,
    Section: row.section,
    Priority: row.priority,
    "Reference link": "",
    "Design link": row.designLink,
    "Dev Status": "",
    Comments: "",
    "UAT ID": id,
    "Needs human look": row.needsHumanLook,
  };
}

export function writeRound1(input: Round1Input): Round1Result {
  return withScreenLock(input.root, input.slug, () => {
    const prior = readLatest(input.root, input.slug);
    if (prior && !input.restart) {
      throw new Error(
        `screen ${input.slug} already has a ledger (round ${prior.round}); use recheck, or pass --restart to start a new series (IDs are never reused)`,
      );
    }
    let counter = prior?.counter ?? 0;
    const ledger: Ledger = {
      version: 1,
      slug: input.slug,
      runId: input.runId,
      round: 1,
      createdAt: new Date().toISOString(),
      counter: 0,
      capture: input.capture,
      rows: {},
    };
    const ids: string[] = [];
    const header = [...BASE_COLUMNS, verdictCol(1)] as string[];
    const csvRows: string[][] = [header];
    for (const row of input.rows) {
      counter += 1;
      const id = makeId(input.slug, counter);
      ids.push(id);
      ledger.rows[id] = {
        id,
        description: row.description,
        section: row.section,
        kind: row.kind,
        designLink: row.designLink,
        selector: row.selector,
        fingerprint: row.fingerprint,
        bbox: row.bbox,
        ruleId: row.ruleId,
        figmaNode: row.figmaNode,
        nodeHash: row.figmaNode ? input.nodeHashes?.[row.figmaNode] : undefined,
        evidence: { "1": `evidence/round1/${id}.png` },
        firstRound: 1,
        verdicts: { "1": { verdict: "new in round 1", reason: "" } },
      };
      const cells = newRowCells(row, id);
      csvRows.push([...BASE_COLUMNS.map((c) => protectCell(cells[c])), "new in round 1"]);
    }
    ledger.counter = counter;
    const delta: string[][] = [deltaHeader(1), ...ids.map((id, i) => deltaRow(id, "new in round 1", input.rows[i].needsHumanLook, input.rows[i], true))];
    const files = writeRound(input.root, ledger, csvRows, delta, input.hook);
    return { ledger, files, ids, csvRows };
  });
}

export function deltaHeader(round: number): string[] {
  return ["UAT ID", verdictCol(round), "Needs human look", "New row", "Description", "Section", "Priority", "Reference link", "Design link"];
}

export function deltaRow(id: string, verdict: string, needs: string, row: JudgedRow | undefined, isNew: boolean): string[] {
  return [
    id,
    verdict,
    protectCell(needs),
    isNew ? "yes" : "",
    isNew && row ? protectCell(row.description) : "",
    isNew && row ? protectCell(row.section) : "",
    isNew && row ? row.priority : "",
    "",
    isNew && row ? row.designLink : "",
  ];
}

/* ---------- recheck ---------- */

export interface Probe {
  count: number;
  fingerprint?: string;
  bbox?: BBox;
}

export interface PlanEntry {
  id: string;
  description: string;
  designLink: string;
  selector: string;
  oldEvidence?: string;
  newBbox?: BBox;
  newCrop?: string;
}

export interface RecheckPlan {
  slug: string;
  fromRunId: string;
  fromRound: number;
  round: number;
  toJudge: PlanEntry[];
  cantTell: { id: string; reason: string; rowIndex?: number }[];
  skipped: { id: string; reason: string }[];
}

export interface PlanInput {
  ledger: Ledger;
  exportedCsv: string;
  probes: Record<string, Probe>;
  current: { actionsHash: string; width: number; dpr: number };
  slugExists: (slug: string) => boolean;
  nodeHashes?: Record<string, string>;
}

function colIndex(header: string[], name: string): number {
  return header.findIndex((h) => h.trim() === name);
}

export function planRecheck(input: PlanInput): RecheckPlan {
  const { ledger } = input;
  const table = parseCsv(input.exportedCsv);
  if (table.length === 0) throw new Error("exported CSV is empty");
  const header = table[0];
  const idCol = colIndex(header, "UAT ID");
  if (idCol < 0) throw new Error('exported CSV has no "UAT ID" column; export the sheet with that column included');

  const plan: RecheckPlan = {
    slug: ledger.slug,
    fromRunId: ledger.runId,
    fromRound: ledger.round,
    round: ledger.round + 1,
    toJudge: [],
    cantTell: [],
    skipped: [],
  };

  const seen = new Map<string, number[]>();
  table.slice(1).forEach((r, i) => {
    const id = (r[idCol] ?? "").trim();
    if (!id) return;
    seen.set(id, [...(seen.get(id) ?? []), i + 1]);
  });

  const cfgReasons: string[] = [];
  if (ledger.capture.actionsHash !== input.current.actionsHash) cfgReasons.push("action file changed since check");
  if (ledger.capture.width !== input.current.width || ledger.capture.dpr !== input.current.dpr) cfgReasons.push("viewport or device scale factor changed since check");
  const cfgReason = cfgReasons.join("; ");

  const handled = new Set<string>();
  table.slice(1).forEach((r, i) => {
    const rowIndex = i + 1;
    const id = (r[idCol] ?? "").trim();
    if (!id) {
      plan.cantTell.push({ id: `(row ${rowIndex + 1})`, rowIndex, reason: "row has no UAT ID (manual row, no ledger entry)" });
      return;
    }
    const parsed = parseId(id);
    if (!parsed) {
      plan.cantTell.push({ id, rowIndex, reason: "UAT ID is not in the expected format" });
      return;
    }
    if (parsed.slug !== ledger.slug) {
      if (input.slugExists(parsed.slug)) plan.skipped.push({ id, reason: `belongs to another screen (${parsed.slug})` });
      else plan.cantTell.push({ id, rowIndex, reason: `screen ${parsed.slug} has no ledger` });
      return;
    }
    if ((seen.get(id)?.length ?? 0) > 1) {
      plan.cantTell.push({ id, rowIndex, reason: "duplicate UAT ID in the sheet" });
      return;
    }
    const row = ledger.rows[id];
    if (!row) {
      plan.cantTell.push({ id, rowIndex, reason: "UAT ID is not in this screen's ledger" });
      return;
    }
    handled.add(id);
    if (cfgReason) {
      plan.cantTell.push({ id, rowIndex, reason: `capture configuration differs: ${cfgReason}` });
      return;
    }
    if (!row.selector) {
      plan.cantTell.push({ id, rowIndex, reason: "no unique selector was stored for this row" });
      return;
    }
    const probe = input.probes[row.selector];
    if (!probe || probe.count !== 1) {
      plan.cantTell.push({ id, rowIndex, reason: "selector no longer matches exactly one element" });
      return;
    }
    if (row.fingerprint && probe.fingerprint !== row.fingerprint) {
      plan.cantTell.push({ id, rowIndex, reason: "the element's tag or text changed since check" });
      return;
    }
    if (row.figmaNode && row.nodeHash && input.nodeHashes?.[row.figmaNode] && input.nodeHashes[row.figmaNode] !== row.nodeHash) {
      plan.cantTell.push({ id, rowIndex, reason: "the Figma node changed since check" });
      return;
    }
    const lastRound = Math.max(...Object.keys(row.evidence).map(Number), 0);
    plan.toJudge.push({
      id,
      description: row.description,
      designLink: row.designLink,
      selector: row.selector,
      oldEvidence: lastRound ? row.evidence[String(lastRound)] : undefined,
      newBbox: probe.bbox,
    });
  });
  for (const id of Object.keys(ledger.rows)) {
    if (!handled.has(id) && !plan.cantTell.some((c) => c.id === id) && !seen.has(id)) plan.skipped.push({ id, reason: "row no longer in the sheet export" });
  }
  return plan;
}

export interface Verdict {
  id: string;
  verdict: "fixed" | "still broken";
  reason: string;
}

export interface ApplyInput {
  root: string;
  ledger: Ledger;
  plan: RecheckPlan;
  verdicts: Verdict[];
  exportedCsv: string;
  runId: string;
  newRows?: JudgedRow[];
  hook?: (step: WriteStep) => void;
}

function lastVerdict(row: LedgerRow): string | undefined {
  const rounds = Object.keys(row.verdicts).map(Number).sort((a, b) => b - a);
  return rounds.length ? row.verdicts[String(rounds[0])].verdict : undefined;
}

export function applyRecheck(input: ApplyInput): { ledger: Ledger; files: RoundFiles; summary: Record<string, number> } {
  const { plan } = input;
  return withScreenLock(input.root, plan.slug, () => {
    const current = readLatest(input.root, plan.slug);
    if (!current || current.runId !== input.ledger.runId) {
      throw new Error("the screen's latest ledger changed since the recheck plan was made; run recheck-plan again");
    }
    const round = plan.round;
    const ledger: Ledger = JSON.parse(JSON.stringify(input.ledger));
    ledger.round = round;
    ledger.runId = input.runId;
    ledger.createdAt = new Date().toISOString();

    const result = new Map<string, { verdict: string; reason: string }>();
    const given = new Map(input.verdicts.map((v) => [v.id, v]));
    for (const entry of plan.toJudge) {
      const v = given.get(entry.id);
      if (!v) {
        result.set(entry.id, { verdict: "can't tell", reason: "no verdict was returned for this row" });
        continue;
      }
      const prev = lastVerdict(ledger.rows[entry.id]);
      const verdict = v.verdict === "still broken" && prev === "fixed" ? "regressed" : v.verdict;
      result.set(entry.id, { verdict, reason: v.reason.slice(0, 300) });
    }
    for (const c of plan.cantTell) result.set(c.id, { verdict: "can't tell", reason: c.reason });
    for (const [id, r] of result) if (ledger.rows[id]) ledger.rows[id].verdicts[String(round)] = r;
    for (const entry of plan.toJudge) ledger.rows[entry.id].evidence[String(round)] = `evidence/round${round}/${entry.id}.png`;

    const table = parseCsv(input.exportedCsv).map((r, i) => (i === 0 ? r : r.map(unprotectCell)));
    const header = table[0];
    const ensure = (name: string) => {
      let idx = colIndex(header, name);
      if (idx < 0) {
        header.push(name);
        for (const r of table.slice(1)) r.push("");
        idx = header.length - 1;
      }
      return idx;
    };
    const idCol = ensure("UAT ID");
    const needsCol = ensure("Needs human look");
    const vCol = ensure(verdictCol(round));
    const delta: string[][] = [deltaHeader(round)];
    const counts: Record<string, number> = { fixed: 0, "still broken": 0, regressed: 0, "can't tell": 0, new: 0 };

    table.slice(1).forEach((r) => {
      const id = (r[idCol] ?? "").trim();
      let res = id ? result.get(id) : undefined;
      if (!id) {
        res = { verdict: "can't tell", reason: "row has no UAT ID (manual row, no ledger entry)" };
      }
      if (!res) return;
      r[vCol] = res.verdict;
      counts[res.verdict] = (counts[res.verdict] ?? 0) + 1;
      let needs = r[needsCol] ?? "";
      if (res.verdict === "can't tell" && !needs.trim()) needs = res.reason;
      r[needsCol] = needs;
      delta.push(deltaRow(id, res.verdict, needs, undefined, false));
    });

    let counter = ledger.counter;
    for (const row of input.newRows ?? []) {
      counter += 1;
      const id = makeId(plan.slug, counter);
      ledger.rows[id] = {
        id,
        description: row.description,
        section: row.section,
        kind: row.kind,
        designLink: row.designLink,
        selector: row.selector,
        fingerprint: row.fingerprint,
        bbox: row.bbox,
        ruleId: row.ruleId,
        figmaNode: row.figmaNode,
        evidence: { [String(round)]: `evidence/round${round}/${id}.png` },
        firstRound: round,
        verdicts: { [String(round)]: { verdict: `new in round ${round}`, reason: "" } },
      };
      const cells = newRowCells(row, id);
      const out = header.map((h) => (h === verdictCol(round) ? `new in round ${round}` : (cells[h] ?? "")));
      table.push(out);
      delta.push(deltaRow(id, `new in round ${round}`, row.needsHumanLook, row, true));
      counts.new += 1;
    }
    ledger.counter = counter;

    const csvOut = [header, ...table.slice(1).map((r) => r.map(protectCell))];
    const files = writeRound(input.root, ledger, csvOut, delta, input.hook);
    return { ledger, files, summary: counts };
  });
}

/* ---------- reference links (after manual or Drive upload) ---------- */

export function setLinks(root: string, slug: string, links: Record<string, string>): { updated: string[]; unknown: string[] } {
  return withScreenLock(root, slug, () => {
    const ledger = readLatest(root, slug);
    if (!ledger) throw new Error(`no ledger for screen ${slug}`);
    const csvPath = join(root, slug, `${ledger.runId}.csv`);
    const deltaPath = join(root, slug, `delta.${ledger.runId}.csv`);
    const updated: string[] = [];
    const unknown = Object.keys(links).filter((id) => !ledger.rows[id]);
    for (const path of [csvPath, deltaPath]) {
      const table = parseCsv(readFileSync(path, "utf8"));
      const header = table[0];
      const idCol = header.indexOf("UAT ID");
      const linkCol = header.indexOf("Reference link");
      for (const r of table.slice(1)) {
        const url = links[r[idCol]];
        if (url && ledger.rows[r[idCol]]) {
          if (!/^https:\/\//.test(url)) throw new Error(`link for ${r[idCol]} must be an https URL`);
          r[linkCol] = url;
          if (path === csvPath) updated.push(r[idCol]);
        }
      }
      writeAtomic(path, toCsv(table));
    }
    return { updated, unknown };
  });
}

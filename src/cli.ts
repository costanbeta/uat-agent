import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { capture, GuardError, login, loadActions, type CaptureReport } from "./capture.js";
import { composeEvidence, type EvidenceItem } from "./evidence.js";
import { loadRules, nodeHash, validateJudgment, type DomElement, type JudgedRow } from "./judge.js";
import {
  applyRecheck,
  listSlugs,
  planRecheck,
  readLatest,
  setLinks,
  slugFor,
  writeRound1,
  type CaptureConfig,
  type Probe,
  type RecheckPlan,
  type Verdict,
} from "./sheet.js";

type Args = { flags: Record<string, string[]>; bools: Set<string> };
const BOOLEAN_FLAGS = new Set(["headed", "allow-password-field", "restart"]);

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string[]> = {};
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      bools.add(key);
      continue;
    }
    const val = argv[++i];
    if (val === undefined || val.startsWith("--")) throw new Error(`--${key} needs a value`);
    (flags[key] ??= []).push(val);
  }
  return { flags, bools };
}

const one = (a: Args, k: string): string | undefined => a.flags[k]?.[a.flags[k].length - 1];
const need = (a: Args, k: string): string => {
  const v = one(a, k);
  if (v === undefined) throw new Error(`missing required --${k}`);
  return v;
};
const num = (a: Args, k: string, d?: number): number => {
  const v = one(a, k);
  if (v === undefined) {
    if (d === undefined) throw new Error(`missing required --${k}`);
    return d;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${k} must be a positive number`);
  return n;
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function loadOrigins(path: string): string[] {
  if (!existsSync(path)) {
    throw new GuardError("no-staging-config", `${path} not found. Create it with {"origins": ["https://your-staging-host"]}; the tool refuses to run without it.`);
  }
  const cfg = readJson<{ origins?: string[] }>(path);
  if (!Array.isArray(cfg.origins) || cfg.origins.length === 0) throw new GuardError("no-staging-config", `${path} must list at least one origin`);
  return cfg.origins.map((o) => new URL(o).origin);
}

const profileOf = (a: Args) => resolve(one(a, "profile") ?? join(homedir(), ".uat-agent", "profile"));
const configOf = (a: Args) => resolve(one(a, "config") ?? "staging.config");
const runIdOf = (round: number) => `r${round}-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;

function captureOptions(a: Args, probeSelectors?: string[]) {
  return {
    url: need(a, "url"),
    expect: need(a, "expect"),
    origins: loadOrigins(configOf(a)),
    profileDir: profileOf(a),
    outDir: resolve(need(a, "out")),
    width: num(a, "width"),
    height: num(a, "height", 900),
    dpr: num(a, "dpr", 1),
    actionsPath: one(a, "actions"),
    allowPost: a.flags["allow-post"] ?? [],
    allowFinalPath: a.flags["allow-final-path"] ?? [],
    allowPasswordField: a.bools.has("allow-password-field"),
    maxElements: num(a, "max-elements", 400),
    probeSelectors,
    headed: a.bools.has("headed"),
  };
}

function captureConfigOf(report: CaptureReport, rulesHash: string, figmaNode?: string): CaptureConfig {
  return {
    url: report.url,
    expect: report.config.expect,
    origins: report.config.origins,
    allowPost: report.config.allowPost,
    allowFinalPath: report.config.allowFinalPath,
    allowPasswordField: report.config.allowPasswordField,
    actionsPath: report.config.actionsPath,
    actionsHash: report.actionsHash,
    rulesHash,
    width: report.width,
    height: report.height,
    dpr: report.dpr,
    figmaNode,
    capturedAt: report.capturedAt,
  };
}

function nodeHashesFrom(path: string | undefined): Record<string, string> | undefined {
  if (!path) return undefined;
  const map = readJson<Record<string, unknown>>(path);
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, nodeHash(v)]));
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = parseArgs(rest);
  switch (cmd) {
    case "login": {
      await login({ url: need(a, "url"), expect: need(a, "expect"), profileDir: profileOf(a), origins: loadOrigins(configOf(a)) });
      console.log("Login detected; session saved in the profile.");
      return;
    }
    case "capture": {
      let probes: string[] | undefined;
      const screen = one(a, "screen");
      if (screen) {
        const ledger = readLatest(resolve(need(a, "root")), screen);
        if (!ledger) throw new Error(`no ledger for screen ${screen}`);
        probes = [...new Set(Object.values(ledger.rows).map((r) => r.selector).filter((s): s is string => !!s))];
      }
      const report = await capture(captureOptions(a, probes));
      console.log(JSON.stringify({ ok: true, report: join(report.screenshot, "..", "report.json"), screenshot: report.screenshot, dom: report.dom, probes: report.probes, blocked: report.blocked.length, warnings: report.warnings, slug: slugFor(report.url, report.config.actionsPath) }, null, 2));
      return;
    }
    case "validate": {
      const dir = resolve(need(a, "capture"));
      const report = readJson<CaptureReport>(join(dir, "report.json"));
      const dom = readJson<{ elements: DomElement[] }>(report.dom);
      const result = validateJudgment(readJson(need(a, "judgment")), {
        imageWidth: report.screenshotSize.width,
        imageHeight: report.screenshotSize.height,
        dpr: report.dpr,
        dom: dom.elements,
      });
      const out = resolve(need(a, "out"));
      writeFileSync(out, JSON.stringify(result.rows, null, 2));
      console.log(JSON.stringify({ ok: true, issues: result.rows.length, needsHumanLook: result.rows.filter((r) => r.needsHumanLook).length, rejected: result.rejected, out }, null, 2));
      return;
    }
    case "check-write": {
      const root = resolve(need(a, "root"));
      const dir = resolve(need(a, "capture"));
      const report = readJson<CaptureReport>(join(dir, "report.json"));
      const rows = readJson<JudgedRow[]>(need(a, "issues"));
      const rules = loadRules(one(a, "rules"));
      const slug = slugFor(report.url, report.config.actionsPath);
      const result = writeRound1({
        root,
        slug,
        runId: runIdOf(1),
        capture: captureConfigOf(report, rules.hash, one(a, "figma-node")),
        rows,
        nodeHashes: nodeHashesFrom(one(a, "node-json")),
        restart: a.bools.has("restart"),
      });
      const items: EvidenceItem[] = result.ids.map((id, i) => ({
        screenshot: report.screenshot,
        bbox: rows[i].bbox,
        dpr: report.dpr,
        out: join(root, slug, result.ledger.rows[id].evidence["1"]),
        label: `${id}  ${rows[i].description}`.slice(0, 140),
      }));
      await composeEvidence(items);
      const manifest = Object.fromEntries(items.map((it, i) => [result.ids[i], it.out]));
      writeFileSync(join(root, slug, `evidence-manifest.${result.ledger.runId}.json`), JSON.stringify(manifest, null, 2));
      console.log(JSON.stringify({ ok: true, slug, round: 1, rows: result.ids.length, csv: result.files.csvPath, delta: result.files.deltaPath, ledger: result.files.ledgerPath, evidenceDir: join(root, slug, "evidence", "round1") }, null, 2));
      return;
    }
    case "recheck-plan": {
      const root = resolve(need(a, "root"));
      const slug = need(a, "screen");
      const ledger = readLatest(root, slug);
      if (!ledger) throw new Error(`no ledger for screen ${slug}`);
      const dir = resolve(need(a, "capture"));
      const report = readJson<CaptureReport>(join(dir, "report.json"));
      const probes = report.probes ? readJson<Record<string, Probe>>(report.probes) : {};
      const plan = planRecheck({
        ledger,
        exportedCsv: readFileSync(need(a, "csv"), "utf8"),
        probes,
        current: { actionsHash: report.actionsHash, width: report.width, dpr: report.dpr },
        slugExists: (s) => listSlugs(root).includes(s),
        nodeHashes: nodeHashesFrom(one(a, "node-json")),
      });
      const items: EvidenceItem[] = [];
      for (const entry of plan.toJudge) {
        const out = join(root, slug, `evidence/round${plan.round}/${entry.id}.png`);
        items.push({ screenshot: report.screenshot, bbox: entry.newBbox, dpr: report.dpr, out, label: `${entry.id} (round ${plan.round})` });
        entry.newCrop = out;
        if (entry.oldEvidence) entry.oldEvidence = isAbsolute(entry.oldEvidence) ? entry.oldEvidence : join(root, slug, entry.oldEvidence);
      }
      await composeEvidence(items);
      const out = resolve(need(a, "out"));
      writeFileSync(out, JSON.stringify(plan, null, 2));
      console.log(JSON.stringify({ ok: true, round: plan.round, toJudge: plan.toJudge.length, cantTell: plan.cantTell.length, skipped: plan.skipped.length, plan: out }, null, 2));
      return;
    }
    case "recheck-write": {
      const root = resolve(need(a, "root"));
      const slug = need(a, "screen");
      const ledger = readLatest(root, slug);
      if (!ledger) throw new Error(`no ledger for screen ${slug}`);
      const plan = readJson<RecheckPlan>(need(a, "plan"));
      const verdicts = readJson<Verdict[]>(need(a, "verdicts"));
      const newRows = one(a, "issues") ? readJson<JudgedRow[]>(need(a, "issues")) : [];
      const result = applyRecheck({
        root,
        ledger,
        plan,
        verdicts,
        exportedCsv: readFileSync(need(a, "csv"), "utf8"),
        runId: runIdOf(plan.round),
        newRows,
      });
      if (one(a, "capture")) {
        const report = readJson<CaptureReport>(join(resolve(need(a, "capture")), "report.json"));
        const items: EvidenceItem[] = Object.values(result.ledger.rows)
          .filter((r) => r.firstRound === plan.round)
          .map((r) => ({ screenshot: report.screenshot, bbox: r.bbox, dpr: report.dpr, out: join(root, slug, r.evidence[String(plan.round)]), label: `${r.id}  ${r.description}`.slice(0, 140) }));
        await composeEvidence(items);
      }
      console.log(JSON.stringify({ ok: true, slug, round: plan.round, summary: result.summary, csv: result.files.csvPath, delta: result.files.deltaPath }, null, 2));
      return;
    }
    case "show": {
      const ledger = readLatest(resolve(need(a, "root")), need(a, "screen"));
      if (!ledger) throw new Error(`no ledger for screen ${need(a, "screen")}`);
      console.log(JSON.stringify({ slug: ledger.slug, round: ledger.round, runId: ledger.runId, rows: Object.keys(ledger.rows).length, capture: ledger.capture }, null, 2));
      return;
    }
    case "set-links": {
      const result = setLinks(resolve(need(a, "root")), need(a, "screen"), readJson<Record<string, string>>(need(a, "links")));
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      return;
    }
    case "hash-node": {
      console.log(nodeHash(readJson(need(a, "file"))));
      return;
    }
    case "actions-check": {
      const { steps, hash } = loadActions(need(a, "file"));
      console.log(JSON.stringify({ steps: steps.length, hash }));
      return;
    }
    default:
      console.error("usage: uat <login|capture|validate|check-write|recheck-plan|recheck-write|show|set-links|hash-node> [flags]; see .claude/skills/uat-check/SKILL.md");
      process.exit(64);
  }
}

main().catch((e) => {
  if (e instanceof GuardError) {
    console.error(JSON.stringify({ ok: false, error: e.code, message: e.message }));
    process.exit(2);
  }
  console.error(JSON.stringify({ ok: false, error: "failed", message: e instanceof Error ? e.message : String(e) }));
  process.exit(1);
});


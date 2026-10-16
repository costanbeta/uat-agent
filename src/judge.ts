import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { parse as parseYaml } from "yaml";

export const BBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});
export type BBox = z.infer<typeof BBoxSchema>;

export const KINDS = ["layout", "missing", "style", "copy", "other"] as const;

export const IssueSchema = z.object({
  description: z.string().min(1),
  section: z.string().default(""),
  kind: z.enum(KINDS).default("other"),
  selector: z.string().min(1).optional(),
  bbox: BBoxSchema.optional(),
  design_link: z.string().optional(),
  rule_id: z.string().optional(),
  figma_node: z.string().optional(),
  computed: z.record(z.string(), z.string()).optional(),
  confidence: z.number().min(0).max(1),
});

export const JudgmentSchema = z.object({ issues: z.array(z.unknown()) });

export interface DomElement {
  selector: string;
  tag: string;
  text: string;
  bbox: BBox;
  unique: boolean;
}

export interface JudgedRow {
  description: string;
  section: string;
  priority: string;
  designLink: string;
  kind: string;
  selector?: string;
  fingerprint?: string;
  bbox?: BBox;
  ruleId?: string;
  figmaNode?: string;
  needsHumanLook: string;
}

export interface ValidateOptions {
  imageWidth: number;
  imageHeight: number;
  dpr?: number;
  lowConfidence?: number;
  dom?: DomElement[];
  maxDescription?: number;
}

export function fingerprintOf(tag: string, text: string): string {
  const norm = `${tag.toLowerCase()}|${text.replace(/\s+/g, " ").trim().slice(0, 80).toLowerCase()}`;
  return createHash("sha1").update(norm).digest("hex").slice(0, 16);
}

export function sanitizeDescription(raw: string, max = 300): string {
  let s = raw.replace(/https?:\/\/\S+/gi, "").replace(/\bwww\.\S+/gi, "");
  s = s.replace(/[A-Za-z0-9+/]{40,}={0,2}/g, "");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + "…";
  return s;
}

export function priorityFor(kind: string): string {
  switch (kind) {
    case "layout":
    case "missing":
      return "High";
    case "copy":
      return "Low";
    default:
      return "Medium";
  }
}

export function validateJudgment(raw: unknown, opts: ValidateOptions): { rows: JudgedRow[]; rejected: { index: number; reason: string }[] } {
  const rejected: { index: number; reason: string }[] = [];
  const top = JudgmentSchema.safeParse(raw);
  if (!top.success) {
    return {
      rows: [
        {
          description: "Judgment output was not valid JSON of the expected shape; no issues were read.",
          section: "",
          priority: "",
          designLink: "",
          kind: "other",
          needsHumanLook: `invalid judgment file: ${top.error.issues[0]?.message ?? "unknown error"}`,
        },
      ],
      rejected: [{ index: -1, reason: "top-level schema" }],
    };
  }
  const low = opts.lowConfidence ?? 0.6;
  const dpr = opts.dpr ?? 1;
  const cssW = opts.imageWidth / dpr;
  const cssH = opts.imageHeight / dpr;
  const byDom = new Map<string, DomElement>();
  for (const el of opts.dom ?? []) byDom.set(el.selector, el);

  const rows: JudgedRow[] = [];
  top.data.issues.forEach((item, index) => {
    const parsed = IssueSchema.safeParse(item);
    if (!parsed.success) {
      const reason = parsed.error.issues[0]?.message ?? "invalid item";
      rejected.push({ index, reason });
      rows.push({
        description: `Judgment item ${index + 1} could not be read.`,
        section: "",
        priority: "",
        designLink: "",
        kind: "other",
        needsHumanLook: `invalid judgment item ${index + 1}: ${reason}`,
      });
      return;
    }
    const issue = parsed.data;
    const notes: string[] = [];
    let bbox = issue.bbox;
    if (bbox && (bbox.x < 0 || bbox.y < 0 || bbox.x + bbox.w > cssW + 1 || bbox.y + bbox.h > cssH + 1)) {
      notes.push("bbox outside screenshot, dropped");
      bbox = undefined;
    }
    let selector = issue.selector;
    let fingerprint: string | undefined;
    if (selector) {
      const el = byDom.get(selector);
      if (!el) {
        notes.push("selector not found in DOM dump, dropped");
        selector = undefined;
      } else if (!el.unique) {
        notes.push("selector matches more than one element, dropped");
        selector = undefined;
      } else {
        fingerprint = fingerprintOf(el.tag, el.text);
        bbox = bbox ?? el.bbox;
      }
    }
    if (!selector) notes.push("no unique selector: recheck will return can't tell for this row");
    if (issue.confidence < low) notes.unshift(`low confidence (${issue.confidence.toFixed(2)})`);
    const description = sanitizeDescription(issue.description, opts.maxDescription);
    rows.push({
      description: description || `Judgment item ${index + 1} had an empty description after sanitizing.`,
      section: sanitizeDescription(issue.section, 80),
      priority: priorityFor(issue.kind),
      designLink: issue.design_link ?? "",
      kind: issue.kind,
      selector,
      fingerprint,
      bbox,
      ruleId: issue.rule_id,
      figmaNode: issue.figma_node,
      needsHumanLook: issue.confidence < low || !description ? notes.join("; ") : notes.filter((n) => !n.startsWith("no unique selector")).join("; "),
    });
  });
  return { rows, rejected };
}

export interface Rules {
  stagingNote?: string;
  rules: { id: string; text: string }[];
  hash: string;
}

export function loadRules(path: string | undefined): Rules {
  if (!path) return { rules: [], hash: "none" };
  const text = readFileSync(path, "utf8");
  const parsed = parseYaml(text);
  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.rules) ? parsed.rules : [];
  const rules = list.map((r: unknown, i: number) =>
    typeof r === "string" ? { id: `rule-${i + 1}`, text: r } : { id: String((r as any).id ?? `rule-${i + 1}`), text: String((r as any).text ?? "") },
  );
  return { rules, hash: createHash("sha1").update(text).digest("hex").slice(0, 16) };
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      if (/^(id|nodeId|imageRef|url|.*Url|.*Id)$/.test(key)) continue;
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  if (typeof value === "string" && /^https?:\/\//.test(value)) return "<url>";
  return value;
}

export function nodeHash(json: unknown): string {
  return createHash("sha1").update(JSON.stringify(canonicalize(json))).digest("hex").slice(0, 16);
}

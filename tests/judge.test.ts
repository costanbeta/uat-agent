import { describe, expect, it } from "vitest";
import { fingerprintOf, nodeHash, priorityFor, sanitizeDescription, validateJudgment, type DomElement } from "../src/judge.js";

const dom: DomElement[] = [
  { selector: "#badge", tag: "span", text: "Active", bbox: { x: 10, y: 10, w: 50, h: 20 }, unique: true },
  { selector: "li", tag: "li", text: "item", bbox: { x: 10, y: 50, w: 50, h: 20 }, unique: false },
];
const opts = { imageWidth: 800, imageHeight: 600, dpr: 1, dom };

describe("validateJudgment", () => {
  it("accepts a valid issue and maps kind to priority", () => {
    const { rows } = validateJudgment({ issues: [{ description: "Badge border missing", kind: "style", selector: "#badge", confidence: 0.9 }] }, opts);
    expect(rows).toHaveLength(1);
    expect(rows[0].priority).toBe("Medium");
    expect(rows[0].selector).toBe("#badge");
    expect(rows[0].fingerprint).toBe(fingerprintOf("span", "Active"));
    expect(rows[0].bbox).toEqual({ x: 10, y: 10, w: 50, h: 20 });
    expect(rows[0].needsHumanLook).toBe("");
  });

  it("maps every kind to its priority", () => {
    expect(["layout", "missing", "style", "copy", "other"].map(priorityFor)).toEqual(["High", "High", "Medium", "Low", "Medium"]);
  });

  it("turns a malformed top-level into a single needs-human-look row", () => {
    const { rows, rejected } = validateJudgment("not json shape", opts);
    expect(rows).toHaveLength(1);
    expect(rows[0].needsHumanLook).toMatch(/invalid judgment file/);
    expect(rejected[0].index).toBe(-1);
  });

  it("turns an unreadable item into a flagged row and keeps the others", () => {
    const { rows, rejected } = validateJudgment({ issues: [{ nope: 1 }, { description: "ok", confidence: 0.9, kind: "copy" }] }, opts);
    expect(rows).toHaveLength(2);
    expect(rows[0].needsHumanLook).toMatch(/invalid judgment item 1/);
    expect(rows[1].description).toBe("ok");
    expect(rejected).toHaveLength(1);
  });

  it("drops a bbox that is outside the screenshot and flags it", () => {
    const { rows } = validateJudgment({ issues: [{ description: "x", confidence: 0.9, bbox: { x: 790, y: 10, w: 100, h: 10 } }] }, opts);
    expect(rows[0].bbox).toBeUndefined();
    expect(rows[0].needsHumanLook).toMatch(/bbox outside screenshot/);
  });

  it("drops a selector that is not unique or not in the DOM dump", () => {
    const { rows } = validateJudgment(
      {
        issues: [
          { description: "a", confidence: 0.9, selector: "li" },
          { description: "b", confidence: 0.9, selector: "#nope" },
        ],
      },
      opts,
    );
    expect(rows[0].selector).toBeUndefined();
    expect(rows[1].selector).toBeUndefined();
    expect(rows[0].needsHumanLook).toMatch(/more than one element/);
    expect(rows[1].needsHumanLook).toMatch(/not found in DOM dump/);
  });

  it("flags low-confidence issues", () => {
    const { rows } = validateJudgment({ issues: [{ description: "maybe", confidence: 0.3, selector: "#badge" }] }, opts);
    expect(rows[0].needsHumanLook).toMatch(/low confidence/);
  });

  it("divides bbox bounds by dpr", () => {
    const { rows } = validateJudgment({ issues: [{ description: "x", confidence: 0.9, bbox: { x: 10, y: 10, w: 700, h: 10 } }] }, { ...opts, imageWidth: 1600, dpr: 2 });
    expect(rows[0].bbox).toBeDefined();
  });
});

describe("sanitizeDescription", () => {
  it("strips urls and base64-looking strings and limits length", () => {
    const dirty = "See https://evil.example/x?a=1 and www.evil.example and QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVm end";
    const clean = sanitizeDescription(dirty);
    expect(clean).not.toMatch(/https?:|www\.|QUJD/);
    expect(clean).toContain("See");
    expect(sanitizeDescription("word ".repeat(100), 100).length).toBe(100);
    expect(sanitizeDescription("class .template-studio-header-actions-primary-button-group looks off")).toContain("template-studio-header-actions-primary-button-group");
  });
});

describe("nodeHash", () => {
  it("is stable across key order, ids and asset urls", () => {
    const a = { name: "Frame", id: "1:2", fills: [{ imageRef: "abc", color: "#fff" }], icon: "https://cdn/x.png?t=1", w: 10 };
    const b = { w: 10, icon: "https://cdn/x.png?t=2", fills: [{ color: "#fff", imageRef: "zzz" }], id: "9:9", name: "Frame" };
    expect(nodeHash(a)).toBe(nodeHash(b));
  });
  it("changes when a real property changes", () => {
    expect(nodeHash({ name: "Frame", w: 10 })).not.toBe(nodeHash({ name: "Frame", w: 11 }));
  });
});

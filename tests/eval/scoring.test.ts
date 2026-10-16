import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agreement, decide, median, precision, recall } from "../../src/score.js";

const recorded = JSON.parse(readFileSync(new URL("./recorded-run.json", import.meta.url), "utf8")) as {
  runs: { matched: number; denominator: number; accepted: number; total: number }[];
  round2: { tool: string; human: string }[];
};

describe("scoring arithmetic (replay of a recorded run; not a measure of live judgment quality)", () => {
  it("computes recall and precision per run and reports the median", () => {
    const recalls = recorded.runs.map(recall);
    const precisions = recorded.runs.map(precision);
    expect(recalls).toEqual([0.5, 0.4, 0.6]);
    expect(median(recalls)).toBe(0.5);
    expect(median(precisions)).toBeCloseTo(0.8, 5);
  });

  it("counts can't tell as not agreed and reports the can't-tell rate beside the agreement", () => {
    const a = agreement(recorded.round2);
    expect(a.total).toBe(5);
    expect(a.agreed).toBe(3);
    expect(a.rate).toBeCloseTo(0.6, 5);
    expect(a.cantTellRate).toBeCloseTo(0.2, 5);
  });

  it("a tool that says can't tell everywhere cannot score high", () => {
    const a = agreement([1, 2, 3, 4].map(() => ({ tool: "can't tell", human: "fixed" })));
    expect(a.rate).toBe(0);
    expect(a.cantTellRate).toBe(1);
  });

  it("handles empty input without dividing by zero", () => {
    expect(recall({ matched: 0, denominator: 0 })).toBe(0);
    expect(agreement([]).rate).toBe(0);
    expect(median([])).toBe(0);
  });

  it.each([
    [0.5, 0.9, "continue"],
    [0.3, 0.9, "ledger-is-the-product"],
    [0.9, 0.7, "not-ready"],
    [0.2, 0.2, "not-ready"],
    [0.4, 0.8, "continue"],
  ])("decision rule: recall %f agreement %f -> %s", (r, a, expected) => {
    expect(decide(r, a)).toBe(expected);
  });
});

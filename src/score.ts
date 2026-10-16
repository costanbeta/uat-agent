export interface RecallInput {
  matched: number;
  denominator: number;
}
export interface PrecisionInput {
  accepted: number;
  total: number;
}
export interface AgreementRow {
  tool: string;
  human: string;
}

const ratio = (n: number, d: number) => (d === 0 ? 0 : n / d);

export const recall = (r: RecallInput) => ratio(r.matched, r.denominator);
export const precision = (p: PrecisionInput) => ratio(p.accepted, p.total);

export function agreement(rows: AgreementRow[]) {
  const total = rows.length;
  const cantTell = rows.filter((r) => r.tool === "can't tell").length;
  const agreed = rows.filter((r) => r.tool !== "can't tell" && r.tool === r.human).length;
  return { agreed, total, rate: ratio(agreed, total), cantTellRate: ratio(cantTell, total) };
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export type Decision = "continue" | "ledger-is-the-product" | "not-ready";

export function decide(recallMedian: number, agreementRate: number, bars = { recall: 0.4, agreement: 0.8 }): Decision {
  if (agreementRate < bars.agreement) return "not-ready";
  return recallMedian >= bars.recall ? "continue" : "ledger-is-the-product";
}

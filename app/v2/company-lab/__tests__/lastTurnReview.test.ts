// ShrimpX V2 — UI-CLARITY-2 B-5: Overview「前Turnのふりかえり」の検査
//
// 実際に2四半期を回した確定記録から組み立て、画面に出る値が
// 確定記録の値と一致することを固定する（画面側で作った数値が無いことの検査）。

import { test } from "node:test";
import assert from "node:assert/strict";

import { advanceSimulationTurns, createSimulationSession } from "../../../lib/v2/companyLab/simulation/engine";
import { unwrapUnit } from "../../../lib/v2/core/units";
import { unwrapUsd } from "../../../lib/v2/finance/types";
import { buildLastTurnReview, type ReviewSectionKey } from "../lastTurnReviewViewModel";

const TS_AT = "2026-10-11T00:00:00.000Z";
const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const;

function runTurns(turns: number) {
  const session = createSimulationSession({
    simulationRunId: `last-turn-review-${turns}`,
    scenarioId: "dynamic-scenario-2",
    seed: "management-console-32q",
    requestedTurns: turns,
    startedAt: TS_AT,
    sourceCommit: "B5-TEST",
    companyControlModes: Object.fromEntries(COMPANIES.map((c) => [c, "STANDARD_AI"])) as Record<string, "PLAYER" | "STANDARD_AI">,
    salesModelId: "tiered-v200-crowding-v1",
  });
  return advanceSimulationTurns({ session, turns, timestamp: TS_AT, sourceCommit: "B5-TEST" });
}

const twoTurns = runTurns(2);
const history = twoTurns.state.history;
const record = history[history.length - 1];
const previousRecord = history[history.length - 2];

test("B5-1: 確定記録が1件も無ければ null（Turn1の意思決定前にふりかえりを作らない）", () => {
  assert.equal(buildLastTurnReview({ companyId: "BAL", record: undefined }), null);
});

test("B5-2: 5つの活動（業績・販売・生産・調達・財務・投資）がすべて出る", () => {
  const review = buildLastTurnReview({ companyId: "BAL", record, previousRecord });
  assert.ok(review !== null);
  const keys = review!.sections.map((s) => s.key);
  const expected: readonly ReviewSectionKey[] = ["performance", "sales", "production", "procurement", "finance", "investment"];
  assert.deepEqual(keys, expected);
  assert.equal(review!.turn, record.turn);
  assert.equal(review!.period, record.period);
  assert.equal(review!.hasSubmittedDecision, true, "提出内容が記録に残っているはず");
});

test("B5-3: 業績の数値は financialResults の値そのもの（画面で作り直していない）", () => {
  const review = buildLastTurnReview({ companyId: "BAL", record, previousRecord })!;
  const financial = record.financialResults.find((f) => f.companyId === "BAL")!;
  const performance = review.sections.find((s) => s.key === "performance")!;
  const find = (testId: string) => performance.lines.find((l) => l.testId === testId)!;
  const m = (v: number) => `$${(v / 1e6).toFixed(2)}M`;
  assert.equal(find("review-performance-net-revenue").result, m(unwrapUsd(financial.profitAndLoss.netRevenue)));
  assert.equal(find("review-performance-operating-profit").result, m(unwrapUsd(financial.profitAndLoss.operatingProfit)));
  assert.equal(find("review-performance-net-income").result, m(unwrapUsd(financial.profitAndLoss.netIncome)));
  assert.equal(find("review-performance-cash").result, m(unwrapUsd(financial.balanceSheet.cash)));
  assert.equal(find("review-performance-equity").result, m(unwrapUsd(financial.balanceSheet.totalEquity)));
});

test("B5-4: 前Turnがあるときだけ前Turn比が付く", () => {
  const withPrevious = buildLastTurnReview({ companyId: "BAL", record, previousRecord })!;
  const withoutPrevious = buildLastTurnReview({ companyId: "BAL", record })!;
  const pick = (r: typeof withPrevious) => r.sections.find((s) => s.key === "performance")!.lines.find((l) => l.testId === "review-performance-cash")!;
  assert.ok(pick(withPrevious).note?.startsWith("前Turn比"), pick(withPrevious).note);
  assert.equal(pick(withoutPrevious).note, undefined);
});

test("B5-5: 販売は「提示量（提出した指示）→ 新規成約量（結果）」で並ぶ", () => {
  const review = buildLastTurnReview({ companyId: "BAL", record, previousRecord })!;
  const sales = review.sections.find((s) => s.key === "sales")!;
  const line = sales.lines.find((l) => l.testId === "review-sales-contracted")!;
  const decision = record.decisions.find((d) => d.companyId === "BAL")!;
  const instructedTons = decision.salesPlans.reduce((sum, p) => sum + unwrapUnit(p.desiredQuantity), 0);
  const summary = record.companySummaries.find((s) => s.companyId === "BAL")!;
  assert.equal(line.instructed, `${Math.round(instructedTons).toLocaleString("en-US")} t`);
  assert.equal(line.result, `${Math.round(unwrapUnit(summary.newContractedQuantity)).toLocaleString("en-US")} t`);
  assert.ok(line.note?.includes("成約率"), line.note);
});

test("B5-6: 生産は「計画 → 実績」で、商品別の実績が summary と一致する", () => {
  const review = buildLastTurnReview({ companyId: "BAL", record, previousRecord })!;
  const production = review.sections.find((s) => s.key === "production")!;
  const summary = record.companySummaries.find((s) => s.companyId === "BAL")!;
  const t = (v: number) => `${Math.round(v).toLocaleString("en-US")} t`;
  assert.equal(production.lines.find((l) => l.testId === "review-production-hoso")!.result, t(unwrapUnit(summary.hosoProduced)));
  assert.equal(production.lines.find((l) => l.testId === "review-production-pd")!.result, t(unwrapUnit(summary.pdProduced)));
  assert.equal(production.lines.find((l) => l.testId === "review-production-vap")!.result, t(unwrapUnit(summary.vapProduced)));
  assert.ok(production.lines.find((l) => l.testId === "review-production-total")!.instructed !== undefined);
});

test("B5-7: 調達は国内買付の希望と実際を並べ、不足していれば理由を書く", () => {
  const review = buildLastTurnReview({ companyId: "BAL", record, previousRecord })!;
  const procurement = review.sections.find((s) => s.key === "procurement")!;
  const line = procurement.lines.find((l) => l.testId === "review-procurement-domestic")!;
  const decision = record.decisions.find((d) => d.companyId === "BAL")!;
  const summary = record.companySummaries.find((s) => s.companyId === "BAL")!;
  const t = (v: number) => `${Math.round(v).toLocaleString("en-US")} t`;
  assert.equal(line.instructed, t(unwrapUnit(decision.domesticPurchasePlan.desiredQuantity)));
  assert.equal(line.result, t(unwrapUnit(summary.domesticPurchaseQuantity)));
  assert.ok(line.note !== undefined, "希望どおり買えたかどうかを必ず書く");
});

test("B5-8: 財務は借入の申請額・承認額・否決額を出し、理由は内部名のまま出さない", () => {
  const review = buildLastTurnReview({ companyId: "BAL", record, previousRecord })!;
  const finance = review.sections.find((s) => s.key === "finance")!;
  const line = finance.lines.find((l) => l.testId === "review-finance-loan")!;
  const financing = record.financingResults.find((f) => f.companyId === "BAL")!;
  const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
  assert.equal(line.result, `承認 ${usd(financing.underwriting.approvedAmountUsd)} ／ 否決 ${usd(financing.underwriting.deniedAmountUsd)}`);
  assert.ok(!(line.note ?? "").includes("binding:"), `内部名が残っている: ${line.note}`);
  assert.ok(finance.lines.some((l) => l.testId === "review-finance-capacity"), "借入余力の行が必要");
});

test("B5-9: 投資は提案件数と支払額を出す", () => {
  const review = buildLastTurnReview({ companyId: "BAL", record, previousRecord })!;
  const investment = review.sections.find((s) => s.key === "investment")!;
  const capex = record.capexResults.find((c) => c.companyId === "BAL")!;
  const line = investment.lines.find((l) => l.testId === "review-investment-paid")!;
  assert.equal(line.result, `$${Math.round(capex.totalPaidThisQuarterUsd).toLocaleString("en-US")}`);
});

test("B5-10: 他社の値は一切混ざらない（会社を変えると中身が変わる）", () => {
  const bal = buildLastTurnReview({ companyId: "BAL", record, previousRecord })!;
  const mass = buildLastTurnReview({ companyId: "MASS", record, previousRecord })!;
  const revenueOf = (r: typeof bal) =>
    r.sections.find((s) => s.key === "performance")!.lines.find((l) => l.testId === "review-performance-net-revenue")!.result;
  assert.notEqual(revenueOf(bal), revenueOf(mass));
  assert.equal(bal.companyId, "BAL");
  assert.equal(mass.companyId, "MASS");
});

test("B5-11: 1Turnだけ回した記録でも組み立てられる（前Turn比が無いだけ）", () => {
  const oneTurn = runTurns(1);
  const only = oneTurn.state.history[0];
  const review = buildLastTurnReview({ companyId: "BAL", record: only });
  assert.ok(review !== null);
  assert.equal(review!.turn, 1);
  assert.equal(review!.sections.length, 6);
});

// --- 実機28Turnプレイの指摘を受けた追加分 ---

test("B5-12: 商品別の成約率が出る（市場別だけでは値付けの判断ができない）", () => {
  const review = buildLastTurnReview({ companyId: "BAL", record, previousRecord })!;
  const sales = review.sections.find((s) => s.key === "sales")!;
  for (const product of ["hoso", "pd", "vap"] as const) {
    const line = sales.lines.find((l) => l.testId === `review-sales-product-${product}`);
    assert.ok(line !== undefined, `${product} の商品計の行が必要`);
    assert.ok(line!.note?.includes("成約率"), `${product}: ${line!.note}`);
  }
});

test("B5-13: 完成品在庫を渡すと、商品別の内訳が成約率の隣に出る", () => {
  const review = buildLastTurnReview({
    companyId: "BAL",
    record,
    previousRecord,
    finishedGoodsTonsByProduct: { hoso: 1111, pd: 2222, vap: 333 },
  })!;
  const sales = review.sections.find((s) => s.key === "sales")!;
  assert.ok(sales.lines.find((l) => l.testId === "review-sales-product-pd")!.note?.includes("完成品在庫 2,222 t"));
});

test("B5-14: 却下された投資提案は件数と理由が必ず出る（黙って消えない）", () => {
  // 提出記録に載らない却下（資金繰り事由など）でも負の件数にならないことを固定する。
  // 実機28Turnプレイの Turn 16 で、pdMechanization が
  // 「重大な資金繰り状態のため新規承認を見送り」として却下されていた。
  const capex = record.capexResults.find((c) => c.companyId === "BAL")!;
  const withRejection: typeof record = {
    ...record,
    capexResults: record.capexResults.map((c) =>
      c.companyId === "BAL"
        ? {
            ...c,
            rejectedProposals: [
              { projectType: "pdMechanization" as const, requestedBudgetUsd: 2_500_000, reasons: ["重大な資金繰り状態（支払不能・債務超過等）のため新規承認を見送り。"] },
            ],
          }
        : c
    ),
  };
  const review = buildLastTurnReview({ companyId: "BAL", record: withRejection, previousRecord })!;
  const line = review.sections.find((s) => s.key === "investment")!.lines.find((l) => l.testId === "review-investment-proposals")!;
  assert.ok(line.result?.includes("却下 1件"), line.result);
  assert.ok(!/却下 -\d/.test(line.result ?? ""), `件数が負になってはいけない: ${line.result}`);
  assert.ok(line.note?.includes("重大な資金繰り状態"), line.note);
  assert.ok(line.note?.includes("$2,500,000"), line.note);
  assert.equal(capex.companyId, "BAL");
});

test("B5-15: 投資の申請も着手も無い四半期は「申請なし」と出る（空欄にしない）", () => {
  const empty: typeof record = {
    ...record,
    decisions: record.decisions.map((d) =>
      d.companyId === "BAL" ? { ...d, capexDecision: { ...d.capexDecision, newProjectProposals: [] } } : d
    ),
    capexResults: record.capexResults.map((c) => (c.companyId === "BAL" ? { ...c, events: [], rejectedProposals: [] } : c)),
  };
  const review = buildLastTurnReview({ companyId: "BAL", record: empty, previousRecord })!;
  const line = review.sections.find((s) => s.key === "investment")!.lines.find((l) => l.testId === "review-investment-proposals")!;
  assert.equal(line.instructed, "申請なし");
  assert.equal(line.result, "申請なし");
});

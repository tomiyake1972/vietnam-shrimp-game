// ShrimpX V2 — Phase 6C 統合回帰テスト（#05 §20 の regression 条件を数値で固定する）
//
// 【固定すること】
//   営業能力の壁を外したモデル（会社全体営業能力）で 32Q 回しても、
//     - 完成品在庫が異常増加しない
//     - 提出／成約比が不合理にならない
//     - 営業利益が崩壊しない
//     - 現金が負にならない・借入が暴増しない
//     - 生産が不自然に停止しない
//   こと。Phase 6B ではこれらがすべて壊れていた（在庫3倍・累計営業利益 −61%）。
//
// 【固定しないこと】ゲームバランスの具体的な数値（校正中のため、閾値は
//   「明らかに壊れている」水準にのみ置く）。

import test from "node:test";
import assert from "node:assert/strict";

import { CompanyLabConfig } from "../../types";
import { runCompanyLabWithAutoPolicyForAllCompanies } from "../../runner";
import { createStandardAiProvider } from "../../standardAi/policy";
import { SALES_PARAMETERS_V1, SalesParameters } from "../../../sales/parameters";
import { unwrapUnit } from "../../../core/units";
import { unwrapUsd } from "../../../finance/types";
import { Product } from "../../../market/types";

const TURNS = 32;

/**
 * 会社全体営業能力モデル（Phase 6B の Case B 相当）。
 *
 * 【なぜ Case C ではなく Case B なのか】Phase 6C 完了後の複数seed検証で、
 * Case C + V3 は seed によって MASS が資金枯渇 → 生産0 → 現金 −159M に陥ることが
 * 判明した（5seed中1seed）。Case B + V1 は5seedすべてで Control を上回り、
 * 生産停止・現金負・借入のいずれも発生しない。したがって回帰の基準は Case B に置く。
 * Case C の seed 感受性は未解決の課題として報告済みであり、ここでは固定しない。
 */
const COMPANY_WIDE_PARAMS: SalesParameters = {
  ...SALES_PARAMETERS_V1,
  salesEffortCoefficients: { hoso: 1.0, pd: 1.2, vap: 3.0 } as Readonly<Record<Product, number>>,
  salesCapacityModel: {
    kind: "companyWide",
    companyBaselineCapacityTons: 1_000,
    companyCapacityMaxIncrementTons: 95_000,
    companyCapacitySaturationHeadcount: 190,
    fragmentationPenaltyPerExtraMarket: 0,
    fragmentationFloor: 1,
  },
};

const CALIBRATION_SEED = "management-console-32q";

function run(salesParams: SalesParameters, seed: string = CALIBRATION_SEED) {
  const config: CompanyLabConfig = {
    scenarioId: "baseline",
    mode: "canonical",
    seed,
    turns: TURNS,
    ...(salesParams === SALES_PARAMETERS_V1 ? {} : { salesParamsOverride: salesParams }),
  };
  const { provider, diagnostics } = createStandardAiProvider({ salesParams });
  return { result: runCompanyLabWithAutoPolicyForAllCompanies(config, provider), diagnostics };
}

const control = run(SALES_PARAMETERS_V1);
const companyWide = run(COMPANY_WIDE_PARAMS);

function lastSummaries(r: ReturnType<typeof run>) {
  return r.result.history[r.result.history.length - 1].companySummaries;
}

function cumulativeOperatingProfitUsd(r: ReturnType<typeof run>): number {
  return r.result.history.reduce(
    (sum, h) => sum + h.financialResults.reduce((s, f) => s + unwrapUsd(f.profitAndLoss.operatingProfit), 0),
    0
  );
}

// ---------------------------------------------------------------------
// CCI-1 在庫: 完成品在庫が継続的に異常増加しない
// ---------------------------------------------------------------------

test("CCI-1: 会社全体営業能力モデルでも、完成品在庫が Control の2倍を超えて積み上がらない", () => {
  const controlFg = lastSummaries(control).reduce((s, c) => s + unwrapUnit(c.finishedGoodsInventory), 0);
  const wideFg = lastSummaries(companyWide).reduce((s, c) => s + unwrapUnit(c.finishedGoodsInventory), 0);
  assert.ok(wideFg > 0, "在庫がゼロに張り付いていない（作らなくなったわけではない）");
  assert.ok(
    wideFg < controlFg * 2,
    `完成品在庫 ${Math.round(wideFg)}t が Control ${Math.round(controlFg)}t の2倍未満であること（Phase 6B では約3倍だった）`
  );
});

test("CCI-1b: 完成品在庫が終盤に単調増加し続けない（在庫の発散が無い）", () => {
  const fgAt = (turn: number) =>
    companyWide.result.history
      .find((h) => h.turn === turn)!
      .companySummaries.reduce((s, c) => s + unwrapUnit(c.finishedGoodsInventory), 0);
  const late = [20, 24, 28, 32].map(fgAt);
  const strictlyIncreasing = late.every((v, i) => i === 0 || v > late[i - 1] * 1.15);
  assert.ok(!strictlyIncreasing, `終盤の在庫が毎回15%以上増え続けていない: ${late.map(Math.round).join(" → ")}`);
});

// ---------------------------------------------------------------------
// CCI-2 提出／成約比が不合理でない
// ---------------------------------------------------------------------

test("CCI-2: 終盤の 提出→成約 転換率が合理的な帯（55%以上）に収まる", () => {
  for (const d of companyWide.diagnostics.filter((x) => x.turn === TURNS)) {
    const submitted = d.decision.salesPlans.reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0);
    const summary = companyWide.result.history[TURNS - 1].companySummaries.find((c) => c.companyId === d.companyId)!;
    const contracted = unwrapUnit(summary.newContractedQuantity);
    if (submitted <= 0) continue;
    const conversion = contracted / submitted;
    assert.ok(conversion >= 0.55, `${d.companyId}: 転換率 ${(conversion * 100).toFixed(0)}%（Phase 6B では54〜61%まで落ちていた）`);
    assert.ok(conversion <= 1.0001, `${d.companyId}: 成約が提出を超えない`);
  }
});

test("CCI-2b: 提出量は志と一致もせず、成約量とも一致しない（3つが別の量として動いている）", () => {
  const late = companyWide.diagnostics.filter((x) => x.turn === TURNS);
  assert.ok(late.length > 0);
  const anyDifferent = late.some((d) => {
    const submitted = d.decision.salesPlans.reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0);
    const ambition = d.commercialAmbition?.ambitionTons ?? 0;
    const summary = companyWide.result.history[TURNS - 1].companySummaries.find((c) => c.companyId === d.companyId)!;
    return Math.abs(submitted - unwrapUnit(summary.newContractedQuantity)) > 1 && ambition > 0;
  });
  assert.ok(anyDifferent, "Ambition・Submitted・Contracts が同一値へ潰れていない");
});

// ---------------------------------------------------------------------
// CCI-3 利益・現金・借入
// ---------------------------------------------------------------------

test("CCI-3: 32Q累計営業利益が Control の75%を下回らない（Phase 6B は39%まで崩壊していた）", () => {
  const controlProfit = cumulativeOperatingProfitUsd(control);
  const wideProfit = cumulativeOperatingProfitUsd(companyWide);
  assert.ok(controlProfit > 0);
  assert.ok(
    wideProfit >= controlProfit * 0.75,
    `累計営業利益 ${(wideProfit / 1e6).toFixed(1)}M が Control ${(controlProfit / 1e6).toFixed(1)}M の75%以上であること`
  );
});

test("CCI-4: 現金が負にならず、借入が期末に暴増しない", () => {
  const last = companyWide.result.history[TURNS - 1];
  for (const f of last.financialResults) {
    assert.ok(unwrapUsd(f.balanceSheet.cash) >= 0, `${f.companyId}: 期末現金が負ではない`);
    const debt = unwrapUsd(f.balanceSheet.shortTermLoans) + unwrapUsd(f.balanceSheet.longTermLoans);
    const equity = unwrapUsd(f.balanceSheet.totalEquity);
    assert.ok(debt <= Math.max(equity, 1) * 2, `${f.companyId}: 借入 ${(debt / 1e6).toFixed(1)}M が純資産の2倍以内`);
  }
});

// ---------------------------------------------------------------------
// CCI-5 生産が不自然に停止しない
// ---------------------------------------------------------------------

test("CCI-5: どの会社も、どの四半期でも生産がゼロで停止しない", () => {
  for (const h of companyWide.result.history) {
    for (const c of h.companySummaries) {
      const produced = unwrapUnit(c.hosoProduced) + unwrapUnit(c.pdProduced) + unwrapUnit(c.vapProduced);
      assert.ok(produced > 0, `turn ${h.turn} / ${c.companyId}: 生産が0で停止していない`);
    }
  }
});

// ---------------------------------------------------------------------
// CCI-6 生産は提出量へ盲目的に追随しない
// ---------------------------------------------------------------------

test("CCI-6: 終盤の生産量は、提出量ではなく成約量の近くにある", () => {
  const last = companyWide.result.history[TURNS - 1];
  for (const d of companyWide.diagnostics.filter((x) => x.turn === TURNS)) {
    const submitted = d.decision.salesPlans.reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0);
    const summary = last.companySummaries.find((c) => c.companyId === d.companyId)!;
    const contracted = unwrapUnit(summary.newContractedQuantity);
    const produced = unwrapUnit(summary.hosoProduced) + unwrapUnit(summary.pdProduced) + unwrapUnit(summary.vapProduced);
    if (submitted <= contracted + 1) continue; // 提出=成約なら比較する意味がない
    assert.ok(
      Math.abs(produced - contracted) < Math.abs(produced - submitted),
      `${d.companyId}: 生産 ${Math.round(produced)}t は提出 ${Math.round(submitted)}t より成約 ${Math.round(contracted)}t に近いこと`
    );
  }
});

// ---------------------------------------------------------------------
// CCI-7 決定論
// ---------------------------------------------------------------------

test("CCI-7: 同一 seed・同一パラメータで 32Q を2回回すと完全に一致する", () => {
  const again = run(COMPANY_WIDE_PARAMS);
  const fingerprint = (r: ReturnType<typeof run>) =>
    r.result.history
      .flatMap((h) =>
        h.companySummaries.map(
          (c) => `${h.turn}:${c.companyId}:${unwrapUnit(c.newContractedQuantity).toFixed(6)}:${unwrapUnit(c.finishedGoodsInventory).toFixed(6)}`
        )
      )
      .join("|");
  assert.equal(fingerprint(again), fingerprint(companyWide));
});

// ---------------------------------------------------------------------
// CCI-8 Control 互換性（#05 §16: silent 変更をしない）
// ---------------------------------------------------------------------

test("CCI-8: 既定パラメータ（perMarket）では、営業能力SSoT化後も転換率がほぼ100%のまま", () => {
  const last = control.result.history[TURNS - 1];
  for (const d of control.diagnostics.filter((x) => x.turn === TURNS)) {
    const submitted = d.decision.salesPlans.reduce((s, p) => s + unwrapUnit(p.desiredQuantity), 0);
    const contracted = unwrapUnit(last.companySummaries.find((c) => c.companyId === d.companyId)!.newContractedQuantity);
    if (submitted <= 0) continue;
    assert.ok(contracted / submitted > 0.95, `${d.companyId}: Control の転換率は従来どおり高いまま`);
  }
});

// ---------------------------------------------------------------------
// CCI-9 seed 頑健性（1つの seed でたまたま通っただけ、を許さない）
// ---------------------------------------------------------------------

test("CCI-9: 複数 seed でも 生産停止ゼロ・現金負ゼロ・在庫発散なし", () => {
  for (const seed of ["phase6c-regression", "seed-a", "seed-b"]) {
    const r = run(COMPANY_WIDE_PARAMS, seed);
    let zeroProductionQuarters = 0;
    let minimumCashUsd = Infinity;
    for (const h of r.result.history) {
      for (const c of h.companySummaries) {
        if (unwrapUnit(c.hosoProduced) + unwrapUnit(c.pdProduced) + unwrapUnit(c.vapProduced) <= 0) zeroProductionQuarters += 1;
      }
      for (const f of h.financialResults) minimumCashUsd = Math.min(minimumCashUsd, unwrapUsd(f.balanceSheet.cash));
    }
    assert.equal(zeroProductionQuarters, 0, `seed=${seed}: 生産が0の四半期が無いこと`);
    assert.ok(minimumCashUsd >= 0, `seed=${seed}: 現金が負になる四半期が無いこと（最小 ${(minimumCashUsd / 1e6).toFixed(1)}M）`);
    const fg = r.result.history[TURNS - 1].companySummaries.reduce((s, c) => s + unwrapUnit(c.finishedGoodsInventory), 0);
    assert.ok(fg < 60_000, `seed=${seed}: 期末完成品在庫 ${Math.round(fg)}t が発散していないこと`);
  }
});

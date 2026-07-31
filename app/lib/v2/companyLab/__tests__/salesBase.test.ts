// ShrimpX V2 — Phase SAI-5D: 営業基盤ストック（salesBase.ts）の単体テスト
//
// 実装指示§7の実装条件: 有限範囲・上下限・1四半期でゼロにならない・数四半期で
// 低下・小さい市場での形成速度抑制・成約強化・重大事故毀損・決定論を検証する。

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptySalesBaseState,
  lookupSalesBaseScore,
  salesBaseSliceForCompany,
  updateSalesBaseState,
  SalesBaseQuarterActivity,
} from "../salesBase";
import { computeMarketProductMix } from "../../market/productLifecycle";
import { hosoEqTons, score0to100, unwrapUnit } from "../../core/units";
import { CompanySalesPlanEntry } from "../../sales/types";

const COMPANIES = ["BAL", "MASS", "JPQ", "VAP", "CONSV"];

function plan(companyId: string, market: string, product: string, desired: number, headcount = 5): CompanySalesPlanEntry {
  return {
    companyId,
    market: market as never,
    product: product as never,
    desiredQuantity: hosoEqTons(desired),
    priceAdjustmentUsdPerHosoEqKg: 0,
    salesForceHeadcount: headcount,
  };
}

function activity(overrides: Partial<SalesBaseQuarterActivity> = {}): SalesBaseQuarterActivity {
  return { salesPlans: [], allocations: [], qualityAdjustments: [], ...overrides };
}

test("SAI-5D: 空状態のlookupは中立値50を返す", () => {
  assert.equal(lookupSalesBaseScore(emptySalesBaseState(), "JPQ", "JP", "vap"), 50);
  assert.equal(lookupSalesBaseScore(undefined, "JPQ", "JP", "vap"), 50);
});

test("SAI-5D: 活動した市場×商品の基盤が上昇し、活動しなかった既存基盤は徐々に減衰する", () => {
  // 1期目: JPQがJP×VAPで活動
  const s1 = updateSalesBaseState(undefined, activity({ salesPlans: [plan("JPQ", "JP", "vap", 500)] }), COMPANIES);
  const after1 = lookupSalesBaseScore(s1, "JPQ", "JP", "vap");
  assert.ok(after1 > 50, `活動後の基盤(${after1})が中立値から上昇していない`);

  // 2期目以降: 活動を止める → 数四半期かけて徐々に低下（1四半期でゼロにならない）
  let s = s1;
  let prev = after1;
  for (let q = 0; q < 4; q++) {
    s = updateSalesBaseState(s, activity(), COMPANIES);
    const now = lookupSalesBaseScore(s, "JPQ", "JP", "vap");
    assert.ok(now < prev, `放置${q + 1}期目で基盤が低下していない`);
    assert.ok(now > prev * 0.8, `放置1四半期の低下(${prev}→${now})が急すぎる`);
    prev = now;
  }
  assert.ok(prev > 0, "数四半期の放置でゼロになった");
});

test("SAI-5D: 営業を継続した会社の基盤は、止めた会社より高くなる（方向テスト）", () => {
  let sContinue: ReturnType<typeof updateSalesBaseState> | undefined;
  let sStop: ReturnType<typeof updateSalesBaseState> | undefined;
  for (let q = 1; q <= 6; q++) {
    sContinue = updateSalesBaseState(sContinue, activity({ salesPlans: [plan("JPQ", "JP", "vap", 500)] }), COMPANIES);
    sStop = updateSalesBaseState(sStop, activity({ salesPlans: q <= 2 ? [plan("JPQ", "JP", "vap", 500)] : [] }), COMPANIES);
  }
  const cont = lookupSalesBaseScore(sContinue, "JPQ", "JP", "vap");
  const stop = lookupSalesBaseScore(sStop, "JPQ", "JP", "vap");
  assert.ok(cont > stop, `継続(${cont}) > 中断(${stop}) になっていない`);
});

test("SAI-5D: 成約成功は基盤を追加強化する", () => {
  const withoutContract = updateSalesBaseState(undefined, activity({ salesPlans: [plan("JPQ", "JP", "vap", 500)] }), COMPANIES);
  const withContract = updateSalesBaseState(
    undefined,
    activity({
      salesPlans: [plan("JPQ", "JP", "vap", 500)],
      allocations: [
        {
          market: "JP",
          product: "vap",
          period: "2015Q1",
          basePrice: 0,
          targetDemand: hosoEqTons(1000),
          companies: [{ companyId: "JPQ", allocatedQuantity: hosoEqTons(400) } as never],
          externalOptionQuantity: hosoEqTons(0),
        } as never,
      ],
    }),
    COMPANIES
  );
  assert.ok(
    lookupSalesBaseScore(withContract, "JPQ", "JP", "vap") > lookupSalesBaseScore(withoutContract, "JPQ", "JP", "vap"),
    "成約ありの基盤が成約なしより高くない"
  );
});

test("SAI-5D: 重大品質事故は当該会社×商品の全市場の基盤を毀損する", () => {
  // 事前に基盤を築く
  let s = updateSalesBaseState(
    undefined,
    activity({ salesPlans: [plan("JPQ", "JP", "vap", 500), plan("JPQ", "US", "vap", 300)] }),
    COMPANIES
  );
  const before = lookupSalesBaseScore(s, "JPQ", "JP", "vap");
  s = updateSalesBaseState(
    s,
    activity({
      salesPlans: [plan("JPQ", "JP", "vap", 500), plan("JPQ", "US", "vap", 300)],
      qualityAdjustments: [
        { companyId: "JPQ", product: "vap", outcome: { majorIncident: { occurred: true, severity: 0.5, probability: 0.01, seed: "t" } } } as never,
      ],
    }),
    COMPANIES
  );
  const after = lookupSalesBaseScore(s, "JPQ", "JP", "vap");
  // 活動獲得（+）より毀損（−8）が大きいため純減する
  assert.ok(after < before, `重大事故後の基盤(${after})が事故前(${before})から低下していない`);
});

test("SAI-5D: 基盤は上限・下限（0〜100）を超えない・常に有限", () => {
  let s: ReturnType<typeof updateSalesBaseState> | undefined;
  for (let q = 0; q < 60; q++) {
    s = updateSalesBaseState(s, activity({ salesPlans: [plan("MASS", "CN", "hoso", 5000)] }), COMPANIES);
  }
  const high = lookupSalesBaseScore(s, "MASS", "CN", "hoso");
  assert.ok(high <= 100 && Number.isFinite(high), `長期活動後の基盤(${high})が上限を超えた`);
  for (let q = 0; q < 60; q++) {
    s = updateSalesBaseState(s, activity(), COMPANIES);
  }
  const low = lookupSalesBaseScore(s, "MASS", "CN", "hoso");
  assert.ok(low >= 0 && Number.isFinite(low), `長期放置後の基盤(${low})が下限を割った`);
});

test("SAI-5D: 小さい初期市場（中国VAP等）では基盤形成速度が抑えられ、市場成長後は速くなる", () => {
  const earlyMix = computeMarketProductMix(1); // 中国VAPシェア極小
  const lateMix = computeMarketProductMix(32); // 中国VAP成長後
  const early = updateSalesBaseState(undefined, activity({ salesPlans: [plan("MASS", "CN", "vap", 100)], lifecycleMix: earlyMix }), COMPANIES);
  const late = updateSalesBaseState(undefined, activity({ salesPlans: [plan("MASS", "CN", "vap", 100)], lifecycleMix: lateMix }), COMPANIES);
  const earlyGain = lookupSalesBaseScore(early, "MASS", "CN", "vap") - 50;
  const lateGain = lookupSalesBaseScore(late, "MASS", "CN", "vap") - 50;
  assert.ok(earlyGain > 0, "初期市場でも基盤形成がゼロではない");
  assert.ok(lateGain > earlyGain, `市場成長後の形成速度(${lateGain})が初期(${earlyGain})より速くない（後発参入余地の表現）`);
});

test("SAI-5D: 同一入力なら常に同一の結果（決定論・エントリ順も固定）", () => {
  const act = activity({ salesPlans: [plan("VAP", "US", "pd", 300), plan("BAL", "EU", "hoso", 200)] });
  const a = updateSalesBaseState(undefined, act, COMPANIES);
  const b = updateSalesBaseState(undefined, act, [...COMPANIES].reverse()); // 会社ID順の入力順に依存しない
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("SAI-5D: salesBaseSliceForCompanyは自社分だけを返す", () => {
  const s = updateSalesBaseState(
    undefined,
    activity({ salesPlans: [plan("JPQ", "JP", "vap", 500), plan("MASS", "CN", "hoso", 800)] }),
    COMPANIES
  );
  const slice = salesBaseSliceForCompany(s, "JPQ");
  assert.ok(slice.JP?.vap !== undefined && unwrapUnit(slice.JP.vap as never) > 50);
  assert.equal(slice.CN?.hoso, undefined, "他社(MASS)の基盤が混入している");
});

test("SAI-5D: スコアが負・NaN・Infinityにならない（score0to100スマートコンストラクタで構造的に保証）", () => {
  assert.throws(() => score0to100(-1));
  assert.throws(() => score0to100(NaN));
  assert.throws(() => score0to100(Infinity));
});

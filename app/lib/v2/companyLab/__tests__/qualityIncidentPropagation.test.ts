// ShrimpX V2 — SAI-5 監査指摘J: 重大品質事故の伝播経路の数値検証
//
// 三宅さんのご指示§3-J:「3経路のうち1つを機械的に削除するのではなく、
// 1件の事故が品質・顧客信頼・営業基盤へどう伝播し、合計でどれだけ成約競争力を
// 押し下げるかを数値で確認する。3つに別の意味があるならそれを記録し、合計影響が
// 過大なら営業基盤側の毀損を減らす／外す」。
//
// 【3経路の意味の違い（重複ではない）】
//  1) 品質スコア（会社×商品）— quality/qualityOutcome.ts の
//     severityToQualityPenalty=40。「この会社のこの商品の作りの良さ」。
//     観測系列は生産バッチの品質。競争力ウェイト quality。
//  2) 顧客信頼（会社×市場）— quality/trustObservation.ts の
//     severityToTrustPenalty=25。「この市場の顧客が受けた取引体験」。
//     観測系列は納品の品質・納期。競争力ウェイト relationship。
//  3) 営業基盤（会社×市場×商品）— salesBase.ts の majorIncidentPenaltyPerSeverity=8。
//     「その市場×商品での商談パイプライン・顧客承認実績の毀損」。
//     観測系列は営業活動・成約。競争力ウェイト salesBase。
// 粒度・観測系列・回復速度がすべて異なるため、同じシグナルの三重計上ではない。
// ただし「合計でどれだけ効くか」は測る必要がある — それが本ファイル。

import { test } from "node:test";
import assert from "node:assert/strict";
import { QUALITY_PARAMETERS_V1 } from "../../quality/parameters";
import { updateCustomerTrustScore, updateQualityScore } from "../../quality/scoreUpdates";
import { SALES_BASE_PARAMETERS_V1, updateSalesBaseState, lookupSalesBaseScore, SalesBaseQuarterActivity } from "../salesBase";
import { allocateMarketProduct, computeCompetitivenessBreakdown } from "../../sales/allocation";
import { period } from "../../core/period";
import { SALES_PARAMETERS_SAI5_SALES_BASE_V1 } from "../../sales/parameters";
import { CompanySalesPlanEntry, CompetitivenessWeightBreakdown } from "../../sales/types";
/**
 * 内訳の6項目を**テスト側で独立に**合計する。
 * 実装の sumCompetitivenessContributions をそのまま使うと、実装側で項を落とす
 * リグレッションを入れたときに両辺が同時に変わって検出できない（監査再指摘）。
 * ここは意図的に手書きで、実装とは別経路にしておく。
 */
function sumBreakdownIndependently(b: CompetitivenessWeightBreakdown): number {
  return (
    b.priceContribution +
    b.coverageContribution +
    b.relationshipContribution +
    b.qualityContribution +
    b.deliveryReliabilityContribution +
    b.salesBaseContribution
  );
}

import { hosoEqTons, score0to100, usdPerHosoEqKg } from "../../core/units";

const SEVERITY = 0.5; // 中程度の重大事故（severity=1.0が最悪）
const COMPANIES = ["A"];
const BASE_PRICE = usdPerHosoEqKg(4.5);

function plan(desired = 500): CompanySalesPlanEntry {
  return {
    companyId: "A",
    market: "JP",
    product: "vap",
    desiredQuantity: hosoEqTons(desired),
    priceAdjustmentUsdPerHosoEqKg: 0,
    salesForceHeadcount: 10,
  };
}

function activity(withIncident: boolean): SalesBaseQuarterActivity {
  return {
    salesPlans: [plan()],
    allocations: [],
    qualityAdjustments: withIncident
      ? ([{ companyId: "A", product: "vap", outcome: { majorIncident: { occurred: true, severity: SEVERITY, probability: 0.01, seed: "t" } } }] as never)
      : [],
  };
}

/** 品質・信頼・営業基盤の3スコアから合成競争力ウェイトを求める（SAI-5ウェイト有効時）。 */
function competitiveness(quality: number, trust: number, salesBase: number): number {
  const entry: CompanySalesPlanEntry = {
    ...plan(),
    qualityReputation: score0to100(quality),
    customerRelationship: score0to100(trust),
    salesBaseScore: score0to100(salesBase),
  };
  return sumBreakdownIndependently(computeCompetitivenessBreakdown(entry, BASE_PRICE, BASE_PRICE, 0.8, SALES_PARAMETERS_SAI5_SALES_BASE_V1));
}

test("SAI-5J: severity0.5の重大事故1件が3経路へ伝播する量を数値で確認する", () => {
  const p = QUALITY_PARAMETERS_V1;

  // --- 経路1: 品質スコア（会社×商品）---
  // 観測品質が severity × severityToQualityPenalty だけ下がり、alphaDown=0.2で反映
  const qualityBefore = 70;
  const observedQuality = qualityBefore - SEVERITY * p.majorIncident.severityToQualityPenalty; // 70 - 20 = 50
  const qualityAfter = Number(updateQualityScore(score0to100(qualityBefore), score0to100(observedQuality)));
  const qualityDrop = qualityBefore - qualityAfter;
  assert.ok(Math.abs(qualityDrop - 4) < 0.01, `品質スコアの低下(${qualityDrop})が想定(20×0.2=4)と違う`);

  // --- 経路2: 顧客信頼（会社×市場）---
  // 取引体験 = 0.5×納品品質 + 0.5×納期 − severity×severityToTrustPenalty、alphaDown=0.18
  const trustBefore = 70;
  const trustAfter = Number(
    updateCustomerTrustScore(score0to100(trustBefore), score0to100(observedQuality), score0to100(100), SEVERITY * p.majorIncident.severityToTrustPenalty)
  );
  const trustDrop = trustBefore - trustAfter;
  // 体験値 = 0.5×50 + 0.5×100 − 12.5 = 62.5 → (70-62.5)×0.18 = 1.35
  assert.ok(Math.abs(trustDrop - 1.35) < 0.02, `顧客信頼の低下(${trustDrop})が想定(1.35)と違う`);

  // --- 経路3: 営業基盤（会社×市場×商品）---
  const noIncident = updateSalesBaseState(undefined, activity(false), COMPANIES);
  const withIncident = updateSalesBaseState(undefined, activity(true), COMPANIES);
  const baseNo = lookupSalesBaseScore(noIncident, "A", "JP", "vap");
  const baseWith = lookupSalesBaseScore(withIncident, "A", "JP", "vap");
  const salesBaseDrop = baseNo - baseWith;
  const expectedSalesBaseDrop = SEVERITY * SALES_BASE_PARAMETERS_V1.majorIncidentPenaltyPerSeverity;
  assert.ok(Math.abs(salesBaseDrop - expectedSalesBaseDrop) < 1e-9, `営業基盤の低下(${salesBaseDrop})が想定(0.5×8=4)と違う`);

  // --- 合計の成約競争力への影響 ---
  const before = competitiveness(qualityBefore, trustBefore, baseNo);
  const after = competitiveness(qualityAfter, trustAfter, baseWith);
  const relativeDrop = (before - after) / before;

  // 3経路の内訳（設計判断の根拠として明示的に検証する）
  const dropFromQuality = SALES_PARAMETERS_SAI5_SALES_BASE_V1.competitivenessWeights.quality * (qualityDrop / 100);
  const dropFromTrust = SALES_PARAMETERS_SAI5_SALES_BASE_V1.competitivenessWeights.relationship * (trustDrop / 100);
  const dropFromSalesBase = SALES_PARAMETERS_SAI5_SALES_BASE_V1.competitivenessWeights.salesBase * (salesBaseDrop / 100);
  assert.ok(Math.abs(before - after - (dropFromQuality + dropFromTrust + dropFromSalesBase)) < 1e-9, "3経路の内訳合計と実際の低下が一致しない");

  // severity比例化後の内訳: 品質 0.0052 / 顧客信頼 0.00176 / 営業基盤 0.0032。
  // 合計 0.0102 ＝ 合成競争力の約1.5%。「1件の事故で成約が崩壊する」水準ではなく、
  // かつ丸め誤差でもない。営業基盤（補助シグナル）は品質（主シグナル）より小さい。
  assert.ok(relativeDrop > 0.005, `事故1件の影響(${(relativeDrop * 100).toFixed(2)}%)が小さすぎて意味がない`);
  assert.ok(relativeDrop < 0.05, `事故1件の合計影響(${(relativeDrop * 100).toFixed(2)}%)が過大（3経路合計で競争力の5%超）`);
  assert.ok(
    dropFromSalesBase < dropFromQuality,
    `営業基盤経路(${dropFromSalesBase})が主シグナルの品質経路(${dropFromQuality})より大きい（主従が逆転している）`
  );
});

test("SAI-5J: 営業基盤の事故毀損は数四半期で中立へ向けて回復する（恒久的な烙印にならない）", () => {
  let s = updateSalesBaseState(undefined, activity(true), COMPANIES);
  const justAfter = lookupSalesBaseScore(s, "A", "JP", "vap");
  assert.ok(justAfter < 50, `事故直後(${justAfter})が中立50を下回っていない`);
  // 営業を続ければ回復する
  for (let q = 0; q < 6; q++) s = updateSalesBaseState(s, activity(false), COMPANIES);
  const recovered = lookupSalesBaseScore(s, "A", "JP", "vap");
  assert.ok(recovered > justAfter, `営業継続後(${recovered})に回復していない`);
  assert.ok(recovered > 50, "6四半期の営業継続でも中立を回復できない（毀損が重すぎる）");
});

test("SAI-5J: 事故は当該会社×商品の全市場に及ぶが、他商品・他社には及ばない（粒度の確認）", () => {
  const s = updateSalesBaseState(
    undefined,
    {
      salesPlans: [
        plan(),
        { ...plan(), market: "US" as never },
        { ...plan(), product: "pd" as never },
        { ...plan(), companyId: "B" },
      ],
      allocations: [],
      qualityAdjustments: [
        { companyId: "A", product: "vap", outcome: { majorIncident: { occurred: true, severity: SEVERITY, probability: 0.01, seed: "t" } } },
      ] as never,
    },
    ["A", "B"]
  );
  assert.ok(lookupSalesBaseScore(s, "A", "JP", "vap") < 50, "事故商品×事故会社のJPが毀損していない");
  assert.ok(lookupSalesBaseScore(s, "A", "US", "vap") < 50, "事故は当該会社×商品の全市場へ及ぶ設計だがUSが毀損していない");
  assert.ok(lookupSalesBaseScore(s, "A", "JP", "pd") > 50, "他商品(PD)へ巻き添えが及んでいる");
  assert.ok(lookupSalesBaseScore(s, "B", "JP", "vap") > 50, "他社へ巻き添えが及んでいる");
});

test("SAI-5J修正: 営業基盤の事故毀損はseverityに比例する（他2経路と同じ扱い）", () => {
  const dropFor = (severity: number): number => {
    const s = updateSalesBaseState(
      undefined,
      {
        salesPlans: [plan()],
        allocations: [],
        qualityAdjustments: [
          { companyId: "A", product: "vap", outcome: { majorIncident: { occurred: true, severity, probability: 0.01, seed: "t" } } },
        ] as never,
      },
      COMPANIES
    );
    const noInc = updateSalesBaseState(undefined, activity(false), COMPANIES);
    return lookupSalesBaseScore(noInc, "A", "JP", "vap") - lookupSalesBaseScore(s, "A", "JP", "vap");
  };
  const light = dropFor(0.1);
  const mid = dropFor(0.5);
  const worst = dropFor(1.0);
  assert.ok(Math.abs(light - 0.8) < 1e-9, `軽微な事故(severity 0.1)の毀損が${light}（想定0.8）`);
  assert.ok(Math.abs(mid - 4.0) < 1e-9, `中程度(0.5)の毀損が${mid}（想定4.0）`);
  assert.ok(Math.abs(worst - 8.0) < 1e-9, `最悪(1.0)の毀損が${worst}（想定8.0）`);
  assert.ok(light < mid && mid < worst, "severityに対して単調でない");
});

test("SAI-5J修正: 同一四半期に同じ会社×商品で複数バッチの事故が起きても毀損は最大severity1件ぶん", () => {
  const multi = updateSalesBaseState(
    undefined,
    {
      salesPlans: [plan()],
      allocations: [],
      qualityAdjustments: [
        { companyId: "A", product: "vap", outcome: { majorIncident: { occurred: true, severity: 0.3, probability: 0.01, seed: "a" } } },
        { companyId: "A", product: "vap", outcome: { majorIncident: { occurred: true, severity: 0.6, probability: 0.01, seed: "b" } } },
        { companyId: "A", product: "vap", outcome: { majorIncident: { occurred: true, severity: 0.2, probability: 0.01, seed: "c" } } },
      ] as never,
    },
    COMPANIES
  );
  const single = updateSalesBaseState(
    undefined,
    {
      salesPlans: [plan()],
      allocations: [],
      qualityAdjustments: [
        { companyId: "A", product: "vap", outcome: { majorIncident: { occurred: true, severity: 0.6, probability: 0.01, seed: "b" } } },
      ] as never,
    },
    COMPANIES
  );
  assert.equal(
    lookupSalesBaseScore(multi, "A", "JP", "vap"),
    lookupSalesBaseScore(single, "A", "JP", "vap"),
    "バッチ数に比例して毀損が積み上がっている"
  );
});

test("SAI-5J: 重大事故は「結果水準」まで届く — 事故を起こした会社の成約量が実際に減る", () => {
  // 【監査再指摘への対応】旧版は合成競争力（内訳の合計）までで止まっており、
  // 成約配分を通した実際の成約量の差までは見ていなかった。
  // 事故あり/なしの2社を同一条件で allocateMarketProduct へ投入して比較する。
  const p = QUALITY_PARAMETERS_V1;
  const before = 70;
  const observedQuality = before - SEVERITY * p.majorIncident.severityToQualityPenalty;
  const qualityAfter = Number(updateQualityScore(score0to100(before), score0to100(observedQuality)));
  const trustAfter = Number(
    updateCustomerTrustScore(score0to100(before), score0to100(observedQuality), score0to100(100), SEVERITY * p.majorIncident.severityToTrustPenalty)
  );
  const baseNo = lookupSalesBaseScore(updateSalesBaseState(undefined, activity(false), COMPANIES), "A", "JP", "vap");
  const baseWith = lookupSalesBaseScore(updateSalesBaseState(undefined, activity(true), COMPANIES), "A", "JP", "vap");

  const planFor = (companyId: string, quality: number, trust: number, salesBase: number): CompanySalesPlanEntry => ({
    companyId,
    market: "JP",
    product: "vap",
    desiredQuantity: hosoEqTons(100000),
    priceAdjustmentUsdPerHosoEqKg: 0,
    salesForceHeadcount: 40,
    qualityReputation: score0to100(quality),
    customerRelationship: score0to100(trust),
    salesBaseScore: score0to100(salesBase),
  });

  const result = allocateMarketProduct(
    "JP",
    "vap",
    period(2015, 1),
    // 3社にするのは、2社だと双方が最大供給者シェア上限（対象需要の35%）に張り付いて
    // 競争力の差が成約量に現れないため（上限が拘束すると差が消える）。
    [
      planFor("CLEAN", before, before, baseNo),
      planFor("INCIDENT", qualityAfter, trustAfter, baseWith),
      planFor("OTHER", before, before, baseNo),
    ],
    usdPerHosoEqKg(4.5),
    hosoEqTons(10000),
    SALES_PARAMETERS_SAI5_SALES_BASE_V1
  );
  const clean = result.companies.find((c) => c.companyId === "CLEAN")!;
  const incident = result.companies.find((c) => c.companyId === "INCIDENT")!;
  const cleanQty = Number(clean.allocatedQuantity);
  const incidentQty = Number(incident.allocatedQuantity);

  assert.ok(incidentQty < cleanQty, `事故を起こした会社の成約量(${incidentQty})が無事故(${cleanQty})を下回っていない`);
  // 影響は「意味があるが壊滅的ではない」水準
  const drop = (cleanQty - incidentQty) / cleanQty;
  assert.ok(drop > 0.005, `事故1件の成約量への影響(${(drop * 100).toFixed(2)}%)が小さすぎる`);
  assert.ok(drop < 0.05, `事故1件の成約量への影響(${(drop * 100).toFixed(2)}%)が過大`);
});

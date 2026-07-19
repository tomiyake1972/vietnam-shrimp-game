// ShrimpX V2 — Phase 7A 品質→販売競争力への接続 テスト
//
// Phase 7Aは、sales/allocation.ts・sales/types.tsの既存フィールド
// （CompanySalesPlanEntry.qualityReputation/customerRelationship/deliveryReliability、
// computeCompetitivenessWeight）へ「値を渡す」だけで接続する（sales側のロジック自体は
// 一切変更しない）。本テストはその既存接続点が、Phase 7Aが要求する意味
// （品質・信頼・納期が高い会社ほど有利、極端な安値で無限に打ち消せない）を
// 満たしていることを確認する。
//
// 対応する受入条件:
//   21. 同価格帯では品質・信頼・納期が高い会社の成約量が多い
//   22. 極端な安値が品質・信頼差を無限に打ち消さない

import { test } from "node:test";
import assert from "node:assert/strict";
import { hosoEqTons, score0to100, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { PeriodV2 } from "../../core/period";
import { allocateMarketProduct, computeCompetitivenessWeight } from "../../sales/allocation";
import { CompanySalesPlanEntry } from "../../sales/types";
import { SALES_PARAMETERS_V1 } from "../../sales/parameters";

const PERIOD = "2015Q1" as PeriodV2;
const BASE_PRICE = usdPerHosoEqKg(4);

function makeEntry(overrides: Partial<CompanySalesPlanEntry> = {}): CompanySalesPlanEntry {
  return {
    companyId: "C1",
    market: "CN",
    product: "hoso",
    desiredQuantity: hosoEqTons(1000),
    priceAdjustmentUsdPerHosoEqKg: 0,
    salesForceHeadcount: 5,
    ...overrides,
  };
}

// --- 21: 同価格帯では品質・信頼・納期が高い会社の成約量が多い ---

test("21a: computeCompetitivenessWeightは同一価格でも品質・顧客関係・納期信頼性が高いほど大きくなる", () => {
  const low = makeEntry({ qualityReputation: score0to100(40), customerRelationship: score0to100(40), deliveryReliability: score0to100(40) });
  const high = makeEntry({ qualityReputation: score0to100(90), customerRelationship: score0to100(90), deliveryReliability: score0to100(90) });

  const weightLow = computeCompetitivenessWeight(low, BASE_PRICE, BASE_PRICE, 0.5, SALES_PARAMETERS_V1);
  const weightHigh = computeCompetitivenessWeight(high, BASE_PRICE, BASE_PRICE, 0.5, SALES_PARAMETERS_V1);
  assert.ok(weightHigh > weightLow);
});

test("21b: 同一提示価格の5社（実際のゲームと同じ社数）で、品質・信頼・納期が高い会社の方が成約量(allocatedQuantity)が多い", () => {
  // 【注記】1社あたりの成約上限=対象需要×maximumSupplierShare(35%)があるため、
  // 参加社数が2社のみだと「基準となるweight」だけで既に35%を超えてしまい、
  // 品質・信頼差があってもどちらも同じ上限で頭打ちになってしまう（安値による
  // 過剰受注防止の上限が意図せず品質差を覆い隠してしまう）。実際のゲームと同じ
  // 5社構成にすることで、この上限に達しない範囲でweightの差がそのまま
  // 成約量の差として現れることを確認する。
  const companyLow: CompanySalesPlanEntry = makeEntry({
    companyId: "C_LOW",
    priceAdjustmentUsdPerHosoEqKg: 0,
    qualityReputation: score0to100(40),
    customerRelationship: score0to100(40),
    deliveryReliability: score0to100(40),
  });
  const companyHigh: CompanySalesPlanEntry = makeEntry({
    companyId: "C_HIGH",
    priceAdjustmentUsdPerHosoEqKg: 0,
    qualityReputation: score0to100(90),
    customerRelationship: score0to100(90),
    deliveryReliability: score0to100(90),
  });
  const neutralCompanies: CompanySalesPlanEntry[] = ["C_N1", "C_N2", "C_N3"].map((id) => makeEntry({ companyId: id, priceAdjustmentUsdPerHosoEqKg: 0 }));

  const result = allocateMarketProduct(
    "CN",
    "hoso",
    PERIOD,
    [companyLow, companyHigh, ...neutralCompanies],
    BASE_PRICE,
    hosoEqTons(2000),
    SALES_PARAMETERS_V1
  );
  const low = result.companies.find((c) => c.companyId === "C_LOW")!;
  const high = result.companies.find((c) => c.companyId === "C_HIGH")!;
  assert.ok(unwrapUnit(high.allocatedQuantity) > unwrapUnit(low.allocatedQuantity), `high=${unwrapUnit(high.allocatedQuantity)} low=${unwrapUnit(low.allocatedQuantity)}`);
  // 全社合計成約量+外部選択肢が対象需要を超えない（既存の水位法アルゴリズムの不変条件）。
  const totalAllocated = result.companies.reduce((sum, c) => sum + unwrapUnit(c.allocatedQuantity), 0) + unwrapUnit(result.externalOptionQuantity);
  assert.ok(Math.abs(totalAllocated - 2000) < 1);
});

// --- 22: 極端な安値が品質・信頼差を無限に打ち消さない ---

test("22a: priceScoreはmaximumPriceCompetitivenessでclampされるため、値下げ幅を増やしてもpriceContributionは頭打ちになる", () => {
  const params = SALES_PARAMETERS_V1;
  const entry = makeEntry();
  const moderateDiscount = usdPerHosoEqKg(unwrapUnit(BASE_PRICE) * 0.8); // 20%値下げ
  const extremeDiscount = usdPerHosoEqKg(unwrapUnit(BASE_PRICE) * 0.55); // 45%値下げ（許容下限付近）

  const weightModerate = computeCompetitivenessWeight(entry, moderateDiscount, BASE_PRICE, 0.5, params);
  const weightExtreme = computeCompetitivenessWeight(entry, extremeDiscount, BASE_PRICE, 0.5, params);
  // 20%値下げの時点でほぼ上限(1.6)に達するため、45%まで値下げしても価格貢献分はほぼ変わらない
  // （無限に成約力が伸びる「抜け道」にならない）。
  assert.ok(Math.abs(weightExtreme - weightModerate) < 0.02, `weightModerate=${weightModerate} weightExtreme=${weightExtreme}`);
});

test("22b: 極端な安値を提示しても、品質・信頼で劣る会社が優位な会社に成約量で逆転することはない", () => {
  // 安値会社: 提示価格を許容下限近くまで下げるが、品質・信頼・納期はすべて最低。
  const cheapButLowQuality: CompanySalesPlanEntry = makeEntry({
    companyId: "C_CHEAP",
    priceAdjustmentUsdPerHosoEqKg: unwrapUnit(BASE_PRICE) * -0.45, // 45%値下げ（下限0.5倍に近い）
    qualityReputation: score0to100(20),
    customerRelationship: score0to100(20),
    deliveryReliability: score0to100(20),
  });
  // 高品質会社: 標準価格・高スコア。
  const premiumHighQuality: CompanySalesPlanEntry = makeEntry({
    companyId: "C_PREMIUM",
    priceAdjustmentUsdPerHosoEqKg: 0,
    qualityReputation: score0to100(95),
    customerRelationship: score0to100(95),
    deliveryReliability: score0to100(95),
  });

  const result = allocateMarketProduct(
    "CN",
    "hoso",
    PERIOD,
    [cheapButLowQuality, premiumHighQuality],
    BASE_PRICE,
    hosoEqTons(1500),
    SALES_PARAMETERS_V1
  );
  const cheap = result.companies.find((c) => c.companyId === "C_CHEAP")!;
  const premium = result.companies.find((c) => c.companyId === "C_PREMIUM")!;
  // 安値の効果はあるので"互角に近い"ことは許容するが、priceScoreのclampにより
  // 極端な安値だけで品質・信頼の差(20 vs 95、3項目)を完全に無効化して逆転勝ちすることはない。
  assert.ok(
    unwrapUnit(premium.allocatedQuantity) >= unwrapUnit(cheap.allocatedQuantity),
    `premium=${unwrapUnit(premium.allocatedQuantity)} cheap=${unwrapUnit(cheap.allocatedQuantity)}`
  );
});

test("未接続(qualityReputation等未指定)の場合は中立値(50)として扱われる", () => {
  const entry = makeEntry({ qualityReputation: undefined, customerRelationship: undefined, deliveryReliability: undefined });
  const withNeutral = computeCompetitivenessWeight(entry, BASE_PRICE, BASE_PRICE, 0.5, SALES_PARAMETERS_V1);
  const withExplicitNeutral = computeCompetitivenessWeight(
    makeEntry({ qualityReputation: score0to100(50), customerRelationship: score0to100(50), deliveryReliability: score0to100(50) }),
    BASE_PRICE,
    BASE_PRICE,
    0.5,
    SALES_PARAMETERS_V1
  );
  assert.ok(Math.abs(withNeutral - withExplicitNeutral) < 1e-9);
});

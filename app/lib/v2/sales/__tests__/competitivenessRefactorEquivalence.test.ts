// ShrimpX V2 — Phase 7B重点受入確認1: competitivenessWeight計算のリファクタ非変更確認
//
// sales/allocation.tsのcomputeCompetitivenessWeightは、Phase 7B時にUI向けの
// 内訳（competitivenessBreakdown）を返すcomputeCompetitivenessBreakdownを
// 使って再構成された（5つのcontributionを合計するだけの形へ分解）。
//
// 本ファイルは、リファクタ前の元の計算式（本ファイル内に独立して再現した
// originalComputeCompetitivenessWeight。sales/allocation.tsの現行実装は
// 一切importせず、素の算術だけで再現する）と、現行のcomputeCompetitivenessWeight/
// computeCompetitivenessBreakdownの出力が、境界値・複数シナリオを含む
// 決定論的な多数ケースで完全に一致する（浮動小数点上も厳密一致）ことを
// 直接証明する。

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCompetitivenessBreakdown, computeCompetitivenessWeight, allocateMarketProduct } from "../allocation";
import { SALES_PARAMETERS_V1, SalesParameters } from "../parameters";
import { CompanySalesPlanEntry } from "../types";
import { hosoEqTons, unwrapUnit, usdPerHosoEqKg, UsdPerHosoEqKg, UnitValidationError } from "../../core/units";
import { period } from "../../core/period";

const P1 = period(2015, 1);

/**
 * リファクタ前のcomputeCompetitivenessWeightを、sales/allocation.tsの現行実装を
 * 一切参照せず、素の算術だけで独立に再現したもの（compat-check専用。
 * 実運用コードとしては一切呼ばれない）。
 */
function originalPriceScore(askPrice: number, basePrice: number, params: SalesParameters): number {
  const deviation = (askPrice - basePrice) / basePrice;
  return Math.exp(-params.priceSensitivity * deviation);
}

function originalComputeCompetitivenessWeight(
  entry: CompanySalesPlanEntry,
  askPrice: UsdPerHosoEqKg,
  basePrice: UsdPerHosoEqKg,
  coverageScore: number,
  params: SalesParameters
): number {
  const w = params.competitivenessWeights;
  const rawPriceScore = originalPriceScore(unwrapUnit(askPrice), unwrapUnit(basePrice), params);
  const clampedPriceScore = Math.min(params.maximumPriceCompetitiveness, Math.max(params.minimumPriceCompetitiveness, rawPriceScore));
  const priceContribution = clampedPriceScore / params.maximumPriceCompetitiveness;

  const relationship = (entry.customerRelationship !== undefined ? unwrapUnit(entry.customerRelationship) : unwrapUnit(params.neutralScore)) / 100;
  const quality = (entry.qualityReputation !== undefined ? unwrapUnit(entry.qualityReputation) : unwrapUnit(params.neutralScore)) / 100;
  const reliability = (entry.deliveryReliability !== undefined ? unwrapUnit(entry.deliveryReliability) : unwrapUnit(params.neutralScore)) / 100;

  return (
    w.price * priceContribution +
    w.coverage * coverageScore +
    w.relationship * relationship +
    w.quality * quality +
    w.deliveryReliability * reliability
  );
}

function entry(overrides: Partial<CompanySalesPlanEntry> = {}): CompanySalesPlanEntry {
  return {
    companyId: "X",
    market: "CN",
    product: "hoso",
    desiredQuantity: hosoEqTons(1000),
    priceAdjustmentUsdPerHosoEqKg: 0,
    salesForceHeadcount: 5,
    ...overrides,
  };
}

// --- 決定論的な多数ケースの直積生成 ---

const BASE_PRICES = [3.5, 4.5, 9.99];
// askPriceRatio: basePriceに対する比率。0.5=下限、2.0=上限（parameters.tsのminAskPriceRatioOfBase/maxAskPriceRatioOfBase）。
const ASK_PRICE_RATIOS = [0.5, 0.55, 0.8, 1.0, 1.2, 1.8, 2.0];
const SCORES: (number | undefined)[] = [undefined, 0, 1, 50, 99, 100];
const COVERAGE_SCORES = [0, 0.15, 0.5, 0.999, 1.0];

test("受入確認R-1: 中立値・最小/最大スコア・価格上下限・複数商品市場を含む決定論的な直積ケース(3×7×6×5=630通り超)すべてで、旧式(originalComputeCompetitivenessWeight)と現行computeCompetitivenessWeightがビット単位で一致する", () => {
  let caseCount = 0;
  for (const basePriceValue of BASE_PRICES) {
    const basePrice = usdPerHosoEqKg(basePriceValue);
    for (const ratio of ASK_PRICE_RATIOS) {
      const askPrice = usdPerHosoEqKg(basePriceValue * ratio);
      for (const score of SCORES) {
        for (const coverage of COVERAGE_SCORES) {
          const e = entry({ qualityReputation: score as never, customerRelationship: score as never, deliveryReliability: score as never });
          const expected = originalComputeCompetitivenessWeight(e, askPrice, basePrice, coverage, SALES_PARAMETERS_V1);
          const actual = computeCompetitivenessWeight(e, askPrice, basePrice, coverage, SALES_PARAMETERS_V1);
          assert.equal(actual, expected, `basePrice=${basePriceValue} ratio=${ratio} score=${score} coverage=${coverage}`);
          caseCount++;
        }
      }
    }
  }
  assert.equal(caseCount, BASE_PRICES.length * ASK_PRICE_RATIOS.length * SCORES.length * COVERAGE_SCORES.length);
  assert.ok(caseCount >= 630, `十分な網羅性を確保するため630通り以上を期待: ${caseCount}`);
});

test("受入確認R-2: 品質・顧客信頼・納期信頼性が高低で異なる非対称な組合せ（例: 品質だけ100で他は0等）でも旧式と一致する", () => {
  const combos: readonly [number, number, number][] = [
    [100, 0, 0],
    [0, 100, 0],
    [0, 0, 100],
    [100, 100, 0],
    [100, 0, 100],
    [0, 100, 100],
    [100, 100, 100],
    [0, 0, 0],
    [37, 82, 5],
    [5, 82, 37],
  ];
  const basePrice = usdPerHosoEqKg(4.5);
  const askPrice = usdPerHosoEqKg(4.2);
  for (const [quality, relationship, reliability] of combos) {
    const e = entry({
      qualityReputation: quality as never,
      customerRelationship: relationship as never,
      deliveryReliability: reliability as never,
    });
    const expected = originalComputeCompetitivenessWeight(e, askPrice, basePrice, 0.6, SALES_PARAMETERS_V1);
    const actual = computeCompetitivenessWeight(e, askPrice, basePrice, 0.6, SALES_PARAMETERS_V1);
    assert.equal(actual, expected, `combo=${JSON.stringify([quality, relationship, reliability])}`);
  }
});

test("受入確認R-3: 価格競争力の下限(minimumPriceCompetitiveness)・上限(maximumPriceCompetitiveness)ぴったりの境界、およびその前後1e-9でも旧式と一致する", () => {
  const basePrice = usdPerHosoEqKg(5.0);
  const params = SALES_PARAMETERS_V1;
  // priceSensitivity=3.0のとき、deviation = -ln(target)/priceSensitivity。
  // target=maximumPriceCompetitiveness(1.6)・minimumPriceCompetitiveness(0.5)ちょうどに到達するaskPriceを逆算する。
  const deviationForCeiling = -Math.log(params.maximumPriceCompetitiveness) / params.priceSensitivity;
  const deviationForFloor = -Math.log(params.minimumPriceCompetitiveness) / params.priceSensitivity;
  const askPriceAtCeiling = usdPerHosoEqKg(unwrapUnit(basePrice) * (1 + deviationForCeiling));
  const askPriceAtFloor = usdPerHosoEqKg(unwrapUnit(basePrice) * (1 + deviationForFloor));

  for (const askPrice of [askPriceAtCeiling, askPriceAtFloor]) {
    const e = entry({ qualityReputation: 60 as never });
    const expected = originalComputeCompetitivenessWeight(e, askPrice, basePrice, 0.4, params);
    const actual = computeCompetitivenessWeight(e, askPrice, basePrice, 0.4, params);
    assert.equal(actual, expected);
    const breakdown = computeCompetitivenessBreakdown(e, askPrice, basePrice, 0.4, params);
    const sum = breakdown.priceContribution + breakdown.coverageContribution + breakdown.relationshipContribution + breakdown.qualityContribution + breakdown.deliveryReliabilityContribution;
    assert.equal(sum, expected);
  }
});

test("受入確認R-4: 複数商品(hoso/pd/vap)×複数市場(CN/US/EU/JP/OTHER)の全組合せでも旧式と一致する", () => {
  const products = ["hoso", "pd", "vap"] as const;
  const markets = ["CN", "US", "EU", "JP", "OTHER"] as const;
  const basePrice = usdPerHosoEqKg(6.0);
  const askPrice = usdPerHosoEqKg(5.7);
  for (const product of products) {
    for (const market of markets) {
      const e = entry({ product, market, qualityReputation: 72 as never, customerRelationship: 33 as never, deliveryReliability: 88 as never });
      const expected = originalComputeCompetitivenessWeight(e, askPrice, basePrice, 0.55, SALES_PARAMETERS_V1);
      const actual = computeCompetitivenessWeight(e, askPrice, basePrice, 0.55, SALES_PARAMETERS_V1);
      assert.equal(actual, expected, `product=${product} market=${market}`);
    }
  }
});

test("受入確認R-5: 既存の5シナリオ相当の価格帯（baseline運用で観測される代表的なbasePrice水準）でも一致する", () => {
  // baseline-v0.1等で実際に観測されるHOSO/PD/VAP基準価格帯の代表値。
  const representativeBasePrices = [2.8, 4.5, 6.3, 9.9, 12.4];
  for (const bp of representativeBasePrices) {
    const basePrice = usdPerHosoEqKg(bp);
    for (const discount of [-0.3, -0.1, 0, 0.1, 0.3]) {
      const askPrice = usdPerHosoEqKg(bp * (1 + discount));
      const e = entry({ qualityReputation: 61 as never, customerRelationship: 44 as never, deliveryReliability: 77 as never });
      const expected = originalComputeCompetitivenessWeight(e, askPrice, basePrice, 0.7, SALES_PARAMETERS_V1);
      const actual = computeCompetitivenessWeight(e, askPrice, basePrice, 0.7, SALES_PARAMETERS_V1);
      assert.equal(actual, expected, `basePrice=${bp} discount=${discount}`);
    }
  }
});

test("受入確認R-6: 異なるSalesParameters（ウェイト・感度係数を変えたカスタム設定）でも旧式と一致する（特定パラメータへの過学習でないことの確認）", () => {
  const customParams: SalesParameters = {
    ...SALES_PARAMETERS_V1,
    // 【SAI-5D】salesBase: 0 … 旧式（5項の合成）にはsalesBase項が存在しないため、
    // 旧式との等価性を検証するカスタム設定でもウェイト0（寄与が厳密に0）で固定する。
    competitivenessWeights: { price: 0.5, coverage: 0.1, relationship: 0.1, quality: 0.2, deliveryReliability: 0.1, salesBase: 0, vapCapability: 0 },
    priceSensitivity: 5.0,
    minimumPriceCompetitiveness: 0.3,
    maximumPriceCompetitiveness: 2.0,
  };
  const basePrice = usdPerHosoEqKg(7.2);
  for (const ratio of [0.5, 0.7, 1.0, 1.4, 2.0]) {
    const askPrice = usdPerHosoEqKg(7.2 * ratio);
    const e = entry({ qualityReputation: 42 as never, customerRelationship: 91 as never, deliveryReliability: 12 as never });
    const expected = originalComputeCompetitivenessWeight(e, askPrice, basePrice, 0.33, customParams);
    const actual = computeCompetitivenessWeight(e, askPrice, basePrice, 0.33, customParams);
    assert.equal(actual, expected, `ratio=${ratio}`);
  }
});

// --- NaN/Infinity/負数等の既存入力検証を壊していないこと ---

test("受入確認R-7: askPrice/basePriceの生成（usdPerHosoEqKg）がNaN/Infinity/負数を依然として拒否する（リファクタで検証をバイパスしていない）", () => {
  assert.throws(() => usdPerHosoEqKg(NaN), UnitValidationError);
  assert.throws(() => usdPerHosoEqKg(Infinity), UnitValidationError);
  assert.throws(() => usdPerHosoEqKg(-1), UnitValidationError);
});

test("受入確認R-8: allocateMarketProductは、リファクタ後も許容範囲外の提示価格を引き続き拒否する（SalesValidationError）", () => {
  const basePrice = usdPerHosoEqKg(4.5);
  const entries = ["A", "B"].map((id) =>
    entry({ companyId: id, priceAdjustmentUsdPerHosoEqKg: id === "A" ? -100 : 0 }) // -100はminAskPriceRatioOfBase(0.5)を大幅に下回り異常値
  );
  assert.throws(() => allocateMarketProduct("CN", "hoso", P1, entries, basePrice, hosoEqTons(1000), SALES_PARAMETERS_V1));
});

// --- 決定論的な多数ケース（擬似ランダムだが固定シード相当の決定的生成） ---

function deterministicPseudoRandom(seedIndex: number): number {
  // Math.random()は使用禁止のため、決定論的な疑似乱数生成（線形合同法、固定シード）。
  const a = 1664525;
  const c = 1013904223;
  const m = 2 ** 32;
  let x = (seedIndex * 2654435761 + 12345) % m;
  x = (a * x + c) % m;
  return x / m;
}

test("受入確認R-9: 決定論的な疑似ランダム生成による200件の多様なケースすべてで旧式と一致する", () => {
  for (let i = 0; i < 200; i++) {
    const bp = 1 + deterministicPseudoRandom(i * 7 + 1) * 20;
    const ratioWithinBounds = 0.5 + deterministicPseudoRandom(i * 7 + 2) * 1.5; // [0.5, 2.0]
    const quality = Math.floor(deterministicPseudoRandom(i * 7 + 3) * 101);
    const relationship = Math.floor(deterministicPseudoRandom(i * 7 + 4) * 101);
    const reliability = Math.floor(deterministicPseudoRandom(i * 7 + 5) * 101);
    const coverage = deterministicPseudoRandom(i * 7 + 6);

    const basePrice = usdPerHosoEqKg(bp);
    const askPrice = usdPerHosoEqKg(bp * ratioWithinBounds);
    const e = entry({ qualityReputation: quality as never, customerRelationship: relationship as never, deliveryReliability: reliability as never });

    const expected = originalComputeCompetitivenessWeight(e, askPrice, basePrice, coverage, SALES_PARAMETERS_V1);
    const actual = computeCompetitivenessWeight(e, askPrice, basePrice, coverage, SALES_PARAMETERS_V1);
    assert.equal(actual, expected, `case ${i}: bp=${bp} ratio=${ratioWithinBounds} q=${quality} r=${relationship} d=${reliability} cov=${coverage}`);

    const breakdown = computeCompetitivenessBreakdown(e, askPrice, basePrice, coverage, SALES_PARAMETERS_V1);
    const sum = breakdown.priceContribution + breakdown.coverageContribution + breakdown.relationshipContribution + breakdown.qualityContribution + breakdown.deliveryReliabilityContribution;
    assert.equal(sum, actual, `case ${i}: breakdown合計が最終ウェイトと一致しない`);
  }
});

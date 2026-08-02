// ShrimpX V2 — 営業能力再設計（加工品市場進化 §e）のテスト
//
// SC-1〜SC-10。監査§5の3つの構造的欠陥の解消と、実装指示§7のハード制約
// （営業工数制約を消さない／VAP投資と営業増員の**組み合わせ**でのみ最大効果）
// を検証する。SC-6 が 2×2 の交互作用の実測。

import test from "node:test";
import assert from "node:assert/strict";

import {
  allocateThroughputByPriority,
  computeCustomerDevelopmentScore,
  computeSalesThroughput,
  customerDevelopmentMultiplier,
  marketScaleFactor,
  SALES_CAPABILITY_PARAMETERS_V1,
} from "../salesCapability";
import { applyMarketSalesEffortCapacity, computeMarketSalesEffort } from "../marketEffort";
import { processingCapacity } from "../salesForce";
import { SALES_PARAMETERS_MARKET_EVOLUTION_PRODUCT_WISE_V1, SALES_PARAMETERS_V1 } from "../parameters";
import { allocateMarketProduct } from "../allocation";
import { CompanySalesPlanEntry } from "../types";
import { Product } from "../../market/types";
import { hosoEqTons, score0to100, unwrapUnit, usdPerHosoEqKg } from "../../core/units";
import { period } from "../../core/period";

const PARAMS = SALES_CAPABILITY_PARAMETERS_V1;
const SALES = SALES_PARAMETERS_V1;
const REFERENCE_MARKET = PARAMS.referenceMarketDemandTons;

// ---------------------------------------------------------------------
// 欠陥(i): 絶対トン数の頭打ち → 市場規模・人数に連動
// ---------------------------------------------------------------------

test("SC-1: 【欠陥(i)の解消】販売処理能力が人数に線形で伸び、5,000tの絶対上限に張り付かない", () => {
  // 従来: h=20で3,400t、h=50で4,200t、h→∞でも5,000tで頭打ち。
  assert.equal(unwrapUnit(processingCapacity(20, SALES)), 3400);
  assert.equal(unwrapUnit(processingCapacity(50, SALES)), 4200);
  assert.equal(SALES.salesForce.baselineCapacityTons + SALES.salesForce.capacityMaxIncrementTons, 5000);

  // 人数由来の素の能力（市場規模・顧客開発倍率を掛ける前）は人数に厳密に線形。
  const raw = (headcount: number) =>
    computeSalesThroughput({ salesForceHeadcount: headcount }, REFERENCE_MARKET, SALES, PARAMS).headcountThroughputTons;
  assert.equal(raw(0), 200, "人数0でも既存顧客ぶんの基礎能力は残る");
  assert.equal(raw(10), 200 + 260 * 10);
  assert.equal(raw(20), 200 + 260 * 20);
  assert.equal(raw(21) - raw(20), raw(41) - raw(40), "1人あたりの限界処理能力は一定（逓減しない）");

  // 最終能力は顧客開発倍率が掛かるため厳密な線形ではないが、絶対上限には張り付かない。
  const at = (headcount: number) =>
    computeSalesThroughput({ salesForceHeadcount: headcount }, REFERENCE_MARKET, SALES, PARAMS).throughputCapacityTons;
  assert.ok(at(50) > 5000, `h=50で従来の絶対上限5,000tを超える（実測 ${at(50)}）`);
  assert.ok(at(100) > at(50), "h=50を超えても増員が効き続ける（従来は5,000tで飽和）");
  assert.ok(at(20) > at(10) && at(10) > at(5), "増員は単調に効く");
});

test("SC-2: 【欠陥(i)の解消】市場規模（対象需要）が大きいほど処理能力が伸びる", () => {
  assert.equal(marketScaleFactor(REFERENCE_MARKET, PARAMS), 1, "基準規模の市場では係数1.0");
  assert.ok(marketScaleFactor(REFERENCE_MARKET * 2, PARAMS) > 1, "大きい市場では係数が1を超える");
  assert.ok(marketScaleFactor(REFERENCE_MARKET * 0.3, PARAMS) < 1, "小さい市場では係数が1を下回る");
  // 上下限で有界（青天井にも0にもならない）。
  assert.equal(marketScaleFactor(REFERENCE_MARKET * 100, PARAMS), PARAMS.marketScaleCap);
  assert.equal(marketScaleFactor(1, PARAMS), PARAMS.marketScaleFloor);
  assert.equal(marketScaleFactor(undefined, PARAMS), 1, "対象需要が不明なら中立");

  // 需要が伸びれば、同じ人数でも売れる量が伸びる（Phase6の構造的原因への直接対応）。
  const small = computeSalesThroughput({ salesForceHeadcount: 10 }, REFERENCE_MARKET, SALES, PARAMS).throughputCapacityTons;
  const grown = computeSalesThroughput({ salesForceHeadcount: 10 }, REFERENCE_MARKET * 1.5, SALES, PARAMS).throughputCapacityTons;
  assert.ok(grown > small * 1.4, `需要1.5倍で処理能力も概ね1.5倍へ（${small} → ${grown}）`);
});

// ---------------------------------------------------------------------
// 欠陥(ii): VAP係数が数量を割る → 人手で解ける
// ---------------------------------------------------------------------

test("SC-3: 【営業工数制約は消えていない】VAPは依然として3倍の工数を要し、人数が足りなければ縮小される", () => {
  const context = { marketTargetDemandTons: REFERENCE_MARKET };
  const desired: Record<Product, number> = { hoso: 0, pd: 0, vap: 3000 };
  const result = computeMarketSalesEffort(5, desired, SALES, context);
  assert.equal(result.desiredEffortWeightedQuantity, 9000, "VAP3,000tの必要工数は3.0×3,000=9,000");
  assert.ok(result.isConstrained, "人数5人（能力1,500t）では賄えず縮小されるべき");
  assert.ok(result.adjustedQuantityByProduct.vap < 3000);

  // 同じ数量でも、HOSOなら必要工数は1/3で済む＝VAPの営業負荷は維持されている。
  const hosoResult = computeMarketSalesEffort(5, { hoso: 3000, pd: 0, vap: 0 }, SALES, context);
  assert.equal(hosoResult.desiredEffortWeightedQuantity, 3000);
  assert.ok(
    hosoResult.adjustedQuantityByProduct.hoso > result.adjustedQuantityByProduct.vap * 2.9,
    "同一人員で成立する数量はHOSOがVAPの約3倍のまま"
  );
});

test("SC-4: 【欠陥(ii)の解消】VAPの営業工数不足は増員で解消できる", () => {
  const context = { marketTargetDemandTons: REFERENCE_MARKET };
  const desired: Record<Product, number> = { hoso: 0, pd: 0, vap: 3000 };

  // 従来モデルでは、何人雇っても市場能力が5,000tで頭打ちのため
  // VAP3,000t（必要工数9,000t）は**構造的に達成不能**だった。
  const legacyAt = (h: number) => computeMarketSalesEffort(h, desired, SALES).adjustedQuantityByProduct.vap;
  assert.ok(legacyAt(10) < 900, `従来h=10ではVAP900t未満（実測 ${legacyAt(10)}）`);
  assert.ok(legacyAt(100) < 1700, `従来はh=100でも1,700t未満で頭打ち（実測 ${legacyAt(100)}）`);

  // 再設計後は、必要人数（(9000-200)/260 ≒ 34人）を雇えば希望どおり売れる。
  const newAt = (h: number) => computeMarketSalesEffort(h, desired, SALES, context).adjustedQuantityByProduct.vap;
  assert.ok(newAt(10) > legacyAt(10), "同じ10人でも従来より多く売れる");
  assert.equal(newAt(40), 3000, "40人まで増員すればVAP3,000tを希望どおり成立させられる");
  assert.ok(newAt(20) > newAt(10), "増員が単調に効く");
});

// ---------------------------------------------------------------------
// 欠陥(iii): 一律縮小 → 優先度
// ---------------------------------------------------------------------

test("SC-5: 【欠陥(iii)の解消】商品別優先度でVAPを守れる。優先度が同じなら従来の一律縮小と一致する", () => {
  const desired: Record<Product, number> = { hoso: 2000, pd: 1500, vap: 800 };
  const context = { marketTargetDemandTons: REFERENCE_MARKET };

  const uniform = computeMarketSalesEffort(5, desired, SALES, context);
  assert.ok(uniform.isConstrained);
  // 優先度未指定（すべて1.0）なら全商品が同じ縮小率になる。
  const scales = uniform.scaleByProduct!;
  assert.ok(Math.abs(scales.hoso - scales.vap) < 1e-9, "優先度が同じなら一律縮小と一致");
  assert.ok(Math.abs(scales.pd - scales.vap) < 1e-9);

  const vapProtected = computeMarketSalesEffort(5, desired, SALES, {
    ...context,
    priorityByProduct: { hoso: 1, pd: 1, vap: 4 },
  });
  assert.ok(
    vapProtected.adjustedQuantityByProduct.vap > uniform.adjustedQuantityByProduct.vap,
    `VAP優先でVAP数量が増える（${uniform.adjustedQuantityByProduct.vap} → ${vapProtected.adjustedQuantityByProduct.vap}）`
  );
  assert.ok(vapProtected.adjustedQuantityByProduct.hoso < uniform.adjustedQuantityByProduct.hoso, "その分HOSOは削られる");
  // 総工数は能力を超えない（優先度は配分を変えるだけで能力を増やさない）。
  const usedEffort =
    SALES.salesEffortCoefficients.hoso * vapProtected.adjustedQuantityByProduct.hoso +
    SALES.salesEffortCoefficients.pd * vapProtected.adjustedQuantityByProduct.pd +
    SALES.salesEffortCoefficients.vap * vapProtected.adjustedQuantityByProduct.vap;
  assert.ok(usedEffort <= vapProtected.capacityHosoEqTons + 1e-6, "優先度を変えても総工数は能力以内");
});

// ---------------------------------------------------------------------
// 非加算性（実装指示の必須要件）
// ---------------------------------------------------------------------

test("SC-6: 【必須】商品開発投資 × 営業人員 の 2×2 で交互作用項が正になる（どちらか一方では最大効果に届かない）", () => {
  const context = (vapCapabilityScore: number) => ({
    marketTargetDemandTons: REFERENCE_MARKET,
    customerDevelopment: { vapCapabilityScore, qualityReputation: 50, customerRelationship: 50 },
  });
  // どのセルでも希望量に届かない（＝能力が binding のまま）水準にする。
  // 途中で希望量に到達してしまうと交互作用項が頭打ちで過小評価されるため。
  const desired: Record<Product, number> = { hoso: 5000, pd: 5000, vap: 5000 };
  // 低/高 の2水準。VAP能力スコアは商品開発投資の主因（premiumPolicy.tsで重み0.4）。
  const LOW_DEV = 40;
  const HIGH_DEV = 90;
  const LOW_STAFF = 5;
  const HIGH_STAFF = 25;

  const sellable = (dev: number, staff: number) => {
    const r = computeMarketSalesEffort(staff, desired, SALES, context(dev));
    return r.adjustedQuantityByProduct.hoso + r.adjustedQuantityByProduct.pd + r.adjustedQuantityByProduct.vap;
  };

  const lowLow = sellable(LOW_DEV, LOW_STAFF);
  const highLow = sellable(HIGH_DEV, LOW_STAFF);
  const lowHigh = sellable(LOW_DEV, HIGH_STAFF);
  const highHigh = sellable(HIGH_DEV, HIGH_STAFF);

  const devOnlyGain = highLow - lowLow;
  const staffOnlyGain = lowHigh - lowLow;
  const bothGain = highHigh - lowLow;
  const interaction = bothGain - devOnlyGain - staffOnlyGain;

  assert.ok(devOnlyGain > 0, `商品開発投資だけでも効果はある（${devOnlyGain}）`);
  assert.ok(staffOnlyGain > 0, `増員だけでも効果はある（${staffOnlyGain}）`);
  assert.ok(
    interaction > 0,
    `交互作用項が正であるべき（both=${bothGain} dev=${devOnlyGain} staff=${staffOnlyGain} interaction=${interaction}）`
  );
  assert.ok(bothGain > devOnlyGain && bothGain > staffOnlyGain, "組み合わせが単独のどちらより大きい");
  // 交互作用の大きさが誤差ではなく意味のある水準であること。
  assert.ok(
    interaction > Math.max(devOnlyGain, staffOnlyGain) * 0.15,
    `交互作用項は単独効果の15%以上であるべき（実測 interaction=${interaction}）`
  );
});

test("SC-7: 顧客開発能力は人数に対して逓減し、VAP商品開発・品質・顧客関係で底上げされる", () => {
  const scoreAt = (h: number, vap = 50) =>
    computeCustomerDevelopmentScore({ salesForceHeadcount: h, vapCapabilityScore: vap }, SALES, PARAMS);

  // 逓減: 0→5人の伸びが 20→25人の伸びより大きい。
  assert.ok(scoreAt(5) - scoreAt(0) > scoreAt(25) - scoreAt(20), "人数の効果は逓減する");
  // 商品開発（VAP能力）が底上げする。
  assert.ok(scoreAt(10, 90) > scoreAt(10, 50), "VAP能力が高いほど顧客開発能力が高い");
  // 倍率は有界。
  assert.equal(customerDevelopmentMultiplier(50, PARAMS), 1, "中立スコア50で倍率1.0");
  assert.ok(customerDevelopmentMultiplier(100, PARAMS) <= PARAMS.customerDevelopmentMultiplierCap);
  assert.ok(customerDevelopmentMultiplier(0, PARAMS) >= PARAMS.customerDevelopmentMultiplierFloor);
});

// ---------------------------------------------------------------------
// allocation.ts の上限（旧「散文の証明」の置き換え）
// ---------------------------------------------------------------------

test("SC-8: 【旧証明の置き換え】営業工数制約を通した後の計画は、allocation側の個社上限で二重に打ち切られない", () => {
  // marketEffort.ts のヘッダにあった「適用後は allocation の capacity 上限が
  // 数学的に非拘束」という散文の証明を、直接のアサートへ置き換える。
  const marketTargetDemandTons = REFERENCE_MARKET;
  const makePlans = (headcount: number, desired: Record<Product, number>): CompanySalesPlanEntry[] =>
    (["hoso", "pd", "vap"] as const).map(
      (product) =>
        ({
          companyId: "BAL",
          market: "JP",
          product,
          desiredQuantity: hosoEqTons(desired[product]),
          priceAdjustmentUsdPerHosoEqKg: 0,
          salesForceHeadcount: headcount,
          vapCapabilityScore: score0to100(70),
        }) as CompanySalesPlanEntry
    );

  for (const headcount of [0, 5, 15, 40]) {
    const plans = makePlans(headcount, { hoso: 3000, pd: 2500, vap: 2000 });
    const { adjustedPlans } = applyMarketSalesEffortCapacity(plans, SALES, {
      targetDemandByMarket: { JP: marketTargetDemandTons },
    });

    for (const product of ["hoso", "pd", "vap"] as const) {
      const adjusted = adjustedPlans.find((p) => p.product === product)!;
      const result = allocateMarketProduct(
        "JP",
        product,
        period(2026, 1),
        adjustedPlans,
        usdPerHosoEqKg(6.0),
        hosoEqTons(50_000), // 対象需要は十分大きく、シェア上限も効かない条件にする
        SALES,
        { marketTargetDemandTons }
      );
      const company = result.companies.find((c) => c.companyId === "BAL")!;
      // 工数制約適用後の希望量が、allocation側の個社処理能力上限を超えていないこと。
      assert.ok(
        unwrapUnit(adjusted.desiredQuantity) <= unwrapUnit(company.processingCapacity) + 1e-6,
        `h=${headcount} ${product}: 工数制約後の希望量(${unwrapUnit(adjusted.desiredQuantity)})が` +
          `allocation側の上限(${unwrapUnit(company.processingCapacity)})を超えている＝二重制約が発生`
      );
    }
  }
});

test("SC-9: 文脈を渡さなければ従来挙動とビット単位で一致する（後方互換）", () => {
  const cases: { headcount: number; desired: Record<Product, number> }[] = [
    { headcount: 8, desired: { hoso: 2000, pd: 1000, vap: 200 } },
    { headcount: 8, desired: { hoso: 2000, pd: 1000, vap: 1000 } },
    { headcount: 20, desired: { hoso: 4000, pd: 3000, vap: 1500 } },
    { headcount: 5, desired: { hoso: 500, pd: 300, vap: 100 } },
  ];
  for (const c of cases) {
    const result = computeMarketSalesEffort(c.headcount, c.desired, SALES);
    assert.equal(result.capacityHosoEqTons, unwrapUnit(processingCapacity(c.headcount, SALES)));
    assert.equal(result.throughput, undefined, "文脈なしでは新モデルの内訳を返さない");
    if (result.isConstrained) {
      for (const p of ["hoso", "pd", "vap"] as const) {
        assert.ok(Math.abs(result.adjustedQuantityByProduct[p] - c.desired[p] * result.scaleFactor) < 1e-12);
      }
    }
  }
});

test("SC-10: 優先度水位法は総工数を超えず、必要量を満たした商品は打ち切られる", () => {
  const required: Record<Product, number> = { hoso: 1000, pd: 500, vap: 1500 };
  // 能力が十分ならすべて1.0。
  assert.deepEqual(allocateThroughputByPriority(required, { hoso: 1, pd: 1, vap: 1 }, 5000), { hoso: 1, pd: 1, vap: 1 });

  // 能力不足かつVAP優先。VAPの縮小率が他より高くなる。
  const scales = allocateThroughputByPriority(required, { hoso: 1, pd: 1, vap: 10 }, 1500);
  assert.ok(scales.vap > scales.hoso, `VAP優先で縮小率が高い（vap=${scales.vap} hoso=${scales.hoso}）`);
  const used = required.hoso * scales.hoso + required.pd * scales.pd + required.vap * scales.vap;
  assert.ok(used <= 1500 + 1e-6, `配分後の総工数(${used})が能力1,500を超えない`);
  for (const p of ["hoso", "pd", "vap"] as const) {
    assert.ok(scales[p] >= 0 && scales[p] <= 1, `${p}: 縮小率は0〜1`);
  }

  // 極端な優先度でも、必要量を満たした商品はそれ以上取らない（1.0で打ち切り）。
  const capped = allocateThroughputByPriority({ hoso: 100, pd: 100, vap: 100 }, { hoso: 1000, pd: 1, vap: 1 }, 250);
  assert.equal(capped.hoso, 1, "優先度が極端でも必要量100を超えて取らない");
  // 剰余は他商品へ回る。
  assert.ok(capped.pd > 0 && capped.vap > 0, "打ち切り後の残余が他商品へ再配分される");
});

test("SC-11: 商品別ウェイトプロファイルと併用しても各性質が保たれる", () => {
  const context = { marketTargetDemandTons: REFERENCE_MARKET, customerDevelopment: { vapCapabilityScore: 80 } };
  const result = computeMarketSalesEffort(15, { hoso: 1000, pd: 1000, vap: 1000 }, SALES_PARAMETERS_MARKET_EVOLUTION_PRODUCT_WISE_V1, context);
  assert.ok(result.throughput !== undefined, "新モデルの内訳が返る");
  assert.ok(result.throughput!.customerDevelopmentMultiplier > 1, "VAP能力80なら顧客開発倍率は1超");
  // 工数係数は商品別ウェイトプロファイルでも同じ（営業負荷はウェイトとは別概念）。
  assert.equal(SALES_PARAMETERS_MARKET_EVOLUTION_PRODUCT_WISE_V1.salesEffortCoefficients.vap, 3.0);
});

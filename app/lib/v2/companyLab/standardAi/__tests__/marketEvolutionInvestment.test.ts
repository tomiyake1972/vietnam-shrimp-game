// ShrimpX V2 — 標準AIの市場認識・投資判断（加工品市場進化 §h）のテスト
//
// MEI-1〜MEI-8。実装指示の「固定ターンの規則にしない」「予測需要・能力不足・
// 期待回収・現金余力の4点だけで決める」「会社ごとに判断が分かれる」を検証する。

import test from "node:test";
import assert from "node:assert/strict";

import {
  decideMarketEvolutionInvestments,
  MARKET_EVOLUTION_INVESTMENT_PARAMETERS_V1,
  perceiveMarketOutlook,
} from "../decision/marketEvolutionInvestment";
import { resolveOrientationProfile } from "../orientationProfile";
import { PressureScores } from "../pressures";
import { StandardAiObservation } from "../types";
import { CompanyFixture } from "../../types";
import { DEMAND_MARKET_IDS, DemandMarketId, Product } from "../../../market/types";
import { VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD } from "../../productDevelopmentState";

const PARAMS = MARKET_EVOLUTION_INVESTMENT_PARAMETERS_V1;

function mixMatrix(pd: number, vap: number): Readonly<Record<DemandMarketId, Readonly<Record<Product, number>>>> {
  return Object.fromEntries(DEMAND_MARKET_IDS.map((m) => [m, { hoso: 1 - pd - vap, pd, vap }])) as Readonly<
    Record<DemandMarketId, Readonly<Record<Product, number>>>
  >;
}

function observation(overrides: Partial<StandardAiObservation> = {}): StandardAiObservation {
  return {
    companyId: "BAL",
    factories: [
      {
        factoryId: "BAL-F1",
        capacityByProduct: { hoso: 5000, pd: 4000, vap: 1000 },
        commonProcessingCapacity: 10000,
        freezingPackagingCapacity: 10000,
        currentRegularHeadcount: 1200,
        skillByProduct: { hoso: 0.8, pd: 0.8, vap: 0.8 },
        attendanceRate: 0.95,
      },
    ],
    cashUsd: 100_000_000,
    existingLoanBalanceUsd: 0,
    regularHeadcountTotal: 1200,
    salesForceHeadcountTotal: 18,
    marketPremiumByProduct: {},
    productEconomics: { expectedProcessingCostUsdPerHosoEqKg: { hoso: 1, pd: 1.2, vap: 2 } },
    activeCapexProjectTargets: new Set(),
    qualityScoreByProduct: {},
    customerTrustByMarket: {},
    deliveryReliabilityByMarket: {},
    lastQuarterActualProductionByProduct: {},
    ...overrides,
  } as unknown as StandardAiObservation;
}

function pressures(overrides: Partial<PressureScores> = {}): PressureScores {
  return {
    equipmentUtilizationLastQuarter: 0.85,
    hadPriorQuarterUtilization: true,
    laborUtilizationLastQuarter: 0.8,
    targetMinimumCashUsd: 10_000_000,
    rawMaterialInventoryPosition: 1.0,
    ...overrides,
  } as unknown as PressureScores;
}

const BAL = { companyId: "BAL" } as unknown as CompanyFixture;

test("MEI-1: ライフサイクル観測が無ければ需要成長を織り込まない（機能OFF時の中立動作）", () => {
  const outlook = perceiveMarketOutlook(observation(), pressures(), PARAMS);
  assert.equal(outlook.pdDemandForecastMultiple, 1);
  assert.equal(outlook.vapDemandForecastMultiple, 1);
  assert.equal(outlook.pdDemandTrendPerQuarter, 0);
});

test("MEI-2: 予測需要倍率は公開トレンドの外挿であり、期間分だけ効く", () => {
  const trend = 0.01;
  const outlook = perceiveMarketOutlook(
    observation({
      lifecycleSharesByMarket: mixMatrix(0.3, 0.1),
      lifecycleTrendByMarket: mixMatrix(trend, trend),
    }),
    pressures(),
    PARAMS
  );
  // vap: (0.1 + 0.01×6) / 0.1 = 1.6
  assert.ok(Math.abs(outlook.vapDemandForecastMultiple - (0.1 + trend * PARAMS.demandForecastHorizonQuarters) / 0.1) < 1e-9);
  // pd: (0.3 + 0.06) / 0.3 = 1.2
  assert.ok(Math.abs(outlook.pdDemandForecastMultiple - (0.3 + trend * PARAMS.demandForecastHorizonQuarters) / 0.3) < 1e-9);
  // 予測能力不足率 = 現在稼働率 × 予測需要倍率。
  assert.ok(Math.abs(outlook.vapForecastCapacityShortfallRatio! - 0.85 * outlook.vapDemandForecastMultiple) < 1e-9);
});

test("MEI-3: 【固定ターン規則でないこと】同じ観測なら、どのturnでも同じ判断になる", () => {
  const obs = observation({
    lifecycleSharesByMarket: mixMatrix(0.3, 0.1),
    lifecycleTrendByMarket: mixMatrix(0.01, 0.01),
  });
  // decideMarketEvolutionInvestments はturnを引数に取らない（＝時期で分岐できない）。
  const a = decideMarketEvolutionInvestments(BAL, obs, pressures(), resolveOrientationProfile("BAL"), new Set(), PARAMS);
  const b = decideMarketEvolutionInvestments(BAL, obs, pressures(), resolveOrientationProfile("BAL"), new Set(), PARAMS);
  assert.deepEqual(a.proposals, b.proposals);
  assert.equal(a.vapProductDevelopmentSpendUsd, b.vapProductDevelopmentSpendUsd);
});

test("MEI-4: 予測需要が能力を上回り、稼働率も現金余力も十分なら新工場を提案する", () => {
  const obs = observation({
    lifecycleSharesByMarket: mixMatrix(0.3, 0.1),
    lifecycleTrendByMarket: mixMatrix(0.01, 0.01),
    cashUsd: 500_000_000,
  });
  const result = decideMarketEvolutionInvestments(BAL, obs, pressures(), resolveOrientationProfile("BAL"), new Set(), PARAMS);
  assert.ok(
    result.proposals.some((p) => p.projectType === "newFactoryConstruction"),
    `新工場が提案されるべき（実際: ${JSON.stringify(result.proposals)}）`
  );
  assert.ok(result.diagnostics.some((d) => d.code === "NEW_FACTORY_PROPOSED_FOR_FORECAST_DEMAND"));
});

test("MEI-5: 【現金が危ういときは見送る】同じ需要見通しでも現金余力が無ければ提案しない", () => {
  const base = {
    lifecycleSharesByMarket: mixMatrix(0.3, 0.1),
    lifecycleTrendByMarket: mixMatrix(0.01, 0.01),
  };
  const rich = decideMarketEvolutionInvestments(
    BAL,
    observation({ ...base, cashUsd: 500_000_000 }),
    pressures(),
    resolveOrientationProfile("BAL"),
    new Set(),
    PARAMS
  );
  const poor = decideMarketEvolutionInvestments(
    BAL,
    observation({ ...base, cashUsd: 5_000_000 }),
    pressures(),
    resolveOrientationProfile("BAL"),
    new Set(),
    PARAMS
  );
  assert.ok(rich.proposals.some((p) => p.projectType === "newFactoryConstruction"));
  assert.ok(!poor.proposals.some((p) => p.projectType === "newFactoryConstruction"), "現金不足時は新工場を提案しない");
  assert.ok(poor.diagnostics.some((d) => d.code === "NEW_FACTORY_DEFERRED"));
  assert.equal(poor.vapProductDevelopmentSpendUsd, 0, "現金不足時はVAP商品開発投資も0になる");
});

test("MEI-6: 稼働率が低ければ新工場を提案しない（設備が埋まっていないのに増設しない）", () => {
  const obs = observation({
    lifecycleSharesByMarket: mixMatrix(0.3, 0.1),
    lifecycleTrendByMarket: mixMatrix(0.01, 0.01),
    cashUsd: 500_000_000,
  });
  const idle = decideMarketEvolutionInvestments(
    BAL,
    obs,
    pressures({ equipmentUtilizationLastQuarter: 0.3 }),
    resolveOrientationProfile("BAL"),
    new Set(),
    PARAMS
  );
  assert.ok(!idle.proposals.some((p) => p.projectType === "newFactoryConstruction"));
});

test("MEI-7: VAP商品開発投資はトレンドと現金余力で決まり、供給過剰なら1段階抑える", () => {
  const rising = {
    lifecycleSharesByMarket: mixMatrix(0.3, 0.1),
    lifecycleTrendByMarket: mixMatrix(0.001, 0.02),
    cashUsd: 500_000_000,
  };
  const normal = decideMarketEvolutionInvestments(BAL, observation(rising), pressures(), resolveOrientationProfile("BAL"), new Set(), PARAMS);
  assert.ok(normal.vapProductDevelopmentSpendUsd > 0, "VAP需要が伸びていれば投資する");
  assert.ok(
    VAP_PRODUCT_DEVELOPMENT_SPEND_TIERS_USD.includes(normal.vapProductDevelopmentSpendUsd),
    "投資額は許容ティアのいずれかであるべき"
  );

  const oversupplied = decideMarketEvolutionInvestments(
    BAL,
    observation({ ...rising, productSupplyPressureByProduct: { pd: 1.0, vap: 1.4 } }),
    pressures(),
    resolveOrientationProfile("BAL"),
    new Set(),
    PARAMS
  );
  assert.ok(
    oversupplied.vapProductDevelopmentSpendUsd < normal.vapProductDevelopmentSpendUsd,
    `VAP供給過剰時は1段階抑えるべき（通常=${normal.vapProductDevelopmentSpendUsd} 過剰時=${oversupplied.vapProductDevelopmentSpendUsd}）`
  );

  // トレンドが弱ければ投資しない。
  const flat = decideMarketEvolutionInvestments(
    BAL,
    observation({ ...rising, lifecycleTrendByMarket: mixMatrix(0.0001, 0.0001) }),
    pressures(),
    resolveOrientationProfile("BAL"),
    new Set(),
    PARAMS
  );
  assert.equal(flat.vapProductDevelopmentSpendUsd, 0, "VAP需要が伸びていなければ投資しない");
});

test("MEI-8: 【5社一様の解消】志向プロファイルの違いが判断の分岐点を変える", () => {
  const obs = observation({
    lifecycleSharesByMarket: mixMatrix(0.3, 0.1),
    // VAP志向の会社だけがしきい値を超える、ちょうど境目のトレンドを与える。
    lifecycleTrendByMarket: mixMatrix(0.001, 0.0038),
    cashUsd: 500_000_000,
  });
  const spendByCompany = new Map<string, number>();
  for (const companyId of ["BAL", "MASS", "JPQ", "VAP", "CONSV"] as const) {
    const result = decideMarketEvolutionInvestments(
      { companyId } as unknown as CompanyFixture,
      obs,
      pressures(),
      resolveOrientationProfile(companyId),
      new Set(),
      PARAMS
    );
    spendByCompany.set(companyId, result.vapProductDevelopmentSpendUsd);
  }
  const distinct = new Set(spendByCompany.values());
  assert.ok(distinct.size > 1, `会社によってVAP開発投資の判断が分かれるべき（実際: ${JSON.stringify([...spendByCompany])}）`);
  // VAP志向(productMultipliers.vap=1.1)とJP品質志向(1.2)はしきい値が下がり投資する。
  assert.ok(spendByCompany.get("JPQ")! > 0, "VAP志向の強いJPQは投資する");
  // HOSO志向のMASS（vap倍率0.85）はしきい値が上がり見送る。
  assert.equal(spendByCompany.get("MASS"), 0, "VAP志向の弱いMASSは見送る");
});

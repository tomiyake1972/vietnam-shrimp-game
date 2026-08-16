// ShrimpX V2 — Standard AI Investment Portfolio Calibration（Phase PC-2A）単体テスト
//
// 指示§37のPC2A-1〜9に対応させる。decision/vapProductDevelopment.tsのtier選定を
// 「affordabilityが通れば必ず最大tier」（PC-1.5監査で確認したbang-bang原因）から、
// Investment Intensity（headroom・VAP事業規模・affordabilityの単純平均、0〜1）で
// 候補tierを決め、その候補がaffordability・財務ゲートを満たさない場合だけ段階的に
// 下げる方式へ変更した（指示§5-9）。既存のOperational/Commercial Needゲート
// （LOW_OPPORTUNITY/LOW_MARGIN/ALREADY_ACTIVE）・スコア更新式・SG&A会計処理は
// 一切変更していない（vapProductDevelopmentCE2.test.tsが引き続き検証）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStandardAiVapProductDevelopmentDecision } from "../decision/vapProductDevelopment";
import { StandardAiObservation } from "../types";
import { PressureScores } from "../pressures";
import { STANDARD_AI_PARAMETERS_V1, StandardAiParameters } from "../parameters";
import { CompanyFixture } from "../../types";
import { DEMAND_MARKET_IDS } from "../../../market/types";

function fixtureFor(margin: number): CompanyFixture {
  return {
    companyId: "BAL",
    productEconomics: {
      expectedProcessingCostUsdPerHosoEqKg: { hoso: 0.5, pd: 0.75, vap: 1.2 },
      premiumEconomics: {
        vap: {
          expectedVariableProcessingCostUsdPerHosoEqKg: 0.43,
          allocatedFixedCostUsdPerHosoEqKg: 0.35,
          sellingAndLogisticsCostUsdPerHosoEqKg: 0.1,
          targetMarginUsdPerHosoEqKg: margin,
          avoidableVariableProcessingCostUsdPerHosoEqKg: 0.43,
          incrementalSellingAndLogisticsCostUsdPerHosoEqKg: 0.06,
          minimumContributionMarginUsdPerHosoEqKg: 0.1,
        },
      },
    },
  } as unknown as CompanyFixture;
}

function observation(overrides: Partial<StandardAiObservation> = {}): StandardAiObservation {
  return {
    companyId: "BAL",
    period: "2015Q3",
    turn: 20,
    totalEffectiveCapacityByProduct: { hoso: 8000, pd: 7000, vap: 5000 },
    lastQuarterActualProductionByProduct: { hoso: 3000, pd: 3000, vap: 4500 },
    marketPremiumByProduct: { pd: 1.0, vap: 3.0 },
    vapProductDevelopmentScore: 50,
    cashUsd: 200_000_000,
    ...overrides,
  } as unknown as StandardAiObservation;
}

function pressures(overrides: Partial<PressureScores> = {}): PressureScores {
  return {
    borrowingPressure: 0.1,
    targetMinimumCashUsd: 30_000_000,
    marketPriceRanking: [...DEMAND_MARKET_IDS],
    ...overrides,
  } as unknown as PressureScores;
}

function intensityKeyValues(result: ReturnType<typeof buildStandardAiVapProductDevelopmentDecision>) {
  return result.diagnostics.find((d) => d.code === "VAP_DEV_INTENSITY_EVALUATED")?.keyValues;
}

test("PC2A-1: $0 case（headroom・VAP事業規模はあるが、affordabilityが極端に低いため$100kすら見送り）", () => {
  const obs = observation({ lastQuarterActualProductionByProduct: { hoso: 3000, pd: 3000, vap: 3000 } });
  const result = buildStandardAiVapProductDevelopmentDecision(fixtureFor(0.002), obs, pressures(), STANDARD_AI_PARAMETERS_V1);
  assert.equal(result.spendUsd, 0);
  assert.ok(result.diagnostics.some((d) => d.code === "VAP_DEV_PAYBACK_UNATTRACTIVE"));
});

test("PC2A-2: $100k case（LOW intensity＝headroom・VAP事業規模・affordabilityの平均が1/3未満）", () => {
  const obs = observation({
    lastQuarterActualProductionByProduct: { hoso: 8000, pd: 1000, vap: 3000 },
    vapProductDevelopmentScore: 80, // headroom = 0.2
  });
  const result = buildStandardAiVapProductDevelopmentDecision(fixtureFor(0.02), obs, pressures(), STANDARD_AI_PARAMETERS_V1);
  const kv = intensityKeyValues(result);
  assert.ok(kv && kv.investmentIntensity < STANDARD_AI_PARAMETERS_V1.vapProductDevelopmentIntensityMediumThreshold, "LOW intensity帯であることの前提確認");
  assert.equal(result.spendUsd, 100_000);
});

test("PC2A-3: $250k case（MEDIUM intensity＝1/3以上2/3未満）", () => {
  const result = buildStandardAiVapProductDevelopmentDecision(fixtureFor(0.5), observation(), pressures(), STANDARD_AI_PARAMETERS_V1);
  const kv = intensityKeyValues(result);
  assert.ok(
    kv &&
      kv.investmentIntensity >= STANDARD_AI_PARAMETERS_V1.vapProductDevelopmentIntensityMediumThreshold &&
      kv.investmentIntensity < STANDARD_AI_PARAMETERS_V1.vapProductDevelopmentIntensityHighThreshold,
    "MEDIUM intensity帯であることの前提確認"
  );
  assert.equal(result.spendUsd, 250_000);
});

test("PC2A-4: $500k case（HIGH intensity＝2/3以上）", () => {
  const obs = observation({
    lastQuarterActualProductionByProduct: { hoso: 1000, pd: 1000, vap: 8000 },
    totalEffectiveCapacityByProduct: { hoso: 8000, pd: 7000, vap: 9000 },
    vapProductDevelopmentScore: 10, // headroom = 0.9
  });
  const result = buildStandardAiVapProductDevelopmentDecision(fixtureFor(0.5), obs, pressures(), STANDARD_AI_PARAMETERS_V1);
  const kv = intensityKeyValues(result);
  assert.ok(kv && kv.investmentIntensity >= STANDARD_AI_PARAMETERS_V1.vapProductDevelopmentIntensityHighThreshold, "HIGH intensity帯であることの前提確認");
  assert.equal(result.spendUsd, 500_000);
});

test("PC2A-5: affordability respected（Intensityの候補tierが$500kでも、affordabilityを満たさなければ段階的に下のtierへ落ちる）", () => {
  const obs = observation({
    lastQuarterActualProductionByProduct: { hoso: 500, pd: 500, vap: 9000 },
    totalEffectiveCapacityByProduct: { hoso: 8000, pd: 7000, vap: 9500 },
    vapProductDevelopmentScore: 5, // headroom = 0.95
  });
  const result = buildStandardAiVapProductDevelopmentDecision(fixtureFor(0.01), obs, pressures(), STANDARD_AI_PARAMETERS_V1);
  const kv = intensityKeyValues(result);
  assert.equal(kv?.candidateTierUsd, 500_000, "前提: IntensityはHIGH（$500k候補）のはず");
  assert.equal(result.spendUsd, 250_000, "$500kのaffordabilityを満たさないため、$250kへ段階的に下がるはず（$0へ飛ばない）");
});

test("PC2A-6: Finance Gate respected（affordabilityを満たすtierでも、現金不足なら段階的に下がる／全滅すればFINANCE_BLOCKED）", () => {
  const okResult = buildStandardAiVapProductDevelopmentDecision(fixtureFor(0.5), observation({ cashUsd: 30_300_000 }), pressures(), STANDARD_AI_PARAMETERS_V1);
  assert.equal(okResult.spendUsd, 100_000, "候補$250kが現金不足で外れても、$100kの財務ゲートは満たすため$100kが選ばれるはず");

  const blockedResult = buildStandardAiVapProductDevelopmentDecision(fixtureFor(0.5), observation({ cashUsd: 30_100_000 }), pressures(), STANDARD_AI_PARAMETERS_V1);
  assert.equal(blockedResult.spendUsd, 0);
  assert.ok(blockedResult.diagnostics.some((d) => d.code === "VAP_DEV_FINANCE_BLOCKED"));
});

test("PC2A-7: Strategy Profile soft bias（productOrientationMultipliersはaffordabilityScore経由でIntensityへソフトに反映されるが、単独でtierを強制しない）", () => {
  const obs = observation({
    lastQuarterActualProductionByProduct: { hoso: 3000, pd: 1000, vap: 3000 },
    vapProductDevelopmentScore: 40,
  });
  const lowMarginFixture: CompanyFixture = {
    ...fixtureFor(0.03),
  };
  const baseline = buildStandardAiVapProductDevelopmentDecision(lowMarginFixture, obs, pressures(), STANDARD_AI_PARAMETERS_V1);
  assert.equal(baseline.spendUsd, 250_000);

  const vapOrientedParams: StandardAiParameters = {
    ...STANDARD_AI_PARAMETERS_V1,
    productOrientationMultipliers: { hoso: 0.7, vap: 1.4 },
  };
  const biased = buildStandardAiVapProductDevelopmentDecision(lowMarginFixture, obs, pressures(), vapOrientedParams);
  assert.equal(biased.spendUsd, 500_000, "VAP志向が高いほどaffordabilityScoreが上がりIntensityも上がるが、これは他2要素との平均であり単独では決まらない（ソフトバイアス）");
});

test("PC2A-8: 決定論的（同一入力を再実行しても同じtierが選ばれる）", () => {
  const obs = observation();
  const fixture = fixtureFor(0.5);
  const r1 = buildStandardAiVapProductDevelopmentDecision(fixture, obs, pressures(), STANDARD_AI_PARAMETERS_V1);
  const r2 = buildStandardAiVapProductDevelopmentDecision(fixture, obs, pressures(), STANDARD_AI_PARAMETERS_V1);
  assert.equal(r1.spendUsd, r2.spendUsd);
  assert.deepEqual(intensityKeyValues(r1), intensityKeyValues(r2));
});

test("PC2A-9: persistence unaffected（返り値spendUsdは既存のCompanyDecisionInput.vapProductDevelopmentSpendUsd経路だけを使い、新しい永続状態を必要としない）", () => {
  const result = buildStandardAiVapProductDevelopmentDecision(fixtureFor(0.5), observation(), pressures(), STANDARD_AI_PARAMETERS_V1);
  // 返り値はspendUsd（既存の4段階tierのいずれか）とdiagnostics（診断専用、永続化されない）のみ。
  assert.deepEqual(Object.keys(result).sort(), ["diagnostics", "spendUsd"]);
  assert.ok([0, 100_000, 250_000, 500_000].includes(result.spendUsd));
});

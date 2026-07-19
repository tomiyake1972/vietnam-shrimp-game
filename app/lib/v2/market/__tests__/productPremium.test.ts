import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateProductPremium } from "../productPremium";
import { MARKET_PARAMETERS_V1 } from "../parameters";
import { createRandomStream } from "../../core/random";
import { calculateMarketQuarter } from "../index";
import { unwrapUnit, hosoEqTons, score0to100 } from "../../core/units";
import { COUNTRY_IDS } from "../types";
import { baseMarketQuarterInput, baseCountryInput } from "./fixtures";

// テスト6: PD能力過剰でPDプレミアムが下がる
test("PD加工能力が過剰になるとPDプレミアムが下がる", () => {
  const base = baseMarketQuarterInput();
  const capacityUp = {
    ...base,
    countries: {
      EC: baseCountryInput("EC", { pdProcessingCapacity: hosoEqTons(40000) }),
      IN: baseCountryInput("IN", { pdProcessingCapacity: hosoEqTons(40000) }),
      ID: baseCountryInput("ID", { pdProcessingCapacity: hosoEqTons(40000) }),
      VN: baseCountryInput("VN", { pdProcessingCapacity: hosoEqTons(40000) }),
    },
  };

  const baseResult = calculateMarketQuarter(base, MARKET_PARAMETERS_V1, createRandomStream("seed-pd-1"));
  const capacityUpResult = calculateMarketQuarter(capacityUp, MARKET_PARAMETERS_V1, createRandomStream("seed-pd-1"));

  assert.ok(capacityUpResult.pdPremium.globalUtilization < baseResult.pdPremium.globalUtilization);
  assert.ok(unwrapUnit(capacityUpResult.pdPremium.basePremium) < unwrapUnit(baseResult.pdPremium.basePremium));
  assert.ok(capacityUpResult.pdPremium.drivers.includes("PROCESSING_CAPACITY_OVERSUPPLY"));
});

// テスト7: VAP能力不足またはVAP需要増でVAPプレミアムが上がる
test("VAP需要が増えるとVAPプレミアムが上がる", () => {
  const base = baseMarketQuarterInput();
  const demandUp = { ...base, pdVapDemand: { ...base.pdVapDemand, vapDemand: hosoEqTons(35000) } };

  const baseResult = calculateMarketQuarter(base, MARKET_PARAMETERS_V1, createRandomStream("seed-vap-1"));
  const demandUpResult = calculateMarketQuarter(demandUp, MARKET_PARAMETERS_V1, createRandomStream("seed-vap-1"));

  assert.ok(demandUpResult.vapPremium.globalUtilization > baseResult.vapPremium.globalUtilization);
  assert.ok(unwrapUnit(demandUpResult.vapPremium.basePremium) > unwrapUnit(baseResult.vapPremium.basePremium));
  assert.ok(demandUpResult.vapPremium.drivers.includes("VAP_DEMAND_STRENGTH"));
});

test("VAP加工能力が不足するとVAPプレミアムが上がる", () => {
  const base = baseMarketQuarterInput();
  const capacityDown = {
    ...base,
    countries: {
      EC: baseCountryInput("EC", { vapProcessingCapacity: hosoEqTons(2000) }),
      IN: baseCountryInput("IN", { vapProcessingCapacity: hosoEqTons(2000) }),
      ID: baseCountryInput("ID", { vapProcessingCapacity: hosoEqTons(2000) }),
      VN: baseCountryInput("VN", { vapProcessingCapacity: hosoEqTons(2000) }),
    },
  };

  const baseResult = calculateMarketQuarter(base, MARKET_PARAMETERS_V1, createRandomStream("seed-vap-2"));
  const capacityDownResult = calculateMarketQuarter(capacityDown, MARKET_PARAMETERS_V1, createRandomStream("seed-vap-2"));

  assert.ok(unwrapUnit(capacityDownResult.vapPremium.basePremium) > unwrapUnit(baseResult.vapPremium.basePremium));
  assert.ok(capacityDownResult.vapPremium.drivers.includes("VAP_CAPACITY_TIGHTNESS"));
});

// テスト8: エクアドル・インドのPD能力上昇が、後半のPDプレミアムを押し下げる
test("エクアドル・インドのPD能力上昇（ゲーム後半を想定した入力）がPDプレミアムを押し下げる", () => {
  const earlyGame = baseMarketQuarterInput(); // 2015年（ゲーム序盤）相当のPD能力
  const lateGame = {
    ...earlyGame,
    countries: {
      ...earlyGame.countries,
      EC: { ...earlyGame.countries.EC, pdProcessingCapacity: hosoEqTons(35000) }, // 後半に能力増強
      IN: { ...earlyGame.countries.IN, pdProcessingCapacity: hosoEqTons(25000) },
    },
  };

  const earlyResult = calculateMarketQuarter(earlyGame, MARKET_PARAMETERS_V1, createRandomStream("seed-ec-in"));
  const lateResult = calculateMarketQuarter(lateGame, MARKET_PARAMETERS_V1, createRandomStream("seed-ec-in"));

  assert.ok(unwrapUnit(lateResult.pdPremium.basePremium) < unwrapUnit(earlyResult.pdPremium.basePremium));
  assert.ok(lateResult.pdPremium.drivers.includes("ECUADOR_PD_CAPACITY_EXPANSION"));
});

// テスト9: ベトナムとインドネシアの品質優位がPD・VAP価格へ反映される
test("ベトナム・インドネシアの品質スコアが高いと、PD/VAP最終価格に品質プレミアムが上乗せされる", () => {
  const base = baseMarketQuarterInput();
  const withQualityEdge = {
    ...base,
    countries: {
      ...base.countries,
      VN: { ...base.countries.VN, qualityScore: score0to100(85) },
      ID: { ...base.countries.ID, qualityScore: score0to100(80) },
      EC: { ...base.countries.EC, qualityScore: score0to100(50) },
      IN: { ...base.countries.IN, qualityScore: score0to100(50) },
    },
  };

  const result = calculateMarketQuarter(withQualityEdge, MARKET_PARAMETERS_V1, createRandomStream("seed-quality"));

  assert.ok(unwrapUnit(result.pdPremium.byCountry.VN.qualityAdjustment) > 0);
  assert.ok(unwrapUnit(result.pdPremium.byCountry.ID.qualityAdjustment) > 0);
  assert.ok(unwrapUnit(result.pdPremium.byCountry.EC.qualityAdjustment) === 0);
  assert.ok(unwrapUnit(result.vapPremium.byCountry.VN.qualityAdjustment) > 0);
  assert.ok(unwrapUnit(result.vapPremium.byCountry.ID.qualityAdjustment) > 0);
  assert.ok(result.pdPremium.drivers.includes("QUALITY_PREMIUM_APPLIED"));
});

test("calculateProductPremiumは入力オブジェクトを変更しない", () => {
  const base = baseMarketQuarterInput();
  const hosoPricesResult = calculateMarketQuarter(base, MARKET_PARAMETERS_V1, createRandomStream("seed-mutation")).hosoPrices;
  const countriesSnapshot = JSON.parse(JSON.stringify(base.countries));
  calculateProductPremium(
    "pd",
    hosoPricesResult,
    base.countries,
    COUNTRY_IDS,
    { demand: base.pdVapDemand.pdDemand, basePremiumRatio: MARKET_PARAMETERS_V1.pdVapPremium.pdBasePremiumRatio },
    MARKET_PARAMETERS_V1
  );
  assert.deepEqual(JSON.parse(JSON.stringify(base.countries)), countriesSnapshot);
});

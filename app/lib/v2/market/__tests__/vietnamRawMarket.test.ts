import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateBuyingCeiling, applyMinimumOfftakeRule, clearVietnamRawMarket } from "../vietnamRawMarket";
import { MARKET_PARAMETERS_V1 } from "../parameters";
import { hosoEqTons, usdPerHosoEqKg, unwrapUnit } from "../../core/units";
import { baseVietnamDomesticInput } from "./fixtures";

const VN_HOSO_PRICE = usdPerHosoEqKg(5.6);

test("買付上限 = HOSO価格×歩留まり - 加工輸出費用 - 必要利益", () => {
  const input = baseVietnamDomesticInput();
  const ceiling = calculateBuyingCeiling(VN_HOSO_PRICE, input);
  const expected =
    5.6 * unwrapUnit(input.hosoYieldRatio) -
    unwrapUnit(input.processingExportCostUsdPerKg) -
    unwrapUnit(input.requiredMarginUsdPerKg);
  assert.ok(Math.abs(unwrapUnit(ceiling) - expected) < 1e-9);
});

// テスト4: ベトナム国内原料が不足すると国内原料価格が上がる
test("国内原料供給が不足すると価格が上がる", () => {
  const balanced = baseVietnamDomesticInput({
    domesticRawSupply: hosoEqTons(30000),
    domesticProcurementIntent: hosoEqTons(30000),
  });
  const shortage = baseVietnamDomesticInput({
    domesticRawSupply: hosoEqTons(20000), // 供給が需要を大きく下回る
    domesticProcurementIntent: hosoEqTons(30000),
  });

  const balancedResult = clearVietnamRawMarket(VN_HOSO_PRICE, balanced, MARKET_PARAMETERS_V1);
  const shortageResult = clearVietnamRawMarket(VN_HOSO_PRICE, shortage, MARKET_PARAMETERS_V1);

  assert.ok(unwrapUnit(shortageResult.price) > unwrapUnit(balancedResult.price));
  assert.ok(shortageResult.drivers.includes("VIETNAM_RAW_MATERIAL_SHORTAGE"));
});

// テスト5: 国内原料余剰なら国内原料価格が下がる
test("国内原料が余剰になると価格が下がる", () => {
  const balanced = baseVietnamDomesticInput({
    domesticRawSupply: hosoEqTons(30000),
    domesticProcurementIntent: hosoEqTons(30000),
  });
  const surplus = baseVietnamDomesticInput({
    domesticRawSupply: hosoEqTons(45000), // 供給が需要を大きく上回る
    domesticProcurementIntent: hosoEqTons(30000),
  });

  const balancedResult = clearVietnamRawMarket(VN_HOSO_PRICE, balanced, MARKET_PARAMETERS_V1);
  const surplusResult = clearVietnamRawMarket(VN_HOSO_PRICE, surplus, MARKET_PARAMETERS_V1);

  assert.ok(unwrapUnit(surplusResult.price) < unwrapUnit(balancedResult.price));
  assert.ok(surplusResult.drivers.includes("VIETNAM_RAW_MATERIAL_SURPLUS"));
});

test("国際HOSO価格が上がると、ベトナム国内原料価格の買付上限も連動して上がる", () => {
  const input = baseVietnamDomesticInput();
  const low = calculateBuyingCeiling(usdPerHosoEqKg(5.0), input);
  const high = calculateBuyingCeiling(usdPerHosoEqKg(7.0), input);
  assert.ok(unwrapUnit(high) > unwrapUnit(low));
});

// プロラタ最低引取ルール（全体実装計画書 v0.1 §10.1）
test("5社の買付希望が過度に少ない場合、過去4Q平均×20%が最低引取基準として適用される", () => {
  const input = baseVietnamDomesticInput({
    domesticProcurementIntent: hosoEqTons(1000), // 極端に消極的
    trailingAverageDomesticPurchase: hosoEqTons(28000),
  });
  const { effectiveDemand, applied } = applyMinimumOfftakeRule(input, MARKET_PARAMETERS_V1);
  assert.equal(applied, true);
  // 28000 * 0.20 = 5600
  assert.ok(Math.abs(unwrapUnit(effectiveDemand) - 5600) < 1e-9);
});

test("買付希望が最低引取基準を上回る場合はそのまま採用され、ルールは発動しない", () => {
  const input = baseVietnamDomesticInput({
    domesticProcurementIntent: hosoEqTons(30000),
    trailingAverageDomesticPurchase: hosoEqTons(28000),
  });
  const { effectiveDemand, applied } = applyMinimumOfftakeRule(input, MARKET_PARAMETERS_V1);
  assert.equal(applied, false);
  assert.ok(Math.abs(unwrapUnit(effectiveDemand) - 30000) < 1e-9);
});

test("最低引取ルール発動時はMINIMUM_OFFTAKE_RULE_APPLIEDが理由コードに含まれる", () => {
  const input = baseVietnamDomesticInput({
    domesticProcurementIntent: hosoEqTons(500),
    domesticRawSupply: hosoEqTons(30000),
    trailingAverageDomesticPurchase: hosoEqTons(28000),
  });
  const result = clearVietnamRawMarket(VN_HOSO_PRICE, input, MARKET_PARAMETERS_V1);
  assert.ok(result.drivers.includes("MINIMUM_OFFTAKE_RULE_APPLIED"));
  assert.equal(result.minimumOfftakeApplied, true);
});

test("clearVietnamRawMarketは入力を変更しない", () => {
  const input = baseVietnamDomesticInput();
  const snapshot = JSON.parse(JSON.stringify(input));
  clearVietnamRawMarket(VN_HOSO_PRICE, input, MARKET_PARAMETERS_V1);
  assert.deepEqual(JSON.parse(JSON.stringify(input)), snapshot);
});

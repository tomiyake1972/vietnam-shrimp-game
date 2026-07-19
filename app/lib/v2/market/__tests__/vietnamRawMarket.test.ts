import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateBuyingCeiling, applyMinimumOfftakeRule, clearVietnamRawMarket } from "../vietnamRawMarket";
import { MARKET_PARAMETERS_V1 } from "../parameters";
import { hosoEqTons, usdPerHosoEqKg, unwrapUnit } from "../../core/units";
import { baseVietnamDomesticInput } from "./fixtures";

const VN_HOSO_PRICE = usdPerHosoEqKg(5.6);

test("買付上限 = HOSO価格×HOSO換算回収率(基準1.00) - 加工輸出費用 - 必要利益（物理歩留まりを掛けない）", () => {
  const input = baseVietnamDomesticInput();
  const ceiling = calculateBuyingCeiling(VN_HOSO_PRICE, input);
  const expected =
    5.6 * unwrapUnit(input.hosoEqRecoveryRatio) -
    unwrapUnit(input.processingExportCostUsdPerKg) -
    unwrapUnit(input.requiredMarginUsdPerKg);
  assert.ok(Math.abs(unwrapUnit(ceiling) - expected) < 1e-9);
  // HLSO相当の物理歩留まり(0.62)を掛けた旧式の値にはならない。
  assert.ok(Math.abs(unwrapUnit(ceiling) - (5.6 * 0.62 - 1.1)) > 0.5);
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

// --- Phase 6.3: 農家留保価格・数量調整 ---

test("需給による価格が農家留保価格を下回ると、価格は留保価格で下支えされる（買付上限>=留保価格の通常領域）", () => {
  // 強い供給過剰（D/S = 10%）かつHOSO安（ceiling 2.5 >= 留保価格2.25）の局面では、
  // 需給乗数による価格(約1.5)ではなく留保価格が下限になる。
  const input = baseVietnamDomesticInput({
    domesticRawSupply: hosoEqTons(100000),
    domesticProcurementIntent: hosoEqTons(10000),
    trailingAverageDomesticPurchase: hosoEqTons(10000),
  });
  const result = clearVietnamRawMarket(usdPerHosoEqKg(3.6), input, MARKET_PARAMETERS_V1);
  const d = MARKET_PARAMETERS_V1.vietnamDomestic.farmerEconomicsDefaults;
  const reservation = d.farmingCostUsdPerHosoEqKg + d.diseaseRiskAllowanceUsdPerHosoEqKg + d.minimumFarmerMarginUsdPerHosoEqKg;
  assert.ok(Math.abs(unwrapUnit(result.farmerReservationPrice) - reservation) < 1e-9);
  assert.ok(unwrapUnit(result.price) >= reservation - 1e-9);
  assert.equal(result.reservationPriceApplied, true);
  assert.equal(result.quantityRationed, false);
  assert.ok(result.drivers.includes("VIETNAM_FARMER_RESERVATION_PRICE_APPLIED"));
  // 取引量は需要分のみ。未売却の潜在供給が残る（会社在庫へは自動計上されない）。
  assert.ok(Math.abs(unwrapUnit(result.transactedVolume) - 10000) < 1e-6);
  assert.ok(Math.abs(unwrapUnit(result.unsoldSupply) - 90000) < 1e-6);
});

test("買付上限が農家留保価格を下回ると、価格ではなく取引数量が縮小する（数量調整）", () => {
  // HOSO暴落局面: ceiling = 2.0×1.0 - 0.8 - 0.3 = 0.9 < 留保価格2.60。
  const input = baseVietnamDomesticInput({
    domesticRawSupply: hosoEqTons(30000),
    domesticProcurementIntent: hosoEqTons(30000),
  });
  const crashedHoso = usdPerHosoEqKg(2.0);
  const result = clearVietnamRawMarket(crashedHoso, input, MARKET_PARAMETERS_V1);
  assert.equal(result.quantityRationed, true);
  assert.ok(result.drivers.includes("VIETNAM_PROCUREMENT_QUANTITY_RATIONED"));
  // 価格は留保価格未満へ下がらない（留保価格未満での全量取引はしない）。
  assert.ok(unwrapUnit(result.price) >= unwrapUnit(result.farmerReservationPrice) - 1e-9);
  // 取引量が需要より減り、加工会社側の調達未達の原資になる。
  assert.ok(unwrapUnit(result.transactedVolume) < 30000 - 1e-6);
  // 数量保存: transacted + unsold = supply。
  assert.ok(Math.abs(unwrapUnit(result.transactedVolume) + unwrapUnit(result.unsoldSupply) - 30000) < 1e-6);
});

test("通常領域では取引数量 = min(供給, 実効需要) で、価格は[留保価格, 買付上限]の範囲に収まる", () => {
  const input = baseVietnamDomesticInput({
    domesticRawSupply: hosoEqTons(30000),
    domesticProcurementIntent: hosoEqTons(24000),
  });
  const result = clearVietnamRawMarket(VN_HOSO_PRICE, input, MARKET_PARAMETERS_V1);
  assert.ok(Math.abs(unwrapUnit(result.transactedVolume) - 24000) < 1e-6);
  assert.ok(unwrapUnit(result.price) >= unwrapUnit(result.farmerReservationPrice) - 1e-9);
  assert.ok(unwrapUnit(result.price) <= unwrapUnit(result.buyingCeiling) + 1e-9);
  assert.equal(result.quantityRationed, false);
});

test("シナリオ側から農家経済（留保価格の構成要素）を上書きできる", () => {
  const input = baseVietnamDomesticInput({
    farmerEconomics: {
      farmingCostUsdPerHosoEqKg: 3.0,
      diseaseRiskAllowanceUsdPerHosoEqKg: 0.5,
      minimumFarmerMarginUsdPerHosoEqKg: 0.5,
    },
  });
  const result = clearVietnamRawMarket(VN_HOSO_PRICE, input, MARKET_PARAMETERS_V1);
  assert.ok(Math.abs(unwrapUnit(result.farmerReservationPrice) - 4.0) < 1e-9);
});

test("clearVietnamRawMarketは入力を変更しない", () => {
  const input = baseVietnamDomesticInput();
  const snapshot = JSON.parse(JSON.stringify(input));
  clearVietnamRawMarket(VN_HOSO_PRICE, input, MARKET_PARAMETERS_V1);
  assert.deepEqual(JSON.parse(JSON.stringify(input)), snapshot);
});

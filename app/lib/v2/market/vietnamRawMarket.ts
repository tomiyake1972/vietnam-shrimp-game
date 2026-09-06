// ShrimpX V2 — ベトナム国内未凍結原料市場（Phase 1、Phase 6.3で経済尺度を是正）
//
// 市場価格形成モジュール仕様書 v0.2 §10「ベトナム国内未凍結原料市場」に対応。
// 国際HOSO価格の下流ではなく、HOSO等の期待製品価値を加工会社の買付上限へ
// 変換したうえで、当期の収穫量と加工会社の買付希望量を突き合わせて清算する
// 独立市場として実装する（§10冒頭・仕様書§17不変条件「HOSO価格とベトナム国内
// 原料価格が別フィールド・別計算として保存される」）。
//
// 【Phase 6.3修正（実装指示 §3・§4）】
// 1. 買付上限式から物理歩留まり（旧hosoYieldRatio=0.62、HLSO相当）を除去した。
//    国内原料価格とVN HOSO輸出価格はどちらもHOSO換算kgあたり価格であり、
//    物理歩留まりを掛けると単位系が混線する（HOSO換算どうしの差し引きに
//    物理重量の換算率を混ぜてはならない）。真の販売可能回収率を反映する場合も
//    HOSO換算上の回収率（hosoEqRecoveryRatio、基準1.00）を一度だけ使う。
// 2. 養殖農家の販売留保価格（farmerReservationPrice）を導入した。需給による
//    価格がこの水準を下回る圧力は、価格ではなく取引数量の縮小として市場を
//    調整する（買付上限が留保価格を下回ると取引成立量が減り、加工会社側に
//    調達未達が発生する。未売却の潜在供給は会社在庫へ自動計上されず、次期の
//    池入れ・供給減少判断のシグナルとして結果に保持される）。
//    absolutePriceFloorUsdPerKg（0.05）は数値エラー防止用バックストップとして
//    のみ残し、通常の市場計算で到達する経済的下限には使用しない。

import { HosoEqTons, UsdPerHosoEqKg, hosoEqTons, usdPerHosoEqKg, unwrapUnit } from "../core/units";
import { MarketValidationError, VietnamDomesticInput, VietnamDomesticResult, MarketPriceDriver } from "./types";
import { MarketParameters } from "./parameters";
import { assertFinite, clamp, safeDivide } from "./validation";

/**
 * 理論原料支払上限（買付上限）。
 * 買付上限 = HOSO FOB価格 × HOSO換算回収率（基準1.00） − 加工輸出費用 − 必要利益
 * （Phase 6.3修正。旧実装はここにHLSO相当の物理歩留まり0.62を掛けており、
 * HOSO換算価格どうしの計算に物理重量換算を混入させていた。Phase1では
 * ゲーム内通貨をUSD単一建てとしているため為替項を省略。docsに明記する。）
 */
export function calculateBuyingCeiling(
  vietnamHosoFobPrice: UsdPerHosoEqKg,
  input: VietnamDomesticInput
): UsdPerHosoEqKg {
  const hoso = unwrapUnit(vietnamHosoFobPrice);
  const recoveryRatio = unwrapUnit(input.hosoEqRecoveryRatio);
  const cost = unwrapUnit(input.processingExportCostUsdPerKg);
  const margin = unwrapUnit(input.requiredMarginUsdPerKg);
  const ceiling = hoso * recoveryRatio - cost - margin;
  return usdPerHosoEqKg(Math.max(ceiling, 0));
}

/**
 * 養殖農家の販売留保価格（集荷に応じる最低価格。Phase 6.3、実装指示 §4）。
 * farmerReservationPrice = farmingCost + diseaseRiskAllowance + minimumFarmerMargin。
 * 構成要素はシナリオ側（VietnamDomesticInput.farmerEconomics）から変動可能で、
 * 未指定時はMarketParametersの既定値を使う。
 */
export function calculateFarmerReservationPrice(
  input: VietnamDomesticInput,
  parameters: MarketParameters
): UsdPerHosoEqKg {
  const econ = input.farmerEconomics ?? parameters.vietnamDomestic.farmerEconomicsDefaults;
  const reservation =
    econ.farmingCostUsdPerHosoEqKg + econ.diseaseRiskAllowanceUsdPerHosoEqKg + econ.minimumFarmerMarginUsdPerHosoEqKg;
  assertFinite(reservation, "farmerReservationPrice");
  return usdPerHosoEqKg(Math.max(reservation, 0));
}

/**
 * プロラタ最低引取ルール適用後の実効需要量。
 * 全体実装計画書 v0.1 §10.1「一律に買付予定の20%を強制するのではなく、
 * 過去4Qの国内購入平均×20%を最低引取基準とする」に対応する。
 * Phase1では会社別の按分（プロラタ配分）自体は調達モジュールの責務とし、
 * ここでは業界集計値としての実効需要（表明値と最低引取基準の大きい方）のみを
 * 算出する。
 */
export function applyMinimumOfftakeRule(
  input: VietnamDomesticInput,
  parameters: MarketParameters
): { readonly effectiveDemand: HosoEqTons; readonly applied: boolean } {
  const intent = unwrapUnit(input.domesticProcurementIntent);
  const floor = unwrapUnit(input.trailingAverageDomesticPurchase) * parameters.minimumOfftakeRatio;
  const effectiveDemandValue = Math.max(intent, floor);
  return {
    effectiveDemand: hosoEqTons(effectiveDemandValue),
    applied: floor > intent,
  };
}

/**
 * ベトナム国内未凍結原料市場を清算する。
 *
 * 価格帯の決まり方（Phase 6.3）:
 *   - 需給乗数による価格 = 買付上限 × clamp(baseMultiplier + imbalance × sensitivity)
 *   - 買付上限 >= 農家留保価格 のとき: 価格はこの需給価格を [留保価格, 買付上限] に
 *     クランプした値。取引数量は min(供給, 実効需要)（留保価格で下支えされた場合、
 *     需要を超える潜在供給は農家の未売却分として残る）。
 *   - 買付上限 < 農家留保価格 のとき: 農家は留保価格未満で全量取引に応じない。
 *     価格は留保価格（取引が成立する場合の限界的な集荷価格）とし、価格ではなく
 *     取引数量を縮小して市場を調整する（tradeRatioにより実際の取引成立量が減り、
 *     加工会社側に調達未達が発生する）。
 */
export function clearVietnamRawMarket(
  vietnamHosoFobPrice: UsdPerHosoEqKg,
  input: VietnamDomesticInput,
  parameters: MarketParameters,
  /**
   * 【ENG-DS2-COST-FOUNDATION-1】原料価格捕捉指数（Scenario opt-in。既定1.00）。
   *
   * 需給乗数の**基準値だけ**に掛ける:
   *   adjustedBaseMultiplier = baseMultiplier × rawPriceCaptureIndex
   *   m = clamp(adjustedBaseMultiplier + imbalance × demandSensitivity,
   *             floorMultiplier, 1.0)
   *
   * 1.00 のとき baseMultiplier × 1.0 === baseMultiplier（IEEE754で厳密に同値）で
   * あり、現行の計算とビット単位で一致する。
   *
   * 【触らないもの】buyingCeiling（processingExportCost / requiredMargin）、
   * farmerReservationPrice の式、clamp の上限 1.0、数量ラショニング分岐
   * （ceiling < reservation）のいずれも変更しない。上限1.0を維持するため、
   * この指数をどれだけ上げても rawPrice が buyingCeiling を超えることはない。
   */
  rawPriceCaptureIndex: number = 1.0
): VietnamDomesticResult {
  if (!Number.isFinite(rawPriceCaptureIndex) || rawPriceCaptureIndex <= 0) {
    throw new MarketValidationError(
      `rawPriceCaptureIndex は0より大きい有限数である必要があります。受け取った値: ${rawPriceCaptureIndex}`
    );
  }
  const buyingCeiling = calculateBuyingCeiling(vietnamHosoFobPrice, input);
  const farmerReservationPrice = calculateFarmerReservationPrice(input, parameters);
  const { effectiveDemand, applied } = applyMinimumOfftakeRule(input, parameters);

  const supplyValue = unwrapUnit(input.domesticRawSupply);
  const demandValue = unwrapUnit(effectiveDemand);
  const ceilingValue = unwrapUnit(buyingCeiling);
  const reservationValue = unwrapUnit(farmerReservationPrice);

  const rawImbalance = safeDivide(demandValue - supplyValue, supplyValue);
  const p = parameters.vietnamDomestic;
  const imbalance = clamp(rawImbalance, -p.imbalanceClamp, p.imbalanceClamp);

  const adjustedBaseMultiplier = p.baseMultiplier * rawPriceCaptureIndex;
  const multiplier = clamp(adjustedBaseMultiplier + imbalance * p.demandSensitivity, p.floorMultiplier, 1.0);
  const supplyDemandPriceValue = ceilingValue * multiplier;
  assertFinite(supplyDemandPriceValue, "vietnamDomesticPrice");

  let priceValue: number;
  let transactedValue: number;
  let reservationPriceApplied = false;
  let quantityRationed = false;
  let appliedTradeRatio = 1;

  if (ceilingValue >= reservationValue) {
    // 通常領域: 価格は [留保価格, 買付上限] の範囲で需給により決まる。
    priceValue = clamp(supplyDemandPriceValue, reservationValue, ceilingValue);
    reservationPriceApplied = supplyDemandPriceValue < reservationValue;
    transactedValue = Math.min(supplyValue, demandValue);
  } else {
    // 買付上限 < 留保価格: 農家は留保価格未満で全量取引に応じない。
    // 価格ではなく数量で調整する（実装指示 §4）。
    const severity = safeDivide(reservationValue - ceilingValue, Math.max(reservationValue, 1e-9));
    const tradeRatio = clamp(
      1 - severity * p.quantityRationing.severitySensitivity,
      p.quantityRationing.minTradeRatio,
      1
    );
    priceValue = reservationValue;
    reservationPriceApplied = true;
    quantityRationed = true;
    appliedTradeRatio = tradeRatio;
    transactedValue = Math.min(supplyValue, demandValue) * tradeRatio;
  }

  const unsoldValue = Math.max(0, supplyValue - transactedValue);

  const drivers: MarketPriceDriver[] = [];
  const t = parameters.driverThresholds;
  if (imbalance > t.supplyDemandImbalance) drivers.push("VIETNAM_RAW_MATERIAL_SHORTAGE");
  if (imbalance < -t.supplyDemandImbalance) drivers.push("VIETNAM_RAW_MATERIAL_SURPLUS");
  if (applied) drivers.push("MINIMUM_OFFTAKE_RULE_APPLIED");
  if (reservationPriceApplied) drivers.push("VIETNAM_FARMER_RESERVATION_PRICE_APPLIED");
  if (quantityRationed) drivers.push("VIETNAM_PROCUREMENT_QUANTITY_RATIONED");

  return {
    // absolutePriceFloorは数値エラー防止のバックストップのみ（通常は留保価格が下限）。
    price: usdPerHosoEqKg(Math.max(priceValue, p.absolutePriceFloorUsdPerKg)),
    buyingCeiling,
    farmerReservationPrice,
    // 【ENG-DS2-COST-FOUNDATION-1】診断値は捕捉指数が中立でないときだけ載せる。
    // 中立時にキーを作らないことで、既存Scenarioの保存結果を不変に保つ。
    ...(rawPriceCaptureIndex !== 1.0
      ? { priceMultiplier: multiplier, rawPriceCaptureIndex, tradeRatio: appliedTradeRatio }
      : {}),
    supply: hosoEqTons(supplyValue),
    effectiveDemand,
    transactedVolume: hosoEqTons(Math.max(0, transactedValue)),
    unsoldSupply: hosoEqTons(unsoldValue),
    imbalance,
    minimumOfftakeApplied: applied,
    reservationPriceApplied,
    quantityRationed,
    drivers,
  };
}
